import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream, createWriteStream } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  unlink,
  type FileHandle
} from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { z } from 'zod'
import {
  HostMutationOperationCoordinatorError,
  hostMutationReturn,
  hostMutationThrow,
  type HostMutationOperationCoordinator,
  type HostMutationOperationScope,
  type HostMutationRecoveryOperationCoordinator
} from '../host-mutation/operation-coordinator.js'
import { sha256Schema } from '../updates/version.js'
import { parseThunderstoreDependency, thunderstoreDependencyIdSchema } from './dependency.js'
import {
  clientParityManifestSchema,
  serverModLockSchema,
  validateModManifestPair,
  type ServerModLockEntry
} from './manifest.js'
import {
  ModPlatformLockError,
  modPlatformLockSchema,
  validateModPlatformLock
} from './platform-lock.js'
import {
  DEFAULT_MOD_DEPLOYMENT_HISTORY_PAGE_SIZE,
  MAX_DEPLOYED_MOD_TOTAL_BYTES,
  MAX_MOD_DEPLOYMENT_HISTORY_CURSOR_LENGTH,
  MAX_MOD_DEPLOYMENT_HISTORY_PAGE_SIZE,
  MAX_MOD_DEPLOYMENT_MANIFEST_BYTES,
  MAX_MOD_DEPLOYMENT_RECEIPT_ENTRIES,
  MAX_STAGED_MOD_FILE_BYTES,
  MAX_STAGED_MOD_FILES,
  MAX_STAGED_MOD_TOTAL_BYTES,
  ModDeploymentError,
  type ModDeploymentCleanupCandidate,
  type ModDeploymentCleanupPlan,
  type ModDeploymentFaultPhase,
  type ModDeploymentOperation,
  type ModDeploymentPreview,
  type ModDeploymentReceipt,
  type ModDeploymentReceiptHistoryPage,
  type ModDeploymentRecoveryStatus,
  type ModDeploymentRequest,
  type ModDeploymentServiceOptions,
  type ModDeploymentStateSummary,
  type StagedModPackageFile,
  type StagedModPackageManifest
} from './deployment-types.js'

const ACTIVE_MANIFEST_NAME = '.dyson-control-active.json'
const STAGED_MANIFEST_NAME = 'package-manifest.json'
const STAGED_PAYLOAD_NAME = 'payload'
const STATE_FORMAT = 'dyson-control-active-mod-deployment' as const
const RECEIPT_FORMAT = 'dyson-control-mod-deployment-receipt' as const
const RECEIPT_ENVELOPE_FORMAT = 'dyson-control-mod-deployment-receipt-envelope' as const
const RECEIPT_HISTORY_FORMAT = 'dyson-control-mod-deployment-receipt-history' as const
const RECOVERY_JOURNAL_FORMAT = 'dyson-control-mod-deployment-recovery-journal' as const
const TRANSACTION_LOCK_FORMAT = 'dyson-control-mod-deployment-transaction-lock' as const
const MAX_MOD_DEPLOYMENT_RECEIPT_BYTES = 16 * 1024
const MAX_MOD_DEPLOYMENT_RECOVERY_JOURNAL_BYTES = 16 * 1024 * 1024
const MAX_SNAPSHOTS_DEFAULT = 8
const MAX_MOD_DEPLOYMENT_TREE_ENTRIES = 2_048

const relativePayloadPathSchema = z.string().min(5).max(240).refine(isSafePayloadRelativePath)
const stagedFileSchema: z.ZodType<StagedModPackageFile> = z.strictObject({
  relativePath: relativePayloadPathSchema,
  sizeBytes: z.number().int().positive().max(MAX_STAGED_MOD_FILE_BYTES),
  sha256: sha256Schema
})
export const stagedModPackageManifestSchema: z.ZodType<StagedModPackageManifest> = z.strictObject({
  format: z.literal('dyson-control-staged-mod-package'),
  schemaVersion: z.literal(1),
  dependencyId: thunderstoreDependencyIdSchema,
  sourceId: z.string().min(3).max(160),
  version: z.string().min(5).max(64),
  dependencies: z.array(thunderstoreDependencyIdSchema).max(64),
  files: z.array(stagedFileSchema).min(1).max(MAX_STAGED_MOD_FILES)
})

const requestSchema: z.ZodType<ModDeploymentRequest> = z.strictObject({
  requestId: z.string().uuid().transform((value) => value.toLowerCase()),
  operation: z.enum(['install', 'update', 'enable', 'disable', 'remove']),
  package: z.strictObject({
    dependencyId: thunderstoreDependencyIdSchema,
    version: z.string().min(5).max(64)
  }),
  manifest: z.strictObject({
    serverLock: serverModLockSchema,
    clientParity: clientParityManifestSchema,
    platformLock: modPlatformLockSchema
  }),
  expectedRevision: sha256Schema.transform((value) => value.toLowerCase())
})

interface ManagedModPackage extends ServerModLockEntry {
  enabled: boolean
  payloadDirectory: string
  files: StagedModPackageFile[]
}

interface LastTransaction {
  requestId: string
  fingerprint: string
  operation: ModDeploymentOperation
  package: { dependencyId: string; version: string }
  previousRevision: string
  payloadFileCount: number
  payloadSizeBytes: number
  recoverablePayloadPreserved: boolean
}

interface ActiveModState {
  format: typeof STATE_FORMAT
  schemaVersion: 1
  revision: string
  packages: ManagedModPackage[]
  lastTransaction: LastTransaction | null
}

interface PreparedDeployment {
  request: ModDeploymentRequest
  fingerprint: string
  current: ActiveModState
  next: ActiveModState
  target: ServerModLockEntry
  currentTarget: ManagedModPackage | undefined
  staged: VerifiedStagedPackage | null
  payloadFileCount: number
  payloadSizeBytes: number
  snapshotCount: number
}

interface VerifiedStagedPackage {
  manifest: StagedModPackageManifest
  payloadRoot: string
  totalSizeBytes: number
}

interface LoadedStoredReceipt {
  fingerprint: string
  persistedAt: string
  receipt: ModDeploymentReceipt
}

interface RecoveryReceiptDirectoryEvidence {
  readonly final: ReadonlyMap<string, LoadedStoredReceipt>
  readonly pendingRequestIds: ReadonlySet<string>
}

interface ReceiptHistoryCursor {
  persistedAt: string
  requestId: string
}

interface DirectoryContentSummary {
  sha256: string
  fileCount: number
  directoryCount: number
  totalBytes: number
}

type RecoveryJournalPhase =
  | 'prepared'
  | 'forward-live-to-snapshot-intent'
  | 'forward-live-to-snapshot-completed'
  | 'forward-pending-to-live-intent'
  | 'forward-pending-to-live-completed'
  | 'rollback-live-to-failed-intent'
  | 'rollback-live-to-failed-completed'
  | 'rollback-snapshot-to-live-intent'
  | 'rollback-snapshot-to-live-completed'

interface ModDeploymentRecoveryJournal {
  format: typeof RECOVERY_JOURNAL_FORMAT
  schemaVersion: 1
  request: ModDeploymentRequest
  fingerprint: string
  previousRevision: string
  nextRevision: string
  paths: {
    pending: string
    snapshot: string
    failed: string
  }
  previousState: ActiveModState
  nextState: ActiveModState
  previousSummary: DirectoryContentSummary
  candidateSummary: DirectoryContentSummary
  successReceipt: ModDeploymentReceipt
  rolledBackReceipt: ModDeploymentReceipt
  phase: RecoveryJournalPhase
}

interface TransactionLockIdentity {
  dev: string
  ino: string
  birthtimeNs: string
}

interface TransactionLockRecord {
  format: typeof TRANSACTION_LOCK_FORMAT
  schemaVersion: 1
  owner: string
  journal: { requestId: string; fingerprint: string } | null
  identity: TransactionLockIdentity
}

interface OwnedTransactionLock {
  path: string
  handle: FileHandle
  record: TransactionLockRecord
}

type RecoveryLayout =
  | 'previous'
  | 'snapshot-only'
  | 'candidate'
  | 'failed-candidate'
  | 'restored-previous'

class UnknownModDeploymentWriteError extends ModDeploymentError {
  constructor() {
    super('MOD_DEPLOYMENT_EXECUTION_FAILED')
    this.name = 'UnknownModDeploymentWriteError'
  }
}

class CompletedLiveRenameFault extends Error {
  readonly journal: ModDeploymentRecoveryJournal
  readonly faultPhase: ModDeploymentFaultPhase

  constructor(journal: ModDeploymentRecoveryJournal, faultPhase: ModDeploymentFaultPhase, cause: unknown) {
    super('MOD_DEPLOYMENT_POST_RENAME_FAULT', { cause })
    this.name = 'CompletedLiveRenameFault'
    this.journal = journal
    this.faultPhase = faultPhase
  }
}

const managedPackageSchema: z.ZodType<ManagedModPackage> = z.strictObject({
  dependencyId: thunderstoreDependencyIdSchema,
  sourceId: z.string().min(3).max(160),
  version: z.string().min(5).max(64),
  sha256: sha256Schema,
  dependencies: z.array(thunderstoreDependencyIdSchema).max(64),
  loadOrder: z.number().int().nonnegative().max(511),
  root: z.boolean(),
  serverRequired: z.boolean(),
  clientRequirement: z.enum(['required', 'optional', 'not-required']),
  enabled: z.boolean(),
  payloadDirectory: z.string().regex(/^mod-[0-9a-f]{32}-[0-9a-f]{32}$/),
  files: z.array(stagedFileSchema).min(1).max(MAX_STAGED_MOD_FILES)
})

const lastTransactionSchema: z.ZodType<LastTransaction> = z.strictObject({
  requestId: z.string().uuid(),
  fingerprint: sha256Schema,
  operation: z.enum(['install', 'update', 'enable', 'disable', 'remove']),
  package: z.strictObject({ dependencyId: thunderstoreDependencyIdSchema, version: z.string().min(5).max(64) }),
  previousRevision: sha256Schema,
  payloadFileCount: z.number().int().nonnegative().max(MAX_STAGED_MOD_FILES),
  payloadSizeBytes: z.number().int().nonnegative().max(MAX_STAGED_MOD_TOTAL_BYTES),
  recoverablePayloadPreserved: z.boolean()
})

const activeStateSchema: z.ZodType<ActiveModState> = z.strictObject({
  format: z.literal(STATE_FORMAT),
  schemaVersion: z.literal(1),
  revision: sha256Schema,
  packages: z.array(managedPackageSchema).max(512),
  lastTransaction: lastTransactionSchema.nullable()
})

const publicReceiptSchema: z.ZodType<ModDeploymentReceipt> = z.strictObject({
  format: z.literal(RECEIPT_FORMAT),
  schemaVersion: z.literal(1),
  requestId: z.string().uuid(),
  operation: z.enum(['install', 'update', 'enable', 'disable', 'remove']),
  package: z.strictObject({ dependencyId: thunderstoreDependencyIdSchema, version: z.string().min(5).max(64) }),
  status: z.enum(['succeeded', 'rolled-back', 'rollback-failed']),
  previousRevision: sha256Schema,
  newRevision: sha256Schema.nullable(),
  rollback: z.enum(['not-needed', 'succeeded', 'failed']),
  recoveryPointCreated: z.boolean(),
  recoverablePayloadPreserved: z.boolean(),
  payloadFileCount: z.number().int().nonnegative().max(MAX_STAGED_MOD_FILES),
  payloadSizeBytes: z.number().int().nonnegative().max(MAX_STAGED_MOD_TOTAL_BYTES),
  errorCode: z.enum(['MOD_DEPLOYMENT_EXECUTION_FAILED', 'MOD_DEPLOYMENT_ROLLBACK_FAILED']).nullable(),
  reused: z.boolean()
})

const legacyStoredReceiptSchema = z.strictObject({
  fingerprint: sha256Schema,
  receipt: publicReceiptSchema
})

const storedReceiptEnvelopeSchema = z.strictObject({
  format: z.literal(RECEIPT_ENVELOPE_FORMAT),
  schemaVersion: z.literal(1),
  fingerprint: sha256Schema,
  persistedAt: z.string().datetime({ offset: true }),
  receipt: publicReceiptSchema
})

const directoryContentSummarySchema: z.ZodType<DirectoryContentSummary> = z.strictObject({
  sha256: sha256Schema,
  fileCount: z.number().int().nonnegative().max(MAX_MOD_DEPLOYMENT_TREE_ENTRIES),
  directoryCount: z.number().int().nonnegative().max(MAX_MOD_DEPLOYMENT_TREE_ENTRIES),
  totalBytes: z.number().int().nonnegative().max(MAX_DEPLOYED_MOD_TOTAL_BYTES + MAX_MOD_DEPLOYMENT_MANIFEST_BYTES)
})

const recoveryJournalPhaseSchema = z.enum([
  'prepared',
  'forward-live-to-snapshot-intent',
  'forward-live-to-snapshot-completed',
  'forward-pending-to-live-intent',
  'forward-pending-to-live-completed',
  'rollback-live-to-failed-intent',
  'rollback-live-to-failed-completed',
  'rollback-snapshot-to-live-intent',
  'rollback-snapshot-to-live-completed'
])

const recoveryJournalSchema: z.ZodType<ModDeploymentRecoveryJournal> = z.strictObject({
  format: z.literal(RECOVERY_JOURNAL_FORMAT),
  schemaVersion: z.literal(1),
  request: requestSchema,
  fingerprint: sha256Schema,
  previousRevision: sha256Schema,
  nextRevision: sha256Schema,
  paths: z.strictObject({
    pending: z.string().regex(/^pending\/[0-9a-f-]{36}$/),
    snapshot: z.string().regex(/^snapshots\/snapshot-[0-9a-f]{16}-[0-9a-f-]{36}$/),
    failed: z.string().regex(/^recovery\/failed-[0-9a-f-]{36}$/)
  }),
  previousState: activeStateSchema,
  nextState: activeStateSchema,
  previousSummary: directoryContentSummarySchema,
  candidateSummary: directoryContentSummarySchema,
  successReceipt: publicReceiptSchema,
  rolledBackReceipt: publicReceiptSchema,
  phase: recoveryJournalPhaseSchema
})

const transactionLockIdentitySchema: z.ZodType<TransactionLockIdentity> = z.strictObject({
  dev: z.string().regex(/^\d+$/),
  ino: z.string().regex(/^\d+$/),
  birthtimeNs: z.string().regex(/^\d+$/)
})

const transactionLockRecordSchema: z.ZodType<TransactionLockRecord> = z.strictObject({
  format: z.literal(TRANSACTION_LOCK_FORMAT),
  schemaVersion: z.literal(1),
  owner: z.string().uuid(),
  journal: z.strictObject({
    requestId: z.string().uuid(),
    fingerprint: sha256Schema
  }).nullable(),
  identity: transactionLockIdentitySchema
})

const receiptRequestIdSchema = z.string().uuid().transform((value) => value.toLowerCase())
const receiptHistoryQuerySchema = z.strictObject({
  cursor: z.string().min(1).max(MAX_MOD_DEPLOYMENT_HISTORY_CURSOR_LENGTH)
    .regex(/^[A-Za-z0-9_-]+$/).nullable().default(null),
  pageSize: z.number().int().min(1).max(MAX_MOD_DEPLOYMENT_HISTORY_PAGE_SIZE)
    .default(DEFAULT_MOD_DEPLOYMENT_HISTORY_PAGE_SIZE)
})

/** Hashes the canonical staged payload index used by ServerModLockEntry.sha256. */
export function computeStagedModPayloadDigest(input: StagedModPackageManifest): string {
  const manifest = parseAndValidateStagedManifest(input)
  return hashText(payloadDigestMaterial(manifest))
}

export class ModDeploymentService {
  readonly #stagingRoot: string
  readonly #pluginsRoot: string
  readonly #controlRoot: string
  readonly #verifyStoppedState: ModDeploymentServiceOptions['verifyStoppedState']
  readonly #hostMutationCoordinator: HostMutationOperationCoordinator | null
  readonly #hostMutationRecoveryCoordinator: HostMutationRecoveryOperationCoordinator | null
  readonly #readPlatformInventory: NonNullable<ModDeploymentServiceOptions['readPlatformInventory']> | null
  readonly #faultInjector: ModDeploymentServiceOptions['faultInjector']
  readonly #now: () => Date
  readonly #maxSnapshots: number
  #tail: Promise<void> = Promise.resolve()

  constructor(options: ModDeploymentServiceOptions) {
    if (!isAbsolute(options.stagingRoot) || !isAbsolute(options.pluginsRoot) ||
        typeof options.verifyStoppedState !== 'function' ||
        (options.hostMutationCoordinator !== undefined &&
          typeof options.hostMutationCoordinator.runExclusive !== 'function') ||
        (options.hostMutationRecoveryCoordinator !== undefined &&
          typeof options.hostMutationRecoveryCoordinator.runRecoveryExclusive !== 'function')) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_ROOT_INVALID')
    }
    this.#stagingRoot = resolve(options.stagingRoot)
    this.#pluginsRoot = resolve(options.pluginsRoot)
    this.#controlRoot = join(dirname(this.#pluginsRoot), `.${basename(this.#pluginsRoot)}.dyson-control`)
    if (samePath(this.#stagingRoot, this.#pluginsRoot) || isPathWithin(this.#stagingRoot, this.#pluginsRoot) ||
        isPathWithin(this.#pluginsRoot, this.#stagingRoot) || samePath(this.#stagingRoot, this.#controlRoot) ||
        isPathWithin(this.#stagingRoot, this.#controlRoot) || isPathWithin(this.#controlRoot, this.#stagingRoot)) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_ROOT_INVALID')
    }
    this.#verifyStoppedState = options.verifyStoppedState
    this.#hostMutationCoordinator = options.hostMutationCoordinator ?? null
    this.#hostMutationRecoveryCoordinator = options.hostMutationRecoveryCoordinator ?? null
    this.#readPlatformInventory = options.readPlatformInventory ?? null
    this.#faultInjector = options.faultInjector
    this.#now = options.now ?? (() => new Date())
    this.#maxSnapshots = options.maxSnapshots ?? MAX_SNAPSHOTS_DEFAULT
    if (!Number.isInteger(this.#maxSnapshots) || this.#maxSnapshots < 1 || this.#maxSnapshots > 64) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_ROOT_INVALID')
    }
  }

  async inspect(): Promise<ModDeploymentStateSummary> {
    return this.#exclusive(async () => this.#withFileLock(randomUUID(), async () => {
      const state = await this.#loadState()
      return summarizeState(state)
    }))
  }

  async preview(input: ModDeploymentRequest): Promise<ModDeploymentPreview> {
    const request = parseRequest(input)
    await this.#assertPlatformLockCurrent(request)
    return this.#exclusive(async () => this.#withFileLock(request.requestId, async () => {
      const current = await this.#loadState()
      const prepared = await this.#prepare(request, current)
      return toPreview(prepared, this.#maxSnapshots)
    }))
  }

  async execute(input: ModDeploymentRequest): Promise<ModDeploymentReceipt> {
    const request = parseRequest(input)
    const fingerprint = requestFingerprint(request)
    return this.#exclusive(async () => this.#withFileLock(request.requestId, async () => {
      await this.#assertNoRecoveryJournal()
      const stored = await this.#readReceipt(request.requestId)
      if (stored !== null) {
        if (stored.fingerprint !== fingerprint) throw new ModDeploymentError('MOD_DEPLOYMENT_IDEMPOTENCY_CONFLICT')
        return { ...stored.receipt, reused: true }
      }

      const current = await this.#loadState()
      if (current.lastTransaction?.requestId === request.requestId) {
        if (current.lastTransaction.fingerprint !== fingerprint) {
          throw new ModDeploymentError('MOD_DEPLOYMENT_IDEMPOTENCY_CONFLICT')
        }
        const reconstructed = receiptFromCommittedState(current)
        await this.#writeReceipt(fingerprint, reconstructed)
        return { ...reconstructed, reused: true }
      }

      await this.#assertPlatformLockCurrent(request)
      const prepared = await this.#prepare(request, current)
      return this.#executePreparedWithHostMutation(prepared)
    }, { requestId: request.requestId, fingerprint }, 'MOD_DEPLOYMENT_RECOVERY_REQUIRED'))
  }

  async reconcileInterrupted(
    requestIdInput: unknown,
    desiredInput: 'candidate' | 'previous',
    hostMutationScope: HostMutationOperationScope
  ): Promise<ModDeploymentReceipt> {
    const requestId = receiptRequestIdSchema.safeParse(requestIdInput)
    const desired = z.enum(['candidate', 'previous']).safeParse(desiredInput)
    if (!requestId.success || !desired.success) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_REQUEST_INVALID')
    }
    this.#assertHostMutationActive(hostMutationScope)
    return this.#exclusive(async () => {
      this.#assertHostMutationActive(hostMutationScope)
      await this.#readRecoveryOperationEvidence(requestId.data, desired.data)
      this.#assertHostMutationActive(hostMutationScope)
      const receipt = await this.#reconcileInterruptedTransaction(requestId.data, desired.data, hostMutationScope)
      this.#assertHostMutationActive(hostMutationScope)
      return receipt
    })
  }

  async recoverInterrupted(
    requestIdInput: unknown,
    desiredInput: 'candidate' | 'previous'
  ): Promise<ModDeploymentReceipt> {
    const requestId = receiptRequestIdSchema.safeParse(requestIdInput)
    const desired = z.enum(['candidate', 'previous']).safeParse(desiredInput)
    if (!requestId.success || !desired.success) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_REQUEST_INVALID')
    }
    const coordinator = this.#hostMutationRecoveryCoordinator
    if (coordinator === null) throw new ModDeploymentError('MOD_DEPLOYMENT_HOST_LEASE_UNAVAILABLE')

    const evidence = await this.#exclusive(async () =>
      this.#readRecoveryOperationEvidence(requestId.data, desired.data))
    try {
      return await coordinator.runRecoveryExclusive({
        expectedOperation: `mod-deployment-${evidence.operation}`,
        expectedRequestId: requestId.data
      }, async (scope) => {
        try {
          this.#assertHostMutationActive(scope)
          const receipt = await this.reconcileInterrupted(requestId.data, desired.data, scope)
          this.#assertHostMutationActive(scope)
          const persisted = await this.#exclusive(async () =>
            this.#readCompletedReconciliation(requestId.data, desired.data))
          if (persisted === null ||
              JSON.stringify({ ...persisted, reused: false }) !== JSON.stringify({ ...receipt, reused: false })) {
            return hostMutationThrow<ModDeploymentReceipt>(
              new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED'),
              'abandon'
            )
          }
          return hostMutationReturn(receipt, 'release')
        } catch (error) {
          if (error instanceof HostMutationOperationCoordinatorError) throw error
          return hostMutationThrow<ModDeploymentReceipt>(
            error instanceof ModDeploymentError
              ? error
              : new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED'),
            'abandon'
          )
        }
      })
    } catch (error) {
      if (error instanceof ModDeploymentError) throw error
      if (error instanceof HostMutationOperationCoordinatorError) {
        if (error.code === 'HOST_MUTATION_LEASE_RECOVERY_NOT_REQUIRED') {
          const replay = await this.#exclusive(async () =>
            this.#readCompletedReconciliation(requestId.data, desired.data))
          if (replay !== null) return replay
          throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
        }
        throw new ModDeploymentError(mapHostMutationCoordinatorError(error.code))
      }
      throw new ModDeploymentError('MOD_DEPLOYMENT_HOST_LEASE_UNAVAILABLE')
    }
  }

  async recoveryStatus(): Promise<ModDeploymentRecoveryStatus> {
    return this.#exclusive(async () => this.#readRecoveryStatus())
  }

  async getReceipt(input: unknown): Promise<ModDeploymentReceipt | null> {
    const parsed = receiptRequestIdSchema.safeParse(input)
    if (!parsed.success) throw new ModDeploymentError('MOD_DEPLOYMENT_RECEIPT_REQUEST_INVALID')
    return this.#exclusive(async () => this.#withFileLock(parsed.data, async () => {
      const stored = await this.#readReceipt(parsed.data)
      return stored === null ? null : { ...stored.receipt, reused: false }
    }))
  }

  async history(input: unknown = {}): Promise<ModDeploymentReceiptHistoryPage> {
    const parsed = receiptHistoryQuerySchema.safeParse(input)
    if (!parsed.success) throw new ModDeploymentError('MOD_DEPLOYMENT_HISTORY_REQUEST_INVALID')
    let cursor: ReceiptHistoryCursor | null
    try {
      cursor = decodeReceiptHistoryCursor(parsed.data.cursor)
    } catch {
      throw new ModDeploymentError('MOD_DEPLOYMENT_HISTORY_CURSOR_INVALID')
    }
    return this.#exclusive(async () => this.#withFileLock(randomUUID(), async () => {
      const ordered = await this.#readReceiptHistory()
      let offset = 0
      if (cursor !== null) {
        const cursorIndex = ordered.findIndex((entry) =>
          entry.persistedAt === cursor.persistedAt && entry.receipt.requestId === cursor.requestId)
        if (cursorIndex < 0) throw new ModDeploymentError('MOD_DEPLOYMENT_HISTORY_CURSOR_INVALID')
        offset = cursorIndex + 1
      }
      const selected = ordered.slice(offset, offset + parsed.data.pageSize)
      const nextOffset = offset + selected.length
      return {
        format: RECEIPT_HISTORY_FORMAT,
        schemaVersion: 1,
        order: 'persisted-at-descending',
        items: selected.map((entry) => ({
          persistedAt: entry.persistedAt,
          receipt: { ...entry.receipt, reused: false }
        })),
        page: {
          limit: parsed.data.pageSize,
          returned: selected.length,
          totalReceipts: ordered.length,
          nextCursor: nextOffset < ordered.length && selected.length > 0
            ? encodeReceiptHistoryCursor(selected[selected.length - 1]!)
            : null
        }
      }
    }))
  }

  async previewCleanup(): Promise<ModDeploymentCleanupPlan> {
    return this.#exclusive(async () => this.#withFileLock(randomUUID(), async () => {
      const candidates: ModDeploymentCleanupCandidate[] = []
      for (const [directory, kind] of [
        ['snapshots', 'snapshot'],
        ['recovery', 'failed-publication'],
        ['pending', 'abandoned-pending']
      ] as const) {
        const root = await this.#ensureControlDirectory(directory)
        for (const entry of await readdir(root, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[A-Za-z0-9._-]{1,160}$/.test(entry.name)) {
            throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
          }
          candidates.push({ id: entry.name, kind })
        }
      }
      candidates.sort((left, right) => compareText(`${left.kind}:${left.id}`, `${right.kind}:${right.id}`))
      return { dryRun: true, irreversible: true, executeSupported: false, candidates }
    }))
  }

  async #prepare(request: ModDeploymentRequest, current: ActiveModState): Promise<PreparedDeployment> {
    if (request.expectedRevision !== current.revision) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_REVISION_CONFLICT')
    }
    let validated: ReturnType<typeof validateModManifestPair>
    try {
      validated = validateModManifestPair(request.manifest.serverLock, request.manifest.clientParity)
    } catch {
      throw new ModDeploymentError('MOD_DEPLOYMENT_MANIFEST_INVALID')
    }
    const identity = parseThunderstoreDependency(request.package.dependencyId)
    if (identity.version !== request.package.version) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_TARGET_MISMATCH')
    }
    const target = validated.serverLock.mods.find((entry) =>
      entry.dependencyId.toLowerCase() === request.package.dependencyId.toLowerCase())
    if (target === undefined) throw new ModDeploymentError('MOD_DEPLOYMENT_TARGET_MISSING')
    if (target.version !== request.package.version || target.sourceId.toLowerCase() !== identity.sourceId.toLowerCase()) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_TARGET_MISMATCH')
    }

    const currentTarget = current.packages.find((entry) => entry.sourceId.toLowerCase() === target.sourceId.toLowerCase())
    assertOperationPreconditions(request.operation, target, currentTarget)
    assertManifestCoversState(request.operation, validated.serverLock.mods, current.packages, target)

    const needsStaging = request.operation === 'install' || request.operation === 'update' || request.operation === 'enable'
    const staged = needsStaging ? await this.#verifyStagedPackage(target) : null
    const payloadFiles = staged?.manifest.files ?? currentTarget?.files
    if (payloadFiles === undefined) throw new ModDeploymentError('MOD_DEPLOYMENT_NOT_INSTALLED')
    const payloadSizeBytes = sumPayloadBytes(payloadFiles)

    const nextPackages = buildNextPackages(request.operation, validated.serverLock.mods, current.packages, target,
      staged?.manifest.files ?? null)
    assertEnabledDependencyClosure(nextPackages, request.operation, target)
    const fingerprint = requestFingerprint(request)
    const lastTransaction: LastTransaction = {
      requestId: request.requestId,
      fingerprint,
      operation: request.operation,
      package: { ...request.package },
      previousRevision: current.revision,
      payloadFileCount: payloadFiles.length,
      payloadSizeBytes,
      recoverablePayloadPreserved: request.operation === 'remove' || request.operation === 'disable' ||
        request.operation === 'update'
    }
    const next = createState(nextPackages, lastTransaction)
    const snapshotCount = await this.#snapshotCount()
    return {
      request,
      fingerprint,
      current,
      next,
      target,
      currentTarget,
      staged,
      payloadFileCount: payloadFiles.length,
      payloadSizeBytes,
      snapshotCount
    }
  }

  async #assertPlatformLockCurrent(request: ModDeploymentRequest): Promise<void> {
    let serverLockSha256: string
    try {
      serverLockSha256 = validateModManifestPair(
        request.manifest.serverLock,
        request.manifest.clientParity
      ).serverLockSha256
    } catch {
      throw new ModDeploymentError('MOD_DEPLOYMENT_MANIFEST_INVALID')
    }
    let platformLock
    try {
      platformLock = validateModPlatformLock(request.manifest.platformLock, serverLockSha256)
    } catch (error) {
      if (error instanceof ModPlatformLockError) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_PLATFORM_LOCK_INVALID')
      }
      throw error
    }
    if (platformLock.requirements.length === 0) return
    const readPlatformInventory = this.#readPlatformInventory
    if (readPlatformInventory === null) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_PLATFORM_INVENTORY_UNAVAILABLE')
    }
    let current: Awaited<ReturnType<NonNullable<ModDeploymentServiceOptions['readPlatformInventory']>>>
    try {
      current = await readPlatformInventory()
    } catch {
      throw new ModDeploymentError('MOD_DEPLOYMENT_PLATFORM_INVENTORY_UNAVAILABLE')
    }
    if (!/^[0-9a-f]{64}$/.test(current.inventoryRevision) || typeof current.inventory.nebula !== 'string' ||
        typeof current.inventory.bepInEx !== 'string') {
      throw new ModDeploymentError('MOD_DEPLOYMENT_PLATFORM_INVENTORY_UNAVAILABLE')
    }
    if (platformLock.inventoryRevision !== current.inventoryRevision) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_PLATFORM_INVENTORY_DRIFT')
    }
    for (const requirement of platformLock.requirements) {
      const actualVersion = requirement.deploymentOwner === 'nebula'
        ? current.inventory.nebula
        : current.inventory.bepInEx
      if (actualVersion !== requirement.requiredVersion) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_PLATFORM_VERSION_MISMATCH')
      }
    }
  }

  async #executePrepared(
    prepared: PreparedDeployment,
    hostMutationScope: HostMutationOperationScope | null = null
  ): Promise<ModDeploymentReceipt> {
    if (prepared.snapshotCount >= this.#maxSnapshots) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_SNAPSHOT_LIMIT')
    }
    await this.#assertStopped(hostMutationScope)
    const pendingRoot = await this.#pendingPath(prepared.request.requestId)
    await this.#buildPendingTree(prepared, pendingRoot)
    this.#assertHostMutationActive(hostMutationScope)
    await syncDirectoryTree(pendingRoot)
    await syncDirectory(dirname(pendingRoot))
    this.#assertHostMutationActive(hostMutationScope)
    await this.#injectFault('after-pending-built')
    await this.#assertStopped(hostMutationScope)
    await this.#assertPlatformLockWithinHostMutation(prepared.request, hostMutationScope)

    const snapshotsRoot = await this.#ensureControlDirectory('snapshots')
    const snapshotId = `snapshot-${prepared.current.revision.slice(0, 16)}-${prepared.request.requestId}`
    const snapshotRoot = join(snapshotsRoot, snapshotId)
    const recoveryRoot = await this.#ensureControlDirectory('recovery')
    const failedRoot = join(recoveryRoot, `failed-${prepared.request.requestId}`)
    await assertPathDoesNotExist(snapshotRoot)
    await assertPathDoesNotExist(failedRoot)
    const previousSummary = await summarizeDirectoryContents(this.#pluginsRoot)
    const candidateSummary = await summarizeDirectoryContents(pendingRoot)
    let journal = createRecoveryJournal(
      prepared,
      previousSummary,
      candidateSummary,
      snapshotId
    )
    await this.#writeRecoveryJournal(journal, true, hostMutationScope)
    let snapshotCreated = false
    let published = false
    try {
      journal = await this.#recordedRename(
        journal,
        'forward-live-to-snapshot-intent',
        'forward-live-to-snapshot-completed',
        this.#pluginsRoot,
        snapshotRoot,
        'after-snapshot',
        hostMutationScope
      )
      snapshotCreated = true
      journal = await this.#recordedRename(
        journal,
        'forward-pending-to-live-intent',
        'forward-pending-to-live-completed',
        pendingRoot,
        this.#pluginsRoot,
        'after-publish',
        hostMutationScope
      )
      published = true
      const receipt = successReceipt(prepared)
      await this.#writeReceipt(prepared.fingerprint, receipt, hostMutationScope)
      await this.#removeRecoveryJournal(prepared.request.requestId, hostMutationScope)
      this.#assertHostMutationActive(hostMutationScope)
      return receipt
    } catch (caught) {
      if (caught instanceof HostMutationOperationCoordinatorError) throw caught
      if (caught instanceof CompletedLiveRenameFault) {
        journal = caught.journal
        if (caught.faultPhase === 'after-snapshot') snapshotCreated = true
        if (caught.faultPhase === 'after-publish') published = true
      }
      if (!snapshotCreated) {
        throw new UnknownModDeploymentWriteError()
      }
      const rollback = await this.#rollbackPublication(
        journal,
        snapshotRoot,
        failedRoot,
        published,
        hostMutationScope
      )
      journal = rollback.journal
      const receipt = rollbackReceipt(prepared, rollback.succeeded)
      try {
        await this.#writeReceipt(prepared.fingerprint, receipt, hostMutationScope)
        if (rollback.succeeded) {
          await this.#removeRecoveryJournal(prepared.request.requestId, hostMutationScope)
        }
      } catch (error) {
        if (error instanceof HostMutationOperationCoordinatorError) throw error
        if (rollback.succeeded) throw new UnknownModDeploymentWriteError()
        // The unresolved publication already requires an abandoned lease; preserve that result.
      }
      if (rollback.succeeded) this.#assertHostMutationActive(hostMutationScope)
      return receipt
    }
  }

  async #executePreparedWithHostMutation(prepared: PreparedDeployment): Promise<ModDeploymentReceipt> {
    const coordinator = this.#hostMutationCoordinator
    if (coordinator === null) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_HOST_LEASE_UNAVAILABLE')
    }

    try {
      return await coordinator.runExclusive(
        {
          operation: `mod-deployment-${prepared.request.operation}`,
          requestId: prepared.request.requestId
        },
        async (scope) => {
          try {
            await this.#assertPlatformLockWithinHostMutation(prepared.request, scope)
            const receipt = await this.#executePrepared(prepared, scope)
            return hostMutationReturn(
              receipt,
              receipt.status === 'rollback-failed' ? 'abandon' : 'release'
            )
          } catch (error) {
            if (error instanceof HostMutationOperationCoordinatorError) throw error
            if (error instanceof UnknownModDeploymentWriteError) {
              return hostMutationThrow(error, 'abandon')
            }
            if (error instanceof ModDeploymentError) {
              return hostMutationThrow(error, 'release')
            }
            return hostMutationThrow(
              new ModDeploymentError('MOD_DEPLOYMENT_EXECUTION_FAILED'),
              'abandon'
            )
          }
        }
      )
    } catch (error) {
      if (error instanceof HostMutationOperationCoordinatorError) {
        throw new ModDeploymentError(mapHostMutationCoordinatorError(error.code))
      }
      throw error
    }
  }

  async #assertPlatformLockWithinHostMutation(
    request: ModDeploymentRequest,
    scope: HostMutationOperationScope | null
  ): Promise<void> {
    this.#assertHostMutationActive(scope)
    await this.#assertPlatformLockCurrent(request)
    this.#assertHostMutationActive(scope)
  }

  async #buildPendingTree(prepared: PreparedDeployment, pendingRoot: string): Promise<void> {
    await mkdir(pendingRoot)
    await assertDirectoryBoundary(pendingRoot, this.#controlRoot)
    const currentBySource = new Map(prepared.current.packages.map((entry) => [entry.sourceId.toLowerCase(), entry]))
    for (const entry of prepared.next.packages) {
      if (!entry.enabled) continue
      const destination = join(pendingRoot, entry.payloadDirectory)
      const isTarget = entry.sourceId.toLowerCase() === prepared.target.sourceId.toLowerCase()
      if (isTarget && prepared.staged !== null &&
          (prepared.request.operation === 'install' || prepared.request.operation === 'update' ||
           prepared.request.operation === 'enable')) {
        await copyVerifiedPayload(prepared.staged.payloadRoot, destination, entry.files)
      } else {
        const current = currentBySource.get(entry.sourceId.toLowerCase())
        if (current === undefined || !current.enabled || current.payloadDirectory !== entry.payloadDirectory) {
          throw new ModDeploymentError('MOD_DEPLOYMENT_STATE_INVALID')
        }
        await copyVerifiedPayload(join(this.#pluginsRoot, current.payloadDirectory), destination, entry.files)
      }
    }
    await writeJsonExclusive(join(pendingRoot, ACTIVE_MANIFEST_NAME), prepared.next)
    await this.#verifyManagedTree(pendingRoot, prepared.next)
  }

  async #rollbackPublication(
    journalInput: ModDeploymentRecoveryJournal,
    snapshotRoot: string,
    failedRoot: string,
    published: boolean,
    hostMutationScope: HostMutationOperationScope | null
  ): Promise<{ succeeded: boolean; journal: ModDeploymentRecoveryJournal }> {
    let journal = journalInput
    try {
      if (published) {
        await assertPathDoesNotExist(failedRoot)
        journal = await this.#recordedRename(
          journal,
          'rollback-live-to-failed-intent',
          'rollback-live-to-failed-completed',
          this.#pluginsRoot,
          failedRoot,
          'after-rollback-failed-move',
          hostMutationScope
        )
      }
      journal = await this.#recordedRename(
        journal,
        'rollback-snapshot-to-live-intent',
        'rollback-snapshot-to-live-completed',
        snapshotRoot,
        this.#pluginsRoot,
        'after-rollback-restore',
        hostMutationScope
      )
      await assertDirectoryBoundary(this.#pluginsRoot, dirname(this.#pluginsRoot))
      return { succeeded: true, journal }
    } catch (error) {
      if (error instanceof HostMutationOperationCoordinatorError) throw error
      if (error instanceof CompletedLiveRenameFault) journal = error.journal
      return { succeeded: false, journal }
    }
  }

  async #recordedRename(
    journal: ModDeploymentRecoveryJournal,
    intentPhase: RecoveryJournalPhase,
    completedPhase: RecoveryJournalPhase,
    source: string,
    destination: string,
    faultPhase: ModDeploymentFaultPhase,
    hostMutationScope: HostMutationOperationScope | null
  ): Promise<ModDeploymentRecoveryJournal> {
    const intent = recoveryJournalSchema.parse({ ...journal, phase: intentPhase })
    if (journal.phase !== intentPhase) {
      await this.#writeRecoveryJournal(intent, false, hostMutationScope)
    }
    let renamed = false
    try {
      this.#assertHostMutationActive(hostMutationScope)
      await rename(source, destination)
      renamed = true
      await syncRenameParents(source, destination)
      this.#assertHostMutationActive(hostMutationScope)
      await this.#injectFault(faultPhase)
      const completed = recoveryJournalSchema.parse({ ...intent, phase: completedPhase })
      await this.#writeRecoveryJournal(completed, false, hostMutationScope)
      return completed
    } catch (error) {
      if (error instanceof HostMutationOperationCoordinatorError) throw error
      if (renamed) throw new CompletedLiveRenameFault(intent, faultPhase, error)
      throw error
    }
  }

  async #assertNoRecoveryJournal(): Promise<void> {
    const root = join(this.#controlRoot, 'journals')
    const info = await lstat(root).catch((error: unknown) => isMissingError(error) ? null : Promise.reject(error))
    if (info === null) {
      await this.#ensureControlDirectory('journals')
      return
    }
    await assertDirectoryBoundary(root, this.#controlRoot)
    const entries = await readdir(root, { withFileTypes: true })
    if (entries.length !== 0) throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
  }

  async #readRecoveryJournal(requestId: string): Promise<ModDeploymentRecoveryJournal> {
    const root = join(this.#controlRoot, 'journals')
    await assertDirectoryBoundary(root, this.#controlRoot)
    const entries = await readdir(root, { withFileTypes: true })
    if (entries.length !== 1 || !entries[0]!.isFile() || entries[0]!.isSymbolicLink() ||
        entries[0]!.name !== `${requestId}.json`) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    }
    const filePath = join(root, entries[0]!.name)
    let journal: ModDeploymentRecoveryJournal
    try {
      journal = recoveryJournalSchema.parse(await readStableBoundedJson(filePath))
    } catch {
      throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    }
    validateRecoveryJournal(journal)
    if (journal.request.requestId !== requestId) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    }
    return journal
  }

  async #readRecoveryJournalFile(filePath: string, requestId: string): Promise<ModDeploymentRecoveryJournal> {
    let journal: ModDeploymentRecoveryJournal
    try {
      journal = recoveryJournalSchema.parse(await readStableBoundedJson(filePath))
    } catch {
      throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    }
    validateRecoveryJournal(journal)
    if (journal.request.requestId !== requestId) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    }
    return journal
  }

  async #recoverPendingRecoveryJournal(
    requestId: string,
    lock: OwnedTransactionLock,
    hostMutationScope: HostMutationOperationScope
  ): Promise<ModDeploymentRecoveryJournal> {
    const evidence = await this.#inspectRecoveryJournalEvidence(requestId, lock)
    if (evidence.pendingPath === null) return evidence.journal
    this.#assertHostMutationActive(hostMutationScope)
    await rename(evidence.pendingPath, evidence.finalPath)
    await syncDirectory(dirname(evidence.finalPath))
    this.#assertHostMutationActive(hostMutationScope)
    return evidence.journal
  }

  async #inspectRecoveryJournalEvidence(
    requestId: string,
    lock: OwnedTransactionLock
  ): Promise<{
      journal: ModDeploymentRecoveryJournal
      pendingPath: string | null
      finalPath: string
      layout: RecoveryLayout
    }> {
    const root = join(this.#controlRoot, 'journals')
    await assertDirectoryBoundary(root, this.#controlRoot)
    const finalPath = join(root, `${requestId}.json`)
    const pendingPath = join(root, `${requestId}.pending`)
    const entries = await readdir(root, { withFileTypes: true })
    const allowedNames = new Set([`${requestId}.json`, `${requestId}.pending`])
    if (entries.length < 1 || entries.length > 2 || entries.some((entry) =>
      !entry.isFile() || entry.isSymbolicLink() || !allowedNames.has(entry.name))) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    }

    const pendingExists = entries.some((entry) => entry.name === `${requestId}.pending`)
    if (!pendingExists) {
      const journal = await this.#readRecoveryJournal(requestId)
      return {
        journal,
        pendingPath: null,
        finalPath,
        layout: await this.#classifyRecoveryLayout(journal)
      }
    }

    const pending = await this.#readRecoveryJournalFile(pendingPath, requestId)
    if (lock.record.journal?.fingerprint !== pending.fingerprint) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    }
    const finalExists = entries.some((entry) => entry.name === `${requestId}.json`)
    if (finalExists) {
      const current = await this.#readRecoveryJournalFile(finalPath, requestId)
      if (!sameRecoveryJournalBinding(current, pending) ||
          !isRecoveryJournalTransitionAllowed(current.phase, pending.phase)) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
      }
    } else if (pending.phase !== 'prepared') {
      throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    }
    const layout = await this.#classifyRecoveryLayout(pending)
    return { journal: pending, pendingPath, finalPath, layout }
  }

  async #writeRecoveryJournal(
    journalInput: ModDeploymentRecoveryJournal,
    initial: boolean,
    hostMutationScope: HostMutationOperationScope | null
  ): Promise<void> {
    const journal = recoveryJournalSchema.parse(journalInput)
    validateRecoveryJournal(journal)
    const root = initial
      ? await this.#ensureControlDirectory('journals')
      : join(this.#controlRoot, 'journals')
    if (!initial) await assertDirectoryBoundary(root, this.#controlRoot)
    const filePath = join(root, `${journal.request.requestId}.json`)
    const pendingPath = join(root, `${journal.request.requestId}.pending`)
    if (initial) await assertPathDoesNotExist(filePath)
    else {
      const existing = await this.#readRecoveryJournal(journal.request.requestId)
      if (!sameRecoveryJournalBinding(existing, journal) ||
          !isRecoveryJournalTransitionAllowed(existing.phase, journal.phase)) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
      }
    }
    await assertPathDoesNotExist(pendingPath)
    this.#assertHostMutationActive(hostMutationScope)
    await writeJsonAtomic(
      filePath,
      pendingPath,
      journal,
      () => this.#assertHostMutationActive(hostMutationScope),
      async () => this.#injectFault('after-journal-pending-synced')
    )
    this.#assertHostMutationActive(hostMutationScope)
  }

  async #removeRecoveryJournal(
    requestId: string,
    hostMutationScope: HostMutationOperationScope | null
  ): Promise<void> {
    const root = join(this.#controlRoot, 'journals')
    const filePath = join(root, `${requestId}.json`)
    this.#assertHostMutationActive(hostMutationScope)
    await unlink(filePath)
    await syncDirectory(root)
    this.#assertHostMutationActive(hostMutationScope)
  }

  async #readResidualTransactionLock(
    requestId?: string,
    readOnly = false
  ): Promise<OwnedTransactionLock> {
    const lockPath = join(this.#controlRoot, 'transaction.lock')
    let handle: FileHandle | null = null
    try {
      await assertDirectoryBoundary(this.#controlRoot, dirname(this.#controlRoot))
      handle = await open(lockPath, readOnly ? constants.O_RDONLY : constants.O_RDWR)
      const before = await handle.stat({ bigint: true })
      const pathBefore = await lstat(lockPath, { bigint: true })
      const content = await handle.readFile('utf8')
      const after = await handle.stat({ bigint: true })
      const pathAfter = await lstat(lockPath, { bigint: true })
      const record = transactionLockRecordSchema.parse(JSON.parse(content) as unknown)
      const identity = transactionLockIdentity(before)
      if (!sameFileSnapshot(before, after) || !sameFileSnapshot(pathBefore, pathAfter) ||
          !sameTransactionLockIdentity(identity, transactionLockIdentity(after)) ||
          !sameTransactionLockIdentity(identity, transactionLockIdentity(pathBefore)) ||
          !sameTransactionLockIdentity(identity, transactionLockIdentity(pathAfter)) ||
          !sameTransactionLockIdentity(identity, record.identity) ||
          (requestId !== undefined &&
            (record.owner !== requestId || record.journal?.requestId !== requestId))) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
      }
      return { path: lockPath, handle, record }
    } catch (error) {
      await handle?.close().catch(() => undefined)
      if (error instanceof ModDeploymentError) throw error
      throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    }
  }

  async #reconcileInterruptedTransaction(
    requestId: string,
    desired: 'candidate' | 'previous',
    hostMutationScope: HostMutationOperationScope
  ): Promise<ModDeploymentReceipt> {
    const completed = await this.#replayCompletedReconciliation(requestId, desired, hostMutationScope)
    if (completed !== null) return completed
    const lock = await this.#readResidualTransactionLock(requestId)
    let released = false
    try {
      const journalPath = join(this.#controlRoot, 'journals', `${requestId}.json`)
      const journalPendingPath = join(this.#controlRoot, 'journals', `${requestId}.pending`)
      if (!await pathExists(journalPath) && !await pathExists(journalPendingPath)) {
        let terminal = await this.#readReceipt(requestId, false)
        const receiptPending = await pathExists(join(this.#controlRoot, 'receipts', `${requestId}.pending`))
        if (terminal !== null && receiptPending) {
          throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
        }
        if (terminal === null && receiptPending) {
          const committed = await this.#readCommittedReceiptPendingEvidence(requestId, lock)
          await this.#publishMatchingPendingReceipt(
            committed.fingerprint, committed.receipt, hostMutationScope
          )
          terminal = await this.#readReceipt(requestId, false)
        }
        if (terminal === null || terminal.fingerprint !== lock.record.journal!.fingerprint ||
            (terminal.receipt.status !== 'succeeded' && terminal.receipt.status !== 'rolled-back')) {
          throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
        }
        if ((terminal.receipt.status === 'succeeded' && desired !== 'candidate') ||
            (terminal.receipt.status === 'rolled-back' && desired !== 'previous')) {
          throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_TARGET_NOT_ALLOWED')
        }
        this.#assertHostMutationActive(hostMutationScope)
        await this.#releaseOwnedLock(lock, hostMutationScope)
        released = true
        return { ...terminal.receipt, reused: true }
      }

      const journal = await this.#recoverPendingRecoveryJournal(requestId, lock, hostMutationScope)
      if (lock.record.journal!.fingerprint !== journal.fingerprint) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
      }
      let currentJournal = journal
      let layout = await this.#classifyRecoveryLayout(currentJournal)
      const existing = await this.#readReceipt(requestId, false)
      if (existing !== null &&
          await pathExists(join(this.#controlRoot, 'receipts', `${requestId}.pending`))) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
      }
      if (existing !== null && (existing.fingerprint !== journal.fingerprint ||
          (JSON.stringify(existing.receipt) !== JSON.stringify(journal.successReceipt) &&
           JSON.stringify(existing.receipt) !== JSON.stringify(journal.rolledBackReceipt)))) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
      }
      if (existing !== null) {
        const success = JSON.stringify(existing.receipt) === JSON.stringify(journal.successReceipt)
        const rolledBack = JSON.stringify(existing.receipt) === JSON.stringify(journal.rolledBackReceipt)
        if ((success && layout !== 'candidate') ||
            (rolledBack && layout !== 'previous' && layout !== 'restored-previous')) {
          throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
        }
        if ((success && desired !== 'candidate') || (rolledBack && desired !== 'previous')) {
          throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_TARGET_NOT_ALLOWED')
        }
        await this.#removeRecoveryJournal(requestId, hostMutationScope)
        await this.#releaseOwnedLock(lock, hostMutationScope)
        released = true
        return { ...existing.receipt, reused: true }
      }

      if (layout === 'candidate' && desired === 'candidate') {
        const receipt = await this.#persistRecoveryReceipt(
          journal.fingerprint, journal.successReceipt, existing, hostMutationScope
        )
        await this.#removeRecoveryJournal(requestId, hostMutationScope)
        await this.#releaseOwnedLock(lock, hostMutationScope)
        released = true
        return receipt
      }

      if (layout === 'snapshot-only' || layout === 'candidate' || layout === 'failed-candidate') {
        await this.#assertStopped(hostMutationScope)
        const revalidated = await this.#classifyRecoveryLayout(currentJournal)
        if (revalidated !== layout) throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
      }

      const paths = this.#recoveryPaths(currentJournal)
      if (layout === 'candidate') {
        currentJournal = await this.#recordedRename(
          currentJournal,
          'rollback-live-to-failed-intent',
          'rollback-live-to-failed-completed',
          paths.live,
          paths.failed,
          'after-rollback-failed-move',
          hostMutationScope
        )
        layout = 'failed-candidate'
      }
      if (layout === 'snapshot-only' || layout === 'failed-candidate') {
        currentJournal = await this.#recordedRename(
          currentJournal,
          'rollback-snapshot-to-live-intent',
          'rollback-snapshot-to-live-completed',
          paths.snapshot,
          paths.live,
          'after-rollback-restore',
          hostMutationScope
        )
      }
      const finalLayout = await this.#classifyRecoveryLayout(currentJournal)
      if (finalLayout !== 'previous' && finalLayout !== 'restored-previous') {
        throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
      }
      const receipt = await this.#persistRecoveryReceipt(
        journal.fingerprint, journal.rolledBackReceipt, existing, hostMutationScope
      )
      await this.#removeRecoveryJournal(requestId, hostMutationScope)
      await this.#releaseOwnedLock(lock, hostMutationScope)
      released = true
      return receipt
    } catch (error) {
      if (error instanceof CompletedLiveRenameFault) {
        throw error.cause
      }
      throw error
    } finally {
      if (!released) await lock.handle.close().catch(() => undefined)
    }
  }

  async #replayCompletedReconciliation(
    requestId: string,
    desired: 'candidate' | 'previous',
    hostMutationScope: HostMutationOperationScope
  ): Promise<ModDeploymentReceipt | null> {
    this.#assertHostMutationActive(hostMutationScope)
    const completed = await this.#readCompletedReconciliation(requestId, desired)
    this.#assertHostMutationActive(hostMutationScope)
    return completed
  }

  async #readCompletedReconciliation(
    requestId: string,
    desired: 'candidate' | 'previous'
  ): Promise<ModDeploymentReceipt | null> {
    const lockPath = join(this.#controlRoot, 'transaction.lock')
    if (await pathExists(lockPath)) return null

    const journalsRoot = join(this.#controlRoot, 'journals')
    const journalRootInfo = await lstat(journalsRoot).catch((error: unknown) =>
      isMissingError(error) ? null : Promise.reject(error))
    if (journalRootInfo !== null) {
      await assertDirectoryBoundary(journalsRoot, this.#controlRoot)
      if ((await readdir(journalsRoot)).length !== 0) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
      }
    }

    const receiptsRoot = join(this.#controlRoot, 'receipts')
    if (await pathExists(join(receiptsRoot, `${requestId}.pending`))) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    }
    const stored = await this.#readReceipt(requestId, false)
    if (stored === null) return null

    const current = await this.#loadState(false)
    if (stored.receipt.status === 'succeeded') {
      if (current.lastTransaction?.requestId !== requestId ||
          current.lastTransaction.fingerprint !== stored.fingerprint ||
          JSON.stringify(stored.receipt) !== JSON.stringify(receiptFromCommittedState(current))) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
      }
      if (desired !== 'candidate') {
        throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_TARGET_NOT_ALLOWED')
      }
    } else if (stored.receipt.status === 'rolled-back') {
      if (stored.receipt.newRevision !== stored.receipt.previousRevision ||
          stored.receipt.rollback !== 'succeeded' ||
          stored.receipt.errorCode !== 'MOD_DEPLOYMENT_EXECUTION_FAILED' ||
          current.revision !== stored.receipt.previousRevision) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
      }
      if (desired !== 'previous') {
        throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_TARGET_NOT_ALLOWED')
      }
    } else {
      throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    }
    return { ...stored.receipt, reused: true }
  }

  async #readRecoveryStatus(): Promise<ModDeploymentRecoveryStatus> {
    try {
      const controlInfo = await lstat(this.#controlRoot).catch((error: unknown) =>
        isMissingError(error) ? null : Promise.reject(error))
      if (controlInfo === null) {
        const current = await this.#loadState(false)
        if (current.lastTransaction !== null) throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
        return { phase: 'ready', requestId: null, operation: null, allowedDesired: [] }
      }
      await assertDirectoryBoundary(this.#controlRoot, dirname(this.#controlRoot))

      const receiptEvidence = await this.#readRecoveryReceiptDirectoryEvidence()
      if ([...receiptEvidence.final.values()].some((entry) => entry.receipt.status === 'rollback-failed')) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
      }
      const journalEntries = await this.#readRecoveryJournalDirectoryEntries()
      const lockPath = join(this.#controlRoot, 'transaction.lock')
      if (!await pathExists(lockPath)) {
        if (journalEntries.length !== 0 || receiptEvidence.pendingRequestIds.size !== 0) {
          throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
        }
        const current = await this.#loadState(false)
        this.#assertCleanLiveReceipt(current, receiptEvidence.final)
        return { phase: 'ready', requestId: null, operation: null, allowedDesired: [] }
      }

      const lock = await this.#readResidualTransactionLock(undefined, true)
      try {
        const binding = lock.record.journal
        if (binding === null || lock.record.owner !== binding.requestId) {
          throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
        }
        const requestId = binding.requestId
        if ([...receiptEvidence.pendingRequestIds].some((value) => value !== requestId)) {
          throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
        }
        const journalNames = new Set([`${requestId}.json`, `${requestId}.pending`])
        if (journalEntries.some((entry) => !journalNames.has(entry))) {
          throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
        }

        if (journalEntries.length !== 0) {
          const evidence = await this.#inspectRecoveryJournalEvidence(requestId, lock)
          if (evidence.journal.fingerprint !== binding.fingerprint) {
            throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
          }
          const finalReceipt = receiptEvidence.final.get(requestId) ?? null
          const hasPendingReceipt = receiptEvidence.pendingRequestIds.has(requestId)
          if (finalReceipt !== null && hasPendingReceipt) {
            throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
          }
          const allowedDesired = await this.#allowedDesiredForRecoveryEvidence(
            evidence.journal,
            evidence.layout,
            finalReceipt,
            hasPendingReceipt
          )
          return {
            phase: 'recovery-required',
            requestId,
            operation: evidence.journal.request.operation,
            allowedDesired
          }
        }

        const terminal = receiptEvidence.final.get(requestId) ?? null
        const hasPendingReceipt = receiptEvidence.pendingRequestIds.has(requestId)
        if (terminal !== null && hasPendingReceipt) {
          throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
        }
        if (terminal !== null) {
          if (terminal.fingerprint !== binding.fingerprint) {
            throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
          }
          const allowedDesired = this.#validateTerminalReceiptAgainstLive(
            terminal,
            await this.#loadState(false)
          )
          return {
            phase: 'recovery-required',
            requestId,
            operation: terminal.receipt.operation,
            allowedDesired
          }
        }
        if (hasPendingReceipt) {
          const committed = await this.#readCommittedReceiptPendingEvidence(requestId, lock)
          return {
            phase: 'recovery-required',
            requestId,
            operation: committed.receipt.operation,
            allowedDesired: ['candidate']
          }
        }
        throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
      } finally {
        await lock.handle.close().catch(() => undefined)
      }
    } catch {
      throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    }
  }

  async #readRecoveryJournalDirectoryEntries(): Promise<string[]> {
    const root = join(this.#controlRoot, 'journals')
    const info = await lstat(root).catch((error: unknown) => isMissingError(error) ? null : Promise.reject(error))
    if (info === null) return []
    await assertDirectoryBoundary(root, this.#controlRoot)
    const entries = await readdir(root, { withFileTypes: true })
    if (entries.length > 2 || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    }
    return entries.map((entry) => entry.name)
  }

  async #readRecoveryReceiptDirectoryEvidence(): Promise<RecoveryReceiptDirectoryEvidence> {
    const root = join(this.#controlRoot, 'receipts')
    const info = await lstat(root).catch((error: unknown) => isMissingError(error) ? null : Promise.reject(error))
    if (info === null) return { final: new Map(), pendingRequestIds: new Set() }
    await assertDirectoryBoundary(root, this.#controlRoot)
    const entries = await readdir(root, { withFileTypes: true })
    if (entries.length > MAX_MOD_DEPLOYMENT_RECEIPT_ENTRIES) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    }
    const final = new Map<string, LoadedStoredReceipt>()
    const pendingRequestIds = new Set<string>()
    for (const entry of entries) {
      const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(json|pending)$/.exec(entry.name)
      if (!entry.isFile() || entry.isSymbolicLink() || match === null) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
      }
      const requestId = match[1]!
      if (match[2] === 'pending') {
        if (pendingRequestIds.has(requestId)) throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
        pendingRequestIds.add(requestId)
      } else {
        if (final.has(requestId)) throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
        const stored = await this.#readReceipt(requestId, false)
        if (stored === null || !isReceiptSemanticallyConsistent(stored.receipt)) {
          throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
        }
        final.set(requestId, stored)
      }
    }
    return { final, pendingRequestIds }
  }

  #assertCleanLiveReceipt(
    current: ActiveModState,
    receipts: ReadonlyMap<string, LoadedStoredReceipt>
  ): void {
    const transaction = current.lastTransaction
    if (transaction === null) return
    const stored = receipts.get(transaction.requestId)
    if (stored === undefined || stored.fingerprint !== transaction.fingerprint ||
        JSON.stringify(stored.receipt) !== JSON.stringify(receiptFromCommittedState(current))) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    }
  }

  #validateTerminalReceiptAgainstLive(
    stored: LoadedStoredReceipt,
    current: ActiveModState
  ): Array<'candidate' | 'previous'> {
    if (stored.receipt.status === 'succeeded') {
      if (current.lastTransaction?.requestId !== stored.receipt.requestId ||
          current.lastTransaction.fingerprint !== stored.fingerprint ||
          JSON.stringify(stored.receipt) !== JSON.stringify(receiptFromCommittedState(current))) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
      }
      return ['candidate']
    }
    if (stored.receipt.status === 'rolled-back' &&
        stored.receipt.newRevision === stored.receipt.previousRevision &&
        stored.receipt.rollback === 'succeeded' &&
        stored.receipt.errorCode === 'MOD_DEPLOYMENT_EXECUTION_FAILED' &&
        current.revision === stored.receipt.previousRevision) {
      return ['previous']
    }
    throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
  }

  async #allowedDesiredForRecoveryEvidence(
    journal: ModDeploymentRecoveryJournal,
    layout: RecoveryLayout,
    finalReceipt: LoadedStoredReceipt | null,
    hasPendingReceipt: boolean
  ): Promise<Array<'candidate' | 'previous'>> {
    if (finalReceipt !== null) {
      if (finalReceipt.fingerprint !== journal.fingerprint) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
      }
      if (JSON.stringify(finalReceipt.receipt) === JSON.stringify(journal.successReceipt) &&
          layout === 'candidate') return ['candidate']
      if (JSON.stringify(finalReceipt.receipt) === JSON.stringify(journal.rolledBackReceipt) &&
          (layout === 'previous' || layout === 'restored-previous')) return ['previous']
      throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    }
    if (hasPendingReceipt) {
      const root = join(this.#controlRoot, 'receipts')
      const pending = await this.#readStoredReceiptFile(
        join(root, `${journal.request.requestId}.pending`), root, journal.request.requestId
      )
      if (pending.fingerprint !== journal.fingerprint) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
      }
      if (JSON.stringify(pending.receipt) === JSON.stringify(journal.successReceipt) &&
          layout === 'candidate') return ['candidate']
      if (JSON.stringify(pending.receipt) === JSON.stringify(journal.rolledBackReceipt) &&
          (layout === 'previous' || layout === 'restored-previous')) return ['previous']
      throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    }
    return layout === 'candidate' ? ['candidate', 'previous'] : ['previous']
  }

  async #readRecoveryOperationEvidence(
    requestId: string,
    desired: 'candidate' | 'previous'
  ): Promise<{ operation: ModDeploymentOperation }> {
    const completed = await this.#readCompletedReconciliation(requestId, desired)
    if (completed !== null) return { operation: completed.operation }
    const status = await this.#readRecoveryStatus()
    if (status.phase !== 'recovery-required' || status.requestId !== requestId || status.operation === null) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    }
    if (!status.allowedDesired.includes(desired)) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_TARGET_NOT_ALLOWED')
    }
    return { operation: status.operation }
  }

  async #readCommittedReceiptPendingEvidence(
    requestId: string,
    lock: OwnedTransactionLock
  ): Promise<{ fingerprint: string; receipt: ModDeploymentReceipt }> {
    const fingerprint = lock.record.journal?.fingerprint
    const current = await this.#loadState(false)
    if (fingerprint === undefined || current.lastTransaction?.requestId !== requestId ||
        current.lastTransaction.fingerprint !== fingerprint) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    }
    const receipt = receiptFromCommittedState(current)
    const receiptsRoot = join(this.#controlRoot, 'receipts')
    const pendingPath = join(receiptsRoot, `${requestId}.pending`)
    const pending = await this.#readStoredReceiptFile(pendingPath, receiptsRoot, requestId)
    if (pending.fingerprint !== fingerprint ||
        JSON.stringify(pending.receipt) !== JSON.stringify(receipt)) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    }
    return { fingerprint, receipt }
  }

  async #persistRecoveryReceipt(
    fingerprint: string,
    expected: ModDeploymentReceipt,
    existing: LoadedStoredReceipt | null,
    hostMutationScope: HostMutationOperationScope
  ): Promise<ModDeploymentReceipt> {
    if (existing !== null) {
      if (existing.fingerprint !== fingerprint || JSON.stringify(existing.receipt) !== JSON.stringify(expected)) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
      }
      return { ...existing.receipt, reused: true }
    }
    if (await this.#publishMatchingPendingReceipt(fingerprint, expected, hostMutationScope)) {
      return { ...expected, reused: false }
    }
    await this.#writeReceipt(fingerprint, expected, hostMutationScope)
    return { ...expected, reused: false }
  }

  async #publishMatchingPendingReceipt(
    fingerprint: string,
    expected: ModDeploymentReceipt,
    hostMutationScope: HostMutationOperationScope
  ): Promise<boolean> {
    const receiptsRoot = join(this.#controlRoot, 'receipts')
    const pendingPath = join(receiptsRoot, `${expected.requestId}.pending`)
    if (!await pathExists(pendingPath)) return false
    await assertDirectoryBoundary(receiptsRoot, this.#controlRoot)
    const pending = await this.#readStoredReceiptFile(pendingPath, receiptsRoot, expected.requestId)
    if (pending.fingerprint !== fingerprint ||
        JSON.stringify(pending.receipt) !== JSON.stringify({ ...expected, reused: false })) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    }
    const finalPath = join(receiptsRoot, `${expected.requestId}.json`)
    await assertPathDoesNotExist(finalPath)
    this.#assertHostMutationActive(hostMutationScope)
    await rename(pendingPath, finalPath)
    await syncDirectory(receiptsRoot)
    this.#assertHostMutationActive(hostMutationScope)
    return true
  }

  #recoveryPaths(journal: ModDeploymentRecoveryJournal): {
    live: string; pending: string; snapshot: string; failed: string
  } {
    const resolveRelative = (relativePath: string): string => {
      const candidate = resolve(this.#controlRoot, ...relativePath.split('/'))
      if (!isPathWithin(this.#controlRoot, candidate)) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
      }
      return candidate
    }
    return {
      live: this.#pluginsRoot,
      pending: resolveRelative(journal.paths.pending),
      snapshot: resolveRelative(journal.paths.snapshot),
      failed: resolveRelative(journal.paths.failed)
    }
  }

  async #classifyRecoveryLayout(journal: ModDeploymentRecoveryJournal): Promise<RecoveryLayout> {
    const paths = this.#recoveryPaths(journal)
    const [live, pending, snapshot, failed] = await Promise.all([
      summarizeDirectoryIfPresent(paths.live),
      summarizeDirectoryIfPresent(paths.pending),
      summarizeDirectoryIfPresent(paths.snapshot),
      summarizeDirectoryIfPresent(paths.failed)
    ])
    let layout: RecoveryLayout | null = null
    if (matchesSummary(live, journal.previousSummary) && matchesSummary(pending, journal.candidateSummary) &&
        snapshot === null && failed === null) layout = 'previous'
    else if (live === null && matchesSummary(pending, journal.candidateSummary) &&
        matchesSummary(snapshot, journal.previousSummary) && failed === null) layout = 'snapshot-only'
    else if (matchesSummary(live, journal.candidateSummary) && pending === null &&
        matchesSummary(snapshot, journal.previousSummary) && failed === null) layout = 'candidate'
    else if (live === null && pending === null && matchesSummary(snapshot, journal.previousSummary) &&
        matchesSummary(failed, journal.candidateSummary)) layout = 'failed-candidate'
    else if (matchesSummary(live, journal.previousSummary) && pending === null && snapshot === null &&
        matchesSummary(failed, journal.candidateSummary)) layout = 'restored-previous'
    if (layout === null || !phaseAllowsRecoveryLayout(journal.phase, layout)) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    }
    return layout
  }

  async #verifyStagedPackage(target: ServerModLockEntry): Promise<VerifiedStagedPackage> {
    const packageRoot = join(this.#stagingRoot, target.dependencyId)
    await assertDirectoryBoundary(packageRoot, this.#stagingRoot, 'MOD_DEPLOYMENT_STAGING_MISSING')
    const entries = await readdir(packageRoot, { withFileTypes: true })
    const names = entries.map((entry) => entry.name).sort(compareText)
    if (names.length !== 2 || names[0] !== STAGED_MANIFEST_NAME || names[1] !== STAGED_PAYLOAD_NAME) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_STAGING_INVALID')
    }
    const manifestPath = join(packageRoot, STAGED_MANIFEST_NAME)
    await assertRegularFileBoundary(manifestPath, packageRoot)
    const manifest = parseAndValidateStagedManifest(await readBoundedJson(manifestPath))
    if (manifest.dependencyId !== target.dependencyId || manifest.sourceId !== target.sourceId ||
        manifest.version !== target.version ||
        !sameStringArray(manifest.dependencies, target.dependencies) ||
        computeStagedModPayloadDigest(manifest) !== target.sha256) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_PAYLOAD_TAMPERED')
    }
    const payloadRoot = join(packageRoot, STAGED_PAYLOAD_NAME)
    await assertDirectoryBoundary(payloadRoot, packageRoot)
    await verifyPayloadDirectory(payloadRoot, manifest.files)
    return { manifest, payloadRoot, totalSizeBytes: sumPayloadBytes(manifest.files) }
  }

  async #loadState(ensureRoots = true): Promise<ActiveModState> {
    if (ensureRoots) await this.#ensureRoots()
    else await assertDirectoryBoundary(this.#pluginsRoot, dirname(this.#pluginsRoot))
    const entries = await readdir(this.#pluginsRoot, { withFileTypes: true })
    const manifestEntry = entries.find((entry) => entry.name === ACTIVE_MANIFEST_NAME)
    if (manifestEntry === undefined) {
      if (entries.length !== 0) throw new ModDeploymentError('MOD_DEPLOYMENT_UNMANAGED_CONTENT')
      return createState([], null)
    }
    if (!manifestEntry.isFile() || manifestEntry.isSymbolicLink()) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_ROOT_LINK_REJECTED')
    }
    const manifestPath = join(this.#pluginsRoot, ACTIVE_MANIFEST_NAME)
    await assertRegularFileBoundary(manifestPath, this.#pluginsRoot)
    let state: ActiveModState
    try {
      state = activeStateSchema.parse(await readBoundedJson(manifestPath))
    } catch (error) {
      if (error instanceof ModDeploymentError) throw error
      throw new ModDeploymentError('MOD_DEPLOYMENT_STATE_INVALID')
    }
    if (state.revision !== computeStateRevision(state.packages, state.lastTransaction)) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_STATE_INVALID')
    }
    validateManagedPackages(state.packages)
    await this.#verifyManagedTree(this.#pluginsRoot, state)
    return state
  }

  async #verifyManagedTree(root: string, state: ActiveModState): Promise<void> {
    const expectedNames = new Set<string>([ACTIVE_MANIFEST_NAME])
    let totalSize = 0
    for (const entry of state.packages) {
      if (!entry.enabled) continue
      expectedNames.add(entry.payloadDirectory)
      const payloadRoot = join(root, entry.payloadDirectory)
      await assertDirectoryBoundary(payloadRoot, root)
      await verifyPayloadDirectory(payloadRoot, entry.files)
      totalSize += sumPayloadBytes(entry.files)
      if (totalSize > MAX_DEPLOYED_MOD_TOTAL_BYTES) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_PAYLOAD_TOO_LARGE')
      }
    }
    const actual = await readdir(root, { withFileTypes: true })
    const normalized = new Set<string>()
    for (const entry of actual) {
      const key = entry.name.toLowerCase()
      if (normalized.has(key)) throw new ModDeploymentError('MOD_DEPLOYMENT_UNMANAGED_CONTENT')
      normalized.add(key)
      if (!expectedNames.has(entry.name) || entry.isSymbolicLink() ||
          (entry.name === ACTIVE_MANIFEST_NAME ? !entry.isFile() : !entry.isDirectory())) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_UNMANAGED_CONTENT')
      }
    }
    if (actual.length !== expectedNames.size) throw new ModDeploymentError('MOD_DEPLOYMENT_UNMANAGED_CONTENT')
  }

  async #assertStopped(hostMutationScope: HostMutationOperationScope | null): Promise<void> {
    try {
      this.#assertHostMutationActive(hostMutationScope)
      const proof = await this.#verifyStoppedState(hostMutationScope?.signal)
      this.#assertHostMutationActive(hostMutationScope)
      if (proof.processStopped !== true || proof.portClosed !== true) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_STOP_GATE_REJECTED')
      }
    } catch (error) {
      if (error instanceof HostMutationOperationCoordinatorError) throw error
      if (error instanceof ModDeploymentError) throw error
      throw new ModDeploymentError('MOD_DEPLOYMENT_STOP_GATE_REJECTED')
    }
  }

  #assertHostMutationActive(scope: HostMutationOperationScope | null): void {
    if (scope === null) return
    try {
      scope.assertActive()
    } catch {
      throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_LOST')
    }
  }

  async #snapshotCount(): Promise<number> {
    const snapshotsRoot = await this.#ensureControlDirectory('snapshots')
    const entries = await readdir(snapshotsRoot, { withFileTypes: true })
    if (entries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink())) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    }
    return entries.length
  }

  async #pendingPath(requestId: string): Promise<string> {
    const pendingRoot = await this.#ensureControlDirectory('pending')
    const candidate = join(pendingRoot, requestId)
    await assertPathDoesNotExist(candidate)
    return candidate
  }

  async #readReceipt(requestId: string, createRoot = true): Promise<LoadedStoredReceipt | null> {
    const receiptsRoot = createRoot
      ? await this.#ensureControlDirectory('receipts')
      : join(this.#controlRoot, 'receipts')
    if (!createRoot) {
      const rootInfo = await lstat(receiptsRoot).catch((error: unknown) =>
        isMissingError(error) ? null : Promise.reject(error))
      if (rootInfo === null) return null
      await assertDirectoryBoundary(receiptsRoot, this.#controlRoot)
    }
    const receiptPath = join(receiptsRoot, `${requestId}.json`)
    try {
      await assertRegularFileBoundary(receiptPath, receiptsRoot)
    } catch (error) {
      if (isMissingError(error)) return null
      throw error
    }
    return this.#readStoredReceiptFile(receiptPath, receiptsRoot, requestId)
  }

  async #readStoredReceiptFile(
    receiptPath: string,
    receiptsRoot: string,
    requestId: string
  ): Promise<LoadedStoredReceipt> {
    try {
      await assertRegularFileBoundary(receiptPath, receiptsRoot)
      const metadata = await lstat(receiptPath, { bigint: true })
      if (metadata.size > BigInt(MAX_MOD_DEPLOYMENT_RECEIPT_BYTES)) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
      }
      const raw = await readBoundedJson(receiptPath)
      const currentMetadata = await lstat(receiptPath, { bigint: true })
      if (!sameFileSnapshot(metadata, currentMetadata)) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
      }
      const envelope = storedReceiptEnvelopeSchema.safeParse(raw)
      const legacy = envelope.success ? null : legacyStoredReceiptSchema.safeParse(raw)
      const stored = envelope.success
        ? envelope.data
        : legacy?.success
          ? { ...legacy.data, persistedAt: metadata.mtime.toISOString() }
          : null
      if (stored === null || stored.receipt.requestId.toLowerCase() !== requestId || stored.receipt.reused) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
      }
      return {
        fingerprint: stored.fingerprint.toLowerCase(),
        persistedAt: new Date(stored.persistedAt).toISOString(),
        receipt: { ...stored.receipt, requestId: stored.receipt.requestId.toLowerCase(), reused: false }
      }
    } catch {
      throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    }
  }

  async #readReceiptHistory(): Promise<LoadedStoredReceipt[]> {
    const receiptsRoot = await this.#ensureControlDirectory('receipts')
    const entries = await readdir(receiptsRoot, { withFileTypes: true })
    if (entries.length > MAX_MOD_DEPLOYMENT_RECEIPT_ENTRIES) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    }
    const requestIds: string[] = []
    const seen = new Set<string>()
    for (const entry of entries) {
      const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/.exec(entry.name)
      if (!entry.isFile() || entry.isSymbolicLink() || match === null || seen.has(match[1]!)) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
      }
      seen.add(match[1]!)
      requestIds.push(match[1]!)
    }
    const stored: LoadedStoredReceipt[] = []
    for (const requestId of requestIds.sort(compareText)) {
      const receipt = await this.#readReceipt(requestId)
      if (receipt === null) throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
      stored.push(receipt)
    }
    return stored.sort(compareReceiptHistory)
  }

  async #writeReceipt(
    fingerprint: string,
    receipt: ModDeploymentReceipt,
    hostMutationScope: HostMutationOperationScope | null = null
  ): Promise<void> {
    const receiptsRoot = await this.#ensureControlDirectory('receipts')
    const finalPath = join(receiptsRoot, `${receipt.requestId}.json`)
    const pendingPath = join(receiptsRoot, `${receipt.requestId}.pending`)
    await assertPathDoesNotExist(finalPath)
    await assertPathDoesNotExist(pendingPath)
    const persistedAt = this.#now()
    if (!(persistedAt instanceof Date) || !Number.isFinite(persistedAt.getTime())) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    }
    this.#assertHostMutationActive(hostMutationScope)
    await writeJsonExclusive(pendingPath, {
      format: RECEIPT_ENVELOPE_FORMAT,
      schemaVersion: 1,
      fingerprint,
      persistedAt: persistedAt.toISOString(),
      receipt: { ...receipt, reused: false }
    })
    this.#assertHostMutationActive(hostMutationScope)
    await this.#injectFault('after-receipt-pending-synced')
    this.#assertHostMutationActive(hostMutationScope)
    await rename(pendingPath, finalPath)
    await syncDirectory(receiptsRoot)
    this.#assertHostMutationActive(hostMutationScope)
  }

  async #ensureRoots(): Promise<void> {
    await assertDirectoryBoundary(this.#stagingRoot, dirname(this.#stagingRoot))
    await assertDirectoryBoundary(this.#pluginsRoot, dirname(this.#pluginsRoot))
    try {
      await mkdir(this.#controlRoot)
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw new ModDeploymentError('MOD_DEPLOYMENT_ROOT_INVALID')
    }
    await syncDirectory(dirname(this.#controlRoot))
    await assertDirectoryBoundary(this.#controlRoot, dirname(this.#controlRoot))
  }

  async #ensureControlDirectory(
    name: 'snapshots' | 'recovery' | 'pending' | 'receipts' | 'journals'
  ): Promise<string> {
    await this.#ensureRoots()
    const candidate = join(this.#controlRoot, name)
    try {
      await mkdir(candidate)
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw new ModDeploymentError('MOD_DEPLOYMENT_ROOT_INVALID')
    }
    await syncDirectory(this.#controlRoot)
    await assertDirectoryBoundary(candidate, this.#controlRoot)
    return candidate
  }

  async #withFileLock<T>(
    owner: string,
    action: () => Promise<T>,
    journal: TransactionLockRecord['journal'] = null,
    existingCode: 'MOD_DEPLOYMENT_BUSY' | 'MOD_DEPLOYMENT_RECOVERY_REQUIRED' = 'MOD_DEPLOYMENT_BUSY'
  ): Promise<T> {
    const controlInfo = await lstat(this.#controlRoot).catch((error: unknown) => isMissingError(error) ? null : Promise.reject(error))
    if (controlInfo === null) await this.#ensureRoots()
    else await assertDirectoryBoundary(this.#controlRoot, dirname(this.#controlRoot))
    const lockPath = join(this.#controlRoot, 'transaction.lock')
    let lock: OwnedTransactionLock | null = null
    let creatingHandle: FileHandle | null = null
    try {
      const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600)
      creatingHandle = handle
      const identity = transactionLockIdentity(await handle.stat({ bigint: true }))
      const record = transactionLockRecordSchema.parse({
        format: TRANSACTION_LOCK_FORMAT,
        schemaVersion: 1,
        owner,
        journal,
        identity
      })
      lock = { path: lockPath, handle, record }
      creatingHandle = null
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8')
      await handle.sync()
      await syncDirectory(this.#controlRoot)
    } catch (error) {
      await creatingHandle?.close().catch(() => undefined)
      if (lock !== null) await this.#discardNewOwnedLock(lock).catch(() => undefined)
      if (isAlreadyExistsError(error)) throw new ModDeploymentError(existingCode)
      throw new ModDeploymentError('MOD_DEPLOYMENT_ROOT_INVALID')
    }
    try {
      return await action()
    } finally {
      const journalRoot = join(this.#controlRoot, 'journals')
      if (journal !== null &&
          (await pathExists(join(journalRoot, `${journal.requestId}.json`)) ||
           await pathExists(join(journalRoot, `${journal.requestId}.pending`)) ||
           await pathExists(join(this.#controlRoot, 'receipts', `${journal.requestId}.pending`)))) {
        await lock.handle.close().catch(() => undefined)
      } else {
        await this.#releaseOwnedLock(lock)
      }
    }
  }

  async #discardNewOwnedLock(lock: OwnedTransactionLock): Promise<void> {
    try {
      const handleIdentity = transactionLockIdentity(await lock.handle.stat({ bigint: true }))
      const pathIdentity = transactionLockIdentity(await lstat(lock.path, { bigint: true }))
      if (sameTransactionLockIdentity(handleIdentity, pathIdentity) &&
          sameTransactionLockIdentity(handleIdentity, lock.record.identity)) {
        await unlink(lock.path)
        await syncDirectory(this.#controlRoot)
      }
    } finally {
      await lock.handle.close().catch(() => undefined)
    }
  }

  async #releaseOwnedLock(
    lock: OwnedTransactionLock,
    hostMutationScope: HostMutationOperationScope | null = null
  ): Promise<void> {
    try {
      const handleBefore = await lock.handle.stat({ bigint: true })
      const handleIdentity = transactionLockIdentity(handleBefore)
      const before = await lstat(lock.path, { bigint: true })
      const pathIdentity = transactionLockIdentity(before)
      const raw = await readFile(lock.path, 'utf8')
      const after = await lstat(lock.path, { bigint: true })
      const handleAfter = await lock.handle.stat({ bigint: true })
      const afterIdentity = transactionLockIdentity(after)
      const parsed = transactionLockRecordSchema.safeParse(JSON.parse(raw) as unknown)
      if (!sameTransactionLockIdentity(handleIdentity, lock.record.identity) ||
          !sameTransactionLockIdentity(pathIdentity, lock.record.identity) ||
          !sameTransactionLockIdentity(afterIdentity, lock.record.identity) ||
          !sameFileSnapshot(handleBefore, handleAfter) || !sameFileSnapshot(before, after) ||
          !parsed.success || JSON.stringify(parsed.data) !== JSON.stringify(lock.record)) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
      }
      this.#assertHostMutationActive(hostMutationScope)
      const finalIdentity = transactionLockIdentity(await lstat(lock.path, { bigint: true }))
      if (!sameTransactionLockIdentity(finalIdentity, lock.record.identity)) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
      }
      // Node has no portable delete-by-handle primitive. This final pathname
      // deletion is therefore valid only for cooperative writers serialized by
      // the shared host-mutation lease. An out-of-band writer replacing this
      // pathname inside the final lstat-to-unlink window is outside that model.
      this.#assertHostMutationActive(hostMutationScope)
      await unlink(lock.path)
      await syncDirectory(this.#controlRoot)
      this.#assertHostMutationActive(hostMutationScope)
    } catch (error) {
      if (error instanceof HostMutationOperationCoordinatorError) throw error
      if (error instanceof ModDeploymentError) throw error
      throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    } finally {
      await lock.handle.close().catch(() => undefined)
    }
  }

  async #exclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.#tail
    let release!: () => void
    this.#tail = new Promise<void>((resolvePromise) => { release = resolvePromise })
    await previous
    try {
      return await action()
    } finally {
      release()
    }
  }

  async #injectFault(phase: ModDeploymentFaultPhase): Promise<void> {
    await this.#faultInjector?.(phase)
  }
}

function parseRequest(input: ModDeploymentRequest): ModDeploymentRequest {
  const parsed = requestSchema.safeParse(input)
  if (!parsed.success) throw new ModDeploymentError('MOD_DEPLOYMENT_REQUEST_INVALID')
  return parsed.data
}

function parseAndValidateStagedManifest(input: unknown): StagedModPackageManifest {
  const parsed = stagedModPackageManifestSchema.safeParse(input)
  if (!parsed.success) throw new ModDeploymentError('MOD_DEPLOYMENT_STAGING_INVALID')
  const identity = parseThunderstoreDependency(parsed.data.dependencyId)
  if (identity.sourceId !== parsed.data.sourceId || identity.version !== parsed.data.version) {
    throw new ModDeploymentError('MOD_DEPLOYMENT_STAGING_INVALID')
  }
  const files = [...parsed.data.files]
  const normalized = files.map((file) => file.relativePath.toLowerCase())
  if (new Set(normalized).size !== files.length) throw new ModDeploymentError('MOD_DEPLOYMENT_PAYLOAD_NAME_INVALID')
  if (files.some((file, index) => index > 0 && compareText(files[index - 1]!.relativePath, file.relativePath) >= 0)) {
    throw new ModDeploymentError('MOD_DEPLOYMENT_PAYLOAD_NAME_INVALID')
  }
  if (files.some((file) => file.sha256 !== file.sha256.toLowerCase())) {
    throw new ModDeploymentError('MOD_DEPLOYMENT_STAGING_INVALID')
  }
  const dependencies = parsed.data.dependencies.map((dependency) => parseThunderstoreDependency(dependency).dependencyId)
  if (new Set(dependencies.map((dependency) => dependency.toLowerCase())).size !== dependencies.length ||
      dependencies.some((dependency, index) => dependency !== parsed.data.dependencies[index]) ||
      dependencies.some((dependency, index) => index > 0 && compareText(parsed.data.dependencies[index - 1]!, dependency) >= 0) ||
      dependencies.some((dependency) => dependency.toLowerCase() === parsed.data.dependencyId.toLowerCase())) {
    throw new ModDeploymentError('MOD_DEPLOYMENT_STAGING_INVALID')
  }
  sumPayloadBytes(files)
  return parsed.data
}

function payloadDigestMaterial(manifest: StagedModPackageManifest): string {
  return `${manifest.dependencyId}\u0000${manifest.sourceId}\u0000${manifest.version}\n` +
    manifest.files.map((file) => `${file.relativePath}\u0000${file.sizeBytes}\u0000${file.sha256}\n`).join('')
}

function assertOperationPreconditions(
  operation: ModDeploymentOperation,
  target: ServerModLockEntry,
  current: ManagedModPackage | undefined
): void {
  if (operation === 'install') {
    if (current?.dependencyId === target.dependencyId) throw new ModDeploymentError('MOD_DEPLOYMENT_ALREADY_INSTALLED')
    if (current !== undefined) throw new ModDeploymentError('MOD_DEPLOYMENT_SOURCE_CONFLICT')
    return
  }
  if (current === undefined) throw new ModDeploymentError('MOD_DEPLOYMENT_NOT_INSTALLED')
  if (operation === 'update') {
    if (current.dependencyId === target.dependencyId && current.sha256 === target.sha256) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_NO_CHANGE')
    }
    return
  }
  if (current.dependencyId !== target.dependencyId || current.sha256 !== target.sha256) {
    throw new ModDeploymentError('MOD_DEPLOYMENT_TARGET_MISMATCH')
  }
  if (operation === 'enable' && current.enabled) throw new ModDeploymentError('MOD_DEPLOYMENT_ALREADY_ENABLED')
  if (operation === 'disable' && !current.enabled) throw new ModDeploymentError('MOD_DEPLOYMENT_ALREADY_DISABLED')
}

function assertManifestCoversState(
  operation: ModDeploymentOperation,
  manifestEntries: readonly ServerModLockEntry[],
  current: readonly ManagedModPackage[],
  target: ServerModLockEntry
): void {
  const manifestBySource = new Map(manifestEntries.map((entry) => [entry.sourceId.toLowerCase(), entry]))
  const expectedSources = new Set(current.map((entry) => entry.sourceId.toLowerCase()))
  if (operation === 'install') expectedSources.add(target.sourceId.toLowerCase())
  if (manifestBySource.size !== expectedSources.size || [...expectedSources].some((key) => !manifestBySource.has(key))) {
    throw new ModDeploymentError('MOD_DEPLOYMENT_MANIFEST_STATE_MISMATCH')
  }
  for (const installed of current) {
    if (operation === 'update' && installed.sourceId.toLowerCase() === target.sourceId.toLowerCase()) continue
    const manifest = manifestBySource.get(installed.sourceId.toLowerCase())
    if (manifest === undefined || manifest.dependencyId !== installed.dependencyId || manifest.sha256 !== installed.sha256 ||
        manifest.version !== installed.version || manifest.serverRequired !== installed.serverRequired ||
        manifest.clientRequirement !== installed.clientRequirement) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_MANIFEST_STATE_MISMATCH')
    }
  }
}

function buildNextPackages(
  operation: ModDeploymentOperation,
  manifestEntries: readonly ServerModLockEntry[],
  current: readonly ManagedModPackage[],
  target: ServerModLockEntry,
  stagedFiles: readonly StagedModPackageFile[] | null
): ManagedModPackage[] {
  const currentBySource = new Map(current.map((entry) => [entry.sourceId.toLowerCase(), entry]))
  const packages: ManagedModPackage[] = []
  for (const manifest of manifestEntries) {
    const isTarget = manifest.sourceId.toLowerCase() === target.sourceId.toLowerCase()
    if (isTarget && operation === 'remove') continue
    const installed = currentBySource.get(manifest.sourceId.toLowerCase())
    if (installed === undefined && !isTarget) throw new ModDeploymentError('MOD_DEPLOYMENT_MANIFEST_STATE_MISMATCH')
    const files = isTarget && stagedFiles !== null ? [...stagedFiles] : [...installed!.files]
    let enabled = installed?.enabled ?? true
    if (isTarget && operation === 'enable') enabled = true
    if (isTarget && operation === 'disable') enabled = false
    packages.push({
      ...manifest,
      enabled,
      payloadDirectory: payloadDirectoryFor(manifest.dependencyId, manifest.sha256),
      files
    })
  }
  packages.sort(compareManagedPackages)
  validateManagedPackages(packages)
  return packages
}

function assertEnabledDependencyClosure(
  packages: readonly ManagedModPackage[],
  operation: ModDeploymentOperation,
  target: ServerModLockEntry
): void {
  const byDependency = new Map(packages.map((entry) => [entry.dependencyId.toLowerCase(), entry]))
  for (const entry of packages) {
    if (!entry.enabled) continue
    for (const dependencyId of entry.dependencies) {
      const dependency = byDependency.get(dependencyId.toLowerCase())
      if (dependency === undefined || !dependency.enabled) {
        if ((operation === 'disable' || operation === 'remove') &&
            dependencyId.toLowerCase() === target.dependencyId.toLowerCase()) {
          throw new ModDeploymentError('MOD_DEPLOYMENT_DEPENDENT_ACTIVE')
        }
        throw new ModDeploymentError('MOD_DEPLOYMENT_DEPENDENCY_MISSING')
      }
    }
  }
}

function validateManagedPackages(packages: readonly ManagedModPackage[]): void {
  const sourceIds = new Set<string>()
  const dependencyIds = new Set<string>()
  const payloadDirectories = new Set<string>()
  let previousKey = ''
  let deployedSizeBytes = 0
  for (const entry of packages) {
    const sourceKey = entry.sourceId.toLowerCase()
    const dependencyKey = entry.dependencyId.toLowerCase()
    const identity = parseThunderstoreDependency(entry.dependencyId)
    if (sourceIds.has(sourceKey) || dependencyIds.has(dependencyKey) || payloadDirectories.has(entry.payloadDirectory) ||
        identity.sourceId.toLowerCase() !== sourceKey || identity.version !== entry.version ||
        entry.payloadDirectory !== payloadDirectoryFor(entry.dependencyId, entry.sha256) ||
        (previousKey !== '' && previousKey >= sourceKey)) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_STATE_INVALID')
    }
    parseAndValidateStagedManifest({
      format: 'dyson-control-staged-mod-package',
      schemaVersion: 1,
      dependencyId: entry.dependencyId,
      sourceId: entry.sourceId,
      version: entry.version,
      dependencies: entry.dependencies,
      files: entry.files
    })
    if (computeStagedModPayloadDigest({
      format: 'dyson-control-staged-mod-package', schemaVersion: 1,
      dependencyId: entry.dependencyId, sourceId: entry.sourceId, version: entry.version,
      dependencies: entry.dependencies, files: entry.files
    }) !== entry.sha256) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_STATE_INVALID')
    }
    if (entry.enabled) {
      deployedSizeBytes += sumPayloadBytes(entry.files)
      if (!Number.isSafeInteger(deployedSizeBytes) || deployedSizeBytes > MAX_DEPLOYED_MOD_TOTAL_BYTES) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_PAYLOAD_TOO_LARGE')
      }
    }
    sourceIds.add(sourceKey)
    dependencyIds.add(dependencyKey)
    payloadDirectories.add(entry.payloadDirectory)
    previousKey = sourceKey
  }
}

function createState(packages: ManagedModPackage[], lastTransaction: LastTransaction | null): ActiveModState {
  const revision = computeStateRevision(packages, lastTransaction)
  return { format: STATE_FORMAT, schemaVersion: 1, revision, packages, lastTransaction }
}

function computeStateRevision(packages: readonly ManagedModPackage[], lastTransaction: LastTransaction | null): string {
  return hashText(`${JSON.stringify({ format: STATE_FORMAT, schemaVersion: 1, packages, lastTransaction }, null, 2)}\n`)
}

function requestFingerprint(request: ModDeploymentRequest): string {
  return hashText(`${JSON.stringify(request, null, 2)}\n`)
}

function payloadDirectoryFor(dependencyId: string, payloadSha256: string): string {
  return `mod-${hashText(dependencyId.toLowerCase()).slice(0, 32)}-${payloadSha256.slice(0, 32).toLowerCase()}`
}

function toPreview(prepared: PreparedDeployment, snapshotLimit: number): ModDeploymentPreview {
  return {
    dryRun: true,
    operation: prepared.request.operation,
    package: { ...prepared.request.package },
    currentRevision: prepared.current.revision,
    nextRevision: prepared.next.revision,
    currentlyInstalled: prepared.currentTarget !== undefined,
    currentlyEnabled: prepared.currentTarget?.enabled ?? false,
    nextEnabled: prepared.next.packages.find((entry) =>
      entry.sourceId.toLowerCase() === prepared.target.sourceId.toLowerCase())?.enabled ?? null,
    payloadFileCount: prepared.payloadFileCount,
    payloadSizeBytes: prepared.payloadSizeBytes,
    dependencyCount: prepared.target.dependencies.length,
    snapshotsUsed: prepared.snapshotCount,
    snapshotLimit,
    stoppedStateRequiredForExecute: true,
    recoverablePayloadPreserved: prepared.request.operation === 'remove' || prepared.request.operation === 'disable' ||
      prepared.request.operation === 'update'
  }
}

function successReceipt(prepared: PreparedDeployment): ModDeploymentReceipt {
  return {
    format: RECEIPT_FORMAT,
    schemaVersion: 1,
    requestId: prepared.request.requestId,
    operation: prepared.request.operation,
    package: { ...prepared.request.package },
    status: 'succeeded',
    previousRevision: prepared.current.revision,
    newRevision: prepared.next.revision,
    rollback: 'not-needed',
    recoveryPointCreated: true,
    recoverablePayloadPreserved: prepared.request.operation === 'remove' || prepared.request.operation === 'disable' ||
      prepared.request.operation === 'update',
    payloadFileCount: prepared.payloadFileCount,
    payloadSizeBytes: prepared.payloadSizeBytes,
    errorCode: null,
    reused: false
  }
}

function rollbackReceipt(prepared: PreparedDeployment, succeeded: boolean): ModDeploymentReceipt {
  return {
    format: RECEIPT_FORMAT,
    schemaVersion: 1,
    requestId: prepared.request.requestId,
    operation: prepared.request.operation,
    package: { ...prepared.request.package },
    status: succeeded ? 'rolled-back' : 'rollback-failed',
    previousRevision: prepared.current.revision,
    newRevision: succeeded ? prepared.current.revision : null,
    rollback: succeeded ? 'succeeded' : 'failed',
    recoveryPointCreated: true,
    recoverablePayloadPreserved: true,
    payloadFileCount: prepared.payloadFileCount,
    payloadSizeBytes: prepared.payloadSizeBytes,
    errorCode: succeeded ? 'MOD_DEPLOYMENT_EXECUTION_FAILED' : 'MOD_DEPLOYMENT_ROLLBACK_FAILED',
    reused: false
  }
}

function isReceiptSemanticallyConsistent(receipt: ModDeploymentReceipt): boolean {
  if (!receipt.recoveryPointCreated || receipt.reused) return false
  if (receipt.status === 'succeeded') {
    return receipt.newRevision !== null && receipt.rollback === 'not-needed' && receipt.errorCode === null
  }
  if (receipt.status === 'rolled-back') {
    return receipt.newRevision === receipt.previousRevision && receipt.rollback === 'succeeded' &&
      receipt.errorCode === 'MOD_DEPLOYMENT_EXECUTION_FAILED' && receipt.recoverablePayloadPreserved
  }
  return receipt.newRevision === null && receipt.rollback === 'failed' &&
    receipt.errorCode === 'MOD_DEPLOYMENT_ROLLBACK_FAILED' && receipt.recoverablePayloadPreserved
}

function createRecoveryJournal(
  prepared: PreparedDeployment,
  previousSummary: DirectoryContentSummary,
  candidateSummary: DirectoryContentSummary,
  snapshotId: string
): ModDeploymentRecoveryJournal {
  return recoveryJournalSchema.parse({
    format: RECOVERY_JOURNAL_FORMAT,
    schemaVersion: 1,
    request: prepared.request,
    fingerprint: prepared.fingerprint,
    previousRevision: prepared.current.revision,
    nextRevision: prepared.next.revision,
    paths: {
      pending: `pending/${prepared.request.requestId}`,
      snapshot: `snapshots/${snapshotId}`,
      failed: `recovery/failed-${prepared.request.requestId}`
    },
    previousState: prepared.current,
    nextState: prepared.next,
    previousSummary,
    candidateSummary,
    successReceipt: successReceipt(prepared),
    rolledBackReceipt: rollbackReceipt(prepared, true),
    phase: 'prepared'
  })
}

function validateRecoveryJournal(journal: ModDeploymentRecoveryJournal): void {
  const requestId = journal.request.requestId
  if (journal.fingerprint !== requestFingerprint(journal.request) ||
      journal.previousRevision !== journal.previousState.revision ||
      journal.nextRevision !== journal.nextState.revision ||
      journal.previousState.revision !== computeStateRevision(
        journal.previousState.packages, journal.previousState.lastTransaction
      ) ||
      journal.nextState.revision !== computeStateRevision(journal.nextState.packages, journal.nextState.lastTransaction) ||
      journal.paths.pending !== `pending/${requestId}` ||
      journal.paths.snapshot !== `snapshots/snapshot-${journal.previousRevision.slice(0, 16)}-${requestId}` ||
      journal.paths.failed !== `recovery/failed-${requestId}`) {
    throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
  }
  validateManagedPackages(journal.previousState.packages)
  validateManagedPackages(journal.nextState.packages)
  const transaction = journal.nextState.lastTransaction
  if (transaction === null || transaction.requestId !== requestId ||
      transaction.fingerprint !== journal.fingerprint ||
      transaction.previousRevision !== journal.previousRevision ||
      transaction.operation !== journal.request.operation ||
      transaction.package.dependencyId !== journal.request.package.dependencyId ||
      transaction.package.version !== journal.request.package.version ||
      transaction.recoverablePayloadPreserved !== (
        journal.request.operation === 'remove' || journal.request.operation === 'disable' ||
        journal.request.operation === 'update'
      )) {
    throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
  }
  const success = journal.successReceipt
  const rolledBack = journal.rolledBackReceipt
  if (success.requestId !== requestId || success.operation !== journal.request.operation ||
      success.package.dependencyId !== journal.request.package.dependencyId ||
      success.package.version !== journal.request.package.version || success.status !== 'succeeded' ||
      success.previousRevision !== journal.previousRevision || success.newRevision !== journal.nextRevision ||
      success.rollback !== 'not-needed' || success.errorCode !== null || success.reused ||
      !success.recoveryPointCreated ||
      success.recoverablePayloadPreserved !== transaction.recoverablePayloadPreserved ||
      rolledBack.requestId !== requestId || rolledBack.operation !== journal.request.operation ||
      rolledBack.package.dependencyId !== journal.request.package.dependencyId ||
      rolledBack.package.version !== journal.request.package.version || rolledBack.status !== 'rolled-back' ||
      rolledBack.previousRevision !== journal.previousRevision || rolledBack.newRevision !== journal.previousRevision ||
      rolledBack.rollback !== 'succeeded' || rolledBack.errorCode !== 'MOD_DEPLOYMENT_EXECUTION_FAILED' ||
      rolledBack.reused || !rolledBack.recoveryPointCreated || !rolledBack.recoverablePayloadPreserved ||
      success.payloadFileCount !== transaction.payloadFileCount ||
      rolledBack.payloadFileCount !== transaction.payloadFileCount ||
      success.payloadSizeBytes !== transaction.payloadSizeBytes ||
      rolledBack.payloadSizeBytes !== transaction.payloadSizeBytes) {
    throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
  }
}

function receiptFromCommittedState(state: ActiveModState): ModDeploymentReceipt {
  const transaction = state.lastTransaction
  if (transaction === null) throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
  return {
    format: RECEIPT_FORMAT,
    schemaVersion: 1,
    requestId: transaction.requestId,
    operation: transaction.operation,
    package: { ...transaction.package },
    status: 'succeeded',
    previousRevision: transaction.previousRevision,
    newRevision: state.revision,
    rollback: 'not-needed',
    recoveryPointCreated: true,
    recoverablePayloadPreserved: transaction.recoverablePayloadPreserved,
    payloadFileCount: transaction.payloadFileCount,
    payloadSizeBytes: transaction.payloadSizeBytes,
    errorCode: null,
    reused: false
  }
}

function summarizeState(state: ActiveModState): ModDeploymentStateSummary {
  return {
    revision: state.revision,
    packages: state.packages.map((entry) => ({
      dependencyId: entry.dependencyId,
      sourceId: entry.sourceId,
      version: entry.version,
      enabled: entry.enabled,
      clientRequirement: entry.clientRequirement
    })),
    enabledCount: state.packages.filter((entry) => entry.enabled).length,
    disabledCount: state.packages.filter((entry) => !entry.enabled).length
  }
}

async function verifyPayloadDirectory(root: string, files: readonly StagedModPackageFile[]): Promise<void> {
  const actual = await enumeratePayloadFiles(root)
  const expected = files.map((file) => file.relativePath)
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new ModDeploymentError('MOD_DEPLOYMENT_STAGING_INVALID')
  }
  for (const file of files) {
    const filePath = joinPayloadPath(root, file.relativePath)
    await assertRegularFileBoundary(filePath, root)
    const measured = await hashFileBounded(filePath, file.sizeBytes)
    if (measured.sizeBytes !== file.sizeBytes || measured.sha256 !== file.sha256) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_PAYLOAD_TAMPERED')
    }
  }
}

async function enumeratePayloadFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    const normalized = new Set<string>()
    for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
      const key = entry.name.toLowerCase()
      if (normalized.has(key) || entry.isSymbolicLink()) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_ROOT_LINK_REJECTED')
      }
      normalized.add(key)
      const relativeName = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const fullPath = join(directory, entry.name)
      if (entry.isDirectory()) {
        await assertDirectoryBoundary(fullPath, root)
        await visit(fullPath, relativeName)
      } else if (entry.isFile()) {
        if (!isSafePayloadRelativePath(relativeName)) {
          throw new ModDeploymentError('MOD_DEPLOYMENT_PAYLOAD_TYPE_INVALID')
        }
        files.push(relativeName)
        if (files.length > MAX_STAGED_MOD_FILES) {
          throw new ModDeploymentError('MOD_DEPLOYMENT_PAYLOAD_COUNT_INVALID')
        }
      } else {
        throw new ModDeploymentError('MOD_DEPLOYMENT_PAYLOAD_TYPE_INVALID')
      }
    }
  }
  await visit(root, '')
  return files.sort(compareText)
}

async function copyVerifiedPayload(
  sourceRoot: string,
  destinationRoot: string,
  files: readonly StagedModPackageFile[]
): Promise<void> {
  await mkdir(destinationRoot)
  for (const file of files) {
    const source = joinPayloadPath(sourceRoot, file.relativePath)
    await assertRegularFileBoundary(source, sourceRoot)
    const destination = joinPayloadPath(destinationRoot, file.relativePath)
    await mkdir(dirname(destination), { recursive: true })
    const hash = createHash('sha256')
    let sizeBytes = 0
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sizeBytes += chunk.length
        if (sizeBytes > file.sizeBytes || sizeBytes > MAX_STAGED_MOD_FILE_BYTES) {
          callback(new ModDeploymentError('MOD_DEPLOYMENT_PAYLOAD_TOO_LARGE'))
          return
        }
        hash.update(chunk)
        callback(null, chunk)
      }
    })
    try {
      await pipeline(createReadStream(source), meter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
    } catch (error) {
      if (error instanceof ModDeploymentError) throw error
      throw new ModDeploymentError('MOD_DEPLOYMENT_EXECUTION_FAILED')
    }
    if (sizeBytes !== file.sizeBytes || hash.digest('hex') !== file.sha256) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_PAYLOAD_TAMPERED')
    }
  }
}

async function hashFileBounded(filePath: string, expectedSize: number): Promise<{ sizeBytes: number; sha256: string }> {
  const hash = createHash('sha256')
  let sizeBytes = 0
  try {
    for await (const chunk of createReadStream(filePath)) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      sizeBytes += data.length
      if (sizeBytes > expectedSize || sizeBytes > MAX_STAGED_MOD_FILE_BYTES) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_PAYLOAD_TOO_LARGE')
      }
      hash.update(data)
    }
  } catch (error) {
    if (error instanceof ModDeploymentError) throw error
    throw new ModDeploymentError('MOD_DEPLOYMENT_PAYLOAD_TAMPERED')
  }
  return { sizeBytes, sha256: hash.digest('hex') }
}

async function readBoundedJson(filePath: string): Promise<unknown> {
  const stats = await lstat(filePath)
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_MOD_DEPLOYMENT_MANIFEST_BYTES) {
    throw new ModDeploymentError('MOD_DEPLOYMENT_MANIFEST_INVALID')
  }
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown
  } catch {
    throw new ModDeploymentError('MOD_DEPLOYMENT_MANIFEST_INVALID')
  }
}

async function readStableBoundedJson(filePath: string): Promise<unknown> {
  const before = await lstat(filePath, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1n ||
      before.size > BigInt(MAX_MOD_DEPLOYMENT_RECOVERY_JOURNAL_BYTES)) {
    throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
  }
  const content = await readFile(filePath, 'utf8')
  const after = await lstat(filePath, { bigint: true })
  if (!sameFileSnapshot(before, after)) throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
  return JSON.parse(content) as unknown
}

async function writeJsonExclusive(filePath: string, value: unknown): Promise<void> {
  const content = `${JSON.stringify(value, null, 2)}\n`
  if (Buffer.byteLength(content, 'utf8') > MAX_MOD_DEPLOYMENT_MANIFEST_BYTES) {
    throw new ModDeploymentError('MOD_DEPLOYMENT_MANIFEST_INVALID')
  }
  const handle = await open(filePath, 'wx', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeJsonAtomic(
  filePath: string,
  temporary: string,
  value: unknown,
  assertActive: () => void,
  afterPendingSynced: () => Promise<void>
): Promise<void> {
  const content = `${JSON.stringify(value, null, 2)}\n`
  if (Buffer.byteLength(content, 'utf8') > MAX_MOD_DEPLOYMENT_RECOVERY_JOURNAL_BYTES) {
    throw new ModDeploymentError('MOD_DEPLOYMENT_MANIFEST_INVALID')
  }
  let handle: FileHandle | null = null
  try {
    assertActive()
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    assertActive()
    await handle.writeFile(content, 'utf8')
    assertActive()
    await handle.sync()
    assertActive()
    await handle.close()
    handle = null
    await afterPendingSynced()
    assertActive()
    await rename(temporary, filePath)
    await syncDirectory(dirname(filePath))
    assertActive()
  } catch (error) {
    await handle?.close().catch(() => undefined)
    if (error instanceof HostMutationOperationCoordinatorError) throw error
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

async function syncRenameParents(source: string, destination: string): Promise<void> {
  const sourceParent = dirname(source)
  const destinationParent = dirname(destination)
  await syncDirectory(sourceParent)
  if (!samePath(sourceParent, destinationParent)) await syncDirectory(destinationParent)
}

async function syncDirectoryTree(root: string): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const value = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new ModDeploymentError('MOD_DEPLOYMENT_ROOT_LINK_REJECTED')
      if (entry.isDirectory()) await visit(value)
      else if (entry.isFile()) {
        const handle = await open(value, constants.O_RDWR)
        try { await handle.sync() } finally { await handle.close() }
      } else throw new ModDeploymentError('MOD_DEPLOYMENT_PAYLOAD_TYPE_INVALID')
    }
    await syncDirectory(directory)
  }
  await visit(root)
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | null = null
  try {
    handle = await open(directory, constants.O_RDONLY)
    await handle.sync()
  } catch (error) {
    if (process.platform !== 'win32' || !isDirectorySyncUnsupported(error)) throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function isDirectorySyncUnsupported(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error.code === 'EINVAL' || error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EISDIR')
}

async function summarizeDirectoryIfPresent(root: string): Promise<DirectoryContentSummary | null> {
  let info
  try {
    info = await lstat(root)
  } catch (error) {
    if (isMissingError(error)) return null
    throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
  }
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(root), root)) {
    throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
  }
  return summarizeDirectoryContents(root)
}

async function summarizeDirectoryContents(root: string): Promise<DirectoryContentSummary> {
  await assertDirectoryBoundary(root, dirname(root))
  const rootBefore = await lstat(root, { bigint: true })
  const hash = createHash('sha256')
  let fileCount = 0
  let directoryCount = 0
  let totalBytes = 0
  let totalEntries = 0
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => compareText(left.name, right.name))
    const normalized = new Set<string>()
    for (const entry of entries) {
      const key = entry.name.toLowerCase()
      if (normalized.has(key) || entry.isSymbolicLink()) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
      }
      normalized.add(key)
      totalEntries += 1
      if (totalEntries > MAX_MOD_DEPLOYMENT_TREE_ENTRIES) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
      }
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const fullPath = join(directory, entry.name)
      if (entry.isDirectory()) {
        directoryCount += 1
        hash.update(`d\0${relativePath}\n`, 'utf8')
        await assertDirectoryBoundary(fullPath, root)
        await visit(fullPath, relativePath)
      } else if (entry.isFile()) {
        fileCount += 1
        const before = await lstat(fullPath, { bigint: true })
        if (!before.isFile() || before.isSymbolicLink()) {
          throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
        }
        totalBytes += Number(before.size)
        if (!Number.isSafeInteger(totalBytes) ||
            totalBytes > MAX_DEPLOYED_MOD_TOTAL_BYTES + MAX_MOD_DEPLOYMENT_MANIFEST_BYTES) {
          throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
        }
        hash.update(`f\0${relativePath}\0${before.size.toString()}\n`, 'utf8')
        for await (const chunk of createReadStream(fullPath)) hash.update(chunk as Buffer)
        const after = await lstat(fullPath, { bigint: true })
        if (!sameFileSnapshot(before, after)) throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
      } else {
        throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
      }
    }
  }
  await visit(root, '')
  const rootAfter = await lstat(root, { bigint: true })
  if (!sameFileSnapshot(rootBefore, rootAfter)) {
    throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
  }
  return directoryContentSummarySchema.parse({
    sha256: hash.digest('hex'), fileCount, directoryCount, totalBytes
  })
}

function sameFileSnapshot(
  left: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint },
  right: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function transactionLockIdentity(
  stats: { dev: bigint; ino: bigint; birthtimeNs: bigint }
): TransactionLockIdentity {
  return transactionLockIdentitySchema.parse({
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
    birthtimeNs: stats.birthtimeNs.toString()
  })
}

function sameTransactionLockIdentity(left: TransactionLockIdentity, right: TransactionLockIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs
}

function matchesSummary(
  actual: DirectoryContentSummary | null,
  expected: DirectoryContentSummary
): boolean {
  return actual !== null && actual.sha256 === expected.sha256 && actual.fileCount === expected.fileCount &&
    actual.directoryCount === expected.directoryCount && actual.totalBytes === expected.totalBytes
}

function phaseAllowsRecoveryLayout(phase: RecoveryJournalPhase, layout: RecoveryLayout): boolean {
  const allowed: Record<RecoveryJournalPhase, readonly RecoveryLayout[]> = {
    prepared: ['previous'],
    'forward-live-to-snapshot-intent': ['previous', 'snapshot-only'],
    'forward-live-to-snapshot-completed': ['snapshot-only'],
    'forward-pending-to-live-intent': ['snapshot-only', 'candidate'],
    'forward-pending-to-live-completed': ['candidate'],
    'rollback-live-to-failed-intent': ['candidate', 'failed-candidate'],
    'rollback-live-to-failed-completed': ['failed-candidate'],
    'rollback-snapshot-to-live-intent': ['snapshot-only', 'failed-candidate', 'previous', 'restored-previous'],
    'rollback-snapshot-to-live-completed': ['previous', 'restored-previous']
  }
  return allowed[phase].includes(layout)
}

function sameRecoveryJournalBinding(
  left: ModDeploymentRecoveryJournal,
  right: ModDeploymentRecoveryJournal
): boolean {
  const { phase: _leftPhase, ...leftBinding } = left
  const { phase: _rightPhase, ...rightBinding } = right
  return JSON.stringify(leftBinding) === JSON.stringify(rightBinding)
}

function isRecoveryJournalTransitionAllowed(
  previous: RecoveryJournalPhase,
  next: RecoveryJournalPhase
): boolean {
  const transitions: Record<RecoveryJournalPhase, readonly RecoveryJournalPhase[]> = {
    prepared: ['forward-live-to-snapshot-intent'],
    'forward-live-to-snapshot-intent': [
      'forward-live-to-snapshot-completed',
      'rollback-snapshot-to-live-intent'
    ],
    'forward-live-to-snapshot-completed': [
      'forward-pending-to-live-intent',
      'rollback-snapshot-to-live-intent'
    ],
    'forward-pending-to-live-intent': [
      'forward-pending-to-live-completed',
      'rollback-live-to-failed-intent',
      'rollback-snapshot-to-live-intent'
    ],
    'forward-pending-to-live-completed': ['rollback-live-to-failed-intent'],
    'rollback-live-to-failed-intent': [
      'rollback-live-to-failed-completed',
      'rollback-snapshot-to-live-intent'
    ],
    'rollback-live-to-failed-completed': ['rollback-snapshot-to-live-intent'],
    'rollback-snapshot-to-live-intent': ['rollback-snapshot-to-live-completed'],
    'rollback-snapshot-to-live-completed': []
  }
  return transitions[previous].includes(next)
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await lstat(value)
    return true
  } catch (error) {
    if (isMissingError(error)) return false
    throw error
  }
}

async function assertDirectoryBoundary(
  candidate: string,
  boundary: string,
  missingCode: 'MOD_DEPLOYMENT_STAGING_MISSING' | 'MOD_DEPLOYMENT_ROOT_INVALID' = 'MOD_DEPLOYMENT_ROOT_INVALID'
): Promise<void> {
  if (!samePath(candidate, boundary) && !isPathWithin(boundary, candidate)) {
    throw new ModDeploymentError('MOD_DEPLOYMENT_PATH_ESCAPE')
  }
  let stats
  try {
    stats = await lstat(candidate)
  } catch (error) {
    if (isMissingError(error)) throw new ModDeploymentError(missingCode)
    throw new ModDeploymentError('MOD_DEPLOYMENT_ROOT_INVALID')
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new ModDeploymentError('MOD_DEPLOYMENT_ROOT_LINK_REJECTED')
  }
  const resolvedCandidate = await realpath(candidate)
  if (!samePath(resolvedCandidate, candidate)) throw new ModDeploymentError('MOD_DEPLOYMENT_ROOT_LINK_REJECTED')
  if (!samePath(candidate, boundary)) {
    const resolvedBoundary = await realpath(boundary)
    if (!isPathWithin(resolvedBoundary, resolvedCandidate)) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_PATH_ESCAPE')
    }
  }
}

async function assertRegularFileBoundary(candidate: string, boundary: string): Promise<void> {
  if (!isPathWithin(boundary, candidate)) throw new ModDeploymentError('MOD_DEPLOYMENT_PATH_ESCAPE')
  let stats
  try {
    stats = await lstat(candidate)
  } catch (error) {
    if (isMissingError(error)) throw error
    throw new ModDeploymentError('MOD_DEPLOYMENT_STAGING_INVALID')
  }
  if (!stats.isFile() || stats.isSymbolicLink()) throw new ModDeploymentError('MOD_DEPLOYMENT_ROOT_LINK_REJECTED')
  const resolvedCandidate = await realpath(candidate)
  const resolvedBoundary = await realpath(boundary)
  if (!isPathWithin(resolvedBoundary, resolvedCandidate)) throw new ModDeploymentError('MOD_DEPLOYMENT_PATH_ESCAPE')
}

async function assertPathDoesNotExist(candidate: string): Promise<void> {
  try {
    await lstat(candidate)
  } catch (error) {
    if (isMissingError(error)) return
    throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
  }
  throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
}

function joinPayloadPath(root: string, relativePath: string): string {
  if (!isSafePayloadRelativePath(relativePath)) throw new ModDeploymentError('MOD_DEPLOYMENT_PAYLOAD_NAME_INVALID')
  const candidate = resolve(root, ...relativePath.split('/'))
  if (!isPathWithin(root, candidate)) throw new ModDeploymentError('MOD_DEPLOYMENT_PATH_ESCAPE')
  return candidate
}

function isSafePayloadRelativePath(value: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/.test(value) || value.includes('//') || value.endsWith('/')) return false
  const segments = value.split('/')
  if (segments.some((segment) => segment === '.' || segment === '..' || segment.length === 0)) return false
  const extension = extname(value).toLowerCase()
  return extension === '.dll' || extension === '.json'
}

function sumPayloadBytes(files: readonly StagedModPackageFile[]): number {
  let total = 0
  for (const file of files) {
    if (file.sizeBytes > MAX_STAGED_MOD_FILE_BYTES) throw new ModDeploymentError('MOD_DEPLOYMENT_PAYLOAD_TOO_LARGE')
    total += file.sizeBytes
    if (!Number.isSafeInteger(total) || total > MAX_STAGED_MOD_TOTAL_BYTES) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_PAYLOAD_TOO_LARGE')
    }
  }
  return total
}

function compareManagedPackages(left: ManagedModPackage, right: ManagedModPackage): number {
  return compareText(left.sourceId.toLowerCase(), right.sourceId.toLowerCase())
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right)
}

function isPathWithin(boundary: string, candidate: string): boolean {
  const relation = relative(resolve(boundary), resolve(candidate))
  return relation !== '' && relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation)
}

function normalizePath(value: string): string {
  const normalized = resolve(value).replace(/^\\\\\?\\/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function compareReceiptHistory(left: LoadedStoredReceipt, right: LoadedStoredReceipt): number {
  const timeOrder = compareText(right.persistedAt, left.persistedAt)
  return timeOrder !== 0 ? timeOrder : compareText(right.receipt.requestId, left.receipt.requestId)
}

function encodeReceiptHistoryCursor(entry: LoadedStoredReceipt): string {
  return Buffer.from(`${entry.persistedAt}\n${entry.receipt.requestId}`, 'utf8').toString('base64url')
}

function decodeReceiptHistoryCursor(input: string | null): ReceiptHistoryCursor | null {
  if (input === null) return null
  if (input.length > MAX_MOD_DEPLOYMENT_HISTORY_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(input)) {
    throw new Error('invalid cursor')
  }
  const decoded = Buffer.from(input, 'base64url').toString('utf8')
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== input) throw new Error('invalid cursor')
  const parts = decoded.split('\n')
  if (parts.length !== 2) throw new Error('invalid cursor')
  const persistedAt = z.string().datetime({ offset: true }).safeParse(parts[0])
  const requestId = receiptRequestIdSchema.safeParse(parts[1])
  if (!persistedAt.success || !requestId.success || requestId.data !== parts[1]) throw new Error('invalid cursor')
  return { persistedAt: persistedAt.data, requestId: requestId.data }
}

function isMissingError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}

function mapHostMutationCoordinatorError(
  code: HostMutationOperationCoordinatorError['code']
): ModDeploymentError['code'] {
  if (code === 'HOST_MUTATION_LEASE_BUSY') return 'MOD_DEPLOYMENT_HOST_LEASE_BUSY'
  if (code === 'HOST_MUTATION_LEASE_DIRTY') return 'MOD_DEPLOYMENT_HOST_LEASE_DIRTY'
  if (code === 'HOST_MUTATION_LEASE_RECOVERY_REQUIRED') {
    return 'MOD_DEPLOYMENT_HOST_LEASE_RECOVERY_REQUIRED'
  }
  if (code === 'HOST_MUTATION_LEASE_RECOVERY_MISMATCH' ||
      code === 'HOST_MUTATION_LEASE_RECOVERY_NOT_REQUIRED') {
    return 'MOD_DEPLOYMENT_RECOVERY_REQUIRED'
  }
  if (code === 'HOST_MUTATION_LEASE_LOST') return 'MOD_DEPLOYMENT_HOST_LEASE_LOST'
  return 'MOD_DEPLOYMENT_HOST_LEASE_UNAVAILABLE'
}

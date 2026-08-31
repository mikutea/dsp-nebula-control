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
const MAX_MOD_DEPLOYMENT_RECEIPT_BYTES = 16 * 1024
const MAX_SNAPSHOTS_DEFAULT = 8

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

interface ReceiptHistoryCursor {
  persistedAt: string
  requestId: string
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
  readonly #readPlatformInventory: NonNullable<ModDeploymentServiceOptions['readPlatformInventory']> | null
  readonly #faultInjector: ModDeploymentServiceOptions['faultInjector']
  readonly #now: () => Date
  readonly #maxSnapshots: number
  #tail: Promise<void> = Promise.resolve()

  constructor(options: ModDeploymentServiceOptions) {
    if (!isAbsolute(options.stagingRoot) || !isAbsolute(options.pluginsRoot) ||
        typeof options.verifyStoppedState !== 'function') {
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
    await this.#assertPlatformLockCurrent(request)
    const fingerprint = requestFingerprint(request)
    return this.#exclusive(async () => this.#withFileLock(request.requestId, async () => {
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

      const prepared = await this.#prepare(request, current)
      return this.#executePrepared(prepared)
    }))
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

  async #executePrepared(prepared: PreparedDeployment): Promise<ModDeploymentReceipt> {
    if (prepared.snapshotCount >= this.#maxSnapshots) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_SNAPSHOT_LIMIT')
    }
    await this.#assertStopped()
    const pendingRoot = await this.#pendingPath(prepared.request.requestId)
    await this.#buildPendingTree(prepared, pendingRoot)
    await this.#injectFault('after-pending-built')
    await this.#assertStopped()

    const snapshotsRoot = await this.#ensureControlDirectory('snapshots')
    const snapshotId = `snapshot-${prepared.current.revision.slice(0, 16)}-${prepared.request.requestId}`
    const snapshotRoot = join(snapshotsRoot, snapshotId)
    await assertPathDoesNotExist(snapshotRoot)
    let snapshotCreated = false
    let published = false
    try {
      await rename(this.#pluginsRoot, snapshotRoot)
      snapshotCreated = true
      await this.#injectFault('after-snapshot')
      await rename(pendingRoot, this.#pluginsRoot)
      published = true
      await this.#injectFault('after-publish')
      const receipt = successReceipt(prepared)
      await this.#writeReceipt(prepared.fingerprint, receipt)
      return receipt
    } catch (error) {
      if (!snapshotCreated) {
        if (error instanceof ModDeploymentError) throw error
        throw new ModDeploymentError('MOD_DEPLOYMENT_EXECUTION_FAILED')
      }
      const rollbackSucceeded = await this.#rollbackPublication(prepared.request.requestId, snapshotRoot, published)
      const receipt = rollbackReceipt(prepared, rollbackSucceeded)
      try {
        await this.#writeReceipt(prepared.fingerprint, receipt)
      } catch {
        // The audit-safe receipt is still returned; stale receipt state will fail closed on reuse.
      }
      return receipt
    }
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

  async #rollbackPublication(requestId: string, snapshotRoot: string, published: boolean): Promise<boolean> {
    try {
      if (published) {
        const recoveryRoot = await this.#ensureControlDirectory('recovery')
        const failedRoot = join(recoveryRoot, `failed-${requestId}`)
        await assertPathDoesNotExist(failedRoot)
        await rename(this.#pluginsRoot, failedRoot)
      }
      await rename(snapshotRoot, this.#pluginsRoot)
      await assertDirectoryBoundary(this.#pluginsRoot, dirname(this.#pluginsRoot))
      return true
    } catch {
      return false
    }
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

  async #loadState(): Promise<ActiveModState> {
    await this.#ensureRoots()
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

  async #assertStopped(): Promise<void> {
    try {
      const proof = await this.#verifyStoppedState()
      if (proof.processStopped !== true || proof.portClosed !== true) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_STOP_GATE_REJECTED')
      }
    } catch (error) {
      if (error instanceof ModDeploymentError) throw error
      throw new ModDeploymentError('MOD_DEPLOYMENT_STOP_GATE_REJECTED')
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

  async #readReceipt(requestId: string): Promise<LoadedStoredReceipt | null> {
    const receiptsRoot = await this.#ensureControlDirectory('receipts')
    const receiptPath = join(receiptsRoot, `${requestId}.json`)
    try {
      await assertRegularFileBoundary(receiptPath, receiptsRoot)
    } catch (error) {
      if (isMissingError(error)) return null
      throw error
    }
    try {
      const metadata = await lstat(receiptPath)
      if (metadata.size > MAX_MOD_DEPLOYMENT_RECEIPT_BYTES) {
        throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
      }
      const raw = await readBoundedJson(receiptPath)
      const currentMetadata = await lstat(receiptPath)
      if (metadata.size !== currentMetadata.size || metadata.mtimeMs !== currentMetadata.mtimeMs) {
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

  async #writeReceipt(fingerprint: string, receipt: ModDeploymentReceipt): Promise<void> {
    const receiptsRoot = await this.#ensureControlDirectory('receipts')
    const finalPath = join(receiptsRoot, `${receipt.requestId}.json`)
    const pendingPath = join(receiptsRoot, `${receipt.requestId}.pending`)
    await assertPathDoesNotExist(finalPath)
    const persistedAt = this.#now()
    if (!(persistedAt instanceof Date) || !Number.isFinite(persistedAt.getTime())) {
      throw new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    }
    await writeJsonExclusive(pendingPath, {
      format: RECEIPT_ENVELOPE_FORMAT,
      schemaVersion: 1,
      fingerprint,
      persistedAt: persistedAt.toISOString(),
      receipt: { ...receipt, reused: false }
    })
    await rename(pendingPath, finalPath)
  }

  async #ensureRoots(): Promise<void> {
    await assertDirectoryBoundary(this.#stagingRoot, dirname(this.#stagingRoot))
    await assertDirectoryBoundary(this.#pluginsRoot, dirname(this.#pluginsRoot))
    try {
      await mkdir(this.#controlRoot)
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw new ModDeploymentError('MOD_DEPLOYMENT_ROOT_INVALID')
    }
    await assertDirectoryBoundary(this.#controlRoot, dirname(this.#controlRoot))
  }

  async #ensureControlDirectory(name: 'snapshots' | 'recovery' | 'pending' | 'receipts'): Promise<string> {
    await this.#ensureRoots()
    const candidate = join(this.#controlRoot, name)
    try {
      await mkdir(candidate)
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw new ModDeploymentError('MOD_DEPLOYMENT_ROOT_INVALID')
    }
    await assertDirectoryBoundary(candidate, this.#controlRoot)
    return candidate
  }

  async #withFileLock<T>(owner: string, action: () => Promise<T>): Promise<T> {
    await this.#ensureRoots()
    const lockPath = join(this.#controlRoot, 'transaction.lock')
    let handle: FileHandle | null = null
    try {
      handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      await handle.writeFile(`${owner}\n`, 'utf8')
      await handle.sync()
    } catch (error) {
      await handle?.close().catch(() => undefined)
      if (handle !== null) await unlink(lockPath).catch(() => undefined)
      if (isAlreadyExistsError(error)) throw new ModDeploymentError('MOD_DEPLOYMENT_BUSY')
      throw new ModDeploymentError('MOD_DEPLOYMENT_ROOT_INVALID')
    }
    try {
      return await action()
    } finally {
      await handle.close().catch(() => undefined)
      await unlink(lockPath).catch(() => undefined)
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

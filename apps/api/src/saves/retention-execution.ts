import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  lstat,
  link,
  mkdir,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
  type FileHandle
} from 'node:fs/promises'
import { hostname, uptime } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { HostMutationLeaseError } from '../host-mutation/lease.js'
import {
  HostMutationOperationCoordinatorError,
  hostMutationReturn,
  hostMutationThrow,
  type HostMutationOperationCoordinator,
  type HostMutationRecoveryOperationCoordinator,
  type HostMutationOperationScope
} from '../host-mutation/operation-coordinator.js'
import { verifyBackupPair } from './backups.js'
import {
  readBoundedDirectory,
  resolveNormalBackupDirectory,
  resolveNormalDirectory,
  safeImmediateChild
} from './boundary.js'
import { planBackupRetention } from './retention.js'
import {
  MAX_DIRECTORY_ENTRIES,
  MAX_MANIFEST_BYTES,
  backupIdSchema,
  backupManifestV1Schema,
  retentionPolicySchema,
  saveNameSchema,
  type BackupVerification,
  type RetentionPlan,
  type RetentionPolicy
} from './schemas.js'

const CONTROL_DIRECTORY = '.retention-control'
const RETIRED_DIRECTORY = 'retired'
const RECEIPT_DIRECTORY = 'receipts'
const ANNOTATION_DIRECTORY = 'annotations'
const LOCK_FILE = 'retention.lock'
const OPERATION_PREFIX = 'retire-'
const JOURNAL_PREFIX = 'journal-'
const MAX_JOURNAL_ENTRIES = 20_000
const MAX_JOURNAL_BYTES = 1_048_576
export const MAX_RETIREMENT_EXECUTION_BATCH = 128
const activeRetentionLocks = new Set<string>()

const requestIdSchema = z.string().uuid().transform((value) => value.toLocaleLowerCase('en-US'))
const digestSchema = z.string().length(64).regex(/^[a-f0-9]{64}$/)
const isoDateSchema = z.string().datetime({ offset: true })
const retirementPreviewRequestSchema = z.strictObject({
  referenceTime: isoDateSchema,
  policy: retentionPolicySchema
})
const retirementExecuteRequestSchema = retirementPreviewRequestSchema.extend({
  requestId: requestIdSchema,
  previewDigest: digestSchema,
  confirmation: z.literal('RETIRE_BACKUPS')
})
const retirementRestoreRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  retirementRequestId: requestIdSchema,
  confirmation: z.literal('RESTORE_RETIRED_BACKUPS')
})
const purgePreviewRequestSchema = z.strictObject({
  retirementRequestId: requestIdSchema
})
const purgeExecuteRequestSchema = purgePreviewRequestSchema.extend({
  requestId: requestIdSchema,
  purgePreviewDigest: digestSchema,
  confirmation: z.literal('PURGE_RETIRED_BACKUPS')
})
const backupAnnotationRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  backupId: backupIdSchema,
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  note: z.string().trim().min(1).max(256).nullable(),
  protected: z.boolean(),
  confirmation: z.literal('UPDATE_BACKUP_ANNOTATION')
})
const retentionRecoveryRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('annotate'),
    requestId: requestIdSchema,
    confirmation: z.literal('RECOVER_RETENTION_OPERATION')
  }),
  z.strictObject({
    operation: z.literal('retire'),
    requestId: requestIdSchema,
    confirmation: z.literal('RECOVER_RETENTION_OPERATION')
  }),
  z.strictObject({
    operation: z.literal('restore'),
    requestId: requestIdSchema,
    retirementRequestId: requestIdSchema,
    confirmation: z.literal('RECOVER_RETENTION_OPERATION')
  }),
  z.strictObject({
    operation: z.literal('purge'),
    requestId: requestIdSchema,
    retirementRequestId: requestIdSchema,
    confirmation: z.literal('RECOVER_RETENTION_OPERATION')
  })
])

const excludedBackupSchema = z.strictObject({
  backupId: backupIdSchema,
  reason: z.enum(['created-at-unavailable', 'redirected-entry'])
})
const retirementCandidateReceiptSchema = z.strictObject({
  backupId: backupIdSchema,
  saveName: saveNameSchema,
  createdAt: isoDateSchema,
  health: z.enum(['healthy', 'incomplete', 'corrupt']),
  totalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  evidenceDigest: digestSchema
})
const retirementReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operation: z.literal('retire'),
  requestId: requestIdSchema,
  previewDigest: digestSchema,
  committedAt: isoDateSchema,
  retired: z.array(retirementCandidateReceiptSchema).max(MAX_DIRECTORY_ENTRIES),
  recoveryRequired: z.literal(false)
})
const restoreReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operation: z.literal('restore-retired'),
  requestId: requestIdSchema,
  retirementRequestId: requestIdSchema,
  committedAt: isoDateSchema,
  restoredBackupIds: z.array(backupIdSchema).max(MAX_DIRECTORY_ENTRIES),
  recoveryRequired: z.literal(false)
})
const backupAnnotationSchema = z.strictObject({
  backupId: backupIdSchema,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  note: z.string().min(1).max(256).nullable(),
  protected: z.boolean(),
  updatedAt: isoDateSchema
})
const annotationReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operation: z.literal('annotate'),
  requestId: requestIdSchema,
  committedAt: isoDateSchema,
  annotation: backupAnnotationSchema
})
const purgeReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operation: z.literal('purge-retired'),
  requestId: requestIdSchema,
  retirementRequestId: requestIdSchema,
  committedAt: isoDateSchema,
  purgedBackupIds: z.array(backupIdSchema).max(MAX_DIRECTORY_ENTRIES),
  bytesFreed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  recoveryRequired: z.literal(false)
})
const receiptEnvelopeSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    format: z.literal('dyson-control-retention-receipt'),
    schemaVersion: z.literal(1),
    operation: z.literal('retire'),
    requestFingerprint: digestSchema,
    receipt: retirementReceiptSchema
  }),
  z.strictObject({
    format: z.literal('dyson-control-retention-receipt'),
    schemaVersion: z.literal(1),
    operation: z.literal('restore-retired'),
    requestFingerprint: digestSchema,
    receipt: restoreReceiptSchema
  }),
  z.strictObject({
    format: z.literal('dyson-control-retention-receipt'),
    schemaVersion: z.literal(1),
    operation: z.literal('annotate'),
    requestFingerprint: digestSchema,
    receipt: annotationReceiptSchema
  }),
  z.strictObject({
    format: z.literal('dyson-control-retention-receipt'),
    schemaVersion: z.literal(1),
    operation: z.literal('purge-retired'),
    requestFingerprint: digestSchema,
    receipt: purgeReceiptSchema
  })
])
const annotationEventSchema = z.strictObject({
  format: z.literal('dyson-control-backup-annotation'),
  schemaVersion: z.literal(1),
  requestId: requestIdSchema,
  requestFingerprint: digestSchema,
  annotation: backupAnnotationSchema
})

const journalStateSchema = z.enum([
  'moving', 'rolling-back', 'rolled-back', 'committed',
  'restoring', 'restore-rolling-back', 'restored',
  'purging', 'purge-recovery-required', 'purged', 'recovery-required'
])
const journalEntrySchema = z.strictObject({
  format: z.literal('dyson-control-retention-journal'),
  schemaVersion: z.literal(1),
  sequence: z.number().int().positive().max(MAX_JOURNAL_ENTRIES),
  retirementRequestId: requestIdSchema,
  requestFingerprint: digestSchema,
  previewDigest: digestSchema,
  state: journalStateSchema,
  planned: z.array(retirementCandidateReceiptSchema).max(MAX_DIRECTORY_ENTRIES),
  movedBackupIds: z.array(backupIdSchema).max(MAX_DIRECTORY_ENTRIES),
  restoreRequestId: requestIdSchema.nullable(),
  restoredBackupIds: z.array(backupIdSchema).max(MAX_DIRECTORY_ENTRIES),
  purgeRequestId: requestIdSchema.nullable(),
  purgeRequestFingerprint: digestSchema.nullable(),
  purgeIntentBackupId: backupIdSchema.nullable(),
  purgedBackupIds: z.array(backupIdSchema).max(MAX_DIRECTORY_ENTRIES),
  updatedAt: isoDateSchema,
  retirementReceipt: retirementReceiptSchema.nullable(),
  restoreReceipt: restoreReceiptSchema.nullable(),
  purgeReceipt: purgeReceiptSchema.nullable()
})
const lockSchema = z.strictObject({
  format: z.literal('dyson-control-retention-lock'),
  schemaVersion: z.literal(1),
  host: z.string().min(1).max(255),
  bootId: z.string().min(1).max(64),
  pid: z.number().int().positive()
})

type RetirementExecuteRequest = z.infer<typeof retirementExecuteRequestSchema>
type RetirementRestoreRequest = z.infer<typeof retirementRestoreRequestSchema>
type RetirementReceipt = z.infer<typeof retirementReceiptSchema>
type RestoreReceipt = z.infer<typeof restoreReceiptSchema>
type AnnotationReceipt = z.infer<typeof annotationReceiptSchema>
type PurgeReceipt = z.infer<typeof purgeReceiptSchema>
type BackupAnnotation = z.infer<typeof backupAnnotationSchema>
type JournalEntry = z.infer<typeof journalEntrySchema>
type RetentionRecoveryRequest = z.infer<typeof retentionRecoveryRequestSchema>

export type BackupRetentionErrorCode =
  | 'SAVE_RETENTION_REQUEST_INVALID'
  | 'SAVE_RETENTION_STORAGE_UNAVAILABLE'
  | 'SAVE_RETENTION_LOCK_BUSY'
  | 'SAVE_RETENTION_IDEMPOTENCY_CONFLICT'
  | 'SAVE_RETENTION_PLAN_CHANGED'
  | 'SAVE_RETENTION_BACKUP_CHANGED'
  | 'SAVE_RETENTION_OPERATION_NOT_FOUND'
  | 'SAVE_RETENTION_OPERATION_NOT_RESTORABLE'
  | 'SAVE_RETENTION_ANNOTATION_CONFLICT'
  | 'SAVE_RETENTION_PURGE_TOO_EARLY'
  | 'SAVE_RETENTION_BATCH_LIMIT_EXCEEDED'
  | 'SAVE_RETENTION_HOST_LEASE_BUSY'
  | 'SAVE_RETENTION_HOST_LEASE_RECOVERY_REQUIRED'
  | 'SAVE_RETENTION_HOST_LEASE_LOST'
  | 'SAVE_RETENTION_HOST_LEASE_UNAVAILABLE'
  | 'SAVE_RETENTION_RECOVERY_REQUIRED'
  | 'SAVE_RETENTION_FAILED'

export class BackupRetentionError extends Error {
  constructor(readonly code: BackupRetentionErrorCode, options?: ErrorOptions) {
    super(code, options)
    this.name = 'BackupRetentionError'
  }
}

export interface BackupRetentionProtectionSource {
  listProtectedBackupIds(): Promise<ReadonlySet<string>>
}

export interface BackupRetentionPreview {
  schemaVersion: 1
  mode: 'dry-run'
  referenceTime: string
  policy: RetentionPolicy
  plan: RetentionPlan
  executionBatch: {
    maximumCandidates: number
    selectedBackupIds: string[]
    deferredCandidateCount: number
  }
  excluded: Array<z.infer<typeof excludedBackupSchema>>
  inventoryDigest: string
  previewDigest: string
}

export interface BackupRetentionPurgePreview {
  schemaVersion: 1
  mode: 'dry-run'
  retirementRequestId: string
  eligibleAt: string
  eligible: boolean
  retiredBackupIds: string[]
  totalBytes: number
  retirementReceiptDigest: string
  purgePreviewDigest: string
}

export interface BackupRetentionRecoveryResult {
  operation: 'annotate' | 'retire' | 'restore' | 'purge'
  requestId: string
  retirementRequestId: string | null
  outcome: 'receipt-republished' | 'rolled-back' | 'resume-required' | 'already-terminal'
}

export interface BackupRetentionControlOptions {
  backupRoot: string
  protectionSource?: BackupRetentionProtectionSource
  hostMutationCoordinator?: HostMutationOperationCoordinator
  /** Trusted capability used only by the explicit recovery workflow. */
  hostMutationRecoveryCoordinator?: HostMutationRecoveryOperationCoordinator
  now?: () => Date
  maximumDirectoryEntries?: number
  /** Defaults to seven days. Zero is intended only for deterministic tests. */
  minimumPurgeAgeMs?: number
  /** @internal Deterministic failure injection for transaction tests only. */
  phase?: (
    phase: 'before-retire-move' | 'after-retire-move' |
      'before-restore-move' | 'after-restore-move' |
      'before-purge' | 'after-purge' | 'after-annotation-event',
    backupId: string
  ) => void | Promise<void>
}

interface PreparedRetentionRoots {
  backupRoot: string
  controlRoot: string
  retiredRoot: string
  receiptRoot: string
  annotationRoot: string
  lockPath: string
}

interface InventoryResult {
  candidates: Array<{
    backupId: string
    createdAt: string
    health: 'healthy' | 'incomplete' | 'corrupt'
    protected: boolean
  }>
  verifications: Map<string, InventoryEvidence>
  excluded: BackupRetentionPreview['excluded']
}

interface InventoryEvidence {
  verification: BackupVerification
  evidenceDigest: string
}

interface BackupRetentionHostMutationContext {
  readonly scope: HostMutationOperationScope
  markPossibleWrite(): void
  markDurableTerminal(): void
  markDurableRecoveryBoundary(): void
  hasPossibleWrite(): boolean
  canReleaseRecovery(): boolean
}

/**
 * Recoverable first-stage retention executor. It never touches live saves and
 * never irreversibly unlinks backup bytes: selected verified backup directories
 * are atomically retired beneath the fixed backup root and can be restored by a
 * separately confirmed transaction. Permanent purge belongs to a later,
 * independently confirmed grace-period operation.
 */
export class BackupRetentionControlService {
  readonly #configuredBackupRoot: string
  readonly #protectionSource: BackupRetentionProtectionSource
  readonly #now: () => Date
  readonly #maximumDirectoryEntries: number
  readonly #phase: NonNullable<BackupRetentionControlOptions['phase']>
  readonly #minimumPurgeAgeMs: number
  readonly #hostMutationCoordinator: HostMutationOperationCoordinator | null
  readonly #hostMutationRecoveryCoordinator: HostMutationRecoveryOperationCoordinator | null

  constructor(options: BackupRetentionControlOptions) {
    if (!options || !path.isAbsolute(options.backupRoot)) {
      throw new BackupRetentionError('SAVE_RETENTION_REQUEST_INVALID')
    }
    const maximum = options.maximumDirectoryEntries ?? MAX_DIRECTORY_ENTRIES
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > MAX_DIRECTORY_ENTRIES) {
      throw new BackupRetentionError('SAVE_RETENTION_REQUEST_INVALID')
    }
    this.#configuredBackupRoot = path.resolve(options.backupRoot)
    this.#protectionSource = options.protectionSource ?? {
      listProtectedBackupIds: async () => new Set<string>()
    }
    this.#hostMutationCoordinator = options.hostMutationCoordinator ?? null
    this.#hostMutationRecoveryCoordinator = options.hostMutationRecoveryCoordinator ?? null
    this.#now = options.now ?? (() => new Date())
    this.#maximumDirectoryEntries = maximum
    this.#phase = options.phase ?? (() => undefined)
    const minimumPurgeAgeMs = options.minimumPurgeAgeMs ?? 7 * 24 * 60 * 60 * 1_000
    if (!Number.isSafeInteger(minimumPurgeAgeMs) || minimumPurgeAgeMs < 0 ||
        minimumPurgeAgeMs > 365 * 24 * 60 * 60 * 1_000) {
      throw new BackupRetentionError('SAVE_RETENTION_REQUEST_INVALID')
    }
    this.#minimumPurgeAgeMs = minimumPurgeAgeMs
  }

  async preview(input: unknown): Promise<BackupRetentionPreview> {
    const request = parsePreviewRequest(input)
    const backupRoot = await resolveRetentionBackupRoot(this.#configuredBackupRoot)
    return (await this.#snapshotAtRoot(backupRoot, request.referenceTime, request.policy)).preview
  }

  async listAnnotations(): Promise<BackupAnnotation[]> {
    const backupRoot = await resolveRetentionBackupRoot(this.#configuredBackupRoot)
    return [...(await readAnnotationStateIfPresent(backupRoot)).values()]
      .sort((left, right) => left.backupId.localeCompare(right.backupId))
  }

  /**
   * Trusted explicit recovery entrypoint. Ordinary retention mutations never
   * call this capability. The generic coordinator resolves the prior lease's
   * instance/digest binding internally and will only acquire when the exact
   * persisted domain operation and request ID match.
   */
  async recoverInterrupted(input: unknown): Promise<BackupRetentionRecoveryResult> {
    const request = parseRecoveryRequest(input)
    const coordinator = this.#hostMutationRecoveryCoordinator
    if (coordinator === null) {
      throw new BackupRetentionError('SAVE_RETENTION_HOST_LEASE_UNAVAILABLE')
    }
    // Reject obviously unrelated/corrupt domain evidence before probing the
    // global recovery broker. A second read occurs under the acquired lease.
    await assertRetentionRecoveryEvidence(this.#configuredBackupRoot, request)
    try {
      return await coordinator.runRecoveryExclusive({
        expectedOperation: retentionHostOperation(request.operation),
        expectedRequestId: request.requestId
      }, async (scope) => {
        try {
          scope.assertActive()
          const result = await this.#recoverInterruptedUnderLease(request, scope)
          scope.assertActive()
          return hostMutationReturn(result, 'release')
        } catch (error) {
          if (error instanceof HostMutationLeaseError ||
              error instanceof HostMutationOperationCoordinatorError) throw error
          return hostMutationThrow<BackupRetentionRecoveryResult>(
            error instanceof BackupRetentionError
              ? error
              : new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED', { cause: error }),
            'abandon'
          )
        }
      })
    } catch (error) {
      if (error instanceof BackupRetentionError) throw error
      if (error instanceof HostMutationOperationCoordinatorError) {
        if (error.code === 'HOST_MUTATION_LEASE_RECOVERY_NOT_REQUIRED') {
          const replay = await readTerminalRetentionRecoveryReplay(this.#configuredBackupRoot, request)
          if (replay !== null) return replay
          throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED', { cause: error })
        }
        throw new BackupRetentionError(mapHostMutationCoordinatorError(error.code), { cause: error })
      }
      if (error instanceof HostMutationLeaseError) {
        throw new BackupRetentionError('SAVE_RETENTION_HOST_LEASE_LOST', { cause: error })
      }
      throw new BackupRetentionError('SAVE_RETENTION_HOST_LEASE_UNAVAILABLE', { cause: error })
    }
  }

  async #recoverInterruptedUnderLease(
    request: RetentionRecoveryRequest,
    scope: HostMutationOperationScope
  ): Promise<BackupRetentionRecoveryResult> {
    const roots = await resolveExistingRetentionRoots(this.#configuredBackupRoot)
    return await withRetentionLock(roots, async () => {
      scope.assertActive()
      await assertRetentionRecoveryEvidence(this.#configuredBackupRoot, request)
      scope.assertActive()

      if (request.operation === 'annotate') {
        const ledger = await readAnnotationLedger(roots.annotationRoot)
        const event = ledger.byRequestId.get(request.requestId)
        if (event === undefined) {
          return recoveryResult(request, 'already-terminal')
        }
        const receipt = annotationReceiptSchema.parse({
          schemaVersion: 1,
          operation: 'annotate',
          requestId: request.requestId,
          committedAt: event.annotation.updatedAt,
          annotation: event.annotation
        })
        scope.assertActive()
        await publishReceiptEnvelopeIfMissing(roots, {
          format: 'dyson-control-retention-receipt',
          schemaVersion: 1,
          operation: 'annotate',
          requestFingerprint: event.requestFingerprint,
          receipt
        })
        scope.assertActive()
        return recoveryResult(request, 'receipt-republished')
      }

      const operationDirectory = operationPath(roots, request.operation === 'retire'
        ? request.requestId
        : request.retirementRequestId)
      const history = await readJournalHistory(operationDirectory)
      let journal = history.at(-1) ?? null
      if (journal === null) {
        if (request.operation !== 'retire') {
          throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
        }
        await cleanUnpublishedRetirementOperation(operationDirectory, scope)
        return recoveryResult(request, 'rolled-back')
      }
      assertRecoveryRequestMatchesJournal(history, request)

      if (request.operation === 'retire') {
        if (journal.state === 'moving' || journal.state === 'rolling-back' ||
            (journal.state === 'recovery-required' && journal.retirementReceipt === null)) {
          const rolledBack = await rollbackRetirementMoves(roots, operationDirectory, journal, this.#now, scope)
          if (!rolledBack) throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
          return recoveryResult(request, 'rolled-back')
        }
        if (journal.state === 'committed' && journal.retirementReceipt !== null) {
          await assertTerminalJournalLayout(roots, operationDirectory, journal)
          scope.assertActive()
          await publishReceiptEnvelopeIfMissing(roots, {
            format: 'dyson-control-retention-receipt',
            schemaVersion: 1,
            operation: 'retire',
            requestFingerprint: journal.requestFingerprint,
            receipt: journal.retirementReceipt
          })
          scope.assertActive()
          return recoveryResult(request, 'receipt-republished')
        }
        if (journal.state === 'rolled-back') {
          await assertTerminalJournalLayout(roots, operationDirectory, journal)
          return recoveryResult(request, 'already-terminal')
        }
        throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
      }

      if (request.operation === 'restore') {
        if (journal.state === 'restoring' || journal.state === 'restore-rolling-back' ||
            (journal.state === 'recovery-required' && journal.retirementReceipt !== null)) {
          const rolledBack = await rollbackRestoreMoves(roots, operationDirectory, journal, this.#now, scope)
          if (!rolledBack) throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
          return recoveryResult(request, 'rolled-back')
        }
        if (journal.state === 'restored' && journal.restoreReceipt !== null) {
          await assertTerminalJournalLayout(roots, operationDirectory, journal)
          scope.assertActive()
          await publishReceiptEnvelopeIfMissing(roots, {
            format: 'dyson-control-retention-receipt',
            schemaVersion: 1,
            operation: 'restore-retired',
            requestFingerprint: requestFingerprint('restore-retired', {
              requestId: request.requestId,
              retirementRequestId: request.retirementRequestId,
              confirmation: 'RESTORE_RETIRED_BACKUPS'
            }),
            receipt: journal.restoreReceipt
          })
          scope.assertActive()
          return recoveryResult(request, 'receipt-republished')
        }
        if (journal.state === 'committed') {
          await assertTerminalJournalLayout(roots, operationDirectory, journal)
          return recoveryResult(request, 'resume-required')
        }
        throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
      }

      if (journal.state === 'purging') {
        journal = nextJournal(journal, {
          state: 'purge-recovery-required',
          updatedAt: this.#now().toISOString()
        })
        scope.assertActive()
        await appendJournal(operationDirectory, journal)
        scope.assertActive()
        return recoveryResult(request, 'resume-required')
      }
      if (journal.state === 'purge-recovery-required' || journal.state === 'committed') {
        await assertTerminalJournalLayout(roots, operationDirectory, journal)
        return recoveryResult(request, 'resume-required')
      }
      if (journal.state === 'purged' && journal.purgeReceipt !== null &&
          journal.purgeRequestFingerprint !== null) {
        await assertTerminalJournalLayout(roots, operationDirectory, journal)
        scope.assertActive()
        await publishReceiptEnvelopeIfMissing(roots, {
          format: 'dyson-control-retention-receipt',
          schemaVersion: 1,
          operation: 'purge-retired',
          requestFingerprint: journal.purgeRequestFingerprint,
          receipt: journal.purgeReceipt
        })
        scope.assertActive()
        return recoveryResult(request, 'receipt-republished')
      }
      throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
    }, scope, true)
  }

  async setAnnotation(input: unknown): Promise<{ receipt: AnnotationReceipt, reused: boolean }> {
    const request = parseAnnotationRequest(input)
    return await this.#runHostMutation('backup-retention-annotate', request.requestId,
      async (context) => await this.#setAnnotationUnderHostLease(request, context))
  }

  async #setAnnotationUnderHostLease(
    request: z.infer<typeof backupAnnotationRequestSchema>,
    context: BackupRetentionHostMutationContext
  ): Promise<{ receipt: AnnotationReceipt, reused: boolean }> {
    const roots = await prepareRetentionRoots(this.#configuredBackupRoot)
    return await withRetentionLock(roots, async () => {
      context.scope.assertActive()
      context.markPossibleWrite()
      await reconcileRetentionOperations(roots, this.#now, undefined, undefined, context.scope)
      context.scope.assertActive()
      context.markDurableTerminal()
      const fingerprint = requestFingerprint('annotate', request)
      const existing = await readReceiptEnvelope(roots, 'annotate', request.requestId)
      if (existing !== null) {
        if (existing.requestFingerprint !== fingerprint) {
          throw new BackupRetentionError('SAVE_RETENTION_IDEMPOTENCY_CONFLICT')
        }
        return { receipt: existing.receipt, reused: true }
      }

      const ledger = await readAnnotationLedger(roots.annotationRoot)
      const replayedEvent = ledger.byRequestId.get(request.requestId)
      if (replayedEvent !== undefined) {
        if (replayedEvent.requestFingerprint !== fingerprint) {
          throw new BackupRetentionError('SAVE_RETENTION_IDEMPOTENCY_CONFLICT')
        }
        const receipt = annotationReceiptSchema.parse({
          schemaVersion: 1,
          operation: 'annotate',
          requestId: request.requestId,
          committedAt: replayedEvent.annotation.updatedAt,
          annotation: replayedEvent.annotation
        })
        await publishReceiptEnvelope(roots, {
          format: 'dyson-control-retention-receipt',
          schemaVersion: 1,
          operation: 'annotate',
          requestFingerprint: fingerprint,
          receipt
        })
        return { receipt, reused: true }
      }
      await resolveNormalBackupDirectory(roots.backupRoot, request.backupId).catch((error: unknown) => {
        throw new BackupRetentionError('SAVE_RETENTION_BACKUP_CHANGED', { cause: error })
      })
      const current = ledger.state.get(request.backupId) ?? null
      if ((current?.revision ?? null) !== request.expectedRevision) {
        throw new BackupRetentionError('SAVE_RETENTION_ANNOTATION_CONFLICT')
      }
      const annotation = backupAnnotationSchema.parse({
        backupId: request.backupId,
        revision: (current?.revision ?? 0) + 1,
        note: request.note,
        protected: request.protected,
        updatedAt: this.#now().toISOString()
      })
      const event = annotationEventSchema.parse({
        format: 'dyson-control-backup-annotation',
        schemaVersion: 1,
        requestId: request.requestId,
        requestFingerprint: fingerprint,
        annotation
      })
      context.scope.assertActive()
      context.markPossibleWrite()
      await publishImmutableJson(annotationEventPath(roots.annotationRoot, event), event)
      context.scope.assertActive()
      // The immutable event is the replayable terminal authority. If receipt
      // publication is interrupted, a later ordinary replay can reconstruct
      // it without consuming a host-recovery lease.
      context.markDurableTerminal()
      await this.#phase('after-annotation-event', request.backupId)
      const receipt = annotationReceiptSchema.parse({
        schemaVersion: 1,
        operation: 'annotate',
        requestId: request.requestId,
        committedAt: annotation.updatedAt,
        annotation
      })
      await publishReceiptEnvelope(roots, {
        format: 'dyson-control-retention-receipt',
        schemaVersion: 1,
        operation: 'annotate',
        requestFingerprint: fingerprint,
        receipt
      })
      return { receipt, reused: false }
    }, context.scope)
  }

  async execute(input: unknown): Promise<{ receipt: RetirementReceipt, reused: boolean }> {
    const request = parseExecuteRequest(input)
    return await this.#runHostMutation('backup-retention-retire', request.requestId,
      async (context) => await this.#executeUnderHostLease(request, context))
  }

  async #executeUnderHostLease(
    request: RetirementExecuteRequest,
    context: BackupRetentionHostMutationContext
  ): Promise<{ receipt: RetirementReceipt, reused: boolean }> {
    const roots = await prepareRetentionRoots(this.#configuredBackupRoot)
    return await withRetentionLock(roots, async () => {
      context.scope.assertActive()
      context.markPossibleWrite()
      await reconcileRetentionOperations(roots, this.#now, undefined, undefined, context.scope)
      context.scope.assertActive()
      context.markDurableTerminal()
      const fingerprint = requestFingerprint('retire', request)
      const existing = await readReceiptEnvelope(roots, 'retire', request.requestId)
      if (existing !== null) {
        if (existing.requestFingerprint !== fingerprint) {
          throw new BackupRetentionError('SAVE_RETENTION_IDEMPOTENCY_CONFLICT')
        }
        return { receipt: existing.receipt, reused: true }
      }

      const snapshot = await this.#snapshotAtRoot(roots.backupRoot, request.referenceTime, request.policy)
      const preview = snapshot.preview
      if (preview.previewDigest !== request.previewDigest) {
        throw new BackupRetentionError('SAVE_RETENTION_PLAN_CHANGED')
      }
      if (preview.excluded.some((entry) => entry.reason === 'redirected-entry')) {
        throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
      }
      const plannedSnapshot = bindPlannedCandidates(preview, snapshot.inventory.verifications)
      // The preview-bound inventory is intentionally not the final deletion
      // authority. A workflow may acquire a protection point after candidate
      // generation, so refresh once at the commit boundary before any backup
      // directory is moved.
      const latestProtectedIds = await this.#loadProtectedIds(roots.backupRoot)
      const planned = plannedSnapshot.filter((candidate) => !latestProtectedIds.has(candidate.backupId))
      const operationDirectory = operationPath(roots, request.requestId)
      let journal: JournalEntry
      if (await pathExists(operationDirectory)) {
        const previous = await readLatestJournal(operationDirectory)
        if (previous === null || previous.state !== 'rolled-back' ||
            previous.requestFingerprint !== fingerprint || previous.previewDigest !== request.previewDigest ||
            JSON.stringify(previous.planned) !== JSON.stringify(planned)) {
          throw new BackupRetentionError('SAVE_RETENTION_IDEMPOTENCY_CONFLICT')
        }
        await assertRolledBackOperationClean(operationDirectory)
        assertJournalBudget(previous, 2 * planned.length + 3)
        journal = nextJournal(previous, {
          state: 'moving',
          movedBackupIds: [],
          restoreRequestId: null,
          restoredBackupIds: [],
          updatedAt: this.#now().toISOString()
        })
        await appendJournal(operationDirectory, journal)
      } else {
        journal = makeInitialJournal(request, fingerprint, planned, this.#now().toISOString())
        assertJournalBudget(journal, 2 * planned.length + 3)
        await createFreshNormalDirectory(operationDirectory)
        await appendJournal(operationDirectory, journal)
      }

      try {
        for (const candidate of planned) {
          await this.#phase('before-retire-move', candidate.backupId)
          const current = await inspectBackupEvidence(roots.backupRoot, candidate.backupId)
          if (!sameCandidate(current, candidate)) {
            throw new BackupRetentionError('SAVE_RETENTION_BACKUP_CHANGED')
          }
          const source = await resolveNormalBackupDirectory(roots.backupRoot, candidate.backupId)
          const destination = safeImmediateChild(operationDirectory, candidate.backupId)
          if (await pathExists(destination)) {
            throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
          }
          context.scope.assertActive()
          context.markPossibleWrite()
          await rename(source, destination)
          context.scope.assertActive()
          journal = nextJournal(journal, {
            state: 'moving',
            movedBackupIds: [...journal.movedBackupIds, candidate.backupId],
            updatedAt: this.#now().toISOString()
          })
          await appendJournal(operationDirectory, journal)
          await this.#phase('after-retire-move', candidate.backupId)
        }
      } catch (error) {
        if (error instanceof HostMutationLeaseError) throw error
        context.scope.assertActive()
        const rolledBack = await rollbackRetirementMoves(
          roots, operationDirectory, journal, this.#now, context.scope
        )
        context.scope.assertActive()
        if (!rolledBack) {
          throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED', { cause: error })
        }
        context.markDurableTerminal()
        throw normalizeRetentionError(error)
      }

      const receipt = retirementReceiptSchema.parse({
        schemaVersion: 1,
        operation: 'retire',
        requestId: request.requestId,
        previewDigest: request.previewDigest,
        committedAt: this.#now().toISOString(),
        retired: planned,
        recoveryRequired: false
      })
      journal = nextJournal(journal, {
        state: 'committed',
        updatedAt: receipt.committedAt,
        retirementReceipt: receipt
      })
      await appendJournal(operationDirectory, journal)
      context.markDurableTerminal()
      await publishReceiptEnvelope(roots, {
        format: 'dyson-control-retention-receipt',
        schemaVersion: 1,
        operation: 'retire',
        requestFingerprint: fingerprint,
        receipt
      })
      return { receipt, reused: false }
    }, context.scope)
  }

  async restore(input: unknown): Promise<{ receipt: RestoreReceipt, reused: boolean }> {
    const request = parseRestoreRequest(input)
    return await this.#runHostMutation('backup-retention-restore', request.requestId,
      async (context) => await this.#restoreUnderHostLease(request, context))
  }

  async #restoreUnderHostLease(
    request: RetirementRestoreRequest,
    context: BackupRetentionHostMutationContext
  ): Promise<{ receipt: RestoreReceipt, reused: boolean }> {
    const roots = await prepareRetentionRoots(this.#configuredBackupRoot)
    return await withRetentionLock(roots, async () => {
      context.scope.assertActive()
      context.markPossibleWrite()
      await reconcileRetentionOperations(roots, this.#now, undefined, undefined, context.scope)
      context.scope.assertActive()
      context.markDurableTerminal()
      const fingerprint = requestFingerprint('restore-retired', request)
      const existing = await readReceiptEnvelope(roots, 'restore-retired', request.requestId)
      if (existing !== null) {
        if (existing.requestFingerprint !== fingerprint) {
          throw new BackupRetentionError('SAVE_RETENTION_IDEMPOTENCY_CONFLICT')
        }
        return { receipt: existing.receipt, reused: true }
      }

      const operationDirectory = operationPath(roots, request.retirementRequestId)
      let journal = await readLatestJournal(operationDirectory)
      if (journal === null) throw new BackupRetentionError('SAVE_RETENTION_OPERATION_NOT_FOUND')
      if (journal.state !== 'committed' || journal.retirementReceipt === null) {
        throw new BackupRetentionError(
          journal.state === 'recovery-required'
            ? 'SAVE_RETENTION_RECOVERY_REQUIRED'
            : 'SAVE_RETENTION_OPERATION_NOT_RESTORABLE'
        )
      }
      assertJournalBudget(journal, 2 * journal.planned.length + 3)
      journal = nextJournal(journal, {
        state: 'restoring',
        restoreRequestId: request.requestId,
        restoredBackupIds: [],
        updatedAt: this.#now().toISOString()
      })
      await appendJournal(operationDirectory, journal)

      try {
        for (const candidate of journal.planned) {
          await this.#phase('before-restore-move', candidate.backupId)
          if (await pathExists(safeImmediateChild(roots.backupRoot, candidate.backupId))) {
            throw new BackupRetentionError('SAVE_RETENTION_BACKUP_CHANGED')
          }
          const retired = await inspectBackupEvidence(operationDirectory, candidate.backupId)
          if (!sameCandidate(retired, candidate)) {
            throw new BackupRetentionError('SAVE_RETENTION_BACKUP_CHANGED')
          }
          const source = await resolveNormalBackupDirectory(operationDirectory, candidate.backupId)
          const destination = safeImmediateChild(roots.backupRoot, candidate.backupId)
          context.scope.assertActive()
          context.markPossibleWrite()
          await rename(source, destination)
          context.scope.assertActive()
          journal = nextJournal(journal, {
            state: 'restoring',
            restoredBackupIds: [...journal.restoredBackupIds, candidate.backupId],
            updatedAt: this.#now().toISOString()
          })
          await appendJournal(operationDirectory, journal)
          await this.#phase('after-restore-move', candidate.backupId)
        }
      } catch (error) {
        if (error instanceof HostMutationLeaseError) throw error
        context.scope.assertActive()
        const rolledBack = await rollbackRestoreMoves(
          roots, operationDirectory, journal, this.#now, context.scope
        )
        context.scope.assertActive()
        if (!rolledBack) {
          throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED', { cause: error })
        }
        context.markDurableTerminal()
        throw normalizeRetentionError(error)
      }

      const receipt = restoreReceiptSchema.parse({
        schemaVersion: 1,
        operation: 'restore-retired',
        requestId: request.requestId,
        retirementRequestId: request.retirementRequestId,
        committedAt: this.#now().toISOString(),
        restoredBackupIds: journal.planned.map((entry) => entry.backupId),
        recoveryRequired: false
      })
      journal = nextJournal(journal, {
        state: 'restored',
        updatedAt: receipt.committedAt,
        restoreReceipt: receipt
      })
      await appendJournal(operationDirectory, journal)
      context.markDurableTerminal()
      await publishReceiptEnvelope(roots, {
        format: 'dyson-control-retention-receipt',
        schemaVersion: 1,
        operation: 'restore-retired',
        requestFingerprint: fingerprint,
        receipt
      })
      return { receipt, reused: false }
    }, context.scope)
  }

  async previewPurge(input: unknown): Promise<BackupRetentionPurgePreview> {
    const request = parsePurgePreviewRequest(input)
    const roots = await resolveExistingRetentionRoots(this.#configuredBackupRoot)
    return await this.#purgePreview(roots, request.retirementRequestId)
  }

  async purge(input: unknown): Promise<{ receipt: PurgeReceipt, reused: boolean }> {
    const request = parsePurgeExecuteRequest(input)
    return await this.#runHostMutation('backup-retention-purge', request.requestId,
      async (context) => await this.#purgeUnderHostLease(request, context))
  }

  async #purgeUnderHostLease(
    request: z.infer<typeof purgeExecuteRequestSchema>,
    context: BackupRetentionHostMutationContext
  ): Promise<{ receipt: PurgeReceipt, reused: boolean }> {
    const roots = await prepareRetentionRoots(this.#configuredBackupRoot)
    return await withRetentionLock(roots, async () => {
      const fingerprint = requestFingerprint('purge-retired', request)
      context.scope.assertActive()
      context.markPossibleWrite()
      await reconcileRetentionOperations(
        roots, this.#now, request.retirementRequestId, fingerprint, context.scope
      )
      context.scope.assertActive()
      context.markDurableTerminal()
      const existing = await readReceiptEnvelope(roots, 'purge-retired', request.requestId)
      if (existing !== null) {
        if (existing.requestFingerprint !== fingerprint) {
          throw new BackupRetentionError('SAVE_RETENTION_IDEMPOTENCY_CONFLICT')
        }
        return { receipt: existing.receipt, reused: true }
      }

      const preview = await this.#purgePreview(roots, request.retirementRequestId)
      if (preview.purgePreviewDigest !== request.purgePreviewDigest) {
        throw new BackupRetentionError('SAVE_RETENTION_PLAN_CHANGED')
      }
      if (!preview.eligible) throw new BackupRetentionError('SAVE_RETENTION_PURGE_TOO_EARLY')
      const operationDirectory = operationPath(roots, request.retirementRequestId)
      let journal = await readLatestJournal(operationDirectory)
      if (journal === null || journal.retirementReceipt === null) {
        throw new BackupRetentionError('SAVE_RETENTION_OPERATION_NOT_FOUND')
      }
      if (journal.state !== 'committed' &&
          (!['purging', 'purge-recovery-required'].includes(journal.state) ||
           journal.purgeRequestId !== request.requestId || journal.purgeRequestFingerprint !== fingerprint)) {
        throw new BackupRetentionError(
          journal.state === 'purged' ? 'SAVE_RETENTION_OPERATION_NOT_RESTORABLE' :
            journal.state === 'recovery-required' ? 'SAVE_RETENTION_RECOVERY_REQUIRED' :
              'SAVE_RETENTION_IDEMPOTENCY_CONFLICT'
        )
      }

      // Validate the entire owned batch and refresh workflow protections before
      // the first irreversible unlink. A failed refresh therefore performs zero
      // removals for this invocation. A newly protected retired backup invalidates
      // the bound purge as a whole; the caller must obtain a fresh preview after
      // the protection is resolved.
      await preflightPurgeBatch(roots, operationDirectory, journal)
      const latestProtectedIds = await this.#loadProtectedIds(roots.backupRoot)
      const alreadyPurgedIds = new Set(journal.purgedBackupIds)
      if (journal.planned.some((candidate) =>
        !alreadyPurgedIds.has(candidate.backupId) && latestProtectedIds.has(candidate.backupId))) {
        throw new BackupRetentionError('SAVE_RETENTION_PLAN_CHANGED')
      }
      const remainingPurgeCount = journal.planned.length - journal.purgedBackupIds.length
      assertJournalBudget(journal, 2 * remainingPurgeCount + 3)

      if (journal.state === 'committed') {
        journal = nextJournal(journal, {
          state: 'purging',
          purgeRequestId: request.requestId,
          purgeRequestFingerprint: fingerprint,
          purgeIntentBackupId: null,
          purgedBackupIds: [],
          updatedAt: this.#now().toISOString()
        })
        await appendJournal(operationDirectory, journal)
      }

      try {
        for (const candidate of journal.planned) {
          if (journal.purgedBackupIds.includes(candidate.backupId)) continue
          if (journal.purgeIntentBackupId !== candidate.backupId) {
            journal = nextJournal(journal, {
              state: 'purging',
              purgeIntentBackupId: candidate.backupId,
              updatedAt: this.#now().toISOString()
            })
            await appendJournal(operationDirectory, journal)
          }
          await this.#phase('before-purge', candidate.backupId)
          context.scope.assertActive()
          context.markPossibleWrite()
          await purgeOwnedRetiredBackup(operationDirectory, candidate, true, context.scope)
          context.scope.assertActive()
          await this.#phase('after-purge', candidate.backupId)
          journal = nextJournal(journal, {
            state: 'purging',
            purgeIntentBackupId: null,
            purgedBackupIds: [...journal.purgedBackupIds, candidate.backupId],
            updatedAt: this.#now().toISOString()
          })
          await appendJournal(operationDirectory, journal)
        }
      } catch (error) {
        if (error instanceof HostMutationLeaseError) throw error
        if (journal.state !== 'purge-recovery-required') {
          journal = nextJournal(journal, {
            state: 'purge-recovery-required',
            updatedAt: this.#now().toISOString()
          })
          await appendJournal(operationDirectory, journal)
        }
        context.markDurableRecoveryBoundary()
        throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED', { cause: error })
      }

      const receipt = purgeReceiptSchema.parse({
        schemaVersion: 1,
        operation: 'purge-retired',
        requestId: request.requestId,
        retirementRequestId: request.retirementRequestId,
        committedAt: this.#now().toISOString(),
        purgedBackupIds: journal.planned.map((candidate) => candidate.backupId),
        bytesFreed: preview.totalBytes,
        recoveryRequired: false
      })
      journal = nextJournal(journal, {
        state: 'purged',
        purgeIntentBackupId: null,
        updatedAt: receipt.committedAt,
        purgeReceipt: receipt
      })
      await appendJournal(operationDirectory, journal)
      context.markDurableTerminal()
      await publishReceiptEnvelope(roots, {
        format: 'dyson-control-retention-receipt',
        schemaVersion: 1,
        operation: 'purge-retired',
        requestFingerprint: fingerprint,
        receipt
      })
      return { receipt, reused: false }
    }, context.scope)
  }

  async #runHostMutation<T>(
    operation: 'backup-retention-annotate' | 'backup-retention-retire' |
      'backup-retention-restore' | 'backup-retention-purge',
    requestId: string,
    action: (context: BackupRetentionHostMutationContext) => Promise<T>
  ): Promise<T> {
    const coordinator = this.#hostMutationCoordinator
    if (coordinator === null) {
      throw new BackupRetentionError('SAVE_RETENTION_HOST_LEASE_UNAVAILABLE')
    }
    try {
      return await coordinator.runExclusive({ operation, requestId }, async (scope) => {
        let possibleWrite = false
        let durableRecoveryBoundary = false
        const context: BackupRetentionHostMutationContext = {
          scope,
          markPossibleWrite: () => {
            possibleWrite = true
            durableRecoveryBoundary = false
          },
          markDurableTerminal: () => {
            possibleWrite = false
            durableRecoveryBoundary = false
          },
          markDurableRecoveryBoundary: () => {
            possibleWrite = false
            durableRecoveryBoundary = true
          },
          hasPossibleWrite: () => possibleWrite,
          canReleaseRecovery: () => durableRecoveryBoundary
        }
        try {
          scope.assertActive()
          const result = await action(context)
          scope.assertActive()
          if (context.hasPossibleWrite()) {
            return hostMutationThrow<T>(
              new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED'),
              'abandon'
            )
          }
          return hostMutationReturn(result, 'release')
        } catch (error) {
          if (error instanceof HostMutationLeaseError ||
              error instanceof HostMutationOperationCoordinatorError) throw error
          if (error instanceof BackupRetentionError) {
            return hostMutationThrow<T>(
              error,
              context.hasPossibleWrite() ||
                (error.code === 'SAVE_RETENTION_RECOVERY_REQUIRED' && !context.canReleaseRecovery())
                ? 'abandon'
                : 'release'
            )
          }
          return hostMutationThrow<T>(
            new BackupRetentionError('SAVE_RETENTION_FAILED', { cause: error }),
            context.hasPossibleWrite() ? 'abandon' : 'release'
          )
        }
      })
    } catch (error) {
      if (error instanceof BackupRetentionError) throw error
      if (error instanceof HostMutationOperationCoordinatorError) {
        throw new BackupRetentionError(mapHostMutationCoordinatorError(error.code), { cause: error })
      }
      if (error instanceof HostMutationLeaseError) {
        throw new BackupRetentionError('SAVE_RETENTION_HOST_LEASE_LOST', { cause: error })
      }
      throw new BackupRetentionError('SAVE_RETENTION_HOST_LEASE_UNAVAILABLE', { cause: error })
    }
  }

  async #purgePreview(
    roots: PreparedRetentionRoots,
    retirementRequestId: string
  ): Promise<BackupRetentionPurgePreview> {
    const journal = await readLatestJournal(operationPath(roots, retirementRequestId))
    if (journal === null || journal.retirementReceipt === null) {
      throw new BackupRetentionError('SAVE_RETENTION_OPERATION_NOT_FOUND')
    }
    if (!['committed', 'purging', 'purge-recovery-required'].includes(journal.state)) {
      throw new BackupRetentionError(
        journal.state === 'recovery-required'
          ? 'SAVE_RETENTION_RECOVERY_REQUIRED'
          : 'SAVE_RETENTION_OPERATION_NOT_RESTORABLE'
      )
    }
    const receiptDigest = sha256(JSON.stringify(journal.retirementReceipt))
    const eligibleAt = new Date(
      Date.parse(journal.retirementReceipt.committedAt) + this.#minimumPurgeAgeMs
    ).toISOString()
    const retiredBackupIds = journal.planned.map((candidate) => candidate.backupId)
    const totalBytes = sumBoundedBytes(journal.planned)
    const digestInput = {
      schemaVersion: 1,
      retirementRequestId,
      eligibleAt,
      retiredBackupIds,
      totalBytes,
      retirementReceiptDigest: receiptDigest
    }
    return {
      schemaVersion: 1,
      mode: 'dry-run',
      retirementRequestId,
      eligibleAt,
      eligible: this.#now().getTime() >= Date.parse(eligibleAt),
      retiredBackupIds,
      totalBytes,
      retirementReceiptDigest: receiptDigest,
      purgePreviewDigest: sha256(JSON.stringify(digestInput))
    }
  }

  async #snapshotAtRoot(
    backupRoot: string,
    referenceTime: string,
    policy: RetentionPolicy
  ): Promise<{ preview: BackupRetentionPreview, inventory: InventoryResult }> {
    const inventory = await this.#inventory(backupRoot)
    const plan = planBackupRetention({ referenceTime, policy, candidates: inventory.candidates })
    const selectedBackupIds = plan.delete
      .slice(-MAX_RETIREMENT_EXECUTION_BATCH)
      .map((entry) => entry.backupId)
    const executionBatch = {
      maximumCandidates: MAX_RETIREMENT_EXECUTION_BATCH,
      selectedBackupIds,
      deferredCandidateCount: plan.delete.length - selectedBackupIds.length
    }
    const excluded = [...inventory.excluded].sort((left, right) => left.backupId.localeCompare(right.backupId))
    const evidence = inventory.candidates
      .map((candidate) => {
        const inspected = inventory.verifications.get(candidate.backupId)
        if (inspected === undefined) throw new BackupRetentionError('SAVE_RETENTION_STORAGE_UNAVAILABLE')
        return {
          ...candidate,
          totalBytes: inspected.verification.totalBytes,
          evidenceDigest: inspected.evidenceDigest
        }
      })
      .sort((left, right) => left.backupId.localeCompare(right.backupId))
    const inventoryDigest = sha256(JSON.stringify({ evidence, excluded }))
    const digestInput = {
      schemaVersion: 1,
      referenceTime,
      policy,
      plan,
      executionBatch,
      excluded,
      inventoryDigest
    }
    const preview: BackupRetentionPreview = {
      schemaVersion: 1,
      mode: 'dry-run',
      referenceTime,
      policy,
      plan,
      executionBatch,
      excluded,
      inventoryDigest,
      previewDigest: sha256(JSON.stringify(digestInput))
    }
    return { preview, inventory }
  }

  async #inventory(backupRoot: string): Promise<InventoryResult> {
    const protectedIds = await this.#loadProtectedIds(backupRoot)
    const entries = await readBoundedDirectory(backupRoot, this.#maximumDirectoryEntries)
    const candidates: InventoryResult['candidates'] = []
    const verifications = new Map<string, InventoryEvidence>()
    const excluded: InventoryResult['excluded'] = []
    const identities = new Set<string>()
    for (const entry of entries) {
      const parsedId = backupIdSchema.safeParse(entry.name)
      if (!parsedId.success) continue
      if (identities.has(parsedId.data)) {
        throw new BackupRetentionError('SAVE_RETENTION_STORAGE_UNAVAILABLE')
      }
      identities.add(parsedId.data)
      if (entry.kind === 'redirected') {
        excluded.push({ backupId: parsedId.data, reason: 'redirected-entry' })
        continue
      }
      if (entry.kind !== 'directory') continue
      let inspected: InventoryEvidence
      try {
        inspected = await inspectBackupEvidence(backupRoot, parsedId.data)
      } catch (error) {
        throw new BackupRetentionError('SAVE_RETENTION_STORAGE_UNAVAILABLE', { cause: error })
      }
      const verification = inspected.verification
      verifications.set(parsedId.data, inspected)
      if (verification.createdAt === null) {
        excluded.push({ backupId: parsedId.data, reason: 'created-at-unavailable' })
        continue
      }
      candidates.push({
        backupId: parsedId.data,
        createdAt: verification.createdAt,
        health: verification.health,
        protected: protectedIds.has(parsedId.data)
      })
    }
    return { candidates, verifications, excluded }
  }

  async #loadProtectedIds(backupRoot: string): Promise<ReadonlySet<string>> {
    try {
      const [externalIds, annotationState] = await Promise.all([
        this.#protectionSource.listProtectedBackupIds(),
        readAnnotationStateIfPresent(backupRoot)
      ])
      if (externalIds === null || externalIds === undefined ||
          typeof externalIds[Symbol.iterator] !== 'function') {
        throw new Error('invalid protection set')
      }
      const protectedIds = new Set<string>()
      for (const externalId of externalIds) protectedIds.add(backupIdSchema.parse(externalId))
      for (const annotation of annotationState.values()) {
        if (annotation.protected) protectedIds.add(annotation.backupId)
      }
      return protectedIds
    } catch (error) {
      throw new BackupRetentionError('SAVE_RETENTION_STORAGE_UNAVAILABLE', { cause: error })
    }
  }
}

function parsePreviewRequest(input: unknown): z.infer<typeof retirementPreviewRequestSchema> {
  try {
    return retirementPreviewRequestSchema.parse(input)
  } catch {
    throw new BackupRetentionError('SAVE_RETENTION_REQUEST_INVALID')
  }
}

function parseExecuteRequest(input: unknown): RetirementExecuteRequest {
  try {
    return retirementExecuteRequestSchema.parse(input)
  } catch {
    throw new BackupRetentionError('SAVE_RETENTION_REQUEST_INVALID')
  }
}

function parseRestoreRequest(input: unknown): RetirementRestoreRequest {
  try {
    return retirementRestoreRequestSchema.parse(input)
  } catch {
    throw new BackupRetentionError('SAVE_RETENTION_REQUEST_INVALID')
  }
}

function parseAnnotationRequest(input: unknown): z.infer<typeof backupAnnotationRequestSchema> {
  try {
    return backupAnnotationRequestSchema.parse(input)
  } catch {
    throw new BackupRetentionError('SAVE_RETENTION_REQUEST_INVALID')
  }
}

function parsePurgePreviewRequest(input: unknown): z.infer<typeof purgePreviewRequestSchema> {
  try {
    return purgePreviewRequestSchema.parse(input)
  } catch {
    throw new BackupRetentionError('SAVE_RETENTION_REQUEST_INVALID')
  }
}

function parsePurgeExecuteRequest(input: unknown): z.infer<typeof purgeExecuteRequestSchema> {
  try {
    return purgeExecuteRequestSchema.parse(input)
  } catch {
    throw new BackupRetentionError('SAVE_RETENTION_REQUEST_INVALID')
  }
}

function parseRecoveryRequest(input: unknown): RetentionRecoveryRequest {
  try {
    return retentionRecoveryRequestSchema.parse(input)
  } catch {
    throw new BackupRetentionError('SAVE_RETENTION_REQUEST_INVALID')
  }
}

function retentionHostOperation(operation: RetentionRecoveryRequest['operation']): string {
  if (operation === 'annotate') return 'backup-retention-annotate'
  if (operation === 'retire') return 'backup-retention-retire'
  if (operation === 'restore') return 'backup-retention-restore'
  return 'backup-retention-purge'
}

function recoveryResult(
  request: RetentionRecoveryRequest,
  outcome: BackupRetentionRecoveryResult['outcome']
): BackupRetentionRecoveryResult {
  return {
    operation: request.operation,
    requestId: request.requestId,
    retirementRequestId: request.operation === 'restore' || request.operation === 'purge'
      ? request.retirementRequestId
      : null,
    outcome
  }
}

function bindPlannedCandidates(
  preview: BackupRetentionPreview,
  verifications: ReadonlyMap<string, InventoryEvidence>
): RetirementReceipt['retired'] {
  const decisions = new Map(preview.plan.delete.map((decision) => [decision.backupId, decision]))
  if (preview.executionBatch.maximumCandidates !== MAX_RETIREMENT_EXECUTION_BATCH ||
      preview.executionBatch.deferredCandidateCount !==
        preview.plan.delete.length - preview.executionBatch.selectedBackupIds.length ||
      preview.executionBatch.selectedBackupIds.length > MAX_RETIREMENT_EXECUTION_BATCH ||
      new Set(preview.executionBatch.selectedBackupIds).size !== preview.executionBatch.selectedBackupIds.length) {
    throw new BackupRetentionError('SAVE_RETENTION_PLAN_CHANGED')
  }
  return preview.executionBatch.selectedBackupIds.map((backupId) => {
    const decision = decisions.get(backupId)
    if (decision === undefined) throw new BackupRetentionError('SAVE_RETENTION_PLAN_CHANGED')
    const inspected = verifications.get(decision.backupId)
    if (inspected === undefined || inspected.verification.createdAt === null ||
        inspected.verification.saveName === null) {
      throw new BackupRetentionError('SAVE_RETENTION_BACKUP_CHANGED')
    }
    const verification = inspected.verification
    return retirementCandidateReceiptSchema.parse({
      backupId: verification.backupId,
      saveName: verification.saveName,
      createdAt: verification.createdAt,
      health: verification.health,
      totalBytes: verification.totalBytes,
      evidenceDigest: inspected.evidenceDigest
    })
  })
}

function sameCandidate(
  inspected: InventoryEvidence,
  candidate: RetirementReceipt['retired'][number]
): boolean {
  const verification = inspected.verification
  return verification.backupId === candidate.backupId &&
    verification.saveName === candidate.saveName &&
    verification.createdAt === candidate.createdAt &&
    verification.health === candidate.health &&
    verification.totalBytes === candidate.totalBytes &&
    inspected.evidenceDigest === candidate.evidenceDigest
}

async function inspectBackupEvidence(backupRoot: string, backupId: string): Promise<InventoryEvidence> {
  const verification = await verifyBackupPair({ backupRoot, backupId })
  const directory = await resolveNormalBackupDirectory(backupRoot, backupId)
  const manifestPath = safeImmediateChild(directory, 'manifest.json')
  let evidenceDigest: string
  try {
    const metadata = await lstat(manifestPath)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 ||
        metadata.size > MAX_MANIFEST_BYTES || !samePath(await realpath(manifestPath), manifestPath)) {
      throw new Error('manifest is not trustworthy')
    }
    evidenceDigest = sha256(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    if (verification.createdAt === null) {
      evidenceDigest = sha256(JSON.stringify({
        backupId: verification.backupId,
        health: verification.health,
        issues: verification.issues,
        manifestPresent: verification.manifestPresent,
        manifestValid: verification.manifestValid,
        pairPresent: verification.pairPresent,
        totalBytes: verification.totalBytes
      }))
    } else {
      throw error
    }
  }
  return { verification, evidenceDigest }
}

interface AnnotationLedger {
  state: Map<string, BackupAnnotation>
  byRequestId: Map<string, z.infer<typeof annotationEventSchema>>
}

async function readAnnotationStateIfPresent(backupRoot: string): Promise<Map<string, BackupAnnotation>> {
  const controlRoot = safeImmediateChild(backupRoot, CONTROL_DIRECTORY)
  if (!await pathExists(controlRoot)) return new Map()
  let resolvedControl: string
  try {
    resolvedControl = await resolveNormalDirectory(controlRoot)
  } catch (error) {
    throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED', { cause: error })
  }
  const annotationRoot = safeImmediateChild(resolvedControl, ANNOTATION_DIRECTORY)
  if (!await pathExists(annotationRoot)) return new Map()
  let resolvedAnnotations: string
  try {
    resolvedAnnotations = await resolveNormalDirectory(annotationRoot)
  } catch (error) {
    throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED', { cause: error })
  }
  return (await readAnnotationLedger(resolvedAnnotations)).state
}

async function readAnnotationLedger(annotationRoot: string): Promise<AnnotationLedger> {
  const root = await resolveNormalDirectory(annotationRoot).catch((error: unknown) => {
    throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED', { cause: error })
  })
  const entries = await readBoundedDirectory(root, MAX_JOURNAL_ENTRIES)
  const events: Array<z.infer<typeof annotationEventSchema>> = []
  for (const entry of entries) {
    if (entry.kind === 'file' && /^\.partial-[0-9a-f-]{36}$/.test(entry.name)) continue
    if (entry.kind !== 'file' || !entry.name.startsWith('annotation-') || !entry.name.endsWith('.json')) {
      throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
    }
    const filePath = safeImmediateChild(root, entry.name)
    try {
      const metadata = await lstat(filePath)
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > 8_192 ||
          !samePath(await realpath(filePath), filePath)) throw new Error('invalid annotation event')
      const event = annotationEventSchema.parse(JSON.parse(await readFile(filePath, 'utf8')) as unknown)
      if (entry.name !== annotationEventFilename(event)) throw new Error('annotation identity mismatch')
      events.push(event)
    } catch (error) {
      throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED', { cause: error })
    }
  }
  events.sort((left, right) => {
    const backup = left.annotation.backupId.localeCompare(right.annotation.backupId)
    if (backup !== 0) return backup
    return left.annotation.revision - right.annotation.revision
  })
  const state = new Map<string, BackupAnnotation>()
  const byRequestId = new Map<string, z.infer<typeof annotationEventSchema>>()
  for (const event of events) {
    if (byRequestId.has(event.requestId)) {
      throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
    }
    const previous = state.get(event.annotation.backupId)
    if (event.annotation.revision !== (previous?.revision ?? 0) + 1) {
      throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
    }
    state.set(event.annotation.backupId, event.annotation)
    byRequestId.set(event.requestId, event)
  }
  return { state, byRequestId }
}

function annotationEventPath(
  annotationRoot: string,
  event: z.infer<typeof annotationEventSchema>
): string {
  return safeImmediateChild(annotationRoot, annotationEventFilename(event))
}

function annotationEventFilename(event: z.infer<typeof annotationEventSchema>): string {
  return `annotation-${event.annotation.backupId}-r${event.annotation.revision
    .toString().padStart(12, '0')}-${event.requestId}.json`
}

async function resolveRetentionBackupRoot(configuredRoot: string): Promise<string> {
  try {
    return await resolveNormalDirectory(configuredRoot)
  } catch (error) {
    throw new BackupRetentionError('SAVE_RETENTION_STORAGE_UNAVAILABLE', { cause: error })
  }
}

async function prepareRetentionRoots(configuredRoot: string): Promise<PreparedRetentionRoots> {
  const backupRoot = await resolveRetentionBackupRoot(configuredRoot)
  try {
    const controlRoot = await ensureNormalChildDirectory(backupRoot, CONTROL_DIRECTORY)
    const retiredRoot = await ensureNormalChildDirectory(controlRoot, RETIRED_DIRECTORY)
    const receiptRoot = await ensureNormalChildDirectory(controlRoot, RECEIPT_DIRECTORY)
    const annotationRoot = await ensureNormalChildDirectory(controlRoot, ANNOTATION_DIRECTORY)
    return {
      backupRoot,
      controlRoot,
      retiredRoot,
      receiptRoot,
      annotationRoot,
      lockPath: safeImmediateChild(controlRoot, LOCK_FILE)
    }
  } catch (error) {
    throw new BackupRetentionError('SAVE_RETENTION_STORAGE_UNAVAILABLE', { cause: error })
  }
}

async function resolveExistingRetentionRoots(configuredRoot: string): Promise<PreparedRetentionRoots> {
  const backupRoot = await resolveRetentionBackupRoot(configuredRoot)
  try {
    const controlRoot = await resolveNormalDirectory(safeImmediateChild(backupRoot, CONTROL_DIRECTORY))
    return {
      backupRoot,
      controlRoot,
      retiredRoot: await resolveNormalDirectory(safeImmediateChild(controlRoot, RETIRED_DIRECTORY)),
      receiptRoot: await resolveNormalDirectory(safeImmediateChild(controlRoot, RECEIPT_DIRECTORY)),
      annotationRoot: await resolveNormalDirectory(safeImmediateChild(controlRoot, ANNOTATION_DIRECTORY)),
      lockPath: safeImmediateChild(controlRoot, LOCK_FILE)
    }
  } catch (error) {
    throw new BackupRetentionError('SAVE_RETENTION_OPERATION_NOT_FOUND', { cause: error })
  }
}

async function ensureNormalChildDirectory(parent: string, name: string): Promise<string> {
  const child = safeImmediateChild(parent, name)
  try {
    await mkdir(child, { mode: 0o700 })
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error
  }
  return await resolveNormalDirectory(child)
}

async function createFreshNormalDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { mode: 0o700 })
  } catch (error) {
    if (isNodeError(error, 'EEXIST')) {
      throw new BackupRetentionError('SAVE_RETENTION_IDEMPOTENCY_CONFLICT')
    }
    throw new BackupRetentionError('SAVE_RETENTION_STORAGE_UNAVAILABLE', { cause: error })
  }
  await resolveNormalDirectory(directory)
}

async function assertRolledBackOperationClean(operationDirectory: string): Promise<void> {
  const entries = await readBoundedDirectory(operationDirectory, MAX_JOURNAL_ENTRIES)
  for (const entry of entries) {
    if (entry.kind === 'file' && /^journal-[0-9]{6}\.json$/.test(entry.name)) continue
    if (entry.kind === 'file' && /^\.partial-[0-9a-f-]{36}$/.test(entry.name)) {
      await unlink(safeImmediateChild(operationDirectory, entry.name)).catch(() => undefined)
      continue
    }
    throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
  }
}

function operationPath(roots: PreparedRetentionRoots, retirementRequestId: string): string {
  const parsed = requestIdSchema.parse(retirementRequestId)
  return safeImmediateChild(roots.retiredRoot, `${OPERATION_PREFIX}${parsed}`)
}

function makeInitialJournal(
  request: RetirementExecuteRequest,
  fingerprint: string,
  planned: RetirementReceipt['retired'],
  updatedAt: string
): JournalEntry {
  return journalEntrySchema.parse({
    format: 'dyson-control-retention-journal',
    schemaVersion: 1,
    sequence: 1,
    retirementRequestId: request.requestId,
    requestFingerprint: fingerprint,
    previewDigest: request.previewDigest,
    state: 'moving',
    planned,
    movedBackupIds: [],
    restoreRequestId: null,
    restoredBackupIds: [],
    purgeRequestId: null,
    purgeRequestFingerprint: null,
    purgeIntentBackupId: null,
    purgedBackupIds: [],
    updatedAt,
    retirementReceipt: null,
    restoreReceipt: null,
    purgeReceipt: null
  })
}

function nextJournal(current: JournalEntry, change: Partial<JournalEntry>): JournalEntry {
  return journalEntrySchema.parse({
    ...current,
    ...change,
    sequence: current.sequence + 1
  })
}

function assertJournalBudget(current: JournalEntry, additionalEntries: number): void {
  if (!Number.isSafeInteger(additionalEntries) || additionalEntries < 0 ||
      current.sequence + additionalEntries + current.planned.length > MAX_JOURNAL_ENTRIES) {
    throw new BackupRetentionError('SAVE_RETENTION_BATCH_LIMIT_EXCEEDED')
  }
  const allBackupIds = current.planned.map((candidate) => candidate.backupId)
  const pessimistic = {
    ...current,
    sequence: current.sequence + additionalEntries,
    movedBackupIds: allBackupIds,
    restoredBackupIds: allBackupIds,
    purgedBackupIds: allBackupIds,
    retirementReceipt: current.retirementReceipt ?? {
      schemaVersion: 1,
      operation: 'retire',
      requestId: current.retirementRequestId,
      previewDigest: current.previewDigest,
      committedAt: current.updatedAt,
      retired: current.planned,
      recoveryRequired: false
    },
    restoreReceipt: current.restoreReceipt ?? {
      schemaVersion: 1,
      operation: 'restore-retired',
      requestId: current.retirementRequestId,
      retirementRequestId: current.retirementRequestId,
      committedAt: current.updatedAt,
      restoredBackupIds: allBackupIds,
      recoveryRequired: false
    },
    purgeReceipt: current.purgeReceipt ?? {
      schemaVersion: 1,
      operation: 'purge-retired',
      requestId: current.retirementRequestId,
      retirementRequestId: current.retirementRequestId,
      committedAt: current.updatedAt,
      purgedBackupIds: allBackupIds,
      bytesFreed: sumBoundedBytes(current.planned),
      recoveryRequired: false
    }
  }
  if (Buffer.byteLength(JSON.stringify(pessimistic), 'utf8') > MAX_JOURNAL_BYTES) {
    throw new BackupRetentionError('SAVE_RETENTION_BATCH_LIMIT_EXCEEDED')
  }
}

async function appendJournal(operationDirectory: string, journal: JournalEntry): Promise<void> {
  const parsed = journalEntrySchema.parse(journal)
  if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') > MAX_JOURNAL_BYTES) {
    throw new BackupRetentionError('SAVE_RETENTION_BATCH_LIMIT_EXCEEDED')
  }
  const filename = `${JOURNAL_PREFIX}${journal.sequence.toString().padStart(6, '0')}.json`
  await publishImmutableJson(
    safeImmediateChild(operationDirectory, filename),
    parsed
  )
}

async function readJournalHistory(operationDirectory: string): Promise<JournalEntry[]> {
  if (!await pathExists(operationDirectory)) return []
  let resolved: string
  try {
    resolved = await resolveNormalDirectory(operationDirectory)
  } catch (error) {
    throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED', { cause: error })
  }
  const entries = await readBoundedDirectory(resolved, MAX_JOURNAL_ENTRIES)
  const names = entries
    .filter((entry) => entry.kind === 'file' && /^journal-[0-9]{6}\.json$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
  if (names.length === 0) return []
  try {
    const operationName = path.basename(operationDirectory)
    if (!operationName.startsWith(OPERATION_PREFIX)) throw new Error('invalid operation directory')
    const expectedRequestId = requestIdSchema.parse(operationName.slice(OPERATION_PREFIX.length))
    const history: JournalEntry[] = []
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index]!
      const filePath = safeImmediateChild(resolved, name)
      const metadata = await lstat(filePath)
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > MAX_JOURNAL_BYTES ||
        !samePath(await realpath(filePath), filePath)) {
        throw new Error('invalid journal')
      }
      const parsed = journalEntrySchema.parse(JSON.parse(await readFile(filePath, 'utf8')) as unknown)
      if (name !== `${JOURNAL_PREFIX}${parsed.sequence.toString().padStart(6, '0')}.json` ||
          parsed.sequence !== index + 1 || parsed.retirementRequestId !== expectedRequestId) {
        throw new Error('journal identity mismatch')
      }
      assertJournalSemantics(parsed)
      const previous = history.at(-1)
      if (previous !== undefined) assertJournalTransition(previous, parsed)
      history.push(parsed)
    }
    return history
  } catch (error) {
    throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED', { cause: error })
  }
}

async function readLatestJournal(operationDirectory: string): Promise<JournalEntry | null> {
  const history = await readJournalHistory(operationDirectory)
  return history.at(-1) ?? null
}

async function assertRetentionRecoveryEvidence(
  configuredBackupRoot: string,
  request: RetentionRecoveryRequest
): Promise<void> {
  const roots = await resolveExistingRetentionRoots(configuredBackupRoot)
  if (request.operation === 'annotate') {
    const ledger = await readAnnotationLedger(roots.annotationRoot)
    const event = ledger.byRequestId.get(request.requestId)
    if (event !== undefined) {
      const existing = await readReceiptEnvelope(roots, 'annotate', request.requestId)
      if (existing !== null && (existing.requestFingerprint !== event.requestFingerprint ||
          JSON.stringify(existing.receipt.annotation) !== JSON.stringify(event.annotation))) {
        throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
      }
    }
    return
  }
  const retirementRequestId = request.operation === 'retire'
    ? request.requestId
    : request.retirementRequestId
  const operationDirectory = operationPath(roots, retirementRequestId)
  const history = await readJournalHistory(operationDirectory)
  if (history.length === 0) {
    if (request.operation !== 'retire') {
      throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
    }
    await assertUnpublishedRetirementOperation(operationDirectory)
    return
  }
  assertRecoveryRequestMatchesJournal(history, request)
}

async function readTerminalRetentionRecoveryReplay(
  configuredBackupRoot: string,
  request: RetentionRecoveryRequest
): Promise<BackupRetentionRecoveryResult | null> {
  await assertRetentionRecoveryEvidence(configuredBackupRoot, request)
  const roots = await resolveExistingRetentionRoots(configuredBackupRoot)
  if (request.operation === 'annotate') {
    const ledger = await readAnnotationLedger(roots.annotationRoot)
    const event = ledger.byRequestId.get(request.requestId)
    if (event === undefined) return null
    const receipt = await readReceiptEnvelope(roots, 'annotate', request.requestId)
    return receipt !== null && receipt.requestFingerprint === event.requestFingerprint
      ? recoveryResult(request, 'already-terminal')
      : null
  }
  const operationDirectory = operationPath(roots, request.operation === 'retire'
    ? request.requestId
    : request.retirementRequestId)
  const history = await readJournalHistory(operationDirectory)
  const journal = history.at(-1)
  if (journal === undefined) return null
  assertRecoveryRequestMatchesJournal(history, request)
  if (request.operation === 'retire') {
    if (journal.state === 'rolled-back') {
      await assertTerminalJournalLayout(roots, operationDirectory, journal)
      return recoveryResult(request, 'already-terminal')
    }
    if (journal.state !== 'committed' || journal.retirementReceipt === null) return null
    await assertTerminalJournalLayout(roots, operationDirectory, journal)
    const receipt = await readReceiptEnvelope(roots, 'retire', request.requestId)
    return receipt !== null && receipt.requestFingerprint === journal.requestFingerprint &&
      JSON.stringify(receipt.receipt) === JSON.stringify(journal.retirementReceipt)
      ? recoveryResult(request, 'already-terminal')
      : null
  }
  if (request.operation === 'restore') {
    if (journal.state === 'committed' && history.at(-2)?.state === 'restore-rolling-back') {
      await assertTerminalJournalLayout(roots, operationDirectory, journal)
      return recoveryResult(request, 'already-terminal')
    }
    if (journal.state !== 'restored' || journal.restoreReceipt === null) return null
    await assertTerminalJournalLayout(roots, operationDirectory, journal)
    const receipt = await readReceiptEnvelope(roots, 'restore-retired', request.requestId)
    const expectedFingerprint = requestFingerprint('restore-retired', {
      requestId: request.requestId,
      retirementRequestId: request.retirementRequestId,
      confirmation: 'RESTORE_RETIRED_BACKUPS'
    })
    return receipt !== null && receipt.requestFingerprint === expectedFingerprint &&
      JSON.stringify(receipt.receipt) === JSON.stringify(journal.restoreReceipt)
      ? recoveryResult(request, 'already-terminal')
      : null
  }
  if (journal.state === 'purge-recovery-required') {
    await assertTerminalJournalLayout(roots, operationDirectory, journal)
    return recoveryResult(request, 'resume-required')
  }
  if (journal.state !== 'purged' || journal.purgeReceipt === null) return null
  await assertTerminalJournalLayout(roots, operationDirectory, journal)
  const receipt = await readReceiptEnvelope(roots, 'purge-retired', request.requestId)
  return receipt !== null && receipt.requestFingerprint === journal.purgeRequestFingerprint &&
    JSON.stringify(receipt.receipt) === JSON.stringify(journal.purgeReceipt)
    ? recoveryResult(request, 'already-terminal')
    : null
}

function assertRecoveryRequestMatchesJournal(
  history: readonly JournalEntry[],
  request: Exclude<RetentionRecoveryRequest, { operation: 'annotate' }>
): void {
  const journal = history.at(-1)
  if (journal === undefined) throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
  if (request.operation === 'retire') {
    const retireState = journal.state === 'moving' || journal.state === 'rolling-back' ||
      journal.state === 'rolled-back' ||
      (journal.state === 'recovery-required' && journal.retirementReceipt === null) ||
      (journal.state === 'committed' && history.at(-2)?.state === 'moving')
    if (!retireState || journal.retirementRequestId !== request.requestId) {
      throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
    }
    return
  }
  if (journal.retirementRequestId !== request.retirementRequestId) {
    throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
  }
  if (request.operation === 'restore') {
    if (journal.state === 'committed') {
      const previous = history.at(-2)
      if (previous?.state === 'restore-rolling-back' && previous.restoreRequestId !== request.requestId) {
        throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
      }
      // A committed retirement with no restore journal is the proven
      // before-first-write baseline. The recovery broker supplies the exact
      // original restore request binding.
      return
    }
    if (!['restoring', 'restore-rolling-back', 'restored', 'recovery-required'].includes(journal.state) ||
        journal.restoreRequestId !== request.requestId) {
      throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
    }
    return
  }
  if (journal.state === 'committed') return
  if (!['purging', 'purge-recovery-required', 'purged'].includes(journal.state) ||
      journal.purgeRequestId !== request.requestId || journal.purgeRequestFingerprint === null) {
    throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
  }
}

async function assertUnpublishedRetirementOperation(operationDirectory: string): Promise<void> {
  if (!await pathExists(operationDirectory)) return
  const resolved = await resolveNormalDirectory(operationDirectory).catch((error: unknown) => {
    throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED', { cause: error })
  })
  const entries = await readBoundedDirectory(resolved, MAX_JOURNAL_ENTRIES)
  if (entries.some((entry) => entry.kind !== 'file' || !/^\.partial-[0-9a-f-]{36}$/.test(entry.name))) {
    throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
  }
}

async function cleanUnpublishedRetirementOperation(
  operationDirectory: string,
  scope: HostMutationOperationScope
): Promise<void> {
  await assertUnpublishedRetirementOperation(operationDirectory)
  if (!await pathExists(operationDirectory)) return
  const entries = await readBoundedDirectory(operationDirectory, MAX_JOURNAL_ENTRIES)
  for (const entry of entries) {
    scope.assertActive()
    await unlink(safeImmediateChild(operationDirectory, entry.name))
    scope.assertActive()
  }
  scope.assertActive()
  await rmdir(operationDirectory)
  scope.assertActive()
}

function assertJournalSemantics(journal: JournalEntry): void {
  const plannedIds = journal.planned.map((candidate) => candidate.backupId)
  if (journal.planned.length > MAX_RETIREMENT_EXECUTION_BATCH ||
      new Set(plannedIds).size !== plannedIds.length ||
      !isExactPrefix(journal.movedBackupIds, plannedIds) ||
      !isExactPrefix(journal.restoredBackupIds, plannedIds) ||
      !isExactPrefix(journal.purgedBackupIds, plannedIds)) {
    throw new Error('journal candidate identity is invalid')
  }
  if (journal.retirementReceipt !== null && (
    journal.retirementReceipt.requestId !== journal.retirementRequestId ||
    journal.retirementReceipt.previewDigest !== journal.previewDigest ||
    JSON.stringify(journal.retirementReceipt.retired) !== JSON.stringify(journal.planned)
  )) {
    throw new Error('retirement receipt does not bind the journal')
  }
  if (journal.restoreReceipt !== null && (
    journal.restoreRequestId === null ||
    journal.restoreReceipt.requestId !== journal.restoreRequestId ||
    journal.restoreReceipt.retirementRequestId !== journal.retirementRequestId ||
    JSON.stringify(journal.restoreReceipt.restoredBackupIds) !== JSON.stringify(plannedIds)
  )) {
    throw new Error('restore receipt does not bind the journal')
  }
  if (journal.purgeReceipt !== null && (
    journal.purgeRequestId === null || journal.purgeRequestFingerprint === null ||
    journal.purgeReceipt.requestId !== journal.purgeRequestId ||
    journal.purgeReceipt.retirementRequestId !== journal.retirementRequestId ||
    JSON.stringify(journal.purgeReceipt.purgedBackupIds) !== JSON.stringify(plannedIds) ||
    journal.purgeReceipt.bytesFreed !== sumBoundedBytes(journal.planned)
  )) {
    throw new Error('purge receipt does not bind the journal')
  }
  const nextPurgeId = plannedIds[journal.purgedBackupIds.length]
  if (journal.purgeIntentBackupId !== null && journal.purgeIntentBackupId !== nextPurgeId) {
    throw new Error('purge intent is not the next planned candidate')
  }

  const noRestore = journal.restoreRequestId === null && journal.restoredBackupIds.length === 0 &&
    journal.restoreReceipt === null
  const noPurge = journal.purgeRequestId === null && journal.purgeRequestFingerprint === null &&
    journal.purgeIntentBackupId === null && journal.purgedBackupIds.length === 0 && journal.purgeReceipt === null
  const retirementCommitted = journal.retirementReceipt !== null &&
    journal.movedBackupIds.length === plannedIds.length
  switch (journal.state) {
    case 'moving':
    case 'rolling-back':
      if (journal.retirementReceipt !== null || !noRestore || !noPurge) throw new Error('invalid move state')
      break
    case 'rolled-back':
      if (journal.retirementReceipt !== null || journal.movedBackupIds.length !== 0 || !noRestore || !noPurge) {
        throw new Error('invalid rolled-back state')
      }
      break
    case 'committed':
      if (!retirementCommitted || !noRestore || !noPurge) throw new Error('invalid committed state')
      break
    case 'restoring':
    case 'restore-rolling-back':
      if (!retirementCommitted || journal.restoreRequestId === null || journal.restoreReceipt !== null || !noPurge) {
        throw new Error('invalid restore state')
      }
      break
    case 'restored':
      if (!retirementCommitted || journal.restoreRequestId === null || journal.restoreReceipt === null ||
          journal.restoredBackupIds.length !== plannedIds.length || !noPurge) {
        throw new Error('invalid restored state')
      }
      break
    case 'purging':
    case 'purge-recovery-required':
      if (!retirementCommitted || !noRestore || journal.purgeRequestId === null ||
          journal.purgeRequestFingerprint === null || journal.purgeReceipt !== null) {
        throw new Error('invalid purge state')
      }
      break
    case 'purged':
      if (!retirementCommitted || !noRestore || journal.purgeRequestId === null ||
          journal.purgeRequestFingerprint === null || journal.purgeIntentBackupId !== null ||
          journal.purgeReceipt === null || journal.purgedBackupIds.length !== plannedIds.length) {
        throw new Error('invalid purged state')
      }
      break
    case 'recovery-required':
      if (!noPurge) throw new Error('purge recovery uses its dedicated state')
      break
  }
}

function assertJournalTransition(previous: JournalEntry, current: JournalEntry): void {
  if (current.sequence !== previous.sequence + 1 ||
      current.retirementRequestId !== previous.retirementRequestId ||
      current.requestFingerprint !== previous.requestFingerprint ||
      current.previewDigest !== previous.previewDigest ||
      JSON.stringify(current.planned) !== JSON.stringify(previous.planned)) {
    throw new Error('journal immutable binding changed')
  }
  const allowed: Record<JournalEntry['state'], readonly JournalEntry['state'][]> = {
    moving: ['moving', 'rolling-back', 'committed'],
    'rolling-back': ['rolling-back', 'rolled-back', 'recovery-required'],
    'rolled-back': ['moving'],
    committed: ['restoring', 'purging'],
    restoring: ['restoring', 'restore-rolling-back', 'restored'],
    'restore-rolling-back': ['restore-rolling-back', 'committed', 'recovery-required'],
    restored: [],
    purging: ['purging', 'purge-recovery-required', 'purged'],
    'purge-recovery-required': ['purge-recovery-required', 'purging', 'purged'],
    purged: [],
    'recovery-required': ['rolling-back', 'restore-rolling-back']
  }
  if (!allowed[previous.state].includes(current.state)) throw new Error('invalid journal state transition')
  if (previous.retirementReceipt !== null &&
      JSON.stringify(current.retirementReceipt) !== JSON.stringify(previous.retirementReceipt)) {
    throw new Error('retirement receipt changed')
  }
  if (previous.restoreReceipt !== null &&
      JSON.stringify(current.restoreReceipt) !== JSON.stringify(previous.restoreReceipt)) {
    throw new Error('restore receipt changed')
  }
  if (previous.purgeReceipt !== null &&
      JSON.stringify(current.purgeReceipt) !== JSON.stringify(previous.purgeReceipt)) {
    throw new Error('purge receipt changed')
  }
}

function isExactPrefix(values: readonly string[], planned: readonly string[]): boolean {
  return values.length <= planned.length && values.every((value, index) => value === planned[index])
}

async function rollbackRetirementMoves(
  roots: PreparedRetentionRoots,
  operationDirectory: string,
  current: JournalEntry,
  now: () => Date,
  hostMutation?: HostMutationOperationScope
): Promise<boolean> {
  hostMutation?.assertActive()
  let journal = nextJournal(current, { state: 'rolling-back', updatedAt: now().toISOString() })
  await appendJournal(operationDirectory, journal)
  hostMutation?.assertActive()
  try {
    const placements = await inspectRetirementRollbackPlacements(roots, operationDirectory, journal)
    for (const candidate of [...journal.planned].reverse()) {
      const backupId = candidate.backupId
      if (placements.get(backupId) === 'retired') {
        const source = await resolveNormalBackupDirectory(operationDirectory, backupId)
        const active = safeImmediateChild(roots.backupRoot, backupId)
        if (await pathExists(active) || !sameCandidate(await inspectBackupEvidence(operationDirectory, backupId), candidate)) {
          throw new Error('retirement rollback evidence changed')
        }
        hostMutation?.assertActive()
        await rename(source, active)
        hostMutation?.assertActive()
      }
      journal = nextJournal(journal, {
        state: 'rolling-back',
        movedBackupIds: journal.movedBackupIds.filter((value) => value !== backupId),
        updatedAt: now().toISOString()
      })
      await appendJournal(operationDirectory, journal)
    }
    journal = nextJournal(journal, { state: 'rolled-back', updatedAt: now().toISOString() })
    await appendJournal(operationDirectory, journal)
    hostMutation?.assertActive()
    return true
  } catch (error) {
    if (error instanceof HostMutationLeaseError) throw error
    journal = nextJournal(journal, { state: 'recovery-required', updatedAt: now().toISOString() })
    await appendJournal(operationDirectory, journal).catch(() => undefined)
    return false
  }
}

async function rollbackRestoreMoves(
  roots: PreparedRetentionRoots,
  operationDirectory: string,
  current: JournalEntry,
  now: () => Date,
  hostMutation?: HostMutationOperationScope
): Promise<boolean> {
  hostMutation?.assertActive()
  let journal = nextJournal(current, { state: 'restore-rolling-back', updatedAt: now().toISOString() })
  await appendJournal(operationDirectory, journal)
  hostMutation?.assertActive()
  try {
    const placements = await inspectRestoreRollbackPlacements(roots, operationDirectory, journal)
    for (const candidate of [...journal.planned].reverse()) {
      const backupId = candidate.backupId
      if (placements.get(backupId) === 'active') {
        const source = await resolveNormalBackupDirectory(roots.backupRoot, backupId)
        const retired = safeImmediateChild(operationDirectory, backupId)
        if (await pathExists(retired) || !sameCandidate(await inspectBackupEvidence(roots.backupRoot, backupId), candidate)) {
          throw new Error('restore rollback evidence changed')
        }
        hostMutation?.assertActive()
        await rename(source, retired)
        hostMutation?.assertActive()
      }
      journal = nextJournal(journal, {
        state: 'restore-rolling-back',
        restoredBackupIds: journal.restoredBackupIds.filter((value) => value !== backupId),
        updatedAt: now().toISOString()
      })
      await appendJournal(operationDirectory, journal)
    }
    journal = nextJournal(journal, {
      state: 'committed',
      restoreRequestId: null,
      restoredBackupIds: [],
      updatedAt: now().toISOString()
    })
    await appendJournal(operationDirectory, journal)
    hostMutation?.assertActive()
    return true
  } catch (error) {
    if (error instanceof HostMutationLeaseError) throw error
    journal = nextJournal(journal, { state: 'recovery-required', updatedAt: now().toISOString() })
    await appendJournal(operationDirectory, journal).catch(() => undefined)
    return false
  }
}

type CandidatePlacement = 'active' | 'retired'

async function inspectRetirementRollbackPlacements(
  roots: PreparedRetentionRoots,
  operationDirectory: string,
  journal: JournalEntry
): Promise<Map<string, CandidatePlacement>> {
  assertJournalSemantics(journal)
  const placements = new Map<string, CandidatePlacement>()
  const movedCount = journal.movedBackupIds.length
  for (let index = 0; index < journal.planned.length; index += 1) {
    const candidate = journal.planned[index]!
    const placement = await inspectExactCandidatePlacement(roots, operationDirectory, candidate)
    const allowed = journal.state === 'moving'
      ? index < movedCount
        ? ['retired']
        : index === movedCount
          ? ['active', 'retired']
          : ['active']
      : journal.state === 'rolling-back'
        ? index < Math.max(0, movedCount - 1)
          ? ['retired']
          : index <= movedCount
            ? ['active', 'retired']
            : ['active']
        : journal.state === 'recovery-required' && journal.retirementReceipt === null
          ? ['active', 'retired']
          : []
    if (!allowed.includes(placement)) throw new Error('retirement rollback layout is not journal-authorized')
    placements.set(candidate.backupId, placement)
  }
  return placements
}

async function inspectRestoreRollbackPlacements(
  roots: PreparedRetentionRoots,
  operationDirectory: string,
  journal: JournalEntry
): Promise<Map<string, CandidatePlacement>> {
  assertJournalSemantics(journal)
  if (journal.retirementReceipt === null) throw new Error('restore journal has no retirement receipt')
  const placements = new Map<string, CandidatePlacement>()
  const restoredCount = journal.restoredBackupIds.length
  for (let index = 0; index < journal.planned.length; index += 1) {
    const candidate = journal.planned[index]!
    const placement = await inspectExactCandidatePlacement(roots, operationDirectory, candidate)
    const allowed = journal.state === 'restoring'
      ? index < restoredCount
        ? ['active']
        : index === restoredCount
          ? ['active', 'retired']
          : ['retired']
      : journal.state === 'restore-rolling-back'
        ? index < Math.max(0, restoredCount - 1)
          ? ['active']
          : index <= restoredCount
            ? ['active', 'retired']
            : ['retired']
        : journal.state === 'recovery-required'
          ? ['active', 'retired']
          : []
    if (!allowed.includes(placement)) throw new Error('restore rollback layout is not journal-authorized')
    placements.set(candidate.backupId, placement)
  }
  return placements
}

async function inspectExactCandidatePlacement(
  roots: PreparedRetentionRoots,
  operationDirectory: string,
  candidate: RetirementReceipt['retired'][number]
): Promise<CandidatePlacement> {
  const active = safeImmediateChild(roots.backupRoot, candidate.backupId)
  const retired = safeImmediateChild(operationDirectory, candidate.backupId)
  const [activeExists, retiredExists] = await Promise.all([pathExists(active), pathExists(retired)])
  if (activeExists === retiredExists) throw new Error('candidate placement is ambiguous')
  const placement: CandidatePlacement = activeExists ? 'active' : 'retired'
  const inspected = await inspectBackupEvidence(
    placement === 'active' ? roots.backupRoot : operationDirectory,
    candidate.backupId
  )
  if (!sameCandidate(inspected, candidate)) throw new Error('candidate evidence is not journal-bound')
  return placement
}

async function assertTerminalJournalLayout(
  roots: PreparedRetentionRoots,
  operationDirectory: string,
  journal: JournalEntry
): Promise<void> {
  if (journal.state === 'purge-recovery-required') {
    await preflightPurgeBatch(roots, operationDirectory, journal)
    return
  }
  for (const candidate of journal.planned) {
    const active = safeImmediateChild(roots.backupRoot, candidate.backupId)
    const retired = safeImmediateChild(operationDirectory, candidate.backupId)
    const [activeExists, retiredExists] = await Promise.all([pathExists(active), pathExists(retired)])
    if (journal.state === 'purged') {
      if (activeExists || retiredExists) throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
      continue
    }
    const expected: CandidatePlacement = journal.state === 'rolled-back' || journal.state === 'restored'
      ? 'active'
      : 'retired'
    if ((expected === 'active' && (!activeExists || retiredExists)) ||
        (expected === 'retired' && (activeExists || !retiredExists))) {
      throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
    }
    const inspected = await inspectBackupEvidence(
      expected === 'active' ? roots.backupRoot : operationDirectory,
      candidate.backupId
    )
    if (!sameCandidate(inspected, candidate)) {
      throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
    }
  }
}

async function preflightPurgeBatch(
  roots: PreparedRetentionRoots,
  operationDirectory: string,
  journal: JournalEntry
): Promise<void> {
  for (const candidate of journal.planned) {
    const active = safeImmediateChild(roots.backupRoot, candidate.backupId)
    const retired = safeImmediateChild(operationDirectory, candidate.backupId)
    if (await pathExists(active)) throw new BackupRetentionError('SAVE_RETENTION_BACKUP_CHANGED')
    if (journal.purgedBackupIds.includes(candidate.backupId)) {
      if (await pathExists(retired)) throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
      continue
    }
    if (journal.purgeIntentBackupId === candidate.backupId) {
      // A durable intent permits exact continuation from a partially removed
      // owned directory after a process crash.
      continue
    }
    if (!await pathExists(retired)) throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
    const inspected = await inspectBackupEvidence(operationDirectory, candidate.backupId)
    if (!sameCandidate(inspected, candidate)) {
      throw new BackupRetentionError('SAVE_RETENTION_BACKUP_CHANGED')
    }
    await assertExactOwnedBackupDirectory(operationDirectory, candidate)
  }
}

async function assertExactOwnedBackupDirectory(
  operationDirectory: string,
  candidate: RetirementReceipt['retired'][number]
): Promise<void> {
  const directory = await resolveNormalBackupDirectory(operationDirectory, candidate.backupId)
  const expected = new Set([
    `${candidate.saveName}.dsv`, `${candidate.saveName}.server`, 'manifest.json'
  ])
  const entries = await readBoundedDirectory(directory, 4)
  if (entries.length !== expected.size || entries.some((entry) => entry.kind !== 'file' || !expected.has(entry.name))) {
    throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
  }
  for (const name of expected) await assertNormalOwnedFile(safeImmediateChild(directory, name))
}

async function purgeOwnedRetiredBackup(
  operationDirectory: string,
  candidate: RetirementReceipt['retired'][number],
  resumeAllowed: boolean,
  hostMutation?: HostMutationOperationScope
): Promise<void> {
  const directoryPath = safeImmediateChild(operationDirectory, candidate.backupId)
  if (!await pathExists(directoryPath)) {
    if (resumeAllowed) return
    throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
  }
  const directory = await resolveNormalDirectory(directoryPath).catch((error: unknown) => {
    throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED', { cause: error })
  })
  const expectedNames = new Set([
    `${candidate.saveName}.dsv`, `${candidate.saveName}.server`, 'manifest.json'
  ])
  const entries = await readBoundedDirectory(directory, 4)
  if (entries.some((entry) => entry.kind !== 'file' || !expectedNames.has(entry.name))) {
    throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
  }
  const names = new Set(entries.map((entry) => entry.name))
  if (!resumeAllowed && names.size !== expectedNames.size) {
    throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
  }
  const manifestPath = safeImmediateChild(directory, 'manifest.json')
  if (names.has('manifest.json')) {
    const raw = await readNormalOwnedFile(manifestPath, MAX_MANIFEST_BYTES)
    let manifest: z.infer<typeof backupManifestV1Schema>
    try {
      manifest = backupManifestV1Schema.parse(JSON.parse(raw) as unknown)
    } catch (error) {
      throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED', { cause: error })
    }
    if (`tx-${manifest.requestId.toLocaleLowerCase('en-US')}` !== candidate.backupId ||
        manifest.saveName !== candidate.saveName || sha256(raw) !== candidate.evidenceDigest) {
      throw new BackupRetentionError('SAVE_RETENTION_BACKUP_CHANGED')
    }
  } else if (!resumeAllowed || names.size > 0) {
    // The manifest is deliberately removed last. Remaining files without it
    // cannot be proven to belong to this operation.
    throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
  }
  for (const name of [`${candidate.saveName}.dsv`, `${candidate.saveName}.server`]) {
    if (!names.has(name)) continue
    const filePath = safeImmediateChild(directory, name)
    await assertNormalOwnedFile(filePath)
    hostMutation?.assertActive()
    await unlink(filePath)
    hostMutation?.assertActive()
  }
  if (names.has('manifest.json')) {
    await assertNormalOwnedFile(manifestPath)
    hostMutation?.assertActive()
    await unlink(manifestPath)
    hostMutation?.assertActive()
  }
  hostMutation?.assertActive()
  await rmdir(directory)
  hostMutation?.assertActive()
}

async function assertNormalOwnedFile(filePath: string): Promise<void> {
  const metadata = await lstat(filePath)
  if (!metadata.isFile() || metadata.isSymbolicLink() || !samePath(await realpath(filePath), filePath)) {
    throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
  }
}

async function readNormalOwnedFile(filePath: string, maximumBytes: number): Promise<string> {
  const metadata = await lstat(filePath)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > maximumBytes ||
      !samePath(await realpath(filePath), filePath)) {
    throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
  }
  return await readFile(filePath, 'utf8')
}

async function reconcileRetentionOperations(
  roots: PreparedRetentionRoots,
  now: () => Date,
  resumablePurgeRetirementId?: string,
  resumablePurgeFingerprint?: string,
  hostMutation?: HostMutationOperationScope
): Promise<void> {
  const directory = await opendir(roots.retiredRoot)
  let count = 0
  try {
    for await (const entry of directory) {
      count += 1
      if (count > MAX_DIRECTORY_ENTRIES) {
        throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
      }
      if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith(OPERATION_PREFIX)) continue
      const requestId = requestIdSchema.safeParse(entry.name.slice(OPERATION_PREFIX.length))
      if (!requestId.success) continue
      const operationDirectory = operationPath(roots, requestId.data)
      const journal = await readLatestJournal(operationDirectory)
      if (journal === null) throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
      if (journal.state === 'moving' || journal.state === 'rolling-back') {
        if (!await rollbackRetirementMoves(roots, operationDirectory, journal, now, hostMutation)) {
          throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
        }
      } else if (journal.state === 'restoring' || journal.state === 'restore-rolling-back') {
        if (!await rollbackRestoreMoves(roots, operationDirectory, journal, now, hostMutation)) {
          throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
        }
      } else if (journal.state === 'recovery-required') {
        throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
      } else if (journal.state === 'purging' || journal.state === 'purge-recovery-required') {
        if (journal.retirementRequestId !== resumablePurgeRetirementId ||
            journal.purgeRequestFingerprint !== resumablePurgeFingerprint) {
          throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
        }
      } else if (journal.state === 'committed' && journal.retirementReceipt !== null) {
        hostMutation?.assertActive()
        await publishReceiptEnvelopeIfMissing(roots, {
          format: 'dyson-control-retention-receipt',
          schemaVersion: 1,
          operation: 'retire',
          requestFingerprint: journal.requestFingerprint,
          receipt: journal.retirementReceipt
        })
        hostMutation?.assertActive()
      } else if (journal.state === 'restored' && journal.restoreReceipt !== null && journal.restoreRequestId !== null) {
        hostMutation?.assertActive()
        await publishReceiptEnvelopeIfMissing(roots, {
          format: 'dyson-control-retention-receipt',
          schemaVersion: 1,
          operation: 'restore-retired',
          requestFingerprint: requestFingerprint('restore-retired', {
            requestId: journal.restoreRequestId,
            retirementRequestId: journal.retirementRequestId,
            confirmation: 'RESTORE_RETIRED_BACKUPS'
          }),
          receipt: journal.restoreReceipt
        })
        hostMutation?.assertActive()
      } else if (journal.state === 'purged' && journal.purgeReceipt !== null &&
          journal.purgeRequestFingerprint !== null) {
        hostMutation?.assertActive()
        await publishReceiptEnvelopeIfMissing(roots, {
          format: 'dyson-control-retention-receipt',
          schemaVersion: 1,
          operation: 'purge-retired',
          requestFingerprint: journal.purgeRequestFingerprint,
          receipt: journal.purgeReceipt
        })
        hostMutation?.assertActive()
      }
    }
  } finally {
    await directory.close().catch(() => undefined)
  }
}

async function readReceiptEnvelope(
  roots: PreparedRetentionRoots,
  operation: 'retire',
  requestId: string
): Promise<Extract<z.infer<typeof receiptEnvelopeSchema>, { operation: 'retire' }> | null>
async function readReceiptEnvelope(
  roots: PreparedRetentionRoots,
  operation: 'restore-retired',
  requestId: string
): Promise<Extract<z.infer<typeof receiptEnvelopeSchema>, { operation: 'restore-retired' }> | null>
async function readReceiptEnvelope(
  roots: PreparedRetentionRoots,
  operation: 'annotate',
  requestId: string
): Promise<Extract<z.infer<typeof receiptEnvelopeSchema>, { operation: 'annotate' }> | null>
async function readReceiptEnvelope(
  roots: PreparedRetentionRoots,
  operation: 'purge-retired',
  requestId: string
): Promise<Extract<z.infer<typeof receiptEnvelopeSchema>, { operation: 'purge-retired' }> | null>
async function readReceiptEnvelope(
  roots: PreparedRetentionRoots,
  operation: 'retire' | 'restore-retired' | 'annotate' | 'purge-retired',
  requestId: string
): Promise<z.infer<typeof receiptEnvelopeSchema> | null> {
  const filePath = receiptPath(roots, operation, requestId)
  try {
    const metadata = await lstat(filePath)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > 1_048_576 ||
        !samePath(await realpath(filePath), filePath)) {
      throw new Error('invalid receipt')
    }
    const parsed = receiptEnvelopeSchema.parse(JSON.parse(await readFile(filePath, 'utf8')) as unknown)
    if (parsed.operation !== operation || parsed.receipt.requestId !== requestIdSchema.parse(requestId)) {
      throw new Error('receipt identity mismatch')
    }
    return parsed
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null
    throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED', { cause: error })
  }
}

async function publishReceiptEnvelope(
  roots: PreparedRetentionRoots,
  envelope: z.infer<typeof receiptEnvelopeSchema>
): Promise<void> {
  await publishImmutableJson(
    receiptPath(roots, envelope.operation, envelope.receipt.requestId),
    receiptEnvelopeSchema.parse(envelope)
  )
}

async function publishReceiptEnvelopeIfMissing(
  roots: PreparedRetentionRoots,
  envelope: z.infer<typeof receiptEnvelopeSchema>
): Promise<void> {
  const existing = envelope.operation === 'retire'
    ? await readReceiptEnvelope(roots, 'retire', envelope.receipt.requestId)
    : envelope.operation === 'restore-retired'
      ? await readReceiptEnvelope(roots, 'restore-retired', envelope.receipt.requestId)
      : envelope.operation === 'annotate'
        ? await readReceiptEnvelope(roots, 'annotate', envelope.receipt.requestId)
        : await readReceiptEnvelope(roots, 'purge-retired', envelope.receipt.requestId)
  if (existing !== null) {
    if (JSON.stringify(existing) !== JSON.stringify(envelope)) {
      throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
    }
    return
  }
  await publishReceiptEnvelope(roots, envelope)
}

function receiptPath(
  roots: PreparedRetentionRoots,
  operation: 'retire' | 'restore-retired' | 'annotate' | 'purge-retired',
  requestId: string
): string {
  const parsed = requestIdSchema.parse(requestId)
  return safeImmediateChild(roots.receiptRoot, `${operation}-${parsed}.json`)
}

async function publishImmutableJson(filePath: string, value: unknown): Promise<void> {
  const partialPath = safeImmediateChild(path.dirname(filePath), `.partial-${randomUUID()}`)
  let handle: FileHandle | null = null
  try {
    handle = await open(partialPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await link(partialPath, filePath)
    await unlink(partialPath)
  } catch (error) {
    if (handle !== null) await handle.close().catch(() => undefined)
    await unlink(partialPath).catch(() => undefined)
    if (isNodeError(error, 'EEXIST')) {
      throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED', { cause: error })
    }
    throw normalizeRetentionError(error)
  }
}

async function withRetentionLock<T>(
  roots: PreparedRetentionRoots,
  operation: () => Promise<T>,
  hostMutation?: HostMutationOperationScope,
  allowCurrentProcessResidual = false
): Promise<T> {
  const lockIdentity = normalizedPath(roots.lockPath)
  const handle = await acquireRetentionLock(roots.lockPath, allowCurrentProcessResidual)
  activeRetentionLocks.add(lockIdentity)
  try {
    return await operation()
  } finally {
    await handle.close().catch(() => undefined)
    activeRetentionLocks.delete(lockIdentity)
    // A lost global lease means this process no longer has authority to
    // mutate even control metadata. Preserve the local lock for the explicit
    // recovery path rather than deleting it after ownership was lost.
    let mayRelease = true
    if (hostMutation !== undefined) {
      try {
        hostMutation.assertActive()
      } catch {
        mayRelease = false
      }
    }
    if (mayRelease) await unlink(roots.lockPath).catch(() => undefined)
  }
}

async function acquireRetentionLock(
  lockPath: string,
  allowCurrentProcessResidual = false
): Promise<FileHandle> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle: FileHandle
    try {
      handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) {
        throw new BackupRetentionError('SAVE_RETENTION_STORAGE_UNAVAILABLE', { cause: error })
      }
      if (attempt > 0 || !await removeProvablyStaleLock(lockPath, allowCurrentProcessResidual)) {
        throw new BackupRetentionError('SAVE_RETENTION_LOCK_BUSY', { cause: error })
      }
      continue
    }
    try {
      await handle.writeFile(`${JSON.stringify({
        format: 'dyson-control-retention-lock',
        schemaVersion: 1,
        host: hostname(),
        bootId: currentBootId(),
        pid: process.pid
      })}\n`, 'utf8')
      await handle.sync()
      return handle
    } catch (error) {
      await handle.close().catch(() => undefined)
      await unlink(lockPath).catch(() => undefined)
      throw new BackupRetentionError('SAVE_RETENTION_STORAGE_UNAVAILABLE', { cause: error })
    }
  }
  throw new BackupRetentionError('SAVE_RETENTION_LOCK_BUSY')
}

async function removeProvablyStaleLock(
  lockPath: string,
  allowCurrentProcessResidual = false
): Promise<boolean> {
  let parsed: z.infer<typeof lockSchema>
  try {
    const metadata = await lstat(lockPath)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > 2_048 ||
        !samePath(await realpath(lockPath), lockPath)) return false
    parsed = lockSchema.parse(JSON.parse(await readFile(lockPath, 'utf8')) as unknown)
  } catch {
    return false
  }
  if (parsed.host !== hostname()) return false
  if (parsed.bootId === currentBootId() && processIsAlive(parsed.pid) && (
    !allowCurrentProcessResidual || parsed.pid !== process.pid ||
    activeRetentionLocks.has(normalizedPath(lockPath))
  )) return false
  try {
    await unlink(lockPath)
    return true
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return true
    throw error
  }
}

function requestFingerprint(
  operation: 'retire' | 'restore-retired' | 'annotate' | 'purge-retired',
  request: unknown
): string {
  return sha256(JSON.stringify({ operation, request }))
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function sumBoundedBytes(candidates: RetirementReceipt['retired']): number {
  let total = 0
  for (const candidate of candidates) {
    if (candidate.totalBytes > Number.MAX_SAFE_INTEGER - total) {
      throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
    }
    total += candidate.totalBytes
  }
  return total
}

function currentBootId(): string {
  return Math.round((Date.now() - uptime() * 1_000) / 60_000).toString(36)
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isNodeError(error, 'EPERM')
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate)
    return true
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false
    throw error
  }
}

function samePath(left: string, right: string): boolean {
  return normalizedPath(left) === normalizedPath(right)
}

function normalizedPath(value: string): string {
  return path.resolve(value).replace(/[\\/]+$/, '').toLocaleLowerCase('en-US')
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
}

function normalizeRetentionError(error: unknown): BackupRetentionError {
  if (error instanceof BackupRetentionError) return error
  return new BackupRetentionError('SAVE_RETENTION_FAILED', { cause: error })
}

function mapHostMutationCoordinatorError(
  code: HostMutationOperationCoordinatorError['code']
): BackupRetentionErrorCode {
  if (code === 'HOST_MUTATION_LEASE_BUSY') return 'SAVE_RETENTION_HOST_LEASE_BUSY'
  if (code === 'HOST_MUTATION_LEASE_RECOVERY_REQUIRED' ||
      code === 'HOST_MUTATION_LEASE_RECOVERY_MISMATCH' ||
      code === 'HOST_MUTATION_LEASE_DIRTY') {
    return 'SAVE_RETENTION_HOST_LEASE_RECOVERY_REQUIRED'
  }
  if (code === 'HOST_MUTATION_LEASE_LOST') return 'SAVE_RETENTION_HOST_LEASE_LOST'
  return 'SAVE_RETENTION_HOST_LEASE_UNAVAILABLE'
}

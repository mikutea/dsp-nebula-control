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

export interface BackupRetentionControlOptions {
  backupRoot: string
  protectionSource?: BackupRetentionProtectionSource
  now?: () => Date
  maximumDirectoryEntries?: number
  /** Defaults to seven days. Zero is intended only for deterministic tests. */
  minimumPurgeAgeMs?: number
  /** @internal Deterministic failure injection for transaction tests only. */
  phase?: (
    phase: 'before-retire-move' | 'after-retire-move' |
      'before-restore-move' | 'after-restore-move' |
      'before-purge' | 'after-purge',
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

  async setAnnotation(input: unknown): Promise<{ receipt: AnnotationReceipt, reused: boolean }> {
    const request = parseAnnotationRequest(input)
    const roots = await prepareRetentionRoots(this.#configuredBackupRoot)
    return await withRetentionLock(roots, async () => {
      await reconcileRetentionOperations(roots, this.#now)
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
      await publishImmutableJson(annotationEventPath(roots.annotationRoot, event), event)
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
    })
  }

  async execute(input: unknown): Promise<{ receipt: RetirementReceipt, reused: boolean }> {
    const request = parseExecuteRequest(input)
    const roots = await prepareRetentionRoots(this.#configuredBackupRoot)
    return await withRetentionLock(roots, async () => {
      await reconcileRetentionOperations(roots, this.#now)
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
      const planned = bindPlannedCandidates(preview, snapshot.inventory.verifications)
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
        journal = nextJournal(previous, {
          state: 'moving',
          movedBackupIds: [],
          restoreRequestId: null,
          restoredBackupIds: [],
          updatedAt: this.#now().toISOString()
        })
        await appendJournal(operationDirectory, journal)
      } else {
        await createFreshNormalDirectory(operationDirectory)
        journal = makeInitialJournal(request, fingerprint, planned, this.#now().toISOString())
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
          await rename(source, destination)
          journal = nextJournal(journal, {
            state: 'moving',
            movedBackupIds: [...journal.movedBackupIds, candidate.backupId],
            updatedAt: this.#now().toISOString()
          })
          await appendJournal(operationDirectory, journal)
          await this.#phase('after-retire-move', candidate.backupId)
        }
      } catch (error) {
        const rolledBack = await rollbackRetirementMoves(roots, operationDirectory, journal, this.#now)
        if (!rolledBack) {
          throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED', { cause: error })
        }
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
      await publishReceiptEnvelope(roots, {
        format: 'dyson-control-retention-receipt',
        schemaVersion: 1,
        operation: 'retire',
        requestFingerprint: fingerprint,
        receipt
      })
      return { receipt, reused: false }
    })
  }

  async restore(input: unknown): Promise<{ receipt: RestoreReceipt, reused: boolean }> {
    const request = parseRestoreRequest(input)
    const roots = await prepareRetentionRoots(this.#configuredBackupRoot)
    return await withRetentionLock(roots, async () => {
      await reconcileRetentionOperations(roots, this.#now)
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
          await rename(
            await resolveNormalBackupDirectory(operationDirectory, candidate.backupId),
            safeImmediateChild(roots.backupRoot, candidate.backupId)
          )
          journal = nextJournal(journal, {
            state: 'restoring',
            restoredBackupIds: [...journal.restoredBackupIds, candidate.backupId],
            updatedAt: this.#now().toISOString()
          })
          await appendJournal(operationDirectory, journal)
          await this.#phase('after-restore-move', candidate.backupId)
        }
      } catch (error) {
        const rolledBack = await rollbackRestoreMoves(roots, operationDirectory, journal, this.#now)
        if (!rolledBack) {
          throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED', { cause: error })
        }
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
      await publishReceiptEnvelope(roots, {
        format: 'dyson-control-retention-receipt',
        schemaVersion: 1,
        operation: 'restore-retired',
        requestFingerprint: fingerprint,
        receipt
      })
      return { receipt, reused: false }
    })
  }

  async previewPurge(input: unknown): Promise<BackupRetentionPurgePreview> {
    const request = parsePurgePreviewRequest(input)
    const roots = await resolveExistingRetentionRoots(this.#configuredBackupRoot)
    return await this.#purgePreview(roots, request.retirementRequestId)
  }

  async purge(input: unknown): Promise<{ receipt: PurgeReceipt, reused: boolean }> {
    const request = parsePurgeExecuteRequest(input)
    const roots = await prepareRetentionRoots(this.#configuredBackupRoot)
    return await withRetentionLock(roots, async () => {
      const fingerprint = requestFingerprint('purge-retired', request)
      await reconcileRetentionOperations(roots, this.#now, request.retirementRequestId, fingerprint)
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
      } else if (!['purging', 'purge-recovery-required'].includes(journal.state) ||
          journal.purgeRequestId !== request.requestId || journal.purgeRequestFingerprint !== fingerprint) {
        throw new BackupRetentionError(
          journal.state === 'purged' ? 'SAVE_RETENTION_OPERATION_NOT_RESTORABLE' :
            journal.state === 'recovery-required' ? 'SAVE_RETENTION_RECOVERY_REQUIRED' :
              'SAVE_RETENTION_IDEMPOTENCY_CONFLICT'
        )
      }

      try {
        await preflightPurgeBatch(roots, operationDirectory, journal)
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
          await purgeOwnedRetiredBackup(operationDirectory, candidate, true)
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
        journal = nextJournal(journal, {
          state: 'purge-recovery-required',
          updatedAt: this.#now().toISOString()
        })
        await appendJournal(operationDirectory, journal).catch(() => undefined)
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
      await publishReceiptEnvelope(roots, {
        format: 'dyson-control-retention-receipt',
        schemaVersion: 1,
        operation: 'purge-retired',
        requestFingerprint: fingerprint,
        receipt
      })
      return { receipt, reused: false }
    })
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
      excluded,
      inventoryDigest
    }
    const preview: BackupRetentionPreview = {
      schemaVersion: 1,
      mode: 'dry-run',
      referenceTime,
      policy,
      plan,
      excluded,
      inventoryDigest,
      previewDigest: sha256(JSON.stringify(digestInput))
    }
    return { preview, inventory }
  }

  async #inventory(backupRoot: string): Promise<InventoryResult> {
    let protectedIds: ReadonlySet<string>
    try {
      const [externalIds, annotationState] = await Promise.all([
        this.#protectionSource.listProtectedBackupIds(),
        readAnnotationStateIfPresent(backupRoot)
      ])
      protectedIds = new Set([
        ...externalIds,
        ...[...annotationState.values()]
          .filter((annotation) => annotation.protected)
          .map((annotation) => annotation.backupId)
      ])
    } catch (error) {
      throw new BackupRetentionError('SAVE_RETENTION_STORAGE_UNAVAILABLE', { cause: error })
    }
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

function bindPlannedCandidates(
  preview: BackupRetentionPreview,
  verifications: ReadonlyMap<string, InventoryEvidence>
): RetirementReceipt['retired'] {
  return preview.plan.delete.map((decision) => {
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

async function appendJournal(operationDirectory: string, journal: JournalEntry): Promise<void> {
  const filename = `${JOURNAL_PREFIX}${journal.sequence.toString().padStart(6, '0')}.json`
  await publishImmutableJson(
    safeImmediateChild(operationDirectory, filename),
    journalEntrySchema.parse(journal)
  )
}

async function readLatestJournal(operationDirectory: string): Promise<JournalEntry | null> {
  if (!await pathExists(operationDirectory)) return null
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
  const latest = names.at(-1)
  if (latest === undefined) return null
  try {
    const filePath = safeImmediateChild(resolved, latest)
    const metadata = await lstat(filePath)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > 1_048_576 ||
        !samePath(await realpath(filePath), filePath)) {
      throw new Error('invalid journal')
    }
    const parsed = journalEntrySchema.parse(JSON.parse(await readFile(filePath, 'utf8')) as unknown)
    if (latest !== `${JOURNAL_PREFIX}${parsed.sequence.toString().padStart(6, '0')}.json`) {
      throw new Error('journal identity mismatch')
    }
    return parsed
  } catch (error) {
    throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED', { cause: error })
  }
}

async function rollbackRetirementMoves(
  roots: PreparedRetentionRoots,
  operationDirectory: string,
  current: JournalEntry,
  now: () => Date
): Promise<boolean> {
  let journal = nextJournal(current, { state: 'rolling-back', updatedAt: now().toISOString() })
  await appendJournal(operationDirectory, journal).catch(() => undefined)
  try {
    for (const candidate of [...journal.planned].reverse()) {
      const backupId = candidate.backupId
      const active = safeImmediateChild(roots.backupRoot, backupId)
      const retired = safeImmediateChild(operationDirectory, backupId)
      const [activeExists, retiredExists] = await Promise.all([pathExists(active), pathExists(retired)])
      if (activeExists === retiredExists) throw new Error('rollback boundary conflict')
      if (retiredExists) {
        await rename(await resolveNormalBackupDirectory(operationDirectory, backupId), active)
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
    return true
  } catch {
    journal = nextJournal(journal, { state: 'recovery-required', updatedAt: now().toISOString() })
    await appendJournal(operationDirectory, journal).catch(() => undefined)
    return false
  }
}

async function rollbackRestoreMoves(
  roots: PreparedRetentionRoots,
  operationDirectory: string,
  current: JournalEntry,
  now: () => Date
): Promise<boolean> {
  let journal = nextJournal(current, { state: 'restore-rolling-back', updatedAt: now().toISOString() })
  await appendJournal(operationDirectory, journal).catch(() => undefined)
  try {
    for (const candidate of [...journal.planned].reverse()) {
      const backupId = candidate.backupId
      const active = safeImmediateChild(roots.backupRoot, backupId)
      const retired = safeImmediateChild(operationDirectory, backupId)
      const [activeExists, retiredExists] = await Promise.all([pathExists(active), pathExists(retired)])
      if (activeExists === retiredExists) throw new Error('restore rollback boundary conflict')
      if (activeExists) {
        await rename(await resolveNormalBackupDirectory(roots.backupRoot, backupId), retired)
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
    return true
  } catch {
    journal = nextJournal(journal, { state: 'recovery-required', updatedAt: now().toISOString() })
    await appendJournal(operationDirectory, journal).catch(() => undefined)
    return false
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
  resumeAllowed: boolean
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
    await unlink(filePath)
  }
  if (names.has('manifest.json')) {
    await assertNormalOwnedFile(manifestPath)
    await unlink(manifestPath)
  }
  await rmdir(directory)
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
  resumablePurgeFingerprint?: string
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
        if (!await rollbackRetirementMoves(roots, operationDirectory, journal, now)) {
          throw new BackupRetentionError('SAVE_RETENTION_RECOVERY_REQUIRED')
        }
      } else if (journal.state === 'restoring' || journal.state === 'restore-rolling-back') {
        if (!await rollbackRestoreMoves(roots, operationDirectory, journal, now)) {
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
        await publishReceiptEnvelopeIfMissing(roots, {
          format: 'dyson-control-retention-receipt',
          schemaVersion: 1,
          operation: 'retire',
          requestFingerprint: journal.requestFingerprint,
          receipt: journal.retirementReceipt
        })
      } else if (journal.state === 'restored' && journal.restoreReceipt !== null && journal.restoreRequestId !== null) {
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
      } else if (journal.state === 'purged' && journal.purgeReceipt !== null &&
          journal.purgeRequestFingerprint !== null) {
        await publishReceiptEnvelopeIfMissing(roots, {
          format: 'dyson-control-retention-receipt',
          schemaVersion: 1,
          operation: 'purge-retired',
          requestFingerprint: journal.purgeRequestFingerprint,
          receipt: journal.purgeReceipt
        })
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
  operation: () => Promise<T>
): Promise<T> {
  const handle = await acquireRetentionLock(roots.lockPath)
  try {
    return await operation()
  } finally {
    await handle.close().catch(() => undefined)
    await unlink(roots.lockPath).catch(() => undefined)
  }
}

async function acquireRetentionLock(lockPath: string): Promise<FileHandle> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle: FileHandle
    try {
      handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) {
        throw new BackupRetentionError('SAVE_RETENTION_STORAGE_UNAVAILABLE', { cause: error })
      }
      if (attempt > 0 || !await removeProvablyStaleLock(lockPath)) {
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

async function removeProvablyStaleLock(lockPath: string): Promise<boolean> {
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
  if (parsed.bootId === currentBootId() && processIsAlive(parsed.pid)) return false
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
  const normalize = (value: string): string => path.resolve(value)
    .replace(/[\\/]+$/, '')
    .toLocaleLowerCase('en-US')
  return normalize(left) === normalize(right)
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
}

function normalizeRetentionError(error: unknown): BackupRetentionError {
  if (error instanceof BackupRetentionError) return error
  return new BackupRetentionError('SAVE_RETENTION_FAILED', { cause: error })
}

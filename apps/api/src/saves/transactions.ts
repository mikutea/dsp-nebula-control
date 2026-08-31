import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
  type FileHandle
} from 'node:fs/promises'
import { hostname } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { resolveNormalDirectory, safeImmediateChild } from './boundary.js'
import { planBackupRetention } from './retention.js'
import {
  BACKUP_MANIFEST_PROTOCOL,
  MAX_MANIFEST_BYTES,
  backupIdSchema,
  backupManifestV1Schema,
  saveNameSchema,
  type BackupManifestV1,
  type RetentionPlan
} from './schemas.js'

const schemaVersion = 1 as const
const controlDirectoryName = '.dyson-save-control'
const auditDirectoryName = 'audit'
const receiptDirectoryName = 'receipts'
const restoreJournalDirectoryName = 'restore-journals'
const lockFileName = 'transaction.lock'
const maximumAuditAttempts = 32
const streamBufferBytes = 1024 * 1024
const defaultStableWindowMs = 250
const defaultSnapshotAttempts = 3
const pairRevisionPattern = /^pair-v1:[a-f0-9]{64}$/
const sha256Pattern = /^[a-f0-9]{64}$/
const persistedControlFileMaximumBytes = 16_384
const maximumRestoreJournalEntries = 64
const restoreJournalSlotFilePattern = /^restore-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-([ab])\.json$/
const restoreJournalCandidateFilePattern = /^restore-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-([ab])\.candidate\.json$/

const requestIdSchema = z.string().uuid().transform((value) => value.toLocaleLowerCase('en-US'))
const pairRevisionSchema = z.string().regex(pairRevisionPattern)
const backupRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  saveName: saveNameSchema,
  dryRun: z.boolean().optional().default(false)
})
const restoreRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  backupId: backupIdSchema,
  expectedRevision: pairRevisionSchema,
  protectionRequestId: requestIdSchema,
  dryRun: z.boolean().optional().default(false)
}).superRefine((value, context) => {
  if (value.backupId === `tx-${value.protectionRequestId}`) {
    context.addIssue({ code: 'custom', message: 'protection request conflicts with source backup' })
  }
})
const runtimeStoppedEvidenceSchema = z.strictObject({
  protocol: z.literal('DYSON_CONTROL_RUNTIME_V1'),
  expected: z.literal('stopped'),
  state: z.literal('matched'),
  processVerified: z.literal(true),
  gamePortListening: z.literal(false)
})
const restoreReceiptSchema = z.strictObject({
  schemaVersion: z.literal(schemaVersion),
  requestId: requestIdSchema,
  backupId: backupIdSchema,
  protectionBackupId: backupIdSchema,
  saveName: saveNameSchema,
  beforeRevision: pairRevisionSchema,
  afterRevision: pairRevisionSchema,
  pairBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  completedAt: z.string().datetime({ offset: true })
})
const transactionLeaseSchema = z.strictObject({
  format: z.literal('dyson-control-save-transaction-lease'),
  schemaVersion: z.literal(schemaVersion),
  host: z.string().min(1).max(255),
  bootId: z.string().min(1).max(64),
  pid: z.number().int().positive(),
  instanceId: z.string().uuid(),
  requestId: requestIdSchema,
  acquiredAt: z.string().datetime({ offset: true })
})
const restoreJournalPhaseSchema = z.enum([
  'prepared',
  'original-dsv-move-intent',
  'original-dsv-moved',
  'original-server-move-intent',
  'original-server-moved',
  'restored-dsv-install-intent',
  'restored-dsv-installed',
  'restored-server-install-intent',
  'restored-server-installed',
  'receipt-write-intent',
  'gc-pending',
  'recovery-dsv-install-intent',
  'recovery-dsv-installed',
  'recovery-server-install-intent',
  'recovery-server-installed',
  'rolled-back',
  'recovery-required'
])
const restoreJournalSchema = z.strictObject({
  format: z.literal('dyson-control-save-restore-journal-envelope'),
  schemaVersion: z.literal(schemaVersion),
  slot: z.enum(['a', 'b']),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  previousDigest: z.string().regex(sha256Pattern).nullable(),
  requestId: requestIdSchema,
  backupId: backupIdSchema,
  protectionBackupId: backupIdSchema,
  saveName: saveNameSchema,
  beforeRevision: pairRevisionSchema,
  afterRevision: pairRevisionSchema,
  phase: restoreJournalPhaseSchema,
  recoveryFromPhase: restoreJournalPhaseSchema.optional(),
  updatedAt: z.string().datetime({ offset: true }),
  digest: z.string().regex(sha256Pattern)
}).superRefine((value, context) => {
  if ((value.phase === 'recovery-required') !== (value.recoveryFromPhase !== undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'recoveryFromPhase must exist only for recovery-required records'
    })
  }
})

export type SaveTransactionErrorCode =
  | 'SAVE_REQUEST_INVALID'
  | 'SAVE_ROOT_UNAVAILABLE'
  | 'SAVE_TRANSACTION_STORAGE_UNAVAILABLE'
  | 'SAVE_TRANSACTION_BUSY'
  | 'SAVE_JOURNAL_MAINTENANCE_REQUIRED'
  | 'SAVE_PAIR_INCOMPLETE'
  | 'SAVE_PAIR_REDIRECTED'
  | 'SAVE_PAIR_CHANGED'
  | 'SAVE_BACKUP_CORRUPT'
  | 'SAVE_IDEMPOTENCY_CONFLICT'
  | 'SAVE_SERVICE_NOT_STOPPED'
  | 'SAVE_REVISION_CONFLICT'
  | 'SAVE_COMMIT_FAILED'
  | 'SAVE_COMMIT_CLEANUP_PENDING'
  | 'SAVE_COMMIT_VERIFICATION_FAILED'
  | 'SAVE_ROLLBACK_FAILED'

export type SaveTransactionStatus =
  | 'dry-run'
  | 'succeeded'
  | 'busy'
  | 'rejected'
  | 'revision-conflict'
  | 'failed'
  | 'rolled-back'
  | 'rollback-failed'

type RestoreJournalPhase = z.infer<typeof restoreJournalPhaseSchema>

export type SaveTransactionHookPhase =
  | 'after-lease-created-before-write'
  | 'backup-staged'
  | 'before-backup-publish'
  | 'protection-created'
  | 'restore-staged'
  | 'before-restore-commit'
  | 'after-original-dsv-moved'
  | 'after-original-server-moved'
  | 'after-restored-dsv-installed'
  | 'after-restored-server-installed'
  | 'before-restore-verify'
  | 'before-rollback'
  | 'after-recovery-stage-reset'
  | 'after-recovery-staged'
  | 'before-recovery-dsv-target-remove'
  | 'after-recovery-dsv-target-removed'
  | 'before-recovery-dsv-install'
  | 'after-recovery-dsv-installed'
  | 'before-recovery-server-target-remove'
  | 'after-recovery-server-target-removed'
  | 'before-recovery-server-install'
  | 'after-recovery-server-installed'
  | 'after-receipt'
  | 'after-first-rollback-cleanup'
  | 'before-stage-rmdir'
  | 'before-final-audit-store'
  | `after-journal-${RestoreJournalPhase}-sync`
  | 'before-journal-slot-replace'
  | 'after-journal-slot-replace'
  | 'after-journal-slot-published'

/** Test-only hooks receive fixed phase names and never paths, contents, or hashes. */
export interface SaveTransactionTestHooks {
  onPhase?: (phase: SaveTransactionHookPhase) => void | Promise<void>
}

export interface RuntimeStoppedEvidence {
  protocol: 'DYSON_CONTROL_RUNTIME_V1'
  expected: 'stopped'
  state: 'matched'
  processVerified: true
  gamePortListening: false
}

export interface SaveTransactionServiceOptions {
  /** Trusted server-side save directory; never populate this from an HTTP request. */
  saveRoot: string
  /** Trusted server-side protection-point directory; never populate this from an HTTP request. */
  backupRoot: string
  /** Required fixed-adapter gate. Every restore invokes it before protection and again before commit. */
  verifyServiceStopped: () => Promise<unknown>
  /** @internal Deterministic fault injection for tests only. */
  testHooks?: SaveTransactionTestHooks
  /** @internal Deterministic clock for tests only. */
  now?: () => Date
  /** @internal Shortened only by tests; production defaults to a non-zero stable window. */
  stableWindowMs?: number
  /** @internal Deterministic retry count for tests. */
  snapshotAttempts?: number
  /** @internal Replaces sleeping in tests. */
  wait?: (milliseconds: number) => Promise<void>
}

export interface BackupSavePairRequest {
  requestId: string
  saveName: string
  dryRun?: boolean
}

export interface RestoreSavePairRequest {
  requestId: string
  backupId: string
  expectedRevision: string
  protectionRequestId: string
  dryRun?: boolean
}

export interface SaveTransactionAuditRecord {
  schemaVersion: 1
  requestId: string
  action: 'save.backup' | 'save.restore'
  status: SaveTransactionStatus | 'prepared'
  dryRun: boolean
  backupId: string
  protectionBackupId?: string
  reused: boolean
  rollback: 'not-required' | 'succeeded' | 'failed'
  cleanupPending: boolean
  maintenanceRequired: boolean
  startedAt: string
  finishedAt: string
  errorCode?: SaveTransactionErrorCode
}

export interface SaveTransactionResult {
  schemaVersion: 1
  requestId: string
  operation: 'backup' | 'restore'
  status: SaveTransactionStatus
  dryRun: boolean
  backupId: string
  protectionBackupId?: string
  reused: boolean
  rollback: 'not-required' | 'succeeded' | 'failed'
  pairBytes: number
  cleanupPending: boolean
  maintenanceRequired: boolean
  beforeRevision?: string
  afterRevision?: string
  errorCode?: SaveTransactionErrorCode
  auditStored: boolean
  audit: SaveTransactionAuditRecord
}

export interface SavePairRevision {
  schemaVersion: 1
  saveName: string
  revision: string
  dsvBytes: number
  serverBytes: number
  totalBytes: number
}

interface PreparedRoots {
  saveRoot: string
  backupRoot: string
  controlRoot: string
  auditRoot: string
  receiptRoot: string
  restoreJournalRoot: string
  lockPath: string
  key: string
  journalHook?: (phase: SaveTransactionHookPhase) => Promise<void>
}

interface AcquiredLock {
  key: string
  path: string
  handle: FileHandle
  instanceId: string
}

type RestoreJournal = z.infer<typeof restoreJournalSchema>

interface FileEvidence {
  bytes: number
  sha256: string
  modifiedMs: number
  changedMs: number
}

interface PairEvidence {
  saveName: string
  dsv: FileEvidence
  server: FileEvidence
  revision: string
  totalBytes: number
}

interface TrustedBackup {
  backupId: string
  directory: string
  manifest: BackupManifestV1
  pair: PairEvidence
}

interface CreatedBackup {
  backupId: string
  pair: PairEvidence
  reused: boolean
}

const inProcessLocks = new Set<string>()
const processBootIdentity = randomUUID()

export class SaveTransactionError extends Error {
  constructor(readonly code: SaveTransactionErrorCode) {
    super(code)
    this.name = 'SaveTransactionError'
  }
}

export class SaveTransactionService {
  readonly #configuredSaveRoot: string
  readonly #configuredBackupRoot: string
  readonly #verifyServiceStopped: () => Promise<unknown>
  readonly #hooks: SaveTransactionTestHooks | undefined
  readonly #now: () => Date
  readonly #stableWindowMs: number
  readonly #snapshotAttempts: number
  readonly #wait: (milliseconds: number) => Promise<void>

  constructor(options: SaveTransactionServiceOptions) {
    if (!options || !nonBlank(options.saveRoot) || !nonBlank(options.backupRoot) ||
        typeof options.verifyServiceStopped !== 'function') {
      throw new SaveTransactionError('SAVE_ROOT_UNAVAILABLE')
    }
    if (options.stableWindowMs !== undefined &&
        (!Number.isInteger(options.stableWindowMs) || options.stableWindowMs < 0 || options.stableWindowMs > 5_000)) {
      throw new SaveTransactionError('SAVE_REQUEST_INVALID')
    }
    if (options.snapshotAttempts !== undefined &&
        (!Number.isInteger(options.snapshotAttempts) || options.snapshotAttempts < 1 || options.snapshotAttempts > 5)) {
      throw new SaveTransactionError('SAVE_REQUEST_INVALID')
    }
    this.#configuredSaveRoot = path.resolve(options.saveRoot)
    this.#configuredBackupRoot = path.resolve(options.backupRoot)
    this.#verifyServiceStopped = options.verifyServiceStopped
    this.#hooks = options.testHooks
    this.#now = options.now ?? (() => new Date())
    this.#stableWindowMs = options.stableWindowMs ?? defaultStableWindowMs
    this.#snapshotAttempts = options.snapshotAttempts ?? defaultSnapshotAttempts
    this.#wait = options.wait ?? (async (milliseconds) => {
      await new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
    })
  }

  async inspect(saveName: string): Promise<SavePairRevision> {
    const parsedName = parseSaveName(saveName)
    const saveRoot = await prepareNormalRoot(this.#configuredSaveRoot)
    const pair = await this.#readStablePair(saveRoot, parsedName)
    return publicRevision(pair)
  }

  async backup(input: BackupSavePairRequest): Promise<SaveTransactionResult> {
    const request = parseBackupRequest(input)
    const backupId = `tx-${request.requestId}`
    const startedAt = this.#now().toISOString()
    let roots: PreparedRoots | null = null
    let lock: AcquiredLock | null = null
    try {
      roots = await prepareRoots(this.#configuredSaveRoot, this.#configuredBackupRoot)
      roots.journalHook = this.#phase.bind(this)
      lock = await acquireExclusiveLock(roots, request.requestId, startedAt)
      if (lock === null) {
        return makeResult({
          requestId: request.requestId,
          operation: 'backup',
          status: 'busy',
          dryRun: request.dryRun,
          backupId,
          reused: false,
          rollback: 'not-required',
          pairBytes: 0,
          startedAt,
          finishedAt: this.#now().toISOString(),
          errorCode: 'SAVE_TRANSACTION_BUSY',
          auditStored: false
        })
      }
      const unresolved = await inspectUnresolvedRestoreJournals(roots, this.#readStablePair.bind(this))
      if (unresolved.maintenanceRequired) {
        return makeResult({
          requestId: request.requestId,
          operation: 'backup',
          status: 'failed',
          dryRun: request.dryRun,
          backupId,
          reused: false,
          rollback: 'not-required',
          pairBytes: 0,
          maintenanceRequired: true,
          startedAt,
          finishedAt: this.#now().toISOString(),
          errorCode: 'SAVE_JOURNAL_MAINTENANCE_REQUIRED',
          auditStored: false
        })
      }
      if (unresolved.blocked || unresolved.journal !== null) {
        return makeResult({
          requestId: request.requestId,
          operation: 'backup',
          status: 'busy',
          dryRun: request.dryRun,
          backupId,
          reused: false,
          rollback: 'not-required',
          pairBytes: 0,
          startedAt,
          finishedAt: this.#now().toISOString(),
          errorCode: 'SAVE_TRANSACTION_BUSY',
          auditStored: false
        })
      }

      const existing = await readExistingBackup(roots.backupRoot, backupId, this.#readStablePair.bind(this))
      if (existing !== null) {
        if (existing.manifest.saveName !== request.saveName) {
          return await this.#finish(roots, {
            requestId: request.requestId,
            operation: 'backup',
            status: 'rejected',
            dryRun: request.dryRun,
            backupId,
            reused: false,
            rollback: 'not-required',
            pairBytes: 0,
            startedAt,
            errorCode: 'SAVE_IDEMPOTENCY_CONFLICT'
          })
        }
        return await this.#finish(roots, {
          requestId: request.requestId,
          operation: 'backup',
          status: request.dryRun ? 'dry-run' : 'succeeded',
          dryRun: request.dryRun,
          backupId,
          reused: true,
          rollback: 'not-required',
          pairBytes: existing.pair.totalBytes,
          startedAt,
          beforeRevision: existing.pair.revision,
          afterRevision: existing.pair.revision
        })
      }

      if (request.dryRun) {
        const current = await this.#readStablePair(roots.saveRoot, request.saveName)
        return await this.#finish(roots, {
          requestId: request.requestId,
          operation: 'backup',
          status: 'dry-run',
          dryRun: true,
          backupId,
          reused: false,
          rollback: 'not-required',
          pairBytes: current.totalBytes,
          startedAt,
          beforeRevision: current.revision,
          afterRevision: current.revision
        })
      }

      await this.#storePreparedAudit(roots, {
        requestId: request.requestId,
        operation: 'backup',
        dryRun: false,
        backupId,
        startedAt
      })
      const created = await this.#createBackupLocked(
        roots,
        request.requestId,
        request.saveName
      )
      return await this.#finish(roots, {
        requestId: request.requestId,
        operation: 'backup',
        status: 'succeeded',
        dryRun: false,
        backupId,
        reused: created.reused,
        rollback: 'not-required',
        pairBytes: created.pair.totalBytes,
        startedAt,
        beforeRevision: created.pair.revision,
        afterRevision: created.pair.revision
      }, 1)
    } catch (error) {
      const code = safeErrorCode(error)
      return await this.#finishIfPossible(roots, {
        requestId: request.requestId,
        operation: 'backup',
        status: code === 'SAVE_PAIR_INCOMPLETE' || code === 'SAVE_PAIR_REDIRECTED' ||
          code === 'SAVE_IDEMPOTENCY_CONFLICT' ? 'rejected' : 'failed',
        dryRun: request.dryRun,
        backupId,
        reused: false,
        rollback: 'not-required',
        pairBytes: 0,
        startedAt,
        errorCode: code
      })
    } finally {
      if (lock !== null) await releaseExclusiveLock(lock)
    }
  }

  async restore(input: RestoreSavePairRequest): Promise<SaveTransactionResult> {
    const request = parseRestoreRequest(input)
    const protectionBackupId = `tx-${request.protectionRequestId}`
    const startedAt = this.#now().toISOString()
    const readOnlyReplay = await probeCommittedRestoreReceipt(
      this.#configuredSaveRoot,
      request.requestId
    )
    if (readOnlyReplay.receipt !== null && !readOnlyReplay.requestJournalPresent) {
      const receipt = readOnlyReplay.receipt
      const conflicts = receipt.backupId !== request.backupId ||
        receipt.protectionBackupId !== protectionBackupId ||
        receipt.beforeRevision !== request.expectedRevision ||
        request.dryRun
      if (conflicts) {
        return makeResult({
          requestId: request.requestId,
          operation: 'restore',
          status: 'rejected',
          dryRun: request.dryRun,
          backupId: request.backupId,
          protectionBackupId,
          reused: false,
          rollback: 'not-required',
          pairBytes: 0,
          startedAt,
          finishedAt: this.#now().toISOString(),
          errorCode: 'SAVE_IDEMPOTENCY_CONFLICT',
          auditStored: false
        })
      }
      // A validated immutable receipt is the self-contained committed terminal.
      // With no request journal there is no maintenance work to mutate, so replay
      // deliberately avoids root preparation, leases, backups, live data and the
      // runtime-stopped adapter.
      return makeResult({
        requestId: request.requestId,
        operation: 'restore',
        status: 'succeeded',
        dryRun: false,
        backupId: receipt.backupId,
        protectionBackupId: receipt.protectionBackupId,
        reused: true,
        rollback: 'not-required',
        pairBytes: receipt.pairBytes,
        startedAt,
        finishedAt: this.#now().toISOString(),
        beforeRevision: receipt.beforeRevision,
        afterRevision: receipt.afterRevision,
        auditStored: true
      })
    }
    let roots: PreparedRoots | null = null
    let lock: AcquiredLock | null = null
    let pairBytes = 0
    let beforeRevision: string | undefined
    let mutationMayHaveOccurred = false
    let rollback: SaveTransactionResult['rollback'] = 'not-required'

    try {
      roots = await prepareRoots(this.#configuredSaveRoot, this.#configuredBackupRoot)
      roots.journalHook = this.#phase.bind(this)
      lock = await acquireExclusiveLock(roots, request.requestId, startedAt)
      if (lock === null) {
        return makeResult({
          requestId: request.requestId,
          operation: 'restore',
          status: 'busy',
          dryRun: request.dryRun,
          backupId: request.backupId,
          protectionBackupId,
          reused: false,
          rollback,
          pairBytes,
          startedAt,
          finishedAt: this.#now().toISOString(),
          errorCode: 'SAVE_TRANSACTION_BUSY',
          auditStored: false
        })
      }

      const receipt = await readRestoreReceipt(roots, request.requestId)
      if (receipt !== null &&
          (receipt.backupId !== request.backupId || receipt.protectionBackupId !== protectionBackupId ||
           receipt.beforeRevision !== request.expectedRevision || request.dryRun)) {
        throw new SaveTransactionError('SAVE_IDEMPOTENCY_CONFLICT')
      }
      const unresolved = await inspectUnresolvedRestoreJournals(roots, this.#readStablePair.bind(this))
      if (unresolved.maintenanceRequired) {
        if (receipt !== null) {
          // The immutable receipt is the business commit point even when the
          // remaining journal cannot be safely interpreted. Preserve all
          // evidence and expose maintenance instead of reclassifying the
          // committed restore as a rollback or an ordinary failure.
          return await this.#finish(roots, {
            requestId: request.requestId,
            operation: 'restore',
            status: 'succeeded',
            dryRun: false,
            backupId: receipt.backupId,
            protectionBackupId: receipt.protectionBackupId,
            reused: true,
            rollback: 'not-required',
            pairBytes: receipt.pairBytes,
            cleanupPending: true,
            maintenanceRequired: true,
            startedAt,
            beforeRevision: receipt.beforeRevision,
            afterRevision: receipt.afterRevision,
            errorCode: 'SAVE_COMMIT_CLEANUP_PENDING'
          }, 1)
        }
        return makeResult({
          requestId: request.requestId,
          operation: 'restore',
          status: 'failed',
          dryRun: request.dryRun,
          backupId: request.backupId,
          protectionBackupId,
          reused: false,
          rollback,
          pairBytes,
          maintenanceRequired: true,
          startedAt,
          finishedAt: this.#now().toISOString(),
          errorCode: 'SAVE_JOURNAL_MAINTENANCE_REQUIRED',
          auditStored: false
        })
      }
      let interruptedJournal = unresolved.journal
      if (unresolved.blocked ||
          (interruptedJournal !== null &&
           (interruptedJournal.requestId !== request.requestId ||
            interruptedJournal.backupId !== request.backupId ||
            interruptedJournal.protectionBackupId !== protectionBackupId ||
            interruptedJournal.beforeRevision !== request.expectedRevision))) {
        return makeResult({
          requestId: request.requestId,
          operation: 'restore',
          status: 'busy',
          dryRun: request.dryRun,
          backupId: request.backupId,
          protectionBackupId,
          reused: false,
          rollback,
          pairBytes,
          startedAt,
          finishedAt: this.#now().toISOString(),
          errorCode: 'SAVE_TRANSACTION_BUSY',
          auditStored: false
        })
      }
      if (interruptedJournal !== null && unresolved.scan?.latest.kind === 'candidate') {
        await publishRestoreJournalCandidate(roots, unresolved.scan)
        interruptedJournal = unresolved.scan.latest.journal
      }
      if (receipt !== null) {
        if (interruptedJournal !== null) {
          return await this.#reconcileRestoreJournal(roots, request, interruptedJournal, startedAt, receipt)
        }
        return await this.#finish(roots, {
          requestId: request.requestId,
          operation: 'restore',
          status: 'succeeded',
          dryRun: false,
          backupId: receipt.backupId,
          protectionBackupId: receipt.protectionBackupId,
          reused: true,
          rollback: 'not-required',
          pairBytes: receipt.pairBytes,
          startedAt,
          beforeRevision: receipt.beforeRevision,
          afterRevision: receipt.afterRevision
        }, 1)
      }
      if (interruptedJournal !== null) {
        if (request.dryRun) throw new SaveTransactionError('SAVE_IDEMPOTENCY_CONFLICT')
        return await this.#reconcileRestoreJournal(roots, request, interruptedJournal, startedAt, null)
      }

      const backup = await readTrustedBackup(roots.backupRoot, request.backupId, this.#readStablePair.bind(this))
      pairBytes = backup.pair.totalBytes
      await this.#assertServiceStopped()

      const current = await this.#readStablePair(roots.saveRoot, backup.manifest.saveName)
      beforeRevision = current.revision
      if (current.revision !== request.expectedRevision) {
        return await this.#finish(roots, {
          requestId: request.requestId,
          operation: 'restore',
          status: 'revision-conflict',
          dryRun: request.dryRun,
          backupId: request.backupId,
          protectionBackupId,
          reused: false,
          rollback,
          pairBytes,
          startedAt,
          beforeRevision,
          errorCode: 'SAVE_REVISION_CONFLICT'
        })
      }

      if (request.dryRun) {
        return await this.#finish(roots, {
          requestId: request.requestId,
          operation: 'restore',
          status: 'dry-run',
          dryRun: true,
          backupId: request.backupId,
          protectionBackupId,
          reused: false,
          rollback,
          pairBytes,
          startedAt,
          beforeRevision,
          afterRevision: backup.pair.revision
        })
      }

      try {
        await assertInitialRestoreArtifactsAbsent(roots.saveRoot, request.requestId)
      } catch {
        // A fixed restore/rollback/GC pathname without this request's durable
        // journal cannot be claimed. Fail before prepared audit or protection
        // backup creation and leave the entire namespace untouched.
        return makeResult({
          requestId: request.requestId,
          operation: 'restore',
          status: 'failed',
          dryRun: false,
          backupId: request.backupId,
          protectionBackupId,
          reused: false,
          rollback: 'not-required',
          pairBytes,
          startedAt,
          finishedAt: this.#now().toISOString(),
          beforeRevision,
          errorCode: 'SAVE_TRANSACTION_STORAGE_UNAVAILABLE',
          auditStored: false
        })
      }

      await this.#storePreparedAudit(roots, {
        requestId: request.requestId,
        operation: 'restore',
        dryRun: false,
        backupId: request.backupId,
        protectionBackupId,
        startedAt
      })
      const protection = await this.#createBackupLocked(
        roots,
        request.protectionRequestId,
        backup.manifest.saveName,
        request.expectedRevision
      )
      if (protection.pair.revision !== request.expectedRevision) {
        throw new SaveTransactionError('SAVE_REVISION_CONFLICT')
      }
      const trustedProtection = await readTrustedBackup(
        roots.backupRoot,
        protectionBackupId,
        this.#readStablePair.bind(this)
      )
      await this.#phase('protection-created')

      const stage = restoreStagePaths(roots.saveRoot, request.requestId)
      const rollbackPaths = restoreRollbackPaths(roots.saveRoot, request.requestId)
      const targetPaths = pairPaths(roots.saveRoot, backup.manifest.saveName)
      let durableCommitReached = false
      let journal: RestoreJournal | null = null
      let stageCreated = false
      try {
        await assertInitialRestoreArtifactsAbsent(roots.saveRoot, request.requestId)
        journal = await createRestoreJournal(roots, {
          requestId: request.requestId,
          backupId: request.backupId,
          protectionBackupId,
          saveName: backup.manifest.saveName,
          beforeRevision: request.expectedRevision,
          afterRevision: backup.pair.revision,
          phase: 'prepared',
          updatedAt: this.#now().toISOString()
        })
        await createRestoreStage(roots.saveRoot, request.requestId)
        stageCreated = true
        await copyBackupIntoRestoreStage(backup, stage)
        await this.#phase('restore-staged')
        await this.#assertServiceStopped()
        const immediatelyBeforeCommit = await this.#readStablePair(roots.saveRoot, backup.manifest.saveName)
        if (immediatelyBeforeCommit.revision !== request.expectedRevision) {
          throw new SaveTransactionError('SAVE_REVISION_CONFLICT')
        }
        await this.#phase('before-restore-commit')

        await assertNormalFile(targetPaths.dsv)
        await assertNormalFile(targetPaths.server)
        await assertNormalFile(stage.dsv)
        await assertNormalFile(stage.server)
        await assertPathAbsent(rollbackPaths.dsv)
        await assertPathAbsent(rollbackPaths.server)

        mutationMayHaveOccurred = true
        journal = await advanceRestoreJournal(roots, journal, 'original-dsv-move-intent', this.#now())
        await rename(targetPaths.dsv, rollbackPaths.dsv)
        journal = await advanceRestoreJournal(roots, journal, 'original-dsv-moved', this.#now())
        await this.#phase('after-original-dsv-moved')
        journal = await advanceRestoreJournal(roots, journal, 'original-server-move-intent', this.#now())
        await rename(targetPaths.server, rollbackPaths.server)
        journal = await advanceRestoreJournal(roots, journal, 'original-server-moved', this.#now())
        await this.#phase('after-original-server-moved')
        journal = await advanceRestoreJournal(roots, journal, 'restored-dsv-install-intent', this.#now())
        await rename(stage.dsv, targetPaths.dsv)
        journal = await advanceRestoreJournal(roots, journal, 'restored-dsv-installed', this.#now())
        await this.#phase('after-restored-dsv-installed')
        journal = await advanceRestoreJournal(roots, journal, 'restored-server-install-intent', this.#now())
        await rename(stage.server, targetPaths.server)
        journal = await advanceRestoreJournal(roots, journal, 'restored-server-installed', this.#now())
        await this.#phase('after-restored-server-installed')
        await this.#phase('before-restore-verify')

        const restored = await this.#readStablePair(roots.saveRoot, backup.manifest.saveName)
        if (restored.revision !== backup.pair.revision || !samePairContent(restored, backup.pair)) {
          throw new SaveTransactionError('SAVE_COMMIT_VERIFICATION_FAILED')
        }
        journal = await advanceRestoreJournal(roots, journal, 'receipt-write-intent', this.#now())
        await writeRestoreReceipt(roots, {
          schemaVersion,
          requestId: request.requestId,
          backupId: request.backupId,
          protectionBackupId,
          saveName: backup.manifest.saveName,
          beforeRevision: request.expectedRevision,
          afterRevision: restored.revision,
          pairBytes: restored.totalBytes,
          completedAt: this.#now().toISOString()
        })
        // The durable receipt is the restore commit point. Journal advancement,
        // audit storage, and artifact deletion are retryable post-commit work
        // and must never re-enter business rollback.
        durableCommitReached = true
      } catch (error) {
        if (durableCommitReached) throw error
        if (journal === null) {
          // The journal is published before any request-owned restore artifact.
          // If publication itself failed, there is no durable ownership proof
          // authorizing cleanup of fixed stage/rollback pathnames.
          throw error
        }
        if (!stageCreated) {
          journal = await forceRestoreJournalPhase(roots, journal, 'recovery-required', this.#now())
            .catch(() => journal)
          return await this.#finish(roots, {
            requestId: request.requestId,
            operation: 'restore',
            status: 'rollback-failed',
            dryRun: false,
            backupId: request.backupId,
            protectionBackupId,
            reused: false,
            rollback: 'failed',
            pairBytes,
            maintenanceRequired: true,
            startedAt,
            beforeRevision,
            errorCode: 'SAVE_ROLLBACK_FAILED'
          }, 1)
        }
        try {
          let rolledBack: PairEvidence
          if (mutationMayHaveOccurred) {
            await this.#phase('before-rollback')
            if (!await restoreLayoutAllowsProtectionRecovery(
              journal.phase,
              targetPaths,
              rollbackPaths,
              stage,
              protection.pair,
              backup.pair
            )) {
              throw new SaveTransactionError('SAVE_ROLLBACK_FAILED')
            }
            const recovered = await this.#recoverProtectionPair(
              roots,
              request.requestId,
              journal,
              trustedProtection,
              backup.pair,
              targetPaths
            )
            journal = recovered.journal
            rolledBack = recovered.recovered
          } else {
            rolledBack = await this.#readStablePair(roots.saveRoot, backup.manifest.saveName)
            if (rolledBack.revision !== request.expectedRevision || !samePairContent(rolledBack, protection.pair)) {
              throw new SaveTransactionError('SAVE_ROLLBACK_FAILED')
            }
          }
          rollback = 'succeeded'
          journal = await forceRestoreJournalPhase(roots, journal, 'rolled-back', this.#now())
          const cleanup = await this.#quarantineAndDeleteRestoreArtifacts(
            roots.saveRoot,
            request.requestId,
            stage,
            rollbackPaths,
            protection.pair,
            backup.pair,
            'rolled-back'
          )
          if (cleanup.state === 'unsafe') throw new SaveTransactionError('SAVE_ROLLBACK_FAILED')
          return await this.#finishJournaledRestore(roots, journal, {
            requestId: request.requestId,
            operation: 'restore',
            status: 'rolled-back',
            dryRun: false,
            backupId: request.backupId,
            protectionBackupId,
            reused: false,
            rollback,
            pairBytes,
            startedAt,
            beforeRevision,
            afterRevision: rolledBack.revision,
            errorCode: restoreFailureCode(error)
          }, cleanup)
        } catch {
          rollback = 'failed'
          const durableJournal = await readRestoreJournal(roots, request.requestId).catch(() => null)
          const remainsRecoverable = durableJournal !== null && durableJournal.phase !== 'recovery-required' &&
            await restoreLayoutAllowsProtectionRecovery(
              durableJournal.phase,
              targetPaths,
              rollbackPaths,
              stage,
              protection.pair,
              backup.pair
            )
          if (!remainsRecoverable && durableJournal !== null) {
            journal = await forceRestoreJournalPhase(roots, durableJournal, 'recovery-required', this.#now())
              .catch(() => durableJournal)
          }
          return await this.#finish(roots, {
            requestId: request.requestId,
            operation: 'restore',
            status: 'rollback-failed',
            dryRun: false,
            backupId: request.backupId,
            protectionBackupId,
            reused: false,
            rollback,
            pairBytes,
            startedAt,
            beforeRevision,
            errorCode: 'SAVE_ROLLBACK_FAILED'
          }, 1)
        }
      }
      if (!durableCommitReached) throw new SaveTransactionError('SAVE_COMMIT_FAILED')
      if (journal !== null) {
        journal = await forceRestoreJournalPhase(roots, journal, 'gc-pending', this.#now())
          .catch(() => journal)
      }
      const cleanup = await this.#quarantineAndDeleteRestoreArtifacts(
        roots.saveRoot,
        request.requestId,
        stage,
        rollbackPaths,
        protection.pair,
        backup.pair,
        'committed'
      )
      if (journal === null) throw new SaveTransactionError('SAVE_TRANSACTION_STORAGE_UNAVAILABLE')
      return await this.#finishJournaledRestore(roots, journal, {
        requestId: request.requestId,
        operation: 'restore',
        status: 'succeeded',
        dryRun: false,
        backupId: request.backupId,
        protectionBackupId,
        reused: false,
        rollback,
        pairBytes,
        startedAt,
        beforeRevision,
        afterRevision: backup.pair.revision
      }, cleanup)
    } catch (error) {
      const code = safeErrorCode(error)
      const recoveryRequired = code === 'SAVE_ROLLBACK_FAILED'
      const maintenanceRequired = code === 'SAVE_JOURNAL_MAINTENANCE_REQUIRED'
      return await this.#finishIfPossible(roots, {
        requestId: request.requestId,
        operation: 'restore',
        status: recoveryRequired
          ? 'rollback-failed'
          : code === 'SAVE_REVISION_CONFLICT'
          ? 'revision-conflict'
          : code === 'SAVE_SERVICE_NOT_STOPPED' || code === 'SAVE_PAIR_INCOMPLETE' ||
              code === 'SAVE_PAIR_REDIRECTED' || code === 'SAVE_BACKUP_CORRUPT' ||
              code === 'SAVE_IDEMPOTENCY_CONFLICT'
            ? 'rejected'
            : 'failed',
        dryRun: request.dryRun,
        backupId: request.backupId,
        protectionBackupId,
        reused: false,
        rollback: recoveryRequired ? 'failed' : rollback,
        pairBytes,
        maintenanceRequired,
        startedAt,
        beforeRevision,
        errorCode: code
      })
    } finally {
      if (lock !== null) await releaseExclusiveLock(lock)
    }
  }

  async #createBackupLocked(
    roots: PreparedRoots,
    requestId: string,
    saveName: string,
    requiredSourceRevision?: string
  ): Promise<CreatedBackup> {
    const backupId = `tx-${requestId}`
    const existing = await readExistingBackup(roots.backupRoot, backupId, this.#readStablePair.bind(this))
    if (existing !== null) {
      if (existing.manifest.saveName !== saveName ||
          (requiredSourceRevision !== undefined && existing.pair.revision !== requiredSourceRevision)) {
        throw new SaveTransactionError('SAVE_IDEMPOTENCY_CONFLICT')
      }
      return { backupId, pair: existing.pair, reused: true }
    }

    const stage = await createBackupStage(roots.backupRoot, requestId, saveName)
    let published = false
    try {
      const sourcePaths = pairPaths(roots.saveRoot, saveName)
      let stablePair: PairEvidence | null = null
      for (let attempt = 0; attempt < this.#snapshotAttempts; attempt += 1) {
        await cleanupBackupStageFiles(stage)
        const beforeDsv = await assertNormalFile(sourcePaths.dsv)
        const beforeServer = await assertNormalFile(sourcePaths.server)
        const copiedDsv = await copyAndHashStableFile(sourcePaths.dsv, stage.dsv)
        const copiedServer = await copyAndHashStableFile(sourcePaths.server, stage.server)
        await this.#wait(this.#stableWindowMs)
        const after = await this.#readPairOnce(roots.saveRoot, saveName)
        const copied = makePairEvidence(saveName, copiedDsv, copiedServer)
        if (sameFileSnapshot(beforeDsv, copiedDsv) && sameFileSnapshot(beforeServer, copiedServer) &&
            samePairContent(after, copied)) {
          stablePair = copied
          break
        }
      }
      if (stablePair === null) throw new SaveTransactionError('SAVE_PAIR_CHANGED')
      if (requiredSourceRevision !== undefined && stablePair.revision !== requiredSourceRevision) {
        throw new SaveTransactionError('SAVE_REVISION_CONFLICT')
      }

      const manifest: BackupManifestV1 = {
        protocol: BACKUP_MANIFEST_PROTOCOL,
        schemaVersion,
        requestId,
        createdAt: this.#now().toISOString(),
        saveName,
        files: [
          { name: `${saveName}.dsv`, bytes: stablePair.dsv.bytes, sha256: stablePair.dsv.sha256 },
          { name: `${saveName}.server`, bytes: stablePair.server.bytes, sha256: stablePair.server.sha256 }
        ]
      }
      backupManifestV1Schema.parse(manifest)
      await writeManifest(stage.directory, manifest)
      await this.#phase('backup-staged')
      await this.#phase('before-backup-publish')
      const finalDirectory = safeImmediateChild(roots.backupRoot, backupId)
      await rename(stage.directory, finalDirectory)
      published = true
      const verified = await readTrustedBackupDirectory(
        finalDirectory,
        backupId,
        this.#readPairOnce.bind(this)
      )
      if (!samePairContent(verified.pair, stablePair)) throw new SaveTransactionError('SAVE_BACKUP_CORRUPT')
      return { backupId, pair: verified.pair, reused: false }
    } catch (error) {
      if (published) {
        await removeOwnedBackupDirectory(roots.backupRoot, backupId).catch(() => undefined)
      } else {
        await cleanupBackupStage(stage).catch(() => undefined)
      }
      throw error
    }
  }

  async #readStablePair(root: string, saveName: string): Promise<PairEvidence> {
    for (let attempt = 0; attempt < this.#snapshotAttempts; attempt += 1) {
      const evidence = await this.#readPairOnce(root, saveName)
      await this.#wait(this.#stableWindowMs)
      const paths = pairPaths(root, saveName)
      const afterDsv = await assertNormalFile(paths.dsv)
      const afterServer = await assertNormalFile(paths.server)
      if (sameFileSnapshot(afterDsv, evidence.dsv) && sameFileSnapshot(afterServer, evidence.server)) {
        return evidence
      }
    }
    throw new SaveTransactionError('SAVE_PAIR_CHANGED')
  }

  async #readPairOnce(root: string, saveName: string): Promise<PairEvidence> {
    const paths = pairPaths(root, saveName)
    const dsv = await hashStableNormalFile(paths.dsv)
    const server = await hashStableNormalFile(paths.server)
    return makePairEvidence(saveName, dsv, server)
  }

  async #assertServiceStopped(): Promise<RuntimeStoppedEvidence> {
    try {
      return runtimeStoppedEvidenceSchema.parse(await this.#verifyServiceStopped())
    } catch {
      throw new SaveTransactionError('SAVE_SERVICE_NOT_STOPPED')
    }
  }

  async #phase(phase: SaveTransactionHookPhase): Promise<void> {
    await this.#hooks?.onPhase?.(phase)
  }

  async #quarantineAndDeleteRestoreArtifacts(
    saveRoot: string,
    requestId: string,
    stage: RestoreStage,
    rollbackPaths: { dsv: string; server: string },
    before: PairEvidence,
    after: PairEvidence,
    mode: 'committed' | 'rolled-back'
  ): Promise<RestoreArtifactCleanupResult> {
    try {
      if (mode === 'committed') await this.#phase('after-receipt')
      return await quarantineAndDeleteOwnedRestoreArtifacts({
        saveRoot,
        requestId,
        stage,
        rollbackPaths,
        before,
        after,
        mode,
        afterFirstRollbackQuarantine: async () => {
          if (mode === 'committed') await this.#phase('after-first-rollback-cleanup')
        },
        beforeStageQuarantineDelete: async () => {
          if (mode === 'committed') await this.#phase('before-stage-rmdir')
        }
      })
    } catch {
      return { state: 'pending' }
    }
  }

  async #finishJournaledRestore(
    roots: PreparedRoots,
    journal: RestoreJournal,
    input: FinishResultInput,
    cleanup: RestoreArtifactCleanupResult
  ): Promise<SaveTransactionResult> {
    const finishPending = async (minimumAuditIndex: number): Promise<SaveTransactionResult> => this.#finish(roots, {
      ...input,
      cleanupPending: true,
      maintenanceRequired: true,
      ...(input.status === 'succeeded'
        ? { errorCode: 'SAVE_COMMIT_CLEANUP_PENDING' as const }
        : {})
    }, minimumAuditIndex)
    if (cleanup.state !== 'complete') return finishPending(1)

    const completed = await this.#finish(roots, {
      ...input,
      cleanupPending: false,
      maintenanceRequired: false
    }, 1)
    // The journal is also the retry token for a final audit write. Remove it
    // only after that audit is durable; a no-journal receipt replay is then
    // intentionally read-only.
    if (!completed.auditStored) return completed
    const removed = await removeRestoreJournal(roots, journal).then(() => true, () => false)
    return removed ? completed : finishPending(2)
  }

  async #recoverProtectionPair(
    roots: PreparedRoots,
    requestId: string,
    journal: RestoreJournal,
    protection: TrustedBackup,
    after: PairEvidence,
    targets: { dsv: string; server: string }
  ): Promise<{ journal: RestoreJournal; recovered: PairEvidence }> {
    journal = await forceRestoreJournalPhase(roots, journal, 'recovery-dsv-install-intent', this.#now())
    const recoveryStage = restoreStagePaths(roots.saveRoot, requestId)
    await resetRestoreStageForRecovery(recoveryStage, protection.pair, after)
    await this.#phase('after-recovery-stage-reset')
    await copyBackupIntoRestoreStage(protection, recoveryStage)
    await this.#phase('after-recovery-staged')
    await this.#phase('before-recovery-dsv-target-remove')
    await removeKnownRecoveryTarget(targets.dsv, [protection.pair.dsv, after.dsv])
    await this.#phase('after-recovery-dsv-target-removed')
    await this.#phase('before-recovery-dsv-install')
    await rename(recoveryStage.dsv, targets.dsv)
    await this.#phase('after-recovery-dsv-installed')
    journal = await forceRestoreJournalPhase(roots, journal, 'recovery-dsv-installed', this.#now())
    journal = await forceRestoreJournalPhase(roots, journal, 'recovery-server-install-intent', this.#now())
    await this.#phase('before-recovery-server-target-remove')
    await removeKnownRecoveryTarget(targets.server, [protection.pair.server, after.server])
    await this.#phase('after-recovery-server-target-removed')
    await this.#phase('before-recovery-server-install')
    await rename(recoveryStage.server, targets.server)
    await this.#phase('after-recovery-server-installed')
    journal = await forceRestoreJournalPhase(roots, journal, 'recovery-server-installed', this.#now())
    const recovered = await this.#readStablePair(roots.saveRoot, journal.saveName)
    if (recovered.revision !== protection.pair.revision || !samePairContent(recovered, protection.pair)) {
      throw new SaveTransactionError('SAVE_ROLLBACK_FAILED')
    }
    return { journal, recovered }
  }

  async #reconcileRestoreJournal(
    roots: PreparedRoots,
    request: z.infer<typeof restoreRequestSchema>,
    journal: RestoreJournal,
    startedAt: string,
    receipt: z.infer<typeof restoreReceiptSchema> | null
  ): Promise<SaveTransactionResult> {
    const protectionBackupId = `tx-${request.protectionRequestId}`
    if (journal.requestId !== request.requestId || journal.backupId !== request.backupId ||
        journal.protectionBackupId !== protectionBackupId || journal.beforeRevision !== request.expectedRevision) {
      throw new SaveTransactionError('SAVE_IDEMPOTENCY_CONFLICT')
    }
    const stage = restoreStagePaths(roots.saveRoot, request.requestId)
    const rollbackPaths = restoreRollbackPaths(roots.saveRoot, request.requestId)
    if (receipt !== null) {
      if (receipt.backupId !== journal.backupId || receipt.protectionBackupId !== journal.protectionBackupId ||
          receipt.saveName !== journal.saveName || receipt.beforeRevision !== journal.beforeRevision ||
          receipt.afterRevision !== journal.afterRevision) {
        throw new SaveTransactionError('SAVE_IDEMPOTENCY_CONFLICT')
      }
      let cleanup: RestoreArtifactCleanupResult = { state: 'pending' }
      try {
        const source = await readTrustedBackup(
          roots.backupRoot,
          request.backupId,
          this.#readStablePair.bind(this)
        )
        const protection = await readTrustedBackup(
          roots.backupRoot,
          protectionBackupId,
          this.#readStablePair.bind(this)
        )
        if (source.manifest.saveName !== journal.saveName || source.pair.revision !== receipt.afterRevision ||
            source.pair.totalBytes !== receipt.pairBytes ||
            protection.manifest.saveName !== journal.saveName || protection.pair.revision !== receipt.beforeRevision) {
          throw new SaveTransactionError('SAVE_BACKUP_CORRUPT')
        }
        journal = await forceRestoreJournalPhase(roots, journal, 'gc-pending', this.#now())
          .catch(() => journal)
        cleanup = await this.#quarantineAndDeleteRestoreArtifacts(
          roots.saveRoot,
          request.requestId,
          stage,
          rollbackPaths,
          protection.pair,
          source.pair,
          'committed'
        )
      } catch {
        cleanup = { state: 'pending' }
      }
      return await this.#finishJournaledRestore(roots, journal, {
        requestId: request.requestId,
        operation: 'restore',
        status: 'succeeded',
        dryRun: false,
        backupId: request.backupId,
        protectionBackupId,
        reused: true,
        rollback: 'not-required',
        pairBytes: receipt.pairBytes,
        startedAt,
        beforeRevision: receipt.beforeRevision,
        afterRevision: receipt.afterRevision
      }, cleanup)
    }
    await this.#assertServiceStopped()
    if (journal.phase === 'gc-pending') {
      await forceRestoreJournalPhase(roots, journal, 'recovery-required', this.#now()).catch(() => undefined)
      throw new SaveTransactionError('SAVE_ROLLBACK_FAILED')
    }
    if (journal.phase === 'recovery-required') {
      throw new SaveTransactionError('SAVE_ROLLBACK_FAILED')
    }

    const requireManualRecovery = async (): Promise<never> => {
      journal = await forceRestoreJournalPhase(roots, journal, 'recovery-required', this.#now()).catch(() => journal)
      throw new SaveTransactionError('SAVE_ROLLBACK_FAILED')
    }

    let source: TrustedBackup
    let protection: TrustedBackup
    try {
      source = await readTrustedBackup(
        roots.backupRoot,
        request.backupId,
        this.#readStablePair.bind(this)
      )
      protection = await readTrustedBackup(
        roots.backupRoot,
        protectionBackupId,
        this.#readStablePair.bind(this)
      )
    } catch {
      return requireManualRecovery()
    }
    if (source.manifest.saveName !== journal.saveName || source.pair.revision !== journal.afterRevision ||
        protection.manifest.saveName !== journal.saveName || protection.pair.revision !== journal.beforeRevision) {
      return requireManualRecovery()
    }
    const targets = pairPaths(roots.saveRoot, journal.saveName)
    const layoutAllowsRecovery = await restoreLayoutAllowsProtectionRecovery(
      journal.phase,
      targets,
      rollbackPaths,
      stage,
      protection.pair,
      source.pair
    )
    const currentBeforeRecovery = await this.#readStablePair(roots.saveRoot, journal.saveName).catch(() => null)
    if (currentBeforeRecovery?.revision === journal.beforeRevision &&
        samePairContent(currentBeforeRecovery, protection.pair)) {
      if (!layoutAllowsRecovery) return requireManualRecovery()
      journal = await forceRestoreJournalPhase(roots, journal, 'rolled-back', this.#now())
      const cleanup = await this.#quarantineAndDeleteRestoreArtifacts(
        roots.saveRoot,
        request.requestId,
        stage,
        rollbackPaths,
        protection.pair,
        source.pair,
        'rolled-back'
      )
      if (cleanup.state === 'unsafe') return requireManualRecovery()
      return await this.#finishJournaledRestore(roots, journal, {
        requestId: request.requestId,
        operation: 'restore',
        status: 'rolled-back',
        dryRun: false,
        backupId: request.backupId,
        protectionBackupId,
        reused: false,
        rollback: 'succeeded',
        pairBytes: protection.pair.totalBytes,
        startedAt,
        beforeRevision: journal.beforeRevision,
        afterRevision: currentBeforeRecovery.revision,
        errorCode: 'SAVE_COMMIT_FAILED'
      }, cleanup)
    }
    if (currentBeforeRecovery === null && await bothRestoreTargetsExist(targets)) {
      return requireManualRecovery()
    }
    if (!layoutAllowsRecovery) return requireManualRecovery()

    let recovered: PairEvidence
    try {
      const recovery = await this.#recoverProtectionPair(
        roots,
        request.requestId,
        journal,
        protection,
        source.pair,
        targets
      )
      journal = recovery.journal
      recovered = recovery.recovered
    } catch {
      const durableJournal = await readRestoreJournal(roots, request.requestId).catch(() => null)
      if (durableJournal === null || durableJournal.phase === 'recovery-required' ||
          !await restoreLayoutAllowsProtectionRecovery(
            durableJournal.phase,
            targets,
            rollbackPaths,
            stage,
            protection.pair,
            source.pair
          )) {
        if (durableJournal !== null) journal = durableJournal
        return requireManualRecovery()
      }
      throw new SaveTransactionError('SAVE_ROLLBACK_FAILED')
    }
    journal = await forceRestoreJournalPhase(roots, journal, 'rolled-back', this.#now())
    const cleanup = await this.#quarantineAndDeleteRestoreArtifacts(
      roots.saveRoot,
      request.requestId,
      stage,
      rollbackPaths,
      protection.pair,
      source.pair,
      'rolled-back'
    )
    if (cleanup.state === 'unsafe') return requireManualRecovery()
    return await this.#finishJournaledRestore(roots, journal, {
      requestId: request.requestId,
      operation: 'restore',
      status: 'rolled-back',
      dryRun: false,
      backupId: request.backupId,
      protectionBackupId,
      reused: false,
      rollback: 'succeeded',
      pairBytes: protection.pair.totalBytes,
      startedAt,
      beforeRevision: journal.beforeRevision,
      afterRevision: recovered.revision,
      errorCode: 'SAVE_COMMIT_FAILED'
    }, cleanup)
  }

  async #storePreparedAudit(roots: PreparedRoots, input: PreparedAuditInput): Promise<void> {
    const finishedAt = this.#now().toISOString()
    const audit = makeAudit({
      ...input,
      status: 'prepared',
      reused: false,
      rollback: 'not-required',
      finishedAt
    })
    await storeAudit(roots, audit)
  }

  async #finish(
    roots: PreparedRoots,
    input: FinishResultInput,
    minimumAuditIndex = 0
  ): Promise<SaveTransactionResult> {
    const finishedAt = this.#now().toISOString()
    const audit = makeAudit({ ...input, finishedAt })
    let auditStored = true
    try {
      await this.#phase('before-final-audit-store')
      await storeAudit(roots, audit, minimumAuditIndex)
    } catch {
      auditStored = false
    }
    return makeResult({ ...input, finishedAt, auditStored })
  }

  async #finishIfPossible(
    roots: PreparedRoots | null,
    input: FinishResultInput
  ): Promise<SaveTransactionResult> {
    if (roots !== null) return this.#finish(roots, input)
    return makeResult({ ...input, finishedAt: this.#now().toISOString(), auditStored: false })
  }
}

/** Existing retention logic is deliberately exposed as preview-only; it never deletes backups. */
export function previewBackupRetention(input: unknown): RetentionPlan {
  return planBackupRetention(input)
}

function parseBackupRequest(input: BackupSavePairRequest): z.infer<typeof backupRequestSchema> {
  try {
    return backupRequestSchema.parse(input)
  } catch {
    throw new SaveTransactionError('SAVE_REQUEST_INVALID')
  }
}

function parseRestoreRequest(input: RestoreSavePairRequest): z.infer<typeof restoreRequestSchema> {
  try {
    return restoreRequestSchema.parse(input)
  } catch {
    throw new SaveTransactionError('SAVE_REQUEST_INVALID')
  }
}

function parseSaveName(value: string): string {
  try {
    return saveNameSchema.parse(value)
  } catch {
    throw new SaveTransactionError('SAVE_REQUEST_INVALID')
  }
}

async function probeCommittedRestoreReceipt(
  configuredSaveRoot: string,
  requestId: string
): Promise<{
    receipt: z.infer<typeof restoreReceiptSchema> | null
    requestJournalPresent: boolean
  }> {
  const saveRoot = await resolveOptionalNormalDirectory(configuredSaveRoot)
  if (saveRoot === null) return { receipt: null, requestJournalPresent: false }
  const controlRoot = await resolveOptionalNormalDirectory(safeImmediateChild(saveRoot, controlDirectoryName))
  if (controlRoot === null) return { receipt: null, requestJournalPresent: false }
  const receiptRoot = await resolveOptionalNormalDirectory(safeImmediateChild(controlRoot, receiptDirectoryName))
  if (receiptRoot === null) return { receipt: null, requestJournalPresent: false }
  const receiptPath = safeImmediateChild(receiptRoot, `restore-${requestId}.json`)
  let receipt: z.infer<typeof restoreReceiptSchema> | null = null
  try {
    const metadata = await assertNormalFile(receiptPath)
    if (metadata.size <= 0 || metadata.size > MAX_MANIFEST_BYTES) {
      throw new SaveTransactionError('SAVE_IDEMPOTENCY_CONFLICT')
    }
    receipt = restoreReceiptSchema.parse(JSON.parse(await readFile(receiptPath, 'utf8')) as unknown)
    if (receipt.requestId !== requestId) throw new SaveTransactionError('SAVE_IDEMPOTENCY_CONFLICT')
  } catch (error) {
    if (!(hasCode(error, 'ENOENT') ||
          (error instanceof SaveTransactionError && error.code === 'SAVE_PAIR_INCOMPLETE'))) {
      throw new SaveTransactionError('SAVE_IDEMPOTENCY_CONFLICT')
    }
  }
  if (receipt === null) return { receipt: null, requestJournalPresent: false }
  const journalRoot = await resolveOptionalNormalDirectory(safeImmediateChild(controlRoot, restoreJournalDirectoryName))
  if (journalRoot === null) return { receipt, requestJournalPresent: false }
  const journalPaths = [
    `restore-${requestId}-a.json`,
    `restore-${requestId}-b.json`,
    `restore-${requestId}-a.candidate.json`,
    `restore-${requestId}-b.candidate.json`
  ].map((name) => safeImmediateChild(journalRoot, name))
  return {
    receipt,
    requestJournalPresent: (await Promise.all(journalPaths.map(pathExists))).some(Boolean)
  }
}

async function resolveOptionalNormalDirectory(directory: string): Promise<string | null> {
  try {
    await lstat(directory)
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null
    throw new SaveTransactionError('SAVE_ROOT_UNAVAILABLE')
  }
  try {
    const resolved = await resolveNormalDirectory(directory)
    if (normalizePath(resolved) !== normalizePath(directory)) {
      throw new SaveTransactionError('SAVE_ROOT_UNAVAILABLE')
    }
    return resolved
  } catch (error) {
    if (error instanceof SaveTransactionError) throw error
    throw new SaveTransactionError('SAVE_ROOT_UNAVAILABLE')
  }
}

async function prepareRoots(saveRoot: string, backupRoot: string): Promise<PreparedRoots> {
  const preparedSaveRoot = await prepareNormalRoot(saveRoot)
  const preparedBackupRoot = await prepareNormalRoot(backupRoot)
  try {
    // Keep transaction metadata beside the trusted save root so the backup
    // catalog remains a collection of protection-point directories only.
    const controlRoot = await ensureNormalChildDirectory(preparedSaveRoot, controlDirectoryName)
    const auditRoot = await ensureNormalChildDirectory(controlRoot, auditDirectoryName)
    const receiptRoot = await ensureNormalChildDirectory(controlRoot, receiptDirectoryName)
    const restoreJournalRoot = await ensureNormalChildDirectory(controlRoot, restoreJournalDirectoryName)
    return {
      saveRoot: preparedSaveRoot,
      backupRoot: preparedBackupRoot,
      controlRoot,
      auditRoot,
      receiptRoot,
      restoreJournalRoot,
      lockPath: safeImmediateChild(controlRoot, lockFileName),
      key: `${normalizePath(preparedSaveRoot)}\0${normalizePath(preparedBackupRoot)}`
    }
  } catch {
    throw new SaveTransactionError('SAVE_TRANSACTION_STORAGE_UNAVAILABLE')
  }
}

async function prepareNormalRoot(root: string): Promise<string> {
  try {
    return await resolveNormalDirectory(root)
  } catch {
    throw new SaveTransactionError('SAVE_ROOT_UNAVAILABLE')
  }
}

async function ensureNormalChildDirectory(parent: string, name: string): Promise<string> {
  const child = safeImmediateChild(parent, name)
  try {
    await mkdir(child, { mode: 0o700 })
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error
  }
  return resolveNormalDirectory(child)
}

async function acquireExclusiveLock(
  roots: PreparedRoots,
  requestId: string,
  startedAt: string
): Promise<AcquiredLock | null> {
  if (inProcessLocks.has(roots.key)) return null
  inProcessLocks.add(roots.key)
  const instanceId = randomUUID()
  let handle: FileHandle | null = null
  try {
    handle = await open(roots.lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  } catch (error) {
    inProcessLocks.delete(roots.key)
    if (hasCode(error, 'EEXIST')) return null
    throw new SaveTransactionError('SAVE_TRANSACTION_STORAGE_UNAVAILABLE')
  }
  try {
    await roots.journalHook?.('after-lease-created-before-write')
    const lease = transactionLeaseSchema.parse({
      format: 'dyson-control-save-transaction-lease',
      schemaVersion,
      host: hostname(),
      bootId: processBootIdentity,
      pid: process.pid,
      instanceId,
      requestId,
      acquiredAt: startedAt
    })
    await handle.writeFile(`${JSON.stringify(lease)}\n`, 'utf8')
    await handle.sync()
    return { key: roots.key, path: roots.lockPath, handle, instanceId }
  } catch {
    await handle.close().catch(() => undefined)
    // Creation may have failed after another actor replaced the pathname.
    // Without a handle-bound unlink primitive, leaving the lease fail-closed
    // is safer than deleting a path whose ownership can no longer be proven.
    inProcessLocks.delete(roots.key)
    throw new SaveTransactionError('SAVE_TRANSACTION_STORAGE_UNAVAILABLE')
  }
}

async function releaseExclusiveLock(lock: AcquiredLock): Promise<void> {
  try {
    if (!await pathnameRefersToOpenFile(lock.handle, lock.path)) return
    const current = await readTransactionLease(lock.path)
    if (current.instanceId !== lock.instanceId) return
    // Recheck after the pathname read. An exact byte-for-byte replacement has
    // the same lease identity but a different filesystem identity and must be
    // preserved. Keep the original handle open through unlink so its file ID
    // cannot be recycled into a replacement during this release attempt.
    if (!await pathnameRefersToOpenFile(lock.handle, lock.path)) return
    await unlink(lock.path)
  } catch {
    // A missing, replaced, redirected, or malformed lease is never removed by
    // a process that cannot still prove both content and file identity.
  } finally {
    await lock.handle.close().catch(() => undefined)
    inProcessLocks.delete(lock.key)
  }
}

async function pathnameRefersToOpenFile(handle: FileHandle, filePath: string): Promise<boolean> {
  const [opened, current] = await Promise.all([
    handle.stat({ bigint: true }),
    lstat(filePath, { bigint: true })
  ])
  // Node exposes the Windows/Unix file identity through dev + ino. A zero
  // inode cannot prove identity, so release fails closed and preserves the
  // lease for explicit maintenance.
  return opened.isFile() && current.isFile() && !current.isSymbolicLink() &&
    opened.ino !== 0n && opened.dev === current.dev && opened.ino === current.ino
}

async function readTransactionLease(lockPath: string): Promise<z.infer<typeof transactionLeaseSchema>> {
  const metadata = await lstat(lockPath)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 ||
      metadata.size > persistedControlFileMaximumBytes ||
      normalizePath(await realpath(lockPath)) !== normalizePath(lockPath)) {
    throw new SaveTransactionError('SAVE_TRANSACTION_STORAGE_UNAVAILABLE')
  }
  try {
    return transactionLeaseSchema.parse(JSON.parse(await readFile(lockPath, 'utf8')) as unknown)
  } catch {
    throw new SaveTransactionError('SAVE_TRANSACTION_STORAGE_UNAVAILABLE')
  }
}

async function readExistingBackup(
  backupRoot: string,
  backupId: string,
  readStablePair: (root: string, saveName: string) => Promise<PairEvidence>
): Promise<TrustedBackup | null> {
  const directory = safeImmediateChild(backupRoot, backupId)
  try {
    await lstat(directory)
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null
    throw new SaveTransactionError('SAVE_BACKUP_CORRUPT')
  }
  return readTrustedBackup(backupRoot, backupId, readStablePair)
}

async function readTrustedBackup(
  backupRoot: string,
  backupId: string,
  readStablePair: (root: string, saveName: string) => Promise<PairEvidence>
): Promise<TrustedBackup> {
  let directory: string
  try {
    const parsedId = backupIdSchema.parse(backupId)
    const root = await resolveNormalDirectory(backupRoot)
    directory = await resolveNormalDirectory(safeImmediateChild(root, parsedId))
  } catch {
    throw new SaveTransactionError('SAVE_BACKUP_CORRUPT')
  }
  return readTrustedBackupDirectory(directory, backupId, readStablePair)
}

async function readTrustedBackupDirectory(
  directory: string,
  backupId: string,
  readStablePair: (root: string, saveName: string) => Promise<PairEvidence>
): Promise<TrustedBackup> {
  try {
    const manifestPath = safeImmediateChild(directory, 'manifest.json')
    const metadata = await assertNormalFile(manifestPath)
    if (metadata.size <= 0 || metadata.size > MAX_MANIFEST_BYTES) {
      throw new SaveTransactionError('SAVE_BACKUP_CORRUPT')
    }
    const raw = await readFile(manifestPath, 'utf8')
    const manifest = backupManifestV1Schema.parse(JSON.parse(raw) as unknown)
    if (backupId !== `tx-${manifest.requestId.toLocaleLowerCase('en-US')}`) {
      throw new SaveTransactionError('SAVE_BACKUP_CORRUPT')
    }
    const expectedNames = [`${manifest.saveName}.dsv`, `${manifest.saveName}.server`]
    if (manifest.files.length !== 2 ||
        expectedNames.some((name) => manifest.files.filter((entry) => entry.name === name).length !== 1)) {
      throw new SaveTransactionError('SAVE_BACKUP_CORRUPT')
    }
    const pair = await readStablePair(directory, manifest.saveName)
    const dsv = manifest.files.find((entry) => entry.name === expectedNames[0])!
    const server = manifest.files.find((entry) => entry.name === expectedNames[1])!
    if (pair.dsv.bytes !== dsv.bytes || pair.dsv.sha256 !== dsv.sha256.toLocaleLowerCase('en-US') ||
        pair.server.bytes !== server.bytes || pair.server.sha256 !== server.sha256.toLocaleLowerCase('en-US')) {
      throw new SaveTransactionError('SAVE_BACKUP_CORRUPT')
    }
    return { backupId, directory, manifest, pair }
  } catch {
    throw new SaveTransactionError('SAVE_BACKUP_CORRUPT')
  }
}

function pairPaths(root: string, saveName: string): { dsv: string; server: string } {
  const parsedName = parseSaveName(saveName)
  return {
    dsv: safeImmediateChild(root, `${parsedName}.dsv`),
    server: safeImmediateChild(root, `${parsedName}.server`)
  }
}

async function hashStableNormalFile(filePath: string): Promise<FileEvidence> {
  let initial: Stats
  try {
    initial = await assertNormalFile(filePath)
  } catch (error) {
    if (error instanceof SaveTransactionError) throw error
    throw new SaveTransactionError('SAVE_PAIR_INCOMPLETE')
  }
  const handle = await open(filePath, 'r').catch(() => {
    throw new SaveTransactionError('SAVE_PAIR_INCOMPLETE')
  })
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size !== initial.size ||
        before.mtimeMs !== initial.mtimeMs || before.ctimeMs !== initial.ctimeMs) {
      throw new SaveTransactionError('SAVE_PAIR_CHANGED')
    }
    const digest = createHash('sha256')
    const buffer = Buffer.allocUnsafe(streamBufferBytes)
    let position = 0
    while (position < before.size) {
      const length = Math.min(buffer.length, before.size - position)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      if (bytesRead === 0) break
      digest.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    const after = await handle.stat()
    if (position !== before.size || !sameMetadata(before, after)) {
      throw new SaveTransactionError('SAVE_PAIR_CHANGED')
    }
    return {
      bytes: before.size,
      sha256: digest.digest('hex'),
      modifiedMs: before.mtimeMs,
      changedMs: before.ctimeMs
    }
  } finally {
    await handle.close()
  }
}

async function copyAndHashStableFile(source: string, destination: string): Promise<FileEvidence> {
  await assertNormalFile(source)
  const sourceHandle = await open(source, 'r').catch(() => {
    throw new SaveTransactionError('SAVE_PAIR_INCOMPLETE')
  })
  let destinationHandle: FileHandle | null = null
  try {
    const before = await sourceHandle.stat()
    if (!before.isFile()) throw new SaveTransactionError('SAVE_PAIR_REDIRECTED')
    destinationHandle = await open(destination, 'wx', 0o600)
    const digest = createHash('sha256')
    const buffer = Buffer.allocUnsafe(streamBufferBytes)
    let position = 0
    while (position < before.size) {
      const length = Math.min(buffer.length, before.size - position)
      const { bytesRead } = await sourceHandle.read(buffer, 0, length, position)
      if (bytesRead === 0) break
      digest.update(buffer.subarray(0, bytesRead))
      let written = 0
      while (written < bytesRead) {
        const result = await destinationHandle.write(buffer, written, bytesRead - written, position + written)
        if (result.bytesWritten === 0) throw new SaveTransactionError('SAVE_COMMIT_FAILED')
        written += result.bytesWritten
      }
      position += bytesRead
    }
    await destinationHandle.sync()
    const after = await sourceHandle.stat()
    if (position !== before.size || !sameMetadata(before, after)) {
      throw new SaveTransactionError('SAVE_PAIR_CHANGED')
    }
    return {
      bytes: before.size,
      sha256: digest.digest('hex'),
      modifiedMs: before.mtimeMs,
      changedMs: before.ctimeMs
    }
  } finally {
    await destinationHandle?.close().catch(() => undefined)
    await sourceHandle.close()
  }
}

async function assertNormalFile(filePath: string): Promise<Stats> {
  let metadata: Stats
  try {
    metadata = await lstat(filePath)
  } catch (error) {
    if (hasCode(error, 'ENOENT')) throw new SaveTransactionError('SAVE_PAIR_INCOMPLETE')
    throw new SaveTransactionError('SAVE_PAIR_INCOMPLETE')
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new SaveTransactionError('SAVE_PAIR_REDIRECTED')
  }
  try {
    if (normalizePath(await realpath(filePath)) !== normalizePath(filePath)) {
      throw new SaveTransactionError('SAVE_PAIR_REDIRECTED')
    }
  } catch (error) {
    if (error instanceof SaveTransactionError) throw error
    throw new SaveTransactionError('SAVE_PAIR_REDIRECTED')
  }
  return metadata
}

function makePairEvidence(saveName: string, dsv: FileEvidence, server: FileEvidence): PairEvidence {
  const revision = createHash('sha256')
    .update('dyson-save-pair-revision-v1\0', 'utf8')
    .update(saveName, 'utf8')
    .update('\0dsv\0', 'utf8')
    .update(String(dsv.bytes), 'utf8')
    .update('\0', 'utf8')
    .update(dsv.sha256, 'ascii')
    .update('\0server\0', 'utf8')
    .update(String(server.bytes), 'utf8')
    .update('\0', 'utf8')
    .update(server.sha256, 'ascii')
    .digest('hex')
  return {
    saveName,
    dsv,
    server,
    revision: `pair-v1:${revision}`,
    totalBytes: dsv.bytes + server.bytes
  }
}

function samePairContent(left: PairEvidence, right: PairEvidence): boolean {
  return left.saveName === right.saveName && left.dsv.bytes === right.dsv.bytes &&
    left.dsv.sha256 === right.dsv.sha256 && left.server.bytes === right.server.bytes &&
    left.server.sha256 === right.server.sha256
}

function publicRevision(pair: PairEvidence): SavePairRevision {
  return {
    schemaVersion,
    saveName: pair.saveName,
    revision: pair.revision,
    dsvBytes: pair.dsv.bytes,
    serverBytes: pair.server.bytes,
    totalBytes: pair.totalBytes
  }
}

interface BackupStage {
  directory: string
  dsv: string
  server: string
  manifest: string
  partialManifest: string
}

async function createBackupStage(
  backupRoot: string,
  requestId: string,
  saveName: string
): Promise<BackupStage> {
  const directory = safeImmediateChild(backupRoot, `.staging-${requestId}`)
  const parsedName = parseSaveName(saveName)
  const stage = {
    directory,
    dsv: safeImmediateChild(directory, `${parsedName}.dsv`),
    server: safeImmediateChild(directory, `${parsedName}.server`),
    manifest: safeImmediateChild(directory, 'manifest.json'),
    partialManifest: safeImmediateChild(directory, '.manifest.partial')
  }
  await createOrRecoverStageDirectory(directory, [
    `${parsedName}.dsv`, `${parsedName}.server`, 'manifest.json', '.manifest.partial'
  ])
  return stage
}

async function cleanupBackupStageFiles(stage: BackupStage): Promise<void> {
  await removeFileIfExists(stage.dsv)
  await removeFileIfExists(stage.server)
  await removeFileIfExists(stage.manifest)
  await removeFileIfExists(stage.partialManifest)
}

async function cleanupBackupStage(stage: BackupStage): Promise<void> {
  await cleanupBackupStageFiles(stage)
  await rmdir(stage.directory).catch((error) => {
    if (!hasCode(error, 'ENOENT')) throw error
  })
}

async function writeManifest(directory: string, manifest: BackupManifestV1): Promise<void> {
  const partial = safeImmediateChild(directory, '.manifest.partial')
  const final = safeImmediateChild(directory, 'manifest.json')
  const handle = await open(partial, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(manifest), 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(partial, final)
}

async function removeOwnedBackupDirectory(backupRoot: string, backupId: string): Promise<void> {
  const directory = await resolveNormalDirectory(safeImmediateChild(backupRoot, backupId))
  const manifest = await readManifestIdentityOnly(directory, backupId)
  const paths = pairPaths(directory, manifest.saveName)
  await removeNormalFile(paths.dsv)
  await removeNormalFile(paths.server)
  await removeNormalFile(safeImmediateChild(directory, 'manifest.json'))
  const remaining = await readdir(directory)
  if (remaining.length !== 0) throw new SaveTransactionError('SAVE_TRANSACTION_STORAGE_UNAVAILABLE')
  await rmdir(directory)
}

async function readManifestIdentityOnly(directory: string, backupId: string): Promise<BackupManifestV1> {
  try {
    const manifestPath = safeImmediateChild(directory, 'manifest.json')
    const metadata = await assertNormalFile(manifestPath)
    if (metadata.size <= 0 || metadata.size > MAX_MANIFEST_BYTES) throw new Error('invalid')
    const manifest = backupManifestV1Schema.parse(JSON.parse(await readFile(manifestPath, 'utf8')) as unknown)
    if (`tx-${manifest.requestId.toLocaleLowerCase('en-US')}` !== backupId) throw new Error('invalid')
    return manifest
  } catch {
    throw new SaveTransactionError('SAVE_TRANSACTION_STORAGE_UNAVAILABLE')
  }
}

interface RestoreStage {
  directory: string
  dsv: string
  server: string
}

async function createRestoreStage(saveRoot: string, requestId: string): Promise<RestoreStage> {
  const stage = restoreStagePaths(saveRoot, requestId)
  try {
    await mkdir(stage.directory, { mode: 0o700 })
  } catch {
    // A fixed-name directory without the already-published request journal is
    // not durable ownership evidence. Never recover or delete it by filename.
    throw new SaveTransactionError('SAVE_TRANSACTION_STORAGE_UNAVAILABLE')
  }
  return stage
}

function restoreStagePaths(saveRoot: string, requestId: string): RestoreStage {
  const directory = safeImmediateChild(saveRoot, `.restore-stage-${requestId}`)
  return {
    directory,
    dsv: safeImmediateChild(directory, 'pair.dsv'),
    server: safeImmediateChild(directory, 'pair.server')
  }
}

async function copyBackupIntoRestoreStage(backup: TrustedBackup, stage: RestoreStage): Promise<void> {
  const source = pairPaths(backup.directory, backup.manifest.saveName)
  const dsv = await copyAndHashStableFile(source.dsv, stage.dsv)
  const server = await copyAndHashStableFile(source.server, stage.server)
  const copied = makePairEvidence(backup.manifest.saveName, dsv, server)
  if (!samePairContent(copied, backup.pair)) throw new SaveTransactionError('SAVE_BACKUP_CORRUPT')
}

function restoreRollbackPaths(saveRoot: string, requestId: string): { dsv: string; server: string } {
  return {
    dsv: safeImmediateChild(saveRoot, `.rollback-${requestId}-dsv.bin`),
    server: safeImmediateChild(saveRoot, `.rollback-${requestId}-server.bin`)
  }
}

type RestoreArtifactCleanupResult = { state: 'complete' | 'pending' | 'unsafe' }

interface RestoreArtifactCleanupInput {
  saveRoot: string
  requestId: string
  stage: RestoreStage
  rollbackPaths: { dsv: string; server: string }
  before: PairEvidence
  after: PairEvidence
  mode: 'committed' | 'rolled-back'
  afterFirstRollbackQuarantine: () => Promise<void>
  beforeStageQuarantineDelete: () => Promise<void>
}

interface RestoreCleanupQuarantine {
  rollbackDsv: string
  rollbackServer: string
  stage: RestoreStage
}

class RestoreArtifactOwnershipError extends Error {}

function restoreCleanupQuarantine(saveRoot: string, requestId: string): RestoreCleanupQuarantine {
  const stageDirectory = safeImmediateChild(saveRoot, `.gc-${requestId}-stage`)
  return {
    rollbackDsv: safeImmediateChild(saveRoot, `.gc-${requestId}-rollback-dsv.bin`),
    rollbackServer: safeImmediateChild(saveRoot, `.gc-${requestId}-rollback-server.bin`),
    stage: {
      directory: stageDirectory,
      dsv: safeImmediateChild(stageDirectory, 'pair.dsv'),
      server: safeImmediateChild(stageDirectory, 'pair.server')
    }
  }
}

async function assertInitialRestoreArtifactsAbsent(saveRoot: string, requestId: string): Promise<void> {
  const stage = restoreStagePaths(saveRoot, requestId)
  const rollback = restoreRollbackPaths(saveRoot, requestId)
  const quarantine = restoreCleanupQuarantine(saveRoot, requestId)
  await Promise.all([
    assertPathAbsent(stage.directory),
    assertPathAbsent(rollback.dsv),
    assertPathAbsent(rollback.server),
    assertPathAbsent(quarantine.rollbackDsv),
    assertPathAbsent(quarantine.rollbackServer),
    assertPathAbsent(quarantine.stage.directory)
  ])
}

async function assertRestoreCleanupQuarantineAbsent(saveRoot: string, requestId: string): Promise<void> {
  const quarantine = restoreCleanupQuarantine(saveRoot, requestId)
  await Promise.all([
    assertPathAbsent(quarantine.rollbackDsv),
    assertPathAbsent(quarantine.rollbackServer),
    assertPathAbsent(quarantine.stage.directory)
  ])
}

async function quarantineAndDeleteOwnedRestoreArtifacts(
  input: RestoreArtifactCleanupInput
): Promise<RestoreArtifactCleanupResult> {
  const quarantine = restoreCleanupQuarantine(input.saveRoot, input.requestId)
  try {
    await assertCleanupFileLocations(input.rollbackPaths.dsv, quarantine.rollbackDsv, input.before.dsv)
    await assertCleanupFileLocations(input.rollbackPaths.server, quarantine.rollbackServer, input.before.server)
    await assertCleanupStageLocations(input.stage, quarantine.stage, input.before, input.after, input.mode)

    let firstRollbackMoved = false
    if (await pathExists(input.rollbackPaths.dsv)) {
      await rename(input.rollbackPaths.dsv, quarantine.rollbackDsv)
      await assertCleanupFileOwned(quarantine.rollbackDsv, input.before.dsv)
      firstRollbackMoved = true
    }
    if (firstRollbackMoved) await input.afterFirstRollbackQuarantine()
    if (await pathExists(input.rollbackPaths.server)) {
      await rename(input.rollbackPaths.server, quarantine.rollbackServer)
      await assertCleanupFileOwned(quarantine.rollbackServer, input.before.server)
    }
    if (await pathExists(input.stage.directory)) {
      await rename(input.stage.directory, quarantine.stage.directory)
      await inspectOwnedCleanupStage(quarantine.stage, input.before, input.after, input.mode)
    }

    await deleteQuarantinedCleanupFile(
      input.rollbackPaths.dsv,
      quarantine.rollbackDsv,
      input.before.dsv
    )
    await deleteQuarantinedCleanupFile(
      input.rollbackPaths.server,
      quarantine.rollbackServer,
      input.before.server
    )
    if (await pathExists(quarantine.stage.directory)) {
      await assertPathAbsent(input.stage.directory)
      await inspectOwnedCleanupStage(quarantine.stage, input.before, input.after, input.mode)
      await input.beforeStageQuarantineDelete()
      for (const [filePath, beforeFile, afterFile] of [
        [quarantine.stage.dsv, input.before.dsv, input.after.dsv],
        [quarantine.stage.server, input.before.server, input.after.server]
      ] as const) {
        const evidence = await readOptionalStableArtifact(filePath)
        if (evidence === null) continue
        if (!sameFileContent(evidence, beforeFile) && !sameFileContent(evidence, afterFile)) {
          throw new RestoreArtifactOwnershipError()
        }
        await unlink(filePath)
      }
      if ((await readdir(quarantine.stage.directory)).length !== 0) {
        throw new RestoreArtifactOwnershipError()
      }
      await rmdir(quarantine.stage.directory)
    }

    const leftovers = await Promise.all([
      pathExists(input.rollbackPaths.dsv),
      pathExists(input.rollbackPaths.server),
      pathExists(input.stage.directory),
      pathExists(quarantine.rollbackDsv),
      pathExists(quarantine.rollbackServer),
      pathExists(quarantine.stage.directory)
    ])
    return leftovers.some(Boolean) ? { state: 'pending' } : { state: 'complete' }
  } catch (error) {
    await bestEffortRestoreCleanupArtifacts(input, quarantine)
    return error instanceof RestoreArtifactOwnershipError
      ? { state: 'unsafe' }
      : { state: 'pending' }
  }
}

async function assertCleanupFileLocations(
  original: string,
  quarantine: string,
  expected: FileEvidence
): Promise<void> {
  const [originalEvidence, quarantineEvidence] = await Promise.all([
    readOptionalStableArtifact(original),
    readOptionalStableArtifact(quarantine)
  ])
  if (originalEvidence !== null && quarantineEvidence !== null) throw new RestoreArtifactOwnershipError()
  if (originalEvidence !== null && !sameFileContent(originalEvidence, expected)) {
    throw new RestoreArtifactOwnershipError()
  }
  if (quarantineEvidence !== null && !sameFileContent(quarantineEvidence, expected)) {
    throw new RestoreArtifactOwnershipError()
  }
}

async function assertCleanupFileOwned(filePath: string, expected: FileEvidence): Promise<void> {
  const evidence = await readOptionalStableArtifact(filePath)
  if (evidence === null || !sameFileContent(evidence, expected)) throw new RestoreArtifactOwnershipError()
}

async function deleteQuarantinedCleanupFile(
  original: string,
  quarantine: string,
  expected: FileEvidence
): Promise<void> {
  const evidence = await readOptionalStableArtifact(quarantine)
  if (evidence === null) return
  await assertPathAbsent(original)
  if (!sameFileContent(evidence, expected)) throw new RestoreArtifactOwnershipError()
  await assertCleanupFileOwned(quarantine, expected)
  await unlink(quarantine)
}

async function assertCleanupStageLocations(
  original: RestoreStage,
  quarantine: RestoreStage,
  before: PairEvidence,
  after: PairEvidence,
  mode: 'committed' | 'rolled-back'
): Promise<void> {
  const [originalExists, quarantineExists] = await Promise.all([
    pathExists(original.directory),
    pathExists(quarantine.directory)
  ])
  if (originalExists && quarantineExists) throw new RestoreArtifactOwnershipError()
  if (originalExists) await inspectOwnedCleanupStage(original, before, after, mode)
  if (quarantineExists) await inspectOwnedCleanupStage(quarantine, before, after, mode)
}

async function inspectOwnedCleanupStage(
  stage: RestoreStage,
  before: PairEvidence,
  after: PairEvidence,
  mode: 'committed' | 'rolled-back'
): Promise<void> {
  let directory: string
  try {
    directory = await resolveNormalDirectory(stage.directory)
  } catch {
    throw new RestoreArtifactOwnershipError()
  }
  if (normalizePath(directory) !== normalizePath(stage.directory)) throw new RestoreArtifactOwnershipError()
  const names = await readdir(directory)
  if (names.length > 2 || names.some((name) => name !== 'pair.dsv' && name !== 'pair.server')) {
    throw new RestoreArtifactOwnershipError()
  }
  if (inputStageMustBeEmpty(mode) && names.length !== 0) throw new RestoreArtifactOwnershipError()
  for (const [name, beforeFile, afterFile] of [
    ['pair.dsv', before.dsv, after.dsv],
    ['pair.server', before.server, after.server]
  ] as const) {
    if (!names.includes(name)) continue
    const evidence = await hashStableNormalFile(safeImmediateChild(directory, name))
    if (!sameFileContent(evidence, beforeFile) && !sameFileContent(evidence, afterFile)) {
      throw new RestoreArtifactOwnershipError()
    }
  }
}

function inputStageMustBeEmpty(mode: 'committed' | 'rolled-back'): boolean {
  return mode === 'committed'
}

async function bestEffortRestoreCleanupArtifacts(
  input: RestoreArtifactCleanupInput,
  quarantine: RestoreCleanupQuarantine
): Promise<void> {
  await bestEffortRestoreCleanupFile(quarantine.rollbackDsv, input.rollbackPaths.dsv, input.before.dsv)
  await bestEffortRestoreCleanupFile(quarantine.rollbackServer, input.rollbackPaths.server, input.before.server)
  try {
    if (!await pathExists(quarantine.stage.directory) || await pathExists(input.stage.directory)) return
    await inspectOwnedCleanupStage(quarantine.stage, input.before, input.after, input.mode)
    await rename(quarantine.stage.directory, input.stage.directory)
  } catch {
    // Preserve both locations for the durable journal to classify on retry.
  }
}

async function bestEffortRestoreCleanupFile(
  quarantine: string,
  original: string,
  expected: FileEvidence
): Promise<void> {
  try {
    if (!await pathExists(quarantine) || await pathExists(original)) return
    await assertCleanupFileOwned(quarantine, expected)
    await rename(quarantine, original)
  } catch {
    // Preserve whichever evidence remains; never overwrite an unproven path.
  }
}

async function resetRestoreStageForRecovery(
  stage: RestoreStage,
  before: PairEvidence,
  after: PairEvidence
): Promise<void> {
  if (!await pathExists(stage.directory)) {
    await mkdir(stage.directory, { mode: 0o700 })
    return
  }
  const directory = await resolveNormalDirectory(stage.directory).catch(() => {
    throw new SaveTransactionError('SAVE_ROLLBACK_FAILED')
  })
  if (normalizePath(directory) !== normalizePath(stage.directory)) {
    throw new SaveTransactionError('SAVE_ROLLBACK_FAILED')
  }
  const names = await readdir(directory)
  if (names.length > 2 || names.some((name) => name !== 'pair.dsv' && name !== 'pair.server')) {
    throw new SaveTransactionError('SAVE_ROLLBACK_FAILED')
  }
  await removeKnownRecoveryTarget(stage.dsv, [before.dsv, after.dsv])
  await removeKnownRecoveryTarget(stage.server, [before.server, after.server])
  if ((await readdir(directory)).length !== 0) throw new SaveTransactionError('SAVE_ROLLBACK_FAILED')
  await rmdir(directory)
  await mkdir(stage.directory, { mode: 0o700 })
}

async function removeKnownRecoveryTarget(
  target: string,
  expected: readonly FileEvidence[]
): Promise<void> {
  const evidence = await readOptionalStableArtifact(target)
  if (evidence === null) return
  if (!expected.some((candidate) => sameFileContent(evidence, candidate))) {
    throw new SaveTransactionError('SAVE_ROLLBACK_FAILED')
  }
  const verified = await hashStableNormalFile(target)
  if (!sameFileContent(evidence, verified)) throw new SaveTransactionError('SAVE_ROLLBACK_FAILED')
  await unlink(target)
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate)
    return true
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false
    throw error
  }
}

type RestoreArtifactExpectation = 'absent' | 'before' | 'after'

interface RestoreLayoutPattern {
  targetDsv: readonly RestoreArtifactExpectation[]
  targetServer: readonly RestoreArtifactExpectation[]
  rollbackDsv: readonly RestoreArtifactExpectation[]
  rollbackServer: readonly RestoreArtifactExpectation[]
  stageDsv: readonly RestoreArtifactExpectation[]
  stageServer: readonly RestoreArtifactExpectation[]
}

interface RestoreLayoutEvidence {
  targetDsv: FileEvidence | null
  targetServer: FileEvidence | null
  rollbackDsv: FileEvidence | null
  rollbackServer: FileEvidence | null
  stageDsv: FileEvidence | null
  stageServer: FileEvidence | null
}

async function restoreLayoutAllowsProtectionRecovery(
  phase: z.infer<typeof restoreJournalPhaseSchema>,
  targets: { dsv: string; server: string },
  rollbackPaths: { dsv: string; server: string },
  stage: RestoreStage,
  before: PairEvidence,
  after: PairEvidence
): Promise<boolean> {
  if (!await restoreStageInventoryIsExact(stage)) return false
  let layout: RestoreLayoutEvidence
  try {
    const [targetDsv, targetServer, rollbackDsv, rollbackServer, stageDsv, stageServer] = await Promise.all([
      readOptionalStableArtifact(targets.dsv),
      readOptionalStableArtifact(targets.server),
      readOptionalStableArtifact(rollbackPaths.dsv),
      readOptionalStableArtifact(rollbackPaths.server),
      readOptionalStableArtifact(stage.dsv),
      readOptionalStableArtifact(stage.server)
    ])
    layout = { targetDsv, targetServer, rollbackDsv, rollbackServer, stageDsv, stageServer }
  } catch {
    return false
  }

  const absent = ['absent'] as const
  const beforeOnly = ['before'] as const
  const afterOnly = ['after'] as const
  const known = ['absent', 'before', 'after'] as const
  const beforeOrAbsent = ['absent', 'before'] as const
  const afterOrAbsent = ['absent', 'after'] as const
  const forward: readonly RestoreLayoutPattern[] = [
    {
      targetDsv: beforeOnly, targetServer: beforeOnly,
      rollbackDsv: absent, rollbackServer: absent,
      stageDsv: afterOrAbsent, stageServer: afterOrAbsent
    },
    {
      targetDsv: absent, targetServer: beforeOnly,
      rollbackDsv: beforeOnly, rollbackServer: absent,
      stageDsv: afterOnly, stageServer: afterOnly
    },
    {
      targetDsv: absent, targetServer: absent,
      rollbackDsv: beforeOnly, rollbackServer: beforeOnly,
      stageDsv: afterOnly, stageServer: afterOnly
    },
    {
      targetDsv: afterOnly, targetServer: absent,
      rollbackDsv: beforeOnly, rollbackServer: beforeOnly,
      stageDsv: absent, stageServer: afterOnly
    },
    {
      targetDsv: afterOnly, targetServer: afterOnly,
      rollbackDsv: beforeOnly, rollbackServer: beforeOnly,
      stageDsv: absent, stageServer: absent
    }
  ]
  const forwardIndexes: Partial<Record<z.infer<typeof restoreJournalPhaseSchema>, readonly number[]>> = {
    prepared: [0],
    'original-dsv-move-intent': [0, 1],
    'original-dsv-moved': [1],
    'original-server-move-intent': [1, 2],
    'original-server-moved': [2],
    'restored-dsv-install-intent': [2, 3],
    'restored-dsv-installed': [3],
    'restored-server-install-intent': [3, 4],
    'restored-server-installed': [4],
    'receipt-write-intent': [4]
  }
  const indexes = forwardIndexes[phase]
  if (indexes !== undefined && indexes.some((index) => restoreLayoutMatches(layout, forward[index]!, before, after))) {
    return true
  }

  if (phase === 'recovery-dsv-install-intent') {
    return restoreLayoutMatches(layout, {
      targetDsv: known,
      targetServer: known,
      rollbackDsv: beforeOrAbsent,
      rollbackServer: beforeOrAbsent,
      stageDsv: known,
      stageServer: known
    }, before, after)
  }
  if (phase === 'recovery-dsv-installed' || phase === 'recovery-server-install-intent') {
    return restoreLayoutMatches(layout, {
      targetDsv: beforeOnly,
      targetServer: known,
      rollbackDsv: beforeOrAbsent,
      rollbackServer: beforeOrAbsent,
      stageDsv: absent,
      stageServer: ['absent', 'before']
    }, before, after)
  }
  if (phase === 'recovery-server-installed' || phase === 'rolled-back') {
    return restoreLayoutMatches(layout, {
      targetDsv: beforeOnly,
      targetServer: beforeOnly,
      rollbackDsv: beforeOrAbsent,
      rollbackServer: beforeOrAbsent,
      stageDsv: absent,
      stageServer: absent
    }, before, after)
  }
  return false
}

async function restoreStageInventoryIsExact(stage: RestoreStage): Promise<boolean> {
  try {
    await lstat(stage.directory)
  } catch (error) {
    return hasCode(error, 'ENOENT')
  }
  try {
    const directory = await resolveNormalDirectory(stage.directory)
    if (normalizePath(directory) !== normalizePath(stage.directory)) return false
    const names = await readdir(directory)
    return names.length <= 2 && names.every((name) => name === 'pair.dsv' || name === 'pair.server')
  } catch {
    return false
  }
}

async function readOptionalStableArtifact(filePath: string): Promise<FileEvidence | null> {
  try {
    await lstat(filePath)
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null
    throw error
  }
  return hashStableNormalFile(filePath)
}

async function bothRestoreTargetsExist(targets: { dsv: string; server: string }): Promise<boolean> {
  const exists = async (filePath: string): Promise<boolean> => {
    try {
      await lstat(filePath)
      return true
    } catch (error) {
      return !hasCode(error, 'ENOENT')
    }
  }
  const [dsv, server] = await Promise.all([exists(targets.dsv), exists(targets.server)])
  return dsv && server
}

function restoreLayoutMatches(
  layout: RestoreLayoutEvidence,
  pattern: RestoreLayoutPattern,
  before: PairEvidence,
  after: PairEvidence
): boolean {
  return restoreArtifactMatches(layout.targetDsv, pattern.targetDsv, before.dsv, after.dsv) &&
    restoreArtifactMatches(layout.targetServer, pattern.targetServer, before.server, after.server) &&
    restoreArtifactMatches(layout.rollbackDsv, pattern.rollbackDsv, before.dsv, after.dsv) &&
    restoreArtifactMatches(layout.rollbackServer, pattern.rollbackServer, before.server, after.server) &&
    restoreArtifactMatches(layout.stageDsv, pattern.stageDsv, before.dsv, after.dsv) &&
    restoreArtifactMatches(layout.stageServer, pattern.stageServer, before.server, after.server)
}

function restoreArtifactMatches(
  actual: FileEvidence | null,
  expected: readonly RestoreArtifactExpectation[],
  before: FileEvidence,
  after: FileEvidence
): boolean {
  if (actual === null) return expected.includes('absent')
  return (expected.includes('before') && sameFileContent(actual, before)) ||
    (expected.includes('after') && sameFileContent(actual, after))
}

function sameFileContent(left: FileEvidence, right: FileEvidence): boolean {
  return left.bytes === right.bytes && left.sha256 === right.sha256
}

async function readRestoreReceipt(roots: PreparedRoots, requestId: string): Promise<z.infer<typeof restoreReceiptSchema> | null> {
  const receiptPath = restoreReceiptPath(roots, requestId)
  try {
    const metadata = await assertNormalFile(receiptPath)
    if (metadata.size <= 0 || metadata.size > MAX_MANIFEST_BYTES) {
      throw new SaveTransactionError('SAVE_IDEMPOTENCY_CONFLICT')
    }
    const receipt = restoreReceiptSchema.parse(JSON.parse(await readFile(receiptPath, 'utf8')) as unknown)
    if (receipt.requestId !== requestId) throw new SaveTransactionError('SAVE_IDEMPOTENCY_CONFLICT')
    return receipt
  } catch (error) {
    if (hasCode(error, 'ENOENT') ||
        (error instanceof SaveTransactionError && error.code === 'SAVE_PAIR_INCOMPLETE')) return null
    throw new SaveTransactionError('SAVE_IDEMPOTENCY_CONFLICT')
  }
}

async function writeRestoreReceipt(
  roots: PreparedRoots,
  receipt: z.infer<typeof restoreReceiptSchema>
): Promise<void> {
  restoreReceiptSchema.parse(receipt)
  const final = restoreReceiptPath(roots, receipt.requestId)
  const partial = safeImmediateChild(roots.receiptRoot, `.partial-${receipt.requestId}-${randomUUID()}`)
  const handle = await open(partial, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(receipt), 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(partial, final)
  } catch (error) {
    await removeFileIfExists(partial)
    throw error
  }
}

function restoreReceiptPath(roots: PreparedRoots, requestId: string): string {
  return safeImmediateChild(roots.receiptRoot, `restore-${requestId}.json`)
}

type RestoreJournalDraft = Pick<RestoreJournal,
  'requestId' | 'backupId' | 'protectionBackupId' | 'saveName' |
  'beforeRevision' | 'afterRevision' | 'phase' | 'updatedAt'> &
  Partial<Pick<RestoreJournal, 'recoveryFromPhase'>>

interface RestoreJournalRecord {
  journal: RestoreJournal
  path: string
  kind: 'slot' | 'candidate'
}

interface RestoreJournalScan {
  records: RestoreJournalRecord[]
  latest: RestoreJournalRecord
  predecessor: RestoreJournalRecord | null
}

interface RestoreJournalInspection {
  blocked: boolean
  maintenanceRequired: boolean
  journal: RestoreJournal | null
  scan: RestoreJournalScan | null
}

function restoreJournalSlotPath(
  roots: PreparedRoots,
  requestId: string,
  slot: RestoreJournal['slot']
): string {
  return safeImmediateChild(roots.restoreJournalRoot, `restore-${requestId}-${slot}.json`)
}

function restoreJournalCandidatePath(
  roots: PreparedRoots,
  requestId: string,
  slot: RestoreJournal['slot']
): string {
  return safeImmediateChild(roots.restoreJournalRoot, `restore-${requestId}-${slot}.candidate.json`)
}

function restoreJournalRequestPaths(roots: PreparedRoots, requestId: string): string[] {
  return [
    restoreJournalSlotPath(roots, requestId, 'a'),
    restoreJournalSlotPath(roots, requestId, 'b'),
    restoreJournalCandidatePath(roots, requestId, 'a'),
    restoreJournalCandidatePath(roots, requestId, 'b')
  ]
}

async function inspectUnresolvedRestoreJournals(
  roots: PreparedRoots,
  readStablePair: (root: string, saveName: string) => Promise<PairEvidence>
): Promise<RestoreJournalInspection> {
  try {
    const scan = await scanRestoreJournalDirectory(roots)
    if (scan === null) {
      return { blocked: false, maintenanceRequired: false, journal: null, scan: null }
    }
    if (!await restoreJournalLayoutIsProvable(
      roots,
      scan.latest.journal,
      readStablePair,
      scan.records.length === 1 && scan.latest.kind === 'candidate'
    )) {
      return { blocked: true, maintenanceRequired: true, journal: null, scan }
    }
    return {
      blocked: false,
      maintenanceRequired: false,
      journal: scan.latest.journal,
      scan
    }
  } catch {
    // Foreign names, truncated slots/candidates, invalid digests, broken chains,
    // redirected entries and ambiguous layouts are durable maintenance evidence.
    return { blocked: true, maintenanceRequired: true, journal: null, scan: null }
  }
}

async function restoreJournalLayoutIsProvable(
  roots: PreparedRoots,
  journal: RestoreJournal,
  readStablePair: (root: string, saveName: string) => Promise<PairEvidence>,
  initialCandidateOnly = false
): Promise<boolean> {
  try {
    const receipt = await readRestoreReceipt(roots, journal.requestId)
    if (receipt !== null) {
      return receipt.backupId === journal.backupId &&
        receipt.protectionBackupId === journal.protectionBackupId &&
        receipt.saveName === journal.saveName &&
        receipt.beforeRevision === journal.beforeRevision &&
        receipt.afterRevision === journal.afterRevision
    }
    if (journal.phase === 'recovery-required') return true
    const [source, protection] = await Promise.all([
      readTrustedBackup(roots.backupRoot, journal.backupId, readStablePair),
      readTrustedBackup(roots.backupRoot, journal.protectionBackupId, readStablePair)
    ])
    if (source.manifest.saveName !== journal.saveName || source.pair.revision !== journal.afterRevision ||
        protection.manifest.saveName !== journal.saveName || protection.pair.revision !== journal.beforeRevision) {
      return false
    }
    if (initialCandidateOnly) {
      // The initial candidate is synced before its slot is published, while
      // every restore/rollback/GC artifact is created only after publication.
      await assertInitialRestoreArtifactsAbsent(roots.saveRoot, journal.requestId)
    }
    if (!['gc-pending', 'rolled-back'].includes(journal.phase)) {
      // Cleanup quarantine is first owned only after a terminal cleanup phase
      // is durable. An early prepared/forward/recovery phase may not adopt it.
      await assertRestoreCleanupQuarantineAbsent(roots.saveRoot, journal.requestId)
    }
    return restoreLayoutAllowsProtectionRecovery(
      journal.phase,
      pairPaths(roots.saveRoot, journal.saveName),
      restoreRollbackPaths(roots.saveRoot, journal.requestId),
      restoreStagePaths(roots.saveRoot, journal.requestId),
      protection.pair,
      source.pair
    )
  } catch {
    return false
  }
}

async function scanRestoreJournalDirectory(roots: PreparedRoots): Promise<RestoreJournalScan | null> {
  const entries = await readdir(roots.restoreJournalRoot, { withFileTypes: true })
  if (entries.length === 0) return null
  if (entries.length > maximumRestoreJournalEntries) throw new SaveTransactionError('SAVE_JOURNAL_MAINTENANCE_REQUIRED')
  const requestIds = new Set<string>()
  const records: RestoreJournalRecord[] = []
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new SaveTransactionError('SAVE_JOURNAL_MAINTENANCE_REQUIRED')
    }
    const slotMatch = restoreJournalSlotFilePattern.exec(entry.name)
    const candidateMatch = restoreJournalCandidateFilePattern.exec(entry.name)
    const match = slotMatch ?? candidateMatch
    if (match === null) throw new SaveTransactionError('SAVE_JOURNAL_MAINTENANCE_REQUIRED')
    const requestId = requestIdSchema.parse(match[1])
    const slot = z.enum(['a', 'b']).parse(match[2])
    requestIds.add(requestId)
    const journalPath = safeImmediateChild(roots.restoreJournalRoot, entry.name)
    const journal = await readRestoreJournalEnvelopeFile(journalPath, requestId, slot)
    const isInitial = journal.sequence === 1
    if (isInitial
      ? journal.previousDigest !== null || journal.slot !== 'a' || journal.phase !== 'prepared'
      : journal.previousDigest === null) {
      throw new SaveTransactionError('SAVE_JOURNAL_MAINTENANCE_REQUIRED')
    }
    records.push({ journal, path: journalPath, kind: candidateMatch === null ? 'slot' : 'candidate' })
  }
  if (requestIds.size !== 1 || records.length > 3) {
    throw new SaveTransactionError('SAVE_JOURNAL_MAINTENANCE_REQUIRED')
  }
  records.sort((left, right) => left.journal.sequence - right.journal.sequence)
  if (new Set(records.map((record) => record.journal.sequence)).size !== records.length) {
    throw new SaveTransactionError('SAVE_JOURNAL_MAINTENANCE_REQUIRED')
  }
  if (records.filter((record) => record.kind === 'candidate').length > 1) {
    throw new SaveTransactionError('SAVE_JOURNAL_MAINTENANCE_REQUIRED')
  }
  for (let index = 1; index < records.length; index += 1) {
    if (!restoreJournalRecordIsSuccessor(records[index - 1]!.journal, records[index]!.journal)) {
      throw new SaveTransactionError('SAVE_JOURNAL_MAINTENANCE_REQUIRED')
    }
  }
  const latest = records.at(-1)!
  if (records.some((record) => record.kind === 'candidate' && record !== latest)) {
    throw new SaveTransactionError('SAVE_JOURNAL_MAINTENANCE_REQUIRED')
  }
  if (latest.kind === 'candidate' && records.length === 1 &&
      (latest.journal.sequence !== 1 || latest.journal.previousDigest !== null ||
       latest.journal.slot !== 'a' || latest.journal.phase !== 'prepared')) {
    throw new SaveTransactionError('SAVE_JOURNAL_MAINTENANCE_REQUIRED')
  }
  return {
    records,
    latest,
    predecessor: records.length < 2 ? null : records.at(-2)!
  }
}

async function readRestoreJournalEnvelopeFile(
  journalPath: string,
  requestId: string,
  slot: RestoreJournal['slot']
): Promise<RestoreJournal> {
  const metadata = await assertNormalFile(journalPath)
  if (metadata.size < 1 || metadata.size > persistedControlFileMaximumBytes) {
    throw new SaveTransactionError('SAVE_JOURNAL_MAINTENANCE_REQUIRED')
  }
  let journal: RestoreJournal
  try {
    journal = restoreJournalSchema.parse(JSON.parse(await readFile(journalPath, 'utf8')) as unknown)
  } catch {
    throw new SaveTransactionError('SAVE_JOURNAL_MAINTENANCE_REQUIRED')
  }
  if (journal.requestId !== requestId || journal.slot !== slot ||
      journal.digest !== restoreJournalDigest(journal)) {
    throw new SaveTransactionError('SAVE_JOURNAL_MAINTENANCE_REQUIRED')
  }
  return journal
}

async function readRestoreJournal(roots: PreparedRoots, requestId: string): Promise<RestoreJournal | null> {
  const scan = await scanRestoreJournalDirectory(roots)
  if (scan === null) return null
  if (scan.latest.journal.requestId !== requestId) {
    throw new SaveTransactionError('SAVE_IDEMPOTENCY_CONFLICT')
  }
  if (scan.latest.kind === 'candidate') await publishRestoreJournalCandidate(roots, scan)
  return scan.latest.journal
}

async function createRestoreJournal(roots: PreparedRoots, draft: RestoreJournalDraft): Promise<RestoreJournal> {
  for (const candidate of restoreJournalRequestPaths(roots, draft.requestId)) await assertPathAbsent(candidate)
  const journal = makeRestoreJournalEnvelope(draft, null, 'a')
  await writeRestoreJournal(roots, journal, null)
  return journal
}

async function advanceRestoreJournal(
  roots: PreparedRoots,
  journal: RestoreJournal,
  phase: RestoreJournalPhase,
  now: Date
): Promise<RestoreJournal> {
  if (!isRestoreJournalTransitionAllowed(journal.phase, phase)) {
    throw new SaveTransactionError('SAVE_TRANSACTION_STORAGE_UNAVAILABLE')
  }
  const next = makeRestoreJournalEnvelope({
    ...restoreJournalDraft(journal),
    phase,
    updatedAt: now.toISOString()
  }, journal, oppositeRestoreJournalSlot(journal.slot))
  await writeRestoreJournal(roots, next, journal)
  return next
}

async function forceRestoreJournalPhase(
  roots: PreparedRoots,
  journal: RestoreJournal,
  phase: 'gc-pending' | 'rolled-back' | 'recovery-required' |
    'recovery-dsv-install-intent' | 'recovery-dsv-installed' |
    'recovery-server-install-intent' | 'recovery-server-installed',
  now: Date
): Promise<RestoreJournal> {
  const next = makeRestoreJournalEnvelope({
    ...restoreJournalDraft(journal),
    phase,
    ...(phase === 'recovery-required'
      ? { recoveryFromPhase: journal.recoveryFromPhase ?? journal.phase }
      : {}),
    updatedAt: now.toISOString()
  }, journal, oppositeRestoreJournalSlot(journal.slot))
  await writeRestoreJournal(roots, next, journal)
  return next
}

async function writeRestoreJournal(
  roots: PreparedRoots,
  journal: RestoreJournal,
  current: RestoreJournal | null
): Promise<void> {
  const parsed = parseRestoreJournalEnvelope(journal)
  if (current === null
    ? parsed.sequence !== 1 || parsed.previousDigest !== null || parsed.slot !== 'a' || parsed.phase !== 'prepared'
    : !restoreJournalRecordIsSuccessor(current, parsed)) {
    throw new SaveTransactionError('SAVE_TRANSACTION_STORAGE_UNAVAILABLE')
  }
  const candidatePath = restoreJournalCandidatePath(roots, parsed.requestId, parsed.slot)
  let handle: FileHandle | null = null
  try {
    handle = await open(candidatePath, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(parsed)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle?.close().catch(() => undefined)
  }
  await roots.journalHook?.(`after-journal-${parsed.phase}-sync`)
  if (current === null) {
    try {
      // The initial candidate does not establish ownership until publication.
      // Recheck after its durable write so a foreign fixed artifact introduced
      // in the candidate-sync window cannot be adopted by the new journal.
      await assertInitialRestoreArtifactsAbsent(roots.saveRoot, parsed.requestId)
    } catch {
      throw new SaveTransactionError('SAVE_JOURNAL_MAINTENANCE_REQUIRED')
    }
  }
  await publishRestoreJournalCandidate(roots, {
    records: current === null
      ? [{ journal: parsed, path: candidatePath, kind: 'candidate' }]
      : [
          { journal: current, path: restoreJournalSlotPath(roots, current.requestId, current.slot), kind: 'slot' },
          { journal: parsed, path: candidatePath, kind: 'candidate' }
        ],
    latest: { journal: parsed, path: candidatePath, kind: 'candidate' },
    predecessor: current === null
      ? null
      : { journal: current, path: restoreJournalSlotPath(roots, current.requestId, current.slot), kind: 'slot' }
  })
}

async function publishRestoreJournalCandidate(roots: PreparedRoots, scan: RestoreJournalScan): Promise<void> {
  if (scan.latest.kind !== 'candidate') return
  const next = scan.latest.journal
  const destination = restoreJournalSlotPath(roots, next.requestId, next.slot)
  if (await pathExists(destination)) {
    if (scan.predecessor === null || scan.predecessor.journal.previousDigest === null) {
      throw new SaveTransactionError('SAVE_JOURNAL_MAINTENANCE_REQUIRED')
    }
    const inactive = await readRestoreJournalEnvelopeFile(destination, next.requestId, next.slot)
    if (inactive.digest !== scan.predecessor.journal.previousDigest) {
      throw new SaveTransactionError('SAVE_JOURNAL_MAINTENANCE_REQUIRED')
    }
    await roots.journalHook?.('before-journal-slot-replace')
    await unlink(destination)
    await roots.journalHook?.('after-journal-slot-replace')
  }
  await rename(scan.latest.path, destination)
  try {
    await roots.journalHook?.('after-journal-slot-published')
  } catch (error) {
    // Publication is already the durable state transition. A callback failure
    // after rename must not make the caller continue from its predecessor and
    // create a divergent successor with the same sequence number.
    const published = await readRestoreJournalEnvelopeFile(destination, next.requestId, next.slot)
      .catch(() => null)
    if (published?.digest === next.digest) return
    throw error
  }
}

async function removeRestoreJournal(roots: PreparedRoots, expected: RestoreJournal): Promise<void> {
  let scan = await scanRestoreJournalDirectory(roots)
  if (scan === null || scan.latest.journal.requestId !== expected.requestId ||
      scan.latest.journal.digest !== expected.digest) {
    throw new SaveTransactionError('SAVE_TRANSACTION_STORAGE_UNAVAILABLE')
  }
  if (scan.latest.kind === 'candidate') {
    await publishRestoreJournalCandidate(roots, scan)
    scan = await scanRestoreJournalDirectory(roots)
    if (scan === null) throw new SaveTransactionError('SAVE_TRANSACTION_STORAGE_UNAVAILABLE')
  }
  for (const record of scan.records) {
    const verified = await readRestoreJournalEnvelopeFile(
      record.path,
      record.journal.requestId,
      record.journal.slot
    )
    if (verified.digest !== record.journal.digest) {
      throw new SaveTransactionError('SAVE_TRANSACTION_STORAGE_UNAVAILABLE')
    }
    await unlink(record.path)
  }
}

function makeRestoreJournalEnvelope(
  draft: RestoreJournalDraft,
  current: RestoreJournal | null,
  slot: RestoreJournal['slot']
): RestoreJournal {
  const body = {
    format: 'dyson-control-save-restore-journal-envelope' as const,
    schemaVersion,
    slot,
    sequence: current === null ? 1 : current.sequence + 1,
    previousDigest: current?.digest ?? null,
    ...draft
  }
  return parseRestoreJournalEnvelope({ ...body, digest: restoreJournalDigest(body) })
}

function restoreJournalDraft(journal: RestoreJournal): RestoreJournalDraft {
  return {
    requestId: journal.requestId,
    backupId: journal.backupId,
    protectionBackupId: journal.protectionBackupId,
    saveName: journal.saveName,
    beforeRevision: journal.beforeRevision,
    afterRevision: journal.afterRevision,
    phase: journal.phase,
    ...(journal.recoveryFromPhase === undefined ? {} : { recoveryFromPhase: journal.recoveryFromPhase }),
    updatedAt: journal.updatedAt
  }
}

function parseRestoreJournalEnvelope(input: unknown): RestoreJournal {
  const parsed = restoreJournalSchema.parse(input)
  if (parsed.digest !== restoreJournalDigest(parsed)) {
    throw new SaveTransactionError('SAVE_JOURNAL_MAINTENANCE_REQUIRED')
  }
  return parsed
}

function restoreJournalDigest(input: Omit<RestoreJournal, 'digest'> | RestoreJournal): string {
  const body = {
    format: input.format,
    schemaVersion: input.schemaVersion,
    slot: input.slot,
    sequence: input.sequence,
    previousDigest: input.previousDigest,
    requestId: input.requestId,
    backupId: input.backupId,
    protectionBackupId: input.protectionBackupId,
    saveName: input.saveName,
    beforeRevision: input.beforeRevision,
    afterRevision: input.afterRevision,
    phase: input.phase,
    ...(input.recoveryFromPhase === undefined ? {} : { recoveryFromPhase: input.recoveryFromPhase }),
    updatedAt: input.updatedAt
  }
  return createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex')
}

function oppositeRestoreJournalSlot(slot: RestoreJournal['slot']): RestoreJournal['slot'] {
  return slot === 'a' ? 'b' : 'a'
}

function restoreJournalRecordIsSuccessor(previous: RestoreJournal, next: RestoreJournal): boolean {
  return next.sequence === previous.sequence + 1 &&
    next.previousDigest === previous.digest &&
    next.slot === oppositeRestoreJournalSlot(previous.slot) &&
    next.requestId === previous.requestId && next.backupId === previous.backupId &&
    next.protectionBackupId === previous.protectionBackupId && next.saveName === previous.saveName &&
    next.beforeRevision === previous.beforeRevision && next.afterRevision === previous.afterRevision &&
    Date.parse(next.updatedAt) >= Date.parse(previous.updatedAt) &&
    (next.phase !== 'recovery-required' ||
      next.recoveryFromPhase === (previous.phase === 'recovery-required'
        ? previous.recoveryFromPhase
        : previous.phase)) &&
    isRestoreJournalSuccessorPhase(previous.phase, next.phase)
}

function isRestoreJournalSuccessorPhase(current: RestoreJournalPhase, next: RestoreJournalPhase): boolean {
  if (isRestoreJournalTransitionAllowed(current, next)) return true
  if (next === 'recovery-required' || next === 'gc-pending') return true
  if (next === 'rolled-back') return current !== 'gc-pending' && current !== 'recovery-required'
  if (next === 'recovery-dsv-install-intent') {
    return current !== 'gc-pending' && current !== 'rolled-back' && current !== 'recovery-required'
  }
  return next === current && [
    'gc-pending', 'rolled-back', 'recovery-dsv-install-intent',
    'recovery-dsv-installed', 'recovery-server-install-intent',
    'recovery-server-installed'
  ].includes(next)
}

function isRestoreJournalTransitionAllowed(
  current: z.infer<typeof restoreJournalPhaseSchema>,
  next: z.infer<typeof restoreJournalPhaseSchema>
): boolean {
  const forward: Partial<Record<z.infer<typeof restoreJournalPhaseSchema>, z.infer<typeof restoreJournalPhaseSchema>>> = {
    prepared: 'original-dsv-move-intent',
    'original-dsv-move-intent': 'original-dsv-moved',
    'original-dsv-moved': 'original-server-move-intent',
    'original-server-move-intent': 'original-server-moved',
    'original-server-moved': 'restored-dsv-install-intent',
    'restored-dsv-install-intent': 'restored-dsv-installed',
    'restored-dsv-installed': 'restored-server-install-intent',
    'restored-server-install-intent': 'restored-server-installed',
    'restored-server-installed': 'receipt-write-intent',
    'receipt-write-intent': 'gc-pending',
    'recovery-dsv-install-intent': 'recovery-dsv-installed',
    'recovery-dsv-installed': 'recovery-server-install-intent',
    'recovery-server-install-intent': 'recovery-server-installed',
    'recovery-server-installed': 'rolled-back'
  }
  return forward[current] === next
}

interface PreparedAuditInput {
  requestId: string
  operation: 'backup' | 'restore'
  dryRun: boolean
  backupId: string
  protectionBackupId?: string
  startedAt: string
}

interface FinishResultInput extends PreparedAuditInput {
  status: SaveTransactionStatus
  reused: boolean
  rollback: SaveTransactionResult['rollback']
  pairBytes: number
  cleanupPending?: boolean
  maintenanceRequired?: boolean
  beforeRevision?: string
  afterRevision?: string
  errorCode?: SaveTransactionErrorCode
}

interface CompleteResultInput extends FinishResultInput {
  finishedAt: string
  auditStored: boolean
}

function makeAudit(input: {
  requestId: string
  operation: 'backup' | 'restore'
  status: SaveTransactionStatus | 'prepared'
  dryRun: boolean
  backupId: string
  protectionBackupId?: string
  reused: boolean
  rollback: SaveTransactionResult['rollback']
  cleanupPending?: boolean
  maintenanceRequired?: boolean
  startedAt: string
  finishedAt: string
  errorCode?: SaveTransactionErrorCode
}): SaveTransactionAuditRecord {
  const cleanupPending = input.cleanupPending ?? false
  const maintenanceRequired = input.maintenanceRequired ?? (cleanupPending || input.status === 'rollback-failed')
  return {
    schemaVersion,
    requestId: input.requestId,
    action: input.operation === 'backup' ? 'save.backup' : 'save.restore',
    status: input.status,
    dryRun: input.dryRun,
    backupId: input.backupId,
    ...(input.protectionBackupId === undefined ? {} : { protectionBackupId: input.protectionBackupId }),
    reused: input.reused,
    rollback: input.rollback,
    cleanupPending,
    maintenanceRequired,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode })
  }
}

function makeResult(input: CompleteResultInput): SaveTransactionResult {
  const audit = makeAudit(input)
  const cleanupPending = input.cleanupPending ?? false
  const maintenanceRequired = input.maintenanceRequired ?? (cleanupPending || input.status === 'rollback-failed')
  return {
    schemaVersion,
    requestId: input.requestId,
    operation: input.operation,
    status: input.status,
    dryRun: input.dryRun,
    backupId: input.backupId,
    ...(input.protectionBackupId === undefined ? {} : { protectionBackupId: input.protectionBackupId }),
    reused: input.reused,
    rollback: input.rollback,
    pairBytes: input.pairBytes,
    cleanupPending,
    maintenanceRequired,
    ...(input.beforeRevision === undefined ? {} : { beforeRevision: input.beforeRevision }),
    ...(input.afterRevision === undefined ? {} : { afterRevision: input.afterRevision }),
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    auditStored: input.auditStored,
    audit
  }
}

async function storeAudit(
  roots: PreparedRoots,
  audit: SaveTransactionAuditRecord,
  minimumIndex = 0
): Promise<void> {
  const serialized = JSON.stringify(audit)
  if (/"(?:sha256|path|root|password|secret|beforeRevision|afterRevision)"\s*:/i.test(serialized)) {
    throw new SaveTransactionError('SAVE_TRANSACTION_STORAGE_UNAVAILABLE')
  }
  for (let index = minimumIndex; index < maximumAuditAttempts; index += 1) {
    const auditPath = safeImmediateChild(
      roots.auditRoot,
      `${audit.requestId}-${audit.action === 'save.backup' ? 'backup' : 'restore'}-${index}.json`
    )
    let handle: FileHandle | null = null
    try {
      handle = await open(auditPath, 'wx', 0o600)
      await handle.writeFile(serialized, 'utf8')
      await handle.sync()
      return
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }
  throw new SaveTransactionError('SAVE_TRANSACTION_STORAGE_UNAVAILABLE')
}

async function removeNormalFile(filePath: string): Promise<void> {
  await assertNormalFile(filePath)
  await unlink(filePath)
}

async function removeFileIfExists(filePath: string): Promise<void> {
  try {
    await removeNormalFile(filePath)
  } catch (error) {
    if (error instanceof SaveTransactionError && error.code === 'SAVE_PAIR_INCOMPLETE') return
    if (hasCode(error, 'ENOENT')) return
    throw error
  }
}

async function createOrRecoverStageDirectory(
  directory: string,
  allowlistedFileNames: readonly string[]
): Promise<void> {
  try {
    await mkdir(directory, { mode: 0o700 })
    return
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) {
      throw new SaveTransactionError('SAVE_TRANSACTION_STORAGE_UNAVAILABLE')
    }
  }

  try {
    const normalDirectory = await resolveNormalDirectory(directory)
    const names = await readdir(normalDirectory)
    const allowed = new Set(allowlistedFileNames)
    if (names.length > allowlistedFileNames.length || names.some((name) => !allowed.has(name))) {
      throw new SaveTransactionError('SAVE_TRANSACTION_STORAGE_UNAVAILABLE')
    }
    for (const name of names) await removeNormalFile(safeImmediateChild(normalDirectory, name))
    await rmdir(normalDirectory)
    await mkdir(directory, { mode: 0o700 })
  } catch (error) {
    if (error instanceof SaveTransactionError) throw error
    throw new SaveTransactionError('SAVE_TRANSACTION_STORAGE_UNAVAILABLE')
  }
}

async function assertPathAbsent(filePath: string): Promise<void> {
  try {
    await lstat(filePath)
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return
    throw new SaveTransactionError('SAVE_TRANSACTION_STORAGE_UNAVAILABLE')
  }
  throw new SaveTransactionError('SAVE_TRANSACTION_STORAGE_UNAVAILABLE')
}

function restoreFailureCode(error: unknown): SaveTransactionErrorCode {
  if (error instanceof SaveTransactionError &&
      (error.code === 'SAVE_REVISION_CONFLICT' || error.code === 'SAVE_BACKUP_CORRUPT' ||
       error.code === 'SAVE_COMMIT_VERIFICATION_FAILED')) return error.code
  return 'SAVE_COMMIT_FAILED'
}

function safeErrorCode(error: unknown): SaveTransactionErrorCode {
  return error instanceof SaveTransactionError
    ? error.code
    : 'SAVE_TRANSACTION_STORAGE_UNAVAILABLE'
}

function sameMetadata(left: Stats, right: Stats): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

function sameFileSnapshot(metadata: Stats, evidence: FileEvidence): boolean {
  return metadata.size === evidence.bytes && metadata.mtimeMs === evidence.modifiedMs &&
    metadata.ctimeMs === evidence.changedMs
}

function normalizePath(value: string): string {
  return path.resolve(value).replace(/[\\/]+$/, '').toLocaleLowerCase('en-US')
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

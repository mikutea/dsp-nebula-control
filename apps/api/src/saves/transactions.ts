import { createHash, randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
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
const lockFileName = 'transaction.lock'
const maximumAuditAttempts = 32
const streamBufferBytes = 1024 * 1024
const defaultStableWindowMs = 250
const defaultSnapshotAttempts = 3
const pairRevisionPattern = /^pair-v1:[a-f0-9]{64}$/

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
  completedAt: z.string().datetime({ offset: true })
})

export type SaveTransactionErrorCode =
  | 'SAVE_REQUEST_INVALID'
  | 'SAVE_ROOT_UNAVAILABLE'
  | 'SAVE_TRANSACTION_STORAGE_UNAVAILABLE'
  | 'SAVE_TRANSACTION_BUSY'
  | 'SAVE_PAIR_INCOMPLETE'
  | 'SAVE_PAIR_REDIRECTED'
  | 'SAVE_PAIR_CHANGED'
  | 'SAVE_BACKUP_CORRUPT'
  | 'SAVE_IDEMPOTENCY_CONFLICT'
  | 'SAVE_SERVICE_NOT_STOPPED'
  | 'SAVE_REVISION_CONFLICT'
  | 'SAVE_COMMIT_FAILED'
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

export type SaveTransactionHookPhase =
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
  lockPath: string
  key: string
}

interface AcquiredLock {
  key: string
  path: string
  handle: FileHandle
}

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

interface RestoreCommitState {
  originalDsvMoved: boolean
  originalServerMoved: boolean
  restoredDsvInstalled: boolean
  restoredServerInstalled: boolean
}

const inProcessLocks = new Set<string>()

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
    let roots: PreparedRoots | null = null
    let lock: AcquiredLock | null = null
    let pairBytes = 0
    let beforeRevision: string | undefined
    let mutationMayHaveOccurred = false
    let rollback: SaveTransactionResult['rollback'] = 'not-required'

    try {
      roots = await prepareRoots(this.#configuredSaveRoot, this.#configuredBackupRoot)
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

      const backup = await readTrustedBackup(roots.backupRoot, request.backupId, this.#readStablePair.bind(this))
      pairBytes = backup.pair.totalBytes
      await this.#assertServiceStopped()

      const receipt = await readRestoreReceipt(roots, request.requestId)
      if (receipt !== null) {
        if (receipt.backupId !== request.backupId ||
            receipt.protectionBackupId !== protectionBackupId ||
            receipt.saveName !== backup.manifest.saveName ||
            receipt.beforeRevision !== request.expectedRevision) {
          throw new SaveTransactionError('SAVE_IDEMPOTENCY_CONFLICT')
        }
        const current = await this.#readStablePair(roots.saveRoot, receipt.saveName)
        if (current.revision !== receipt.afterRevision) {
          throw new SaveTransactionError('SAVE_IDEMPOTENCY_CONFLICT')
        }
        return await this.#finish(roots, {
          requestId: request.requestId,
          operation: 'restore',
          status: 'succeeded',
          dryRun: request.dryRun,
          backupId: request.backupId,
          protectionBackupId,
          reused: true,
          rollback,
          pairBytes,
          startedAt,
          beforeRevision: current.revision,
          afterRevision: current.revision
        })
      }

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
      await this.#phase('protection-created')

      const stage = await createRestoreStage(roots.saveRoot, request.requestId)
      const rollbackPaths = restoreRollbackPaths(roots.saveRoot, request.requestId)
      const targetPaths = pairPaths(roots.saveRoot, backup.manifest.saveName)
      const state: RestoreCommitState = {
        originalDsvMoved: false,
        originalServerMoved: false,
        restoredDsvInstalled: false,
        restoredServerInstalled: false
      }
      let receiptStored = false
      try {
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
        await rename(targetPaths.dsv, rollbackPaths.dsv)
        state.originalDsvMoved = true
        await this.#phase('after-original-dsv-moved')
        await rename(targetPaths.server, rollbackPaths.server)
        state.originalServerMoved = true
        await this.#phase('after-original-server-moved')
        await rename(stage.dsv, targetPaths.dsv)
        state.restoredDsvInstalled = true
        await this.#phase('after-restored-dsv-installed')
        await rename(stage.server, targetPaths.server)
        state.restoredServerInstalled = true
        await this.#phase('after-restored-server-installed')
        await this.#phase('before-restore-verify')

        const restored = await this.#readStablePair(roots.saveRoot, backup.manifest.saveName)
        if (restored.revision !== backup.pair.revision || !samePairContent(restored, backup.pair)) {
          throw new SaveTransactionError('SAVE_COMMIT_VERIFICATION_FAILED')
        }
        await writeRestoreReceipt(roots, {
          schemaVersion,
          requestId: request.requestId,
          backupId: request.backupId,
          protectionBackupId,
          saveName: backup.manifest.saveName,
          beforeRevision: request.expectedRevision,
          afterRevision: restored.revision,
          completedAt: this.#now().toISOString()
        })
        receiptStored = true

        const result = await this.#finish(roots, {
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
          afterRevision: restored.revision
        }, 1)
        await removeNormalFile(rollbackPaths.dsv)
        await removeNormalFile(rollbackPaths.server)
        await cleanupRestoreStage(stage)
        return result
      } catch (error) {
        if (receiptStored) await removeRestoreReceipt(roots, request.requestId)
        if (!mutationMayHaveOccurred) {
          await cleanupRestoreStage(stage)
          throw error
        }
        try {
          await this.#phase('before-rollback')
          await rollbackRestore(targetPaths, rollbackPaths, state)
          const rolledBack = await this.#readStablePair(roots.saveRoot, backup.manifest.saveName)
          if (rolledBack.revision !== request.expectedRevision || !samePairContent(rolledBack, protection.pair)) {
            throw new SaveTransactionError('SAVE_ROLLBACK_FAILED')
          }
          rollback = 'succeeded'
          await cleanupRestoreStage(stage)
          return await this.#finish(roots, {
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
          }, 1)
        } catch {
          rollback = 'failed'
          await cleanupRestoreStage(stage).catch(() => undefined)
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
    } catch (error) {
      const code = safeErrorCode(error)
      return await this.#finishIfPossible(roots, {
        requestId: request.requestId,
        operation: 'restore',
        status: code === 'SAVE_REVISION_CONFLICT'
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
        rollback,
        pairBytes,
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

async function prepareRoots(saveRoot: string, backupRoot: string): Promise<PreparedRoots> {
  const preparedSaveRoot = await prepareNormalRoot(saveRoot)
  const preparedBackupRoot = await prepareNormalRoot(backupRoot)
  try {
    // Keep transaction metadata beside the trusted save root so the backup
    // catalog remains a collection of protection-point directories only.
    const controlRoot = await ensureNormalChildDirectory(preparedSaveRoot, controlDirectoryName)
    const auditRoot = await ensureNormalChildDirectory(controlRoot, auditDirectoryName)
    const receiptRoot = await ensureNormalChildDirectory(controlRoot, receiptDirectoryName)
    return {
      saveRoot: preparedSaveRoot,
      backupRoot: preparedBackupRoot,
      controlRoot,
      auditRoot,
      receiptRoot,
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
  let handle: FileHandle | null = null
  try {
    handle = await open(roots.lockPath, 'wx', 0o600)
    await handle.writeFile(JSON.stringify({ schemaVersion, requestId, startedAt }), 'utf8')
    await handle.sync()
    return { key: roots.key, path: roots.lockPath, handle }
  } catch (error) {
    if (handle !== null) await handle.close().catch(() => undefined)
    inProcessLocks.delete(roots.key)
    if (hasCode(error, 'EEXIST')) return null
    throw new SaveTransactionError('SAVE_TRANSACTION_STORAGE_UNAVAILABLE')
  }
}

async function releaseExclusiveLock(lock: AcquiredLock): Promise<void> {
  await lock.handle.close().catch(() => undefined)
  try {
    await unlink(lock.path)
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) {
      inProcessLocks.delete(lock.key)
      return
    }
  }
  inProcessLocks.delete(lock.key)
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
  const directory = safeImmediateChild(saveRoot, `.restore-stage-${requestId}`)
  const stage = {
    directory,
    dsv: safeImmediateChild(directory, 'pair.dsv'),
    server: safeImmediateChild(directory, 'pair.server')
  }
  await createOrRecoverStageDirectory(directory, ['pair.dsv', 'pair.server'])
  return stage
}

async function copyBackupIntoRestoreStage(backup: TrustedBackup, stage: RestoreStage): Promise<void> {
  const source = pairPaths(backup.directory, backup.manifest.saveName)
  const dsv = await copyAndHashStableFile(source.dsv, stage.dsv)
  const server = await copyAndHashStableFile(source.server, stage.server)
  const copied = makePairEvidence(backup.manifest.saveName, dsv, server)
  if (!samePairContent(copied, backup.pair)) throw new SaveTransactionError('SAVE_BACKUP_CORRUPT')
}

async function cleanupRestoreStage(stage: RestoreStage): Promise<void> {
  await removeFileIfExists(stage.dsv)
  await removeFileIfExists(stage.server)
  await rmdir(stage.directory).catch((error) => {
    if (!hasCode(error, 'ENOENT')) throw error
  })
}

function restoreRollbackPaths(saveRoot: string, requestId: string): { dsv: string; server: string } {
  return {
    dsv: safeImmediateChild(saveRoot, `.rollback-${requestId}-dsv.bin`),
    server: safeImmediateChild(saveRoot, `.rollback-${requestId}-server.bin`)
  }
}

async function rollbackRestore(
  targets: { dsv: string; server: string },
  rollbackPaths: { dsv: string; server: string },
  state: RestoreCommitState
): Promise<void> {
  if (state.restoredDsvInstalled) await removeNormalFile(targets.dsv)
  if (state.restoredServerInstalled) await removeNormalFile(targets.server)
  if (state.originalDsvMoved) await rename(rollbackPaths.dsv, targets.dsv)
  if (state.originalServerMoved) await rename(rollbackPaths.server, targets.server)
}

async function readRestoreReceipt(roots: PreparedRoots, requestId: string): Promise<z.infer<typeof restoreReceiptSchema> | null> {
  const receiptPath = restoreReceiptPath(roots, requestId)
  try {
    const metadata = await assertNormalFile(receiptPath)
    if (metadata.size <= 0 || metadata.size > MAX_MANIFEST_BYTES) {
      throw new SaveTransactionError('SAVE_IDEMPOTENCY_CONFLICT')
    }
    return restoreReceiptSchema.parse(JSON.parse(await readFile(receiptPath, 'utf8')) as unknown)
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

async function removeRestoreReceipt(roots: PreparedRoots, requestId: string): Promise<void> {
  await removeNormalFile(restoreReceiptPath(roots, requestId))
}

function restoreReceiptPath(roots: PreparedRoots, requestId: string): string {
  return safeImmediateChild(roots.receiptRoot, `restore-${requestId}.json`)
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
  startedAt: string
  finishedAt: string
  errorCode?: SaveTransactionErrorCode
}): SaveTransactionAuditRecord {
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
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode })
  }
}

function makeResult(input: CompleteResultInput): SaveTransactionResult {
  const audit = makeAudit(input)
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

import { isUtf8 } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  type FileHandle
} from 'node:fs/promises'
import path from 'node:path'
import {
  HostMutationOperationCoordinatorError,
  hostMutationReturn,
  hostMutationThrow,
  type HostMutationDisposition,
  type HostMutationOperationCoordinator,
  type HostMutationOperationScope
} from '../host-mutation/operation-coordinator.js'
import { gameConfigCatalog, type GameConfigFileId } from './catalog.js'
import { findBepInExValue } from './bepinex.js'
import {
  inspectGameConfiguration,
  type GameConfigFiles,
  type PublicGameConfigValue
} from './planner.js'

const managedFiles = Object.freeze([
  { id: 'nebula', fileName: 'nebula.cfg', storedName: 'nebula.bin' },
  { id: 'galaxy', fileName: 'nebulaGameDescSettings.cfg', storedName: 'galaxy.bin' },
  { id: 'bepinex', fileName: 'BepInEx.cfg', storedName: 'bepinex.bin' },
  { id: 'bridge', fileName: 'io.github.mikutea.dyson-control-bridge.cfg', storedName: 'bridge.bin' }
] as const satisfies ReadonlyArray<{ id: GameConfigFileId; fileName: string; storedName: string }>)

const snapshotFormat = 'dyson-control-game-config-snapshot' as const
const receiptFormat = 'dyson-control-game-config-restore-receipt' as const
const journalFormat = 'dyson-control-game-config-restore-journal' as const
const maximumConfigBytes = 512 * 1024
const maximumManifestBytes = 128 * 1024
const maximumReceiptBytes = 64 * 1024
const maximumJournalBytes = 64 * 1024
const sha256Pattern = /^[0-9a-f]{64}$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const processLocks = new Set<string>()

export type GameConfigSnapshotKind = 'manual' | 'pre-restore'

export interface GameConfigHistoryLimits {
  maximumSnapshots?: number
  maximumSnapshotBytes?: number
  maximumTotalSnapshotBytes?: number
  maximumReceipts?: number
  maximumInterruptedTransactions?: number
}

interface NormalizedLimits {
  maximumSnapshots: number
  maximumSnapshotBytes: number
  maximumTotalSnapshotBytes: number
  maximumReceipts: number
  maximumInterruptedTransactions: number
}

export interface GameConfigStopProofContext {
  token: string
  requestId: string
  snapshotId: string
  phase: 'prepare' | 'publish' | 'reconcile'
}

export type GameConfigStopProofValidator = (
  context: GameConfigStopProofContext,
  signal?: AbortSignal
) => boolean | Promise<boolean>

export type GameConfigHistoryHookPhase =
  | 'after-target-read'
  | 'before-protection'
  | 'before-publish-file'
  | 'after-publish-file'
  | 'before-rollback'
  | 'before-reconcile'
  | 'before-lock-release'

export interface GameConfigHistoryTestHooks {
  onPhase?: (
    phase: GameConfigHistoryHookPhase,
    detail: { fileId?: GameConfigFileId; index?: number }
  ) => void | Promise<void>
  /** @internal Simulates an uncatchable process exit after an atomic file publication. */
  simulateInterruptionAfterFileIndex?: number
}

export interface GameConfigHistoryServiceOptions {
  /** Trusted server-side directory containing the four managed configuration files. */
  configRoot: string
  validateStopProof: GameConfigStopProofValidator
  hostMutationCoordinator?: HostMutationOperationCoordinator
  limits?: GameConfigHistoryLimits
  /** @internal Deterministic test clock. */
  now?: () => Date
  /** @internal Deterministic test UUID source. */
  createId?: () => string
  /** @internal Fault and race injection used only by unit tests. */
  testHooks?: GameConfigHistoryTestHooks
}

export interface GameConfigSnapshotSummary {
  format: typeof snapshotFormat
  snapshotId: string
  kind: GameConfigSnapshotKind
  createdAt: string
  revision: string
  manifestSha256: string
  fileCount: number
  totalBytes: number
}

export interface GameConfigSnapshotFileDetail {
  id: GameConfigFileId
  present: boolean
  bytes: number
}

export interface GameConfigSnapshotDetail extends GameConfigSnapshotSummary {
  files: GameConfigSnapshotFileDetail[]
}

export interface GameConfigHistoryDiffEntry {
  id: string
  file: GameConfigFileId
  before: PublicGameConfigValue
  after: PublicGameConfigValue
  changed: boolean
}

export interface GameConfigHistoryFileDiff {
  id: GameConfigFileId
  beforePresent: boolean
  afterPresent: boolean
  changed: boolean
}

export interface GameConfigHistoryDiff {
  snapshotId: string
  currentRevision: string
  targetRevision: string
  files: GameConfigHistoryFileDiff[]
  settings: GameConfigHistoryDiffEntry[]
}

export interface RestoreGameConfigurationRequest {
  requestId: string
  snapshotId: string
  expectedCurrentRevision: string
  stopProofToken: string
  dryRun?: boolean
}

export type GameConfigRestoreStatus =
  | 'busy'
  | 'dry-run'
  | 'restored'
  | 'rejected'
  | 'rolled-back'
  | 'recovery-required'
  | 'interrupted-recovered'

export type GameConfigHistoryErrorCode =
  | 'CONFIG_HISTORY_REQUEST_INVALID'
  | 'CONFIG_HISTORY_REQUEST_CONFLICT'
  | 'CONFIG_HISTORY_ROOT_UNAVAILABLE'
  | 'CONFIG_HISTORY_STORAGE_UNAVAILABLE'
  | 'CONFIG_HISTORY_BUSY'
  | 'CONFIG_HISTORY_CAPACITY_EXCEEDED'
  | 'CONFIG_HISTORY_SNAPSHOT_INVALID'
  | 'CONFIG_HISTORY_REVISION_CONFLICT'
  | 'CONFIG_HISTORY_STOP_PROOF_REJECTED'
  | 'CONFIG_HISTORY_RECONCILIATION_REQUIRED'
  | 'CONFIG_HISTORY_COMMIT_FAILED'
  | 'CONFIG_HISTORY_ROLLBACK_FAILED'
  | 'CONFIG_HISTORY_INTERRUPTED_RECOVERED'
  | 'CONFIG_HISTORY_HOST_LEASE_BUSY'
  | 'CONFIG_HISTORY_HOST_LEASE_DIRTY'
  | 'CONFIG_HISTORY_HOST_LEASE_RECOVERY_REQUIRED'
  | 'CONFIG_HISTORY_HOST_LEASE_LOST'
  | 'CONFIG_HISTORY_HOST_LEASE_UNAVAILABLE'

export interface GameConfigRestoreReceipt {
  format: typeof receiptFormat
  version: 1
  requestId: string
  snapshotId: string
  protectionSnapshotId: string | null
  status: GameConfigRestoreStatus
  dryRun: boolean
  expectedCurrentRevision: string
  targetRevision: string | null
  finalRevision: string | null
  errorCode: GameConfigHistoryErrorCode | 'NONE'
  startedAt: string
  finishedAt: string
  persisted: boolean
  reused: boolean
}

export interface GameConfigRecoveryResult {
  requestId: string
  status: 'committed-cleanup' | 'interrupted-recovered' | 'recovery-required'
  finalRevision: string | null
  errorCode: GameConfigHistoryErrorCode | 'NONE'
}

interface SnapshotFileManifest {
  id: GameConfigFileId
  present: boolean
  bytes: number
  sha256: string | null
}

interface SnapshotManifest {
  format: typeof snapshotFormat
  version: 1
  snapshotId: string
  kind: GameConfigSnapshotKind
  requestId: string | null
  createdAt: string
  revision: string
  fileCount: number
  totalBytes: number
  files: SnapshotFileManifest[]
}

interface LoadedSnapshot {
  manifest: SnapshotManifest
  manifestSha256: string
  buffers: ConfigBuffers
}

interface StoredReceipt {
  fingerprint: string
  receipt: Omit<GameConfigRestoreReceipt, 'persisted' | 'reused'>
}

interface RestoreJournal {
  format: typeof journalFormat
  version: 1
  requestId: string
  fingerprint: string
  snapshotId: string
  protectionSnapshotId: string
  expectedCurrentRevision: string
  targetRevision: string
  startedAt: string
  state: 'prepared' | 'publishing' | 'recovery-required'
}

interface PreparedRoot {
  root: string
  controlRoot: string
  historyRoot: string
  snapshotsRoot: string
  receiptsRoot: string
  pendingRoot: string
  orphansRoot: string
  snapshotStagingRoot: string
  lockPath: string
}

interface AcquiredLock {
  rootKey: string
  lockPath: string
  handle: FileHandle
  identity: LockFileIdentity
}

interface LockFileIdentity {
  dev: bigint
  ino: bigint
  ctimeNs: bigint
  birthtimeNs: bigint
}

interface GameConfigHostMutationContext {
  readonly scope: HostMutationOperationScope
  markPossibleLiveWrite(): void
  markDurableVerifiedTerminal(): void
}

type ConfigBuffers = Record<GameConfigFileId, Buffer | null>

class SimulatedInterruptionError extends Error {
  constructor() {
    super('TEST_SIMULATED_PROCESS_EXIT')
    this.name = 'SimulatedInterruptionError'
  }
}

export class GameConfigHistoryService {
  readonly #configuredRoot: string
  readonly #stopProofValidator: GameConfigStopProofValidator
  readonly #hostMutationCoordinator: HostMutationOperationCoordinator | null
  readonly #limits: NormalizedLimits
  readonly #now: () => Date
  readonly #createId: () => string
  readonly #hooks: GameConfigHistoryTestHooks | undefined

  constructor(options: GameConfigHistoryServiceOptions) {
    if (!options || typeof options.configRoot !== 'string' || options.configRoot.trim().length === 0 ||
        typeof options.validateStopProof !== 'function' ||
        (options.hostMutationCoordinator !== undefined &&
          typeof options.hostMutationCoordinator.runExclusive !== 'function')) {
      throw new GameConfigHistoryError('CONFIG_HISTORY_REQUEST_INVALID')
    }
    this.#configuredRoot = path.resolve(options.configRoot)
    this.#stopProofValidator = options.validateStopProof
    this.#hostMutationCoordinator = options.hostMutationCoordinator ?? null
    this.#limits = normalizeLimits(options.limits)
    this.#now = options.now ?? (() => new Date())
    this.#createId = options.createId ?? randomUUID
    this.#hooks = options.testHooks
  }

  async capture(): Promise<GameConfigSnapshotDetail> {
    const root = await prepareRoot(this.#configuredRoot)
    const lock = await acquireLock(root, this.#nextId(), this.#now().toISOString())
    if (!lock) throw new GameConfigHistoryError('CONFIG_HISTORY_BUSY')
    try {
      assertNoInterruptedTransactions(await listInterruptedRoots(root, this.#limits))
      const buffers = await readConfigBuffers(root.root)
      const snapshot = await this.#createSnapshot(root, buffers, 'manual', null)
      return publicSnapshotDetail(snapshot)
    } catch (error) {
      throw sanitizeHistoryError(error)
    } finally {
      await this.#releaseLock(lock)
    }
  }

  async list(): Promise<GameConfigSnapshotSummary[]> {
    try {
      const root = await prepareRoot(this.#configuredRoot)
      const snapshots = await listLoadedSnapshots(root, this.#limits)
      return snapshots
        .map(publicSnapshotSummary)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) ||
          right.snapshotId.localeCompare(left.snapshotId))
    } catch (error) {
      throw sanitizeHistoryError(error)
    }
  }

  async detail(snapshotId: string): Promise<GameConfigSnapshotDetail> {
    try {
      assertUuid(snapshotId)
      const root = await prepareRoot(this.#configuredRoot)
      return publicSnapshotDetail(await readSnapshot(root, snapshotId, this.#limits))
    } catch (error) {
      throw sanitizeHistoryError(error)
    }
  }

  async diff(snapshotId: string): Promise<GameConfigHistoryDiff> {
    try {
      assertUuid(snapshotId)
      const root = await prepareRoot(this.#configuredRoot)
      const [target, current] = await Promise.all([
        readSnapshot(root, snapshotId, this.#limits),
        readConfigBuffers(root.root)
      ])
      return buildPublicDiff(snapshotId, current, target.buffers)
    } catch (error) {
      throw sanitizeHistoryError(error)
    }
  }

  async restore(request: RestoreGameConfigurationRequest): Promise<GameConfigRestoreReceipt> {
    const normalized = normalizeRestoreRequest(request)
    const fingerprint = restoreFingerprint(normalized)
    const startedAt = this.#now().toISOString()
    const root = await prepareRoot(this.#configuredRoot)
    const lock = await acquireLock(root, normalized.requestId, startedAt)
    if (!lock) {
      return makeReceipt({
        request: normalized, status: 'busy', targetRevision: null, finalRevision: null,
        protectionSnapshotId: null, errorCode: 'CONFIG_HISTORY_BUSY', startedAt,
        finishedAt: this.#now().toISOString(), persisted: false, reused: false
      })
    }

    try {
      const stored = await readStoredReceipt(root, normalized.requestId, this.#limits)
      if (stored) {
        if (stored.fingerprint !== fingerprint) {
          throw new GameConfigHistoryError('CONFIG_HISTORY_REQUEST_CONFLICT')
        }
        return { ...stored.receipt, persisted: true, reused: true }
      }
      return await this.#runHostMutation(
        'game-config-restore',
        normalized.requestId,
        async (hostMutationContext) => {
          const hostMutationScope = hostMutationContext.scope
          const persistTerminal = (
            input: Omit<ReceiptInput, 'finishedAt' | 'persisted' | 'reused'>
          ) => this.#persistTerminal(root, fingerprint, input, hostMutationContext)
      await assertReceiptCapacity(root, this.#limits)
      if ((await listInterruptedRoots(root, this.#limits)).length > 0) {
        return persistTerminal({
          request: normalized, status: 'rejected', targetRevision: null, finalRevision: null,
          protectionSnapshotId: null, errorCode: 'CONFIG_HISTORY_RECONCILIATION_REQUIRED', startedAt
        })
      }

      let target: LoadedSnapshot
      try {
        target = await readSnapshot(root, normalized.snapshotId, this.#limits)
      } catch {
        return persistTerminal({
          request: normalized, status: 'rejected', targetRevision: null, finalRevision: null,
          protectionSnapshotId: null, errorCode: 'CONFIG_HISTORY_SNAPSHOT_INVALID', startedAt
        })
      }
      const current = await readConfigBuffers(root.root)
      const currentRevision = revisionOf(current)
      if (currentRevision !== normalized.expectedCurrentRevision) {
        return persistTerminal({
          request: normalized, status: 'rejected', targetRevision: target.manifest.revision,
          finalRevision: currentRevision, protectionSnapshotId: null,
          errorCode: 'CONFIG_HISTORY_REVISION_CONFLICT', startedAt
        })
      }
      await this.#phase('after-target-read', {})
      try {
        const reverifiedTarget = await readSnapshot(root, normalized.snapshotId, this.#limits)
        if (reverifiedTarget.manifestSha256 !== target.manifestSha256 ||
            !equalBufferSets(reverifiedTarget.buffers, target.buffers)) {
          throw new GameConfigHistoryError('CONFIG_HISTORY_SNAPSHOT_INVALID')
        }
        target = reverifiedTarget
      } catch {
        return persistTerminal({
          request: normalized, status: 'rejected', targetRevision: target.manifest.revision,
          finalRevision: currentRevision, protectionSnapshotId: null,
          errorCode: 'CONFIG_HISTORY_SNAPSHOT_INVALID', startedAt
        })
      }
      if (!await this.#stopProof(normalized, 'prepare', hostMutationScope)) {
        return persistTerminal({
          request: normalized, status: 'rejected', targetRevision: target.manifest.revision,
          finalRevision: currentRevision, protectionSnapshotId: null,
          errorCode: 'CONFIG_HISTORY_STOP_PROOF_REJECTED', startedAt
        })
      }
      if (normalized.dryRun) {
        return persistTerminal({
          request: normalized, status: 'dry-run', targetRevision: target.manifest.revision,
          finalRevision: currentRevision, protectionSnapshotId: null, errorCode: 'NONE', startedAt
        })
      }

      await this.#phase('before-protection', {})
      const protectedCurrent = await readConfigBuffers(root.root)
      if (!equalBufferSets(protectedCurrent, current)) {
        return persistTerminal({
          request: normalized, status: 'rejected', targetRevision: target.manifest.revision,
          finalRevision: revisionOf(protectedCurrent), protectionSnapshotId: null,
          errorCode: 'CONFIG_HISTORY_REVISION_CONFLICT', startedAt
        })
      }
      let protection: LoadedSnapshot
      try {
        protection = await this.#createSnapshot(
          root, protectedCurrent, 'pre-restore', normalized.requestId
        )
      } catch (error) {
        const errorCode = error instanceof GameConfigHistoryError &&
          ['CONFIG_HISTORY_CAPACITY_EXCEEDED', 'CONFIG_HISTORY_SNAPSHOT_INVALID'].includes(error.code)
          ? error.code
          : 'CONFIG_HISTORY_STORAGE_UNAVAILABLE'
        return persistTerminal({
          request: normalized, status: 'rejected', targetRevision: target.manifest.revision,
          finalRevision: currentRevision, protectionSnapshotId: null, errorCode, startedAt
        })
      }

      let transactionRoot: string | null = null
      let mutationStarted = false
      try {
        const verifiedTarget = await readSnapshot(root, normalized.snapshotId, this.#limits)
        if (verifiedTarget.manifestSha256 !== target.manifestSha256 ||
            !equalBufferSets(verifiedTarget.buffers, target.buffers)) {
          throw new GameConfigHistoryError('CONFIG_HISTORY_SNAPSHOT_INVALID')
        }
        target = verifiedTarget
        transactionRoot = await createTransactionRoot(root, normalized.requestId)
        const journal: RestoreJournal = {
          format: journalFormat,
          version: 1,
          requestId: normalized.requestId,
          fingerprint,
          snapshotId: normalized.snapshotId,
          protectionSnapshotId: protection.manifest.snapshotId,
          expectedCurrentRevision: normalized.expectedCurrentRevision,
          targetRevision: target.manifest.revision,
          startedAt,
          state: 'prepared'
        }
        await writeJournal(transactionRoot, journal)
        await stageBuffers(transactionRoot, 'target', target.buffers)
        await assertCurrentState(root.root, protectedCurrent)
        journal.state = 'publishing'
        await writeJournal(transactionRoot, journal, true)
        mutationStarted = true
        await this.#publishBuffers(
          root,
          transactionRoot,
          'target',
          target.buffers,
          protectedCurrent,
          normalized,
          hostMutationContext
        )
        const committed = await readConfigBuffers(root.root)
        if (!equalBufferSets(committed, target.buffers) || revisionOf(committed) !== target.manifest.revision) {
          throw new GameConfigHistoryError('CONFIG_HISTORY_COMMIT_FAILED')
        }
        const receipt = await persistTerminal({
          request: normalized, status: 'restored', targetRevision: target.manifest.revision,
          finalRevision: target.manifest.revision, protectionSnapshotId: protection.manifest.snapshotId,
          errorCode: 'NONE', startedAt
        })
        // The durable terminal receipt is the commit point. A cleanup failure
        // must leave the journal for reconciliation, never compensate a commit
        // that callers have already been told succeeded.
        await removeTransactionRoot(transactionRoot, root.pendingRoot).catch(() => undefined)
        return receipt
      } catch (error) {
        if (error instanceof HostMutationOperationCoordinatorError) throw error
        if (error instanceof SimulatedInterruptionError) throw error
        const failureCode: GameConfigHistoryErrorCode = error instanceof GameConfigHistoryError &&
          ['CONFIG_HISTORY_SNAPSHOT_INVALID', 'CONFIG_HISTORY_REVISION_CONFLICT',
            'CONFIG_HISTORY_STOP_PROOF_REJECTED'].includes(error.code)
          ? error.code
          : 'CONFIG_HISTORY_COMMIT_FAILED'
        if (!mutationStarted) {
          if (transactionRoot) await removeTransactionRoot(transactionRoot, root.pendingRoot).catch(() => undefined)
          return persistTerminal({
            request: normalized, status: 'rejected', targetRevision: target.manifest.revision,
            finalRevision: revisionOf(await readConfigBuffers(root.root)),
            protectionSnapshotId: protection.manifest.snapshotId, errorCode: failureCode, startedAt
          })
        }
        try {
          await this.#phase('before-rollback', {})
          if (!transactionRoot) throw new GameConfigHistoryError('CONFIG_HISTORY_ROLLBACK_FAILED')
          await stageBuffers(transactionRoot, 'rollback', protection.buffers)
          await publishAllBuffers(
            root,
            transactionRoot,
            'rollback',
            protection.buffers,
            hostMutationContext
          )
          await assertCurrentState(root.root, protection.buffers)
          const receipt = await persistTerminal({
            request: normalized, status: 'rolled-back', targetRevision: target.manifest.revision,
            finalRevision: protection.manifest.revision,
            protectionSnapshotId: protection.manifest.snapshotId,
            errorCode: failureCode, startedAt
          })
          await removeTransactionRoot(transactionRoot, root.pendingRoot).catch(() => undefined)
          return receipt
        } catch (rollbackError) {
          if (rollbackError instanceof HostMutationOperationCoordinatorError) throw rollbackError
          if (transactionRoot) {
            await markRecoveryRequired(transactionRoot).catch(() => undefined)
            await moveTransactionToOrphans(root, transactionRoot, normalized.requestId).catch(() => undefined)
          }
          return persistTerminal({
            request: normalized, status: 'recovery-required', targetRevision: target.manifest.revision,
            finalRevision: safeRevision(await readConfigBuffers(root.root).catch(() => null)),
            protectionSnapshotId: protection.manifest.snapshotId,
            errorCode: 'CONFIG_HISTORY_ROLLBACK_FAILED', startedAt
          })
        }
      }
        },
        restoreHostMutationDisposition
      )
    } catch (error) {
      if (error instanceof SimulatedInterruptionError) throw error
      throw sanitizeHistoryError(error)
    } finally {
      await this.#releaseLock(lock)
    }
  }

  async reconcileInterrupted(stopProofToken: string): Promise<GameConfigRecoveryResult[]> {
    assertStopProofToken(stopProofToken)
    const root = await prepareRoot(this.#configuredRoot)
    const lockId = this.#nextId()
    const lock = await acquireLock(root, lockId, this.#now().toISOString())
    if (!lock) throw new GameConfigHistoryError('CONFIG_HISTORY_BUSY')
    try {
      return await this.#runHostMutation(
        'game-config-reconcile',
        lockId,
        async (hostMutationContext) => {
      const hostMutationScope = hostMutationContext.scope
      const interrupted = await listInterruptedRoots(root, this.#limits)
      const results: GameConfigRecoveryResult[] = []
      for (const candidate of interrupted) {
        let journal: RestoreJournal
        try {
          journal = await readJournal(candidate.path)
        } catch {
          results.push({
            requestId: candidate.requestId,
            status: 'recovery-required',
            finalRevision: safeRevision(await readConfigBuffers(root.root).catch(() => null)),
            errorCode: 'CONFIG_HISTORY_RECONCILIATION_REQUIRED'
          })
          continue
        }
        const stored = await readStoredReceipt(root, journal.requestId, this.#limits).catch(() => null)
        if (stored && ['restored', 'rolled-back', 'interrupted-recovered'].includes(stored.receipt.status)) {
          const current = await readConfigBuffers(root.root).catch(() => null)
          if (current && stored.receipt.finalRevision !== null &&
              revisionOf(current) === stored.receipt.finalRevision) {
            await removeTransactionRoot(candidate.path, candidate.parentRoot)
            results.push({
              requestId: journal.requestId,
              status: 'committed-cleanup',
              finalRevision: stored.receipt.finalRevision,
              errorCode: 'NONE'
            })
            continue
          }
        }

        await this.#phase('before-reconcile', {})
        const validProof = await this.#validateStopProof({
          token: stopProofToken,
          requestId: journal.requestId,
          snapshotId: journal.snapshotId,
          phase: 'reconcile'
        }, hostMutationScope)
        if (!validProof) {
          results.push({
            requestId: journal.requestId,
            status: 'recovery-required',
            finalRevision: safeRevision(await readConfigBuffers(root.root).catch(() => null)),
            errorCode: 'CONFIG_HISTORY_STOP_PROOF_REJECTED'
          })
          continue
        }

        try {
          const protection = await readSnapshot(root, journal.protectionSnapshotId, this.#limits)
          await stageBuffers(candidate.path, 'reconcile', protection.buffers)
          if (!await this.#validateStopProof({
            token: stopProofToken,
            requestId: journal.requestId,
            snapshotId: journal.snapshotId,
            phase: 'reconcile'
          }, hostMutationScope)) {
            throw new GameConfigHistoryError('CONFIG_HISTORY_STOP_PROOF_REJECTED')
          }
          await publishAllBuffers(
            root,
            candidate.path,
            'reconcile',
            protection.buffers,
            hostMutationContext
          )
          await assertCurrentState(root.root, protection.buffers)
          const receipt = makeReceipt({
            request: {
              requestId: journal.requestId,
              snapshotId: journal.snapshotId,
              expectedCurrentRevision: journal.expectedCurrentRevision,
              stopProofToken,
              dryRun: false
            },
            status: 'interrupted-recovered',
            targetRevision: journal.targetRevision,
            finalRevision: protection.manifest.revision,
            protectionSnapshotId: protection.manifest.snapshotId,
            errorCode: 'CONFIG_HISTORY_INTERRUPTED_RECOVERED',
            startedAt: journal.startedAt,
            finishedAt: this.#now().toISOString(),
            persisted: true,
            reused: false
          })
          await writeStoredReceipt(root, journal.fingerprint, receipt, stored !== null)
          assertHostMutationActive(hostMutationScope)
          hostMutationContext.markDurableVerifiedTerminal()
          await removeTransactionRoot(candidate.path, candidate.parentRoot)
          results.push({
            requestId: journal.requestId,
            status: 'interrupted-recovered',
            finalRevision: protection.manifest.revision,
            errorCode: 'CONFIG_HISTORY_INTERRUPTED_RECOVERED'
          })
        } catch (error) {
          if (error instanceof HostMutationOperationCoordinatorError) throw error
          results.push({
            requestId: journal.requestId,
            status: 'recovery-required',
            finalRevision: safeRevision(await readConfigBuffers(root.root).catch(() => null)),
            errorCode: error instanceof GameConfigHistoryError &&
              error.code === 'CONFIG_HISTORY_STOP_PROOF_REJECTED'
              ? error.code
              : 'CONFIG_HISTORY_ROLLBACK_FAILED'
          })
        }
      }
      return results
        },
        reconcileHostMutationDisposition
      )
    } catch (error) {
      throw sanitizeHistoryError(error)
    } finally {
      await this.#releaseLock(lock)
    }
  }

  async #createSnapshot(
    root: PreparedRoot,
    buffers: ConfigBuffers,
    kind: GameConfigSnapshotKind,
    requestId: string | null
  ): Promise<LoadedSnapshot> {
    const snapshotId = this.#nextId()
    const createdAt = this.#now().toISOString()
    assertIsoTimestamp(createdAt)
    const manifest = createSnapshotManifest(snapshotId, kind, requestId, createdAt, buffers)
    const manifestBytes = canonicalJsonBytes(manifest)
    const snapshotBytes = manifestBytes.byteLength + manifest.totalBytes
    if (snapshotBytes > this.#limits.maximumSnapshotBytes) {
      throw new GameConfigHistoryError('CONFIG_HISTORY_CAPACITY_EXCEEDED')
    }
    const existing = await listLoadedSnapshots(root, this.#limits)
    if (existing.length >= this.#limits.maximumSnapshots ||
        existing.reduce((sum, snapshot) => sum + snapshotStorageBytes(snapshot), 0) + snapshotBytes >
          this.#limits.maximumTotalSnapshotBytes) {
      throw new GameConfigHistoryError('CONFIG_HISTORY_CAPACITY_EXCEEDED')
    }

    const stagingName = `snapshot-${snapshotId}`
    const stagingRoot = fixedChild(root.snapshotStagingRoot, stagingName)
    const finalRoot = fixedChild(root.snapshotsRoot, snapshotId)
    await mkdir(stagingRoot, { mode: 0o700 })
    try {
      await assertPlainDirectory(stagingRoot, root.snapshotStagingRoot)
      for (const file of managedFiles) {
        const content = buffers[file.id]
        if (content !== null) {
          await writeDurableExclusive(fixedChild(stagingRoot, file.storedName), content)
        }
      }
      await writeDurableExclusive(fixedChild(stagingRoot, 'manifest.json'), manifestBytes)
      await syncDirectory(stagingRoot)
      await rename(stagingRoot, finalRoot)
      await syncDirectory(root.snapshotsRoot)
    } catch (error) {
      await removeFixedTree(stagingRoot, root.snapshotStagingRoot).catch(() => undefined)
      throw error
    }
    return readSnapshot(root, snapshotId, this.#limits)
  }

  async #publishBuffers(
    root: PreparedRoot,
    transactionRoot: string,
    stageName: string,
    desired: ConfigBuffers,
    initial: ConfigBuffers,
    request: NormalizedRestoreRequest,
    hostMutationContext: GameConfigHostMutationContext
  ): Promise<void> {
    const hostMutationScope = hostMutationContext.scope
    const expected: ConfigBuffers = cloneBuffers(initial)
    for (const [index, file] of managedFiles.entries()) {
      await this.#phase('before-publish-file', { fileId: file.id, index })
      await assertCurrentState(root.root, expected)
      if (!await this.#stopProof(request, 'publish', hostMutationScope)) {
        throw new GameConfigHistoryError('CONFIG_HISTORY_STOP_PROOF_REJECTED')
      }
      await publishOneBuffer(
        root.root,
        transactionRoot,
        stageName,
        file,
        desired[file.id],
        index,
        hostMutationContext
      )
      expected[file.id] = desired[file.id] === null ? null : Buffer.from(desired[file.id]!)
      await this.#phase('after-publish-file', { fileId: file.id, index })
      if (this.#hooks?.simulateInterruptionAfterFileIndex === index) {
        throw new SimulatedInterruptionError()
      }
    }
  }

  async #persistTerminal(
    root: PreparedRoot,
    fingerprint: string,
    input: Omit<ReceiptInput, 'finishedAt' | 'persisted' | 'reused'>,
    hostMutationContext: GameConfigHostMutationContext
  ): Promise<GameConfigRestoreReceipt> {
    const receipt = makeReceipt({
      ...input,
      finishedAt: this.#now().toISOString(),
      persisted: true,
      reused: false
    })
    await writeStoredReceipt(root, fingerprint, receipt)
    assertHostMutationActive(hostMutationContext.scope)
    if (receipt.status === 'restored' || receipt.status === 'rolled-back') {
      hostMutationContext.markDurableVerifiedTerminal()
    }
    return receipt
  }

  async #stopProof(
    request: NormalizedRestoreRequest,
    phase: GameConfigStopProofContext['phase'],
    hostMutationScope: HostMutationOperationScope
  ): Promise<boolean> {
    return this.#validateStopProof({
      token: request.stopProofToken,
      requestId: request.requestId,
      snapshotId: request.snapshotId,
      phase
    }, hostMutationScope)
  }

  async #validateStopProof(
    context: GameConfigStopProofContext,
    hostMutationScope: HostMutationOperationScope
  ): Promise<boolean> {
    assertHostMutationActive(hostMutationScope)
    const valid = await validateStopProofSafely(
      this.#stopProofValidator,
      context,
      hostMutationScope.signal
    )
    assertHostMutationActive(hostMutationScope)
    return valid
  }

  async #runHostMutation<T>(
    operation: string,
    requestId: string,
    action: (context: GameConfigHostMutationContext) => Promise<T>,
    dispositionForResult: (result: T) => HostMutationDisposition
  ): Promise<T> {
    const coordinator = this.#hostMutationCoordinator
    if (coordinator === null) {
      throw new GameConfigHistoryError('CONFIG_HISTORY_HOST_LEASE_UNAVAILABLE')
    }
    try {
      return await coordinator.runExclusive(
        { operation, requestId },
        async (scope) => {
          let possibleLiveWrite = false
          const context: GameConfigHostMutationContext = {
            scope,
            markPossibleLiveWrite: () => { possibleLiveWrite = true },
            markDurableVerifiedTerminal: () => { possibleLiveWrite = false }
          }
          try {
            const result = await action(context)
            return hostMutationReturn(result, dispositionForResult(result))
          } catch (error) {
            if (error instanceof HostMutationOperationCoordinatorError) throw error
            if (error instanceof SimulatedInterruptionError) {
              return hostMutationThrow<T>(error, 'abandon')
            }
            if (error instanceof GameConfigHistoryError) {
              return hostMutationThrow<T>(
                error,
                possibleLiveWrite ? 'abandon' : historyErrorHostMutationDisposition(error.code)
              )
            }
            return hostMutationThrow<T>(sanitizeHistoryError(error), 'abandon')
          }
        }
      )
    } catch (error) {
      if (error instanceof HostMutationOperationCoordinatorError) {
        throw new GameConfigHistoryError(mapHostMutationCoordinatorError(error.code))
      }
      throw error
    }
  }

  async #phase(
    phase: GameConfigHistoryHookPhase,
    detail: { fileId?: GameConfigFileId; index?: number }
  ): Promise<void> {
    await this.#hooks?.onPhase?.(phase, detail)
  }

  async #releaseLock(lock: AcquiredLock): Promise<void> {
    let hookError: unknown = null
    try {
      await this.#phase('before-lock-release', {})
    } catch (error) {
      hookError = error
    }
    try {
      await releaseLock(lock)
    } catch (error) {
      throw sanitizeHistoryError(error)
    }
    if (hookError !== null) throw sanitizeHistoryError(hookError)
  }

  #nextId(): string {
    const id = this.#createId().toLocaleLowerCase('en-US')
    assertUuid(id)
    return id
  }
}

interface NormalizedRestoreRequest {
  requestId: string
  snapshotId: string
  expectedCurrentRevision: string
  stopProofToken: string
  dryRun: boolean
}

interface ReceiptInput {
  request: NormalizedRestoreRequest
  status: GameConfigRestoreStatus
  protectionSnapshotId: string | null
  targetRevision: string | null
  finalRevision: string | null
  errorCode: GameConfigHistoryErrorCode | 'NONE'
  startedAt: string
  finishedAt: string
  persisted: boolean
  reused: boolean
}

interface InterruptedRoot {
  requestId: string
  path: string
  parentRoot: string
}

function normalizeLimits(input: GameConfigHistoryLimits | undefined): NormalizedLimits {
  const defaults: NormalizedLimits = {
    maximumSnapshots: 128,
    maximumSnapshotBytes: 4 * 1024 * 1024,
    maximumTotalSnapshotBytes: 256 * 1024 * 1024,
    maximumReceipts: 2_048,
    maximumInterruptedTransactions: 32
  }
  if (input === undefined) return defaults
  const keys = Object.keys(input)
  if (keys.some((key) => !(key in defaults))) {
    throw new GameConfigHistoryError('CONFIG_HISTORY_REQUEST_INVALID')
  }
  const result = { ...defaults, ...input }
  for (const [key, value] of Object.entries(result)) {
    const upper = defaults[key as keyof NormalizedLimits]
    if (!Number.isSafeInteger(value) || value < 1 || value > upper) {
      throw new GameConfigHistoryError('CONFIG_HISTORY_REQUEST_INVALID')
    }
  }
  return result
}

async function prepareRoot(configuredRoot: string): Promise<PreparedRoot> {
  try {
    await assertPlainDirectory(configuredRoot)
    const canonicalRoot = await realpath(configuredRoot)
    if (!samePath(canonicalRoot, configuredRoot)) {
      throw new GameConfigHistoryError('CONFIG_HISTORY_ROOT_UNAVAILABLE')
    }
    const controlRoot = fixedChild(canonicalRoot, '.dyson-control')
    await ensurePlainDirectory(controlRoot, canonicalRoot)
    const historyRoot = fixedChild(controlRoot, 'config-history')
    await ensurePlainDirectory(historyRoot, controlRoot)
    const snapshotsRoot = fixedChild(historyRoot, 'snapshots')
    const receiptsRoot = fixedChild(historyRoot, 'receipts')
    const pendingRoot = fixedChild(historyRoot, 'pending')
    const orphansRoot = fixedChild(historyRoot, 'orphans')
    const snapshotStagingRoot = fixedChild(historyRoot, 'snapshot-staging')
    for (const directory of [snapshotsRoot, receiptsRoot, pendingRoot, orphansRoot, snapshotStagingRoot]) {
      await ensurePlainDirectory(directory, historyRoot)
    }
    return {
      root: canonicalRoot,
      controlRoot,
      historyRoot,
      snapshotsRoot,
      receiptsRoot,
      pendingRoot,
      orphansRoot,
      snapshotStagingRoot,
      lockPath: fixedChild(controlRoot, 'configuration.lock')
    }
  } catch (error) {
    if (error instanceof GameConfigHistoryError) throw error
    throw new GameConfigHistoryError('CONFIG_HISTORY_ROOT_UNAVAILABLE')
  }
}

async function ensurePlainDirectory(directory: string, parent: string): Promise<void> {
  await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
    if (!hasErrorCode(error, 'EEXIST')) throw error
  })
  await assertPlainDirectory(directory, parent)
}

async function assertPlainDirectory(directory: string, parent?: string): Promise<void> {
  const metadata = await lstat(directory)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
      !samePath(await realpath(directory), directory) ||
      (parent !== undefined && !samePath(path.dirname(directory), parent))) {
    throw new GameConfigHistoryError('CONFIG_HISTORY_STORAGE_UNAVAILABLE')
  }
}

async function acquireLock(
  root: PreparedRoot,
  requestId: string,
  startedAt: string
): Promise<AcquiredLock | null> {
  const rootKey = normalizePath(root.root)
  if (processLocks.has(rootKey)) return null
  processLocks.add(rootKey)
  let handle: FileHandle | null = null
  let identity: LockFileIdentity | null = null
  try {
    handle = await open(root.lockPath, 'wx', 0o600).catch((error: unknown) => {
      if (hasErrorCode(error, 'EEXIST')) return null
      throw error
    })
    if (!handle) {
      processLocks.delete(rootKey)
      return null
    }
    const initial = await handle.stat({ bigint: true })
    if (!initial.isFile()) throw new GameConfigHistoryError('CONFIG_HISTORY_STORAGE_UNAVAILABLE')
    identity = lockFileIdentity(initial)
    await handle.writeFile(`${JSON.stringify({
      format: 'dyson-control-game-config-history-lock', version: 1, requestId, startedAt
    })}\n`, 'utf8')
    await handle.sync()
    const finalized = await handle.stat({ bigint: true })
    if (!sameLockFileOwner(finalized, identity)) {
      throw new GameConfigHistoryError('CONFIG_HISTORY_STORAGE_UNAVAILABLE')
    }
    identity = lockFileIdentity(finalized)
    return { rootKey, lockPath: root.lockPath, handle, identity }
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    if (identity !== null) {
      await unlinkOwnedLockFile(root.lockPath, identity, false).catch(() => false)
    }
    processLocks.delete(rootKey)
    throw sanitizeHistoryError(error)
  }
}

async function releaseLock(lock: AcquiredLock): Promise<void> {
  let closeFailed = false
  try {
    await lock.handle.close()
  } catch {
    closeFailed = true
  } finally {
    processLocks.delete(lock.rootKey)
  }
  let removed = false
  try {
    removed = await unlinkOwnedLockFile(lock.lockPath, lock.identity, true)
  } catch {
    throw new GameConfigHistoryError('CONFIG_HISTORY_STORAGE_UNAVAILABLE')
  }
  if (closeFailed || !removed) {
    throw new GameConfigHistoryError('CONFIG_HISTORY_STORAGE_UNAVAILABLE')
  }
}

function lockFileIdentity(metadata: BigIntStats): LockFileIdentity {
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    ctimeNs: metadata.ctimeNs,
    birthtimeNs: metadata.birthtimeNs
  }
}

function sameLockFileOwner(metadata: BigIntStats, identity: LockFileIdentity): boolean {
  return metadata.isFile() && !metadata.isSymbolicLink() &&
    metadata.dev === identity.dev && metadata.ino === identity.ino &&
    metadata.birthtimeNs === identity.birthtimeNs
}

function sameLockFileIdentity(metadata: BigIntStats, identity: LockFileIdentity): boolean {
  return sameLockFileOwner(metadata, identity) && metadata.ctimeNs === identity.ctimeNs
}

async function unlinkOwnedLockFile(
  lockPath: string,
  identity: LockFileIdentity,
  requireFinalIdentity: boolean
): Promise<boolean> {
  const metadata = await lstat(lockPath, { bigint: true }).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT')) return null
    throw error
  })
  if (metadata === null ||
      !(requireFinalIdentity
        ? sameLockFileIdentity(metadata, identity)
        : sameLockFileOwner(metadata, identity)) ||
      !samePath(await realpath(lockPath), lockPath)) {
    return false
  }
  await unlink(lockPath)
  return true
}

async function readConfigBuffers(root: string): Promise<ConfigBuffers> {
  const first = await readConfigBuffersOnce(root)
  const second = await readConfigBuffersOnce(root)
  if (!equalBufferSets(first, second)) {
    throw new GameConfigHistoryError('CONFIG_HISTORY_STORAGE_UNAVAILABLE')
  }
  return second
}

async function readConfigBuffersOnce(root: string): Promise<ConfigBuffers> {
  await assertPlainDirectory(root)
  const entries = await Promise.all(managedFiles.map(async (file) => [
    file.id,
    await readStableOptionalFile(root, file.fileName, maximumConfigBytes)
  ] as const))
  const buffers = Object.fromEntries(entries) as ConfigBuffers
  for (const file of managedFiles) {
    const content = buffers[file.id]
    if (content !== null) decodeConfig(content)
  }
  return buffers
}

async function readStableOptionalFile(
  root: string,
  fileName: string,
  maximumBytes: number
): Promise<Buffer | null> {
  const target = fixedChild(root, fileName)
  const initial = await lstat(target, { bigint: true }).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT')) return null
    throw error
  })
  if (initial === null) return null
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size > BigInt(maximumBytes) ||
      !samePath(await realpath(target), target)) {
    throw new GameConfigHistoryError('CONFIG_HISTORY_STORAGE_UNAVAILABLE')
  }
  const handle = await open(target, 'r')
  try {
    const before = await handle.stat({ bigint: true })
    if (!sameFileSnapshot(initial, before) || before.size > BigInt(maximumBytes)) {
      throw new GameConfigHistoryError('CONFIG_HISTORY_STORAGE_UNAVAILABLE')
    }
    const content = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    const final = await lstat(target, { bigint: true })
    if (!sameFileSnapshot(before, after) || !sameFileSnapshot(after, final) ||
        content.byteLength !== Number(after.size) || final.isSymbolicLink() ||
        !samePath(await realpath(target), target)) {
      throw new GameConfigHistoryError('CONFIG_HISTORY_STORAGE_UNAVAILABLE')
    }
    return content
  } finally {
    await handle.close()
  }
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function createSnapshotManifest(
  snapshotId: string,
  kind: GameConfigSnapshotKind,
  requestId: string | null,
  createdAt: string,
  buffers: ConfigBuffers
): SnapshotManifest {
  const files = managedFiles.map((file): SnapshotFileManifest => {
    const content = buffers[file.id]
    return {
      id: file.id,
      present: content !== null,
      bytes: content?.byteLength ?? 0,
      sha256: content === null ? null : sha256(content)
    }
  })
  return {
    format: snapshotFormat,
    version: 1,
    snapshotId,
    kind,
    requestId,
    createdAt,
    revision: revisionOf(buffers),
    fileCount: files.filter((file) => file.present).length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files
  }
}

async function readSnapshot(
  root: PreparedRoot,
  snapshotId: string,
  limits: NormalizedLimits
): Promise<LoadedSnapshot> {
  assertUuid(snapshotId)
  const snapshotRoot = fixedChild(root.snapshotsRoot, snapshotId)
  try {
    await assertPlainDirectory(snapshotRoot, root.snapshotsRoot)
    const manifestBytes = await readStableRequiredFile(snapshotRoot, 'manifest.json', maximumManifestBytes)
    const parsed = JSON.parse(decodeUtf8(manifestBytes)) as unknown
    if (!isSnapshotManifest(parsed, snapshotId, limits)) {
      throw new GameConfigHistoryError('CONFIG_HISTORY_SNAPSHOT_INVALID')
    }
    if (!manifestBytes.equals(canonicalJsonBytes(parsed))) {
      throw new GameConfigHistoryError('CONFIG_HISTORY_SNAPSHOT_INVALID')
    }
    const expectedNames = ['manifest.json', ...parsed.files
      .filter((file) => file.present)
      .map((file) => managedFiles.find((managed) => managed.id === file.id)!.storedName)]
      .sort(compareOrdinal)
    const actualEntries = await readdir(snapshotRoot, { withFileTypes: true })
    const actualNames = actualEntries.map((entry) => entry.name).sort(compareOrdinal)
    if (!sameStringArray(actualNames, expectedNames) ||
        actualEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
      throw new GameConfigHistoryError('CONFIG_HISTORY_SNAPSHOT_INVALID')
    }

    const entries = await Promise.all(managedFiles.map(async (managed) => {
      const file = parsed.files.find((candidate) => candidate.id === managed.id)!
      if (!file.present) return [managed.id, null] as const
      const content = await readStableRequiredFile(snapshotRoot, managed.storedName, maximumConfigBytes)
      if (content.byteLength !== file.bytes || sha256(content) !== file.sha256) {
        throw new GameConfigHistoryError('CONFIG_HISTORY_SNAPSHOT_INVALID')
      }
      decodeConfig(content)
      return [managed.id, content] as const
    }))
    const buffers = Object.fromEntries(entries) as ConfigBuffers
    if (revisionOf(buffers) !== parsed.revision) {
      throw new GameConfigHistoryError('CONFIG_HISTORY_SNAPSHOT_INVALID')
    }
    return { manifest: parsed, manifestSha256: sha256(manifestBytes), buffers }
  } catch (error) {
    if (error instanceof GameConfigHistoryError &&
        error.code === 'CONFIG_HISTORY_CAPACITY_EXCEEDED') throw error
    throw new GameConfigHistoryError('CONFIG_HISTORY_SNAPSHOT_INVALID')
  }
}

async function readStableRequiredFile(root: string, fileName: string, maximumBytes: number): Promise<Buffer> {
  const content = await readStableOptionalFile(root, fileName, maximumBytes)
  if (content === null) throw new GameConfigHistoryError('CONFIG_HISTORY_STORAGE_UNAVAILABLE')
  return content
}

async function listLoadedSnapshots(
  root: PreparedRoot,
  limits: NormalizedLimits
): Promise<LoadedSnapshot[]> {
  const entries = await readdir(root.snapshotsRoot, { withFileTypes: true })
  if (entries.length > limits.maximumSnapshots) {
    throw new GameConfigHistoryError('CONFIG_HISTORY_CAPACITY_EXCEEDED')
  }
  const snapshots: LoadedSnapshot[] = []
  let totalBytes = 0
  for (const entry of entries.sort((left, right) => compareOrdinal(left.name, right.name))) {
    if (!uuidPattern.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw new GameConfigHistoryError('CONFIG_HISTORY_SNAPSHOT_INVALID')
    }
    const snapshot = await readSnapshot(root, entry.name, limits)
    const bytes = snapshotStorageBytes(snapshot)
    if (bytes > limits.maximumSnapshotBytes) {
      throw new GameConfigHistoryError('CONFIG_HISTORY_CAPACITY_EXCEEDED')
    }
    totalBytes += bytes
    if (totalBytes > limits.maximumTotalSnapshotBytes) {
      throw new GameConfigHistoryError('CONFIG_HISTORY_CAPACITY_EXCEEDED')
    }
    snapshots.push(snapshot)
  }
  return snapshots
}

function publicSnapshotSummary(snapshot: LoadedSnapshot): GameConfigSnapshotSummary {
  return {
    format: snapshotFormat,
    snapshotId: snapshot.manifest.snapshotId,
    kind: snapshot.manifest.kind,
    createdAt: snapshot.manifest.createdAt,
    revision: snapshot.manifest.revision,
    manifestSha256: snapshot.manifestSha256,
    fileCount: snapshot.manifest.fileCount,
    totalBytes: snapshot.manifest.totalBytes
  }
}

function publicSnapshotDetail(snapshot: LoadedSnapshot): GameConfigSnapshotDetail {
  return {
    ...publicSnapshotSummary(snapshot),
    files: snapshot.manifest.files.map((file) => ({
      id: file.id,
      present: file.present,
      bytes: file.bytes
    }))
  }
}

function buildPublicDiff(
  snapshotId: string,
  current: ConfigBuffers,
  target: ConfigBuffers
): GameConfigHistoryDiff {
  const currentFiles = buffersToFiles(current)
  const targetFiles = buffersToFiles(target)
  const currentInspection = inspectGameConfiguration(currentFiles)
  const targetInspection = inspectGameConfiguration(targetFiles)
  const currentEntries = new Map(currentInspection.entries.map((entry) => [entry.id, entry]))
  const targetEntries = new Map(targetInspection.entries.map((entry) => [entry.id, entry]))
  const settings = gameConfigCatalog.map((definition): GameConfigHistoryDiffEntry => {
    const before = currentEntries.get(definition.id)!
    const after = targetEntries.get(definition.id)!
    const changed = definition.type === 'secret'
      ? (findBepInExValue(
          currentFiles[definition.file] ?? '', definition.section, definition.key
        ) ?? '') !== (findBepInExValue(
          targetFiles[definition.file] ?? '', definition.section, definition.key
        ) ?? '')
      : !samePublicValue(before.value, after.value)
    return {
      id: definition.id,
      file: definition.file,
      before: clonePublicValue(before.value),
      after: clonePublicValue(after.value),
      changed
    }
  })
  return {
    snapshotId,
    currentRevision: currentInspection.revision,
    targetRevision: targetInspection.revision,
    files: managedFiles.map((file) => ({
      id: file.id,
      beforePresent: current[file.id] !== null,
      afterPresent: target[file.id] !== null,
      changed: !equalBuffers(current[file.id], target[file.id])
    })),
    settings
  }
}

function isSnapshotManifest(
  value: unknown,
  snapshotId: string,
  limits: NormalizedLimits
): value is SnapshotManifest {
  if (!isRecord(value) || !hasExactKeys(value, [
    'format', 'version', 'snapshotId', 'kind', 'requestId', 'createdAt', 'revision',
    'fileCount', 'totalBytes', 'files'
  ]) || value.format !== snapshotFormat || value.version !== 1 || value.snapshotId !== snapshotId ||
      !['manual', 'pre-restore'].includes(String(value.kind)) ||
      !(value.requestId === null || typeof value.requestId === 'string' && uuidPattern.test(value.requestId)) ||
      typeof value.createdAt !== 'string' || !isIsoTimestamp(value.createdAt) ||
      typeof value.revision !== 'string' || !sha256Pattern.test(value.revision) ||
      !Number.isSafeInteger(value.fileCount) || Number(value.fileCount) < 0 ||
      Number(value.fileCount) > managedFiles.length ||
      !Number.isSafeInteger(value.totalBytes) || Number(value.totalBytes) < 0 ||
      Number(value.totalBytes) > limits.maximumSnapshotBytes || !Array.isArray(value.files)) return false
  const files: unknown[] = value.files
  if (files.length !== managedFiles.length) return false
  let present = 0
  let totalBytes = 0
  for (const [index, managed] of managedFiles.entries()) {
    const file = files[index]
    if (!isRecord(file) || !hasExactKeys(file, ['id', 'present', 'bytes', 'sha256']) ||
        file.id !== managed.id || typeof file.present !== 'boolean' ||
        !Number.isSafeInteger(file.bytes) || Number(file.bytes) < 0 ||
        Number(file.bytes) > maximumConfigBytes) return false
    if (file.present) {
      if (typeof file.sha256 !== 'string' || !sha256Pattern.test(file.sha256)) return false
      present++
      totalBytes += Number(file.bytes)
    } else if (file.sha256 !== null || file.bytes !== 0) return false
  }
  if (present !== value.fileCount || totalBytes !== value.totalBytes) return false
  if (value.kind === 'manual' && value.requestId !== null) return false
  if (value.kind === 'pre-restore' &&
      (typeof value.requestId !== 'string' || !uuidPattern.test(value.requestId))) return false
  return true
}

function snapshotStorageBytes(snapshot: LoadedSnapshot): number {
  return snapshot.manifest.totalBytes + canonicalJsonBytes(snapshot.manifest).byteLength
}

function revisionOf(buffers: ConfigBuffers): string {
  return inspectGameConfiguration(buffersToFiles(buffers)).revision
}

function safeRevision(buffers: ConfigBuffers | null): string | null {
  if (buffers === null) return null
  try { return revisionOf(buffers) } catch { return null }
}

function buffersToFiles(buffers: ConfigBuffers): GameConfigFiles {
  return Object.fromEntries(managedFiles.map((file) => [
    file.id,
    buffers[file.id] === null ? null : decodeConfig(buffers[file.id]!)
  ])) as GameConfigFiles
}

function decodeConfig(content: Buffer): string {
  if (!isUtf8(content) || content.byteLength > maximumConfigBytes) {
    throw new GameConfigHistoryError('CONFIG_HISTORY_STORAGE_UNAVAILABLE')
  }
  const decoded = content.toString('utf8')
  if (decoded.includes('\0')) throw new GameConfigHistoryError('CONFIG_HISTORY_STORAGE_UNAVAILABLE')
  return decoded
}

function decodeUtf8(content: Buffer): string {
  if (!isUtf8(content)) throw new GameConfigHistoryError('CONFIG_HISTORY_STORAGE_UNAVAILABLE')
  const decoded = content.toString('utf8')
  if (decoded.includes('\0')) throw new GameConfigHistoryError('CONFIG_HISTORY_STORAGE_UNAVAILABLE')
  return decoded
}

async function createTransactionRoot(root: PreparedRoot, requestId: string): Promise<string> {
  const name = `restore-${requestId}`
  const transactionRoot = fixedChild(root.pendingRoot, name)
  await mkdir(transactionRoot, { mode: 0o700 })
  await assertPlainDirectory(transactionRoot, root.pendingRoot)
  await syncDirectory(root.pendingRoot)
  return transactionRoot
}

async function stageBuffers(
  transactionRoot: string,
  stageName: string,
  buffers: ConfigBuffers
): Promise<void> {
  if (!/^(?:target|rollback|reconcile)$/.test(stageName)) {
    throw new GameConfigHistoryError('CONFIG_HISTORY_STORAGE_UNAVAILABLE')
  }
  const stageRoot = fixedChild(transactionRoot, stageName)
  const existing = await lstat(stageRoot).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT')) return null
    throw error
  })
  if (existing !== null) {
    await removeFixedTree(stageRoot, transactionRoot)
  }
  await mkdir(stageRoot, { mode: 0o700 })
  await assertPlainDirectory(stageRoot, transactionRoot)
  for (const file of managedFiles) {
    const content = buffers[file.id]
    if (content !== null) {
      await writeDurableExclusive(fixedChild(stageRoot, file.storedName), content)
    }
  }
  await syncDirectory(stageRoot)
  await syncDirectory(transactionRoot)
}

async function publishAllBuffers(
  root: PreparedRoot,
  transactionRoot: string,
  stageName: string,
  buffers: ConfigBuffers,
  hostMutationContext: GameConfigHostMutationContext
): Promise<void> {
  for (const [index, file] of managedFiles.entries()) {
    await publishOneBuffer(
      root.root,
      transactionRoot,
      stageName,
      file,
      buffers[file.id],
      index,
      hostMutationContext
    )
  }
}

async function publishOneBuffer(
  configRoot: string,
  transactionRoot: string,
  stageName: string,
  file: (typeof managedFiles)[number],
  desired: Buffer | null,
  index: number,
  hostMutationContext: GameConfigHostMutationContext
): Promise<void> {
  const target = fixedChild(configRoot, file.fileName)
  const displacedRoot = fixedChild(transactionRoot, `displaced-${stageName}`)
  await ensurePlainDirectory(displacedRoot, transactionRoot)
  const displaced = fixedChild(displacedRoot, `${index}-${file.storedName}`)
  const current = await lstat(target).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT')) return null
    throw error
  })
  if (current !== null) {
    if (!current.isFile() || current.isSymbolicLink() || current.size > maximumConfigBytes ||
        !samePath(await realpath(target), target)) {
      throw new GameConfigHistoryError('CONFIG_HISTORY_COMMIT_FAILED')
    }
    hostMutationContext.markPossibleLiveWrite()
    assertHostMutationActive(hostMutationContext.scope)
    await rename(target, displaced)
    await syncDirectory(configRoot)
    await syncDirectory(displacedRoot)
  }
  if (desired !== null) {
    const stageRoot = fixedChild(transactionRoot, stageName)
    await assertPlainDirectory(stageRoot, transactionRoot)
    const staged = fixedChild(stageRoot, file.storedName)
    const stagedBytes = await readStableRequiredFile(stageRoot, file.storedName, maximumConfigBytes)
    if (!stagedBytes.equals(desired)) {
      throw new GameConfigHistoryError('CONFIG_HISTORY_COMMIT_FAILED')
    }
    hostMutationContext.markPossibleLiveWrite()
    assertHostMutationActive(hostMutationContext.scope)
    await rename(staged, target)
    await syncFile(target)
    await syncDirectory(configRoot)
  }
}

async function assertCurrentState(root: string, expected: ConfigBuffers): Promise<void> {
  const actual = await readConfigBuffers(root)
  if (!equalBufferSets(actual, expected)) {
    throw new GameConfigHistoryError('CONFIG_HISTORY_REVISION_CONFLICT')
  }
}

async function writeJournal(
  transactionRoot: string,
  journal: RestoreJournal,
  replace = false
): Promise<void> {
  const target = fixedChild(transactionRoot, 'journal.json')
  const bytes = canonicalJsonBytes(journal)
  if (bytes.byteLength > maximumJournalBytes || !isRestoreJournal(journal)) {
    throw new GameConfigHistoryError('CONFIG_HISTORY_STORAGE_UNAVAILABLE')
  }
  if (!replace) {
    await writeDurableExclusive(target, bytes)
  } else {
    await writeAtomicReplace(transactionRoot, 'journal.json', bytes)
  }
  await syncDirectory(transactionRoot)
}

async function readJournal(transactionRoot: string): Promise<RestoreJournal> {
  const bytes = await readStableRequiredFile(transactionRoot, 'journal.json', maximumJournalBytes)
  const parsed = JSON.parse(decodeUtf8(bytes)) as unknown
  if (!isRestoreJournal(parsed)) {
    throw new GameConfigHistoryError('CONFIG_HISTORY_RECONCILIATION_REQUIRED')
  }
  return parsed
}

function isRestoreJournal(value: unknown): value is RestoreJournal {
  return isRecord(value) && hasExactKeys(value, [
    'format', 'version', 'requestId', 'fingerprint', 'snapshotId', 'protectionSnapshotId',
    'expectedCurrentRevision', 'targetRevision', 'startedAt', 'state'
  ]) && value.format === journalFormat && value.version === 1 &&
    typeof value.requestId === 'string' && uuidPattern.test(value.requestId) &&
    typeof value.fingerprint === 'string' && sha256Pattern.test(value.fingerprint) &&
    typeof value.snapshotId === 'string' && uuidPattern.test(value.snapshotId) &&
    typeof value.protectionSnapshotId === 'string' && uuidPattern.test(value.protectionSnapshotId) &&
    typeof value.expectedCurrentRevision === 'string' && sha256Pattern.test(value.expectedCurrentRevision) &&
    typeof value.targetRevision === 'string' && sha256Pattern.test(value.targetRevision) &&
    typeof value.startedAt === 'string' && isIsoTimestamp(value.startedAt) &&
    ['prepared', 'publishing', 'recovery-required'].includes(String(value.state))
}

async function markRecoveryRequired(transactionRoot: string): Promise<void> {
  const journal = await readJournal(transactionRoot)
  journal.state = 'recovery-required'
  await writeJournal(transactionRoot, journal, true)
}

async function moveTransactionToOrphans(
  root: PreparedRoot,
  transactionRoot: string,
  requestId: string
): Promise<void> {
  if (!samePath(path.dirname(transactionRoot), root.pendingRoot)) {
    throw new GameConfigHistoryError('CONFIG_HISTORY_STORAGE_UNAVAILABLE')
  }
  const target = fixedChild(root.orphansRoot, requestId)
  await rename(transactionRoot, target)
  await syncDirectory(root.pendingRoot)
  await syncDirectory(root.orphansRoot)
}

async function listInterruptedRoots(
  root: PreparedRoot,
  limits: NormalizedLimits
): Promise<InterruptedRoot[]> {
  const result: InterruptedRoot[] = []
  for (const [parentRoot, prefix] of [[root.pendingRoot, 'restore-'], [root.orphansRoot, '']] as const) {
    const entries = await readdir(parentRoot, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => compareOrdinal(left.name, right.name))) {
      const requestId = prefix === '' ? entry.name : entry.name.startsWith(prefix)
        ? entry.name.slice(prefix.length)
        : ''
      if (!uuidPattern.test(requestId) || !entry.isDirectory() || entry.isSymbolicLink()) {
        throw new GameConfigHistoryError('CONFIG_HISTORY_RECONCILIATION_REQUIRED')
      }
      const candidate = fixedChild(parentRoot, entry.name)
      await assertPlainDirectory(candidate, parentRoot)
      result.push({ requestId, path: candidate, parentRoot })
    }
  }
  if (result.length > limits.maximumInterruptedTransactions) {
    throw new GameConfigHistoryError('CONFIG_HISTORY_CAPACITY_EXCEEDED')
  }
  return result
}

function assertNoInterruptedTransactions(interrupted: readonly InterruptedRoot[]): void {
  if (interrupted.length > 0) {
    throw new GameConfigHistoryError('CONFIG_HISTORY_RECONCILIATION_REQUIRED')
  }
}

async function removeTransactionRoot(transactionRoot: string, parentRoot: string): Promise<void> {
  await removeFixedTree(transactionRoot, parentRoot)
  await syncDirectory(parentRoot)
}

async function assertReceiptCapacity(root: PreparedRoot, limits: NormalizedLimits): Promise<void> {
  const entries = await readdir(root.receiptsRoot, { withFileTypes: true })
  if (entries.length >= limits.maximumReceipts) {
    throw new GameConfigHistoryError('CONFIG_HISTORY_CAPACITY_EXCEEDED')
  }
  for (const entry of entries) {
    if (!/^[0-9a-f-]{36}\.json$/.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
      throw new GameConfigHistoryError('CONFIG_HISTORY_STORAGE_UNAVAILABLE')
    }
    const requestId = entry.name.slice(0, -5)
    if (!uuidPattern.test(requestId)) {
      throw new GameConfigHistoryError('CONFIG_HISTORY_STORAGE_UNAVAILABLE')
    }
  }
}

async function readStoredReceipt(
  root: PreparedRoot,
  requestId: string,
  limits: NormalizedLimits
): Promise<StoredReceipt | null> {
  assertUuid(requestId)
  const target = fixedChild(root.receiptsRoot, `${requestId}.json`)
  const metadata = await lstat(target).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT')) return null
    throw error
  })
  if (metadata === null) return null
  const bytes = await readStableRequiredFile(root.receiptsRoot, `${requestId}.json`, maximumReceiptBytes)
  const parsed = JSON.parse(decodeUtf8(bytes)) as unknown
  if (!isStoredReceipt(parsed, requestId)) {
    throw new GameConfigHistoryError('CONFIG_HISTORY_STORAGE_UNAVAILABLE')
  }
  const entries = await readdir(root.receiptsRoot)
  if (entries.length > limits.maximumReceipts) {
    throw new GameConfigHistoryError('CONFIG_HISTORY_CAPACITY_EXCEEDED')
  }
  return parsed
}

async function writeStoredReceipt(
  root: PreparedRoot,
  fingerprint: string,
  receipt: GameConfigRestoreReceipt,
  replace = false
): Promise<void> {
  if (!sha256Pattern.test(fingerprint) || !isReceipt(receipt)) {
    throw new GameConfigHistoryError('CONFIG_HISTORY_STORAGE_UNAVAILABLE')
  }
  const stored: StoredReceipt = {
    fingerprint,
    receipt: publicStoredReceipt(receipt)
  }
  const bytes = canonicalJsonBytes(stored)
  if (bytes.byteLength > maximumReceiptBytes) {
    throw new GameConfigHistoryError('CONFIG_HISTORY_STORAGE_UNAVAILABLE')
  }
  const fileName = `${receipt.requestId}.json`
  if (replace) await writeAtomicReplace(root.receiptsRoot, fileName, bytes)
  else await writeAtomicCreate(root.receiptsRoot, fileName, bytes)
  await syncDirectory(root.receiptsRoot)
}

function isStoredReceipt(value: unknown, requestId: string): value is StoredReceipt {
  if (!isRecord(value) || !hasExactKeys(value, ['fingerprint', 'receipt']) ||
      typeof value.fingerprint !== 'string' || !sha256Pattern.test(value.fingerprint) ||
      !isRecord(value.receipt)) return false
  const receipt = { ...value.receipt, persisted: true, reused: false }
  return isReceipt(receipt) && receipt.requestId === requestId &&
    value.fingerprint === receiptFingerprint(receipt)
}

function isReceipt(value: unknown): value is GameConfigRestoreReceipt {
  if (!isRecord(value) || !hasExactKeys(value, [
    'format', 'version', 'requestId', 'snapshotId', 'protectionSnapshotId', 'status', 'dryRun',
    'expectedCurrentRevision', 'targetRevision', 'finalRevision', 'errorCode', 'startedAt',
    'finishedAt', 'persisted', 'reused'
  ])) return false
  const structurallyValid = value.format === receiptFormat && value.version === 1 &&
    typeof value.requestId === 'string' && uuidPattern.test(value.requestId) &&
    typeof value.snapshotId === 'string' && uuidPattern.test(value.snapshotId) &&
    (value.protectionSnapshotId === null || typeof value.protectionSnapshotId === 'string' &&
      uuidPattern.test(value.protectionSnapshotId)) &&
    ['busy', 'dry-run', 'restored', 'rejected', 'rolled-back', 'recovery-required',
      'interrupted-recovered'].includes(String(value.status)) &&
    typeof value.dryRun === 'boolean' &&
    typeof value.expectedCurrentRevision === 'string' && sha256Pattern.test(value.expectedCurrentRevision) &&
    (value.targetRevision === null || typeof value.targetRevision === 'string' && sha256Pattern.test(value.targetRevision)) &&
    (value.finalRevision === null || typeof value.finalRevision === 'string' && sha256Pattern.test(value.finalRevision)) &&
    (value.errorCode === 'NONE' || isErrorCode(value.errorCode)) &&
    typeof value.startedAt === 'string' && isIsoTimestamp(value.startedAt) &&
    typeof value.finishedAt === 'string' && isIsoTimestamp(value.finishedAt) &&
    typeof value.persisted === 'boolean' && typeof value.reused === 'boolean'
  if (!structurallyValid || String(value.startedAt) > String(value.finishedAt)) return false
  const status = value.status as GameConfigRestoreStatus
  const errorCode = value.errorCode as GameConfigHistoryErrorCode | 'NONE'
  if ((status === 'dry-run') !== (value.dryRun === true)) return false
  if (status === 'restored') {
    return errorCode === 'NONE' && value.protectionSnapshotId !== null &&
      value.targetRevision !== null && value.finalRevision === value.targetRevision
  }
  if (status === 'dry-run') {
    return errorCode === 'NONE' && value.protectionSnapshotId === null &&
      value.targetRevision !== null && value.finalRevision !== null
  }
  if (status === 'rolled-back') {
    return errorCode !== 'NONE' && value.protectionSnapshotId !== null &&
      value.targetRevision !== null && value.finalRevision !== null
  }
  if (status === 'recovery-required') {
    return errorCode === 'CONFIG_HISTORY_ROLLBACK_FAILED' && value.protectionSnapshotId !== null
  }
  if (status === 'interrupted-recovered') {
    return errorCode === 'CONFIG_HISTORY_INTERRUPTED_RECOVERED' &&
      value.protectionSnapshotId !== null && value.finalRevision !== null
  }
  if (status === 'busy') {
    return errorCode === 'CONFIG_HISTORY_BUSY' && value.persisted === false
  }
  return status === 'rejected' && errorCode !== 'NONE'
}

function publicStoredReceipt(
  receipt: GameConfigRestoreReceipt
): Omit<GameConfigRestoreReceipt, 'persisted' | 'reused'> {
  const { persisted: _persisted, reused: _reused, ...stored } = receipt
  return stored
}

function makeReceipt(input: ReceiptInput): GameConfigRestoreReceipt {
  return {
    format: receiptFormat,
    version: 1,
    requestId: input.request.requestId,
    snapshotId: input.request.snapshotId,
    protectionSnapshotId: input.protectionSnapshotId,
    status: input.status,
    dryRun: input.request.dryRun,
    expectedCurrentRevision: input.request.expectedCurrentRevision,
    targetRevision: input.targetRevision,
    finalRevision: input.finalRevision,
    errorCode: input.errorCode,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    persisted: input.persisted,
    reused: input.reused
  }
}

function normalizeRestoreRequest(request: RestoreGameConfigurationRequest): NormalizedRestoreRequest {
  if (!isRecord(request) || !hasExactKeys(request, [
    'requestId', 'snapshotId', 'expectedCurrentRevision', 'stopProofToken',
    ...(Object.prototype.hasOwnProperty.call(request, 'dryRun') ? ['dryRun'] : [])
  ]) || typeof request.requestId !== 'string' || typeof request.snapshotId !== 'string' ||
      typeof request.expectedCurrentRevision !== 'string' ||
      typeof request.stopProofToken !== 'string' ||
      !(request.dryRun === undefined || typeof request.dryRun === 'boolean')) {
    throw new GameConfigHistoryError('CONFIG_HISTORY_REQUEST_INVALID')
  }
  const requestId = request.requestId.toLocaleLowerCase('en-US')
  const snapshotId = request.snapshotId.toLocaleLowerCase('en-US')
  const expectedCurrentRevision = request.expectedCurrentRevision.toLocaleLowerCase('en-US')
  assertUuid(requestId)
  assertUuid(snapshotId)
  if (!sha256Pattern.test(expectedCurrentRevision)) {
    throw new GameConfigHistoryError('CONFIG_HISTORY_REQUEST_INVALID')
  }
  assertStopProofToken(request.stopProofToken)
  return {
    requestId,
    snapshotId,
    expectedCurrentRevision,
    stopProofToken: request.stopProofToken,
    dryRun: request.dryRun === true
  }
}

function restoreFingerprint(request: NormalizedRestoreRequest): string {
  return sha256(canonicalJsonBytes({
    action: 'game-config.restore',
    requestId: request.requestId,
    snapshotId: request.snapshotId,
    expectedCurrentRevision: request.expectedCurrentRevision,
    dryRun: request.dryRun
  }))
}

function receiptFingerprint(receipt: GameConfigRestoreReceipt): string {
  return sha256(canonicalJsonBytes({
    action: 'game-config.restore',
    requestId: receipt.requestId,
    snapshotId: receipt.snapshotId,
    expectedCurrentRevision: receipt.expectedCurrentRevision,
    dryRun: receipt.dryRun
  }))
}

async function validateStopProofSafely(
  validator: GameConfigStopProofValidator,
  context: GameConfigStopProofContext,
  signal?: AbortSignal
): Promise<boolean> {
  try { return await validator(context, signal) === true } catch { return false }
}

async function writeDurableExclusive(filePath: string, content: Buffer): Promise<void> {
  const handle = await open(filePath, 'wx', 0o600)
  try {
    await handle.writeFile(content)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeAtomicCreate(root: string, fileName: string, content: Buffer): Promise<void> {
  const target = fixedChild(root, fileName)
  const temporary = fixedChild(root, `.${fileName}.${randomUUID()}.tmp`)
  await writeDurableExclusive(temporary, content)
  try {
    const existing = await lstat(target).catch((error: unknown) => {
      if (hasErrorCode(error, 'ENOENT')) return null
      throw error
    })
    if (existing !== null) throw new GameConfigHistoryError('CONFIG_HISTORY_REQUEST_CONFLICT')
    await rename(temporary, target)
    await syncFile(target)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

async function writeAtomicReplace(root: string, fileName: string, content: Buffer): Promise<void> {
  const target = fixedChild(root, fileName)
  const temporary = fixedChild(root, `.${fileName}.${randomUUID()}.tmp`)
  await writeDurableExclusive(temporary, content)
  try {
    const existing = await lstat(target)
    if (!existing.isFile() || existing.isSymbolicLink() || !samePath(await realpath(target), target)) {
      throw new GameConfigHistoryError('CONFIG_HISTORY_STORAGE_UNAVAILABLE')
    }
    await rename(temporary, target)
    await syncFile(target)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, 'r+')
  try { await handle.sync() } finally { await handle.close() }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r').catch(() => null)
  if (!handle) return
  try {
    await handle.sync().catch((error: unknown) => {
      if (!['EINVAL', 'EPERM', 'EACCES'].some((code) => hasErrorCode(error, code))) throw error
    })
  } finally {
    await handle.close()
  }
}

async function removeFixedTree(target: string, parent: string): Promise<void> {
  if (!samePath(path.dirname(target), parent)) {
    throw new GameConfigHistoryError('CONFIG_HISTORY_STORAGE_UNAVAILABLE')
  }
  const metadata = await lstat(target).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT')) return null
    throw error
  })
  if (metadata === null) return
  if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
      !samePath(await realpath(target), target)) {
    throw new GameConfigHistoryError('CONFIG_HISTORY_STORAGE_UNAVAILABLE')
  }
  await rm(target, { recursive: true, force: false })
}

function fixedChild(root: string, childName: string): string {
  if (!/^[A-Za-z0-9._-]{1,180}$/.test(childName) || childName === '.' || childName === '..') {
    throw new GameConfigHistoryError('CONFIG_HISTORY_STORAGE_UNAVAILABLE')
  }
  const candidate = path.resolve(root, childName)
  if (!samePath(path.dirname(candidate), root)) {
    throw new GameConfigHistoryError('CONFIG_HISTORY_STORAGE_UNAVAILABLE')
  }
  return candidate
}

function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
}

function cloneBuffers(buffers: ConfigBuffers): ConfigBuffers {
  return Object.fromEntries(managedFiles.map((file) => [
    file.id,
    buffers[file.id] === null ? null : Buffer.from(buffers[file.id]!)
  ])) as ConfigBuffers
}

function equalBufferSets(left: ConfigBuffers, right: ConfigBuffers): boolean {
  return managedFiles.every((file) => equalBuffers(left[file.id], right[file.id]))
}

function equalBuffers(left: Buffer | null, right: Buffer | null): boolean {
  if (left === null || right === null) return left === right
  return left.equals(right)
}

function samePublicValue(left: PublicGameConfigValue, right: PublicGameConfigValue): boolean {
  if (typeof left === 'object' && typeof right === 'object') {
    return left.configured === right.configured
  }
  return Object.is(left, right)
}

function clonePublicValue(value: PublicGameConfigValue): PublicGameConfigValue {
  return typeof value === 'object' ? { configured: value.configured } : value
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right)
}

function normalizePath(value: string): string {
  return path.resolve(value).replace(/[\\/]+$/, '').toLocaleLowerCase('en-US')
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function assertUuid(value: string): void {
  if (!uuidPattern.test(value)) throw new GameConfigHistoryError('CONFIG_HISTORY_REQUEST_INVALID')
}

function assertStopProofToken(value: string): void {
  if (value.length < 1 || value.length > 2_048 || /[\r\n\0]/.test(value)) {
    throw new GameConfigHistoryError('CONFIG_HISTORY_REQUEST_INVALID')
  }
}

function assertIsoTimestamp(value: string): void {
  if (!isIsoTimestamp(value)) throw new GameConfigHistoryError('CONFIG_HISTORY_STORAGE_UNAVAILABLE')
}

function isIsoTimestamp(value: string): boolean {
  const parsed = new Date(value)
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort(compareOrdinal)
  const wanted = [...expected].sort(compareOrdinal)
  return sameStringArray(actual, wanted)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isErrorCode(value: unknown): value is GameConfigHistoryErrorCode {
  return typeof value === 'string' && [
    'CONFIG_HISTORY_REQUEST_INVALID',
    'CONFIG_HISTORY_REQUEST_CONFLICT',
    'CONFIG_HISTORY_ROOT_UNAVAILABLE',
    'CONFIG_HISTORY_STORAGE_UNAVAILABLE',
    'CONFIG_HISTORY_BUSY',
    'CONFIG_HISTORY_CAPACITY_EXCEEDED',
    'CONFIG_HISTORY_SNAPSHOT_INVALID',
    'CONFIG_HISTORY_REVISION_CONFLICT',
    'CONFIG_HISTORY_STOP_PROOF_REJECTED',
    'CONFIG_HISTORY_RECONCILIATION_REQUIRED',
    'CONFIG_HISTORY_COMMIT_FAILED',
    'CONFIG_HISTORY_ROLLBACK_FAILED',
    'CONFIG_HISTORY_INTERRUPTED_RECOVERED',
    'CONFIG_HISTORY_HOST_LEASE_BUSY',
    'CONFIG_HISTORY_HOST_LEASE_DIRTY',
    'CONFIG_HISTORY_HOST_LEASE_RECOVERY_REQUIRED',
    'CONFIG_HISTORY_HOST_LEASE_LOST',
    'CONFIG_HISTORY_HOST_LEASE_UNAVAILABLE'
  ].includes(value)
}

function restoreHostMutationDisposition(
  receipt: GameConfigRestoreReceipt
): HostMutationDisposition {
  return receipt.status === 'recovery-required' ||
    receipt.errorCode === 'CONFIG_HISTORY_RECONCILIATION_REQUIRED'
    ? 'abandon'
    : 'release'
}

function reconcileHostMutationDisposition(
  results: readonly GameConfigRecoveryResult[]
): HostMutationDisposition {
  return results.some((result) => result.status === 'recovery-required')
    ? 'abandon'
    : 'release'
}

function historyErrorHostMutationDisposition(
  code: GameConfigHistoryErrorCode
): HostMutationDisposition {
  return code === 'CONFIG_HISTORY_RECONCILIATION_REQUIRED' ||
    code === 'CONFIG_HISTORY_ROLLBACK_FAILED' ||
    code.startsWith('CONFIG_HISTORY_HOST_LEASE_')
    ? 'abandon'
    : 'release'
}

function assertHostMutationActive(scope: HostMutationOperationScope): void {
  try {
    scope.assertActive()
  } catch {
    throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_LOST')
  }
}

function mapHostMutationCoordinatorError(
  code: HostMutationOperationCoordinatorError['code']
): GameConfigHistoryErrorCode {
  if (code === 'HOST_MUTATION_LEASE_BUSY') return 'CONFIG_HISTORY_HOST_LEASE_BUSY'
  if (code === 'HOST_MUTATION_LEASE_DIRTY') return 'CONFIG_HISTORY_HOST_LEASE_DIRTY'
  if (code === 'HOST_MUTATION_LEASE_RECOVERY_REQUIRED') {
    return 'CONFIG_HISTORY_HOST_LEASE_RECOVERY_REQUIRED'
  }
  if (code === 'HOST_MUTATION_LEASE_LOST') return 'CONFIG_HISTORY_HOST_LEASE_LOST'
  return 'CONFIG_HISTORY_HOST_LEASE_UNAVAILABLE'
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function sanitizeHistoryError(error: unknown): GameConfigHistoryError {
  return error instanceof GameConfigHistoryError
    ? error
    : new GameConfigHistoryError('CONFIG_HISTORY_STORAGE_UNAVAILABLE')
}

export class GameConfigHistoryError extends Error {
  constructor(readonly code: GameConfigHistoryErrorCode) {
    super(code)
    this.name = 'GameConfigHistoryError'
  }
}

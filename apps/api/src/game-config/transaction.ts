import { createHash, randomUUID } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  type FileHandle
} from 'node:fs/promises'
import path from 'node:path'
import {
  gameConfigDefinitionById,
  type GameConfigDefinition,
  type GameConfigFileId
} from './catalog.js'
import { applyBepInExPatches, findBepInExValue } from './bepinex.js'
import { inspectGameConfiguration, type GameConfigFiles, type GameConfigPlan } from './planner.js'

const fileIds = ['nebula', 'galaxy', 'bepinex', 'bridge'] as const
const configFileNames: Readonly<Record<GameConfigFileId, string>> = Object.freeze({
  nebula: 'nebula.cfg',
  galaxy: 'nebulaGameDescSettings.cfg',
  bepinex: 'BepInEx.cfg',
  bridge: 'io.github.mikutea.dyson-control-bridge.cfg'
})
const controlDirectoryName = '.dyson-control'
const maximumConfigBytes = 512 * 1024
const sha256Pattern = /^[0-9a-f]{64}$/
const transactionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const inProcessLocks = new Set<string>()

export type GameConfigTransactionStatus =
  | 'dry-run'
  | 'applied'
  | 'busy'
  | 'revision-conflict'
  | 'rejected'
  | 'failed'
  | 'rolled-back'
  | 'rollback-failed'

export type GameConfigTransactionErrorCode =
  | 'CONFIG_TRANSACTION_BUSY'
  | 'CONFIG_REVISION_CONFLICT'
  | 'CONFIG_PLAN_INVALID'
  | 'CONFIG_PLAN_NOT_ALLOWLISTED'
  | 'CONFIG_ROOT_UNAVAILABLE'
  | 'CONFIG_TRANSACTION_STORAGE_UNAVAILABLE'
  | 'CONFIG_SNAPSHOT_FAILED'
  | 'CONFIG_COMMIT_FAILED'
  | 'CONFIG_COMMIT_VERIFICATION_FAILED'
  | 'CONFIG_ROLLBACK_FAILED'

export interface GameConfigTransactionAuditRecord {
  schemaVersion: 1
  transactionId: string
  action: 'game-config.apply'
  status: GameConfigTransactionStatus | 'prepared'
  dryRun: boolean
  baseRevision: string
  nextRevision: string
  changedSettingIds: string[]
  restartRequired: boolean
  newGameOnlyChanged: boolean
  startedAt: string
  finishedAt: string
  errorCode?: GameConfigTransactionErrorCode
}

export interface GameConfigTransactionResult {
  transactionId: string
  status: GameConfigTransactionStatus
  dryRun: boolean
  baseRevision: string
  nextRevision: string
  changedSettingIds: string[]
  restartRequired: boolean
  newGameOnlyChanged: boolean
  snapshotId?: string
  currentRevision?: string
  errorCode?: GameConfigTransactionErrorCode
  auditStored: boolean
  audit: GameConfigTransactionAuditRecord
}

export interface GameConfigSnapshotVerification {
  snapshotId: string
  valid: boolean
  beforeRevision: string | null
  fileCount: number
}

export type GameConfigTransactionHookPhase =
  | 'snapshot-created'
  | 'before-replace'
  | 'after-replace'
  | 'before-verify'
  | 'before-restore'

/**
 * Fault hooks exist solely for deterministic transaction tests. They receive only
 * allowlisted identifiers and never receive file contents or filesystem paths.
 */
export interface GameConfigTransactionTestHooks {
  onPhase?: (
    phase: GameConfigTransactionHookPhase,
    detail: { fileId?: GameConfigFileId; index?: number }
  ) => void | Promise<void>
}

export interface GameConfigTransactionServiceOptions {
  /** Trusted, server-side BepInEx/config root. This is never accepted from an HTTP request. */
  configRoot: string
  /** @internal Test-only fault injection. */
  testHooks?: GameConfigTransactionTestHooks
  /** @internal Test-only deterministic clock. */
  now?: () => Date
  /** @internal Test-only deterministic transaction identifier. */
  createTransactionId?: () => string
}

export interface ApplyGameConfigTransactionOptions {
  dryRun?: boolean
}

export class GameConfigTransactionService {
  readonly #configuredRoot: string
  readonly #hooks: GameConfigTransactionTestHooks | undefined
  readonly #now: () => Date
  readonly #createTransactionId: () => string

  constructor(options: GameConfigTransactionServiceOptions) {
    if (!options || typeof options.configRoot !== 'string' || options.configRoot.trim().length === 0) {
      throw new GameConfigTransactionError('CONFIG_ROOT_UNAVAILABLE')
    }
    this.#configuredRoot = path.resolve(options.configRoot)
    this.#hooks = options.testHooks
    this.#now = options.now ?? (() => new Date())
    this.#createTransactionId = options.createTransactionId ?? randomUUID
  }

  async apply(
    plan: GameConfigPlan,
    options: ApplyGameConfigTransactionOptions = {}
  ): Promise<GameConfigTransactionResult> {
    const transactionId = this.#createTransactionId()
    if (!transactionIdPattern.test(transactionId)) {
      throw new GameConfigTransactionError('CONFIG_TRANSACTION_STORAGE_UNAVAILABLE')
    }
    const dryRun = options.dryRun === true
    const startedAt = this.#now().toISOString()
    const safePlan = publicPlanFields(plan)
    let root: PreparedRoot | null = null
    let lock: AcquiredLock | null = null

    try {
      root = await prepareRoot(this.#configuredRoot)
      lock = await acquireExclusiveLock(root, transactionId, startedAt)
      if (!lock) {
        return makeResult({
          transactionId,
          status: 'busy',
          dryRun,
          safePlan,
          startedAt,
          finishedAt: this.#now().toISOString(),
          errorCode: 'CONFIG_TRANSACTION_BUSY',
          auditStored: false
        })
      }

      const original = await readConfigBuffers(root.root)
      const currentFiles = buffersToConfigFiles(original)
      const currentRevision = inspectGameConfiguration(currentFiles).revision

      if (!isGameConfigPlanShape(plan)) {
        return await this.#finishWithoutMutation(root, transactionId, {
          status: 'rejected', dryRun, safePlan, startedAt,
          errorCode: 'CONFIG_PLAN_INVALID', currentRevision
        })
      }
      if (plan.baseRevision !== currentRevision) {
        return await this.#finishWithoutMutation(root, transactionId, {
          status: 'revision-conflict', dryRun, safePlan, startedAt,
          errorCode: 'CONFIG_REVISION_CONFLICT', currentRevision
        })
      }

      try {
        assertAllowlistedPlannerOutput(currentFiles, plan)
      } catch (error) {
        const code = error instanceof GameConfigTransactionError
          ? error.code
          : 'CONFIG_PLAN_INVALID'
        return await this.#finishWithoutMutation(root, transactionId, {
          status: 'rejected', dryRun, safePlan, startedAt,
          errorCode: code, currentRevision
        })
      }

      if (dryRun) {
        return await this.#finishWithoutMutation(root, transactionId, {
          status: 'dry-run', dryRun: true, safePlan, startedAt, currentRevision
        })
      }

      let snapshotId: string | undefined
      try {
        snapshotId = await createVerifiedSnapshot(root, transactionId, original, currentRevision)
        await this.#phase('snapshot-created', {})
      } catch {
        return await this.#finishWithoutMutation(root, transactionId, {
          status: 'failed', dryRun, safePlan, startedAt,
          errorCode: 'CONFIG_SNAPSHOT_FAILED', currentRevision
        })
      }

      const preparedAudit = makeAudit({
        transactionId,
        status: 'prepared',
        dryRun: false,
        safePlan,
        startedAt,
        finishedAt: this.#now().toISOString()
      })
      try {
        await writeAudit(root, preparedAudit, 0)
      } catch {
        return makeResult({
          transactionId,
          status: 'failed',
          dryRun,
          safePlan,
          startedAt,
          finishedAt: this.#now().toISOString(),
          snapshotId,
          currentRevision,
          errorCode: 'CONFIG_TRANSACTION_STORAGE_UNAVAILABLE',
          auditStored: false
        })
      }

      const proposed = configFilesToBuffers(plan.files)
      const changedIds = fileIds.filter((id) => !equalBuffers(original[id], proposed[id]))
      const staged = new Map<GameConfigFileId, string>()
      let mutationMayHaveOccurred = false
      let commitErrorCode: GameConfigTransactionErrorCode = 'CONFIG_COMMIT_FAILED'
      try {
        for (const id of changedIds) {
          const content = proposed[id]
          if (content === null) throw new GameConfigTransactionError('CONFIG_PLAN_NOT_ALLOWLISTED')
          staged.set(id, await stageBuffer(root.root, configFileNames[id], content, transactionId, 'apply'))
        }
        for (const [index, id] of changedIds.entries()) {
          await this.#phase('before-replace', { fileId: id, index })
          // Once replacement begins, even a subsequent flush failure must enter
          // the compensating rollback path because rename may already have won.
          mutationMayHaveOccurred = true
          await commitStagedFile(root.root, staged.get(id)!, configFileNames[id])
          staged.delete(id)
          await this.#phase('after-replace', { fileId: id, index })
        }
        await this.#phase('before-verify', {})
        const committed = await readConfigBuffers(root.root)
        if (!equalBufferSets(committed, proposed) ||
            inspectGameConfiguration(buffersToConfigFiles(committed)).revision !== plan.nextRevision) {
          commitErrorCode = 'CONFIG_COMMIT_VERIFICATION_FAILED'
          throw new GameConfigTransactionError(commitErrorCode)
        }
      } catch (error) {
        if (error instanceof GameConfigTransactionError &&
            error.code === 'CONFIG_COMMIT_VERIFICATION_FAILED') {
          commitErrorCode = error.code
        }
        await cleanupStaged(staged)
        if (!mutationMayHaveOccurred) {
          return await this.#finishAfterPrepared(root, transactionId, {
            status: 'failed', dryRun, safePlan, startedAt, snapshotId,
            errorCode: commitErrorCode, currentRevision
          })
        }
        try {
          await this.#restoreOriginal(root, transactionId, original)
          return await this.#finishAfterPrepared(root, transactionId, {
            status: 'rolled-back', dryRun, safePlan, startedAt, snapshotId,
            errorCode: commitErrorCode, currentRevision
          })
        } catch {
          return await this.#finishAfterPrepared(root, transactionId, {
            status: 'rollback-failed', dryRun, safePlan, startedAt, snapshotId,
            errorCode: 'CONFIG_ROLLBACK_FAILED', currentRevision
          })
        }
      }

      return await this.#finishAfterPrepared(root, transactionId, {
        status: 'applied', dryRun, safePlan, startedAt, snapshotId,
        currentRevision: plan.nextRevision
      })
    } catch (error) {
      const errorCode = error instanceof GameConfigTransactionError
        ? error.code
        : 'CONFIG_TRANSACTION_STORAGE_UNAVAILABLE'
      return makeResult({
        transactionId,
        status: errorCode === 'CONFIG_ROOT_UNAVAILABLE' ? 'rejected' : 'failed',
        dryRun,
        safePlan,
        startedAt,
        finishedAt: this.#now().toISOString(),
        errorCode,
        auditStored: false
      })
    } finally {
      if (lock) await releaseExclusiveLock(lock)
    }
  }

  async verifySnapshot(snapshotId: string): Promise<GameConfigSnapshotVerification> {
    if (!transactionIdPattern.test(snapshotId)) {
      return { snapshotId, valid: false, beforeRevision: null, fileCount: 0 }
    }
    try {
      const root = await prepareRoot(this.#configuredRoot)
      const manifest = await readAndVerifySnapshot(root, snapshotId)
      return {
        snapshotId,
        valid: true,
        beforeRevision: manifest.beforeRevision,
        fileCount: manifest.files.length
      }
    } catch {
      return { snapshotId, valid: false, beforeRevision: null, fileCount: 0 }
    }
  }

  async #restoreOriginal(
    root: PreparedRoot,
    transactionId: string,
    original: ConfigBuffers
  ): Promise<void> {
    const staged = new Map<GameConfigFileId, string>()
    try {
      for (const id of fileIds) {
        const content = original[id]
        if (content !== null) {
          staged.set(id, await stageBuffer(root.root, configFileNames[id], content, transactionId, 'restore'))
        }
      }
      for (const [index, id] of fileIds.entries()) {
        await this.#phase('before-restore', { fileId: id, index })
        const content = original[id]
        if (content === null) {
          await removeFixedFile(root.root, configFileNames[id])
        } else {
          await commitStagedFile(root.root, staged.get(id)!, configFileNames[id])
          staged.delete(id)
        }
      }
      const restored = await readConfigBuffers(root.root)
      if (!equalBufferSets(restored, original)) throw new GameConfigTransactionError('CONFIG_ROLLBACK_FAILED')
    } finally {
      await cleanupStaged(staged)
    }
  }

  async #finishWithoutMutation(
    root: PreparedRoot,
    transactionId: string,
    input: FinishInput
  ): Promise<GameConfigTransactionResult> {
    const finishedAt = this.#now().toISOString()
    const audit = makeAudit({ transactionId, ...input, finishedAt })
    let auditStored = true
    try {
      await writeAudit(root, audit, 0)
    } catch {
      auditStored = false
    }
    return makeResult({ transactionId, ...input, finishedAt, auditStored })
  }

  async #finishAfterPrepared(
    root: PreparedRoot,
    transactionId: string,
    input: FinishInput
  ): Promise<GameConfigTransactionResult> {
    const finishedAt = this.#now().toISOString()
    const audit = makeAudit({ transactionId, ...input, finishedAt })
    let auditStored = true
    try {
      await writeAudit(root, audit, 1)
    } catch {
      auditStored = false
    }
    return makeResult({ transactionId, ...input, finishedAt, auditStored })
  }

  async #phase(
    phase: GameConfigTransactionHookPhase,
    detail: { fileId?: GameConfigFileId; index?: number }
  ): Promise<void> {
    await this.#hooks?.onPhase?.(phase, detail)
  }
}

interface SafePlanFields {
  baseRevision: string
  nextRevision: string
  changedSettingIds: string[]
  restartRequired: boolean
  newGameOnlyChanged: boolean
}

interface FinishInput {
  status: GameConfigTransactionStatus
  dryRun: boolean
  safePlan: SafePlanFields
  startedAt: string
  snapshotId?: string
  currentRevision?: string
  errorCode?: GameConfigTransactionErrorCode
}

interface ResultInput extends FinishInput {
  transactionId: string
  finishedAt: string
  auditStored: boolean
}

type AuditInput = Omit<FinishInput, 'status'> & {
  transactionId: string
  status: GameConfigTransactionStatus | 'prepared'
  finishedAt: string
}

interface PreparedRoot {
  root: string
  controlRoot: string
  snapshotsRoot: string
  auditRoot: string
  lockPath: string
}

interface AcquiredLock {
  rootKey: string
  lockPath: string
  handle: FileHandle
}

type ConfigBuffers = Record<GameConfigFileId, Buffer | null>

interface SnapshotFileManifest {
  id: GameConfigFileId
  present: boolean
  bytes: number
  sha256: string | null
}

interface SnapshotManifest {
  schemaVersion: 1
  snapshotId: string
  beforeRevision: string
  createdAt: string
  files: SnapshotFileManifest[]
}

function publicPlanFields(plan: unknown): SafePlanFields {
  const record = isRecord(plan) ? plan : {}
  const diff = Array.isArray(record.diff) ? record.diff : []
  const changedSettingIds = diff.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !gameConfigDefinitionById.has(entry.id)) return []
    return [entry.id]
  }).slice(0, 32)
  return {
    baseRevision: typeof record.baseRevision === 'string' && sha256Pattern.test(record.baseRevision)
      ? record.baseRevision
      : 'invalid',
    nextRevision: typeof record.nextRevision === 'string' && sha256Pattern.test(record.nextRevision)
      ? record.nextRevision
      : 'invalid',
    changedSettingIds: [...new Set(changedSettingIds)],
    restartRequired: record.restartRequired === true,
    newGameOnlyChanged: record.newGameOnlyChanged === true
  }
}

function isGameConfigPlanShape(value: unknown): value is GameConfigPlan {
  if (!isRecord(value) || !hasExactKeys(value, [
    'baseRevision', 'nextRevision', 'restartRequired', 'newGameOnlyChanged', 'diff', 'files'
  ])) return false
  if (typeof value.baseRevision !== 'string' || !sha256Pattern.test(value.baseRevision) ||
      typeof value.nextRevision !== 'string' || !sha256Pattern.test(value.nextRevision) ||
      typeof value.restartRequired !== 'boolean' || typeof value.newGameOnlyChanged !== 'boolean' ||
      !Array.isArray(value.diff) || value.diff.length < 1 || value.diff.length > 32 ||
      !isRecord(value.files) || !hasExactKeys(value.files, [...fileIds])) return false
  for (const id of fileIds) {
    const content = value.files[id]
    if (content !== null && (typeof content !== 'string' || !validConfigContent(content))) return false
  }
  const seen = new Set<string>()
  for (const entry of value.diff) {
    if (!isRecord(entry) || !hasExactKeys(entry, [
      'id', 'file', 'label', 'activation', 'before', 'after', 'changed'
    ]) || typeof entry.id !== 'string' || seen.has(entry.id)) return false
    const definition = gameConfigDefinitionById.get(entry.id)
    if (!definition || entry.file !== definition.file || entry.label !== definition.label ||
        entry.activation !== definition.activation || typeof entry.changed !== 'boolean' ||
        !validPublicValue(definition, entry.before) || !validPublicValue(definition, entry.after)) return false
    seen.add(entry.id)
  }
  return true
}

function assertAllowlistedPlannerOutput(current: GameConfigFiles, plan: GameConfigPlan): void {
  const proposed = inspectGameConfiguration(plan.files)
  if (proposed.revision !== plan.nextRevision) {
    throw new GameConfigTransactionError('CONFIG_PLAN_INVALID')
  }
  const currentSnapshot = inspectGameConfiguration(current)
  const currentEntries = new Map(currentSnapshot.entries.map((entry) => [entry.id, entry]))
  const proposedEntries = new Map(proposed.entries.map((entry) => [entry.id, entry]))

  for (const entry of plan.diff) {
    const definition = gameConfigDefinitionById.get(entry.id)!
    const before = currentEntries.get(entry.id)!
    const after = proposedEntries.get(entry.id)!
    if (!samePublicValue(entry.before, before.value) || !samePublicValue(entry.after, after.value)) {
      throw new GameConfigTransactionError('CONFIG_PLAN_INVALID')
    }
    const beforeRaw = findBepInExValue(current[definition.file] ?? '', definition.section, definition.key)
      ?? serializeDefault(definition)
    const afterRaw = findBepInExValue(plan.files[definition.file] ?? '', definition.section, definition.key)
    if (afterRaw === null || entry.changed !== (beforeRaw !== afterRaw)) {
      throw new GameConfigTransactionError('CONFIG_PLAN_INVALID')
    }
  }

  for (const fileId of fileIds) {
    const patches = plan.diff.flatMap((entry) => {
      const definition = gameConfigDefinitionById.get(entry.id)!
      if (definition.file !== fileId) return []
      const value = findBepInExValue(plan.files[fileId] ?? '', definition.section, definition.key)
      if (value === null) throw new GameConfigTransactionError('CONFIG_PLAN_INVALID')
      return [{ section: definition.section, key: definition.key, value }]
    })
    const reconstructed = patches.length === 0
      ? current[fileId]
      : applyBepInExPatches(current[fileId] ?? '', patches)
    if (reconstructed !== plan.files[fileId]) {
      throw new GameConfigTransactionError('CONFIG_PLAN_NOT_ALLOWLISTED')
    }
  }

  const restartRequired = plan.diff.some((entry) => entry.changed && entry.activation === 'server-restart')
  const newGameOnlyChanged = plan.diff.some((entry) => entry.changed && entry.activation === 'new-game-only')
  if (plan.restartRequired !== restartRequired || plan.newGameOnlyChanged !== newGameOnlyChanged) {
    throw new GameConfigTransactionError('CONFIG_PLAN_INVALID')
  }
}

async function prepareRoot(configuredRoot: string): Promise<PreparedRoot> {
  const metadata = await lstat(configuredRoot).catch(() => null)
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    throw new GameConfigTransactionError('CONFIG_ROOT_UNAVAILABLE')
  }
  const canonicalRoot = await realpath(configuredRoot)
  if (!samePath(canonicalRoot, configuredRoot)) {
    throw new GameConfigTransactionError('CONFIG_ROOT_UNAVAILABLE')
  }
  const controlRoot = path.resolve(canonicalRoot, controlDirectoryName)
  if (!samePath(path.dirname(controlRoot), canonicalRoot)) {
    throw new GameConfigTransactionError('CONFIG_TRANSACTION_STORAGE_UNAVAILABLE')
  }
  await ensureFixedDirectory(controlRoot)
  const snapshotsRoot = path.join(controlRoot, 'snapshots')
  const auditRoot = path.join(controlRoot, 'audit')
  await ensureFixedDirectory(snapshotsRoot)
  await ensureFixedDirectory(auditRoot)
  return {
    root: canonicalRoot,
    controlRoot,
    snapshotsRoot,
    auditRoot,
    lockPath: path.join(controlRoot, 'configuration.lock')
  }
}

async function ensureFixedDirectory(directory: string): Promise<void> {
  await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
    if (!hasErrorCode(error, 'EEXIST')) throw error
  })
  const metadata = await lstat(directory)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !samePath(await realpath(directory), directory)) {
    throw new GameConfigTransactionError('CONFIG_TRANSACTION_STORAGE_UNAVAILABLE')
  }
}

async function acquireExclusiveLock(
  root: PreparedRoot,
  transactionId: string,
  startedAt: string
): Promise<AcquiredLock | null> {
  const rootKey = normalizePath(root.root)
  if (inProcessLocks.has(rootKey)) return null
  inProcessLocks.add(rootKey)
  try {
    const handle = await open(root.lockPath, 'wx', 0o600).catch((error: unknown) => {
      if (hasErrorCode(error, 'EEXIST')) return null
      throw error
    })
    if (!handle) {
      inProcessLocks.delete(rootKey)
      return null
    }
    try {
      await handle.writeFile(JSON.stringify({ schemaVersion: 1, transactionId, startedAt }), 'utf8')
      await handle.sync()
      return { rootKey, lockPath: root.lockPath, handle }
    } catch (error) {
      await handle.close().catch(() => undefined)
      await unlink(root.lockPath).catch(() => undefined)
      throw error
    }
  } catch (error) {
    inProcessLocks.delete(rootKey)
    throw error
  }
}

async function releaseExclusiveLock(lock: AcquiredLock): Promise<void> {
  try {
    await lock.handle.close().catch(() => undefined)
  } finally {
    await unlink(lock.lockPath).catch(() => undefined)
    inProcessLocks.delete(lock.rootKey)
  }
}

async function readConfigBuffers(root: string): Promise<ConfigBuffers> {
  const entries = await Promise.all(fileIds.map(async (id) => {
    const fileName = configFileNames[id]
    const target = fixedFilePath(root, fileName)
    const metadata = await lstat(target).catch((error: unknown) => hasErrorCode(error, 'ENOENT')
      ? null
      : Promise.reject(error))
    if (metadata === null) return [id, null] as const
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumConfigBytes ||
        !samePath(await realpath(target), target)) {
      throw new GameConfigTransactionError('CONFIG_PLAN_INVALID')
    }
    const content = await readFile(target)
    decodeConfig(content)
    return [id, content] as const
  }))
  return Object.fromEntries(entries) as ConfigBuffers
}

function buffersToConfigFiles(buffers: ConfigBuffers): GameConfigFiles {
  return Object.fromEntries(fileIds.map((id) => [
    id,
    buffers[id] === null ? null : decodeConfig(buffers[id]!)
  ])) as GameConfigFiles
}

function configFilesToBuffers(files: GameConfigFiles): ConfigBuffers {
  return Object.fromEntries(fileIds.map((id) => [
    id,
    files[id] === null ? null : Buffer.from(files[id]!, 'utf8')
  ])) as ConfigBuffers
}

async function createVerifiedSnapshot(
  root: PreparedRoot,
  transactionId: string,
  original: ConfigBuffers,
  beforeRevision: string
): Promise<string> {
  const snapshotRoot = path.join(root.snapshotsRoot, transactionId)
  if (!samePath(path.dirname(snapshotRoot), root.snapshotsRoot)) {
    throw new GameConfigTransactionError('CONFIG_SNAPSHOT_FAILED')
  }
  await mkdir(snapshotRoot, { mode: 0o700 })
  const files: SnapshotFileManifest[] = []
  for (const id of fileIds) {
    const content = original[id]
    const file: SnapshotFileManifest = {
      id,
      present: content !== null,
      bytes: content?.byteLength ?? 0,
      sha256: content === null ? null : sha256(content)
    }
    files.push(file)
    if (content !== null) await writeDurableExclusive(path.join(snapshotRoot, `${id}.bin`), content)
  }
  const manifest: SnapshotManifest = {
    schemaVersion: 1,
    snapshotId: transactionId,
    beforeRevision,
    createdAt: new Date().toISOString(),
    files
  }
  await writeDurableExclusive(
    path.join(snapshotRoot, 'manifest.json'),
    Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8')
  )
  await syncDirectory(snapshotRoot)
  await readAndVerifySnapshot(root, transactionId)
  return transactionId
}

async function readAndVerifySnapshot(root: PreparedRoot, snapshotId: string): Promise<SnapshotManifest> {
  if (!transactionIdPattern.test(snapshotId)) throw new GameConfigTransactionError('CONFIG_SNAPSHOT_FAILED')
  const snapshotRoot = path.join(root.snapshotsRoot, snapshotId)
  if (!samePath(path.dirname(snapshotRoot), root.snapshotsRoot)) {
    throw new GameConfigTransactionError('CONFIG_SNAPSHOT_FAILED')
  }
  const rootMetadata = await lstat(snapshotRoot)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() ||
      !samePath(await realpath(snapshotRoot), snapshotRoot)) {
    throw new GameConfigTransactionError('CONFIG_SNAPSHOT_FAILED')
  }
  const manifestBuffer = await readFixedRegularFile(snapshotRoot, 'manifest.json', 64 * 1024)
  const parsed: unknown = JSON.parse(decodeConfig(manifestBuffer))
  if (!isSnapshotManifest(parsed, snapshotId)) throw new GameConfigTransactionError('CONFIG_SNAPSHOT_FAILED')
  for (const file of parsed.files) {
    if (!file.present) continue
    const content = await readFixedRegularFile(snapshotRoot, `${file.id}.bin`, maximumConfigBytes)
    if (content.byteLength !== file.bytes || sha256(content) !== file.sha256) {
      throw new GameConfigTransactionError('CONFIG_SNAPSHOT_FAILED')
    }
  }
  return parsed
}

async function stageBuffer(
  root: string,
  targetName: string,
  content: Buffer,
  transactionId: string,
  purpose: 'apply' | 'restore'
): Promise<string> {
  const tempName = `.${targetName}.${transactionId}.${purpose}.tmp`
  const tempPath = fixedFilePath(root, tempName)
  await writeDurableExclusive(tempPath, content)
  return tempPath
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

async function commitStagedFile(root: string, stagedPath: string, targetName: string): Promise<void> {
  const targetPath = fixedFilePath(root, targetName)
  if (!samePath(path.dirname(stagedPath), root)) throw new GameConfigTransactionError('CONFIG_COMMIT_FAILED')
  await rename(stagedPath, targetPath)
  await syncFile(targetPath)
  await syncDirectory(root)
}

async function removeFixedFile(root: string, targetName: string): Promise<void> {
  const targetPath = fixedFilePath(root, targetName)
  await unlink(targetPath).catch((error: unknown) => {
    if (!hasErrorCode(error, 'ENOENT')) throw error
  })
  await syncDirectory(root)
}

async function syncFile(filePath: string): Promise<void> {
  // Windows FlushFileBuffers rejects a read-only handle with EPERM. The file is
  // not modified through this handle; r+ only supplies the access right needed
  // to durably flush the rename result.
  const handle = await open(filePath, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r').catch(() => null)
  if (!handle) return
  try {
    await handle.sync().catch((error: unknown) => {
      if (!hasErrorCode(error, 'EINVAL') && !hasErrorCode(error, 'EPERM') && !hasErrorCode(error, 'EACCES')) {
        throw error
      }
    })
  } finally {
    await handle.close()
  }
}

async function cleanupStaged(staged: ReadonlyMap<GameConfigFileId, string>): Promise<void> {
  await Promise.all([...staged.values()].map((filePath) => unlink(filePath).catch(() => undefined)))
}

async function writeAudit(
  root: PreparedRoot,
  audit: GameConfigTransactionAuditRecord,
  ordinal: 0 | 1
): Promise<void> {
  const safeStatus = audit.status.replace(/[^a-z-]/g, '')
  const fileName = `${audit.transactionId}-${ordinal}-${safeStatus}.json`
  const target = fixedFilePath(root.auditRoot, fileName)
  await writeDurableExclusive(target, Buffer.from(`${JSON.stringify(audit)}\n`, 'utf8'))
  await syncDirectory(root.auditRoot)
}

function makeAudit(input: AuditInput): GameConfigTransactionAuditRecord {
  return {
    schemaVersion: 1,
    transactionId: input.transactionId,
    action: 'game-config.apply',
    status: input.status,
    dryRun: input.dryRun,
    baseRevision: input.safePlan.baseRevision,
    nextRevision: input.safePlan.nextRevision,
    changedSettingIds: [...input.safePlan.changedSettingIds],
    restartRequired: input.safePlan.restartRequired,
    newGameOnlyChanged: input.safePlan.newGameOnlyChanged,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode })
  }
}

function makeResult(input: ResultInput): GameConfigTransactionResult {
  const audit = makeAudit({
    transactionId: input.transactionId,
    status: input.status,
    dryRun: input.dryRun,
    safePlan: input.safePlan,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode })
  })
  return {
    transactionId: input.transactionId,
    status: input.status,
    dryRun: input.dryRun,
    baseRevision: input.safePlan.baseRevision,
    nextRevision: input.safePlan.nextRevision,
    changedSettingIds: [...input.safePlan.changedSettingIds],
    restartRequired: input.safePlan.restartRequired,
    newGameOnlyChanged: input.safePlan.newGameOnlyChanged,
    ...(input.snapshotId === undefined ? {} : { snapshotId: input.snapshotId }),
    ...(input.currentRevision === undefined ? {} : { currentRevision: input.currentRevision }),
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    auditStored: input.auditStored,
    audit
  }
}

function isSnapshotManifest(value: unknown, snapshotId: string): value is SnapshotManifest {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion', 'snapshotId', 'beforeRevision', 'createdAt', 'files'
  ]) || value.schemaVersion !== 1 || value.snapshotId !== snapshotId ||
      typeof value.beforeRevision !== 'string' || !sha256Pattern.test(value.beforeRevision) ||
      typeof value.createdAt !== 'string' || !Array.isArray(value.files)) return false
  const files: unknown[] = value.files
  if (files.length !== fileIds.length) return false
  return fileIds.every((id, index) => {
    const file = files[index]
    return isRecord(file) && hasExactKeys(file, ['id', 'present', 'bytes', 'sha256']) &&
      file.id === id && typeof file.present === 'boolean' &&
      Number.isInteger(file.bytes) && Number(file.bytes) >= 0 && Number(file.bytes) <= maximumConfigBytes &&
      (file.present
        ? typeof file.sha256 === 'string' && sha256Pattern.test(file.sha256)
        : file.sha256 === null && file.bytes === 0)
  })
}

async function readFixedRegularFile(root: string, fileName: string, maximumBytes: number): Promise<Buffer> {
  const target = fixedFilePath(root, fileName)
  const metadata = await lstat(target)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumBytes ||
      !samePath(await realpath(target), target)) {
    throw new GameConfigTransactionError('CONFIG_SNAPSHOT_FAILED')
  }
  return readFile(target)
}

function fixedFilePath(root: string, fileName: string): string {
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(fileName) || fileName === '.' || fileName === '..') {
    throw new GameConfigTransactionError('CONFIG_TRANSACTION_STORAGE_UNAVAILABLE')
  }
  const resolved = path.resolve(root, fileName)
  if (!samePath(path.dirname(resolved), root)) {
    throw new GameConfigTransactionError('CONFIG_TRANSACTION_STORAGE_UNAVAILABLE')
  }
  return resolved
}

function validPublicValue(definition: GameConfigDefinition, value: unknown): boolean {
  if (definition.type === 'secret') {
    return isRecord(value) && hasExactKeys(value, ['configured']) && typeof value.configured === 'boolean'
  }
  return definition.type === 'boolean'
    ? typeof value === 'boolean'
    : typeof value === 'number' && Number.isFinite(value)
}

function samePublicValue(left: unknown, right: unknown): boolean {
  if (isRecord(left) && isRecord(right)) return left.configured === right.configured
  return Object.is(left, right)
}

function serializeDefault(definition: GameConfigDefinition): string {
  return typeof definition.defaultValue === 'boolean'
    ? String(definition.defaultValue).toLowerCase()
    : String(definition.defaultValue)
}

function validConfigContent(content: string): boolean {
  return !content.includes('\0') &&
    Buffer.byteLength(content, 'utf8') <= maximumConfigBytes &&
    Buffer.from(content, 'utf8').toString('utf8') === content
}

function decodeConfig(content: Buffer): string {
  if (!isUtf8(content)) throw new GameConfigTransactionError('CONFIG_PLAN_INVALID')
  const value = content.toString('utf8')
  if (!validConfigContent(value)) throw new GameConfigTransactionError('CONFIG_PLAN_INVALID')
  return value
}

function equalBuffers(left: Buffer | null, right: Buffer | null): boolean {
  if (left === null || right === null) return left === right
  return left.equals(right)
}

function equalBufferSets(left: ConfigBuffers, right: ConfigBuffers): boolean {
  return fileIds.every((id) => equalBuffers(left[id], right[id]))
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right)
}

function normalizePath(value: string): string {
  return path.resolve(value).replace(/[\\/]+$/, '').toLocaleLowerCase('en-US')
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

export class GameConfigTransactionError extends Error {
  constructor(readonly code: GameConfigTransactionErrorCode) {
    super(code)
    this.name = 'GameConfigTransactionError'
  }
}

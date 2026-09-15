import type {
  GameConfigFileId,
  GameConfigHistoryDiff,
  GameConfigHistoryErrorCode,
  GameConfigHistoryRecoveryResult,
  GameConfigHistoryRestoreReceipt,
  GameConfigHistorySnapshotDetail,
  GameConfigHistorySnapshotSummary,
  PublicGameConfigValue
} from './model'

const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const sha256Pattern = /^[0-9a-f]{64}$/i
const settingIdPattern = /^[a-z0-9.-]{1,128}$/
const maximumSnapshots = 128
const maximumSnapshotBytes = 4 * 1_024 * 1_024
const maximumSettings = 64
const maximumRecoveryResults = 32

export const gameConfigHistoryFileIds = [
  'nebula', 'galaxy', 'bepinex', 'bridge'
] as const satisfies readonly GameConfigFileId[]

const restoreStatuses = new Set([
  'busy', 'dry-run', 'restored', 'rejected', 'rolled-back',
  'recovery-required', 'interrupted-recovered'
])

const historyErrorCodes = new Set<GameConfigHistoryErrorCode>([
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
  'CONFIG_HISTORY_HTTP_REQUEST_INVALID',
  'CONFIG_HISTORY_HTTP_CONFIRMATION_INVALID',
  'CONFIG_HISTORY_HTTP_MUTATION_DISABLED',
  'CONFIG_HISTORY_HTTP_GATE_UNAVAILABLE',
  'CONFIG_HISTORY_HTTP_STOP_PROOF_UNAVAILABLE',
  'CONFIG_HISTORY_HTTP_RESPONSE_INVALID',
  'CONFIG_HISTORY_HTTP_UNAVAILABLE',
  'CONFIG_HISTORY_HTTP_SNAPSHOT_NOT_FOUND'
])

export function isGameConfigHistorySnapshotId(value: string): boolean {
  return uuidV4Pattern.test(value)
}

export function isGameConfigRevision(value: string): boolean {
  return sha256Pattern.test(value)
}

export function parseGameConfigHistoryList(value: unknown): GameConfigHistorySnapshotSummary[] | null {
  if (!Array.isArray(value) || value.length > maximumSnapshots) return null
  const snapshots: GameConfigHistorySnapshotSummary[] = []
  const ids = new Set<string>()
  for (const candidate of value) {
    const snapshot = parseSnapshotSummary(candidate)
    if (snapshot === null || ids.has(snapshot.snapshotId)) return null
    ids.add(snapshot.snapshotId)
    snapshots.push(snapshot)
  }
  return snapshots
}

export function parseGameConfigHistoryDetail(value: unknown): GameConfigHistorySnapshotDetail | null {
  if (!hasExactKeys(value, [
    'format', 'snapshotId', 'kind', 'createdAt', 'revision', 'manifestSha256',
    'fileCount', 'totalBytes', 'files'
  ])) return null
  const summary = parseSnapshotSummaryFields(value)
  if (summary === null || !Array.isArray(value.files) || value.files.length !== gameConfigHistoryFileIds.length) {
    return null
  }
  const files: GameConfigHistorySnapshotDetail['files'] = []
  const seen = new Set<GameConfigFileId>()
  for (const candidate of value.files) {
    if (!hasExactKeys(candidate, ['id', 'present', 'bytes'])
        || !isGameConfigFileId(candidate.id) || seen.has(candidate.id)
        || typeof candidate.present !== 'boolean'
        || !isBoundedSafeInteger(candidate.bytes, 0, maximumSnapshotBytes)
        || (!candidate.present && candidate.bytes !== 0)) return null
    seen.add(candidate.id)
    files.push({ id: candidate.id, present: candidate.present, bytes: candidate.bytes })
  }
  if (!gameConfigHistoryFileIds.every((id) => seen.has(id))
      || files.filter((file) => file.present).length !== summary.fileCount
      || files.reduce((total, file) => total + file.bytes, 0) !== summary.totalBytes) return null
  return { ...summary, files }
}

export function parseGameConfigHistoryDiff(value: unknown): GameConfigHistoryDiff | null {
  if (!hasExactKeys(value, [
    'snapshotId', 'currentRevision', 'targetRevision', 'files', 'settings'
  ]) || !isUuid(value.snapshotId) || !isSha256(value.currentRevision) || !isSha256(value.targetRevision)
      || !Array.isArray(value.files) || value.files.length !== gameConfigHistoryFileIds.length
      || !Array.isArray(value.settings) || value.settings.length > maximumSettings) return null

  const files: GameConfigHistoryDiff['files'] = []
  const fileIds = new Set<GameConfigFileId>()
  for (const candidate of value.files) {
    if (!hasExactKeys(candidate, ['id', 'beforePresent', 'afterPresent', 'changed'])
        || !isGameConfigFileId(candidate.id) || fileIds.has(candidate.id)
        || typeof candidate.beforePresent !== 'boolean'
        || typeof candidate.afterPresent !== 'boolean'
        || typeof candidate.changed !== 'boolean'
        || (candidate.beforePresent !== candidate.afterPresent && candidate.changed !== true)) return null
    fileIds.add(candidate.id)
    files.push({
      id: candidate.id,
      beforePresent: candidate.beforePresent,
      afterPresent: candidate.afterPresent,
      changed: candidate.changed
    })
  }
  if (!gameConfigHistoryFileIds.every((id) => fileIds.has(id))) return null

  const settings: GameConfigHistoryDiff['settings'] = []
  const settingIds = new Set<string>()
  for (const candidate of value.settings) {
    if (!hasExactKeys(candidate, ['id', 'file', 'before', 'after', 'changed'])
        || typeof candidate.id !== 'string' || !settingIdPattern.test(candidate.id)
        || settingIds.has(candidate.id) || !isGameConfigFileId(candidate.file)
        || typeof candidate.changed !== 'boolean') return null
    const before = parsePublicValue(candidate.before)
    const after = parsePublicValue(candidate.after)
    if (before === null || after === null) return null
    settingIds.add(candidate.id)
    settings.push({ id: candidate.id, file: candidate.file, before, after, changed: candidate.changed })
  }

  return {
    snapshotId: value.snapshotId.toLowerCase(),
    currentRevision: value.currentRevision.toLowerCase(),
    targetRevision: value.targetRevision.toLowerCase(),
    files,
    settings
  }
}

export function parseGameConfigHistoryRestoreReceipt(value: unknown): GameConfigHistoryRestoreReceipt | null {
  if (!hasExactKeys(value, [
    'format', 'version', 'requestId', 'snapshotId', 'protectionSnapshotId', 'status',
    'dryRun', 'expectedCurrentRevision', 'targetRevision', 'finalRevision', 'errorCode',
    'startedAt', 'finishedAt', 'persisted', 'reused'
  ]) || value.format !== 'dyson-control-game-config-restore-receipt' || value.version !== 1
      || !isUuid(value.requestId) || !isUuid(value.snapshotId)
      || !(value.protectionSnapshotId === null || isUuid(value.protectionSnapshotId))
      || typeof value.status !== 'string' || !restoreStatuses.has(value.status)
      || typeof value.dryRun !== 'boolean' || !isSha256(value.expectedCurrentRevision)
      || !(value.targetRevision === null || isSha256(value.targetRevision))
      || !(value.finalRevision === null || isSha256(value.finalRevision))
      || !isHistoryErrorCodeOrNone(value.errorCode)
      || !isIsoTimestamp(value.startedAt) || !isIsoTimestamp(value.finishedAt)
      || Date.parse(value.finishedAt) < Date.parse(value.startedAt)
      || typeof value.persisted !== 'boolean' || typeof value.reused !== 'boolean') return null

  const status = value.status as GameConfigHistoryRestoreReceipt['status']
  const errorCode = value.errorCode as GameConfigHistoryRestoreReceipt['errorCode']
  if ((status === 'dry-run') !== value.dryRun) return null
  if ((status === 'dry-run' || status === 'restored') !== (errorCode === 'NONE')) return null
  if (status === 'dry-run' && (
    value.targetRevision === null || value.finalRevision !== value.expectedCurrentRevision
    || value.protectionSnapshotId !== null || !value.persisted
  )) return null
  if (status === 'restored' && (
    value.targetRevision === null || value.finalRevision !== value.targetRevision
    || value.protectionSnapshotId === null || !value.persisted
  )) return null
  if (status === 'busy' && (
    value.targetRevision !== null || value.finalRevision !== null
    || value.protectionSnapshotId !== null || value.persisted
  )) return null

  return {
    format: 'dyson-control-game-config-restore-receipt',
    version: 1,
    requestId: value.requestId.toLowerCase(),
    snapshotId: value.snapshotId.toLowerCase(),
    protectionSnapshotId: value.protectionSnapshotId?.toLowerCase() ?? null,
    status,
    dryRun: value.dryRun,
    expectedCurrentRevision: value.expectedCurrentRevision.toLowerCase(),
    targetRevision: value.targetRevision?.toLowerCase() ?? null,
    finalRevision: value.finalRevision?.toLowerCase() ?? null,
    errorCode,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    persisted: value.persisted,
    reused: value.reused
  }
}

export function parseGameConfigHistoryRecoveryResults(value: unknown): GameConfigHistoryRecoveryResult[] | null {
  if (!Array.isArray(value) || value.length > maximumRecoveryResults) return null
  const results: GameConfigHistoryRecoveryResult[] = []
  const requestIds = new Set<string>()
  for (const candidate of value) {
    if (!hasExactKeys(candidate, ['requestId', 'status', 'finalRevision', 'errorCode'])
        || !isUuid(candidate.requestId) || requestIds.has(candidate.requestId)
        || !['committed-cleanup', 'interrupted-recovered', 'recovery-required'].includes(String(candidate.status))
        || !(candidate.finalRevision === null || isSha256(candidate.finalRevision))
        || !isHistoryErrorCodeOrNone(candidate.errorCode)) return null
    const status = candidate.status as GameConfigHistoryRecoveryResult['status']
    const errorCode = candidate.errorCode as GameConfigHistoryRecoveryResult['errorCode']
    if (status === 'committed-cleanup' && errorCode !== 'NONE') return null
    if (status === 'interrupted-recovered' && errorCode !== 'CONFIG_HISTORY_INTERRUPTED_RECOVERED') {
      return null
    }
    if (status === 'recovery-required' && errorCode === 'NONE') return null
    requestIds.add(candidate.requestId)
    results.push({
      requestId: candidate.requestId.toLowerCase(),
      status,
      finalRevision: candidate.finalRevision?.toLowerCase() ?? null,
      errorCode
    })
  }
  return results
}

function parseSnapshotSummary(value: unknown): GameConfigHistorySnapshotSummary | null {
  if (!hasExactKeys(value, [
    'format', 'snapshotId', 'kind', 'createdAt', 'revision', 'manifestSha256',
    'fileCount', 'totalBytes'
  ])) return null
  return parseSnapshotSummaryFields(value)
}

function parseSnapshotSummaryFields(value: Record<string, unknown>): GameConfigHistorySnapshotSummary | null {
  if (value.format !== 'dyson-control-game-config-snapshot' || !isUuid(value.snapshotId)
      || (value.kind !== 'manual' && value.kind !== 'pre-restore')
      || !isIsoTimestamp(value.createdAt) || !isSha256(value.revision)
      || !isSha256(value.manifestSha256) || !isBoundedSafeInteger(value.fileCount, 0, 4)
      || !isBoundedSafeInteger(value.totalBytes, 0, maximumSnapshotBytes)) return null
  return {
    format: 'dyson-control-game-config-snapshot',
    snapshotId: value.snapshotId.toLowerCase(),
    kind: value.kind,
    createdAt: value.createdAt,
    revision: value.revision.toLowerCase(),
    manifestSha256: value.manifestSha256.toLowerCase(),
    fileCount: value.fileCount,
    totalBytes: value.totalBytes
  }
}

function parsePublicValue(value: unknown): PublicGameConfigValue | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (hasExactKeys(value, ['configured']) && typeof value.configured === 'boolean') {
    return { configured: value.configured }
  }
  return null
}

function isHistoryErrorCodeOrNone(value: unknown): boolean {
  return value === 'NONE' || historyErrorCodes.has(value as GameConfigHistoryErrorCode)
}

function isGameConfigFileId(value: unknown): value is GameConfigFileId {
  return gameConfigHistoryFileIds.includes(value as GameConfigFileId)
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidV4Pattern.test(value)
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && sha256Pattern.test(value)
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 20 || value.length > 32) return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value
}

function isBoundedSafeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key))
}

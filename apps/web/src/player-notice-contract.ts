import type {
  JobRecord, PlayerNoticePlan, PlayerNoticePreviewInput, PlayerNoticeReceipt
} from './model'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const rosterGenerationPattern = /^roster-v1:[0-9a-f]{64}$/
const sessionPlayerIdPattern = /^player-[0-9]{6,12}$/
const codePattern = /^(?:NONE|[A-Z][A-Z0-9_]{2,63})$/
const templates = new Set(['maintenance-5m', 'maintenance-now', 'reconnect-required'])

export function isPlayerNoticePreviewInput(value: unknown): value is PlayerNoticePreviewInput {
  return exact(value, ['rosterGeneration', 'rosterSequence', 'sessionPlayerId', 'templateId']) &&
    isRosterGeneration(value.rosterGeneration) && positiveInteger(value.rosterSequence) &&
    isSessionPlayerId(value.sessionPlayerId) && templates.has(String(value.templateId))
}

export function normalizePlayerNoticePreviewEnvelope(
  value: unknown,
  input: PlayerNoticePreviewInput
): { data: { job: JobRecord; plan: PlayerNoticePlan } } | null {
  if (!exact(value, ['data']) || !exact(value.data, ['job', 'plan'])) return null
  const job = normalizeJob(value.data.job, 'player.notice.preview')
  const plan = normalizePlan(value.data.plan)
  if (job === null || plan === null || job.state !== 'succeeded' || job.errorCode !== null ||
      !samePreview(plan, input)) return null
  return { data: { job, plan } }
}

export function normalizePlayerNoticeExecutionEnvelope(
  value: unknown,
  input: PlayerNoticePreviewInput & {
    requestId: string
    confirmation: 'EXECUTE'
    expectedTargetJoinedAtUnixMs?: number
  }
): { data: { job: JobRecord; receipt: PlayerNoticeReceipt } } | null {
  if (!exact(value, ['data']) || !exact(value.data, ['job', 'receipt'])) return null
  const job = normalizeJob(value.data.job, 'player.notice')
  const receipt = normalizeReceipt(value.data.receipt)
  if (job === null || receipt === null || receipt.requestId !== input.requestId.toLowerCase() ||
      receipt.rosterGeneration !== input.rosterGeneration || receipt.rosterSequence !== input.rosterSequence ||
      receipt.sessionPlayerId !== input.sessionPlayerId || receipt.templateId !== input.templateId ||
      (input.expectedTargetJoinedAtUnixMs !== undefined &&
       Date.parse(receipt.targetJoinedAt) !== input.expectedTargetJoinedAtUnixMs)) return null
  const dispatched = receipt.state === 'transport-dispatched'
  if ((dispatched && (job.state !== 'succeeded' || job.errorCode !== null)) ||
      (!dispatched && (job.state !== 'failed' || job.errorCode !== receipt.errorCode))) return null
  return { data: { job, receipt } }
}

export function normalizePlayerNoticeReceiptEnvelope(
  value: unknown,
  input: PlayerNoticePreviewInput & { requestId: string; expectedTargetJoinedAtUnixMs?: number }
): { data: { receipt: PlayerNoticeReceipt } } | null {
  if (!exact(value, ['data']) || !exact(value.data, ['receipt'])) return null
  const receipt = normalizeReceipt(value.data.receipt)
  if (receipt === null || receipt.requestId !== input.requestId.toLowerCase() ||
      receipt.rosterGeneration !== input.rosterGeneration || receipt.rosterSequence !== input.rosterSequence ||
      receipt.sessionPlayerId !== input.sessionPlayerId || receipt.templateId !== input.templateId ||
      (input.expectedTargetJoinedAtUnixMs !== undefined &&
       Date.parse(receipt.targetJoinedAt) !== input.expectedTargetJoinedAtUnixMs)) return null
  return { data: { receipt } }
}

function normalizePlan(value: unknown): PlayerNoticePlan | null {
  if (!exact(value, [
    'action', 'mode', 'allowed', 'executionEnabled', 'rosterGeneration', 'rosterSequence',
    'sessionPlayerId', 'targetJoinedAtUnixMs', 'templateId', 'checks', 'blockers', 'mutation', 'rollback'
  ]) || value.action !== 'player.notice' || value.mode !== 'dry-run' || typeof value.allowed !== 'boolean' ||
      typeof value.executionEnabled !== 'boolean' || !isRosterGeneration(value.rosterGeneration) ||
      !positiveInteger(value.rosterSequence) || !isSessionPlayerId(value.sessionPlayerId) ||
      !(value.targetJoinedAtUnixMs === null || positiveInteger(value.targetJoinedAtUnixMs)) ||
      !templates.has(String(value.templateId)) || value.mutation !== false ||
      !Array.isArray(value.checks) || value.checks.length < 1 || value.checks.length > 16 ||
      !Array.isArray(value.blockers) || value.blockers.length > 16 ||
      !exact(value.rollback, ['strategy', 'ready', 'summary']) ||
      value.rollback.strategy !== 'not-possible' || value.rollback.ready !== false ||
      !boundedText(value.rollback.summary, 1, 256)) return null
  const checks = value.checks.map(normalizeCheck)
  const checkIds = checks.map((check) => check?.id)
  const expectedCheckIds = [
    'execution-gate', 'capability', 'session-generation',
    'roster-sequence', 'target-session', 'fixed-template'
  ]
  if (checks.some((check) => check === null) || checks.length !== expectedCheckIds.length ||
      new Set(checkIds).size !== checkIds.length || expectedCheckIds.some((id) => !checkIds.includes(id)) ||
      !value.blockers.every((entry) => boundedToken(entry, 1, 64)) ||
      value.allowed !== (value.blockers.length === 0) ||
      value.allowed !== checks.every((check) => check?.status === 'pass') ||
      (value.allowed && !value.executionEnabled) ||
      (value.allowed && value.targetJoinedAtUnixMs === null)) return null
  return {
    action: 'player.notice',
    mode: 'dry-run',
    allowed: value.allowed,
    executionEnabled: value.executionEnabled,
    rosterGeneration: value.rosterGeneration,
    rosterSequence: value.rosterSequence,
    sessionPlayerId: value.sessionPlayerId,
    targetJoinedAtUnixMs: value.targetJoinedAtUnixMs,
    templateId: value.templateId as PlayerNoticePlan['templateId'],
    checks: checks as PlayerNoticePlan['checks'],
    blockers: value.blockers as string[],
    mutation: false,
    rollback: { strategy: 'not-possible', ready: false, summary: value.rollback.summary }
  }
}

function normalizeReceipt(value: unknown): PlayerNoticeReceipt | null {
  if (!exact(value, [
    'requestId', 'action', 'state', 'startedAt', 'finishedAt', 'rosterGeneration', 'rosterSequence',
    'sessionPlayerId', 'targetJoinedAt', 'templateId', 'mutationMayHaveOccurred', 'recoveryRequired',
    'rollback', 'errorCode'
  ]) || !isUuid(value.requestId) || value.action !== 'player.notice' ||
      !['transport-dispatched', 'rejected', 'failed', 'uncertain'].includes(String(value.state)) ||
      !isoTimestamp(value.startedAt) || !isoTimestamp(value.finishedAt) ||
      Date.parse(value.finishedAt) < Date.parse(value.startedAt) || !isRosterGeneration(value.rosterGeneration) ||
      !positiveInteger(value.rosterSequence) || !isSessionPlayerId(value.sessionPlayerId) ||
      !isoTimestamp(value.targetJoinedAt) || !templates.has(String(value.templateId)) ||
      typeof value.mutationMayHaveOccurred !== 'boolean' || typeof value.recoveryRequired !== 'boolean' ||
      !exact(value.rollback, ['strategy', 'summary']) || value.rollback.strategy !== 'not-possible' ||
      !boundedText(value.rollback.summary, 1, 256) || typeof value.errorCode !== 'string' ||
      !codePattern.test(value.errorCode)) return null
  const state = value.state as PlayerNoticeReceipt['state']
  if ((state === 'transport-dispatched' &&
       (!value.mutationMayHaveOccurred || value.recoveryRequired || value.errorCode !== 'NONE')) ||
      (state === 'uncertain' &&
       (!value.mutationMayHaveOccurred || !value.recoveryRequired || value.errorCode === 'NONE')) ||
      ((state === 'failed' || state === 'rejected') &&
       (value.mutationMayHaveOccurred || value.recoveryRequired || value.errorCode === 'NONE'))) return null
  return {
    requestId: value.requestId.toLowerCase(),
    action: 'player.notice',
    state,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    rosterGeneration: value.rosterGeneration,
    rosterSequence: value.rosterSequence,
    sessionPlayerId: value.sessionPlayerId,
    targetJoinedAt: value.targetJoinedAt,
    templateId: value.templateId as PlayerNoticeReceipt['templateId'],
    mutationMayHaveOccurred: value.mutationMayHaveOccurred,
    recoveryRequired: value.recoveryRequired,
    rollback: { strategy: 'not-possible', summary: value.rollback.summary },
    errorCode: value.errorCode
  }
}

function normalizeJob(value: unknown, kind: 'player.notice.preview' | 'player.notice'): JobRecord | null {
  if (!exact(value, [
    'id', 'kind', 'state', 'actor', 'createdAt', 'startedAt', 'finishedAt', 'durationMs', 'summary', 'errorCode'
  ]) || !isUuid(value.id) || value.kind !== kind || !['succeeded', 'failed'].includes(String(value.state)) ||
      !boundedText(value.actor, 1, 64) || !isoTimestamp(value.createdAt) || !isoTimestamp(value.startedAt) ||
      !isoTimestamp(value.finishedAt) || !nonNegativeInteger(value.durationMs) ||
      !boundedText(value.summary, 1, 256) || !(value.errorCode === null ||
        (typeof value.errorCode === 'string' && codePattern.test(value.errorCode)))) return null
  return value as unknown as JobRecord
}

function normalizeCheck(value: unknown): PlayerNoticePlan['checks'][number] | null {
  if (!exact(value, ['id', 'status', 'message']) || !boundedToken(value.id, 1, 64) ||
      (value.status !== 'pass' && value.status !== 'block') || !boundedText(value.message, 1, 256)) return null
  return { id: value.id, status: value.status, message: value.message }
}

function samePreview(plan: PlayerNoticePlan, input: PlayerNoticePreviewInput): boolean {
  return plan.rosterGeneration === input.rosterGeneration && plan.rosterSequence === input.rosterSequence &&
    plan.sessionPlayerId === input.sessionPlayerId && plan.templateId === input.templateId
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}
function isUuid(value: unknown): value is string { return typeof value === 'string' && uuidPattern.test(value) }
function isRosterGeneration(value: unknown): value is string {
  return typeof value === 'string' && rosterGenerationPattern.test(value)
}
function isSessionPlayerId(value: unknown): value is string {
  return typeof value === 'string' && sessionPlayerIdPattern.test(value)
}
function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function isoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 20 && value.length <= 40 && Number.isFinite(Date.parse(value))
}
function boundedText(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum && !/[\r\n\0]/.test(value)
}
function boundedToken(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum && /^[A-Za-z0-9._-]+$/.test(value)
}

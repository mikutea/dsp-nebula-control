import type { JobRecord, SaveJobExecutionResult, SaveJobResultSummary } from './model'

export const SAVE_JOB_RECONCILE_CONFIRMATION = 'RECONCILE_SAVE_JOB' as const

export type SaveReconciliationReason =
  | 'committed-cleanup'
  | 'rolled-back-cleanup'
  | 'audit-repair'

export interface SaveJobResultSummaryWithMaintenance extends SaveJobResultSummary {
  cleanupPending: boolean
  maintenanceRequired: boolean
}

export interface SaveJobExecutionResultWithMaintenance extends Omit<SaveJobExecutionResult, 'run'> {
  run: Omit<SaveJobExecutionResult['run'], 'result'> & {
    result: SaveJobResultSummaryWithMaintenance | null
  }
}

export type SaveReconcileEligibility =
  | Readonly<{
      state: 'allowed'
      reason: SaveReconciliationReason
      confirmation: typeof SAVE_JOB_RECONCILE_CONFIRMATION
    }>
  | Readonly<{
      state: 'in-progress'
      code: 'SAVE_JOB_RECONCILIATION_IN_PROGRESS'
    }>
  | Readonly<{
      state: 'manual-only'
      code:
        | 'SAVE_JOB_NOT_RECOVERY_REQUIRED'
        | 'SAVE_JOB_RECONCILE_NOT_ALLOWED'
        | 'SAVE_JOB_BROWSER_RESPONSE_INVALID'
    }>

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const transactionBackupIdPattern = /^tx-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const catalogBackupIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const errorCodePattern = /^SAVE_[A-Z0-9_]{2,63}$/
const actorPattern = /^[A-Za-z][A-Za-z0-9 ._-]*$/
const runStates = new Set(['queued', 'running', 'succeeded', 'failed', 'interrupted'])
const resultStatuses = new Set([
  'dry-run', 'succeeded', 'busy', 'rejected', 'revision-conflict',
  'failed', 'rolled-back', 'rollback-failed'
])
const rollbackStates = new Set(['not-required', 'succeeded', 'failed'])

/**
 * Parses the complete save-job wire object. This intentionally rejects unknown
 * fields and cross-object identity mismatches before the result can drive a
 * recovery control.
 */
export function normalizeSaveJobExecutionResult(value: unknown): SaveJobExecutionResultWithMaintenance | null {
  if (!hasExactKeys(value, ['job', 'run', 'reused']) || typeof value.reused !== 'boolean') return null
  const job = normalizeSaveJobRecord(value.job)
  const run = normalizeSaveJobRun(value.run)
  if (job === null || run === null || job.id !== run.jobId || job.createdAt !== run.createdAt) return null
  if (job.kind !== `save.${run.operation}` || !jobAndRunStatesMatch(job.state, run.state)) return null
  if (job.errorCode !== run.errorCode || !jobLifecycleFieldsMatch(job) || !runLifecycleFieldsMatch(run)) return null
  if (Date.parse(run.updatedAt) < Date.parse(run.createdAt)) return null
  if (run.state === 'interrupted' && !run.recoveryRequired) return null
  if (run.state === 'succeeded' && (run.recoveryRequired || run.result?.status !== 'succeeded')) return null
  if (run.result !== null) {
    if (run.operation === 'backup' && run.result.protectionBackupId !== null) return null
    if (run.operation === 'restore' && run.result.protectionBackupId === null) return null
  }
  return { job, run, reused: value.reused }
}

export function normalizeSaveJobExecutionEnvelope(
  value: unknown
): { data: SaveJobExecutionResultWithMaintenance } | null {
  if (!hasExactKeys(value, ['data'])) return null
  const data = normalizeSaveJobExecutionResult(value.data)
  return data === null ? null : { data }
}

/**
 * Mirrors the server's deliberately narrow reconciliation allow-list. The
 * input is parsed again so callers cannot obtain an enabled UI from a cast or
 * a partially trusted object.
 */
export function deriveSaveReconcileEligibility(value: unknown): SaveReconcileEligibility {
  const execution = normalizeSaveJobExecutionResult(value)
  if (execution === null) {
    return { state: 'manual-only', code: 'SAVE_JOB_BROWSER_RESPONSE_INVALID' }
  }
  const { run } = execution
  if (!run.recoveryRequired) {
    return { state: 'manual-only', code: 'SAVE_JOB_NOT_RECOVERY_REQUIRED' }
  }
  if (run.state === 'queued' || run.state === 'running') {
    return { state: 'in-progress', code: 'SAVE_JOB_RECONCILIATION_IN_PROGRESS' }
  }
  if (run.state !== 'interrupted' || run.operation !== 'restore' || run.result === null) {
    return { state: 'manual-only', code: 'SAVE_JOB_RECONCILE_NOT_ALLOWED' }
  }

  const result = run.result
  if (run.errorCode === 'SAVE_COMMIT_CLEANUP_PENDING' && result.status === 'succeeded' &&
      result.rollback === 'not-required' && result.auditStored && result.cleanupPending &&
      result.maintenanceRequired) {
    return allowed('committed-cleanup')
  }
  if (run.errorCode === 'SAVE_ROLLBACK_CLEANUP_PENDING' && result.status === 'rolled-back' &&
      result.rollback === 'succeeded' && result.auditStored && result.cleanupPending &&
      result.maintenanceRequired) {
    return allowed('rolled-back-cleanup')
  }
  if (run.errorCode === 'SAVE_JOB_AUDIT_MISSING' && !result.auditStored &&
      ((result.status === 'succeeded' && result.rollback === 'not-required') ||
       (result.status === 'rolled-back' && result.rollback === 'succeeded'))) {
    return allowed('audit-repair')
  }
  return { state: 'manual-only', code: 'SAVE_JOB_RECONCILE_NOT_ALLOWED' }
}

function normalizeSaveJobRecord(value: unknown): JobRecord | null {
  if (!hasExactKeys(value, [
    'id', 'kind', 'state', 'actor', 'createdAt', 'startedAt',
    'finishedAt', 'durationMs', 'summary', 'errorCode'
  ])) return null
  if (!isUuid(value.id) || (value.kind !== 'save.backup' && value.kind !== 'save.restore') ||
      !['queued', 'running', 'succeeded', 'failed'].includes(String(value.state)) ||
      typeof value.actor !== 'string' || value.actor.length < 1 || value.actor.length > 64 ||
      !actorPattern.test(value.actor) || !isIsoTimestamp(value.createdAt) ||
      !isIsoTimestampOrNull(value.startedAt) || !isIsoTimestampOrNull(value.finishedAt) ||
      !isNullableBoundedInteger(value.durationMs, 0, 31_536_000_000) ||
      typeof value.summary !== 'string' || value.summary.length < 1 || value.summary.length > 256 ||
      /[\r\n]/.test(value.summary) || !isErrorCodeOrNull(value.errorCode)) return null
  return {
    id: value.id,
    kind: value.kind,
    state: value.state as JobRecord['state'],
    actor: value.actor,
    createdAt: value.createdAt,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    durationMs: value.durationMs,
    summary: value.summary,
    errorCode: value.errorCode
  }
}

function normalizeSaveJobRun(value: unknown): SaveJobExecutionResultWithMaintenance['run'] | null {
  if (!hasExactKeys(value, [
    'jobId', 'operation', 'state', 'attemptCount', 'result',
    'errorCode', 'recoveryRequired', 'createdAt', 'updatedAt'
  ]) || !isUuid(value.jobId) || (value.operation !== 'backup' && value.operation !== 'restore') ||
      typeof value.state !== 'string' || !runStates.has(value.state) ||
      !isBoundedInteger(value.attemptCount, 0, 1_000_000) ||
      !isErrorCodeOrNull(value.errorCode) || typeof value.recoveryRequired !== 'boolean' ||
      !isIsoTimestamp(value.createdAt) || !isIsoTimestamp(value.updatedAt)) return null
  const result = value.result === null ? null : normalizeSaveJobResult(value.result, value.operation)
  if (value.result !== null && result === null) return null
  return {
    jobId: value.jobId,
    operation: value.operation,
    state: value.state as SaveJobExecutionResultWithMaintenance['run']['state'],
    attemptCount: value.attemptCount,
    result,
    errorCode: value.errorCode,
    recoveryRequired: value.recoveryRequired,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  }
}

function normalizeSaveJobResult(
  value: unknown,
  operation: 'backup' | 'restore'
): SaveJobResultSummaryWithMaintenance | null {
  if (!hasExactKeys(value, [
    'status', 'backupId', 'protectionBackupId', 'pairBytes', 'rollback',
    'reused', 'auditStored', 'cleanupPending', 'maintenanceRequired'
  ]) || typeof value.status !== 'string' || !resultStatuses.has(value.status) || value.status === 'dry-run' ||
      !(operation === 'backup' ? isTransactionBackupId(value.backupId) : isCatalogBackupId(value.backupId)) ||
      !(value.protectionBackupId === null || isTransactionBackupId(value.protectionBackupId)) ||
      !isBoundedInteger(value.pairBytes, 0, Number.MAX_SAFE_INTEGER) ||
      typeof value.rollback !== 'string' || !rollbackStates.has(value.rollback) ||
      typeof value.reused !== 'boolean' || typeof value.auditStored !== 'boolean' ||
      typeof value.cleanupPending !== 'boolean' || typeof value.maintenanceRequired !== 'boolean') return null
  if (value.cleanupPending && (!value.maintenanceRequired ||
      !['succeeded', 'rolled-back'].includes(value.status))) return null
  if (!value.cleanupPending && value.maintenanceRequired &&
      value.status !== 'failed' && value.status !== 'rollback-failed') return null
  if (value.status === 'succeeded' && value.rollback !== 'not-required') return null
  if (value.status === 'rolled-back' && value.rollback !== 'succeeded') return null
  if (value.status === 'rollback-failed' && (value.rollback !== 'failed' || !value.maintenanceRequired)) return null
  return {
    status: value.status as SaveJobResultSummaryWithMaintenance['status'],
    backupId: value.backupId as string,
    protectionBackupId: value.protectionBackupId as string | null,
    pairBytes: value.pairBytes,
    rollback: value.rollback as SaveJobResultSummaryWithMaintenance['rollback'],
    reused: value.reused,
    auditStored: value.auditStored,
    cleanupPending: value.cleanupPending,
    maintenanceRequired: value.maintenanceRequired
  }
}

function allowed(reason: SaveReconciliationReason): SaveReconcileEligibility {
  return { state: 'allowed', reason, confirmation: SAVE_JOB_RECONCILE_CONFIRMATION }
}

function jobAndRunStatesMatch(jobState: JobRecord['state'], runState: SaveJobExecutionResultWithMaintenance['run']['state']): boolean {
  if (runState === 'interrupted' || runState === 'failed') return jobState === 'failed'
  return jobState === runState
}

function jobLifecycleFieldsMatch(job: JobRecord): boolean {
  if (job.state === 'queued') {
    return job.startedAt === null && job.finishedAt === null && job.durationMs === null && job.errorCode === null
  }
  if (job.state === 'running') {
    return job.startedAt !== null && job.finishedAt === null && job.durationMs === null && job.errorCode === null
  }
  if (job.startedAt === null || job.finishedAt === null || job.durationMs === null) return false
  return job.state === 'succeeded' ? job.errorCode === null : job.errorCode !== null
}

function runLifecycleFieldsMatch(run: SaveJobExecutionResultWithMaintenance['run']): boolean {
  if (run.state === 'queued' || run.state === 'running') {
    if (run.errorCode !== null) return false
    return run.recoveryRequired
      ? run.attemptCount > 0 && run.result !== null
      : run.result === null
  }
  if (run.state === 'succeeded') return run.errorCode === null && !run.recoveryRequired && run.result !== null
  if (run.state === 'interrupted') return run.errorCode !== null && run.recoveryRequired
  return run.errorCode !== null && !run.recoveryRequired
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value)
}

function isTransactionBackupId(value: unknown): value is string {
  return typeof value === 'string' && transactionBackupIdPattern.test(value)
}

function isCatalogBackupId(value: unknown): value is string {
  return typeof value === 'string' && catalogBackupIdPattern.test(value)
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 20 && value.length <= 40 && Number.isFinite(Date.parse(value))
}

function isIsoTimestampOrNull(value: unknown): value is string | null {
  return value === null || isIsoTimestamp(value)
}

function isErrorCodeOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && errorCodePattern.test(value))
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

function isNullableBoundedInteger(value: unknown, minimum: number, maximum: number): value is number | null {
  return value === null || isBoundedInteger(value, minimum, maximum)
}

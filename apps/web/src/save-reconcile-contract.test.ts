import { describe, expect, it } from 'vitest'
import {
  deriveSaveReconcileEligibility,
  normalizeSaveJobExecutionEnvelope,
  normalizeSaveJobExecutionResult,
  SAVE_JOB_RECONCILE_CONFIRMATION
} from './save-reconcile-contract'

const jobId = '11111111-1111-4111-8111-111111111111'

describe('save reconciliation browser contract', () => {
  it.each([
    ['committed-cleanup', 'SAVE_COMMIT_CLEANUP_PENDING', 'succeeded', 'not-required', true, true, true],
    ['rolled-back-cleanup', 'SAVE_ROLLBACK_CLEANUP_PENDING', 'rolled-back', 'succeeded', true, true, true],
    ['audit-repair', 'SAVE_JOB_AUDIT_MISSING', 'succeeded', 'not-required', false, false, false],
    ['audit-repair', 'SAVE_JOB_AUDIT_MISSING', 'rolled-back', 'succeeded', false, false, false]
  ] as const)('allows only the proven %s terminal', (
    reason, errorCode, status, rollback, auditStored, cleanupPending, maintenanceRequired
  ) => {
    const execution = fixture({ errorCode, status, rollback, auditStored, cleanupPending, maintenanceRequired })
    expect(normalizeSaveJobExecutionResult(execution)).not.toBeNull()
    expect(deriveSaveReconcileEligibility(execution)).toEqual({
      state: 'allowed', reason, confirmation: SAVE_JOB_RECONCILE_CONFIRMATION
    })
  })

  it.each([
    ['SAVE_ROLLBACK_FAILED', 'rollback-failed', 'failed', true, false, true],
    ['SAVE_JOURNAL_MAINTENANCE_REQUIRED', 'failed', 'not-required', false, false, true],
    ['SAVE_JOB_RECONCILIATION_UNCERTAIN', 'failed', 'not-required', false, false, true]
  ] as const)('keeps unsafe recovery %s manual-only', (
    errorCode, status, rollback, auditStored, cleanupPending, maintenanceRequired
  ) => {
    expect(deriveSaveReconcileEligibility(fixture({
      errorCode, status, rollback, auditStored, cleanupPending, maintenanceRequired
    }))).toEqual({ state: 'manual-only', code: 'SAVE_JOB_RECONCILE_NOT_ALLOWED' })
  })

  it('accepts a queued reconciliation retaining its prior result but never enables another authorization', () => {
    const execution = fixture({
      jobState: 'queued', runState: 'queued', jobErrorCode: null, errorCode: null,
      startedAt: null, finishedAt: null, durationMs: null
    })
    expect(normalizeSaveJobExecutionResult(execution)).not.toBeNull()
    expect(deriveSaveReconcileEligibility(execution)).toEqual({
      state: 'in-progress', code: 'SAVE_JOB_RECONCILIATION_IN_PROGRESS'
    })
  })

  it('accepts a backend-valid catalog backup id on a restore recovery result', () => {
    const execution = fixture({ backupId: 'backup-one.v2' })
    expect(normalizeSaveJobExecutionResult(execution)).not.toBeNull()
    expect(deriveSaveReconcileEligibility(execution)).toEqual({
      state: 'allowed', reason: 'committed-cleanup', confirmation: SAVE_JOB_RECONCILE_CONFIRMATION
    })
  })

  it.each([
    ['extra result field', (value: Record<string, unknown>) => {
      const run = value.run as Record<string, unknown>
      run.result = { ...(run.result as Record<string, unknown>), path: 'C:\\forbidden' }
    }],
    ['missing maintenance flag', (value: Record<string, unknown>) => {
      const result = (value.run as Record<string, unknown>).result as Record<string, unknown>
      delete result.maintenanceRequired
    }],
    ['job/run identity mismatch', (value: Record<string, unknown>) => {
      ;(value.run as Record<string, unknown>).jobId = '22222222-2222-4222-8222-222222222222'
    }],
    ['operation mismatch', (value: Record<string, unknown>) => {
      ;(value.run as Record<string, unknown>).operation = 'backup'
    }],
    ['state mismatch', (value: Record<string, unknown>) => {
      ;(value.job as Record<string, unknown>).state = 'succeeded'
    }],
    ['job/run error mismatch', (value: Record<string, unknown>) => {
      ;(value.job as Record<string, unknown>).errorCode = 'SAVE_JOB_AUDIT_MISSING'
    }]
  ] as const)('fails closed on %s', (_name, mutate) => {
    const execution = fixture()
    mutate(execution)
    expect(normalizeSaveJobExecutionResult(execution)).toBeNull()
    expect(deriveSaveReconcileEligibility(execution)).toEqual({
      state: 'manual-only', code: 'SAVE_JOB_BROWSER_RESPONSE_INVALID'
    })
  })

  it('requires an exact one-field response envelope', () => {
    const execution = fixture()
    expect(normalizeSaveJobExecutionEnvelope({ data: execution })).toEqual({ data: execution })
    expect(normalizeSaveJobExecutionEnvelope({ data: execution, meta: {} })).toBeNull()
  })
})

type FixturePatch = {
  jobState?: 'queued' | 'running' | 'succeeded' | 'failed'
  runState?: 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted'
  jobErrorCode?: string | null
  errorCode?: string | null
  status?: 'succeeded' | 'failed' | 'rolled-back' | 'rollback-failed'
  rollback?: 'not-required' | 'succeeded' | 'failed'
  auditStored?: boolean
  cleanupPending?: boolean
  maintenanceRequired?: boolean
  startedAt?: string | null
  finishedAt?: string | null
  durationMs?: number | null
  backupId?: string
}

function fixture(patch: FixturePatch = {}): Record<string, unknown> {
  const createdAt = '2026-09-05T01:00:00.000Z'
  return {
    job: {
      id: jobId,
      kind: 'save.restore',
      state: patch.jobState ?? 'failed',
      actor: 'Administrator',
      createdAt,
      startedAt: patch.startedAt === undefined ? '2026-09-05T01:00:01.000Z' : patch.startedAt,
      finishedAt: patch.finishedAt === undefined ? '2026-09-05T01:00:02.000Z' : patch.finishedAt,
      durationMs: patch.durationMs === undefined ? 1_000 : patch.durationMs,
      summary: 'Fictional save recovery fixture',
      errorCode: patch.jobErrorCode === undefined
        ? (patch.errorCode ?? 'SAVE_COMMIT_CLEANUP_PENDING')
        : patch.jobErrorCode
    },
    run: {
      jobId,
      operation: 'restore',
      state: patch.runState ?? 'interrupted',
      attemptCount: 1,
      result: {
        status: patch.status ?? 'succeeded',
        backupId: patch.backupId ?? 'tx-33333333-3333-4333-8333-333333333333',
        protectionBackupId: 'tx-44444444-4444-4444-8444-444444444444',
        pairBytes: 2048,
        rollback: patch.rollback ?? 'not-required',
        reused: false,
        auditStored: patch.auditStored ?? true,
        cleanupPending: patch.cleanupPending ?? true,
        maintenanceRequired: patch.maintenanceRequired ?? true
      },
      errorCode: patch.errorCode === undefined ? 'SAVE_COMMIT_CLEANUP_PENDING' : patch.errorCode,
      recoveryRequired: true,
      createdAt,
      updatedAt: '2026-09-05T01:00:02.000Z'
    },
    reused: false
  }
}

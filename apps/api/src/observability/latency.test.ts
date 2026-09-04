import { describe, expect, it } from 'vitest'
import type { JobRecord, LifecycleReceiptRecord, LifecycleRunRecord } from '../domain.js'
import type { StoredSaveJobRun } from '../saves/job-types.js'
import { ObservabilityError } from './errors.js'
import {
  ControlDatabaseReceiptLatencySource,
  deriveBackupLatency,
  deriveLifecycleSaveLatency,
  summarizeServerReceiptLatencies
} from './latency.js'

describe('server-authoritative observability latency derivation', () => {
  it('derives successful save and backup latency only from bound persistent records', () => {
    const save = deriveLifecycleSaveLatency(lifecycleRun(), lifecycleReceipt())
    const backup = deriveBackupLatency(backupJob(), backupRun())
    expect(save).toMatchObject({
      authority: 'control-database', operation: 'save', outcome: 'succeeded', durationMs: 4_000
    })
    expect(backup).toMatchObject({
      authority: 'control-database', operation: 'backup', outcome: 'succeeded', durationMs: 30_000
    })
  })

  it('counts failed and incomplete receipts but never presents them as latency samples', () => {
    const failedReceipt = lifecycleReceipt({ state: 'failed', errorCode: 'LIFECYCLE_PHASE_TIMEOUT' })
    const incompleteReceipt = lifecycleReceipt({ state: 'running', finishedAt: null })
    const failed = deriveLifecycleSaveLatency(lifecycleRun(), failedReceipt)!
    const incomplete = deriveLifecycleSaveLatency(lifecycleRun(), incompleteReceipt)!
    const success = deriveLifecycleSaveLatency(lifecycleRun(), lifecycleReceipt())!
    expect(failed).toMatchObject({ outcome: 'failed', durationMs: null })
    expect(incomplete).toMatchObject({ outcome: 'incomplete', durationMs: null })
    expect(summarizeServerReceiptLatencies([failed, incomplete, success], 'save')).toEqual({
      operation: 'save',
      evidenceStatus: 'not-qualified',
      totalReceipts: 3,
      successfulReceipts: 1,
      failedReceipts: 1,
      incompleteReceipts: 1,
      p50Ms: 4_000,
      p95Ms: 4_000,
      maximumMs: 4_000
    })
  })

  it('builds a bounded read-only report and leaves absent receipt classes unknown', () => {
    const source = new ControlDatabaseReceiptLatencySource({
      listJobs: () => [backupJob()],
      getLifecycleRun: () => null,
      listLifecycleReceipts: () => [],
      getSaveRun: () => backupRun()
    }, () => new Date('2026-08-30T12:00:00.000Z'))

    expect(source.report()).toEqual({
      schemaVersion: 1,
      kind: 'dyson-server-receipt-latency-report',
      evidenceStatus: 'not-qualified',
      generatedAt: '2026-08-30T12:00:00.000Z',
      scannedJobs: 1,
      truncated: false,
      save: {
        operation: 'save', evidenceStatus: 'unknown', totalReceipts: 0,
        successfulReceipts: 0, failedReceipts: 0, incompleteReceipts: 0,
        p50Ms: null, p95Ms: null, maximumMs: null
      },
      backup: {
        operation: 'backup', evidenceStatus: 'not-qualified', totalReceipts: 1,
        successfulReceipts: 1, failedReceipts: 0, incompleteReceipts: 0,
        p50Ms: 30_000, p95Ms: 30_000, maximumMs: 30_000
      }
    })
  })

  it('marks a 5,000-job bounded scan as truncated and unknown instead of complete evidence', () => {
    const jobs = Array.from({ length: 5_001 }, (_, index): JobRecord => ({
      ...backupJob(),
      id: `status-${String(index).padStart(4, '0')}`,
      kind: 'status.refresh'
    }))
    const source = new ControlDatabaseReceiptLatencySource({
      listJobs: () => jobs,
      getLifecycleRun: () => null,
      listLifecycleReceipts: () => [],
      getSaveRun: () => null
    }, () => new Date('2026-08-30T12:00:00.000Z'))

    expect(source.report()).toMatchObject({
      evidenceStatus: 'unknown',
      scannedJobs: 5_000,
      truncated: true,
      save: { totalReceipts: 0, p50Ms: null, p95Ms: null, maximumMs: null },
      backup: { totalReceipts: 0, p50Ms: null, p95Ms: null, maximumMs: null }
    })
  })

  it('rejects cross-job binding, duration drift, and success without a terminal time', () => {
    expect(() => deriveLifecycleSaveLatency(
      lifecycleRun(), lifecycleReceipt({ jobId: 'other-job' })
    )).toThrowError(expect.objectContaining<Partial<ObservabilityError>>({
      code: 'OBSERVABILITY_LATENCY_RECEIPT_BINDING_INVALID'
    }))
    expect(() => deriveBackupLatency(
      { ...backupJob(), durationMs: 1 }, backupRun()
    )).toThrowError(expect.objectContaining<Partial<ObservabilityError>>({
      code: 'OBSERVABILITY_LATENCY_DURATION_MISMATCH'
    }))
    expect(() => deriveLifecycleSaveLatency(
      lifecycleRun(), lifecycleReceipt({ finishedAt: null })
    )).toThrowError(expect.objectContaining<Partial<ObservabilityError>>({
      code: 'OBSERVABILITY_LATENCY_RECEIPT_INVALID'
    }))
  })
})

function lifecycleRun(): LifecycleRunRecord {
  return {
    jobId: 'lifecycle-job', action: 'save', idempotencyKey: 'fixture-lifecycle-save',
    requestId: '11111111-1111-4111-8111-111111111111', state: 'succeeded',
    currentPhase: 'save', protectionPointId: 'protection-fixture', recoveryRequired: false,
    createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:04.000Z'
  }
}

function lifecycleReceipt(
  overrides: Partial<LifecycleReceiptRecord> = {}
): LifecycleReceiptRecord {
  return {
    id: 'save-receipt', jobId: 'lifecycle-job', sequence: 4, phase: 'save',
    state: 'succeeded', startedAt: '2026-08-30T00:00:00.000Z',
    finishedAt: '2026-08-30T00:00:04.000Z', summary: 'fixture', errorCode: null,
    evidence: {}, ...overrides
  }
}

function backupJob(): JobRecord {
  return {
    id: 'backup-job', kind: 'save.backup', state: 'succeeded', actor: 'fixture',
    createdAt: '2026-08-30T00:00:00.000Z', startedAt: '2026-08-30T00:00:00.000Z',
    finishedAt: '2026-08-30T00:00:30.000Z', durationMs: 30_000,
    summary: 'fixture', errorCode: null
  }
}

function backupRun(): StoredSaveJobRun {
  return {
    jobId: 'backup-job', operation: 'backup', idempotencyKey: 'fixture-backup',
    saveName: 'fictional-save', backupId: null, expectedRevision: null,
    protectionRequestId: null, state: 'succeeded', attemptCount: 1,
    result: {
      status: 'succeeded', backupId: 'backup-fixture', protectionBackupId: null,
      pairBytes: 1_000, rollback: 'not-required', reused: false, auditStored: true,
      cleanupPending: false, maintenanceRequired: false
    },
    errorCode: null, recoveryRequired: false,
    createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:30.000Z'
  }
}

import type { JobRecord, LifecycleReceiptRecord, LifecycleRunRecord } from '../domain.js'
import type { StoredSaveJobRun } from '../saves/job-types.js'
import { ObservabilityError } from './errors.js'

export type ObservabilityOperationKind = 'save' | 'backup'
export type ObservabilityOperationOutcome = 'succeeded' | 'failed' | 'incomplete'
export type ObservabilityLatencyEvidenceStatus = 'unknown' | 'not-qualified'

export const OBSERVABILITY_LATENCY_JOB_SCAN_LIMIT = 5_000

/**
 * This type is produced only from records already accepted by ControlDatabase.
 * It is intentionally not paired with an HTTP/body parser: clients cannot
 * submit their own latency values as qualification evidence.
 */
export interface ServerReceiptLatencyObservation {
  schemaVersion: 1
  kind: 'dyson-server-receipt-latency'
  authority: 'control-database'
  operation: ObservabilityOperationKind
  receiptId: string
  observedAt: string
  outcome: ObservabilityOperationOutcome
  durationMs: number | null
}

export interface OperationLatencySummary {
  operation: ObservabilityOperationKind
  evidenceStatus: ObservabilityLatencyEvidenceStatus
  totalReceipts: number
  successfulReceipts: number
  failedReceipts: number
  incompleteReceipts: number
  p50Ms: number | null
  p95Ms: number | null
  maximumMs: number | null
}

export interface ServerReceiptLatencyReport {
  schemaVersion: 1
  kind: 'dyson-server-receipt-latency-report'
  evidenceStatus: ObservabilityLatencyEvidenceStatus
  generatedAt: string
  scannedJobs: number
  truncated: boolean
  save: OperationLatencySummary
  backup: OperationLatencySummary
}

export interface ServerReceiptLatencyStore {
  listJobs(limit: number): JobRecord[]
  getLifecycleRun(jobId: string): LifecycleRunRecord | null
  listLifecycleReceipts(jobId: string): LifecycleReceiptRecord[]
  getSaveRun(jobId: string): StoredSaveJobRun | null
}

export interface ServerReceiptLatencyReportSource {
  report(): ServerReceiptLatencyReport
}

export class ControlDatabaseReceiptLatencySource implements ServerReceiptLatencyReportSource {
  readonly #store: ServerReceiptLatencyStore
  readonly #now: () => Date

  constructor(store: ServerReceiptLatencyStore, now: () => Date = () => new Date()) {
    this.#store = store
    this.#now = now
  }

  report(): ServerReceiptLatencyReport {
    const listed = this.#store.listJobs(OBSERVABILITY_LATENCY_JOB_SCAN_LIMIT + 1)
    const truncated = listed.length > OBSERVABILITY_LATENCY_JOB_SCAN_LIMIT
    const jobs = listed.slice(0, OBSERVABILITY_LATENCY_JOB_SCAN_LIMIT)
    const observations: ServerReceiptLatencyObservation[] = []
    for (const job of jobs) {
      if (job.kind === 'save.backup') {
        const run = this.#store.getSaveRun(job.id)
        if (run === null) throw new ObservabilityError('OBSERVABILITY_LATENCY_RECEIPT_INVALID')
        const observation = deriveBackupLatency(job, run)
        if (observation !== null) observations.push(observation)
        continue
      }
      if (!['game.save', 'game.stop', 'game.restart'].includes(job.kind)) continue
      const run = this.#store.getLifecycleRun(job.id)
      if (run === null) throw new ObservabilityError('OBSERVABILITY_LATENCY_RECEIPT_INVALID')
      for (const receipt of this.#store.listLifecycleReceipts(job.id)) {
        const observation = deriveLifecycleSaveLatency(run, receipt)
        if (observation !== null) observations.push(observation)
      }
    }
    const save = summarizeServerReceiptLatencies(observations, 'save')
    const backup = summarizeServerReceiptLatencies(observations, 'backup')
    return {
      schemaVersion: 1,
      kind: 'dyson-server-receipt-latency-report',
      // A bounded scan is useful operationally, but once truncated it cannot
      // characterize the complete persisted receipt population.
      evidenceStatus: truncated || save.totalReceipts + backup.totalReceipts === 0
        ? 'unknown'
        : 'not-qualified',
      generatedAt: this.#now().toISOString(),
      scannedJobs: jobs.length,
      truncated,
      save,
      backup
    }
  }
}

export function deriveLifecycleSaveLatency(
  run: LifecycleRunRecord,
  receipt: LifecycleReceiptRecord
): ServerReceiptLatencyObservation | null {
  if (receipt.phase !== 'save') return null
  if (run.jobId !== receipt.jobId) {
    throw new ObservabilityError('OBSERVABILITY_LATENCY_RECEIPT_BINDING_INVALID')
  }
  return fromTimes(
    'save',
    receipt.id,
    receipt.startedAt,
    receipt.finishedAt,
    receipt.state === 'succeeded' ? 'succeeded' : receipt.state === 'failed' ? 'failed' : 'incomplete'
  )
}

export function deriveBackupLatency(
  job: JobRecord,
  run: StoredSaveJobRun
): ServerReceiptLatencyObservation | null {
  if (run.operation !== 'backup') return null
  if (job.id !== run.jobId || job.kind !== 'save.backup') {
    throw new ObservabilityError('OBSERVABILITY_LATENCY_RECEIPT_BINDING_INVALID')
  }
  const outcome: ObservabilityOperationOutcome = job.state === 'succeeded'
      && run.state === 'succeeded'
      && run.result?.status === 'succeeded'
      && run.result.auditStored
      && !run.result.cleanupPending
      && !run.result.maintenanceRequired
      && !run.recoveryRequired
    ? 'succeeded'
    : job.state === 'failed' || run.state === 'failed' || run.state === 'interrupted'
      ? 'failed'
      : 'incomplete'
  const observation = fromTimes('backup', job.id, job.startedAt, job.finishedAt, outcome)
  if (observation.durationMs !== null && job.durationMs !== observation.durationMs) {
    throw new ObservabilityError('OBSERVABILITY_LATENCY_DURATION_MISMATCH')
  }
  return observation
}

export function summarizeServerReceiptLatencies(
  observations: readonly ServerReceiptLatencyObservation[],
  operation: ObservabilityOperationKind
): OperationLatencySummary {
  const selected = observations.filter((observation) => observation.operation === operation)
  const successful = selected.filter((observation) =>
    observation.outcome === 'succeeded' && observation.durationMs !== null)
  const durations = successful.map((observation) => observation.durationMs as number)
  return {
    operation,
    evidenceStatus: selected.length === 0 ? 'unknown' : 'not-qualified',
    totalReceipts: selected.length,
    successfulReceipts: successful.length,
    failedReceipts: selected.filter((observation) => observation.outcome === 'failed').length,
    incompleteReceipts: selected.filter((observation) => observation.outcome === 'incomplete').length,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maximumMs: durations.length === 0 ? null : Math.max(...durations)
  }
}

function fromTimes(
  operation: ObservabilityOperationKind,
  receiptId: string,
  startedAt: string | null,
  finishedAt: string | null,
  outcome: ObservabilityOperationOutcome
): ServerReceiptLatencyObservation {
  if (!receiptId || receiptId.length > 128 || startedAt === null || Number.isNaN(Date.parse(startedAt))) {
    throw new ObservabilityError('OBSERVABILITY_LATENCY_RECEIPT_INVALID')
  }
  if (outcome === 'succeeded' && finishedAt === null) {
    throw new ObservabilityError('OBSERVABILITY_LATENCY_RECEIPT_INVALID')
  }
  if (finishedAt !== null && Number.isNaN(Date.parse(finishedAt))) {
    throw new ObservabilityError('OBSERVABILITY_LATENCY_RECEIPT_INVALID')
  }
  const elapsed = finishedAt === null ? null : Date.parse(finishedAt) - Date.parse(startedAt)
  if (elapsed !== null && (!Number.isSafeInteger(elapsed) || elapsed < 0)) {
    throw new ObservabilityError('OBSERVABILITY_LATENCY_RECEIPT_INVALID')
  }
  return {
    schemaVersion: 1,
    kind: 'dyson-server-receipt-latency',
    authority: 'control-database',
    operation,
    receiptId,
    observedAt: finishedAt ?? startedAt,
    outcome,
    // Failed and incomplete records are counted but never become latency data.
    durationMs: outcome === 'succeeded' ? elapsed : null
  }
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1))
  return sorted[index] ?? null
}

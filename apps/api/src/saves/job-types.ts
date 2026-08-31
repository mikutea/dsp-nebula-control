import type { SaveTransactionErrorCode, SaveTransactionStatus } from './transactions.js'

export type SaveJobOperation = 'backup' | 'restore'
export type SaveJobRunState = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted'

export interface BackupSaveJobRequest {
  operation: 'backup'
  idempotencyKey: string
  saveName: string
}

export interface RestoreSaveJobRequest {
  operation: 'restore'
  idempotencyKey: string
  backupId: string
  expectedRevision: string
  protectionRequestId: string
}

export type SaveJobRequest = BackupSaveJobRequest | RestoreSaveJobRequest

/**
 * Fixed-column request stored for safe replay. Revision data is internal and is
 * intentionally omitted from public save-job snapshots.
 */
export interface PersistedSaveJobRequest {
  operation: SaveJobOperation
  idempotencyKey: string
  saveName: string | null
  backupId: string | null
  expectedRevision: string | null
  protectionRequestId: string | null
}

export interface SaveJobResultSummary {
  status: SaveTransactionStatus
  backupId: string
  protectionBackupId: string | null
  pairBytes: number
  rollback: 'not-required' | 'succeeded' | 'failed'
  reused: boolean
  auditStored: boolean
}

/** Internal database record. Do not return its request fields from an HTTP route. */
export interface StoredSaveJobRun extends PersistedSaveJobRequest {
  jobId: string
  state: SaveJobRunState
  attemptCount: number
  result: SaveJobResultSummary | null
  errorCode: SaveTransactionErrorCode | SaveJobErrorCode | null
  recoveryRequired: boolean
  createdAt: string
  updatedAt: string
}

/** Bounded query result: no paths, revisions, hashes, contents, or secrets. */
export interface SaveJobRunRecord {
  jobId: string
  operation: SaveJobOperation
  state: SaveJobRunState
  attemptCount: number
  result: SaveJobResultSummary | null
  errorCode: SaveTransactionErrorCode | SaveJobErrorCode | null
  recoveryRequired: boolean
  createdAt: string
  updatedAt: string
}

export type SaveJobErrorCode =
  | 'SAVE_JOB_REQUEST_INVALID'
  | 'SAVE_JOB_IDEMPOTENCY_CONFLICT'
  | 'SAVE_JOB_SERVICE_CLOSED'
  | 'SAVE_JOB_RESULT_INVALID'
  | 'SAVE_JOB_EXECUTOR_FAILED'
  | 'SAVE_JOB_AUDIT_MISSING'
  | 'SAVE_JOB_RECONCILIATION_UNCERTAIN'

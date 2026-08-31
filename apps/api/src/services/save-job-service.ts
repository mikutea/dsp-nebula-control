import { z } from 'zod'
import type { JobRecord } from '../domain.js'
import {
  backupIdSchema,
  saveNameSchema
} from '../saves/schemas.js'
import type {
  PersistedSaveJobRequest,
  SaveJobErrorCode,
  SaveJobRequest,
  SaveJobResultSummary,
  SaveJobRunRecord,
  StoredSaveJobRun
} from '../saves/job-types.js'
import type {
  BackupSavePairRequest,
  RestoreSavePairRequest,
  SaveTransactionErrorCode,
  SaveTransactionResult,
  SaveTransactionService
} from '../saves/transactions.js'
import { ControlDatabase } from '../storage/database.js'
import { EventHub } from './event-hub.js'

const uuidSchema = z.string().uuid().transform((value) => value.toLocaleLowerCase('en-US'))
const pairRevisionSchema = z.string().regex(/^pair-v1:[a-f0-9]{64}$/)
const backupJobRequestSchema = z.strictObject({
  operation: z.literal('backup'),
  idempotencyKey: uuidSchema,
  saveName: saveNameSchema
})
const restoreJobRequestSchema = z.strictObject({
  operation: z.literal('restore'),
  idempotencyKey: uuidSchema,
  backupId: backupIdSchema,
  expectedRevision: pairRevisionSchema,
  protectionRequestId: uuidSchema
})
const saveJobRequestSchema = z.discriminatedUnion('operation', [backupJobRequestSchema, restoreJobRequestSchema])
const transactionResultSchema = z.object({
  schemaVersion: z.literal(1),
  requestId: uuidSchema,
  operation: z.enum(['backup', 'restore']),
  status: z.enum([
    'dry-run', 'succeeded', 'busy', 'rejected', 'revision-conflict',
    'failed', 'rolled-back', 'rollback-failed'
  ]),
  dryRun: z.literal(false),
  backupId: backupIdSchema,
  protectionBackupId: backupIdSchema.optional(),
  reused: z.boolean(),
  rollback: z.enum(['not-required', 'succeeded', 'failed']),
  pairBytes: z.number().int().nonnegative(),
  errorCode: z.string().regex(/^SAVE_[A-Z0-9_]{2,63}$/).optional(),
  auditStored: z.boolean()
})

export interface SaveTransactionExecutor {
  backup(input: BackupSavePairRequest): Promise<SaveTransactionResult>
  restore(input: RestoreSavePairRequest): Promise<SaveTransactionResult>
}

export interface SaveJobExecutionResult {
  job: JobRecord
  run: SaveJobRunRecord
  reused: boolean
}

export class SaveJobServiceError extends Error {
  constructor(readonly code: SaveJobErrorCode) {
    super(code)
    this.name = 'SaveJobServiceError'
  }
}

/**
 * Durable single-worker orchestration around the already idempotent paired-save
 * transaction service. HTTP confirmation and authorization belong to app.ts;
 * this service accepts only validated logical identifiers.
 */
export class SaveJobService {
  readonly #database: ControlDatabase
  readonly #executor: SaveTransactionExecutor | Pick<SaveTransactionService, 'backup' | 'restore'>
  readonly #events: EventHub
  readonly #scheduled = new Set<string>()
  #queue: Promise<void> = Promise.resolve()
  #initialized = false
  #closed = false

  constructor(
    database: ControlDatabase,
    executor: SaveTransactionExecutor | Pick<SaveTransactionService, 'backup' | 'restore'>,
    events: EventHub
  ) {
    this.#database = database
    this.#executor = executor
    this.#events = events
  }

  /** Replays queued work and idempotently reconciles work that was running. */
  initialize(): number {
    if (this.#initialized) return 0
    if (this.#closed) throw new SaveJobServiceError('SAVE_JOB_SERVICE_CLOSED')
    this.#initialized = true
    const active = this.#database.listActiveSaveRuns()
    for (const run of active) this.#schedule(run, run.state === 'running')
    return active.length
  }

  enqueue(input: SaveJobRequest, actor: string): SaveJobExecutionResult {
    if (this.#closed) throw new SaveJobServiceError('SAVE_JOB_SERVICE_CLOSED')
    const request = parseRequest(input)
    if (!this.#initialized) this.initialize()
    const created = this.#database.createSaveJob(
      request,
      actor,
      request.operation === 'backup' ? '配对存档备份事务已排队' : '受控存档恢复事务已排队'
    )
    if (created.reused && !sameRequest(created.run, request)) {
      throw new SaveJobServiceError('SAVE_JOB_IDEMPOTENCY_CONFLICT')
    }
    this.#events.publish({ type: 'job.updated', data: created.job })
    if (created.run.state === 'queued' || created.run.state === 'running') {
      this.#schedule(created.run, created.run.state === 'running')
    }
    return this.#snapshot(created.job.id, created.reused)
  }

  get(jobId: string): SaveJobExecutionResult | null {
    const job = this.#database.getJob(jobId)
    const run = this.#database.getSaveRun(jobId)
    if (!job || !run) return null
    return { job, run: publicRun(run), reused: true }
  }

  /** Stops accepting work and drains the current serial queue without cancelling a mutation. */
  async close(): Promise<void> {
    this.#closed = true
    await this.#queue
  }

  #schedule(run: StoredSaveJobRun, reconciling: boolean): void {
    if (this.#scheduled.has(run.jobId)) return
    this.#scheduled.add(run.jobId)
    this.#queue = this.#queue
      .then(async () => { await this.#run(run.jobId, reconciling) })
      .catch(() => undefined)
      .finally(() => { this.#scheduled.delete(run.jobId) })
  }

  async #run(jobId: string, reconciling: boolean): Promise<void> {
    const run = this.#database.getSaveRun(jobId)
    if (!run || !['queued', 'running'].includes(run.state)) return
    const running = this.#database.markSaveRunRunning(
      jobId,
      reconciling ? '存档事务正在执行幂等重启对账' : '存档事务正在执行'
    )
    this.#events.publish({ type: 'job.updated', data: running.job })

    let rawResult: SaveTransactionResult
    try {
      rawResult = run.operation === 'backup'
        ? await this.#executor.backup({
            requestId: run.idempotencyKey,
            saveName: required(run.saveName),
            dryRun: false
          })
        : await this.#executor.restore({
            requestId: run.idempotencyKey,
            backupId: required(run.backupId),
            expectedRevision: required(run.expectedRevision),
            protectionRequestId: required(run.protectionRequestId),
            dryRun: false
          })
    } catch {
      this.#complete(
        jobId,
        'interrupted',
        reconciling ? '存档事务重启对账结果不确定，已停止自动恢复' : '存档事务执行器异常，结果需要人工核验',
        reconciling ? 'SAVE_JOB_RECONCILIATION_UNCERTAIN' : 'SAVE_JOB_EXECUTOR_FAILED',
        true,
        null
      )
      return
    }

    const result = parseAndBindResult(rawResult, run)
    if (result === null) {
      this.#complete(
        jobId,
        'interrupted',
        '存档事务返回了无法绑定到请求的结果，已停止自动恢复',
        'SAVE_JOB_RESULT_INVALID',
        true,
        null
      )
      return
    }

    if (['succeeded', 'rolled-back', 'rollback-failed'].includes(result.status) && !result.auditStored) {
      this.#complete(
        jobId,
        'interrupted',
        '存档事务完成但审计记录未确认持久化，需要人工核验',
        'SAVE_JOB_AUDIT_MISSING',
        true,
        result
      )
      return
    }

    if (result.status === 'succeeded') {
      this.#complete(
        jobId,
        'succeeded',
        run.operation === 'backup' ? '配对存档备份事务已完成' : '受控存档恢复事务已完成',
        null,
        false,
        result
      )
      return
    }

    if (reconciling || result.status === 'rollback-failed') {
      this.#complete(
        jobId,
        'interrupted',
        reconciling ? '存档事务重启对账无法证明终态，已停止自动恢复' : '存档恢复补偿未完成，需要人工核验',
        reconciling ? 'SAVE_JOB_RECONCILIATION_UNCERTAIN' : (result.errorCode ?? 'SAVE_ROLLBACK_FAILED'),
        true,
        result
      )
      return
    }

    this.#complete(
      jobId,
      'failed',
      result.status === 'rolled-back'
        ? '存档事务失败，当前存档对已完成补偿恢复'
        : '存档事务未完成且未提交可验证结果',
      result.errorCode ?? fallbackErrorCode(result.status),
      false,
      result
    )
  }

  #complete(
    jobId: string,
    state: 'succeeded' | 'failed' | 'interrupted',
    summary: string,
    errorCode: SaveTransactionErrorCode | SaveJobErrorCode | null,
    recoveryRequired: boolean,
    result: SaveJobResultSummary | null
  ): void {
    const completed = this.#database.completeSaveRun(
      jobId,
      state,
      summary,
      errorCode,
      recoveryRequired,
      result
    )
    this.#events.publish({ type: 'job.updated', data: completed.job })
  }

  #snapshot(jobId: string, reused: boolean): SaveJobExecutionResult {
    const job = this.#database.getJob(jobId)
    const run = this.#database.getSaveRun(jobId)
    if (!job || !run) throw new Error(`Save job is missing: ${jobId}`)
    return { job, run: publicRun(run), reused }
  }
}

function parseRequest(input: SaveJobRequest): PersistedSaveJobRequest {
  let parsed: z.infer<typeof saveJobRequestSchema>
  try {
    parsed = saveJobRequestSchema.parse(input)
  } catch {
    throw new SaveJobServiceError('SAVE_JOB_REQUEST_INVALID')
  }
  return parsed.operation === 'backup'
    ? {
        operation: 'backup', idempotencyKey: parsed.idempotencyKey,
        saveName: parsed.saveName, backupId: null, expectedRevision: null,
        protectionRequestId: null
      }
    : {
        operation: 'restore', idempotencyKey: parsed.idempotencyKey,
        saveName: null, backupId: parsed.backupId,
        expectedRevision: parsed.expectedRevision,
        protectionRequestId: parsed.protectionRequestId
      }
}

function sameRequest(left: PersistedSaveJobRequest, right: PersistedSaveJobRequest): boolean {
  return left.operation === right.operation && left.idempotencyKey === right.idempotencyKey &&
    left.saveName === right.saveName && left.backupId === right.backupId &&
    left.expectedRevision === right.expectedRevision &&
    left.protectionRequestId === right.protectionRequestId
}

function parseAndBindResult(
  input: SaveTransactionResult,
  run: StoredSaveJobRun
): (SaveJobResultSummary & { errorCode?: SaveTransactionErrorCode }) | null {
  const parsed = transactionResultSchema.safeParse(input)
  if (!parsed.success || parsed.data.requestId !== run.idempotencyKey ||
      parsed.data.operation !== run.operation || parsed.data.status === 'dry-run') return null
  if (parsed.data.status === 'succeeded' &&
      (parsed.data.errorCode !== undefined || parsed.data.rollback !== 'not-required')) return null
  if (parsed.data.status === 'rolled-back' &&
      (parsed.data.errorCode === undefined || parsed.data.rollback !== 'succeeded')) return null
  if (parsed.data.status === 'rollback-failed' &&
      (parsed.data.errorCode === undefined || parsed.data.rollback !== 'failed')) return null
  if (!['succeeded', 'rolled-back', 'rollback-failed'].includes(parsed.data.status) &&
      parsed.data.errorCode === undefined) return null
  if (run.operation === 'backup') {
    if (parsed.data.backupId !== `tx-${run.idempotencyKey}` || parsed.data.protectionBackupId !== undefined) {
      return null
    }
  } else if (parsed.data.backupId !== run.backupId ||
      parsed.data.protectionBackupId !== `tx-${run.protectionRequestId}`) return null
  return {
    status: parsed.data.status,
    backupId: parsed.data.backupId,
    protectionBackupId: parsed.data.protectionBackupId ?? null,
    pairBytes: parsed.data.pairBytes,
    rollback: parsed.data.rollback,
    reused: parsed.data.reused,
    auditStored: parsed.data.auditStored,
    ...(parsed.data.errorCode === undefined
      ? {}
      : { errorCode: parsed.data.errorCode as SaveTransactionErrorCode })
  }
}

function publicRun(run: StoredSaveJobRun): SaveJobRunRecord {
  return {
    jobId: run.jobId,
    operation: run.operation,
    state: run.state,
    attemptCount: run.attemptCount,
    result: run.result,
    errorCode: run.errorCode,
    recoveryRequired: run.recoveryRequired,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt
  }
}

function fallbackErrorCode(status: SaveJobResultSummary['status']): SaveTransactionErrorCode {
  if (status === 'busy') return 'SAVE_TRANSACTION_BUSY'
  if (status === 'revision-conflict') return 'SAVE_REVISION_CONFLICT'
  if (status === 'rolled-back') return 'SAVE_COMMIT_FAILED'
  return 'SAVE_TRANSACTION_STORAGE_UNAVAILABLE'
}

function required(value: string | null): string {
  if (value === null) throw new SaveJobServiceError('SAVE_JOB_RESULT_INVALID')
  return value
}

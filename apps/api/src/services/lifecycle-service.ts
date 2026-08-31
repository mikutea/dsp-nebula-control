import {
  LifecycleExecutionError,
  type JobRecord,
  type LifecycleAction,
  type LifecycleEvidence,
  type LifecycleExecutionPhase,
  type LifecycleMutationAdapter,
  type LifecycleOperationContext,
  type LifecyclePhaseResult,
  type LifecycleReceiptRecord,
  type LifecycleRunRecord
} from '../domain.js'
import { ControlDatabase } from '../storage/database.js'
import { EventHub } from './event-hub.js'

export interface LifecycleExecutionResult {
  job: JobRecord
  run: LifecycleRunRecord
  receipts: LifecycleReceiptRecord[]
  reused: boolean
}

export { LifecycleExecutionError } from '../domain.js'

export class LifecycleService {
  readonly #database: ControlDatabase
  readonly #adapter: LifecycleMutationAdapter
  readonly #events: EventHub
  readonly #phaseTimeoutMs: number
  #queue: Promise<void> = Promise.resolve()

  constructor(
    database: ControlDatabase,
    adapter: LifecycleMutationAdapter,
    events: EventHub,
    phaseTimeoutMs = 30_000
  ) {
    if (!Number.isInteger(phaseTimeoutMs) || phaseTimeoutMs < 10 || phaseTimeoutMs > 300_000) {
      throw new Error('Lifecycle phase timeout must be between 10 and 300000 ms')
    }
    this.#database = database
    this.#adapter = adapter
    this.#events = events
    this.#phaseTimeoutMs = phaseTimeoutMs
  }

  initialize(): number {
    const reconciled = this.#database.reconcileInterruptedLifecycleRuns()
    for (const item of reconciled) this.#events.publish({ type: 'job.updated', data: item.job })
    return reconciled.length
  }

  get(jobId: string): LifecycleExecutionResult | null {
    const job = this.#database.getJob(jobId)
    const run = this.#database.getLifecycleRun(jobId)
    if (!job || !run) return null
    return { job, run, receipts: this.#database.listLifecycleReceipts(jobId), reused: true }
  }

  preview(action: LifecycleAction) {
    return this.#adapter.previewLifecycle(action, {
      executionLockReady: this.#database.isLifecycleLockAvailable()
    })
  }

  enqueue(action: LifecycleAction, idempotencyKey: string, actor: string): LifecycleExecutionResult {
    const created = this.#create(action, idempotencyKey, actor)
    if (!created.reused) {
      this.#queue = this.#queue.then(async () => { await this.#run(created) }).catch(() => undefined)
    }
    return this.#snapshot(created.job.id, created.reused)
  }

  async execute(action: LifecycleAction, idempotencyKey: string, actor: string): Promise<LifecycleExecutionResult> {
    const created = this.#create(action, idempotencyKey, actor)
    if (created.reused) return this.#snapshot(created.job.id, true)
    return this.#run(created)
  }

  async close(): Promise<void> {
    await this.#queue
  }

  #create(action: LifecycleAction, idempotencyKey: string, actor: string) {
    const created = this.#database.createLifecycleJob(
      action,
      idempotencyKey,
      actor,
      `${this.#label(action)}生命周期事务已排队`
    )
    if (created.reused && created.run.action !== action) {
      throw new LifecycleExecutionError('LIFECYCLE_IDEMPOTENCY_CONFLICT')
    }
    this.#events.publish({ type: 'job.updated', data: created.job })
    return created
  }

  async #run(created: ReturnType<ControlDatabase['createLifecycleJob']>): Promise<LifecycleExecutionResult> {
    const action = created.run.action
    const running = this.#database.markLifecycleRunRunning(
      created.job.id,
      `${this.#label(action)}生命周期事务正在获取全局锁`
    )
    this.#events.publish({ type: 'job.updated', data: running.job })

    const lockReceipt = this.#database.startLifecyclePhase(created.job.id, 'lock', '获取全局生命周期互斥锁')
    if (!this.#database.tryAcquireLifecycleLock(created.job.id)) {
      this.#database.finishLifecyclePhase(
        lockReceipt.id,
        'failed',
        '已有其他生命周期事务持有全局锁',
        'LIFECYCLE_BUSY',
        {}
      )
      const failed = this.#database.completeLifecycleRun(
        created.job.id,
        'failed',
        `${this.#label(action)}生命周期事务未执行：服务器正忙`,
        'LIFECYCLE_BUSY',
        false
      )
      this.#events.publish({ type: 'job.updated', data: failed.job })
      return this.#snapshot(created.job.id, false)
    }
    this.#database.finishLifecyclePhase(lockReceipt.id, 'succeeded', '已获取全局生命周期互斥锁', null, {})

    let protectionPointId: string | null = null
    let stopMayHaveOccurred = false
    let startMayHaveOccurred = false
    let failedPhase: LifecycleExecutionPhase | null = null
    let failureCode = 'LIFECYCLE_PHASE_FAILED'
    let recoveryRequired = false

    try {
      await this.#phase(created.run, 'preflight', protectionPointId, async () => {
        if (!this.#adapter.mutationEnabled) {
          throw new LifecycleExecutionError('LIFECYCLE_EXECUTION_DISABLED')
        }
        const preview = await this.#adapter.previewLifecycle(action, { executionLockReady: true })
        if (!preview.allowed || !preview.executionEnabled || preview.blockers.length > 0) {
          throw new LifecycleExecutionError('LIFECYCLE_PREFLIGHT_BLOCKED')
        }
        return {
          summary: '生命周期执行预检通过',
          evidence: { blockerCount: preview.blockers.length, rollbackReady: preview.rollback.ready }
        }
      })

      if (action !== 'start') {
        const protection = await this.#phase(
          created.run,
          'protection-point',
          protectionPointId,
          async (context) => {
            const result = await this.#adapter.createProtectionPoint(context)
            return { ...result, protectionPointId: this.#validateProtectionPoint(result.protectionPointId) }
          }
        )
        protectionPointId = protection.protectionPointId!
        this.#database.setLifecycleProtectionPoint(created.job.id, protectionPointId)

        await this.#phase(
          created.run,
          'save',
          protectionPointId,
          (context) => this.#adapter.requestSave(context)
        )
      }

      if (action === 'graceful-stop' || action === 'restart') {
        stopMayHaveOccurred = true
        await this.#phase(
          created.run,
          'stop',
          protectionPointId,
          (context) => this.#adapter.requestGracefulStop(context)
        )
        await this.#phase(
          created.run,
          'verify-stopped',
          protectionPointId,
          (context) => this.#adapter.verifyStopped(context)
        )
      }

      if (action === 'start' || action === 'restart') {
        startMayHaveOccurred = true
        await this.#phase(
          created.run,
          'start',
          protectionPointId,
          (context) => this.#adapter.requestStart(context)
        )
        await this.#phase(
          created.run,
          'verify-running',
          protectionPointId,
          (context) => this.#adapter.verifyRunning(context)
        )
      }

      const succeeded = this.#database.completeLifecycleRun(
        created.job.id,
        'succeeded',
        `${this.#label(action)}生命周期事务已完成`,
        null,
        false
      )
      this.#events.publish({ type: 'job.updated', data: succeeded.job })
      return this.#snapshot(created.job.id, false)
    } catch (error) {
      const run = this.#database.getLifecycleRun(created.job.id)
      failedPhase = run?.currentPhase ?? null
      failureCode = this.#errorCode(error)
      recoveryRequired = failureCode === 'LIFECYCLE_PHASE_TIMEOUT' || failedPhase === 'save' ||
        (action === 'start' && startMayHaveOccurred)

      if (stopMayHaveOccurred) {
        try {
          await this.#phase(
            created.run,
            'rollback-start',
            protectionPointId,
            (context) => this.#adapter.requestRollbackStart(context)
          )
          await this.#phase(
            created.run,
            'verify-running',
            protectionPointId,
            (context) => this.#adapter.verifyRunning(context)
          )
          recoveryRequired = false
        } catch {
          failureCode = 'LIFECYCLE_ROLLBACK_FAILED'
          recoveryRequired = true
        }
      }

      const failed = this.#database.completeLifecycleRun(
        created.job.id,
        'failed',
        `${this.#label(action)}生命周期事务失败${failedPhase ? `（${failedPhase}）` : ''}`,
        failureCode,
        recoveryRequired
      )
      this.#events.publish({ type: 'job.updated', data: failed.job })
      return this.#snapshot(created.job.id, false)
    }
  }

  async #phase(
    run: LifecycleRunRecord,
    phase: Exclude<LifecycleExecutionPhase, 'lock' | 'reconciliation'>,
    protectionPointId: string | null,
    operation: (context: LifecycleOperationContext) => Promise<LifecyclePhaseResult>
  ): Promise<LifecyclePhaseResult> {
    const receipt = this.#database.startLifecyclePhase(run.jobId, phase, `${this.#phaseLabel(phase)}开始`)
    const controller = new AbortController()
    let timer: NodeJS.Timeout | null = null
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new LifecycleExecutionError('LIFECYCLE_PHASE_TIMEOUT'))
        }, this.#phaseTimeoutMs)
      })
      const result = await Promise.race([
        operation({
          jobId: run.jobId,
          requestId: run.requestId,
          action: run.action,
          protectionPointId,
          signal: controller.signal
        }),
        timeout
      ])
      const summary = this.#boundedSummary(result.summary)
      const evidence = this.#boundedEvidence(result.evidence ?? {})
      this.#database.finishLifecyclePhase(receipt.id, 'succeeded', summary, null, evidence)
      return { ...result, summary, evidence }
    } catch (error) {
      const code = this.#errorCode(error)
      this.#database.finishLifecyclePhase(
        receipt.id,
        'failed',
        `${this.#phaseLabel(phase)}失败`,
        code,
        {}
      )
      throw error instanceof LifecycleExecutionError ? error : new LifecycleExecutionError(code)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  #snapshot(jobId: string, reused: boolean): LifecycleExecutionResult {
    const job = this.#database.getJob(jobId)
    const run = this.#database.getLifecycleRun(jobId)
    if (!job || !run) throw new Error(`Lifecycle execution is missing: ${jobId}`)
    return { job, run, receipts: this.#database.listLifecycleReceipts(jobId), reused }
  }

  #validateProtectionPoint(value: string | undefined): string {
    if (!value || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
      throw new LifecycleExecutionError('LIFECYCLE_PROTECTION_POINT_INVALID')
    }
    return value
  }

  #boundedSummary(value: string): string {
    if (typeof value !== 'string' || value.length < 1 || value.length > 256 || /[\r\n\0]/.test(value)) {
      throw new LifecycleExecutionError('LIFECYCLE_ADAPTER_RESULT_INVALID')
    }
    return value
  }

  #boundedEvidence(value: LifecycleEvidence): LifecycleEvidence {
    const entries = Object.entries(value)
    if (entries.length > 32) throw new LifecycleExecutionError('LIFECYCLE_ADAPTER_RESULT_INVALID')
    const result: LifecycleEvidence = {}
    for (const [key, item] of entries) {
      if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(key)) {
        throw new LifecycleExecutionError('LIFECYCLE_ADAPTER_RESULT_INVALID')
      }
      if (typeof item === 'string') {
        if (item.length > 256 || /[\r\n\0]/.test(item)) {
          throw new LifecycleExecutionError('LIFECYCLE_ADAPTER_RESULT_INVALID')
        }
      } else if (typeof item === 'number') {
        if (!Number.isFinite(item)) throw new LifecycleExecutionError('LIFECYCLE_ADAPTER_RESULT_INVALID')
      } else if (typeof item !== 'boolean' && item !== null) {
        throw new LifecycleExecutionError('LIFECYCLE_ADAPTER_RESULT_INVALID')
      }
      result[key] = item
    }
    return result
  }

  #errorCode(error: unknown): string {
    if (error instanceof LifecycleExecutionError && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.code)) {
      return error.code
    }
    return 'LIFECYCLE_PHASE_FAILED'
  }

  #label(action: LifecycleAction): string {
    if (action === 'start') return '启动'
    if (action === 'save') return '保存'
    if (action === 'graceful-stop') return '优雅停服'
    return '重启'
  }

  #phaseLabel(phase: Exclude<LifecycleExecutionPhase, 'lock' | 'reconciliation'>): string {
    const labels: Record<Exclude<LifecycleExecutionPhase, 'lock' | 'reconciliation'>, string> = {
      preflight: '执行预检',
      'protection-point': '创建保护点',
      save: '请求保存',
      stop: '请求优雅停服',
      'verify-stopped': '确认进程已停止',
      start: '请求启动',
      'verify-running': '确认服务健康',
      'rollback-start': '回滚启动'
    }
    return labels[phase]
  }
}

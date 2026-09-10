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
import {
  LifecycleCoordinatorError,
  type LifecycleCoordinatorScope,
  type LifecycleLeaseDisposition,
  type LifecycleMutationCoordinator
} from '../host-mutation/lifecycle-coordinator.js'
import { EventHub } from './event-hub.js'

export interface LifecycleExecutionResult {
  job: JobRecord
  run: LifecycleRunRecord
  receipts: LifecycleReceiptRecord[]
  reused: boolean
}

interface LifecycleTransactionOutcome {
  state: 'succeeded' | 'failed'
  failedPhase: LifecycleExecutionPhase | null
  failureCode: string | null
  recoveryRequired: boolean
  disposition: LifecycleLeaseDisposition
}

export { LifecycleExecutionError } from '../domain.js'

export class LifecycleService {
  readonly #database: ControlDatabase
  readonly #adapter: LifecycleMutationAdapter
  readonly #events: EventHub
  readonly #phaseTimeoutMs: number
  readonly #startupTimeoutMs: number
  readonly #coordinator: LifecycleMutationCoordinator | undefined
  #queue: Promise<void> = Promise.resolve()

  constructor(
    database: ControlDatabase,
    adapter: LifecycleMutationAdapter,
    events: EventHub,
    phaseTimeoutMs = 30_000,
    coordinator?: LifecycleMutationCoordinator,
    startupTimeoutMs = phaseTimeoutMs
  ) {
    if (!Number.isInteger(phaseTimeoutMs) || phaseTimeoutMs < 10 || phaseTimeoutMs > 300_000) {
      throw new Error('Lifecycle phase timeout must be between 10 and 300000 ms')
    }
    if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 10 || startupTimeoutMs > 900_000) {
      throw new Error('Lifecycle startup timeout must be between 10 and 900000 ms')
    }
    this.#startupTimeoutMs = startupTimeoutMs
    this.#database = database
    this.#adapter = adapter
    this.#events = events
    this.#phaseTimeoutMs = phaseTimeoutMs
    this.#coordinator = coordinator
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

  preview(action: LifecycleAction, signal: AbortSignal = new AbortController().signal) {
    if (signal.aborted) return Promise.reject(abortReason(signal))
    return waitForAbort(
      Promise.resolve().then(async () => await this.#adapter.previewLifecycle(action, {
        executionLockReady: this.#database.isLifecycleLockAvailable(),
        signal
      })),
      signal
    )
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

    if (!this.#coordinator) {
      this.#database.finishLifecyclePhase(lockReceipt.id, 'succeeded', '已获取全局生命周期互斥锁', null, {})
      return this.#completeTransaction(created, await this.#executeTransaction(created))
    }

    let coordinatorEntered = false
    try {
      const outcome = await this.#coordinator.runExclusive(
        { requestId: created.run.requestId, action },
        async (scope) => {
          coordinatorEntered = true
          this.#database.finishLifecyclePhase(
            lockReceipt.id,
            'succeeded',
            '已获取全局生命周期互斥锁和主机变更租约',
            null,
            {}
          )
          const transaction = await this.#executeTransaction(created, scope)
          return { value: transaction, disposition: transaction.disposition }
        }
      )
      return this.#completeTransaction(created, outcome)
    } catch (error) {
      const failureCode = coordinatorEntered
        ? 'LIFECYCLE_HOST_LEASE_LOST'
        : this.#coordinatorAcquireErrorCode(error)
      if (!coordinatorEntered) {
        this.#database.finishLifecyclePhase(
          lockReceipt.id,
          'failed',
          '主机变更租约获取失败',
          failureCode,
          {}
        )
      }
      const failed = this.#database.completeLifecycleRun(
        created.job.id,
        'failed',
        `${this.#label(action)}生命周期事务失败（主机变更租约）`,
        failureCode,
        coordinatorEntered
      )
      this.#events.publish({ type: 'job.updated', data: failed.job })
      return this.#snapshot(created.job.id, false)
    }
  }

  async #executeTransaction(
    created: ReturnType<ControlDatabase['createLifecycleJob']>,
    hostMutation?: LifecycleCoordinatorScope
  ): Promise<LifecycleTransactionOutcome> {
    const action = created.run.action
    const leaseSignal = hostMutation?.signal

    let protectionPointId: string | null = null
    let stopMayHaveOccurred = false
    let startMayHaveOccurred = false
    let nativeMutationMayHaveOccurred = false
    let failedPhase: LifecycleExecutionPhase | null = null
    let failureCode = 'LIFECYCLE_PHASE_FAILED'
    let recoveryRequired = false

    try {
      await this.#phase(created.run, 'preflight', protectionPointId, async (context) => {
        if (!this.#adapter.mutationEnabled) {
          throw new LifecycleExecutionError('LIFECYCLE_EXECUTION_DISABLED')
        }
        const preview = await this.#adapter.previewLifecycle(action, {
          executionLockReady: true,
          requestId: context.requestId,
          signal: context.signal,
          ...(context.hostMutation ? { hostMutation: context.hostMutation } : {})
        })
        if (!preview.allowed || !preview.executionEnabled || preview.blockers.length > 0) {
          throw new LifecycleExecutionError('LIFECYCLE_PREFLIGHT_BLOCKED')
        }
        return {
          summary: '生命周期执行预检通过',
          evidence: { blockerCount: preview.blockers.length, rollbackReady: preview.rollback.ready }
        }
      }, hostMutation)

      if (action !== 'start') {
        nativeMutationMayHaveOccurred = true
        const protection = await this.#phase(
          created.run,
          'protection-point',
          protectionPointId,
          async (context) => {
            const result = await this.#adapter.createProtectionPoint(context)
            return { ...result, protectionPointId: this.#validateProtectionPoint(result.protectionPointId) }
          },
          hostMutation
        )
        protectionPointId = protection.protectionPointId!
        this.#database.setLifecycleProtectionPoint(created.job.id, protectionPointId)

        await this.#phase(
          created.run,
          'save',
          protectionPointId,
          (context) => this.#adapter.requestSave(context),
          hostMutation
        )
      }

      if (action === 'graceful-stop' || action === 'restart') {
        stopMayHaveOccurred = true
        nativeMutationMayHaveOccurred = true
        await this.#phase(
          created.run,
          'stop',
          protectionPointId,
          (context) => this.#adapter.requestGracefulStop(context),
          hostMutation
        )
        await this.#phase(
          created.run,
          'verify-stopped',
          protectionPointId,
          (context) => this.#adapter.verifyStopped(context),
          hostMutation
        )
      }

      if (action === 'start' || action === 'restart') {
        startMayHaveOccurred = true
        nativeMutationMayHaveOccurred = true
        await this.#phase(
          created.run,
          'start',
          protectionPointId,
          (context) => this.#adapter.requestStart(context),
          hostMutation
        )
        await this.#phase(
          created.run,
          'verify-running',
          protectionPointId,
          (context) => this.#adapter.verifyRunning(context),
          hostMutation
        )
      }

      return {
        state: 'succeeded',
        failedPhase: null,
        failureCode: null,
        recoveryRequired: false,
        disposition: 'release'
      }
    } catch (error) {
      const run = this.#database.getLifecycleRun(created.job.id)
      failedPhase = run?.currentPhase ?? null
      failureCode = this.#errorCode(error)
      recoveryRequired = failureCode === 'LIFECYCLE_PHASE_TIMEOUT' || failedPhase === 'save' ||
        (action === 'start' && startMayHaveOccurred)
      const leaseLost = leaseSignal?.aborted === true || failureCode === 'LIFECYCLE_HOST_LEASE_LOST'
      if (leaseSignal && nativeMutationMayHaveOccurred) recoveryRequired = true
      if (leaseLost) recoveryRequired = true

      if (stopMayHaveOccurred && !leaseLost) {
        try {
          await this.#phase(
            created.run,
            'rollback-start',
            protectionPointId,
            (context) => this.#adapter.requestRollbackStart(context),
            hostMutation
          )
          await this.#phase(
            created.run,
            'verify-running',
            protectionPointId,
            (context) => this.#adapter.verifyRunning(context),
            hostMutation
          )
          recoveryRequired = false
        } catch (rollbackError) {
          const rollbackCode = this.#errorCode(rollbackError)
          failureCode = rollbackCode === 'LIFECYCLE_HOST_LEASE_LOST'
            ? rollbackCode
            : 'LIFECYCLE_ROLLBACK_FAILED'
          recoveryRequired = true
        }
      }

      return {
        state: 'failed',
        failedPhase,
        failureCode,
        recoveryRequired,
        disposition: recoveryRequired ? 'abandon' : 'release'
      }
    }
  }

  #completeTransaction(
    created: ReturnType<ControlDatabase['createLifecycleJob']>,
    outcome: LifecycleTransactionOutcome
  ): LifecycleExecutionResult {
    const action = created.run.action
    const completed = this.#database.completeLifecycleRun(
      created.job.id,
      outcome.state,
      outcome.state === 'succeeded'
        ? `${this.#label(action)}生命周期事务已完成`
        : `${this.#label(action)}生命周期事务失败${outcome.failedPhase ? `（${outcome.failedPhase}）` : ''}`,
      outcome.failureCode,
      outcome.recoveryRequired
    )
    this.#events.publish({ type: 'job.updated', data: completed.job })
    return this.#snapshot(created.job.id, false)
  }

  async #phase(
    run: LifecycleRunRecord,
    phase: Exclude<LifecycleExecutionPhase, 'lock' | 'reconciliation'>,
    protectionPointId: string | null,
    operation: (context: LifecycleOperationContext) => Promise<LifecyclePhaseResult>,
    hostMutation?: LifecycleCoordinatorScope
  ): Promise<LifecyclePhaseResult> {
    const leaseSignal = hostMutation?.signal
    const receipt = this.#database.startLifecyclePhase(run.jobId, phase, `${this.#phaseLabel(phase)}开始`)
    const controller = new AbortController()
    let timer: NodeJS.Timeout | null = null
    let removeLeaseAbortListener: (() => void) | null = null
    try {
      if (leaseSignal?.aborted) {
        throw new LifecycleExecutionError('LIFECYCLE_HOST_LEASE_LOST')
      }
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new LifecycleExecutionError('LIFECYCLE_PHASE_TIMEOUT'))
          controller.abort()
        }, phase === 'verify-running' ? this.#startupTimeoutMs : this.#phaseTimeoutMs)
      })
      const contenders: Array<Promise<LifecyclePhaseResult> | Promise<never>> = [
        Promise.resolve().then(async () => {
          const borrowed = hostMutation
            ? {
                assertActive: () => this.#assertHostMutationActive(hostMutation),
                toPowerShellBorrowArguments: () => {
                  this.#assertHostMutationActive(hostMutation)
                  try { return hostMutation.toPowerShellBorrowArguments() }
                  catch { throw new LifecycleExecutionError('LIFECYCLE_HOST_LEASE_LOST') }
                }
              }
            : undefined
          this.#assertHostMutationActive(hostMutation)
          const result = await operation({
            jobId: run.jobId,
            requestId: run.requestId,
            action: run.action,
            protectionPointId,
            signal: controller.signal,
            ...(borrowed ? { hostMutation: borrowed } : {})
          })
          this.#assertHostMutationActive(hostMutation)
          return result
        }),
        timeout
      ]
      if (leaseSignal) {
        let rejectLeaseAbort!: (reason?: unknown) => void
        const leaseAbort = new Promise<never>((_resolve, reject) => { rejectLeaseAbort = reject })
        const onAbort = () => {
          rejectLeaseAbort(new LifecycleExecutionError('LIFECYCLE_HOST_LEASE_LOST'))
          controller.abort()
        }
        if (leaseSignal.aborted) {
          onAbort()
        } else {
          leaseSignal.addEventListener('abort', onAbort, { once: true })
          removeLeaseAbortListener = () => leaseSignal.removeEventListener('abort', onAbort)
        }
        contenders.push(leaseAbort)
      }
      const result = await Promise.race(contenders)
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
      removeLeaseAbortListener?.()
      if (!controller.signal.aborted) controller.abort()
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

  #assertHostMutationActive(scope: LifecycleCoordinatorScope | undefined): void {
    if (!scope) return
    try { scope.assertActive() }
    catch { throw new LifecycleExecutionError('LIFECYCLE_HOST_LEASE_LOST') }
  }

  #coordinatorAcquireErrorCode(error: unknown): string {
    if (error instanceof LifecycleCoordinatorError) return error.code
    return 'LIFECYCLE_HOST_LEASE_UNAVAILABLE'
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

function waitForAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal))

  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => finish(() => reject(abortReason(signal)))

    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error))
    )
  })
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('LIFECYCLE_PREVIEW_ABORTED')
}

import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type {
  LifecycleAction,
  LifecycleMutationAdapter,
  LifecycleOperationContext,
  LifecyclePhaseResult,
  LifecyclePreview,
  LifecyclePreviewContext
} from '../domain.js'
import {
  LifecycleCoordinatorError,
  type LifecycleCoordinatorOutcome,
  type LifecycleCoordinatorRequest,
  type LifecycleCoordinatorScope,
  type LifecycleMutationCoordinator
} from '../host-mutation/lifecycle-coordinator.js'
import { ControlDatabase } from '../storage/database.js'
import { EventHub } from './event-hub.js'
import { LifecycleExecutionError, LifecycleService } from './lifecycle-service.js'

describe('durable lifecycle service', () => {
  it('persists every restart phase and reuses an idempotent result without running again', async () => {
    const database = new ControlDatabase('unused', true)
    const adapter = new FakeLifecycleAdapter()
    const service = new LifecycleService(database, adapter, new EventHub(), 1_000)
    expect(service.initialize()).toBe(0)

    const first = await service.execute('restart', 'restart:fixture:0001', 'Administrator')
    expect(first.job.state).toBe('succeeded')
    expect(first.run).toMatchObject({
      state: 'succeeded', recoveryRequired: false, protectionPointId: 'backup:fixture-0001'
    })
    expect(first.receipts.map((receipt) => [receipt.phase, receipt.state])).toEqual([
      ['lock', 'succeeded'],
      ['preflight', 'succeeded'],
      ['protection-point', 'succeeded'],
      ['save', 'succeeded'],
      ['stop', 'succeeded'],
      ['verify-stopped', 'succeeded'],
      ['start', 'succeeded'],
      ['verify-running', 'succeeded']
    ])
    expect(adapter.calls).toEqual([
      'preflight:restart', 'protection-point', 'save', 'stop',
      'verify-stopped', 'start', 'verify-running'
    ])

    const duplicate = await service.execute('restart', 'restart:fixture:0001', 'Administrator')
    expect(duplicate.reused).toBe(true)
    expect(duplicate.job.id).toBe(first.job.id)
    expect(adapter.calls).toHaveLength(7)
    expect(() => service.enqueue('save', 'restart:fixture:0001', 'Administrator')).toThrowError(
      expect.objectContaining({ code: 'LIFECYCLE_IDEMPOTENCY_CONFLICT' })
    )
    database.close()
  })

  it('starts a stopped server without running the save or stop chain and reuses the durable result', async () => {
    const database = new ControlDatabase('unused', true)
    const adapter = new FakeLifecycleAdapter()
    const service = new LifecycleService(database, adapter, new EventHub(), 1_000)

    const first = await service.execute('start', 'start:fixture:stopped-0001', 'Administrator')
    expect(first.job).toMatchObject({ kind: 'game.start', state: 'succeeded', errorCode: null })
    expect(first.run).toMatchObject({ action: 'start', protectionPointId: null, recoveryRequired: false })
    expect(first.receipts.map((receipt) => [receipt.phase, receipt.state])).toEqual([
      ['lock', 'succeeded'],
      ['preflight', 'succeeded'],
      ['start', 'succeeded'],
      ['verify-running', 'succeeded']
    ])
    expect(adapter.calls).toEqual(['preflight:start', 'start', 'verify-running'])

    const duplicate = await service.execute('start', 'start:fixture:stopped-0001', 'Administrator')
    expect(duplicate).toMatchObject({ reused: true, job: { id: first.job.id, state: 'succeeded' } })
    expect(adapter.calls).toHaveLength(3)
    database.close()
  })

  it('does not auto-stop a partially started runtime when health verification fails', async () => {
    const database = new ControlDatabase('unused', true)
    const adapter = new FakeLifecycleAdapter()
    adapter.failFirstRunningVerification = true
    const service = new LifecycleService(database, adapter, new EventHub(), 1_000)

    const result = await service.execute('start', 'start:fixture:verify-failed-01', 'Administrator')
    expect(result.job).toMatchObject({ state: 'failed', errorCode: 'TEST_VERIFY_FAILED' })
    expect(result.run).toMatchObject({ state: 'failed', recoveryRequired: true, protectionPointId: null })
    expect(result.receipts.map((receipt) => [receipt.phase, receipt.state])).toEqual([
      ['lock', 'succeeded'],
      ['preflight', 'succeeded'],
      ['start', 'succeeded'],
      ['verify-running', 'failed']
    ])
    expect(adapter.calls).toEqual(['preflight:start', 'start', 'verify-running'])
    database.close()
  })

  it('rejects a concurrent lifecycle transaction through the durable global lock', async () => {
    const database = new ControlDatabase('unused', true)
    const adapter = new FakeLifecycleAdapter()
    const saveGate = deferred<void>()
    const saveStarted = deferred<void>()
    adapter.saveGate = saveGate.promise
    adapter.onSaveStarted = () => saveStarted.resolve()
    const service = new LifecycleService(database, adapter, new EventHub(), 2_000)

    const firstPromise = service.execute('save', 'save:fixture:concurrent-01', 'Administrator')
    await saveStarted.promise
    const second = await service.execute('save', 'save:fixture:concurrent-02', 'Administrator')
    expect(second.job).toMatchObject({ state: 'failed', errorCode: 'LIFECYCLE_BUSY' })
    expect(second.receipts).toEqual([
      expect.objectContaining({ phase: 'lock', state: 'failed', errorCode: 'LIFECYCLE_BUSY' })
    ])

    saveGate.resolve()
    const first = await firstPromise
    expect(first.job.state).toBe('succeeded')
    database.close()
  })

  it('starts rollback and verifies health when restart health verification fails', async () => {
    const database = new ControlDatabase('unused', true)
    const adapter = new FakeLifecycleAdapter()
    adapter.failFirstRunningVerification = true
    const service = new LifecycleService(database, adapter, new EventHub(), 1_000)

    const result = await service.execute('restart', 'restart:fixture:rollback-01', 'Administrator')
    expect(result.job).toMatchObject({ state: 'failed', errorCode: 'TEST_VERIFY_FAILED' })
    expect(result.run).toMatchObject({ state: 'failed', recoveryRequired: false })
    expect(result.receipts.map((receipt) => [receipt.phase, receipt.state])).toEqual([
      ['lock', 'succeeded'],
      ['preflight', 'succeeded'],
      ['protection-point', 'succeeded'],
      ['save', 'succeeded'],
      ['stop', 'succeeded'],
      ['verify-stopped', 'succeeded'],
      ['start', 'succeeded'],
      ['verify-running', 'failed'],
      ['rollback-start', 'succeeded'],
      ['verify-running', 'succeeded']
    ])
    expect(adapter.calls.slice(-3)).toEqual(['verify-running', 'rollback-start', 'verify-running'])
    database.close()
  })

  it('marks a file-backed unfinished phase interrupted after a real database reopen without replaying it', async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), 'dyson-lifecycle-recovery-'))
    let database: ControlDatabase | null = new ControlDatabase(dataDirectory)
    try {
      const created = database.createLifecycleJob(
        'restart', 'restart:fixture:interrupted-01', 'Administrator', 'queued fixture'
      )
      database.markLifecycleRunRunning(created.job.id, 'running fixture')
      expect(database.tryAcquireLifecycleLock(created.job.id)).toBe(true)
      database.startLifecyclePhase(created.job.id, 'save', 'save started')
      database.close()
      database = null

      database = new ControlDatabase(dataDirectory)
      const adapter = new FakeLifecycleAdapter()
      const service = new LifecycleService(database, adapter, new EventHub(), 1_000)
      expect(service.initialize()).toBe(1)
      const result = service.get(created.job.id)
      expect(result?.job).toMatchObject({ state: 'failed', errorCode: 'LIFECYCLE_INTERRUPTED' })
      expect(result?.run).toMatchObject({
        state: 'interrupted', currentPhase: 'reconciliation', recoveryRequired: true
      })
      expect(result?.receipts).toEqual([
        expect.objectContaining({ phase: 'save', state: 'failed', errorCode: 'CONTROL_PLANE_RESTARTED' }),
        expect.objectContaining({ phase: 'reconciliation', state: 'failed', errorCode: 'LIFECYCLE_INTERRUPTED' })
      ])
      expect(adapter.calls).toEqual([])
    } finally {
      database?.close()
      await rm(dataDirectory, { recursive: true, force: true })
    }
  })

  it('holds one coordinator scope across the transaction, releases success, and does not reacquire on replay', async () => {
    const database = new ControlDatabase('unused', true)
    const adapter = new FakeLifecycleAdapter()
    const coordinator = new FakeLifecycleCoordinator()
    const service = new LifecycleService(database, adapter, new EventHub(), 1_000, coordinator)

    const first = await service.execute('restart', 'restart:fixture:lease-0001', 'Administrator')

    expect(first.job.state).toBe('succeeded')
    expect(coordinator.acquireCount).toBe(1)
    expect(coordinator.requests).toEqual([{ requestId: first.run.requestId, action: 'restart' }])
    expect(coordinator.dispositions).toEqual(['release'])
    expect(coordinator.scopeSignals).toHaveLength(1)
    expect(adapter.phaseSignals).toHaveLength(6)
    expect(adapter.phaseSignals.every((signal) => signal.aborted)).toBe(true)
    expect(adapter.previewLeaseArguments).toEqual([
      '-DataRoot', 'C:\\fixture\\data',
      '-LeaseInstanceId', '00000000-0000-4000-8000-000000000302',
      '-LeaseToken', 'B'.repeat(43)
    ])
    expect(adapter.phaseLeaseArguments).toHaveLength(6)
    expect(adapter.phaseLeaseArguments.every((arguments_) =>
      arguments_?.join('\0') === adapter.previewLeaseArguments?.join('\0'))).toBe(true)

    const replay = await service.execute('restart', 'restart:fixture:lease-0001', 'Administrator')
    expect(replay).toMatchObject({ reused: true, job: { id: first.job.id, state: 'succeeded' } })
    expect(coordinator.acquireCount).toBe(1)
    expect(adapter.calls).toHaveLength(7)
    database.close()
  })

  it.each([
    'LIFECYCLE_HOST_LEASE_BUSY',
    'LIFECYCLE_HOST_LEASE_DIRTY',
    'LIFECYCLE_HOST_LEASE_RECOVERY_REQUIRED'
  ] as const)('persists the fixed safe acquire failure %s and releases the database lock', async (code) => {
    const database = new ControlDatabase('unused', true)
    const adapter = new FakeLifecycleAdapter()
    const coordinator = new FakeLifecycleCoordinator()
    coordinator.acquireError = new LifecycleCoordinatorError(code)
    const service = new LifecycleService(database, adapter, new EventHub(), 1_000, coordinator)

    const result = await service.execute('save', `save:fixture:${code}`, 'Administrator')

    expect(result.job).toMatchObject({ state: 'failed', errorCode: code })
    expect(result.run).toMatchObject({ state: 'failed', recoveryRequired: false })
    expect(result.receipts).toEqual([
      expect.objectContaining({ phase: 'lock', state: 'failed', errorCode: code })
    ])
    expect(result.receipts[0]?.summary).toBe('主机变更租约获取失败')
    expect(database.isLifecycleLockAvailable()).toBe(true)
    expect(adapter.calls).toEqual([])
    database.close()
  })

  it('maps an unknown acquire exception to unavailable without persisting coordinator output', async () => {
    const database = new ControlDatabase('unused', true)
    const adapter = new FakeLifecycleAdapter()
    const coordinator = new FakeLifecycleCoordinator()
    coordinator.acquireError = new Error('SENSITIVE_BROKER_OUTPUT_MUST_NOT_PERSIST')
    const service = new LifecycleService(database, adapter, new EventHub(), 1_000, coordinator)

    const result = await service.execute('save', 'save:fixture:lease-unknown', 'Administrator')

    expect(result.job).toMatchObject({ state: 'failed', errorCode: 'LIFECYCLE_HOST_LEASE_UNAVAILABLE' })
    expect(result.receipts).toEqual([
      expect.objectContaining({
        phase: 'lock', state: 'failed', errorCode: 'LIFECYCLE_HOST_LEASE_UNAVAILABLE'
      })
    ])
    expect(JSON.stringify(result)).not.toContain('SENSITIVE_BROKER_OUTPUT_MUST_NOT_PERSIST')
    expect(database.isLifecycleLockAvailable()).toBe(true)
    database.close()
  })

  it('releases a preflight rejection that proves no native mutation started', async () => {
    const database = new ControlDatabase('unused', true)
    const adapter = new FakeLifecycleAdapter()
    adapter.mutationEnabled = false
    const coordinator = new FakeLifecycleCoordinator()
    const service = new LifecycleService(database, adapter, new EventHub(), 1_000, coordinator)

    const result = await service.execute('save', 'save:fixture:preflight-disabled', 'Administrator')

    expect(result.job).toMatchObject({ state: 'failed', errorCode: 'LIFECYCLE_EXECUTION_DISABLED' })
    expect(result.run.recoveryRequired).toBe(false)
    expect(coordinator.dispositions).toEqual(['release'])
    expect(adapter.calls).toEqual([])
    database.close()
  })

  it('releases only after a failed restart completes and verifies rollback', async () => {
    const database = new ControlDatabase('unused', true)
    const adapter = new FakeLifecycleAdapter()
    adapter.failFirstRunningVerification = true
    const coordinator = new FakeLifecycleCoordinator()
    const service = new LifecycleService(database, adapter, new EventHub(), 1_000, coordinator)

    const result = await service.execute('restart', 'restart:fixture:lease-rollback', 'Administrator')

    expect(result.job).toMatchObject({ state: 'failed', errorCode: 'TEST_VERIFY_FAILED' })
    expect(result.run.recoveryRequired).toBe(false)
    expect(adapter.calls.slice(-3)).toEqual(['verify-running', 'rollback-start', 'verify-running'])
    expect(coordinator.dispositions).toEqual(['release'])
    database.close()
  })

  it('abandons an unrecovered start mutation while returning the persisted failed snapshot', async () => {
    const database = new ControlDatabase('unused', true)
    const adapter = new FakeLifecycleAdapter()
    adapter.failFirstRunningVerification = true
    const coordinator = new FakeLifecycleCoordinator()
    const service = new LifecycleService(database, adapter, new EventHub(), 1_000, coordinator)

    const result = await service.execute('start', 'start:fixture:lease-abandon', 'Administrator')

    expect(result.job).toMatchObject({ state: 'failed', errorCode: 'TEST_VERIFY_FAILED' })
    expect(result.run.recoveryRequired).toBe(true)
    expect(coordinator.dispositions).toEqual(['abandon'])
    expect(result).not.toHaveProperty('disposition')
    database.close()
  })

  it('fails the active phase and skips rollback when the broker root signal is lost', async () => {
    const database = new ControlDatabase('unused', true)
    const adapter = new FakeLifecycleAdapter()
    const coordinator = new FakeLifecycleCoordinator()
    adapter.hangStopUntilAbort = true
    adapter.onStopStarted = () => queueMicrotask(() => coordinator.abort())
    const service = new LifecycleService(database, adapter, new EventHub(), 1_000, coordinator)

    const result = await service.execute('restart', 'restart:fixture:broker-abort', 'Administrator')

    expect(result.job).toMatchObject({ state: 'failed', errorCode: 'LIFECYCLE_HOST_LEASE_LOST' })
    expect(result.run.recoveryRequired).toBe(true)
    expect(result.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'stop', state: 'failed', errorCode: 'LIFECYCLE_HOST_LEASE_LOST' })
    ]))
    expect(adapter.stopAbortObserved).toBe(true)
    expect(adapter.calls).not.toContain('rollback-start')
    expect(coordinator.dispositions).toEqual(['abandon'])
    database.close()
  })

  it('abandons a timed-out detached mutation and ignores its late successful return', async () => {
    const database = new ControlDatabase('unused', true)
    const adapter = new FakeLifecycleAdapter()
    const coordinator = new FakeLifecycleCoordinator()
    const saveGate = deferred<void>()
    const saveCompleted = deferred<void>()
    adapter.saveGate = saveGate.promise
    adapter.onSaveCompleted = () => saveCompleted.resolve()
    const service = new LifecycleService(database, adapter, new EventHub(), 25, coordinator)

    const result = await service.execute('save', 'save:fixture:detached-timeout', 'Administrator')

    expect(result.job).toMatchObject({ state: 'failed', errorCode: 'LIFECYCLE_PHASE_TIMEOUT' })
    expect(result.run.recoveryRequired).toBe(true)
    expect(coordinator.dispositions).toEqual(['abandon'])
    expect(adapter.phaseSignals.at(-1)?.aborted).toBe(true)

    saveGate.resolve()
    await saveCompleted.promise
    const afterLateReturn = service.get(result.job.id)
    expect(afterLateReturn?.job).toMatchObject({ state: 'failed', errorCode: 'LIFECYCLE_PHASE_TIMEOUT' })
    expect(afterLateReturn?.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'save', state: 'failed', errorCode: 'LIFECYCLE_PHASE_TIMEOUT' })
    ]))
    database.close()
  })

  it('times out a save phase, aborts the adapter signal, and requires reconciliation', async () => {
    const database = new ControlDatabase('unused', true)
    const adapter = new FakeLifecycleAdapter()
    adapter.hangSaveUntilAbort = true
    const service = new LifecycleService(database, adapter, new EventHub(), 25)

    const result = await service.execute('save', 'save:fixture:timeout-0001', 'Administrator')
    expect(result.job).toMatchObject({ state: 'failed', errorCode: 'LIFECYCLE_PHASE_TIMEOUT' })
    expect(result.run).toMatchObject({ state: 'failed', recoveryRequired: true })
    expect(result.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'save', state: 'failed', errorCode: 'LIFECYCLE_PHASE_TIMEOUT' })
    ]))
    expect(adapter.saveAbortObserved).toBe(true)
    database.close()
  })

  it('propagates and observes the caller cancellation signal across a public preview', async () => {
    const database = new ControlDatabase('unused', true)
    const adapter = new FakeLifecycleAdapter()
    const previewStarted = deferred<void>()
    adapter.previewGate = new Promise<never>(() => undefined)
    adapter.onPreviewStarted = () => previewStarted.resolve()
    const service = new LifecycleService(database, adapter, new EventHub(), 1_000)
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')

    const pending = service.preview('save', controller.signal)
    await previewStarted.promise
    controller.abort('fixture-http-disconnect')

    await expect(pending).rejects.toThrow('LIFECYCLE_PREVIEW_ABORTED')
    expect(adapter.previewSignals).toEqual([controller.signal])
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    database.close()
  })
})

class FakeLifecycleAdapter implements LifecycleMutationAdapter {
  mutationEnabled = true
  readonly calls: string[] = []
  readonly phaseSignals: AbortSignal[] = []
  readonly previewSignals: AbortSignal[] = []
  readonly phaseLeaseArguments: Array<readonly string[] | null> = []
  previewLeaseArguments: readonly string[] | null = null
  previewGate: Promise<never> | null = null
  onPreviewStarted: (() => void) | null = null
  saveGate: Promise<void> | null = null
  onSaveStarted: (() => void) | null = null
  onSaveCompleted: (() => void) | null = null
  onStopStarted: (() => void) | null = null
  failFirstRunningVerification = false
  hangSaveUntilAbort = false
  hangStopUntilAbort = false
  saveAbortObserved = false
  stopAbortObserved = false
  #runningVerificationCount = 0

  async previewLifecycle(action: LifecycleAction, context: LifecyclePreviewContext): Promise<LifecyclePreview> {
    this.calls.push(`preflight:${action}`)
    if (context.signal) this.previewSignals.push(context.signal)
    context.hostMutation?.assertActive()
    this.previewLeaseArguments = context.hostMutation?.toPowerShellBorrowArguments() ?? null
    this.onPreviewStarted?.()
    if (this.previewGate) await this.previewGate
    return allowedPreview(action)
  }

  async createProtectionPoint(context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    this.calls.push('protection-point')
    this.#recordContext(context)
    return {
      summary: 'paired backup verified',
      protectionPointId: 'backup:fixture-0001',
      evidence: { manifestVerified: true }
    }
  }

  async requestSave(context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    this.calls.push('save')
    this.#recordContext(context)
    this.onSaveStarted?.()
    if (this.hangSaveUntilAbort) {
      await new Promise<void>((_resolve, reject) => {
        const onAbort = () => {
          this.saveAbortObserved = true
          reject(new LifecycleExecutionError('TEST_ABORTED'))
        }
        if (context.signal.aborted) onAbort()
        else context.signal.addEventListener('abort', onAbort, { once: true })
      })
    }
    if (this.saveGate) await this.saveGate
    this.onSaveCompleted?.()
    return { summary: 'signed save receipt verified', evidence: { pairStable: true } }
  }

  async requestGracefulStop(context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    this.calls.push('stop')
    this.#recordContext(context)
    this.onStopStarted?.()
    if (this.hangStopUntilAbort) {
      await new Promise<void>((_resolve, reject) => {
        const onAbort = () => {
          this.stopAbortObserved = true
          reject(new LifecycleExecutionError('TEST_ABORTED'))
        }
        if (context.signal.aborted) onAbort()
        else context.signal.addEventListener('abort', onAbort, { once: true })
      })
    }
    return { summary: 'graceful stop receipt verified' }
  }

  async verifyStopped(context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    this.calls.push('verify-stopped')
    this.#recordContext(context)
    return { summary: 'managed process is stopped', evidence: { stopped: true } }
  }

  async requestStart(context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    this.calls.push('start')
    this.#recordContext(context)
    return { summary: 'start task receipt verified' }
  }

  async verifyRunning(context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    this.calls.push('verify-running')
    this.#recordContext(context)
    this.#runningVerificationCount += 1
    if (this.failFirstRunningVerification && this.#runningVerificationCount === 1) {
      throw new LifecycleExecutionError('TEST_VERIFY_FAILED')
    }
    return { summary: 'managed process and game health verified', evidence: { healthy: true } }
  }

  async requestRollbackStart(context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    this.calls.push('rollback-start')
    this.#recordContext(context)
    return { summary: 'previous runtime restarted' }
  }

  #recordContext(context: LifecycleOperationContext): void {
    this.phaseSignals.push(context.signal)
    context.hostMutation?.assertActive()
    this.phaseLeaseArguments.push(context.hostMutation?.toPowerShellBorrowArguments() ?? null)
  }
}

class FakeLifecycleCoordinator implements LifecycleMutationCoordinator {
  readonly requests: LifecycleCoordinatorRequest[] = []
  readonly dispositions: Array<LifecycleCoordinatorOutcome<unknown>['disposition']> = []
  readonly scopeSignals: AbortSignal[] = []
  acquireCount = 0
  acquireError: unknown = null
  #controller: AbortController | null = null

  abort(): void {
    this.#controller?.abort()
  }

  async runExclusive<T>(
    request: LifecycleCoordinatorRequest,
    operation: (
      scope: LifecycleCoordinatorScope
    ) => Promise<LifecycleCoordinatorOutcome<T>> | LifecycleCoordinatorOutcome<T>
  ): Promise<T> {
    this.acquireCount++
    this.requests.push(request)
    if (this.acquireError) throw this.acquireError
    const controller = new AbortController()
    this.#controller = controller
    this.scopeSignals.push(controller.signal)
    try {
      const outcome = await operation({
        signal: controller.signal,
        assertActive: () => {
          if (controller.signal.aborted) {
            throw new LifecycleCoordinatorError('LIFECYCLE_HOST_LEASE_UNAVAILABLE')
          }
        },
        toPowerShellBorrowArguments: () => [
          '-DataRoot', 'C:\\fixture\\data',
          '-LeaseInstanceId', '00000000-0000-4000-8000-000000000302',
          '-LeaseToken', 'B'.repeat(43)
        ]
      })
      this.dispositions.push(outcome.disposition)
      return outcome.value
    } finally {
      if (!controller.signal.aborted) controller.abort()
      if (this.#controller === controller) this.#controller = null
    }
  }
}

function allowedPreview(action: LifecycleAction): LifecyclePreview {
  return {
    collectedAt: new Date().toISOString(),
    action,
    mode: 'dry-run',
    allowed: true,
    executionEnabled: true,
    checks: [{ id: 'execution-lock', status: 'pass', message: 'fixture lock is available' }],
    blockers: [],
    rollback: action === 'start'
      ? { strategy: 'no-op', ready: true, summary: 'fixture start rollback requires no file mutation' }
      : { strategy: 'paired-save-backup', ready: true, summary: 'fixture rollback is ready' }
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve })
  return { promise, resolve: resolvePromise }
}

it('allows a longer startup verification without extending save timeouts', async () => {
  const database = new ControlDatabase('unused', true)
  try {
    const adapter = new FakeLifecycleAdapter()
    const original = adapter.verifyRunning.bind(adapter)
    vi.spyOn(adapter,'verifyRunning').mockImplementation(async context => {
      await new Promise(resolve=>setTimeout(resolve,80))
      return original(context)
    })
    const service = new LifecycleService(database,adapter,new EventHub(),30,undefined,250)
    const start = await service.execute('start','startup:separate:0001','Administrator')
    expect(start.job.state).toBe('succeeded')
    adapter.hangSaveUntilAbort = true
    const save = await service.execute('save','startup:separate:0002','Administrator')
    expect(save.job.state).toBe('failed')
    expect(save.job.errorCode).toBe('LIFECYCLE_PHASE_TIMEOUT')
    expect(adapter.saveAbortObserved).toBe(true)
  } finally { database.close() }
})

it('aborts startup verification at its own bounded deadline', async () => {
  const database = new ControlDatabase('unused', true)
  try {
    const adapter = new FakeLifecycleAdapter()
    let aborted = false
    vi.spyOn(adapter,'verifyRunning').mockImplementation(context => new Promise((_resolve,reject) => {
      context.signal.addEventListener('abort',()=>{aborted=true;reject(new LifecycleExecutionError('FIXTURE_ABORTED'))},{once:true})
    }))
    const service = new LifecycleService(database,adapter,new EventHub(),1000,undefined,25)
    const result = await service.execute('start','startup:bounded:0001','Administrator')
    expect(result.job).toMatchObject({state:'failed',errorCode:'LIFECYCLE_PHASE_TIMEOUT'})
    expect(result.run.recoveryRequired).toBe(true)
    expect(aborted).toBe(true)
  } finally { database.close() }
})
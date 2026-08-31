import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type {
  LifecycleAction,
  LifecycleMutationAdapter,
  LifecycleOperationContext,
  LifecyclePhaseResult,
  LifecyclePreview
} from '../domain.js'
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
})

class FakeLifecycleAdapter implements LifecycleMutationAdapter {
  mutationEnabled = true
  readonly calls: string[] = []
  saveGate: Promise<void> | null = null
  onSaveStarted: (() => void) | null = null
  failFirstRunningVerification = false
  hangSaveUntilAbort = false
  saveAbortObserved = false
  #runningVerificationCount = 0

  async previewLifecycle(action: LifecycleAction): Promise<LifecyclePreview> {
    this.calls.push(`preflight:${action}`)
    return allowedPreview(action)
  }

  async createProtectionPoint(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    this.calls.push('protection-point')
    return {
      summary: 'paired backup verified',
      protectionPointId: 'backup:fixture-0001',
      evidence: { manifestVerified: true }
    }
  }

  async requestSave(context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    this.calls.push('save')
    this.onSaveStarted?.()
    if (this.hangSaveUntilAbort) {
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener('abort', () => {
          this.saveAbortObserved = true
          reject(new LifecycleExecutionError('TEST_ABORTED'))
        }, { once: true })
      })
    }
    if (this.saveGate) await this.saveGate
    return { summary: 'signed save receipt verified', evidence: { pairStable: true } }
  }

  async requestGracefulStop(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    this.calls.push('stop')
    return { summary: 'graceful stop receipt verified' }
  }

  async verifyStopped(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    this.calls.push('verify-stopped')
    return { summary: 'managed process is stopped', evidence: { stopped: true } }
  }

  async requestStart(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    this.calls.push('start')
    return { summary: 'start task receipt verified' }
  }

  async verifyRunning(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    this.calls.push('verify-running')
    this.#runningVerificationCount += 1
    if (this.failFirstRunningVerification && this.#runningVerificationCount === 1) {
      throw new LifecycleExecutionError('TEST_VERIFY_FAILED')
    }
    return { summary: 'managed process and game health verified', evidence: { healthy: true } }
  }

  async requestRollbackStart(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    this.calls.push('rollback-start')
    return { summary: 'previous runtime restarted' }
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

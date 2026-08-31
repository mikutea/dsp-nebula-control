import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PersistedSaveJobRequest } from '../saves/job-types.js'
import type {
  BackupSavePairRequest,
  RestoreSavePairRequest,
  SaveTransactionResult
} from '../saves/transactions.js'
import { ControlDatabase } from '../storage/database.js'
import { EventHub } from './event-hub.js'
import {
  SaveJobService,
  type SaveTransactionExecutor
} from './save-job-service.js'

const backupKey = '11111111-1111-4111-8111-111111111111'
const secondBackupKey = '22222222-2222-4222-8222-222222222222'
const restoreKey = '33333333-3333-4333-8333-333333333333'
const protectionKey = '44444444-4444-4444-8444-444444444444'
const sourceBackupId = 'tx-55555555-5555-4555-8555-555555555555'
const expectedRevision = `pair-v1:${'a'.repeat(64)}`

describe('durable paired-save job service', () => {
  it('returns queued immediately, serializes concurrent jobs, and reuses the same UUID exactly once', async () => {
    const database = new ControlDatabase('unused', true)
    let active = 0
    let maximumActive = 0
    const firstGate = deferred<void>()
    const firstStarted = deferred<void>()
    const executor = new ScriptedExecutor(async (operation, input) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      try {
        if (input.requestId === backupKey) {
          firstStarted.resolve()
          await firstGate.promise
        }
        return transactionResult(operation, input)
      } finally {
        active -= 1
      }
    })
    const service = new SaveJobService(database, executor, new EventHub())

    const first = service.enqueue({ operation: 'backup', idempotencyKey: backupKey, saveName: '_lastexit_' }, 'Administrator')
    const duplicate = service.enqueue({ operation: 'backup', idempotencyKey: backupKey, saveName: '_lastexit_' }, 'Administrator')
    const second = service.enqueue({ operation: 'backup', idempotencyKey: secondBackupKey, saveName: 'factory' }, 'Administrator')
    expect(first).toMatchObject({ reused: false, job: { state: 'queued', kind: 'save.backup' } })
    expect(duplicate).toMatchObject({ reused: true, job: { id: first.job.id } })
    expect(second.job.id).not.toBe(first.job.id)

    await firstStarted.promise
    expect(executor.calls).toHaveLength(1)
    expect(service.get(first.job.id)).toMatchObject({
      job: { state: 'running' }, run: { state: 'running', attemptCount: 1 }
    })
    firstGate.resolve()
    await service.close()

    expect(maximumActive).toBe(1)
    expect(executor.calls.map((call) => call.input.requestId)).toEqual([backupKey, secondBackupKey])
    expect(service.get(first.job.id)).toMatchObject({
      job: { state: 'succeeded', errorCode: null },
      run: { state: 'succeeded', attemptCount: 1, recoveryRequired: false }
    })
    expect(() => service.enqueue(
      { operation: 'backup', idempotencyKey: backupKey, saveName: '_lastexit_' },
      'Administrator'
    )).toThrowError(expect.objectContaining({ code: 'SAVE_JOB_SERVICE_CLOSED' }))

    const restartExecutor = new ScriptedExecutor(async (operation, input) => transactionResult(operation, input))
    const restartedService = new SaveJobService(database, restartExecutor, new EventHub())
    const durableDuplicate = restartedService.enqueue(
      { operation: 'backup', idempotencyKey: backupKey, saveName: '_lastexit_' },
      'Administrator'
    )
    expect(durableDuplicate).toMatchObject({
      reused: true, job: { id: first.job.id, state: 'succeeded' }, run: { state: 'succeeded' }
    })
    await restartedService.close()
    expect(restartExecutor.calls).toEqual([])
    database.close()
  })

  it('rejects unknown request fields and an idempotency UUID reused for different logical input', async () => {
    const database = new ControlDatabase('unused', true)
    const gate = deferred<void>()
    const executor = new ScriptedExecutor(async (operation, input) => {
      await gate.promise
      return transactionResult(operation, input)
    })
    const service = new SaveJobService(database, executor, new EventHub())
    service.enqueue({ operation: 'backup', idempotencyKey: backupKey, saveName: '_lastexit_' }, 'Administrator')

    expect(() => service.enqueue(
      { operation: 'backup', idempotencyKey: backupKey, saveName: 'other' },
      'Administrator'
    )).toThrowError(expect.objectContaining({ code: 'SAVE_JOB_IDEMPOTENCY_CONFLICT' }))
    expect(() => service.enqueue({
      operation: 'backup', idempotencyKey: secondBackupKey, saveName: '_lastexit_',
      path: 'C:\\Fictional\\save.dsv', command: 'arbitrary', secret: 'should-never-persist'
    } as never, 'Administrator')).toThrowError(expect.objectContaining({ code: 'SAVE_JOB_REQUEST_INVALID' }))

    gate.resolve()
    await service.close()
    database.close()
  })

  it('persists exact restore logic input but omits revision/hash/path/secret data from query results', async () => {
    const database = new ControlDatabase('unused', true)
    const executor = new ScriptedExecutor(async (operation, input) => transactionResult(operation, input))
    const service = new SaveJobService(database, executor, new EventHub())
    const queued = service.enqueue({
      operation: 'restore',
      idempotencyKey: restoreKey,
      backupId: sourceBackupId,
      expectedRevision,
      protectionRequestId: protectionKey
    }, 'Administrator')
    await service.close()

    expect(executor.calls).toEqual([{
      operation: 'restore',
      input: {
        requestId: restoreKey,
        backupId: sourceBackupId,
        expectedRevision,
        protectionRequestId: protectionKey,
        dryRun: false
      }
    }])
    const result = service.get(queued.job.id)
    expect(result).toMatchObject({
      job: { kind: 'save.restore', state: 'succeeded' },
      run: {
        operation: 'restore', state: 'succeeded', errorCode: null,
        result: { backupId: sourceBackupId, protectionBackupId: `tx-${protectionKey}` }
      }
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(expectedRevision)
    expect(serialized).not.toMatch(/beforeRevision|afterRevision|expectedRevision|password|secret|path|root|sha256/i)
    database.close()
  })

  it('replays a file-backed queued job after database reopen', async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), 'dyson-save-job-queued-'))
    let database: ControlDatabase | null = new ControlDatabase(dataDirectory)
    try {
      const created = database.createSaveJob(
        persistedBackup(backupKey, '_lastexit_'), 'Administrator', 'queued fixture'
      )
      database.close()
      database = null

      database = new ControlDatabase(dataDirectory)
      const executor = new ScriptedExecutor(async (operation, input) => transactionResult(operation, input))
      const service = new SaveJobService(database, executor, new EventHub())
      expect(service.initialize()).toBe(1)
      await service.close()

      expect(executor.calls).toHaveLength(1)
      expect(service.get(created.job.id)).toMatchObject({
        job: { state: 'succeeded' },
        run: { state: 'succeeded', attemptCount: 1, recoveryRequired: false }
      })
    } finally {
      database?.close()
      await rm(dataDirectory, { recursive: true, force: true })
    }
  })

  it('idempotently reconciles a previously running job when the durable transaction result is provable', async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), 'dyson-save-job-running-'))
    let database: ControlDatabase | null = new ControlDatabase(dataDirectory)
    try {
      const created = database.createSaveJob(
        persistedBackup(backupKey, '_lastexit_'), 'Administrator', 'queued fixture'
      )
      database.markSaveRunRunning(created.job.id, 'running fixture')
      database.close()
      database = null

      database = new ControlDatabase(dataDirectory)
      const executor = new ScriptedExecutor(async (operation, input) => transactionResult(operation, input, {
        reused: true
      }))
      const service = new SaveJobService(database, executor, new EventHub())
      expect(service.initialize()).toBe(1)
      await service.close()

      expect(executor.calls).toHaveLength(1)
      expect(service.get(created.job.id)).toMatchObject({
        job: { state: 'succeeded', errorCode: null },
        run: {
          state: 'succeeded', attemptCount: 2, recoveryRequired: false,
          result: { reused: true, auditStored: true }
        }
      })
    } finally {
      database?.close()
      await rm(dataDirectory, { recursive: true, force: true })
    }
  })

  it('fails closed as interrupted when a running-job replay cannot prove a terminal result', async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), 'dyson-save-job-uncertain-'))
    let database: ControlDatabase | null = new ControlDatabase(dataDirectory)
    try {
      const created = database.createSaveJob(
        persistedBackup(backupKey, '_lastexit_'), 'Administrator', 'queued fixture'
      )
      database.markSaveRunRunning(created.job.id, 'running fixture')
      database.close()
      database = null

      database = new ControlDatabase(dataDirectory)
      const executor = new ScriptedExecutor(async (operation, input) => transactionResult(operation, input, {
        status: 'busy',
        errorCode: 'SAVE_TRANSACTION_BUSY',
        auditStored: false
      }))
      const service = new SaveJobService(database, executor, new EventHub())
      expect(service.initialize()).toBe(1)
      await service.close()

      expect(service.get(created.job.id)).toMatchObject({
        job: { state: 'failed', errorCode: 'SAVE_JOB_RECONCILIATION_UNCERTAIN' },
        run: {
          state: 'interrupted', recoveryRequired: true,
          errorCode: 'SAVE_JOB_RECONCILIATION_UNCERTAIN'
        }
      })
    } finally {
      database?.close()
      await rm(dataDirectory, { recursive: true, force: true })
    }
  })

  it('records deterministic transaction failure and marks missing audit or executor exceptions interrupted', async () => {
    const database = new ControlDatabase('unused', true)
    const executor = new ScriptedExecutor(async (operation, input) => {
      if (input.requestId === backupKey) return transactionResult(operation, input, {
        status: 'rejected', errorCode: 'SAVE_PAIR_INCOMPLETE'
      })
      if (input.requestId === secondBackupKey) return transactionResult(operation, input, {
        auditStored: false
      })
      throw new Error('fixture executor failure')
    })
    const service = new SaveJobService(database, executor, new EventHub())
    const rejected = service.enqueue({
      operation: 'backup', idempotencyKey: backupKey, saveName: '_lastexit_'
    }, 'Administrator')
    const missingAudit = service.enqueue({
      operation: 'backup', idempotencyKey: secondBackupKey, saveName: 'factory'
    }, 'Administrator')
    const thrown = service.enqueue({
      operation: 'restore', idempotencyKey: restoreKey, backupId: sourceBackupId,
      expectedRevision, protectionRequestId: protectionKey
    }, 'Administrator')
    await service.close()

    expect(service.get(rejected.job.id)).toMatchObject({
      job: { state: 'failed', errorCode: 'SAVE_PAIR_INCOMPLETE' },
      run: { state: 'failed', recoveryRequired: false }
    })
    expect(service.get(missingAudit.job.id)).toMatchObject({
      job: { state: 'failed', errorCode: 'SAVE_JOB_AUDIT_MISSING' },
      run: { state: 'interrupted', recoveryRequired: true }
    })
    expect(service.get(thrown.job.id)).toMatchObject({
      job: { state: 'failed', errorCode: 'SAVE_JOB_EXECUTOR_FAILED' },
      run: { state: 'interrupted', recoveryRequired: true }
    })
    const databaseText = JSON.stringify(database.listJobs(20))
    expect(databaseText).not.toMatch(/Fictional|pair-v1|password|secret|sha256|[A-Z]:\\/i)
    database.close()
  })

  it('drains an in-flight mutation on close instead of cancelling it', async () => {
    const database = new ControlDatabase('unused', true)
    const started = deferred<void>()
    const gate = deferred<void>()
    const executor = new ScriptedExecutor(async (operation, input) => {
      started.resolve()
      await gate.promise
      return transactionResult(operation, input)
    })
    const service = new SaveJobService(database, executor, new EventHub())
    const queued = service.enqueue({
      operation: 'backup', idempotencyKey: backupKey, saveName: '_lastexit_'
    }, 'Administrator')
    await started.promise

    let closed = false
    const closing = service.close().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    gate.resolve()
    await closing
    expect(service.get(queued.job.id)?.run.state).toBe('succeeded')
    database.close()
  })
})

type ExecutorInput = BackupSavePairRequest | RestoreSavePairRequest

class ScriptedExecutor implements SaveTransactionExecutor {
  readonly calls: Array<{ operation: 'backup' | 'restore'; input: ExecutorInput }> = []

  constructor(
    private readonly handler: (
      operation: 'backup' | 'restore', input: ExecutorInput
    ) => Promise<SaveTransactionResult>
  ) {}

  backup(input: BackupSavePairRequest): Promise<SaveTransactionResult> {
    return this.run('backup', input)
  }

  restore(input: RestoreSavePairRequest): Promise<SaveTransactionResult> {
    return this.run('restore', input)
  }

  private run(operation: 'backup' | 'restore', input: ExecutorInput): Promise<SaveTransactionResult> {
    this.calls.push({ operation, input })
    return this.handler(operation, input)
  }
}

function transactionResult(
  operation: 'backup' | 'restore',
  input: ExecutorInput,
  overrides: Partial<SaveTransactionResult> = {}
): SaveTransactionResult {
  const backupId = operation === 'backup'
    ? `tx-${input.requestId}`
    : (input as RestoreSavePairRequest).backupId
  const protectionBackupId = operation === 'restore'
    ? `tx-${(input as RestoreSavePairRequest).protectionRequestId}`
    : undefined
  const startedAt = '2026-08-30T00:00:00.000Z'
  const finishedAt = '2026-08-30T00:00:01.000Z'
  const status = overrides.status ?? 'succeeded'
  const rollback = overrides.rollback ?? 'not-required'
  const errorCode = overrides.errorCode
  return {
    schemaVersion: 1,
    requestId: input.requestId,
    operation,
    status,
    dryRun: false,
    backupId,
    ...(protectionBackupId === undefined ? {} : { protectionBackupId }),
    reused: false,
    rollback,
    pairBytes: 2048,
    ...(errorCode === undefined ? {} : { errorCode }),
    auditStored: true,
    audit: {
      schemaVersion: 1,
      requestId: input.requestId,
      action: operation === 'backup' ? 'save.backup' : 'save.restore',
      status,
      dryRun: false,
      backupId,
      ...(protectionBackupId === undefined ? {} : { protectionBackupId }),
      reused: false,
      rollback,
      startedAt,
      finishedAt,
      ...(errorCode === undefined ? {} : { errorCode })
    },
    ...overrides
  }
}

function persistedBackup(idempotencyKey: string, saveName: string): PersistedSaveJobRequest {
  return {
    operation: 'backup', idempotencyKey, saveName,
    backupId: null, expectedRevision: null, protectionRequestId: null
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

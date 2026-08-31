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

  it('fails closed instead of automatically replaying a previously running job after restart', async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), 'dyson-save-job-running-'))
    let database: ControlDatabase | null = new ControlDatabase(dataDirectory)
    try {
      const created = database.createSaveJob(
        persistedBackup(backupKey, '_lastexit_'), 'Administrator', 'queued fixture'
      )
      claimRunningFixture(database, created.job.id)
      database.close()
      database = null

      database = new ControlDatabase(dataDirectory)
      const executor = new ScriptedExecutor(async (operation, input) => transactionResult(operation, input, {
        reused: true
      }))
      const service = new SaveJobService(database, executor, new EventHub())
      expect(service.initialize()).toBe(1)
      await service.close()

      expect(executor.calls).toHaveLength(0)
      expect(service.get(created.job.id)).toMatchObject({
        job: { state: 'failed', errorCode: 'SAVE_JOB_RECONCILIATION_UNCERTAIN' },
        run: {
          state: 'interrupted', attemptCount: 1, recoveryRequired: true,
          errorCode: 'SAVE_JOB_RECONCILIATION_UNCERTAIN', result: null
        }
      })
    } finally {
      database?.close()
      await rm(dataDirectory, { recursive: true, force: true })
    }
  })

  it('lets only one initializing instance interrupt an unowned running attempt and invokes no executor', async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), 'dyson-save-job-running-multi-instance-'))
    let seed: ControlDatabase | null = new ControlDatabase(dataDirectory)
    let firstDatabase: ControlDatabase | null = null
    let secondDatabase: ControlDatabase | null = null
    try {
      const created = seed.createSaveJob(persistedRestore(), 'Administrator', 'queued fixture')
      claimRunningFixture(seed, created.job.id)
      seed.close()
      seed = null

      firstDatabase = new ControlDatabase(dataDirectory)
      secondDatabase = new ControlDatabase(dataDirectory)
      const firstExecutor = new ScriptedExecutor(async (operation, input) => transactionResult(operation, input))
      const secondExecutor = new ScriptedExecutor(async (operation, input) => transactionResult(operation, input))
      const firstService = new SaveJobService(firstDatabase, firstExecutor, new EventHub())
      const secondService = new SaveJobService(secondDatabase, secondExecutor, new EventHub())

      expect(firstService.initialize()).toBe(1)
      expect(secondService.initialize()).toBe(0)
      await firstService.close()
      await secondService.close()

      expect(firstExecutor.calls).toHaveLength(0)
      expect(secondExecutor.calls).toHaveLength(0)
      expect(secondService.get(created.job.id)).toMatchObject({
        job: { state: 'failed', errorCode: 'SAVE_JOB_RECONCILIATION_UNCERTAIN' },
        run: {
          state: 'interrupted', attemptCount: 1, recoveryRequired: true,
          errorCode: 'SAVE_JOB_RECONCILIATION_UNCERTAIN'
        }
      })
    } finally {
      seed?.close()
      firstDatabase?.close()
      secondDatabase?.close()
      await rm(dataDirectory, { recursive: true, force: true })
    }
  })

  it('does not invoke even a rollback-proving executor for an unowned running attempt', async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), 'dyson-save-job-rolled-back-'))
    let database: ControlDatabase | null = new ControlDatabase(dataDirectory)
    try {
      const created = database.createSaveJob(persistedRestore(), 'Administrator', 'queued fixture')
      claimRunningFixture(database, created.job.id)
      database.close()
      database = null

      database = new ControlDatabase(dataDirectory)
      const executor = new ScriptedExecutor(async (operation, input) => transactionResult(operation, input, {
        status: 'rolled-back',
        rollback: 'succeeded',
        errorCode: 'SAVE_COMMIT_FAILED',
        auditStored: true
      }))
      const service = new SaveJobService(database, executor, new EventHub())
      expect(service.initialize()).toBe(1)
      await service.close()

      expect(executor.calls).toHaveLength(0)
      expect(service.get(created.job.id)).toMatchObject({
        job: { state: 'failed', errorCode: 'SAVE_JOB_RECONCILIATION_UNCERTAIN' },
        run: {
          state: 'interrupted', attemptCount: 1, recoveryRequired: true,
          errorCode: 'SAVE_JOB_RECONCILIATION_UNCERTAIN', result: null
        }
      })
    } finally {
      database?.close()
      await rm(dataDirectory, { recursive: true, force: true })
    }
  })

  it('surfaces a committed restore with cleanup pending as maintenance-required in normal and restart execution', async () => {
    const committedPending = async (operation: 'backup' | 'restore', input: ExecutorInput) =>
      transactionResult(operation, input, {
        status: 'succeeded',
        rollback: 'not-required',
        cleanupPending: true,
        maintenanceRequired: true,
        errorCode: 'SAVE_COMMIT_CLEANUP_PENDING',
        auditStored: true
      })
    const memoryDatabase = new ControlDatabase('unused', true)
    const normalService = new SaveJobService(
      memoryDatabase,
      new ScriptedExecutor(committedPending),
      new EventHub()
    )
    const normal = normalService.enqueue({
      operation: 'restore', idempotencyKey: restoreKey, backupId: sourceBackupId,
      expectedRevision, protectionRequestId: protectionKey
    }, 'Administrator')
    await normalService.close()
    expect(normalService.get(normal.job.id)).toMatchObject({
      job: { state: 'failed', errorCode: 'SAVE_COMMIT_CLEANUP_PENDING' },
      run: {
        state: 'interrupted', recoveryRequired: true,
        errorCode: 'SAVE_COMMIT_CLEANUP_PENDING',
        result: { status: 'succeeded', rollback: 'not-required', auditStored: true }
      }
    })
    memoryDatabase.close()

    const missingAuditDatabase = new ControlDatabase('unused', true)
    const missingAuditService = new SaveJobService(
      missingAuditDatabase,
      new ScriptedExecutor(async (operation, input) => transactionResult(operation, input, {
        status: 'succeeded', rollback: 'not-required', cleanupPending: true,
        maintenanceRequired: true, errorCode: 'SAVE_COMMIT_CLEANUP_PENDING', auditStored: false
      })),
      new EventHub()
    )
    const missingAudit = missingAuditService.enqueue({
      operation: 'restore', idempotencyKey: restoreKey, backupId: sourceBackupId,
      expectedRevision, protectionRequestId: protectionKey
    }, 'Administrator')
    await missingAuditService.close()
    expect(missingAuditService.get(missingAudit.job.id)).toMatchObject({
      job: { state: 'failed', errorCode: 'SAVE_JOB_AUDIT_MISSING' },
      run: { state: 'interrupted', recoveryRequired: true, errorCode: 'SAVE_JOB_AUDIT_MISSING' }
    })
    missingAuditDatabase.close()

    const dataDirectory = await mkdtemp(path.join(tmpdir(), 'dyson-save-job-committed-cleanup-pending-'))
    let database: ControlDatabase | null = new ControlDatabase(dataDirectory)
    try {
      const created = database.createSaveJob(persistedRestore(), 'Administrator', 'queued fixture')
      claimRunningFixture(database, created.job.id)
      database.close()
      database = null
      database = new ControlDatabase(dataDirectory)
      const restarted = new SaveJobService(database, new ScriptedExecutor(committedPending), new EventHub())
      expect(restarted.initialize()).toBe(1)
      await restarted.close()
      expect(restarted.get(created.job.id)).toMatchObject({
        job: { state: 'failed', errorCode: 'SAVE_JOB_RECONCILIATION_UNCERTAIN' },
        run: {
          state: 'interrupted', recoveryRequired: true,
          errorCode: 'SAVE_JOB_RECONCILIATION_UNCERTAIN', result: null
        }
      })
    } finally {
      database?.close()
      await rm(dataDirectory, { recursive: true, force: true })
    }
  })

  it('requires explicit reconciliation, reuses concurrent requests, and replays only the durable original restore', async () => {
    const database = new ControlDatabase('unused', true)
    let attempt = 0
    const executor = new ScriptedExecutor(async (operation, input) => {
      attempt += 1
      return transactionResult(operation, input, attempt === 1
        ? {
            status: 'succeeded', rollback: 'not-required',
            cleanupPending: true, maintenanceRequired: true,
            errorCode: 'SAVE_COMMIT_CLEANUP_PENDING', auditStored: true
          }
        : {})
    })
    const service = new SaveJobService(database, executor, new EventHub())
    const queued = service.enqueue({
      operation: 'restore', idempotencyKey: restoreKey, backupId: sourceBackupId,
      expectedRevision, protectionRequestId: protectionKey
    }, 'Administrator')
    await waitForTerminal(service, queued.job.id)

    expect(service.get(queued.job.id)).toMatchObject({
      job: { state: 'failed', errorCode: 'SAVE_COMMIT_CLEANUP_PENDING' },
      run: {
        state: 'interrupted', attemptCount: 1, recoveryRequired: true,
        result: { cleanupPending: true, maintenanceRequired: true }
      }
    })
    const ordinaryDuplicate = service.enqueue({
      operation: 'restore', idempotencyKey: restoreKey, backupId: sourceBackupId,
      expectedRevision, protectionRequestId: protectionKey
    }, 'Administrator')
    expect(ordinaryDuplicate).toMatchObject({ reused: true, run: { state: 'interrupted' } })
    expect(executor.calls).toHaveLength(1)

    const firstReconcile = service.reconcile(queued.job.id, 'Administrator')
    const concurrentReconcile = service.reconcile(queued.job.id, 'Administrator')
    expect(firstReconcile).toMatchObject({ reused: false, run: { state: 'queued', recoveryRequired: true } })
    expect(concurrentReconcile).toMatchObject({ reused: true, job: { id: queued.job.id } })
    expect(database.getLatestSaveReconciliationReason(queued.job.id)).toBe('committed-cleanup')
    await waitForTerminal(service, queued.job.id)
    await service.close()

    expect(executor.calls).toHaveLength(2)
    expect(executor.calls[1]).toEqual(executor.calls[0])
    expect(service.get(queued.job.id)).toMatchObject({
      job: { state: 'succeeded', errorCode: null },
      run: {
        state: 'succeeded', attemptCount: 2, recoveryRequired: false,
        result: { cleanupPending: false, maintenanceRequired: false, auditStored: true }
      }
    })
    database.close()
  })

  it('lets only the instance that durably authorizes reconciliation schedule the executor', async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), 'dyson-save-job-multi-instance-reconcile-'))
    let seed: ControlDatabase | null = new ControlDatabase(dataDirectory)
    let firstDatabase: ControlDatabase | null = null
    let secondDatabase: ControlDatabase | null = null
    try {
      const created = seed.createSaveJob(persistedRestore(), 'Administrator', 'queued fixture')
      claimRunningFixture(seed, created.job.id)
      seed.completeSaveRun(created.job.id, 'interrupted', 'cleanup pending fixture',
        'SAVE_COMMIT_CLEANUP_PENDING', true, {
          status: 'succeeded', backupId: sourceBackupId,
          protectionBackupId: `tx-${protectionKey}`, pairBytes: 2048,
          rollback: 'not-required', reused: false, auditStored: true,
          cleanupPending: true, maintenanceRequired: true
        })
      seed.close()
      seed = null

      firstDatabase = new ControlDatabase(dataDirectory)
      secondDatabase = new ControlDatabase(dataDirectory)
      let executionCount = 0
      const firstStarted = deferred<void>()
      const firstGate = deferred<void>()
      const firstExecutor = new ScriptedExecutor(async (operation, input) => {
        executionCount += 1
        firstStarted.resolve()
        await firstGate.promise
        return transactionResult(operation, input, { reused: true })
      })
      const secondExecutor = new ScriptedExecutor(async (operation, input) => {
        executionCount += 1
        return transactionResult(operation, input, { reused: true })
      })
      const firstService = new SaveJobService(firstDatabase, firstExecutor, new EventHub())
      const secondService = new SaveJobService(secondDatabase, secondExecutor, new EventHub())
      expect(firstService.initialize()).toBe(0)
      expect(secondService.initialize()).toBe(0)

      const first = firstService.reconcile(created.job.id, 'Administrator')
      const second = secondService.reconcile(created.job.id, 'Administrator')
      expect(first).toMatchObject({ reused: false, run: { state: 'queued' } })
      expect(second).toMatchObject({ reused: true, job: { id: created.job.id } })
      await firstStarted.promise
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(firstExecutor.calls).toHaveLength(1)
      expect(secondExecutor.calls).toHaveLength(0)
      firstGate.resolve()
      await firstService.close()
      await secondService.close()

      expect(executionCount).toBe(1)
      expect(firstExecutor.calls).toHaveLength(1)
      expect(secondExecutor.calls).toHaveLength(0)
      expect(secondService.get(created.job.id)).toMatchObject({
        run: { state: 'succeeded', attemptCount: 2, recoveryRequired: false }
      })
    } finally {
      seed?.close()
      firstDatabase?.close()
      secondDatabase?.close()
      await rm(dataDirectory, { recursive: true, force: true })
    }
  })

  it('allows an explicit audit-only repair but refuses a rollback-failed recovery expansion', async () => {
    const auditDatabase = new ControlDatabase('unused', true)
    let auditAttempt = 0
    const auditExecutor = new ScriptedExecutor(async (operation, input) => {
      auditAttempt += 1
      return transactionResult(operation, input, auditAttempt === 1 ? { auditStored: false } : {})
    })
    const auditService = new SaveJobService(auditDatabase, auditExecutor, new EventHub())
    const auditJob = auditService.enqueue({
      operation: 'restore', idempotencyKey: restoreKey, backupId: sourceBackupId,
      expectedRevision, protectionRequestId: protectionKey
    }, 'Administrator')
    await waitForTerminal(auditService, auditJob.job.id)
    expect(auditService.get(auditJob.job.id)).toMatchObject({
      run: { state: 'interrupted', errorCode: 'SAVE_JOB_AUDIT_MISSING', recoveryRequired: true }
    })
    expect(auditService.reconcile(auditJob.job.id, 'Administrator')).toMatchObject({
      reused: false, run: { state: 'queued' }
    })
    await waitForTerminal(auditService, auditJob.job.id)
    await auditService.close()
    expect(auditExecutor.calls).toHaveLength(2)
    expect(auditDatabase.getLatestSaveReconciliationReason(auditJob.job.id)).toBe('audit-repair')
    expect(auditService.get(auditJob.job.id)).toMatchObject({
      run: { state: 'succeeded', attemptCount: 2, recoveryRequired: false }
    })
    auditDatabase.close()

    const unsafeDatabase = new ControlDatabase('unused', true)
    const unsafeExecutor = new ScriptedExecutor(async (operation, input) => transactionResult(operation, input, {
      status: 'rollback-failed', rollback: 'failed',
      errorCode: 'SAVE_ROLLBACK_FAILED', auditStored: true
    }))
    const unsafeService = new SaveJobService(unsafeDatabase, unsafeExecutor, new EventHub())
    const unsafeJob = unsafeService.enqueue({
      operation: 'restore', idempotencyKey: restoreKey, backupId: sourceBackupId,
      expectedRevision, protectionRequestId: protectionKey
    }, 'Administrator')
    await waitForTerminal(unsafeService, unsafeJob.job.id)
    expect(() => unsafeService.reconcile(unsafeJob.job.id, 'Administrator')).toThrowError(
      expect.objectContaining({ code: 'SAVE_JOB_RECONCILE_NOT_ALLOWED' })
    )
    await unsafeService.close()
    expect(unsafeExecutor.calls).toHaveLength(1)
    unsafeDatabase.close()
  })

  it('preserves a journal-maintenance terminal and never treats it as an ordinary retry', async () => {
    const database = new ControlDatabase('unused', true)
    const executor = new ScriptedExecutor(async (operation, input) => transactionResult(operation, input, {
      status: 'failed', rollback: 'not-required',
      errorCode: 'SAVE_JOURNAL_MAINTENANCE_REQUIRED',
      maintenanceRequired: true, cleanupPending: false, auditStored: false
    }))
    const service = new SaveJobService(database, executor, new EventHub())
    const queued = service.enqueue({
      operation: 'backup', idempotencyKey: backupKey, saveName: '_lastexit_'
    }, 'Administrator')
    await waitForTerminal(service, queued.job.id)

    expect(service.get(queued.job.id)).toMatchObject({
      job: { state: 'failed', errorCode: 'SAVE_JOURNAL_MAINTENANCE_REQUIRED' },
      run: {
        state: 'interrupted', recoveryRequired: true,
        result: { status: 'failed', maintenanceRequired: true, cleanupPending: false }
      }
    })
    expect(service.enqueue({
      operation: 'backup', idempotencyKey: backupKey, saveName: '_lastexit_'
    }, 'Administrator')).toMatchObject({ reused: true, run: { state: 'interrupted' } })
    expect(() => service.reconcile(queued.job.id, 'Administrator')).toThrowError(
      expect.objectContaining({ code: 'SAVE_JOB_RECONCILE_NOT_ALLOWED' })
    )
    await service.close()
    expect(executor.calls).toHaveLength(1)
    database.close()
  })

  it('resumes a durably authorized queued reconciliation exactly once after database reopen', async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), 'dyson-save-job-explicit-reconcile-'))
    let database: ControlDatabase | null = new ControlDatabase(dataDirectory)
    try {
      const created = database.createSaveJob(persistedRestore(), 'Administrator', 'queued fixture')
      claimRunningFixture(database, created.job.id)
      database.completeSaveRun(created.job.id, 'interrupted', 'cleanup pending fixture',
        'SAVE_COMMIT_CLEANUP_PENDING', true, {
          status: 'succeeded', backupId: sourceBackupId,
          protectionBackupId: `tx-${protectionKey}`, pairBytes: 2048,
          rollback: 'not-required', reused: false, auditStored: true,
          cleanupPending: true, maintenanceRequired: true
        })
      const terminal = database.getSaveRun(created.job.id)
      if (!terminal) throw new Error('fixture save run missing')
      database.requeueSaveRunForReconciliation(
        created.job.id, terminal.updatedAt, 'Administrator', 'committed-cleanup', 'queued reconciliation fixture'
      )
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
        run: {
          state: 'succeeded', attemptCount: 2, recoveryRequired: false,
          result: { reused: true, cleanupPending: false, maintenanceRequired: false }
        }
      })
    } finally {
      database?.close()
      await rm(dataDirectory, { recursive: true, force: true })
    }
  })

  it('keeps rollback-failed results interrupted and recovery-required in normal and restart execution', async () => {
    const rollbackFailed = async (operation: 'backup' | 'restore', input: ExecutorInput) =>
      transactionResult(operation, input, {
        status: 'rollback-failed',
        rollback: 'failed',
        errorCode: 'SAVE_ROLLBACK_FAILED',
        auditStored: true
      })
    const memoryDatabase = new ControlDatabase('unused', true)
    const normalService = new SaveJobService(
      memoryDatabase,
      new ScriptedExecutor(rollbackFailed),
      new EventHub()
    )
    const normal = normalService.enqueue({
      operation: 'restore', idempotencyKey: restoreKey, backupId: sourceBackupId,
      expectedRevision, protectionRequestId: protectionKey
    }, 'Administrator')
    await normalService.close()
    expect(normalService.get(normal.job.id)).toMatchObject({
      job: { state: 'failed', errorCode: 'SAVE_ROLLBACK_FAILED' },
      run: { state: 'interrupted', recoveryRequired: true, errorCode: 'SAVE_ROLLBACK_FAILED' }
    })
    memoryDatabase.close()

    const dataDirectory = await mkdtemp(path.join(tmpdir(), 'dyson-save-job-recovery-required-'))
    let database: ControlDatabase | null = new ControlDatabase(dataDirectory)
    try {
      const created = database.createSaveJob(persistedRestore(), 'Administrator', 'queued fixture')
      claimRunningFixture(database, created.job.id)
      database.close()
      database = null
      database = new ControlDatabase(dataDirectory)
      const restarted = new SaveJobService(database, new ScriptedExecutor(rollbackFailed), new EventHub())
      expect(restarted.initialize()).toBe(1)
      await restarted.close()
      expect(restarted.get(created.job.id)).toMatchObject({
        job: { state: 'failed', errorCode: 'SAVE_JOB_RECONCILIATION_UNCERTAIN' },
        run: {
          state: 'interrupted', recoveryRequired: true,
          errorCode: 'SAVE_JOB_RECONCILIATION_UNCERTAIN', result: null
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
      claimRunningFixture(database, created.job.id)
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
  const cleanupPending = overrides.cleanupPending ?? false
  const maintenanceRequired = overrides.maintenanceRequired ??
    (cleanupPending || status === 'rollback-failed')
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
    cleanupPending,
    maintenanceRequired,
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
      cleanupPending,
      maintenanceRequired,
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

function persistedRestore(): PersistedSaveJobRequest {
  return {
    operation: 'restore',
    idempotencyKey: restoreKey,
    saveName: null,
    backupId: sourceBackupId,
    expectedRevision,
    protectionRequestId: protectionKey
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

async function waitForTerminal(service: SaveJobService, jobId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = service.get(jobId)?.run.state
    if (state && !['queued', 'running'].includes(state)) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`save job did not reach a terminal state: ${jobId}`)
}

function claimRunningFixture(database: ControlDatabase, jobId: string): void {
  const queued = database.getSaveRun(jobId)
  if (!queued) throw new Error(`fixture save run missing: ${jobId}`)
  if (!database.claimQueuedSaveRun(jobId, queued.updatedAt, 'running fixture')) {
    throw new Error(`fixture save run claim failed: ${jobId}`)
  }
}

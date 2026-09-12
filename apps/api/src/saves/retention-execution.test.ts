import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  HostMutationOperationCoordinator,
  HostMutationRecoveryOperationCoordinator,
  HostMutationOperationOutcome,
  HostMutationOperationRequest,
  HostMutationRecoveryOperationRequest,
  HostMutationOperationScope
} from '../host-mutation/operation-coordinator.js'
import { HostMutationOperationCoordinatorError } from '../host-mutation/operation-coordinator.js'
import { HostMutationLeaseError } from '../host-mutation/lease.js'
import {
  BackupRetentionControlService as ProductionBackupRetentionControlService,
  BackupRetentionError,
  MAX_RETIREMENT_EXECUTION_BATCH,
  type BackupRetentionControlOptions
} from './retention-execution.js'
import { BACKUP_MANIFEST_PROTOCOL } from './schemas.js'

const roots: string[] = []
// The test deliberately inventories more than one maximum execution batch,
// verifies every pair twice, and persists a journal entry for every move. Keep
// a finite integration-test budget so loaded Windows/NTFS runners do not start
// afterEach cleanup while that awaited transaction is still completing.
const largeInventoryTestTimeoutMs = 60_000
const policy = {
  keepLastHealthy: 1,
  keepDailyDays: 0,
  keepWeeklyWeeks: 0,
  minimumHealthy: 1,
  allowUnhealthyDeletion: false
}
const referenceTime = '2026-08-31T12:00:00.000Z'

class BackupRetentionControlService extends ProductionBackupRetentionControlService {
  constructor(options: BackupRetentionControlOptions) {
    super({ ...options, hostMutationCoordinator: new PassThroughHostMutationCoordinator() })
  }
}

class PassThroughHostMutationCoordinator implements HostMutationOperationCoordinator {
  async runExclusive<T>(
    _request: HostMutationOperationRequest,
    operation: (scope: HostMutationOperationScope) =>
      Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>
  ): Promise<T> {
    const outcome = await operation({
      signal: new AbortController().signal,
      assertActive: () => undefined,
      toPowerShellBorrowArguments: () => []
    })
    if (outcome.kind === 'throw') throw outcome.error
    return outcome.value
  }
}

class RecoveryHarnessCoordinator implements
  HostMutationOperationCoordinator,
  HostMutationRecoveryOperationCoordinator {
  recoveryRequired = false
  priorOperation: string | null = null
  priorRequestId: string | null = null
  currentLeaseLost = false

  loseCurrentLease(): void {
    this.currentLeaseLost = true
  }

  async runExclusive<T>(
    request: HostMutationOperationRequest,
    operation: (scope: HostMutationOperationScope) =>
      Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>
  ): Promise<T> {
    if (this.recoveryRequired) {
      throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_RECOVERY_REQUIRED')
    }
    this.priorOperation = request.operation
    this.priorRequestId = request.requestId
    try {
      const outcome = await operation({
        signal: new AbortController().signal,
        assertActive: () => {
          if (this.currentLeaseLost) {
            throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_LOST')
          }
        },
        toPowerShellBorrowArguments: () => []
      })
      if (outcome.disposition === 'abandon') this.recoveryRequired = true
      if (outcome.kind === 'throw') throw outcome.error
      return outcome.value
    } catch (error) {
      if (error instanceof HostMutationLeaseError) this.recoveryRequired = true
      throw error
    }
  }

  async runRecoveryExclusive<T>(
    request: HostMutationRecoveryOperationRequest,
    operation: (scope: HostMutationOperationScope) =>
      Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>
  ): Promise<T> {
    if (!this.recoveryRequired || request.expectedOperation !== this.priorOperation ||
        request.expectedRequestId !== this.priorRequestId) {
      throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_RECOVERY_MISMATCH')
    }
    this.currentLeaseLost = false
    const outcome = await operation(activeScope())
    if (outcome.disposition === 'release') this.recoveryRequired = false
    if (outcome.kind === 'throw') throw outcome.error
    return outcome.value
  }
}

function activeScope(): HostMutationOperationScope {
  return {
    signal: new AbortController().signal,
    assertActive: () => undefined,
    toPowerShellBorrowArguments: () => []
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

describe('recoverable backup retention execution', () => {
  it('blocks ordinary mutations after a hard-exit boundary and resumes only through exact explicit recovery', async () => {
    const fixture = await fixtureRoot()
    await createBackup(fixture, '2026-08-31T10:00:00.000Z', 'newest')
    const old = await createBackup(fixture, '2026-07-01T10:00:00.000Z', 'old')
    const coordinator = new RecoveryHarnessCoordinator()
    let loseOnce = true
    const service = new ProductionBackupRetentionControlService({
      backupRoot: fixture,
      now: fixedClock(),
      hostMutationCoordinator: coordinator,
      hostMutationRecoveryCoordinator: coordinator,
      phase: (phase) => {
        if (phase === 'after-retire-move' && loseOnce) {
          loseOnce = false
          coordinator.loseCurrentLease()
          throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_LOST')
        }
      }
    })
    const preview = await service.preview({ referenceTime, policy })
    const request = {
      requestId: randomUUID(),
      previewDigest: preview.previewDigest,
      referenceTime,
      policy,
      confirmation: 'RETIRE_BACKUPS'
    } as const

    await expect(service.execute(request)).rejects.toMatchObject({ code: 'SAVE_RETENTION_HOST_LEASE_LOST' })
    await expect(stat(retiredBackupPath(fixture, request.requestId, old))).resolves.toBeDefined()
    await expect(stat(path.join(fixture, '.retention-control', 'retention.lock'))).resolves.toBeDefined()
    await expect(service.execute(request)).rejects.toMatchObject({
      code: 'SAVE_RETENTION_HOST_LEASE_RECOVERY_REQUIRED'
    })

    await expect(service.recoverInterrupted({
      operation: 'retire',
      requestId: request.requestId,
      confirmation: 'RECOVER_RETENTION_OPERATION'
    })).resolves.toMatchObject({ operation: 'retire', outcome: 'rolled-back' })
    expect(coordinator.recoveryRequired).toBe(false)
    await expect(stat(path.join(fixture, '.retention-control', 'retention.lock')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path.join(fixture, old))).resolves.toBeDefined()

    await expect(service.execute(request)).resolves.toMatchObject({
      reused: false,
      receipt: { retired: [expect.objectContaining({ backupId: old })] }
    })
  })
  it('binds a large eligible inventory to a bounded oldest-first recoverable batch', async () => {
    const fixture = await fixtureRoot()
    const backupIds: string[] = []
    for (let index = 0; index < MAX_RETIREMENT_EXECUTION_BATCH + 2; index++) {
      backupIds.push(await createBackup(
        fixture,
        new Date(Date.parse(referenceTime) - index * 3_600_000).toISOString(),
        `batch-${index.toString().padStart(3, '0')}`
      ))
    }
    const service = new BackupRetentionControlService({ backupRoot: fixture, now: fixedClock() })
    const preview = await service.preview({ referenceTime, policy })

    expect(preview.plan.delete).toHaveLength(MAX_RETIREMENT_EXECUTION_BATCH + 1)
    expect(preview.executionBatch).toEqual({
      maximumCandidates: MAX_RETIREMENT_EXECUTION_BATCH,
      selectedBackupIds: backupIds.slice(2),
      deferredCandidateCount: 1
    })

    const executed = await service.execute({
      requestId: randomUUID(),
      previewDigest: preview.previewDigest,
      referenceTime,
      policy,
      confirmation: 'RETIRE_BACKUPS'
    })
    expect(executed.receipt.retired.map((entry) => entry.backupId))
      .toEqual(preview.executionBatch.selectedBackupIds)
    await expect(stat(path.join(fixture, backupIds[1]!))).resolves.toBeDefined()
  }, largeInventoryTestTimeoutMs)

  it('persists versioned annotations and makes protection part of the executable plan digest', async () => {
    const fixture = await fixtureRoot()
    await createBackup(fixture, '2026-08-31T10:00:00.000Z', 'newest')
    const old = await createBackup(fixture, '2026-07-01T10:00:00.000Z', 'old')
    const service = new BackupRetentionControlService({ backupRoot: fixture, now: fixedClock() })
    const before = await service.preview({ referenceTime, policy })
    expect(before.plan.delete.map((entry) => entry.backupId)).toEqual([old])

    const requestId = randomUUID()
    const created = await service.setAnnotation({
      requestId,
      backupId: old,
      expectedRevision: null,
      note: '  手工保护点  ',
      protected: true,
      confirmation: 'UPDATE_BACKUP_ANNOTATION'
    })
    expect(created).toMatchObject({
      reused: false,
      receipt: {
        annotation: { backupId: old, revision: 1, note: '手工保护点', protected: true }
      }
    })
    expect(await service.listAnnotations()).toEqual([created.receipt.annotation])
    expect(await service.setAnnotation({
      requestId,
      backupId: old,
      expectedRevision: null,
      note: '  手工保护点  ',
      protected: true,
      confirmation: 'UPDATE_BACKUP_ANNOTATION'
    })).toEqual({ receipt: created.receipt, reused: true })
    await expect(service.setAnnotation({
      requestId,
      backupId: old,
      expectedRevision: 1,
      note: 'different',
      protected: false,
      confirmation: 'UPDATE_BACKUP_ANNOTATION'
    })).rejects.toMatchObject({ code: 'SAVE_RETENTION_IDEMPOTENCY_CONFLICT' })

    const protectedPreview = await service.preview({ referenceTime, policy })
    expect(protectedPreview.plan.delete).toEqual([])
    expect(protectedPreview.plan.keep).toContainEqual({ backupId: old, reasons: ['protected'] })
    expect(protectedPreview.previewDigest).not.toBe(before.previewDigest)
    await expect(service.execute({
      requestId: randomUUID(),
      previewDigest: before.previewDigest,
      referenceTime,
      policy,
      confirmation: 'RETIRE_BACKUPS'
    })).rejects.toMatchObject({ code: 'SAVE_RETENTION_PLAN_CHANGED' })

    await expect(service.setAnnotation({
      requestId: randomUUID(),
      backupId: old,
      expectedRevision: 0,
      note: null,
      protected: false,
      confirmation: 'UPDATE_BACKUP_ANNOTATION'
    })).rejects.toMatchObject({ code: 'SAVE_RETENTION_ANNOTATION_CONFLICT' })
    const updated = await service.setAnnotation({
      requestId: randomUUID(),
      backupId: old,
      expectedRevision: 1,
      note: null,
      protected: false,
      confirmation: 'UPDATE_BACKUP_ANNOTATION'
    })
    expect(updated.receipt.annotation).toMatchObject({ revision: 2, note: null, protected: false })
    expect((await service.preview({ referenceTime, policy })).plan.delete.map((entry) => entry.backupId))
      .toEqual([old])
  })

  it('releases the global lease after an annotation event is durable even when receipt publication is interrupted', async () => {
    const fixture = await fixtureRoot()
    const backupId = await createBackup(fixture, '2026-08-31T10:00:00.000Z', 'annotated')
    const coordinator = new RecoveryHarnessCoordinator()
    let failOnce = true
    const service = new ProductionBackupRetentionControlService({
      backupRoot: fixture,
      now: fixedClock(),
      hostMutationCoordinator: coordinator,
      hostMutationRecoveryCoordinator: coordinator,
      phase: (phase) => {
        if (phase === 'after-annotation-event' && failOnce) {
          failOnce = false
          throw new Error('receipt publication interrupted')
        }
      }
    })
    const request = {
      requestId: randomUUID(), backupId, expectedRevision: null,
      note: 'durable event', protected: true,
      confirmation: 'UPDATE_BACKUP_ANNOTATION'
    } as const

    await expect(service.setAnnotation(request)).rejects.toMatchObject({ code: 'SAVE_RETENTION_FAILED' })
    expect(coordinator.recoveryRequired).toBe(false)
    await expect(service.setAnnotation(request)).resolves.toMatchObject({
      reused: true,
      receipt: { requestId: request.requestId, annotation: { backupId, protected: true } }
    })
  })

  it('fails closed when the private annotation ledger contains an unexpected entry', async () => {
    const fixture = await fixtureRoot()
    const backupId = await createBackup(fixture, '2026-08-31T10:00:00.000Z', 'annotated')
    const service = new BackupRetentionControlService({ backupRoot: fixture, now: fixedClock() })
    await service.setAnnotation({
      requestId: randomUUID(),
      backupId,
      expectedRevision: null,
      note: 'protected',
      protected: true,
      confirmation: 'UPDATE_BACKUP_ANNOTATION'
    })
    await writeFile(
      path.join(fixture, '.retention-control', 'annotations', 'unexpected.txt'),
      'must not be ignored'
    )
    await expect(service.listAnnotations()).rejects.toMatchObject({
      code: 'SAVE_RETENTION_RECOVERY_REQUIRED'
    })
    await expect(service.preview({ referenceTime, policy })).rejects.toMatchObject({
      code: 'SAVE_RETENTION_STORAGE_UNAVAILABLE'
    })
  })

  it('inventories trusted backups itself, honors protected IDs, and excludes an untrusted timestamp', async () => {
    const fixture = await fixtureRoot()
    const newest = await createBackup(fixture, '2026-08-31T10:00:00.000Z', 'newest')
    const protectedOld = await createBackup(fixture, '2026-07-01T10:00:00.000Z', 'protected')
    const deletableOld = await createBackup(fixture, '2026-06-01T10:00:00.000Z', 'deletable')
    const untrustedId = `tx-${randomUUID()}`
    await mkdir(path.join(fixture, untrustedId))
    await writeFile(path.join(fixture, untrustedId, 'orphan.bin'), 'not a trusted backup')

    const service = new BackupRetentionControlService({
      backupRoot: fixture,
      protectionSource: {
        listProtectedBackupIds: async () => new Set([protectedOld])
      }
    })
    const preview = await service.preview({ referenceTime, policy })

    expect(preview.mode).toBe('dry-run')
    expect(preview.plan.keep).toEqual([
      { backupId: newest, reasons: ['latest-healthy', 'minimum-healthy'] },
      { backupId: protectedOld, reasons: ['protected'] }
    ])
    expect(preview.plan.delete).toEqual([{ backupId: deletableOld, reason: 'outside-policy' }])
    expect(preview.excluded).toEqual([{ backupId: untrustedId, reason: 'created-at-unavailable' }])
    expect(preview.inventoryDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(preview.previewDigest).toMatch(/^[a-f0-9]{64}$/)
    await expect(stat(path.join(fixture, deletableOld))).resolves.toBeDefined()
  })

  it('skips a candidate that becomes protected after executable candidate generation', async () => {
    const fixture = await fixtureRoot()
    await createBackup(fixture, '2026-08-31T10:00:00.000Z', 'newest')
    const old = await createBackup(fixture, '2026-07-01T10:00:00.000Z', 'old')
    let protectionReads = 0
    const service = new BackupRetentionControlService({
      backupRoot: fixture,
      now: fixedClock(),
      protectionSource: {
        listProtectedBackupIds: async () => {
          protectionReads += 1
          return protectionReads >= 3 ? new Set([old]) : new Set()
        }
      }
    })
    const preview = await service.preview({ referenceTime, policy })
    expect(preview.plan.delete.map((entry) => entry.backupId)).toEqual([old])

    const executed = await service.execute({
      requestId: randomUUID(),
      previewDigest: preview.previewDigest,
      referenceTime,
      policy,
      confirmation: 'RETIRE_BACKUPS'
    })

    expect(protectionReads).toBe(3)
    expect(executed.receipt.retired).toEqual([])
    await expect(stat(path.join(fixture, old))).resolves.toBeDefined()
  })

  it('fails the whole retirement batch before moving bytes when the commit-boundary protection refresh fails', async () => {
    const fixture = await fixtureRoot()
    await createBackup(fixture, '2026-08-31T10:00:00.000Z', 'newest')
    const old = await createBackup(fixture, '2026-07-01T10:00:00.000Z', 'old')
    let protectionReads = 0
    const service = new BackupRetentionControlService({
      backupRoot: fixture,
      now: fixedClock(),
      protectionSource: {
        listProtectedBackupIds: async () => {
          protectionReads += 1
          if (protectionReads === 3) throw new Error('fictional protection source outage')
          return new Set()
        }
      }
    })
    const preview = await service.preview({ referenceTime, policy })
    const retirementRequestId = randomUUID()

    await expect(service.execute({
      requestId: retirementRequestId,
      previewDigest: preview.previewDigest,
      referenceTime,
      policy,
      confirmation: 'RETIRE_BACKUPS'
    })).rejects.toMatchObject({ code: 'SAVE_RETENTION_STORAGE_UNAVAILABLE' })
    expect(protectionReads).toBe(3)
    await expect(stat(path.join(fixture, old))).resolves.toBeDefined()
    await expect(stat(retiredBackupPath(fixture, retirementRequestId, old)))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retires only the bound plan, persists an idempotent receipt, and restores it separately', async () => {
    const fixture = await fixtureRoot()
    const newest = await createBackup(fixture, '2026-08-31T10:00:00.000Z', 'newest')
    const old = await createBackup(fixture, '2026-07-01T10:00:00.000Z', 'old')
    const service = new BackupRetentionControlService({ backupRoot: fixture, now: fixedClock() })
    const preview = await service.preview({ referenceTime, policy })
    const requestId = randomUUID()

    await expect(service.execute({
      requestId,
      previewDigest: preview.previewDigest,
      referenceTime,
      policy,
      confirmation: 'WRONG'
    })).rejects.toMatchObject({ code: 'SAVE_RETENTION_REQUEST_INVALID' })
    await expect(stat(path.join(fixture, old))).resolves.toBeDefined()

    const executed = await service.execute({
      requestId,
      previewDigest: preview.previewDigest,
      referenceTime,
      policy,
      confirmation: 'RETIRE_BACKUPS'
    })
    expect(executed.reused).toBe(false)
    expect(executed.receipt.retired).toEqual([
      expect.objectContaining({ backupId: old, health: 'healthy' })
    ])
    expect(executed.receipt.retired[0]?.evidenceDigest).toMatch(/^[a-f0-9]{64}$/)
    await expect(stat(path.join(fixture, newest))).resolves.toBeDefined()
    await expect(stat(path.join(fixture, old))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(retiredBackupPath(fixture, requestId, old))).resolves.toBeDefined()

    const replay = await service.execute({
      requestId,
      previewDigest: preview.previewDigest,
      referenceTime,
      policy,
      confirmation: 'RETIRE_BACKUPS'
    })
    expect(replay).toEqual({ receipt: executed.receipt, reused: true })
    await expect(service.execute({
      requestId,
      previewDigest: '0'.repeat(64),
      referenceTime,
      policy,
      confirmation: 'RETIRE_BACKUPS'
    })).rejects.toMatchObject({ code: 'SAVE_RETENTION_IDEMPOTENCY_CONFLICT' })

    const restoreRequestId = randomUUID()
    const restored = await service.restore({
      requestId: restoreRequestId,
      retirementRequestId: requestId,
      confirmation: 'RESTORE_RETIRED_BACKUPS'
    })
    expect(restored).toMatchObject({
      reused: false,
      receipt: { restoredBackupIds: [old], retirementRequestId: requestId.toLowerCase() }
    })
    await expect(stat(path.join(fixture, old))).resolves.toBeDefined()
    await expect(stat(retiredBackupPath(fixture, requestId, old))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await service.restore({
      requestId: restoreRequestId,
      retirementRequestId: requestId,
      confirmation: 'RESTORE_RETIRED_BACKUPS'
    })).toEqual({ receipt: restored.receipt, reused: true })
  })

  it('never rolls an unrelated active backup into retirement when a schema-valid journal is corrupted', async () => {
    const fixture = await fixtureRoot()
    const newest = await createBackup(fixture, '2026-08-31T10:00:00.000Z', 'newest')
    const old = await createBackup(fixture, '2026-07-01T10:00:00.000Z', 'old')
    const service = new BackupRetentionControlService({ backupRoot: fixture, now: fixedClock() })
    const preview = await service.preview({ referenceTime, policy })
    const retirementRequestId = randomUUID()
    await service.execute({
      requestId: retirementRequestId,
      previewDigest: preview.previewDigest,
      referenceTime,
      policy,
      confirmation: 'RETIRE_BACKUPS'
    })
    const operationDirectory = path.join(
      fixture, '.retention-control', 'retired', `retire-${retirementRequestId.toLowerCase()}`
    )
    const latestJournalPath = path.join(operationDirectory, 'journal-000003.json')
    const journal = JSON.parse(await readFile(latestJournalPath, 'utf8')) as {
      planned: Array<{ backupId: string }>
    }
    journal.planned[0]!.backupId = newest
    await writeFile(latestJournalPath, JSON.stringify(journal))

    await expect(service.restore({
      requestId: randomUUID(),
      retirementRequestId,
      confirmation: 'RESTORE_RETIRED_BACKUPS'
    })).rejects.toMatchObject({ code: 'SAVE_RETENTION_RECOVERY_REQUIRED' })
    await expect(stat(path.join(fixture, newest))).resolves.toBeDefined()
    await expect(stat(retiredBackupPath(fixture, retirementRequestId, old))).resolves.toBeDefined()
  })

  it('binds the preview to manifest content even when replacement bytes remain healthy and equal-sized', async () => {
    const fixture = await fixtureRoot()
    await createBackup(fixture, '2026-08-31T10:00:00.000Z', 'newest')
    const old = await createBackup(fixture, '2026-07-01T10:00:00.000Z', 'old-data')
    const service = new BackupRetentionControlService({ backupRoot: fixture })
    const preview = await service.preview({ referenceTime, policy })

    const directory = path.join(fixture, old)
    const manifestPath = path.join(directory, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      files: Array<{ name: string, bytes: number, sha256: string }>
    }
    const dsv = manifest.files.find((entry) => entry.name.endsWith('.dsv'))
    expect(dsv).toBeDefined()
    const replacement = Buffer.from('NEW-DATA')
    await writeFile(path.join(directory, dsv!.name), replacement)
    dsv!.bytes = replacement.length
    dsv!.sha256 = sha256(replacement)
    await writeFile(manifestPath, JSON.stringify(manifest))

    await expect(service.execute({
      requestId: randomUUID(),
      previewDigest: preview.previewDigest,
      referenceTime,
      policy,
      confirmation: 'RETIRE_BACKUPS'
    })).rejects.toMatchObject({ code: 'SAVE_RETENTION_PLAN_CHANGED' })
    await expect(stat(path.join(fixture, old))).resolves.toBeDefined()
  })

  it('rolls back a partial retirement and safely retries the same idempotency key', async () => {
    const fixture = await fixtureRoot()
    await createBackup(fixture, '2026-08-31T10:00:00.000Z', 'newest')
    const middle = await createBackup(fixture, '2026-07-01T10:00:00.000Z', 'middle')
    const oldest = await createBackup(fixture, '2026-06-01T10:00:00.000Z', 'oldest')
    let failOnce = true
    let beforeMoveCount = 0
    const service = new BackupRetentionControlService({
      backupRoot: fixture,
      now: fixedClock(),
      phase: (phase) => {
        if (phase !== 'before-retire-move') return
        beforeMoveCount += 1
        if (failOnce && beforeMoveCount === 2) {
          failOnce = false
          throw new Error('injected retirement failure')
        }
      }
    })
    const preview = await service.preview({ referenceTime, policy })
    const request = {
      requestId: randomUUID(),
      previewDigest: preview.previewDigest,
      referenceTime,
      policy,
      confirmation: 'RETIRE_BACKUPS'
    } as const

    await expect(service.execute(request)).rejects.toBeInstanceOf(BackupRetentionError)
    await expect(stat(path.join(fixture, middle))).resolves.toBeDefined()
    await expect(stat(path.join(fixture, oldest))).resolves.toBeDefined()

    beforeMoveCount = 0
    const retry = await service.execute(request)
    expect(retry.reused).toBe(false)
    expect(retry.receipt.retired.map((entry) => entry.backupId)).toEqual([middle, oldest])
    await expect(stat(path.join(fixture, middle))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path.join(fixture, oldest))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rolls back a partial restore and permits an exact retry', async () => {
    const fixture = await fixtureRoot()
    await createBackup(fixture, '2026-08-31T10:00:00.000Z', 'newest')
    const middle = await createBackup(fixture, '2026-07-01T10:00:00.000Z', 'middle')
    const oldest = await createBackup(fixture, '2026-06-01T10:00:00.000Z', 'oldest')
    let failOnce = false
    let restoreMoveCount = 0
    const service = new BackupRetentionControlService({
      backupRoot: fixture,
      now: fixedClock(),
      phase: (phase) => {
        if (phase !== 'before-restore-move') return
        restoreMoveCount += 1
        if (failOnce && restoreMoveCount === 2) {
          failOnce = false
          throw new Error('injected restore failure')
        }
      }
    })
    const preview = await service.preview({ referenceTime, policy })
    const retirementRequestId = randomUUID()
    await service.execute({
      requestId: retirementRequestId,
      previewDigest: preview.previewDigest,
      referenceTime,
      policy,
      confirmation: 'RETIRE_BACKUPS'
    })

    failOnce = true
    const request = {
      requestId: randomUUID(),
      retirementRequestId,
      confirmation: 'RESTORE_RETIRED_BACKUPS'
    } as const
    await expect(service.restore(request)).rejects.toBeInstanceOf(BackupRetentionError)
    await expect(stat(path.join(fixture, middle))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path.join(fixture, oldest))).rejects.toMatchObject({ code: 'ENOENT' })

    restoreMoveCount = 0
    const retry = await service.restore(request)
    expect(retry.receipt.restoredBackupIds).toEqual([middle, oldest])
    await expect(stat(path.join(fixture, middle))).resolves.toBeDefined()
    await expect(stat(path.join(fixture, oldest))).resolves.toBeDefined()
  })

  it('requires the purge grace period, a bound preview, and a separate confirmation', async () => {
    const fixture = await fixtureRoot()
    await createBackup(fixture, '2026-08-31T10:00:00.000Z', 'newest')
    const old = await createBackup(fixture, '2026-07-01T10:00:00.000Z', 'old')
    const service = new BackupRetentionControlService({ backupRoot: fixture, now: fixedClock() })
    const preview = await service.preview({ referenceTime, policy })
    const retirementRequestId = randomUUID()
    await service.execute({
      requestId: retirementRequestId,
      previewDigest: preview.previewDigest,
      referenceTime,
      policy,
      confirmation: 'RETIRE_BACKUPS'
    })
    const purgePreview = await service.previewPurge({ retirementRequestId })
    expect(purgePreview).toMatchObject({
      mode: 'dry-run',
      eligible: false,
      retiredBackupIds: [old]
    })
    expect(Date.parse(purgePreview.eligibleAt) - Date.parse('2026-08-31T12:00:00.000Z'))
      .toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1_000)
    await expect(service.purge({
      requestId: randomUUID(),
      retirementRequestId,
      purgePreviewDigest: purgePreview.purgePreviewDigest,
      confirmation: 'PURGE_RETIRED_BACKUPS'
    })).rejects.toMatchObject({ code: 'SAVE_RETENTION_PURGE_TOO_EARLY' })
    await expect(stat(retiredBackupPath(fixture, retirementRequestId, old))).resolves.toBeDefined()
  })

  it('permanently purges only an eligible retired transaction and persists an idempotent receipt', async () => {
    const fixture = await fixtureRoot()
    await createBackup(fixture, '2026-08-31T10:00:00.000Z', 'newest')
    const old = await createBackup(fixture, '2026-07-01T10:00:00.000Z', 'old')
    const service = new BackupRetentionControlService({
      backupRoot: fixture,
      now: fixedClock(),
      minimumPurgeAgeMs: 0
    })
    const preview = await service.preview({ referenceTime, policy })
    const retirementRequestId = randomUUID()
    const retired = await service.execute({
      requestId: retirementRequestId,
      previewDigest: preview.previewDigest,
      referenceTime,
      policy,
      confirmation: 'RETIRE_BACKUPS'
    })
    const purgePreview = await service.previewPurge({ retirementRequestId })
    expect(purgePreview.eligible).toBe(true)
    expect(purgePreview.totalBytes).toBe(retired.receipt.retired[0]?.totalBytes)
    const request = {
      requestId: randomUUID(),
      retirementRequestId,
      purgePreviewDigest: purgePreview.purgePreviewDigest,
      confirmation: 'PURGE_RETIRED_BACKUPS'
    } as const
    const purged = await service.purge(request)
    expect(purged).toMatchObject({
      reused: false,
      receipt: {
        purgedBackupIds: [old],
        bytesFreed: purgePreview.totalBytes,
        recoveryRequired: false
      }
    })
    await expect(stat(retiredBackupPath(fixture, retirementRequestId, old)))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect(await service.purge(request)).toEqual({ receipt: purged.receipt, reused: true })
    await expect(service.restore({
      requestId: randomUUID(),
      retirementRequestId,
      confirmation: 'RESTORE_RETIRED_BACKUPS'
    })).rejects.toMatchObject({ code: 'SAVE_RETENTION_OPERATION_NOT_RESTORABLE' })
  })

  it('performs zero irreversible deletion when a retired backup becomes protected before purge', async () => {
    const fixture = await fixtureRoot()
    await createBackup(fixture, '2026-08-31T10:00:00.000Z', 'newest')
    const old = await createBackup(fixture, '2026-07-01T10:00:00.000Z', 'old')
    let protectedNow = false
    const service = new BackupRetentionControlService({
      backupRoot: fixture,
      now: fixedClock(),
      minimumPurgeAgeMs: 0,
      protectionSource: {
        listProtectedBackupIds: async () => protectedNow ? new Set([old]) : new Set()
      }
    })
    const preview = await service.preview({ referenceTime, policy })
    const retirementRequestId = randomUUID()
    await service.execute({
      requestId: retirementRequestId,
      previewDigest: preview.previewDigest,
      referenceTime,
      policy,
      confirmation: 'RETIRE_BACKUPS'
    })
    const purgePreview = await service.previewPurge({ retirementRequestId })
    protectedNow = true

    await expect(service.purge({
      requestId: randomUUID(),
      retirementRequestId,
      purgePreviewDigest: purgePreview.purgePreviewDigest,
      confirmation: 'PURGE_RETIRED_BACKUPS'
    })).rejects.toMatchObject({ code: 'SAVE_RETENTION_PLAN_CHANGED' })
    await expect(stat(retiredBackupPath(fixture, retirementRequestId, old))).resolves.toBeDefined()
  })

  it('resumes the same purge after a crash-equivalent failure following irreversible removal', async () => {
    const fixture = await fixtureRoot()
    await createBackup(fixture, '2026-08-31T10:00:00.000Z', 'newest')
    const middle = await createBackup(fixture, '2026-07-01T10:00:00.000Z', 'middle')
    const oldest = await createBackup(fixture, '2026-06-01T10:00:00.000Z', 'oldest')
    let failOnce = true
    const coordinator = new RecoveryHarnessCoordinator()
    const service = new ProductionBackupRetentionControlService({
      backupRoot: fixture,
      now: fixedClock(),
      minimumPurgeAgeMs: 0,
      hostMutationCoordinator: coordinator,
      hostMutationRecoveryCoordinator: coordinator,
      phase: (phase) => {
        if (phase === 'after-purge' && failOnce) {
          failOnce = false
          throw new Error('crash after first owned directory removal')
        }
      }
    })
    const preview = await service.preview({ referenceTime, policy })
    const retirementRequestId = randomUUID()
    await service.execute({
      requestId: retirementRequestId,
      previewDigest: preview.previewDigest,
      referenceTime,
      policy,
      confirmation: 'RETIRE_BACKUPS'
    })
    const purgePreview = await service.previewPurge({ retirementRequestId })
    const request = {
      requestId: randomUUID(),
      retirementRequestId,
      purgePreviewDigest: purgePreview.purgePreviewDigest,
      confirmation: 'PURGE_RETIRED_BACKUPS'
    } as const
    await expect(service.purge(request)).rejects.toMatchObject({
      code: 'SAVE_RETENTION_RECOVERY_REQUIRED'
    })
    expect(coordinator.recoveryRequired).toBe(false)
    const resumed = await service.purge(request)
    expect(resumed.receipt.purgedBackupIds).toEqual([middle, oldest])
    await expect(stat(retiredBackupPath(fixture, retirementRequestId, middle)))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(retiredBackupPath(fixture, retirementRequestId, oldest)))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses permanent purge when a retired directory contains any unowned extra entry', async () => {
    const fixture = await fixtureRoot()
    await createBackup(fixture, '2026-08-31T10:00:00.000Z', 'newest')
    const old = await createBackup(fixture, '2026-07-01T10:00:00.000Z', 'old')
    const service = new BackupRetentionControlService({
      backupRoot: fixture,
      now: fixedClock(),
      minimumPurgeAgeMs: 0
    })
    const preview = await service.preview({ referenceTime, policy })
    const retirementRequestId = randomUUID()
    await service.execute({
      requestId: retirementRequestId,
      previewDigest: preview.previewDigest,
      referenceTime,
      policy,
      confirmation: 'RETIRE_BACKUPS'
    })
    const retiredDirectory = retiredBackupPath(fixture, retirementRequestId, old)
    await writeFile(path.join(retiredDirectory, 'unowned.extra'), 'do not unlink')
    const purgePreview = await service.previewPurge({ retirementRequestId })
    await expect(service.purge({
      requestId: randomUUID(),
      retirementRequestId,
      purgePreviewDigest: purgePreview.purgePreviewDigest,
      confirmation: 'PURGE_RETIRED_BACKUPS'
    })).rejects.toMatchObject({ code: 'SAVE_RETENTION_RECOVERY_REQUIRED' })
    await expect(stat(path.join(retiredDirectory, 'unowned.extra'))).resolves.toBeDefined()
    await expect(stat(path.join(retiredDirectory, 'manifest.json'))).resolves.toBeDefined()
  })
})

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dyson-retention-execution-'))
  roots.push(root)
  return root
}

async function createBackup(root: string, createdAt: string, marker: string): Promise<string> {
  const requestId = randomUUID()
  const backupId = `tx-${requestId}`
  const saveName = `Save_${marker.replace(/[^A-Za-z0-9_-]/g, '_')}`
  const directory = path.join(root, backupId)
  const dsv = Buffer.from(marker.toUpperCase())
  const server = Buffer.from(`SERVER-${marker.toUpperCase()}`)
  await mkdir(directory)
  const manifest = JSON.stringify({
    protocol: BACKUP_MANIFEST_PROTOCOL,
    schemaVersion: 1,
    requestId,
    createdAt,
    saveName,
    files: [
      { name: `${saveName}.dsv`, bytes: dsv.length, sha256: sha256(dsv) },
      { name: `${saveName}.server`, bytes: server.length, sha256: sha256(server) }
    ]
  })
  await Promise.all([
    writeFile(path.join(directory, `${saveName}.dsv`), dsv),
    writeFile(path.join(directory, `${saveName}.server`), server),
    writeFile(path.join(directory, 'manifest.json'), manifest)
  ])
  return backupId
}

function retiredBackupPath(root: string, retirementRequestId: string, backupId: string): string {
  return path.join(root, '.retention-control', 'retired', `retire-${retirementRequestId.toLowerCase()}`, backupId)
}

function fixedClock(): () => Date {
  let milliseconds = Date.parse('2026-08-31T12:00:00.000Z')
  return () => new Date(milliseconds++)
}

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

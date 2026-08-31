import { describe, expect, it, vi } from 'vitest'
import { BackupRetentionError } from './retention-execution.js'
import {
  BackupRetentionHttpController,
  backupRetentionHttpConfirmations,
  type BackupRetentionHttpService
} from './retention-http.js'

const requestId = '11111111-1111-4111-8111-111111111111'
const restoreRequestId = '22222222-2222-4222-8222-222222222222'
const purgeRequestId = '33333333-3333-4333-8333-333333333333'
const digest = 'a'.repeat(64)
const purgeDigest = 'b'.repeat(64)
const referenceTime = '2026-08-31T08:00:00.000Z'
const committedAt = '2026-08-31T08:01:00.000Z'
const policy = {
  keepLastHealthy: 3,
  keepDailyDays: 14,
  keepWeeklyWeeks: 8,
  minimumHealthy: 2,
  allowUnhealthyDeletion: false
}

describe('BackupRetentionHttpController', () => {
  it('keeps mutation execution default-closed while still returning a bounded preview', async () => {
    const service = createService()
    const controller = new BackupRetentionHttpController({ service })

    const preview = await controller.preview({ referenceTime, policy })
    expect(preview).toEqual({
      statusCode: 200,
      body: { data: previewFixture(), meta: { executionEnabled: false } }
    })

    const execute = await controller.execute({
      requestId, referenceTime, policy, previewDigest: digest,
      confirmation: backupRetentionHttpConfirmations.retire
    })
    expect(execute).toEqual({
      statusCode: 423,
      body: { error: { code: 'SAVE_RETENTION_MUTATIONS_DISABLED', message: '备份保留变更门禁未开启' } }
    })
    expect(service.execute).not.toHaveBeenCalled()
  })

  it('passes only the strict annotation request and validates the bound receipt', async () => {
    const service = createService()
    const controller = new BackupRetentionHttpController({ service, mutationGate: () => true })
    const input = {
      requestId,
      backupId: 'backup-one',
      expectedRevision: null,
      note: '首个稳定保护点',
      protected: true,
      confirmation: backupRetentionHttpConfirmations.annotate
    }

    const result = await controller.annotate(input)
    expect(result.statusCode).toBe(201)
    expect(result.body).toEqual({ data: annotationResultFixture() })
    expect(service.setAnnotation).toHaveBeenCalledWith(input)
  })

  it('rejects a wrong confirmation before invoking the mutation service', async () => {
    const service = createService()
    const controller = new BackupRetentionHttpController({ service, mutationGate: () => true })
    const result = await controller.execute({
      requestId, referenceTime, policy, previewDigest: digest, confirmation: 'RETIRE'
    })

    expect(result.statusCode).toBe(422)
    expect(result.body).toEqual({
      error: { code: 'SAVE_RETENTION_CONFIRMATION_INVALID', message: '备份保留固定确认短语不匹配' }
    })
    expect(service.execute).not.toHaveBeenCalled()
  })

  it('returns 200 for an idempotently reused, request-bound retirement receipt', async () => {
    const service = createService({ retirementReused: true })
    const controller = new BackupRetentionHttpController({ service, mutationGate: () => true })
    const result = await controller.execute({
      requestId, referenceTime, policy, previewDigest: digest,
      confirmation: backupRetentionHttpConfirmations.retire
    })

    expect(result.statusCode).toBe(200)
    expect(result.body).toEqual({ data: retirementResultFixture(true) })
  })

  it('binds restore and purge output to both request identifiers', async () => {
    const service = createService()
    const controller = new BackupRetentionHttpController({ service, mutationGate: () => true })

    const restore = await controller.restore({
      requestId: restoreRequestId,
      retirementRequestId: requestId,
      confirmation: backupRetentionHttpConfirmations.restore
    })
    expect(restore.statusCode).toBe(201)

    const purgePreview = await controller.previewPurge({ retirementRequestId: requestId })
    expect(purgePreview).toEqual({
      statusCode: 200,
      body: { data: purgePreviewFixture(), meta: { executionEnabled: true } }
    })

    const purge = await controller.purge({
      requestId: purgeRequestId,
      retirementRequestId: requestId,
      purgePreviewDigest: purgeDigest,
      confirmation: backupRetentionHttpConfirmations.purge
    })
    expect(purge.statusCode).toBe(201)
  })

  it('maps core conflicts without exposing thrown error details', async () => {
    const service = createService()
    vi.mocked(service.execute).mockRejectedValueOnce(
      new BackupRetentionError('SAVE_RETENTION_PLAN_CHANGED', { cause: new Error('Y:\\private\\save') })
    )
    const controller = new BackupRetentionHttpController({ service, mutationGate: () => true })
    const result = await controller.execute({
      requestId, referenceTime, policy, previewDigest: digest,
      confirmation: backupRetentionHttpConfirmations.retire
    })

    expect(result).toEqual({
      statusCode: 409,
      body: { error: { code: 'SAVE_RETENTION_PLAN_CHANGED', message: '备份清单或保留计划已经变化' } }
    })
    expect(JSON.stringify(result)).not.toContain('private')
  })

  it('fails closed when a core response contains extra path-shaped output', async () => {
    const service = createService()
    vi.mocked(service.execute).mockResolvedValueOnce({
      ...retirementResultFixture(false),
      workspacePath: 'Y:\\Projects\\Game\\Dyson'
    })
    const controller = new BackupRetentionHttpController({ service, mutationGate: () => true })
    const result = await controller.execute({
      requestId, referenceTime, policy, previewDigest: digest,
      confirmation: backupRetentionHttpConfirmations.retire
    })

    expect(result).toEqual({
      statusCode: 503,
      body: { error: { code: 'SAVE_RETENTION_RESPONSE_INVALID', message: '备份保留服务返回了无效结果' } }
    })
    expect(JSON.stringify(result)).not.toContain('Projects')
  })

  it('rejects duplicate identifiers across preview result partitions', async () => {
    const service = createService()
    const invalid = previewFixture()
    invalid.plan.delete.push({ backupId: 'backup-one', reason: 'outside-policy' })
    vi.mocked(service.preview).mockResolvedValueOnce(invalid)
    const controller = new BackupRetentionHttpController({ service })

    const result = await controller.preview({ referenceTime, policy })
    expect(result.statusCode).toBe(503)
    expect(result.body).toEqual({
      error: { code: 'SAVE_RETENTION_RESPONSE_INVALID', message: '备份保留服务返回了无效结果' }
    })
  })

  it('fails closed when the mutation-gate provider is unavailable', async () => {
    const service = createService()
    const controller = new BackupRetentionHttpController({
      service,
      mutationGate: () => { throw new Error('gate backend unavailable') }
    })

    const result = await controller.previewPurge({ retirementRequestId: requestId })
    expect(result).toEqual({
      statusCode: 503,
      body: { error: { code: 'SAVE_RETENTION_GATE_UNAVAILABLE', message: '备份保留变更门禁暂不可用' } }
    })
  })
})

function createService(options: { retirementReused?: boolean } = {}): BackupRetentionHttpService {
  return {
    listAnnotations: vi.fn(async () => [annotationResultFixture().receipt.annotation]),
    setAnnotation: vi.fn(async () => annotationResultFixture()),
    preview: vi.fn(async () => previewFixture()),
    execute: vi.fn(async () => retirementResultFixture(options.retirementReused ?? false)),
    restore: vi.fn(async () => ({
      receipt: {
        schemaVersion: 1,
        operation: 'restore-retired',
        requestId: restoreRequestId,
        retirementRequestId: requestId,
        committedAt,
        restoredBackupIds: ['backup-one'],
        recoveryRequired: false
      },
      reused: false
    })),
    previewPurge: vi.fn(async () => purgePreviewFixture()),
    purge: vi.fn(async () => ({
      receipt: {
        schemaVersion: 1,
        operation: 'purge-retired',
        requestId: purgeRequestId,
        retirementRequestId: requestId,
        committedAt,
        purgedBackupIds: ['backup-one'],
        bytesFreed: 3072,
        recoveryRequired: false
      },
      reused: false
    }))
  }
}

function previewFixture() {
  return {
    schemaVersion: 1 as const,
    mode: 'dry-run' as const,
    referenceTime,
    policy: { ...policy },
    plan: {
      schemaVersion: 1 as const,
      mode: 'dry-run' as const,
      referenceTime,
      policy: { ...policy },
      keep: [{ backupId: 'backup-one', reasons: ['latest-healthy' as const] }],
      delete: [] as Array<{ backupId: string; reason: 'outside-policy' | 'unhealthy-deletion-enabled' }>,
      blocked: [] as Array<{ backupId: string; reason: 'unhealthy-backup' }>
    },
    excluded: [] as Array<{ backupId: string; reason: 'created-at-unavailable' | 'redirected-entry' }>,
    inventoryDigest: 'c'.repeat(64),
    previewDigest: digest
  }
}

function annotationResultFixture() {
  return {
    receipt: {
      schemaVersion: 1 as const,
      operation: 'annotate' as const,
      requestId,
      committedAt,
      annotation: {
        backupId: 'backup-one',
        revision: 1,
        note: '首个稳定保护点',
        protected: true,
        updatedAt: committedAt
      }
    },
    reused: false
  }
}

function retirementResultFixture(reused: boolean) {
  return {
    receipt: {
      schemaVersion: 1 as const,
      operation: 'retire' as const,
      requestId,
      previewDigest: digest,
      committedAt,
      retired: [{
        backupId: 'backup-one',
        saveName: 'MainSave',
        createdAt: referenceTime,
        health: 'healthy' as const,
        totalBytes: 3072,
        evidenceDigest: 'd'.repeat(64)
      }],
      recoveryRequired: false as const
    },
    reused
  }
}

function purgePreviewFixture() {
  return {
    schemaVersion: 1 as const,
    mode: 'dry-run' as const,
    retirementRequestId: requestId,
    eligibleAt: '2026-09-07T08:01:00.000Z',
    eligible: false,
    retiredBackupIds: ['backup-one'],
    totalBytes: 3072,
    retirementReceiptDigest: 'e'.repeat(64),
    purgePreviewDigest: purgeDigest
  }
}

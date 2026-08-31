// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SaveRetentionWorkspace } from './SaveRetentionWorkspace'
import { api, ApiError } from './api'
import type {
  BackupAnnotation,
  BackupCatalogItem,
  BackupRetentionPreview,
  BackupRetirementReceipt,
  BackupRetentionPurgePreview,
  SessionUser
} from './model'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('save retention workspace', () => {
  it('requires a server preview and exact local confirmation before retirement', async () => {
    vi.spyOn(api, 'backupAnnotations').mockResolvedValue({ data: [] })
    vi.spyOn(api, 'previewBackupRetention').mockResolvedValue({
      data: previewFixture(), meta: { executionEnabled: true }
    })
    const execute = vi.spyOn(api, 'executeBackupRetention').mockResolvedValue({
      data: { receipt: retirementFixture(), reused: false }
    })
    render(<SaveRetentionWorkspace backups={backups()} user={administrator()} />)

    fireEvent.click(await screen.findByRole('button', { name: '生成无写入预演' }))
    expect(await screen.findByText('预演已绑定当前清单')).toBeTruthy()
    expect(screen.queryByText(/尚未释放磁盘/)).toBeNull()
    const retire = screen.getByRole('button', { name: '退役选中备份' }) as HTMLButtonElement
    expect(retire.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('确认退役'), { target: { value: 'RETIRE' } })
    expect(retire.disabled).toBe(false)
    fireEvent.click(retire)

    expect(await screen.findByText('备份已进入私有退役区')).toBeTruthy()
    expect(screen.getByText(/尚未释放磁盘/)).toBeTruthy()
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      previewDigest: 'a'.repeat(64),
      referenceTime: previewFixture().referenceTime,
      policy: previewFixture().policy
    }), expect.any(AbortSignal))
  })

  it('uses the current annotation revision and rotates the request only after success', async () => {
    const annotation = annotationFixture()
    vi.spyOn(api, 'backupAnnotations').mockResolvedValue({ data: [annotation] })
    const update = vi.spyOn(api, 'setBackupAnnotation').mockImplementation(async (input) => ({
      data: {
        receipt: {
          schemaVersion: 1,
          operation: 'annotate',
          requestId: input.requestId,
          committedAt: '2026-08-31T12:05:00.000Z',
          annotation: { ...annotation, revision: 3, note: input.note, protected: input.protected }
        },
        reused: false
      }
    }))
    render(<SaveRetentionWorkspace backups={backups()} user={administrator()} />)

    const note = await screen.findByLabelText('备份备注')
    await waitFor(() => expect((note as HTMLInputElement).value).toBe('长期保留'))
    fireEvent.change(note, { target: { value: '大后期基线' } })
    fireEvent.click(screen.getByLabelText('保护此备份'))
    fireEvent.click(screen.getByRole('button', { name: '保存版本 3' }))

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      backupId: backups()[0]!.backupId,
      expectedRevision: 2,
      note: '大后期基线',
      protected: false
    }), expect.any(AbortSignal))
    expect(await screen.findByRole('button', { name: '保存版本 4' })).toBeTruthy()
  })

  it('shows an ineligible purge as a future gate and never enables irreversible execution', async () => {
    vi.spyOn(api, 'backupAnnotations').mockResolvedValue({ data: [] })
    vi.spyOn(api, 'previewBackupRetention').mockResolvedValue({
      data: previewFixture(), meta: { executionEnabled: true }
    })
    vi.spyOn(api, 'executeBackupRetention').mockResolvedValue({
      data: { receipt: retirementFixture(), reused: false }
    })
    vi.spyOn(api, 'previewRetiredBackupPurge').mockResolvedValue({
      data: purgePreviewFixture(false), meta: { executionEnabled: true }
    })
    const purge = vi.spyOn(api, 'purgeRetiredBackups')
    render(<SaveRetentionWorkspace backups={backups()} user={administrator()} />)

    fireEvent.click(await screen.findByRole('button', { name: '生成无写入预演' }))
    await screen.findByText('预演已绑定当前清单')
    fireEvent.change(screen.getByLabelText('确认退役'), { target: { value: 'RETIRE' } })
    fireEvent.click(screen.getByRole('button', { name: '退役选中备份' }))
    await screen.findByText('备份已进入私有退役区')
    fireEvent.click(screen.getByRole('button', { name: '生成永久清理预演' }))

    expect(await screen.findByText(/最早可清理/)).toBeTruthy()
    expect((screen.getByLabelText('确认永久清理') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '永久清理退役备份' }) as HTMLButtonElement).disabled)
      .toBe(true)
    expect(purge).not.toHaveBeenCalled()
  })

  it('keeps non-administrators read-only and locks all mutations after a fail-closed response', async () => {
    vi.spyOn(api, 'backupAnnotations').mockResolvedValue({ data: [] })
    const view = render(<SaveRetentionWorkspace backups={backups()} user={viewer()} />)
    expect(screen.getByText('ADMINISTRATOR ONLY')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '生成无写入预演' })).toBeNull()
    view.unmount()

    vi.spyOn(api, 'previewBackupRetention').mockRejectedValue(
      new ApiError(423, 'retention disabled', 'SAVE_RETENTION_MUTATIONS_DISABLED')
    )
    render(<SaveRetentionWorkspace backups={backups()} user={administrator()} />)
    fireEvent.click(await screen.findByRole('button', { name: '生成无写入预演' }))
    expect(await screen.findByText('FAIL-CLOSED')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('默认关闭')
    expect((screen.getByRole('button', { name: '生成无写入预演' }) as HTMLButtonElement).disabled)
      .toBe(true)
  })
})

function administrator(): SessionUser {
  return {
    name: 'fictional-admin',
    role: 'administrator',
    permissions: ['saves.read', 'saves.backup', 'saves.restore']
  }
}

function viewer(): SessionUser {
  return { name: 'fictional-viewer', role: 'viewer', permissions: ['saves.read'] }
}

function backups(): BackupCatalogItem[] {
  return [{
    schemaVersion: 1,
    backupId: 'tx-11111111-2222-4333-8444-555555555555',
    saveName: 'Fictional_Late_Game',
    createdAt: '2026-07-01T10:00:00.000Z',
    health: 'healthy',
    issues: [],
    manifestPresent: true,
    manifestValid: true,
    pairPresent: true,
    dsvBytes: 1024,
    serverBytes: 512,
    totalBytes: 1536
  }]
}

function annotationFixture(): BackupAnnotation {
  return {
    backupId: backups()[0]!.backupId,
    revision: 2,
    note: '长期保留',
    protected: true,
    updatedAt: '2026-08-31T12:00:00.000Z'
  }
}

function previewFixture(): BackupRetentionPreview {
  return {
    schemaVersion: 1,
    mode: 'dry-run',
    referenceTime: '2026-08-31T12:00:00.000Z',
    policy: {
      keepLastHealthy: 3,
      keepDailyDays: 14,
      keepWeeklyWeeks: 8,
      minimumHealthy: 2,
      allowUnhealthyDeletion: false
    },
    plan: {
      schemaVersion: 1,
      mode: 'dry-run',
      referenceTime: '2026-08-31T12:00:00.000Z',
      policy: {
        keepLastHealthy: 3,
        keepDailyDays: 14,
        keepWeeklyWeeks: 8,
        minimumHealthy: 2,
        allowUnhealthyDeletion: false
      },
      keep: [],
      delete: [{ backupId: backups()[0]!.backupId, reason: 'outside-policy' }],
      blocked: []
    },
    excluded: [],
    inventoryDigest: 'b'.repeat(64),
    previewDigest: 'a'.repeat(64)
  }
}

function retirementFixture(): BackupRetirementReceipt {
  return {
    schemaVersion: 1,
    operation: 'retire',
    requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    previewDigest: 'a'.repeat(64),
    committedAt: '2026-08-31T12:01:00.000Z',
    retired: [{
      backupId: backups()[0]!.backupId,
      saveName: 'Fictional_Late_Game',
      createdAt: '2026-07-01T10:00:00.000Z',
      health: 'healthy',
      totalBytes: 1536,
      evidenceDigest: 'c'.repeat(64)
    }],
    recoveryRequired: false
  }
}

function purgePreviewFixture(eligible: boolean): BackupRetentionPurgePreview {
  return {
    schemaVersion: 1,
    mode: 'dry-run',
    retirementRequestId: retirementFixture().requestId,
    eligibleAt: '2026-09-07T12:01:00.000Z',
    eligible,
    retiredBackupIds: [backups()[0]!.backupId],
    totalBytes: 1536,
    retirementReceiptDigest: 'd'.repeat(64),
    purgePreviewDigest: 'e'.repeat(64)
  }
}

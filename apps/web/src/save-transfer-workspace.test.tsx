// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SaveTransferWorkspace } from './SaveTransferWorkspace'
import { api, ApiError, SAVE_PAIR_PROMOTION_CONFIRMATION } from './api'
import type {
  BackupCatalogItem, SavePairExportReceipt, SavePairImportReceipt,
  SavePairPromotionPlan, SavePairPromotionReceipt, SessionUser
} from './model'

const originalCrypto = globalThis.crypto
const originalCreateObjectUrl = URL.createObjectURL
const originalRevokeObjectUrl = URL.revokeObjectURL
const fixedRequestId = '11111111-2222-4333-8444-555555555555'
const importedRequestId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const fixedSha256 = 'ab'.repeat(32)

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: originalCrypto })
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectUrl })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectUrl })
})

describe('save transfer workspace', () => {
  it('lets an authorized Administrator prepare and download only a verified backup', async () => {
    installDeterministicCrypto()
    const prepare = vi.spyOn(api, 'prepareSavePairExport').mockImplementation(async (requestId, backupId) => ({
      data: exportReceiptFixture(requestId, backupId)
    }))
    vi.spyOn(api, 'downloadSavePairExport').mockImplementation(async (requestId, receipt) => ({
      blob: new Blob(['fictional archive'], { type: 'application/vnd.dyson-control.save-pair' }),
      fileName: `dyson-save-${requestId}.dyson-save-pair`,
      sizeBytes: receipt.archiveBytes,
      sha256: receipt.archiveSha256
    }))
    const createObjectUrl = vi.fn(() => 'blob:fictional-save-pair')
    const revokeObjectUrl = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const view = render(<SaveTransferWorkspace backups={backupFixtures()} user={administrator()} />)

    const selector = await screen.findByRole('combobox', { name: '选择已验证导出备份' }) as HTMLSelectElement
    expect(selector.options).toHaveLength(2)
    expect(selector.value).toBe('fictional-backup-verified')
    expect(screen.queryByText('fictional-backup-corrupt')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '创建已验证导出' }))
    expect(await screen.findByText('EXPORT RECEIPT')).toBeTruthy()
    expect(prepare).toHaveBeenCalledWith(
      fixedRequestId,
      'fictional-backup-verified',
      expect.any(AbortSignal)
    )
    expect(screen.getByText(fixedSha256)).toBeTruthy()
    expect(screen.getByText('未执行')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '下载 .dyson-save-pair' }))
    expect(await screen.findByText(/已交给浏览器/)).toBeTruthy()
    expect(createObjectUrl).toHaveBeenCalledTimes(1)
    expect(click).toHaveBeenCalledTimes(1)
    expect((click.mock.instances[0] as unknown as HTMLAnchorElement).download).toBe(
      `dyson-save-${fixedRequestId}.dyson-save-pair`
    )

    view.unmount()
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:fictional-save-pair')
  })

  it('hashes one local .dyson-save-pair and publishes it only to quarantine/inbox', async () => {
    installDeterministicCrypto()
    const payload = new TextEncoder().encode('fictional imported save pair')
    const importArchive = vi.spyOn(api, 'importSavePairArchive').mockImplementation(
      async (requestId, receivedPayload, sha256) => ({
        data: importReceiptFixture(requestId, receivedPayload.byteLength, sha256)
      })
    )
    render(<SaveTransferWorkspace backups={backupFixtures()} user={administrator()} />)
    const file = new File([payload], 'fictional-transfer.dyson-save-pair', {
      type: 'application/vnd.dyson-control.save-pair'
    })
    Object.defineProperty(file, 'arrayBuffer', {
      configurable: true,
      value: vi.fn(async () => exactArrayBuffer(payload))
    })

    fireEvent.change(screen.getByLabelText('选择配对存档传输制品'), {
      target: { files: [file] }
    })
    expect(await screen.findByText('fictional-transfer.dyson-save-pair')).toBeTruthy()
    expect(screen.getByText(/浏览器内存 · 不落盘/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '校验并上传到隔离区' }))

    await waitFor(() => expect(importArchive).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('QUARANTINE RECEIPT')).toBeTruthy()
    const importCall = importArchive.mock.calls[0]
    expect(importCall?.[0]).toBe(fixedRequestId)
    expect(importCall?.[2]).toBe(fixedSha256)
    expect(importCall?.[3]?.aborted).toBe(false)
    const receivedPayload = importCall?.[1]
    expect(Object.prototype.toString.call(receivedPayload)).toBe('[object ArrayBuffer]')
    expect(Array.from(new Uint8Array(receivedPayload))).toEqual(Array.from(payload))
    expect(screen.getByText(`import-${fixedRequestId}`)).toBeTruthy()
    expect(screen.getByText(/已进入 quarantine\/inbox/)).toBeTruthy()
    expect(screen.getByText(/restoreExecuted=false/)).toBeTruthy()
    expect((screen.getByLabelText('隔离导入 request UUID') as HTMLInputElement).value).toBe(fixedRequestId)
    expect(screen.queryByRole('button', { name: /恢复/ })).toBeNull()
  })

  it('promotes a selected quarantine UUID only after preview, exact confirmation, and unchanged re-preview', async () => {
    const randomUuid = installDeterministicCrypto()
    const preview = vi.spyOn(api, 'previewSavePairPromotion').mockImplementation(async (requestId, importId) => ({
      data: promotionPlanFixture(requestId, importId)
    }))
    const execute = vi.spyOn(api, 'executeSavePairPromotion').mockImplementation(
      async (requestId, importId, confirmation) => {
        expect(confirmation).toBe(SAVE_PAIR_PROMOTION_CONFIRMATION)
        return { data: promotionReceiptFixture(requestId, importId) }
      }
    )
    render(<SaveTransferWorkspace backups={backupFixtures()} user={administrator()} />)
    const uuidCallsBeforePreview = randomUuid.mock.calls.length

    fireEvent.change(screen.getByLabelText('隔离导入 request UUID'), {
      target: { value: importedRequestId }
    })
    fireEvent.click(screen.getByRole('button', { name: '生成零写入晋升预演' }))

    expect(await screen.findByText('DRY-RUN · ZERO WRITE')).toBeTruthy()
    expect(randomUuid.mock.calls.length).toBeGreaterThan(uuidCallsBeforePreview)
    expect(preview).toHaveBeenCalledWith(fixedRequestId, importedRequestId, expect.any(AbortSignal))
    expect(screen.getByText(`tx-${fixedRequestId}`)).toBeTruthy()
    expect(screen.getByText(/canonical manifest/)).toBeTruthy()
    expect(screen.getAllByText(/LIVE SAVE 不变/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/INBOX 保留/).length).toBeGreaterThan(0)

    const executeButton = screen.getByRole('button', { name: '确认晋升为已验证保护点' }) as HTMLButtonElement
    expect(executeButton.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('输入存档晋升确认词'), {
      target: { value: SAVE_PAIR_PROMOTION_CONFIRMATION }
    })
    fireEvent.click(executeButton)

    expect(await screen.findByText('VERIFIED BACKUP RECEIPT')).toBeTruthy()
    expect(preview).toHaveBeenCalledTimes(2)
    expect(preview.mock.calls[1]?.slice(0, 2)).toEqual([fixedRequestId, importedRequestId])
    expect(execute).toHaveBeenCalledTimes(1)
    expect(screen.getByText('cd'.repeat(32))).toBeTruthy()
    expect(screen.getByText(/live save 未选择、未写入/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '准备下一次晋升' })).toBeTruthy()
  })

  it('clears confirmation and refuses execution when the required re-preview drifts', async () => {
    installDeterministicCrypto()
    const preview = vi.spyOn(api, 'previewSavePairPromotion')
      .mockImplementationOnce(async (requestId, importId) => ({
        data: promotionPlanFixture(requestId, importId)
      }))
      .mockImplementationOnce(async (requestId, importId) => ({
        data: promotionPlanFixture(requestId, importId, { availableBytes: 999_999 })
      }))
    const execute = vi.spyOn(api, 'executeSavePairPromotion')
    render(<SaveTransferWorkspace backups={backupFixtures()} user={administrator()} />)

    fireEvent.change(screen.getByLabelText('隔离导入 request UUID'), {
      target: { value: importedRequestId }
    })
    fireEvent.click(screen.getByRole('button', { name: '生成零写入晋升预演' }))
    await screen.findByText('DRY-RUN · ZERO WRITE')
    const confirmation = screen.getByLabelText('输入存档晋升确认词') as HTMLInputElement
    fireEvent.change(confirmation, { target: { value: SAVE_PAIR_PROMOTION_CONFIRMATION } })
    fireEvent.click(screen.getByRole('button', { name: '确认晋升为已验证保护点' }))

    expect(await screen.findByText(/预演证据已变化/)).toBeTruthy()
    expect(preview).toHaveBeenCalledTimes(2)
    expect(execute).not.toHaveBeenCalled()
    expect(confirmation.value).toBe('')
  })

  it('shows preview-only effects when execution is default-off', async () => {
    installDeterministicCrypto()
    vi.spyOn(api, 'previewSavePairPromotion').mockImplementation(async (requestId, importId) => ({
      data: promotionPlanFixture(requestId, importId, { executionEnabled: false })
    }))
    render(<SaveTransferWorkspace backups={backupFixtures()} user={administrator()} />)

    fireEvent.change(screen.getByLabelText('隔离导入 request UUID'), {
      target: { value: importedRequestId }
    })
    fireEvent.click(screen.getByRole('button', { name: '生成零写入晋升预演' }))

    expect(await screen.findByText('DEFAULT OFF')).toBeTruthy()
    expect(screen.getByText('执行默认关闭')).toBeTruthy()
    expect((screen.getByLabelText('输入存档晋升确认词') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '确认晋升为已验证保护点' }) as HTMLButtonElement).disabled)
      .toBe(true)
    expect(screen.getByText('quarantinePreserved=true')).toBeTruthy()
    expect(screen.getByText('liveSaveChanged=false')).toBeTruthy()
  })

  it.each([
    [403, 'AUTHORIZATION_DENIED'],
    [423, 'SAVE_PROMOTION_HOST_MUTATION_BLOCKED']
  ])('locks promotion after status %i without exposing another mutation path', async (status, code) => {
    installDeterministicCrypto()
    vi.spyOn(api, 'previewSavePairPromotion').mockRejectedValue(
      new ApiError(status, '服务端门禁拒绝晋升。', code)
    )
    render(<SaveTransferWorkspace backups={backupFixtures()} user={administrator()} />)

    fireEvent.change(screen.getByLabelText('隔离导入 request UUID'), {
      target: { value: importedRequestId }
    })
    fireEvent.click(screen.getByRole('button', { name: '生成零写入晋升预演' }))

    expect((await screen.findAllByText('FAIL-CLOSED')).length).toBeGreaterThan(0)
    expect(screen.getByRole('alert').textContent).toContain(code)
    expect((screen.getByRole('button', { name: '生成零写入晋升预演' }) as HTMLButtonElement).disabled)
      .toBe(true)
    expect(screen.getByText(/不会修改配置或绕过主机变更租约/)).toBeTruthy()
  })

  it('suppresses duplicate promotion previews before React commits the busy state', async () => {
    installDeterministicCrypto()
    let resolvePreview!: (value: { data: SavePairPromotionPlan }) => void
    const preview = vi.spyOn(api, 'previewSavePairPromotion').mockImplementation(
      (requestId, importId) => new Promise((resolve) => {
        resolvePreview = () => resolve({ data: promotionPlanFixture(requestId, importId) })
      })
    )
    render(<SaveTransferWorkspace backups={backupFixtures()} user={administrator()} />)
    fireEvent.change(screen.getByLabelText('隔离导入 request UUID'), {
      target: { value: importedRequestId }
    })
    const button = screen.getByRole('button', { name: '生成零写入晋升预演' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(preview).toHaveBeenCalledTimes(1)
    resolvePreview({ data: promotionPlanFixture(fixedRequestId, importedRequestId) })
    expect(await screen.findByText('DRY-RUN · ZERO WRITE')).toBeTruthy()
  })

  it.each([
    ['Viewer', viewer()],
    ['Operator', operator()],
    ['Administrator without permission', { ...administrator(), permissions: [] }]
  ])('keeps %s in a read-only explanation without file or mutation controls', (_label, user) => {
    render(<SaveTransferWorkspace backups={backupFixtures()} user={user} />)
    expect(screen.getByText('ADMINISTRATOR ONLY')).toBeTruthy()
    expect(screen.queryByLabelText('选择配对存档传输制品')).toBeNull()
    expect(screen.queryByRole('button', { name: /创建已验证导出/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /上传到隔离区/ })).toBeNull()
    expect(screen.getByText(/仅 Administrator 且拥有 saves.transfer 权限/)).toBeTruthy()
  })

  it.each([
    [403, 'AUTHORIZATION_DENIED'],
    [423, 'SAVE_TRANSFER_DISABLED'],
    [503, 'SAVE_TRANSFER_NOT_CONFIGURED']
  ])('locks every transfer action after server status %i', async (status, code) => {
    installDeterministicCrypto()
    vi.spyOn(api, 'prepareSavePairExport').mockRejectedValue(new ApiError(status, '服务端拒绝传输。', code))
    render(<SaveTransferWorkspace backups={backupFixtures()} user={administrator()} />)

    fireEvent.click(await screen.findByRole('button', { name: '创建已验证导出' }))
    expect((await screen.findAllByText('FAIL-CLOSED')).length).toBeGreaterThan(0)
    expect(screen.getByRole('alert').textContent).toContain(code)
    expect((screen.getByRole('button', { name: '创建已验证导出' }) as HTMLButtonElement).disabled)
      .toBe(true)
    expect((screen.getByRole('button', { name: '选择文件' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/不会改变后端配置/)).toBeTruthy()
  })

  it('cancels browser waiting and retries with the same idempotency request ID', async () => {
    installDeterministicCrypto()
    const requestIds: string[] = []
    let invocation = 0
    vi.spyOn(api, 'prepareSavePairExport').mockImplementation((requestId, backupId, signal) => {
      requestIds.push(requestId)
      invocation += 1
      if (invocation === 2) return Promise.resolve({ data: exportReceiptFixture(requestId, backupId) })
      return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => {
        reject(new DOMException('cancelled', 'AbortError'))
      }, { once: true }))
    })
    render(<SaveTransferWorkspace backups={backupFixtures()} user={administrator()} />)

    fireEvent.click(await screen.findByRole('button', { name: '创建已验证导出' }))
    fireEvent.click(await screen.findByRole('button', { name: '取消浏览器等待' }))
    expect(await screen.findByText(/同一 request ID，可安全幂等重试/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '创建已验证导出' }))
    expect(await screen.findByText('EXPORT RECEIPT')).toBeTruthy()
    expect(requestIds).toEqual([fixedRequestId, fixedRequestId])
  })

  it('rejects non-pair and oversized files before reading or uploading', async () => {
    installDeterministicCrypto()
    const importArchive = vi.spyOn(api, 'importSavePairArchive')
    render(<SaveTransferWorkspace backups={backupFixtures()} user={administrator()} />)
    const input = screen.getByLabelText('选择配对存档传输制品')
    const wrong = new File(['{}'], 'not-a-pair.zip', { type: 'application/zip' })
    Object.defineProperty(wrong, 'arrayBuffer', { configurable: true, value: vi.fn() })
    fireEvent.change(input, { target: { files: [wrong] } })
    expect(await screen.findByText(/只接受 \.dyson-save-pair 文件/)).toBeTruthy()

    const oversized = {
      name: 'oversized.dyson-save-pair',
      size: 16 * 1024 * 1024 * 1024 + 1,
      arrayBuffer: vi.fn()
    } as unknown as File
    fireEvent.change(input, { target: { files: [oversized] } })
    expect(await screen.findByText(/不超过 16 GiB/)).toBeTruthy()
    expect(oversized.arrayBuffer).not.toHaveBeenCalled()
    expect(importArchive).not.toHaveBeenCalled()
  })
})

function installDeterministicCrypto() {
  const randomUUID = vi.fn(() => fixedRequestId)
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      randomUUID,
      getRandomValues: vi.fn((bytes: Uint8Array) => bytes),
      subtle: {
        digest: vi.fn(async () => new Uint8Array(32).fill(0xab).buffer)
      }
    }
  })
  return randomUUID
}

function administrator(): SessionUser {
  return { name: 'fictional-admin', role: 'administrator', permissions: ['saves.transfer'] }
}

function operator(): SessionUser {
  return { name: 'fictional-operator', role: 'operator', permissions: ['status.read', 'saves.read'] }
}

function viewer(): SessionUser {
  return { name: 'fictional-viewer', role: 'viewer', permissions: ['status.read', 'saves.read'] }
}

function backupFixtures(): BackupCatalogItem[] {
  return [{
    schemaVersion: 1,
    backupId: 'fictional-backup-verified',
    saveName: 'fictional-cluster',
    createdAt: '2026-08-30T12:00:00.000Z',
    health: 'healthy',
    issues: [],
    manifestPresent: true,
    manifestValid: true,
    pairPresent: true,
    dsvBytes: 12,
    serverBytes: 13,
    totalBytes: 25
  }, {
    schemaVersion: 1,
    backupId: 'fictional-backup-corrupt',
    saveName: 'fictional-corrupt',
    createdAt: '2026-08-30T11:00:00.000Z',
    health: 'corrupt',
    issues: ['manifest-digest-mismatch'],
    manifestPresent: true,
    manifestValid: false,
    pairPresent: true,
    dsvBytes: 12,
    serverBytes: 13,
    totalBytes: 25
  }]
}

function exportReceiptFixture(requestId: string, requestedBackupId: string): SavePairExportReceipt {
  return {
    format: 'dyson-control-save-transfer-receipt',
    schemaVersion: 1,
    operation: 'export',
    requestId,
    backupId: requestedBackupId,
    archiveId: `export-${requestId}`,
    saveName: 'fictional-cluster',
    archiveBytes: 18,
    archiveSha256: fixedSha256,
    completedAt: '2026-08-30T12:10:00.000Z',
    restoreExecuted: false,
    reused: false
  }
}

function importReceiptFixture(requestId: string, archiveBytes: number, archiveSha256: string): SavePairImportReceipt {
  return {
    format: 'dyson-control-save-transfer-receipt',
    schemaVersion: 1,
    operation: 'import',
    requestId,
    inboxId: `import-${requestId}`,
    saveName: 'fictional-cluster',
    archiveBytes,
    archiveSha256,
    dsvBytes: 12,
    serverBytes: 13,
    completedAt: '2026-08-30T12:11:00.000Z',
    restoreExecuted: false,
    reused: false
  }
}

function promotionPlanFixture(
  requestId: string,
  importRequestId: string,
  overrides: Partial<SavePairPromotionPlan> = {}
): SavePairPromotionPlan {
  return {
    format: 'dyson-control-save-promotion-plan',
    schemaVersion: 1,
    mode: 'dry-run',
    requestId,
    importRequestId,
    inboxId: `import-${importRequestId}`,
    backupId: `tx-${requestId}`,
    saveName: 'fictional-cluster',
    sourceArchiveSha256: fixedSha256,
    dsvBytes: 12,
    serverBytes: 13,
    requiredBytes: 16_409,
    availableBytes: 1_000_000,
    allowed: true,
    blockers: [],
    reused: false,
    requiredConfirmation: SAVE_PAIR_PROMOTION_CONFIRMATION,
    effects: {
      quarantinePreserved: true,
      verifiedBackupCreated: true,
      liveSaveChanged: false,
      restoreExecuted: false
    },
    executionEnabled: true,
    ...overrides
  }
}

function promotionReceiptFixture(
  requestId: string,
  importRequestId: string
): SavePairPromotionReceipt {
  return {
    format: 'dyson-control-save-promotion-receipt',
    schemaVersion: 1,
    operation: 'promote-import',
    requestId,
    importRequestId,
    inboxId: `import-${importRequestId}`,
    backupId: `tx-${requestId}`,
    saveName: 'fictional-cluster',
    sourceArchiveSha256: fixedSha256,
    manifestSha256: 'cd'.repeat(32),
    dsvBytes: 12,
    serverBytes: 13,
    completedAt: '2026-09-01T00:00:00.000Z',
    restoreExecuted: false,
    reused: false
  }
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SaveTransferWorkspace } from './SaveTransferWorkspace'
import { api, ApiError } from './api'
import type {
  BackupCatalogItem, SavePairExportReceipt, SavePairImportReceipt, SessionUser
} from './model'

const originalCrypto = globalThis.crypto
const originalCreateObjectUrl = URL.createObjectURL
const originalRevokeObjectUrl = URL.revokeObjectURL
const fixedRequestId = '11111111-2222-4333-8444-555555555555'
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
    expect(screen.queryByRole('button', { name: /恢复/ })).toBeNull()
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
    expect(await screen.findByText('FAIL-CLOSED')).toBeTruthy()
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

function installDeterministicCrypto(): void {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      randomUUID: vi.fn(() => fixedRequestId),
      getRandomValues: vi.fn((bytes: Uint8Array) => bytes),
      subtle: {
        digest: vi.fn(async () => new Uint8Array(32).fill(0xab).buffer)
      }
    }
  })
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

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, sha256ArrayBuffer } from './api'
import type { SavePairExportReceipt, SavePairImportReceipt } from './model'

const exportRequestId = '11111111-2222-4333-8444-555555555555'
const importRequestId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const backupId = 'fictional-backup-0001'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('save pair transfer web client contract', () => {
  it('creates an export using only a UUID and a verified backup ID', async () => {
    const receipt = exportReceiptFixture(23, 'a'.repeat(64))
    const fetchMock = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json')
      expect(JSON.parse(String(init?.body))).toEqual({ requestId: exportRequestId, backupId })
      expect(String(init?.body)).not.toMatch(/(?:path|url|command|credential)/i)
      return jsonResponse({ data: receipt }, 201)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.prepareSavePairExport(exportRequestId, backupId)).resolves.toEqual({ data: receipt })
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/saves/transfers/exports', expect.objectContaining({
      method: 'POST', credentials: 'same-origin'
    }))
  })

  it('downloads the fixed media type and independently verifies length and SHA-256', async () => {
    const payload = new TextEncoder().encode('fictional dyson save pair')
    const payloadBuffer = exactArrayBuffer(payload)
    const sha256 = await sha256ArrayBuffer(payloadBuffer)
    const receipt = exportReceiptFixture(payload.byteLength, sha256)
    const fetchMock = vi.fn(async () => new Response(payload, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.dyson-control.save-pair',
        'Content-Disposition': `attachment; filename="dyson-save-${exportRequestId}.dspair"`,
        'Content-Length': String(payload.byteLength),
        'X-Dyson-Content-SHA256': sha256,
        'Cache-Control': 'private, no-store'
      }
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await api.downloadSavePairExport(exportRequestId, receipt)
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/saves/transfers/exports/${exportRequestId}`,
      expect.objectContaining({ credentials: 'same-origin' })
    )
    expect(result).toMatchObject({
      fileName: `dyson-save-${exportRequestId}.dyson-save-pair`,
      sizeBytes: payload.byteLength,
      sha256
    })
    expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(payload)
  })

  it('uploads a fixed Blob with UA-derived length and a digest header, accepting only quarantine', async () => {
    const payload = new TextEncoder().encode('fictional quarantined pair')
    const payloadBuffer = exactArrayBuffer(payload)
    const sha256 = await sha256ArrayBuffer(payloadBuffer)
    const receipt = importReceiptFixture(payload.byteLength, sha256)
    const fetchMock = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      expect(path).toBe(`/api/v1/saves/transfers/imports/${importRequestId}`)
      expect(init?.method).toBe('POST')
      expect(init?.credentials).toBe('same-origin')
      const headers = new Headers(init?.headers)
      expect(headers.get('Content-Type')).toBe('application/vnd.dyson-control.save-pair')
      expect(headers.has('Content-Length')).toBe(false)
      expect(headers.get('X-Dyson-Content-SHA256')).toBe(sha256)
      expect(init?.body).toBeInstanceOf(Blob)
      const body = init?.body as Blob
      expect(body.type).toBe('application/vnd.dyson-control.save-pair')
      expect(new Uint8Array(await body.arrayBuffer())).toEqual(payload)
      return jsonResponse({ data: receipt }, 201)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.importSavePairArchive(importRequestId, payloadBuffer, sha256)).resolves.toEqual({
      data: receipt
    })
    expect(receipt.restoreExecuted).toBe(false)
    expect(receipt.inboxId).toBe(`import-${importRequestId}`)
  })

  it('rejects an invalid download response and preserves a fail-closed server status', async () => {
    const receipt = exportReceiptFixture(4, 'a'.repeat(64))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': '4',
        'X-Dyson-Content-SHA256': receipt.archiveSha256,
        'Content-Disposition': `attachment; filename="dyson-save-${exportRequestId}.dspair"`,
        'Cache-Control': 'no-store'
      }
    })))

    await expect(api.downloadSavePairExport(exportRequestId, receipt)).rejects.toMatchObject({
      status: 502,
      code: 'SAVE_TRANSFER_DOWNLOAD_RESPONSE_INVALID'
    })

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      error: { code: 'SAVE_TRANSFER_DISABLED', message: '存档跨机器传输默认关闭。' }
    }, 423)))
    const error = await api.prepareSavePairExport(exportRequestId, backupId)
      .then(() => null, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 423, code: 'SAVE_TRANSFER_DISABLED' })
  })
})

function exportReceiptFixture(archiveBytes: number, archiveSha256: string): SavePairExportReceipt {
  return {
    format: 'dyson-control-save-transfer-receipt',
    schemaVersion: 1,
    operation: 'export',
    requestId: exportRequestId,
    backupId,
    archiveId: `export-${exportRequestId}`,
    saveName: 'fictional-cluster',
    archiveBytes,
    archiveSha256,
    completedAt: '2026-08-30T12:00:00.000Z',
    restoreExecuted: false,
    reused: false
  }
}

function importReceiptFixture(archiveBytes: number, archiveSha256: string): SavePairImportReceipt {
  return {
    format: 'dyson-control-save-transfer-receipt',
    schemaVersion: 1,
    operation: 'import',
    requestId: importRequestId,
    inboxId: `import-${importRequestId}`,
    saveName: 'fictional-cluster',
    archiveBytes,
    archiveSha256,
    dsvBytes: 12,
    serverBytes: 13,
    completedAt: '2026-08-30T12:01:00.000Z',
    restoreExecuted: false,
    reused: false
  }
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function jsonResponse(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

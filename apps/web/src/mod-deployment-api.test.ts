import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import type { ModDeploymentReceipt, ModDeploymentReceiptHistoryPage } from './model'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('mod deployment receipt web client', () => {
  it('reads the exact receipt route without sending host or transport fields', async () => {
    const receipt = receiptFixture()
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ data: receipt }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.modDeploymentReceipt(receipt.requestId)).resolves.toEqual({ data: receipt })
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/mods/deployment/receipts/${receipt.requestId}`,
      expect.objectContaining({ credentials: 'same-origin' })
    )
    const [path, init] = fetchMock.mock.calls[0]!
    expect(String(path)).not.toMatch(/(?:pluginsRoot|stagingRoot|hostPath|command|secret|token)/i)
    expect(init?.body).toBeUndefined()
  })

  it('encodes only the opaque cursor and bounded page size for durable history', async () => {
    const cursor = 'MjAyNi0wOC0zMFQxMDowMDowMC4wMDBaCjExMTExMTExLTExMTEtNDExMS04MTExLTExMTExMTExMTExMQ'
    const history = historyFixture()
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ data: history }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.modDeploymentHistory({ cursor, pageSize: 8 })).resolves.toEqual({ data: history })
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/mods/deployment/history?cursor=${encodeURIComponent(cursor)}&pageSize=8`,
      expect.objectContaining({ credentials: 'same-origin' })
    )
  })

  it('omits the query string when no pagination arguments are supplied', async () => {
    const history = historyFixture()
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ data: history }))
    vi.stubGlobal('fetch', fetchMock)

    await api.modDeploymentHistory()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/mods/deployment/history',
      expect.objectContaining({ credentials: 'same-origin' })
    )
  })
})

function receiptFixture(): ModDeploymentReceipt {
  return {
    format: 'dyson-control-mod-deployment-receipt',
    schemaVersion: 1,
    requestId: '11111111-1111-4111-8111-111111111111',
    operation: 'install',
    package: { dependencyId: 'Fictional-ModConsole-1.0.0', version: '1.0.0' },
    status: 'succeeded',
    previousRevision: '0'.repeat(64),
    newRevision: '1'.repeat(64),
    rollback: 'not-needed',
    recoveryPointCreated: true,
    recoverablePayloadPreserved: false,
    payloadFileCount: 2,
    payloadSizeBytes: 4096,
    errorCode: null,
    reused: false
  }
}

function historyFixture(): ModDeploymentReceiptHistoryPage {
  return {
    format: 'dyson-control-mod-deployment-receipt-history',
    schemaVersion: 1,
    order: 'persisted-at-descending',
    items: [{ persistedAt: '2026-08-30T10:00:00.000Z', receipt: receiptFixture() }],
    page: { limit: 8, returned: 1, totalReceipts: 1, nextCursor: null }
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

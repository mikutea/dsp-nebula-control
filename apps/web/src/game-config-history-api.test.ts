import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, GameConfigHistoryApiError } from './api'
import {
  configHistoryCurrentRevision,
  configHistoryDiffFixture,
  configHistoryDryRunReceiptFixture,
  configHistoryRecoveryFixture,
  configHistoryRequestId,
  configHistorySnapshotFixture,
  configHistorySnapshotId,
  configHistorySummaryFixture
} from './game-config-history.fixture'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('game configuration history web client contract', () => {
  it('reads the current configuration revision with an explicit no-store request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      data: { revision: configHistoryCurrentRevision, entries: [], invalidSettingIds: [] }
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.configuration()).resolves.toEqual({
      data: { revision: configHistoryCurrentRevision, entries: [], invalidSettingIds: [] }
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/configuration', expect.objectContaining({
      credentials: 'same-origin',
      cache: 'no-store'
    }))
  })

  it('reads list, fixed snapshot detail, diff, and restore preview without query input', async () => {
    const responses = [
      [configHistorySummaryFixture()],
      configHistorySnapshotFixture(),
      configHistoryDiffFixture(),
      configHistoryDiffFixture()
    ]
    const fetchMock = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.credentials).toBe('same-origin')
      expect(init?.cache).toBe('no-store')
      return jsonResponse({ ok: true, data: responses.shift() })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.gameConfigHistory()).resolves.toEqual({ data: [configHistorySummaryFixture()] })
    await expect(api.gameConfigHistoryDetail(configHistorySnapshotId)).resolves.toEqual({
      data: configHistorySnapshotFixture()
    })
    await expect(api.gameConfigHistoryDiff(configHistorySnapshotId)).resolves.toEqual({
      data: configHistoryDiffFixture()
    })
    await expect(api.gameConfigHistoryRestorePreview(configHistorySnapshotId)).resolves.toEqual({
      data: configHistoryDiffFixture()
    })
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/v1/game-config/history',
      `/api/v1/game-config/history/${configHistorySnapshotId}`,
      `/api/v1/game-config/history/${configHistorySnapshotId}/diff`,
      `/api/v1/game-config/history/${configHistorySnapshotId}/restore-preview`
    ])
  })

  it('sends only fixed mutation fields and operation-specific confirmations', async () => {
    const fetchMock = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json')
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(JSON.stringify(body)).not.toMatch(/stopProofToken|path|url|command/i)
      if (String(path).endsWith('/capture')) {
        expect(body).toEqual({ confirmation: 'CREATE_CONFIG_SNAPSHOT' })
        return jsonResponse({ ok: true, data: configHistorySnapshotFixture() }, 201)
      }
      if (String(path).endsWith('/restore')) {
        expect(body).toEqual({
          requestId: configHistoryRequestId,
          snapshotId: configHistorySnapshotId,
          expectedCurrentRevision: configHistoryCurrentRevision,
          dryRun: true,
          confirmation: 'RESTORE_CONFIG_SNAPSHOT'
        })
        return jsonResponse({ ok: true, data: configHistoryDryRunReceiptFixture() })
      }
      expect(body).toEqual({ confirmation: 'RECONCILE_CONFIG_RESTORE' })
      return jsonResponse({ ok: true, data: configHistoryRecoveryFixture() })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.captureGameConfigHistory()).resolves.toEqual({ data: configHistorySnapshotFixture() })
    await expect(api.restoreGameConfigHistory(
      configHistoryRequestId,
      configHistorySnapshotId,
      configHistoryCurrentRevision,
      true
    )).resolves.toEqual({ data: configHistoryDryRunReceiptFixture() })
    await expect(api.reconcileGameConfigHistory()).resolves.toEqual({
      data: configHistoryRecoveryFixture()
    })
  })

  it('rejects non-UUID snapshot and request identifiers before fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.gameConfigHistoryDetail('../snapshot')).rejects.toMatchObject({
      status: 400,
      code: 'CONFIG_HISTORY_CLIENT_REQUEST_INVALID'
    })
    await expect(api.restoreGameConfigHistory(
      'not-a-uuid',
      configHistorySnapshotId,
      configHistoryCurrentRevision,
      true
    )).rejects.toMatchObject({ status: 400, code: 'CONFIG_HISTORY_CLIENT_REQUEST_INVALID' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects extra response fields and unredacted setting values', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      ok: true,
      data: {
        ...configHistoryDiffFixture(),
        settings: [{
          ...configHistoryDiffFixture().settings[0],
          before: 'fictional-raw-secret'
        }]
      },
      untrusted: true
    })))

    await expect(api.gameConfigHistoryDiff(configHistorySnapshotId)).rejects.toMatchObject({
      status: 502,
      code: 'CONFIG_HISTORY_RESPONSE_INVALID'
    })

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      ok: true,
      data: {
        ...configHistoryDiffFixture(),
        settings: [{
          ...configHistoryDiffFixture().settings[0],
          before: 'fictional-raw-secret'
        }]
      }
    })))
    const error = await api.gameConfigHistoryDiff(configHistorySnapshotId)
      .then(() => null, (reason: unknown) => reason)
    expect(error).toMatchObject({ status: 502, code: 'CONFIG_HISTORY_RESPONSE_INVALID' })
    expect(String((error as Error).message)).not.toContain('fictional-raw-secret')
  })

  it('preserves a validated revision-conflict receipt while returning a fixed error', async () => {
    const rejected = {
      ...configHistoryDryRunReceiptFixture(),
      dryRun: false,
      status: 'rejected' as const,
      errorCode: 'CONFIG_HISTORY_REVISION_CONFLICT' as const,
      persisted: true
    }
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      ok: false,
      error: { code: 'CONFIG_HISTORY_REVISION_CONFLICT' },
      data: rejected
    }, 409)))

    const error = await api.restoreGameConfigHistory(
      configHistoryRequestId,
      configHistorySnapshotId,
      configHistoryCurrentRevision,
      false
    ).then(() => null, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(GameConfigHistoryApiError)
    expect(error).toMatchObject({
      status: 409,
      code: 'CONFIG_HISTORY_REVISION_CONFLICT',
      message: '当前配置 revision 已变化；必须重新读取、预演并执行 dry-run。',
      data: rejected
    })

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      ok: false,
      error: { code: 'CONFIG_HISTORY_REVISION_CONFLICT' },
      data: { ...rejected, requestId: '038f47a0-7d5b-4abc-8def-0123456789ab' }
    }, 409)))
    await expect(api.restoreGameConfigHistory(
      configHistoryRequestId,
      configHistorySnapshotId,
      configHistoryCurrentRevision,
      false
    )).rejects.toMatchObject({ status: 502, code: 'CONFIG_HISTORY_RESPONSE_INVALID' })
  })

  it('maps authentication failures without reflecting application error text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      error: { code: 'AUTH_REQUIRED', message: 'untrusted server detail' }
    }, 401)))

    const error = await api.gameConfigHistory().then(() => null, (reason: unknown) => reason)
    expect(error).toMatchObject({
      status: 401,
      code: 'AUTH_REQUIRED',
      message: '配置历史需要重新建立认证会话。'
    })
    expect(String((error as Error).message)).not.toContain('untrusted server detail')
  })
})

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

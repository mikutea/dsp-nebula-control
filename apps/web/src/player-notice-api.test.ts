import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, PlayerNoticeApiError } from './api'

const input = {
  rosterGeneration: `roster-v1:${'a'.repeat(64)}`,
  rosterSequence: 7,
  sessionPlayerId: 'player-000002',
  templateId: 'maintenance-5m' as const
}
const requestId = '44444444-5555-4666-8777-888888888888'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('player notice web API', () => {
  it('reads one original receipt without cache and validates its full identity', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: { receipt: receipt() } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.playerNoticeReceipt({ ...input, requestId })).resolves.toEqual({
      data: { receipt: receipt() }
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/players/notice/receipts/${requestId}`,
      expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' })
    )
  })

  it('keeps 404 and response drift fail-closed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      error: { code: 'PLAYER_NOTICE_RECEIPT_NOT_FOUND', message: 'not found' }
    }, 404)))
    await expect(api.playerNoticeReceipt({ ...input, requestId })).rejects.toMatchObject({
      status: 404, code: 'PLAYER_NOTICE_RECEIPT_NOT_FOUND'
    } satisfies Partial<ApiError>)

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      data: { receipt: { ...receipt(), rosterSequence: 8 } }
    })))
    await expect(api.playerNoticeReceipt({ ...input, requestId })).rejects.toMatchObject({
      status: 502, code: 'PLAYER_NOTICE_BROWSER_RESPONSE_INVALID'
    } satisfies Partial<ApiError>)
  })

  it('preserves a validated terminal receipt on non-2xx and rejects malformed success', async () => {
    const terminal = receipt()
    const fetchMock = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      expect(Object.keys(JSON.parse(String(init?.body))).sort()).toEqual([
        'confirmation', 'requestId', 'rosterGeneration', 'rosterSequence', 'sessionPlayerId', 'templateId'
      ])
      expect(String(init?.body)).not.toContain('expectedTargetJoinedAtUnixMs')
      return jsonResponse({ data: {
        job: job({ state: 'failed', errorCode: terminal.errorCode }), receipt: terminal
      } }, 503)
    })
    vi.stubGlobal('fetch', fetchMock)
    const expectedTargetJoinedAtUnixMs = Date.parse(terminal.targetJoinedAt)
    const failure = await api.executePlayerNotice({
      ...input, requestId, confirmation: 'EXECUTE', expectedTargetJoinedAtUnixMs
    })
      .then(() => null, (reason: unknown) => reason)
    expect(failure).toBeInstanceOf(PlayerNoticeApiError)
    expect(failure).toMatchObject({ status: 503, code: 'PLAYER_NOTICE_OUTCOME_UNKNOWN' })
    expect((failure as PlayerNoticeApiError).data?.receipt).toEqual(terminal)

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: {
      job: job(), receipt: { ...terminal, requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }
    } })))
    await expect(api.executePlayerNotice({ ...input, requestId, confirmation: 'EXECUTE' }))
      .rejects.toMatchObject({ status: 502, code: 'PLAYER_NOTICE_BROWSER_RESPONSE_INVALID' })

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: {
      job: job({ state: 'failed', errorCode: terminal.errorCode }), receipt: terminal
    } }, 503)))
    await expect(api.executePlayerNotice({
      ...input,
      requestId,
      confirmation: 'EXECUTE',
      expectedTargetJoinedAtUnixMs: expectedTargetJoinedAtUnixMs + 1
    })).rejects.toMatchObject({ status: 502, code: 'PLAYER_NOTICE_BROWSER_RESPONSE_INVALID' })
  })
})

function receipt() {
  return {
    requestId, action: 'player.notice' as const, state: 'uncertain' as const,
    startedAt: '2026-08-30T10:05:01.000Z', finishedAt: '2026-08-30T10:05:21.000Z',
    ...input, targetJoinedAt: '2026-08-30T09:46:00.000Z',
    mutationMayHaveOccurred: true, recoveryRequired: true,
    rollback: { strategy: 'not-possible' as const, summary: '请求可能已进入传输层。' },
    errorCode: 'PLAYER_NOTICE_OUTCOME_UNKNOWN'
  }
}

function job(patch: Record<string, unknown> = {}) {
  return {
    id: '22222222-3333-4444-8555-666666666666', kind: 'player.notice', state: 'succeeded',
    actor: 'administrator', createdAt: '2026-08-30T10:05:00.000Z',
    startedAt: '2026-08-30T10:05:00.001Z', finishedAt: '2026-08-30T10:05:00.010Z',
    durationMs: 9, summary: 'Fictional player notice result', errorCode: null,
    ...patch
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

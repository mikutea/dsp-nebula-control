import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('observability alert web client contract', () => {
  it('reads the bounded projection without browser caching', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      data: {
        schemaVersion: 1,
        kind: 'observability-alert-episode-projection',
        observedThrough: null,
        capacity: 256,
        resolveAfterMissingSamples: 3,
        episodes: []
      },
      meta: { recoveryRequired: false }
    }))
    vi.stubGlobal('fetch', fetchMock)

    await api.observabilityAlerts()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/observability/alerts',
      expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' })
    )
  })

  it('acknowledges only one encoded episode with a fixed confirmation', async () => {
    const fetchMock = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ confirmation: 'ACKNOWLEDGE_ALERT' })
      expect(String(init?.body)).not.toMatch(/actor|time|path|metric|message|source/i)
      return jsonResponse({ data: {} })
    })
    vi.stubGlobal('fetch', fetchMock)

    await api.acknowledgeObservabilityAlert('alert:1/unsafe')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/observability/alerts/alert%3A1%2Funsafe/acknowledge',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' })
    )
  })

  it('preserves a recovery-required refusal as an API error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      error: {
        code: 'OBSERVABILITY_ALERT_PERSISTENCE_RECOVERY_REQUIRED',
        message: 'alert persistence requires reconciliation'
      }
    }, 503)))

    const error = await api.acknowledgeObservabilityAlert('alert-000001-HOST_CPU_PRESSURE')
      .then(() => null, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      status: 503,
      code: 'OBSERVABILITY_ALERT_PERSISTENCE_RECOVERY_REQUIRED'
    })
  })
})

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

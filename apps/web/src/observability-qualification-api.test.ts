import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'
import {
  makeQualificationInsufficient, qualificationEnvelopeFixture
} from './observability-qualification.fixture'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('observability qualification web client contract', () => {
  it('reads the authenticated fixed route and accepts only the exact report envelope', async () => {
    const fixture = qualificationEnvelopeFixture()
    const controller = new AbortController()
    const fetchMock = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      expect(path).toBe('/api/v1/observability/qualification')
      expect(init?.credentials).toBe('same-origin')
      expect(init?.signal).toBe(controller.signal)
      return jsonResponse(fixture)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.observabilityQualification(controller.signal)).resolves.toEqual(fixture)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects unknown envelope fields instead of widening the public contract', async () => {
    const fixture = qualificationEnvelopeFixture()
    const malformed = {
      ...fixture,
      meta: { ...fixture.meta, untrustedHostPath: 'fictional-value' }
    }
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(malformed)))

    await expect(api.observabilityQualification()).rejects.toMatchObject({
      status: 502,
      code: 'OBSERVABILITY_QUALIFICATION_RESPONSE_INVALID'
    })
  })

  it('rejects an unavailable metric falsely labeled as pass', async () => {
    const fixture = qualificationEnvelopeFixture()
    const check = fixture.data.checks.find(({ id }) => id === 'simulation.ups-floor')!
    check.observed = { value: null, p05: null, median: null }
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(fixture)))

    await expect(api.observabilityQualification()).rejects.toMatchObject({
      status: 502,
      code: 'OBSERVABILITY_QUALIFICATION_RESPONSE_INVALID'
    })
  })

  it('rejects overall pass when any fixed check has insufficient evidence', async () => {
    const fixture = makeQualificationInsufficient(
      qualificationEnvelopeFixture(),
      'host.per-core-coverage'
    )
    fixture.data.result = 'pass'
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(fixture)))

    await expect(api.observabilityQualification()).rejects.toMatchObject({
      status: 502,
      code: 'OBSERVABILITY_QUALIFICATION_RESPONSE_INVALID'
    })
  })

  it('maps unavailable service responses to a fixed non-reflective failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      error: {
        code: 'OBSERVABILITY_QUALIFICATION_UNAVAILABLE',
        message: 'untrusted reflected input must never reach the operator'
      }
    }, 503)))

    const error = await api.observabilityQualification().then(() => null, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      status: 503,
      code: 'OBSERVABILITY_QUALIFICATION_UNAVAILABLE',
      message: '观测资格报告暂不可用；最后可信报告保持只读。'
    })
    expect(String((error as Error).message)).not.toContain('untrusted reflected input')
  })
})

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

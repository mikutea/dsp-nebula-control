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
    expect(fixture.data.checks.map(({ id }) => id).slice(4, 8)).toEqual([
      'simulation.ups-coverage', 'simulation.ups-floor',
      'simulation.tps-coverage', 'simulation.tps-floor'
    ])
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

  it('rejects unavailable actual TPS evidence falsely labeled as pass', async () => {
    const fixture = qualificationEnvelopeFixture()
    const check = fixture.data.checks.find(({ id }) => id === 'simulation.tps-floor')!
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

  it('rejects a 72-hour pass without a verified chain', async () => {
    const fixture = qualificationEnvelopeFixture()
    fixture.data.continuity72h.chainIntegrity = 'unknown'
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(fixture)))

    await expect(api.observabilityQualification()).rejects.toMatchObject({
      status: 502,
      code: 'OBSERVABILITY_QUALIFICATION_RESPONSE_INVALID'
    })
  })

  it('rejects 72-hour checks that are not bound to the reported sample count and span', async () => {
    for (const id of ['window.samples', 'window.duration'] as const) {
      const fixture = qualificationEnvelopeFixture()
      const check = fixture.data.continuity72h.checks.find((candidate) => candidate.id === id)!
      check.observed.value = (check.observed.value as number) + 1
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(fixture)))

      await expect(api.observabilityQualification()).rejects.toMatchObject({
        status: 502,
        code: 'OBSERVABILITY_QUALIFICATION_RESPONSE_INVALID'
      })
    }
  })

  it('rejects inconsistent latency truncation metadata', async () => {
    const fixture = qualificationEnvelopeFixture()
    fixture.data.latency.truncated = true
    fixture.data.latency.evidenceStatus = 'unknown'
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(fixture)))

    await expect(api.observabilityQualification()).rejects.toMatchObject({
      status: 502,
      code: 'OBSERVABILITY_QUALIFICATION_RESPONSE_INVALID'
    })
  })

  it('rejects manufactured zero latency when there is no successful trusted receipt', async () => {
    const fixture = qualificationEnvelopeFixture()
    fixture.data.latency.save.successfulReceipts = 0
    fixture.data.latency.save.failedReceipts = 5
    fixture.data.latency.save.p50Ms = 0
    fixture.data.latency.save.p95Ms = 0
    fixture.data.latency.save.maximumMs = 0
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

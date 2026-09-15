import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'
import type {
  ArtifactAcquisitionCandidate,
  ArtifactAcquisitionPlan,
  ArtifactAcquisitionReceipt,
  NebulaDiscoveryEnvelope
} from './model'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('managed artifact acquisition web client', () => {
  it('preserves strict discovery acquisition metadata without submitting a provider URL', async () => {
    const envelope = discoveryEnvelope()
    const fetchMock = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({})
      return jsonResponse(envelope, 200)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.discoverNebula()).resolves.toEqual(envelope)
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/updates/discovery/nebula', expect.objectContaining({
      method: 'POST', credentials: 'same-origin'
    }))
  })

  it('submits only opaque IDs plus the fixed acquisition confirmation and accepts 201 or replay 200', async () => {
    const candidate = candidateFixture()
    const requestId = '11111111-1111-4111-8111-111111111111'
    const fetchMock = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      if (String(path).endsWith('/preview')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        expect(body).toEqual({ candidateId: candidate.candidateId })
        expectNoTransportFields(body)
        return jsonResponse({ ok: true, data: planFixture() }, 200)
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(body).toEqual({
        requestId,
        candidateId: candidate.candidateId,
        confirmation: 'ACQUIRE_UPDATE_ARTIFACT'
      })
      expectNoTransportFields(body)
      return jsonResponse({ ok: true, data: receiptFixture(true) }, 200)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.previewArtifactAcquisition(candidate.candidateId)).resolves.toEqual({ data: planFixture() })
    await expect(api.executeArtifactAcquisition(requestId, candidate.candidateId)).resolves.toEqual({
      data: receiptFixture(true)
    })
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/v1/updates/acquisition/execute', expect.objectContaining({
      method: 'POST', credentials: 'same-origin'
    }))
  })

  it('queries one encoded receipt ID and maps the default-off 423 to an explicit fail-closed error', async () => {
    const requestId = '11111111-1111-4111-8111-111111111111'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: receiptFixture(false) }, 200))
      .mockResolvedValueOnce(jsonResponse({
        ok: false,
        error: { code: 'UPDATE_ACQUISITION_MUTATION_DISABLED' }
      }, 423))
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.artifactAcquisitionReceipt(requestId)).resolves.toEqual({ data: receiptFixture(false) })
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/api/v1/updates/acquisition/receipts/${requestId}`,
      expect.objectContaining({ credentials: 'same-origin' })
    )

    const error = await api.executeArtifactAcquisition(requestId, candidateFixture().candidateId)
      .then(() => null, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      status: 423,
      code: 'UPDATE_ACQUISITION_MUTATION_DISABLED',
      message: '制品获取门禁为 fail-closed；当前只允许发现、查看与预演。'
    })
  })
})

function expectNoTransportFields(body: Record<string, unknown>): void {
  expect(JSON.stringify(body)).not.toMatch(
    /"(?:url|path|command|executable|credential|archive|zip|downloadUrl|sha256)"\s*:/i
  )
}

function discoveryEnvelope(): NebulaDiscoveryEnvelope {
  const candidate = candidateFixture()
  return {
    data: {
      items: [{
        provider: 'github', sourceId: 'github:NebulaModTeam/nebula', releaseId: 1001,
        version: candidate.release.version, publishedAt: '2026-08-30T01:00:00.000Z', prerelease: false,
        artifact: {
          ...candidate.artifact,
          downloadUrl: 'https://github.com/NebulaModTeam/nebula/releases/download/v0.9.23/Nebula.zip'
        }
      }],
      pagesFetched: 1,
      truncated: false
    },
    meta: {
      acquisition: {
        configured: true,
        executionEnabled: true,
        candidates: [{
          artifactId: candidate.artifact.artifactId,
          eligible: true,
          status: 'registered',
          candidate
        }]
      }
    }
  }
}

function candidateFixture(): ArtifactAcquisitionCandidate {
  return {
    candidateId: `candidate-${'a'.repeat(48)}`,
    provider: 'github',
    release: { kind: 'nebula', sourceId: 'github:NebulaModTeam/nebula', version: '0.9.23' },
    artifact: {
      artifactId: `artifact-${'b'.repeat(40)}`,
      fileName: 'Nebula.zip',
      sizeBytes: 4096,
      sha256: 'c'.repeat(64),
      integrity: 'provider-sha256'
    },
    expiresAt: '2099-08-31T08:00:00.000Z'
  }
}

function planFixture(): ArtifactAcquisitionPlan {
  return {
    format: 'dyson-control-artifact-acquisition-plan',
    schemaVersion: 1,
    dryRun: true,
    candidate: candidateFixture(),
    operations: [
      'load-server-registered-candidate',
      'acquire-exclusive-request-and-artifact-locks',
      'download-from-bound-provider',
      'stream-size-and-sha256-verification',
      'atomically-publish-fixed-inbox-artifact',
      'persist-acquisition-receipt',
      'release-exclusive-locks'
    ],
    staging: { automatic: false, nextAction: 'offline-artifact-staging' }
  }
}

function receiptFixture(reused: boolean): ArtifactAcquisitionReceipt {
  const candidate = candidateFixture()
  return {
    format: 'dyson-control-artifact-acquisition-receipt',
    schemaVersion: 1,
    requestId: '11111111-1111-4111-8111-111111111111',
    candidateId: candidate.candidateId,
    provider: candidate.provider,
    release: candidate.release,
    artifact: {
      artifactId: candidate.artifact.artifactId,
      fileName: candidate.artifact.fileName,
      sizeBytes: candidate.artifact.sizeBytes!,
      sha256: candidate.artifact.sha256!,
      integrity: 'provider-verified'
    },
    state: 'acquired',
    reused,
    acquiredAt: '2026-08-30T08:00:00.000Z'
  }
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

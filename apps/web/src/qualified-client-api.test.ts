import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'

const downloadId = '20000000-0000-0000-0000-000000000002'
const digest = 'a'.repeat(64)

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('qualified client profile API', () => {
  it('uses the exact issue request and binds each download to its receipt metadata', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { downloadId } }))
      .mockResolvedValueOnce(artifactResponse('dyson-qualified-client-profile.zip', 'application/zip'))
      .mockResolvedValueOnce(artifactResponse('dyson-qualified-nebula-client.zip', 'application/zip'))
      .mockResolvedValueOnce(artifactResponse('qualified-client-runtime.json', 'application/json'))
    vi.stubGlobal('fetch', fetchMock)

    const qualificationId = '10000000-0000-0000-0000-000000000001'
    await api.issueQualifiedClientProfile({ schemaVersion: 2, qualificationId })
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/v2/client-profile/issue', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ schemaVersion: 2, qualificationId })
    }))

    for (const kind of ['profile', 'client', 'runtime'] as const) {
      const result = await api.downloadQualifiedClientArtifact(downloadId, kind, {
        sha256: `sha256:${digest}`,
        sizeBytes: 3
      })
      expect(result).toMatchObject({ kind, sizeBytes: 3, sha256: digest })
    }
    expect(fetchMock.mock.calls.slice(1).map(([url]) => url)).toEqual([
      `/api/v2/client-profile/archive/${downloadId}`,
      `/api/v2/client-profile/client/${downloadId}`,
      `/api/v2/client-profile/runtime/${downloadId}`
    ])
  })

  it('rejects status errors and any response that drifts from the issued receipt', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({
      error: { code: 'QUALIFIED_CLIENT_ARTIFACT_UNAVAILABLE', message: '客户端制品不可用' }
    }, 404)))
    await expect(api.downloadQualifiedClientArtifact(downloadId, 'profile', {
      sha256: `sha256:${digest}`, sizeBytes: 3
    })).rejects.toMatchObject({ status: 404, code: 'QUALIFIED_CLIENT_ARTIFACT_UNAVAILABLE' } satisfies Partial<ApiError>)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(artifactResponse(
      'dyson-qualified-client-profile.zip', 'application/zip', 'b'.repeat(64)
    )))
    await expect(api.downloadQualifiedClientArtifact(downloadId, 'profile', {
      sha256: `sha256:${digest}`, sizeBytes: 3
    })).rejects.toMatchObject({
      status: 502,
      code: 'QUALIFIED_CLIENT_ARTIFACT_RESPONSE_INVALID'
    } satisfies Partial<ApiError>)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="dyson-qualified-client-profile.zip"',
        'Content-Length': '3',
        'X-Dyson-Content-SHA256': digest,
        'X-Content-Type-Options': 'nosniff'
      }
    })))
    await expect(api.downloadQualifiedClientArtifact(downloadId, 'profile', {
      sha256: `sha256:${digest}`, sizeBytes: 3
    })).rejects.toMatchObject({ code: 'QUALIFIED_CLIENT_ARTIFACT_RESPONSE_INVALID' })
  })
})

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function artifactResponse(fileName: string, mediaType: string, sha256 = digest): Response {
  return new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: {
      'Content-Type': mediaType,
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': '3',
      'X-Dyson-Content-SHA256': sha256,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store'
    }
  })
}

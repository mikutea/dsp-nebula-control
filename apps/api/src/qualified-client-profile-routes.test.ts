import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApplication, type BuiltApplication } from './app.js'
import type { IssuedQualifiedClientProfileReference } from './client-profile/index.js'
import { loadConfig } from './config.js'
import type { QualifiedClientProfileService } from './services/qualified-client-profile-service.js'

const origin = 'http://127.0.0.1:13010'
const downloadId = '90000000-0000-0000-0000-000000000001'
const qualificationId = '11111111-1111-1111-1111-111111111111'
const issueRequest = { schemaVersion: 2 as const, qualificationId }
let application: BuiltApplication | null = null

afterEach(async () => {
  if (application) await application.close()
  application = null
})

describe('qualified client profile V2 routes', () => {
  it('requires authentication, an exact opaque request, and returns metadata without bytes', async () => {
    const service = fakeService()
    application = await buildApplication(testConfig(true), { qualifiedClientProfileService: service })

    const unauthenticated = await application.app.inject({
      method: 'POST', url: '/api/v2/client-profile/issue', headers: { origin }, payload: issueRequest
    })
    expect(unauthenticated.statusCode).toBe(401)

    const cookie = await login(application)
    const invalid = await application.app.inject({
      method: 'POST', url: '/api/v2/client-profile/issue', headers: { origin },
      cookies: { dyson_session: cookie }, payload: { ...issueRequest, callerPath: 'forbidden' }
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json()).toMatchObject({ error: { code: 'QUALIFIED_CLIENT_PROFILE_REQUEST_INVALID' } })
    expect(service.issue).not.toHaveBeenCalled()

    const issued = await application.app.inject({
      method: 'POST', url: '/api/v2/client-profile/issue', headers: { origin },
      cookies: { dyson_session: cookie }, payload: issueRequest
    })
    expect(issued.statusCode).toBe(200)
    expect(service.issue).toHaveBeenCalledWith(issueRequest)
    expect(issued.json()).toMatchObject({ data: { downloadId, qualificationId } })
    expect(issued.body).not.toContain('bytes')
    expect(issued.body).not.toContain('private-root')
  })

  it('streams three independently rebound artifacts with fixed no-store headers', async () => {
    const service = fakeService()
    application = await buildApplication(testConfig(true), { qualifiedClientProfileService: service })
    const cookie = await login(application)

    for (const expected of [
      {
        url: `/api/v2/client-profile/archive/${downloadId}`,
        bytes: Buffer.from('profile-archive-fixture'),
        fileName: 'dyson-qualified-client-profile.zip',
        mediaType: 'application/zip'
      },
      {
        url: `/api/v2/client-profile/client/${downloadId}`,
        bytes: Buffer.from('client-payload-fixture'),
        fileName: 'dyson-qualified-nebula-client.zip',
        mediaType: 'application/zip'
      },
      {
        url: `/api/v2/client-profile/runtime/${downloadId}`,
        bytes: Buffer.from('{"runtime":"fixture"}'),
        fileName: 'qualified-client-runtime.json',
        mediaType: 'application/json'
      }
    ]) {
      const response = await application.app.inject({
        method: 'GET', url: expected.url, headers: { origin }, cookies: { dyson_session: cookie }
      })
      expect(response.statusCode).toBe(200)
      expect(response.rawPayload.equals(expected.bytes)).toBe(true)
      expect(response.headers['content-type']).toContain(expected.mediaType)
      expect(response.headers['content-disposition']).toBe(`attachment; filename="${expected.fileName}"`)
      expect(response.headers['content-length']).toBe(String(expected.bytes.length))
      expect(response.headers['x-dyson-content-sha256']).toBe(bareSha256(expected.bytes))
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.headers['x-content-type-options']).toBe('nosniff')
    }
  })

  it('fails closed for disabled service, invalid IDs, query smuggling, and rebound hash drift', async () => {
    const disabledService = fakeService()
    application = await buildApplication(testConfig(), { qualifiedClientProfileService: disabledService })
    let cookie = await login(application)
    const disabled = await application.app.inject({
      method: 'POST', url: '/api/v2/client-profile/issue', headers: { origin },
      cookies: { dyson_session: cookie }, payload: issueRequest
    })
    expect(disabled.statusCode).toBe(423)
    expect(disabledService.issue).not.toHaveBeenCalled()
    await application.close()

    const service = fakeService()
    const tamperedBytes = Buffer.from('tampered')
    service.readProfileArchive.mockResolvedValueOnce({
      downloadId,
      fileName: 'dyson-qualified-client-profile.zip',
      mediaType: 'application/zip',
      bytes: tamperedBytes,
      sizeBytes: tamperedBytes.length,
      sha256: `sha256:${'0'.repeat(64)}`
    })
    service.readClientPayload.mockResolvedValueOnce({
      downloadId,
      fileName: 'dyson-qualified-nebula-client.zip',
      mediaType: 'application/zip',
      bytes: tamperedBytes,
      sizeBytes: tamperedBytes.length,
      sha256: `sha256:${'0'.repeat(64)}`
    })
    service.readRuntimeArtifact.mockResolvedValueOnce({
      downloadId,
      fileName: 'qualified-client-runtime.json',
      mediaType: 'application/json',
      bytes: tamperedBytes,
      sizeBytes: tamperedBytes.length,
      sha256: `sha256:${'0'.repeat(64)}`
    })
    application = await buildApplication(testConfig(true), { qualifiedClientProfileService: service })
    cookie = await login(application)
    for (const url of [
      '/api/v2/client-profile/archive/not-a-uuid',
      `/api/v2/client-profile/archive/${downloadId}?privateRoot=forbidden`
    ]) {
      const response = await application.app.inject({
        method: 'GET', url, headers: { origin }, cookies: { dyson_session: cookie }
      })
      expect(response.statusCode).toBe(404)
      expect(response.json()).toMatchObject({ error: { code: 'QUALIFIED_CLIENT_ARTIFACT_UNAVAILABLE' } })
      expect(response.body).not.toContain('forbidden')
      expect(response.body).not.toContain('tampered')
    }
    for (const url of [
      `/api/v2/client-profile/archive/${downloadId}`,
      `/api/v2/client-profile/client/${downloadId}`,
      `/api/v2/client-profile/runtime/${downloadId}`
    ]) {
      const response = await application.app.inject({
        method: 'GET', url, headers: { origin }, cookies: { dyson_session: cookie }
      })
      expect(response.statusCode).toBe(404)
      expect(response.json()).toMatchObject({ error: { code: 'QUALIFIED_CLIENT_ARTIFACT_UNAVAILABLE' } })
      expect(response.body).not.toContain('forbidden')
      expect(response.body).not.toContain('tampered')
    }
    expect(service.readProfileArchive).toHaveBeenCalledTimes(1)
    expect(service.readClientPayload).toHaveBeenCalledTimes(1)
    expect(service.readRuntimeArtifact).toHaveBeenCalledTimes(1)
  })

  it('normalizes protected verification failures without reflecting internals', async () => {
    const service = fakeService()
    service.issue.mockRejectedValueOnce(new Error('private-root\\keys\\coordinator.key'))
    application = await buildApplication(testConfig(true), { qualifiedClientProfileService: service })
    const cookie = await login(application)
    const response = await application.app.inject({
      method: 'POST', url: '/api/v2/client-profile/issue', headers: { origin },
      cookies: { dyson_session: cookie }, payload: issueRequest
    })
    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ error: { code: 'QUALIFIED_CLIENT_PROFILE_NOT_ISSUED' } })
    expect(response.body).not.toContain('private-root')
    expect(response.body).not.toContain('coordinator.key')
  })
})

function fakeService() {
  const profileBytes = Buffer.from('profile-archive-fixture')
  const clientBytes = Buffer.from('client-payload-fixture')
  const runtimeBytes = Buffer.from('{"runtime":"fixture"}')
  const safeIssue = {
    downloadId,
    issueReceiptSha256: `sha256:${'f'.repeat(64)}`,
    qualificationId,
    bindingSha256: `sha256:${'a'.repeat(64)}`,
    expiresAtUtc: '2099-01-01T00:00:00.000Z',
    metadata: { format: 'fixture' },
    archive: {
      fileName: 'dyson-qualified-client-profile.zip',
      mediaType: 'application/zip',
      sizeBytes: profileBytes.length,
      sha256: prefixedSha256(profileBytes)
    }
  } as unknown as IssuedQualifiedClientProfileReference
  return {
    issue: vi.fn(async () => safeIssue),
    readProfileArchive: vi.fn(async () => ({
      downloadId,
      fileName: 'dyson-qualified-client-profile.zip' as const,
      mediaType: 'application/zip' as const,
      bytes: profileBytes,
      sizeBytes: profileBytes.length,
      sha256: prefixedSha256(profileBytes)
    })),
    readClientPayload: vi.fn(async () => ({
      downloadId,
      fileName: 'dyson-qualified-nebula-client.zip' as const,
      mediaType: 'application/zip' as const,
      bytes: clientBytes,
      sizeBytes: clientBytes.length,
      sha256: prefixedSha256(clientBytes)
    })),
    readRuntimeArtifact: vi.fn(async () => ({
      downloadId,
      fileName: 'qualified-client-runtime.json' as const,
      mediaType: 'application/json' as const,
      bytes: runtimeBytes,
      sizeBytes: runtimeBytes.length,
      sha256: prefixedSha256(runtimeBytes)
    }))
  } satisfies QualifiedClientProfileService
}

function prefixedSha256(bytes: Uint8Array): string {
  return `sha256:${bareSha256(bytes)}`
}

function bareSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function testConfig(qualifiedClientProfileEnabled = false) {
  const config = loadConfig({
    NODE_ENV: 'test',
    DYSON_PROVIDER: 'demo',
    DYSON_DEV_ADMIN_PASSWORD: 'test-password-long-enough',
    DYSON_PUBLIC_ORIGIN: origin
  })
  return qualifiedClientProfileEnabled ? { ...config, qualifiedClientProfileEnabled: true } : config
}

async function login(target: BuiltApplication): Promise<string> {
  const response = await target.app.inject({
    method: 'POST', url: '/api/v1/auth/login', headers: { origin },
    payload: { password: 'test-password-long-enough' }
  })
  expect(response.statusCode).toBe(200)
  return response.cookies[0]!.value
}

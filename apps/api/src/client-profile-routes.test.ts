import { afterEach, describe, expect, it } from 'vitest'
import { buildApplication, type BuiltApplication } from './app.js'
import { verifyClientProfileZip, generateClientProfile } from './client-profile/index.js'
import { loadConfig } from './config.js'
import { generateModManifests } from './mods/index.js'

const origin = 'http://127.0.0.1:13010'
let application: BuiltApplication | null = null

afterEach(async () => {
  if (application) await application.close()
  application = null
})

describe('authenticated client profile ZIP route', () => {
  it('generates deterministic bytes, independently verifies them, and returns fixed download headers', async () => {
    application = await buildApplication(testConfig())
    const request = profileGenerationRequest()

    const unauthenticated = await application.app.inject({
      method: 'POST', url: '/api/v1/client-profile/archive', headers: { origin }, payload: request
    })
    expect(unauthenticated.statusCode).toBe(401)

    const cookie = await login(application)
    const first = await archive(application, cookie, request)
    const second = await archive(application, cookie, structuredClone(request))

    expect(first.statusCode).toBe(200)
    expect(first.headers['content-type']).toBe('application/zip')
    expect(first.headers['content-disposition']).toBe('attachment; filename="dyson-client-profile.zip"')
    expect(first.headers['cache-control']).toBe('no-store')
    expect(Number(first.headers['content-length'])).toBe(first.rawPayload.length)
    expect(first.headers['x-dyson-profile-sha256']).toMatch(/^[0-9a-f]{64}$/)
    expect(second.rawPayload.equals(first.rawPayload)).toBe(true)

    const verified = verifyClientProfileZip(first.rawPayload)
    const generated = generateClientProfile(request)
    expect(verified).toMatchObject({
      valid: true,
      archiveSha256: first.headers['x-dyson-profile-sha256'],
      sizeBytes: first.rawPayload.length,
      artifactSetSha256: generated.artifactSetSha256,
      profileId: 'fixture-profile'
    })
    expect(verified.entries.map((entry) => entry.entryName)).toEqual([
      'CHECKSUMS.sha256',
      'INSTALL.md',
      'client-mod-lock.json',
      'client-profile.json',
      'parity-report.json',
      'verification-checklist.json'
    ])
  })

  it('returns one generic 400 response without reflecting invalid input', async () => {
    application = await buildApplication(testConfig())
    const cookie = await login(application)
    const response = await archive(application, cookie, {
      schemaVersion: 1,
      marker: 'DO-NOT-REFLECT-THIS-INPUT',
      profile: { connection: { host: 'not a hostname', port: -1 } }
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({
      error: {
        code: 'CLIENT_PROFILE_ARCHIVE_NOT_GENERATED',
        message: '客户端 ZIP 未通过生成与独立完整性校验'
      }
    })
    expect(response.body).not.toContain('DO-NOT-REFLECT-THIS-INPUT')
    expect(response.body).not.toContain('not a hostname')
  })
})

function testConfig() {
  return loadConfig({
    NODE_ENV: 'test',
    DYSON_PROVIDER: 'demo',
    DYSON_DEV_ADMIN_PASSWORD: 'test-password-long-enough',
    DYSON_PUBLIC_ORIGIN: origin
  })
}

async function login(target: BuiltApplication): Promise<string> {
  const response = await target.app.inject({
    method: 'POST', url: '/api/v1/auth/login', headers: { origin },
    payload: { password: 'test-password-long-enough' }
  })
  expect(response.statusCode).toBe(200)
  return response.cookies[0]!.value
}

async function archive(target: BuiltApplication, cookie: string, payload: Record<string, unknown>) {
  return await target.app.inject({
    method: 'POST',
    url: '/api/v1/client-profile/archive',
    headers: { origin },
    cookies: { dyson_session: cookie },
    payload
  })
}

function profileGenerationRequest() {
  const manifests = generateModManifests({
    roots: ['Fictional-MultiplayerRoot-2.0.0'],
    packages: [
      {
        dependencyId: 'Fictional-MultiplayerRoot-2.0.0',
        sha256: 'b'.repeat(64),
        dependencies: ['Fictional-ServerHelper-1.0.0'],
        serverRequired: true,
        clientRequirement: 'required'
      },
      {
        dependencyId: 'Fictional-ServerHelper-1.0.0',
        sha256: 'a'.repeat(64),
        dependencies: [],
        serverRequired: true,
        clientRequirement: 'not-required'
      }
    ]
  })
  return {
    schemaVersion: 1,
    profile: {
      profileId: 'fixture-profile',
      displayName: 'Fictional Dyson Server',
      connection: { host: 'dsp.example.com', port: 8469 }
    },
    compatibility: {
      inventory: {
        dsp: '0.10.34.28529',
        nebula: '0.9.22.2',
        bepInEx: '5.4.17.0',
        plugins: [{
          sourceId: 'thunderstore:NebulaModTeam/NebulaMultiplayerMod',
          version: '0.9.22.2'
        }]
      },
      matrix: {
        schemaVersion: 1,
        entries: [{
          id: 'fixture-compatible',
          core: {
            dsp: { minInclusive: '0.10.34.0', maxExclusive: '0.10.35.0' },
            nebula: { equals: '0.9.22.2' },
            bepInEx: { minInclusive: '5.4.17', maxExclusive: '6.0.0' }
          },
          plugins: [{
            sourceId: 'thunderstore:NebulaModTeam/NebulaMultiplayerMod',
            range: { equals: '0.9.22.2' },
            required: true
          }]
        }]
      }
    },
    serverLock: manifests.serverLock,
    clientParity: manifests.clientParity
  }
}

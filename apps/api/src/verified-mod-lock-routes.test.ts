import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApplication, type BuiltApplication } from './app.js'
import { loadConfig } from './config.js'
import { createModPlatformLock, VerifiedModLockError, type VerifiedModLockService } from './mods/index.js'
import { hashPassword } from './security/password.js'

const origin = 'http://127.0.0.1:13010'
const administratorPassword = 'fictional-verified-lock-administrator'
const viewerPassword = 'fictional-verified-lock-viewer'
const receiptId = '22222222-2222-4222-8222-222222222222'
let viewerPasswordHash = ''
let application: BuiltApplication | null = null

beforeAll(async () => { viewerPasswordHash = await hashPassword(viewerPassword) })
afterEach(async () => { await application?.close(); application = null })

describe('verified mod lock application route', () => {
  it('lets a Viewer build a dry-run lock from opaque import receipt ids', async () => {
    const preview = vi.fn<VerifiedModLockService['preview']>(async () => previewFixture)
    application = await buildApplication(baseConfig(), { verifiedModLockService: { preview } })
    const viewer = await login('viewer', viewerPassword)
    const request = requestFixture()

    const response = await post(viewer, request)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ data: previewFixture })
    expect(preview).toHaveBeenCalledWith(request, expect.any(AbortSignal))
    expect(JSON.stringify(request)).not.toMatch(/(?:path|url|command|zip|archive|sha256)/i)
  })

  it('maps missing receipts without reflecting inputs and is stable when unconfigured', async () => {
    const preview = vi.fn<VerifiedModLockService['preview']>(async () => {
      throw new VerifiedModLockError('VERIFIED_MOD_IMPORT_RECEIPT_NOT_FOUND')
    })
    application = await buildApplication(baseConfig(), { verifiedModLockService: { preview } })
    const administrator = await login('administrator', administratorPassword)
    const missing = await post(administrator, requestFixture())
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toEqual({ error: { code: 'VERIFIED_MOD_IMPORT_RECEIPT_NOT_FOUND' } })

    await application.close()
    application = await buildApplication(baseConfig())
    const nextAdministrator = await login('administrator', administratorPassword)
    const unavailable = await post(nextAdministrator, requestFixture())
    expect(unavailable.statusCode).toBe(503)
    expect(unavailable.json()).toEqual({ error: { code: 'VERIFIED_MOD_LOCK_NOT_CONFIGURED' } })
  })

  it('keeps invalid evidence at 422 and verification unavailability or abort at 503', async () => {
    const preview = vi.fn<VerifiedModLockService['preview']>()
      .mockRejectedValueOnce(new VerifiedModLockError('VERIFIED_MOD_IMPORT_RECEIPT_INVALID'))
      .mockRejectedValueOnce(new VerifiedModLockError('VERIFIED_MOD_IMPORT_RECEIPT_UNAVAILABLE'))
      .mockRejectedValueOnce(new VerifiedModLockError('VERIFIED_MOD_LOCK_ABORTED'))
    application = await buildApplication(baseConfig(), { verifiedModLockService: { preview } })
    const administrator = await login('administrator', administratorPassword)

    const invalid = await post(administrator, requestFixture())
    expect(invalid.statusCode).toBe(422)
    expect(invalid.json()).toEqual({ error: { code: 'VERIFIED_MOD_IMPORT_RECEIPT_INVALID' } })

    const unavailable = await post(administrator, requestFixture())
    expect(unavailable.statusCode).toBe(503)
    expect(unavailable.json()).toEqual({ error: { code: 'VERIFIED_MOD_IMPORT_RECEIPT_UNAVAILABLE' } })

    const aborted = await post(administrator, requestFixture())
    expect(aborted.statusCode).toBe(503)
    expect(aborted.json()).toEqual({ error: { code: 'VERIFIED_MOD_LOCK_ABORTED' } })
  })
})

function baseConfig() {
  return loadConfig({
    NODE_ENV: 'test',
    DYSON_PROVIDER: 'demo',
    DYSON_PUBLIC_ORIGIN: origin,
    DYSON_DEV_ADMIN_PASSWORD: administratorPassword,
    DYSON_VIEWER_PASSWORD_HASH: viewerPasswordHash
  })
}

async function login(role: 'viewer' | 'administrator', password: string): Promise<string> {
  const response = await application!.app.inject({
    method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { role, password }
  })
  expect(response.statusCode).toBe(200)
  return response.cookies[0]!.value
}

async function post(cookie: string, payload: ReturnType<typeof requestFixture>) {
  return await application!.app.inject({
    method: 'POST', url: '/api/v1/mods/verified-lock/preview', headers: { origin },
    cookies: { dyson_session: cookie }, payload
  })
}

function requestFixture() {
  return {
    roots: ['Fictional-ServerHelper-1.0.0'],
    importReceiptIds: [receiptId],
    policies: [{
      sourceId: 'thunderstore:Fictional/ServerHelper',
      serverRequired: true,
      clientRequirement: 'required' as const
    }]
  }
}

const previewFixture = {
  mode: 'dry-run' as const,
  serverLock: {
    format: 'dyson-control-server-mod-lock' as const,
    schemaVersion: 1 as const,
    mods: [{
      dependencyId: 'Fictional-ServerHelper-1.0.0',
      sourceId: 'thunderstore:Fictional/ServerHelper',
      version: '1.0.0', sha256: 'a'.repeat(64), dependencies: [], loadOrder: 0,
      root: true, serverRequired: true, clientRequirement: 'required' as const
    }]
  },
  serverLockSha256: 'b'.repeat(64),
  clientParity: {
    format: 'dyson-control-client-parity' as const,
    schemaVersion: 1 as const,
    serverLockSha256: 'b'.repeat(64),
    mods: [{
      sourceId: 'thunderstore:Fictional/ServerHelper', version: '1.0.0', sha256: 'a'.repeat(64),
      serverRequired: true, clientRequirement: 'required' as const
    }]
  },
  platformRequirements: [],
  platformLock: createModPlatformLock({
    serverLockSha256: 'b'.repeat(64),
    inventoryRevision: null,
    requirements: []
  })
}

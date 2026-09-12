import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApplication, type BuiltApplication } from './app.js'
import { loadConfig } from './config.js'
import { hashPassword } from './security/password.js'
import {
  TrustedCompatibilityHttpController,
  type TrustedCompatibilityHttpService,
  type TrustedCompatibilityReceipt,
  type TrustedCompatibilityStatus
} from './update-pipeline/index.js'

const origin = 'http://127.0.0.1:13010'
let application: BuiltApplication | null = null

afterEach(async () => {
  if (application) await application.close()
  application = null
})

describe('trusted compatibility application routes', () => {
  it('allows viewers to inspect server-owned status/receipts but never prepare evidence', async () => {
    const viewerPassword = 'fictional-viewer-password'
    const service = createService()
    application = await buildApplication(loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'demo', DYSON_PUBLIC_ORIGIN: origin,
      DYSON_DEV_ADMIN_PASSWORD: 'fictional-administrator-password',
      DYSON_VIEWER_PASSWORD_HASH: await hashPassword(viewerPassword)
    }), { trustedCompatibilityController: new TrustedCompatibilityHttpController(service) })
    const cookie = await login('viewer', viewerPassword)

    const status = await application.app.inject({
      method: 'GET', url: '/api/v1/updates/compatibility/status', cookies: { dyson_session: cookie }
    })
    expect(status.statusCode).toBe(200)
    expect(status.json().data).toEqual(statusFixture)

    const receipt = await application.app.inject({
      method: 'GET', url: `/api/v1/updates/compatibility/receipts/${receiptFixture.receiptId}`,
      cookies: { dyson_session: cookie }
    })
    expect(receipt.statusCode).toBe(200)

    const forbidden = await application.app.inject({
      method: 'POST', url: '/api/v1/updates/compatibility/prepare', headers: { origin },
      cookies: { dyson_session: cookie }, payload: prepareRequest()
    })
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json().error.code).toBe('AUTHORIZATION_DENIED')
    expect(service.prepare).not.toHaveBeenCalled()
  })

  it('lets an operator prepare only the strict candidate identity with same-origin protection', async () => {
    const operatorPassword = 'fictional-operator-password'
    const service = createService()
    application = await buildApplication(loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'demo', DYSON_PUBLIC_ORIGIN: origin,
      DYSON_DEV_ADMIN_PASSWORD: 'fictional-administrator-password',
      DYSON_OPERATOR_PASSWORD_HASH: await hashPassword(operatorPassword)
    }), { trustedCompatibilityController: new TrustedCompatibilityHttpController(service) })
    const cookie = await login('operator', operatorPassword)

    const missingOrigin = await application.app.inject({
      method: 'POST', url: '/api/v1/updates/compatibility/prepare',
      cookies: { dyson_session: cookie }, payload: prepareRequest()
    })
    expect(missingOrigin.statusCode).toBe(403)
    expect(service.prepare).not.toHaveBeenCalled()

    const accepted = await application.app.inject({
      method: 'POST', url: '/api/v1/updates/compatibility/prepare', headers: { origin },
      cookies: { dyson_session: cookie }, payload: prepareRequest()
    })
    expect(accepted.statusCode).toBe(201)
    expect(accepted.json().data).toMatchObject({ receiptId: receiptFixture.receiptId, compatible: true })
    expect(service.prepare).toHaveBeenCalledWith(expect.not.objectContaining({
      matrix: expect.anything(), inventory: expect.anything(), url: expect.anything(), path: expect.anything()
    }))

    const rejected = await application.app.inject({
      method: 'POST', url: '/api/v1/updates/compatibility/prepare', headers: { origin },
      cookies: { dyson_session: cookie }, payload: { ...prepareRequest(), matrix: { schemaVersion: 1 } }
    })
    expect(rejected.statusCode).toBe(422)
    expect(service.prepare).toHaveBeenCalledTimes(1)
  })

  it('returns one explicit unavailable response when the trusted service is not configured', async () => {
    application = await buildApplication(loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'demo', DYSON_PUBLIC_ORIGIN: origin,
      DYSON_DEV_ADMIN_PASSWORD: 'fictional-administrator-password'
    }))
    const cookie = await login('administrator', 'fictional-administrator-password')
    const response = await application.app.inject({
      method: 'GET', url: '/api/v1/updates/compatibility/status', cookies: { dyson_session: cookie }
    })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ ok: false, error: { code: 'UPDATE_COMPATIBILITY_NOT_CONFIGURED' } })
  })
})

function createService() {
  return {
    status: vi.fn(async () => statusFixture),
    prepare: vi.fn(async () => receiptFixture),
    getReceipt: vi.fn(async () => receiptFixture)
  } satisfies TrustedCompatibilityHttpService
}

async function login(role: 'viewer' | 'operator' | 'administrator', password: string): Promise<string> {
  const response = await application!.app.inject({
    method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { role, password }
  })
  expect(response.statusCode).toBe(200)
  return response.cookies[0]!.value
}

function prepareRequest() {
  return {
    requestId: receiptFixture.receiptId,
    component: 'nebula', artifactId: receiptFixture.artifactId,
    sha256: receiptFixture.artifactSha256, targetVersion: receiptFixture.targetVersion,
    expectedInventoryRevision: statusFixture.inventoryRevision,
    expectedPolicyRevision: statusFixture.policyRevision,
    confirmation: 'PREPARE_COMPATIBILITY_EVIDENCE'
  }
}

const statusFixture: TrustedCompatibilityStatus = {
  format: 'dyson-control-trusted-compatibility-status', schemaVersion: 1, available: true,
  policyId: 'fictional-route-policy', policyRevision: '1'.repeat(64),
  policyReviewedAt: '2026-08-30T10:00:00.000Z', inventoryRevision: '2'.repeat(64),
  inventory: { dsp: '0.10.33.26727', nebula: '0.9.0', bepInEx: '5.4.22', plugins: [] }
}

const receiptFixture: TrustedCompatibilityReceipt = {
  format: 'dyson-control-trusted-compatibility-receipt', schemaVersion: 1,
  receiptId: '018f47a0-7d5b-7abc-8def-0123456789ab', component: 'nebula',
  artifactId: 'nebula-artifact-0001', artifactSha256: 'a'.repeat(64), targetVersion: '0.9.1',
  inventoryRevision: statusFixture.inventoryRevision, policyId: statusFixture.policyId!,
  policyRevision: statusFixture.policyRevision!, matchedEntryId: 'fictional-nebula-091', compatible: true,
  issuedAt: '2026-08-30T12:00:00.000Z', expiresAt: '2026-08-30T12:10:00.000Z', reused: false
}

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApplication, type BuiltApplication } from './app.js'
import { loadConfig } from './config.js'
import type { CutoverRoutesController } from './cutover/routes.js'
import { PREPARE_GSMANAGER_TO_DYSON } from './cutover/types.js'
import { hashPassword } from './security/password.js'

const origin = 'http://127.0.0.1:13010'
const passwords = {
  viewer: 'fictional-cutover-viewer-password',
  operator: 'fictional-cutover-operator-password',
  administrator: 'fictional-cutover-admin-password'
} as const
let viewerPasswordHash = ''
let operatorPasswordHash = ''
let application: BuiltApplication | null = null

beforeAll(async () => {
  [viewerPasswordHash, operatorPasswordHash] = await Promise.all([
    hashPassword(passwords.viewer),
    hashPassword(passwords.operator)
  ])
})

afterEach(async () => {
  await application?.close()
  application = null
})

describe('cutover application wiring', () => {
  it('registers the injected controller behind independent read and execute permissions', async () => {
    const controller = fixtureController()
    application = await buildApplication(loadConfig({
      NODE_ENV: 'test',
      DYSON_PROVIDER: 'demo',
      DYSON_PUBLIC_ORIGIN: origin,
      DYSON_DEV_ADMIN_PASSWORD: passwords.administrator,
      DYSON_VIEWER_PASSWORD_HASH: viewerPasswordHash,
      DYSON_OPERATOR_PASSWORD_HASH: operatorPasswordHash
    }), { cutoverController: controller })

    const viewer = await login('viewer')
    const operator = await login('operator')
    const administrator = await login('administrator')

    const status = await application.app.inject({
      method: 'GET', url: '/api/v1/cutover/status',
      cookies: { dyson_session: viewer }
    })
    expect(status.statusCode).toBe(200)
    expect(controller.recoveryStatus).toHaveBeenCalledWith({})

    const denied = await application.app.inject({
      method: 'POST', url: '/api/v1/cutover/prepare', headers: { origin },
      cookies: { dyson_session: operator },
      payload: {
        requestId: '00000000-0000-4000-8000-000000000001',
        confirmation: PREPARE_GSMANAGER_TO_DYSON
      }
    })
    expect(denied.statusCode).toBe(403)
    expect(controller.prepare).not.toHaveBeenCalled()

    const allowed = await application.app.inject({
      method: 'POST', url: '/api/v1/cutover/prepare', headers: { origin },
      cookies: { dyson_session: administrator },
      payload: {
        requestId: '00000000-0000-4000-8000-000000000001',
        confirmation: PREPARE_GSMANAGER_TO_DYSON
      }
    })
    expect(allowed.statusCode).toBe(202)
    expect(controller.prepare).toHaveBeenCalledWith({
      requestId: '00000000-0000-4000-8000-000000000001',
      confirmation: PREPARE_GSMANAGER_TO_DYSON
    }, { actorRole: 'administrator' })
  })

  it('does not expose cutover routes when no controller was constructed', async () => {
    application = await buildApplication(loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'demo', DYSON_PUBLIC_ORIGIN: origin,
      DYSON_DEV_ADMIN_PASSWORD: passwords.administrator
    }))
    const readiness = await application.app.inject({ method: 'GET', url: '/readyz' })
    expect(readiness.statusCode).toBe(200)
    expect(readiness.json()).toMatchObject({
      status: 'ready',
      checks: { cutoverRecovery: 'not-applicable' }
    })

    const administrator = await login('administrator')
    const response = await application.app.inject({
      method: 'GET', url: '/api/v1/cutover/status',
      cookies: { dyson_session: administrator }
    })
    expect(response.statusCode).toBe(404)
  })
})

function fixtureController() {
  return {
    recoveryStatus: vi.fn(async () => ({
      statusCode: 200,
      body: { ok: true as const, data: { schemaVersion: 1, phase: 'ready' } }
    })),
    prepare: vi.fn(async () => ({
      statusCode: 202,
      body: { ok: true as const, data: { requestId: 'fixture', phase: 'prepared' } }
    })),
    activate: vi.fn(),
    rollback: vi.fn(),
    recover: vi.fn()
  } as unknown as CutoverRoutesController & Record<string, ReturnType<typeof vi.fn>>
}

async function login(role: keyof typeof passwords): Promise<string> {
  const response = await application!.app.inject({
    method: 'POST', url: '/api/v1/auth/login', headers: { origin },
    payload: { role, password: passwords[role] }
  })
  expect(response.statusCode).toBe(200)
  return response.cookies[0]!.value
}

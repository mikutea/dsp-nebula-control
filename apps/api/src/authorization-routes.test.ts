import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApplication, type BuiltApplication } from './app.js'
import { loadConfig } from './config.js'
import { hashPassword } from './security/password.js'

const origin = 'http://127.0.0.1:13010'
const passwords = {
  viewer: 'fictional-viewer-password',
  operator: 'fictional-operator-password',
  administrator: 'fictional-admin-password'
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
  if (application) await application.close()
  application = null
})

async function buildRoleFixture() {
  application = await buildApplication(loadConfig({
    NODE_ENV: 'test',
    DYSON_PROVIDER: 'demo',
    DYSON_PUBLIC_ORIGIN: origin,
    DYSON_DEV_ADMIN_PASSWORD: passwords.administrator,
    DYSON_VIEWER_PASSWORD_HASH: viewerPasswordHash,
    DYSON_OPERATOR_PASSWORD_HASH: operatorPasswordHash
  }))
}

async function login(role: keyof typeof passwords): Promise<string> {
  const response = await application!.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin },
    payload: { role, password: passwords[role] }
  })
  expect(response.statusCode).toBe(200)
  expect(response.json().user).toMatchObject({ role })
  const cookie = response.cookies[0]?.value
  expect(cookie).toBeTruthy()
  return cookie!
}

function injectWithCookie(
  cookie: string,
  input: { method: 'GET' | 'POST'; url: string; payload?: string | object | Buffer }
) {
  const headers = input.method === 'POST' ? { origin } : {}
  return application!.app.inject({ ...input, headers, cookies: { dyson_session: cookie } })
}

describe('role-based route authorization', () => {
  it('returns the exact role and bounded permissions from login and session', async () => {
    await buildRoleFixture()
    const cookie = await login('operator')
    const session = await injectWithCookie(cookie, { method: 'GET', url: '/api/v1/auth/session' })
    expect(session.statusCode).toBe(200)
    expect(session.json().user).toMatchObject({
      name: 'Operator',
      role: 'operator',
      permissions: expect.arrayContaining([
        'status.read',
        'status.refresh',
        'lifecycle.execute',
        'console.command'
      ])
    })
    expect(session.json().user.permissions).not.toContain('saves.restore')
    expect(session.json().user.permissions).not.toContain('mods.mutate')
    expect(session.body).not.toMatch(/password|secret|token/i)
  })

  it('keeps Viewer read-only and masks mutation capabilities', async () => {
    await buildRoleFixture()
    const cookie = await login('viewer')
    const status = await injectWithCookie(cookie, { method: 'GET', url: '/api/v1/status' })
    expect(status.statusCode).toBe(200)
    expect(status.json().data.capabilities).toMatchObject({
      refresh: false,
      start: false,
      save: false,
      gracefulStop: false,
      restart: false
    })

    for (const request of [
      { method: 'POST' as const, url: '/api/v1/actions/refresh' },
      {
        method: 'POST' as const,
        url: '/api/v1/actions/lifecycle/preview',
        payload: { action: 'save' }
      },
      {
        method: 'POST' as const,
        url: '/api/v1/console/commands/preview',
        payload: { command: 'server.save' }
      },
      {
        method: 'POST' as const,
        url: '/api/v1/configuration/apply',
        payload: {}
      },
      {
        method: 'POST' as const,
        url: '/api/v1/mods/deployment/execute',
        payload: {}
      }
    ]) {
      const response = await injectWithCookie(cookie, request)
      expect(response.statusCode).toBe(403)
      expect(response.json().error.code).toBe('AUTHORIZATION_DENIED')
    }
  })

  it('allows Operator routine lifecycle and fixed-console workflows but denies high-risk mutations', async () => {
    await buildRoleFixture()
    const cookie = await login('operator')
    const refresh = await injectWithCookie(cookie, {
      method: 'POST',
      url: '/api/v1/actions/refresh'
    })
    expect(refresh.statusCode).toBe(202)

    const preview = await injectWithCookie(cookie, {
      method: 'POST',
      url: '/api/v1/console/commands/preview',
      payload: { command: 'server.restart' }
    })
    expect(preview.statusCode).toBe(200)
    expect(preview.json().data).toMatchObject({
      mode: 'dry-run',
      command: 'server.restart',
      requiredConfirmation: 'RESTART_SERVER',
      lifecycle: { action: 'restart' }
    })

    const mismatch = await injectWithCookie(cookie, {
      method: 'POST',
      url: '/api/v1/console/commands/execute',
      payload: {
        command: 'server.restart',
        idempotencyKey: 'console-fixture-request-0001',
        confirmation: 'START_SERVER'
      }
    })
    expect(mismatch.statusCode).toBe(422)
    expect(mismatch.json().error.code).toBe('CONSOLE_COMMAND_CONFIRMATION_MISMATCH')

    const extraInput = await injectWithCookie(cookie, {
      method: 'POST',
      url: '/api/v1/console/commands/execute',
      payload: {
        command: 'server.restart',
        idempotencyKey: 'console-fixture-request-0002',
        confirmation: 'RESTART_SERVER',
        commandLine: 'untrusted'
      }
    })
    expect(extraInput.statusCode).toBe(400)

    for (const request of [
      {
        method: 'POST' as const,
        url: '/api/v1/saves/restore/preview',
        payload: {}
      },
      {
        method: 'POST' as const,
        url: '/api/v1/configuration/apply',
        payload: {}
      },
      {
        method: 'POST' as const,
        url: '/api/v1/mods/deployment/execute',
        payload: {}
      }
    ]) {
      const response = await injectWithCookie(cookie, request)
      expect(response.statusCode).toBe(403)
      expect(response.json().error.code).toBe('AUTHORIZATION_DENIED')
    }
  })

  it('lets Administrator reach high-risk route gates without bypassing their separate safety checks', async () => {
    await buildRoleFixture()
    const cookie = await login('administrator')
    const modExecution = await injectWithCookie(cookie, {
      method: 'POST',
      url: '/api/v1/mods/deployment/execute',
      payload: {}
    })
    expect(modExecution.statusCode).toBe(503)
    expect(modExecution.json().error.code).toBe('MOD_DEPLOYMENT_MUTATIONS_DISABLED')

    const restore = await injectWithCookie(cookie, {
      method: 'POST',
      url: '/api/v1/saves/restore/preview',
      payload: {}
    })
    expect(restore.statusCode).not.toBe(403)
  })

  it('uses a generic failure for unknown roles and creates no session', async () => {
    await buildRoleFixture()
    const response = await application!.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin },
      payload: { role: 'owner', password: passwords.administrator }
    })
    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe('INVALID_CREDENTIALS')
    expect(response.cookies).toHaveLength(0)
  })
})

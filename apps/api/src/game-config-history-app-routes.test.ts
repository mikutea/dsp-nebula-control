import path from 'node:path'
import os from 'node:os'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApplication, type BuiltApplication } from './app.js'
import { loadConfig } from './config.js'
import type { GameConfigHistoryRoutesController } from './game-config/history-routes.js'

let application: BuiltApplication | null = null
const temporaryRoots: string[] = []

afterEach(async () => {
  if (application) await application.close()
  application = null
  await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })))
})

describe('application game configuration history wiring', () => {
  it('registers the injected history controller behind the application session', async () => {
    const controller = createController()
    application = await buildApplication(testConfig(), { gameConfigHistoryController: controller })

    const unauthenticated = await application.app.inject({
      method: 'GET', url: '/api/v1/game-config/history'
    })
    expect(unauthenticated.statusCode).toBe(401)
    expect(controller.list).not.toHaveBeenCalled()

    const cookie = await login()
    const response = await application.app.inject({
      method: 'GET', url: '/api/v1/game-config/history', cookies: { dyson_session: cookie }
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true, data: [] })
    expect(controller.list).toHaveBeenCalledWith({})
  })

  it('retains application same-origin checks on history mutations', async () => {
    const controller = createController()
    application = await buildApplication(testConfig(), { gameConfigHistoryController: controller })

    const administratorCookie = await login()
    const rejectedOrigin = await application.app.inject({
      method: 'POST', url: '/api/v1/game-config/history/capture',
      cookies: { dyson_session: administratorCookie },
      payload: { confirmation: 'CREATE_CONFIG_SNAPSHOT' }
    })
    expect(rejectedOrigin.statusCode).toBe(403)
    expect(controller.capture).not.toHaveBeenCalled()

    const accepted = await application.app.inject({
      method: 'POST', url: '/api/v1/game-config/history/capture',
      headers: { origin: publicOrigin }, cookies: { dyson_session: administratorCookie },
      payload: { confirmation: 'CREATE_CONFIG_SNAPSHOT' }
    })
    expect(accepted.statusCode).toBe(423)
    expect(controller.capture).toHaveBeenCalledWith({ confirmation: 'CREATE_CONFIG_SNAPSHOT' })
  })

  it('constructs the real Windows history stack while keeping mutations disabled by default', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dyson-config-history-app-'))
    temporaryRoots.push(root)
    const projectRoot = path.join(root, 'project')
    await mkdir(path.join(projectRoot, 'server', 'BepInEx', 'config'), { recursive: true })

    application = await buildApplication(loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'windows', DYSON_PROJECT_ROOT: projectRoot,
      DYSON_DATA_DIR: path.join(root, 'data'), DYSON_PUBLIC_ORIGIN: publicOrigin,
      DYSON_DEV_ADMIN_PASSWORD: developmentPassword
    }))
    const cookie = await login()

    const history = await application.app.inject({
      method: 'GET', url: '/api/v1/game-config/history', cookies: { dyson_session: cookie }
    })
    expect(history.statusCode).toBe(200)
    expect(history.json()).toEqual({ ok: true, data: [] })

    const capture = await application.app.inject({
      method: 'POST', url: '/api/v1/game-config/history/capture',
      headers: { origin: publicOrigin }, cookies: { dyson_session: cookie },
      payload: { confirmation: 'CREATE_CONFIG_SNAPSHOT' }
    })
    expect(capture.statusCode).toBe(423)
    expect(capture.json()).toEqual({
      ok: false,
      error: { code: 'CONFIG_HISTORY_HTTP_MUTATION_DISABLED' }
    })
  })
})

function createController(): GameConfigHistoryRoutesController {
  return {
    list: vi.fn(async () => ({ statusCode: 200, body: { ok: true as const, data: [] } })),
    detail: vi.fn(async () => ({ statusCode: 404, body: { ok: false as const, error: { code: 'NOT_FOUND' } } })),
    diff: vi.fn(async () => ({ statusCode: 404, body: { ok: false as const, error: { code: 'NOT_FOUND' } } })),
    preview: vi.fn(async () => ({ statusCode: 404, body: { ok: false as const, error: { code: 'NOT_FOUND' } } })),
    capture: vi.fn(async () => ({ statusCode: 423, body: { ok: false as const, error: { code: 'DISABLED' } } })),
    restore: vi.fn(async () => ({ statusCode: 423, body: { ok: false as const, error: { code: 'DISABLED' } } })),
    reconcile: vi.fn(async () => ({ statusCode: 423, body: { ok: false as const, error: { code: 'DISABLED' } } }))
  }
}

async function login(): Promise<string> {
  const response = await application!.app.inject({
    method: 'POST', url: '/api/v1/auth/login', headers: { origin: publicOrigin },
    payload: { role: 'administrator', password: developmentPassword }
  })
  expect(response.statusCode).toBe(200)
  const cookie = response.cookies[0]?.value
  expect(cookie).toBeTruthy()
  return cookie!
}

function testConfig() {
  return loadConfig({
    NODE_ENV: 'test', DYSON_PROVIDER: 'demo',
    DYSON_PUBLIC_ORIGIN: publicOrigin, DYSON_DEV_ADMIN_PASSWORD: developmentPassword
  })
}

const publicOrigin = 'http://127.0.0.1:13010'
const developmentPassword = 'fictional-development-password'

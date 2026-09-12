import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApplication, type ApplicationDependencies, type BuiltApplication } from './app.js'
import { loadConfig } from './config.js'
import type { LifecycleMutationAdapter, StatusProvider } from './domain.js'
import type { WindowsLifecycleBrokerClient } from './providers/windows-lifecycle-broker.js'
import { hashPassword } from './security/password.js'

const origin = 'http://127.0.0.1:13010'
const administratorPassword = 'fictional-administrator-password'
const viewerPassword = 'fictional-viewer-password'
const requestId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
let application: BuiltApplication | null = null
const temporaryRoots: string[] = []

afterEach(async () => {
  if (application !== null) await application.close()
  application = null
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Steam manual handoff application routes', () => {
  it('returns one explicit unavailable contract for every route when no controller is configured', async () => {
    application = await buildApplication(loadConfig({
      NODE_ENV: 'test',
      DYSON_PROVIDER: 'demo',
      DYSON_PUBLIC_ORIGIN: origin,
      DYSON_DEV_ADMIN_PASSWORD: administratorPassword
    }))
    const cookie = await login('administrator', administratorPassword)

    for (const request of [
      { method: 'GET' as const, url: '/api/v1/updates/steam-handoff/state' },
      { method: 'GET' as const, url: '/api/v1/updates/steam-handoff/recovery' },
      { method: 'GET' as const, url: `/api/v1/updates/steam-handoff/receipts/${requestId}` },
      { method: 'POST' as const, url: '/api/v1/updates/steam-handoff/preview' },
      { method: 'POST' as const, url: '/api/v1/updates/steam-handoff/begin' },
      { method: 'POST' as const, url: '/api/v1/updates/steam-handoff/confirm' }
    ]) {
      const response = await application.app.inject({
        ...request,
        headers: request.method === 'POST' ? { origin } : undefined,
        cookies: { dyson_session: cookie },
        payload: request.method === 'POST' ? {} : undefined
      })
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(503)
      expect(response.json().error.code, `${request.method} ${request.url}`)
        .toBe('DSP_STEAM_HANDOFF_NOT_CONFIGURED')
    }
  })

  it('remains unavailable when the enabled Windows host has no fixed transaction provider', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dyson-steam-handoff-routes-'))
    temporaryRoots.push(root)
    const config = loadConfig({
      NODE_ENV: 'test',
      DYSON_PROVIDER: 'windows',
      DYSON_PUBLIC_ORIGIN: origin,
      DYSON_DEV_ADMIN_PASSWORD: administratorPassword,
      DYSON_DATA_DIR: path.join(root, 'data'),
      DYSON_PROJECT_ROOT: path.join(root, 'fictional-project'),
      DYSON_SCRIPT_ROOT: path.join(root, 'fixed-scripts'),
      DYSON_RUNTIME_BOOTSTRAP_ROOT: path.join(root, 'runtime-bootstrap'),
      DYSON_LIFECYCLE_ENABLED: 'true',
      DYSON_LIFECYCLE_BROKER_PROFILE_FILE:
        path.join(root, 'data', 'lifecycle-broker', 'broker-profile.json'),
      DYSON_RUNTIME_SERVICE_USER: '.\\FictionalDyson',
      DYSON_BRIDGE_CONTROL_ROOT: path.join(root, 'bridge-control'),
      DYSON_BRIDGE_SECRET_FILE: path.join(root, 'private', 'bridge.key'),
      DYSON_UPDATE_COMPATIBILITY_POLICY_FILE: path.join(root, 'trusted-compatibility-policy.json'),
      DYSON_STEAM_MANUAL_HANDOFF_ENABLED: 'true'
    })
    application = await buildApplication(config, {
      statusProvider: unusedWindowsStatusProvider,
      lifecycleAdapter: unusedLifecycleAdapter,
      lifecycleBrokerClient: unusedLifecycleBrokerClient,
      trustedCompatibilityService: unusedTrustedCompatibilityService
    })
    const cookie = await login('administrator', administratorPassword)

    const response = await application.app.inject({
      method: 'GET', url: '/api/v1/updates/steam-handoff/state',
      cookies: { dyson_session: cookie }
    })
    expect(response.statusCode).toBe(503)
    expect(response.json().error.code).toBe('DSP_STEAM_HANDOFF_NOT_CONFIGURED')
    expect(unusedWindowsStatusProvider.collectStatus).not.toHaveBeenCalled()
    expect(unusedLifecycleAdapter.requestGracefulStop).not.toHaveBeenCalled()
    expect(unusedLifecycleAdapter.requestStart).not.toHaveBeenCalled()
    expect(unusedTrustedCompatibilityService.assertCurrent).not.toHaveBeenCalled()
  })

  it('projects read-controller status codes and bodies unchanged through updates.read', async () => {
    const controller = fixtureController()
    application = await buildApplication(loadConfig({
      NODE_ENV: 'test',
      DYSON_PROVIDER: 'demo',
      DYSON_PUBLIC_ORIGIN: origin,
      DYSON_DEV_ADMIN_PASSWORD: administratorPassword,
      DYSON_VIEWER_PASSWORD_HASH: await hashPassword(viewerPassword)
    }), { steamManualHandoffController: controller })
    const cookie = await login('viewer', viewerPassword)
    expect(controller.initialize).toHaveBeenCalledOnce()
    const previewInput = {
      requestId,
      targetVersion: '0.10.35.29485',
      expectedRevision: '0'.repeat(64)
    }

    const state = await application.app.inject({
      method: 'GET', url: '/api/v1/updates/steam-handoff/state',
      cookies: { dyson_session: cookie }
    })
    expect(state.statusCode).toBe(206)
    expect(state.json()).toEqual(projectedBody('state', {}))
    expect(controller.state).toHaveBeenCalledWith({})

    const recovery = await application.app.inject({
      method: 'GET', url: '/api/v1/updates/steam-handoff/recovery',
      cookies: { dyson_session: cookie }
    })
    expect(recovery.statusCode).toBe(503)
    expect(recovery.json()).toEqual(projectedBody('recovery', {}))
    expect(controller.recoveryStatus).toHaveBeenCalledWith({})

    const receipt = await application.app.inject({
      method: 'GET', url: `/api/v1/updates/steam-handoff/receipts/${requestId}`,
      cookies: { dyson_session: cookie }
    })
    expect(receipt.statusCode).toBe(404)
    expect(receipt.json()).toEqual(projectedBody('receipt', { requestId }))
    expect(controller.getReceipt).toHaveBeenCalledWith({ requestId })

    const preview = await application.app.inject({
      method: 'POST', url: '/api/v1/updates/steam-handoff/preview',
      headers: { origin }, cookies: { dyson_session: cookie }, payload: previewInput
    })
    expect(preview.statusCode).toBe(422)
    expect(preview.json()).toEqual(projectedBody('preview', previewInput))
    expect(controller.preview).toHaveBeenCalledWith(previewInput)
    expect(controller.begin).not.toHaveBeenCalled()
    expect(controller.confirm).not.toHaveBeenCalled()
  })

  it('keeps begin and confirm behind updates.activate while projecting authorized results unchanged', async () => {
    const controller = fixtureController()
    application = await buildApplication(loadConfig({
      NODE_ENV: 'test',
      DYSON_PROVIDER: 'demo',
      DYSON_PUBLIC_ORIGIN: origin,
      DYSON_DEV_ADMIN_PASSWORD: administratorPassword,
      DYSON_VIEWER_PASSWORD_HASH: await hashPassword(viewerPassword)
    }), { steamManualHandoffController: controller })
    const viewerCookie = await login('viewer', viewerPassword)
    const beginInput = {
      requestId,
      targetVersion: '0.10.35.29485',
      expectedRevision: '0'.repeat(64),
      confirmation: 'BEGIN_STEAM_CLIENT_UPDATE_HANDOFF'
    }
    const confirmInput = {
      requestId,
      confirmation: 'CONFIRM_STEAM_CLIENT_UPDATE_COMPLETED'
    }

    for (const [url, payload] of [
      ['/api/v1/updates/steam-handoff/begin', beginInput],
      ['/api/v1/updates/steam-handoff/confirm', confirmInput]
    ] as const) {
      const forbidden = await application.app.inject({
        method: 'POST', url, headers: { origin },
        cookies: { dyson_session: viewerCookie }, payload
      })
      expect(forbidden.statusCode).toBe(403)
      expect(forbidden.json().error.code).toBe('AUTHORIZATION_DENIED')
    }
    expect(controller.begin).not.toHaveBeenCalled()
    expect(controller.confirm).not.toHaveBeenCalled()

    const administratorCookie = await login('administrator', administratorPassword)
    const begin = await application.app.inject({
      method: 'POST', url: '/api/v1/updates/steam-handoff/begin',
      headers: { origin }, cookies: { dyson_session: administratorCookie }, payload: beginInput
    })
    expect(begin.statusCode).toBe(202)
    expect(begin.json()).toEqual(projectedBody('begin', beginInput))
    expect(controller.begin).toHaveBeenCalledWith(beginInput)

    const confirm = await application.app.inject({
      method: 'POST', url: '/api/v1/updates/steam-handoff/confirm',
      headers: { origin }, cookies: { dyson_session: administratorCookie }, payload: confirmInput
    })
    expect(confirm.statusCode).toBe(409)
    expect(confirm.json()).toEqual(projectedBody('confirm', confirmInput))
    expect(controller.confirm).toHaveBeenCalledWith(confirmInput)
  })
})

type FixtureController = NonNullable<ApplicationDependencies['steamManualHandoffController']> & {
  initialize: ReturnType<typeof vi.fn>
  state: ReturnType<typeof vi.fn>
  recoveryStatus: ReturnType<typeof vi.fn>
  getReceipt: ReturnType<typeof vi.fn>
  preview: ReturnType<typeof vi.fn>
  begin: ReturnType<typeof vi.fn>
  confirm: ReturnType<typeof vi.fn>
}

function fixtureController(): FixtureController {
  return {
    initialize: vi.fn(async () => undefined),
    state: vi.fn(async (input: unknown) => projectedResult(206, 'state', input)),
    recoveryStatus: vi.fn(async (input: unknown) => projectedResult(503, 'recovery', input)),
    getReceipt: vi.fn(async (input: unknown) => projectedResult(404, 'receipt', input)),
    preview: vi.fn(async (input: unknown) => projectedResult(422, 'preview', input)),
    begin: vi.fn(async (input: unknown) => projectedResult(202, 'begin', input)),
    confirm: vi.fn(async (input: unknown) => projectedResult(409, 'confirm', input))
  } as unknown as FixtureController
}

function projectedResult(statusCode: number, route: string, input: unknown) {
  return { statusCode, body: projectedBody(route, input) }
}

function projectedBody(route: string, input: unknown) {
  return { ok: false, error: { code: `FIXTURE_${route.toUpperCase()}`, input } }
}

async function login(role: 'viewer' | 'administrator', password: string): Promise<string> {
  const response = await application!.app.inject({
    method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { role, password }
  })
  expect(response.statusCode).toBe(200)
  return response.cookies[0]!.value
}

const unusedWindowsStatusProvider = {
  name: 'windows' as const,
  collectStatus: vi.fn(async () => await unexpectedRuntimeCall()),
  previewLifecycle: vi.fn(async () => await unexpectedRuntimeCall())
} satisfies StatusProvider

const unusedLifecycleAdapter = {
  mutationEnabled: true,
  previewLifecycle: vi.fn(async () => await unexpectedRuntimeCall()),
  createProtectionPoint: vi.fn(async () => await unexpectedRuntimeCall()),
  requestSave: vi.fn(async () => await unexpectedRuntimeCall()),
  requestGracefulStop: vi.fn(async () => await unexpectedRuntimeCall()),
  verifyStopped: vi.fn(async () => await unexpectedRuntimeCall()),
  requestStart: vi.fn(async () => await unexpectedRuntimeCall()),
  verifyRunning: vi.fn(async () => await unexpectedRuntimeCall()),
  requestRollbackStart: vi.fn(async () => await unexpectedRuntimeCall())
} satisfies LifecycleMutationAdapter

const unusedLifecycleBrokerClient = {
  preflight: vi.fn(async () => await unexpectedRuntimeCall()),
  dispatch: vi.fn(async () => await unexpectedRuntimeCall()),
  verify: vi.fn(async () => await unexpectedRuntimeCall()),
  status: vi.fn(async () => await unexpectedRuntimeCall())
} satisfies WindowsLifecycleBrokerClient

const unusedTrustedCompatibilityService = {
  status: vi.fn(async () => await unexpectedRuntimeCall()),
  prepare: vi.fn(async () => await unexpectedRuntimeCall()),
  getReceipt: vi.fn(async () => await unexpectedRuntimeCall()),
  assertCurrent: vi.fn(async () => await unexpectedRuntimeCall())
} satisfies NonNullable<ApplicationDependencies['trustedCompatibilityService']>

async function unexpectedRuntimeCall(): Promise<never> {
  throw new Error('UNEXPECTED_FIXTURE_RUNTIME_CALL')
}

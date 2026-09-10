import fs from 'node:fs'
import { request as httpRequest } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApplication, type BuiltApplication } from './app.js'
import { loadConfig } from './config.js'
import type {
  LifecycleAction,
  LifecycleBlockerCode,
  LifecycleMutationAdapter,
  LifecycleOperationContext,
  LifecyclePhaseResult,
  LifecyclePreview,
  LifecyclePreviewContext,
  ServerStatus,
  StatusProvider
} from './domain.js'
import { DemoProvider } from './providers/demo.js'
import { buildPlayerSnapshot } from './players/protocol.js'
import type {
  LifecycleBrokerStatusEvidence,
  WindowsLifecycleBrokerClient
} from './providers/windows-lifecycle-broker.js'
import type {
  LifecycleCoordinatorOutcome,
  LifecycleCoordinatorRequest,
  LifecycleCoordinatorScope,
  LifecycleMutationCoordinator
} from './host-mutation/lifecycle-coordinator.js'

let application: BuiltApplication | null = null
const temporaryRoots: string[] = []
afterEach(async () => {
  if (application) await application.close()
  application = null
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('control API', () => {
  it.each(['complete', 'empty', 'truncated', 'expired', 'unavailable'] as const)(
    'projects only a current complete authoritative roster into overview: %s', async (kind) => {
      const config = loadConfig({ NODE_ENV: 'test', DYSON_PROVIDER: 'demo',
        DYSON_DEV_ADMIN_PASSWORD: 'test-password-long-enough', DYSON_PUBLIC_ORIGIN: 'http://127.0.0.1:13010' })
      const demo = new DemoProvider()
      const provider: StatusProvider = {
        name: 'windows', collectStatus: async () => {
          const value = await demo.collectStatus()
          return { ...value, runtime: { ...value.runtime, onlinePlayers: null, maxPlayers: null } }
        }, previewLifecycle: (action) => demo.previewLifecycle(action)
      }
      const now = Date.now()
      const snapshot = buildPlayerSnapshot({
        sessionId: '10000000-0000-4000-8000-000000000001', writtenAtUnixMs: kind === 'expired' ? now - 60_000 : now,
        sequence: 1, state: 'active', truncated: kind === 'truncated',
        players: kind === 'empty' ? [] : [{ sessionPlayerId: 'player-000001', displayName: 'FictionalPlayer',
          online: true, joinedAtUnixMs: now - 120_000, location: 'deep-space' }]
      }, 'fictional-roster-secret-at-least-32-characters').snapshot
      const read = vi.fn(async () => {
        if (kind === 'unavailable') throw new Error('fixture unavailable')
        return snapshot
      })
      application = await buildApplication(config, { statusProvider: provider, playerSnapshotSource: { read } })
      const cookie = await loginAdministrator(application)
      const responses = await Promise.all([1, 2].map(() => application!.app.inject({
        method: 'GET', url: '/api/v1/status', cookies: { dyson_session: cookie }
      })))
      for (const response of responses) {
        expect(response.statusCode).toBe(200)
        expect(response.json().data.runtime.onlinePlayers).toBe(kind === 'complete' ? 1 : kind === 'empty' ? 0 : null)
        expect(response.json().data.runtime.maxPlayers).toBeNull()
      }
      if (kind === 'complete' || kind === 'empty' || kind === 'truncated') expect(read).toHaveBeenCalledTimes(1)
      if (kind === 'complete') {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now + config.playerSnapshotMaximumAgeMs + 1)
        try {
          const expired = await application.app.inject({ method: 'GET', url: '/api/v1/status',
            cookies: { dyson_session: cookie } })
          expect(expired.statusCode).toBe(200)
          expect(expired.json().data.runtime.onlinePlayers).toBeNull()
        } finally { clock.mockRestore() }
      }
    }
  )
  it('echoes the immutable deployment release through the health contract', async () => {
    const config = loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'demo', DYSON_DEV_ADMIN_PASSWORD: 'test-password-long-enough',
      DYSON_PUBLIC_ORIGIN: 'http://127.0.0.1:13010', DYSON_DEPLOYMENT_VERSION: 'v0.1.0-fixture.1'
    })
    application = await buildApplication(config)

    const health = await application.app.inject({ method: 'GET', url: '/healthz' })
    expect(health.statusCode).toBe(200)
    expect(health.headers['x-dyson-control-release']).toBe('v0.1.0-fixture.1')
    expect(health.json()).toMatchObject({
      status: 'ok', version: '0.1.0-rc.23', deploymentVersion: 'v0.1.0-fixture.1'
    })

    const readiness = await application.app.inject({ method: 'GET', url: '/readyz' })
    expect(readiness.statusCode).toBe(200)
    expect(readiness.headers['cache-control']).toBe('no-store')
    expect(readiness.headers['x-dyson-control-release']).toBe('v0.1.0-fixture.1')
    expect(readiness.json()).toMatchObject({
      status: 'ready',
      provider: 'demo',
      version: '0.1.0-rc.23',
      deploymentVersion: 'v0.1.0-fixture.1',
      checks: {
        deploymentVersion: 'not-applicable',
        statusProvider: 'pass',
        projectRoot: 'not-applicable',
        activationRecovery: 'not-applicable'
      }
    })
  })

  it('fails closed before creating database or polling side effects when the lifecycle broker profile is unavailable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fictional-dyson-broker-startup-'))
    const dataDir = path.join(root, 'fictional-data')
    const statusProvider = {
      name: 'windows' as const,
      collectStatus: vi.fn(async () => { throw new Error('UNEXPECTED_FIXTURE_STATUS_POLL') }),
      previewLifecycle: vi.fn(async () => { throw new Error('UNEXPECTED_FIXTURE_LIFECYCLE_PREVIEW') })
    } satisfies StatusProvider
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')

    try {
      const config = loadConfig({
        NODE_ENV: 'test',
        DYSON_PROVIDER: 'windows',
        DYSON_PUBLIC_ORIGIN: 'http://127.0.0.1:13010',
        DYSON_DEV_ADMIN_PASSWORD: 'fictional-administrator-password',
        DYSON_DATA_DIR: dataDir,
        DYSON_PROJECT_ROOT: path.join(root, 'fictional-project'),
        DYSON_SCRIPT_ROOT: path.join(root, 'fictional-installed', 'scripts', 'windows'),
        DYSON_RUNTIME_BOOTSTRAP_ROOT: path.join(root, 'fictional-runtime-bootstrap'),
        DYSON_LIFECYCLE_ENABLED: 'true',
        DYSON_LIFECYCLE_BROKER_PROFILE_FILE:
          path.join(dataDir, 'lifecycle-broker', 'broker-profile.json'),
        DYSON_RUNTIME_SERVICE_USER: '.\\FictionalDyson',
        DYSON_BRIDGE_CONTROL_ROOT: path.join(root, 'fictional-bridge-control'),
        DYSON_BRIDGE_SECRET_FILE: path.join(root, 'fictional-private', 'bridge.secret'),
        DYSON_OBSERVABILITY_INTERVAL_MS: '1000'
      })

      await expect(buildApplication(config, { statusProvider })).rejects.toMatchObject({
        code: 'LIFECYCLE_BROKER_PROFILE_UNAVAILABLE',
        message: 'LIFECYCLE_BROKER_PROFILE_UNAVAILABLE'
      })

      expect(fs.existsSync(dataDir)).toBe(false)
      expect(fs.existsSync(path.join(dataDir, 'control.db'))).toBe(false)
      expect(setIntervalSpy).not.toHaveBeenCalled()
      expect(statusProvider.collectStatus).not.toHaveBeenCalled()
      expect(statusProvider.previewLifecycle).not.toHaveBeenCalled()
      expect(fs.readdirSync(root)).toEqual([])
    } finally {
      setIntervalSpy.mockRestore()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports bounded not-ready evidence when the configured status provider cannot inspect its root', async () => {
    const config = loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'demo', DYSON_DEV_ADMIN_PASSWORD: 'test-password-long-enough',
      DYSON_PUBLIC_ORIGIN: 'http://127.0.0.1:13010'
    })
    const provider: StatusProvider = {
      name: 'windows',
      collectStatus: async () => { throw new Error('C:\\sensitive-host-path must never leave readiness') },
      previewLifecycle: async () => { throw new Error('not used') }
    }
    application = await buildApplication(config, { statusProvider: provider })

    const readiness = await application.app.inject({ method: 'GET', url: '/readyz' })
    expect(readiness.statusCode).toBe(503)
    expect(readiness.headers['cache-control']).toBe('no-store')
    expect(readiness.json()).toMatchObject({
      status: 'not-ready',
      provider: 'windows',
      checks: {
        deploymentVersion: 'not-applicable',
        statusProvider: 'fail',
        projectRoot: 'fail',
        activationRecovery: 'not-applicable'
      }
    })
    expect(readiness.body).not.toContain('sensitive-host-path')
  })

  it('checks the lifecycle broker independently and rejects failed or semantically untrusted status evidence', async () => {
    const config = createWindowsLifecycleConfig()
    const status = await createWindowsStatus('running')
    const trusted = trustedBrokerStatus(config.gamePort, 'running')
    let current: LifecycleBrokerStatusEvidence | Error = trusted
    const broker = createLifecycleBrokerClient(async () => {
      if (current instanceof Error) throw current
      return current
    })
    application = await buildApplication(config, {
      statusProvider: createWindowsStatusProvider(status),
      lifecycleAdapter: new ApiLifecycleAdapter(),
      lifecycleBrokerClient: broker
    })

    const unknownRuntime: LifecycleBrokerStatusEvidence = {
      ...trusted,
      lifecycleState: 'unknown_unverifiable',
      runtime: {
        ...trusted.runtime,
        lifecycleState: 'unknown_unverifiable',
        process: { status: 'unverifiable', pid: null, owner: null, sessionId: null },
        port: { port: config.gamePort, listenerCount: 0 },
        pidFile: { present: false, valid: false }
      }
    }
    const cases: Array<[string, LifecycleBrokerStatusEvidence | Error]> = [
      ['broker call failed', new Error('C:\\fictional-private\\broker-status-failure')],
      ['task binding invalid', { ...trusted, task: { ...trusted.task, valid: false } }],
      ['runtime unverifiable', unknownRuntime],
      ['profile port drift', {
        ...trusted,
        runtime: {
          ...trusted.runtime,
          port: { ...trusted.runtime.port, port: config.gamePort + 1 }
        }
      }]
    ]

    for (const [label, evidence] of cases) {
      current = evidence
      const readiness = await application.app.inject({ method: 'GET', url: '/readyz' })
      expect(readiness.statusCode, label).toBe(503)
      expect(readiness.json().checks.lifecycleBroker, label).toBe('fail')
      expect(readiness.body, label).not.toContain('fictional-private')
    }

    current = trusted
    const readiness = await application.app.inject({ method: 'GET', url: '/readyz' })
    expect(readiness.statusCode).toBe(200)
    expect(readiness.json()).toMatchObject({
      status: 'ready',
      checks: { statusProvider: 'pass', projectRoot: 'pass', lifecycleBroker: 'pass' }
    })
    expect(broker.status).toHaveBeenCalledTimes(cases.length + 1)
  })

  it('keeps start capability false when authoritative session or Steam preflight blocks execution', async () => {
    const config = createWindowsLifecycleConfig()
    const status = await createWindowsStatus('stopped')
    let blocker: LifecycleBlockerCode = 'interactive-session-missing'
    const adapter = new ConfigurablePreviewLifecycleAdapter((action) =>
      blockedLifecyclePreview(action, blocker))
    application = await buildApplication(config, {
      statusProvider: createWindowsStatusProvider(status),
      lifecycleAdapter: adapter,
      lifecycleBrokerClient: createLifecycleBrokerClient(async () => trustedBrokerStatus(config.gamePort, 'stopped'))
    })
    const cookie = await loginAdministrator(application)

    for (const expectedBlocker of ['interactive-session-missing', 'steam-session-missing'] as const) {
      blocker = expectedBlocker
      const response = await application.app.inject({
        method: 'GET', url: '/api/v1/status', cookies: { dyson_session: cookie }
      })
      expect(response.statusCode).toBe(200)
      expect(response.json().data.capabilities).toMatchObject({
        start: false, save: false, gracefulStop: false, restart: false
      })
    }
    expect(adapter.calls).toEqual(['preflight:start', 'preflight:start'])
  })

  it('keeps running lifecycle capabilities false when the signed save bridge preflight is blocked', async () => {
    const config = createWindowsLifecycleConfig()
    const status = await createWindowsStatus('running')
    const adapter = new ConfigurablePreviewLifecycleAdapter((action) =>
      blockedLifecyclePreview(action, 'save-trigger-unverified'))
    application = await buildApplication(config, {
      statusProvider: createWindowsStatusProvider(status),
      lifecycleAdapter: adapter,
      lifecycleBrokerClient: createLifecycleBrokerClient(async () => trustedBrokerStatus(config.gamePort, 'running'))
    })
    const cookie = await loginAdministrator(application)

    const response = await application.app.inject({
      method: 'GET', url: '/api/v1/status', cookies: { dyson_session: cookie }
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().data.capabilities).toMatchObject({
      start: false, save: false, gracefulStop: false, restart: false
    })
    expect(adapter.calls).toEqual(expect.arrayContaining([
      'preflight:save', 'preflight:graceful-stop', 'preflight:restart'
    ]))
  })

  it('applies one total deadline to a public lifecycle preview and aborts its adapter signal', async () => {
    const config = {
      ...loadConfig({
        NODE_ENV: 'test', DYSON_PROVIDER: 'demo', DYSON_DEV_ADMIN_PASSWORD: 'test-password-long-enough',
        DYSON_PUBLIC_ORIGIN: 'http://127.0.0.1:13010'
      }),
      lifecycleTimeoutMs: 25
    }
    const adapter = new DeferredPreviewLifecycleAdapter()
    application = await buildApplication(config, { lifecycleAdapter: adapter })
    const cookie = await loginAdministrator(application)
    const startedAt = Date.now()

    const response = await application.app.inject({
      method: 'POST', url: '/api/v1/actions/lifecycle/preview',
      headers: { origin: 'http://127.0.0.1:13010' }, cookies: { dyson_session: cookie },
      payload: { action: 'save' }
    })

    expect(response.statusCode).toBe(503)
    expect(response.json().error.code).toBe('LIFECYCLE_PREVIEW_FAILED')
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(adapter.signal?.aborted).toBe(true)
    expect(adapter.signal?.reason).toBe('lifecycle-preview-timeout')
  })

  it('propagates a disconnected HTTP client to the public lifecycle preview signal', async () => {
    const config = {
      ...loadConfig({
        NODE_ENV: 'test', DYSON_PROVIDER: 'demo', DYSON_DEV_ADMIN_PASSWORD: 'test-password-long-enough',
        DYSON_PUBLIC_ORIGIN: 'http://127.0.0.1:13010'
      }),
      lifecycleTimeoutMs: 5_000
    }
    const adapter = new DeferredPreviewLifecycleAdapter()
    application = await buildApplication(config, { lifecycleAdapter: adapter })
    const address = await application.app.listen({ host: '127.0.0.1', port: 0 })
    const cookie = await loginAdministrator(application)
    const body = JSON.stringify({ action: 'save' })
    let client: ReturnType<typeof httpRequest> | null = null
    const clientClosed = new Promise<void>((resolve) => {
      client = httpRequest(new URL('/api/v1/actions/lifecycle/preview', address), {
        method: 'POST',
        headers: {
          origin: 'http://127.0.0.1:13010',
          cookie: `dyson_session=${cookie}`,
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body))
        }
      }, (response) => {
        response.resume()
        response.once('end', resolve)
      })
      client.once('error', () => resolve())
      client.once('close', () => resolve())
      client.end(body)
    })

    await withTimeout(adapter.started.promise, 1_000)
    client!.destroy()
    await withTimeout(adapter.aborted.promise, 1_000)
    await withTimeout(clientClosed, 1_000)

    expect(adapter.signal?.aborted).toBe(true)
    expect(['http-request-aborted', 'http-client-disconnected']).toContain(adapter.signal?.reason)
  })

  it('protects status and supports authenticated refresh and lifecycle-preview jobs', async () => {
    const config = loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'demo', DYSON_DEV_ADMIN_PASSWORD: 'test-password-long-enough',
      DYSON_PUBLIC_ORIGIN: 'http://127.0.0.1:13010'
    })
    application = await buildApplication(config)
    expect((await application.app.inject({ method: 'GET', url: '/api/v1/status' })).statusCode).toBe(401)

    const login = await application.app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      headers: { origin: 'http://127.0.0.1:13010' },
      payload: { password: 'test-password-long-enough' }
    })
    expect(login.statusCode).toBe(200)
    const cookie = login.cookies[0]?.value
    expect(cookie).toBeTruthy()

    const status = await application.app.inject({
      method: 'GET', url: '/api/v1/status', cookies: { dyson_session: cookie! }
    })
    expect(status.statusCode).toBe(200)
    expect(status.json().data.capabilities.save).toBe(false)
    expect(status.json().meta).toEqual({ provider: 'demo', environment: 'test' })

    const refresh = await application.app.inject({
      method: 'POST', url: '/api/v1/actions/refresh',
      headers: { origin: 'http://127.0.0.1:13010' }, cookies: { dyson_session: cookie! }
    })
    expect(refresh.statusCode).toBe(202)
    expect(refresh.json().data.kind).toBe('status.refresh')

    const preview = await application.app.inject({
      method: 'POST', url: '/api/v1/actions/lifecycle/preview',
      headers: { origin: 'http://127.0.0.1:13010' }, cookies: { dyson_session: cookie! },
      payload: { action: 'graceful-stop' }
    })
    expect(preview.statusCode).toBe(200)
    expect(preview.json().data.job).toMatchObject({
      kind: 'game.stop.preview', state: 'succeeded', errorCode: null
    })
    expect(preview.json().data.preview).toMatchObject({
      action: 'graceful-stop', mode: 'dry-run', allowed: false, executionEnabled: false
    })
    expect(preview.json().data.preview.blockers).toContain('execution-disabled')
    expect(preview.json().data.preview.blockers).toContain('lifecycle-broker-unavailable')
    expect(preview.json().data.preview.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'interactive-session', status: 'pass' }),
      expect.objectContaining({ id: 'steam-session', status: 'not-applicable' }),
      expect.objectContaining({ id: 'lifecycle-broker', status: 'block' })
    ]))

    const demoStartPreview = await application.app.inject({
      method: 'POST', url: '/api/v1/actions/lifecycle/preview',
      headers: { origin: 'http://127.0.0.1:13010' }, cookies: { dyson_session: cookie! },
      payload: { action: 'start' }
    })
    expect(demoStartPreview.statusCode).toBe(200)
    expect(demoStartPreview.json().data).toMatchObject({
      job: { kind: 'game.start.preview', state: 'succeeded' },
      preview: { action: 'start', allowed: false, executionEnabled: false }
    })
    expect(demoStartPreview.json().data.preview.blockers).toEqual(expect.arrayContaining([
      'server-already-running', 'game-port-listening', 'execution-disabled'
    ]))

    const jobs = await application.app.inject({
      method: 'GET', url: '/api/v1/jobs', cookies: { dyson_session: cookie! }
    })
    expect(jobs.json().data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: preview.json().data.job.id, kind: 'game.stop.preview', state: 'succeeded' })
    ]))

    const invalidPreview = await application.app.inject({
      method: 'POST', url: '/api/v1/actions/lifecycle/preview',
      headers: { origin: 'http://127.0.0.1:13010' }, cookies: { dyson_session: cookie! },
      payload: { action: 'force-kill' }
    })
    expect(invalidPreview.statusCode).toBe(400)
    expect(invalidPreview.json().error.code).toBe('INVALID_LIFECYCLE_ACTION')

    const extraInputPreview = await application.app.inject({
      method: 'POST', url: '/api/v1/actions/lifecycle/preview',
      headers: { origin: 'http://127.0.0.1:13010' }, cookies: { dyson_session: cookie! },
      payload: { action: 'save', command: 'untrusted-input' }
    })
    expect(extraInputPreview.statusCode).toBe(400)

    const disabledExecution = await application.app.inject({
      method: 'POST', url: '/api/v1/actions/lifecycle/execute',
      headers: { origin: 'http://127.0.0.1:13010' }, cookies: { dyson_session: cookie! },
      payload: { action: 'save', idempotencyKey: 'save:disabled:fixture-0001', confirmation: 'EXECUTE' }
    })
    expect(disabledExecution.statusCode).toBe(202)
    const disabledResult = await waitForLifecycle(application, cookie!, disabledExecution.json().data.job.id)
    expect(disabledResult.job).toMatchObject({
      state: 'failed', errorCode: 'LIFECYCLE_EXECUTION_DISABLED'
    })
    expect(disabledResult.receipts).toEqual([
      expect.objectContaining({ phase: 'lock', state: 'succeeded' }),
      expect.objectContaining({
        phase: 'preflight', state: 'failed', errorCode: 'LIFECYCLE_EXECUTION_DISABLED'
      })
    ])
  })

  it('executes, polls, and idempotently reuses a durable lifecycle API transaction', async () => {
    const config = loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'demo', DYSON_DEV_ADMIN_PASSWORD: 'test-password-long-enough',
      DYSON_PUBLIC_ORIGIN: 'http://127.0.0.1:13010'
    })
    const adapter = new ApiLifecycleAdapter()
    const coordinator = new ApiLifecycleCoordinator()
    application = await buildApplication(config, {
      lifecycleAdapter: adapter,
      lifecycleCoordinator: coordinator
    })

    const login = await application.app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      headers: { origin: 'http://127.0.0.1:13010' },
      payload: { password: 'test-password-long-enough' }
    })
    const cookie = login.cookies[0]?.value
    expect(cookie).toBeTruthy()

    const executablePreview = await application.app.inject({
      method: 'POST', url: '/api/v1/actions/lifecycle/preview',
      headers: { origin: 'http://127.0.0.1:13010' }, cookies: { dyson_session: cookie! },
      payload: { action: 'save' }
    })
    expect(executablePreview.statusCode).toBe(200)
    expect(executablePreview.json().data.preview).toMatchObject({
      action: 'save', allowed: true, executionEnabled: true, blockers: []
    })

    const request = {
      action: 'save', idempotencyKey: 'save:api:fixture-0001', confirmation: 'EXECUTE'
    } as const
    const accepted = await application.app.inject({
      method: 'POST', url: '/api/v1/actions/lifecycle/execute',
      headers: { origin: 'http://127.0.0.1:13010' }, cookies: { dyson_session: cookie! },
      payload: request
    })
    expect(accepted.statusCode).toBe(202)
    expect(accepted.json().data).toMatchObject({ reused: false, job: { state: 'queued' } })

    const completed = await waitForLifecycle(application, cookie!, accepted.json().data.job.id)
    expect(completed).toMatchObject({
      job: { state: 'succeeded', errorCode: null },
      run: { state: 'succeeded', protectionPointId: 'backup:api-fixture-0001' }
    })
    expect(completed.receipts.map((receipt: { phase: string }) => receipt.phase)).toEqual([
      'lock', 'preflight', 'protection-point', 'save'
    ])
    expect(adapter.calls).toEqual(['preflight:save', 'preflight:save', 'protection-point', 'save'])
    expect(coordinator.requests).toEqual([
      expect.objectContaining({ action: 'save' })
    ])
    expect(coordinator.dispositions).toEqual(['release'])

    const duplicate = await application.app.inject({
      method: 'POST', url: '/api/v1/actions/lifecycle/execute',
      headers: { origin: 'http://127.0.0.1:13010' }, cookies: { dyson_session: cookie! },
      payload: request
    })
    expect(duplicate.statusCode).toBe(200)
    expect(duplicate.json().data).toMatchObject({
      reused: true, job: { id: accepted.json().data.job.id, state: 'succeeded' }
    })
    expect(adapter.calls).toHaveLength(4)

    const conflictingAction = await application.app.inject({
      method: 'POST', url: '/api/v1/actions/lifecycle/execute',
      headers: { origin: 'http://127.0.0.1:13010' }, cookies: { dyson_session: cookie! },
      payload: { ...request, action: 'restart' }
    })
    expect(conflictingAction.statusCode).toBe(409)
    expect(conflictingAction.json().error.code).toBe('LIFECYCLE_IDEMPOTENCY_CONFLICT')
    expect(adapter.calls).toHaveLength(4)

    const unrecognizedInput = await application.app.inject({
      method: 'POST', url: '/api/v1/actions/lifecycle/execute',
      headers: { origin: 'http://127.0.0.1:13010' }, cookies: { dyson_session: cookie! },
      payload: { ...request, command: 'untrusted-input' }
    })
    expect(unrecognizedInput.statusCode).toBe(400)
    expect(unrecognizedInput.json().error.code).toBe('INVALID_LIFECYCLE_EXECUTION')

    const invalidId = await application.app.inject({
      method: 'GET', url: '/api/v1/lifecycle/not-a-uuid', cookies: { dyson_session: cookie! }
    })
    expect(invalidId.statusCode).toBe(400)

    const startPreview = await application.app.inject({
      method: 'POST', url: '/api/v1/actions/lifecycle/preview',
      headers: { origin: 'http://127.0.0.1:13010' }, cookies: { dyson_session: cookie! },
      payload: { action: 'start' }
    })
    expect(startPreview.statusCode).toBe(200)
    expect(startPreview.json().data).toMatchObject({
      job: { kind: 'game.start.preview', state: 'succeeded' },
      preview: { action: 'start', allowed: true, executionEnabled: true }
    })

    const acceptedStart = await application.app.inject({
      method: 'POST', url: '/api/v1/actions/lifecycle/execute',
      headers: { origin: 'http://127.0.0.1:13010' }, cookies: { dyson_session: cookie! },
      payload: {
        action: 'start', idempotencyKey: 'start:api:fixture-0001', confirmation: 'EXECUTE'
      }
    })
    expect(acceptedStart.statusCode).toBe(202)
    expect(acceptedStart.json().data.job.kind).toBe('game.start')
    const completedStart = await waitForLifecycle(application, cookie!, acceptedStart.json().data.job.id)
    expect(completedStart).toMatchObject({
      job: { state: 'succeeded', errorCode: null },
      run: { action: 'start', protectionPointId: null, recoveryRequired: false }
    })
    expect(completedStart.receipts.map((receipt: { phase: string }) => receipt.phase)).toEqual([
      'lock', 'preflight', 'start', 'verify-running'
    ])
    expect(coordinator.requests).toEqual([
      expect.objectContaining({ action: 'save' }),
      expect.objectContaining({ action: 'start' })
    ])
    expect(coordinator.dispositions).toEqual(['release', 'release'])

    const arbitraryStartTarget = await application.app.inject({
      method: 'POST', url: '/api/v1/actions/lifecycle/execute',
      headers: { origin: 'http://127.0.0.1:13010' }, cookies: { dyson_session: cookie! },
      payload: {
        action: 'start', idempotencyKey: 'start:api:arbitrary-target-01', confirmation: 'EXECUTE',
        taskName: 'Untrusted-Task', executable: 'C:\\Untrusted\\server.exe', command: 'anything'
      }
    })
    expect(arbitraryStartTarget.statusCode).toBe(400)
    expect(arbitraryStartTarget.json().error.code).toBe('INVALID_LIFECYCLE_EXECUTION')
  })
})

class ApiLifecycleCoordinator implements LifecycleMutationCoordinator {
  readonly requests: LifecycleCoordinatorRequest[] = []
  readonly dispositions: Array<'release' | 'abandon'> = []
  readonly #controller = new AbortController()

  async runExclusive<T>(
    request: LifecycleCoordinatorRequest,
    operation: (
      scope: LifecycleCoordinatorScope
    ) => Promise<LifecycleCoordinatorOutcome<T>> | LifecycleCoordinatorOutcome<T>
  ): Promise<T> {
    this.requests.push(request)
    const outcome = await operation({
      signal: this.#controller.signal,
      assertActive: () => undefined,
      toPowerShellBorrowArguments: () => [
        '-DataRoot', 'C:\\fixture\\data',
        '-LeaseInstanceId', '00000000-0000-4000-8000-000000000301',
        '-LeaseToken', 'A'.repeat(43)
      ]
    })
    this.dispositions.push(outcome.disposition)
    return outcome.value
  }
}

class ApiLifecycleAdapter implements LifecycleMutationAdapter {
  readonly mutationEnabled = true
  readonly calls: string[] = []

  async previewLifecycle(action: LifecycleAction, _context?: LifecyclePreviewContext): Promise<LifecyclePreview> {
    this.calls.push(`preflight:${action}`)
    return allowedLifecyclePreview(action)
  }

  async createProtectionPoint(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    this.calls.push('protection-point')
    return { summary: 'API fixture protection point created', protectionPointId: 'backup:api-fixture-0001' }
  }

  async requestSave(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    this.calls.push('save')
    return { summary: 'API fixture save completed', evidence: { pairStable: true } }
  }

  requestGracefulStop(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    return this.#unexpected('stop')
  }

  verifyStopped(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    return this.#unexpected('verify-stopped')
  }

  async requestStart(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    this.calls.push('start')
    return { summary: 'API fixture fixed start task completed' }
  }

  async verifyRunning(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    this.calls.push('verify-running')
    return { summary: 'API fixture managed process and port are running' }
  }

  requestRollbackStart(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    return this.#unexpected('rollback-start')
  }

  #unexpected(phase: string): Promise<never> {
    return Promise.reject(new Error(`Unexpected API fixture phase: ${phase}`))
  }
}

type LifecyclePreviewFactory = (
  action: LifecycleAction,
  context?: LifecyclePreviewContext
) => LifecyclePreview | Promise<LifecyclePreview>

class ConfigurablePreviewLifecycleAdapter extends ApiLifecycleAdapter {
  readonly #previewFor: LifecyclePreviewFactory

  constructor(previewFor: LifecyclePreviewFactory) {
    super()
    this.#previewFor = previewFor
  }

  override async previewLifecycle(
    action: LifecycleAction,
    context?: LifecyclePreviewContext
  ): Promise<LifecyclePreview> {
    this.calls.push(`preflight:${action}`)
    return await this.#previewFor(action, context)
  }
}

class DeferredPreviewLifecycleAdapter extends ApiLifecycleAdapter {
  readonly started = deferred<void>()
  readonly aborted = deferred<void>()
  signal: AbortSignal | null = null

  override async previewLifecycle(
    action: LifecycleAction,
    context?: LifecyclePreviewContext
  ): Promise<LifecyclePreview> {
    this.calls.push(`preflight:${action}`)
    if (!context?.signal) throw new Error('FIXTURE_PREVIEW_SIGNAL_MISSING')
    this.signal = context.signal
    this.started.resolve()
    return await new Promise<LifecyclePreview>((_resolve, reject) => {
      const onAbort = () => {
        context.signal?.removeEventListener('abort', onAbort)
        this.aborted.resolve()
        reject(new Error('FIXTURE_PREVIEW_ABORTED'))
      }
      if (context.signal!.aborted) onAbort()
      else context.signal!.addEventListener('abort', onAbort, { once: true })
    })
  }
}

function allowedLifecyclePreview(action: LifecycleAction): LifecyclePreview {
  return {
    collectedAt: new Date().toISOString(),
    action,
    mode: 'dry-run',
    allowed: true,
    executionEnabled: true,
    checks: [{ id: 'execution-lock', status: 'pass', message: 'API fixture is ready' }],
    blockers: [],
    rollback: action === 'start'
      ? { strategy: 'no-op', ready: true, summary: 'API fixture start changes no save files' }
      : { strategy: 'paired-save-backup', ready: true, summary: 'API fixture rollback is ready' }
  }
}

function blockedLifecyclePreview(
  action: LifecycleAction,
  blocker: LifecycleBlockerCode
): LifecyclePreview {
  const preview = allowedLifecyclePreview(action)
  return {
    ...preview,
    allowed: false,
    checks: [{ id: 'execution-lock', status: 'block', message: 'Authoritative fixture preflight blocked.' }],
    blockers: [blocker]
  }
}

function createWindowsLifecycleConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fictional-dyson-lifecycle-app-'))
  temporaryRoots.push(root)
  return loadConfig({
    NODE_ENV: 'test',
    DYSON_PROVIDER: 'windows',
    DYSON_PUBLIC_ORIGIN: 'http://127.0.0.1:13010',
    DYSON_DEV_ADMIN_PASSWORD: 'test-password-long-enough',
    DYSON_DATA_DIR: path.join(root, 'fictional-data'),
    DYSON_PROJECT_ROOT: path.join(root, 'fictional-project'),
    DYSON_SCRIPT_ROOT: path.join(root, 'fictional-installed', 'scripts', 'windows'),
    DYSON_RUNTIME_BOOTSTRAP_ROOT: path.join(root, 'fictional-runtime-bootstrap'),
    DYSON_LIFECYCLE_ENABLED: 'true',
    DYSON_LIFECYCLE_BROKER_PROFILE_FILE:
      path.join(root, 'fictional-data', 'lifecycle-broker', 'broker-profile.json'),
    DYSON_RUNTIME_SERVICE_USER: '.\\FictionalDyson',
    DYSON_BRIDGE_CONTROL_ROOT: path.join(root, 'fictional-bridge-control'),
    DYSON_BRIDGE_SECRET_FILE: path.join(root, 'fictional-private', 'bridge.secret'),
    DYSON_OBSERVABILITY_INTERVAL_MS: '0'
  })
}

async function createWindowsStatus(state: 'running' | 'stopped'): Promise<ServerStatus> {
  const status = await new DemoProvider().collectStatus()
  return {
    ...status,
    state,
    automation: { ...status.automation, projectRootAvailable: true }
  }
}

function createWindowsStatusProvider(status: ServerStatus): StatusProvider {
  return {
    name: 'windows',
    collectStatus: vi.fn(async () => status),
    previewLifecycle: vi.fn(async () => { throw new Error('UNEXPECTED_STATUS_PROVIDER_PREVIEW') })
  }
}

function trustedBrokerStatus(
  gamePort: number,
  state: 'running' | 'stopped'
): LifecycleBrokerStatusEvidence {
  const running = state === 'running'
  const lifecycleState = running ? 'running_verified' as const : 'stopped_verified' as const
  return {
    lifecycleState,
    task: {
      valid: true,
      server: { name: 'Dyson-Nebula-Server', path: '\\', state: running ? 'Running' : 'Ready' },
      stop: { name: 'Dyson-Nebula-Stop', path: '\\', state: 'Ready' }
    },
    runtime: {
      lifecycleState,
      session: { status: 'verified', id: 7, count: 1 },
      steam: { status: 'verified', pid: 1101, sessionId: 7 },
      process: running
        ? { status: 'verified', pid: 2202, owner: '.\\FictionalDyson', sessionId: 7 }
        : { status: 'absent', pid: null, owner: null, sessionId: null },
      port: { port: gamePort, listenerCount: running ? 1 : 0 },
      pidFile: { present: running, valid: running }
    }
  }
}

function createLifecycleBrokerClient(status: WindowsLifecycleBrokerClient['status']) {
  return {
    preflight: vi.fn(async () => { throw new Error('UNEXPECTED_BROKER_PREFLIGHT') }),
    dispatch: vi.fn(async () => { throw new Error('UNEXPECTED_BROKER_DISPATCH') }),
    verify: vi.fn(async () => { throw new Error('UNEXPECTED_BROKER_VERIFY') }),
    status: vi.fn(status)
  } satisfies WindowsLifecycleBrokerClient
}

async function loginAdministrator(target: BuiltApplication): Promise<string> {
  const response = await target.app.inject({
    method: 'POST', url: '/api/v1/auth/login',
    headers: { origin: 'http://127.0.0.1:13010' },
    payload: { role: 'administrator', password: 'test-password-long-enough' }
  })
  expect(response.statusCode).toBe(200)
  const cookie = response.cookies[0]?.value
  expect(cookie).toBeTruthy()
  return cookie!
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('FIXTURE_TIMEOUT')), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function waitForLifecycle(application: BuiltApplication, cookie: string, id: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await application.app.inject({
      method: 'GET', url: `/api/v1/lifecycle/${id}`, cookies: { dyson_session: cookie }
    })
    expect(response.statusCode).toBe(200)
    const result = response.json().data
    if (result.job.state === 'succeeded' || result.job.state === 'failed') return result
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Lifecycle transaction did not finish: ${id}`)
}

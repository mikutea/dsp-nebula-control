import { afterEach, describe, expect, it } from 'vitest'
import { buildApplication, type BuiltApplication } from './app.js'
import { loadConfig } from './config.js'
import type {
  LifecycleAction,
  LifecycleMutationAdapter,
  LifecycleOperationContext,
  LifecyclePhaseResult,
  LifecyclePreview,
  StatusProvider
} from './domain.js'

let application: BuiltApplication | null = null
afterEach(async () => { if (application) await application.close(); application = null })

describe('control API', () => {
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
      status: 'ok', version: '0.1.0', deploymentVersion: 'v0.1.0-fixture.1'
    })

    const readiness = await application.app.inject({ method: 'GET', url: '/readyz' })
    expect(readiness.statusCode).toBe(200)
    expect(readiness.headers['cache-control']).toBe('no-store')
    expect(readiness.headers['x-dyson-control-release']).toBe('v0.1.0-fixture.1')
    expect(readiness.json()).toMatchObject({
      status: 'ready',
      provider: 'demo',
      version: '0.1.0',
      deploymentVersion: 'v0.1.0-fixture.1',
      checks: {
        deploymentVersion: 'not-applicable',
        statusProvider: 'pass',
        projectRoot: 'not-applicable',
        activationRecovery: 'not-applicable'
      }
    })
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
    application = await buildApplication(config, { lifecycleAdapter: adapter })

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

class ApiLifecycleAdapter implements LifecycleMutationAdapter {
  readonly mutationEnabled = true
  readonly calls: string[] = []

  async previewLifecycle(action: LifecycleAction): Promise<LifecyclePreview> {
    this.calls.push(`preflight:${action}`)
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

import { afterEach, describe, expect, it } from 'vitest'
import { buildApplication, type BuiltApplication } from './app.js'
import { loadConfig } from './config.js'

let application: BuiltApplication | null = null
afterEach(async () => { if (application) await application.close(); application = null })

describe('control API', () => {
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
  })
})

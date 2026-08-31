import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ControlRole } from '../security/authorization.js'
import {
  registerBackupRetentionRoutes,
  type BackupRetentionRoutesController
} from './retention-routes.js'

let app: FastifyInstance | null = null

afterEach(async () => {
  await app?.close()
  app = null
})

describe('backup retention routes', () => {
  it('requires authentication before invoking the controller', async () => {
    const controller = createController()
    app = buildRoutes(controller)

    const response = await app.inject({ method: 'GET', url: '/api/v1/backups/retention/annotations' })
    expect(response.statusCode).toBe(401)
    expect(controller.annotations).not.toHaveBeenCalled()
  })

  it('allows read routes to viewers but reserves every mutation for administrators', async () => {
    const controller = createController()
    app = buildRoutes(controller)

    const read = await app.inject({
      method: 'POST',
      url: '/api/v1/backups/retention/preview',
      headers: { 'x-test-role': 'viewer' },
      payload: { referenceTime: '2026-08-31T08:00:00.000Z', policy: {} }
    })
    expect(read.statusCode).toBe(200)
    expect(controller.preview).toHaveBeenCalledOnce()

    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/backups/retention/annotations',
      headers: { 'x-test-role': 'operator' },
      payload: { requestId: 'opaque' }
    })
    expect(denied.statusCode).toBe(403)
    expect(controller.annotate).not.toHaveBeenCalled()

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v1/backups/retention/annotations',
      headers: { 'x-test-role': 'administrator' },
      payload: { requestId: 'opaque' }
    })
    expect(accepted.statusCode).toBe(201)
    expect(controller.annotate).toHaveBeenCalledWith({ requestId: 'opaque' })
  })

  it('marks query-parameter smuggling so the strict controller can reject it', async () => {
    const controller = createController()
    app = buildRoutes(controller)
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/backups/retention/purge/preview?path=private',
      headers: { 'x-test-role': 'viewer' },
      payload: { retirementRequestId: 'opaque' }
    })

    expect(response.statusCode).toBe(200)
    expect(controller.previewPurge).toHaveBeenCalledWith({
      retirementRequestId: 'opaque',
      __unexpectedQueryParameters: true
    })
  })

  it('enforces a small body limit before a mutation reaches the controller', async () => {
    const controller = createController()
    app = buildRoutes(controller)
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/backups/retention/execute',
      headers: { 'x-test-role': 'administrator' },
      payload: { padding: 'x'.repeat(20 * 1024) }
    })

    expect(response.statusCode).toBe(413)
    expect(controller.execute).not.toHaveBeenCalled()
  })
})

function buildRoutes(controller: BackupRetentionRoutesController): FastifyInstance {
  const instance = Fastify({ logger: false })
  registerBackupRetentionRoutes(instance, {
    controller,
    authenticate: async (request, reply) => {
      const role = request.headers['x-test-role']
      if (!isTestRole(role)) {
        await reply.code(401).send({ error: { code: 'AUTHENTICATION_REQUIRED' } })
        return
      }
      request.actorRole = role
    }
  })
  return instance
}

function isTestRole(value: unknown): value is ControlRole {
  return value === 'viewer' || value === 'operator' || value === 'administrator'
}

function createController(): BackupRetentionRoutesController {
  const ok = { statusCode: 200, body: { data: [] } } as const
  return {
    annotations: vi.fn(async () => ok),
    annotate: vi.fn(async () => ({ statusCode: 201, body: { data: {} } })),
    preview: vi.fn(async () => ok),
    execute: vi.fn(async () => ({ statusCode: 201, body: { data: {} } })),
    restore: vi.fn(async () => ({ statusCode: 201, body: { data: {} } })),
    previewPurge: vi.fn(async () => ok),
    purge: vi.fn(async () => ({ statusCode: 201, body: { data: {} } }))
  }
}

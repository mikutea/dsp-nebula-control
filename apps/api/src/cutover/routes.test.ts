import Fastify, { type FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerCutoverRoutes, type CutoverRoutesController } from './routes.js'
import { PREPARE_GSMANAGER_TO_DYSON } from './types.js'

describe('cutover routes', () => {
  let app: FastifyInstance
  let controller: Record<keyof CutoverRoutesController, ReturnType<typeof vi.fn>>

  beforeEach(async () => {
    controller = {
      recoveryStatus: vi.fn(async () => result(200, { phase: 'ready' })),
      preview: vi.fn(async () => result(200, { operation: 'prepare' })),
      prepare: vi.fn(async () => result(202, { phase: 'prepared' })),
      activate: vi.fn(async () => result(202, { phase: 'activated' })),
      rollback: vi.fn(async () => result(202, { phase: 'rolled-back-later' })),
      recover: vi.fn(async () => result(202, { phase: 'recovered-previous' }))
    }
    app = Fastify()
    app.decorateRequest('actorRole', null)
    registerCutoverRoutes(app, {
      controller: controller as unknown as CutoverRoutesController,
      authenticate: async (request, reply) => {
        const role = request.headers['x-test-role']
        if (role !== 'viewer' && role !== 'operator' && role !== 'administrator') {
          await reply.code(401).send({ error: { code: 'AUTHENTICATION_REQUIRED' } })
          return
        }
        request.actorRole = role
      }
    })
    await app.ready()
  })

  it('allows every authenticated role to read bounded cutover recovery status', async () => {
    for (const role of ['viewer', 'operator', 'administrator']) {
      const response = await app.inject({
        method: 'GET', url: '/api/v1/cutover/status', headers: { 'x-test-role': role }
      })
      expect(response.statusCode).toBe(200)
    }
    expect(controller.recoveryStatus).toHaveBeenCalledTimes(3)
    expect(controller.recoveryStatus).toHaveBeenCalledWith({})
  })

  it('reserves every cutover mutation for administrators', async () => {
    for (const role of ['viewer', 'operator']) {
      const response = await app.inject({
        method: 'POST', url: '/api/v1/cutover/prepare', headers: { 'x-test-role': role },
        payload: {
          requestId: '00000000-0000-4000-8000-000000000001',
          confirmation: PREPARE_GSMANAGER_TO_DYSON
        }
      })
      expect(response.statusCode).toBe(403)
    }
    expect(controller.prepare).not.toHaveBeenCalled()

    const allowed = await app.inject({
      method: 'POST', url: '/api/v1/cutover/prepare', headers: { 'x-test-role': 'administrator' },
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

  it('reserves the executable server preview for administrators and binds its exact route', async () => {
    const payload = {
      requestId: '00000000-0000-4000-8000-000000000009',
      operation: 'prepare'
    }
    for (const role of ['viewer', 'operator']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/cutover/preview',
        headers: { 'x-test-role': role },
        payload
      })
      expect(response.statusCode).toBe(403)
    }
    expect(controller.preview).not.toHaveBeenCalled()

    const allowed = await app.inject({
      method: 'POST',
      url: '/api/v1/cutover/preview',
      headers: { 'x-test-role': 'administrator' },
      payload
    })
    expect(allowed.statusCode).toBe(200)
    expect(controller.preview).toHaveBeenCalledWith(payload)
  })

  it('binds the four mutation routes to their exact controller methods and status codes', async () => {
    const fixtures = [
      ['/api/v1/cutover/activate', 'activate', { requestId: '1', confirmation: 'ACTIVATE' }],
      ['/api/v1/cutover/rollback', 'rollback', { requestId: '2', mode: 'later' }],
      ['/api/v1/cutover/recover', 'recover', { requestId: '3', desired: 'previous' }]
    ] as const
    for (const [url, method, payload] of fixtures) {
      const response = await app.inject({
        method: 'POST', url, headers: { 'x-test-role': 'administrator' }, payload
      })
      expect(response.statusCode).toBe(202)
      expect(controller[method]).toHaveBeenCalledWith(payload, { actorRole: 'administrator' })
    }
  })

  it('marks every unexpected query so the strict controller rejects it', async () => {
    await app.inject({
      method: 'GET', url: '/api/v1/cutover/status?extra=1', headers: { 'x-test-role': 'viewer' }
    })
    expect(controller.recoveryStatus).toHaveBeenLastCalledWith({
      __unexpectedQueryParameters: true
    })

    const payload = {
      requestId: '00000000-0000-4000-8000-000000000001',
      confirmation: PREPARE_GSMANAGER_TO_DYSON
    }
    await app.inject({
      method: 'POST', url: '/api/v1/cutover/prepare?extra=1',
      headers: { 'x-test-role': 'administrator' }, payload
    })
    expect(controller.prepare).toHaveBeenLastCalledWith({
      ...payload,
      __unexpectedQueryParameters: true
    }, { actorRole: 'administrator' })
  })

  it('rejects an oversized mutation body before invoking the controller', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/cutover/prepare',
      headers: { 'x-test-role': 'administrator' },
      payload: { requestId: '00000000-0000-4000-8000-000000000001', padding: 'x'.repeat(17 * 1024) }
    })
    expect(response.statusCode).toBe(413)
    expect(controller.prepare).not.toHaveBeenCalled()
  })

  it('requires authentication before status or mutation dispatch', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/cutover/status' })).statusCode).toBe(401)
    expect((await app.inject({
      method: 'POST', url: '/api/v1/cutover/prepare', payload: {}
    })).statusCode).toBe(401)
    expect(controller.recoveryStatus).not.toHaveBeenCalled()
    expect(controller.prepare).not.toHaveBeenCalled()
  })
})

function result(statusCode: number, data: unknown) {
  return { statusCode, body: { ok: true as const, data } }
}

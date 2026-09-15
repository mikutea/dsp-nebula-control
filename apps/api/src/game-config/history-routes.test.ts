import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isControlRole } from '../security/authorization.js'
import {
  GameConfigHistoryHttpController,
  gameConfigHistoryHttpConfirmations,
  type GameConfigHistoryHttpService
} from './history-http.js'
import { registerGameConfigHistoryRoutes } from './history-routes.js'
import {
  GameConfigHistoryError,
  type GameConfigRestoreReceipt,
  type GameConfigSnapshotDetail
} from './history.js'

const applications: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(applications.splice(0).map(async (app) => app.close()))
})

describe('game configuration history Fastify routes', () => {
  it('requires authentication on every route before invoking the controller core', async () => {
    const service = createService()
    const app = await buildRouteApplication(service)

    for (const request of [
      { method: 'GET' as const, url: '/api/v1/game-config/history' },
      { method: 'GET' as const, url: `/api/v1/game-config/history/${snapshotId}` },
      { method: 'GET' as const, url: `/api/v1/game-config/history/${snapshotId}/diff` },
      { method: 'GET' as const, url: `/api/v1/game-config/history/${snapshotId}/restore-preview` },
      {
        method: 'POST' as const,
        url: '/api/v1/game-config/history/capture',
        payload: { confirmation: gameConfigHistoryHttpConfirmations.capture }
      },
      {
        method: 'POST' as const,
        url: '/api/v1/game-config/history/restore',
        payload: restoreInput
      },
      {
        method: 'POST' as const,
        url: '/api/v1/game-config/history/reconcile',
        payload: { confirmation: gameConfigHistoryHttpConfirmations.reconcile }
      }
    ]) {
      const response = await app.inject(request)
      expect(response.statusCode).toBe(401)
      expect(response.json()).toEqual({
        error: { code: 'AUTH_REQUIRED', message: 'Authentication required' }
      })
    }

    expect(service.list).not.toHaveBeenCalled()
    expect(service.detail).not.toHaveBeenCalled()
    expect(service.diff).not.toHaveBeenCalled()
    expect(service.capture).not.toHaveBeenCalled()
    expect(service.restore).not.toHaveBeenCalled()
    expect(service.reconcileInterrupted).not.toHaveBeenCalled()
  })

  it('allows Viewer to list, inspect, diff, and preview snapshots', async () => {
    const service = createService()
    const app = await buildRouteApplication(service)
    const headers = roleHeaders('viewer')

    const list = await app.inject({
      method: 'GET', url: '/api/v1/game-config/history', headers
    })
    const detail = await app.inject({
      method: 'GET', url: `/api/v1/game-config/history/${snapshotId}`, headers
    })
    const diff = await app.inject({
      method: 'GET', url: `/api/v1/game-config/history/${snapshotId}/diff`, headers
    })
    const preview = await app.inject({
      method: 'GET', url: `/api/v1/game-config/history/${snapshotId}/restore-preview`, headers
    })

    expect(list.statusCode).toBe(200)
    expect(list.json()).toEqual({ ok: true, data: [snapshotSummaryFixture] })
    expect(detail.statusCode).toBe(200)
    expect(detail.json()).toEqual({ ok: true, data: snapshotFixture })
    expect(diff.statusCode).toBe(200)
    expect(preview.statusCode).toBe(200)
    expect(diff.json()).toEqual({ ok: true, data: diffFixture })
    expect(preview.json()).toEqual({ ok: true, data: diffFixture })
    expect(service.detail).toHaveBeenCalledWith(snapshotId)
    expect(service.diff).toHaveBeenCalledTimes(2)
  })

  it.each(['viewer', 'operator'] as const)(
    'denies every mutation to %s using the existing configuration.apply permission',
    async (role) => {
      const service = createService()
      const app = await buildRouteApplication(service)
      const headers = roleHeaders(role)

      for (const request of [
        {
          method: 'POST' as const,
          url: '/api/v1/game-config/history/capture',
          payload: { confirmation: gameConfigHistoryHttpConfirmations.capture }
        },
        {
          method: 'POST' as const,
          url: '/api/v1/game-config/history/restore',
          payload: restoreInput
        },
        {
          method: 'POST' as const,
          url: '/api/v1/game-config/history/reconcile',
          payload: { confirmation: gameConfigHistoryHttpConfirmations.reconcile }
        }
      ]) {
        const response = await app.inject({ ...request, headers })
        expect(response.statusCode).toBe(403)
        expect(response.json().error.code).toBe('AUTHORIZATION_DENIED')
      }

      expect(service.capture).not.toHaveBeenCalled()
      expect(service.restore).not.toHaveBeenCalled()
      expect(service.reconcileInterrupted).not.toHaveBeenCalled()
    }
  )

  it('allows Administrator through RBAC while retaining controller confirmations and stop proof', async () => {
    const service = createService()
    const stopProofProvider = vi.fn(() => internalStopProof)
    const app = await buildRouteApplication(service, { stopProofProvider })
    const headers = roleHeaders('administrator')

    const capture = await app.inject({
      method: 'POST',
      url: '/api/v1/game-config/history/capture',
      headers,
      payload: { confirmation: gameConfigHistoryHttpConfirmations.capture }
    })
    const restore = await app.inject({
      method: 'POST',
      url: '/api/v1/game-config/history/restore',
      headers,
      payload: restoreInput
    })
    const reconcile = await app.inject({
      method: 'POST',
      url: '/api/v1/game-config/history/reconcile',
      headers,
      payload: { confirmation: gameConfigHistoryHttpConfirmations.reconcile }
    })

    expect(capture.statusCode).toBe(201)
    expect(restore.statusCode).toBe(200)
    expect(reconcile.statusCode).toBe(200)
    expect(service.capture).toHaveBeenCalledOnce()
    expect(service.restore).toHaveBeenCalledWith({
      requestId,
      snapshotId,
      expectedCurrentRevision: currentRevision,
      dryRun: false,
      stopProofToken: internalStopProof
    })
    expect(service.reconcileInterrupted).toHaveBeenCalledWith(internalStopProof)
    expect(stopProofProvider).toHaveBeenCalledTimes(2)
    expect(JSON.stringify([restore.json(), reconcile.json()])).not.toContain(internalStopProof)
  })

  it.each([
    ['GET', `/api/v1/game-config/history?path=${encodeURIComponent('C:\\fictional-private')}`],
    ['GET', `/api/v1/game-config/history/${snapshotId}?url=${encodeURIComponent('https://fictional.invalid')}`],
    ['GET', `/api/v1/game-config/history/${snapshotId}/diff?command=whoami`],
    ['GET', `/api/v1/game-config/history/${snapshotId}/restore-preview?fileName=private.cfg`]
  ] as const)('rejects unexpected query input on %s %s', async (method, url) => {
    const service = createService()
    const app = await buildRouteApplication(service)
    const response = await app.inject({ method, url, headers: roleHeaders('viewer') })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({
      ok: false,
      error: { code: 'CONFIG_HISTORY_HTTP_REQUEST_INVALID' }
    })
    expect(response.body).not.toContain('fictional-private')
    expect(response.body).not.toContain('fictional.invalid')
    expect(service.list).not.toHaveBeenCalled()
    expect(service.detail).not.toHaveBeenCalled()
    expect(service.diff).not.toHaveBeenCalled()
  })

  it.each(['stopProofToken', 'path', 'url', 'command', 'fileName'])(
    'rejects browser mutation field %s without invoking the provider or core',
    async (field) => {
      const service = createService()
      const stopProofProvider = vi.fn(() => internalStopProof)
      const app = await buildRouteApplication(service, { stopProofProvider })
      const sensitive = 'C:\\fictional-private\\fake-secret'
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/game-config/history/restore',
        headers: roleHeaders('administrator'),
        payload: { ...restoreInput, [field]: sensitive }
      })

      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual({
        ok: false,
        error: { code: 'CONFIG_HISTORY_HTTP_REQUEST_INVALID' }
      })
      expect(response.body).not.toContain('fake-secret')
      expect(stopProofProvider).not.toHaveBeenCalled()
      expect(service.restore).not.toHaveBeenCalled()
    }
  )

  it('rejects query parameters on mutation routes instead of silently ignoring them', async () => {
    const service = createService()
    const stopProofProvider = vi.fn(() => internalStopProof)
    const app = await buildRouteApplication(service, { stopProofProvider })
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/game-config/history/restore?stopProofToken=browser-value',
      headers: roleHeaders('administrator'),
      payload: restoreInput
    })

    expect(response.statusCode).toBe(400)
    expect(stopProofProvider).not.toHaveBeenCalled()
    expect(service.restore).not.toHaveBeenCalled()
  })

  it('enforces a bounded mutation body before the controller is called', async () => {
    const service = createService()
    const app = await buildRouteApplication(service)
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/game-config/history/restore',
      headers: {
        ...roleHeaders('administrator'),
        'content-type': 'application/json'
      },
      payload: JSON.stringify({ ...restoreInput, padding: 'x'.repeat(17 * 1024) })
    })

    expect(response.statusCode).toBe(413)
    expect(service.restore).not.toHaveBeenCalled()
  })

  it('forwards fixed controller status and code-only errors without adding details', async () => {
    const service = createService({
      capture: vi.fn(async () => { throw new GameConfigHistoryError('CONFIG_HISTORY_BUSY') })
    })
    const app = await buildRouteApplication(service)
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/game-config/history/capture',
      headers: roleHeaders('administrator'),
      payload: { confirmation: gameConfigHistoryHttpConfirmations.capture }
    })

    expect(response.statusCode).toBe(423)
    expect(response.json()).toEqual({
      ok: false,
      error: { code: 'CONFIG_HISTORY_BUSY' }
    })
    expect(Object.keys(response.json().error)).toEqual(['code'])
  })

  it('passes the client requestId unchanged so the core can prove idempotent replay', async () => {
    const reused = { ...restoredReceipt, reused: true }
    const restore = vi.fn()
      .mockResolvedValueOnce(restoredReceipt)
      .mockResolvedValueOnce(reused)
    const service = createService({ restore })
    const app = await buildRouteApplication(service)
    const request = {
      method: 'POST' as const,
      url: '/api/v1/game-config/history/restore',
      headers: roleHeaders('administrator'),
      payload: restoreInput
    }

    expect((await app.inject(request)).json().data.reused).toBe(false)
    expect((await app.inject(request)).json().data.reused).toBe(true)
    expect(restore).toHaveBeenCalledTimes(2)
    expect(restore.mock.calls[0]?.[0].requestId).toBe(requestId)
    expect(restore.mock.calls[1]?.[0].requestId).toBe(requestId)
  })
})

async function buildRouteApplication(
  service: GameConfigHistoryHttpService,
  options: { stopProofProvider?: () => string } = {}
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  applications.push(app)
  app.decorateRequest('actorRole', null)
  const controller = new GameConfigHistoryHttpController({
    service,
    mutationGate: () => true,
    stopProofTokenProvider: options.stopProofProvider ?? (() => internalStopProof)
  })
  registerGameConfigHistoryRoutes(app, {
    controller,
    authenticate: testAuthenticate
  })
  await app.ready()
  return app
}

async function testAuthenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const role = request.headers['x-test-role']
  if (!isControlRole(role)) {
    await reply.code(401).send({
      error: { code: 'AUTH_REQUIRED', message: 'Authentication required' }
    })
    return
  }
  request.actorRole = role
}

function roleHeaders(role: 'viewer' | 'operator' | 'administrator') {
  return { 'x-test-role': role }
}

const snapshotId = '018f47a0-7d5b-4abc-8def-0123456789ab'
const requestId = '028f47a0-7d5b-4abc-8def-0123456789ab'
const protectionSnapshotId = '038f47a0-7d5b-4abc-8def-0123456789ab'
const currentRevision = '1'.repeat(64)
const targetRevision = '2'.repeat(64)
const internalStopProof = 'fictional-route-stop-proof'

const snapshotFixture: GameConfigSnapshotDetail = {
  format: 'dyson-control-game-config-snapshot',
  snapshotId,
  kind: 'manual',
  createdAt: '2026-08-30T10:00:00.000Z',
  revision: targetRevision,
  manifestSha256: '3'.repeat(64),
  fileCount: 4,
  totalBytes: 2_048,
  files: [
    { id: 'nebula', present: true, bytes: 512 },
    { id: 'galaxy', present: true, bytes: 512 },
    { id: 'bepinex', present: true, bytes: 512 },
    { id: 'bridge', present: true, bytes: 512 }
  ]
}

const snapshotSummaryFixture = {
  format: snapshotFixture.format,
  snapshotId: snapshotFixture.snapshotId,
  kind: snapshotFixture.kind,
  createdAt: snapshotFixture.createdAt,
  revision: snapshotFixture.revision,
  manifestSha256: snapshotFixture.manifestSha256,
  fileCount: snapshotFixture.fileCount,
  totalBytes: snapshotFixture.totalBytes
}

const diffFixture = {
  snapshotId,
  currentRevision,
  targetRevision,
  files: [{ id: 'nebula' as const, beforePresent: true, afterPresent: true, changed: true }],
  settings: [{
    id: 'nebula.server-password',
    file: 'nebula' as const,
    before: { configured: true },
    after: { configured: true },
    changed: true
  }]
}

const restoredReceipt: GameConfigRestoreReceipt = {
  format: 'dyson-control-game-config-restore-receipt',
  version: 1,
  requestId,
  snapshotId,
  protectionSnapshotId,
  status: 'restored',
  dryRun: false,
  expectedCurrentRevision: currentRevision,
  targetRevision,
  finalRevision: targetRevision,
  errorCode: 'NONE',
  startedAt: '2026-08-30T10:00:00.000Z',
  finishedAt: '2026-08-30T10:00:01.000Z',
  persisted: true,
  reused: false
}

const restoreInput = {
  requestId,
  snapshotId,
  expectedCurrentRevision: currentRevision,
  dryRun: false,
  confirmation: gameConfigHistoryHttpConfirmations.restore
}

function createService(overrides: Partial<GameConfigHistoryHttpService> = {}) {
  return {
    list: vi.fn(async () => [snapshotSummaryFixture]),
    detail: vi.fn(async () => snapshotFixture),
    diff: vi.fn(async () => diffFixture),
    capture: vi.fn(async () => snapshotFixture),
    restore: vi.fn(async () => restoredReceipt),
    reconcileInterrupted: vi.fn(async () => []),
    ...overrides
  } satisfies GameConfigHistoryHttpService
}

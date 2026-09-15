import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AuthService } from '../security/auth.js'
import { requirePermission, type ControlPermission } from '../security/authorization.js'
import type { GameConfigHistoryHttpController, GameConfigHistoryHttpResult } from './history-http.js'

const mutationBodyLimitBytes = 16 * 1024
const unexpectedQueryMarker = '__unexpectedQueryParameters'

export type GameConfigHistoryRoutesController = Pick<
  GameConfigHistoryHttpController,
  'list' | 'detail' | 'diff' | 'preview' | 'capture' | 'restore' | 'reconcile'
>

export interface GameConfigHistoryRoutesOptions {
  controller: GameConfigHistoryRoutesController
  /** Use AuthService.authenticate from the embedding application. */
  authenticate: AuthService['authenticate']
}

/**
 * Registers only route transport. Construction of the history service,
 * mutation gate, and stop-proof provider stays with the embedding application.
 */
export function registerGameConfigHistoryRoutes(
  app: FastifyInstance,
  options: GameConfigHistoryRoutesOptions
): void {
  const protectedRoute = (permission: ControlPermission) => ({
    preHandler: [options.authenticate, requirePermission(permission)]
  })
  const protectedMutationRoute = {
    ...protectedRoute('configuration.apply'),
    bodyLimit: mutationBodyLimitBytes
  }

  app.get('/api/v1/game-config/history', protectedRoute('configuration.read'), async (request, reply) => {
    return sendResult(reply, await options.controller.list(queryFreeInput(request, {})))
  })

  app.get<{
    Params: { snapshotId: string }
  }>('/api/v1/game-config/history/:snapshotId', protectedRoute('configuration.read'), async (request, reply) => {
    return sendResult(reply, await options.controller.detail(queryFreeInput(request, {
      snapshotId: request.params.snapshotId
    })))
  })

  app.get<{
    Params: { snapshotId: string }
  }>('/api/v1/game-config/history/:snapshotId/diff', protectedRoute('configuration.read'), async (request, reply) => {
    return sendResult(reply, await options.controller.diff(queryFreeInput(request, {
      snapshotId: request.params.snapshotId
    })))
  })

  app.get<{
    Params: { snapshotId: string }
  }>(
    '/api/v1/game-config/history/:snapshotId/restore-preview',
    protectedRoute('configuration.read'),
    async (request, reply) => {
      return sendResult(reply, await options.controller.preview(queryFreeInput(request, {
        snapshotId: request.params.snapshotId
      })))
    }
  )

  app.post(
    '/api/v1/game-config/history/capture',
    protectedMutationRoute,
    async (request, reply) => {
      return sendResult(reply, await options.controller.capture(queryFreeInput(request, request.body)))
    }
  )

  app.post(
    '/api/v1/game-config/history/restore',
    protectedMutationRoute,
    async (request, reply) => {
      return sendResult(reply, await options.controller.restore(queryFreeInput(request, request.body)))
    }
  )

  app.post(
    '/api/v1/game-config/history/reconcile',
    protectedMutationRoute,
    async (request, reply) => {
      return sendResult(reply, await options.controller.reconcile(queryFreeInput(request, request.body)))
    }
  )
}

function queryFreeInput(request: FastifyRequest, input: unknown): unknown {
  if (isEmptyRecord(request.query)) return input
  if (isRecord(input)) return { ...input, [unexpectedQueryMarker]: true }
  return { [unexpectedQueryMarker]: true }
}

function isEmptyRecord(value: unknown): value is Record<string, never> {
  return isRecord(value) && Reflect.ownKeys(value).length === 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sendResult<T>(reply: FastifyReply, result: GameConfigHistoryHttpResult<T>) {
  return reply.code(result.statusCode).send(result.body)
}

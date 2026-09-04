import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AuthService } from '../security/auth.js'
import { requirePermission, type ControlPermission } from '../security/authorization.js'
import type {
  CutoverHttpController,
  CutoverHttpMutationContext,
  CutoverHttpRecoveryStatus,
  CutoverHttpResult
} from './http.js'
import type { CutoverPreviewReceipt, CutoverReceipt } from './types.js'

const mutationBodyLimitBytes = 16 * 1024
const unexpectedQueryMarker = '__unexpectedQueryParameters'

export type CutoverRoutesController = Pick<
  CutoverHttpController,
  'recoveryStatus' | 'preview' | 'prepare' | 'activate' | 'rollback' | 'recover'
>

export interface CutoverRoutesOptions {
  controller: CutoverRoutesController
  /** Use AuthService.authenticate from the embedding application. */
  authenticate: AuthService['authenticate']
}

/** Registers only the authenticated transport surface for the durable cutover core. */
export function registerCutoverRoutes(app: FastifyInstance, options: CutoverRoutesOptions): void {
  const protectedRoute = (permission: ControlPermission) => ({
    preHandler: [options.authenticate, requirePermission(permission)]
  })
  const protectedMutationRoute = {
    ...protectedRoute('cutover.execute'),
    bodyLimit: mutationBodyLimitBytes
  }

  app.get(
    '/api/v1/cutover/status',
    protectedRoute('cutover.read'),
    async (request, reply) => sendResult(
      reply,
      await options.controller.recoveryStatus(queryFreeInput(request, {}))
    )
  )
  app.post(
    '/api/v1/cutover/preview',
    protectedMutationRoute,
    async (request, reply) => sendResult(
      reply,
      await options.controller.preview(queryFreeInput(request, request.body))
    )
  )
  app.post(
    '/api/v1/cutover/prepare',
    protectedMutationRoute,
    async (request, reply) => sendResult(
      reply,
      await options.controller.prepare(
        queryFreeInput(request, request.body),
        mutationContext(request)
      )
    )
  )
  app.post(
    '/api/v1/cutover/activate',
    protectedMutationRoute,
    async (request, reply) => sendResult(
      reply,
      await options.controller.activate(
        queryFreeInput(request, request.body),
        mutationContext(request)
      )
    )
  )
  app.post(
    '/api/v1/cutover/rollback',
    protectedMutationRoute,
    async (request, reply) => sendResult(
      reply,
      await options.controller.rollback(
        queryFreeInput(request, request.body),
        mutationContext(request)
      )
    )
  )
  app.post(
    '/api/v1/cutover/recover',
    protectedMutationRoute,
    async (request, reply) => sendResult(
      reply,
      await options.controller.recover(
        queryFreeInput(request, request.body),
        mutationContext(request)
      )
    )
  )
}

function mutationContext(request: FastifyRequest): CutoverHttpMutationContext | undefined {
  return request.actorRole === null ? undefined : { actorRole: request.actorRole }
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

function sendResult(
  reply: FastifyReply,
  result: CutoverHttpResult<CutoverReceipt | CutoverPreviewReceipt | CutoverHttpRecoveryStatus>
) {
  return reply.code(result.statusCode).send(result.body)
}

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RouteShorthandOptions
} from 'fastify'
import { z } from 'zod'
import { HostMutationOperationCoordinatorError } from './host-mutation/operation-coordinator.js'
import {
  WindowsNebulaPluginTransactionError,
  type WindowsNebulaPluginTransactionService
} from './providers/windows-nebula-plugin-transaction.js'

const maximumBodyBytes = 4 * 1024
const maximumRequestTargetBytes = 2 * 1024
const requestIdSchema = z.string().uuid().transform((value) => value.toLowerCase())
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u)
const timestampSchema = z.string().max(64)
const confirmationSchema = z.string().min(1).max(256)

const planBodySchema = z.strictObject({
  requestId: requestIdSchema,
  currentPluginsTreeSha256: sha256Schema,
  maintenanceWindowStartUtc: timestampSchema,
  maintenanceWindowEndUtc: timestampSchema
})
const applyPreviewBodySchema = z.strictObject({ requestId: requestIdSchema })
const applyMutationBodySchema = z.strictObject({
  requestId: requestIdSchema,
  planDigest: sha256Schema,
  confirmationPhrase: confirmationSchema
})
const rollbackPreviewBodySchema = z.strictObject({
  originalRequestId: requestIdSchema,
  rollbackRequestId: requestIdSchema,
  originalReceiptSha256: sha256Schema,
  maintenanceWindowStartUtc: timestampSchema,
  maintenanceWindowEndUtc: timestampSchema
})
const rollbackMutationBodySchema = rollbackPreviewBodySchema.extend({
  previewDigest: sha256Schema,
  confirmationPhrase: confirmationSchema
})
const rollbackVerifyBodySchema = z.strictObject({
  originalRequestId: requestIdSchema,
  rollbackRequestId: requestIdSchema
})

export type WindowsNebulaPluginTransactionRouteService = Pick<
  WindowsNebulaPluginTransactionService,
  | 'plan'
  | 'previewApply'
  | 'apply'
  | 'recoverApply'
  | 'verifyApply'
  | 'previewRollback'
  | 'rollback'
  | 'recoverRollback'
  | 'verifyRollback'
>

type RouteAuthorization = Pick<RouteShorthandOptions, 'preHandler'>

export interface WindowsNebulaPluginTransactionRouteOptions {
  readonly service: WindowsNebulaPluginTransactionRouteService | null
  readonly ordinaryMutationEnabled: boolean
  readonly recoveryMutationEnabled: boolean
  readonly readAuthorization: RouteAuthorization
  readonly mutationAuthorization: RouteAuthorization
  readonly recoveryAuthorization: RouteAuthorization
}

export function registerWindowsNebulaPluginTransactionRoutes(
  app: FastifyInstance,
  options: WindowsNebulaPluginTransactionRouteOptions
): void {
  const readRoute = boundedRoute(options.readAuthorization)
  const mutationRoute = boundedRoute(options.mutationAuthorization)
  const recoveryRoute = boundedRoute(options.recoveryAuthorization)

  app.post('/api/v1/updates/nebula-plugin-transaction/plan', readRoute, async (request, reply) => {
    const parsed = parseBody(request, reply, planBodySchema)
    if (!parsed) return
    const service = options.service
    if (!service) return unavailable(reply)
    return withRequestAbortSignal(request, reply, async (signal) => await service.plan({
      ...parsed,
      signal
    }))
  })

  app.post(
    '/api/v1/updates/nebula-plugin-transaction/apply/preview',
    readRoute,
    async (request, reply) => {
      const parsed = parseBody(request, reply, applyPreviewBodySchema)
      if (!parsed) return
      const service = options.service
      if (!service) return unavailable(reply)
      return withRequestAbortSignal(request, reply, async (signal) =>
        await service.previewApply({ ...parsed, signal }))
    }
  )

  app.post('/api/v1/updates/nebula-plugin-transaction/apply', mutationRoute, async (request, reply) => {
    const parsed = parseBody(request, reply, applyMutationBodySchema)
    if (!parsed) return
    const service = options.service
    if (!service) return unavailable(reply)
    if (!options.ordinaryMutationEnabled) return ordinaryMutationDisabled(reply)
    return invokeTransaction(reply, async () => await service.apply(parsed))
  })

  app.post(
    '/api/v1/updates/nebula-plugin-transaction/apply/recover',
    recoveryRoute,
    async (request, reply) => {
      const parsed = parseBody(request, reply, applyMutationBodySchema)
      if (!parsed) return
      const service = options.service
      if (!service) return unavailable(reply)
      if (request.actorRole !== 'administrator') return recoveryAuthorizationDenied(reply)
      if (!options.recoveryMutationEnabled) return recoveryMutationDisabled(reply)
      return invokeTransaction(reply, async () => await service.recoverApply(parsed))
    }
  )

  app.post(
    '/api/v1/updates/nebula-plugin-transaction/apply/verify',
    readRoute,
    async (request, reply) => {
      const parsed = parseBody(request, reply, applyPreviewBodySchema)
      if (!parsed) return
      const service = options.service
      if (!service) return unavailable(reply)
      return withRequestAbortSignal(request, reply, async (signal) =>
        await service.verifyApply({ ...parsed, signal }))
    }
  )

  app.post(
    '/api/v1/updates/nebula-plugin-transaction/rollback/preview',
    readRoute,
    async (request, reply) => {
      const parsed = parseBody(request, reply, rollbackPreviewBodySchema)
      if (!parsed) return
      const service = options.service
      if (!service) return unavailable(reply)
      return withRequestAbortSignal(request, reply, async (signal) =>
        await service.previewRollback({ ...parsed, signal }))
    }
  )

  app.post(
    '/api/v1/updates/nebula-plugin-transaction/rollback',
    mutationRoute,
    async (request, reply) => {
      const parsed = parseBody(request, reply, rollbackMutationBodySchema)
      if (!parsed) return
      const service = options.service
      if (!service) return unavailable(reply)
      if (!options.ordinaryMutationEnabled) return ordinaryMutationDisabled(reply)
      return invokeTransaction(reply, async () => await service.rollback(parsed))
    }
  )

  app.post(
    '/api/v1/updates/nebula-plugin-transaction/rollback/recover',
    recoveryRoute,
    async (request, reply) => {
      const parsed = parseBody(request, reply, rollbackMutationBodySchema)
      if (!parsed) return
      const service = options.service
      if (!service) return unavailable(reply)
      if (request.actorRole !== 'administrator') return recoveryAuthorizationDenied(reply)
      if (!options.recoveryMutationEnabled) return recoveryMutationDisabled(reply)
      return invokeTransaction(reply, async () => await service.recoverRollback(parsed))
    }
  )

  app.post(
    '/api/v1/updates/nebula-plugin-transaction/rollback/verify',
    readRoute,
    async (request, reply) => {
      const parsed = parseBody(request, reply, rollbackVerifyBodySchema)
      if (!parsed) return
      const service = options.service
      if (!service) return unavailable(reply)
      return withRequestAbortSignal(request, reply, async (signal) =>
        await service.verifyRollback({ ...parsed, signal }))
    }
  )
}

function boundedRoute(authorization: RouteAuthorization): RouteShorthandOptions {
  return {
    ...authorization,
    bodyLimit: maximumBodyBytes,
    errorHandler: (error, _request, reply) => {
      const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500
      return statusCode >= 400 && statusCode < 500
        ? invalidRequest(reply)
        : codeOnlyError(reply, 503, 'NEBULA_PLUGIN_TRANSACTION_UNAVAILABLE')
    }
  }
}

function parseBody<T extends z.ZodType>(
  request: FastifyRequest,
  reply: FastifyReply,
  schema: T
): z.output<T> | null {
  if (Buffer.byteLength(request.raw.url ?? '', 'utf8') > maximumRequestTargetBytes ||
      request.query === null || typeof request.query !== 'object' ||
      Object.keys(request.query as Record<string, unknown>).length !== 0) {
    invalidRequest(reply)
    return null
  }
  const parsed = schema.safeParse(request.body)
  if (!parsed.success) {
    invalidRequest(reply)
    return null
  }
  return parsed.data
}

async function withRequestAbortSignal<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  operation: (signal: AbortSignal) => Promise<T>
) {
  const controller = new AbortController()
  const abortRequest = () => controller.abort('http-request-aborted')
  const abortDisconnectedResponse = () => {
    if (!reply.raw.writableEnded) controller.abort('http-client-disconnected')
  }
  if (request.raw.aborted) abortRequest()
  request.raw.once('aborted', abortRequest)
  reply.raw.once('close', abortDisconnectedResponse)
  try {
    return await invokeTransaction(reply, async () => await operation(controller.signal))
  } finally {
    request.raw.off('aborted', abortRequest)
    reply.raw.off('close', abortDisconnectedResponse)
  }
}

async function invokeTransaction<T>(reply: FastifyReply, operation: () => Promise<T>) {
  try {
    return reply.code(200).send({ ok: true, data: await operation() })
  } catch (error) {
    return transactionError(reply, error)
  }
}

function invalidRequest(reply: FastifyReply) {
  return codeOnlyError(reply, 400, 'NEBULA_PLUGIN_TRANSACTION_REQUEST_INVALID')
}

function unavailable(reply: FastifyReply) {
  return codeOnlyError(reply, 503, 'NEBULA_PLUGIN_TRANSACTION_NOT_CONFIGURED')
}

function ordinaryMutationDisabled(reply: FastifyReply) {
  return codeOnlyError(reply, 423, 'NEBULA_PLUGIN_TRANSACTION_MUTATION_DISABLED')
}

function recoveryMutationDisabled(reply: FastifyReply) {
  return codeOnlyError(reply, 423, 'NEBULA_PLUGIN_TRANSACTION_RECOVERY_DISABLED')
}

function recoveryAuthorizationDenied(reply: FastifyReply) {
  return codeOnlyError(reply, 403, 'NEBULA_PLUGIN_TRANSACTION_RECOVERY_FORBIDDEN')
}

function transactionError(reply: FastifyReply, error: unknown) {
  if (error instanceof WindowsNebulaPluginTransactionError) {
    const statusCode = error.code === 'WINDOWS_NEBULA_PLUGIN_TRANSACTION_REQUEST_INVALID'
      ? 400
      : error.code === 'WINDOWS_NEBULA_PLUGIN_TRANSACTION_RESULT_INVALID'
        ? 502
        : error.code === 'WINDOWS_NEBULA_PLUGIN_TRANSACTION_TIMEOUT'
          ? 504
          : error.code === 'WINDOWS_NEBULA_PLUGIN_TRANSACTION_CANCELLED'
            ? 408
            : 503
    return codeOnlyError(reply, statusCode, error.code)
  }
  if (error instanceof HostMutationOperationCoordinatorError) {
    const blocked = error.code === 'HOST_MUTATION_LEASE_BUSY' ||
      error.code === 'HOST_MUTATION_LEASE_DIRTY' ||
      error.code === 'HOST_MUTATION_LEASE_RECOVERY_REQUIRED'
    return codeOnlyError(
      reply,
      blocked ? 423 : 503,
      blocked
        ? 'NEBULA_PLUGIN_TRANSACTION_HOST_MUTATION_BLOCKED'
        : 'NEBULA_PLUGIN_TRANSACTION_HOST_MUTATION_UNAVAILABLE'
    )
  }
  return codeOnlyError(reply, 503, 'NEBULA_PLUGIN_TRANSACTION_UNAVAILABLE')
}

function codeOnlyError(reply: FastifyReply, statusCode: number, code: string) {
  return reply.code(statusCode).send({ ok: false, error: { code } })
}

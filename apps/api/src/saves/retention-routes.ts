import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AuthService } from '../security/auth.js'
import { requirePermission, type ControlPermission } from '../security/authorization.js'
import type { BackupRetentionHttpResult } from './retention-http.js'

const mutationBodyLimitBytes = 16 * 1024
const unexpectedQueryMarker = '__unexpectedQueryParameters'

export interface BackupRetentionRoutesController {
  annotations(input: unknown): Promise<BackupRetentionHttpResult<unknown>>
  annotate(input: unknown): Promise<BackupRetentionHttpResult<unknown>>
  preview(input: unknown): Promise<BackupRetentionHttpResult<unknown>>
  execute(input: unknown): Promise<BackupRetentionHttpResult<unknown>>
  restore(input: unknown): Promise<BackupRetentionHttpResult<unknown>>
  previewPurge(input: unknown): Promise<BackupRetentionHttpResult<unknown>>
  purge(input: unknown): Promise<BackupRetentionHttpResult<unknown>>
  recover(input: unknown): Promise<BackupRetentionHttpResult<unknown>>
}

export interface BackupRetentionRoutesOptions {
  controller: BackupRetentionRoutesController
  /** Use AuthService.authenticate from the embedding application. */
  authenticate: AuthService['authenticate']
}

/** Registers only the authenticated, same-origin transport surface. */
export function registerBackupRetentionRoutes(
  app: FastifyInstance,
  options: BackupRetentionRoutesOptions
): void {
  const protectedRoute = (permission: ControlPermission) => ({
    preHandler: [options.authenticate, requirePermission(permission)]
  })
  const protectedMutationRoute = {
    ...protectedRoute('saves.restore'),
    bodyLimit: mutationBodyLimitBytes
  }

  app.get(
    '/api/v1/backups/retention/annotations',
    protectedRoute('saves.read'),
    async (request, reply) => sendResult(reply, await options.controller.annotations(queryFreeInput(request, {})))
  )
  app.post(
    '/api/v1/backups/retention/annotations',
    protectedMutationRoute,
    async (request, reply) => sendResult(reply, await options.controller.annotate(queryFreeInput(request, request.body)))
  )
  app.post(
    '/api/v1/backups/retention/preview',
    { ...protectedRoute('saves.read'), bodyLimit: mutationBodyLimitBytes },
    async (request, reply) => sendResult(reply, await options.controller.preview(queryFreeInput(request, request.body)))
  )
  app.post(
    '/api/v1/backups/retention/execute',
    protectedMutationRoute,
    async (request, reply) => sendResult(reply, await options.controller.execute(queryFreeInput(request, request.body)))
  )
  app.post(
    '/api/v1/backups/retention/restore',
    protectedMutationRoute,
    async (request, reply) => sendResult(reply, await options.controller.restore(queryFreeInput(request, request.body)))
  )
  app.post(
    '/api/v1/backups/retention/purge/preview',
    { ...protectedRoute('saves.read'), bodyLimit: mutationBodyLimitBytes },
    async (request, reply) => sendResult(reply, await options.controller.previewPurge(queryFreeInput(request, request.body)))
  )
  app.post(
    '/api/v1/backups/retention/purge/execute',
    protectedMutationRoute,
    async (request, reply) => sendResult(reply, await options.controller.purge(queryFreeInput(request, request.body)))
  )
  app.post(
    '/api/v1/backups/retention/recover',
    protectedMutationRoute,
    async (request, reply) => sendResult(reply, await options.controller.recover(queryFreeInput(request, request.body)))
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

function sendResult<T>(reply: FastifyReply, result: BackupRetentionHttpResult<T>) {
  return reply.code(result.statusCode).send(result.body)
}

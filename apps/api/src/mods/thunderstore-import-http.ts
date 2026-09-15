import { z } from 'zod'
import {
  ThunderstoreModImportError,
  thunderstoreModImportPreviewRequestSchema,
  thunderstoreModImportRequestSchema,
  type ThunderstoreModImportPlan,
  type ThunderstoreModImportReceipt
} from './thunderstore-import.js'

const receiptInputSchema = z.strictObject({ requestId: z.string().uuid() })

export interface ThunderstoreModImportHttpService {
  preview(input: unknown, signal?: AbortSignal): Promise<ThunderstoreModImportPlan>
  execute(input: unknown, signal?: AbortSignal): Promise<ThunderstoreModImportReceipt>
  getReceipt(requestId: unknown): Promise<ThunderstoreModImportReceipt | null>
}

export interface ThunderstoreModImportHttpResult<T> {
  statusCode: number
  body: { ok: true; data: T } | { ok: false; error: { code: string } }
}

export interface ThunderstoreModImportHttpOptions {
  service: ThunderstoreModImportHttpService
  mutationGate?: () => boolean | Promise<boolean>
}

/**
 * Path-, URL-, and archive-free HTTP boundary for turning a previously
 * acquired Thunderstore receipt into a fixed staged mod package.
 */
export class ThunderstoreModImportHttpController {
  readonly #service: ThunderstoreModImportHttpService
  readonly #mutationGate: () => boolean | Promise<boolean>

  constructor(options: ThunderstoreModImportHttpOptions) {
    this.#service = options.service
    this.#mutationGate = options.mutationGate ?? (() => false)
  }

  async preview(
    input: unknown,
    signal?: AbortSignal
  ): Promise<ThunderstoreModImportHttpResult<ThunderstoreModImportPlan>> {
    try {
      const request = thunderstoreModImportPreviewRequestSchema.parse(input)
      return success(200, await this.#service.preview(request, signal))
    } catch (error) {
      return failureFrom(error)
    }
  }

  async execute(
    input: unknown,
    signal?: AbortSignal
  ): Promise<ThunderstoreModImportHttpResult<ThunderstoreModImportReceipt>> {
    try {
      const request = thunderstoreModImportRequestSchema.parse(input)
      let allowed: boolean
      try {
        allowed = await this.#mutationGate()
      } catch {
        throw new ThunderstoreModImportHttpFault(503, 'THUNDERSTORE_MOD_IMPORT_GATE_UNAVAILABLE')
      }
      if (allowed !== true) {
        throw new ThunderstoreModImportHttpFault(423, 'THUNDERSTORE_MOD_IMPORT_MUTATION_DISABLED')
      }
      const receipt = await this.#service.execute(request, signal)
      return success(receipt.reused ? 200 : 201, receipt)
    } catch (error) {
      return failureFrom(error)
    }
  }

  async getReceipt(
    input: unknown
  ): Promise<ThunderstoreModImportHttpResult<ThunderstoreModImportReceipt>> {
    try {
      const { requestId } = receiptInputSchema.parse(input)
      const receipt = await this.#service.getReceipt(requestId)
      if (receipt === null) {
        throw new ThunderstoreModImportHttpFault(404, 'THUNDERSTORE_MOD_IMPORT_RECEIPT_NOT_FOUND')
      }
      return success(200, receipt)
    } catch (error) {
      return failureFrom(error)
    }
  }
}

function success<T>(statusCode: number, data: T): ThunderstoreModImportHttpResult<T> {
  return { statusCode, body: { ok: true, data } }
}

function failure<T = never>(statusCode: number, code: string): ThunderstoreModImportHttpResult<T> {
  return { statusCode, body: { ok: false, error: { code } } }
}

function failureFrom(error: unknown): ThunderstoreModImportHttpResult<never> {
  if (error instanceof ThunderstoreModImportHttpFault) return failure(error.statusCode, error.code)
  if (error instanceof z.ZodError) return failure(422, 'THUNDERSTORE_MOD_IMPORT_REQUEST_INVALID')
  if (!(error instanceof ThunderstoreModImportError)) {
    return failure(503, 'THUNDERSTORE_MOD_IMPORT_UNAVAILABLE')
  }
  if (notFoundCodes.has(error.code)) return failure(404, error.code)
  if (lockedCodes.has(error.code)) return failure(423, error.code)
  if (conflictCodes.has(error.code)) return failure(409, error.code)
  if (unprocessableCodes.has(error.code)) return failure(422, error.code)
  if (unavailableCodes.has(error.code)) return failure(503, error.code)
  return failure(503, 'THUNDERSTORE_MOD_IMPORT_UNAVAILABLE')
}

class ThunderstoreModImportHttpFault extends Error {
  constructor(readonly statusCode: number, readonly code: string) {
    super(code)
    this.name = 'ThunderstoreModImportHttpFault'
  }
}

const notFoundCodes = new Set([
  'THUNDERSTORE_MOD_IMPORT_ACQUISITION_NOT_FOUND'
])

const lockedCodes = new Set([
  'THUNDERSTORE_MOD_IMPORT_PACKAGE_LOCK_BUSY',
  'THUNDERSTORE_MOD_IMPORT_REQUEST_LOCK_BUSY'
])

const conflictCodes = new Set([
  'THUNDERSTORE_MOD_IMPORT_ACQUIRED_ARTIFACT_CHANGED',
  'THUNDERSTORE_MOD_IMPORT_IDEMPOTENCY_CONFLICT',
  'THUNDERSTORE_MOD_IMPORT_OUTPUT_CONFLICT',
  'THUNDERSTORE_MOD_IMPORT_SOURCE_CHANGED',
  'THUNDERSTORE_MOD_IMPORT_STAGING_CONFLICT'
])

const unprocessableCodes = new Set([
  'THUNDERSTORE_MOD_IMPORT_ACQUISITION_INVALID',
  'THUNDERSTORE_MOD_IMPORT_ARCHIVE_INVALID',
  'THUNDERSTORE_MOD_IMPORT_ARTIFACT_INVALID',
  'THUNDERSTORE_MOD_IMPORT_ARTIFACT_TOO_LARGE',
  'THUNDERSTORE_MOD_IMPORT_DEPENDENCY_GRAPH_MISMATCH',
  'THUNDERSTORE_MOD_IMPORT_DEPENDENCY_DUPLICATE',
  'THUNDERSTORE_MOD_IMPORT_IDENTITY_MISMATCH',
  'THUNDERSTORE_MOD_IMPORT_MANIFEST_INVALID',
  'THUNDERSTORE_MOD_IMPORT_METADATA_MISSING',
  'THUNDERSTORE_MOD_IMPORT_NON_PLUGIN_DESTINATION_UNSUPPORTED',
  'THUNDERSTORE_MOD_IMPORT_PATH_INVALID',
  'THUNDERSTORE_MOD_IMPORT_PAYLOAD_TOO_LARGE',
  'THUNDERSTORE_MOD_IMPORT_RUNTIME_LAYOUT_UNSUPPORTED',
  'THUNDERSTORE_MOD_IMPORT_RUNTIME_PAYLOAD_MISSING'
])

const unavailableCodes = new Set([
  'THUNDERSTORE_MOD_IMPORT_ABORTED',
  'THUNDERSTORE_MOD_IMPORT_ACQUISITION_UNAVAILABLE',
  'THUNDERSTORE_MOD_IMPORT_ARTIFACT_UNAVAILABLE',
  'THUNDERSTORE_MOD_IMPORT_LIMITS_INVALID',
  'THUNDERSTORE_MOD_IMPORT_LOCK_FAILED',
  'THUNDERSTORE_MOD_IMPORT_PATH_ESCAPE',
  'THUNDERSTORE_MOD_IMPORT_PUBLISH_FAILED',
  'THUNDERSTORE_MOD_IMPORT_RECEIPT_INVALID',
  'THUNDERSTORE_MOD_IMPORT_RECEIPT_WRITE_FAILED',
  'THUNDERSTORE_MOD_IMPORT_ROOT_COLLISION',
  'THUNDERSTORE_MOD_IMPORT_ROOT_INVALID',
  'THUNDERSTORE_MOD_IMPORT_ROOT_NOT_ABSOLUTE'
])

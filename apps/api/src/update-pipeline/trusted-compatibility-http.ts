import { z } from 'zod'
import {
  TrustedCompatibilityError,
  trustedCompatibilityPreparationRequestSchema,
  type TrustedCompatibilityReceipt,
  type TrustedCompatibilityService,
  type TrustedCompatibilityStatus
} from './trusted-compatibility.js'

export const trustedCompatibilityConfirmation = 'PREPARE_COMPATIBILITY_EVIDENCE'

const emptyInputSchema = z.strictObject({})
const receiptInputSchema = z.strictObject({ receiptId: z.string().uuid() })
const prepareInputSchema = trustedCompatibilityPreparationRequestSchema.extend({
  confirmation: z.literal(trustedCompatibilityConfirmation)
})

export interface TrustedCompatibilityHttpService {
  status(): Promise<TrustedCompatibilityStatus>
  prepare(input: unknown): Promise<TrustedCompatibilityReceipt>
  getReceipt(receiptId: unknown): Promise<TrustedCompatibilityReceipt | null>
}

export interface TrustedCompatibilityHttpSuccess<T> {
  ok: true
  data: T
}

export interface TrustedCompatibilityHttpFailure {
  ok: false
  error: { code: string }
}

export interface TrustedCompatibilityHttpResult<T> {
  statusCode: number
  body: TrustedCompatibilityHttpSuccess<T> | TrustedCompatibilityHttpFailure
}

/** Strict Fastify-independent boundary; policy and inventory never enter via HTTP. */
export class TrustedCompatibilityHttpController {
  readonly #service: TrustedCompatibilityHttpService

  constructor(service: TrustedCompatibilityHttpService | TrustedCompatibilityService) {
    this.#service = service
  }

  async status(input: unknown): Promise<TrustedCompatibilityHttpResult<TrustedCompatibilityStatus>> {
    try {
      emptyInputSchema.parse(input)
      return success(200, await this.#service.status())
    } catch (error) {
      return failureFrom(error)
    }
  }

  async prepare(input: unknown): Promise<TrustedCompatibilityHttpResult<TrustedCompatibilityReceipt>> {
    try {
      const parsed = prepareInputSchema.parse(input)
      const { confirmation: _confirmation, ...request } = parsed
      const receipt = await this.#service.prepare(request)
      return success(receipt.reused ? 200 : 201, receipt)
    } catch (error) {
      return failureFrom(error)
    }
  }

  async getReceipt(input: unknown): Promise<TrustedCompatibilityHttpResult<TrustedCompatibilityReceipt>> {
    try {
      const { receiptId } = receiptInputSchema.parse(input)
      const receipt = await this.#service.getReceipt(receiptId)
      if (receipt === null) return failure(404, 'UPDATE_COMPATIBILITY_RECEIPT_NOT_FOUND')
      return success(200, receipt)
    } catch (error) {
      return failureFrom(error)
    }
  }
}

function success<T>(statusCode: number, data: T): TrustedCompatibilityHttpResult<T> {
  return { statusCode, body: { ok: true, data } }
}

function failure<T = never>(statusCode: number, code: string): TrustedCompatibilityHttpResult<T> {
  return { statusCode, body: { ok: false, error: { code } } }
}

function failureFrom(error: unknown): TrustedCompatibilityHttpResult<never> {
  if (error instanceof z.ZodError) return failure(422, 'UPDATE_COMPATIBILITY_HTTP_REQUEST_INVALID')
  if (!(error instanceof TrustedCompatibilityError)) return failure(503, 'UPDATE_COMPATIBILITY_HTTP_UNAVAILABLE')
  if (notFoundCodes.has(error.code)) return failure(404, error.code)
  if (conflictCodes.has(error.code)) return failure(409, error.code)
  if (lockedCodes.has(error.code)) return failure(423, error.code)
  if (unprocessableCodes.has(error.code)) return failure(422, error.code)
  if (unavailableCodes.has(error.code)) return failure(503, error.code)
  return failure(503, 'UPDATE_COMPATIBILITY_HTTP_UNAVAILABLE')
}

const notFoundCodes = new Set(['UPDATE_COMPATIBILITY_RECEIPT_NOT_FOUND'])
const conflictCodes = new Set([
  'UPDATE_COMPATIBILITY_CANDIDATE_MISMATCH',
  'UPDATE_COMPATIBILITY_CONFLICT',
  'UPDATE_COMPATIBILITY_IDEMPOTENCY_CONFLICT',
  'UPDATE_COMPATIBILITY_INVENTORY_DRIFT',
  'UPDATE_COMPATIBILITY_POLICY_DRIFT',
  'UPDATE_COMPATIBILITY_RECEIPT_EXPIRED'
])
const lockedCodes = new Set(['UPDATE_COMPATIBILITY_RECEIPT_LIMIT_REACHED'])
const unprocessableCodes = new Set([
  'UPDATE_COMPATIBILITY_CANDIDATE_INVALID',
  'UPDATE_COMPATIBILITY_REQUEST_INVALID'
])
const unavailableCodes = new Set([
  'UPDATE_COMPATIBILITY_CLOCK_INVALID',
  'UPDATE_COMPATIBILITY_HTTP_UNAVAILABLE',
  'UPDATE_COMPATIBILITY_INVENTORY_UNAVAILABLE',
  'UPDATE_COMPATIBILITY_PERSISTENCE_FAILED',
  'UPDATE_COMPATIBILITY_POLICY_UNAVAILABLE',
  'UPDATE_COMPATIBILITY_RECEIPT_DIRECTORY_INVALID',
  'UPDATE_COMPATIBILITY_RECEIPT_INVALID',
  'UPDATE_COMPATIBILITY_ROOT_INVALID',
  'UPDATE_COMPATIBILITY_ROOT_UNAVAILABLE'
])

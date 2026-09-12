import { z } from 'zod'
import {
  componentCandidatePreparationPreviewRequestSchema,
  componentCandidatePreparationRequestSchema,
  type ComponentCandidatePreparationExecutionResult,
  type ComponentCandidatePreparationPlan,
  type ComponentCandidatePreparationReceipt
} from './candidate-preparation.js'
import { UpdatePipelineError } from './errors.js'

const receiptInputSchema = z.strictObject({ requestId: z.string().uuid() })

export interface ComponentCandidatePreparationHttpService {
  preview(input: unknown, signal?: AbortSignal): Promise<ComponentCandidatePreparationPlan>
  execute(input: unknown, signal?: AbortSignal): Promise<ComponentCandidatePreparationExecutionResult>
  getReceipt(requestId: unknown): Promise<ComponentCandidatePreparationReceipt | null>
}

export interface ComponentCandidatePreparationHttpResult<T> {
  statusCode: number
  body: { ok: true; data: T } | { ok: false; error: { code: string } }
}

export interface ComponentCandidatePreparationHttpOptions {
  service: ComponentCandidatePreparationHttpService
  mutationGate?: () => boolean | Promise<boolean>
}

/**
 * Fastify-independent, path/URL/command-free boundary for candidate
 * preparation. Bridge/control return an explicit unavailable projection and
 * never reach the mutation gate or filesystem service.
 */
export class ComponentCandidatePreparationHttpController {
  readonly #service: ComponentCandidatePreparationHttpService
  readonly #mutationGate: () => boolean | Promise<boolean>

  constructor(options: ComponentCandidatePreparationHttpOptions) {
    this.#service = options.service
    this.#mutationGate = options.mutationGate ?? (() => false)
  }

  async preview(
    input: unknown,
    signal?: AbortSignal
  ): Promise<ComponentCandidatePreparationHttpResult<ComponentCandidatePreparationPlan>> {
    try {
      const request = componentCandidatePreparationPreviewRequestSchema.parse(input)
      return success(200, await this.#service.preview(request, signal))
    } catch (error) {
      return failureFrom(error)
    }
  }

  async execute(
    input: unknown,
    signal?: AbortSignal
  ): Promise<ComponentCandidatePreparationHttpResult<ComponentCandidatePreparationExecutionResult>> {
    try {
      const request = componentCandidatePreparationRequestSchema.parse(input)
      if (request.component !== 'bridge' && request.component !== 'control') {
        let allowed: boolean
        try {
          allowed = await this.#mutationGate()
        } catch {
          throw new CandidatePreparationHttpFault(
            503,
            'CANDIDATE_PREPARATION_GATE_UNAVAILABLE'
          )
        }
        if (allowed !== true) {
          throw new CandidatePreparationHttpFault(
            423,
            'CANDIDATE_PREPARATION_MUTATION_DISABLED'
          )
        }
      }
      const result = await this.#service.execute(request, signal)
      if (result.format === 'dyson-control-component-preparation-unavailable') {
        return success(200, result)
      }
      return success(result.reused ? 200 : 201, result)
    } catch (error) {
      return failureFrom(error)
    }
  }

  async getReceipt(
    input: unknown
  ): Promise<ComponentCandidatePreparationHttpResult<ComponentCandidatePreparationReceipt>> {
    try {
      const { requestId } = receiptInputSchema.parse(input)
      const receipt = await this.#service.getReceipt(requestId)
      if (receipt === null) {
        throw new CandidatePreparationHttpFault(
          404,
          'CANDIDATE_PREPARATION_RECEIPT_NOT_FOUND'
        )
      }
      return success(200, receipt)
    } catch (error) {
      return failureFrom(error)
    }
  }
}

function success<T>(statusCode: number, data: T): ComponentCandidatePreparationHttpResult<T> {
  return { statusCode, body: { ok: true, data } }
}

function failure<T = never>(
  statusCode: number,
  code: string
): ComponentCandidatePreparationHttpResult<T> {
  return { statusCode, body: { ok: false, error: { code } } }
}

function failureFrom(error: unknown): ComponentCandidatePreparationHttpResult<never> {
  if (error instanceof CandidatePreparationHttpFault) {
    return failure(error.statusCode, error.code)
  }
  if (error instanceof z.ZodError) {
    return failure(422, 'CANDIDATE_PREPARATION_REQUEST_INVALID')
  }
  if (!(error instanceof UpdatePipelineError)) {
    return failure(503, 'CANDIDATE_PREPARATION_UNAVAILABLE')
  }
  if (notFoundCodes.has(error.code)) return failure(404, error.code)
  if (lockedCodes.has(error.code)) return failure(423, error.code)
  if (conflictCodes.has(error.code)) return failure(409, error.code)
  if (unprocessableCodes.has(error.code) ||
      error.code.startsWith('UPDATE_ARCHIVE_') ||
      error.code.startsWith('UPDATE_NEBULA_') ||
      error.code.startsWith('UPDATE_BEPINEX_')) {
    return failure(422, error.code)
  }
  if (unavailableCodes.has(error.code)) return failure(503, error.code)
  return failure(503, 'CANDIDATE_PREPARATION_UNAVAILABLE')
}

class CandidatePreparationHttpFault extends Error {
  constructor(readonly statusCode: number, readonly code: string) {
    super(code)
    this.name = 'CandidatePreparationHttpFault'
  }
}

const notFoundCodes = new Set([
  'CANDIDATE_PREPARATION_ACQUISITION_RECEIPT_NOT_FOUND'
])

const lockedCodes = new Set([
  'CANDIDATE_PREPARATION_ARTIFACT_LOCK_BUSY',
  'CANDIDATE_PREPARATION_REQUEST_LOCK_BUSY',
  'STAGING_LOCK_BUSY'
])

const conflictCodes = new Set([
  'CANDIDATE_PREPARATION_ACQUIRED_ARTIFACT_CHANGED',
  'CANDIDATE_PREPARATION_ACQUIRED_ARTIFACT_INVALID',
  'CANDIDATE_PREPARATION_ACQUIRED_ARTIFACT_NOT_FOUND',
  'CANDIDATE_PREPARATION_ACQUISITION_CHANGED',
  'CANDIDATE_PREPARATION_COMPONENT_MISMATCH',
  'CANDIDATE_PREPARATION_IDEMPOTENCY_CONFLICT',
  'CANDIDATE_PREPARATION_INBOX_CONFLICT',
  'CANDIDATE_PREPARATION_STAGING_RESULT_INVALID',
  'STAGING_DESTINATION_INVALID',
  'STAGING_IDEMPOTENCY_CONFLICT',
  'STAGING_MANIFEST_INVALID',
  'STAGING_PUBLISHED_ARTIFACT_INVALID',
  'STAGING_SOURCE_MISSING',
  'STAGING_SOURCE_NOT_REGULAR_FILE'
])

const unprocessableCodes = new Set([
  'CANDIDATE_PREPARATION_ARTIFACT_TOO_LARGE',
  'STAGING_ARTIFACT_INVALID',
  'STAGING_ARTIFACT_TOO_LARGE',
  'STAGING_SHA256_MISMATCH',
  'STAGING_SIZE_MISMATCH'
])

const unavailableCodes = new Set([
  'ACQUISITION_RECEIPT_INVALID',
  'ACQUISITION_STATE_FILE_INVALID',
  'CANDIDATE_PREPARATION_ABORTED',
  'CANDIDATE_PREPARATION_ACQUISITION_RECEIPT_INVALID',
  'CANDIDATE_PREPARATION_ACQUISITION_UNAVAILABLE',
  'CANDIDATE_PREPARATION_INBOX_PUBLISH_FAILED',
  'CANDIDATE_PREPARATION_LOCK_FAILED',
  'CANDIDATE_PREPARATION_RECEIPT_INVALID',
  'CANDIDATE_PREPARATION_ROOT_INVALID',
  'CANDIDATE_PREPARATION_STATE_FILE_INVALID',
  'CANDIDATE_PREPARATION_STATE_WRITE_FAILED',
  'STAGING_FAILED',
  'STAGING_LOCK_FAILED'
])

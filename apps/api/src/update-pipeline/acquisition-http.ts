import { z } from 'zod'
import {
  artifactAcquisitionRequestSchema,
  type ArtifactAcquisitionPlan,
  type ArtifactAcquisitionReceipt
} from './acquisition.js'
import { UpdatePipelineError } from './errors.js'

const candidateInputSchema = z.strictObject({
  candidateId: z.string().regex(/^candidate-[0-9a-f]{48}$/)
})
const receiptInputSchema = z.strictObject({ requestId: z.string().uuid() })

export interface ArtifactAcquisitionHttpService {
  preview(candidateId: unknown): Promise<ArtifactAcquisitionPlan>
  acquire(input: unknown, signal?: AbortSignal): Promise<ArtifactAcquisitionReceipt>
  getReceipt(requestId: unknown): Promise<ArtifactAcquisitionReceipt | null>
}

export interface ArtifactAcquisitionHttpResult<T> {
  statusCode: number
  body: { ok: true; data: T } | { ok: false; error: { code: string } }
}

export interface ArtifactAcquisitionHttpOptions {
  service: ArtifactAcquisitionHttpService
  mutationGate?: () => boolean | Promise<boolean>
}

/**
 * Path- and URL-free HTTP boundary for provider-bound acquisition candidates.
 * Candidate registration happens only while interpreting a trusted discovery
 * response; a browser can reference that registration solely by opaque ID.
 */
export class ArtifactAcquisitionHttpController {
  readonly #service: ArtifactAcquisitionHttpService
  readonly #mutationGate: () => boolean | Promise<boolean>

  constructor(options: ArtifactAcquisitionHttpOptions) {
    this.#service = options.service
    this.#mutationGate = options.mutationGate ?? (() => false)
  }

  async preview(input: unknown): Promise<ArtifactAcquisitionHttpResult<ArtifactAcquisitionPlan>> {
    try {
      const { candidateId } = candidateInputSchema.parse(input)
      return success(200, await this.#service.preview(candidateId))
    } catch (error) {
      return failureFrom(error)
    }
  }

  async execute(
    input: unknown,
    signal?: AbortSignal
  ): Promise<ArtifactAcquisitionHttpResult<ArtifactAcquisitionReceipt>> {
    try {
      const request = artifactAcquisitionRequestSchema.parse(input)
      let allowed: boolean
      try { allowed = await this.#mutationGate() } catch {
        throw new AcquisitionHttpFault(503, 'UPDATE_ACQUISITION_GATE_UNAVAILABLE')
      }
      if (allowed !== true) throw new AcquisitionHttpFault(423, 'UPDATE_ACQUISITION_MUTATION_DISABLED')
      const receipt = await this.#service.acquire(request, signal)
      return success(receipt.reused ? 200 : 201, receipt)
    } catch (error) {
      return failureFrom(error)
    }
  }

  async getReceipt(input: unknown): Promise<ArtifactAcquisitionHttpResult<ArtifactAcquisitionReceipt>> {
    try {
      const { requestId } = receiptInputSchema.parse(input)
      const receipt = await this.#service.getReceipt(requestId)
      if (receipt === null) throw new AcquisitionHttpFault(404, 'UPDATE_ACQUISITION_RECEIPT_NOT_FOUND')
      return success(200, receipt)
    } catch (error) {
      return failureFrom(error)
    }
  }
}

function success<T>(statusCode: number, data: T): ArtifactAcquisitionHttpResult<T> {
  return { statusCode, body: { ok: true, data } }
}

function failure<T = never>(statusCode: number, code: string): ArtifactAcquisitionHttpResult<T> {
  return { statusCode, body: { ok: false, error: { code } } }
}

function failureFrom(error: unknown): ArtifactAcquisitionHttpResult<never> {
  if (error instanceof AcquisitionHttpFault) return failure(error.statusCode, error.code)
  if (error instanceof z.ZodError) return failure(422, 'UPDATE_ACQUISITION_REQUEST_INVALID')
  if (!(error instanceof UpdatePipelineError)) return failure(503, 'UPDATE_ACQUISITION_UNAVAILABLE')
  if (notFoundCodes.has(error.code)) return failure(404, error.code)
  if (lockedCodes.has(error.code)) return failure(423, error.code)
  if (conflictCodes.has(error.code)) return failure(409, error.code)
  if (unprocessableCodes.has(error.code)) return failure(422, error.code)
  if (unavailableCodes.has(error.code)) return failure(503, error.code)
  return failure(503, 'UPDATE_ACQUISITION_UNAVAILABLE')
}

class AcquisitionHttpFault extends Error {
  constructor(readonly statusCode: number, readonly code: string) {
    super(code)
    this.name = 'AcquisitionHttpFault'
  }
}

const notFoundCodes = new Set([
  'ACQUISITION_CANDIDATE_NOT_FOUND'
])

const lockedCodes = new Set([
  'ACQUISITION_ARTIFACT_LOCK_BUSY',
  'ACQUISITION_CANDIDATE_LOCK_BUSY',
  'ACQUISITION_REQUEST_LOCK_BUSY'
])

const conflictCodes = new Set([
  'ACQUISITION_AUTHORITY_REJECTED',
  'ACQUISITION_CANDIDATE_CONFLICT',
  'ACQUISITION_CANDIDATE_EXPIRED',
  'ACQUISITION_IDEMPOTENCY_CONFLICT',
  'ACQUISITION_INBOX_CONFLICT'
])

const unprocessableCodes = new Set([
  'ACQUISITION_ARCHIVE_SIGNATURE_INVALID',
  'ACQUISITION_ARTIFACT_EMPTY',
  'ACQUISITION_ARTIFACT_TOO_LARGE',
  'ACQUISITION_CANDIDATE_INELIGIBLE',
  'ACQUISITION_CONTENT_LENGTH_INVALID',
  'ACQUISITION_HTTP_STATUS_INVALID',
  'ACQUISITION_REDIRECT_INVALID',
  'ACQUISITION_REDIRECT_LIMIT',
  'ACQUISITION_SHA256_MISMATCH',
  'ACQUISITION_SIZE_MISMATCH',
  'ACQUISITION_URL_NOT_ALLOWED'
])

const unavailableCodes = new Set([
  'ACQUISITION_AUTHORITY_REQUIRED',
  'ACQUISITION_RECEIPT_AUTHORITY_MISMATCH',
  'ACQUISITION_CANDIDATE_INVALID',
  'ACQUISITION_INBOX_PUBLISH_FAILED',
  'ACQUISITION_LOCK_FAILED',
  'ACQUISITION_RECEIPT_INVALID',
  'ACQUISITION_REQUEST_ABORTED',
  'ACQUISITION_REQUEST_FAILED',
  'ACQUISITION_REQUEST_TIMEOUT',
  'ACQUISITION_RESPONSE_BODY_MISSING',
  'ACQUISITION_ROOT_INVALID',
  'ACQUISITION_STATE_FILE_INVALID',
  'ACQUISITION_STATE_WRITE_FAILED'
])

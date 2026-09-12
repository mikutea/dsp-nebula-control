import { z } from 'zod'
import type { ControlRole } from '../security/authorization.js'
import {
  createCutoverAuditAttemptId,
  type CutoverAuditBeginInput,
  type CutoverAuditCompleteInput,
  type CutoverAuditEventStore,
  type CutoverAuditStartedEvent
} from './audit.js'
import {
  ACTIVATE_GSMANAGER_TO_DYSON,
  PREPARE_GSMANAGER_TO_DYSON,
  ROLLBACK_DYSON_TO_GSMANAGER,
  CutoverError,
  type CutoverErrorCode,
  type CutoverActivateRequest,
  type CutoverAuditReceiptLookupRequest,
  type CutoverAuditReceiptResolution,
  type CutoverDesiredAuthority,
  type CutoverPrepareRequest,
  type CutoverPreviewReceipt,
  type CutoverPreviewRequest,
  type CutoverReceipt,
  type CutoverRecoveryRequest,
  type CutoverRecoveryStatus,
  type CutoverRollbackMode,
  type CutoverRollbackRequest
} from './types.js'

export const RECOVER_GSMANAGER_CUTOVER = 'RECOVER_GSMANAGER_CUTOVER' as const

const requestIdSchema = z.string().uuid().transform((value) => value.toLowerCase())
const rollbackModeSchema = z.enum(['immediate-compensation', 'later-operator-rollback'])
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
const authoritySchema = z.enum(['previous', 'candidate'])
const errorCodeSchema = z.enum([
  'CUTOVER_REQUEST_INVALID',
  'CUTOVER_CONFIRMATION_REQUIRED',
  'CUTOVER_ROLLBACK_CONFIRMATION_REQUIRED',
  'CUTOVER_PREVIEW_REQUIRED',
  'CUTOVER_PREVIEW_CONFLICT',
  'CUTOVER_IDEMPOTENCY_CONFLICT',
  'CUTOVER_NOT_PREPARED',
  'CUTOVER_NOT_CANDIDATE_ACTIVE',
  'CUTOVER_RECOVERY_REQUIRED',
  'CUTOVER_RECOVERY_NOT_REQUIRED',
  'CUTOVER_RECOVERY_TARGET_NOT_ALLOWED',
  'CUTOVER_RECOVERY_EVIDENCE_INVALID',
  'CUTOVER_DURABLE_STATE_INVALID',
  'CUTOVER_DURABLE_STORE_FAILED',
  'CUTOVER_AUTHORITY_DRIFT',
  'CUTOVER_RUNTIME_DRIFT',
  'CUTOVER_PREPARE_INVARIANT_FAILED',
  'CUTOVER_SAVE_PROTECTION_FAILED',
  'CUTOVER_SAVE_RESTORE_FAILED',
  'CUTOVER_STOP_GATE_FAILED',
  'CUTOVER_HEALTH_GATE_FAILED',
  'CUTOVER_UNIQUE_AUTHORITY_FAILED',
  'CUTOVER_ADAPTER_FAILED',
  'CUTOVER_HOST_LEASE_BUSY',
  'CUTOVER_HOST_LEASE_DIRTY',
  'CUTOVER_HOST_LEASE_RECOVERY_REQUIRED',
  'CUTOVER_HOST_LEASE_RECOVERY_NOT_REQUIRED',
  'CUTOVER_HOST_LEASE_RECOVERY_MISMATCH',
  'CUTOVER_HOST_LEASE_LOST',
  'CUTOVER_HOST_LEASE_UNAVAILABLE'
] satisfies readonly CutoverErrorCode[])
const emptyInputSchema = z.strictObject({})

const prepareSchema = z.strictObject({
  requestId: requestIdSchema,
  planFingerprint: sha256Schema,
  confirmation: z.literal(PREPARE_GSMANAGER_TO_DYSON)
})
const prepareConfirmationProbeSchema = z.strictObject({
  requestId: requestIdSchema,
  planFingerprint: z.unknown().optional(),
  confirmation: z.unknown().optional()
})
const activateSchema = z.strictObject({
  requestId: requestIdSchema,
  planFingerprint: sha256Schema,
  confirmation: z.literal(ACTIVATE_GSMANAGER_TO_DYSON)
})
const activateConfirmationProbeSchema = z.strictObject({
  requestId: requestIdSchema,
  planFingerprint: z.unknown().optional(),
  confirmation: z.unknown().optional()
})
const rollbackSchema = z.strictObject({
  requestId: requestIdSchema,
  mode: rollbackModeSchema,
  planFingerprint: sha256Schema,
  confirmation: z.literal(ROLLBACK_DYSON_TO_GSMANAGER)
})
const rollbackConfirmationProbeSchema = z.strictObject({
  requestId: requestIdSchema,
  mode: rollbackModeSchema,
  planFingerprint: z.unknown().optional(),
  confirmation: z.unknown().optional()
})
const recoverySchema = z.strictObject({
  requestId: requestIdSchema,
  desired: authoritySchema,
  confirmation: z.literal(RECOVER_GSMANAGER_CUTOVER)
})
const recoveryConfirmationProbeSchema = z.strictObject({
  requestId: requestIdSchema,
  desired: authoritySchema,
  confirmation: z.unknown().optional()
})

const publicSummarySchema = z.strictObject({
  candidateDefined: z.boolean(),
  candidateDisabled: z.boolean(),
  previousAuthorityEnabled: z.boolean(),
  candidateAuthorityEnabled: z.boolean(),
  previousRuntimeHealthy: z.boolean(),
  candidateRuntimeHealthy: z.boolean(),
  processesStopped: z.boolean(),
  portClosed: z.boolean(),
  uniqueAuthority: z.boolean(),
  saveProtected: z.boolean(),
  baselineRestored: z.boolean(),
  currentProgressProtected: z.boolean(),
  reused: z.boolean()
})

const previewRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ requestId: requestIdSchema, operation: z.literal('prepare') }),
  z.strictObject({ requestId: requestIdSchema, operation: z.literal('activate') }),
  z.strictObject({
    requestId: requestIdSchema,
    operation: z.literal('rollback'),
    mode: rollbackModeSchema
  })
])

const previewReceiptSchema: z.ZodType<CutoverPreviewReceipt> = z.strictObject({
  format: z.literal('dyson-control-cutover-preview'),
  schemaVersion: z.literal(1),
  operation: z.enum(['prepare', 'activate', 'rollback']),
  requestId: requestIdSchema,
  rollbackMode: rollbackModeSchema.nullable(),
  stateRevision: sha256Schema,
  evidenceDigest: sha256Schema,
  planFingerprint: sha256Schema,
  summary: publicSummarySchema
}).superRefine((preview, context) => {
  const coherent = preview.operation === 'rollback'
    ? preview.rollbackMode !== null
    : preview.rollbackMode === null
  if (!coherent || preview.summary.reused) {
    context.addIssue({ code: 'custom', message: 'preview-binding' })
  }
})

const receiptSchema: z.ZodType<CutoverReceipt> = z.strictObject({
  requestId: requestIdSchema,
  phase: z.enum([
    'prepared',
    'activated',
    'rolled-back-immediate',
    'rolled-back-later',
    'recovered-candidate',
    'recovered-previous'
  ]),
  status: z.enum(['succeeded', 'rolled-back', 'failed-safe']),
  allowedDesired: z.array(authoritySchema).max(2),
  summary: publicSummarySchema,
  errorCode: errorCodeSchema.nullable()
})

const coreRecoveryStatusSchema: z.ZodType<CutoverRecoveryStatus> = z.strictObject({
  requestId: requestIdSchema.nullable(),
  phase: z.enum(['ready', 'recovery-required']),
  status: z.enum(['ready', 'interrupted', 'terminal-pending-release', 'evidence-invalid']),
  allowedDesired: z.array(authoritySchema).max(2),
  summary: publicSummarySchema,
  errorCode: errorCodeSchema.nullable()
}).superRefine((value, context) => {
  const coherent = value.phase === 'ready'
    ? value.status === 'ready' && value.requestId === null &&
      value.allowedDesired.length === 0 && value.errorCode === null
    : value.status !== 'ready'
  if (!coherent) context.addIssue({ code: 'custom', message: 'incoherent recovery state' })
})

export interface CutoverHttpService {
  getReceiptForAudit(input: CutoverAuditReceiptLookupRequest): Promise<CutoverAuditReceiptResolution | null>
  preview(input: CutoverPreviewRequest): Promise<CutoverPreviewReceipt>
  prepare(input: CutoverPrepareRequest): Promise<CutoverReceipt>
  activate(input: CutoverActivateRequest): Promise<CutoverReceipt>
  rollback(input: CutoverRollbackRequest): Promise<CutoverReceipt>
  recoveryStatus(): Promise<CutoverRecoveryStatus>
  recoverInterrupted(input: CutoverRecoveryRequest): Promise<CutoverReceipt>
}

export type CutoverOrdinaryGateRequest =
  | Readonly<{ operation: 'prepare'; requestId: string }>
  | Readonly<{ operation: 'activate'; requestId: string }>
  | Readonly<{ operation: 'rollback'; requestId: string; mode: CutoverRollbackMode }>

export interface CutoverRecoveryGateRequest {
  requestId: string
  desired: CutoverDesiredAuthority
}

export type CutoverOrdinaryMutationGate = (
  request: CutoverOrdinaryGateRequest
) => boolean | Promise<boolean>

export type CutoverRecoveryMutationGate = (
  request: Readonly<CutoverRecoveryGateRequest>
) => boolean | Promise<boolean>

export interface CutoverHttpControllerOptions {
  service: CutoverHttpService
  ordinaryMutationGate?: CutoverOrdinaryMutationGate
  recoveryMutationGate?: CutoverRecoveryMutationGate
  /** When present, every valid mutation is fail-closed behind its append-only audit pair. */
  audit?: CutoverAuditEventStore
}

export interface CutoverHttpMutationContext {
  actorRole: ControlRole
}

export type CutoverHttpRecoveryPhase =
  | 'pending'
  | 'reconciling'
  | 'ready'
  | 'recovery-required'
  | 'unavailable'

export interface CutoverHttpRecoveryStatus {
  schemaVersion: 1
  phase: CutoverHttpRecoveryPhase
  status: CutoverRecoveryStatus['status'] | 'pending' | 'reconciling' | 'unavailable'
  mutationBlocked: boolean
  recoveryRequired: boolean
  requestId: string | null
  allowedDesired: CutoverDesiredAuthority[]
  summary: CutoverReceipt['summary']
  errorCode: string | null
}

export interface CutoverHttpSuccess<T> {
  ok: true
  data: T
}

export interface CutoverHttpFailure {
  ok: false
  error: { code: string }
}

export interface CutoverHttpResult<T> {
  statusCode: number
  body: CutoverHttpSuccess<T> | CutoverHttpFailure
}

/** Fastify-independent, code-only boundary for the cutover transaction core. */
export class CutoverHttpController {
  readonly #service: CutoverHttpService
  readonly #ordinaryMutationGate: CutoverOrdinaryMutationGate
  readonly #recoveryMutationGate: CutoverRecoveryMutationGate
  readonly #audit: CutoverAuditEventStore | null
  #initialization: Promise<void> | null = null
  #auditUnavailableCode: string | null = null
  #mutationInFlight = false

  constructor(options: CutoverHttpControllerOptions) {
    this.#service = options.service
    this.#ordinaryMutationGate = options.ordinaryMutationGate ?? (() => false)
    this.#recoveryMutationGate = options.recoveryMutationGate ?? (() => false)
    this.#audit = options.audit ?? null
  }

  async initialize(): Promise<void> {
    if (this.#initialization === null) this.#initialization = this.#initializeOnce()
    await this.#initialization
  }

  async recoveryStatus(input: unknown): Promise<CutoverHttpResult<CutoverHttpRecoveryStatus>> {
    try {
      emptyInputSchema.parse(input)
      await this.initialize()
      const recovery = this.#applyAuditAvailability(await this.#readRecoveryStatus())
      return success(200, cloneRecoveryStatus(recovery))
    } catch (error) {
      return failureFrom(error)
    }
  }

  async preview(input: unknown): Promise<CutoverHttpResult<CutoverPreviewReceipt>> {
    try {
      const request = previewRequestSchema.parse(input) as CutoverPreviewRequest
      await this.initialize()
      const recovery = this.#applyAuditAvailability(await this.#readRecoveryStatus())
      if (recovery.phase !== 'ready') {
        throw new CutoverHttpFault(
          recovery.phase === 'recovery-required' ? 409 : 503,
          recovery.phase === 'recovery-required'
            ? 'CUTOVER_RECOVERY_REQUIRED'
            : 'CUTOVER_HTTP_RECOVERY_UNAVAILABLE'
        )
      }
      return success(200, parsePreviewReceipt(await this.#service.preview(request), request))
    } catch (error) {
      return failureFrom(error)
    }
  }

  async prepare(
    input: unknown,
    context?: CutoverHttpMutationContext
  ): Promise<CutoverHttpResult<CutoverReceipt>> {
    let request: CutoverPrepareRequest
    try {
      request = parsePrepare(input)
    } catch (error) {
      return failureFrom(error)
    }
    return this.#runAuditedMutation({
      operation: 'prepare',
      requestId: request.requestId,
      planFingerprint: request.planFingerprint
    }, context, async () => {
      try {
        await this.#requireOrdinaryReady({ operation: 'prepare', requestId: request.requestId })
        return receiptSuccess(await this.#service.prepare(request), {
          requestId: request.requestId,
          primaryPhase: 'prepared',
          primaryStatus: 'succeeded'
        })
      } catch (error) {
        return failureFrom(error)
      }
    })
  }

  async activate(
    input: unknown,
    context?: CutoverHttpMutationContext
  ): Promise<CutoverHttpResult<CutoverReceipt>> {
    let request: CutoverActivateRequest
    try {
      request = parseActivate(input)
    } catch (error) {
      return failureFrom(error)
    }
    return this.#runAuditedMutation({
      operation: 'activate',
      requestId: request.requestId,
      planFingerprint: request.planFingerprint
    }, context, async () => {
      try {
        await this.#requireOrdinaryReady({ operation: 'activate', requestId: request.requestId })
        return receiptSuccess(await this.#service.activate(request), {
          requestId: request.requestId,
          primaryPhase: 'activated',
          primaryStatus: 'succeeded'
        })
      } catch (error) {
        return failureFrom(error)
      }
    })
  }

  async rollback(
    input: unknown,
    context?: CutoverHttpMutationContext
  ): Promise<CutoverHttpResult<CutoverReceipt>> {
    let request: CutoverRollbackRequest
    try {
      request = parseRollback(input)
    } catch (error) {
      return failureFrom(error)
    }
    return this.#runAuditedMutation({
      operation: 'rollback',
      requestId: request.requestId,
      planFingerprint: request.planFingerprint,
      rollbackMode: request.mode
    }, context, async () => {
      try {
        await this.#requireOrdinaryReady({
          operation: 'rollback',
          requestId: request.requestId,
          mode: request.mode
        })
        return receiptSuccess(await this.#service.rollback(request), {
          requestId: request.requestId,
          primaryPhase: request.mode === 'immediate-compensation'
            ? 'rolled-back-immediate'
            : 'rolled-back-later',
          primaryStatus: 'rolled-back'
        })
      } catch (error) {
        return failureFrom(error)
      }
    })
  }

  async recover(
    input: unknown,
    context?: CutoverHttpMutationContext
  ): Promise<CutoverHttpResult<CutoverReceipt>> {
    let request: CutoverRecoveryRequest
    try {
      request = parseRecovery(input)
    } catch (error) {
      return failureFrom(error)
    }
    return this.#runAuditedMutation({
      operation: 'recover',
      requestId: request.requestId,
      desired: request.desired
    }, context, async () => {
      try {
        const before = this.#applyAuditAvailability(await this.#readRecoveryStatus())
        if (before.phase !== 'recovery-required') {
          throw new CutoverHttpFault(
            before.phase === 'ready' ? 409 : 503,
            before.phase === 'ready'
              ? 'CUTOVER_RECOVERY_NOT_REQUIRED'
              : before.phase === 'pending' || before.phase === 'reconciling'
                ? 'CUTOVER_HTTP_RECOVERY_PENDING'
                : 'CUTOVER_HTTP_RECOVERY_UNAVAILABLE'
          )
        }
        if (before.requestId !== null && before.requestId !== request.requestId) {
          throw new CutoverHttpFault(409, 'CUTOVER_HTTP_RECOVERY_REQUEST_MISMATCH')
        }
        if (!before.allowedDesired.includes(request.desired)) {
          throw new CutoverHttpFault(409, 'CUTOVER_RECOVERY_TARGET_NOT_ALLOWED')
        }

        let allowed: boolean
        try {
          allowed = await this.#recoveryMutationGate({
            requestId: request.requestId,
            desired: request.desired
          })
        } catch {
          throw new CutoverHttpFault(503, 'CUTOVER_HTTP_GATE_UNAVAILABLE')
        }
        if (allowed !== true) {
          throw new CutoverHttpFault(423, 'CUTOVER_HTTP_RECOVERY_MUTATION_DISABLED')
        }

        const receipt = parseBoundReceipt(await this.#service.recoverInterrupted({
          requestId: request.requestId,
          desired: request.desired
        }), {
          requestId: request.requestId,
          primaryPhase: `recovered-${request.desired}`,
          primaryStatus: request.desired === 'candidate' ? 'succeeded' : ['succeeded', 'rolled-back']
        })
        const after = this.#applyAuditAvailability(await this.#readRecoveryStatus())
        if (!isReadyRecoveryStatus(after)) {
          throw new CutoverHttpFault(503, 'CUTOVER_HTTP_RECOVERY_TERMINAL_UNPROVEN')
        }
        return success(receipt.summary.reused ? 200 : 202, receipt)
      } catch (error) {
        return failureFrom(error)
      }
    })
  }

  async #runAuditedMutation(
    input: Omit<CutoverAuditBeginInput, 'attemptId' | 'actorRole'>,
    context: CutoverHttpMutationContext | undefined,
    operation: () => Promise<CutoverHttpResult<CutoverReceipt>>
  ): Promise<CutoverHttpResult<CutoverReceipt>> {
    if (this.#mutationInFlight) return failure(423, 'CUTOVER_HTTP_MUTATION_BUSY')
    this.#mutationInFlight = true
    try {
      await this.initialize()
      if (this.#audit === null) return await operation()
      if (context === undefined) return failure(503, 'CUTOVER_HTTP_AUDIT_UNAVAILABLE')

      const before = await this.#readRecoveryStatus()
      await this.#reconcileIncompleteAudits(before)
      if (this.#auditUnavailableCode !== null) {
        return failure(503, auditMutationFailureCode(this.#auditUnavailableCode))
      }

      const attemptId = createCutoverAuditAttemptId()
      try {
        await this.#audit.begin({ ...input, attemptId, actorRole: context.actorRole })
      } catch {
        this.#auditUnavailableCode = 'CUTOVER_HTTP_AUDIT_UNAVAILABLE'
        return failure(503, 'CUTOVER_HTTP_AUDIT_UNAVAILABLE')
      }

      let result: CutoverHttpResult<CutoverReceipt>
      try {
        result = await operation()
      } catch {
        result = failure(503, 'CUTOVER_HTTP_UNAVAILABLE')
      }
      try {
        await this.#audit.complete(auditCompletion(attemptId, result))
      } catch {
        this.#auditUnavailableCode = 'CUTOVER_HTTP_AUDIT_INCOMPLETE'
        return failure(503, 'CUTOVER_HTTP_AUDIT_INCOMPLETE')
      }

      const after = await this.#readRecoveryStatus()
      await this.#reconcileIncompleteAudits(after)
      if (this.#auditUnavailableCode !== null) {
        return failure(503, 'CUTOVER_HTTP_AUDIT_INCOMPLETE')
      }
      return result
    } finally {
      this.#mutationInFlight = false
    }
  }

  async #requireOrdinaryReady(request: CutoverOrdinaryGateRequest): Promise<void> {
    const recovery = this.#applyAuditAvailability(await this.#readRecoveryStatus())
    if (recovery.phase !== 'ready') {
      throw new CutoverHttpFault(
        503,
        recovery.phase === 'pending' || recovery.phase === 'reconciling'
          ? 'CUTOVER_HTTP_RECOVERY_PENDING'
          : recovery.phase === 'recovery-required'
            ? 'CUTOVER_RECOVERY_REQUIRED'
            : 'CUTOVER_HTTP_RECOVERY_UNAVAILABLE'
      )
    }
    let allowed: boolean
    try {
      allowed = await this.#ordinaryMutationGate(request)
    } catch {
      throw new CutoverHttpFault(503, 'CUTOVER_HTTP_GATE_UNAVAILABLE')
    }
    if (allowed !== true) throw new CutoverHttpFault(423, 'CUTOVER_HTTP_MUTATION_DISABLED')
  }

  async #initializeOnce(): Promise<void> {
    const recovery = await this.#readRecoveryStatus()
    await this.#reconcileIncompleteAudits(recovery)
  }

  async #reconcileIncompleteAudits(recovery: CutoverHttpRecoveryStatus): Promise<void> {
    if (this.#audit === null) return
    try {
      const incomplete = await this.#audit.listIncomplete(200)
      for (const started of incomplete) {
        const resolution = await this.#service.getReceiptForAudit({
          requestId: started.requestId,
          operation: started.operation,
          planFingerprint: started.planFingerprint ?? null,
          rollbackMode: started.rollbackMode,
          desired: started.desired
        })
        if (resolution !== null) {
          await this.#audit.complete(auditCompletionFromResolution(started, resolution))
          continue
        }
        if (recovery.phase === 'ready') {
          await this.#audit.complete({
            attemptId: started.attemptId,
            outcome: 'failed',
            httpStatus: 503,
            errorCode: 'CUTOVER_HTTP_INTERRUPTED_BEFORE_MUTATION'
          })
        }
      }
      const remaining = await this.#audit.listIncomplete(1)
      this.#auditUnavailableCode = remaining.length === 0
        ? null
        : recovery.phase === 'recovery-required'
          ? null
          : recovery.phase === 'ready'
            ? 'CUTOVER_HTTP_AUDIT_RECOVERY_REQUIRED'
            : 'CUTOVER_HTTP_AUDIT_UNAVAILABLE'
    } catch {
      this.#auditUnavailableCode = 'CUTOVER_HTTP_AUDIT_UNAVAILABLE'
    }
  }

  #applyAuditAvailability(recovery: CutoverHttpRecoveryStatus): CutoverHttpRecoveryStatus {
    // Never hide the durable core recovery identity/allowed target from an
    // operator. The mutation path still rechecks and repairs the audit store
    // before it can append a recovery attempt.
    if (this.#auditUnavailableCode === null || recovery.phase === 'recovery-required') {
      return recovery
    }
    return unavailableRecoveryStatus(
      'unavailable',
      'unavailable',
      this.#auditUnavailableCode
    )
  }

  async #readRecoveryStatus(): Promise<CutoverHttpRecoveryStatus> {
    try {
      const status = coreRecoveryStatusSchema.parse(await this.#service.recoveryStatus())
      return {
        schemaVersion: 1,
        phase: status.phase,
        status: status.status,
        mutationBlocked: status.phase !== 'ready',
        recoveryRequired: status.phase === 'recovery-required',
        requestId: status.requestId,
        allowedDesired: [...status.allowedDesired],
        summary: { ...status.summary },
        errorCode: status.errorCode
      }
    } catch (error) {
      return unavailableRecoveryStatus(
        'unavailable',
        'unavailable',
        safeRecoveryFailureCode(error)
      )
    }
  }
}

function isReadyRecoveryStatus(status: CutoverHttpRecoveryStatus): boolean {
  return status.phase === 'ready'
}

function parsePrepare(input: unknown): CutoverPrepareRequest {
  const parsed = prepareSchema.safeParse(input)
  if (parsed.success) return parsed.data
  const confirmationProbe = prepareConfirmationProbeSchema.safeParse(input)
  if (confirmationProbe.success &&
      confirmationProbe.data.confirmation !== PREPARE_GSMANAGER_TO_DYSON) {
    throw new CutoverHttpFault(422, 'CUTOVER_CONFIRMATION_REQUIRED')
  }
  if (confirmationProbe.success && confirmationProbe.data.planFingerprint === undefined) {
    throw new CutoverHttpFault(409, 'CUTOVER_PREVIEW_REQUIRED')
  }
  throw new CutoverHttpFault(422, 'CUTOVER_REQUEST_INVALID')
}

function parseActivate(input: unknown): CutoverActivateRequest {
  const parsed = activateSchema.safeParse(input)
  if (parsed.success) return parsed.data
  const confirmationProbe = activateConfirmationProbeSchema.safeParse(input)
  if (confirmationProbe.success &&
      confirmationProbe.data.confirmation !== ACTIVATE_GSMANAGER_TO_DYSON) {
    throw new CutoverHttpFault(422, 'CUTOVER_CONFIRMATION_REQUIRED')
  }
  if (confirmationProbe.success && confirmationProbe.data.planFingerprint === undefined) {
    throw new CutoverHttpFault(409, 'CUTOVER_PREVIEW_REQUIRED')
  }
  throw new CutoverHttpFault(422, 'CUTOVER_REQUEST_INVALID')
}

function parseRollback(input: unknown): CutoverRollbackRequest {
  const parsed = rollbackSchema.safeParse(input)
  if (parsed.success) return parsed.data
  const confirmationProbe = rollbackConfirmationProbeSchema.safeParse(input)
  if (confirmationProbe.success &&
      confirmationProbe.data.confirmation !== ROLLBACK_DYSON_TO_GSMANAGER) {
    throw new CutoverHttpFault(422, 'CUTOVER_ROLLBACK_CONFIRMATION_REQUIRED')
  }
  if (confirmationProbe.success && confirmationProbe.data.planFingerprint === undefined) {
    throw new CutoverHttpFault(409, 'CUTOVER_PREVIEW_REQUIRED')
  }
  throw new CutoverHttpFault(422, 'CUTOVER_REQUEST_INVALID')
}

function parseRecovery(input: unknown): z.infer<typeof recoverySchema> {
  const parsed = recoverySchema.safeParse(input)
  if (parsed.success) return parsed.data
  const confirmationProbe = recoveryConfirmationProbeSchema.safeParse(input)
  throw new CutoverHttpFault(
    422,
    confirmationProbe.success ? 'CUTOVER_HTTP_RECOVERY_CONFIRMATION_REQUIRED' : 'CUTOVER_REQUEST_INVALID'
  )
}

interface ReceiptBinding {
  requestId: string
  primaryPhase: CutoverReceipt['phase']
  primaryStatus: CutoverReceipt['status'] | readonly CutoverReceipt['status'][]
}

function receiptSuccess(
  value: unknown,
  expected: ReceiptBinding
): CutoverHttpResult<CutoverReceipt> {
  const receipt = parseBoundReceipt(value, expected)
  return success(receipt.summary.reused ? 200 : 202, receipt)
}

function parseBoundReceipt(value: unknown, expected: ReceiptBinding): CutoverReceipt {
  const receipt = parseReceipt(value)
  const allowedStatuses = Array.isArray(expected.primaryStatus)
    ? expected.primaryStatus
    : [expected.primaryStatus]
  if (receipt.requestId !== expected.requestId ||
      receipt.phase !== expected.primaryPhase ||
      !allowedStatuses.includes(receipt.status) ||
      receipt.status === 'failed-safe' ||
      receipt.allowedDesired.length !== 0 || receipt.errorCode !== null) {
    throw new CutoverHttpFault(503, 'CUTOVER_HTTP_RECEIPT_INVALID')
  }
  return receipt
}

function parsePreviewReceipt(
  value: unknown,
  expected: CutoverPreviewRequest
): CutoverPreviewReceipt {
  const parsed = previewReceiptSchema.safeParse(value)
  if (!parsed.success) throw new CutoverHttpFault(503, 'CUTOVER_HTTP_PREVIEW_INVALID')
  const preview = parsed.data
  const rollbackMode = expected.operation === 'rollback' ? expected.mode : null
  if (preview.requestId !== expected.requestId || preview.operation !== expected.operation ||
      preview.rollbackMode !== rollbackMode) {
    throw new CutoverHttpFault(503, 'CUTOVER_HTTP_PREVIEW_INVALID')
  }
  return {
    ...preview,
    summary: { ...preview.summary }
  }
}

function parseReceipt(value: unknown): CutoverReceipt {
  try {
    return receiptSchema.parse(value)
  } catch {
    throw new CutoverHttpFault(503, 'CUTOVER_HTTP_UNAVAILABLE')
  }
}

function success<T>(statusCode: number, data: T): CutoverHttpResult<T> {
  return { statusCode, body: { ok: true, data } }
}

function failure(statusCode: number, code: string): CutoverHttpResult<never> {
  return { statusCode, body: { ok: false, error: { code } } }
}

function failureFrom(error: unknown): CutoverHttpResult<never> {
  if (error instanceof CutoverHttpFault) return failure(error.statusCode, error.code)
  if (error instanceof CutoverError) return mapCoreFailure(error.code)
  if (error instanceof z.ZodError) return failure(422, 'CUTOVER_REQUEST_INVALID')
  return failure(503, 'CUTOVER_HTTP_UNAVAILABLE')
}

function auditCompletion(
  attemptId: string,
  result: CutoverHttpResult<CutoverReceipt>
): CutoverAuditCompleteInput {
  if (result.body.ok) {
    return {
      attemptId,
      outcome: 'succeeded',
      httpStatus: result.statusCode,
      receiptPhase: result.body.data.phase,
      receiptReused: result.body.data.summary.reused
    }
  }
  const code = result.body.error.code
  return {
    attemptId,
    outcome: recoveryRequiredAuditCodes.has(code)
      ? 'recovery-required'
      : result.statusCode >= 400 && result.statusCode < 500
        ? 'rejected'
        : 'failed',
    httpStatus: result.statusCode,
    errorCode: code
  }
}

function auditCompletionFromResolution(
  started: CutoverAuditStartedEvent,
  resolution: CutoverAuditReceiptResolution
): CutoverAuditCompleteInput {
  if (resolution.match === 'conflict') {
    return {
      attemptId: started.attemptId,
      outcome: 'rejected',
      httpStatus: 409,
      errorCode: 'CUTOVER_IDEMPOTENCY_CONFLICT'
    }
  }

  const receipt = parseReceipt(resolution.receipt)
  if (receipt.requestId !== started.requestId || receipt.status === 'failed-safe' ||
      receipt.errorCode !== null || receipt.allowedDesired.length !== 0) {
    throw new CutoverHttpFault(503, 'CUTOVER_HTTP_AUDIT_UNAVAILABLE')
  }
  if (started.operation === 'recover') {
    if (started.desired === null || receipt.phase !== `recovered-${started.desired}` ||
        (started.desired === 'candidate'
          ? receipt.status !== 'succeeded'
          : receipt.status !== 'succeeded' && receipt.status !== 'rolled-back')) {
      throw new CutoverHttpFault(503, 'CUTOVER_HTTP_AUDIT_UNAVAILABLE')
    }
    return reconciledSuccess(started.attemptId, receipt)
  }

  const expected = expectedOrdinaryReceipt(started)
  if (expected === null || resolution.storedOperation !== expected.operation) {
    throw new CutoverHttpFault(503, 'CUTOVER_HTTP_AUDIT_UNAVAILABLE')
  }
  if (receipt.phase === expected.phase) {
    const expectedStatus = started.operation === 'rollback' ? 'rolled-back' : 'succeeded'
    if (receipt.status !== expectedStatus) {
      throw new CutoverHttpFault(503, 'CUTOVER_HTTP_AUDIT_UNAVAILABLE')
    }
    return reconciledSuccess(started.attemptId, receipt)
  }
  if (receipt.phase === 'recovered-candidate' || receipt.phase === 'recovered-previous') {
    return {
      attemptId: started.attemptId,
      outcome: 'recovery-required',
      httpStatus: 503,
      errorCode: 'CUTOVER_RECOVERY_REQUIRED',
      receiptPhase: receipt.phase,
      receiptReused: receipt.summary.reused
    }
  }
  throw new CutoverHttpFault(503, 'CUTOVER_HTTP_AUDIT_UNAVAILABLE')
}

function reconciledSuccess(
  attemptId: string,
  receipt: CutoverReceipt
): CutoverAuditCompleteInput {
  return {
    attemptId,
    outcome: 'succeeded',
    httpStatus: receipt.summary.reused ? 200 : 202,
    receiptPhase: receipt.phase,
    receiptReused: receipt.summary.reused
  }
}

function expectedOrdinaryReceipt(started: CutoverAuditStartedEvent): Readonly<{
  operation: 'prepare' | 'activate' | 'rollback-immediate' | 'rollback-later'
  phase: 'prepared' | 'activated' | 'rolled-back-immediate' | 'rolled-back-later'
}> | null {
  if (started.operation === 'prepare') return { operation: 'prepare', phase: 'prepared' }
  if (started.operation === 'activate') return { operation: 'activate', phase: 'activated' }
  if (started.operation !== 'rollback') return null
  return started.rollbackMode === 'immediate-compensation'
    ? { operation: 'rollback-immediate', phase: 'rolled-back-immediate' }
    : started.rollbackMode === 'later-operator-rollback'
      ? { operation: 'rollback-later', phase: 'rolled-back-later' }
      : null
}

function auditMutationFailureCode(code: string): string {
  return code === 'CUTOVER_HTTP_AUDIT_INCOMPLETE' ||
    code === 'CUTOVER_HTTP_AUDIT_RECOVERY_REQUIRED'
    ? 'CUTOVER_HTTP_AUDIT_INCOMPLETE'
    : 'CUTOVER_HTTP_AUDIT_UNAVAILABLE'
}

function mapCoreFailure(code: string): CutoverHttpResult<never> {
  if (unprocessableCodes.has(code)) return failure(422, code)
  if (conflictCodes.has(code)) return failure(409, code)
  if (lockedCodes.has(code)) return failure(423, code)
  if (unavailableCodes.has(code)) return failure(503, code)
  return failure(503, 'CUTOVER_HTTP_UNAVAILABLE')
}

function safeRecoveryFailureCode(error: unknown): string {
  if (error instanceof CutoverError && errorCodeSchema.safeParse(error.code).success) {
    return error.code
  }
  return 'CUTOVER_HTTP_RECOVERY_UNAVAILABLE'
}

function unavailableRecoveryStatus(
  phase: Extract<CutoverHttpRecoveryPhase, 'pending' | 'reconciling' | 'unavailable'>,
  status: 'pending' | 'reconciling' | 'unavailable',
  errorCode: string | null
): CutoverHttpRecoveryStatus {
  return {
    schemaVersion: 1,
    phase,
    status,
    mutationBlocked: true,
    recoveryRequired: false,
    requestId: null,
    allowedDesired: [],
    summary: emptySummary(),
    errorCode
  }
}

function cloneRecoveryStatus(status: CutoverHttpRecoveryStatus): CutoverHttpRecoveryStatus {
  return {
    ...status,
    allowedDesired: [...status.allowedDesired],
    summary: { ...status.summary }
  }
}

function emptySummary(): CutoverReceipt['summary'] {
  return {
    candidateDefined: false,
    candidateDisabled: false,
    previousAuthorityEnabled: false,
    candidateAuthorityEnabled: false,
    previousRuntimeHealthy: false,
    candidateRuntimeHealthy: false,
    processesStopped: false,
    portClosed: false,
    uniqueAuthority: false,
    saveProtected: false,
    baselineRestored: false,
    currentProgressProtected: false,
    reused: false
  }
}

class CutoverHttpFault extends Error {
  readonly statusCode: number
  readonly code: string

  constructor(statusCode: number, code: string) {
    super(code)
    this.name = 'CutoverHttpFault'
    this.statusCode = statusCode
    this.code = code
  }
}

const unprocessableCodes = new Set<string>([
  'CUTOVER_REQUEST_INVALID',
  'CUTOVER_CONFIRMATION_REQUIRED',
  'CUTOVER_ROLLBACK_CONFIRMATION_REQUIRED'
])

const conflictCodes = new Set<string>([
  'CUTOVER_PREVIEW_REQUIRED',
  'CUTOVER_PREVIEW_CONFLICT',
  'CUTOVER_IDEMPOTENCY_CONFLICT',
  'CUTOVER_NOT_PREPARED',
  'CUTOVER_NOT_CANDIDATE_ACTIVE',
  'CUTOVER_RECOVERY_NOT_REQUIRED',
  'CUTOVER_RECOVERY_TARGET_NOT_ALLOWED',
  'CUTOVER_HOST_LEASE_RECOVERY_NOT_REQUIRED',
  'CUTOVER_HOST_LEASE_RECOVERY_MISMATCH',
  'CUTOVER_AUTHORITY_DRIFT',
  'CUTOVER_RUNTIME_DRIFT',
  'CUTOVER_PREPARE_INVARIANT_FAILED'
])

const lockedCodes = new Set<string>([
  'CUTOVER_HOST_LEASE_BUSY'
])

const unavailableCodes = new Set<string>([
  'CUTOVER_RECOVERY_REQUIRED',
  'CUTOVER_RECOVERY_EVIDENCE_INVALID',
  'CUTOVER_DURABLE_STATE_INVALID',
  'CUTOVER_DURABLE_STORE_FAILED',
  'CUTOVER_SAVE_PROTECTION_FAILED',
  'CUTOVER_SAVE_RESTORE_FAILED',
  'CUTOVER_STOP_GATE_FAILED',
  'CUTOVER_HEALTH_GATE_FAILED',
  'CUTOVER_UNIQUE_AUTHORITY_FAILED',
  'CUTOVER_ADAPTER_FAILED',
  'CUTOVER_HOST_LEASE_DIRTY',
  'CUTOVER_HOST_LEASE_RECOVERY_REQUIRED',
  'CUTOVER_HOST_LEASE_LOST',
  'CUTOVER_HOST_LEASE_UNAVAILABLE'
])

const recoveryRequiredAuditCodes = new Set<string>([
  'CUTOVER_RECOVERY_REQUIRED',
  'CUTOVER_HOST_LEASE_DIRTY',
  'CUTOVER_HOST_LEASE_RECOVERY_REQUIRED',
  'CUTOVER_HTTP_RECOVERY_PENDING',
  'CUTOVER_HTTP_RECOVERY_TERMINAL_UNPROVEN'
])

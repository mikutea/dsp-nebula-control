import { z } from 'zod'
import { normalizeVersion, type VersionComponent } from '../updates/version.js'
import { componentUpdateActivationRequestSchema } from './activation.js'
import {
  ComponentUpdateActivationError,
  type ComponentUpdateActivationPlan,
  type ComponentUpdateActivationReceipt,
  type ComponentUpdateCleanupPlan,
  type ComponentUpdateStateSummary,
  type UpdateActivationComponent,
  type UpdateActivationRequest
} from './activation-types.js'
import { UpdatePipelineError } from './errors.js'

export const componentUpdateActivationConfirmations = Object.freeze({
  dsp: 'ACTIVATE_DSP_UPDATE',
  nebula: 'ACTIVATE_NEBULA_UPDATE',
  bepinex: 'ACTIVATE_BEPINEX_UPDATE',
  bridge: 'ACTIVATE_BRIDGE_UPDATE',
  control: 'ACTIVATE_CONTROL_UPDATE'
} satisfies Record<UpdateActivationComponent, string>)

export const componentUpdateActivationRecoveryConfirmation = 'RECOVER_COMPONENT_UPDATE' as const

const confirmationSchema = z.enum([
  'ACTIVATE_DSP_UPDATE',
  'ACTIVATE_NEBULA_UPDATE',
  'ACTIVATE_BEPINEX_UPDATE',
  'ACTIVATE_BRIDGE_UPDATE',
  'ACTIVATE_CONTROL_UPDATE'
])

// Keep this envelope flat for an eventual HTTP route while making every field
// explicit. The core schema below performs the deep, strict validation.
const executeEnvelopeSchema = z.strictObject({
  requestId: z.unknown(),
  component: z.unknown(),
  artifactId: z.unknown().optional(),
  sha256: z.unknown().optional(),
  targetVersion: z.unknown(),
  expectedRevision: z.unknown(),
  compatibilityReceiptId: z.unknown().optional(),
  confirmation: confirmationSchema
})

const requestIdInputSchema = z.strictObject({ requestId: z.string().uuid() })
const recoveryEnvelopeSchema = z.strictObject({
  requestId: z.string().uuid().transform((value) => value.toLowerCase()),
  confirmation: z.literal(componentUpdateActivationRecoveryConfirmation)
})
const emptyInputSchema = z.strictObject({})

export interface ComponentUpdateActivationHttpService {
  preview(input: unknown): Promise<ComponentUpdateActivationPlan>
  execute(input: unknown): Promise<ComponentUpdateActivationReceipt>
  reconcile(): Promise<ComponentUpdateActivationReceipt | null>
  recoverInterrupted(requestId: unknown): Promise<ComponentUpdateActivationReceipt>
  getReceipt(requestId: unknown): Promise<ComponentUpdateActivationReceipt | null>
  getState(): Promise<ComponentUpdateStateSummary>
  previewCleanup(): Promise<ComponentUpdateCleanupPlan>
}

export type ComponentUpdateActivationRecoveryPhase =
  | 'pending'
  | 'reconciling'
  | 'ready'
  | 'recovery-required'
  | 'unavailable'

export interface ComponentUpdateActivationRecoveryStatus {
  schemaVersion: 1
  phase: ComponentUpdateActivationRecoveryPhase
  mutationBlocked: boolean
  recoveryRequired: boolean
  failureCode: string | null
  reconciledRequestId: string | null
}

export type ComponentUpdateMutationGate = (
  request: Readonly<UpdateActivationRequest>
) => boolean | Promise<boolean>

export type ComponentUpdateRecoveryMutationGate = (
  requestId: string
) => boolean | Promise<boolean>

export interface ComponentUpdateActivationHttpOptions {
  service: ComponentUpdateActivationHttpService
  /** Mutations are disabled unless an embedding application explicitly opts in. */
  mutationGate?: ComponentUpdateMutationGate
  /** Explicit recovery is independently fail-closed even when normal activation is enabled. */
  recoveryMutationGate?: ComponentUpdateRecoveryMutationGate
}

export interface ComponentUpdateActivationHttpSuccess<T> {
  ok: true
  data: T
}

export interface ComponentUpdateActivationHttpFailure {
  ok: false
  error: { code: string }
}

export interface ComponentUpdateActivationHttpResult<T> {
  statusCode: number
  body: ComponentUpdateActivationHttpSuccess<T> | ComponentUpdateActivationHttpFailure
}

/**
 * Fastify-independent HTTP contract for the existing activation transaction.
 * It deliberately owns no filesystem paths, commands, credentials, or update
 * transaction logic; an application may translate the returned result directly
 * into an HTTP status and JSON body.
 */
export class ComponentUpdateActivationHttpController {
  readonly #service: ComponentUpdateActivationHttpService
  readonly #mutationGate: ComponentUpdateMutationGate
  readonly #recoveryMutationGate: ComponentUpdateRecoveryMutationGate
  #initialization: Promise<void> | null = null
  #recovery: ComponentUpdateActivationRecoveryStatus = recoveryStatus('pending')

  constructor(options: ComponentUpdateActivationHttpOptions) {
    this.#service = options.service
    this.#mutationGate = options.mutationGate ?? (() => false)
    this.#recoveryMutationGate = options.recoveryMutationGate ?? (() => false)
  }

  /**
   * Runs exactly once before the embedding application becomes ready. Failures
   * are retained as a code-only read-only status so the rest of the control
   * plane can start without reopening update mutations in an uncertain state.
   */
  async initialize(): Promise<void> {
    if (this.#initialization === null) this.#initialization = this.#initializeOnce()
    await this.#initialization
  }

  async recoveryStatus(input: unknown): Promise<ComponentUpdateActivationHttpResult<ComponentUpdateActivationRecoveryStatus>> {
    try {
      emptyInputSchema.parse(input)
      await this.#refreshReadyState()
      return success(200, { ...this.#recovery })
    } catch (error) {
      return failureFrom(error)
    }
  }

  async preview(input: unknown): Promise<ComponentUpdateActivationHttpResult<ComponentUpdateActivationPlan>> {
    try {
      const request = parseActivationRequest(input)
      if (request.component === 'dsp') {
        // Delegate version validation to the core's read-only preview path, but
        // never advertise a downloadable/activatable DSP artifact.
        await this.#service.preview(request)
        throw new ActivationHttpFault(422, 'UPDATE_DSP_MANUAL_STEAM_REQUIRED')
      }
      return success(200, await this.#service.preview(request))
    } catch (error) {
      return failureFrom(error)
    }
  }

  async execute(input: unknown): Promise<ComponentUpdateActivationHttpResult<ComponentUpdateActivationReceipt>> {
    try {
      const { request, confirmation } = parseExecuteRequest(input)
      if (request.component === 'dsp') {
        await this.#service.preview(request)
        throw new ActivationHttpFault(422, 'UPDATE_DSP_MANUAL_STEAM_REQUIRED')
      }
      if (confirmation !== componentUpdateActivationConfirmations[request.component]) {
        throw new ActivationHttpFault(422, 'UPDATE_ACTIVATION_HTTP_CONFIRMATION_INVALID')
      }

      await this.initialize()
      await this.#refreshReadyState()
      if (this.#recovery.phase === 'pending' || this.#recovery.phase === 'reconciling') {
        throw new ActivationHttpFault(503, 'UPDATE_ACTIVATION_HTTP_RECOVERY_PENDING')
      }
      if (this.#recovery.phase === 'recovery-required') {
        throw new ActivationHttpFault(503, 'UPDATE_ACTIVATION_HTTP_RECOVERY_REQUIRED')
      }
      if (this.#recovery.phase !== 'ready') {
        throw new ActivationHttpFault(503, 'UPDATE_ACTIVATION_HTTP_RECOVERY_UNAVAILABLE')
      }

      let mutationAllowed: boolean
      try {
        mutationAllowed = await this.#mutationGate(request)
      } catch {
        throw new ActivationHttpFault(503, 'UPDATE_ACTIVATION_HTTP_GATE_UNAVAILABLE')
      }
      if (mutationAllowed !== true) {
        throw new ActivationHttpFault(423, 'UPDATE_ACTIVATION_HTTP_MUTATION_DISABLED')
      }

      const receipt = await this.#service.execute(request)
      if (receipt.status !== 'succeeded') {
        if (receipt.recoveryRequired || receipt.status === 'rollback-failed') {
          this.#recovery = recoveryStatus(
            'recovery-required',
            safeReceiptFailureCode(receipt),
            receipt.requestId
          )
        }
        return failure(
          receipt.status === 'rollback-failed' ? 503 : 409,
          safeReceiptFailureCode(receipt)
        )
      }
      // A first execution is represented as accepted; an idempotent replay has
      // already been accepted previously and therefore returns a normal 200.
      return success(receipt.reused ? 200 : 202, receipt)
    } catch (error) {
      return failureFrom(error)
    }
  }

  /**
   * Performs one exact, administrator-confirmed recovery. The browser supplies
   * only the durable request ID and a fixed confirmation; the core reconstructs
   * all paths, transaction identity, and desired terminal state from trusted
   * host evidence and the recovery broker binding.
   */
  async recover(input: unknown): Promise<ComponentUpdateActivationHttpResult<ComponentUpdateActivationReceipt>> {
    try {
      const { requestId } = recoveryEnvelopeSchema.parse(input)
      await this.initialize()
      if (this.#recovery.phase === 'pending' || this.#recovery.phase === 'reconciling') {
        throw new ActivationHttpFault(503, 'UPDATE_ACTIVATION_HTTP_RECOVERY_PENDING')
      }
      if (this.#recovery.phase !== 'recovery-required') {
        throw new ActivationHttpFault(
          this.#recovery.phase === 'ready' ? 409 : 503,
          this.#recovery.phase === 'ready'
            ? 'UPDATE_ACTIVATION_HTTP_RECOVERY_NOT_REQUIRED'
            : 'UPDATE_ACTIVATION_HTTP_RECOVERY_UNAVAILABLE'
        )
      }
      if (this.#recovery.reconciledRequestId !== null &&
          this.#recovery.reconciledRequestId !== requestId) {
        throw new ActivationHttpFault(409, 'UPDATE_RECOVERY_REQUEST_MISMATCH')
      }

      let mutationAllowed: boolean
      try {
        mutationAllowed = await this.#recoveryMutationGate(requestId)
      } catch {
        throw new ActivationHttpFault(503, 'UPDATE_ACTIVATION_HTTP_GATE_UNAVAILABLE')
      }
      if (mutationAllowed !== true) {
        throw new ActivationHttpFault(423, 'UPDATE_ACTIVATION_HTTP_MUTATION_DISABLED')
      }

      const receipt = await this.#service.recoverInterrupted(requestId)
      if (!isProvenRecoveryTerminalReceipt(receipt, requestId)) {
        const failureCode = receipt.recoveryRequired
          ? safeReceiptFailureCode(receipt)
          : 'UPDATE_RECOVERY_TERMINAL_UNPROVEN'
        this.#recovery = recoveryStatus(
          'recovery-required',
          failureCode,
          requestId
        )
        return failure(503, failureCode)
      }
      const [persistedReceipt, state] = await Promise.all([
        this.#service.getReceipt(requestId),
        this.#service.getState()
      ])
      if (persistedReceipt === null ||
          !samePersistedTerminalReceipt(receipt, persistedReceipt) ||
          !stateProvesRecoveryTerminal(state, receipt)) {
        this.#recovery = recoveryStatus(
          'recovery-required',
          'UPDATE_RECOVERY_TERMINAL_UNPROVEN',
          requestId
        )
        return failure(503, 'UPDATE_RECOVERY_TERMINAL_UNPROVEN')
      }
      this.#recovery = recoveryStatus('ready', null, requestId)
      return success(receipt.reused ? 200 : 202, receipt)
    } catch (error) {
      const result = failureFrom(error)
      if (result.statusCode >= 500 && this.#recovery.phase === 'recovery-required') {
        const code = result.body.ok ? null : result.body.error.code
        this.#recovery = recoveryStatus('recovery-required', code, this.#recovery.reconciledRequestId)
      }
      return result
    }
  }

  async getReceipt(input: unknown): Promise<ComponentUpdateActivationHttpResult<ComponentUpdateActivationReceipt>> {
    try {
      const { requestId } = requestIdInputSchema.parse(input)
      const receipt = await this.#service.getReceipt(requestId)
      if (receipt === null) throw new ActivationHttpFault(404, 'UPDATE_ACTIVATION_RECEIPT_NOT_FOUND')
      return success(200, receipt)
    } catch (error) {
      return failureFrom(error)
    }
  }

  /** Returns only the core's bounded state/history summary, never raw history files. */
  async history(input: unknown): Promise<ComponentUpdateActivationHttpResult<ComponentUpdateStateSummary>> {
    try {
      emptyInputSchema.parse(input)
      return success(200, await this.#service.getState())
    } catch (error) {
      return failureFrom(error)
    }
  }

  async previewCleanup(input: unknown): Promise<ComponentUpdateActivationHttpResult<ComponentUpdateCleanupPlan>> {
    try {
      emptyInputSchema.parse(input)
      return success(200, await this.#service.previewCleanup())
    } catch (error) {
      return failureFrom(error)
    }
  }

  async #initializeOnce(): Promise<void> {
    this.#recovery = recoveryStatus('reconciling')
    try {
      const receipt = await this.#service.reconcile()
      const state = await this.#service.getState()
      this.#recovery = receipt?.recoveryRequired === true || state.recoveryRequired
        ? recoveryStatus('recovery-required', 'UPDATE_RECOVERY_REQUIRED', receipt?.requestId ?? null)
        : recoveryStatus('ready', null, receipt?.requestId ?? null)
    } catch (error) {
      const failureCode = safeRecoveryFailureCode(error)
      this.#recovery = recoveryFailureRequiresOperator(error, failureCode)
        ? recoveryStatus('recovery-required', failureCode)
        : recoveryStatus('unavailable', failureCode)
    }
  }

  async #refreshReadyState(): Promise<void> {
    if (this.#recovery.phase !== 'ready') return
    try {
      const state = await this.#service.getState()
      if (state.recoveryRequired) {
        this.#recovery = recoveryStatus(
          'recovery-required',
          'UPDATE_RECOVERY_REQUIRED',
          this.#recovery.reconciledRequestId
        )
      }
    } catch (error) {
      this.#recovery = recoveryStatus(
        'unavailable',
        safeRecoveryFailureCode(error),
        this.#recovery.reconciledRequestId
      )
    }
  }
}

function recoveryStatus(
  phase: ComponentUpdateActivationRecoveryPhase,
  failureCode: string | null = null,
  reconciledRequestId: string | null = null
): ComponentUpdateActivationRecoveryStatus {
  return {
    schemaVersion: 1,
    phase,
    mutationBlocked: phase !== 'ready',
    recoveryRequired: phase === 'recovery-required',
    failureCode,
    reconciledRequestId
  }
}

function safeRecoveryFailureCode(error: unknown): string {
  if (error instanceof ComponentUpdateActivationError || error instanceof UpdatePipelineError) {
    if (/^UPDATE_[A-Z0-9_]{1,96}$/.test(error.code)) {
      const mapped = mapCoreFailure(error.code)
      if (!mapped.body.ok && mapped.body.error.code !== 'UPDATE_ACTIVATION_HTTP_UNAVAILABLE') return error.code
    }
  }
  return 'UPDATE_ACTIVATION_HTTP_RECOVERY_UNAVAILABLE'
}

function recoveryFailureRequiresOperator(error: unknown, code: string): boolean {
  if (error instanceof ComponentUpdateActivationError && error.receipt?.recoveryRequired === true) return true
  return code === 'UPDATE_RECOVERY_REQUIRED' ||
    code === 'UPDATE_HOST_LEASE_DIRTY' ||
    code === 'UPDATE_HOST_LEASE_LOST' ||
    code === 'UPDATE_HOST_LEASE_RECOVERY_REQUIRED' ||
    code === 'UPDATE_RECONCILIATION_AMBIGUOUS' ||
    code === 'UPDATE_RECONCILIATION_UNCERTAIN' ||
    code === 'UPDATE_INTERRUPTED'
}

function parseActivationRequest(input: unknown): UpdateActivationRequest {
  try {
    const request = componentUpdateActivationRequestSchema.parse(input)
    const versionComponent: VersionComponent = request.component === 'dsp'
      ? 'dsp'
      : request.component === 'nebula'
        ? 'nebula'
        : request.component === 'bepinex'
          ? 'bepinex'
          : 'plugin'
    return {
      ...request,
      targetVersion: normalizeVersion(request.targetVersion, versionComponent),
      sha256: typeof request.sha256 === 'string' ? request.sha256.toLowerCase() : request.sha256
    }
  } catch {
    throw new ActivationHttpFault(422, 'UPDATE_ACTIVATION_HTTP_REQUEST_INVALID')
  }
}

function parseExecuteRequest(input: unknown): {
  request: UpdateActivationRequest
  confirmation: z.infer<typeof confirmationSchema>
} {
  let envelope: z.infer<typeof executeEnvelopeSchema>
  try {
    envelope = executeEnvelopeSchema.parse(input)
  } catch {
    throw new ActivationHttpFault(422, 'UPDATE_ACTIVATION_HTTP_REQUEST_INVALID')
  }
  const { confirmation, ...requestInput } = envelope
  return { request: parseActivationRequest(requestInput), confirmation }
}

function success<T>(statusCode: number, data: T): ComponentUpdateActivationHttpResult<T> {
  return { statusCode, body: { ok: true, data } }
}

function failure<T = never>(statusCode: number, code: string): ComponentUpdateActivationHttpResult<T> {
  return { statusCode, body: { ok: false, error: { code } } }
}

function failureFrom(error: unknown): ComponentUpdateActivationHttpResult<never> {
  if (error instanceof ActivationHttpFault) return failure(error.statusCode, error.code)
  if (error instanceof z.ZodError) return failure(422, 'UPDATE_ACTIVATION_HTTP_REQUEST_INVALID')
  if (error instanceof ComponentUpdateActivationError || error instanceof UpdatePipelineError) {
    return mapCoreFailure(error.code)
  }
  return failure(503, 'UPDATE_ACTIVATION_HTTP_UNAVAILABLE')
}

function mapCoreFailure(code: string): ComponentUpdateActivationHttpResult<never> {
  if (conflictCodes.has(code)) return failure(409, code)
  if (lockedCodes.has(code)) return failure(423, code)
  if (unprocessableCodes.has(code)) return failure(422, code)
  if (unavailableCodes.has(code)) return failure(503, code)
  return failure(503, 'UPDATE_ACTIVATION_HTTP_UNAVAILABLE')
}

function safeReceiptFailureCode(receipt: ComponentUpdateActivationReceipt): string {
  const code = receipt.failureCode
  if (code === null || !/^UPDATE_[A-Z0-9_]{1,96}$/.test(code)) return 'UPDATE_ACTIVATION_FAILED'
  const mapped = mapCoreFailure(code)
  return mapped.body.ok ? 'UPDATE_ACTIVATION_FAILED' : mapped.body.error.code
}

function isProvenRecoveryTerminalReceipt(
  receipt: ComponentUpdateActivationReceipt,
  requestId: string
): boolean {
  if (receipt.requestId !== requestId || receipt.recoveryRequired) return false
  if (receipt.status === 'succeeded') {
    return receipt.failureCode === null && receipt.rollbackBindingSha256 !== null
  }
  return receipt.status === 'rolled-back' && receipt.rollbackVerified && receipt.failureCode !== null &&
    receipt.rollbackBindingSha256 !== null &&
    Object.values(receipt.rollbackSteps).every((status) => status === 'verified')
}

function samePersistedTerminalReceipt(
  recovered: ComponentUpdateActivationReceipt,
  persisted: ComponentUpdateActivationReceipt
): boolean {
  return persisted.reused === false &&
    recovered.format === persisted.format &&
    recovered.schemaVersion === persisted.schemaVersion &&
    recovered.requestId === persisted.requestId &&
    recovered.component === persisted.component &&
    recovered.artifactId === persisted.artifactId &&
    recovered.compatibilityReceiptId === persisted.compatibilityReceiptId &&
    recovered.targetVersion === persisted.targetVersion &&
    recovered.releaseId === persisted.releaseId &&
    recovered.status === persisted.status &&
    recovered.previousRevision === persisted.previousRevision &&
    recovered.resultingRevision === persisted.resultingRevision &&
    recovered.protectionBackupId === persisted.protectionBackupId &&
    recovered.rollbackBindingSha256 === persisted.rollbackBindingSha256 &&
    JSON.stringify(recovered.rollbackSteps) === JSON.stringify(persisted.rollbackSteps) &&
    recovered.failureCode === persisted.failureCode &&
    recovered.rollbackVerified === persisted.rollbackVerified &&
    recovered.recoveryRequired === persisted.recoveryRequired &&
    recovered.fileCount === persisted.fileCount &&
    recovered.expandedBytes === persisted.expandedBytes &&
    recovered.completedAt === persisted.completedAt
}

function stateProvesRecoveryTerminal(
  state: ComponentUpdateStateSummary,
  receipt: ComponentUpdateActivationReceipt
): boolean {
  if (state.recoveryRequired || state.revision !== receipt.resultingRevision) return false
  if (receipt.status === 'rolled-back') return true
  const active = state.components.find((entry) => entry.component === receipt.component)
  return active?.version === receipt.targetVersion &&
    active.artifactId === receipt.artifactId &&
    active.releaseId === receipt.releaseId
}

const conflictCodes = new Set([
  'UPDATE_PREVIOUS_COMPONENT_VERSION_MISMATCH',
  'UPDATE_ARCHIVE_CHANGED',
  'UPDATE_COMPATIBILITY_CONFLICT',
  'UPDATE_COMPATIBILITY_CANDIDATE_MISMATCH',
  'UPDATE_COMPATIBILITY_INVENTORY_DRIFT',
  'UPDATE_COMPATIBILITY_POLICY_DRIFT',
  'UPDATE_COMPATIBILITY_RECEIPT_EXPIRED',
  'UPDATE_COMPATIBILITY_RECEIPT_NOT_FOUND',
  'UPDATE_HISTORY_CONFLICT',
  'UPDATE_HISTORY_LIMIT_REACHED',
  'UPDATE_IDEMPOTENCY_CONFLICT',
  'UPDATE_INTERRUPTED',
  'UPDATE_INVENTORY_DRIFT',
  'UPDATE_JOURNAL_CONFLICT',
  'UPDATE_HOST_LEASE_RECOVERY_MISMATCH',
  'UPDATE_HOST_LEASE_RECOVERY_NOT_REQUIRED',
  'UPDATE_RECONCILIATION_AMBIGUOUS',
  'UPDATE_RECONCILIATION_UNCERTAIN',
  'UPDATE_RECOVERY_NOT_PENDING',
  'UPDATE_RECOVERY_REQUEST_MISMATCH',
  'UPDATE_RECOVERY_REQUIRED',
  'UPDATE_REVISION_CONFLICT',
  'UPDATE_STAGED_ARTIFACT_CHANGED',
  'UPDATE_STAGED_ARTIFACT_UNSTABLE'
])

const lockedCodes = new Set([
  'UPDATE_ACTIVATION_LOCK_BUSY',
  'UPDATE_HOST_LEASE_BUSY',
  'UPDATE_SERVICE_STILL_RUNNING'
])

const unprocessableCodes = new Set([
  'UPDATE_ARCHIVE_CONTENT_MISMATCH',
  'UPDATE_ARCHIVE_CRC_MISMATCH',
  'UPDATE_ARCHIVE_DUPLICATE_FILE',
  'UPDATE_ARCHIVE_EXPANDED_TOO_LARGE',
  'UPDATE_ARCHIVE_EXPANSION_INVALID',
  'UPDATE_ARCHIVE_EXTRACTION_FAILED',
  'UPDATE_ARCHIVE_FILE_COUNT_INVALID',
  'UPDATE_ARCHIVE_FILE_TOO_LARGE',
  'UPDATE_ARCHIVE_FILE_TYPE_FORBIDDEN',
  'UPDATE_ARCHIVE_FILENAME_ENCODING_INVALID',
  'UPDATE_ARCHIVE_IDENTITY_MISMATCH',
  'UPDATE_ARCHIVE_LINK_FORBIDDEN',
  'UPDATE_ARCHIVE_MANIFEST_INVALID',
  'UPDATE_ARCHIVE_MANIFEST_MISSING',
  'UPDATE_ARCHIVE_MANIFEST_TOO_LARGE',
  'UPDATE_ARCHIVE_NOT_REGULAR_FILE',
  'UPDATE_ARCHIVE_PATH_ESCAPE',
  'UPDATE_ARCHIVE_PATH_INVALID',
  'UPDATE_ARCHIVE_SIZE_INVALID',
  'UPDATE_ARCHIVE_SIZE_MISMATCH',
  'UPDATE_ARCHIVE_UNDECLARED_FILE',
  'UPDATE_ARCHIVE_ZIP_INVALID',
  'UPDATE_ARCHIVE_ZIP_UNSUPPORTED',
  'UPDATE_COMPATIBILITY_EVIDENCE_INVALID',
  'UPDATE_COMPATIBILITY_CANDIDATE_INVALID',
  'UPDATE_DIRECTORY_INVALID',
  'UPDATE_DSP_MANUAL_STEAM_REQUIRED',
  'UPDATE_MANAGED_NAME_INVALID',
  'UPDATE_PATH_ESCAPE',
  'UPDATE_RELEASE_CONTENT_MISMATCH',
  'UPDATE_RELEASE_FILE_INVALID',
  'UPDATE_RELEASE_FILE_MISSING',
  'UPDATE_RELEASE_FILE_TOO_LARGE',
  'UPDATE_RELEASE_IDENTITY_MISMATCH',
  'UPDATE_RELEASE_INVALID',
  'UPDATE_RELEASE_LINK_FORBIDDEN',
  'UPDATE_RELEASE_MANIFEST_INVALID',
  'UPDATE_RELEASE_RECORD_INVALID',
  'UPDATE_RELEASE_RECORD_MISSING',
  'UPDATE_RELEASE_TOO_LARGE',
  'UPDATE_RELEASE_UNDECLARED_FILE',
  'UPDATE_REQUEST_INVALID',
  'UPDATE_STAGED_ARTIFACT_INVALID',
  'UPDATE_STAGED_ARTIFACT_MISSING',
  'UPDATE_STAGED_ARTIFACT_TAMPERED',
  'UPDATE_STAGED_ARTIFACT_TOO_LARGE',
  'UPDATE_STAGED_IDENTITY_MISMATCH',
  'UPDATE_STAGED_MANIFEST_INVALID',
  'UPDATE_STAGED_MANIFEST_MISSING'
])

const unavailableCodes = new Set([
  'UPDATE_ACTIVATION_FAILED',
  'UPDATE_ACTIVATION_LOCK_FAILED',
  'UPDATE_ACTIVATION_LOCK_INVALID',
  'UPDATE_ACTIVE_STATE_INVALID',
  'UPDATE_ACTIVE_SWITCH_FAILED',
  'UPDATE_ARCHIVE_LIMITS_INVALID',
  'UPDATE_ARCHIVE_UNAVAILABLE',
  'UPDATE_FAILED',
  'UPDATE_HISTORY_DIRECTORY_INVALID',
  'UPDATE_HISTORY_INVALID',
  'UPDATE_HISTORY_LIMIT_INVALID',
  'UPDATE_HISTORY_MISSING',
  'UPDATE_HOST_LEASE_DIRTY',
  'UPDATE_HOST_LEASE_LOST',
  'UPDATE_HOST_LEASE_RECOVERY_REQUIRED',
  'UPDATE_HOST_LEASE_UNAVAILABLE',
  'UPDATE_JOURNAL_DIRECTORY_INVALID',
  'UPDATE_JOURNAL_INVALID',
  'UPDATE_LIMITS_INVALID',
  'UPDATE_COMPATIBILITY_INVENTORY_UNAVAILABLE',
  'UPDATE_COMPATIBILITY_POLICY_UNAVAILABLE',
  'UPDATE_COMPATIBILITY_RECEIPT_INVALID',
  'UPDATE_COMPATIBILITY_ROOT_INVALID',
  'UPDATE_COMPATIBILITY_ROOT_UNAVAILABLE',
  'UPDATE_PERSISTED_FILE_INVALID',
  'UPDATE_PERSISTENCE_FAILED',
  'UPDATE_RECOVERY_EVIDENCE_CHANGED',
  'UPDATE_RECOVERY_EVIDENCE_INVALID',
  'UPDATE_RECOVERY_TERMINAL_UNPROVEN',
  'UPDATE_RECEIPT_INVALID',
  'UPDATE_RELEASE_ASSEMBLY_FAILED',
  'UPDATE_RELEASE_DIRECTORY_INVALID',
  'UPDATE_ROLLBACK_SMOKE_FAILED',
  'UPDATE_ROLLBACK_STOP_UNPROVEN',
  'UPDATE_ROLLBACK_SWITCH_FAILED',
  'UPDATE_ROOT_COLLISION',
  'UPDATE_ROOT_INVALID',
  'UPDATE_ROOT_NOT_ABSOLUTE',
  'UPDATE_ROOT_REPARSE_FORBIDDEN',
  'UPDATE_ROOT_UNAVAILABLE',
  'UPDATE_SAVE_PROTECTION_FAILED',
  'UPDATE_SAVE_PROTECTION_MISMATCH',
  'UPDATE_SMOKE_FAILED',
  'UPDATE_SMOKE_INVALID',
  'UPDATE_SMOKE_UNHEALTHY',
  'UPDATE_STATE_REVISION_INVALID',
  'UPDATE_STOP_PROOF_INVALID'
])

class ActivationHttpFault extends Error {
  readonly statusCode: number
  readonly code: string

  constructor(statusCode: number, code: string) {
    super(code)
    this.name = 'ActivationHttpFault'
    this.statusCode = statusCode
    this.code = code
  }
}

import { z } from 'zod'
import {
  SteamManualHandoffError,
  steamManualHandoffRequestSchema,
  type SteamManualHandoffPlan,
  type SteamManualHandoffReceipt,
  type SteamManualHandoffRequest,
  type SteamManualHandoffState
} from './steam-manual-handoff.js'

export const steamManualHandoffConfirmations = Object.freeze({
  begin: 'BEGIN_STEAM_CLIENT_UPDATE_HANDOFF',
  complete: 'CONFIRM_STEAM_CLIENT_UPDATE_COMPLETED'
} as const)

const requestIdSchema = z.string().uuid().transform((value) => value.toLowerCase())
const emptyInputSchema = z.strictObject({})
const beginEnvelopeSchema = z.strictObject({
  requestId: z.unknown(),
  targetVersion: z.unknown(),
  expectedRevision: z.unknown(),
  confirmation: z.unknown()
})
const confirmationEnvelopeSchema = z.strictObject({
  requestId: z.unknown(),
  confirmation: z.unknown()
})
const receiptInputSchema = z.strictObject({ requestId: requestIdSchema })

export interface SteamManualHandoffHttpService {
  preview(input: unknown): Promise<SteamManualHandoffPlan>
  begin(input: unknown): Promise<SteamManualHandoffReceipt>
  confirm(requestId: unknown): Promise<SteamManualHandoffReceipt>
  reconcile(): Promise<SteamManualHandoffReceipt | null>
  getReceipt(requestId: unknown): Promise<SteamManualHandoffReceipt | null>
  getState(): Promise<SteamManualHandoffState>
}

export type SteamManualHandoffHttpAction = 'begin' | 'confirm'

export type SteamManualHandoffMutationGate = (
  action: SteamManualHandoffHttpAction,
  context: Readonly<SteamManualHandoffRequest> | Readonly<{ requestId: string }>
) => boolean | Promise<boolean>

export type SteamManualHandoffRecoveryPhase =
  | 'pending'
  | 'reconciling'
  | 'ready'
  | 'awaiting-steam-client-update'
  | 'recovery-required'
  | 'unavailable'

export interface SteamManualHandoffRecoveryStatus {
  schemaVersion: 1
  phase: SteamManualHandoffRecoveryPhase
  mutationBlocked: boolean
  recoveryRequired: boolean
  activeRequestId: string | null
  failureCode: string | null
}

export interface SteamManualHandoffHttpOptions {
  service: SteamManualHandoffHttpService
  /** Both mutations remain disabled until the embedding application opts in. */
  mutationGate?: SteamManualHandoffMutationGate
}

export interface SteamManualHandoffHttpSuccess<T> {
  ok: true
  data: T
}

export interface SteamManualHandoffHttpFailure {
  ok: false
  error: { code: string }
}

export interface SteamManualHandoffHttpResult<T> {
  statusCode: number
  body: SteamManualHandoffHttpSuccess<T> | SteamManualHandoffHttpFailure
}

/**
 * Fastify-independent boundary for the durable Steam-client handoff. It accepts
 * no Steam account, credential, executable path, or command field: the browser
 * can only preview, begin with a fixed phrase, or confirm completion with a
 * different fixed phrase after the official client has been operated manually.
 */
export class SteamManualHandoffHttpController {
  readonly #service: SteamManualHandoffHttpService
  readonly #mutationGate: SteamManualHandoffMutationGate
  #initialization: Promise<void> | null = null
  #recovery: SteamManualHandoffRecoveryStatus = recoveryStatus('pending')

  constructor(options: SteamManualHandoffHttpOptions) {
    this.#service = options.service
    this.#mutationGate = options.mutationGate ?? (() => false)
  }

  async initialize(): Promise<void> {
    if (this.#initialization === null) this.#initialization = this.#initializeOnce()
    await this.#initialization
  }

  async recoveryStatus(input: unknown): Promise<SteamManualHandoffHttpResult<SteamManualHandoffRecoveryStatus>> {
    try {
      emptyInputSchema.parse(input)
      await this.#refreshStatus()
      return success(200, { ...this.#recovery })
    } catch (error) {
      return failureFrom(error)
    }
  }

  async preview(input: unknown): Promise<SteamManualHandoffHttpResult<SteamManualHandoffPlan>> {
    try {
      const request = steamManualHandoffRequestSchema.parse(input)
      return success(200, await this.#service.preview(request))
    } catch (error) {
      return failureFrom(error)
    }
  }

  async begin(input: unknown): Promise<SteamManualHandoffHttpResult<SteamManualHandoffReceipt>> {
    try {
      const envelope = beginEnvelopeSchema.parse(input)
      if (envelope.confirmation !== steamManualHandoffConfirmations.begin) {
        throw new SteamManualHandoffHttpFault(422, 'DSP_STEAM_HANDOFF_HTTP_CONFIRMATION_INVALID')
      }
      const { confirmation: _confirmation, ...requestInput } = envelope
      const request = steamManualHandoffRequestSchema.parse(requestInput)
      await this.initialize()
      await this.#refreshStatus()
      assertBeginReady(this.#recovery)
      await this.#assertGate('begin', request)
      const receipt = await this.#service.begin(request)
      this.#adoptReceipt(receipt)
      if (receipt.phase !== 'awaiting-steam-client-update') {
        return failure(503, safeFailureCode(receipt, 'DSP_STEAM_HANDOFF_PREPARATION_FAILED'))
      }
      return success(receipt.reused ? 200 : 202, receipt)
    } catch (error) {
      return failureFrom(error)
    }
  }

  async confirm(input: unknown): Promise<SteamManualHandoffHttpResult<SteamManualHandoffReceipt>> {
    try {
      const envelope = confirmationEnvelopeSchema.parse(input)
      if (envelope.confirmation !== steamManualHandoffConfirmations.complete) {
        throw new SteamManualHandoffHttpFault(422, 'DSP_STEAM_HANDOFF_HTTP_CONFIRMATION_INVALID')
      }
      const requestId = requestIdSchema.parse(envelope.requestId)
      await this.initialize()
      await this.#refreshStatus()
      assertConfirmReady(this.#recovery, requestId)
      await this.#assertGate('confirm', { requestId })
      const receipt = await this.#service.confirm(requestId)
      this.#adoptReceipt(receipt)
      if (receipt.phase !== 'succeeded') {
        return failure(503, safeFailureCode(receipt, 'DSP_STEAM_HANDOFF_RECOVERY_REQUIRED'))
      }
      return success(receipt.reused ? 200 : 202, receipt)
    } catch (error) {
      const result = failureFrom<SteamManualHandoffReceipt>(error)
      if (result.statusCode >= 500) {
        const receipt = error instanceof SteamManualHandoffError ? error.receipt : null
        if (receipt !== null) this.#adoptReceipt(receipt)
      }
      return result
    }
  }

  async getReceipt(input: unknown): Promise<SteamManualHandoffHttpResult<SteamManualHandoffReceipt>> {
    try {
      const { requestId } = receiptInputSchema.parse(input)
      const receipt = await this.#service.getReceipt(requestId)
      if (receipt === null) throw new SteamManualHandoffHttpFault(404, 'DSP_STEAM_HANDOFF_RECEIPT_NOT_FOUND')
      return success(200, receipt)
    } catch (error) {
      return failureFrom(error)
    }
  }

  async state(input: unknown): Promise<SteamManualHandoffHttpResult<SteamManualHandoffState>> {
    try {
      emptyInputSchema.parse(input)
      await this.initialize()
      const state = await this.#service.getState()
      this.#recovery = statusFromState(state)
      return success(200, state)
    } catch (error) {
      return failureFrom(error)
    }
  }

  async #initializeOnce(): Promise<void> {
    this.#recovery = recoveryStatus('reconciling')
    try {
      const receipt = await this.#service.reconcile()
      const state = await this.#service.getState()
      this.#recovery = statusFromState(state, receipt)
    } catch (error) {
      this.#recovery = recoveryStatus(
        'unavailable',
        null,
        safeErrorCode(error, 'DSP_STEAM_HANDOFF_RECONCILIATION_UNAVAILABLE')
      )
    }
  }

  async #refreshStatus(): Promise<void> {
    await this.initialize()
    if (this.#recovery.phase === 'unavailable') return
    try {
      this.#recovery = statusFromState(await this.#service.getState())
    } catch (error) {
      this.#recovery = recoveryStatus(
        'unavailable',
        this.#recovery.activeRequestId,
        safeErrorCode(error, 'DSP_STEAM_HANDOFF_STATE_UNAVAILABLE')
      )
    }
  }

  async #assertGate(
    action: SteamManualHandoffHttpAction,
    context: Readonly<SteamManualHandoffRequest> | Readonly<{ requestId: string }>
  ): Promise<void> {
    let allowed: boolean
    try {
      allowed = await this.#mutationGate(action, context)
    } catch {
      throw new SteamManualHandoffHttpFault(503, 'DSP_STEAM_HANDOFF_HTTP_GATE_UNAVAILABLE')
    }
    if (allowed !== true) {
      throw new SteamManualHandoffHttpFault(423, 'DSP_STEAM_HANDOFF_HTTP_MUTATION_DISABLED')
    }
  }

  #adoptReceipt(receipt: SteamManualHandoffReceipt): void {
    if (receipt.recoveryRequired || receipt.phase === 'recovery-required') {
      this.#recovery = recoveryStatus('recovery-required', receipt.requestId, safeFailureCode(receipt))
    } else if (receipt.phase === 'awaiting-steam-client-update') {
      this.#recovery = recoveryStatus('awaiting-steam-client-update', receipt.requestId, receipt.failureCode)
    } else if (receipt.phase === 'succeeded') {
      this.#recovery = recoveryStatus('ready')
    }
  }
}

function assertBeginReady(status: SteamManualHandoffRecoveryStatus): void {
  if (status.phase === 'ready') return
  if (status.phase === 'awaiting-steam-client-update') {
    throw new SteamManualHandoffHttpFault(409, 'DSP_STEAM_HANDOFF_ALREADY_ACTIVE')
  }
  if (status.phase === 'recovery-required') {
    throw new SteamManualHandoffHttpFault(503, 'DSP_STEAM_HANDOFF_RECOVERY_REQUIRED')
  }
  throw new SteamManualHandoffHttpFault(503, 'DSP_STEAM_HANDOFF_RECONCILIATION_UNAVAILABLE')
}

function assertConfirmReady(status: SteamManualHandoffRecoveryStatus, requestId: string): void {
  if (status.phase === 'awaiting-steam-client-update' && status.activeRequestId === requestId) return
  if (status.phase === 'awaiting-steam-client-update') {
    throw new SteamManualHandoffHttpFault(409, 'DSP_STEAM_HANDOFF_REQUEST_MISMATCH')
  }
  if (status.phase === 'recovery-required') {
    throw new SteamManualHandoffHttpFault(503, 'DSP_STEAM_HANDOFF_RECOVERY_REQUIRED')
  }
  if (status.phase === 'ready') {
    throw new SteamManualHandoffHttpFault(409, 'DSP_STEAM_HANDOFF_NOT_AWAITING_CONFIRMATION')
  }
  throw new SteamManualHandoffHttpFault(503, 'DSP_STEAM_HANDOFF_RECONCILIATION_UNAVAILABLE')
}

function statusFromState(
  state: SteamManualHandoffState,
  reconciled: SteamManualHandoffReceipt | null = state.current
): SteamManualHandoffRecoveryStatus {
  const current = state.current ?? reconciled
  if (state.recoveryRequired || current?.recoveryRequired === true || current?.phase === 'recovery-required') {
    return recoveryStatus(
      'recovery-required',
      state.activeRequestId ?? current?.requestId ?? null,
      current?.failureCode ?? 'DSP_STEAM_HANDOFF_RECOVERY_REQUIRED'
    )
  }
  if (current?.phase === 'awaiting-steam-client-update') {
    return recoveryStatus('awaiting-steam-client-update', current.requestId, current.failureCode)
  }
  return recoveryStatus('ready')
}

function recoveryStatus(
  phase: SteamManualHandoffRecoveryPhase,
  activeRequestId: string | null = null,
  failureCode: string | null = null
): SteamManualHandoffRecoveryStatus {
  return {
    schemaVersion: 1,
    phase,
    mutationBlocked: phase !== 'ready' && phase !== 'awaiting-steam-client-update',
    recoveryRequired: phase === 'recovery-required',
    activeRequestId,
    failureCode
  }
}

function safeFailureCode(
  receipt: SteamManualHandoffReceipt,
  fallback = 'DSP_STEAM_HANDOFF_RECOVERY_REQUIRED'
): string {
  return receipt.failureCode?.match(/^DSP_STEAM_HANDOFF_[A-Z0-9_]{1,72}$/)?.[0] ?? fallback
}

function safeErrorCode(error: unknown, fallback: string): string {
  if (error instanceof SteamManualHandoffError && /^DSP_STEAM_HANDOFF_[A-Z0-9_]{1,72}$/.test(error.code)) {
    return error.code
  }
  return fallback
}

function success<T>(statusCode: number, data: T): SteamManualHandoffHttpResult<T> {
  return { statusCode, body: { ok: true, data } }
}

function failure<T>(statusCode: number, code: string): SteamManualHandoffHttpResult<T> {
  return { statusCode, body: { ok: false, error: { code } } }
}

function failureFrom<T>(error: unknown): SteamManualHandoffHttpResult<T> {
  if (error instanceof SteamManualHandoffHttpFault) return failure(error.statusCode, error.code)
  if (error instanceof z.ZodError) return failure(400, 'DSP_STEAM_HANDOFF_HTTP_INPUT_INVALID')
  if (error instanceof SteamManualHandoffError) {
    const code = safeErrorCode(error, 'DSP_STEAM_HANDOFF_FAILED')
    if (code === 'DSP_STEAM_HANDOFF_REVISION_CONFLICT' ||
        code === 'DSP_STEAM_HANDOFF_PHASE_CONFLICT' ||
        code === 'DSP_STEAM_HANDOFF_IDEMPOTENCY_CONFLICT' ||
        code === 'DSP_STEAM_HANDOFF_VERSION_MISMATCH' ||
        code === 'DSP_STEAM_HANDOFF_COMPATIBILITY_CONFLICT') {
      return failure(409, code)
    }
    if (code === 'DSP_STEAM_HANDOFF_RECEIPT_NOT_FOUND') return failure(404, code)
    return failure(503, code)
  }
  return failure(500, 'DSP_STEAM_HANDOFF_HTTP_INTERNAL')
}

class SteamManualHandoffHttpFault extends Error {
  readonly statusCode: number
  readonly code: string

  constructor(statusCode: number, code: string) {
    super(code)
    this.name = 'SteamManualHandoffHttpFault'
    this.statusCode = statusCode
    this.code = code
  }
}

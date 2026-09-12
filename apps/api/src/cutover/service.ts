import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { HostMutationLeaseError } from '../host-mutation/lease.js'
import {
  HostMutationOperationCoordinatorError,
  hostMutationReturn,
  hostMutationThrow,
  type HostMutationOperationCoordinator,
  type HostMutationRecoveryOperationCoordinator,
  type HostMutationOperationScope
} from '../host-mutation/operation-coordinator.js'
import {
  ACTIVATE_GSMANAGER_TO_DYSON,
  PREPARE_GSMANAGER_TO_DYSON,
  ROLLBACK_DYSON_TO_GSMANAGER,
  CutoverError,
  type CutoverAuditReceiptLookupRequest,
  type CutoverAuditReceiptResolution,
  type CutoverActivateRequest,
  type CutoverAuthorityMutationInvocation,
  type CutoverAuthorityMutationMethod,
  type CutoverAuthorityMutationResult,
  type CutoverAuthority,
  type CutoverDesiredAuthority,
  type CutoverDurableStore,
  type CutoverErrorCode,
  type CutoverHostAdapter,
  type CutoverHostEvidence,
  type CutoverJournal,
  type CutoverJournalPhase,
  type CutoverOperation,
  type CutoverPrepareRequest,
  type CutoverPreviewReceipt,
  type CutoverPreviewRequest,
  type CutoverPublicPhase,
  type CutoverPublicStatus,
  type CutoverPublicSummary,
  type CutoverReceipt,
  type CutoverRecoveryRequest,
  type CutoverRecoveryStatus,
  type CutoverRollbackMode,
  type CutoverRollbackRequest,
  type CutoverServiceOptions,
  type CutoverStoredReceipt,
  type CutoverStoredState
} from './types.js'

const requestIdSchema = z.string().uuid().transform((value) => value.toLowerCase())
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
const operationSchema = z.enum(['prepare', 'activate', 'rollback-immediate', 'rollback-later'])
const authoritySchema = z.enum(['previous', 'candidate'])
const rollbackModeSchema = z.enum(['immediate-compensation', 'later-operator-rollback'])
const previewOperationSchema = z.enum(['prepare', 'activate', 'rollback'])
const phaseSchema = z.enum([
  'prepared',
  'candidate-definition-intent',
  'candidate-defined-disabled',
  'save-protection-intent',
  'save-protected',
  'baseline-restore-intent',
  'baseline-restored',
  'disable-source-intent',
  'source-disabled',
  'stop-source-intent',
  'source-stopped',
  'launch-target-intent',
  'target-enabled',
  'target-start-intent',
  'target-started',
  'recovery-intent',
  'recovery-converging',
  'terminal'
])
const authorityMutationSchema = z.strictObject({
  phase: z.enum(['not-started', 'intent-persisted', 'receipt-persisted']),
  method: z.enum(['defineCandidateDisabled', 'enableCandidateAuthority', 'disableCandidateAuthority']),
  mode: z.enum(['PrepareDisabled', 'Activate']),
  childRequestId: requestIdSchema.nullable(),
  attempt: z.number().int().min(0).max(64),
  state: z.enum(['idle', 'pending', 'succeeded', 'rolled-back', 'recovery-required']),
  receiptDigest: sha256Schema.nullable()
}).superRefine((transaction, context) => {
  if (transaction.mode !== authorityMutationModeForMethod(transaction.method)) {
    context.addIssue({ code: 'custom', message: 'authority-mutation-mode' })
  }
  const idle = transaction.phase === 'not-started' && transaction.childRequestId === null &&
    transaction.attempt === 0 && transaction.state === 'idle' && transaction.receiptDigest === null
  const pending = transaction.phase === 'intent-persisted' &&
    transaction.childRequestId !== null && transaction.attempt > 0 &&
    transaction.state === 'pending' && transaction.receiptDigest === null
  const terminal = transaction.phase === 'receipt-persisted' && transaction.childRequestId !== null &&
    transaction.attempt > 0 && (
      ((transaction.state === 'succeeded' || transaction.state === 'rolled-back') &&
        transaction.receiptDigest !== null) ||
      (transaction.state === 'recovery-required')
    )
  if (!idle && !pending && !terminal) context.addIssue({ code: 'custom', message: 'authority-mutation' })
})
const authorityMutationResultSchema: z.ZodType<CutoverAuthorityMutationResult> = z.strictObject({
  status: z.enum(['succeeded', 'rolled-back', 'recovery-required']),
  receiptDigest: sha256Schema.nullable()
}).superRefine((result, context) => {
  if ((result.status === 'succeeded' || result.status === 'rolled-back') && result.receiptDigest === null) {
    context.addIssue({ code: 'custom', message: 'authority-mutation-receipt' })
  }
})

const publicSummarySchema: z.ZodType<CutoverPublicSummary> = z.strictObject({
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

const previewReceiptSchema: z.ZodType<CutoverPreviewReceipt> = z.strictObject({
  format: z.literal('dyson-control-cutover-preview'),
  schemaVersion: z.literal(1),
  operation: previewOperationSchema,
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

const publicPhaseSchema = z.enum([
  'prepared',
  'activated',
  'rolled-back-immediate',
  'rolled-back-later',
  'recovered-candidate',
  'recovered-previous'
])
const publicStatusSchema = z.enum(['succeeded', 'rolled-back', 'failed-safe'])

const errorCodeValues = [
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
] as const satisfies readonly CutoverErrorCode[]
const errorCodeSchema = z.enum(errorCodeValues)

const receiptSchema: z.ZodType<CutoverReceipt> = z.strictObject({
  requestId: requestIdSchema,
  phase: publicPhaseSchema,
  status: publicStatusSchema,
  allowedDesired: z.array(authoritySchema).max(2),
  summary: publicSummarySchema,
  errorCode: errorCodeSchema.nullable()
})

const stateShape = z.strictObject({
  format: z.literal('dyson-control-cutover-state'),
  schemaVersion: z.literal(1),
  authorityInventoryRevision: sha256Schema,
  revision: sha256Schema,
  prepared: z.boolean(),
  authority: authoritySchema,
  activationBaselineProtected: z.boolean(),
  lastActivationRequestId: requestIdSchema.nullable()
})

const stateSchema: z.ZodType<CutoverStoredState> = stateShape.superRefine((state, context) => {
  const { revision, ...base } = state
  if (revision !== computeRevision(base)) {
    context.addIssue({ code: 'custom', message: 'revision' })
  }
  if (!state.prepared && (state.authority !== 'previous' || state.activationBaselineProtected ||
      state.lastActivationRequestId !== null)) {
    context.addIssue({ code: 'custom', message: 'unprepared-state' })
  }
  if (state.authority === 'candidate' && (!state.prepared || !state.activationBaselineProtected ||
      state.lastActivationRequestId === null)) {
    context.addIssue({ code: 'custom', message: 'candidate-state' })
  }
  if (state.authority === 'previous' && state.activationBaselineProtected) {
    context.addIssue({ code: 'custom', message: 'previous-state' })
  }
})

const journalSchema: z.ZodType<CutoverJournal> = z.strictObject({
  format: z.literal('dyson-control-cutover-journal'),
  schemaVersion: z.literal(1),
  requestId: requestIdSchema,
  authorityInventoryRevision: sha256Schema,
  fingerprint: sha256Schema,
  acceptedPreview: previewReceiptSchema.nullable(),
  operation: operationSchema,
  rollbackMode: rollbackModeSchema.nullable(),
  source: authoritySchema,
  target: authoritySchema,
  baseState: stateSchema,
  phase: phaseSchema,
  sequence: z.number().int().min(0).max(1_000),
  baselineSaveProtected: z.boolean(),
  baselineRestored: z.boolean(),
  currentProgressProtected: z.boolean(),
  possibleLiveMutation: z.boolean(),
  terminalDesired: authoritySchema.nullable(),
  evidence: publicSummarySchema,
  authorityMutation: authorityMutationSchema
}).superRefine((journal, context) => {
  const expectedFingerprint = operationFingerprint(
    journal.requestId,
    journal.operation,
    journal.rollbackMode,
    journal.authorityInventoryRevision
  )
  if (journal.fingerprint !== expectedFingerprint) {
    context.addIssue({ code: 'custom', message: 'fingerprint' })
  }
  if (journal.acceptedPreview !== null && (
    journal.acceptedPreview.requestId !== journal.requestId ||
    journal.acceptedPreview.operation !== publicOperationFor(journal.operation) ||
    journal.acceptedPreview.rollbackMode !== journal.rollbackMode ||
    journal.acceptedPreview.stateRevision !== journal.baseState.revision
  )) {
    context.addIssue({ code: 'custom', message: 'accepted-preview-binding' })
  }
  if ((journal.phase === 'terminal') !== (journal.terminalDesired !== null)) {
    context.addIssue({ code: 'custom', message: 'terminal' })
  }
  const correctBinding = journal.operation === 'prepare'
    ? journal.rollbackMode === null && journal.source === 'previous' && journal.target === 'previous'
    : journal.operation === 'activate'
      ? journal.rollbackMode === null && journal.source === 'previous' && journal.target === 'candidate'
      : journal.operation === 'rollback-immediate'
        ? journal.rollbackMode === 'immediate-compensation' && journal.source === 'candidate' && journal.target === 'previous'
        : journal.rollbackMode === 'later-operator-rollback' && journal.source === 'candidate' && journal.target === 'previous'
  if (!correctBinding) context.addIssue({ code: 'custom', message: 'binding' })
  if (journal.currentProgressProtected && journal.rollbackMode !== 'later-operator-rollback') {
    context.addIssue({ code: 'custom', message: 'progress-protection' })
  }
  if (journal.baselineRestored && !journal.baselineSaveProtected) {
    context.addIssue({ code: 'custom', message: 'baseline-restore' })
  }
  const expectedInitialMethod = authorityMutationMethodForOperation(journal.operation)
  if ((journal.authorityMutation.phase === 'not-started' &&
       journal.authorityMutation.method !== expectedInitialMethod) ||
      journal.baseState.authorityInventoryRevision !== journal.authorityInventoryRevision) {
    context.addIssue({ code: 'custom', message: 'authority-mutation-binding' })
  }
})

const storedReceiptSchema: z.ZodType<CutoverStoredReceipt> = z.strictObject({
  format: z.literal('dyson-control-cutover-receipt-envelope'),
  schemaVersion: z.literal(1),
  authorityInventoryRevision: sha256Schema,
  fingerprint: sha256Schema,
  acceptedPreview: previewReceiptSchema.nullable(),
  operation: operationSchema,
  receipt: receiptSchema
}).superRefine((envelope, context) => {
  if (envelope.fingerprint !== operationFingerprint(
    envelope.receipt.requestId,
    envelope.operation,
    rollbackModeForOperation(envelope.operation),
    envelope.authorityInventoryRevision
  )) {
    context.addIssue({ code: 'custom', message: 'fingerprint' })
  }
  if (envelope.acceptedPreview !== null && (
    envelope.acceptedPreview.requestId !== envelope.receipt.requestId ||
    envelope.acceptedPreview.operation !== publicOperationFor(envelope.operation) ||
    envelope.acceptedPreview.rollbackMode !== rollbackModeForOperation(envelope.operation)
  )) {
    context.addIssue({ code: 'custom', message: 'accepted-preview-binding' })
  }
  const allowedPhases: Record<CutoverOperation, readonly CutoverPublicPhase[]> = {
    prepare: ['prepared', 'recovered-previous'],
    activate: ['activated', 'recovered-candidate', 'recovered-previous'],
    'rollback-immediate': ['rolled-back-immediate', 'recovered-candidate', 'recovered-previous'],
    'rollback-later': ['rolled-back-later', 'recovered-candidate', 'recovered-previous']
  }
  if (!allowedPhases[envelope.operation].includes(envelope.receipt.phase) ||
      envelope.receipt.allowedDesired.length !== 0 || envelope.receipt.summary.reused ||
      envelope.receipt.errorCode !== null || !receiptPhaseStatusCoherent(envelope.receipt)) {
    context.addIssue({ code: 'custom', message: 'receipt-semantics' })
  }
})

const evidenceSchema: z.ZodType<CutoverHostEvidence> = z.strictObject({
  previousDefined: z.boolean(),
  previousEnabled: z.boolean(),
  candidateDefined: z.boolean(),
  candidateEnabled: z.boolean(),
  unexpectedAuthorityPresent: z.boolean(),
  processState: z.enum(['none', 'previous-only', 'candidate-only', 'both', 'unknown']),
  portState: z.enum(['closed', 'previous', 'candidate', 'unknown']),
  previousHealthy: z.boolean(),
  candidateHealthy: z.boolean()
})

type OperationExecutionResult = Readonly<{
  receipt: CutoverReceipt
  terminalJournal: CutoverJournal | null
}>

interface OrdinaryContext {
  readonly scope: HostMutationOperationScope
  markJournalStarted(): void
}

interface RecoveryBinding {
  operation: CutoverOperation
  fingerprint: string
  journal: CutoverJournal | null
  receipt: CutoverStoredReceipt | null
  allowedDesired: CutoverDesiredAuthority[]
}

export function createInitialCutoverState(authorityInventoryRevision: string): CutoverStoredState {
  if (!sha256Schema.safeParse(authorityInventoryRevision).success) {
    throw new CutoverError('CUTOVER_DURABLE_STATE_INVALID')
  }
  return createState(authorityInventoryRevision, {
    prepared: false,
    authority: 'previous',
    activationBaselineProtected: false,
    lastActivationRequestId: null
  })
}

/**
 * Provider-neutral, crash-recoverable GSManager -> Dyson Control cutover.
 * It never imports or calls the existing lifecycle rollback-start primitive.
 */
export class CutoverService {
  readonly #authorityInventoryRevision: string
  readonly #previewKey: Buffer
  readonly #adapter: CutoverHostAdapter
  readonly #store: CutoverDurableStore
  readonly #hostMutationCoordinator: HostMutationOperationCoordinator | null
  readonly #hostMutationRecoveryCoordinator: HostMutationRecoveryOperationCoordinator | null

  constructor(options: CutoverServiceOptions) {
    const adapterMethods = [
      'inspect', 'defineCandidateDisabled', 'createSaveProtectionPoint', 'restoreActivationBaseline',
      'disablePreviousAuthority', 'stopPreviousRuntime', 'enableCandidateAuthority',
      'startCandidateRuntime', 'disableCandidateAuthority', 'stopCandidateRuntime',
      'enablePreviousAuthority', 'startPreviousRuntime'
    ] as const
    const storeMethods = [
      'readState', 'readJournal', 'readReceipt', 'createJournal', 'replaceJournal',
      'commitTerminal', 'clearTerminalJournal'
    ] as const
    if (!options || !sha256Schema.safeParse(options.authorityInventoryRevision).success ||
        adapterMethods.some((method) => typeof options.adapter?.[method] !== 'function') ||
        storeMethods.some((method) => typeof options.store?.[method] !== 'function') ||
        (options.hostMutationCoordinator !== undefined &&
          typeof options.hostMutationCoordinator.runExclusive !== 'function') ||
        (options.hostMutationRecoveryCoordinator !== undefined &&
          typeof options.hostMutationRecoveryCoordinator.runRecoveryExclusive !== 'function')) {
      throw new CutoverError('CUTOVER_DURABLE_STATE_INVALID')
    }
    this.#adapter = options.adapter
    this.#store = options.store
    this.#authorityInventoryRevision = options.authorityInventoryRevision
    this.#previewKey = randomBytes(32)
    this.#hostMutationCoordinator = options.hostMutationCoordinator ?? null
    this.#hostMutationRecoveryCoordinator = options.hostMutationRecoveryCoordinator ?? null
  }

  /**
   * Creates a stable, bounded, server-authenticated plan over the current
   * durable state and full provider-neutral host evidence. This method never
   * acquires the mutation lease and never writes the durable cutover store.
   */
  async preview(input: unknown): Promise<CutoverPreviewReceipt> {
    const request = parsePreviewRequest(input)
    await this.#assertNoPendingJournal()
    const state = await this.#readState()
    const evidence = await this.#inspectReadOnly(request.requestId)
    assertPreviewPreconditions(request, state, evidence)
    return this.#createPreview(request, state, evidence)
  }

  #createPreview(
    request: CutoverPreviewRequest,
    state: CutoverStoredState,
    evidence: CutoverHostEvidence
  ): CutoverPreviewReceipt {
    const rollbackMode = request.operation === 'rollback' ? request.mode : null
    const evidenceDigest = computeEvidenceDigest(evidence)
    const binding = {
      format: 'dyson-control-cutover-plan' as const,
      schemaVersion: 1 as const,
      planRevision: planRevisionFor(request),
      authorityInventoryRevision: this.#authorityInventoryRevision,
      operation: request.operation,
      requestId: request.requestId,
      rollbackMode,
      stateRevision: state.revision,
      evidenceDigest
    }
    const planFingerprint = createHmac('sha256', this.#previewKey)
      .update(canonicalJson(binding))
      .digest('hex')
    return previewReceiptSchema.parse({
      format: 'dyson-control-cutover-preview',
      schemaVersion: 1,
      operation: request.operation,
      requestId: request.requestId,
      rollbackMode,
      stateRevision: state.revision,
      evidenceDigest,
      planFingerprint,
      summary: summarizePreview(request, state, evidence)
    })
  }

  #assertCurrentPreview(
    request: CutoverPreviewRequest,
    planFingerprint: string,
    state: CutoverStoredState,
    evidence: CutoverHostEvidence
  ): CutoverPreviewReceipt {
    const current = this.#createPreview(request, state, evidence)
    if (!sameSha256(current.planFingerprint, planFingerprint)) {
      throw new CutoverError('CUTOVER_PREVIEW_CONFLICT')
    }
    return current
  }

  /** Bounded, operation-bound projection used only for interrupted HTTP audit reconciliation. */
  async getReceiptForAudit(input: unknown): Promise<CutoverAuditReceiptResolution | null> {
    const parsed = z.strictObject({
      requestId: requestIdSchema,
      operation: z.enum(['prepare', 'activate', 'rollback', 'recover']),
      planFingerprint: sha256Schema.nullish(),
      rollbackMode: rollbackModeSchema.nullish(),
      desired: authoritySchema.nullish()
    }).superRefine((request, context) => {
      const rollback = request.operation === 'rollback' && request.rollbackMode != null &&
        request.desired == null
      const recover = request.operation === 'recover' && request.rollbackMode == null &&
        request.desired != null && request.planFingerprint == null
      const ordinary = (request.operation === 'prepare' || request.operation === 'activate') &&
        request.rollbackMode == null && request.desired == null
      if (!rollback && !recover && !ordinary) context.addIssue({ code: 'custom', message: 'binding' })
    }).safeParse(input)
    if (!parsed.success) throw new CutoverError('CUTOVER_REQUEST_INVALID')
    const request = parsed.data as CutoverAuditReceiptLookupRequest
    const stored = await this.#readStoredReceipt(request.requestId)
    if (stored === null) return null
    const expectedFingerprint = operationFingerprint(
      request.requestId,
      stored.operation,
      rollbackModeForOperation(stored.operation),
      this.#authorityInventoryRevision
    )
    if (stored.fingerprint !== expectedFingerprint) {
      throw new CutoverError('CUTOVER_RECOVERY_EVIDENCE_INVALID')
    }
    if (request.planFingerprint != null &&
        stored.acceptedPreview?.planFingerprint !== request.planFingerprint) {
      return { match: 'conflict' }
    }
    const operationMatches = request.operation === 'prepare'
      ? stored.operation === 'prepare'
      : request.operation === 'activate'
        ? stored.operation === 'activate'
        : request.operation === 'rollback'
          ? stored.operation === (request.rollbackMode === 'immediate-compensation'
              ? 'rollback-immediate'
              : 'rollback-later')
          : stored.receipt.phase === `recovered-${request.desired}`
    if (!operationMatches) return { match: 'conflict' }
    return {
      match: 'matched',
      storedOperation: stored.operation,
      receipt: {
        ...stored.receipt,
        allowedDesired: [...stored.receipt.allowedDesired],
        summary: { ...stored.receipt.summary }
      }
    }
  }

  async prepare(input: unknown): Promise<CutoverReceipt> {
    const request = parsePrepareRequest(input)
    const operation: CutoverOperation = 'prepare'
    const fingerprint = operationFingerprint(
      request.requestId, operation, null, this.#authorityInventoryRevision)
    const replay = await this.#readReplay(
      request.requestId, operation, fingerprint, request.planFingerprint)
    if (replay !== null) return replay
    await this.#assertNoPendingJournal()

    return await this.#runOrdinary(operation, request.requestId, async (context) => {
      const replayWithinLease = await this.#readReplay(
        request.requestId, operation, fingerprint, request.planFingerprint)
      if (replayWithinLease !== null) return await this.#terminalResultFromReplay(
        replayWithinLease, operation, fingerprint, request.planFingerprint)
      await this.#assertNoPendingJournal()
      const baseState = await this.#readState()
      if (baseState.authority !== 'previous') throw new CutoverError('CUTOVER_NOT_CANDIDATE_ACTIVE')

      const before = await this.#inspect(context.scope, request.requestId)
      const acceptedPreview = this.#assertCurrentPreview(
        { requestId: request.requestId, operation: 'prepare' },
        request.planFingerprint,
        baseState,
        before
      )
      assertPreviousPreparationBaseline(before)
      if (before.candidateEnabled) throw new CutoverError('CUTOVER_AUTHORITY_DRIFT')

      let journal = createJournal({
        requestId: request.requestId,
        authorityInventoryRevision: this.#authorityInventoryRevision,
        fingerprint,
        acceptedPreview,
        operation,
        rollbackMode: null,
        source: 'previous',
        target: 'previous',
        baseState,
        phase: 'prepared',
        baselineSaveProtected: false,
        currentProgressProtected: false,
        evidence: summarizeEvidence(before, false, false)
      })
      await this.#createJournal(journal, context.scope)
      context.markJournalStarted()

      let after = before
      if (!before.candidateDefined) {
        journal = await this.#advanceJournal(journal, 'candidate-definition-intent', {
          possibleLiveMutation: true
        }, context.scope)
        journal = await this.#applyAuthorityMutation(
          journal,
          'defineCandidateDisabled',
          context.scope
        )
        after = await this.#inspect(context.scope, request.requestId)
        if (!samePreviousAuthorityAndRuntime(before, after) || !after.candidateDefined || after.candidateEnabled) {
          throw new CutoverError('CUTOVER_PREPARE_INVARIANT_FAILED')
        }
      }
      assertPreviousPreparationBaseline(after)
      if (!after.candidateDefined || after.candidateEnabled) {
        throw new CutoverError('CUTOVER_PREPARE_INVARIANT_FAILED')
      }
      journal = await this.#advanceJournal(journal, 'candidate-defined-disabled', {
        evidence: summarizeEvidence(after, false, false)
      }, context.scope)

      const nextState = createState(this.#authorityInventoryRevision, {
        prepared: true,
        authority: 'previous',
        activationBaselineProtected: false,
        lastActivationRequestId: null
      })
      return await this.#commitTerminal(journal, nextState, createReceipt({
        requestId: request.requestId,
        phase: 'prepared',
        status: 'succeeded',
        evidence: after,
        saveProtected: false,
        currentProgressProtected: false
      }), context.scope)
    })
  }

  async activate(input: unknown): Promise<CutoverReceipt> {
    const request = parseActivateRequest(input)
    const operation: CutoverOperation = 'activate'
    const fingerprint = operationFingerprint(
      request.requestId, operation, null, this.#authorityInventoryRevision)
    const replay = await this.#readReplay(
      request.requestId, operation, fingerprint, request.planFingerprint)
    if (replay !== null) return replay
    await this.#assertNoPendingJournal()

    return await this.#runOrdinary(operation, request.requestId, async (context) => {
      const replayWithinLease = await this.#readReplay(
        request.requestId, operation, fingerprint, request.planFingerprint)
      if (replayWithinLease !== null) return await this.#terminalResultFromReplay(
        replayWithinLease, operation, fingerprint, request.planFingerprint)
      await this.#assertNoPendingJournal()
      const baseState = await this.#readState()
      if (!baseState.prepared || baseState.authority !== 'previous') {
        throw new CutoverError('CUTOVER_NOT_PREPARED')
      }
      let evidence = await this.#inspect(context.scope, request.requestId)
      const acceptedPreview = this.#assertCurrentPreview(
        { requestId: request.requestId, operation: 'activate' },
        request.planFingerprint,
        baseState,
        evidence
      )
      assertPreviousTerminal(evidence)
      assertCandidateDefinedDisabled(evidence)

      let journal = createJournal({
        requestId: request.requestId,
        authorityInventoryRevision: this.#authorityInventoryRevision,
        fingerprint,
        acceptedPreview,
        operation,
        rollbackMode: null,
        source: 'previous',
        target: 'candidate',
        baseState,
        phase: 'prepared',
        baselineSaveProtected: false,
        currentProgressProtected: false,
        evidence: summarizeEvidence(evidence, false, false)
      })
      await this.#createJournal(journal, context.scope)
      context.markJournalStarted()

      journal = await this.#advanceJournal(journal, 'save-protection-intent', {}, context.scope)
      const protection = await this.#mutate(context.scope, request.requestId, (requestContext) =>
        this.#adapter.createSaveProtectionPoint({ ...requestContext, purpose: 'activation-baseline' }))
      if (protection.pairProtected !== true || protection.durable !== true) {
        throw new CutoverError('CUTOVER_SAVE_PROTECTION_FAILED')
      }
      journal = await this.#advanceJournal(journal, 'save-protected', {
        baselineSaveProtected: true,
        evidence: summarizeEvidence(evidence, true, false)
      }, context.scope)

      evidence = await this.#inspect(context.scope, request.requestId)
      assertPreviousTerminal(evidence)
      assertCandidateDefinedDisabled(evidence)
      journal = await this.#advanceJournal(journal, 'disable-source-intent', {
        possibleLiveMutation: true
      }, context.scope)
      await this.#mutate(context.scope, request.requestId, (requestContext) =>
        this.#adapter.disablePreviousAuthority(requestContext))
      evidence = await this.#inspect(context.scope, request.requestId)
      assertPreviousRunningWithAuthoritiesDisabled(evidence)
      journal = await this.#advanceJournal(journal, 'source-disabled', {
        evidence: summarizeEvidence(evidence, true, false)
      }, context.scope)

      journal = await this.#advanceJournal(journal, 'stop-source-intent', {}, context.scope)
      await this.#mutate(context.scope, request.requestId, (requestContext) =>
        this.#adapter.stopPreviousRuntime(requestContext))
      evidence = await this.#inspect(context.scope, request.requestId)
      assertStoppedWithAuthoritiesDisabled(evidence)
      journal = await this.#advanceJournal(journal, 'source-stopped', {
        evidence: summarizeEvidence(evidence, true, false)
      }, context.scope)

      // This durable intent is the launch capability boundary. Candidate start
      // is impossible before it has been persisted under the same host lease.
      journal = await this.#advanceJournal(journal, 'launch-target-intent', {}, context.scope)
      journal = await this.#applyAuthorityMutation(
        journal,
        'enableCandidateAuthority',
        context.scope
      )
      evidence = await this.#inspect(context.scope, request.requestId)
      assertCandidateEnabledAndStopped(evidence)
      journal = await this.#advanceJournal(journal, 'target-enabled', {
        evidence: summarizeEvidence(evidence, true, false)
      }, context.scope)

      // Re-read immediately before start. A competing old process or port owner
      // causes a zero-write rejection, blocking the double-start race.
      evidence = await this.#inspect(context.scope, request.requestId)
      assertCandidateEnabledAndStopped(evidence)
      journal = await this.#advanceJournal(journal, 'target-start-intent', {}, context.scope)
      await this.#mutate(context.scope, request.requestId, (requestContext) =>
        this.#adapter.startCandidateRuntime(requestContext))
      evidence = await this.#inspect(context.scope, request.requestId)
      assertCandidateTerminal(evidence)
      journal = await this.#advanceJournal(journal, 'target-started', {
        evidence: summarizeEvidence(evidence, true, false)
      }, context.scope)

      const nextState = createState(this.#authorityInventoryRevision, {
        prepared: true,
        authority: 'candidate',
        activationBaselineProtected: true,
        lastActivationRequestId: request.requestId
      })
      return await this.#commitTerminal(journal, nextState, createReceipt({
        requestId: request.requestId,
        phase: 'activated',
        status: 'succeeded',
        evidence,
        saveProtected: true,
        currentProgressProtected: false
      }), context.scope)
    })
  }

  async rollback(input: unknown): Promise<CutoverReceipt> {
    const request = parseRollbackRequest(input)
    const operation: CutoverOperation = request.mode === 'immediate-compensation'
      ? 'rollback-immediate'
      : 'rollback-later'
    const fingerprint = operationFingerprint(
      request.requestId, operation, request.mode, this.#authorityInventoryRevision)
    const replay = await this.#readReplay(
      request.requestId, operation, fingerprint, request.planFingerprint)
    if (replay !== null) return replay
    await this.#assertNoPendingJournal()

    return await this.#runOrdinary(operation, request.requestId, async (context) => {
      const replayWithinLease = await this.#readReplay(
        request.requestId, operation, fingerprint, request.planFingerprint)
      if (replayWithinLease !== null) return await this.#terminalResultFromReplay(
        replayWithinLease, operation, fingerprint, request.planFingerprint)
      await this.#assertNoPendingJournal()
      const baseState = await this.#readState()
      if (!baseState.prepared || baseState.authority !== 'candidate' ||
          !baseState.activationBaselineProtected || baseState.lastActivationRequestId === null) {
        throw new CutoverError('CUTOVER_NOT_CANDIDATE_ACTIVE')
      }
      let evidence = await this.#inspect(context.scope, request.requestId)
      const acceptedPreview = this.#assertCurrentPreview(
        { requestId: request.requestId, operation: 'rollback', mode: request.mode },
        request.planFingerprint,
        baseState,
        evidence
      )
      assertCandidateTerminal(evidence)

      let journal = createJournal({
        requestId: request.requestId,
        authorityInventoryRevision: this.#authorityInventoryRevision,
        fingerprint,
        acceptedPreview,
        operation,
        rollbackMode: request.mode,
        source: 'candidate',
        target: 'previous',
        baseState,
        phase: 'prepared',
        baselineSaveProtected: true,
        currentProgressProtected: false,
        evidence: summarizeEvidence(evidence, true, false)
      })
      await this.#createJournal(journal, context.scope)
      context.markJournalStarted()

      if (request.mode === 'later-operator-rollback') {
        journal = await this.#advanceJournal(journal, 'save-protection-intent', {}, context.scope)
        const protection = await this.#mutate(context.scope, request.requestId, (requestContext) =>
          this.#adapter.createSaveProtectionPoint({ ...requestContext, purpose: 'later-candidate-progress' }))
        if (protection.pairProtected !== true || protection.durable !== true) {
          throw new CutoverError('CUTOVER_SAVE_PROTECTION_FAILED')
        }
        journal = await this.#advanceJournal(journal, 'save-protected', {
          currentProgressProtected: true,
          evidence: summarizeEvidence(evidence, true, true)
        }, context.scope)
      }

      evidence = await this.#inspect(context.scope, request.requestId)
      assertCandidateTerminal(evidence)
      journal = await this.#advanceJournal(journal, 'disable-source-intent', {
        possibleLiveMutation: true
      }, context.scope)
      journal = await this.#applyAuthorityMutation(
        journal,
        'disableCandidateAuthority',
        context.scope
      )
      evidence = await this.#inspect(context.scope, request.requestId)
      assertCandidateRunningWithAuthoritiesDisabled(evidence)
      journal = await this.#advanceJournal(journal, 'source-disabled', {
        evidence: summarizeEvidence(evidence, true, journal.currentProgressProtected)
      }, context.scope)

      journal = await this.#advanceJournal(journal, 'stop-source-intent', {}, context.scope)
      await this.#mutate(context.scope, request.requestId, (requestContext) =>
        this.#adapter.stopCandidateRuntime(requestContext))
      evidence = await this.#inspect(context.scope, request.requestId)
      assertStoppedWithAuthoritiesDisabled(evidence)
      journal = await this.#advanceJournal(journal, 'source-stopped', {
        evidence: summarizeEvidence(evidence, true, journal.currentProgressProtected)
      }, context.scope)

      if (request.mode === 'immediate-compensation') {
        journal = await this.#restoreActivationBaseline(journal, evidence, context.scope)
      }

      journal = await this.#advanceJournal(journal, 'launch-target-intent', {}, context.scope)
      await this.#mutate(context.scope, request.requestId, (requestContext) =>
        this.#adapter.enablePreviousAuthority(requestContext))
      evidence = await this.#inspect(context.scope, request.requestId)
      assertPreviousEnabledAndStopped(evidence)
      journal = await this.#advanceJournal(journal, 'target-enabled', {
        evidence: summarizeEvidence(evidence, true, journal.currentProgressProtected)
      }, context.scope)

      evidence = await this.#inspect(context.scope, request.requestId)
      assertPreviousEnabledAndStopped(evidence)
      journal = await this.#advanceJournal(journal, 'target-start-intent', {}, context.scope)
      await this.#mutate(context.scope, request.requestId, (requestContext) =>
        this.#adapter.startPreviousRuntime(requestContext))
      evidence = await this.#inspect(context.scope, request.requestId)
      assertPreviousTerminal(evidence)
      journal = await this.#advanceJournal(journal, 'target-started', {
        evidence: summarizeEvidence(evidence, true, journal.currentProgressProtected)
      }, context.scope)

      const nextState = createState(this.#authorityInventoryRevision, {
        prepared: true,
        authority: 'previous',
        activationBaselineProtected: false,
        lastActivationRequestId: null
      })
      return await this.#commitTerminal(journal, nextState, createReceipt({
        requestId: request.requestId,
        phase: request.mode === 'immediate-compensation'
          ? 'rolled-back-immediate'
          : 'rolled-back-later',
        status: 'rolled-back',
        evidence,
        saveProtected: true,
        baselineRestored: journal.baselineRestored,
        currentProgressProtected: journal.currentProgressProtected
      }), context.scope)
    })
  }

  async recoveryStatus(): Promise<CutoverRecoveryStatus> {
    let journal: CutoverJournal | null
    try {
      journal = await this.#readJournal()
      if (journal === null) {
        return {
          requestId: null,
          phase: 'ready',
          status: 'ready',
          allowedDesired: [],
          summary: emptySummary(),
          errorCode: null
        }
      }
      const evidence = await this.#inspectReadOnly(journal.requestId)
      const allowedDesired = allowedDesiredForJournal(journal, evidence)
      return {
        requestId: journal.requestId,
        phase: 'recovery-required',
        status: journal.phase === 'terminal' ? 'terminal-pending-release' : 'interrupted',
        allowedDesired,
        summary: summarizeEvidence(
          evidence,
          journal.baselineSaveProtected,
          journal.currentProgressProtected,
          journal.baselineRestored
        ),
        errorCode: allowedDesired.length === 0 ? 'CUTOVER_RECOVERY_EVIDENCE_INVALID' : null
      }
    } catch {
      return {
        requestId: null,
        phase: 'recovery-required',
        status: 'evidence-invalid',
        allowedDesired: [],
        summary: emptySummary(),
        errorCode: 'CUTOVER_RECOVERY_EVIDENCE_INVALID'
      }
    }
  }

  async recoverInterrupted(input: unknown): Promise<CutoverReceipt> {
    const request = parseRecoveryRequest(input)
    const recoveryCoordinator = this.#hostMutationRecoveryCoordinator
    if (recoveryCoordinator === null) throw new CutoverError('CUTOVER_HOST_LEASE_UNAVAILABLE')

    const initial = await this.#readRecoveryBinding(request)
    if (initial.allowedDesired.length === 0) {
      throw new CutoverError('CUTOVER_RECOVERY_EVIDENCE_INVALID')
    }
    if (!initial.allowedDesired.includes(request.desired)) {
      throw new CutoverError('CUTOVER_RECOVERY_TARGET_NOT_ALLOWED')
    }

    try {
      const result = await recoveryCoordinator.runRecoveryExclusive({
        expectedOperation: hostOperation(initial.operation),
        expectedRequestId: request.requestId
      }, async (scope) => {
        try {
          scope.assertActive()
          const current = await this.#readRecoveryBinding(request)
          if (current.operation !== initial.operation || current.fingerprint !== initial.fingerprint ||
              !current.allowedDesired.includes(request.desired)) {
            return hostMutationThrow<OperationExecutionResult>(
              new CutoverError('CUTOVER_RECOVERY_EVIDENCE_INVALID'),
              'abandon'
            )
          }
          const recovered = current.journal?.phase === 'terminal'
            ? await this.#replayTerminalRecovery(current, request, scope)
            : current.journal === null
              ? await this.#replayReceiptOnlyRecovery(current, request, scope)
              : await this.#convergeRecovery(current.journal, request.desired, scope)
          scope.assertActive()
          return hostMutationReturn(recovered, 'release')
        } catch (error) {
          if (error instanceof HostMutationLeaseError) throw error
          return hostMutationThrow<OperationExecutionResult>(normalizeError(error), 'abandon')
        }
      })
      if (result.terminalJournal !== null) {
        await this.#clearTerminalJournal(result.terminalJournal).catch(() => undefined)
      }
      return result.receipt
    } catch (error) {
      if (error instanceof HostMutationOperationCoordinatorError &&
          error.code === 'HOST_MUTATION_LEASE_RECOVERY_NOT_REQUIRED') {
        return await this.#recoverWhenBrokerAlreadyClean(request)
      }
      throw mapCoordinatorError(error)
    }
  }

  async #convergeRecovery(
    journalInput: CutoverJournal,
    desired: CutoverDesiredAuthority,
    scope: HostMutationOperationScope
  ): Promise<OperationExecutionResult> {
    const persistedState = await this.#readState()
    if (canonicalJson(persistedState) !== canonicalJson(journalInput.baseState)) {
      throw new CutoverError('CUTOVER_RECOVERY_EVIDENCE_INVALID')
    }
    let evidence = await this.#inspect(scope, journalInput.requestId)
    assertReachableEvidence(evidence)
    assertSucceededAuthorityMutationEvidence(journalInput.authorityMutation, evidence)
    const prepareRuntimeWasStopped = journalInput.operation === 'prepare'
      ? assertPrepareRecoveryRuntimePreserved(journalInput, evidence)
      : null
    let journal = journalInput
    if (authorityMutationNeedsRecovery(journal.authorityMutation)) {
      journal = await this.#recoverAuthorityMutation(journal, scope)
      evidence = await this.#inspect(scope, journal.requestId)
      assertReachableEvidence(evidence)
      assertSucceededAuthorityMutationEvidence(journal.authorityMutation, evidence)
      if (prepareRuntimeWasStopped !== null &&
          assertPrepareRecoveryRuntimePreserved(journalInput, evidence) !== prepareRuntimeWasStopped) {
        throw new CutoverError('CUTOVER_RECOVERY_EVIDENCE_INVALID')
      }
    }
    // Live evidence is proven reachable before the parent recovery phases are written.
    journal = await this.#advanceJournal(journal, 'recovery-intent', {}, scope)
    journal = await this.#advanceJournal(journal, 'recovery-converging', {
      evidence: summarizeEvidence(
        evidence,
        journal.baselineSaveProtected,
        journal.currentProgressProtected,
        journal.baselineRestored
      )
    }, scope)

    if (desired === 'candidate') {
      let previousStopFinalized = false
      if (!journal.baselineSaveProtected || !journal.baseState.prepared || !evidence.candidateDefined) {
        throw new CutoverError('CUTOVER_RECOVERY_TARGET_NOT_ALLOWED')
      }
      if (!isCandidateTerminal(evidence)) {
        if (evidence.previousEnabled) {
          journal = await this.#advanceJournal(journal, 'disable-source-intent', {
            possibleLiveMutation: true
          }, scope)
          await this.#mutate(scope, journal.requestId, (requestContext) =>
            this.#adapter.disablePreviousAuthority(requestContext))
          evidence = await this.#inspect(scope, journal.requestId)
          assertKnownEvidence(evidence)
        }
        if (evidence.processState === 'previous-only') {
          if (evidence.previousEnabled || evidence.candidateEnabled) {
            throw new CutoverError('CUTOVER_AUTHORITY_DRIFT')
          }
          journal = await this.#advanceJournal(journal, 'stop-source-intent', {}, scope)
          await this.#mutate(scope, journal.requestId, (requestContext) =>
            this.#adapter.stopPreviousRuntime(requestContext))
          previousStopFinalized = true
          evidence = await this.#inspect(scope, journal.requestId)
          assertKnownEvidence(evidence)
        }
        if (evidence.processState === 'candidate-only') {
          if (evidence.previousEnabled || evidence.candidateEnabled) {
            throw new CutoverError('CUTOVER_AUTHORITY_DRIFT')
          }
          journal = await this.#advanceJournal(journal, 'launch-target-intent', {}, scope)
          journal = await this.#applyAuthorityMutation(
            journal,
            'enableCandidateAuthority',
            scope
          )
          evidence = await this.#inspect(scope, journal.requestId)
        } else {
          if (evidence.processState !== 'none' || evidence.portState !== 'closed') {
            throw new CutoverError('CUTOVER_STOP_GATE_FAILED')
          }
          if (!previousStopFinalized && !evidence.previousEnabled && !evidence.candidateEnabled) {
            // A completed process exit can precede the stop task's durable
            // acknowledgement/cleanup. Reconcile it before enabling authority.
            await this.#mutate(scope, journal.requestId, (requestContext) =>
              this.#adapter.stopPreviousRuntime(requestContext))
            evidence = await this.#inspect(scope, journal.requestId)
            assertStoppedWithAuthoritiesDisabled(evidence)
          }
          if (!evidence.candidateEnabled) {
            if (evidence.previousEnabled) throw new CutoverError('CUTOVER_AUTHORITY_DRIFT')
            journal = await this.#advanceJournal(journal, 'launch-target-intent', {}, scope)
            journal = await this.#applyAuthorityMutation(
              journal,
              'enableCandidateAuthority',
              scope
            )
            evidence = await this.#inspect(scope, journal.requestId)
            assertCandidateEnabledAndStopped(evidence)
          }
          journal = await this.#advanceJournal(journal, 'target-start-intent', {}, scope)
          await this.#mutate(scope, journal.requestId, (requestContext) =>
            this.#adapter.startCandidateRuntime(requestContext))
          evidence = await this.#inspect(scope, journal.requestId)
        }
      }
      assertCandidateTerminal(evidence)
      const nextState = createState(this.#authorityInventoryRevision, {
        prepared: true,
        authority: 'candidate',
        activationBaselineProtected: true,
        lastActivationRequestId: journal.operation === 'activate'
          ? journal.requestId
          : journal.baseState.lastActivationRequestId ?? journal.requestId
      })
      return await this.#commitTerminal(journal, nextState, createReceipt({
        requestId: journal.requestId,
        phase: 'recovered-candidate',
        status: 'succeeded',
        evidence,
        saveProtected: true,
        baselineRestored: journal.baselineRestored,
        currentProgressProtected: journal.currentProgressProtected
      }), scope)
    }

    if (!canRecoverPrevious(journal)) {
      throw new CutoverError('CUTOVER_RECOVERY_TARGET_NOT_ALLOWED')
    }
    if (!isPreviousTerminal(evidence) && prepareRuntimeWasStopped === null) {
      if (evidence.candidateEnabled) {
        journal = await this.#advanceJournal(journal, 'disable-source-intent', {
          possibleLiveMutation: true
        }, scope)
        journal = await this.#applyAuthorityMutation(
          journal,
          'disableCandidateAuthority',
          scope
        )
        evidence = await this.#inspect(scope, journal.requestId)
        assertKnownEvidence(evidence)
      }
      if (evidence.processState === 'candidate-only') {
        if (evidence.previousEnabled || evidence.candidateEnabled) {
          throw new CutoverError('CUTOVER_AUTHORITY_DRIFT')
        }
        journal = await this.#advanceJournal(journal, 'stop-source-intent', {}, scope)
        await this.#mutate(scope, journal.requestId, (requestContext) =>
          this.#adapter.stopCandidateRuntime(requestContext))
        evidence = await this.#inspect(scope, journal.requestId)
        assertKnownEvidence(evidence)
      }
      if (evidence.processState === 'previous-only' && !evidence.previousEnabled && !evidence.candidateEnabled) {
        // A hard exit after disabling the old authority but before stopping its
        // still-healthy process can safely converge by re-enabling it.
      } else if (evidence.processState !== 'none' || evidence.portState !== 'closed') {
        throw new CutoverError('CUTOVER_STOP_GATE_FAILED')
      }
      const restoreBaseline = journal.operation === 'rollback-immediate' ||
        (journal.operation === 'activate' && journal.baselineSaveProtected)
      if (!evidence.previousEnabled && !evidence.candidateEnabled) {
        // Recovery only reconciles the existing stop transaction. A healthy old
        // process must never receive a new signal while restoring its authority.
        await this.#mutate(scope, journal.requestId, (requestContext) =>
          this.#adapter.stopPreviousRuntime(requestContext, { reconcileOnly: true }))
        evidence = await this.#inspect(scope, journal.requestId)
        assertKnownEvidence(evidence)
        if (evidence.previousEnabled || evidence.candidateEnabled ||
            (evidence.processState !== 'previous-only' &&
              (evidence.processState !== 'none' || evidence.portState !== 'closed'))) {
          throw new CutoverError('CUTOVER_STOP_GATE_FAILED')
        }
      }
      if (restoreBaseline && evidence.processState === 'none' && !journal.baselineRestored) {
        journal = await this.#restoreActivationBaseline(journal, evidence, scope)
      }
      if (!evidence.previousEnabled) {
        if (evidence.candidateEnabled) throw new CutoverError('CUTOVER_AUTHORITY_DRIFT')
        journal = await this.#advanceJournal(journal, 'launch-target-intent', {}, scope)
        await this.#mutate(scope, journal.requestId, (requestContext) =>
          this.#adapter.enablePreviousAuthority(requestContext))
        evidence = await this.#inspect(scope, journal.requestId)
        assertKnownEvidence(evidence)
      }
      if (evidence.processState === 'none') {
        assertPreviousEnabledAndStopped(evidence)
        journal = await this.#advanceJournal(journal, 'target-start-intent', {}, scope)
        await this.#mutate(scope, journal.requestId, (requestContext) =>
          this.#adapter.startPreviousRuntime(requestContext))
        evidence = await this.#inspect(scope, journal.requestId)
      }
    }
    if (prepareRuntimeWasStopped === null) assertPreviousTerminal(evidence)
    else {
      evidence = await this.#inspect(scope, journal.requestId)
      if (assertPrepareRecoveryRuntimePreserved(journalInput, evidence) !== prepareRuntimeWasStopped) {
        throw new CutoverError('CUTOVER_RECOVERY_EVIDENCE_INVALID')
      }
    }
    const recoveredPrepared = journal.operation !== 'prepare' || evidence.candidateDefined
    const nextState = createState(this.#authorityInventoryRevision, {
      prepared: recoveredPrepared,
      authority: 'previous',
      activationBaselineProtected: false,
      lastActivationRequestId: null
    })
    return await this.#commitTerminal(journal, nextState, createReceipt({
      requestId: journal.requestId,
      phase: 'recovered-previous',
      status: journal.operation === 'activate' || !recoveredPrepared ? 'rolled-back' : 'succeeded',
      evidence,
      saveProtected: journal.baselineSaveProtected || journal.currentProgressProtected,
      baselineRestored: journal.baselineRestored,
      currentProgressProtected: journal.currentProgressProtected
    }), scope)
  }

  async #readRecoveryBinding(request: CutoverRecoveryRequest): Promise<RecoveryBinding> {
    const journal = await this.#readJournal()
    const receipt = await this.#readStoredReceipt(request.requestId)
    if (journal !== null && journal.requestId !== request.requestId) {
      throw new CutoverError('CUTOVER_RECOVERY_EVIDENCE_INVALID')
    }
    if (journal === null && receipt === null) throw new CutoverError('CUTOVER_RECOVERY_NOT_REQUIRED')
    const operation = journal?.operation ?? receipt!.operation
    const fingerprint = journal?.fingerprint ?? receipt!.fingerprint
    if (receipt !== null && (receipt.operation !== operation || receipt.fingerprint !== fingerprint)) {
      throw new CutoverError('CUTOVER_RECOVERY_EVIDENCE_INVALID')
    }
    if (journal !== null && receipt !== null &&
        canonicalJson(journal.acceptedPreview) !== canonicalJson(receipt.acceptedPreview)) {
      throw new CutoverError('CUTOVER_RECOVERY_EVIDENCE_INVALID')
    }
    const evidence = await this.#inspectReadOnly(request.requestId)
    const allowedDesired = journal === null
      ? terminalAuthorityForReceipt(receipt!.receipt) === null
        ? []
        : [terminalAuthorityForReceipt(receipt!.receipt)!]
      : allowedDesiredForJournal(journal, evidence)
    return { operation, fingerprint, journal, receipt, allowedDesired }
  }

  async #replayTerminalRecovery(
    binding: RecoveryBinding,
    request: CutoverRecoveryRequest,
    scope: HostMutationOperationScope
  ): Promise<OperationExecutionResult> {
    const journal = binding.journal
    const stored = binding.receipt
    if (journal === null || stored === null || journal.phase !== 'terminal' ||
        journal.terminalDesired !== request.desired ||
        terminalAuthorityForReceipt(stored.receipt) !== request.desired) {
      throw new CutoverError('CUTOVER_RECOVERY_EVIDENCE_INVALID')
    }
    const evidence = await this.#inspect(scope, request.requestId)
    assertTerminal(request.desired, evidence)
    const state = await this.#readState()
    if (!stateMatchesReceipt(state, stored.receipt, request.desired)) {
      throw new CutoverError('CUTOVER_RECOVERY_EVIDENCE_INVALID')
    }
    return {
      receipt: withReused(stored.receipt),
      terminalJournal: journal
    }
  }

  async #replayReceiptOnlyRecovery(
    binding: RecoveryBinding,
    request: CutoverRecoveryRequest,
    scope: HostMutationOperationScope
  ): Promise<OperationExecutionResult> {
    const stored = binding.receipt
    if (stored === null || terminalAuthorityForReceipt(stored.receipt) !== request.desired) {
      throw new CutoverError('CUTOVER_RECOVERY_EVIDENCE_INVALID')
    }
    const evidence = await this.#inspect(scope, request.requestId)
    assertTerminal(request.desired, evidence)
    // A receipt-only crash happened after the terminal journal was cleared but
    // before broker release. The exact receipt operation remains the recovery
    // broker binding; there is no journal left to acknowledge after release.
    const state = await this.#readState()
    if (!stateMatchesReceipt(state, stored.receipt, request.desired)) {
      throw new CutoverError('CUTOVER_RECOVERY_EVIDENCE_INVALID')
    }
    return {
      receipt: withReused(stored.receipt),
      terminalJournal: null
    }
  }

  async #recoverWhenBrokerAlreadyClean(request: CutoverRecoveryRequest): Promise<CutoverReceipt> {
    const binding = await this.#readRecoveryBinding(request)
    if (!binding.allowedDesired.includes(request.desired) || binding.receipt === null) {
      throw new CutoverError('CUTOVER_RECOVERY_EVIDENCE_INVALID')
    }
    const evidence = await this.#inspectReadOnly(request.requestId)
    assertTerminal(request.desired, evidence)
    const state = await this.#readState()
    if (!stateMatchesReceipt(state, binding.receipt.receipt, request.desired)) {
      throw new CutoverError('CUTOVER_RECOVERY_EVIDENCE_INVALID')
    }
    if (binding.journal !== null) {
      if (binding.journal.phase !== 'terminal' || binding.journal.terminalDesired !== request.desired) {
        throw new CutoverError('CUTOVER_RECOVERY_EVIDENCE_INVALID')
      }
      await this.#clearTerminalJournal(binding.journal)
    }
    return withReused(binding.receipt.receipt)
  }

  async #runOrdinary(
    operation: CutoverOperation,
    requestId: string,
    execute: (context: OrdinaryContext) => Promise<OperationExecutionResult>
  ): Promise<CutoverReceipt> {
    const coordinator = this.#hostMutationCoordinator
    if (coordinator === null) throw new CutoverError('CUTOVER_HOST_LEASE_UNAVAILABLE')
    try {
      const result = await coordinator.runExclusive({
        operation: hostOperation(operation),
        requestId
      }, async (scope) => {
        let journalStarted = false
        const context: OrdinaryContext = {
          scope,
          markJournalStarted: () => { journalStarted = true }
        }
        try {
          scope.assertActive()
          const executed = await execute(context)
          scope.assertActive()
          return hostMutationReturn(executed, 'release')
        } catch (error) {
          if (error instanceof HostMutationLeaseError) throw error
          return hostMutationThrow<OperationExecutionResult>(
            normalizeError(error),
            journalStarted ? 'abandon' : 'release'
          )
        }
      })
      if (result.terminalJournal !== null) {
        await this.#clearTerminalJournal(result.terminalJournal).catch(() => undefined)
      }
      return result.receipt
    } catch (error) {
      throw mapCoordinatorError(error)
    }
  }

  async #terminalResultFromReplay(
    receipt: CutoverReceipt,
    operation: CutoverOperation,
    fingerprint: string,
    planFingerprint?: string
  ): Promise<OperationExecutionResult> {
    const journal = await this.#readJournal()
    if (journal === null) return { receipt, terminalJournal: null }
    if (journal.requestId !== receipt.requestId || journal.operation !== operation ||
        journal.fingerprint !== fingerprint || journal.phase !== 'terminal' ||
        (planFingerprint !== undefined &&
          journal.acceptedPreview?.planFingerprint !== planFingerprint)) {
      throw new CutoverError('CUTOVER_RECOVERY_EVIDENCE_INVALID')
    }
    return { receipt, terminalJournal: journal }
  }

  async #commitTerminal(
    journal: CutoverJournal,
    nextState: CutoverStoredState,
    receipt: CutoverReceipt,
    scope: HostMutationOperationScope
  ): Promise<OperationExecutionResult> {
    scope.assertActive()
    const terminalJournal = nextJournal(journal, 'terminal', {
      terminalDesired: nextState.authority,
      evidence: receipt.summary
    })
    const envelope: CutoverStoredReceipt = {
      format: 'dyson-control-cutover-receipt-envelope',
      schemaVersion: 1,
      authorityInventoryRevision: this.#authorityInventoryRevision,
      fingerprint: journal.fingerprint,
      acceptedPreview: journal.acceptedPreview,
      operation: journal.operation,
      receipt
    }
    try {
      await this.#store.commitTerminal({
        expectedSequence: journal.sequence,
        journal: terminalJournal,
        nextState,
        receipt: envelope
      })
    } catch (error) {
      throw new CutoverError('CUTOVER_DURABLE_STORE_FAILED', { cause: error })
    }
    scope.assertActive()
    return { receipt, terminalJournal }
  }

  async #createJournal(journal: CutoverJournal, scope: HostMutationOperationScope): Promise<void> {
    scope.assertActive()
    try {
      await this.#store.createJournal(journal)
    } catch (error) {
      throw new CutoverError('CUTOVER_DURABLE_STORE_FAILED', { cause: error })
    }
    scope.assertActive()
  }

  async #advanceJournal(
    journal: CutoverJournal,
    phase: CutoverJournalPhase,
    patch: Partial<Pick<CutoverJournal,
      'baselineSaveProtected' | 'baselineRestored' | 'currentProgressProtected' | 'possibleLiveMutation' |
      'terminalDesired' | 'evidence' | 'authorityMutation'>>,
    scope: HostMutationOperationScope
  ): Promise<CutoverJournal> {
    const next = nextJournal(journal, phase, patch)
    scope.assertActive()
    try {
      await this.#store.replaceJournal(journal.sequence, next)
    } catch (error) {
      throw new CutoverError('CUTOVER_DURABLE_STORE_FAILED', { cause: error })
    }
    scope.assertActive()
    return next
  }

  async #clearTerminalJournal(journal: CutoverJournal): Promise<void> {
    if (journal.phase !== 'terminal') throw new CutoverError('CUTOVER_RECOVERY_EVIDENCE_INVALID')
    try {
      await this.#store.clearTerminalJournal({
        requestId: journal.requestId,
        fingerprint: journal.fingerprint,
        expectedSequence: journal.sequence
      })
    } catch (error) {
      throw new CutoverError('CUTOVER_DURABLE_STORE_FAILED', { cause: error })
    }
  }

  async #applyAuthorityMutation(
    journal: CutoverJournal,
    method: CutoverAuthorityMutationMethod,
    scope: HostMutationOperationScope
  ): Promise<CutoverJournal> {
    if (authorityMutationNeedsRecovery(journal.authorityMutation)) {
      throw new CutoverError('CUTOVER_RECOVERY_REQUIRED')
    }
    const attempt = journal.authorityMutation.attempt + 1
    if (attempt > 64) throw new CutoverError('CUTOVER_RECOVERY_EVIDENCE_INVALID')
    const invocation: CutoverAuthorityMutationInvocation = {
      childRequestId: randomUUID(),
      attempt,
      mode: authorityMutationModeForMethod(method),
      recovery: false
    }
    let current = await this.#advanceJournal(journal, journal.phase, {
      authorityMutation: {
        phase: 'intent-persisted',
        method,
        mode: invocation.mode,
        childRequestId: invocation.childRequestId,
        attempt,
        state: 'pending',
        receiptDigest: null
      }
    }, scope)
    const result = await this.#invokeAuthorityMutation(
      current.requestId,
      method,
      invocation,
      scope
    )
    current = await this.#persistAuthorityMutationResult(current, result, scope)
    if (result.status !== 'succeeded') {
      throw new CutoverError('CUTOVER_RECOVERY_REQUIRED')
    }
    return current
  }

  async #recoverAuthorityMutation(
    journal: CutoverJournal,
    scope: HostMutationOperationScope
  ): Promise<CutoverJournal> {
    const transaction = journal.authorityMutation
    if (!authorityMutationNeedsRecovery(transaction) || transaction.childRequestId === null) {
      throw new CutoverError('CUTOVER_RECOVERY_EVIDENCE_INVALID')
    }
    const invocation: CutoverAuthorityMutationInvocation = {
      childRequestId: transaction.childRequestId,
      attempt: transaction.attempt,
      mode: transaction.mode,
      recovery: true
    }
    const result = await this.#invokeAuthorityMutation(
      journal.requestId,
      transaction.method,
      invocation,
      scope
    )
    if (transaction.receiptDigest !== null && result.receiptDigest !== transaction.receiptDigest) {
      throw new CutoverError('CUTOVER_RECOVERY_EVIDENCE_INVALID')
    }
    const current = await this.#persistAuthorityMutationResult(journal, result, scope)
    if (result.status === 'recovery-required') {
      throw new CutoverError('CUTOVER_RECOVERY_REQUIRED')
    }
    return current
  }

  async #invokeAuthorityMutation(
    requestId: string,
    method: CutoverAuthorityMutationMethod,
    invocation: CutoverAuthorityMutationInvocation,
    scope: HostMutationOperationScope
  ): Promise<CutoverAuthorityMutationResult> {
    const rawResult = await this.#mutate(scope, requestId, async (requestContext) => {
      const request = { ...requestContext, authorityMutation: invocation }
      if (method === 'defineCandidateDisabled') {
        return await this.#adapter.defineCandidateDisabled(request)
      }
      if (method === 'enableCandidateAuthority') {
        return await this.#adapter.enableCandidateAuthority(request)
      }
      return await this.#adapter.disableCandidateAuthority(request)
    })
    const parsed = authorityMutationResultSchema.safeParse(rawResult)
    if (!parsed.success) {
      throw new CutoverError(invocation.recovery
        ? 'CUTOVER_RECOVERY_EVIDENCE_INVALID'
        : 'CUTOVER_ADAPTER_FAILED')
    }
    return parsed.data
  }

  async #persistAuthorityMutationResult(
    journal: CutoverJournal,
    result: CutoverAuthorityMutationResult,
    scope: HostMutationOperationScope
  ): Promise<CutoverJournal> {
    return await this.#advanceJournal(journal, journal.phase, {
      authorityMutation: {
        ...journal.authorityMutation,
        phase: 'receipt-persisted',
        state: result.status,
        receiptDigest: result.receiptDigest
      }
    }, scope)
  }

  async #restoreActivationBaseline(
    journal: CutoverJournal,
    evidence: CutoverHostEvidence,
    scope: HostMutationOperationScope
  ): Promise<CutoverJournal> {
    if (!journal.baselineSaveProtected || evidence.processState !== 'none' ||
        evidence.portState !== 'closed') {
      throw new CutoverError('CUTOVER_SAVE_RESTORE_FAILED')
    }
    const activationRequestId = journal.operation === 'activate'
      ? journal.requestId
      : journal.baseState.lastActivationRequestId
    if (activationRequestId === null) throw new CutoverError('CUTOVER_SAVE_RESTORE_FAILED')
    let current = await this.#advanceJournal(journal, 'baseline-restore-intent', {}, scope)
    const restored = await this.#mutate(scope, journal.requestId, (requestContext) =>
      this.#adapter.restoreActivationBaseline({ ...requestContext, activationRequestId }))
    if (restored.pairRestored !== true || restored.durable !== true) {
      throw new CutoverError('CUTOVER_SAVE_RESTORE_FAILED')
    }
    current = await this.#advanceJournal(current, 'baseline-restored', {
      baselineRestored: true,
      evidence: summarizeEvidence(
        evidence,
        current.baselineSaveProtected,
        current.currentProgressProtected,
        true
      )
    }, scope)
    return current
  }

  async #mutate<T>(
    scope: HostMutationOperationScope,
    requestId: string,
    action: (request: {
      requestId: string
      signal: AbortSignal
      hostMutation: HostMutationOperationScope
    }) => Promise<T>
  ): Promise<T> {
    scope.assertActive()
    try {
      const result = await action({ requestId, signal: scope.signal, hostMutation: scope })
      scope.assertActive()
      return result
    } catch (error) {
      if (error instanceof HostMutationLeaseError || error instanceof CutoverError) throw error
      throw new CutoverError('CUTOVER_ADAPTER_FAILED', { cause: error })
    }
  }

  async #inspect(scope: HostMutationOperationScope, requestId: string): Promise<CutoverHostEvidence> {
    scope.assertActive()
    try {
      const evidence = evidenceSchema.parse(await this.#adapter.inspect({ requestId, signal: scope.signal }))
      scope.assertActive()
      assertKnownEvidence(evidence)
      return evidence
    } catch (error) {
      if (error instanceof HostMutationLeaseError || error instanceof CutoverError) throw error
      throw new CutoverError('CUTOVER_RECOVERY_EVIDENCE_INVALID', { cause: error })
    }
  }

  async #inspectReadOnly(requestId: string): Promise<CutoverHostEvidence> {
    const controller = new AbortController()
    try {
      const evidence = evidenceSchema.parse(await this.#adapter.inspect({
        requestId,
        signal: controller.signal
      }))
      assertKnownEvidence(evidence)
      return evidence
    } catch (error) {
      if (error instanceof CutoverError) throw error
      throw new CutoverError('CUTOVER_RECOVERY_EVIDENCE_INVALID', { cause: error })
    }
  }

  async #readState(): Promise<CutoverStoredState> {
    try {
      const state = stateSchema.parse(await this.#store.readState())
      if (state.authorityInventoryRevision !== this.#authorityInventoryRevision) {
        throw new CutoverError('CUTOVER_AUTHORITY_DRIFT')
      }
      return state
    } catch (error) {
      if (error instanceof CutoverError) throw error
      throw new CutoverError('CUTOVER_DURABLE_STATE_INVALID', { cause: error })
    }
  }

  async #readJournal(): Promise<CutoverJournal | null> {
    let value: unknown | null
    try {
      value = await this.#store.readJournal()
    } catch (error) {
      throw new CutoverError('CUTOVER_DURABLE_STORE_FAILED', { cause: error })
    }
    if (value === null) return null
    try {
      const journal = journalSchema.parse(value)
      if (journal.authorityInventoryRevision !== this.#authorityInventoryRevision) {
        throw new CutoverError('CUTOVER_AUTHORITY_DRIFT')
      }
      return journal
    } catch (error) {
      if (error instanceof CutoverError) throw error
      throw new CutoverError('CUTOVER_RECOVERY_EVIDENCE_INVALID', { cause: error })
    }
  }

  async #readStoredReceipt(requestId: string): Promise<CutoverStoredReceipt | null> {
    let value: unknown | null
    try {
      value = await this.#store.readReceipt(requestId)
    } catch (error) {
      throw new CutoverError('CUTOVER_DURABLE_STORE_FAILED', { cause: error })
    }
    if (value === null) return null
    try {
      const parsed = storedReceiptSchema.parse(value)
      if (parsed.receipt.requestId !== requestId ||
          parsed.authorityInventoryRevision !== this.#authorityInventoryRevision) {
        throw new CutoverError('CUTOVER_AUTHORITY_DRIFT')
      }
      return parsed
    } catch (error) {
      if (error instanceof CutoverError) throw error
      throw new CutoverError('CUTOVER_RECOVERY_EVIDENCE_INVALID', { cause: error })
    }
  }

  async #readReplay(
    requestId: string,
    operation: CutoverOperation,
    fingerprint: string,
    planFingerprint?: string
  ): Promise<CutoverReceipt | null> {
    const stored = await this.#readStoredReceipt(requestId)
    if (stored === null) return null
    if (stored.operation !== operation || stored.fingerprint !== fingerprint ||
        (planFingerprint !== undefined &&
          stored.acceptedPreview?.planFingerprint !== planFingerprint)) {
      throw new CutoverError('CUTOVER_IDEMPOTENCY_CONFLICT')
    }
    return withReused(stored.receipt)
  }

  async #assertNoPendingJournal(): Promise<void> {
    if (await this.#readJournal() !== null) throw new CutoverError('CUTOVER_RECOVERY_REQUIRED')
  }
}

function parsePrepareRequest(input: unknown): CutoverPrepareRequest {
  const parsed = z.strictObject({
    requestId: requestIdSchema,
    planFingerprint: sha256Schema,
    confirmation: z.literal(PREPARE_GSMANAGER_TO_DYSON)
  }).safeParse(input)
  if (parsed.success) return parsed.data
  const confirmationProbe = z.strictObject({
    requestId: requestIdSchema,
    planFingerprint: z.unknown().optional(),
    confirmation: z.unknown().optional()
  }).safeParse(input)
  if (confirmationProbe.success &&
      confirmationProbe.data.confirmation !== PREPARE_GSMANAGER_TO_DYSON) {
    throw new CutoverError('CUTOVER_CONFIRMATION_REQUIRED')
  }
  if (confirmationProbe.success && confirmationProbe.data.planFingerprint === undefined) {
    throw new CutoverError('CUTOVER_PREVIEW_REQUIRED')
  }
  throw new CutoverError('CUTOVER_REQUEST_INVALID')
}

function parseActivateRequest(input: unknown): CutoverActivateRequest {
  const parsed = z.strictObject({
    requestId: requestIdSchema,
    planFingerprint: sha256Schema,
    confirmation: z.literal(ACTIVATE_GSMANAGER_TO_DYSON)
  }).safeParse(input)
  if (!parsed.success) {
    const probe = z.strictObject({
      requestId: requestIdSchema,
      planFingerprint: z.unknown().optional(),
      confirmation: z.unknown().optional()
    }).safeParse(input)
    if (probe.success && probe.data.confirmation !== ACTIVATE_GSMANAGER_TO_DYSON) {
      throw new CutoverError('CUTOVER_CONFIRMATION_REQUIRED')
    }
    if (probe.success && probe.data.planFingerprint === undefined) {
      throw new CutoverError('CUTOVER_PREVIEW_REQUIRED')
    }
    throw new CutoverError('CUTOVER_REQUEST_INVALID')
  }
  return parsed.data
}

function parseRollbackRequest(input: unknown): CutoverRollbackRequest {
  const parsed = z.strictObject({
    requestId: requestIdSchema,
    mode: rollbackModeSchema,
    planFingerprint: sha256Schema,
    confirmation: z.literal(ROLLBACK_DYSON_TO_GSMANAGER)
  }).safeParse(input)
  if (!parsed.success) {
    const probe = z.strictObject({
      requestId: requestIdSchema,
      mode: rollbackModeSchema,
      planFingerprint: z.unknown().optional(),
      confirmation: z.unknown().optional()
    }).safeParse(input)
    if (probe.success && probe.data.confirmation !== ROLLBACK_DYSON_TO_GSMANAGER) {
      throw new CutoverError('CUTOVER_ROLLBACK_CONFIRMATION_REQUIRED')
    }
    if (probe.success && probe.data.planFingerprint === undefined) {
      throw new CutoverError('CUTOVER_PREVIEW_REQUIRED')
    }
    throw new CutoverError('CUTOVER_REQUEST_INVALID')
  }
  return parsed.data
}

function parsePreviewRequest(input: unknown): CutoverPreviewRequest {
  const parsed = z.discriminatedUnion('operation', [
    z.strictObject({ requestId: requestIdSchema, operation: z.literal('prepare') }),
    z.strictObject({ requestId: requestIdSchema, operation: z.literal('activate') }),
    z.strictObject({
      requestId: requestIdSchema,
      operation: z.literal('rollback'),
      mode: rollbackModeSchema
    })
  ]).safeParse(input)
  if (!parsed.success) throw new CutoverError('CUTOVER_REQUEST_INVALID')
  return parsed.data
}

function parseRecoveryRequest(input: unknown): CutoverRecoveryRequest {
  const parsed = z.strictObject({ requestId: requestIdSchema, desired: authoritySchema }).safeParse(input)
  if (!parsed.success) throw new CutoverError('CUTOVER_REQUEST_INVALID')
  return parsed.data
}

function createState(
  authorityInventoryRevision: string,
  input: Omit<CutoverStoredState,
    'format' | 'schemaVersion' | 'authorityInventoryRevision' | 'revision'>
): CutoverStoredState {
  const base = {
    format: 'dyson-control-cutover-state' as const,
    schemaVersion: 1 as const,
    authorityInventoryRevision,
    ...input
  }
  return { ...base, revision: computeRevision(base) }
}

function createJournal(input: Omit<CutoverJournal,
  'format' | 'schemaVersion' | 'sequence' | 'possibleLiveMutation' | 'terminalDesired' |
  'baselineRestored' | 'authorityMutation'> & {
    possibleLiveMutation?: boolean
    terminalDesired?: CutoverAuthority | null
    baselineRestored?: boolean
    authorityMutation?: CutoverJournal['authorityMutation']
  }): CutoverJournal {
  const journal: CutoverJournal = {
    format: 'dyson-control-cutover-journal',
    schemaVersion: 1,
    sequence: 0,
    possibleLiveMutation: input.possibleLiveMutation ?? false,
    terminalDesired: input.terminalDesired ?? null,
    baselineRestored: input.baselineRestored ?? false,
    authorityMutation: input.authorityMutation ?? initialAuthorityMutation(input.operation),
    ...input
  }
  return journalSchema.parse(journal)
}

function nextJournal(
  journal: CutoverJournal,
  phase: CutoverJournalPhase,
  patch: Partial<Pick<CutoverJournal,
    'baselineSaveProtected' | 'baselineRestored' | 'currentProgressProtected' | 'possibleLiveMutation' |
    'terminalDesired' | 'evidence' | 'authorityMutation'>>
): CutoverJournal {
  return journalSchema.parse({
    ...journal,
    ...patch,
    phase,
    sequence: journal.sequence + 1
  })
}

function createReceipt(input: {
  requestId: string
  phase: CutoverPublicPhase
  status: CutoverPublicStatus
  evidence: CutoverHostEvidence
  saveProtected: boolean
  baselineRestored?: boolean
  currentProgressProtected: boolean
  errorCode?: CutoverErrorCode | null
}): CutoverReceipt {
  return receiptSchema.parse({
    requestId: input.requestId,
    phase: input.phase,
    status: input.status,
    allowedDesired: [],
    summary: summarizeEvidence(
      input.evidence,
      input.saveProtected,
      input.currentProgressProtected,
      input.baselineRestored ?? false
    ),
    errorCode: input.errorCode ?? null
  })
}

function withReused(receipt: CutoverReceipt): CutoverReceipt {
  return { ...receipt, summary: { ...receipt.summary, reused: true } }
}

function summarizeEvidence(
  evidence: CutoverHostEvidence,
  saveProtected: boolean,
  currentProgressProtected: boolean,
  baselineRestored = false
): CutoverPublicSummary {
  return {
    candidateDefined: evidence.candidateDefined,
    candidateDisabled: evidence.candidateDefined && !evidence.candidateEnabled,
    previousAuthorityEnabled: evidence.previousEnabled,
    candidateAuthorityEnabled: evidence.candidateEnabled,
    previousRuntimeHealthy: evidence.previousHealthy,
    candidateRuntimeHealthy: evidence.candidateHealthy,
    processesStopped: evidence.processState === 'none',
    portClosed: evidence.portState === 'closed',
    uniqueAuthority: !evidence.unexpectedAuthorityPresent &&
      evidence.previousEnabled !== evidence.candidateEnabled,
    saveProtected,
    baselineRestored,
    currentProgressProtected,
    reused: false
  }
}

function emptySummary(): CutoverPublicSummary {
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

function assertKnownEvidence(evidence: CutoverHostEvidence): void {
  if (evidence.unexpectedAuthorityPresent || evidence.processState === 'unknown' ||
      evidence.portState === 'unknown' || evidence.processState === 'both' ||
      (evidence.previousEnabled && evidence.candidateEnabled)) {
    throw new CutoverError('CUTOVER_AUTHORITY_DRIFT')
  }
  if (evidence.previousEnabled && !evidence.previousDefined) throw new CutoverError('CUTOVER_AUTHORITY_DRIFT')
  if (evidence.candidateEnabled && !evidence.candidateDefined) throw new CutoverError('CUTOVER_AUTHORITY_DRIFT')
  const runtimeCoherent = evidence.processState === 'none'
    ? evidence.portState === 'closed' && !evidence.previousHealthy && !evidence.candidateHealthy
    : evidence.processState === 'previous-only'
      ? evidence.portState === 'previous' && evidence.previousHealthy && !evidence.candidateHealthy
      : evidence.processState === 'candidate-only'
        ? evidence.portState === 'candidate' && evidence.candidateHealthy && !evidence.previousHealthy
        : false
  if (!runtimeCoherent) throw new CutoverError('CUTOVER_RUNTIME_DRIFT')
}

function assertReachableEvidence(evidence: CutoverHostEvidence): void {
  assertKnownEvidence(evidence)
  const reachable = isPreviousTerminal(evidence) || isCandidateTerminal(evidence) ||
    (!evidence.previousEnabled && !evidence.candidateEnabled) ||
    (evidence.previousEnabled && !evidence.candidateEnabled &&
      (evidence.processState === 'none' || evidence.processState === 'previous-only')) ||
    (!evidence.previousEnabled && evidence.candidateEnabled &&
      (evidence.processState === 'none' || evidence.processState === 'candidate-only'))
  if (!reachable) throw new CutoverError('CUTOVER_AUTHORITY_DRIFT')
}

function assertCandidateDefinedDisabled(evidence: CutoverHostEvidence): void {
  if (!evidence.candidateDefined || evidence.candidateEnabled) {
    throw new CutoverError('CUTOVER_NOT_PREPARED')
  }
}

function isPreviousPreparationBaseline(evidence: CutoverHostEvidence): boolean {
  return evidence.previousDefined && evidence.previousEnabled && !evidence.candidateEnabled &&
    !evidence.unexpectedAuthorityPresent && (
      (evidence.processState === 'previous-only' && evidence.portState === 'previous' &&
        evidence.previousHealthy && !evidence.candidateHealthy) ||
      (evidence.processState === 'none' && evidence.portState === 'closed' &&
        !evidence.previousHealthy && !evidence.candidateHealthy)
    )
}

function assertPreviousPreparationBaseline(evidence: CutoverHostEvidence): void {
  assertKnownEvidence(evidence)
  if (!isPreviousPreparationBaseline(evidence)) {
    throw new CutoverError('CUTOVER_PREPARE_INVARIANT_FAILED')
  }
}

function assertPrepareRecoveryRuntimePreserved(
  journal: CutoverJournal,
  evidence: CutoverHostEvidence
): boolean {
  assertPreviousPreparationBaseline(evidence)
  const expectedStopped = journal.evidence.processesStopped && journal.evidence.portClosed &&
    !journal.evidence.previousRuntimeHealthy
  const expectedRunning = !journal.evidence.processesStopped && !journal.evidence.portClosed &&
    journal.evidence.previousRuntimeHealthy
  if (expectedStopped && evidence.processState === 'none' && evidence.portState === 'closed') return true
  if (expectedRunning && evidence.processState === 'previous-only' && evidence.portState === 'previous' &&
      evidence.previousHealthy) return false
  throw new CutoverError('CUTOVER_RECOVERY_EVIDENCE_INVALID')
}

function isPreviousTerminal(evidence: CutoverHostEvidence): boolean {
  return evidence.previousDefined && evidence.previousEnabled && !evidence.candidateEnabled &&
    !evidence.unexpectedAuthorityPresent && evidence.processState === 'previous-only' &&
    evidence.portState === 'previous' && evidence.previousHealthy && !evidence.candidateHealthy
}

function assertPreviousTerminal(evidence: CutoverHostEvidence): void {
  assertKnownEvidence(evidence)
  if (!isPreviousTerminal(evidence)) throw new CutoverError('CUTOVER_UNIQUE_AUTHORITY_FAILED')
}

function isCandidateTerminal(evidence: CutoverHostEvidence): boolean {
  return evidence.candidateDefined && evidence.candidateEnabled && !evidence.previousEnabled &&
    !evidence.unexpectedAuthorityPresent && evidence.processState === 'candidate-only' &&
    evidence.portState === 'candidate' && evidence.candidateHealthy && !evidence.previousHealthy
}

function assertCandidateTerminal(evidence: CutoverHostEvidence): void {
  assertKnownEvidence(evidence)
  if (!isCandidateTerminal(evidence)) throw new CutoverError('CUTOVER_UNIQUE_AUTHORITY_FAILED')
}

function assertTerminal(authority: CutoverAuthority, evidence: CutoverHostEvidence): void {
  if (authority === 'candidate') assertCandidateTerminal(evidence)
  else assertPreviousTerminal(evidence)
}

function assertPreviousRunningWithAuthoritiesDisabled(evidence: CutoverHostEvidence): void {
  assertKnownEvidence(evidence)
  if (evidence.previousEnabled || evidence.candidateEnabled ||
      evidence.processState !== 'previous-only' || evidence.portState !== 'previous') {
    throw new CutoverError('CUTOVER_AUTHORITY_DRIFT')
  }
}

function assertCandidateRunningWithAuthoritiesDisabled(evidence: CutoverHostEvidence): void {
  assertKnownEvidence(evidence)
  if (evidence.previousEnabled || evidence.candidateEnabled ||
      evidence.processState !== 'candidate-only' || evidence.portState !== 'candidate') {
    throw new CutoverError('CUTOVER_AUTHORITY_DRIFT')
  }
}

function assertStoppedWithAuthoritiesDisabled(evidence: CutoverHostEvidence): void {
  assertKnownEvidence(evidence)
  if (evidence.previousEnabled || evidence.candidateEnabled ||
      evidence.processState !== 'none' || evidence.portState !== 'closed') {
    throw new CutoverError('CUTOVER_STOP_GATE_FAILED')
  }
}

function assertCandidateEnabledAndStopped(evidence: CutoverHostEvidence): void {
  assertKnownEvidence(evidence)
  if (evidence.previousEnabled || !evidence.candidateEnabled ||
      evidence.processState !== 'none' || evidence.portState !== 'closed') {
    throw new CutoverError('CUTOVER_STOP_GATE_FAILED')
  }
}

function assertPreviousEnabledAndStopped(evidence: CutoverHostEvidence): void {
  assertKnownEvidence(evidence)
  if (!evidence.previousEnabled || evidence.candidateEnabled ||
      evidence.processState !== 'none' || evidence.portState !== 'closed') {
    throw new CutoverError('CUTOVER_STOP_GATE_FAILED')
  }
}

function samePreviousAuthorityAndRuntime(left: CutoverHostEvidence, right: CutoverHostEvidence): boolean {
  return left.previousDefined === right.previousDefined &&
    left.previousEnabled === right.previousEnabled &&
    left.unexpectedAuthorityPresent === right.unexpectedAuthorityPresent &&
    left.processState === right.processState && left.portState === right.portState &&
    left.previousHealthy === right.previousHealthy &&
    left.candidateHealthy === right.candidateHealthy
}

function assertSucceededAuthorityMutationEvidence(
  transaction: CutoverJournal['authorityMutation'],
  evidence: CutoverHostEvidence
): void {
  if (transaction.phase !== 'receipt-persisted' || transaction.state !== 'succeeded') return
  const matches = transaction.method === 'defineCandidateDisabled'
    ? evidence.candidateDefined && !evidence.candidateEnabled
    : transaction.method === 'enableCandidateAuthority'
      ? evidence.candidateDefined && evidence.candidateEnabled
      : !evidence.candidateEnabled
  if (!matches) throw new CutoverError('CUTOVER_RECOVERY_EVIDENCE_INVALID')
}

function allowedDesiredForJournal(
  journal: CutoverJournal,
  evidence: CutoverHostEvidence
): CutoverDesiredAuthority[] {
  try {
    assertReachableEvidence(evidence)
    assertSucceededAuthorityMutationEvidence(journal.authorityMutation, evidence)
  } catch {
    return []
  }
  if (journal.phase === 'terminal') return journal.terminalDesired === null ? [] : [journal.terminalDesired]
  if (journal.operation === 'prepare') return ['previous']
  if (journal.operation === 'activate') {
    return journal.baselineSaveProtected ? ['candidate', 'previous'] : ['previous']
  }
  if (journal.operation === 'rollback-immediate') return ['candidate', 'previous']
  return journal.currentProgressProtected ? ['candidate', 'previous'] : ['candidate']
}

function canRecoverPrevious(journal: CutoverJournal): boolean {
  if (journal.operation === 'prepare') return true
  if (journal.operation === 'activate') {
    return !journal.possibleLiveMutation || journal.baselineSaveProtected
  }
  if (journal.operation === 'rollback-immediate') return journal.baselineSaveProtected
  return journal.currentProgressProtected
}

function terminalAuthorityForReceipt(receipt: CutoverReceipt): CutoverAuthority | null {
  if (receipt.phase === 'activated' || receipt.phase === 'recovered-candidate') return 'candidate'
  if (receipt.phase === 'prepared' || receipt.phase === 'rolled-back-immediate' ||
      receipt.phase === 'rolled-back-later' || receipt.phase === 'recovered-previous') return 'previous'
  return null
}

function stateMatchesReceipt(
  state: CutoverStoredState,
  receipt: CutoverReceipt,
  desired: CutoverAuthority
): boolean {
  const prepared = !(receipt.phase === 'recovered-previous' && !receipt.summary.candidateDefined)
  return state.authority === desired && state.prepared === prepared &&
    state.authorityInventoryRevision.length === 64
}

function hostOperation(operation: CutoverOperation): string {
  return `gsmanager-cutover-${operation}`
}

function rollbackModeForOperation(operation: CutoverOperation): CutoverRollbackMode | null {
  return operation === 'rollback-immediate'
    ? 'immediate-compensation'
    : operation === 'rollback-later'
      ? 'later-operator-rollback'
      : null
}

function authorityMutationMethodForOperation(
  operation: CutoverOperation
): CutoverAuthorityMutationMethod {
  if (operation === 'prepare') return 'defineCandidateDisabled'
  if (operation === 'activate') return 'enableCandidateAuthority'
  return 'disableCandidateAuthority'
}

function authorityMutationModeForMethod(
  method: CutoverAuthorityMutationMethod
): CutoverJournal['authorityMutation']['mode'] {
  return method === 'enableCandidateAuthority' ? 'Activate' : 'PrepareDisabled'
}

function authorityMutationNeedsRecovery(
  transaction: CutoverJournal['authorityMutation']
): boolean {
  return (transaction.phase === 'intent-persisted' && transaction.state === 'pending') ||
    (transaction.phase === 'receipt-persisted' && transaction.state === 'recovery-required')
}

function initialAuthorityMutation(operation: CutoverOperation): CutoverJournal['authorityMutation'] {
  const method = authorityMutationMethodForOperation(operation)
  return {
    phase: 'not-started',
    method,
    mode: authorityMutationModeForMethod(method),
    childRequestId: null,
    attempt: 0,
    state: 'idle',
    receiptDigest: null
  }
}

function publicOperationFor(operation: CutoverOperation): CutoverPreviewReceipt['operation'] {
  return operation === 'rollback-immediate' || operation === 'rollback-later'
    ? 'rollback'
    : operation
}

function receiptPhaseStatusCoherent(receipt: CutoverReceipt): boolean {
  if (receipt.phase === 'prepared' || receipt.phase === 'activated' ||
      receipt.phase === 'recovered-candidate') {
    return receipt.status === 'succeeded'
  }
  if (receipt.phase === 'rolled-back-immediate' || receipt.phase === 'rolled-back-later') {
    return receipt.status === 'rolled-back'
  }
  return receipt.status === 'succeeded' || receipt.status === 'rolled-back'
}

function assertPreviewPreconditions(
  request: CutoverPreviewRequest,
  state: CutoverStoredState,
  evidence: CutoverHostEvidence
): void {
  if (request.operation === 'prepare') {
    if (state.authority !== 'previous') throw new CutoverError('CUTOVER_NOT_CANDIDATE_ACTIVE')
    assertPreviousPreparationBaseline(evidence)
    if (evidence.candidateEnabled) throw new CutoverError('CUTOVER_AUTHORITY_DRIFT')
    return
  }
  if (request.operation === 'activate') {
    if (!state.prepared || state.authority !== 'previous') {
      throw new CutoverError('CUTOVER_NOT_PREPARED')
    }
    assertPreviousTerminal(evidence)
    assertCandidateDefinedDisabled(evidence)
    return
  }
  if (!state.prepared || state.authority !== 'candidate' ||
      !state.activationBaselineProtected || state.lastActivationRequestId === null) {
    throw new CutoverError('CUTOVER_NOT_CANDIDATE_ACTIVE')
  }
  assertCandidateTerminal(evidence)
}

function summarizePreview(
  request: CutoverPreviewRequest,
  state: CutoverStoredState,
  evidence: CutoverHostEvidence
): CutoverPublicSummary {
  return summarizeEvidence(
    evidence,
    request.operation === 'rollback' && state.activationBaselineProtected,
    false
  )
}

function planRevisionFor(request: CutoverPreviewRequest): string {
  if (request.operation === 'prepare') return 'prepare-disabled-candidate-v1'
  if (request.operation === 'activate') return 'protect-save-switch-candidate-v1'
  return request.mode === 'immediate-compensation'
    ? 'restore-baseline-switch-previous-v1'
    : 'protect-progress-switch-previous-v1'
}

function computeEvidenceDigest(evidence: CutoverHostEvidence): string {
  return createHash('sha256').update(canonicalJson({
    format: 'dyson-control-cutover-host-evidence',
    schemaVersion: 1,
    evidence
  })).digest('hex')
}

function sameSha256(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex')
  const rightBytes = Buffer.from(right, 'hex')
  return leftBytes.length === 32 && rightBytes.length === 32 &&
    timingSafeEqual(leftBytes, rightBytes)
}

function operationFingerprint(
  requestId: string,
  operation: CutoverOperation,
  rollbackMode: CutoverRollbackMode | null,
  authorityInventoryRevision: string
): string {
  return createHash('sha256').update(canonicalJson({
    authorityInventoryRevision,
    operation,
    requestId,
    rollbackMode
  })).digest('hex')
}

function computeRevision(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonical(value))
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, sortCanonical(entry)]))
  }
  return value
}

function normalizeError(error: unknown): CutoverError {
  if (error instanceof CutoverError) return error
  if (error instanceof HostMutationOperationCoordinatorError) return mapCoordinatorError(error)
  return new CutoverError('CUTOVER_ADAPTER_FAILED', { cause: error })
}

function mapCoordinatorError(error: unknown): CutoverError {
  if (error instanceof CutoverError) return error
  if (!(error instanceof HostMutationOperationCoordinatorError)) {
    if (error instanceof HostMutationLeaseError) return new CutoverError('CUTOVER_HOST_LEASE_LOST')
    return new CutoverError('CUTOVER_HOST_LEASE_UNAVAILABLE', { cause: error })
  }
  const mapped: Record<HostMutationOperationCoordinatorError['code'], CutoverErrorCode> = {
    HOST_MUTATION_LEASE_BUSY: 'CUTOVER_HOST_LEASE_BUSY',
    HOST_MUTATION_LEASE_DIRTY: 'CUTOVER_HOST_LEASE_DIRTY',
    HOST_MUTATION_LEASE_RECOVERY_REQUIRED: 'CUTOVER_HOST_LEASE_RECOVERY_REQUIRED',
    HOST_MUTATION_LEASE_RECOVERY_NOT_REQUIRED: 'CUTOVER_HOST_LEASE_RECOVERY_NOT_REQUIRED',
    HOST_MUTATION_LEASE_RECOVERY_MISMATCH: 'CUTOVER_HOST_LEASE_RECOVERY_MISMATCH',
    HOST_MUTATION_LEASE_LOST: 'CUTOVER_HOST_LEASE_LOST',
    HOST_MUTATION_LEASE_UNAVAILABLE: 'CUTOVER_HOST_LEASE_UNAVAILABLE'
  }
  return new CutoverError(mapped[error.code])
}

export { CutoverService as GsManagerCutoverService }

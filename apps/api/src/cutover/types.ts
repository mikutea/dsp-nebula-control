import type {
  HostMutationOperationCoordinator,
  HostMutationOperationScope,
  HostMutationRecoveryOperationCoordinator
} from '../host-mutation/operation-coordinator.js'

export const PREPARE_GSMANAGER_TO_DYSON = 'PREPARE_GSMANAGER_TO_DYSON' as const
export const ACTIVATE_GSMANAGER_TO_DYSON = 'ACTIVATE_GSMANAGER_TO_DYSON' as const
export const ROLLBACK_DYSON_TO_GSMANAGER = 'ROLLBACK_DYSON_TO_GSMANAGER' as const

export type CutoverAuthority = 'previous' | 'candidate'
export type CutoverDesiredAuthority = CutoverAuthority
export type CutoverRollbackMode = 'immediate-compensation' | 'later-operator-rollback'
export type CutoverOperation = 'prepare' | 'activate' | 'rollback-immediate' | 'rollback-later'
export type CutoverPreviewOperation = 'prepare' | 'activate' | 'rollback'

export type CutoverPreviewRequest =
  | Readonly<{ requestId: string; operation: 'prepare' }>
  | Readonly<{ requestId: string; operation: 'activate' }>
  | Readonly<{ requestId: string; operation: 'rollback'; mode: CutoverRollbackMode }>

export interface CutoverPreviewReceipt {
  format: 'dyson-control-cutover-preview'
  schemaVersion: 1
  operation: CutoverPreviewOperation
  requestId: string
  rollbackMode: CutoverRollbackMode | null
  stateRevision: string
  evidenceDigest: string
  planFingerprint: string
  summary: CutoverPublicSummary
}

export interface CutoverPrepareRequest {
  requestId: string
  planFingerprint: string
  confirmation: typeof PREPARE_GSMANAGER_TO_DYSON
}

export interface CutoverActivateRequest {
  requestId: string
  planFingerprint: string
  confirmation: typeof ACTIVATE_GSMANAGER_TO_DYSON
}

export interface CutoverRollbackRequest {
  requestId: string
  mode: CutoverRollbackMode
  planFingerprint: string
  confirmation: typeof ROLLBACK_DYSON_TO_GSMANAGER
}

export interface CutoverRecoveryRequest {
  requestId: string
  desired: CutoverDesiredAuthority
}

export type CutoverPublicPhase =
  | 'prepared'
  | 'activated'
  | 'rolled-back-immediate'
  | 'rolled-back-later'
  | 'recovered-candidate'
  | 'recovered-previous'

export type CutoverPublicStatus = 'succeeded' | 'rolled-back' | 'failed-safe'

export type CutoverAuditRequestOperation = 'prepare' | 'activate' | 'rollback' | 'recover'

export interface CutoverAuditReceiptLookupRequest {
  requestId: string
  operation: CutoverAuditRequestOperation
  planFingerprint?: string | null
  rollbackMode?: CutoverRollbackMode | null
  desired?: CutoverDesiredAuthority | null
}

export type CutoverAuditReceiptResolution =
  | Readonly<{ match: 'conflict' }>
  | Readonly<{
      match: 'matched'
      storedOperation: CutoverOperation
      receipt: CutoverReceipt
    }>

/**
 * Deliberately bounded public summary. Provider paths, task XML, commands,
 * process details, ports, backup identifiers, and adapter errors never cross
 * this boundary.
 */
export interface CutoverPublicSummary {
  candidateDefined: boolean
  candidateDisabled: boolean
  previousAuthorityEnabled: boolean
  candidateAuthorityEnabled: boolean
  previousRuntimeHealthy: boolean
  candidateRuntimeHealthy: boolean
  processesStopped: boolean
  portClosed: boolean
  uniqueAuthority: boolean
  saveProtected: boolean
  baselineRestored: boolean
  currentProgressProtected: boolean
  reused: boolean
}

export interface CutoverReceipt {
  requestId: string
  phase: CutoverPublicPhase
  status: CutoverPublicStatus
  allowedDesired: CutoverDesiredAuthority[]
  summary: CutoverPublicSummary
  errorCode: CutoverErrorCode | null
}

export interface CutoverRecoveryStatus {
  requestId: string | null
  phase: 'ready' | 'recovery-required'
  status: 'ready' | 'interrupted' | 'terminal-pending-release' | 'evidence-invalid'
  allowedDesired: CutoverDesiredAuthority[]
  summary: CutoverPublicSummary
  errorCode: CutoverErrorCode | null
}

export type CutoverErrorCode =
  | 'CUTOVER_REQUEST_INVALID'
  | 'CUTOVER_CONFIRMATION_REQUIRED'
  | 'CUTOVER_ROLLBACK_CONFIRMATION_REQUIRED'
  | 'CUTOVER_PREVIEW_REQUIRED'
  | 'CUTOVER_PREVIEW_CONFLICT'
  | 'CUTOVER_IDEMPOTENCY_CONFLICT'
  | 'CUTOVER_NOT_PREPARED'
  | 'CUTOVER_NOT_CANDIDATE_ACTIVE'
  | 'CUTOVER_RECOVERY_REQUIRED'
  | 'CUTOVER_RECOVERY_NOT_REQUIRED'
  | 'CUTOVER_RECOVERY_TARGET_NOT_ALLOWED'
  | 'CUTOVER_RECOVERY_EVIDENCE_INVALID'
  | 'CUTOVER_DURABLE_STATE_INVALID'
  | 'CUTOVER_DURABLE_STORE_FAILED'
  | 'CUTOVER_AUTHORITY_DRIFT'
  | 'CUTOVER_RUNTIME_DRIFT'
  | 'CUTOVER_PREPARE_INVARIANT_FAILED'
  | 'CUTOVER_SAVE_PROTECTION_FAILED'
  | 'CUTOVER_SAVE_RESTORE_FAILED'
  | 'CUTOVER_STOP_GATE_FAILED'
  | 'CUTOVER_HEALTH_GATE_FAILED'
  | 'CUTOVER_UNIQUE_AUTHORITY_FAILED'
  | 'CUTOVER_ADAPTER_FAILED'
  | 'CUTOVER_HOST_LEASE_BUSY'
  | 'CUTOVER_HOST_LEASE_DIRTY'
  | 'CUTOVER_HOST_LEASE_RECOVERY_REQUIRED'
  | 'CUTOVER_HOST_LEASE_RECOVERY_NOT_REQUIRED'
  | 'CUTOVER_HOST_LEASE_RECOVERY_MISMATCH'
  | 'CUTOVER_HOST_LEASE_LOST'
  | 'CUTOVER_HOST_LEASE_UNAVAILABLE'

export class CutoverError extends Error {
  readonly code: CutoverErrorCode
  readonly receipt: CutoverReceipt | null

  constructor(code: CutoverErrorCode, options?: { receipt?: CutoverReceipt | null; cause?: unknown }) {
    // Provider failures can contain paths, task XML, commands, or process
    // details. Deliberately discard the raw cause at this public boundary.
    super(code)
    this.name = 'CutoverError'
    this.code = code
    this.receipt = options?.receipt ?? null
  }
}

export type CutoverProcessState = 'none' | 'previous-only' | 'candidate-only' | 'both' | 'unknown'
export type CutoverPortState = 'closed' | 'previous' | 'candidate' | 'unknown'

/** Provider-neutral, bounded evidence returned by the trusted host adapter. */
export interface CutoverHostEvidence {
  previousDefined: boolean
  previousEnabled: boolean
  /**
   * Means the exact current managed definition. A disabled legacy same-name
   * task with an old action may be reported as false and replaced only by the
   * adapter's transactional defineCandidateDisabled capability. An enabled
   * legacy task is never replaceable in place: report it as an unexpected
   * authority (and, if running, through process/port evidence) so core rejects
   * the operation with zero live writes.
   */
  candidateDefined: boolean
  candidateEnabled: boolean
  unexpectedAuthorityPresent: boolean
  processState: CutoverProcessState
  portState: CutoverPortState
  previousHealthy: boolean
  candidateHealthy: boolean
}

export interface CutoverSaveProtectionReceipt {
  pairProtected: true
  durable: true
}

export interface CutoverBaselineRestoreReceipt {
  pairRestored: true
  durable: true
}

export interface CutoverAdapterRequest {
  requestId: string
  signal: AbortSignal
}

export interface CutoverAdapterMutationRequest extends CutoverAdapterRequest {
  /** Trusted internal scope; never serialized into a public request or receipt. */
  hostMutation: HostMutationOperationScope
}

export interface CutoverSaveProtectionRequest extends CutoverAdapterMutationRequest {
  purpose: 'activation-baseline' | 'later-candidate-progress'
}

export interface CutoverBaselineRestoreRequest extends CutoverAdapterMutationRequest {
  activationRequestId: string
}

export type CutoverAuthorityMutationMethod =
  | 'defineCandidateDisabled'
  | 'enableCandidateAuthority'
  | 'disableCandidateAuthority'

export interface CutoverAuthorityMutationInvocation {
  childRequestId: string
  attempt: number
  mode: 'PrepareDisabled' | 'Activate'
  recovery: boolean
}

export interface CutoverAuthorityMutationRequest extends CutoverAdapterMutationRequest {
  authorityMutation: CutoverAuthorityMutationInvocation
}

export interface CutoverAuthorityMutationResult {
  status: 'succeeded' | 'rolled-back' | 'recovery-required'
  receiptDigest: string | null
}

/**
 * Every method is a fixed capability and every mutation must be idempotent for
 * one requestId so intent-phase recovery can safely replay it. There is
 * intentionally no arbitrary command, path, executable, XML, service-name, or
 * argument escape hatch.
 */
export interface CutoverHostAdapter {
  inspect(request: CutoverAdapterRequest): Promise<CutoverHostEvidence>
  defineCandidateDisabled(request: CutoverAuthorityMutationRequest): Promise<CutoverAuthorityMutationResult>
  createSaveProtectionPoint(request: CutoverSaveProtectionRequest): Promise<CutoverSaveProtectionReceipt>
  restoreActivationBaseline(request: CutoverBaselineRestoreRequest): Promise<CutoverBaselineRestoreReceipt>
  disablePreviousAuthority(request: CutoverAdapterMutationRequest): Promise<void>
  stopPreviousRuntime(request: CutoverAdapterMutationRequest): Promise<void>
  enableCandidateAuthority(request: CutoverAuthorityMutationRequest): Promise<CutoverAuthorityMutationResult>
  startCandidateRuntime(request: CutoverAdapterMutationRequest): Promise<void>
  disableCandidateAuthority(request: CutoverAuthorityMutationRequest): Promise<CutoverAuthorityMutationResult>
  stopCandidateRuntime(request: CutoverAdapterMutationRequest): Promise<void>
  enablePreviousAuthority(request: CutoverAdapterMutationRequest): Promise<void>
  startPreviousRuntime(request: CutoverAdapterMutationRequest): Promise<void>
}

export interface CutoverStoredState {
  format: 'dyson-control-cutover-state'
  schemaVersion: 1
  authorityInventoryRevision: string
  revision: string
  prepared: boolean
  authority: CutoverAuthority
  activationBaselineProtected: boolean
  lastActivationRequestId: string | null
}

export type CutoverJournalPhase =
  | 'prepared'
  | 'candidate-definition-intent'
  | 'candidate-defined-disabled'
  | 'save-protection-intent'
  | 'save-protected'
  | 'baseline-restore-intent'
  | 'baseline-restored'
  | 'disable-source-intent'
  | 'source-disabled'
  | 'stop-source-intent'
  | 'source-stopped'
  | 'launch-target-intent'
  | 'target-enabled'
  | 'target-start-intent'
  | 'target-started'
  | 'recovery-intent'
  | 'recovery-converging'
  | 'terminal'

export interface CutoverAuthorityMutationTransaction {
  phase: 'not-started' | 'intent-persisted' | 'receipt-persisted'
  method: CutoverAuthorityMutationMethod
  mode: 'PrepareDisabled' | 'Activate'
  childRequestId: string | null
  attempt: number
  state: 'idle' | 'pending' | 'succeeded' | 'rolled-back' | 'recovery-required'
  receiptDigest: string | null
}

export interface CutoverJournal {
  format: 'dyson-control-cutover-journal'
  schemaVersion: 1
  requestId: string
  authorityInventoryRevision: string
  fingerprint: string
  /** Preview accepted under the host lease before the first durable mutation intent. */
  acceptedPreview: CutoverPreviewReceipt | null
  operation: CutoverOperation
  rollbackMode: CutoverRollbackMode | null
  source: CutoverAuthority
  target: CutoverAuthority
  baseState: CutoverStoredState
  phase: CutoverJournalPhase
  sequence: number
  baselineSaveProtected: boolean
  baselineRestored: boolean
  currentProgressProtected: boolean
  possibleLiveMutation: boolean
  terminalDesired: CutoverAuthority | null
  evidence: CutoverPublicSummary
  /** Durable binding for the fixed runtime-task child transaction. */
  authorityMutation: CutoverAuthorityMutationTransaction
}

export interface CutoverStoredReceipt {
  format: 'dyson-control-cutover-receipt-envelope'
  schemaVersion: 1
  authorityInventoryRevision: string
  fingerprint: string
  acceptedPreview: CutoverPreviewReceipt | null
  operation: CutoverOperation
  receipt: CutoverReceipt
}

/**
 * Store methods are durable compare-and-swap capabilities. commitTerminal must
 * atomically persist the immutable receipt, next state, and terminal journal.
 * It intentionally leaves the terminal journal until the host lease has been
 * released; clearTerminalJournal is the post-release acknowledgement.
 */
export interface CutoverDurableStore {
  readState(): Promise<unknown>
  readJournal(): Promise<unknown | null>
  readReceipt(requestId: string): Promise<unknown | null>
  createJournal(journal: CutoverJournal): Promise<void>
  replaceJournal(expectedSequence: number, journal: CutoverJournal): Promise<void>
  commitTerminal(input: {
    expectedSequence: number
    journal: CutoverJournal
    nextState: CutoverStoredState
    receipt: CutoverStoredReceipt
  }): Promise<void>
  clearTerminalJournal(input: {
    requestId: string
    fingerprint: string
    expectedSequence: number
  }): Promise<void>
}

export interface CutoverServiceOptions {
  /** Fixed inventory digest captured when the service is constructed. */
  authorityInventoryRevision: string
  adapter: CutoverHostAdapter
  store: CutoverDurableStore
  hostMutationCoordinator?: HostMutationOperationCoordinator
  hostMutationRecoveryCoordinator?: HostMutationRecoveryOperationCoordinator
}

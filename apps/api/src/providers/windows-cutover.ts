import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { HostMutationOperationScope } from '../host-mutation/operation-coordinator.js'
import type {
  BackupSavePairRequest,
  RestoreSavePairRequest,
  SaveRestoreMutationScope
} from '../saves/transactions.js'
import type {
  CutoverAdapterMutationRequest,
  CutoverAdapterRequest,
  CutoverAuthorityMutationInvocation,
  CutoverAuthorityMutationRequest,
  CutoverAuthorityMutationResult,
  CutoverBaselineRestoreRequest,
  CutoverHostAdapter,
  CutoverHostEvidence,
  CutoverSaveProtectionRequest
} from '../cutover/types.js'

const fixedSaveName = '_lastexit_'
const requestIdSchema = z.string().uuid().transform((value) => value.toLowerCase())
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
const safeByteCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const abortSignalSchema = z.custom<AbortSignal>((value) =>
  typeof value === 'object' && value !== null &&
  typeof (value as AbortSignal).aborted === 'boolean' &&
  typeof (value as AbortSignal).addEventListener === 'function')
const hostMutationScopeSchema = z.custom<HostMutationOperationScope>((value) =>
  typeof value === 'object' && value !== null &&
  abortSignalSchema.safeParse((value as HostMutationOperationScope).signal).success &&
  typeof (value as HostMutationOperationScope).assertActive === 'function' &&
  typeof (value as HostMutationOperationScope).toPowerShellBorrowArguments === 'function')

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

const inspectionSchema = z.strictObject({
  authorityInventoryRevision: sha256Schema,
  evidence: evidenceSchema
})

const adapterRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  signal: abortSignalSchema
})

const mutationRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  signal: abortSignalSchema,
  hostMutation: hostMutationScopeSchema
}).superRefine((request, context) => {
  if (request.signal !== request.hostMutation.signal) {
    context.addIssue({ code: 'custom', message: 'host-mutation-signal' })
  }
})

const authorityInvocationSchema: z.ZodType<CutoverAuthorityMutationInvocation> = z.strictObject({
  childRequestId: requestIdSchema,
  attempt: z.number().int().min(1).max(64),
  mode: z.enum(['PrepareDisabled', 'Activate']),
  recovery: z.boolean()
})

const authorityMutationRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  signal: abortSignalSchema,
  hostMutation: hostMutationScopeSchema,
  authorityMutation: authorityInvocationSchema
}).superRefine((request, context) => {
  if (request.signal !== request.hostMutation.signal) {
    context.addIssue({ code: 'custom', message: 'host-mutation-signal' })
  }
})

const saveProtectionRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  signal: abortSignalSchema,
  hostMutation: hostMutationScopeSchema,
  purpose: z.enum(['activation-baseline', 'later-candidate-progress'])
}).superRefine((request, context) => {
  if (request.signal !== request.hostMutation.signal) {
    context.addIssue({ code: 'custom', message: 'host-mutation-signal' })
  }
})

const baselineRestoreRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  signal: abortSignalSchema,
  hostMutation: hostMutationScopeSchema,
  activationRequestId: requestIdSchema
}).superRefine((request, context) => {
  if (request.signal !== request.hostMutation.signal) {
    context.addIssue({ code: 'custom', message: 'host-mutation-signal' })
  }
})

const fixedMutationReceiptSchema = z.strictObject({
  requestId: requestIdSchema,
  status: z.literal('succeeded')
})

const authorityMutationHostReceiptSchema = z.strictObject({
  outerRequestId: requestIdSchema,
  childRequestId: requestIdSchema,
  attempt: z.number().int().min(1).max(64),
  mode: z.enum(['PrepareDisabled', 'Activate']),
  recovery: z.boolean(),
  status: z.enum(['succeeded', 'rolled-back', 'recovery-required']),
  receiptDigest: sha256Schema.nullable()
}).superRefine((result, context) => {
  if ((result.status === 'succeeded' || result.status === 'rolled-back') &&
      result.receiptDigest === null) {
    context.addIssue({ code: 'custom', message: 'terminal-receipt-digest' })
  }
  if (result.status === 'recovery-required' && result.receiptDigest !== null) {
    context.addIssue({ code: 'custom', message: 'nonterminal-receipt-digest' })
  }
})

const saveNameSchema = z.literal(fixedSaveName)
const backupIdSchema = z.string().regex(/^tx-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
const saveStatusSchema = z.enum([
  'dry-run', 'succeeded', 'busy', 'rejected', 'revision-conflict', 'failed',
  'rolled-back', 'rollback-failed'
])
const saveErrorCodeSchema = z.enum([
  'SAVE_REQUEST_INVALID',
  'SAVE_ROOT_UNAVAILABLE',
  'SAVE_TRANSACTION_STORAGE_UNAVAILABLE',
  'SAVE_TRANSACTION_BUSY',
  'SAVE_JOURNAL_MAINTENANCE_REQUIRED',
  'SAVE_PAIR_INCOMPLETE',
  'SAVE_PAIR_REDIRECTED',
  'SAVE_PAIR_CHANGED',
  'SAVE_BACKUP_CORRUPT',
  'SAVE_IDEMPOTENCY_CONFLICT',
  'SAVE_SERVICE_NOT_STOPPED',
  'SAVE_REVISION_CONFLICT',
  'SAVE_COMMIT_FAILED',
  'SAVE_COMMIT_CLEANUP_PENDING',
  'SAVE_COMMIT_VERIFICATION_FAILED',
  'SAVE_ROLLBACK_FAILED'
])
const rollbackSchema = z.enum(['not-required', 'succeeded', 'failed'])
const timestampSchema = z.string().datetime({ offset: true })

const saveAuditSchema = z.strictObject({
  schemaVersion: z.literal(1),
  requestId: requestIdSchema,
  action: z.enum(['save.backup', 'save.restore']),
  status: z.union([saveStatusSchema, z.literal('prepared')]),
  dryRun: z.boolean(),
  backupId: backupIdSchema,
  protectionBackupId: backupIdSchema.optional(),
  reused: z.boolean(),
  rollback: rollbackSchema,
  cleanupPending: z.boolean(),
  maintenanceRequired: z.boolean(),
  startedAt: timestampSchema,
  finishedAt: timestampSchema,
  errorCode: saveErrorCodeSchema.optional()
})

const saveTransactionResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  requestId: requestIdSchema,
  operation: z.enum(['backup', 'restore']),
  status: saveStatusSchema,
  dryRun: z.boolean(),
  backupId: backupIdSchema,
  protectionBackupId: backupIdSchema.optional(),
  reused: z.boolean(),
  rollback: rollbackSchema,
  pairBytes: safeByteCountSchema,
  cleanupPending: z.boolean(),
  maintenanceRequired: z.boolean(),
  beforeRevision: sha256Schema.optional(),
  afterRevision: sha256Schema.optional(),
  errorCode: saveErrorCodeSchema.optional(),
  auditStored: z.boolean(),
  audit: saveAuditSchema
}).superRefine((result, context) => {
  const audit = result.audit
  const expectedAction = result.operation === 'backup' ? 'save.backup' : 'save.restore'
  const matches = audit.requestId === result.requestId && audit.action === expectedAction &&
    audit.status === result.status && audit.dryRun === result.dryRun &&
    audit.backupId === result.backupId &&
    audit.protectionBackupId === result.protectionBackupId && audit.reused === result.reused &&
    audit.rollback === result.rollback && audit.cleanupPending === result.cleanupPending &&
    audit.maintenanceRequired === result.maintenanceRequired && audit.errorCode === result.errorCode
  if (!matches) context.addIssue({ code: 'custom', message: 'audit-binding' })
})

const savePairRevisionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  saveName: saveNameSchema,
  revision: sha256Schema,
  dsvBytes: safeByteCountSchema,
  serverBytes: safeByteCountSchema,
  totalBytes: safeByteCountSchema
}).superRefine((revision, context) => {
  if (revision.dsvBytes + revision.serverBytes !== revision.totalBytes) {
    context.addIssue({ code: 'custom', message: 'pair-bytes' })
  }
})

export interface WindowsCutoverInspectionRequest {
  requestId: string
  signal: AbortSignal
}

export interface WindowsCutoverInspectionResult {
  authorityInventoryRevision: string
  evidence: CutoverHostEvidence
}

export interface WindowsCutoverFixedMutationRequest {
  requestId: string
  hostMutation: HostMutationOperationScope
}

export interface WindowsCutoverCandidateTaskRequest {
  outerRequestId: string
  authorityMutation: CutoverAuthorityMutationInvocation
  hostMutation: HostMutationOperationScope
}

/**
 * Construction-time fixed Windows capabilities. There is intentionally no
 * caller-selected executable, command, task name, path, port, or argument.
 */
export interface WindowsCutoverHostClient {
  inspect(request: Readonly<WindowsCutoverInspectionRequest>): Promise<unknown>
  runCandidateTaskTransaction(request: Readonly<WindowsCutoverCandidateTaskRequest>): Promise<unknown>
  disablePreviousAuthority(request: Readonly<WindowsCutoverFixedMutationRequest>): Promise<unknown>
  stopPreviousRuntime(request: Readonly<WindowsCutoverFixedMutationRequest>, options?: Readonly<{ reconcileOnly: true }>): Promise<unknown>
  enablePreviousAuthority(request: Readonly<WindowsCutoverFixedMutationRequest>): Promise<unknown>
  startPreviousRuntime(request: Readonly<WindowsCutoverFixedMutationRequest>): Promise<unknown>
  startCandidateRuntime(request: Readonly<WindowsCutoverFixedMutationRequest>): Promise<unknown>
  stopCandidateRuntime(request: Readonly<WindowsCutoverFixedMutationRequest>): Promise<unknown>
}

/** Structurally compatible with the fixed SaveTransactionService surface. */
export interface WindowsCutoverSaveTransactionFacade {
  inspect(saveName: string): Promise<unknown>
  backup(request: BackupSavePairRequest): Promise<unknown>
  restore(request: RestoreSavePairRequest, mutationScope?: SaveRestoreMutationScope): Promise<unknown>
}

export interface WindowsCutoverAdapterOptions {
  authorityInventoryRevision: string
  hostClient: WindowsCutoverHostClient
  saves: WindowsCutoverSaveTransactionFacade
}

export type WindowsCutoverAdapterErrorCode =
  | 'WINDOWS_CUTOVER_OPTIONS_INVALID'
  | 'WINDOWS_CUTOVER_REQUEST_INVALID'
  | 'WINDOWS_CUTOVER_INSPECTION_FAILED'
  | 'WINDOWS_CUTOVER_AUTHORITY_REVISION_MISMATCH'
  | 'WINDOWS_CUTOVER_CANDIDATE_TRANSACTION_FAILED'
  | 'WINDOWS_CUTOVER_HOST_MUTATION_FAILED'
  | 'WINDOWS_CUTOVER_SAVE_PROTECTION_FAILED'
  | 'WINDOWS_CUTOVER_SAVE_RESTORE_FAILED'

export class WindowsCutoverAdapterError extends Error {
  readonly code: WindowsCutoverAdapterErrorCode

  constructor(code: WindowsCutoverAdapterErrorCode) {
    super(code)
    this.name = 'WindowsCutoverAdapterError'
    this.code = code
  }
}

type FixedMutationMethod =
  | 'disablePreviousAuthority'
  | 'stopPreviousRuntime'
  | 'enablePreviousAuthority'
  | 'startPreviousRuntime'
  | 'startCandidateRuntime'
  | 'stopCandidateRuntime'

type CandidateMutationMethod =
  | 'defineCandidateDisabled'
  | 'enableCandidateAuthority'
  | 'disableCandidateAuthority'

/** Broker-independent adapter over fixed Windows and paired-save capabilities. */
export class WindowsCutoverAdapter implements CutoverHostAdapter {
  readonly #authorityInventoryRevision: string
  readonly #hostClient: WindowsCutoverHostClient
  readonly #saves: WindowsCutoverSaveTransactionFacade

  constructor(options: WindowsCutoverAdapterOptions) {
    const hostMethods = [
      'inspect', 'runCandidateTaskTransaction', 'disablePreviousAuthority', 'stopPreviousRuntime',
      'enablePreviousAuthority', 'startPreviousRuntime', 'startCandidateRuntime', 'stopCandidateRuntime'
    ] as const
    const saveMethods = ['inspect', 'backup', 'restore'] as const
    if (!options || !sha256Schema.safeParse(options.authorityInventoryRevision).success ||
        hostMethods.some((method) => typeof options.hostClient?.[method] !== 'function') ||
        saveMethods.some((method) => typeof options.saves?.[method] !== 'function')) {
      throw new WindowsCutoverAdapterError('WINDOWS_CUTOVER_OPTIONS_INVALID')
    }
    this.#authorityInventoryRevision = options.authorityInventoryRevision
    this.#hostClient = options.hostClient
    this.#saves = options.saves
  }

  async inspect(input: CutoverAdapterRequest): Promise<CutoverHostEvidence> {
    const request = parseRequest(adapterRequestSchema, input)
    try {
      const result = inspectionSchema.parse(await this.#hostClient.inspect(request))
      if (result.authorityInventoryRevision !== this.#authorityInventoryRevision) {
        throw new WindowsCutoverAdapterError('WINDOWS_CUTOVER_AUTHORITY_REVISION_MISMATCH')
      }
      return result.evidence
    } catch (error) {
      if (error instanceof WindowsCutoverAdapterError) throw error
      throw new WindowsCutoverAdapterError('WINDOWS_CUTOVER_INSPECTION_FAILED')
    }
  }

  defineCandidateDisabled(input: CutoverAuthorityMutationRequest): Promise<CutoverAuthorityMutationResult> {
    return this.#runCandidateMutation('defineCandidateDisabled', input)
  }

  enableCandidateAuthority(input: CutoverAuthorityMutationRequest): Promise<CutoverAuthorityMutationResult> {
    return this.#runCandidateMutation('enableCandidateAuthority', input)
  }

  disableCandidateAuthority(input: CutoverAuthorityMutationRequest): Promise<CutoverAuthorityMutationResult> {
    return this.#runCandidateMutation('disableCandidateAuthority', input)
  }

  async createSaveProtectionPoint(
    input: CutoverSaveProtectionRequest
  ): Promise<{ pairProtected: true; durable: true }> {
    const request = parseRequest(saveProtectionRequestSchema, input)
    const scope = request.hostMutation
    scope.assertActive()
    try {
      const result = saveTransactionResultSchema.parse(await this.#saves.backup({
        requestId: request.requestId,
        saveName: fixedSaveName
      }))
      scope.assertActive()
      const expectedBackupId = `tx-${request.requestId}`
      if (!isCleanSuccessfulSaveResult(result, 'backup') || result.requestId !== request.requestId ||
          result.backupId !== expectedBackupId || result.protectionBackupId !== undefined ||
          result.rollback !== 'not-required' || result.beforeRevision === undefined ||
          result.afterRevision !== result.beforeRevision) {
        throw new WindowsCutoverAdapterError('WINDOWS_CUTOVER_SAVE_PROTECTION_FAILED')
      }
      scope.assertActive()
      return { pairProtected: true, durable: true }
    } catch {
      scope.assertActive()
      throw new WindowsCutoverAdapterError('WINDOWS_CUTOVER_SAVE_PROTECTION_FAILED')
    }
  }

  async restoreActivationBaseline(
    input: CutoverBaselineRestoreRequest
  ): Promise<{ pairRestored: true; durable: true }> {
    const request = parseRequest(baselineRestoreRequestSchema, input)
    const scope = request.hostMutation
    scope.assertActive()
    try {
      const current = savePairRevisionSchema.parse(await this.#saves.inspect(fixedSaveName))
      scope.assertActive()
      const restoreRequestId = deriveBoundRequestId(
        'restore', request.requestId, request.activationRequestId, this.#authorityInventoryRevision)
      const protectionRequestId = deriveBoundRequestId(
        'protection', request.requestId, request.activationRequestId, this.#authorityInventoryRevision)
      if (restoreRequestId === protectionRequestId) {
        throw new WindowsCutoverAdapterError('WINDOWS_CUTOVER_SAVE_RESTORE_FAILED')
      }
      const backupId = `tx-${request.activationRequestId}`
      const result = saveTransactionResultSchema.parse(await this.#saves.restore({
        requestId: restoreRequestId,
        backupId,
        expectedRevision: current.revision,
        protectionRequestId
      }, scope))
      scope.assertActive()
      if (!isCleanSuccessfulSaveResult(result, 'restore') || result.requestId !== restoreRequestId ||
          result.backupId !== backupId || result.protectionBackupId !== `tx-${protectionRequestId}` ||
          result.beforeRevision !== current.revision || result.afterRevision === undefined ||
          result.rollback === 'failed') {
        throw new WindowsCutoverAdapterError('WINDOWS_CUTOVER_SAVE_RESTORE_FAILED')
      }
      scope.assertActive()
      return { pairRestored: true, durable: true }
    } catch {
      scope.assertActive()
      throw new WindowsCutoverAdapterError('WINDOWS_CUTOVER_SAVE_RESTORE_FAILED')
    }
  }

  disablePreviousAuthority(input: CutoverAdapterMutationRequest): Promise<void> {
    return this.#runFixedMutation('disablePreviousAuthority', input)
  }

  stopPreviousRuntime(input: CutoverAdapterMutationRequest, options?: Readonly<{ reconcileOnly: true }>): Promise<void> {
    return this.#runFixedMutation('stopPreviousRuntime', input, options)
  }

  enablePreviousAuthority(input: CutoverAdapterMutationRequest): Promise<void> {
    return this.#runFixedMutation('enablePreviousAuthority', input)
  }

  startPreviousRuntime(input: CutoverAdapterMutationRequest): Promise<void> {
    return this.#runFixedMutation('startPreviousRuntime', input)
  }

  startCandidateRuntime(input: CutoverAdapterMutationRequest): Promise<void> {
    return this.#runFixedMutation('startCandidateRuntime', input)
  }

  stopCandidateRuntime(input: CutoverAdapterMutationRequest): Promise<void> {
    return this.#runFixedMutation('stopCandidateRuntime', input)
  }

  async #runCandidateMutation(
    method: CandidateMutationMethod,
    input: CutoverAuthorityMutationRequest
  ): Promise<CutoverAuthorityMutationResult> {
    const request = parseRequest(authorityMutationRequestSchema, input)
    const expectedMode = method === 'enableCandidateAuthority' ? 'Activate' : 'PrepareDisabled'
    if (request.authorityMutation.mode !== expectedMode) {
      throw new WindowsCutoverAdapterError('WINDOWS_CUTOVER_REQUEST_INVALID')
    }
    const scope = request.hostMutation
    scope.assertActive()
    try {
      const receipt = authorityMutationHostReceiptSchema.parse(
        await this.#hostClient.runCandidateTaskTransaction({
          outerRequestId: request.requestId,
          authorityMutation: request.authorityMutation,
          hostMutation: scope
        })
      )
      scope.assertActive()
      if (receipt.outerRequestId !== request.requestId ||
          receipt.childRequestId !== request.authorityMutation.childRequestId ||
          receipt.attempt !== request.authorityMutation.attempt ||
          receipt.mode !== request.authorityMutation.mode ||
          receipt.recovery !== request.authorityMutation.recovery) {
        throw new WindowsCutoverAdapterError('WINDOWS_CUTOVER_CANDIDATE_TRANSACTION_FAILED')
      }
      if (receipt.receiptDigest === null) {
        return { status: receipt.status, receiptDigest: null }
      }
      if (receipt.status === 'recovery-required') {
        throw new WindowsCutoverAdapterError('WINDOWS_CUTOVER_CANDIDATE_TRANSACTION_FAILED')
      }
      return {
        status: receipt.status,
        receiptDigest: bindAuthorityReceiptDigest(
          receipt.receiptDigest,
          request.requestId,
          request.authorityMutation,
          receipt.status
        )
      }
    } catch {
      scope.assertActive()
      throw new WindowsCutoverAdapterError('WINDOWS_CUTOVER_CANDIDATE_TRANSACTION_FAILED')
    }
  }

  async #runFixedMutation(method: FixedMutationMethod, input: CutoverAdapterMutationRequest, options?: Readonly<{ reconcileOnly: true }>): Promise<void> {
    const request = parseRequest(mutationRequestSchema, input)
    const scope = request.hostMutation
    scope.assertActive()
    try {
      const result = fixedMutationReceiptSchema.parse(
        await (method === 'stopPreviousRuntime'
          ? this.#hostClient.stopPreviousRuntime({ requestId: request.requestId, hostMutation: scope }, options)
          : this.#hostClient[method]({ requestId: request.requestId, hostMutation: scope }))
      )
      scope.assertActive()
      if (result.requestId !== request.requestId) {
        throw new WindowsCutoverAdapterError('WINDOWS_CUTOVER_HOST_MUTATION_FAILED')
      }
    } catch {
      scope.assertActive()
      throw new WindowsCutoverAdapterError('WINDOWS_CUTOVER_HOST_MUTATION_FAILED')
    }
  }
}

function parseRequest<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new WindowsCutoverAdapterError('WINDOWS_CUTOVER_REQUEST_INVALID')
  return parsed.data
}

function isCleanSuccessfulSaveResult(
  result: z.infer<typeof saveTransactionResultSchema>,
  operation: 'backup' | 'restore'
): boolean {
  return result.operation === operation && result.status === 'succeeded' && !result.dryRun &&
    result.auditStored && !result.cleanupPending && !result.maintenanceRequired &&
    result.errorCode === undefined && result.audit.errorCode === undefined &&
    !result.audit.cleanupPending && !result.audit.maintenanceRequired
}

function deriveBoundRequestId(
  purpose: 'restore' | 'protection',
  outerRequestId: string,
  activationRequestId: string,
  authorityInventoryRevision: string
): string {
  const digest = createHash('sha256').update(JSON.stringify({
    authorityInventoryRevision,
    outerRequestId,
    activationRequestId,
    purpose,
    protocol: 'dyson-control-windows-cutover-save-v1'
  })).digest('hex')
  const versioned = `${digest.slice(0, 12)}5${digest.slice(13, 16)}`
  const variant = ((Number.parseInt(digest[16]!, 16) & 0x3) | 0x8).toString(16)
  const normalized = `${versioned}${variant}${digest.slice(17, 32)}`
  return `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-` +
    `${normalized.slice(16, 20)}-${normalized.slice(20, 32)}`
}

function bindAuthorityReceiptDigest(
  hostReceiptDigest: string,
  outerRequestId: string,
  invocation: CutoverAuthorityMutationInvocation,
  status: 'succeeded' | 'rolled-back'
): string {
  return createHash('sha256').update(JSON.stringify({
    attempt: invocation.attempt,
    childRequestId: invocation.childRequestId,
    hostReceiptDigest,
    mode: invocation.mode,
    outerRequestId,
    protocol: 'dyson-control-windows-cutover-authority-receipt-v1',
    recovery: invocation.recovery,
    status
  })).digest('hex')
}

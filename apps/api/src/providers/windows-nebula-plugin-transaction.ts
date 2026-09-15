import path from 'node:path'
import { z } from 'zod'
import {
  HostMutationOperationCoordinatorError,
  hostMutationReturn,
  hostMutationThrow,
  type HostMutationOperationCoordinator,
  type HostMutationOperationOutcome,
  type HostMutationOperationScope,
  type HostMutationRecoveryOperationCoordinator
} from '../host-mutation/operation-coordinator.js'

const planScriptName = 'New-NebulaPluginCutoverPlan.ps1'
const applyScriptName = 'Invoke-NebulaPluginCutover.ps1'
const rollbackScriptName = 'Restore-NebulaPluginCutover.ps1'
const verifyApplyScriptName = 'Test-NebulaPluginCutover.ps1'
const verifyRollbackScriptName = 'Test-NebulaPluginRollback.ps1'

export const windowsNebulaPluginTransactionScriptNames = [
  planScriptName,
  applyScriptName,
  rollbackScriptName,
  verifyApplyScriptName,
  verifyRollbackScriptName
] as const

export type WindowsNebulaPluginTransactionScriptName =
  (typeof windowsNebulaPluginTransactionScriptNames)[number]

/** Fixed coordinator identities; neither value is caller-selectable. */
export const windowsNebulaPluginApplyOperation = 'nebula-plugin-whole-tree-apply-v3'
export const windowsNebulaPluginRollbackOperation = 'nebula-plugin-whole-tree-rollback-v3'

const planProtocol = 'DYSON_NEBULA_PLUGIN_TRANSACTION_PLAN_V3'
const receiptProtocol = 'DYSON_NEBULA_PLUGIN_TRANSACTION_RECEIPT_V3'
const rollbackPreviewProtocol = 'DYSON_NEBULA_PLUGIN_ROLLBACK_PREVIEW_V3'
const maximumOutputBytes = 32 * 1024

const requestIdSchema = z.string().uuid().transform((value) => value.toLowerCase())
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u)
const targetRoleSchema = z.enum(['Client', 'Server'])
const timestampSchema = z.string().max(64).datetime({ offset: true })
const abortSignalSchema = z.custom<AbortSignal>((value) =>
  typeof value === 'object' && value !== null &&
  typeof (value as AbortSignal).aborted === 'boolean' &&
  typeof (value as AbortSignal).addEventListener === 'function' &&
  typeof (value as AbortSignal).throwIfAborted === 'function')

const planRequestSchema = withWindow(z.strictObject({
  requestId: requestIdSchema,
  currentPluginsTreeSha256: sha256Schema,
  maintenanceWindowStartUtc: timestampSchema,
  maintenanceWindowEndUtc: timestampSchema,
  signal: abortSignalSchema
}))
const applyPreviewRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  signal: abortSignalSchema
})
const applyMutationRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  planDigest: sha256Schema,
  confirmationPhrase: z.string().min(1).max(256)
}).superRefine((value, context) => {
  if (value.confirmationPhrase !== applyConfirmationPhrase(value.requestId, value.planDigest)) {
    context.addIssue({ code: 'custom', path: ['confirmationPhrase'], message: 'confirmation-binding' })
  }
})
const verifyApplyRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  signal: abortSignalSchema
})

const rollbackReadRequestSchema = withWindow(z.strictObject({
  originalRequestId: requestIdSchema,
  rollbackRequestId: requestIdSchema,
  originalReceiptSha256: sha256Schema,
  maintenanceWindowStartUtc: timestampSchema,
  maintenanceWindowEndUtc: timestampSchema,
  signal: abortSignalSchema
})).superRefine(assertDistinctRollbackIds)
const rollbackMutationRequestSchema = withWindow(z.strictObject({
  originalRequestId: requestIdSchema,
  rollbackRequestId: requestIdSchema,
  originalReceiptSha256: sha256Schema,
  maintenanceWindowStartUtc: timestampSchema,
  maintenanceWindowEndUtc: timestampSchema,
  previewDigest: sha256Schema,
  confirmationPhrase: z.string().min(1).max(256)
})).superRefine((value, context) => {
  assertDistinctRollbackIds(value, context)
  if (value.confirmationPhrase !== rollbackConfirmationPhrase(
    value.rollbackRequestId,
    value.previewDigest
  )) {
    context.addIssue({ code: 'custom', path: ['confirmationPhrase'], message: 'confirmation-binding' })
  }
})
const verifyRollbackRequestSchema = z.strictObject({
  originalRequestId: requestIdSchema,
  rollbackRequestId: requestIdSchema,
  signal: abortSignalSchema
}).superRefine(assertDistinctRollbackIds)

const planOutputSchema = z.strictObject({
  protocol: z.literal(planProtocol),
  requestId: requestIdSchema,
  targetRole: targetRoleSchema,
  mode: z.literal('dry-run'),
  executionEnabled: z.literal(false),
  planDigest: sha256Schema,
  productionChanged: z.literal(false)
})
const applyPreviewOutputSchema = z.strictObject({
  protocol: z.literal(planProtocol),
  status: z.literal('preview'),
  mode: z.literal('dry-run'),
  requestId: requestIdSchema,
  targetRole: targetRoleSchema,
  planDigest: sha256Schema,
  confirmationRequired: z.literal(true),
  productionChanged: z.literal(false)
})
const applyTerminalStatusSchema = z.enum([
  'applied',
  'rolled-back-automatic',
  'rolled-back-recovery'
])
const applyFreshOutputSchema = z.strictObject({
  protocol: z.literal(receiptProtocol),
  status: z.literal('applied'),
  requestId: requestIdSchema,
  targetRole: targetRoleSchema,
  receiptDigest: sha256Schema,
  quarantineRetained: z.literal(true),
  reused: z.literal(false)
})
const applyRecoveryOutputSchema = z.strictObject({
  protocol: z.literal(receiptProtocol),
  status: z.literal('rolled-back-recovery'),
  requestId: requestIdSchema,
  receiptDigest: sha256Schema,
  reused: z.literal(false)
})
const applyReusedOutputSchema = z.strictObject({
  protocol: z.literal(receiptProtocol),
  status: applyTerminalStatusSchema,
  requestId: requestIdSchema,
  receiptDigest: sha256Schema,
  reused: z.literal(true)
})
const applyOutputSchema = z.union([
  applyFreshOutputSchema,
  applyRecoveryOutputSchema,
  applyReusedOutputSchema
])
const verifyApplyOutputSchema = z.strictObject({
  protocol: z.literal(receiptProtocol),
  status: z.literal('verified'),
  requestId: requestIdSchema,
  targetRole: targetRoleSchema,
  transactionStatus: applyTerminalStatusSchema,
  receiptDigest: sha256Schema,
  contentAndAclExact: z.literal(true),
  rollbackMaterialRetained: z.literal(true)
})

const rollbackPreviewOutputSchema = z.strictObject({
  protocol: z.literal(rollbackPreviewProtocol),
  status: z.literal('preview'),
  mode: z.literal('dry-run'),
  rollbackRequestId: requestIdSchema,
  originalRequestId: requestIdSchema,
  previewDigest: sha256Schema,
  exactConfirmationPhrase: z.string().min(1).max(256),
  productionChanged: z.literal(false)
})
const rollbackTerminalStatusSchema = z.enum([
  'rolled-back-manual',
  'rollback-failed-restored-candidate',
  'rollback-recovery-restored-candidate'
])
const rollbackFreshOutputSchema = z.strictObject({
  protocol: z.literal(receiptProtocol),
  status: z.literal('rolled-back-manual'),
  requestId: requestIdSchema,
  originalRequestId: requestIdSchema,
  receiptDigest: sha256Schema,
  candidateStageRetained: z.literal(true),
  reused: z.literal(false)
})
const rollbackRecoveryOutputSchema = z.strictObject({
  protocol: z.literal(receiptProtocol),
  status: z.literal('rollback-recovery-restored-candidate'),
  requestId: requestIdSchema,
  receiptDigest: sha256Schema,
  reused: z.literal(false)
})
const rollbackReusedOutputSchema = z.strictObject({
  protocol: z.literal(receiptProtocol),
  status: rollbackTerminalStatusSchema,
  requestId: requestIdSchema,
  receiptDigest: sha256Schema,
  reused: z.literal(true)
})
const rollbackOutputSchema = z.union([
  rollbackFreshOutputSchema,
  rollbackRecoveryOutputSchema,
  rollbackReusedOutputSchema
])
const verifyRollbackOutputSchema = z.strictObject({
  protocol: z.literal(receiptProtocol),
  status: z.literal('verified'),
  operation: z.literal('rollback'),
  originalRequestId: requestIdSchema,
  rollbackRequestId: requestIdSchema,
  transactionStatus: rollbackTerminalStatusSchema,
  receiptDigest: sha256Schema,
  contentAndAclExact: z.literal(true),
  rollbackMaterialRetained: z.literal(true)
})

export interface WindowsNebulaPluginTransactionPowerShellRunner {
  run(
    scriptName: WindowsNebulaPluginTransactionScriptName,
    scriptArguments: string[],
    signal: AbortSignal
  ): Promise<string>
}

export interface WindowsNebulaPluginTransactionServiceOptions {
  /** Trusted fixed roots. Requests cannot override or select any of them. */
  jobBase: string
  gameRoot: string
  dataRoot: string
  targetRole: 'Client' | 'Server'
  runner: WindowsNebulaPluginTransactionPowerShellRunner
  coordinator: HostMutationOperationCoordinator
  recoveryCoordinator: HostMutationRecoveryOperationCoordinator
}

export type WindowsNebulaPluginTransactionErrorCode =
  | 'WINDOWS_NEBULA_PLUGIN_TRANSACTION_OPTIONS_INVALID'
  | 'WINDOWS_NEBULA_PLUGIN_TRANSACTION_REQUEST_INVALID'
  | 'WINDOWS_NEBULA_PLUGIN_TRANSACTION_BORROW_BINDING_INVALID'
  | 'WINDOWS_NEBULA_PLUGIN_TRANSACTION_RESULT_INVALID'
  | 'WINDOWS_NEBULA_PLUGIN_TRANSACTION_SCRIPT_FAILED'
  | 'WINDOWS_NEBULA_PLUGIN_TRANSACTION_TIMEOUT'
  | 'WINDOWS_NEBULA_PLUGIN_TRANSACTION_CANCELLED'

/** Code-only error: runner stderr, paths, tokens and private candidate details are never retained. */
export class WindowsNebulaPluginTransactionError extends Error {
  readonly code: WindowsNebulaPluginTransactionErrorCode

  constructor(code: WindowsNebulaPluginTransactionErrorCode) {
    super(code)
    this.name = 'WindowsNebulaPluginTransactionError'
    this.code = code
  }
}

export interface NebulaPluginPlanRequest {
  requestId: string
  currentPluginsTreeSha256: string
  maintenanceWindowStartUtc: string
  maintenanceWindowEndUtc: string
  signal: AbortSignal
}

export interface NebulaPluginApplyPreviewRequest {
  requestId: string
  signal: AbortSignal
}

export interface NebulaPluginApplyMutationRequest {
  requestId: string
  planDigest: string
  confirmationPhrase: string
}

export interface NebulaPluginRollbackReadRequest {
  originalRequestId: string
  rollbackRequestId: string
  originalReceiptSha256: string
  maintenanceWindowStartUtc: string
  maintenanceWindowEndUtc: string
  signal: AbortSignal
}

export interface NebulaPluginRollbackMutationRequest {
  originalRequestId: string
  rollbackRequestId: string
  originalReceiptSha256: string
  maintenanceWindowStartUtc: string
  maintenanceWindowEndUtc: string
  previewDigest: string
  confirmationPhrase: string
}

export interface NebulaPluginVerifyRollbackRequest {
  originalRequestId: string
  rollbackRequestId: string
  signal: AbortSignal
}

export interface NebulaPluginPlanResult {
  requestId: string
  targetRole: 'Client' | 'Server'
  mode: 'dry-run'
  executionEnabled: false
  planDigest: string
  productionChanged: false
}

export interface NebulaPluginApplyPreviewResult {
  requestId: string
  targetRole: 'Client' | 'Server'
  status: 'preview'
  mode: 'dry-run'
  planDigest: string
  confirmationRequired: true
  productionChanged: false
}

export interface NebulaPluginApplyResult {
  requestId: string
  status: z.output<typeof applyTerminalStatusSchema>
  receiptDigest: string
  reused: boolean
  quarantineRetained: boolean
  candidateStageRetained: boolean
}

export interface NebulaPluginVerifyApplyResult {
  requestId: string
  targetRole: 'Client' | 'Server'
  transactionStatus: z.output<typeof applyTerminalStatusSchema>
  receiptDigest: string
  contentAndAclExact: true
  rollbackMaterialRetained: true
}

export interface NebulaPluginRollbackPreviewResult {
  originalRequestId: string
  rollbackRequestId: string
  status: 'preview'
  mode: 'dry-run'
  previewDigest: string
  exactConfirmationPhrase: string
  productionChanged: false
}

export interface NebulaPluginRollbackResult {
  originalRequestId: string
  rollbackRequestId: string
  status: z.output<typeof rollbackTerminalStatusSchema>
  receiptDigest: string
  reused: boolean
  quarantineRetained: boolean
  candidateStageRetained: boolean
}

export interface NebulaPluginVerifyRollbackResult {
  originalRequestId: string
  rollbackRequestId: string
  transactionStatus: z.output<typeof rollbackTerminalStatusSchema>
  receiptDigest: string
  contentAndAclExact: true
  rollbackMaterialRetained: true
}

/**
 * Narrow host caller for the V3 Nebula whole-plugin-tree transaction.
 *
 * All script names, Windows roots, role, backend and path layout are fixed at
 * construction. Plan/preview/verification never acquire a host-mutation lease.
 * Apply and rollback use ordinary leases; recovery can enter only through the
 * separately typed recovery coordinator and reuses the abandoned operation's
 * exact operation/request UUID binding.
 */
export class WindowsNebulaPluginTransactionService {
  readonly #jobBase: string
  readonly #gameRoot: string
  readonly #dataRoot: string
  readonly #targetRole: 'Client' | 'Server'
  readonly #runner: WindowsNebulaPluginTransactionPowerShellRunner
  readonly #coordinator: HostMutationOperationCoordinator
  readonly #recoveryCoordinator: HostMutationRecoveryOperationCoordinator

  constructor(options: WindowsNebulaPluginTransactionServiceOptions) {
    if (!options || !isSafeWindowsRoot(options.jobBase) ||
        !isSafeWindowsRoot(options.gameRoot) || !isSafeWindowsRoot(options.dataRoot) ||
        !targetRoleSchema.safeParse(options.targetRole).success ||
        typeof options.runner?.run !== 'function' ||
        typeof options.coordinator?.runExclusive !== 'function' ||
        typeof options.recoveryCoordinator?.runRecoveryExclusive !== 'function') {
      throw new WindowsNebulaPluginTransactionError(
        'WINDOWS_NEBULA_PLUGIN_TRANSACTION_OPTIONS_INVALID'
      )
    }
    this.#jobBase = normalizeWindowsPath(options.jobBase)
    this.#gameRoot = normalizeWindowsPath(options.gameRoot)
    this.#dataRoot = normalizeWindowsPath(options.dataRoot)
    this.#targetRole = options.targetRole
    this.#runner = options.runner
    this.#coordinator = options.coordinator
    this.#recoveryCoordinator = options.recoveryCoordinator
  }

  async plan(input: Readonly<NebulaPluginPlanRequest>): Promise<NebulaPluginPlanResult> {
    const request = parseRequest(planRequestSchema, input)
    const output = await this.#runReadOnly(planScriptName, [
      '-RequestId', request.requestId,
      '-JobBase', this.#jobBase,
      '-GameRoot', this.#gameRoot,
      '-TargetRole', this.#targetRole,
      '-CurrentPluginsTreeSha256', request.currentPluginsTreeSha256,
      '-CandidateManifestPath', this.#candidateManifestPath(request.requestId),
      '-MaintenanceWindowStartUtc', request.maintenanceWindowStartUtc,
      '-MaintenanceWindowEndUtc', request.maintenanceWindowEndUtc,
      '-Backend', 'Windows'
    ], request.signal, planOutputSchema)
    if (output.requestId !== request.requestId || output.targetRole !== this.#targetRole) {
      throw resultInvalid()
    }
    return {
      requestId: output.requestId,
      targetRole: output.targetRole,
      mode: output.mode,
      executionEnabled: output.executionEnabled,
      planDigest: output.planDigest,
      productionChanged: output.productionChanged
    }
  }

  async previewApply(
    input: Readonly<NebulaPluginApplyPreviewRequest>
  ): Promise<NebulaPluginApplyPreviewResult> {
    const request = parseRequest(applyPreviewRequestSchema, input)
    const output = await this.#runReadOnly(
      applyScriptName,
      this.#applyBaseArguments(request.requestId),
      request.signal,
      applyPreviewOutputSchema
    )
    if (output.requestId !== request.requestId || output.targetRole !== this.#targetRole) {
      throw resultInvalid()
    }
    return {
      requestId: output.requestId,
      targetRole: output.targetRole,
      status: output.status,
      mode: output.mode,
      planDigest: output.planDigest,
      confirmationRequired: output.confirmationRequired,
      productionChanged: output.productionChanged
    }
  }

  async apply(input: Readonly<NebulaPluginApplyMutationRequest>): Promise<NebulaPluginApplyResult> {
    const request = parseRequest(applyMutationRequestSchema, input)
    return await this.#coordinator.runExclusive(
      { operation: windowsNebulaPluginApplyOperation, requestId: request.requestId },
      (scope) => this.#runApplyMutation(request, scope, false)
    )
  }

  async recoverApply(
    input: Readonly<NebulaPluginApplyMutationRequest>
  ): Promise<NebulaPluginApplyResult> {
    const request = parseRequest(applyMutationRequestSchema, input)
    return await this.#recoveryCoordinator.runRecoveryExclusive(
      {
        expectedOperation: windowsNebulaPluginApplyOperation,
        expectedRequestId: request.requestId
      },
      (scope) => this.#runApplyMutation(request, scope, true)
    )
  }

  async verifyApply(
    input: Readonly<NebulaPluginApplyPreviewRequest>
  ): Promise<NebulaPluginVerifyApplyResult> {
    const request = parseRequest(verifyApplyRequestSchema, input)
    const output = await this.#runReadOnly(verifyApplyScriptName, [
      '-RequestId', request.requestId,
      '-JobBase', this.#jobBase,
      '-GameRoot', this.#gameRoot,
      '-TargetRole', this.#targetRole,
      '-PlanPath', this.#planPath(request.requestId),
      '-Backend', 'Windows'
    ], request.signal, verifyApplyOutputSchema)
    if (output.requestId !== request.requestId || output.targetRole !== this.#targetRole) {
      throw resultInvalid()
    }
    return {
      requestId: output.requestId,
      targetRole: output.targetRole,
      transactionStatus: output.transactionStatus,
      receiptDigest: output.receiptDigest,
      contentAndAclExact: output.contentAndAclExact,
      rollbackMaterialRetained: output.rollbackMaterialRetained
    }
  }

  async previewRollback(
    input: Readonly<NebulaPluginRollbackReadRequest>
  ): Promise<NebulaPluginRollbackPreviewResult> {
    const request = parseRequest(rollbackReadRequestSchema, input)
    const output = await this.#runReadOnly(
      rollbackScriptName,
      this.#rollbackBaseArguments(request),
      request.signal,
      rollbackPreviewOutputSchema
    )
    const expectedPhrase = rollbackConfirmationPhrase(
      request.rollbackRequestId,
      output.previewDigest
    )
    if (output.originalRequestId !== request.originalRequestId ||
        output.rollbackRequestId !== request.rollbackRequestId ||
        output.exactConfirmationPhrase !== expectedPhrase) {
      throw resultInvalid()
    }
    return {
      originalRequestId: output.originalRequestId,
      rollbackRequestId: output.rollbackRequestId,
      status: output.status,
      mode: output.mode,
      previewDigest: output.previewDigest,
      exactConfirmationPhrase: output.exactConfirmationPhrase,
      productionChanged: output.productionChanged
    }
  }

  async rollback(
    input: Readonly<NebulaPluginRollbackMutationRequest>
  ): Promise<NebulaPluginRollbackResult> {
    const request = parseRequest(rollbackMutationRequestSchema, input)
    return await this.#coordinator.runExclusive(
      { operation: windowsNebulaPluginRollbackOperation, requestId: request.rollbackRequestId },
      (scope) => this.#runRollbackMutation(request, scope, false)
    )
  }

  async recoverRollback(
    input: Readonly<NebulaPluginRollbackMutationRequest>
  ): Promise<NebulaPluginRollbackResult> {
    const request = parseRequest(rollbackMutationRequestSchema, input)
    return await this.#recoveryCoordinator.runRecoveryExclusive(
      {
        expectedOperation: windowsNebulaPluginRollbackOperation,
        expectedRequestId: request.rollbackRequestId
      },
      (scope) => this.#runRollbackMutation(request, scope, true)
    )
  }

  async verifyRollback(
    input: Readonly<NebulaPluginVerifyRollbackRequest>
  ): Promise<NebulaPluginVerifyRollbackResult> {
    const request = parseRequest(verifyRollbackRequestSchema, input)
    const output = await this.#runReadOnly(verifyRollbackScriptName, [
      '-OriginalRequestId', request.originalRequestId,
      '-RollbackRequestId', request.rollbackRequestId,
      '-JobBase', this.#jobBase,
      '-GameRoot', this.#gameRoot,
      '-TargetRole', this.#targetRole,
      '-OriginalPlanPath', this.#planPath(request.originalRequestId),
      '-Backend', 'Windows'
    ], request.signal, verifyRollbackOutputSchema)
    if (output.originalRequestId !== request.originalRequestId ||
        output.rollbackRequestId !== request.rollbackRequestId) {
      throw resultInvalid()
    }
    return {
      originalRequestId: output.originalRequestId,
      rollbackRequestId: output.rollbackRequestId,
      transactionStatus: output.transactionStatus,
      receiptDigest: output.receiptDigest,
      contentAndAclExact: output.contentAndAclExact,
      rollbackMaterialRetained: output.rollbackMaterialRetained
    }
  }

  async #runApplyMutation(
    request: z.output<typeof applyMutationRequestSchema>,
    scope: HostMutationOperationScope,
    recovery: boolean
  ): Promise<HostMutationOperationOutcome<NebulaPluginApplyResult>> {
    return this.#runMutation(scope, async (borrowArguments) => {
      const output = parseOutput(applyOutputSchema, await this.#runner.run(applyScriptName, [
        ...this.#applyBaseArguments(request.requestId),
        '-Apply',
        '-ConfirmationPhrase', request.confirmationPhrase,
        ...(recovery ? ['-Recover'] : []),
        ...borrowArguments,
        '-Confirm:$false'
      ], scope.signal))
      if (output.requestId !== request.requestId ||
          ('targetRole' in output && output.targetRole !== this.#targetRole) ||
          (!recovery && !output.reused && output.status !== 'applied') ||
          (recovery && !output.reused && output.status !== 'rolled-back-recovery')) {
        throw resultInvalid()
      }
      return {
        requestId: output.requestId,
        status: output.status,
        receiptDigest: output.receiptDigest,
        reused: output.reused,
        quarantineRetained: output.status === 'applied',
        candidateStageRetained: output.status !== 'applied'
      }
    })
  }

  async #runRollbackMutation(
    request: z.output<typeof rollbackMutationRequestSchema>,
    scope: HostMutationOperationScope,
    recovery: boolean
  ): Promise<HostMutationOperationOutcome<NebulaPluginRollbackResult>> {
    return this.#runMutation(scope, async (borrowArguments) => {
      const output = parseOutput(rollbackOutputSchema, await this.#runner.run(rollbackScriptName, [
        ...this.#rollbackBaseArguments(request),
        '-Apply',
        '-ConfirmationPhrase', request.confirmationPhrase,
        ...(recovery ? ['-Recover'] : []),
        ...borrowArguments,
        '-Confirm:$false'
      ], scope.signal))
      if (output.requestId !== request.rollbackRequestId ||
          ('originalRequestId' in output && output.originalRequestId !== request.originalRequestId) ||
          (!recovery && !output.reused && output.status !== 'rolled-back-manual') ||
          (recovery && !output.reused && output.status !== 'rollback-recovery-restored-candidate')) {
        throw resultInvalid()
      }
      return {
        originalRequestId: request.originalRequestId,
        rollbackRequestId: output.requestId,
        status: output.status,
        receiptDigest: output.receiptDigest,
        reused: output.reused,
        quarantineRetained: output.status !== 'rolled-back-manual',
        candidateStageRetained: output.status === 'rolled-back-manual'
      }
    })
  }

  async #runMutation<T>(
    scope: HostMutationOperationScope,
    invoke: (borrowArguments: readonly string[]) => Promise<T>
  ): Promise<HostMutationOperationOutcome<T>> {
    assertScopeActive(scope)
    let invoked = false
    try {
      const borrowArguments = this.#borrowArguments(scope)
      assertScopeActive(scope)
      invoked = true
      const value = await invoke(borrowArguments)
      assertScopeActive(scope)
      return hostMutationReturn(value)
    } catch (error) {
      // A lost scope must escape so the real coordinator maps it to the
      // canonical HOST_MUTATION_LEASE_LOST outcome. Never downgrade it to a
      // releasable script error.
      assertScopeActive(scope)
      return hostMutationThrow(sanitizeError(error), invoked ? 'abandon' : 'release')
    }
  }

  async #runReadOnly<T extends z.ZodType>(
    scriptName: WindowsNebulaPluginTransactionScriptName,
    arguments_: string[],
    signal: AbortSignal,
    schema: T
  ): Promise<z.output<T>> {
    assertReadSignal(signal)
    try {
      const output = await this.#runner.run(scriptName, arguments_, signal)
      assertReadSignal(signal)
      return parseOutput(schema, output)
    } catch (error) {
      if (signal.aborted) {
        throw new WindowsNebulaPluginTransactionError(
          'WINDOWS_NEBULA_PLUGIN_TRANSACTION_CANCELLED'
        )
      }
      throw sanitizeError(error)
    }
  }

  #applyBaseArguments(requestId: string): string[] {
    return [
      '-RequestId', requestId,
      '-JobBase', this.#jobBase,
      '-GameRoot', this.#gameRoot,
      '-TargetRole', this.#targetRole,
      '-PlanPath', this.#planPath(requestId),
      '-CandidateManifestPath', this.#candidateManifestPath(requestId),
      '-Backend', 'Windows'
    ]
  }

  #rollbackBaseArguments(request: {
    originalRequestId: string
    rollbackRequestId: string
    originalReceiptSha256: string
    maintenanceWindowStartUtc: string
    maintenanceWindowEndUtc: string
  }): string[] {
    return [
      '-OriginalRequestId', request.originalRequestId,
      '-RollbackRequestId', request.rollbackRequestId,
      '-JobBase', this.#jobBase,
      '-GameRoot', this.#gameRoot,
      '-TargetRole', this.#targetRole,
      '-OriginalPlanPath', this.#planPath(request.originalRequestId),
      '-OriginalReceiptSha256', request.originalReceiptSha256,
      '-MaintenanceWindowStartUtc', request.maintenanceWindowStartUtc,
      '-MaintenanceWindowEndUtc', request.maintenanceWindowEndUtc,
      '-Backend', 'Windows'
    ]
  }

  #borrowArguments(scope: HostMutationOperationScope): readonly string[] {
    let raw: readonly string[]
    try {
      raw = scope.toPowerShellBorrowArguments()
    } catch (error) {
      assertScopeActive(scope)
      throw sanitizeError(error, 'WINDOWS_NEBULA_PLUGIN_TRANSACTION_BORROW_BINDING_INVALID')
    }
    if (!Array.isArray(raw) || raw.length !== 6 ||
        raw.some((value) => typeof value !== 'string') ||
        raw[0] !== '-DataRoot' || !sameWindowsPath(raw[1]!, this.#dataRoot) ||
        raw[2] !== '-LeaseInstanceId' || !requestIdSchema.safeParse(raw[3]).success ||
        raw[4] !== '-LeaseToken' || !/^[A-Za-z0-9_-]{43}$/u.test(raw[5]!)) {
      throw new WindowsNebulaPluginTransactionError(
        'WINDOWS_NEBULA_PLUGIN_TRANSACTION_BORROW_BINDING_INVALID'
      )
    }
    // V3 scripts deliberately use HostMutation-prefixed parameter names while
    // the shared coordinator exposes the broker-neutral borrow tuple.
    return [
      '-HostMutationDataRoot', raw[1]!,
      '-HostMutationLeaseInstanceId', raw[3]!,
      '-HostMutationLeaseToken', raw[5]!
    ]
  }

  #planPath(requestId: string): string {
    return path.win32.join(this.#jobBase, requestId, 'evidence', 'plugin-cutover-plan.json')
  }

  #candidateManifestPath(requestId: string): string {
    return path.win32.join(this.#jobBase, requestId, 'evidence', 'candidate-manifest.json')
  }
}

export function nebulaPluginApplyConfirmationPhrase(requestId: string, planDigest: string): string {
  const request = requestIdSchema.safeParse(requestId)
  const digest = sha256Schema.safeParse(planDigest)
  if (!request.success || !digest.success) {
    throw new WindowsNebulaPluginTransactionError(
      'WINDOWS_NEBULA_PLUGIN_TRANSACTION_REQUEST_INVALID'
    )
  }
  return applyConfirmationPhrase(request.data, digest.data)
}

function applyConfirmationPhrase(requestId: string, planDigest: string): string {
  return `CONFIRM NEBULA PLUGIN CUTOVER ${requestId} ${planDigest}`
}

function rollbackConfirmationPhrase(rollbackRequestId: string, previewDigest: string): string {
  return `CONFIRM NEBULA PLUGIN ROLLBACK ${rollbackRequestId} ${previewDigest}`
}

function withWindow<T extends z.ZodRawShape>(schema: z.ZodObject<T>): z.ZodObject<T> {
  return schema.superRefine((value, context) => {
    const window = value as unknown as {
      maintenanceWindowStartUtc: string
      maintenanceWindowEndUtc: string
    }
    const start = Date.parse(window.maintenanceWindowStartUtc)
    const end = Date.parse(window.maintenanceWindowEndUtc)
    const utc = /(?:Z|\+00:00)$/u
    if (!utc.test(window.maintenanceWindowStartUtc) ||
        !utc.test(window.maintenanceWindowEndUtc) ||
        !Number.isFinite(start) || !Number.isFinite(end) || start >= end ||
        end - start > 8 * 60 * 60 * 1_000) {
      context.addIssue({ code: 'custom', path: ['maintenanceWindowEndUtc'], message: 'window-order' })
    }
  }) as unknown as z.ZodObject<T>
}

function assertDistinctRollbackIds(
  value: { originalRequestId: string; rollbackRequestId: string },
  context: z.RefinementCtx
): void {
  if (value.originalRequestId === value.rollbackRequestId) {
    context.addIssue({ code: 'custom', path: ['rollbackRequestId'], message: 'request-id-binding' })
  }
}

function parseRequest<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    throw new WindowsNebulaPluginTransactionError(
      'WINDOWS_NEBULA_PLUGIN_TRANSACTION_REQUEST_INVALID'
    )
  }
  return parsed.data
}

function parseOutput<T extends z.ZodType>(schema: T, output: string): z.output<T> {
  if (typeof output !== 'string' || output.length < 2 ||
      Buffer.byteLength(output, 'utf8') > maximumOutputBytes) {
    throw resultInvalid()
  }
  try {
    const parsed = schema.safeParse(JSON.parse(output) as unknown)
    if (!parsed.success) throw resultInvalid()
    return parsed.data
  } catch (error) {
    if (error instanceof WindowsNebulaPluginTransactionError) throw error
    throw resultInvalid()
  }
}

function sanitizeError(
  error: unknown,
  fallback: WindowsNebulaPluginTransactionErrorCode =
    'WINDOWS_NEBULA_PLUGIN_TRANSACTION_SCRIPT_FAILED'
): Error {
  if (error instanceof HostMutationOperationCoordinatorError ||
      error instanceof WindowsNebulaPluginTransactionError) return error
  const code = typeof error === 'object' && error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null
  if (code === 'HOST_SCRIPT_TIMEOUT') {
    return new WindowsNebulaPluginTransactionError(
      'WINDOWS_NEBULA_PLUGIN_TRANSACTION_TIMEOUT'
    )
  }
  if (code === 'HOST_SCRIPT_ABORTED' || code === 'HOST_SCRIPT_CANCELLED') {
    return new WindowsNebulaPluginTransactionError(
      'WINDOWS_NEBULA_PLUGIN_TRANSACTION_CANCELLED'
    )
  }
  return new WindowsNebulaPluginTransactionError(fallback)
}

function resultInvalid(): WindowsNebulaPluginTransactionError {
  return new WindowsNebulaPluginTransactionError(
    'WINDOWS_NEBULA_PLUGIN_TRANSACTION_RESULT_INVALID'
  )
}

function assertReadSignal(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new WindowsNebulaPluginTransactionError(
      'WINDOWS_NEBULA_PLUGIN_TRANSACTION_CANCELLED'
    )
  }
}

function assertScopeActive(scope: HostMutationOperationScope): void {
  scope.assertActive()
  if (scope.signal.aborted) {
    throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_LOST')
  }
}

function isSafeWindowsRoot(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 3 || value.length > 1_024 ||
      !path.win32.isAbsolute(value) || /[\0\r\n"]/u.test(value)) return false
  const normalized = normalizeWindowsPath(value)
  return normalized.toUpperCase() !==
    normalizeWindowsPath(path.win32.parse(normalized).root).toUpperCase()
}

function normalizeWindowsPath(value: string): string {
  return path.win32.resolve(value).replace(/[\\/]+$/u, '')
}

function sameWindowsPath(left: string, right: string): boolean {
  return typeof left === 'string' && isSafeWindowsRoot(left) &&
    normalizeWindowsPath(left).toUpperCase() === normalizeWindowsPath(right).toUpperCase()
}

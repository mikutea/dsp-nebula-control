import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'
import type { HostMutationOperationScope } from '../host-mutation/operation-coordinator.js'
import type {
  WindowsCutoverCandidateTaskRequest,
  WindowsCutoverFixedMutationRequest,
  WindowsCutoverHostClient,
  WindowsCutoverInspectionRequest
} from './windows-cutover.js'

const evidenceScriptName = 'Get-DysonCutoverEvidence.ps1'
const brokerSubmitScriptName = 'Submit-DysonCutoverBrokerRequest.ps1'
const authorityProfileDirectoryName = 'authority-inventory'
const authorityProfileFileName = 'authority-profile.json'
const brokerDirectoryName = 'cutover-broker'
const brokerProfileFileName = 'broker-profile.json'
const maximumJsonBytes = 64 * 1024

const requestIdSchema = z.string().uuid().transform((value) => value.toLowerCase())
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
const safePathSchema = z.string().min(3).max(1_024).refine((value) =>
  path.win32.isAbsolute(value) && !/[\0\r\n"]/u.test(value)
)
const serviceUserSchema = z.string().min(3).max(128).regex(/^[^"\r\n]+$/u)
const abortSignalSchema = z.custom<AbortSignal>((value) =>
  typeof value === 'object' && value !== null &&
  typeof (value as AbortSignal).aborted === 'boolean' &&
  typeof (value as AbortSignal).addEventListener === 'function' &&
  typeof (value as AbortSignal).throwIfAborted === 'function')
const hostMutationSchema = z.custom<HostMutationOperationScope>((value) =>
  typeof value === 'object' && value !== null &&
  abortSignalSchema.safeParse((value as HostMutationOperationScope).signal).success &&
  typeof (value as HostMutationOperationScope).assertActive === 'function' &&
  typeof (value as HostMutationOperationScope).toPowerShellBorrowArguments === 'function')

const evidenceSchema = z.strictObject({
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

const inspectionReceiptSchema = z.strictObject({
  protocol: z.literal('DYSON_CONTROL_CUTOVER_EVIDENCE_V1'),
  schemaVersion: z.literal(1),
  requestId: requestIdSchema,
  authorityInventoryRevision: sha256Schema,
  evidence: evidenceSchema
})

const actionValues = [
  'DisablePreviousAuthority',
  'StopPreviousRuntime',
  'EnablePreviousAuthority',
  'StartPreviousRuntime',
  'StartCandidateRuntime',
  'StopCandidateRuntime'
] as const
const actionSchema = z.enum(actionValues)
type WindowsCutoverFixedAction = z.output<typeof actionSchema>
const brokerCapabilitySchema = z.enum(['CandidateTaskTransaction', 'CutoverEvidence', ...actionValues])
type WindowsCutoverBrokerCapability = z.output<typeof brokerCapabilitySchema>

const actionReceiptSchema = z.strictObject({
  protocol: z.literal('DYSON_CONTROL_CUTOVER_ACTION_RECEIPT_V1'),
  schemaVersion: z.literal(1),
  requestId: requestIdSchema,
  authorityInventoryRevision: sha256Schema,
  action: z.enum([...actionValues, 'ReconcilePreviousStop']),
  status: z.literal('succeeded')
})

/** Exact child receipt emitted by the broker's fixed runtime-task transaction. */
const runtimeTaskReceiptSchema = z.strictObject({
  protocol: z.literal('DYSON_CONTROL_RUNTIME_TASK_RECEIPT_V2'),
  schemaVersion: z.literal(2),
  requestId: requestIdSchema,
  requestFingerprint: sha256Schema,
  status: z.enum(['succeeded', 'rolled-back']),
  mode: z.enum(['PrepareDisabled', 'Activate']),
  serverTask: z.literal('Dyson-Nebula-Server'),
  stopTask: z.literal('Dyson-Nebula-Stop'),
  terminalPairDigest: sha256Schema,
  completedAt: z.string().datetime({ offset: true }),
  reused: z.boolean()
})

const brokerResultSchema = z.strictObject({
  protocol: z.literal('DYSON_CONTROL_CUTOVER_BROKER_RESULT_V1'),
  schemaVersion: z.literal(1),
  brokerRequestId: requestIdSchema,
  capability: brokerCapabilitySchema,
  requestId: requestIdSchema,
  authorityInventoryRevision: sha256Schema,
  reused: z.boolean(),
  childReceipt: z.unknown()
})

const invocationSchema = z.strictObject({
  childRequestId: requestIdSchema,
  attempt: z.number().int().min(1).max(64),
  mode: z.enum(['PrepareDisabled', 'Activate']),
  recovery: z.boolean()
})
const inspectionRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  signal: abortSignalSchema
})
const candidateRequestSchema = z.strictObject({
  outerRequestId: requestIdSchema,
  authorityMutation: invocationSchema,
  hostMutation: hostMutationSchema
})
const fixedMutationRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  hostMutation: hostMutationSchema
})

export const windowsCutoverHostScriptNames = [
  evidenceScriptName,
  brokerSubmitScriptName
] as const
export type WindowsCutoverHostScriptName = (typeof windowsCutoverHostScriptNames)[number]

/**
 * Narrow structural surface implemented by the allowlisted PowerShell runner.
 * It deliberately has no executable, script path, environment, or stdin knob.
 */
export interface WindowsCutoverPowerShellRunner {
  run(scriptName: WindowsCutoverHostScriptName, scriptArguments: string[], signal: AbortSignal): Promise<string>
}

const optionsSchema = z.strictObject({
  projectRoot: safePathSchema,
  profileFile: safePathSchema,
  cutoverScriptRoot: safePathSchema,
  runtimeBootstrapRoot: safePathSchema,
  runtimeTaskTransactionRoot: safePathSchema,
  serviceUser: serviceUserSchema,
  gamePort: z.number().int().min(1).max(65_535),
  authorityInventoryRevision: sha256Schema,
  runner: z.custom<WindowsCutoverPowerShellRunner>((value) =>
    typeof value === 'object' && value !== null &&
    typeof (value as { run?: unknown }).run === 'function')
})

export interface WindowsCutoverHostClientOptions {
  projectRoot: string
  profileFile: string
  cutoverScriptRoot: string
  runtimeBootstrapRoot: string
  runtimeTaskTransactionRoot: string
  serviceUser: string
  gamePort: number
  authorityInventoryRevision: string
  runner: WindowsCutoverPowerShellRunner
}

export type WindowsCutoverHostClientErrorCode =
  | 'WINDOWS_CUTOVER_HOST_OPTIONS_INVALID'
  | 'WINDOWS_CUTOVER_HOST_REQUEST_INVALID'
  | 'WINDOWS_CUTOVER_HOST_BORROW_BINDING_INVALID'
  | 'WINDOWS_CUTOVER_HOST_INSPECTION_FAILED'
  | 'WINDOWS_CUTOVER_HOST_AUTHORITY_REVISION_MISMATCH'
  | 'WINDOWS_CUTOVER_HOST_CANDIDATE_TRANSACTION_FAILED'
  | 'WINDOWS_CUTOVER_HOST_MUTATION_FAILED'

export class WindowsCutoverHostClientError extends Error {
  readonly code: WindowsCutoverHostClientErrorCode

  constructor(code: WindowsCutoverHostClientErrorCode) {
    super(code)
    this.name = 'WindowsCutoverHostClientError'
    this.code = code
  }
}

/**
 * Fixed-capability Windows host client for the GSManager -> Dyson cutover.
 *
 * The outer request id and attempt are durably bound by the SQLite cutover
 * journal. A deterministic broker request id makes timeout reconciliation an
 * exact replay. The low-privilege API can execute only the read-only evidence
 * script and the fixed broker submission frontend; SYSTEM-only child scripts
 * never enter its runner allowlist. The strict broker envelope and child
 * receipt are both validated before the adapter sees a result.
 */
export class FixedWindowsCutoverHostClient implements WindowsCutoverHostClient {
  readonly #projectRoot: string
  readonly #profileFile: string
  readonly #dataRoot: string
  readonly #cutoverScriptRoot: string
  readonly #brokerRoot: string
  readonly #brokerProfileFile: string
  readonly #runtimeBootstrapRoot: string
  readonly #runtimeTaskTransactionRoot: string
  readonly #serviceUser: string
  readonly #gamePort: number
  readonly #authorityInventoryRevision: string
  readonly #runner: WindowsCutoverPowerShellRunner

  constructor(options: WindowsCutoverHostClientOptions) {
    const parsed = optionsSchema.safeParse(options)
    if (!parsed.success) {
      throw new WindowsCutoverHostClientError('WINDOWS_CUTOVER_HOST_OPTIONS_INVALID')
    }
    const profileFile = normalizeWindowsPath(parsed.data.profileFile)
    const profileDirectory = path.win32.dirname(profileFile)
    if (path.win32.basename(profileFile).toLowerCase() !== authorityProfileFileName ||
        path.win32.basename(profileDirectory).toLowerCase() !== authorityProfileDirectoryName) {
      throw new WindowsCutoverHostClientError('WINDOWS_CUTOVER_HOST_OPTIONS_INVALID')
    }
    const dataRoot = path.win32.dirname(profileDirectory)
    if (!path.win32.isAbsolute(dataRoot) || isWindowsVolumeRoot(dataRoot)) {
      throw new WindowsCutoverHostClientError('WINDOWS_CUTOVER_HOST_OPTIONS_INVALID')
    }

    this.#projectRoot = normalizeWindowsPath(parsed.data.projectRoot)
    this.#profileFile = profileFile
    this.#dataRoot = dataRoot
    this.#cutoverScriptRoot = normalizeWindowsPath(parsed.data.cutoverScriptRoot)
    if (isWindowsVolumeRoot(this.#cutoverScriptRoot)) {
      throw new WindowsCutoverHostClientError('WINDOWS_CUTOVER_HOST_OPTIONS_INVALID')
    }
    this.#brokerRoot = path.win32.join(dataRoot, brokerDirectoryName)
    this.#brokerProfileFile = path.win32.join(this.#brokerRoot, brokerProfileFileName)
    this.#runtimeBootstrapRoot = normalizeWindowsPath(parsed.data.runtimeBootstrapRoot)
    this.#runtimeTaskTransactionRoot = normalizeWindowsPath(parsed.data.runtimeTaskTransactionRoot)
    this.#serviceUser = parsed.data.serviceUser
    this.#gamePort = parsed.data.gamePort
    this.#authorityInventoryRevision = parsed.data.authorityInventoryRevision
    this.#runner = parsed.data.runner
  }

  async inspect(input: Readonly<WindowsCutoverInspectionRequest>): Promise<unknown> {
    const request = parseRequest(inspectionRequestSchema, input)
    assertInspectionSignal(request.signal)
    try {
      // Each observation needs fresh SYSTEM evidence, even for the same outer request.
      const brokerRequestId = randomUUID()
      const output = await this.#runner.run(
        brokerSubmitScriptName,
        this.#brokerArguments(brokerRequestId, 'CutoverEvidence', request.requestId, []),
        request.signal
      )
      assertInspectionSignal(request.signal)
      const receipt = inspectionReceiptSchema.parse(this.#parseBrokerResult(
        output, brokerRequestId, 'CutoverEvidence', request.requestId
      ).childReceipt)
      if (receipt.requestId !== request.requestId) {
        throw new WindowsCutoverHostClientError('WINDOWS_CUTOVER_HOST_INSPECTION_FAILED')
      }
      this.#assertInventoryRevision(receipt.authorityInventoryRevision)
      return {
        authorityInventoryRevision: receipt.authorityInventoryRevision,
        evidence: receipt.evidence
      }
    } catch (error) {
      if (request.signal.aborted) {
        throw new WindowsCutoverHostClientError('WINDOWS_CUTOVER_HOST_INSPECTION_FAILED')
      }
      if (error instanceof WindowsCutoverHostClientError &&
          error.code === 'WINDOWS_CUTOVER_HOST_AUTHORITY_REVISION_MISMATCH') throw error
      throw new WindowsCutoverHostClientError('WINDOWS_CUTOVER_HOST_INSPECTION_FAILED')
    }
  }

  async runCandidateTaskTransaction(
    input: Readonly<WindowsCutoverCandidateTaskRequest>
  ): Promise<unknown> {
    const request = parseRequest(candidateRequestSchema, input)
    const scope = request.hostMutation
    scope.assertActive()
    try {
      const borrowArguments = this.#borrowArguments(scope)
      const invocation = request.authorityMutation
      const brokerRequestId = deriveBrokerRequestId([
        'CandidateTaskTransaction',
        request.outerRequestId,
        invocation.childRequestId,
        String(invocation.attempt),
        invocation.mode,
        String(invocation.recovery),
        this.#authorityInventoryRevision
      ])
      const arguments_ = [
        ...this.#brokerArguments(
          brokerRequestId,
          'CandidateTaskTransaction',
          invocation.childRequestId,
          borrowArguments
        ),
        '-CandidateMode', invocation.mode,
        ...(invocation.recovery ? ['-CandidateRecover'] : [])
      ]
      const output = await this.#runCandidateWithOneOrdinaryReplay(
        arguments_, invocation.recovery, scope
      )
      scope.assertActive()
      const brokerResult = this.#parseBrokerResult(
        output,
        brokerRequestId,
        'CandidateTaskTransaction',
        invocation.childRequestId
      )
      const receipt = runtimeTaskReceiptSchema.parse(brokerResult.childReceipt)
      if (receipt.requestId !== invocation.childRequestId || receipt.mode !== invocation.mode) {
        throw new WindowsCutoverHostClientError(
          'WINDOWS_CUTOVER_HOST_CANDIDATE_TRANSACTION_FAILED'
        )
      }
      scope.assertActive()
      return {
        outerRequestId: request.outerRequestId,
        childRequestId: invocation.childRequestId,
        attempt: invocation.attempt,
        mode: invocation.mode,
        recovery: invocation.recovery,
        status: receipt.status,
        receiptDigest: receipt.terminalPairDigest
      }
    } catch {
      scope.assertActive()
      throw new WindowsCutoverHostClientError('WINDOWS_CUTOVER_HOST_CANDIDATE_TRANSACTION_FAILED')
    }
  }

  /**
   * A broker request writes its intent before the SYSTEM worker dispatches the
   * fixed child capability. One byte-for-byte identical ordinary replay can
   * therefore reconcile a timeout or retrieve a durable terminal result
   * without authorizing a different write. Explicit recovery is never retried
   * implicitly.
   */
  async #runCandidateWithOneOrdinaryReplay(
    arguments_: readonly string[],
    recovery: boolean,
    scope: HostMutationOperationScope
  ): Promise<string> {
    try {
      return await this.#runner.run(brokerSubmitScriptName, [...arguments_], scope.signal)
    } catch {
      scope.assertActive()
      if (recovery) {
        throw new WindowsCutoverHostClientError(
          'WINDOWS_CUTOVER_HOST_CANDIDATE_TRANSACTION_FAILED'
        )
      }
      try {
        // Deliberately byte-for-byte identical: same child id, mode, roots,
        // borrowed lease binding, and still no -Recover switch.
        return await this.#runner.run(brokerSubmitScriptName, [...arguments_], scope.signal)
      } catch {
        scope.assertActive()
        throw new WindowsCutoverHostClientError(
          'WINDOWS_CUTOVER_HOST_CANDIDATE_TRANSACTION_FAILED'
        )
      }
    }
  }

  disablePreviousAuthority(input: Readonly<WindowsCutoverFixedMutationRequest>): Promise<unknown> {
    return this.#runFixedMutation('DisablePreviousAuthority', input)
  }

  stopPreviousRuntime(input: Readonly<WindowsCutoverFixedMutationRequest>, options?: Readonly<{ reconcileOnly: true }>): Promise<unknown> {
    return this.#runFixedMutation('StopPreviousRuntime', input, options)
  }

  enablePreviousAuthority(input: Readonly<WindowsCutoverFixedMutationRequest>): Promise<unknown> {
    return this.#runFixedMutation('EnablePreviousAuthority', input)
  }

  startPreviousRuntime(input: Readonly<WindowsCutoverFixedMutationRequest>): Promise<unknown> {
    return this.#runFixedMutation('StartPreviousRuntime', input)
  }

  startCandidateRuntime(input: Readonly<WindowsCutoverFixedMutationRequest>): Promise<unknown> {
    return this.#runFixedMutation('StartCandidateRuntime', input)
  }

  stopCandidateRuntime(input: Readonly<WindowsCutoverFixedMutationRequest>): Promise<unknown> {
    return this.#runFixedMutation('StopCandidateRuntime', input)
  }

  async #runFixedMutation(
    action: WindowsCutoverFixedAction,
    input: Readonly<WindowsCutoverFixedMutationRequest>,
    options?: Readonly<{ reconcileOnly: true }>
  ): Promise<unknown> {
    const request = parseRequest(fixedMutationRequestSchema, input)
    const scope = request.hostMutation
    scope.assertActive()
    try {
      const borrowArguments = this.#borrowArguments(scope)
      const brokerRequestId = deriveBrokerRequestId([
        action,
        request.requestId,
        this.#authorityInventoryRevision,
        ...(action === 'StopPreviousRuntime' ? [borrowArguments[3]!] : []),
        ...(options?.reconcileOnly ? ['reconcile-only'] : [])
      ])
      const output = await this.#runner.run(
        brokerSubmitScriptName,
        [...this.#brokerArguments(brokerRequestId, action, request.requestId, borrowArguments),
          ...(options?.reconcileOnly ? ['-PreviousStopReconcileOnly'] : [])],
        scope.signal
      )
      scope.assertActive()
      const brokerResult = this.#parseBrokerResult(
        output,
        brokerRequestId,
        action,
        request.requestId
      )
      const receipt = actionReceiptSchema.parse(brokerResult.childReceipt)
      if (receipt.requestId !== request.requestId || receipt.action !== (options?.reconcileOnly ? 'ReconcilePreviousStop' : action)) {
        throw new WindowsCutoverHostClientError('WINDOWS_CUTOVER_HOST_MUTATION_FAILED')
      }
      this.#assertInventoryRevision(receipt.authorityInventoryRevision)
      scope.assertActive()
      return { requestId: receipt.requestId, status: receipt.status }
    } catch {
      scope.assertActive()
      throw new WindowsCutoverHostClientError('WINDOWS_CUTOVER_HOST_MUTATION_FAILED')
    }
  }

  #brokerArguments(
    brokerRequestId: string,
    capability: WindowsCutoverBrokerCapability,
    requestId: string,
    borrowArguments: readonly string[]
  ): string[] {
    return [
      '-BrokerRoot', this.#brokerRoot,
      '-BrokerProfileFile', this.#brokerProfileFile,
      '-BrokerRequestId', brokerRequestId,
      '-Capability', capability,
      '-RequestId', requestId,
      '-AuthorityInventoryRevision', this.#authorityInventoryRevision,
      '-ProjectRoot', this.#projectRoot,
      '-DataRoot', this.#dataRoot,
      '-AuthorityProfileFile', this.#profileFile,
      '-CutoverScriptRoot', this.#cutoverScriptRoot,
      '-RuntimeBootstrapRoot', this.#runtimeBootstrapRoot,
      '-RuntimeTaskTransactionRoot', this.#runtimeTaskTransactionRoot,
      '-ServiceUser', this.#serviceUser,
      '-GamePort', String(this.#gamePort),
      ...(capability === 'CutoverEvidence' ? [] : [
        '-LeaseInstanceId', borrowArguments[3]!,
        '-LeaseToken', borrowArguments[5]!
      ])
    ]
  }

  #parseBrokerResult(
    output: string,
    brokerRequestId: string,
    capability: WindowsCutoverBrokerCapability,
    requestId: string
  ): z.output<typeof brokerResultSchema> {
    const result = brokerResultSchema.parse(parseJson(output))
    if (result.brokerRequestId !== brokerRequestId ||
        result.capability !== capability ||
        result.requestId !== requestId) {
      throw new WindowsCutoverHostClientError('WINDOWS_CUTOVER_HOST_MUTATION_FAILED')
    }
    this.#assertInventoryRevision(result.authorityInventoryRevision)
    return result
  }

  #borrowArguments(scope: HostMutationOperationScope): string[] {
    let raw: readonly string[]
    try {
      raw = scope.toPowerShellBorrowArguments()
    } catch {
      scope.assertActive()
      throw new WindowsCutoverHostClientError('WINDOWS_CUTOVER_HOST_BORROW_BINDING_INVALID')
    }
    if (!Array.isArray(raw) || raw.length !== 6 || raw.some((value) => typeof value !== 'string') ||
        raw[0] !== '-DataRoot' || !sameWindowsPath(raw[1]!, this.#dataRoot) ||
        raw[2] !== '-LeaseInstanceId' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(raw[3]!) ||
        raw[4] !== '-LeaseToken' || !/^[A-Za-z0-9_-]{43}$/u.test(raw[5]!)) {
      throw new WindowsCutoverHostClientError('WINDOWS_CUTOVER_HOST_BORROW_BINDING_INVALID')
    }
    return [...raw]
  }

  #assertInventoryRevision(actual: string): void {
    if (actual !== this.#authorityInventoryRevision) {
      throw new WindowsCutoverHostClientError(
        'WINDOWS_CUTOVER_HOST_AUTHORITY_REVISION_MISMATCH'
      )
    }
  }
}

function parseRequest<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    throw new WindowsCutoverHostClientError('WINDOWS_CUTOVER_HOST_REQUEST_INVALID')
  }
  return parsed.data
}

function parseJson(output: string): unknown {
  if (typeof output !== 'string' || output.length < 2 ||
      Buffer.byteLength(output, 'utf8') > maximumJsonBytes) {
    throw new WindowsCutoverHostClientError('WINDOWS_CUTOVER_HOST_REQUEST_INVALID')
  }
  try {
    return JSON.parse(output) as unknown
  } catch {
    throw new WindowsCutoverHostClientError('WINDOWS_CUTOVER_HOST_REQUEST_INVALID')
  }
}

function assertInspectionSignal(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new WindowsCutoverHostClientError('WINDOWS_CUTOVER_HOST_INSPECTION_FAILED')
  }
}

function normalizeWindowsPath(value: string): string {
  return path.win32.resolve(value).replace(/[\\/]+$/u, '')
}

function sameWindowsPath(left: string, right: string): boolean {
  if (typeof left !== 'string' || !path.win32.isAbsolute(left) || /[\0\r\n"]/u.test(left)) return false
  return normalizeWindowsPath(left).toUpperCase() === normalizeWindowsPath(right).toUpperCase()
}

function isWindowsVolumeRoot(value: string): boolean {
  return normalizeWindowsPath(value).toUpperCase() ===
    normalizeWindowsPath(path.win32.parse(value).root).toUpperCase()
}

function deriveBrokerRequestId(bindings: readonly string[]): string {
  const dnsNamespace = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex')
  const digest = createHash('sha1')
    .update(dnsNamespace)
    .update(['dyson-control.cutover-broker.v1', ...bindings].join('\n'), 'utf8')
    .digest()
  digest[6] = (digest[6]! & 0x0f) | 0x50
  digest[8] = (digest[8]! & 0x3f) | 0x80
  const value = digest.subarray(0, 16).toString('hex')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'
import type { LifecycleAction, LifecycleHostMutationScope } from '../domain.js'

export const lifecycleBrokerSubmitScriptName = 'Submit-DysonLifecycleBrokerRequest.ps1' as const
export type LifecycleBrokerScriptName = typeof lifecycleBrokerSubmitScriptName

export interface WindowsLifecycleBrokerPowerShellRunner {
  run(scriptName: LifecycleBrokerScriptName, scriptArguments: string[], signal: AbortSignal): Promise<string>
}

const requestIdSchema = z.string().uuid().transform((value) => value.toLowerCase())
const lifecycleStateSchema = z.enum(['running_verified', 'stopped_verified', 'unknown_unverifiable'])
const blockerSchema = z.enum([
  'task_definition_mismatch', 'interactive_session_missing', 'session_ambiguous',
  'steam_session_missing', 'process_unverifiable', 'server_already_running',
  'server_not_running', 'state_mismatch', 'recovery_required'
])
const taskSchema = z.strictObject({
  valid: z.boolean(),
  server: z.strictObject({
    name: z.literal('Dyson-Nebula-Server'), path: z.literal('\\'),
    state: z.string().min(1).max(32)
  }),
  stop: z.strictObject({
    name: z.literal('Dyson-Nebula-Stop'), path: z.literal('\\'),
    state: z.string().min(1).max(32)
  })
})
const runtimeSchema = z.strictObject({
  lifecycleState: lifecycleStateSchema,
  session: z.strictObject({
    status: z.enum(['missing', 'verified', 'ambiguous']),
    id: z.number().int().min(0).max(65_535).nullable(),
    count: z.number().int().min(0).max(16)
  }),
  steam: z.strictObject({
    status: z.enum(['missing', 'verified', 'ambiguous']),
    pid: z.number().int().positive().nullable(),
    sessionId: z.number().int().min(0).max(65_535).nullable()
  }),
  process: z.strictObject({
    status: z.enum(['absent', 'verified', 'unverifiable']),
    pid: z.number().int().positive().nullable(),
    owner: z.string().min(1).max(128).nullable(),
    sessionId: z.number().int().min(0).max(65_535).nullable()
  }),
  port: z.strictObject({
    port: z.number().int().min(1).max(65_535),
    listenerCount: z.number().int().min(0).max(16)
  }),
  pidFile: z.strictObject({ present: z.boolean(), valid: z.boolean() })
}).superRefine((runtime, context) => {
  const sessionConsistent = runtime.session.status === 'verified'
    ? runtime.session.id !== null && runtime.session.count === 1
    : runtime.session.id === null && (runtime.session.status === 'missing'
      ? runtime.session.count === 0
      : runtime.session.count >= 2)
  if (!sessionConsistent) {
    context.addIssue({ code: 'custom', path: ['session'], message: 'session-evidence' })
  }
  if ((runtime.process.status === 'verified') !==
      (runtime.process.pid !== null && runtime.process.owner !== null && runtime.process.sessionId !== null)) {
    context.addIssue({ code: 'custom', path: ['process'], message: 'process-evidence' })
  }
  const steamFieldsPresent = runtime.steam.pid !== null && runtime.steam.sessionId !== null
  const steamFieldsAbsent = runtime.steam.pid === null && runtime.steam.sessionId === null
  if ((!steamFieldsPresent && !steamFieldsAbsent) ||
      (runtime.steam.status === 'verified' && !steamFieldsPresent) ||
      (runtime.steam.status === 'missing' && !steamFieldsAbsent)) {
    context.addIssue({ code: 'custom', path: ['steam'], message: 'steam-evidence' })
  }
  if (!runtime.pidFile.present && runtime.pidFile.valid) {
    context.addIssue({ code: 'custom', path: ['pidFile'], message: 'pid-file-evidence' })
  }
})
const preflightEvidenceSchema = z.strictObject({
  action: z.enum(['start', 'save', 'graceful-stop', 'restart']),
  allowed: z.boolean(),
  blockers: z.array(blockerSchema).max(16),
  task: taskSchema,
  runtime: runtimeSchema,
  dispatch: z.strictObject({ attempted: z.literal(false), taskName: z.null() })
})
const verifyEvidenceSchema = z.strictObject({
  expected: z.enum(['running', 'stopped']),
  matched: z.boolean(),
  blockers: z.array(blockerSchema).max(16),
  runtime: runtimeSchema
})
const processTelemetrySchema = z.strictObject({
  processId: z.number().int().positive(),
  startedAtUnixMs: z.number().int().positive(),
  sampledAtUnixMs: z.number().int().positive(),
  processCoresUsed: z.number().finite().nonnegative(),
  workingSetGiB: z.number().finite().nonnegative(),
  privateMemoryGiB: z.number().finite().nonnegative(),
  threadCount: z.number().int().nonnegative()
})
const statusEvidenceSchema = z.strictObject({
  lifecycleState: lifecycleStateSchema,
  task: taskSchema,
  runtime: runtimeSchema,
  processTelemetry: processTelemetrySchema.nullable().optional()
}).superRefine((evidence, context) => {
  if (evidence.lifecycleState !== evidence.runtime.lifecycleState) {
    context.addIssue({ code: 'custom', message: 'state-binding' })
  }
  const telemetry = evidence.processTelemetry
  if (telemetry && (evidence.lifecycleState !== 'running_verified' ||
      evidence.runtime.process.status !== 'verified' || telemetry.processId !== evidence.runtime.process.pid ||
      telemetry.startedAtUnixMs > telemetry.sampledAtUnixMs)) {
    context.addIssue({ code: 'custom', message: 'telemetry-binding' })
  }
})
const dispatchedEvidenceSchema = z.strictObject({
  operation: z.enum(['start', 'graceful-stop', 'rollback-start']),
  dispatched: z.literal(true),
  blockers: z.array(blockerSchema).length(0),
  taskName: z.enum(['Dyson-Nebula-Server', 'Dyson-Nebula-Stop']),
  taskPath: z.literal('\\'),
  readyVerified: z.literal(true)
})
const blockedDispatchEvidenceSchema = z.strictObject({
  operation: z.enum(['start', 'graceful-stop', 'rollback-start']),
  dispatched: z.literal(false),
  blockers: z.array(blockerSchema).min(1).max(16),
  taskName: z.enum(['Dyson-Nebula-Server', 'Dyson-Nebula-Stop']),
  runtime: runtimeSchema
})
const recoveredDispatchEvidenceSchema = z.strictObject({
  operation: z.enum(['start', 'graceful-stop', 'rollback-start']),
  dispatched: z.literal(false),
  recovered: z.literal(true),
  blockers: z.array(blockerSchema).length(0),
  runtime: runtimeSchema
})
const dispatchEvidenceSchema = z.union([
  dispatchedEvidenceSchema,
  blockedDispatchEvidenceSchema,
  recoveredDispatchEvidenceSchema
])

const capabilities = ['LifecyclePreflight', 'LifecycleDispatch', 'LifecycleVerify', 'LifecycleStatus'] as const
const capabilitySchema = z.enum(capabilities)
const errorCodeSchema = z.enum([
  'DYSON_CONTROL_LIFECYCLE_BROKER_INPUT_INVALID',
  'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_INVALID',
  'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_BINDING_MISMATCH',
  'DYSON_CONTROL_LIFECYCLE_BROKER_PATH_INVALID',
  'DYSON_CONTROL_LIFECYCLE_BROKER_HASH_DRIFT',
  'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID',
  'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_CONFLICT',
  'DYSON_CONTROL_LIFECYCLE_BROKER_RECEIPT_INVALID',
  'DYSON_CONTROL_LIFECYCLE_BROKER_STORAGE_UNAVAILABLE',
  'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID',
  'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_TRIGGER_FAILED',
  'DYSON_CONTROL_LIFECYCLE_BROKER_READY_TIMEOUT',
  'DYSON_CONTROL_LIFECYCLE_BROKER_TIMEOUT',
  'DYSON_CONTROL_LIFECYCLE_BROKER_CANCELLED',
  'DYSON_CONTROL_LIFECYCLE_BROKER_LEASE_INVALID',
  'DYSON_CONTROL_LIFECYCLE_BROKER_CAPABILITY_INVALID',
  'DYSON_CONTROL_LIFECYCLE_BROKER_RECOVERY_REQUIRED',
  'DYSON_CONTROL_LIFECYCLE_BROKER_ACCESS_CONTROL_FAILED',
  'DYSON_CONTROL_LIFECYCLE_BROKER_INSTALL_FAILED',
  'DYSON_CONTROL_LIFECYCLE_BROKER_SHADOW_FORBIDDEN',
  'DYSON_CONTROL_LIFECYCLE_BROKER_INTERNAL_ERROR'
])
const receiptBaseSchema = z.strictObject({
  protocol: z.literal('DYSON_CONTROL_LIFECYCLE_BROKER_RECEIPT_V1'),
  schemaVersion: z.literal(1),
  brokerRequestId: requestIdSchema,
  requestFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  capability: capabilitySchema,
  status: z.enum(['succeeded', 'blocked', 'failed']),
  errorCode: errorCodeSchema.nullable(),
  evidence: z.unknown(),
  createdAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }),
  reused: z.boolean()
})
const resultSchema = z.strictObject({
  protocol: z.literal('DYSON_CONTROL_LIFECYCLE_BROKER_RESULT_V1'),
  schemaVersion: z.literal(1),
  brokerRequestId: requestIdSchema,
  capability: capabilitySchema,
  reused: z.boolean(),
  receipt: receiptBaseSchema
})

export type LifecycleBrokerRuntimeEvidence = z.output<typeof runtimeSchema>
export type LifecycleBrokerPreflightEvidence = z.output<typeof preflightEvidenceSchema>
export type LifecycleBrokerStatusEvidence = z.output<typeof statusEvidenceSchema>
export type LifecycleBrokerDispatchEvidence = z.output<typeof dispatchEvidenceSchema>

export type WindowsLifecycleBrokerClientErrorCode =
  | 'WINDOWS_LIFECYCLE_BROKER_OPTIONS_INVALID'
  | 'WINDOWS_LIFECYCLE_BROKER_REQUEST_INVALID'
  | 'WINDOWS_LIFECYCLE_BROKER_RESULT_INVALID'
  | 'WINDOWS_LIFECYCLE_BROKER_BLOCKED'
  | 'WINDOWS_LIFECYCLE_BROKER_FAILED'
  | 'WINDOWS_LIFECYCLE_BROKER_BORROW_BINDING_INVALID'

export class WindowsLifecycleBrokerClientError extends Error {
  readonly code: WindowsLifecycleBrokerClientErrorCode
  readonly brokerErrorCode: string | null
  readonly blockers: readonly string[]

  constructor(
    code: WindowsLifecycleBrokerClientErrorCode,
    options: { brokerErrorCode?: string | null; blockers?: readonly string[] } = {}
  ) {
    super(code)
    this.name = 'WindowsLifecycleBrokerClientError'
    this.code = code
    this.brokerErrorCode = options.brokerErrorCode ?? null
    this.blockers = Object.freeze([...(options.blockers ?? [])])
  }
}

export interface WindowsLifecycleBrokerClient {
  preflight(input: {
    action: LifecycleAction
    outerRequestId?: string
    signal: AbortSignal
  }): Promise<LifecycleBrokerPreflightEvidence>
  dispatch(input: {
    operation: 'start' | 'graceful-stop' | 'rollback-start'
    outerRequestId: string
    hostMutation: LifecycleHostMutationScope
    signal: AbortSignal
  }): Promise<LifecycleBrokerDispatchEvidence>
  verify(input: {
    expected: 'running' | 'stopped'
    outerRequestId: string
    signal: AbortSignal
  }): Promise<z.output<typeof verifyEvidenceSchema>>
  status(input: { signal: AbortSignal }): Promise<LifecycleBrokerStatusEvidence>
}

export interface FixedWindowsLifecycleBrokerClientOptions {
  profileFile: string
  dataRoot: string
  gamePort: number
  timeoutSeconds?: number
  runner: WindowsLifecycleBrokerPowerShellRunner
}

export class FixedWindowsLifecycleBrokerClient implements WindowsLifecycleBrokerClient {
  readonly #profileFile: string
  readonly #brokerRoot: string
  readonly #dataRoot: string
  readonly #gamePort: number
  readonly #timeoutSeconds: number
  readonly #runner: WindowsLifecycleBrokerPowerShellRunner
  #statusInFlight: {
    controller: AbortController
    waiters: number
    promise: Promise<LifecycleBrokerStatusEvidence>
  } | null = null

  constructor(options: FixedWindowsLifecycleBrokerClientOptions) {
    if (!options || typeof options !== 'object' || typeof options.profileFile !== 'string' ||
        !path.isAbsolute(options.profileFile) || /[\0\r\n"]/u.test(options.profileFile) ||
        typeof options.dataRoot !== 'string' || !path.isAbsolute(options.dataRoot) || /[\0\r\n"]/u.test(options.dataRoot) ||
        !Number.isInteger(options.gamePort) || options.gamePort < 1 || options.gamePort > 65_535 ||
        typeof options.runner?.run !== 'function') {
      throw new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_OPTIONS_INVALID')
    }
    const timeoutSeconds = options.timeoutSeconds ?? 120
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 300) {
      throw new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_OPTIONS_INVALID')
    }
    this.#profileFile = path.resolve(options.profileFile)
    this.#brokerRoot = path.dirname(this.#profileFile)
    if (path.basename(this.#profileFile).toLowerCase() !== 'broker-profile.json' ||
        path.basename(this.#brokerRoot).toLowerCase() !== 'lifecycle-broker' ||
        !samePath(path.dirname(this.#brokerRoot), options.dataRoot)) {
      throw new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_OPTIONS_INVALID')
    }
    this.#dataRoot = path.resolve(options.dataRoot)
    this.#gamePort = options.gamePort
    this.#timeoutSeconds = timeoutSeconds
    this.#runner = options.runner
  }

  async preflight(input: {
    action: LifecycleAction
    outerRequestId?: string
    signal: AbortSignal
  }): Promise<LifecycleBrokerPreflightEvidence> {
    assertSignal(input.signal)
    if (!['start', 'save', 'graceful-stop', 'restart'].includes(input.action)) {
      throw new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_REQUEST_INVALID')
    }
    const brokerRequestId = input.outerRequestId
      ? deriveBrokerRequestId(input.outerRequestId, `preflight:${input.action}`)
      : randomUUID()
    const receipt = await this.#invoke('LifecyclePreflight', brokerRequestId, [
      '-Action', input.action
    ], input.signal)
    this.#assertNotFailed(receipt)
    const evidence = parseEvidence(preflightEvidenceSchema, receipt.evidence)
    const allowedEvidenceConsistent = evidence.task.valid &&
      runtimeMatchesExpected(evidence.runtime, input.action === 'start' ? 'stopped' : 'running') &&
      evidence.runtime.session.status === 'verified' &&
      (!(input.action === 'start' || input.action === 'restart') ||
        evidence.runtime.steam.status === 'verified')
    if (evidence.action !== input.action || evidence.runtime.port.port !== this.#gamePort ||
        (evidence.allowed && !allowedEvidenceConsistent) ||
        (receipt.status === 'succeeded') !== evidence.allowed ||
        (receipt.status === 'blocked') !== (evidence.blockers.length > 0) || receipt.errorCode !== null) {
      throw new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_RESULT_INVALID')
    }
    return evidence
  }

  async dispatch(input: {
    operation: 'start' | 'graceful-stop' | 'rollback-start'
    outerRequestId: string
    hostMutation: LifecycleHostMutationScope
    signal: AbortSignal
  }): Promise<LifecycleBrokerDispatchEvidence> {
    assertSignal(input.signal)
    const outerRequestId = requestIdSchema.safeParse(input.outerRequestId)
    if (!outerRequestId.success || !['start', 'graceful-stop', 'rollback-start'].includes(input.operation) ||
        !input.hostMutation || typeof input.hostMutation.assertActive !== 'function' ||
        typeof input.hostMutation.toPowerShellBorrowArguments !== 'function') {
      throw new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_REQUEST_INVALID')
    }
    input.hostMutation.assertActive()
    const borrow = this.#borrowArguments(input.hostMutation)
    const brokerRequestId = deriveBrokerRequestId(outerRequestId.data, `dispatch:${input.operation}`)
    const receipt = await this.#invoke('LifecycleDispatch', brokerRequestId, [
      '-Operation', input.operation, ...borrow, '-Confirm:$false'
    ], input.signal)
    input.hostMutation.assertActive()
    this.#assertNotFailed(receipt)
    const evidence = parseEvidence(dispatchEvidenceSchema, receipt.evidence)
    const expectedTaskName = input.operation === 'graceful-stop'
      ? 'Dyson-Nebula-Stop'
      : 'Dyson-Nebula-Server'
    const recoveredExpected = input.operation === 'graceful-stop' ? 'stopped' : 'running'
    if (evidence.operation !== input.operation ||
        ('taskName' in evidence && evidence.taskName !== expectedTaskName) ||
        ('runtime' in evidence && evidence.runtime.port.port !== this.#gamePort) ||
        ('recovered' in evidence && !runtimeMatchesExpected(evidence.runtime, recoveredExpected))) {
      throw new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_RESULT_INVALID')
    }
    this.#assertTerminal(receipt, evidence.blockers)
    return evidence
  }

  async verify(input: {
    expected: 'running' | 'stopped'
    outerRequestId: string
    signal: AbortSignal
  }): Promise<z.output<typeof verifyEvidenceSchema>> {
    assertSignal(input.signal)
    const outerRequestId = requestIdSchema.safeParse(input.outerRequestId)
    if (!outerRequestId.success || !['running', 'stopped'].includes(input.expected)) {
      throw new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_REQUEST_INVALID')
    }
    const brokerRequestId = deriveBrokerRequestId(outerRequestId.data, `verify:${input.expected}`)
    const receipt = await this.#invoke('LifecycleVerify', brokerRequestId, [
      '-Expected', input.expected
    ], input.signal)
    this.#assertNotFailed(receipt)
    const evidence = parseEvidence(verifyEvidenceSchema, receipt.evidence)
    const runtimeMatched = runtimeMatchesExpected(evidence.runtime, input.expected)
    if (evidence.expected !== input.expected || evidence.runtime.port.port !== this.#gamePort ||
        evidence.matched !== runtimeMatched ||
        (receipt.status === 'succeeded') !== evidence.matched ||
        (receipt.status === 'blocked') !== (!evidence.matched && evidence.blockers.length > 0)) {
      throw new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_RESULT_INVALID')
    }
    this.#assertTerminal(receipt, evidence.blockers)
    return evidence
  }

  async status(input: { signal: AbortSignal }): Promise<LifecycleBrokerStatusEvidence> {
    assertSignal(input.signal)
    if (input.signal.aborted) throw new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_REQUEST_INVALID')
    let work = this.#statusInFlight
    if (work === null || work.controller.signal.aborted) {
      const controller = new AbortController()
      work = { controller, waiters: 0, promise: this.#readStatus(controller.signal) }
      this.#statusInFlight = work
      const current = work
      const clear = () => { if (this.#statusInFlight === current) this.#statusInFlight = null }
      void current.promise.then(clear, clear)
    }
    const current = work
    current.waiters += 1
    try {
      return await new Promise<LifecycleBrokerStatusEvidence>((resolve, reject) => {
        const abort = () => reject(new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_REQUEST_INVALID'))
        if (input.signal.aborted) { abort(); return }
        input.signal.addEventListener('abort', abort, { once: true })
        void current.promise.then(value => {
          input.signal.removeEventListener('abort', abort)
          resolve(structuredClone(value))
        }, error => {
          input.signal.removeEventListener('abort', abort)
          reject(error)
        })
      })
    } finally {
      current.waiters -= 1
      if (current.waiters === 0 && this.#statusInFlight === current) current.controller.abort()
    }
  }

  async #readStatus(signal: AbortSignal): Promise<LifecycleBrokerStatusEvidence> {
    const receipt = await this.#invoke('LifecycleStatus', randomUUID(), [], signal)
    this.#assertNotFailed(receipt)
    const evidence = parseEvidence(statusEvidenceSchema, receipt.evidence)
    this.#assertTerminal(receipt, [])
    if (evidence.runtime.port.port !== this.#gamePort ||
        (evidence.lifecycleState === 'running_verified' && !runtimeMatchesExpected(evidence.runtime, 'running')) ||
        (evidence.lifecycleState === 'stopped_verified' && !runtimeMatchesExpected(evidence.runtime, 'stopped')) ||
        (!evidence.task.valid && evidence.lifecycleState !== 'unknown_unverifiable')) {
      throw new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_RESULT_INVALID')
    }
    return evidence
  }

  async #invoke(
    capability: z.output<typeof capabilitySchema>,
    brokerRequestId: string,
    arguments_: string[],
    signal: AbortSignal
  ): Promise<z.output<typeof receiptBaseSchema>> {
    if (signal.aborted) throw new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_REQUEST_INVALID')
    const output = await this.#runner.run(lifecycleBrokerSubmitScriptName, [
      '-BrokerRoot', this.#brokerRoot,
      '-ProfileFile', this.#profileFile,
      '-BrokerRequestId', brokerRequestId,
      '-Capability', capability,
      ...arguments_,
      '-TimeoutSeconds', String(this.#timeoutSeconds)
    ], signal)
    const parsed = resultSchema.safeParse(parseJson(output))
    if (!parsed.success || parsed.data.brokerRequestId !== brokerRequestId.toLowerCase() ||
        parsed.data.capability !== capability || parsed.data.receipt.brokerRequestId !== brokerRequestId.toLowerCase() ||
        parsed.data.receipt.capability !== capability || parsed.data.receipt.reused ||
        new Date(parsed.data.receipt.completedAt).getTime() < new Date(parsed.data.receipt.createdAt).getTime()) {
      throw new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_RESULT_INVALID')
    }
    return parsed.data.receipt
  }

  #borrowArguments(scope: LifecycleHostMutationScope): string[] {
    let raw: readonly string[]
    try { raw = scope.toPowerShellBorrowArguments() } catch {
      scope.assertActive()
      throw new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_BORROW_BINDING_INVALID')
    }
    if (!Array.isArray(raw) || raw.length !== 6 || raw.some((value) => typeof value !== 'string') ||
        raw[0] !== '-DataRoot' || !samePath(raw[1]!, this.#dataRoot) || raw[2] !== '-LeaseInstanceId' ||
        !requestIdSchema.safeParse(raw[3]).success || raw[4] !== '-LeaseToken' ||
        !/^[A-Za-z0-9_-]{43}$/u.test(raw[5]!)) {
      throw new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_BORROW_BINDING_INVALID')
    }
    return [...raw]
  }

  #assertTerminal(
    receipt: z.output<typeof receiptBaseSchema>,
    blockers: readonly string[]
  ): void {
    if (receipt.status === 'blocked') {
      if (receipt.errorCode !== null || blockers.length === 0) {
        throw new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_RESULT_INVALID')
      }
      throw new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_BLOCKED', { blockers })
    }
    if (receipt.status === 'failed') {
      if (receipt.errorCode === null) {
        throw new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_RESULT_INVALID')
      }
      throw new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_FAILED', {
        brokerErrorCode: receipt.errorCode,
        blockers
      })
    }
    if (receipt.errorCode !== null || blockers.length > 0) {
      throw new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_RESULT_INVALID')
    }
  }

  #assertNotFailed(receipt: z.output<typeof receiptBaseSchema>): void {
    if (receipt.status !== 'failed') return
    if (receipt.errorCode === null) {
      throw new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_RESULT_INVALID')
    }
    const failureEvidence = z.object({
      blockers: z.array(z.string().min(1).max(128)).min(1).max(16)
    }).safeParse(receipt.evidence)
    if (!failureEvidence.success) {
      throw new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_RESULT_INVALID')
    }
    throw new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_FAILED', {
      brokerErrorCode: receipt.errorCode,
      blockers: failureEvidence.data.blockers
    })
  }
}

function deriveBrokerRequestId(outerRequestId: string, purpose: string): string {
  const parsed = requestIdSchema.safeParse(outerRequestId)
  if (!parsed.success || !/^[a-z0-9:-]{3,64}$/u.test(purpose)) {
    throw new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_REQUEST_INVALID')
  }
  const digest = createHash('sha256').update(JSON.stringify({
    outerRequestId: parsed.data,
    protocol: 'dyson-control-lifecycle-broker-request-v1',
    purpose
  })).digest('hex')
  const versioned = `${digest.slice(0, 12)}5${digest.slice(13, 16)}`
  const variant = ((Number.parseInt(digest[16]!, 16) & 0x3) | 0x8).toString(16)
  const normalized = `${versioned}${variant}${digest.slice(17, 32)}`
  return `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-` +
    `${normalized.slice(16, 20)}-${normalized.slice(20, 32)}`
}

function parseJson(output: string): unknown {
  if (typeof output !== 'string' || output.length < 2 || Buffer.byteLength(output, 'utf8') > 128 * 1024) {
    throw new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_RESULT_INVALID')
  }
  try { return JSON.parse(output) as unknown } catch {
    throw new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_RESULT_INVALID')
  }
}

function parseEvidence<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    throw new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_RESULT_INVALID')
  }
  return parsed.data
}

function runtimeMatchesExpected(
  runtime: LifecycleBrokerRuntimeEvidence,
  expected: 'running' | 'stopped'
): boolean {
  if (expected === 'running') {
    return runtime.lifecycleState === 'running_verified' &&
      runtime.session.status === 'verified' &&
      runtime.process.status === 'verified' &&
      runtime.port.listenerCount === 1 &&
      runtime.pidFile.present && runtime.pidFile.valid
  }
  return runtime.lifecycleState === 'stopped_verified' &&
    runtime.process.status === 'absent' &&
    runtime.port.listenerCount === 0 &&
    !runtime.pidFile.present && !runtime.pidFile.valid
}

function assertSignal(signal: AbortSignal): void {
  if (!signal || typeof signal !== 'object' || typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function') {
    throw new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_REQUEST_INVALID')
  }
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).replace(/[\\/]+$/u, '').toUpperCase() ===
    path.resolve(right).replace(/[\\/]+$/u, '').toUpperCase()
}

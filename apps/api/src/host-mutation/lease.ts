import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import fs from 'node:fs/promises'
import path from 'node:path'

const brokerProtocol = 'DYSON_HOST_MUTATION_BROKER_V1'
const brokerScriptName = 'Invoke-DysonHostMutationLeaseBroker.ps1'
const activeDataRoots = new Set<string>()
const brokerErrorCodes = new Set([
  'DYSON_HOST_MUTATION_LEASE_ARGUMENT_INVALID',
  'DYSON_HOST_MUTATION_LEASE_DATA_ROOT_INVALID',
  'DYSON_HOST_MUTATION_LEASE_PLATFORM_UNAVAILABLE',
  'DYSON_HOST_MUTATION_LEASE_PATH_IDENTITY_INVALID',
  'DYSON_HOST_MUTATION_LEASE_STORAGE_UNAVAILABLE',
  'DYSON_HOST_MUTATION_LEASE_HOST_IDENTITY_UNAVAILABLE',
  'DYSON_HOST_MUTATION_LEASE_RECORD_INVALID',
  'DYSON_HOST_MUTATION_LEASE_RECORD_WRITE_FAILED',
  'DYSON_HOST_MUTATION_LEASE_BUSY',
  'DYSON_HOST_MUTATION_LEASE_RECOVERY_REQUIRED',
  'DYSON_HOST_MUTATION_LEASE_RECOVERY_BINDING_INVALID',
  'DYSON_HOST_MUTATION_LEASE_RECOVERY_NOT_REQUIRED',
  'DYSON_HOST_MUTATION_LEASE_ACQUIRE_FAILED',
  'DYSON_HOST_MUTATION_LEASE_BROKER_UNAVAILABLE',
  'DYSON_HOST_MUTATION_LEASE_BROKER_PROTOCOL_FAILED'
])

export interface HostMutationLeaseRecoveryBinding {
  priorInstanceId: string
  priorRecordDigest: string
}

export interface HostMutationLeaseRequest {
  dataRoot: string
  owner: string
  operation: string
  requestId: string
  acquireTimeoutMs?: number
  recovery?: HostMutationLeaseRecoveryBinding
}

export interface HostMutationBrokerProcess {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  once(event: 'error', listener: (error: Error) => void): this
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this
  kill(): boolean
}

export type HostMutationBrokerSpawner = (
  executable: string,
  arguments_: readonly string[],
  options: Readonly<{
    windowsHide: boolean
    stdio: readonly ['pipe', 'pipe', 'pipe']
  }>
) => HostMutationBrokerProcess

export interface HostMutationLeaseManagerOptions {
  scriptRoot: string
  powershellExecutable?: string
  startupTimeoutMs?: number
  releaseTimeoutMs?: number
  maximumOutputBytes?: number
  spawnBroker?: HostMutationBrokerSpawner
}

export class HostMutationLeaseError extends Error {
  readonly code: string
  readonly priorInstanceId?: string
  readonly priorRecordDigest?: string
  readonly priorState?: 'active' | 'abandoned' | 'recovery-required'

  constructor(
    code: string,
    recovery: Partial<Pick<HostMutationLeaseError,
      'priorInstanceId' | 'priorRecordDigest' | 'priorState'>> = {}
  ) {
    super(code)
    this.name = 'HostMutationLeaseError'
    this.code = code
    this.priorInstanceId = recovery.priorInstanceId
    this.priorRecordDigest = recovery.priorRecordDigest
    this.priorState = recovery.priorState
  }
}

interface BrokerReadyMessage {
  protocol: typeof brokerProtocol
  type: 'ready'
  dataRootIdentity: string
  instanceId: string
  token: string
}

interface BrokerErrorMessage {
  protocol: typeof brokerProtocol
  type: 'error'
  code: string
  priorInstanceId: string | null
  priorRecordDigest: string | null
  priorState: 'active' | 'abandoned' | 'recovery-required' | null
}

interface BrokerExit {
  code: number | null
  signal: NodeJS.Signals | null
}

interface LeaseScope {
  active: boolean
  readonly abortController: AbortController
  readonly dataRoot: string
  readonly dataRootKey: string
  readonly dataRootIdentity: string
  readonly instanceId: string
  readonly token: string
  readonly leaseKind: 'mutation' | 'recovery'
}

export class HostMutationLease {
  readonly #scope: LeaseScope
  readonly borrowed: boolean

  constructor(scope: LeaseScope, borrowed: boolean) {
    this.#scope = scope
    this.borrowed = borrowed
  }

  get dataRootIdentity(): string {
    this.#assertActive()
    return this.#scope.dataRootIdentity
  }

  get instanceId(): string {
    this.#assertActive()
    return this.#scope.instanceId
  }

  get token(): string {
    this.#assertActive()
    return this.#scope.token
  }

  get leaseKind(): 'mutation' | 'recovery' {
    this.#assertActive()
    return this.#scope.leaseKind
  }

  /**
   * Host-mutating work must forward this signal to every cancellable child
   * operation. An unexpected broker exit aborts it before the scope is marked
   * unusable; non-cooperative native mutations cannot be made safe by Node.
   */
  get signal(): AbortSignal {
    return this.#scope.abortController.signal
  }

  toPowerShellBorrowArguments(): readonly string[] {
    this.#assertActive()
    return [
      '-DataRoot', this.#scope.dataRoot,
      '-LeaseInstanceId', this.#scope.instanceId,
      '-LeaseToken', this.#scope.token
    ]
  }

  assertActive(): void {
    this.#assertActive()
  }

  #assertActive(): void {
    if (!this.#scope.active) {
      throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_SCOPE_INACTIVE')
    }
  }
}

class RunningBroker {
  readonly #process: HostMutationBrokerProcess
  readonly #maximumOutputBytes: number
  readonly #exitPromise: Promise<BrokerExit>
  #resolveExit!: (exit: BrokerExit) => void
  #readyPromise: Promise<BrokerReadyMessage>
  #resolveReady!: (ready: BrokerReadyMessage) => void
  #rejectReady!: (error: HostMutationLeaseError) => void
  #readySettled = false
  #ready = false
  #exited = false
  #exit: BrokerExit | null = null
  #failure: HostMutationLeaseError | null = null
  #outputBytes = 0
  #stdout = Buffer.alloc(0)
  #exitObserver: (() => void) | null = null

  constructor(process_: HostMutationBrokerProcess, maximumOutputBytes: number) {
    this.#process = process_
    this.#maximumOutputBytes = maximumOutputBytes
    this.#readyPromise = new Promise<BrokerReadyMessage>((resolve, reject) => {
      this.#resolveReady = resolve
      this.#rejectReady = reject
    })
    this.#exitPromise = new Promise<BrokerExit>((resolve) => {
      this.#resolveExit = resolve
    })

    process_.stdout.on('data', (chunk: Buffer | string) => this.#collectStdout(chunk))
    process_.stderr.on('data', (chunk: Buffer | string) => this.#collectStderr(chunk))
    process_.stdin.on('error', () => {
      this.#setFailure(new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_BROKER_IO_FAILED'))
      this.abort()
    })
    process_.once('error', () => {
      this.#setFailure(new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_BROKER_START_FAILED'))
      this.#markExited({ code: null, signal: null })
    })
    process_.once('exit', (code, signal) => this.#markExited({ code, signal }))
  }

  async start(timeoutMs: number): Promise<BrokerReadyMessage> {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        this.#readyPromise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_BROKER_TIMEOUT')
            this.#setFailure(error)
            this.abort()
            reject(error)
          }, timeoutMs)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  onExit(observer: () => void): void {
    this.#exitObserver = observer
    if (this.#exited) observer()
  }

  async finish(disposition: 'release' | 'abandon', timeoutMs: number): Promise<void> {
    if (this.#exited) {
      throw this.#failure ?? new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_BROKER_EXITED')
    }
    try {
      this.#process.stdin.end(disposition === 'release' ? 'RELEASE\n' : 'ABANDON\n', 'utf8')
    } catch {
      this.#setFailure(new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_RELEASE_FAILED'))
      this.abort()
    }

    let timer: NodeJS.Timeout | undefined
    const exit = await Promise.race([
      this.#exitPromise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_RELEASE_TIMEOUT')
          this.#setFailure(error)
          this.abort()
          reject(error)
        }, timeoutMs)
      })
    ]).finally(() => {
      if (timer) clearTimeout(timer)
    })

    if (this.#failure) throw this.#failure
    const expectedExitCode = disposition === 'release' ? 0 : 22
    if (exit.code !== expectedExitCode || exit.signal !== null) {
      throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_RELEASE_FAILED')
    }
  }

  abort(): void {
    if (this.#exited) return
    try { this.#process.kill() } catch { /* best-effort containment */ }
  }

  #collectStdout(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')
    this.#outputBytes += bytes.length
    if (this.#outputBytes > this.#maximumOutputBytes) {
      this.#setFailure(new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_BROKER_OUTPUT_LIMIT'))
      this.abort()
      return
    }
    if (this.#ready) {
      if (bytes.length > 0) {
        this.#setFailure(new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_BROKER_PROTOCOL_INVALID'))
        this.abort()
      }
      return
    }
    this.#stdout = Buffer.concat([this.#stdout, bytes])
    const newline = this.#stdout.indexOf(0x0a)
    if (newline < 0) return
    const lineBytes = this.#stdout.subarray(0, newline)
    const remainder = this.#stdout.subarray(newline + 1)
    if (remainder.length !== 0) {
      this.#setFailure(new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_BROKER_PROTOCOL_INVALID'))
      this.abort()
      return
    }
    const line = lineBytes.at(-1) === 0x0d
      ? lineBytes.subarray(0, lineBytes.length - 1).toString('utf8')
      : lineBytes.toString('utf8')
    let message: BrokerReadyMessage | BrokerErrorMessage
    try { message = parseBrokerMessage(line) }
    catch {
      this.#setFailure(new HostMutationLeaseError(
        'DYSON_HOST_MUTATION_LEASE_BROKER_PROTOCOL_INVALID'
      ))
      this.abort()
      return
    }
    if (message.type === 'error') {
      const error = new HostMutationLeaseError(message.code, {
        ...(message.priorInstanceId ? { priorInstanceId: message.priorInstanceId } : {}),
        ...(message.priorRecordDigest ? { priorRecordDigest: message.priorRecordDigest } : {}),
        ...(message.priorState ? { priorState: message.priorState } : {})
      })
      this.#setFailure(error)
      this.abort()
      return
    }
    this.#ready = true
    this.#settleReady(message)
  }

  #collectStderr(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')
    this.#outputBytes += bytes.length
    const code = this.#outputBytes > this.#maximumOutputBytes
      ? 'DYSON_HOST_MUTATION_LEASE_BROKER_OUTPUT_LIMIT'
      : 'DYSON_HOST_MUTATION_LEASE_BROKER_PROTOCOL_INVALID'
    this.#setFailure(new HostMutationLeaseError(code))
    this.abort()
  }

  #setFailure(error: HostMutationLeaseError): void {
    if (!this.#failure) this.#failure = error
    if (!this.#readySettled) {
      this.#readySettled = true
      this.#rejectReady(this.#failure)
    }
  }

  #settleReady(message: BrokerReadyMessage): void {
    if (this.#readySettled) return
    this.#readySettled = true
    this.#resolveReady(message)
  }

  #markExited(exit: BrokerExit): void {
    if (this.#exited) return
    this.#exited = true
    this.#exit = exit
    if (!this.#readySettled) {
      this.#readySettled = true
      this.#rejectReady(this.#failure ?? new HostMutationLeaseError(
        'DYSON_HOST_MUTATION_LEASE_BROKER_EXITED'
      ))
    }
    this.#resolveExit(exit)
    this.#exitObserver?.()
  }
}

export class HostMutationLeaseManager {
  readonly #scriptRoot: string
  readonly #brokerScript: string
  readonly #powershellExecutable: string
  readonly #startupTimeoutMs: number
  readonly #releaseTimeoutMs: number
  readonly #maximumOutputBytes: number
  readonly #spawnBroker: HostMutationBrokerSpawner
  readonly #storage = new AsyncLocalStorage<LeaseScope>()

  constructor(options: HostMutationLeaseManagerOptions) {
    this.#scriptRoot = normalizeScriptRoot(options.scriptRoot)
    this.#brokerScript = path.resolve(this.#scriptRoot, brokerScriptName)
    const relativeBroker = path.relative(this.#scriptRoot, this.#brokerScript)
    if (relativeBroker !== brokerScriptName) {
      throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_BROKER_UNAVAILABLE')
    }
    this.#powershellExecutable = options.powershellExecutable ?? 'powershell.exe'
    if (!isBoundedProcessArgument(this.#powershellExecutable, 1024)) {
      throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_ARGUMENT_INVALID')
    }
    this.#startupTimeoutMs = boundedInteger(
      options.startupTimeoutMs ?? 10_000, 25, 120_000,
      'DYSON_HOST_MUTATION_LEASE_BROKER_TIMEOUT_INVALID'
    )
    this.#releaseTimeoutMs = boundedInteger(
      options.releaseTimeoutMs ?? 5_000, 25, 120_000,
      'DYSON_HOST_MUTATION_LEASE_RELEASE_TIMEOUT_INVALID'
    )
    this.#maximumOutputBytes = boundedInteger(
      options.maximumOutputBytes ?? 4_096, 256, 65_536,
      'DYSON_HOST_MUTATION_LEASE_BROKER_OUTPUT_LIMIT_INVALID'
    )
    this.#spawnBroker = options.spawnBroker ?? defaultBrokerSpawner
  }

  currentLease(dataRoot?: string): HostMutationLease {
    const scope = this.#storage.getStore()
    if (!scope) {
      throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_SCOPE_UNAVAILABLE')
    }
    if (!scope.active) {
      throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_SCOPE_INACTIVE')
    }
    if (dataRoot !== undefined && normalizeDataRoot(dataRoot).key !== scope.dataRootKey) {
      throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_NESTED_ROOT_INVALID')
    }
    return new HostMutationLease(scope, true)
  }

  async runExclusive<T>(
    request: HostMutationLeaseRequest,
    action: (lease: HostMutationLease) => Promise<T> | T
  ): Promise<T> {
    const validated = validateRequest(request)
    const current = this.#storage.getStore()
    if (current) {
      if (!current.active) {
        throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_SCOPE_INACTIVE')
      }
      if (validated.dataRootKey !== current.dataRootKey) {
        throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_NESTED_ROOT_INVALID')
      }
      if (validated.recovery) {
        throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_NESTED_RECOVERY_INVALID')
      }
      return action(new HostMutationLease(current, true))
    }

    if (activeDataRoots.has(validated.dataRootKey)) {
      throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_BUSY')
    }
    activeDataRoots.add(validated.dataRootKey)

    let broker: RunningBroker | null = null
    let scope: LeaseScope | null = null
    let actionError: unknown
    let actionFailed = false
    let result!: T
    try {
      await fs.access(this.#brokerScript).catch(() => {
        throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_BROKER_UNAVAILABLE')
      })
      const arguments_ = buildBrokerArguments(this.#brokerScript, validated)
      let process_: HostMutationBrokerProcess
      try {
        process_ = this.#spawnBroker(this.#powershellExecutable, arguments_, {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        })
      } catch {
        throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_BROKER_START_FAILED')
      }
      broker = new RunningBroker(process_, this.#maximumOutputBytes)
      const ready = await broker.start(this.#startupTimeoutMs)
      scope = {
        active: true,
        abortController: new AbortController(),
        dataRoot: validated.dataRoot,
        dataRootKey: validated.dataRootKey,
        dataRootIdentity: ready.dataRootIdentity,
        instanceId: ready.instanceId,
        token: ready.token,
        leaseKind: validated.recovery ? 'recovery' : 'mutation'
      }
      const acquiredScope = scope
      let expectedBrokerExit = false
      broker.onExit(() => {
        acquiredScope.active = false
        if (!expectedBrokerExit && !acquiredScope.abortController.signal.aborted) {
          acquiredScope.abortController.abort(new HostMutationLeaseError(
            'DYSON_HOST_MUTATION_LEASE_BROKER_EXITED'
          ))
        }
      })
      try {
        result = await this.#storage.run(
          acquiredScope,
          () => action(new HostMutationLease(acquiredScope, false))
        )
      } catch (error) {
        actionError = error
        actionFailed = true
      }
      acquiredScope.active = false
      if (!acquiredScope.abortController.signal.aborted) {
        acquiredScope.abortController.abort(new HostMutationLeaseError(
          'DYSON_HOST_MUTATION_LEASE_SCOPE_INACTIVE'
        ))
      }
      expectedBrokerExit = true
      if (actionFailed) {
        try { await broker.finish('abandon', this.#releaseTimeoutMs) }
        catch { broker.abort() }
        throw actionError
      }
      await broker.finish('release', this.#releaseTimeoutMs)
      return result
    } catch (error) {
      if (scope) scope.active = false
      broker?.abort()
      if (error instanceof HostMutationLeaseError) throw error
      if (actionFailed && error === actionError) throw actionError
      throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_FAILED')
    } finally {
      activeDataRoots.delete(validated.dataRootKey)
    }
  }
}

interface ValidatedRequest {
  dataRoot: string
  dataRootKey: string
  owner: string
  operation: string
  requestId: string
  acquireTimeoutMs: number
  recovery?: HostMutationLeaseRecoveryBinding
}

function validateRequest(request: HostMutationLeaseRequest): ValidatedRequest {
  if (!request || typeof request !== 'object') {
    throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_ARGUMENT_INVALID')
  }
  const root = normalizeDataRoot(request.dataRoot)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(request.owner) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(request.operation) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.requestId)) {
    throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_ARGUMENT_INVALID')
  }
  const acquireTimeoutMs = boundedInteger(
    request.acquireTimeoutMs ?? 30_000, 0, 120_000,
    'DYSON_HOST_MUTATION_LEASE_ARGUMENT_INVALID'
  )
  let recovery: HostMutationLeaseRecoveryBinding | undefined
  if (request.recovery !== undefined) {
    if (!request.recovery ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          request.recovery.priorInstanceId
        ) ||
        !/^[0-9a-f]{64}$/.test(request.recovery.priorRecordDigest)) {
      throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_RECOVERY_BINDING_INVALID')
    }
    recovery = { ...request.recovery }
  }
  return {
    dataRoot: root.full,
    dataRootKey: root.key,
    owner: request.owner,
    operation: request.operation,
    requestId: request.requestId,
    acquireTimeoutMs,
    ...(recovery ? { recovery } : {})
  }
}

function normalizeDataRoot(value: string): { full: string; key: string } {
  if (!isBoundedProcessArgument(value, 32_767) || !path.isAbsolute(value)) {
    throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_DATA_ROOT_INVALID')
  }
  let full: string
  try { full = path.resolve(value).replace(/[\\/]+$/, '') }
  catch { throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_DATA_ROOT_INVALID') }
  if (!full || full === path.parse(full).root.replace(/[\\/]+$/, '')) {
    throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_DATA_ROOT_INVALID')
  }
  return { full, key: process.platform === 'win32' ? full.toUpperCase() : full }
}

function normalizeScriptRoot(value: string): string {
  if (!isBoundedProcessArgument(value, 32_767)) {
    throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_BROKER_UNAVAILABLE')
  }
  try { return path.resolve(value) }
  catch { throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_BROKER_UNAVAILABLE') }
}

function boundedInteger(value: number, minimum: number, maximum: number, code: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new HostMutationLeaseError(code)
  }
  return value
}

function isBoundedProcessArgument(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength &&
    !/[\0\r\n]/.test(value)
}

function buildBrokerArguments(script: string, request: ValidatedRequest): readonly string[] {
  const arguments_ = [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script,
    '-DataRoot', request.dataRoot,
    '-Owner', request.owner,
    '-Operation', request.operation,
    '-RequestId', request.requestId,
    '-OwnerPid', String(process.pid),
    '-TimeoutMilliseconds', String(request.acquireTimeoutMs)
  ]
  if (request.recovery) {
    arguments_.push(
      '-RecoveryPriorInstanceId', request.recovery.priorInstanceId,
      '-RecoveryPriorRecordDigest', request.recovery.priorRecordDigest
    )
  }
  return arguments_
}

function parseBrokerMessage(line: string): BrokerReadyMessage | BrokerErrorMessage {
  if (Buffer.byteLength(line, 'utf8') > 2_048 || line.length < 2) {
    throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_BROKER_PROTOCOL_INVALID')
  }
  let value: unknown
  try { value = JSON.parse(line) }
  catch { throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_BROKER_PROTOCOL_INVALID') }
  if (!isRecord(value) || value.protocol !== brokerProtocol) {
    throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_BROKER_PROTOCOL_INVALID')
  }
  if (value.type === 'ready') {
    assertExactKeys(value, ['protocol', 'type', 'dataRootIdentity', 'instanceId', 'token'])
    if (typeof value.dataRootIdentity !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/.test(value.dataRootIdentity) ||
        typeof value.instanceId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.instanceId) ||
        typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.token)) {
      throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_BROKER_PROTOCOL_INVALID')
    }
    return value as unknown as BrokerReadyMessage
  }
  if (value.type === 'error') {
    assertExactKeys(value, [
      'protocol', 'type', 'code', 'priorInstanceId', 'priorRecordDigest', 'priorState'
    ])
    if (typeof value.code !== 'string' || !brokerErrorCodes.has(value.code) ||
        !isNullableMatch(value.priorInstanceId,
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/) ||
        !isNullableMatch(value.priorRecordDigest, /^[0-9a-f]{64}$/) ||
        (value.priorState !== null && value.priorState !== 'active' &&
          value.priorState !== 'abandoned' && value.priorState !== 'recovery-required')) {
      throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_BROKER_PROTOCOL_INVALID')
    }
    return value as unknown as BrokerErrorMessage
  }
  throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_BROKER_PROTOCOL_INVALID')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value)
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_BROKER_PROTOCOL_INVALID')
  }
}

function isNullableMatch(value: unknown, pattern: RegExp): value is string | null {
  return value === null || (typeof value === 'string' && pattern.test(value))
}

const defaultBrokerSpawner: HostMutationBrokerSpawner = (executable, arguments_, options) => {
  return spawn(executable, [...arguments_], {
    windowsHide: options.windowsHide,
    stdio: ['pipe', 'pipe', 'pipe']
  })
}

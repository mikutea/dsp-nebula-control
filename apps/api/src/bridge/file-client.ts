import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  BridgeProtocolError,
  assertBridgeReceiptV2,
  actualSimulationRates,
  buildBridgeRequest,
  parseBridgeHeartbeat,
  parseBridgeReceipt,
  parseBridgeRuntimeSession,
  parseBridgeSimulationTelemetry,
  validateBridgeSecret,
  type BridgeHeartbeat,
  type BridgeReceiptV2,
  type BridgeRuntimeSession,
  type BridgeSimulationTelemetry
} from './protocol.js'

export interface FileBridgeClientOptions {
  controlRoot: string
  secretFile: string
  timeoutMs: number
  pollMs?: number
  requestLifetimeMs?: number
  heartbeatMaxAgeMs?: number
  telemetryMaxAgeMs?: number
}

export interface BridgeSimulationTelemetryExpectation {
  processId: number
  processStartedAtUnixMs: number
}

export interface AcceptedBridgeSimulationTelemetry {
  session: BridgeRuntimeSession
  telemetry: BridgeSimulationTelemetry
  actualUps: number
  actualTps: number
}

export class FileBridgeClient {
  readonly #options: Required<FileBridgeClientOptions>
  readonly #acceptedTelemetrySequences = new Map<string, number>()

  constructor(options: FileBridgeClientOptions) {
    if (!path.isAbsolute(options.controlRoot) || path.parse(options.controlRoot).root === path.resolve(options.controlRoot)) {
      throw new BridgeProtocolError('BRIDGE_ROOT_INVALID')
    }
    if (!path.isAbsolute(options.secretFile)) throw new BridgeProtocolError('BRIDGE_SECRET_PATH_INVALID')
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 300_000) {
      throw new BridgeProtocolError('BRIDGE_TIMEOUT_INVALID')
    }
    const pollMs = options.pollMs ?? 200
    const requestLifetimeMs = options.requestLifetimeMs ?? Math.min(options.timeoutMs, 15_000)
    if (!Number.isInteger(pollMs) || pollMs < 25 || pollMs > 2_000) {
      throw new BridgeProtocolError('BRIDGE_POLL_INVALID')
    }
    if (!Number.isInteger(requestLifetimeMs) || requestLifetimeMs < 1_000 || requestLifetimeMs > 120_000) {
      throw new BridgeProtocolError('BRIDGE_LIFETIME_INVALID')
    }
    const heartbeatMaxAgeMs = options.heartbeatMaxAgeMs ?? 10_000
    if (!Number.isInteger(heartbeatMaxAgeMs) || heartbeatMaxAgeMs < 2_000 || heartbeatMaxAgeMs > 120_000) {
      throw new BridgeProtocolError('BRIDGE_HEARTBEAT_AGE_INVALID')
    }
    const telemetryMaxAgeMs = options.telemetryMaxAgeMs ?? 10_000
    if (!Number.isInteger(telemetryMaxAgeMs) || telemetryMaxAgeMs < 2_000 || telemetryMaxAgeMs > 120_000) {
      throw new BridgeProtocolError('BRIDGE_TELEMETRY_AGE_INVALID')
    }
    this.#options = { ...options, pollMs, requestLifetimeMs, heartbeatMaxAgeMs, telemetryMaxAgeMs }
  }

  async probe(signal?: AbortSignal): Promise<BridgeHeartbeat> {
    signal?.throwIfAborted()
    const root = path.resolve(this.#options.controlRoot)
    await this.#assertDirectory(root)
    const secret = await this.#readSecret()
    return this.#readHeartbeat(root, secret, signal)
  }

  async readSimulationTelemetry(
    expectation: BridgeSimulationTelemetryExpectation,
    signal?: AbortSignal
  ): Promise<AcceptedBridgeSimulationTelemetry> {
    if (!Number.isSafeInteger(expectation.processId) || expectation.processId <= 0 ||
        !Number.isSafeInteger(expectation.processStartedAtUnixMs) || expectation.processStartedAtUnixMs <= 0) {
      throw new BridgeProtocolError('BRIDGE_TELEMETRY_EXPECTATION_INVALID')
    }
    signal?.throwIfAborted()
    const root = path.resolve(this.#options.controlRoot)
    await this.#assertDirectory(root)
    const secret = await this.#readSecret()
    const heartbeatBefore = await this.#readHeartbeat(root, secret, signal)
    const session = parseBridgeRuntimeSession(
      await this.#readBoundedFile(root, 'runtime-session', 'BRIDGE_RUNTIME_SESSION'),
      secret
    )
    const telemetry = parseBridgeSimulationTelemetry(
      await this.#readBoundedFile(root, 'simulation-telemetry', 'BRIDGE_TELEMETRY'),
      secret
    )
    const heartbeatAfter = await this.#readHeartbeat(root, secret, signal)
    signal?.throwIfAborted()

    if (heartbeatBefore.processId !== heartbeatAfter.processId ||
        heartbeatBefore.startedAtUnixMs !== heartbeatAfter.startedAtUnixMs ||
        heartbeatBefore.pluginVersion !== heartbeatAfter.pluginVersion) {
      throw new BridgeProtocolError('BRIDGE_SESSION_CHANGED')
    }
    if (session.processId !== heartbeatAfter.processId ||
        session.bridgeStartedAtUnixMs !== heartbeatAfter.startedAtUnixMs ||
        session.pluginVersion !== heartbeatAfter.pluginVersion ||
        session.processId !== expectation.processId ||
        session.processStartedAtUnixMs !== expectation.processStartedAtUnixMs) {
      throw new BridgeProtocolError('BRIDGE_RUNTIME_IDENTITY_MISMATCH')
    }
    if (telemetry.sessionId !== session.sessionId || telemetry.processId !== session.processId ||
        telemetry.processStartedAtUnixMs !== session.processStartedAtUnixMs ||
        telemetry.bridgeStartedAtUnixMs !== session.bridgeStartedAtUnixMs) {
      throw new BridgeProtocolError('BRIDGE_TELEMETRY_IDENTITY_MISMATCH')
    }
    const nowUnixMs = Date.now()
    if (session.issuedAtUnixMs > nowUnixMs + 5_000 || session.bridgeStartedAtUnixMs > nowUnixMs + 5_000) {
      throw new BridgeProtocolError('BRIDGE_RUNTIME_SESSION_FUTURE')
    }
    const telemetryAgeMs = nowUnixMs - telemetry.writtenAtUnixMs
    if (telemetryAgeMs < -5_000 || telemetryAgeMs > this.#options.telemetryMaxAgeMs) {
      throw new BridgeProtocolError('BRIDGE_TELEMETRY_STALE')
    }
    const lastSequence = this.#acceptedTelemetrySequences.get(session.sessionId)
    if (lastSequence !== undefined && telemetry.sequence <= lastSequence) {
      throw new BridgeProtocolError('BRIDGE_TELEMETRY_REPLAY')
    }
    this.#acceptedTelemetrySequences.set(session.sessionId, telemetry.sequence)
    while (this.#acceptedTelemetrySequences.size > 8) {
      const oldest = this.#acceptedTelemetrySequences.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.#acceptedTelemetrySequences.delete(oldest)
    }
    const rates = actualSimulationRates(telemetry)
    return { session, telemetry, actualUps: rates.ups, actualTps: rates.tps }
  }

  async requestSave(requestId: string = randomUUID(), signal?: AbortSignal): Promise<BridgeReceiptV2> {
    signal?.throwIfAborted()
    const root = path.resolve(this.#options.controlRoot)
    const requestsRoot = path.join(root, 'requests')
    const receiptsRoot = path.join(root, 'receipts')
    await this.#assertDirectory(root)
    await this.#assertDirectory(requestsRoot)
    await this.#assertDirectory(receiptsRoot)

    const secret = await this.#readSecret()
    const built = buildBridgeRequest(requestId, secret, Date.now(), this.#options.requestLifetimeMs)
    const requestPath = path.join(requestsRoot, `${built.request.requestId}.request`)
    const receiptPath = path.join(receiptsRoot, `${built.request.requestId}.receipt`)

    const existingReceipt = await this.#readReceipt(receiptPath, secret, built.request.requestId)
    if (existingReceipt) return existingReceipt

    if (!(await this.#exists(requestPath))) {
      const temporaryPath = path.join(requestsRoot, `.partial-${built.request.requestId}-${randomUUID()}`)
      try {
        await fs.writeFile(temporaryPath, built.payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        await fs.rename(temporaryPath, requestPath)
      } catch (error) {
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
        if (!(await this.#exists(requestPath))) {
          throw new BridgeProtocolError('BRIDGE_REQUEST_WRITE_FAILED')
        }
      }
    }

    const startedAtMonotonicMs = performance.now()
    while (performance.now() - startedAtMonotonicMs < this.#options.timeoutMs) {
      if (signal?.aborted) throw new BridgeProtocolError('BRIDGE_REQUEST_ABORTED')
      const receipt = await this.#readReceipt(receiptPath, secret, built.request.requestId)
      if (receipt) return receipt
      await this.#delay(this.#options.pollMs, signal)
    }
    throw new BridgeProtocolError('BRIDGE_RECEIPT_TIMEOUT')
  }

  async #readHeartbeat(root: string, secret: string, signal?: AbortSignal): Promise<BridgeHeartbeat> {
    let heartbeat: BridgeHeartbeat
    try {
      heartbeat = parseBridgeHeartbeat(
        await this.#readBoundedFile(root, 'heartbeat', 'BRIDGE_HEARTBEAT'),
        secret
      )
    } catch (error) {
      if (error instanceof BridgeProtocolError) throw error
      throw new BridgeProtocolError('BRIDGE_HEARTBEAT_READ_FAILED')
    }
    signal?.throwIfAborted()
    const ageMs = Date.now() - heartbeat.writtenAtUnixMs
    if (ageMs < -5_000 || ageMs > this.#options.heartbeatMaxAgeMs) {
      throw new BridgeProtocolError('BRIDGE_HEARTBEAT_STALE')
    }
    return heartbeat
  }

  async #readBoundedFile(root: string, fileName: string, codePrefix: string): Promise<string> {
    const filePath = path.join(root, fileName)
    let stats
    try {
      stats = await fs.lstat(filePath)
    } catch {
      throw new BridgeProtocolError(`${codePrefix}_UNAVAILABLE`)
    }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > 4096) {
      throw new BridgeProtocolError(`${codePrefix}_FILE_INVALID`)
    }
    try {
      const bytes = await fs.readFile(filePath)
      if (bytes.length <= 0 || bytes.length > 4096) {
        throw new BridgeProtocolError(`${codePrefix}_FILE_INVALID`)
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch (error) {
      if (error instanceof BridgeProtocolError) throw error
      throw new BridgeProtocolError(`${codePrefix}_READ_FAILED`)
    }
  }

  async #readReceipt(receiptPath: string, secret: string, requestId: string): Promise<BridgeReceiptV2 | null> {
    let stats
    try {
      stats = await fs.lstat(receiptPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new BridgeProtocolError('BRIDGE_RECEIPT_READ_FAILED')
    }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > 4096) {
      throw new BridgeProtocolError('BRIDGE_RECEIPT_FILE_INVALID')
    }
    let payload: string
    try {
      payload = await fs.readFile(receiptPath, 'utf8')
    } catch {
      throw new BridgeProtocolError('BRIDGE_RECEIPT_READ_FAILED')
    }
    const receipt = parseBridgeReceipt(payload, secret)
    assertBridgeReceiptV2(receipt)
    if (receipt.requestId !== requestId || receipt.action !== 'save') {
      throw new BridgeProtocolError('BRIDGE_RECEIPT_MISMATCH')
    }
    return receipt
  }

  async #assertDirectory(directoryPath: string): Promise<void> {
    let stats
    try {
      stats = await fs.lstat(directoryPath)
    } catch {
      throw new BridgeProtocolError('BRIDGE_DIRECTORY_UNAVAILABLE')
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new BridgeProtocolError('BRIDGE_DIRECTORY_INVALID')
    }
  }

  async #readSecret(): Promise<string> {
    let stats
    try {
      stats = await fs.lstat(this.#options.secretFile)
    } catch {
      throw new BridgeProtocolError('BRIDGE_SECRET_UNAVAILABLE')
    }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 32 || stats.size > 1024) {
      throw new BridgeProtocolError('BRIDGE_SECRET_FILE_INVALID')
    }
    try {
      return validateBridgeSecret(await fs.readFile(this.#options.secretFile, 'utf8'))
    } catch (error) {
      if (error instanceof BridgeProtocolError) throw error
      throw new BridgeProtocolError('BRIDGE_SECRET_UNAVAILABLE')
    }
  }

  async #exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath)
      return true
    } catch {
      return false
    }
  }

  #delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new BridgeProtocolError('BRIDGE_REQUEST_ABORTED'))
        return
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, milliseconds)
      const onAbort = () => {
        clearTimeout(timer)
        reject(new BridgeProtocolError('BRIDGE_REQUEST_ABORTED'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}

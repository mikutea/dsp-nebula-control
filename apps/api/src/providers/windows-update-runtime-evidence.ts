import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import {
  parseBridgeRuntimeSession,
  validateBridgeSecret,
  type BridgeHeartbeat,
  type BridgeRuntimeSession
} from '../bridge/protocol.js'

export const WINDOWS_UPDATE_RUNTIME_EVIDENCE_PROTOCOL =
  'DYSON_CONTROL_LOADED_SAVE_EVIDENCE_V1' as const
export const WINDOWS_UPDATE_RUNTIME_EVIDENCE_FILE = 'loaded-save-evidence' as const
export const WINDOWS_UPDATE_RUNTIME_SESSION_FILE = 'runtime-session' as const

const fixedSaveName = '_lastexit_'
const fixedSaveNameBase64Url = 'X2xhc3RleGl0Xw'
const maximumEvidenceBytes = 4_096
const maximumSecretBytes = 1_024
const futureToleranceMs = 5_000
const sha256Pattern = /^[0-9a-f]{64}$/
const pluginVersionPattern = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]{1,32})?$/
const canonicalGuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const maximumInt64 = 9_223_372_036_854_775_807n

const runtimeKeys = [
  'protocol',
  'sessionId',
  'pluginVersion',
  'processId',
  'processStartedAtUnixMs',
  'bridgeStartedAtUnixMs',
  'observationGeneration',
  'observedAtUnixMs',
  'writtenAtUnixMs',
  'saveNameB64',
  'dsvBytes',
  'dsvWriteTimeUtcTicks',
  'dsvSha256',
  'serverBytes',
  'serverWriteTimeUtcTicks',
  'serverSha256'
] as const

type RuntimeKey = typeof runtimeKeys[number]

export interface WindowsUpdateRuntimeEvidenceRecord {
  protocol: typeof WINDOWS_UPDATE_RUNTIME_EVIDENCE_PROTOCOL
  sessionId: string
  pluginVersion: string
  processId: number
  processStartedAtUnixMs: number
  bridgeStartedAtUnixMs: number
  observationGeneration: number
  observedAtUnixMs: number
  writtenAtUnixMs: number
  saveName: typeof fixedSaveName
  dsvBytes: number
  dsvWriteTimeUtcTicks: bigint
  dsvSha256: string
  serverBytes: number
  serverWriteTimeUtcTicks: bigint
  serverSha256: string
  hmac: string
}

export interface AcceptedWindowsUpdateRuntimeEvidence {
  processId: number
  processStartedAtUnixMs: number
  bridgeStartedAtUnixMs: number
  loadedSaveObservedAtUnixMs: number
  writtenAtUnixMs: number
  startedAt: string
  startupGenerationId: string
  bridgeHeartbeatGenerationId: string
  loadedSaveLogGenerationId: string
  loadedSaveIdentity: string
}

export interface WindowsUpdateRuntimeEvidenceSource {
  readCurrentRuntimeEvidence(signal?: AbortSignal): Promise<AcceptedWindowsUpdateRuntimeEvidence>
  /** Signed last-loaded evidence accepted without requiring a live heartbeat. */
  readPersistedRuntimeEvidence(signal?: AbortSignal): Promise<AcceptedWindowsUpdateRuntimeEvidence>
}

export interface WindowsUpdateRuntimeEvidenceReaderOptions {
  /** Fixed Bridge control directory selected only during trusted construction. */
  controlRoot: string
  /** Fixed Bridge secret selected only during trusted construction. */
  secretFile: string
  /** Optional SHA-256 binding for the normalized construction-time Bridge secret. */
  expectedSecretSha256?: string
  bridgeClient: { probe(signal?: AbortSignal): Promise<BridgeHeartbeat> }
  /** @internal Deterministic test clock. */
  now?: () => number
}

export class WindowsUpdateRuntimeEvidenceError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'WindowsUpdateRuntimeEvidenceError'
    this.code = code
  }
}

/**
 * Reads only construction-time fixed Bridge files. A running record is
 * accepted only when a signed runtime session and loaded-save record are
 * bracketed by one unchanged fresh signed heartbeat. A persisted read is for
 * an independently proven stopped state and must be bound by its caller to the
 * newest trusted runtime receipt.
 */
export class WindowsUpdateRuntimeEvidenceReader implements WindowsUpdateRuntimeEvidenceSource {
  readonly #controlRoot: string
  readonly #secretFile: string
  readonly #expectedSecretSha256?: Buffer
  readonly #bridgeClient: WindowsUpdateRuntimeEvidenceReaderOptions['bridgeClient']
  readonly #now: () => number

  constructor(options: WindowsUpdateRuntimeEvidenceReaderOptions) {
    if (!options || !isSafeAbsoluteRoot(options.controlRoot) ||
        !isSafeAbsoluteFile(options.secretFile) ||
        typeof options.bridgeClient?.probe !== 'function') {
      throw new WindowsUpdateRuntimeEvidenceError('WINDOWS_UPDATE_EVIDENCE_OPTIONS_INVALID')
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new WindowsUpdateRuntimeEvidenceError('WINDOWS_UPDATE_EVIDENCE_OPTIONS_INVALID')
    }
    if (options.expectedSecretSha256 !== undefined &&
        !sha256Pattern.test(options.expectedSecretSha256)) {
      throw new WindowsUpdateRuntimeEvidenceError('WINDOWS_UPDATE_EVIDENCE_OPTIONS_INVALID')
    }
    this.#controlRoot = path.resolve(options.controlRoot)
    this.#secretFile = path.resolve(options.secretFile)
    this.#expectedSecretSha256 = options.expectedSecretSha256 === undefined
      ? undefined
      : Buffer.from(options.expectedSecretSha256, 'hex')
    this.#bridgeClient = options.bridgeClient
    this.#now = options.now ?? Date.now
  }

  async readCurrentRuntimeEvidence(signal?: AbortSignal): Promise<AcceptedWindowsUpdateRuntimeEvidence> {
    signal?.throwIfAborted()
    const root = await assertNormalDirectory(this.#controlRoot)
    const secret = await readSecret(this.#secretFile, this.#expectedSecretSha256)
    const before = await this.#probeHeartbeat(signal)
    const session = await readRuntimeSession(root, secret)
    const record = await readRuntimeEvidence(root, secret)
    const after = await this.#probeHeartbeat(signal)
    signal?.throwIfAborted()

    if (!sameHeartbeatGeneration(before, after)) {
      throw new WindowsUpdateRuntimeEvidenceError('WINDOWS_UPDATE_RUNTIME_GENERATION_MISMATCH')
    }
    assertSessionBinding(record, session, after)
    const now = this.#nowMs()
    assertNotFuture(session.issuedAtUnixMs, now, 'WINDOWS_UPDATE_RUNTIME_SESSION_FUTURE')
    assertNotFuture(record.writtenAtUnixMs, now, 'WINDOWS_UPDATE_RUNTIME_EVIDENCE_FUTURE')
    return acceptedRuntimeEvidence(record)
  }

  async readPersistedRuntimeEvidence(signal?: AbortSignal): Promise<AcceptedWindowsUpdateRuntimeEvidence> {
    signal?.throwIfAborted()
    const root = await assertNormalDirectory(this.#controlRoot)
    const secret = await readSecret(this.#secretFile, this.#expectedSecretSha256)
    const session = await readRuntimeSession(root, secret)
    const record = await readRuntimeEvidence(root, secret)
    signal?.throwIfAborted()
    assertSessionBinding(record, session)
    const now = this.#nowMs()
    assertNotFuture(session.issuedAtUnixMs, now, 'WINDOWS_UPDATE_RUNTIME_SESSION_FUTURE')
    assertNotFuture(record.writtenAtUnixMs, now, 'WINDOWS_UPDATE_RUNTIME_EVIDENCE_FUTURE')
    return acceptedRuntimeEvidence(record)
  }

  async #probeHeartbeat(signal?: AbortSignal): Promise<BridgeHeartbeat> {
    try {
      return await this.#bridgeClient.probe(signal)
    } catch {
      signal?.throwIfAborted()
      throw new WindowsUpdateRuntimeEvidenceError('WINDOWS_UPDATE_RUNTIME_HEARTBEAT_UNAVAILABLE')
    }
  }

  #nowMs(): number {
    const value = this.#now()
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new WindowsUpdateRuntimeEvidenceError('WINDOWS_UPDATE_EVIDENCE_CLOCK_INVALID')
    }
    return value
  }
}

export interface WindowsUpdateRuntimeEvidenceInput {
  sessionId: string
  pluginVersion: string
  processId: number
  processStartedAtUnixMs: number
  bridgeStartedAtUnixMs: number
  observationGeneration: number
  observedAtUnixMs: number
  writtenAtUnixMs: number
  saveName?: typeof fixedSaveName
  dsvBytes: number
  dsvWriteTimeUtcTicks: string | number | bigint
  dsvSha256: string
  serverBytes: number
  serverWriteTimeUtcTicks: string | number | bigint
  serverSha256: string
}

/** Test/vector builder matching BridgeProtocol.SerializeLoadedSaveEvidence. */
export function buildWindowsUpdateRuntimeEvidence(
  input: WindowsUpdateRuntimeEvidenceInput,
  secretInput: string
): { record: WindowsUpdateRuntimeEvidenceRecord; payload: string } {
  const values: Record<RuntimeKey, string> = {
    protocol: WINDOWS_UPDATE_RUNTIME_EVIDENCE_PROTOCOL,
    sessionId: requireCanonicalGuid(input.sessionId),
    pluginVersion: requirePluginVersion(input.pluginVersion),
    processId: formatPositiveInteger(input.processId, 0x7fffffff),
    processStartedAtUnixMs: formatPositiveInteger(input.processStartedAtUnixMs),
    bridgeStartedAtUnixMs: formatPositiveInteger(input.bridgeStartedAtUnixMs),
    observationGeneration: formatPositiveInteger(input.observationGeneration),
    observedAtUnixMs: formatPositiveInteger(input.observedAtUnixMs),
    writtenAtUnixMs: formatPositiveInteger(input.writtenAtUnixMs),
    saveNameB64: input.saveName === undefined || input.saveName === fixedSaveName
      ? fixedSaveNameBase64Url
      : invalid(),
    dsvBytes: formatPositiveInteger(input.dsvBytes),
    dsvWriteTimeUtcTicks: formatPositiveInt64(input.dsvWriteTimeUtcTicks),
    dsvSha256: requireSha256(input.dsvSha256),
    serverBytes: formatPositiveInteger(input.serverBytes),
    serverWriteTimeUtcTicks: formatPositiveInt64(input.serverWriteTimeUtcTicks),
    serverSha256: requireSha256(input.serverSha256)
  }
  const secret = validateSecret(secretInput)
  const unsigned = serialize(runtimeKeys, values)
  const hmac = sign(runtimeKeys.map((key) => values[key]), secret)
  const payload = `${unsigned}hmac=${hmac}\n`
  return { record: parseWindowsUpdateRuntimeEvidence(payload, secret), payload }
}

export function parseWindowsUpdateRuntimeEvidence(
  payload: string,
  secretInput: string
): WindowsUpdateRuntimeEvidenceRecord {
  const { values, hmac } = parseCanonical(payload, runtimeKeys)
  assertHmac(runtimeKeys.map((key) => values[key]), hmac, validateSecret(secretInput))
  if (values.protocol !== WINDOWS_UPDATE_RUNTIME_EVIDENCE_PROTOCOL ||
      values.saveNameB64 !== fixedSaveNameBase64Url) invalid()
  const record: WindowsUpdateRuntimeEvidenceRecord = {
    protocol: WINDOWS_UPDATE_RUNTIME_EVIDENCE_PROTOCOL,
    sessionId: requireCanonicalGuid(values.sessionId),
    pluginVersion: requirePluginVersion(values.pluginVersion),
    processId: parsePositiveInteger(values.processId, 0x7fffffff),
    processStartedAtUnixMs: parsePositiveInteger(values.processStartedAtUnixMs),
    bridgeStartedAtUnixMs: parsePositiveInteger(values.bridgeStartedAtUnixMs),
    observationGeneration: parsePositiveInteger(values.observationGeneration),
    observedAtUnixMs: parsePositiveInteger(values.observedAtUnixMs),
    writtenAtUnixMs: parsePositiveInteger(values.writtenAtUnixMs),
    saveName: fixedSaveName,
    dsvBytes: parsePositiveInteger(values.dsvBytes),
    dsvWriteTimeUtcTicks: parsePositiveInt64(values.dsvWriteTimeUtcTicks),
    dsvSha256: requireSha256(values.dsvSha256),
    serverBytes: parsePositiveInteger(values.serverBytes),
    serverWriteTimeUtcTicks: parsePositiveInt64(values.serverWriteTimeUtcTicks),
    serverSha256: requireSha256(values.serverSha256),
    hmac
  }
  if (record.processStartedAtUnixMs > record.bridgeStartedAtUnixMs ||
      record.bridgeStartedAtUnixMs > record.observedAtUnixMs ||
      record.observedAtUnixMs > record.writtenAtUnixMs ||
      record.writtenAtUnixMs - record.observedAtUnixMs > 5_000) invalid()
  return record
}

export function computeWindowsUpdateStartupGenerationId(input: Readonly<{
  sessionId: string
  pluginVersion: string
  processId: number
  processStartedAtUnixMs: number
  bridgeStartedAtUnixMs: number
}>): string {
  return createHash('sha256')
    .update('dyson-control-update-runtime-generation-v1\0', 'utf8')
    .update(requireCanonicalGuid(input.sessionId), 'ascii')
    .update('\0', 'ascii')
    .update(requirePluginVersion(input.pluginVersion), 'ascii')
    .update('\0', 'ascii')
    .update(formatPositiveInteger(input.processId, 0x7fffffff), 'ascii')
    .update('\0', 'ascii')
    .update(formatPositiveInteger(input.processStartedAtUnixMs), 'ascii')
    .update('\0', 'ascii')
    .update(formatPositiveInteger(input.bridgeStartedAtUnixMs), 'ascii')
    .digest('hex')
}

function acceptedRuntimeEvidence(
  record: WindowsUpdateRuntimeEvidenceRecord
): AcceptedWindowsUpdateRuntimeEvidence {
  const generation = computeWindowsUpdateStartupGenerationId({
    sessionId: record.sessionId,
    pluginVersion: record.pluginVersion,
    processId: record.processId,
    processStartedAtUnixMs: record.processStartedAtUnixMs,
    bridgeStartedAtUnixMs: record.bridgeStartedAtUnixMs
  })
  const loadedSaveIdentity = pairIdentity(
    record.saveName,
    { bytes: record.dsvBytes, sha256: record.dsvSha256 },
    { bytes: record.serverBytes, sha256: record.serverSha256 }
  )
  return {
    processId: record.processId,
    processStartedAtUnixMs: record.processStartedAtUnixMs,
    bridgeStartedAtUnixMs: record.bridgeStartedAtUnixMs,
    loadedSaveObservedAtUnixMs: record.observedAtUnixMs,
    writtenAtUnixMs: record.writtenAtUnixMs,
    startedAt: new Date(record.processStartedAtUnixMs).toISOString(),
    startupGenerationId: generation,
    bridgeHeartbeatGenerationId: generation,
    loadedSaveLogGenerationId: generation,
    loadedSaveIdentity
  }
}

async function readRuntimeSession(root: string, secret: string): Promise<BridgeRuntimeSession> {
  try {
    return parseBridgeRuntimeSession(await readStableUtf8File(
      path.join(root, WINDOWS_UPDATE_RUNTIME_SESSION_FILE),
      maximumEvidenceBytes,
      'WINDOWS_UPDATE_RUNTIME_SESSION_FILE_INVALID'
    ), secret)
  } catch (error) {
    if (error instanceof WindowsUpdateRuntimeEvidenceError) throw error
    throw new WindowsUpdateRuntimeEvidenceError('WINDOWS_UPDATE_RUNTIME_SESSION_INVALID')
  }
}

async function readRuntimeEvidence(
  root: string,
  secret: string
): Promise<WindowsUpdateRuntimeEvidenceRecord> {
  return parseWindowsUpdateRuntimeEvidence(await readStableUtf8File(
    path.join(root, WINDOWS_UPDATE_RUNTIME_EVIDENCE_FILE),
    maximumEvidenceBytes,
    'WINDOWS_UPDATE_RUNTIME_EVIDENCE_FILE_INVALID'
  ), secret)
}

function assertSessionBinding(
  record: WindowsUpdateRuntimeEvidenceRecord,
  session: BridgeRuntimeSession,
  heartbeat?: BridgeHeartbeat
): void {
  if (record.sessionId !== session.sessionId ||
      record.pluginVersion !== session.pluginVersion ||
      record.processId !== session.processId ||
      record.processStartedAtUnixMs !== session.processStartedAtUnixMs ||
      record.bridgeStartedAtUnixMs !== session.bridgeStartedAtUnixMs ||
      (heartbeat !== undefined && (
        session.processId !== heartbeat.processId ||
        session.bridgeStartedAtUnixMs !== heartbeat.startedAtUnixMs ||
        session.pluginVersion !== heartbeat.pluginVersion
      ))) {
    throw new WindowsUpdateRuntimeEvidenceError('WINDOWS_UPDATE_RUNTIME_GENERATION_MISMATCH')
  }
}

function parseCanonical<K extends string>(
  payload: string,
  keys: readonly K[]
): { values: Record<K, string>; hmac: string } {
  if (typeof payload !== 'string' || payload.length === 0 || payload.length > maximumEvidenceBytes ||
      payload.charCodeAt(0) === 0xfeff || /\r|\0/.test(payload) || !payload.endsWith('\n')) invalid()
  const lines = payload.slice(0, -1).split('\n')
  if (lines.length !== keys.length + 1) invalid()
  const values = {} as Record<K, string>
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!
    const prefix = `${key}=`
    const line = lines[index]!
    if (!line.startsWith(prefix)) invalid()
    const value = line.slice(prefix.length)
    if (value.length === 0 || value.includes('=') || /[\u0000-\u001f\u007f]/.test(value)) invalid()
    values[key] = value
  }
  const hmacLine = lines.at(-1)!
  if (!hmacLine.startsWith('hmac=')) invalid()
  const hmac = requireSha256(hmacLine.slice('hmac='.length))
  return { values, hmac }
}

function serialize<K extends string>(keys: readonly K[], values: Record<K, string>): string {
  return `${keys.map((key) => `${key}=${values[key]}`).join('\n')}\n`
}

function sign(parts: readonly string[], secret: string): string {
  return createHmac('sha256', secret).update(parts.join('\n'), 'utf8').digest('hex')
}

function assertHmac(parts: readonly string[], actual: string, secret: string): void {
  const expected = Buffer.from(sign(parts, secret), 'ascii')
  const candidate = Buffer.from(actual, 'ascii')
  if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
    throw new WindowsUpdateRuntimeEvidenceError('WINDOWS_UPDATE_EVIDENCE_HMAC_INVALID')
  }
}

async function assertNormalDirectory(directory: string): Promise<string> {
  try {
    const resolved = path.resolve(directory)
    const info = await lstat(resolved)
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(resolved), resolved)) {
      throw new Error('invalid')
    }
    return resolved
  } catch {
    throw new WindowsUpdateRuntimeEvidenceError('WINDOWS_UPDATE_EVIDENCE_ROOT_INVALID')
  }
}

async function readSecret(secretFile: string, expectedSecretSha256?: Buffer): Promise<string> {
  try {
    const secret = validateSecret(await readStableUtf8File(
      secretFile,
      maximumSecretBytes,
      'WINDOWS_UPDATE_EVIDENCE_SECRET_INVALID',
      32
    ))
    if (expectedSecretSha256 !== undefined) {
      const actualSecretSha256 = createHash('sha256').update(secret, 'utf8').digest()
      if (actualSecretSha256.length !== expectedSecretSha256.length ||
          !timingSafeEqual(actualSecretSha256, expectedSecretSha256)) {
        throw new WindowsUpdateRuntimeEvidenceError('WINDOWS_UPDATE_EVIDENCE_SECRET_INVALID')
      }
    }
    return secret
  } catch (error) {
    if (error instanceof WindowsUpdateRuntimeEvidenceError) throw error
    throw new WindowsUpdateRuntimeEvidenceError('WINDOWS_UPDATE_EVIDENCE_SECRET_INVALID')
  }
}

async function readStableUtf8File(
  filePath: string,
  maximumBytes: number,
  errorCode: string,
  minimumBytes = 1
): Promise<string> {
  let handle: FileHandle | null = null
  try {
    const beforePath = await lstat(filePath)
    if (!beforePath.isFile() || beforePath.isSymbolicLink() ||
        beforePath.size < minimumBytes || beforePath.size > maximumBytes ||
        !samePath(await realpath(filePath), filePath)) throw new Error('invalid')
    handle = await open(filePath, 'r')
    const before = await handle.stat()
    if (!before.isFile() || before.size < minimumBytes || before.size > maximumBytes ||
        !sameFile(beforePath, before)) throw new Error('invalid')
    const bytes = await handle.readFile()
    const after = await handle.stat()
    const afterPath = await lstat(filePath)
    if (bytes.length < minimumBytes || bytes.length > maximumBytes ||
        !sameFile(before, after) || !sameFile(after, afterPath)) throw new Error('changed')
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new WindowsUpdateRuntimeEvidenceError(errorCode)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function sameFile(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

function assertNotFuture(observedAt: number, now: number, code: string): void {
  if (observedAt > now + futureToleranceMs) {
    throw new WindowsUpdateRuntimeEvidenceError(code)
  }
}

function sameHeartbeatGeneration(left: BridgeHeartbeat, right: BridgeHeartbeat): boolean {
  return left.processId === right.processId &&
    left.startedAtUnixMs === right.startedAtUnixMs &&
    left.pluginVersion === right.pluginVersion
}

function pairIdentity(
  saveName: string,
  dsv: { bytes: number; sha256: string },
  server: { bytes: number; sha256: string }
): string {
  return createHash('sha256')
    .update('dyson-save-pair-revision-v1\0', 'utf8')
    .update(saveName, 'utf8')
    .update('\0dsv\0', 'utf8')
    .update(String(dsv.bytes), 'utf8')
    .update('\0', 'utf8')
    .update(dsv.sha256, 'ascii')
    .update('\0server\0', 'utf8')
    .update(String(server.bytes), 'utf8')
    .update('\0', 'utf8')
    .update(server.sha256, 'ascii')
    .digest('hex')
}

function parsePositiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value)) invalid()
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) invalid()
  return parsed
}

function formatPositiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > maximum) invalid()
  return String(value)
}

function parsePositiveInt64(value: unknown): bigint {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value)) invalid()
  const parsed = BigInt(value)
  if (parsed <= 0n || parsed > maximumInt64) invalid()
  return parsed
}

function formatPositiveInt64(value: unknown): string {
  try {
    const parsed = typeof value === 'bigint'
      ? value
      : typeof value === 'number' && Number.isSafeInteger(value)
        ? BigInt(value)
        : typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value)
          ? BigInt(value)
          : invalid()
    if (parsed <= 0n || parsed > maximumInt64) invalid()
    return parsed.toString()
  } catch (error) {
    if (error instanceof WindowsUpdateRuntimeEvidenceError) throw error
    return invalid()
  }
}

function requireCanonicalGuid(value: unknown): string {
  if (typeof value !== 'string' || !canonicalGuidPattern.test(value)) invalid()
  return value.toLowerCase()
}

function requirePluginVersion(value: unknown): string {
  if (typeof value !== 'string' || !pluginVersionPattern.test(value)) invalid()
  return value
}

function requireSha256(value: unknown): string {
  if (typeof value !== 'string' || !sha256Pattern.test(value)) invalid()
  return value
}

function validateSecret(input: string): string {
  try {
    return validateBridgeSecret(input)
  } catch {
    throw new WindowsUpdateRuntimeEvidenceError('WINDOWS_UPDATE_EVIDENCE_SECRET_INVALID')
  }
}

function isSafeAbsoluteRoot(value: unknown): value is string {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return false
  const resolved = path.resolve(value)
  return resolved !== path.parse(resolved).root
}

function isSafeAbsoluteFile(value: unknown): value is string {
  return typeof value === 'string' && path.isAbsolute(value) &&
    path.basename(path.resolve(value)).length > 0
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).replace(/[\\/]+$/, '').toLowerCase() ===
    path.resolve(right).replace(/[\\/]+$/, '').toLowerCase()
}

function invalid(): never {
  throw new WindowsUpdateRuntimeEvidenceError('WINDOWS_UPDATE_EVIDENCE_PAYLOAD_INVALID')
}

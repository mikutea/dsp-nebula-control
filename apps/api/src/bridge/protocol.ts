import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const bridgeRequestProtocol = 'DYSON_CONTROL_REQUEST_V1' as const
export const bridgeReceiptProtocol = 'DYSON_CONTROL_RECEIPT_V2' as const
export const bridgeHeartbeatProtocol = 'DYSON_CONTROL_HEARTBEAT_V1' as const
export const bridgeRuntimeSessionProtocol = 'DYSON_CONTROL_RUNTIME_SESSION_V1' as const
export const bridgeSimulationTelemetryProtocol = 'DYSON_CONTROL_SIMULATION_TELEMETRY_V1' as const
export const bridgeSimulationUpsSource = 'fpscontroller-stopwatch' as const
export const bridgeSimulationTpsSource = 'gamemain-tick-wallclock' as const
export const bridgeLastExitSaveName = '_lastexit_' as const
export const bridgeUnavailableSaveName = '_unavailable_' as const
const legacyBridgeReceiptProtocol = 'DYSON_CONTROL_RECEIPT_V1' as const

export type BridgeAction = 'save'
export type BridgeReceiptState = 'succeeded' | 'failed'

export interface BridgeRequest {
  protocol: typeof bridgeRequestProtocol
  requestId: string
  createdAtUnixMs: number
  expiresAtUnixMs: number
  action: BridgeAction
  nonce: string
  hmac: string
}

/**
 * Compatibility shape for injected adapters that predate receipt V2. The
 * production FileBridgeClient returns BridgeReceiptV2 and never parses V1.
 */
export interface BridgeReceipt {
  protocol: typeof bridgeReceiptProtocol | typeof legacyBridgeReceiptProtocol
  requestId: string
  action: BridgeAction
  state: BridgeReceiptState
  startedAtUnixMs: number
  finishedAtUnixMs: number
  saveTimeBefore: number | bigint
  saveTimeAfter: number | bigint
  dsvBytes: number
  serverBytes: number
  errorCode: string
  hmac: string
  saveName?: string
  dsvWriteTimeUtcTicks?: bigint
  serverWriteTimeUtcTicks?: bigint
  dsvChanged?: boolean
  serverChanged?: boolean
}

export interface BridgeReceiptV2 extends BridgeReceipt {
  protocol: typeof bridgeReceiptProtocol
  saveName: string
  saveTimeBefore: bigint
  saveTimeAfter: bigint
  dsvWriteTimeUtcTicks: bigint
  serverWriteTimeUtcTicks: bigint
  dsvChanged: boolean
  serverChanged: boolean
}

export interface BridgeReceiptV2Input {
  requestId: string
  action: BridgeAction
  state: BridgeReceiptState
  startedAtUnixMs: number
  finishedAtUnixMs: number
  saveName: string
  saveTimeBefore: string | number | bigint
  saveTimeAfter: string | number | bigint
  dsvBytes: number
  dsvWriteTimeUtcTicks: string | number | bigint
  serverBytes: number
  serverWriteTimeUtcTicks: string | number | bigint
  dsvChanged: boolean
  serverChanged: boolean
  errorCode: string
}

export interface BridgeHeartbeat {
  protocol: typeof bridgeHeartbeatProtocol
  pluginVersion: string
  processId: number
  startedAtUnixMs: number
  writtenAtUnixMs: number
  state: 'ready'
  hmac: string
}

export interface BridgeRuntimeSession {
  protocol: typeof bridgeRuntimeSessionProtocol
  sessionId: string
  pluginVersion: string
  processId: number
  processStartedAtUnixMs: number
  bridgeStartedAtUnixMs: number
  issuedAtUnixMs: number
  hmac: string
}

export interface BridgeSimulationTelemetry {
  protocol: typeof bridgeSimulationTelemetryProtocol
  sessionId: string
  processId: number
  processStartedAtUnixMs: number
  bridgeStartedAtUnixMs: number
  sequence: number
  sampleStartedAtUnixMs: number
  sampleFinishedAtUnixMs: number
  writtenAtUnixMs: number
  windowDurationMs: number
  tickStarted: number
  tickFinished: number
  upsMilli: number
  tpsMilli: number
  upsSource: typeof bridgeSimulationUpsSource
  tpsSource: typeof bridgeSimulationTpsSource
  hmac: string
}

export class BridgeProtocolError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'BridgeProtocolError'
    this.code = code
  }
}

const requestKeys = [
  'protocol', 'requestId', 'createdAtUnixMs', 'expiresAtUnixMs', 'action', 'nonce', 'hmac'
] as const
const receiptKeys = [
  'protocol', 'requestId', 'action', 'state', 'startedAtUnixMs', 'finishedAtUnixMs',
  'saveName', 'saveTimeBefore', 'saveTimeAfter',
  'dsvBytes', 'dsvWriteTimeUtcTicks', 'serverBytes', 'serverWriteTimeUtcTicks',
  'dsvChanged', 'serverChanged', 'errorCode', 'hmac'
] as const
const heartbeatKeys = [
  'protocol', 'pluginVersion', 'processId', 'startedAtUnixMs', 'writtenAtUnixMs', 'state', 'hmac'
] as const
const runtimeSessionKeys = [
  'protocol', 'sessionId', 'pluginVersion', 'processId', 'processStartedAtUnixMs',
  'bridgeStartedAtUnixMs', 'issuedAtUnixMs', 'hmac'
] as const
const simulationTelemetryKeys = [
  'protocol', 'sessionId', 'processId', 'processStartedAtUnixMs', 'bridgeStartedAtUnixMs',
  'sequence', 'sampleStartedAtUnixMs', 'sampleFinishedAtUnixMs', 'writtenAtUnixMs',
  'windowDurationMs', 'tickStarted', 'tickFinished', 'upsMilli', 'tpsMilli',
  'upsSource', 'tpsSource', 'hmac'
] as const
const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const noncePattern = /^[A-Za-z0-9_-]{22,64}$/
const hmacPattern = /^[0-9a-f]{64}$/i
const errorCodePattern = /^(?:NONE|[A-Z][A-Z0-9_]{2,47})$/
const pluginVersionPattern = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]{1,32})?$/
const canonicalInt64Pattern = /^(?:-1|0|[1-9]\d{0,18})$/
const maximumInt64 = 9_223_372_036_854_775_807n
const generationIdPrefix = 'generation-v1:'
const maximumSimulationMilliRate = 10_000_000

export function validateBridgeSecret(secret: string): string {
  const normalized = secret.trim()
  if (normalized.length < 32 || normalized.length > 512 || /[\r\n\0]/.test(normalized)) {
    throw new BridgeProtocolError('BRIDGE_SECRET_INVALID')
  }
  return normalized
}

export function buildBridgeRequest(
  requestId: string,
  secret: string,
  nowUnixMs = Date.now(),
  lifetimeMs = 15_000
): { request: BridgeRequest; payload: string } {
  const normalizedRequestId = normalizeRequestId(requestId)
  if (!Number.isSafeInteger(nowUnixMs) || nowUnixMs <= 0) {
    throw new BridgeProtocolError('BRIDGE_TIME_INVALID')
  }
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1_000 || lifetimeMs > 120_000) {
    throw new BridgeProtocolError('BRIDGE_LIFETIME_INVALID')
  }
  const request: BridgeRequest = {
    protocol: bridgeRequestProtocol,
    requestId: normalizedRequestId,
    createdAtUnixMs: nowUnixMs,
    expiresAtUnixMs: nowUnixMs + lifetimeMs,
    action: 'save',
    nonce: randomBytes(18).toString('base64url'),
    hmac: ''
  }
  request.hmac = signRequest(request, validateBridgeSecret(secret))
  return { request, payload: serialize(requestKeys, request) }
}

export function parseBridgeRequest(payload: string, secret: string): BridgeRequest {
  const values = parse(payload, requestKeys)
  const request: BridgeRequest = {
    protocol: requireLiteral(values.protocol, bridgeRequestProtocol),
    requestId: normalizeRequestId(values.requestId),
    createdAtUnixMs: parseSafeInteger(values.createdAtUnixMs, 1, Number.MAX_SAFE_INTEGER),
    expiresAtUnixMs: parseSafeInteger(values.expiresAtUnixMs, 1, Number.MAX_SAFE_INTEGER),
    action: requireLiteral(values.action, 'save'),
    nonce: requirePattern(values.nonce, noncePattern, 'BRIDGE_NONCE_INVALID'),
    hmac: requirePattern(values.hmac, hmacPattern, 'BRIDGE_HMAC_INVALID').toLowerCase()
  }
  if (request.expiresAtUnixMs <= request.createdAtUnixMs ||
      request.expiresAtUnixMs - request.createdAtUnixMs > 120_000) {
    throw new BridgeProtocolError('BRIDGE_TIME_INVALID')
  }
  assertSignature(request.hmac, signRequest(request, validateBridgeSecret(secret)))
  return request
}

export function buildBridgeReceipt(
  values: BridgeReceiptV2Input,
  secret: string
): { receipt: BridgeReceiptV2; payload: string } {
  const receipt: BridgeReceiptV2 = {
    protocol: bridgeReceiptProtocol,
    requestId: normalizeRequestId(values.requestId),
    action: requireLiteral(values.action, 'save'),
    state: requireReceiptState(values.state),
    startedAtUnixMs: requireSafeInteger(values.startedAtUnixMs),
    finishedAtUnixMs: requireSafeInteger(values.finishedAtUnixMs),
    saveName: requireSaveName(values.saveName),
    saveTimeBefore: requireInt64(values.saveTimeBefore),
    saveTimeAfter: requireInt64(values.saveTimeAfter),
    dsvBytes: requireSignedSafeInteger(values.dsvBytes),
    dsvWriteTimeUtcTicks: requireInt64(values.dsvWriteTimeUtcTicks),
    serverBytes: requireSignedSafeInteger(values.serverBytes),
    serverWriteTimeUtcTicks: requireInt64(values.serverWriteTimeUtcTicks),
    dsvChanged: requireBoolean(values.dsvChanged),
    serverChanged: requireBoolean(values.serverChanged),
    errorCode: requirePattern(values.errorCode, errorCodePattern, 'BRIDGE_ERROR_CODE_INVALID'),
    hmac: ''
  }
  validateReceiptSemantics(receipt)
  receipt.hmac = signReceipt(receipt, validateBridgeSecret(secret))
  return { receipt, payload: serialize(receiptKeys, receipt) }
}

export function parseBridgeReceipt(payload: string, secret: string): BridgeReceiptV2 {
  const values = parse(payload, receiptKeys)
  const receipt: BridgeReceiptV2 = {
    protocol: requireLiteral(values.protocol, bridgeReceiptProtocol),
    requestId: normalizeRequestId(values.requestId),
    action: requireLiteral(values.action, 'save'),
    state: requireReceiptState(values.state),
    startedAtUnixMs: parseSafeInteger(values.startedAtUnixMs, 1, Number.MAX_SAFE_INTEGER),
    finishedAtUnixMs: parseSafeInteger(values.finishedAtUnixMs, 1, Number.MAX_SAFE_INTEGER),
    saveName: requireSaveName(values.saveName),
    saveTimeBefore: parseInt64(values.saveTimeBefore),
    saveTimeAfter: parseInt64(values.saveTimeAfter),
    dsvBytes: parseSafeInteger(values.dsvBytes, -1, Number.MAX_SAFE_INTEGER),
    dsvWriteTimeUtcTicks: parseInt64(values.dsvWriteTimeUtcTicks),
    serverBytes: parseSafeInteger(values.serverBytes, -1, Number.MAX_SAFE_INTEGER),
    serverWriteTimeUtcTicks: parseInt64(values.serverWriteTimeUtcTicks),
    dsvChanged: parseBoolean(values.dsvChanged),
    serverChanged: parseBoolean(values.serverChanged),
    errorCode: requirePattern(values.errorCode, errorCodePattern, 'BRIDGE_ERROR_CODE_INVALID'),
    hmac: requirePattern(values.hmac, hmacPattern, 'BRIDGE_HMAC_INVALID').toLowerCase()
  }
  validateReceiptSemantics(receipt)
  assertSignature(receipt.hmac, signReceipt(receipt, validateBridgeSecret(secret)))
  return receipt
}

export function computeBridgeSaveGenerationId(receipt: BridgeReceipt): string {
  assertBridgeReceiptV2(receipt)
  if (receipt.state !== 'succeeded') {
    throw new BridgeProtocolError('BRIDGE_GENERATION_UNAVAILABLE')
  }
  const digest = createHash('sha256')
    .update('dyson-control-save-generation-v1\n', 'utf8')
    .update(receipt.saveName, 'utf8')
    .update('\n', 'utf8')
    .update(receipt.saveTimeAfter.toString(), 'ascii')
    .update('\n', 'utf8')
    .update(String(receipt.dsvBytes), 'ascii')
    .update('\n', 'utf8')
    .update(receipt.dsvWriteTimeUtcTicks.toString(), 'ascii')
    .update('\n', 'utf8')
    .update(String(receipt.serverBytes), 'ascii')
    .update('\n', 'utf8')
    .update(receipt.serverWriteTimeUtcTicks.toString(), 'ascii')
    .digest('hex')
  return `${generationIdPrefix}${digest}`
}

/**
 * Runtime boundary for injected bridge adapters. Production file receipts are
 * already parsed and signed as V2, but lifecycle callers must reject an
 * injected legacy or structurally incomplete object just as strictly.
 */
export function assertBridgeReceiptV2(receipt: BridgeReceipt): asserts receipt is BridgeReceiptV2 {
  if (receipt === null || typeof receipt !== 'object' || !isBridgeReceiptV2(receipt)) {
    throw new BridgeProtocolError('BRIDGE_RECEIPT_V2_REQUIRED')
  }
  normalizeRequestId(receipt.requestId)
  requireLiteral(receipt.action, 'save')
  requireReceiptState(receipt.state)
  requireSafeInteger(receipt.startedAtUnixMs)
  requireSafeInteger(receipt.finishedAtUnixMs)
  requireSaveName(receipt.saveName)
  requireInt64(receipt.saveTimeBefore)
  requireInt64(receipt.saveTimeAfter)
  requireSignedSafeInteger(receipt.dsvBytes)
  requireInt64(receipt.dsvWriteTimeUtcTicks)
  requireSignedSafeInteger(receipt.serverBytes)
  requireInt64(receipt.serverWriteTimeUtcTicks)
  requireBoolean(receipt.dsvChanged)
  requireBoolean(receipt.serverChanged)
  requirePattern(receipt.errorCode, errorCodePattern, 'BRIDGE_ERROR_CODE_INVALID')
  requirePattern(receipt.hmac, hmacPattern, 'BRIDGE_HMAC_INVALID')
  validateReceiptSemantics(receipt)
}

export function buildBridgeHeartbeat(
  values: Omit<BridgeHeartbeat, 'protocol' | 'hmac' | 'state'>,
  secret: string
): { heartbeat: BridgeHeartbeat; payload: string } {
  const heartbeat: BridgeHeartbeat = {
    protocol: bridgeHeartbeatProtocol,
    pluginVersion: requirePattern(values.pluginVersion, pluginVersionPattern, 'BRIDGE_VERSION_INVALID'),
    processId: requireSafeInteger(values.processId),
    startedAtUnixMs: requireSafeInteger(values.startedAtUnixMs),
    writtenAtUnixMs: requireSafeInteger(values.writtenAtUnixMs),
    state: 'ready',
    hmac: ''
  }
  validateHeartbeatSemantics(heartbeat)
  heartbeat.hmac = signHeartbeat(heartbeat, validateBridgeSecret(secret))
  return { heartbeat, payload: serialize(heartbeatKeys, heartbeat) }
}

export function parseBridgeHeartbeat(payload: string, secret: string): BridgeHeartbeat {
  const values = parse(payload, heartbeatKeys)
  const heartbeat: BridgeHeartbeat = {
    protocol: requireLiteral(values.protocol, bridgeHeartbeatProtocol),
    pluginVersion: requirePattern(values.pluginVersion, pluginVersionPattern, 'BRIDGE_VERSION_INVALID'),
    processId: parseSafeInteger(values.processId, 1, 0x7fffffff),
    startedAtUnixMs: parseSafeInteger(values.startedAtUnixMs, 1, Number.MAX_SAFE_INTEGER),
    writtenAtUnixMs: parseSafeInteger(values.writtenAtUnixMs, 1, Number.MAX_SAFE_INTEGER),
    state: requireLiteral(values.state, 'ready'),
    hmac: requirePattern(values.hmac, hmacPattern, 'BRIDGE_HMAC_INVALID').toLowerCase()
  }
  validateHeartbeatSemantics(heartbeat)
  assertSignature(heartbeat.hmac, signHeartbeat(heartbeat, validateBridgeSecret(secret)))
  return heartbeat
}

export function buildBridgeRuntimeSession(
  values: Omit<BridgeRuntimeSession, 'protocol' | 'hmac'>,
  secret: string
): { session: BridgeRuntimeSession; payload: string } {
  const session: BridgeRuntimeSession = {
    protocol: bridgeRuntimeSessionProtocol,
    sessionId: normalizeSessionId(values.sessionId),
    pluginVersion: requirePattern(values.pluginVersion, pluginVersionPattern, 'BRIDGE_VERSION_INVALID'),
    processId: requireSafeInteger(values.processId),
    processStartedAtUnixMs: requireSafeInteger(values.processStartedAtUnixMs),
    bridgeStartedAtUnixMs: requireSafeInteger(values.bridgeStartedAtUnixMs),
    issuedAtUnixMs: requireSafeInteger(values.issuedAtUnixMs),
    hmac: ''
  }
  validateRuntimeSessionSemantics(session)
  session.hmac = signRuntimeSession(session, validateBridgeSecret(secret))
  return { session, payload: serialize(runtimeSessionKeys, session) }
}

export function parseBridgeRuntimeSession(payload: string, secret: string): BridgeRuntimeSession {
  const values = parse(payload, runtimeSessionKeys)
  const session: BridgeRuntimeSession = {
    protocol: requireLiteral(values.protocol, bridgeRuntimeSessionProtocol),
    sessionId: normalizeSessionId(values.sessionId),
    pluginVersion: requirePattern(values.pluginVersion, pluginVersionPattern, 'BRIDGE_VERSION_INVALID'),
    processId: parseSafeInteger(values.processId, 1, 0x7fffffff),
    processStartedAtUnixMs: parseSafeInteger(values.processStartedAtUnixMs, 1, Number.MAX_SAFE_INTEGER),
    bridgeStartedAtUnixMs: parseSafeInteger(values.bridgeStartedAtUnixMs, 1, Number.MAX_SAFE_INTEGER),
    issuedAtUnixMs: parseSafeInteger(values.issuedAtUnixMs, 1, Number.MAX_SAFE_INTEGER),
    hmac: requirePattern(values.hmac, hmacPattern, 'BRIDGE_HMAC_INVALID').toLowerCase()
  }
  validateRuntimeSessionSemantics(session)
  assertSignature(session.hmac, signRuntimeSession(session, validateBridgeSecret(secret)))
  return session
}

export function buildBridgeSimulationTelemetry(
  values: Omit<BridgeSimulationTelemetry, 'protocol' | 'hmac' | 'upsSource' | 'tpsSource'>,
  secret: string
): { telemetry: BridgeSimulationTelemetry; payload: string } {
  const telemetry: BridgeSimulationTelemetry = {
    protocol: bridgeSimulationTelemetryProtocol,
    sessionId: normalizeSessionId(values.sessionId),
    processId: requireSafeInteger(values.processId),
    processStartedAtUnixMs: requireSafeInteger(values.processStartedAtUnixMs),
    bridgeStartedAtUnixMs: requireSafeInteger(values.bridgeStartedAtUnixMs),
    sequence: requireSafeInteger(values.sequence),
    sampleStartedAtUnixMs: requireSafeInteger(values.sampleStartedAtUnixMs),
    sampleFinishedAtUnixMs: requireSafeInteger(values.sampleFinishedAtUnixMs),
    writtenAtUnixMs: requireSafeInteger(values.writtenAtUnixMs),
    windowDurationMs: requireSafeInteger(values.windowDurationMs),
    tickStarted: requireNonnegativeSafeInteger(values.tickStarted),
    tickFinished: requireNonnegativeSafeInteger(values.tickFinished),
    upsMilli: requireNonnegativeSafeInteger(values.upsMilli),
    tpsMilli: requireNonnegativeSafeInteger(values.tpsMilli),
    upsSource: bridgeSimulationUpsSource,
    tpsSource: bridgeSimulationTpsSource,
    hmac: ''
  }
  validateSimulationTelemetrySemantics(telemetry)
  telemetry.hmac = signSimulationTelemetry(telemetry, validateBridgeSecret(secret))
  return { telemetry, payload: serialize(simulationTelemetryKeys, telemetry) }
}

export function parseBridgeSimulationTelemetry(payload: string, secret: string): BridgeSimulationTelemetry {
  const values = parse(payload, simulationTelemetryKeys)
  const telemetry: BridgeSimulationTelemetry = {
    protocol: requireLiteral(values.protocol, bridgeSimulationTelemetryProtocol),
    sessionId: normalizeSessionId(values.sessionId),
    processId: parseSafeInteger(values.processId, 1, 0x7fffffff),
    processStartedAtUnixMs: parseSafeInteger(values.processStartedAtUnixMs, 1, Number.MAX_SAFE_INTEGER),
    bridgeStartedAtUnixMs: parseSafeInteger(values.bridgeStartedAtUnixMs, 1, Number.MAX_SAFE_INTEGER),
    sequence: parseSafeInteger(values.sequence, 1, Number.MAX_SAFE_INTEGER),
    sampleStartedAtUnixMs: parseSafeInteger(values.sampleStartedAtUnixMs, 1, Number.MAX_SAFE_INTEGER),
    sampleFinishedAtUnixMs: parseSafeInteger(values.sampleFinishedAtUnixMs, 1, Number.MAX_SAFE_INTEGER),
    writtenAtUnixMs: parseSafeInteger(values.writtenAtUnixMs, 1, Number.MAX_SAFE_INTEGER),
    windowDurationMs: parseSafeInteger(values.windowDurationMs, 1_000, 10_000),
    tickStarted: parseSafeInteger(values.tickStarted, 0, Number.MAX_SAFE_INTEGER),
    tickFinished: parseSafeInteger(values.tickFinished, 0, Number.MAX_SAFE_INTEGER),
    upsMilli: parseSafeInteger(values.upsMilli, 0, maximumSimulationMilliRate),
    tpsMilli: parseSafeInteger(values.tpsMilli, 0, maximumSimulationMilliRate),
    upsSource: requireLiteral(values.upsSource, bridgeSimulationUpsSource),
    tpsSource: requireLiteral(values.tpsSource, bridgeSimulationTpsSource),
    hmac: requirePattern(values.hmac, hmacPattern, 'BRIDGE_HMAC_INVALID').toLowerCase()
  }
  validateSimulationTelemetrySemantics(telemetry)
  assertSignature(telemetry.hmac, signSimulationTelemetry(telemetry, validateBridgeSecret(secret)))
  return telemetry
}

export function actualSimulationRates(telemetry: BridgeSimulationTelemetry): {
  ups: number
  tps: number
} {
  validateSimulationTelemetrySemantics(telemetry)
  return { ups: telemetry.upsMilli / 1_000, tps: telemetry.tpsMilli / 1_000 }
}

function validateReceiptSemantics(receipt: BridgeReceiptV2): void {
  if (receipt.finishedAtUnixMs < receipt.startedAtUnixMs) {
    throw new BridgeProtocolError('BRIDGE_TIME_INVALID')
  }
  if (receipt.state === 'succeeded') {
    // Pinned Nebula v0.9.22 writes .server unconditionally before the game
    // writes .dsv. Accepting a one-sided change could bind two generations.
    if (receipt.saveName !== bridgeLastExitSaveName || receipt.errorCode !== 'NONE' ||
        receipt.dsvBytes <= 0 || receipt.serverBytes <= 0 ||
        receipt.dsvWriteTimeUtcTicks <= 0n || receipt.serverWriteTimeUtcTicks <= 0n ||
        receipt.saveTimeBefore < 0n || receipt.saveTimeAfter <= receipt.saveTimeBefore ||
        (!receipt.dsvChanged || !receipt.serverChanged)) {
      throw new BridgeProtocolError('BRIDGE_RECEIPT_INCONSISTENT')
    }
    // A failed receipt may report changed=true with -1 metadata: the signed
    // assertion then means the pre-call file identity changed by disappearing.
  } else {
    if ((receipt.saveName !== bridgeLastExitSaveName && receipt.saveName !== bridgeUnavailableSaveName) ||
        receipt.errorCode === 'NONE') {
      throw new BridgeProtocolError('BRIDGE_RECEIPT_INCONSISTENT')
    }
  }
}

function signRequest(request: Omit<BridgeRequest, 'hmac'> | BridgeRequest, secret: string): string {
  return hmac([
    bridgeRequestProtocol,
    request.requestId,
    String(request.createdAtUnixMs),
    String(request.expiresAtUnixMs),
    request.action,
    request.nonce
  ], secret)
}

function signReceipt(receipt: Omit<BridgeReceiptV2, 'hmac'> | BridgeReceiptV2, secret: string): string {
  return hmac([
    bridgeReceiptProtocol,
    receipt.requestId,
    receipt.action,
    receipt.state,
    String(receipt.startedAtUnixMs),
    String(receipt.finishedAtUnixMs),
    receipt.saveName,
    String(receipt.saveTimeBefore),
    String(receipt.saveTimeAfter),
    String(receipt.dsvBytes),
    String(receipt.dsvWriteTimeUtcTicks),
    String(receipt.serverBytes),
    String(receipt.serverWriteTimeUtcTicks),
    String(receipt.dsvChanged),
    String(receipt.serverChanged),
    receipt.errorCode
  ], secret)
}

function signHeartbeat(
  heartbeat: Omit<BridgeHeartbeat, 'hmac'> | BridgeHeartbeat,
  secret: string
): string {
  return hmac([
    bridgeHeartbeatProtocol,
    heartbeat.pluginVersion,
    String(heartbeat.processId),
    String(heartbeat.startedAtUnixMs),
    String(heartbeat.writtenAtUnixMs),
    heartbeat.state
  ], secret)
}

function signRuntimeSession(
  session: Omit<BridgeRuntimeSession, 'hmac'> | BridgeRuntimeSession,
  secret: string
): string {
  return hmac([
    bridgeRuntimeSessionProtocol,
    session.sessionId,
    session.pluginVersion,
    String(session.processId),
    String(session.processStartedAtUnixMs),
    String(session.bridgeStartedAtUnixMs),
    String(session.issuedAtUnixMs)
  ], secret)
}

function signSimulationTelemetry(
  telemetry: Omit<BridgeSimulationTelemetry, 'hmac'> | BridgeSimulationTelemetry,
  secret: string
): string {
  return hmac([
    bridgeSimulationTelemetryProtocol,
    telemetry.sessionId,
    String(telemetry.processId),
    String(telemetry.processStartedAtUnixMs),
    String(telemetry.bridgeStartedAtUnixMs),
    String(telemetry.sequence),
    String(telemetry.sampleStartedAtUnixMs),
    String(telemetry.sampleFinishedAtUnixMs),
    String(telemetry.writtenAtUnixMs),
    String(telemetry.windowDurationMs),
    String(telemetry.tickStarted),
    String(telemetry.tickFinished),
    String(telemetry.upsMilli),
    String(telemetry.tpsMilli),
    telemetry.upsSource,
    telemetry.tpsSource
  ], secret)
}

function validateHeartbeatSemantics(heartbeat: BridgeHeartbeat): void {
  if (heartbeat.writtenAtUnixMs < heartbeat.startedAtUnixMs) {
    throw new BridgeProtocolError('BRIDGE_TIME_INVALID')
  }
}

function validateRuntimeSessionSemantics(session: BridgeRuntimeSession): void {
  if (session.bridgeStartedAtUnixMs < session.processStartedAtUnixMs ||
      session.issuedAtUnixMs < session.bridgeStartedAtUnixMs - 5_000 ||
      session.issuedAtUnixMs > session.bridgeStartedAtUnixMs + 120_000) {
    throw new BridgeProtocolError('BRIDGE_RUNTIME_SESSION_INCONSISTENT')
  }
}

function validateSimulationTelemetrySemantics(telemetry: BridgeSimulationTelemetry): void {
  if (telemetry.bridgeStartedAtUnixMs < telemetry.processStartedAtUnixMs ||
      telemetry.sampleFinishedAtUnixMs < telemetry.sampleStartedAtUnixMs ||
      telemetry.writtenAtUnixMs < telemetry.sampleFinishedAtUnixMs ||
      telemetry.writtenAtUnixMs - telemetry.sampleFinishedAtUnixMs > 5_000 ||
      telemetry.sampleFinishedAtUnixMs - telemetry.sampleStartedAtUnixMs > 120_000 ||
      telemetry.sampleStartedAtUnixMs < telemetry.bridgeStartedAtUnixMs - 5_000 ||
      telemetry.windowDurationMs < 1_000 || telemetry.windowDurationMs > 10_000 ||
      telemetry.tickFinished < telemetry.tickStarted ||
      telemetry.upsMilli < 0 || telemetry.upsMilli > maximumSimulationMilliRate ||
      telemetry.tpsMilli < 0 || telemetry.tpsMilli > maximumSimulationMilliRate) {
    throw new BridgeProtocolError('BRIDGE_TELEMETRY_INCONSISTENT')
  }
  const expectedTpsMilli = (telemetry.tickFinished - telemetry.tickStarted) * 1_000_000 /
    telemetry.windowDurationMs
  if (!Number.isFinite(expectedTpsMilli) || Math.abs(expectedTpsMilli - telemetry.tpsMilli) > 1) {
    throw new BridgeProtocolError('BRIDGE_TELEMETRY_INCONSISTENT')
  }
}

function hmac(parts: string[], secret: string): string {
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(parts.join('\n'), 'utf8').digest('hex')
}

function assertSignature(actualHex: string, expectedHex: string): void {
  const actual = Buffer.from(actualHex, 'hex')
  const expected = Buffer.from(expectedHex, 'hex')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new BridgeProtocolError('BRIDGE_SIGNATURE_INVALID')
  }
}

function parse<K extends readonly string[]>(payload: string, keys: K): Record<K[number], string> {
  if (Buffer.byteLength(payload, 'utf8') > 4096 || payload.includes('\0') || payload.includes('\uFEFF')) {
    throw new BridgeProtocolError('BRIDGE_PAYLOAD_INVALID')
  }
  const lines = payload.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  if (lines.length !== keys.length) throw new BridgeProtocolError('BRIDGE_PAYLOAD_INVALID')
  const values: Partial<Record<K[number], string>> = {}
  for (let index = 0; index < keys.length; index++) {
    const expectedKey = keys[index]!
    const line = lines[index]!
    if (!line.startsWith(`${expectedKey}=`)) throw new BridgeProtocolError('BRIDGE_PAYLOAD_INVALID')
    const value = line.slice(expectedKey.length + 1)
    if (value.length === 0 || /[\r\n\0]/.test(value)) throw new BridgeProtocolError('BRIDGE_PAYLOAD_INVALID')
    values[expectedKey as K[number]] = value
  }
  return values as Record<K[number], string>
}

function serialize<K extends readonly string[]>(keys: K, values: Record<K[number], unknown>): string {
  return `${keys.map((key) => `${key}=${String(values[key as K[number]])}`).join('\n')}\n`
}

function normalizeRequestId(value: string): string {
  if (!guidPattern.test(value)) throw new BridgeProtocolError('BRIDGE_REQUEST_ID_INVALID')
  return value.toLowerCase()
}

function normalizeSessionId(value: string): string {
  if (!guidPattern.test(value)) throw new BridgeProtocolError('BRIDGE_SESSION_ID_INVALID')
  return value.toLowerCase()
}

function parseSafeInteger(value: string, minimum: number, maximum: number): number {
  if (!/^(?:-1|0|[1-9]\d*)$/.test(value)) throw new BridgeProtocolError('BRIDGE_NUMBER_INVALID')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new BridgeProtocolError('BRIDGE_NUMBER_INVALID')
  }
  return parsed
}

function requireSafeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new BridgeProtocolError('BRIDGE_NUMBER_INVALID')
  return value
}

function requireSignedSafeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < -1) throw new BridgeProtocolError('BRIDGE_NUMBER_INVALID')
  return value
}

function requireNonnegativeSafeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new BridgeProtocolError('BRIDGE_NUMBER_INVALID')
  return value
}

function parseInt64(value: string): bigint {
  if (!canonicalInt64Pattern.test(value)) throw new BridgeProtocolError('BRIDGE_INT64_INVALID')
  const parsed = BigInt(value)
  if (parsed < -1n || parsed > maximumInt64) throw new BridgeProtocolError('BRIDGE_INT64_INVALID')
  return parsed
}

function requireInt64(value: string | number | bigint): bigint {
  if (typeof value === 'string') return parseInt64(value)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new BridgeProtocolError('BRIDGE_INT64_INVALID')
    return parseInt64(String(value))
  }
  if (typeof value !== 'bigint' || value < -1n || value > maximumInt64) {
    throw new BridgeProtocolError('BRIDGE_INT64_INVALID')
  }
  return value
}

function requireBoolean(value: boolean): boolean {
  if (typeof value !== 'boolean') throw new BridgeProtocolError('BRIDGE_BOOLEAN_INVALID')
  return value
}

function parseBoolean(value: string): boolean {
  if (value === 'true') return true
  if (value === 'false') return false
  throw new BridgeProtocolError('BRIDGE_BOOLEAN_INVALID')
}

function requireSaveName(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 120 ||
      value === '.' || value === '..' || /[\\/:*?"<>|\u0000-\u001f]/u.test(value) ||
      Buffer.byteLength(value, 'utf8') > 360) {
    throw new BridgeProtocolError('BRIDGE_SAVE_NAME_INVALID')
  }
  return value
}

function isBridgeReceiptV2(receipt: BridgeReceipt): receipt is BridgeReceiptV2 {
  return receipt.protocol === bridgeReceiptProtocol && typeof receipt.saveName === 'string' &&
    typeof receipt.saveTimeBefore === 'bigint' && typeof receipt.saveTimeAfter === 'bigint' &&
    typeof receipt.dsvWriteTimeUtcTicks === 'bigint' &&
    typeof receipt.serverWriteTimeUtcTicks === 'bigint' &&
    typeof receipt.dsvChanged === 'boolean' && typeof receipt.serverChanged === 'boolean'
}

function requireLiteral<T extends string>(value: string, literal: T): T {
  if (value !== literal) throw new BridgeProtocolError('BRIDGE_LITERAL_INVALID')
  return literal
}

function requirePattern(value: string, pattern: RegExp, code: string): string {
  if (!pattern.test(value)) throw new BridgeProtocolError(code)
  return value
}

function requireReceiptState(value: string): BridgeReceiptState {
  if (value !== 'succeeded' && value !== 'failed') {
    throw new BridgeProtocolError('BRIDGE_STATE_INVALID')
  }
  return value
}

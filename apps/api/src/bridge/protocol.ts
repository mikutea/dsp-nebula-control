import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const bridgeRequestProtocol = 'DYSON_CONTROL_REQUEST_V1' as const
export const bridgeReceiptProtocol = 'DYSON_CONTROL_RECEIPT_V1' as const
export const bridgeHeartbeatProtocol = 'DYSON_CONTROL_HEARTBEAT_V1' as const

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

export interface BridgeReceipt {
  protocol: typeof bridgeReceiptProtocol
  requestId: string
  action: BridgeAction
  state: BridgeReceiptState
  startedAtUnixMs: number
  finishedAtUnixMs: number
  saveTimeBefore: number
  saveTimeAfter: number
  dsvBytes: number
  serverBytes: number
  errorCode: string
  hmac: string
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
  'saveTimeBefore', 'saveTimeAfter', 'dsvBytes', 'serverBytes', 'errorCode', 'hmac'
] as const
const heartbeatKeys = [
  'protocol', 'pluginVersion', 'processId', 'startedAtUnixMs', 'writtenAtUnixMs', 'state', 'hmac'
] as const
const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const noncePattern = /^[A-Za-z0-9_-]{22,64}$/
const hmacPattern = /^[0-9a-f]{64}$/i
const errorCodePattern = /^(?:NONE|[A-Z][A-Z0-9_]{2,47})$/
const pluginVersionPattern = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]{1,32})?$/

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
  values: Omit<BridgeReceipt, 'protocol' | 'hmac'>,
  secret: string
): { receipt: BridgeReceipt; payload: string } {
  const receipt: BridgeReceipt = {
    protocol: bridgeReceiptProtocol,
    requestId: normalizeRequestId(values.requestId),
    action: requireLiteral(values.action, 'save'),
    state: requireReceiptState(values.state),
    startedAtUnixMs: requireSafeInteger(values.startedAtUnixMs),
    finishedAtUnixMs: requireSafeInteger(values.finishedAtUnixMs),
    saveTimeBefore: requireSignedSafeInteger(values.saveTimeBefore),
    saveTimeAfter: requireSignedSafeInteger(values.saveTimeAfter),
    dsvBytes: requireSignedSafeInteger(values.dsvBytes),
    serverBytes: requireSignedSafeInteger(values.serverBytes),
    errorCode: requirePattern(values.errorCode, errorCodePattern, 'BRIDGE_ERROR_CODE_INVALID'),
    hmac: ''
  }
  validateReceiptSemantics(receipt)
  receipt.hmac = signReceipt(receipt, validateBridgeSecret(secret))
  return { receipt, payload: serialize(receiptKeys, receipt) }
}

export function parseBridgeReceipt(payload: string, secret: string): BridgeReceipt {
  const values = parse(payload, receiptKeys)
  const receipt: BridgeReceipt = {
    protocol: requireLiteral(values.protocol, bridgeReceiptProtocol),
    requestId: normalizeRequestId(values.requestId),
    action: requireLiteral(values.action, 'save'),
    state: requireReceiptState(values.state),
    startedAtUnixMs: parseSafeInteger(values.startedAtUnixMs, 1, Number.MAX_SAFE_INTEGER),
    finishedAtUnixMs: parseSafeInteger(values.finishedAtUnixMs, 1, Number.MAX_SAFE_INTEGER),
    saveTimeBefore: parseSafeInteger(values.saveTimeBefore, -1, Number.MAX_SAFE_INTEGER),
    saveTimeAfter: parseSafeInteger(values.saveTimeAfter, -1, Number.MAX_SAFE_INTEGER),
    dsvBytes: parseSafeInteger(values.dsvBytes, -1, Number.MAX_SAFE_INTEGER),
    serverBytes: parseSafeInteger(values.serverBytes, -1, Number.MAX_SAFE_INTEGER),
    errorCode: requirePattern(values.errorCode, errorCodePattern, 'BRIDGE_ERROR_CODE_INVALID'),
    hmac: requirePattern(values.hmac, hmacPattern, 'BRIDGE_HMAC_INVALID').toLowerCase()
  }
  validateReceiptSemantics(receipt)
  assertSignature(receipt.hmac, signReceipt(receipt, validateBridgeSecret(secret)))
  return receipt
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

function validateReceiptSemantics(receipt: BridgeReceipt): void {
  if (receipt.finishedAtUnixMs < receipt.startedAtUnixMs) {
    throw new BridgeProtocolError('BRIDGE_TIME_INVALID')
  }
  if (receipt.state === 'succeeded') {
    if (receipt.errorCode !== 'NONE' || receipt.dsvBytes < 0 || receipt.serverBytes < 0 ||
        receipt.saveTimeBefore < 0 || receipt.saveTimeAfter <= receipt.saveTimeBefore) {
      throw new BridgeProtocolError('BRIDGE_RECEIPT_INCONSISTENT')
    }
  } else if (receipt.errorCode === 'NONE') {
    throw new BridgeProtocolError('BRIDGE_RECEIPT_INCONSISTENT')
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

function signReceipt(receipt: Omit<BridgeReceipt, 'hmac'> | BridgeReceipt, secret: string): string {
  return hmac([
    bridgeReceiptProtocol,
    receipt.requestId,
    receipt.action,
    receipt.state,
    String(receipt.startedAtUnixMs),
    String(receipt.finishedAtUnixMs),
    String(receipt.saveTimeBefore),
    String(receipt.saveTimeAfter),
    String(receipt.dsvBytes),
    String(receipt.serverBytes),
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

function validateHeartbeatSemantics(heartbeat: BridgeHeartbeat): void {
  if (heartbeat.writtenAtUnixMs < heartbeat.startedAtUnixMs) {
    throw new BridgeProtocolError('BRIDGE_TIME_INVALID')
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
  if (Buffer.byteLength(payload, 'utf8') > 4096 || payload.includes('\0')) {
    throw new BridgeProtocolError('BRIDGE_PAYLOAD_INVALID')
  }
  const lines = payload.replace(/^\uFEFF/, '').split(/\r?\n/)
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

function parseSafeInteger(value: string, minimum: number, maximum: number): number {
  if (!/^-?\d+$/.test(value)) throw new BridgeProtocolError('BRIDGE_NUMBER_INVALID')
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

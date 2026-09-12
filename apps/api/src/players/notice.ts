import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import { validateBridgeSecret } from '../bridge/protocol.js'
import { findPlayerCapability, type PlayerCapabilitySnapshot } from './capabilities.js'
import type { PlayerSnapshot } from './protocol.js'

export const playerNoticeRequestProtocol = 'DYSON_CONTROL_PLAYER_NOTICE_REQUEST_V1' as const
export const playerNoticeReceiptProtocol = 'DYSON_CONTROL_PLAYER_NOTICE_RECEIPT_V1' as const
export const playerNoticeTemplateIds = [
  'maintenance-5m', 'maintenance-now', 'reconnect-required'
] as const
export type PlayerNoticeTemplateId = (typeof playerNoticeTemplateIds)[number]
export type PlayerNoticeReceiptState = 'transport-dispatched' | 'rejected' | 'failed' | 'uncertain'

const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const rosterGenerationPattern = /^roster-v1:[0-9a-f]{64}$/
const playerIdPattern = /^player-[0-9]{6,12}$/
const noncePattern = /^[A-Za-z0-9_-]{22,64}$/
const hmacPattern = /^[0-9a-f]{64}$/i
const errorCodePattern = /^(?:NONE|[A-Z][A-Z0-9_]{2,47})$/
const requestKeys = [
  'protocol', 'requestId', 'createdAtUnixMs', 'expiresAtUnixMs', 'action',
  'rosterSessionId', 'rosterSequence', 'sessionPlayerId', 'targetJoinedAtUnixMs',
  'templateId', 'nonce', 'hmac'
] as const
const receiptKeys = [
  'protocol', 'requestId', 'action', 'state', 'startedAtUnixMs', 'finishedAtUnixMs',
  'rosterSessionId', 'rosterSequence', 'sessionPlayerId', 'targetJoinedAtUnixMs',
  'templateId', 'mutationMayHaveOccurred', 'recoveryRequired', 'rollback', 'errorCode', 'hmac'
] as const

export const playerNoticePreviewRequestSchema = z.strictObject({
  rosterGeneration: z.string().regex(rosterGenerationPattern),
  rosterSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sessionPlayerId: z.string().regex(playerIdPattern),
  templateId: z.enum(playerNoticeTemplateIds)
})

export const playerNoticeExecutionRequestSchema = playerNoticePreviewRequestSchema.extend({
  requestId: z.string().regex(guidPattern).transform((value) => value.toLowerCase()),
  confirmation: z.literal('EXECUTE')
})

export type PlayerNoticePreviewRequest = z.infer<typeof playerNoticePreviewRequestSchema>
export type PlayerNoticeExecutionRequest = z.infer<typeof playerNoticeExecutionRequestSchema>

export interface PlayerNoticeReceipt {
  protocol: typeof playerNoticeReceiptProtocol
  requestId: string
  action: 'player.notice'
  state: PlayerNoticeReceiptState
  startedAtUnixMs: number
  finishedAtUnixMs: number
  rosterSessionId: string
  rosterSequence: number
  sessionPlayerId: string
  targetJoinedAtUnixMs: number
  templateId: PlayerNoticeTemplateId
  mutationMayHaveOccurred: boolean
  recoveryRequired: boolean
  rollback: 'not-possible'
  errorCode: string
  hmac: string
}

export interface PlayerNoticeWireRequest {
  protocol: typeof playerNoticeRequestProtocol
  requestId: string
  createdAtUnixMs: number
  expiresAtUnixMs: number
  action: 'player.notice'
  rosterSessionId: string
  rosterSequence: number
  sessionPlayerId: string
  targetJoinedAtUnixMs: number
  templateId: PlayerNoticeTemplateId
  nonce: string
  hmac: string
}

export interface PlayerNoticePlan {
  action: 'player.notice'
  mode: 'dry-run'
  allowed: boolean
  executionEnabled: boolean
  rosterGeneration: string
  rosterSequence: number
  sessionPlayerId: string
  targetJoinedAtUnixMs: number | null
  templateId: PlayerNoticeTemplateId
  checks: Array<{ id: string; status: 'pass' | 'block'; message: string }>
  blockers: string[]
  mutation: false
  rollback: { strategy: 'not-possible'; ready: false; summary: string }
}

export class PlayerNoticeError extends Error {
  readonly code: string
  readonly causeCode: string | null
  readonly requestPublished: boolean
  readonly mutationMayHaveOccurred: boolean
  readonly recoveryRequired: boolean

  constructor(code: string, evidence: {
    causeCode?: string
    requestPublished?: boolean
    mutationMayHaveOccurred?: boolean
    recoveryRequired?: boolean
  } = {}) {
    super(code)
    this.name = 'PlayerNoticeError'
    this.code = code
    this.causeCode = evidence.causeCode ?? null
    this.requestPublished = evidence.requestPublished ?? false
    this.mutationMayHaveOccurred = evidence.mutationMayHaveOccurred ?? false
    this.recoveryRequired = evidence.recoveryRequired ?? false
  }
}

export function previewPlayerNotice(
  input: PlayerNoticePreviewRequest,
  roster: PlayerSnapshot,
  capabilities: PlayerCapabilitySnapshot,
  executionEnabled: boolean
): PlayerNoticePlan {
  const notice = findPlayerCapability(capabilities, 'notice')
  const target = roster.players.find((player) => player.sessionPlayerId === input.sessionPlayerId)
  const checks: PlayerNoticePlan['checks'] = []
  const blockers: string[] = []
  const check = (id: string, pass: boolean, message: string, blocker: string) => {
    checks.push({ id, status: pass ? 'pass' : 'block', message })
    if (!pass) blockers.push(blocker)
  }
  check(
    'execution-gate', executionEnabled, executionEnabled ? '玩家通知执行开关已启用' : '玩家通知执行开关未启用',
    'execution-disabled'
  )
  check(
    'capability', capabilities.actionsEnabled && notice.availability === 'available',
    notice.availability === 'available' ? 'Bridge 声明支持定向系统通知' : 'Bridge 未声明通知能力',
    'capability-unavailable'
  )
  check(
    'session-generation', roster.state === 'active' && !roster.truncated &&
      roster.sessionId === capabilities.sessionId && publicRosterGeneration(roster.sessionId) === input.rosterGeneration,
    '签名玩家会话代次必须与预演请求一致', 'stale-roster-generation'
  )
  check(
    'roster-sequence', roster.sequence === input.rosterSequence,
    '当前签名名单序号必须与预演序号精确一致', 'stale-roster-sequence'
  )
  check(
    'target-session', target !== undefined && target.online,
    '目标必须仍属于当前在线会话', 'stale-player-session'
  )
  check(
    'fixed-template', playerNoticeTemplateIds.includes(input.templateId),
    '通知内容来自 Bridge 固定模板白名单', 'template-invalid'
  )

  return {
    action: 'player.notice',
    mode: 'dry-run',
    allowed: blockers.length === 0,
    executionEnabled,
    rosterGeneration: input.rosterGeneration,
    rosterSequence: input.rosterSequence,
    sessionPlayerId: input.sessionPlayerId,
    targetJoinedAtUnixMs: target?.joinedAtUnixMs ?? null,
    templateId: input.templateId,
    checks,
    blockers,
    mutation: false,
    rollback: {
      strategy: 'not-possible', ready: false,
      summary: '系统通知不可撤回；回执仅证明已交给目标连接的传输层，不证明客户端已显示。'
    }
  }
}

export function publicRosterGeneration(sessionId: string): string {
  const normalized = normalizeGuid(sessionId)
  const digest = createHash('sha256')
    .update('dyson-control-player-roster-generation-v1\n', 'utf8')
    .update(normalized, 'ascii')
    .digest('hex')
  return `roster-v1:${digest}`
}

export interface PlayerNoticeClient {
  execute(
    input: PlayerNoticeExecutionRequest & { rosterSessionId: string; targetJoinedAtUnixMs: number },
    signal?: AbortSignal
  ): Promise<PlayerNoticeReceipt>
  /**
   * Reads a signed terminal receipt by its public id. This method never creates a
   * request, retries a dispatch, or mutates any bridge-owned file.
   */
  readReceipt(requestId: string, signal?: AbortSignal): Promise<PlayerNoticeReceipt | null>
}

export class FilePlayerNoticeClient implements PlayerNoticeClient {
  readonly #controlRoot: string
  readonly #secretFile: string
  readonly #timeoutMs: number
  readonly #pollMs: number
  readonly #requestLifetimeMs: number

  constructor(options: {
    controlRoot: string
    secretFile: string
    timeoutMs?: number
    pollMs?: number
    requestLifetimeMs?: number
  }) {
    const controlRoot = path.resolve(options.controlRoot)
    if (!path.isAbsolute(options.controlRoot) || controlRoot === path.parse(controlRoot).root) {
      throw new PlayerNoticeError('PLAYER_NOTICE_ROOT_INVALID')
    }
    if (!path.isAbsolute(options.secretFile)) throw new PlayerNoticeError('PLAYER_NOTICE_SECRET_PATH_INVALID')
    this.#timeoutMs = options.timeoutMs ?? 20_000
    this.#pollMs = options.pollMs ?? 200
    this.#requestLifetimeMs = options.requestLifetimeMs ?? 15_000
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1_000 || this.#timeoutMs > 120_000 ||
        !Number.isInteger(this.#pollMs) || this.#pollMs < 25 || this.#pollMs > 2_000 ||
        !Number.isInteger(this.#requestLifetimeMs) || this.#requestLifetimeMs < 1_000 ||
        this.#requestLifetimeMs > 30_000) {
      throw new PlayerNoticeError('PLAYER_NOTICE_TIMING_INVALID')
    }
    this.#controlRoot = controlRoot
    this.#secretFile = path.resolve(options.secretFile)
  }

  async execute(
    input: PlayerNoticeExecutionRequest & { rosterSessionId: string; targetJoinedAtUnixMs: number },
    signal?: AbortSignal
  ): Promise<PlayerNoticeReceipt> {
    if (signal?.aborted) throw new PlayerNoticeError('PLAYER_NOTICE_REQUEST_ABORTED')
    const normalizedInput = {
      ...input,
      requestId: normalizeGuid(input.requestId),
      rosterSessionId: normalizeGuid(input.rosterSessionId)
    }
    const requestRoot = path.join(this.#controlRoot, 'player-notice-requests')
    const receiptRoot = path.join(this.#controlRoot, 'player-notice-receipts')
    await this.#assertDirectory(this.#controlRoot)
    await this.#assertDirectory(requestRoot)
    await this.#assertDirectory(receiptRoot)
    const secret = await this.#readSecret()
    const receiptPath = path.join(receiptRoot, `${normalizedInput.requestId}.receipt`)
    const existingReceipt = await this.#readReceiptFile(receiptPath, secret, normalizedInput.requestId)
    if (existingReceipt) {
      assertReceiptMatches(existingReceipt, normalizedInput)
      return existingReceipt
    }

    const built = buildPlayerNoticeRequest(normalizedInput, secret, Date.now(), this.#requestLifetimeMs)
    const requestPath = path.join(requestRoot, `${normalizedInput.requestId}.request`)
    const existingRequest = await this.#readPublishedRequest(normalizedInput.requestId, secret)
    if (existingRequest) {
      assertRequestMatches(existingRequest, normalizedInput)
    } else {
      const temporaryPath = path.join(requestRoot, `.partial-${normalizedInput.requestId}-${randomUUID()}`)
      try {
        await fs.writeFile(temporaryPath, built, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        await fs.rename(temporaryPath, requestPath)
      } catch {
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
        const competingRequest = await this.#readPublishedRequest(normalizedInput.requestId, secret)
        if (!competingRequest) throw new PlayerNoticeError('PLAYER_NOTICE_REQUEST_WRITE_FAILED')
        assertRequestMatches(competingRequest, normalizedInput)
      }
    }

    const started = performance.now()
    while (performance.now() - started < this.#timeoutMs) {
      if (signal?.aborted) throw outcomeUnknown('PLAYER_NOTICE_WAIT_ABORTED')
      const receipt = await this.#readReceiptFile(receiptPath, secret, normalizedInput.requestId)
      if (receipt) {
        assertReceiptMatches(receipt, normalizedInput)
        return receipt
      }
      try {
        await delay(this.#pollMs, signal)
      } catch (error) {
        if (error instanceof PlayerNoticeError && error.code === 'PLAYER_NOTICE_REQUEST_ABORTED') {
          throw outcomeUnknown('PLAYER_NOTICE_WAIT_ABORTED')
        }
        throw error
      }
    }
    throw outcomeUnknown('PLAYER_NOTICE_RECEIPT_TIMEOUT')
  }

  async readReceipt(requestId: string, signal?: AbortSignal): Promise<PlayerNoticeReceipt | null> {
    if (signal?.aborted) throw new PlayerNoticeError('PLAYER_NOTICE_REQUEST_ABORTED')
    const normalizedRequestId = normalizeGuid(requestId)
    const receiptRoot = path.join(this.#controlRoot, 'player-notice-receipts')
    await this.#assertDirectory(this.#controlRoot)
    await this.#assertDirectory(receiptRoot)
    const secret = await this.#readSecret()
    if (signal?.aborted) throw new PlayerNoticeError('PLAYER_NOTICE_REQUEST_ABORTED')
    return await this.#readReceiptFile(
      path.join(receiptRoot, `${normalizedRequestId}.receipt`),
      secret,
      normalizedRequestId
    )
  }

  async #readPublishedRequest(requestId: string, secret: string): Promise<PlayerNoticeWireRequest | null> {
    const requestDirectories = [
      'player-notice-requests',
      'player-notice-processing',
      'player-notice-processed',
      'player-notice-rejected'
    ]
    let found: PlayerNoticeWireRequest | null = null
    for (const directory of requestDirectories) {
      const candidate = await this.#readRequestFile(
        path.join(this.#controlRoot, directory, `${requestId}.request`), secret, requestId
      )
      if (!candidate) continue
      if (found) throw new PlayerNoticeError('PLAYER_NOTICE_REQUEST_DUPLICATED')
      found = candidate
    }
    return found
  }

  async #readRequestFile(
    filePath: string,
    secret: string,
    requestId: string
  ): Promise<PlayerNoticeWireRequest | null> {
    const payload = await this.#readBoundedOptionalFile(filePath, 'REQUEST')
    if (payload === null) return null
    const request = parsePlayerNoticeRequest(payload, secret)
    if (request.requestId !== requestId) throw new PlayerNoticeError('PLAYER_NOTICE_REQUEST_MISMATCH')
    return request
  }

  async #readReceiptFile(filePath: string, secret: string, requestId: string) {
    const payload = await this.#readBoundedOptionalFile(filePath, 'RECEIPT')
    if (payload === null) return null
    const receipt = parsePlayerNoticeReceipt(payload, secret)
    if (receipt.requestId !== requestId) throw new PlayerNoticeError('PLAYER_NOTICE_RECEIPT_MISMATCH')
    return receipt
  }

  async #readBoundedOptionalFile(filePath: string, label: 'REQUEST' | 'RECEIPT'): Promise<string | null> {
    let stats
    try { stats = await fs.lstat(filePath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new PlayerNoticeError(`PLAYER_NOTICE_${label}_READ_FAILED`)
    }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > 4_096) {
      throw new PlayerNoticeError(`PLAYER_NOTICE_${label}_INVALID`)
    }
    try {
      return await fs.readFile(filePath, 'utf8')
    } catch {
      throw new PlayerNoticeError(`PLAYER_NOTICE_${label}_READ_FAILED`)
    }
  }

  async #assertDirectory(directory: string) {
    let stats
    try { stats = await fs.lstat(directory) } catch { throw new PlayerNoticeError('PLAYER_NOTICE_DIRECTORY_UNAVAILABLE') }
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new PlayerNoticeError('PLAYER_NOTICE_DIRECTORY_INVALID')
  }

  async #readSecret() {
    let stats
    try { stats = await fs.lstat(this.#secretFile) } catch { throw new PlayerNoticeError('PLAYER_NOTICE_SECRET_UNAVAILABLE') }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 32 || stats.size > 1_024) {
      throw new PlayerNoticeError('PLAYER_NOTICE_SECRET_INVALID')
    }
    return validateBridgeSecret(await fs.readFile(this.#secretFile, 'utf8'))
  }
}

export function buildPlayerNoticeRequest(
  input: PlayerNoticeExecutionRequest & { rosterSessionId: string; targetJoinedAtUnixMs: number },
  secret: string,
  nowUnixMs = Date.now(),
  lifetimeMs = 15_000,
  nonce = randomBytes(18).toString('base64url')
): string {
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1_000 || lifetimeMs > 30_000) {
    throw new PlayerNoticeError('PLAYER_NOTICE_LIFETIME_INVALID')
  }
  const fields = {
    protocol: playerNoticeRequestProtocol,
    requestId: normalizeGuid(input.requestId),
    createdAtUnixMs: requirePositiveInteger(nowUnixMs),
    expiresAtUnixMs: requirePositiveInteger(nowUnixMs + lifetimeMs),
    action: 'player.notice',
    rosterSessionId: normalizeGuid(input.rosterSessionId),
    rosterSequence: requirePositiveInteger(input.rosterSequence),
    sessionPlayerId: requirePattern(input.sessionPlayerId, playerIdPattern, 'PLAYER_NOTICE_PLAYER_ID_INVALID'),
    targetJoinedAtUnixMs: requirePositiveInteger(input.targetJoinedAtUnixMs),
    templateId: requireTemplate(input.templateId),
    nonce: requirePattern(nonce, noncePattern, 'PLAYER_NOTICE_NONCE_INVALID'),
    hmac: ''
  }
  fields.hmac = sign(requestKeys, fields, validateBridgeSecret(secret))
  return serialize(requestKeys, fields)
}

export function parsePlayerNoticeRequest(payload: string, secret: string): PlayerNoticeWireRequest {
  const fields = parse(payload, requestKeys)
  const request: PlayerNoticeWireRequest = {
    protocol: requireLiteral(fields.protocol, playerNoticeRequestProtocol),
    requestId: normalizeGuid(fields.requestId),
    createdAtUnixMs: parsePositiveInteger(fields.createdAtUnixMs),
    expiresAtUnixMs: parsePositiveInteger(fields.expiresAtUnixMs),
    action: requireLiteral(fields.action, 'player.notice'),
    rosterSessionId: normalizeGuid(fields.rosterSessionId),
    rosterSequence: parsePositiveInteger(fields.rosterSequence),
    sessionPlayerId: requirePattern(fields.sessionPlayerId, playerIdPattern, 'PLAYER_NOTICE_PLAYER_ID_INVALID'),
    targetJoinedAtUnixMs: parsePositiveInteger(fields.targetJoinedAtUnixMs),
    templateId: requireTemplate(fields.templateId),
    nonce: requirePattern(fields.nonce, noncePattern, 'PLAYER_NOTICE_NONCE_INVALID'),
    hmac: requirePattern(fields.hmac, hmacPattern, 'PLAYER_NOTICE_HMAC_INVALID').toLowerCase()
  }
  if (request.expiresAtUnixMs <= request.createdAtUnixMs ||
      request.expiresAtUnixMs - request.createdAtUnixMs > 30_000) {
    throw new PlayerNoticeError('PLAYER_NOTICE_REQUEST_SEMANTICS_INVALID')
  }
  assertSignature(request.hmac, sign(requestKeys, request, validateBridgeSecret(secret)))
  return request
}

export function parsePlayerNoticeReceipt(payload: string, secret: string): PlayerNoticeReceipt {
  const fields = parse(payload, receiptKeys)
  const receipt: PlayerNoticeReceipt = {
    protocol: requireLiteral(fields.protocol, playerNoticeReceiptProtocol),
    requestId: normalizeGuid(fields.requestId),
    action: requireLiteral(fields.action, 'player.notice'),
    state: requireState(fields.state),
    startedAtUnixMs: parsePositiveInteger(fields.startedAtUnixMs),
    finishedAtUnixMs: parsePositiveInteger(fields.finishedAtUnixMs),
    rosterSessionId: normalizeGuid(fields.rosterSessionId),
    rosterSequence: parsePositiveInteger(fields.rosterSequence),
    sessionPlayerId: requirePattern(fields.sessionPlayerId, playerIdPattern, 'PLAYER_NOTICE_PLAYER_ID_INVALID'),
    targetJoinedAtUnixMs: parsePositiveInteger(fields.targetJoinedAtUnixMs),
    templateId: requireTemplate(fields.templateId),
    mutationMayHaveOccurred: parseBoolean(fields.mutationMayHaveOccurred),
    recoveryRequired: parseBoolean(fields.recoveryRequired),
    rollback: requireLiteral(fields.rollback, 'not-possible'),
    errorCode: requirePattern(fields.errorCode, errorCodePattern, 'PLAYER_NOTICE_ERROR_CODE_INVALID'),
    hmac: requirePattern(fields.hmac, hmacPattern, 'PLAYER_NOTICE_HMAC_INVALID').toLowerCase()
  }
  if (receipt.finishedAtUnixMs < receipt.startedAtUnixMs ||
      (receipt.state === 'transport-dispatched' &&
       (!receipt.mutationMayHaveOccurred || receipt.recoveryRequired || receipt.errorCode !== 'NONE')) ||
      (receipt.state === 'uncertain' &&
       (!receipt.mutationMayHaveOccurred || !receipt.recoveryRequired || receipt.errorCode === 'NONE')) ||
      ((receipt.state === 'failed' || receipt.state === 'rejected') &&
       (receipt.mutationMayHaveOccurred || receipt.recoveryRequired || receipt.errorCode === 'NONE'))) {
    throw new PlayerNoticeError('PLAYER_NOTICE_RECEIPT_SEMANTICS_INVALID')
  }
  assertSignature(receipt.hmac, sign(receiptKeys, receipt, validateBridgeSecret(secret)))
  return receipt
}

function sign(keys: readonly string[], value: object, secret: string) {
  const record = value as Record<string, unknown>
  const canonical = keys.slice(0, -1).map((key) => String(record[key])).join('\n')
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(canonical, 'utf8').digest('hex')
}

function serialize(keys: readonly string[], value: object) {
  const record = value as Record<string, unknown>
  return `${keys.map((key) => `${key}=${String(record[key])}`).join('\n')}\n`
}

function parse<const T extends readonly string[]>(payload: string, keys: T): Record<T[number], string> {
  if (typeof payload !== 'string' || payload.startsWith('\uFEFF') || payload.includes('\0') ||
      Buffer.byteLength(payload, 'utf8') > 4_096) throw new PlayerNoticeError('PLAYER_NOTICE_PAYLOAD_INVALID')
  const lines = payload.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  if (lines.length !== keys.length) throw new PlayerNoticeError('PLAYER_NOTICE_PAYLOAD_INVALID')
  const result: Record<string, string> = {}
  keys.forEach((key, index) => {
    const prefix = `${key}=`
    const line = lines[index]!
    if (!line.startsWith(prefix)) throw new PlayerNoticeError('PLAYER_NOTICE_PAYLOAD_INVALID')
    const value = line.slice(prefix.length)
    if (!value || /[\r\n\0\uFEFF]/.test(value)) throw new PlayerNoticeError('PLAYER_NOTICE_PAYLOAD_INVALID')
    result[key] = value
  })
  return result as Record<T[number], string>
}

function normalizeGuid(value: unknown) {
  return requirePattern(value, guidPattern, 'PLAYER_NOTICE_GUID_INVALID').toLowerCase()
}
function requirePositiveInteger(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new PlayerNoticeError('PLAYER_NOTICE_NUMBER_INVALID')
  }
  return value
}
function parsePositiveInteger(value: string) {
  if (!/^[1-9][0-9]*$/.test(value)) throw new PlayerNoticeError('PLAYER_NOTICE_NUMBER_INVALID')
  return requirePositiveInteger(Number(value))
}
function requirePattern(value: unknown, pattern: RegExp, code: string) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new PlayerNoticeError(code)
  return value
}
function requireLiteral<T extends string>(value: unknown, literal: T): T {
  if (value !== literal) throw new PlayerNoticeError('PLAYER_NOTICE_LITERAL_INVALID')
  return literal
}
function requireTemplate(value: unknown): PlayerNoticeTemplateId {
  if (typeof value !== 'string' || !playerNoticeTemplateIds.includes(value as PlayerNoticeTemplateId)) {
    throw new PlayerNoticeError('PLAYER_NOTICE_TEMPLATE_INVALID')
  }
  return value as PlayerNoticeTemplateId
}
function requireState(value: unknown): PlayerNoticeReceiptState {
  if (value !== 'transport-dispatched' && value !== 'rejected' && value !== 'failed' && value !== 'uncertain') {
    throw new PlayerNoticeError('PLAYER_NOTICE_STATE_INVALID')
  }
  return value
}
function parseBoolean(value: string) {
  if (value === 'true') return true
  if (value === 'false') return false
  throw new PlayerNoticeError('PLAYER_NOTICE_BOOLEAN_INVALID')
}
function assertSignature(actualHex: string, expectedHex: string) {
  const actual = Buffer.from(actualHex, 'hex')
  const expected = Buffer.from(expectedHex, 'hex')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new PlayerNoticeError('PLAYER_NOTICE_SIGNATURE_INVALID')
  }
}
function assertReceiptMatches(
  receipt: PlayerNoticeReceipt,
  input: PlayerNoticeExecutionRequest & { rosterSessionId: string; targetJoinedAtUnixMs: number }
) {
  if (receipt.rosterSessionId !== input.rosterSessionId ||
      receipt.rosterSequence !== input.rosterSequence ||
      receipt.sessionPlayerId !== input.sessionPlayerId ||
      receipt.targetJoinedAtUnixMs !== input.targetJoinedAtUnixMs ||
      receipt.templateId !== input.templateId) {
    throw new PlayerNoticeError('PLAYER_NOTICE_IDEMPOTENCY_CONFLICT')
  }
}
function assertRequestMatches(
  request: PlayerNoticeWireRequest,
  input: PlayerNoticeExecutionRequest & { rosterSessionId: string; targetJoinedAtUnixMs: number }
) {
  if (request.rosterSessionId !== input.rosterSessionId ||
      request.rosterSequence !== input.rosterSequence ||
      request.sessionPlayerId !== input.sessionPlayerId ||
      request.targetJoinedAtUnixMs !== input.targetJoinedAtUnixMs ||
      request.templateId !== input.templateId) {
    throw new PlayerNoticeError('PLAYER_NOTICE_IDEMPOTENCY_CONFLICT')
  }
}
function outcomeUnknown(causeCode: string) {
  return new PlayerNoticeError('PLAYER_NOTICE_OUTCOME_UNKNOWN', {
    causeCode,
    requestPublished: true,
    mutationMayHaveOccurred: true,
    recoveryRequired: true
  })
}
function delay(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new PlayerNoticeError('PLAYER_NOTICE_REQUEST_ABORTED')); return }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, milliseconds)
    const onAbort = () => { clearTimeout(timer); reject(new PlayerNoticeError('PLAYER_NOTICE_REQUEST_ABORTED')) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

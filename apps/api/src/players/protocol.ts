import { createHmac, timingSafeEqual } from 'node:crypto'

export const playerSnapshotProtocol = 'DYSON_CONTROL_PLAYERS_V1' as const
export const maximumSnapshotPlayers = 64
export const maximumPlayerSnapshotBytes = 32_768

export type PlayerSnapshotState = 'active' | 'inactive' | 'unavailable'

export interface PlayerSnapshotEntry {
  sessionPlayerId: string
  displayName: string
  online: true
  joinedAtUnixMs: number
  location: string
}

export interface PlayerSnapshot {
  protocol: typeof playerSnapshotProtocol
  sessionId: string
  writtenAtUnixMs: number
  sequence: number
  state: PlayerSnapshotState
  truncated: boolean
  playerCount: number
  players: PlayerSnapshotEntry[]
  hmac: string
}

export interface BuildPlayerSnapshotInput {
  sessionId: string
  writtenAtUnixMs: number
  sequence: number
  state: PlayerSnapshotState
  truncated: boolean
  players: PlayerSnapshotEntry[]
}

export class PlayerSnapshotError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'PlayerSnapshotError'
    this.code = code
  }
}

const wireKeys = [
  'protocol', 'sessionId', 'writtenAtUnixMs', 'sequence', 'state', 'truncated',
  'playerCount', 'playersJsonB64', 'hmac'
] as const
const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const sessionPlayerIdPattern = /^player-[0-9]{6,12}$/
const locationPattern = /^(?:deep-space|planet:[1-9][0-9]{0,9}|star:[1-9][0-9]{0,9})$/
const hmacPattern = /^[0-9a-f]{64}$/i
const base64UrlPattern = /^[A-Za-z0-9_-]{2,30000}$/
const playerKeys = ['sessionPlayerId', 'displayName', 'online', 'joinedAtUnixMs', 'location'] as const

export function buildPlayerSnapshot(
  input: BuildPlayerSnapshotInput,
  secret: string
): { snapshot: PlayerSnapshot; payload: string } {
  const normalizedSecret = validateSecret(secret)
  const sessionId = normalizeSessionId(input.sessionId)
  const writtenAtUnixMs = requireSafePositiveInteger(input.writtenAtUnixMs)
  const sequence = requireSafePositiveInteger(input.sequence)
  const state = requireState(input.state)
  const truncated = requireBoolean(input.truncated)
  const players = input.players.map((player) => validatePlayer(player, writtenAtUnixMs))
    .sort((left, right) => left.sessionPlayerId < right.sessionPlayerId ? -1 :
      left.sessionPlayerId > right.sessionPlayerId ? 1 : 0)
  validateSnapshotSemantics(state, truncated, players)
  assertStrictlyOrderedPlayerIds(players)

  const playersJson = canonicalizePlayers(players)
  const playersJsonB64 = Buffer.from(playersJson, 'utf8').toString('base64url')
  const fields = {
    protocol: playerSnapshotProtocol,
    sessionId,
    writtenAtUnixMs: String(writtenAtUnixMs),
    sequence: String(sequence),
    state,
    truncated: String(truncated),
    playerCount: String(players.length),
    playersJsonB64,
    hmac: ''
  }
  fields.hmac = signWireFields(fields, normalizedSecret)
  const snapshot: PlayerSnapshot = {
    protocol: playerSnapshotProtocol,
    sessionId,
    writtenAtUnixMs,
    sequence,
    state,
    truncated,
    playerCount: players.length,
    players,
    hmac: fields.hmac
  }
  return { snapshot, payload: serializeWire(fields) }
}

export function parsePlayerSnapshot(payload: string, secret: string): PlayerSnapshot {
  const fields = parseWire(payload)
  const normalizedSecret = validateSecret(secret)
  const sessionId = normalizeSessionId(fields.sessionId)
  const writtenAtUnixMs = parseSafePositiveInteger(fields.writtenAtUnixMs)
  const sequence = parseSafePositiveInteger(fields.sequence)
  const state = requireState(fields.state)
  const truncated = parseBoolean(fields.truncated)
  const playerCount = parseBoundedCount(fields.playerCount)
  const playersJsonB64 = requirePattern(fields.playersJsonB64, base64UrlPattern, 'PLAYER_SNAPSHOT_PLAYERS_INVALID')
  const hmac = requirePattern(fields.hmac, hmacPattern, 'PLAYER_SNAPSHOT_HMAC_INVALID').toLowerCase()
  if (Buffer.from(playersJsonB64, 'base64url').toString('base64url') !== playersJsonB64) {
    throw new PlayerSnapshotError('PLAYER_SNAPSHOT_PLAYERS_INVALID')
  }

  const expectedHmac = signWireFields({
    protocol: requireLiteral(fields.protocol, playerSnapshotProtocol),
    sessionId,
    writtenAtUnixMs: String(writtenAtUnixMs),
    sequence: String(sequence),
    state,
    truncated: String(truncated),
    playerCount: String(playerCount),
    playersJsonB64,
    hmac: ''
  }, normalizedSecret)
  assertSignature(hmac, expectedHmac)

  let decoded: unknown
  let playersJson: string
  try {
    playersJson = Buffer.from(playersJsonB64, 'base64url').toString('utf8')
    decoded = JSON.parse(playersJson)
  } catch {
    throw new PlayerSnapshotError('PLAYER_SNAPSHOT_PLAYERS_INVALID')
  }
  if (!Array.isArray(decoded) || decoded.length !== playerCount || decoded.length > maximumSnapshotPlayers) {
    throw new PlayerSnapshotError('PLAYER_SNAPSHOT_PLAYERS_INVALID')
  }
  const players = decoded.map((player) => validateUnknownPlayer(player, writtenAtUnixMs))
  assertStrictlyOrderedPlayerIds(players)
  if (canonicalizePlayers(players) !== playersJson) {
    throw new PlayerSnapshotError('PLAYER_SNAPSHOT_PLAYERS_NONCANONICAL')
  }
  validateSnapshotSemantics(state, truncated, players)

  return {
    protocol: playerSnapshotProtocol,
    sessionId,
    writtenAtUnixMs,
    sequence,
    state,
    truncated,
    playerCount,
    players,
    hmac
  }
}

function validateUnknownPlayer(value: unknown, writtenAtUnixMs: number): PlayerSnapshotEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PlayerSnapshotError('PLAYER_SNAPSHOT_PLAYER_INVALID')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== playerKeys.length || playerKeys.some((key, index) => keys[index] !== key)) {
    throw new PlayerSnapshotError('PLAYER_SNAPSHOT_PLAYER_INVALID')
  }
  return validatePlayer({
    sessionPlayerId: record.sessionPlayerId,
    displayName: record.displayName,
    online: record.online,
    joinedAtUnixMs: record.joinedAtUnixMs,
    location: record.location
  }, writtenAtUnixMs)
}

function validatePlayer(value: {
  sessionPlayerId: unknown
  displayName: unknown
  online: unknown
  joinedAtUnixMs: unknown
  location: unknown
}, writtenAtUnixMs: number): PlayerSnapshotEntry {
  const sessionPlayerId = requireStringPattern(
    value.sessionPlayerId, sessionPlayerIdPattern, 'PLAYER_SNAPSHOT_PLAYER_ID_INVALID'
  )
  const displayName = requireDisplayName(value.displayName)
  if (value.online !== true) throw new PlayerSnapshotError('PLAYER_SNAPSHOT_ONLINE_INVALID')
  const joinedAtUnixMs = requireSafePositiveInteger(value.joinedAtUnixMs)
  if (joinedAtUnixMs > writtenAtUnixMs + 5_000) throw new PlayerSnapshotError('PLAYER_SNAPSHOT_TIME_INVALID')
  const location = requireStringPattern(value.location, locationPattern, 'PLAYER_SNAPSHOT_LOCATION_INVALID')
  return { sessionPlayerId, displayName, online: true, joinedAtUnixMs, location }
}

function requireDisplayName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 ||
      [...value].length > 64 || Buffer.byteLength(value, 'utf8') > 128 || /[\0\r\n]/.test(value)) {
    throw new PlayerSnapshotError('PLAYER_SNAPSHOT_DISPLAY_NAME_INVALID')
  }
  return value
}

function validateSnapshotSemantics(
  state: PlayerSnapshotState,
  truncated: boolean,
  players: PlayerSnapshotEntry[]
): void {
  if (players.length > maximumSnapshotPlayers || (state !== 'active' && (players.length !== 0 || truncated))) {
    throw new PlayerSnapshotError('PLAYER_SNAPSHOT_STATE_INVALID')
  }
}

function assertStrictlyOrderedPlayerIds(players: PlayerSnapshotEntry[]): void {
  for (let index = 1; index < players.length; index++) {
    if (players[index - 1]!.sessionPlayerId >= players[index]!.sessionPlayerId) {
      throw new PlayerSnapshotError('PLAYER_SNAPSHOT_PLAYER_ORDER_INVALID')
    }
  }
}

function canonicalizePlayers(players: PlayerSnapshotEntry[]): string {
  return JSON.stringify(players.map((player) => ({
    sessionPlayerId: player.sessionPlayerId,
    displayName: player.displayName,
    online: true,
    joinedAtUnixMs: player.joinedAtUnixMs,
    location: player.location
  })))
}

function signWireFields(fields: Record<(typeof wireKeys)[number], string>, secret: string): string {
  const canonical = [
    playerSnapshotProtocol,
    fields.sessionId,
    fields.writtenAtUnixMs,
    fields.sequence,
    fields.state,
    fields.truncated,
    fields.playerCount,
    fields.playersJsonB64
  ].join('\n')
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(canonical, 'utf8').digest('hex')
}

function assertSignature(actualHex: string, expectedHex: string): void {
  const actual = Buffer.from(actualHex, 'hex')
  const expected = Buffer.from(expectedHex, 'hex')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new PlayerSnapshotError('PLAYER_SNAPSHOT_SIGNATURE_INVALID')
  }
}

function parseWire(payload: string): Record<(typeof wireKeys)[number], string> {
  if (Buffer.byteLength(payload, 'utf8') > maximumPlayerSnapshotBytes || payload.includes('\0')) {
    throw new PlayerSnapshotError('PLAYER_SNAPSHOT_PAYLOAD_INVALID')
  }
  const lines = payload.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  if (lines.length !== wireKeys.length) throw new PlayerSnapshotError('PLAYER_SNAPSHOT_PAYLOAD_INVALID')
  const fields = {} as Record<(typeof wireKeys)[number], string>
  wireKeys.forEach((key, index) => {
    const prefix = `${key}=`
    const line = lines[index]!
    if (!line.startsWith(prefix)) throw new PlayerSnapshotError('PLAYER_SNAPSHOT_PAYLOAD_INVALID')
    const value = line.slice(prefix.length)
    if (value.length === 0 || /[\0\r\n]/.test(value)) {
      throw new PlayerSnapshotError('PLAYER_SNAPSHOT_PAYLOAD_INVALID')
    }
    fields[key] = value
  })
  return fields
}

function serializeWire(fields: Record<(typeof wireKeys)[number], string>): string {
  return `${wireKeys.map((key) => `${key}=${fields[key]}`).join('\n')}\n`
}

function validateSecret(value: string): string {
  const normalized = value.trim()
  if (normalized.length < 32 || normalized.length > 512 || /[\0\r\n]/.test(normalized)) {
    throw new PlayerSnapshotError('PLAYER_SNAPSHOT_SECRET_INVALID')
  }
  return normalized
}

function normalizeSessionId(value: unknown): string {
  if (typeof value !== 'string' || !guidPattern.test(value)) {
    throw new PlayerSnapshotError('PLAYER_SNAPSHOT_SESSION_ID_INVALID')
  }
  return value.toLowerCase()
}

function parseSafePositiveInteger(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new PlayerSnapshotError('PLAYER_SNAPSHOT_NUMBER_INVALID')
  return requireSafePositiveInteger(Number(value))
}

function requireSafePositiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new PlayerSnapshotError('PLAYER_SNAPSHOT_NUMBER_INVALID')
  }
  return value
}

function parseBoundedCount(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new PlayerSnapshotError('PLAYER_SNAPSHOT_COUNT_INVALID')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumSnapshotPlayers) {
    throw new PlayerSnapshotError('PLAYER_SNAPSHOT_COUNT_INVALID')
  }
  return parsed
}

function parseBoolean(value: string): boolean {
  if (value === 'true') return true
  if (value === 'false') return false
  throw new PlayerSnapshotError('PLAYER_SNAPSHOT_BOOLEAN_INVALID')
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new PlayerSnapshotError('PLAYER_SNAPSHOT_BOOLEAN_INVALID')
  return value
}

function requireState(value: unknown): PlayerSnapshotState {
  if (value !== 'active' && value !== 'inactive' && value !== 'unavailable') {
    throw new PlayerSnapshotError('PLAYER_SNAPSHOT_STATE_INVALID')
  }
  return value
}

function requireLiteral<T extends string>(value: string, literal: T): T {
  if (value !== literal) throw new PlayerSnapshotError('PLAYER_SNAPSHOT_PROTOCOL_INVALID')
  return literal
}

function requirePattern(value: string, pattern: RegExp, code: string): string {
  if (!pattern.test(value)) throw new PlayerSnapshotError(code)
  return value
}

function requireStringPattern(value: unknown, pattern: RegExp, code: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new PlayerSnapshotError(code)
  return value
}

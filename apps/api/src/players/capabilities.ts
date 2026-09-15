import { createHmac, timingSafeEqual } from 'node:crypto'

export const playerCapabilityProtocol = 'DYSON_CONTROL_PLAYER_CAPABILITIES_V1' as const
export const maximumPlayerCapabilityBytes = 8_192
export const verifiedNebulaRepository = 'NebulaModTeam/nebula' as const
export const verifiedNebulaTag = 'v0.9.22' as const
// The official v0.9.22 release asset's NebulaPatcher.dll uses this four-part file version.
export const verifiedNebulaRuntimeFileVersion = '0.9.22.2' as const
export const verifiedNebulaCommit = '3cdf95c594a2f8010b0e87a43be828e6ba2f657f' as const
export const playerCapabilityVerificationScope = 'source-contract-only-runtime-unverified' as const
export const playerCapabilityRuntimeVerifiedScope = 'runtime-assembly-identity-verified' as const
export type PlayerCapabilityVerificationScope =
  | typeof playerCapabilityVerificationScope
  | typeof playerCapabilityRuntimeVerifiedScope

export type PlayerCapabilityId =
  | 'observe-roster'
  | 'disconnect'
  | 'kick'
  | 'ban'
  | 'whitelist'
  | 'blacklist'
  | 'notice'
  | 'permission'

export type PlayerCapabilityAvailability = 'available' | 'unavailable'
export type PlayerCapabilityMode = 'read-only' | 'mutation'
export type PlayerCapabilityReasonCode =
  | 'UPSTREAM_ROSTER_API_VERIFIED'
  | 'UPSTREAM_CONNECTED_DISCONNECT_UNSAFE'
  | 'UPSTREAM_KICK_API_ABSENT'
  | 'UPSTREAM_BAN_API_ABSENT'
  | 'UPSTREAM_WHITELIST_API_ABSENT'
  | 'UPSTREAM_BLACKLIST_API_ABSENT'
  | 'UPSTREAM_TARGETED_NOTICE_PRIMITIVES_VERIFIED'
  | 'NEBULA_NOTICE_RUNTIME_UNVERIFIED'
  | 'UPSTREAM_PERMISSION_API_ABSENT'

export interface PlayerCapability {
  capability: PlayerCapabilityId
  availability: PlayerCapabilityAvailability
  mode: PlayerCapabilityMode
  verifiedReasonCode: PlayerCapabilityReasonCode
}

export interface PlayerCapabilitySnapshot {
  protocol: typeof playerCapabilityProtocol
  verifiedUpstreamRepository: typeof verifiedNebulaRepository
  verifiedUpstreamTag: typeof verifiedNebulaTag
  verifiedRuntimeFileVersion: typeof verifiedNebulaRuntimeFileVersion
  verifiedUpstreamCommit: typeof verifiedNebulaCommit
  verificationScope: PlayerCapabilityVerificationScope
  sessionId: string
  writtenAtUnixMs: number
  actionsEnabled: boolean
  capabilities: PlayerCapability[]
  hmac: string
}

export const verifiedPlayerCapabilities: readonly PlayerCapability[] = Object.freeze([
  Object.freeze({
    capability: 'observe-roster',
    availability: 'available',
    mode: 'read-only',
    verifiedReasonCode: 'UPSTREAM_ROSTER_API_VERIFIED'
  }),
  Object.freeze({
    capability: 'disconnect',
    availability: 'unavailable',
    mode: 'mutation',
    verifiedReasonCode: 'UPSTREAM_CONNECTED_DISCONNECT_UNSAFE'
  }),
  Object.freeze({
    capability: 'kick',
    availability: 'unavailable',
    mode: 'mutation',
    verifiedReasonCode: 'UPSTREAM_KICK_API_ABSENT'
  }),
  Object.freeze({
    capability: 'ban',
    availability: 'unavailable',
    mode: 'mutation',
    verifiedReasonCode: 'UPSTREAM_BAN_API_ABSENT'
  }),
  Object.freeze({
    capability: 'whitelist',
    availability: 'unavailable',
    mode: 'mutation',
    verifiedReasonCode: 'UPSTREAM_WHITELIST_API_ABSENT'
  }),
  Object.freeze({
    capability: 'blacklist',
    availability: 'unavailable',
    mode: 'mutation',
    verifiedReasonCode: 'UPSTREAM_BLACKLIST_API_ABSENT'
  }),
  Object.freeze({
    capability: 'notice',
    availability: 'available',
    mode: 'mutation',
    verifiedReasonCode: 'UPSTREAM_TARGETED_NOTICE_PRIMITIVES_VERIFIED'
  }),
  Object.freeze({
    capability: 'permission',
    availability: 'unavailable',
    mode: 'mutation',
    verifiedReasonCode: 'UPSTREAM_PERMISSION_API_ABSENT'
  })
])

export const unverifiedPlayerCapabilities: readonly PlayerCapability[] = Object.freeze(
  verifiedPlayerCapabilities.map((entry) => Object.freeze(entry.capability === 'notice'
    ? {
        ...entry,
        availability: 'unavailable' as const,
        verifiedReasonCode: 'NEBULA_NOTICE_RUNTIME_UNVERIFIED' as const
      }
    : { ...entry }))
)

export const playerCapabilityReasonSummaries: Readonly<Record<PlayerCapabilityReasonCode, string>> =
  Object.freeze({
    UPSTREAM_ROSTER_API_VERIFIED:
      'Nebula v0.9.22 exposes a public server roster and post-sync join/leave events.',
    UPSTREAM_CONNECTED_DISCONNECT_UNSAFE:
      'Nebula v0.9.22 removes the player before socket-close cleanup; connected-player use is not verified safe.',
    UPSTREAM_KICK_API_ABSENT:
      'Nebula v0.9.22 exposes no dedicated connected-player kick operation or kick reason.',
    UPSTREAM_BAN_API_ABSENT:
      'Nebula v0.9.22 exposes no player-ban operation or persistence contract.',
    UPSTREAM_WHITELIST_API_ABSENT:
      'Nebula v0.9.22 exposes no player-whitelist operation or configuration contract.',
    UPSTREAM_BLACKLIST_API_ABSENT:
      'Nebula v0.9.22 exposes no player-blacklist operation or persistence contract.',
    UPSTREAM_TARGETED_NOTICE_PRIMITIVES_VERIFIED:
      'Nebula v0.9.22 exposes targeted packet dispatch and a system-message packet; delivery acknowledgement is unavailable.',
    NEBULA_NOTICE_RUNTIME_UNVERIFIED:
      'The running Nebula assembly identity has not matched the pinned v0.9.22 artifact; player notice remains disabled.',
    UPSTREAM_PERMISSION_API_ABSENT:
      'Nebula v0.9.22 exposes no per-player permission or role operation.'
  })

export class PlayerCapabilityError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'PlayerCapabilityError'
    this.code = code
  }
}

const wireKeys = [
  'protocol',
  'verifiedUpstreamRepository',
  'verifiedUpstreamTag',
  'verifiedRuntimeFileVersion',
  'verifiedUpstreamCommit',
  'verificationScope',
  'sessionId',
  'writtenAtUnixMs',
  'actionsEnabled',
  'capabilitiesJsonB64',
  'hmac'
] as const
const capabilityKeys = [
  'capability', 'availability', 'mode', 'verifiedReasonCode'
] as const
const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const hmacPattern = /^[0-9a-f]{64}$/i
const base64UrlPattern = /^[A-Za-z0-9_-]{2,7000}$/

type WireFields = Record<(typeof wireKeys)[number], string>

export function buildPlayerCapabilitySnapshot(
  input: { sessionId: string; writtenAtUnixMs: number; runtimeVerified: boolean },
  secret: string
): { snapshot: PlayerCapabilitySnapshot; payload: string } {
  const normalizedSecret = validateSecret(secret)
  const sessionId = normalizeSessionId(input.sessionId)
  const writtenAtUnixMs = requireSafePositiveInteger(input.writtenAtUnixMs)
  const runtimeVerified = input.runtimeVerified === true
  const capabilities = cloneCapabilities(runtimeVerified)
  const verificationScope = runtimeVerified
    ? playerCapabilityRuntimeVerifiedScope
    : playerCapabilityVerificationScope
  const capabilitiesJsonB64 = Buffer.from(canonicalizeCapabilities(capabilities), 'utf8').toString('base64url')
  const fields: WireFields = {
    protocol: playerCapabilityProtocol,
    verifiedUpstreamRepository: verifiedNebulaRepository,
    verifiedUpstreamTag: verifiedNebulaTag,
    verifiedRuntimeFileVersion: verifiedNebulaRuntimeFileVersion,
    verifiedUpstreamCommit: verifiedNebulaCommit,
    verificationScope,
    sessionId,
    writtenAtUnixMs: String(writtenAtUnixMs),
    actionsEnabled: String(runtimeVerified),
    capabilitiesJsonB64,
    hmac: ''
  }
  fields.hmac = signWireFields(fields, normalizedSecret)
  return {
    snapshot: {
      protocol: playerCapabilityProtocol,
      verifiedUpstreamRepository: verifiedNebulaRepository,
      verifiedUpstreamTag: verifiedNebulaTag,
      verifiedRuntimeFileVersion: verifiedNebulaRuntimeFileVersion,
      verifiedUpstreamCommit: verifiedNebulaCommit,
      verificationScope,
      sessionId,
      writtenAtUnixMs,
      actionsEnabled: runtimeVerified,
      capabilities,
      hmac: fields.hmac
    },
    payload: serializeWire(fields)
  }
}

export function parsePlayerCapabilitySnapshot(payload: string, secret: string): PlayerCapabilitySnapshot {
  const fields = parseWire(payload)
  const normalizedSecret = validateSecret(secret)
  requireLiteral(fields.protocol, playerCapabilityProtocol, 'PLAYER_CAPABILITY_PROTOCOL_INVALID')
  requireLiteral(
    fields.verifiedUpstreamRepository,
    verifiedNebulaRepository,
    'PLAYER_CAPABILITY_UPSTREAM_INVALID'
  )
  requireLiteral(fields.verifiedUpstreamTag, verifiedNebulaTag, 'PLAYER_CAPABILITY_UPSTREAM_INVALID')
  requireLiteral(
    fields.verifiedRuntimeFileVersion,
    verifiedNebulaRuntimeFileVersion,
    'PLAYER_CAPABILITY_UPSTREAM_INVALID'
  )
  requireLiteral(fields.verifiedUpstreamCommit, verifiedNebulaCommit, 'PLAYER_CAPABILITY_UPSTREAM_INVALID')
  const actionsEnabled = parseActionsEnabled(fields.actionsEnabled)
  const verificationScope = actionsEnabled
    ? requireLiteral(
        fields.verificationScope,
        playerCapabilityRuntimeVerifiedScope,
        'PLAYER_CAPABILITY_SCOPE_INVALID'
      )
    : requireLiteral(
        fields.verificationScope,
        playerCapabilityVerificationScope,
        'PLAYER_CAPABILITY_SCOPE_INVALID'
      )
  const sessionId = normalizeSessionId(fields.sessionId)
  const writtenAtUnixMs = parseSafePositiveInteger(fields.writtenAtUnixMs)
  const capabilitiesJsonB64 = requirePattern(
    fields.capabilitiesJsonB64,
    base64UrlPattern,
    'PLAYER_CAPABILITY_LIST_INVALID'
  )
  const hmac = requirePattern(fields.hmac, hmacPattern, 'PLAYER_CAPABILITY_HMAC_INVALID').toLowerCase()

  if (Buffer.from(capabilitiesJsonB64, 'base64url').toString('base64url') !== capabilitiesJsonB64) {
    throw new PlayerCapabilityError('PLAYER_CAPABILITY_LIST_INVALID')
  }
  const expectedHmac = signWireFields({ ...fields, hmac: '' }, normalizedSecret)
  assertSignature(hmac, expectedHmac)

  let decoded: unknown
  let capabilitiesJson: string
  try {
    capabilitiesJson = Buffer.from(capabilitiesJsonB64, 'base64url').toString('utf8')
    decoded = JSON.parse(capabilitiesJson)
  } catch {
    throw new PlayerCapabilityError('PLAYER_CAPABILITY_LIST_INVALID')
  }
  const capabilities = validateCapabilityList(decoded, actionsEnabled)
  if (canonicalizeCapabilities(capabilities) !== capabilitiesJson) {
    throw new PlayerCapabilityError('PLAYER_CAPABILITY_LIST_NONCANONICAL')
  }

  return {
    protocol: playerCapabilityProtocol,
    verifiedUpstreamRepository: verifiedNebulaRepository,
    verifiedUpstreamTag: verifiedNebulaTag,
    verifiedRuntimeFileVersion: verifiedNebulaRuntimeFileVersion,
    verifiedUpstreamCommit: verifiedNebulaCommit,
    verificationScope,
    sessionId,
    writtenAtUnixMs,
    actionsEnabled,
    capabilities,
    hmac
  }
}

export function findPlayerCapability(
  snapshot: PlayerCapabilitySnapshot,
  capability: PlayerCapabilityId
): PlayerCapability {
  const found = snapshot.capabilities.find((entry) => entry.capability === capability)
  if (!found) throw new PlayerCapabilityError('PLAYER_CAPABILITY_NOT_DECLARED')
  return { ...found }
}

function validateCapabilityList(value: unknown, runtimeVerified: boolean): PlayerCapability[] {
  if (!Array.isArray(value) || value.length !== verifiedPlayerCapabilities.length) {
    throw new PlayerCapabilityError('PLAYER_CAPABILITY_LIST_INVALID')
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new PlayerCapabilityError('PLAYER_CAPABILITY_LIST_INVALID')
    }
    const record = entry as Record<string, unknown>
    const keys = Object.keys(record)
    if (keys.length !== capabilityKeys.length || capabilityKeys.some((key, keyIndex) => keys[keyIndex] !== key)) {
      throw new PlayerCapabilityError('PLAYER_CAPABILITY_LIST_INVALID')
    }
    const expected = (runtimeVerified ? verifiedPlayerCapabilities : unverifiedPlayerCapabilities)[index]!
    if (record.capability !== expected.capability || record.availability !== expected.availability ||
        record.mode !== expected.mode || record.verifiedReasonCode !== expected.verifiedReasonCode) {
      throw new PlayerCapabilityError('PLAYER_CAPABILITY_DECLARATION_INVALID')
    }
    return { ...expected }
  })
}

function canonicalizeCapabilities(capabilities: readonly PlayerCapability[]): string {
  return JSON.stringify(capabilities.map((entry) => ({
    capability: entry.capability,
    availability: entry.availability,
    mode: entry.mode,
    verifiedReasonCode: entry.verifiedReasonCode
  })))
}

function cloneCapabilities(runtimeVerified: boolean): PlayerCapability[] {
  return (runtimeVerified ? verifiedPlayerCapabilities : unverifiedPlayerCapabilities)
    .map((entry) => ({ ...entry }))
}

function signWireFields(fields: WireFields, secret: string): string {
  const canonical = wireKeys.slice(0, -1).map((key) => fields[key]).join('\n')
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(canonical, 'utf8').digest('hex')
}

function assertSignature(actualHex: string, expectedHex: string): void {
  const actual = Buffer.from(actualHex, 'hex')
  const expected = Buffer.from(expectedHex, 'hex')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new PlayerCapabilityError('PLAYER_CAPABILITY_SIGNATURE_INVALID')
  }
}

function parseWire(payload: string): WireFields {
  if (typeof payload !== 'string' || Buffer.byteLength(payload, 'utf8') > maximumPlayerCapabilityBytes ||
      payload.includes('\0')) {
    throw new PlayerCapabilityError('PLAYER_CAPABILITY_PAYLOAD_INVALID')
  }
  const lines = payload.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  if (lines.length !== wireKeys.length) throw new PlayerCapabilityError('PLAYER_CAPABILITY_PAYLOAD_INVALID')
  const fields = {} as WireFields
  wireKeys.forEach((key, index) => {
    const prefix = `${key}=`
    const line = lines[index]!
    if (!line.startsWith(prefix)) throw new PlayerCapabilityError('PLAYER_CAPABILITY_PAYLOAD_INVALID')
    const value = line.slice(prefix.length)
    if (value.length === 0 || /[\0\r\n]/.test(value)) {
      throw new PlayerCapabilityError('PLAYER_CAPABILITY_PAYLOAD_INVALID')
    }
    fields[key] = value
  })
  return fields
}

function serializeWire(fields: WireFields): string {
  return `${wireKeys.map((key) => `${key}=${fields[key]}`).join('\n')}\n`
}

function validateSecret(value: string): string {
  if (typeof value !== 'string') throw new PlayerCapabilityError('PLAYER_CAPABILITY_SECRET_INVALID')
  const normalized = value.trim()
  if (normalized.length < 32 || normalized.length > 512 || /[\0\r\n]/.test(normalized)) {
    throw new PlayerCapabilityError('PLAYER_CAPABILITY_SECRET_INVALID')
  }
  return normalized
}

function normalizeSessionId(value: unknown): string {
  if (typeof value !== 'string' || !guidPattern.test(value)) {
    throw new PlayerCapabilityError('PLAYER_CAPABILITY_SESSION_ID_INVALID')
  }
  return value.toLowerCase()
}

function parseSafePositiveInteger(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new PlayerCapabilityError('PLAYER_CAPABILITY_NUMBER_INVALID')
  return requireSafePositiveInteger(Number(value))
}

function requireSafePositiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new PlayerCapabilityError('PLAYER_CAPABILITY_NUMBER_INVALID')
  }
  return value
}

function requireLiteral<T extends string>(value: string, literal: T, code: string): T {
  if (value !== literal) throw new PlayerCapabilityError(code)
  return literal
}

function requirePattern(value: string, pattern: RegExp, code: string): string {
  if (!pattern.test(value)) throw new PlayerCapabilityError(code)
  return value
}

function parseActionsEnabled(value: string): boolean {
  if (value === 'true') return true
  if (value === 'false') return false
  throw new PlayerCapabilityError('PLAYER_CAPABILITY_ACTIONS_INVALID')
}

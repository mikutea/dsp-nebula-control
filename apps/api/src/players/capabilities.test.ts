import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildPlayerCapabilitySnapshot,
  findPlayerCapability,
  parsePlayerCapabilitySnapshot,
  playerCapabilityReasonSummaries,
  verifiedNebulaCommit,
  verifiedNebulaTag
} from './capabilities.js'

const secret = 'fictional-cross-runtime-secret-0123456789'
const malformedCapabilitiesJsonB64 =
  'W3siY2FwYWJpbGl0eSI6Im9ic2VydmUtcm9zdGVyIiwiYXZhaWxhYmlsaXR5IjoiYXZhaWxhYmxlIiwibW9kZSI6InJlYWQtb25seSIsInZlcmlmaWVkUmVhc29uQ29kZSI6IlVQU1RSRUFNX1JPU1RFUl9BUElfVkVSSUZJRUQifSx7ImNhcGFiaWxpdHkiOiJkaXNjb25uZWN0IiwiYXZhaWxhYmlsaXR5IjoidW5hdmFpbGFibGUiLCJtb2RlIjoibXV0YXRpb24iLCJ2ZXJpZmllZFJlYXNvbkNvZGUiOiJVUFNUUkVBTV9DT05ORUNURURfRElTQ09OTkVDVF9VTlNBRkUifSx7ImNhcGFiaWxpdHkiOiJraWNrIiwiYXZhaWxhYmlsaXR5IjoidW5hdmFpbGFibGUiLCJtb2RlIjoibXV0YXRpb24iLCJ2ZXJpZmllZFJlYXNvbkNvZGUiOiJVUFNUUkVBTV9LSUNLX0FQSV9BQlNFTlQifSx7ImNhcGFiaWxpdHkiOiJiYW4iLCJhdmFpbGFiaWxpdHkiOiJ1bmF2YWlsYWJsZSIsIm1vZGUiOiJtdXRhdGlvbiIsInZlcmlmaWVkUmVhc29uQ29kZSI6IlVQU1RSRUFNX0JBTl9BUElfQUJTRU5UIn0seyJjYXBhYmlsaXR5Ijoid2hpdGVsaXN0IiwiYXZhaWxhYmlsaXR5IjoidW5hdmFpbGFibGUiLCJtb2RlIjoibXV0YXRpb24iLCJ2ZXJpZmllZFJlYXNvbkNvZGUiOiJVUFNUUkVBTV9XSElURUxJU1RfQVBJX0FCU0VOVCJ9LHsiY2FwYWJpbGl0eSI6InBlcm1pc3Npb24iLCJhdmFpbGFiaWxhYmlsaXR5IjoidW5hdmFpbGFibGUiLCJtb2RlIjoibXV0YXRpb24iLCJ2ZXJpZmllZFJlYXNvbkNvZGUiOiJVUFNUUkVBTV9QRVJNSVNTSU9OX0FQSV9BQlNFTlQifV0'
const verifiedCapabilitiesJson = [
  '{"capability":"observe-roster","availability":"available","mode":"read-only","verifiedReasonCode":"UPSTREAM_ROSTER_API_VERIFIED"}',
  '{"capability":"disconnect","availability":"unavailable","mode":"mutation","verifiedReasonCode":"UPSTREAM_CONNECTED_DISCONNECT_UNSAFE"}',
  '{"capability":"kick","availability":"unavailable","mode":"mutation","verifiedReasonCode":"UPSTREAM_KICK_API_ABSENT"}',
  '{"capability":"ban","availability":"unavailable","mode":"mutation","verifiedReasonCode":"UPSTREAM_BAN_API_ABSENT"}',
  '{"capability":"whitelist","availability":"unavailable","mode":"mutation","verifiedReasonCode":"UPSTREAM_WHITELIST_API_ABSENT"}',
  '{"capability":"blacklist","availability":"unavailable","mode":"mutation","verifiedReasonCode":"UPSTREAM_BLACKLIST_API_ABSENT"}',
  '{"capability":"notice","availability":"available","mode":"mutation","verifiedReasonCode":"UPSTREAM_TARGETED_NOTICE_PRIMITIVES_VERIFIED"}',
  '{"capability":"permission","availability":"unavailable","mode":"mutation","verifiedReasonCode":"UPSTREAM_PERMISSION_API_ABSENT"}'
].join(',')
const verifiedCapabilitiesJsonB64 = Buffer.from(`[${verifiedCapabilitiesJson}]`, 'utf8').toString('base64url')
const unverifiedCapabilitiesJson = verifiedCapabilitiesJson.replace(
  '{"capability":"notice","availability":"available","mode":"mutation","verifiedReasonCode":"UPSTREAM_TARGETED_NOTICE_PRIMITIVES_VERIFIED"}',
  '{"capability":"notice","availability":"unavailable","mode":"mutation","verifiedReasonCode":"NEBULA_NOTICE_RUNTIME_UNVERIFIED"}'
)
const unverifiedCapabilitiesJsonB64 = Buffer.from(`[${unverifiedCapabilitiesJson}]`, 'utf8').toString('base64url')
const canonicalVerifiedPayload = [
  'protocol=DYSON_CONTROL_PLAYER_CAPABILITIES_V1',
  'verifiedUpstreamRepository=NebulaModTeam/nebula',
  'verifiedUpstreamTag=v0.9.22',
  'verifiedRuntimeFileVersion=0.9.22.2',
  'verifiedUpstreamCommit=3cdf95c594a2f8010b0e87a43be828e6ba2f657f',
  'verificationScope=runtime-assembly-identity-verified',
  'sessionId=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  'writtenAtUnixMs=1788081004000',
  'actionsEnabled=true',
  `capabilitiesJsonB64=${verifiedCapabilitiesJsonB64}`,
  'hmac=df6871264f343d4b6ffb40c0d1a2bc3e0a7f47bac263f96a87bcd6e9d6993934',
  ''
].join('\n')
const canonicalUnverifiedPayload = [
  'protocol=DYSON_CONTROL_PLAYER_CAPABILITIES_V1',
  'verifiedUpstreamRepository=NebulaModTeam/nebula',
  'verifiedUpstreamTag=v0.9.22',
  'verifiedRuntimeFileVersion=0.9.22.2',
  'verifiedUpstreamCommit=3cdf95c594a2f8010b0e87a43be828e6ba2f657f',
  'verificationScope=source-contract-only-runtime-unverified',
  'sessionId=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  'writtenAtUnixMs=1788081004000',
  'actionsEnabled=false',
  `capabilitiesJsonB64=${unverifiedCapabilitiesJsonB64}`,
  'hmac=49ad9008327dccd6aac3ed7233aa5b3955f910a9db61a6e7903ad9a499b90c5b',
  ''
].join('\n')

describe('signed Nebula player capability contract V1', () => {
  it('matches the C# vector and exposes only roster observation plus fixed-template notice', () => {
    const built = buildPlayerCapabilitySnapshot({
      sessionId: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
      writtenAtUnixMs: 1788081004000,
      runtimeVerified: true
    }, secret)

    expect(built.payload).toBe(canonicalVerifiedPayload)
    const parsed = parsePlayerCapabilitySnapshot(canonicalVerifiedPayload, secret)
    expect(parsed).toMatchObject({
      verifiedUpstreamTag: verifiedNebulaTag,
      verifiedRuntimeFileVersion: '0.9.22.2',
      verifiedUpstreamCommit: verifiedNebulaCommit,
      verificationScope: 'runtime-assembly-identity-verified',
      actionsEnabled: true,
      sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    })
    expect(parsed.capabilities.filter((entry) => entry.availability === 'available')).toEqual([
      {
        capability: 'observe-roster',
        availability: 'available',
        mode: 'read-only',
        verifiedReasonCode: 'UPSTREAM_ROSTER_API_VERIFIED'
      },
      {
        capability: 'notice',
        availability: 'available',
        mode: 'mutation',
        verifiedReasonCode: 'UPSTREAM_TARGETED_NOTICE_PRIMITIVES_VERIFIED'
      }
    ])
    expect(parsed.capabilities.filter((entry) => entry.mode === 'mutation'))
      .toHaveLength(7)
    expect(parsed.capabilities.filter((entry) => entry.mode === 'mutation'))
      .toSatisfy((entries: typeof parsed.capabilities) =>
        entries.filter((entry) => entry.capability !== 'notice')
          .every((entry) => entry.availability === 'unavailable'))
  })

  it('matches the fail-closed C# vector when runtime assembly identity is unverified', () => {
    const built = buildPlayerCapabilitySnapshot({
      sessionId: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
      writtenAtUnixMs: 1788081004000,
      runtimeVerified: false
    }, secret)
    expect(built.payload).toBe(canonicalUnverifiedPayload)
    expect(parsePlayerCapabilitySnapshot(canonicalUnverifiedPayload, secret)).toMatchObject({
      verificationScope: 'source-contract-only-runtime-unverified',
      actionsEnabled: false,
      capabilities: expect.arrayContaining([{
        capability: 'notice',
        availability: 'unavailable',
        mode: 'mutation',
        verifiedReasonCode: 'NEBULA_NOTICE_RUNTIME_UNVERIFIED'
      }])
    })
  })

  it('returns fixed unavailable reasons instead of pretending moderation actions succeeded', () => {
    const parsed = parsePlayerCapabilitySnapshot(canonicalVerifiedPayload, secret)
    const disconnect = findPlayerCapability(parsed, 'disconnect')
    const kick = findPlayerCapability(parsed, 'kick')
    const blacklist = findPlayerCapability(parsed, 'blacklist')
    const notice = findPlayerCapability(parsed, 'notice')

    expect(disconnect).toMatchObject({
      availability: 'unavailable',
      verifiedReasonCode: 'UPSTREAM_CONNECTED_DISCONNECT_UNSAFE'
    })
    expect(kick).toMatchObject({
      availability: 'unavailable',
      verifiedReasonCode: 'UPSTREAM_KICK_API_ABSENT'
    })
    expect(blacklist).toMatchObject({
      availability: 'unavailable',
      verifiedReasonCode: 'UPSTREAM_BLACKLIST_API_ABSENT'
    })
    expect(notice).toMatchObject({
      availability: 'available',
      verifiedReasonCode: 'UPSTREAM_TARGETED_NOTICE_PRIMITIVES_VERIFIED'
    })
    expect(playerCapabilityReasonSummaries[disconnect.verifiedReasonCode])
      .toContain('socket-close cleanup')
  })

  it('rejects tampering, unknown capabilities, and every cross-state mixture', () => {
    expect(() => parsePlayerCapabilitySnapshot(
      canonicalVerifiedPayload.replace('actionsEnabled=true', 'actionsEnabled=maybe'),
      secret
    )).toThrow('PLAYER_CAPABILITY_ACTIONS_INVALID')
    expect(() => parsePlayerCapabilitySnapshot(`${canonicalVerifiedPayload}extra=value\n`, secret))
      .toThrow('PLAYER_CAPABILITY_PAYLOAD_INVALID')
    expect(() => parsePlayerCapabilitySnapshot(
      canonicalVerifiedPayload.replace('hmac=df68', 'hmac=0f68'),
      secret
    )).toThrow('PLAYER_CAPABILITY_SIGNATURE_INVALID')

    const falseWithVerifiedScope = replaceAndResign(
      canonicalUnverifiedPayload,
      'verificationScope',
      'runtime-assembly-identity-verified'
    )
    expect(() => parsePlayerCapabilitySnapshot(falseWithVerifiedScope, secret))
      .toThrow('PLAYER_CAPABILITY_SCOPE_INVALID')
    const trueWithUnverifiedScope = replaceAndResign(
      canonicalVerifiedPayload,
      'verificationScope',
      'source-contract-only-runtime-unverified'
    )
    expect(() => parsePlayerCapabilitySnapshot(trueWithUnverifiedScope, secret))
      .toThrow('PLAYER_CAPABILITY_SCOPE_INVALID')
    const falseWithVerifiedNotice = replaceAndResign(
      canonicalUnverifiedPayload,
      'capabilitiesJsonB64',
      verifiedCapabilitiesJsonB64
    )
    expect(() => parsePlayerCapabilitySnapshot(falseWithVerifiedNotice, secret))
      .toThrow('PLAYER_CAPABILITY_DECLARATION_INVALID')

    const decoded = JSON.parse(Buffer.from(verifiedCapabilitiesJsonB64, 'base64url').toString('utf8'))
    decoded[2].capability = 'teleport'
    const unknown = replaceAndResign(
      canonicalVerifiedPayload,
      'capabilitiesJsonB64',
      Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')
    )
    expect(() => parsePlayerCapabilitySnapshot(unknown, secret))
      .toThrow('PLAYER_CAPABILITY_DECLARATION_INVALID')

    const malformed = replaceAndResign(
      canonicalVerifiedPayload,
      'capabilitiesJsonB64',
      malformedCapabilitiesJsonB64
    )
    expect(() => parsePlayerCapabilitySnapshot(malformed, secret))
      .toThrow('PLAYER_CAPABILITY_LIST_INVALID')
  })
})

function replaceAndResign(payload: string, key: string, value: string): string {
  const lines = payload.trimEnd().split('\n')
  const fieldIndex = lines.findIndex((line) => line.startsWith(`${key}=`))
  lines[fieldIndex] = `${key}=${value}`
  const canonical = lines.slice(0, -1).map((line) => line.slice(line.indexOf('=') + 1)).join('\n')
  lines[lines.length - 1] = `hmac=${createHmac('sha256', secret).update(canonical).digest('hex')}`
  return `${lines.join('\n')}\n`
}

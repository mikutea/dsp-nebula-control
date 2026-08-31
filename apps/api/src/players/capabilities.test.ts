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
const canonicalCapabilitiesJson = [
  '{"capability":"observe-roster","availability":"available","mode":"read-only","verifiedReasonCode":"UPSTREAM_ROSTER_API_VERIFIED"}',
  '{"capability":"disconnect","availability":"unavailable","mode":"mutation","verifiedReasonCode":"UPSTREAM_CONNECTED_DISCONNECT_UNSAFE"}',
  '{"capability":"kick","availability":"unavailable","mode":"mutation","verifiedReasonCode":"UPSTREAM_KICK_API_ABSENT"}',
  '{"capability":"ban","availability":"unavailable","mode":"mutation","verifiedReasonCode":"UPSTREAM_BAN_API_ABSENT"}',
  '{"capability":"whitelist","availability":"unavailable","mode":"mutation","verifiedReasonCode":"UPSTREAM_WHITELIST_API_ABSENT"}',
  '{"capability":"permission","availability":"unavailable","mode":"mutation","verifiedReasonCode":"UPSTREAM_PERMISSION_API_ABSENT"}'
].join(',')
const capabilitiesJsonB64 = Buffer.from(`[${canonicalCapabilitiesJson}]`, 'utf8').toString('base64url')
const canonicalPayload = [
  'protocol=DYSON_CONTROL_PLAYER_CAPABILITIES_V1',
  'verifiedUpstreamRepository=NebulaModTeam/nebula',
  'verifiedUpstreamTag=v0.9.22',
  'verifiedRuntimeFileVersion=0.9.22.2',
  'verifiedUpstreamCommit=3cdf95c594a2f8010b0e87a43be828e6ba2f657f',
  'verificationScope=source-contract-only-runtime-unverified',
  'sessionId=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  'writtenAtUnixMs=1788081004000',
  'actionsEnabled=false',
  `capabilitiesJsonB64=${capabilitiesJsonB64}`,
  'hmac=82d46a96e4402498c183a9dd7ccd281f4e4e1ae20999f33c44d243e846ea5cd0',
  ''
].join('\n')

describe('signed Nebula player capability contract V1', () => {
  it('matches the C# vector and exposes only the verified read-only roster capability', () => {
    const built = buildPlayerCapabilitySnapshot({
      sessionId: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
      writtenAtUnixMs: 1788081004000
    }, secret)

    expect(built.payload).toBe(canonicalPayload)
    const parsed = parsePlayerCapabilitySnapshot(canonicalPayload, secret)
    expect(parsed).toMatchObject({
      verifiedUpstreamTag: verifiedNebulaTag,
      verifiedRuntimeFileVersion: '0.9.22.2',
      verifiedUpstreamCommit: verifiedNebulaCommit,
      actionsEnabled: false,
      sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    })
    expect(parsed.capabilities.filter((entry) => entry.availability === 'available')).toEqual([{
      capability: 'observe-roster',
      availability: 'available',
      mode: 'read-only',
      verifiedReasonCode: 'UPSTREAM_ROSTER_API_VERIFIED'
    }])
    expect(parsed.capabilities.filter((entry) => entry.mode === 'mutation'))
      .toHaveLength(5)
    expect(parsed.capabilities.filter((entry) => entry.mode === 'mutation'))
      .toSatisfy((entries: typeof parsed.capabilities) =>
        entries.every((entry) => entry.availability === 'unavailable'))
  })

  it('returns a fixed unavailable reason instead of pretending disconnect or kick succeeded', () => {
    const parsed = parsePlayerCapabilitySnapshot(canonicalPayload, secret)
    const disconnect = findPlayerCapability(parsed, 'disconnect')
    const kick = findPlayerCapability(parsed, 'kick')

    expect(disconnect).toMatchObject({
      availability: 'unavailable',
      verifiedReasonCode: 'UPSTREAM_CONNECTED_DISCONNECT_UNSAFE'
    })
    expect(kick).toMatchObject({
      availability: 'unavailable',
      verifiedReasonCode: 'UPSTREAM_KICK_API_ABSENT'
    })
    expect(playerCapabilityReasonSummaries[disconnect.verifiedReasonCode])
      .toContain('socket-close cleanup')
  })

  it('rejects tampering, extra fields, enabled actions, and a signed unknown capability', () => {
    expect(() => parsePlayerCapabilitySnapshot(
      canonicalPayload.replace('actionsEnabled=false', 'actionsEnabled=true'),
      secret
    )).toThrow('PLAYER_CAPABILITY_ACTIONS_INVALID')
    expect(() => parsePlayerCapabilitySnapshot(`${canonicalPayload}extra=value\n`, secret))
      .toThrow('PLAYER_CAPABILITY_PAYLOAD_INVALID')
    expect(() => parsePlayerCapabilitySnapshot(
      canonicalPayload.replace('hmac=8', 'hmac=0'),
      secret
    )).toThrow('PLAYER_CAPABILITY_SIGNATURE_INVALID')

    const decoded = JSON.parse(Buffer.from(capabilitiesJsonB64, 'base64url').toString('utf8'))
    decoded[2].capability = 'teleport'
    const unknown = replaceAndResign(
      canonicalPayload,
      'capabilitiesJsonB64',
      Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')
    )
    expect(() => parsePlayerCapabilitySnapshot(unknown, secret))
      .toThrow('PLAYER_CAPABILITY_DECLARATION_INVALID')

    const malformed = replaceAndResign(canonicalPayload, 'capabilitiesJsonB64', malformedCapabilitiesJsonB64)
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

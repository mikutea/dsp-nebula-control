import { describe, expect, it } from 'vitest'
import {
  buildPlayerSnapshot,
  maximumSnapshotPlayers,
  parsePlayerSnapshot,
  type PlayerSnapshotEntry
} from './protocol.js'

const secret = 'fictional-cross-runtime-secret-0123456789'
const canonicalPayload = [
  'protocol=DYSON_CONTROL_PLAYERS_V1',
  'sessionId=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  'writtenAtUnixMs=1788081004000',
  'sequence=7',
  'state=active',
  'truncated=false',
  'playerCount=2',
  'playersJsonB64=W3sic2Vzc2lvblBsYXllcklkIjoicGxheWVyLTAwMDAwMSIsImRpc3BsYXlOYW1lIjoiTm92YSIsIm9ubGluZSI6dHJ1ZSwiam9pbmVkQXRVbml4TXMiOjE3ODgwODEwMDEwMDAsImxvY2F0aW9uIjoicGxhbmV0OjEwMSJ9LHsic2Vzc2lvblBsYXllcklkIjoicGxheWVyLTAwMDAwMiIsImRpc3BsYXlOYW1lIjoi5pif5rW3Iiwib25saW5lIjp0cnVlLCJqb2luZWRBdFVuaXhNcyI6MTc4ODA4MTAwMjAwMCwibG9jYXRpb24iOiJzdGFyOjIifV0',
  'hmac=bce756c9eb27bfd2784ae2277881872ef1ad5a711d5e9bf5972c559eeb3cd92e',
  ''
].join('\n')

describe('signed player snapshot protocol V1', () => {
  it('matches the C# cross-runtime vector and sorts opaque session IDs', () => {
    const built = buildPlayerSnapshot({
      sessionId: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
      writtenAtUnixMs: 1788081004000,
      sequence: 7,
      state: 'active',
      truncated: false,
      players: [
        player('player-000002', '星海', 1788081002000, 'star:2'),
        player('player-000001', 'Nova', 1788081001000, 'planet:101')
      ]
    }, secret)

    expect(built.payload).toBe(canonicalPayload)
    expect(parsePlayerSnapshot(canonicalPayload, secret)).toMatchObject({
      sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      state: 'active',
      playerCount: 2,
      players: [
        { sessionPlayerId: 'player-000001', displayName: 'Nova', location: 'planet:101' },
        { sessionPlayerId: 'player-000002', displayName: '星海', location: 'star:2' }
      ]
    })
  })

  it('rejects tampering, extra fields, and count mismatches', () => {
    expect(() => parsePlayerSnapshot(canonicalPayload.replace('Tm92YS', 'Tn92YS'), secret))
      .toThrow('PLAYER_SNAPSHOT_SIGNATURE_INVALID')
    expect(() => parsePlayerSnapshot(`${canonicalPayload}extra=value\n`, secret))
      .toThrow('PLAYER_SNAPSHOT_PAYLOAD_INVALID')
    expect(() => parsePlayerSnapshot(canonicalPayload.replace('playerCount=2', 'playerCount=1'), secret))
      .toThrow('PLAYER_SNAPSHOT_SIGNATURE_INVALID')
  })

  it('enforces hard player, display-name, state, and location bounds', () => {
    const tooMany = Array.from({ length: maximumSnapshotPlayers + 1 }, (_, index) =>
      player(`player-${String(index + 1).padStart(6, '0')}`, `P${index}`, 1788081001000, 'deep-space'))
    expect(() => buildPlayerSnapshot({
      sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', writtenAtUnixMs: 1788081004000,
      sequence: 1, state: 'active', truncated: true, players: tooMany
    }, secret)).toThrow('PLAYER_SNAPSHOT_STATE_INVALID')
    expect(() => buildPlayerSnapshot({
      sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', writtenAtUnixMs: 1788081004000,
      sequence: 1, state: 'active', truncated: false,
      players: [player('player-000001', 'x'.repeat(129), 1788081001000, 'deep-space')]
    }, secret)).toThrow('PLAYER_SNAPSHOT_DISPLAY_NAME_INVALID')
    expect(() => buildPlayerSnapshot({
      sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', writtenAtUnixMs: 1788081004000,
      sequence: 1, state: 'inactive', truncated: false,
      players: [player('player-000001', 'Nova', 1788081001000, 'planet:101')]
    }, secret)).toThrow('PLAYER_SNAPSHOT_STATE_INVALID')
    expect(() => buildPlayerSnapshot({
      sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', writtenAtUnixMs: 1788081004000,
      sequence: 1, state: 'active', truncated: false,
      players: [player('player-000001', 'Nova', 1788081001000, '192.0.2.10:8469')]
    }, secret)).toThrow('PLAYER_SNAPSHOT_LOCATION_INVALID')
  })
})

function player(
  sessionPlayerId: string,
  displayName: string,
  joinedAtUnixMs: number,
  location: string
): PlayerSnapshotEntry {
  return { sessionPlayerId, displayName, online: true, joinedAtUnixMs, location }
}

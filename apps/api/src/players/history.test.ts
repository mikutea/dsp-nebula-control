import { describe, expect, it } from 'vitest'
import { BoundedPlayerPresenceHistory } from './history.js'
import { buildPlayerSnapshot, type PlayerSnapshotEntry, type PlayerSnapshotState } from './protocol.js'

const secret = 'fictional-player-history-secret-0123456789'
const sessionA = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const sessionB = '11111111-2222-4333-8444-555555555555'
const baseTime = 1788081004000

describe('bounded in-memory player presence history', () => {
  it('derives idempotent join and leave events without persistence', () => {
    const history = new BoundedPlayerPresenceHistory(8)
    const first = snapshot(sessionA, 1, 'active', [
      player('player-000001', 'Nova', baseTime - 3_000),
      player('player-000002', '星海', baseTime - 2_000)
    ])
    expect(history.ingest(first).map((event) => event.type)).toEqual(['join', 'join'])
    expect(history.ingest(first)).toEqual([])

    const second = snapshot(sessionA, 2, 'active', [player('player-000002', '星海', baseTime - 2_000)])
    expect(history.ingest(second)).toMatchObject([{
      type: 'leave', player: { sessionPlayerId: 'player-000001', online: false }
    }])
    expect(history.current().map((entry) => entry.sessionPlayerId)).toEqual(['player-000002'])
    expect(history.list()).toHaveLength(3)
  })

  it('does not invent leaves during an unavailable snapshot', () => {
    const history = new BoundedPlayerPresenceHistory()
    history.ingest(snapshot(sessionA, 1, 'active', [player('player-000001', 'Nova', baseTime - 1_000)]))
    expect(history.ingest(snapshot(sessionA, 100, 'unavailable', []))).toEqual([])
    expect(history.current()).toHaveLength(1)
    expect(() => history.ingest(snapshot(sessionA, 2, 'active', [])))
      .toThrow('PLAYER_HISTORY_SEQUENCE_REGRESSION')
    expect(history.ingest(snapshot(sessionA, 101, 'active', [player('player-000001', 'Nova', baseTime - 1_000)])))
      .toEqual([])
    expect(history.ingest(snapshot(sessionA, 102, 'inactive', []))).toMatchObject([{
      type: 'leave', player: { sessionPlayerId: 'player-000001', online: false }
    }])
  })

  it('closes the old session, opens the new session, and retains only the configured event bound', () => {
    const history = new BoundedPlayerPresenceHistory(3)
    history.ingest(snapshot(sessionA, 1, 'active', [player('player-000001', 'Nova', baseTime - 1_000)]))
    const reset = history.ingest(snapshot(sessionB, 2, 'active', [player('player-000001', 'Orion', baseTime)]))
    expect(reset.map((event) => [event.type, event.sessionId])).toEqual([
      ['leave', sessionA], ['join', sessionB]
    ])
    history.ingest(snapshot(sessionB, 3, 'inactive', []))
    const retained = history.list()
    expect(retained).toHaveLength(3)
    expect(retained.map((event) => event.historySequence)).toEqual([2, 3, 4])
  })

  it('rejects replay regression and same-sequence projection conflicts without retaining HMACs', () => {
    const history = new BoundedPlayerPresenceHistory()
    const first = snapshot(sessionA, 2, 'active', [])
    history.ingest(first)
    expect(() => history.ingest(snapshot(sessionA, 1, 'active', [])))
      .toThrow('PLAYER_HISTORY_SEQUENCE_REGRESSION')
    expect(() => history.ingest({ ...first, writtenAtUnixMs: first.writtenAtUnixMs + 1 }))
      .toThrow('PLAYER_HISTORY_SEQUENCE_CONFLICT')
  })

  it('does not treat a new-session unavailable or a truncated roster window as leave evidence', () => {
    const history = new BoundedPlayerPresenceHistory()
    history.ingest(snapshot(sessionA, 1, 'active', [
      player('player-000001', 'Nova', baseTime - 1_000)
    ]))
    expect(history.ingest(snapshot(sessionB, 2, 'unavailable', []))).toEqual([])
    expect(history.current().map((entry) => entry.sessionPlayerId)).toEqual(['player-000001'])
    expect(() => history.ingest(snapshot(sessionA, 1, 'active', [
      player('player-000001', 'Nova', baseTime - 1_000)
    ]))).toThrow('PLAYER_HISTORY_SESSION_REPLAY')

    const truncated = snapshot(sessionA, 3, 'active', [])
    truncated.truncated = true
    truncated.hmac = 'a'.repeat(64)
    expect(history.ingest(truncated)).toEqual([])
  })
})

function snapshot(
  sessionId: string,
  sequence: number,
  state: PlayerSnapshotState,
  players: PlayerSnapshotEntry[]
) {
  return buildPlayerSnapshot({
    sessionId,
    writtenAtUnixMs: baseTime + sequence * 1_000,
    sequence,
    state,
    truncated: false,
    players
  }, secret).snapshot
}

function player(
  sessionPlayerId: string,
  displayName: string,
  joinedAtUnixMs: number
): PlayerSnapshotEntry {
  return { sessionPlayerId, displayName, online: true, joinedAtUnixMs, location: 'deep-space' }
}

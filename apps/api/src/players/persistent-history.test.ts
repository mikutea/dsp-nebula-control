import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ControlDatabase } from '../storage/database.js'
import {
  PersistentPlayerPresenceHistory,
  type PlayerPresenceHistoryPersistence,
  type PlayerPresenceHistoryPersistenceState
} from './history.js'
import {
  buildPlayerSnapshot,
  type PlayerSnapshotEntry,
  type PlayerSnapshotState
} from './protocol.js'

const secret = 'fictional-persistent-player-history-secret-0123456789'
const sessionA = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const sessionB = '11111111-2222-4333-8444-555555555555'
const baseTime = Date.parse('2026-08-31T02:00:00.000Z')
const temporaryDirectories: string[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('persistent player presence history', () => {
  it('reopens the database without duplicating a join and derives later join/leave events', () => {
    const directory = temporaryDirectory()
    const first = snapshot(sessionA, 1, 'active', [
      player('player-000001', 'Nova', baseTime - 3_000)
    ])
    let database = new ControlDatabase(directory)
    let history = persistent(database)
    expect(history.ingest(first)).toMatchObject([{
      type: 'join', player: { sessionPlayerId: 'player-000001', online: true }
    }])
    database.close()

    database = new ControlDatabase(directory)
    history = persistent(database)
    expect(history.current().map((entry) => entry.sessionPlayerId)).toEqual(['player-000001'])
    expect(history.list()).toHaveLength(1)
    expect(history.ingest(first)).toEqual([])
    expect(history.list()).toHaveLength(1)

    expect(history.ingest(snapshot(sessionA, 2, 'active', [
      player('player-000001', 'Nova', baseTime - 3_000),
      player('player-000002', '星海', baseTime + 1_000)
    ]))).toMatchObject([{
      type: 'join', player: { sessionPlayerId: 'player-000002', online: true }
    }])
    expect(history.ingest(snapshot(sessionA, 3, 'active', [
      player('player-000002', '星海', baseTime + 1_000)
    ]))).toMatchObject([{
      type: 'leave', player: { sessionPlayerId: 'player-000001', online: false }
    }])
    expect(history.list().map((event) => event.historySequence)).toEqual([1, 2, 3])
    database.close()
  })

  it('preserves the last authoritative roster across unavailable snapshots, including a new session id', () => {
    const database = new ControlDatabase(temporaryDirectory())
    const history = persistent(database)
    history.ingest(snapshot(sessionA, 1, 'active', [
      player('player-000001', 'Nova', baseTime - 1_000)
    ]))
    expect(history.ingest(snapshot(sessionA, 2, 'unavailable', []))).toEqual([])
    expect(history.ingest(snapshot(sessionB, 1, 'unavailable', [], baseTime + 2_500))).toEqual([])
    expect(history.current().map((entry) => entry.sessionPlayerId)).toEqual(['player-000001'])
    expect(history.list().map((event) => event.type)).toEqual(['join'])
    expect(history.ingest(snapshot(sessionA, 3, 'active', [
      player('player-000001', 'Nova', baseTime - 1_000)
    ]))).toEqual([])
    expect(history.list().map((event) => event.type)).toEqual(['join'])
    database.close()
  })

  it('persists unavailable sequence high-waters per session and rejects signed replay after restart', () => {
    const directory = temporaryDirectory()
    let database = new ControlDatabase(directory)
    let history = persistent(database)
    history.ingest(snapshot(sessionA, 1, 'active', [
      player('player-000001', 'Nova', baseTime - 1_000)
    ]))
    const unavailableA = snapshot(sessionA, 100, 'unavailable', [])
    const unavailableB = snapshot(sessionB, 100, 'unavailable', [], baseTime + 100_001)
    expect(history.ingest(unavailableA)).toEqual([])
    expect(history.ingest(unavailableB)).toEqual([])
    database.close()

    database = new ControlDatabase(directory)
    history = persistent(database)
    expect(() => history.ingest(snapshot(sessionA, 2, 'active', [])))
      .toThrow('PLAYER_HISTORY_SEQUENCE_REGRESSION')
    expect(() => history.ingest(snapshot(sessionB, 2, 'active', [])))
      .toThrow('PLAYER_HISTORY_SEQUENCE_REGRESSION')
    expect(history.ingest(unavailableB)).toEqual([])
    expect(() => history.ingest(snapshot(
      sessionB,
      100,
      'unavailable',
      [],
      unavailableB.writtenAtUnixMs + 1
    ))).toThrow('PLAYER_HISTORY_SEQUENCE_CONFLICT')
    expect(history.ingest(snapshot(sessionA, 101, 'active', [
      player('player-000001', 'Nova', baseTime - 1_000)
    ]))).toEqual([])
    expect(history.list().map((event) => event.type)).toEqual(['join'])
    database.close()
  })

  it('rejects an older known session replay after restart and keeps the latest roster', () => {
    const directory = temporaryDirectory()
    const snapshotA = snapshot(sessionA, 1, 'active', [
      player('player-000001', 'Fictional A', baseTime)
    ], baseTime + 1_000)
    const snapshotB = snapshot(sessionB, 1, 'active', [
      player('player-000001', 'Fictional B', baseTime + 1_000)
    ], baseTime + 2_000)
    let database = new ControlDatabase(directory)
    let history = persistent(database)
    history.ingest(snapshotA)
    history.ingest(snapshotB)
    database.close()

    database = new ControlDatabase(directory)
    history = persistent(database)
    expect(() => history.ingest(snapshotA)).toThrow('PLAYER_HISTORY_SESSION_REPLAY')
    expect(history.authoritative()).toMatchObject({
      sessionId: sessionB,
      sequence: 1,
      players: [{ displayName: 'Fictional B' }]
    })
    database.close()
  })

  it('retains a global clock high-water after evicting an old per-session cursor', () => {
    const directory = temporaryDirectory()
    let database = new ControlDatabase(directory)
    let history = persistent(database)
    let firstSnapshot: ReturnType<typeof snapshot> | null = null
    let latestSessionId = ''
    for (let index = 0; index < 9; index++) {
      const sessionId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
      const signed = snapshot(sessionId, 1, 'active', [
        player('player-000001', `Fictional Session ${index + 1}`, baseTime + index)
      ], baseTime + (index + 1) * 1_000)
      firstSnapshot ??= signed
      latestSessionId = sessionId
      history.ingest(signed)
    }
    database.close()

    database = new ControlDatabase(directory)
    history = persistent(database)
    expect(() => history.ingest(firstSnapshot!)).toThrow('PLAYER_HISTORY_TIME_REGRESSION')
    expect(history.authoritative()).toMatchObject({ sessionId: latestSessionId })
    database.close()
  })

  it('closes the old authoritative session and opens the next session atomically', () => {
    const database = new ControlDatabase(temporaryDirectory())
    const history = persistent(database)
    history.ingest(snapshot(sessionA, 1, 'active', [
      player('player-000001', 'Nova', baseTime - 1_000)
    ]))
    const changed = history.ingest(snapshot(sessionB, 1, 'active', [
      player('player-000001', 'Orion', baseTime + 1_000)
    ], baseTime + 2_000))
    expect(changed.map((event) => [event.type, event.sessionId])).toEqual([
      ['leave', sessionA], ['join', sessionB]
    ])
    expect(history.current()).toMatchObject([{
      sessionPlayerId: 'player-000001', displayName: 'Orion'
    }])
    database.close()
  })

  it('enforces capacity and time retention together without deleting unrelated tables or current state', () => {
    const directory = temporaryDirectory()
    const database = new ControlDatabase(directory)
    const history = new PersistentPlayerPresenceHistory(database, {
      capacity: 3,
      retentionHours: 168,
      now: () => baseTime + 20_000
    })
    database.createSession(
      'fixture-session-token',
      'Viewer',
      new Date(Date.now() + 60_000).toISOString(),
      'viewer'
    )
    history.ingest(snapshot(sessionA, 1, 'active', [
      player('player-000001', 'Nova', baseTime - 1_000)
    ]))
    history.ingest(snapshot(sessionA, 2, 'active', [
      player('player-000002', 'Orion', baseTime + 1_000)
    ]))
    history.ingest(snapshot(sessionA, 3, 'inactive', []))
    expect(history.list().map((event) => event.historySequence)).toEqual([2, 3, 4])
    expect(database.getSession('fixture-session-token')).toMatchObject({ username: 'Viewer' })

    let now = baseTime + 10 * 60 * 1_000
    const timeDirectory = join(directory, 'time-window')
    const timeDatabase = new ControlDatabase(timeDirectory)
    const timeHistory = new PersistentPlayerPresenceHistory(timeDatabase, {
      capacity: 16,
      retentionHours: 1,
      now: () => now
    })
    timeHistory.ingest(snapshot(sessionA, 1, 'active', [
      player('player-000001', 'Nova', baseTime + 60_000)
    ], baseTime + 2 * 60_000))
    expect(timeHistory.list()).toHaveLength(1)
    now = baseTime + 2 * 60 * 60 * 1_000
    expect(timeHistory.list()).toEqual([])
    expect(timeHistory.current().map((entry) => entry.sessionPlayerId)).toEqual(['player-000001'])
    timeDatabase.close()
    database.close()
  })

  it('secure-deletes expired identity bytes while idle and truncates WAL after the player leaves', async () => {
    const directory = temporaryDirectory()
    vi.useFakeTimers()
    vi.setSystemTime(baseTime + 10 * 60 * 1_000)
    const database = new ControlDatabase(directory)
    const history = new PersistentPlayerPresenceHistory(database, {
      capacity: 16,
      retentionHours: 1,
      now: Date.now
    })
    const maintenanceErrors: string[] = []
    const stopMaintenance = history.startRetentionMaintenance((error) => {
      maintenanceErrors.push(error.code)
    })
    const sentinel = 'ExpiredPlayerSentinel-7f93c2'
    try {
      history.ingest(snapshot(sessionA, 1, 'active', [
        player('player-000001', sentinel, baseTime)
      ]))
      history.ingest(snapshot(sessionA, 2, 'inactive', []))
      expect(history.list()).toHaveLength(2)

      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1_000)
      const raw = new DatabaseSync(join(directory, 'control.db'))
      expect((raw.prepare(
        'SELECT COUNT(*) AS count FROM player_presence_events'
      ).get() as { count: number }).count).toBe(0)
      raw.close()
      expect(maintenanceErrors).toEqual([])
      const sentinelBytes = Buffer.from(sentinel, 'utf8')
      for (const fileName of readdirSync(directory).filter((name) => name.startsWith('control.db'))) {
        expect(readFileSync(join(directory, fileName)).includes(sentinelBytes), fileName).toBe(false)
      }
    } finally {
      stopMaintenance()
      database.close()
    }
  })

  it('schedules idle pruning from the oldest occurrence rather than insertion order', async () => {
    const directory = temporaryDirectory()
    vi.useFakeTimers()
    vi.setSystemTime(baseTime + 10 * 60 * 1_000)
    const database = new ControlDatabase(directory)
    const history = new PersistentPlayerPresenceHistory(database, {
      capacity: 16,
      retentionHours: 1,
      now: Date.now
    })
    const stopMaintenance = history.startRetentionMaintenance(() => undefined)
    try {
      history.ingest(snapshot(sessionA, 1, 'active', [
        player('player-000001', 'Fictional First', baseTime)
      ]))
      history.ingest(snapshot(sessionA, 2, 'active', [
        player('player-000001', 'Fictional First', baseTime),
        player('player-000002', 'Fictional Older Join', baseTime - 5 * 60 * 1_000)
      ]))

      await vi.advanceTimersByTimeAsync(45 * 60 * 1_000 + 1)
      let raw = new DatabaseSync(join(directory, 'control.db'))
      expect(raw.prepare(
        'SELECT display_name FROM player_presence_events ORDER BY history_sequence ASC'
      ).all()).toEqual([{ display_name: 'Fictional First' }])
      raw.close()

      await vi.advanceTimersByTimeAsync(5 * 60 * 1_000)
      raw = new DatabaseSync(join(directory, 'control.db'))
      expect((raw.prepare(
        'SELECT COUNT(*) AS count FROM player_presence_events'
      ).get() as { count: number }).count).toBe(0)
      raw.close()
    } finally {
      stopMaintenance()
      database.close()
    }
  })

  it('does not invent changes while a signed active roster is truncated', () => {
    const database = new ControlDatabase(temporaryDirectory())
    const history = persistent(database)
    history.ingest(snapshot(sessionA, 1, 'active', [
      player('player-000001', 'Nova', baseTime - 1_000)
    ]))
    expect(history.ingest(snapshot(sessionA, 2, 'active', [], undefined, true))).toEqual([])
    expect(history.ingest(snapshot(sessionA, 3, 'active', [
      player('player-000001', 'Nova', baseTime - 1_000),
      player('player-000002', 'Orion', baseTime + 1_000)
    ]))).toEqual([])
    expect(history.list().map((event) => event.type)).toEqual(['join'])
    database.close()
  })

  it('rolls back the projection when an event insert fails inside the SQLite transaction', () => {
    const directory = temporaryDirectory()
    const database = new ControlDatabase(directory)
    const failure = new OneShotInsertFailurePersistence(database, join(directory, 'control.db'))
    const history = new PersistentPlayerPresenceHistory(failure, {
      capacity: 512,
      retentionHours: 168,
      now: () => baseTime + 60_000
    })
    history.ingest(snapshot(sessionA, 1, 'active', [
      player('player-000001', 'Nova', baseTime - 1_000)
    ]))
    failure.arm()
    try {
      expect(() => history.ingest(snapshot(sessionA, 2, 'active', [
        player('player-000001', 'Nova', baseTime - 1_000),
        player('player-000002', 'Orion', baseTime + 1_000)
      ]))).toThrow('PLAYER_HISTORY_PERSISTENCE_FAILED')
    } finally {
      failure.removeTrigger()
    }
    try {
      expect(history.current().map((entry) => entry.sessionPlayerId)).toEqual(['player-000001'])
      expect(history.list()).toMatchObject([{
        historySequence: 1,
        type: 'join',
        player: { sessionPlayerId: 'player-000001' }
      }])
    } finally {
      database.close()
    }
  })

  it.each([
    ['projection JSON', (databasePath: string) => {
      const raw = new DatabaseSync(databasePath)
      raw.prepare('UPDATE player_presence_state SET projection_json = ? WHERE singleton_id = 1')
        .run('{"schemaVersion":1}')
      raw.close()
    }],
    ['event row', (databasePath: string) => {
      const raw = new DatabaseSync(databasePath)
      raw.prepare('UPDATE player_presence_events SET display_name = ? WHERE history_sequence = 1')
        .run('broken\nname')
      raw.close()
    }]
  ])('fails closed with a stable error for corrupted %s', (_label, corrupt) => {
    const directory = temporaryDirectory()
    let database = new ControlDatabase(directory)
    const history = persistent(database)
    history.ingest(snapshot(sessionA, 1, 'active', [
      player('player-000001', 'Nova', baseTime - 1_000)
    ]))
    database.close()
    corrupt(join(directory, 'control.db'))

    let reopened: ControlDatabase | null = null
    expect(() => {
      try {
        reopened = new ControlDatabase(directory)
        persistent(reopened)
      } finally {
        reopened?.close()
      }
    }).toThrow('PLAYER_HISTORY_PERSISTENCE_INVALID')
  })

  it('rejects orphaned events before retention can prune them or invent a new baseline', () => {
    const directory = temporaryDirectory()
    new ControlDatabase(directory).close()
    let raw = new DatabaseSync(join(directory, 'control.db'))
    raw.prepare(`
      INSERT INTO player_presence_events(
        type, occurred_at_unix_ms, session_id, session_player_id,
        display_name, online, joined_at_unix_ms, location
      ) VALUES ('join', ?, ?, 'player-000001', 'Orphan Fixture', 1, ?, 'deep-space')
    `).run(baseTime, sessionA, baseTime)
    raw.close()

    expect(() => new ControlDatabase(directory)).toThrow('PLAYER_HISTORY_PERSISTENCE_INVALID')
    raw = new DatabaseSync(join(directory, 'control.db'))
    expect((raw.prepare('SELECT COUNT(*) AS count FROM player_presence_events').get() as { count: number }).count)
      .toBe(1)
    raw.close()
  })

  it('stores only the minimized projection and never stores the HMAC, secret, endpoint or path', () => {
    const directory = temporaryDirectory()
    const database = new ControlDatabase(directory)
    const history = persistent(database)
    const signed = snapshot(sessionA, 1, 'active', [
      player('player-000001', 'Fictional Captain', baseTime - 1_000)
    ])
    history.ingest(signed)
    database.close()

    const raw = new DatabaseSync(join(directory, 'control.db'))
    const state = raw.prepare(
      'SELECT schema_version, projection_json, cursor_json FROM player_presence_state WHERE singleton_id = 1'
    ).get()
    const events = raw.prepare(`
      SELECT type, occurred_at_unix_ms, session_id, session_player_id,
             display_name, online, joined_at_unix_ms, location
      FROM player_presence_events ORDER BY history_sequence ASC
    `).all()
    const schema = raw.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE name IN ('player_presence_state', 'player_presence_events') ORDER BY name ASC
    `).all()
    raw.close()

    const persisted = JSON.stringify({ state, events, schema })
    const storedState = state as { projection_json: string; cursor_json: string }
    expect(JSON.parse(storedState.projection_json)).toEqual({
      schemaVersion: 1,
      sessionId: sessionA,
      snapshotSequence: 1,
      writtenAtUnixMs: baseTime + 1_000,
      state: 'active',
      truncated: false,
      players: [{
        sessionPlayerId: 'player-000001',
        displayName: 'Fictional Captain',
        online: true,
        joinedAtUnixMs: baseTime - 1_000,
        location: 'deep-space'
      }]
    })
    expect(JSON.parse(storedState.cursor_json)).toEqual([{
      sessionId: sessionA,
      sequence: 1,
      writtenAtUnixMs: baseTime + 1_000,
      state: 'active',
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/)
    }])
    for (const forbidden of [
      signed.hmac,
      secret,
      'hmac',
      'endpoint',
      'ip_address',
      'steam',
      'filesystem_path',
      'raw_payload',
      'C:\\Fictional'
    ]) {
      expect(persisted.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
  })

  it('rejects extra persisted projection fields at the SQLite adapter boundary', () => {
    const database = new ControlDatabase(temporaryDirectory())
    expect(() => database.commitPlayerPresenceHistory({
      expectedProjectionJson: null,
      expectedCursorJson: '[]',
      projectionJson: JSON.stringify({
        schemaVersion: 1,
        sessionId: sessionA,
        snapshotSequence: 1,
        writtenAtUnixMs: baseTime,
        state: 'active',
        truncated: false,
        players: [],
        hmac: 'a'.repeat(64)
      }),
      cursorJson: '[]',
      events: [],
      capacity: 512,
      cutoffUnixMs: baseTime - 60_000
    })).toThrow('PLAYER_HISTORY_PERSISTENCE_INVALID')
    expect(database.loadPlayerPresenceHistory()).toEqual({
      projectionJson: null,
      cursorJson: '[]',
      events: []
    })
    database.close()
  })
})

function persistent(database: ControlDatabase): PersistentPlayerPresenceHistory {
  return new PersistentPlayerPresenceHistory(database, {
    capacity: 512,
    retentionHours: 168,
    now: () => baseTime + 60_000
  })
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dyson-player-history-'))
  temporaryDirectories.push(directory)
  return directory
}

function snapshot(
  sessionId: string,
  sequence: number,
  state: PlayerSnapshotState,
  players: PlayerSnapshotEntry[],
  writtenAtUnixMs = baseTime + sequence * 1_000,
  truncated = false
) {
  return buildPlayerSnapshot({
    sessionId,
    writtenAtUnixMs,
    sequence,
    state,
    truncated,
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

class OneShotInsertFailurePersistence implements PlayerPresenceHistoryPersistence {
  readonly #database: ControlDatabase
  readonly #databasePath: string
  #armed = false

  constructor(database: ControlDatabase, databasePath: string) {
    this.#database = database
    this.#databasePath = databasePath
  }

  arm(): void {
    this.#armed = true
  }

  removeTrigger(): void {
    const raw = new DatabaseSync(this.#databasePath)
    raw.exec('DROP TRIGGER IF EXISTS fixture_abort_player_event')
    raw.close()
  }

  loadPlayerPresenceHistory(): PlayerPresenceHistoryPersistenceState {
    return this.#database.loadPlayerPresenceHistory()
  }

  prunePlayerPresenceHistory(capacity: number, cutoffUnixMs: number): PlayerPresenceHistoryPersistenceState {
    return this.#database.prunePlayerPresenceHistory(capacity, cutoffUnixMs)
  }

  commitPlayerPresenceHistory(
    input: Parameters<PlayerPresenceHistoryPersistence['commitPlayerPresenceHistory']>[0]
  ): ReturnType<PlayerPresenceHistoryPersistence['commitPlayerPresenceHistory']> {
    if (this.#armed) {
      this.#armed = false
      const raw = new DatabaseSync(this.#databasePath)
      raw.exec(`
        CREATE TRIGGER fixture_abort_player_event
        BEFORE INSERT ON player_presence_events
        BEGIN
          SELECT RAISE(ABORT, 'fixture-player-event-failure');
        END;
      `)
      raw.close()
    }
    return this.#database.commitPlayerPresenceHistory(input)
  }
}

import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ObservabilityAlertEpisodeStateMachine } from '../observability/alerts.js'
import { PersistentObservabilityAlerts } from '../observability/persistent-alerts.js'
import { ControlDatabase } from './database.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dyson-control-database-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('control database session roles', () => {
  it('persists alert state with compare-and-swap revisions across reopen', () => {
    const directory = temporaryDirectory()
    const payload = new ObservabilityAlertEpisodeStateMachine({ capacity: 4 }).serializeJson()
    const database = new ControlDatabase(directory)
    expect(database.read()).toBeNull()
    expect(database.write(null, payload)).toBe(1)
    expect(database.read()).toEqual({ revision: 1, payload })
    expect(() => database.write(null, payload)).toThrow(/revision conflict/)
    database.close()

    const reopened = new ControlDatabase(directory)
    expect(reopened.read()).toEqual({ revision: 1, payload })
    expect(reopened.write(1, payload)).toBe(2)
    expect(reopened.read()).toEqual({ revision: 2, payload })
    reopened.close()
  })

  it('hydrates the strict alert reducer from the database store', () => {
    const directory = temporaryDirectory()
    const database = new ControlDatabase(directory)
    const payload = new ObservabilityAlertEpisodeStateMachine({ capacity: 8 }).serializeJson()
    database.write(null, payload)
    database.close()

    const reopened = new ControlDatabase(directory)
    const restored = new PersistentObservabilityAlerts({ store: reopened, capacity: 8 })
    expect(restored.revision).toBe(1)
    expect(restored.project()).toMatchObject({ capacity: 8, episodes: [] })
    reopened.close()
  })

  it('fails closed on a malformed or trigger-bearing alert state table', () => {
    const malformedDirectory = temporaryDirectory()
    const malformed = new DatabaseSync(join(malformedDirectory, 'control.db'))
    malformed.exec(`
      CREATE TABLE observability_alert_state (
        singleton_id INTEGER PRIMARY KEY,
        payload_json TEXT NOT NULL
      )
    `)
    malformed.close()
    expect(() => new ControlDatabase(malformedDirectory)).toThrow(/Observability alert schema is invalid/)

    const triggerDirectory = temporaryDirectory()
    const database = new ControlDatabase(triggerDirectory)
    database.close()
    const tampered = new DatabaseSync(join(triggerDirectory, 'control.db'))
    tampered.exec(`
      CREATE TRIGGER fixture_alert_trigger
      AFTER INSERT ON observability_alert_state
      BEGIN
        DELETE FROM sessions;
      END;
    `)
    tampered.close()
    expect(() => new ControlDatabase(triggerDirectory)).toThrow(/Observability alert schema is invalid/)
  })

  it('persists an exact least-privilege role with the opaque session', () => {
    const database = new ControlDatabase(temporaryDirectory())
    const future = new Date(Date.now() + 60_000).toISOString()
    database.createSession('operator-token-hash', 'Operator', future, 'operator')
    expect(database.getSession('operator-token-hash')).toEqual({
      username: 'Operator',
      role: 'operator',
      expires_at: future
    })
    database.close()
  })

  it('migrates an existing role-less session table to administrator without invalidating it', () => {
    const directory = temporaryDirectory()
    const future = new Date(Date.now() + 60_000).toISOString()
    const legacy = new DatabaseSync(join(directory, 'control.db'))
    legacy.exec(`
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `)
    legacy.prepare(
      'INSERT INTO sessions(token_hash, username, expires_at, created_at) VALUES (?, ?, ?, ?)'
    ).run('legacy-token-hash', 'Administrator', future, new Date().toISOString())
    legacy.close()

    const database = new ControlDatabase(directory)
    expect(database.getSession('legacy-token-hash')).toEqual({
      username: 'Administrator',
      role: 'administrator',
      expires_at: future
    })
    database.close()
  })

  it('fails closed instead of completing a partial player-history schema', () => {
    const directory = temporaryDirectory()
    const malformed = new DatabaseSync(join(directory, 'control.db'))
    malformed.exec(`
      CREATE TABLE player_presence_state (
        singleton_id INTEGER PRIMARY KEY NOT NULL,
        schema_version INTEGER NOT NULL,
        projection_json TEXT
      );
      INSERT INTO player_presence_state(singleton_id, schema_version, projection_json)
      VALUES (1, 1, NULL);
    `)
    malformed.close()

    expect(() => new ControlDatabase(directory)).toThrow('PLAYER_HISTORY_SCHEMA_INVALID')
  })

  it('fails closed when same-named player tables omit the versioned constraints', () => {
    const directory = temporaryDirectory()
    const malformed = new DatabaseSync(join(directory, 'control.db'))
    malformed.exec(`
      CREATE TABLE player_presence_state (
        singleton_id INTEGER PRIMARY KEY NOT NULL,
        schema_version INTEGER NOT NULL,
        projection_json TEXT
      );
      CREATE TABLE player_presence_events (
        history_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        occurred_at_unix_ms INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        session_player_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        online INTEGER NOT NULL,
        joined_at_unix_ms INTEGER NOT NULL,
        location TEXT NOT NULL
      );
      INSERT INTO player_presence_state(singleton_id, schema_version, projection_json)
      VALUES (1, 1, NULL);
    `)
    malformed.close()

    expect(() => new ControlDatabase(directory)).toThrow('PLAYER_HISTORY_SCHEMA_INVALID')
  })

  it('rejects player-table triggers before retention can mutate an unrelated table', () => {
    const directory = temporaryDirectory()
    const database = new ControlDatabase(directory)
    database.createSession(
      'trigger-boundary-token',
      'Viewer',
      new Date(Date.now() + 60_000).toISOString(),
      'viewer'
    )
    database.close()
    const tampered = new DatabaseSync(join(directory, 'control.db'))
    tampered.exec(`
      CREATE TRIGGER fixture_cross_table_delete
      AFTER DELETE ON player_presence_events
      BEGIN
        DELETE FROM sessions;
      END;
    `)
    tampered.close()

    expect(() => new ControlDatabase(directory)).toThrow('PLAYER_HISTORY_SCHEMA_INVALID')
    const verify = new DatabaseSync(join(directory, 'control.db'))
    expect((verify.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count)
      .toBe(1)
    verify.close()
  })
})

import { createRecoverableCleanupPlan } from '../update-pipeline/recoverable-cleanup-plan.js'
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

function claimSaveFixtureRunning(database: ControlDatabase, jobId: string): void {
  const queued = database.getSaveRun(jobId)
  if (!queued) throw new Error(`fixture save run missing: ${jobId}`)
  if (!database.claimQueuedSaveRun(jobId, queued.updatedAt, 'running fixture')) {
    throw new Error(`fixture save run claim failed: ${jobId}`)
  }
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

describe('durable save reconciliation storage', () => {
  it('adds cleanup and maintenance result columns to an existing save-run table', () => {
    const directory = temporaryDirectory()
    const database = new ControlDatabase(directory)
    const created = database.createSaveJob({
      operation: 'restore',
      idempotencyKey: '33333333-3333-4333-8333-333333333333',
      saveName: null,
      backupId: 'tx-55555555-5555-4555-8555-555555555555',
      expectedRevision: `pair-v1:${'a'.repeat(64)}`,
      protectionRequestId: '44444444-4444-4444-8444-444444444444'
    }, 'Administrator', 'legacy migration fixture')
    claimSaveFixtureRunning(database, created.job.id)
    database.completeSaveRun(created.job.id, 'interrupted', 'cleanup pending fixture',
      'SAVE_COMMIT_CLEANUP_PENDING', true, {
        status: 'succeeded',
        backupId: 'tx-55555555-5555-4555-8555-555555555555',
        protectionBackupId: 'tx-44444444-4444-4444-8444-444444444444',
        pairBytes: 2048,
        rollback: 'not-required',
        reused: false,
        auditStored: true,
        cleanupPending: true,
        maintenanceRequired: true
      })
    database.close()

    const legacy = new DatabaseSync(join(directory, 'control.db'))
    legacy.exec(`
      ALTER TABLE save_runs DROP COLUMN result_cleanup_pending;
      ALTER TABLE save_runs DROP COLUMN result_maintenance_required;
    `)
    legacy.close()

    const migrated = new ControlDatabase(directory)
    expect(migrated.getSaveRun(created.job.id)).toMatchObject({
      result: { cleanupPending: true, maintenanceRequired: true }
    })
    migrated.close()
    const inspected = new DatabaseSync(join(directory, 'control.db'), { readOnly: true })
    const columns = inspected.prepare('PRAGMA table_info(save_runs)').all() as unknown as Array<{ name: string }>
    inspected.close()
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'result_cleanup_pending', 'result_maintenance_required'
    ]))
  })

  it('atomically records authorization and requeues only the expected interrupted revision', () => {
    const directory = temporaryDirectory()
    const database = new ControlDatabase(directory)
    const created = database.createSaveJob({
      operation: 'restore',
      idempotencyKey: '33333333-3333-4333-8333-333333333333',
      saveName: null,
      backupId: 'tx-55555555-5555-4555-8555-555555555555',
      expectedRevision: `pair-v1:${'a'.repeat(64)}`,
      protectionRequestId: '44444444-4444-4444-8444-444444444444'
    }, 'Administrator', 'queued fixture')
    claimSaveFixtureRunning(database, created.job.id)
    const completed = database.completeSaveRun(
      created.job.id,
      'interrupted',
      'cleanup pending fixture',
      'SAVE_COMMIT_CLEANUP_PENDING',
      true,
      {
        status: 'succeeded',
        backupId: 'tx-55555555-5555-4555-8555-555555555555',
        protectionBackupId: 'tx-44444444-4444-4444-8444-444444444444',
        pairBytes: 2048,
        rollback: 'not-required',
        reused: false,
        auditStored: true,
        cleanupPending: true,
        maintenanceRequired: true
      }
    )

    expect(() => database.requeueSaveRunForReconciliation(
      created.job.id, 'stale-revision', 'Administrator', 'committed-cleanup', 'reconcile fixture'
    )).toThrow(/conflict/i)
    const requeued = database.requeueSaveRunForReconciliation(
      created.job.id,
      completed.run.updatedAt,
      'Administrator',
      'committed-cleanup',
      'reconcile fixture'
    )
    expect(requeued).toMatchObject({
      reused: false,
      job: { state: 'queued', errorCode: null },
      run: {
        state: 'queued', recoveryRequired: true, attemptCount: 1,
        result: { cleanupPending: true, maintenanceRequired: true }
      }
    })
    expect(database.getLatestSaveReconciliationReason(created.job.id)).toBe('committed-cleanup')
    expect(database.requeueSaveRunForReconciliation(
      created.job.id,
      completed.run.updatedAt,
      'Administrator',
      'committed-cleanup',
      'reconcile fixture'
    ).reused).toBe(true)
    expect(() => database.requeueSaveRunForReconciliation(
      created.job.id,
      completed.run.updatedAt,
      'bad\nactor',
      'committed-cleanup',
      'reconcile fixture'
    )).toThrow(/audit input is invalid/)
    database.close()

    const raw = new DatabaseSync(join(directory, 'control.db'), { readOnly: true })
    const receipts = raw.prepare(`
      SELECT actor, reason, sequence FROM save_reconciliation_receipts WHERE job_id = ?
    `).all(created.job.id)
    raw.close()
    expect(receipts).toEqual([{ actor: 'Administrator', reason: 'committed-cleanup', sequence: 1 }])
  })

  it('grants a queued save execution claim to only one database connection', () => {
    const directory = temporaryDirectory()
    const first = new ControlDatabase(directory)
    const created = first.createSaveJob({
      operation: 'backup',
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
      saveName: '_lastexit_',
      backupId: null,
      expectedRevision: null,
      protectionRequestId: null
    }, 'Administrator', 'queued fixture')
    const second = new ControlDatabase(directory)
    const observedBySecond = second.getSaveRun(created.job.id)
    if (!observedBySecond) throw new Error('fixture save run missing')

    expect(first.claimQueuedSaveRun(
      created.job.id, created.run.updatedAt, 'claimed by first'
    )).toMatchObject({ run: { state: 'running', attemptCount: 1 } })
    expect(second.claimQueuedSaveRun(
      created.job.id, observedBySecond.updatedAt, 'claimed by second'
    )).toBeNull()
    expect(second.getSaveRun(created.job.id)).toMatchObject({
      state: 'running', attemptCount: 1
    })
    first.close()
    second.close()
  })

  it('fails closed when a trigger is attached to reconciliation authorization receipts', () => {
    const directory = temporaryDirectory()
    const database = new ControlDatabase(directory)
    database.close()
    const tampered = new DatabaseSync(join(directory, 'control.db'))
    tampered.exec(`
      CREATE TRIGGER fixture_save_reconciliation_trigger
      AFTER INSERT ON save_reconciliation_receipts
      BEGIN
        UPDATE save_runs SET recovery_required = 0 WHERE job_id = NEW.job_id;
      END;
    `)
    tampered.close()

    expect(() => new ControlDatabase(directory)).toThrow('Save reconciliation schema is invalid')
  })
})

it('closes only interrupted rollback audit attempts across restart without inventing success', () => {
  const directory = temporaryDirectory()
  let database = new ControlDatabase(directory)
  const original = database.createJob('component.rollback', 'Administrator', 'request: fictional-rollback')
  database.updateJob(original.id, { state: 'running', startedAt: '2026-01-01T00:00:00.000Z' })
  const other = database.createJob('status.refresh', 'Operator', 'unrelated')
  const completed = database.createJob('component.rollback.recovery', 'Administrator', 'completed')
  database.updateJob(completed.id, { state: 'succeeded', finishedAt: '2026-01-01T00:01:00.000Z' })
  database.close()
  database = new ControlDatabase(directory)
  database.reconcileInterruptedRollbackAudits()
  const interrupted = database.getJob(original.id)
  expect(interrupted).toMatchObject({ actor: 'Administrator', summary: original.summary,
    state: 'failed', errorCode: 'UPDATE_ROLLBACK_AUDIT_INTERRUPTED', durationMs: null })
  expect(interrupted?.finishedAt).toBeTruthy()
  expect(database.getJob(other.id)?.state).toBe('queued')
  expect(database.getJob(completed.id)?.state).toBe('succeeded')
  database.reconcileInterruptedRollbackAudits()
  expect(database.getJob(original.id)).toEqual(interrupted)
  database.close()
})

it('persists append-only cleanup progress and identity across reopen', () => {
  const directory = temporaryDirectory()
  const requestId = '11111111-1111-4111-8111-111111111111'
  const plan = createRecoverableCleanupPlan({ format: 'dyson-recoverable-component-cleanup-plan', schemaVersion: 1, requestId,
    expectedRevision: 'a'.repeat(64), candidates: [{ kind: 'history', opaqueId: '22222222-2222-4222-8222-222222222222', sha256: 'b'.repeat(64), sizeBytes: 1 }] })
  const initial = { format: 'dyson-recoverable-cleanup-journal', schemaVersion: 1, requestId, plan,
    actor: 'Administrator', direction: 'quarantine', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: null, state: 'running', completedCount: 0 }
  let db = new ControlDatabase(directory)
  db.appendCleanupJournal(initial)
  db.close()
  db = new ControlDatabase(directory)
  expect(db.loadCleanupJournal(requestId)).toEqual(initial)
  expect(db.listCleanupJournals().filter(journal => journal.state === 'running')).toEqual([initial])
  expect(() => db.appendCleanupJournal({ ...initial, completedCount: 1, actor: 'Operator' })).toThrow()
  db.appendCleanupJournal({ ...initial, completedCount: 1 })
  const terminal = { ...initial, completedCount: 1, state: 'completed', finishedAt: '2026-01-01T00:00:01.000Z' }
  db.appendCleanupJournal(terminal)
  db.appendCleanupJournal(terminal)
  expect(db.loadCleanupJournal(requestId)).toEqual(terminal)
  expect(db.listCleanupJournals()).toEqual([terminal])
  expect(db.listCleanupJournals().filter(journal => journal.state === 'running')).toEqual([])
  expect(() => db.appendCleanupJournal(initial)).toThrow()
  db.close()
})

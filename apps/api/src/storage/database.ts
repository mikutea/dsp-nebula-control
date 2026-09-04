import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  JobKind,
  JobRecord,
  JobState,
  LifecycleAction,
  LifecycleEvidence,
  LifecycleExecutionPhase,
  LifecycleReceiptRecord,
  LifecycleReceiptState,
  LifecycleRunRecord,
  LifecycleRunState
} from '../domain.js'
import type {
  PersistedSaveJobRequest,
  SaveJobErrorCode,
  SaveJobOperation,
  SaveJobReconciliationReason,
  SaveJobResultSummary,
  SaveJobRunState,
  StoredSaveJobRun
} from '../saves/job-types.js'
import type { SaveTransactionErrorCode, SaveTransactionStatus } from '../saves/transactions.js'
import type {
  LifecycleBackupProtectionRecord,
  SaveRestoreBackupProtectionRecord
} from '../saves/retention-protection-source.js'
import type { ControlRole } from '../security/authorization.js'
import type {
  ObservabilityAlertStateStore,
  StoredObservabilityAlertState
} from '../observability/persistent-alerts.js'
import { PlayerSnapshotError } from '../players/protocol.js'
import {
  validatePlayerPresencePersistenceMetadata,
  validatePlayerPresencePersistenceState
} from '../players/history.js'

const MAX_RETENTION_PROTECTION_RECORDS = 20_000
const MAX_LIFECYCLE_PROTECTION_RECEIPTS = 32
import type {
  PlayerPresenceEventDraft,
  PlayerPresenceHistoryPersistence,
  PlayerPresenceHistoryPersistenceState,
  StoredPlayerPresenceEventRow
} from '../players/history.js'

interface SessionRow {
  username: string
  role: ControlRole
  expires_at: string
}

interface JobRow {
  id: string
  kind: JobKind
  state: JobState
  actor: string
  created_at: string
  started_at: string | null
  finished_at: string | null
  duration_ms: number | null
  summary: string
  error_code: string | null
}

export interface JobPageCursor {
  createdAt: string
  id: string
}

export interface JobPageQuery {
  limit: number
  cursor: JobPageCursor | null
  kind: JobKind | null
  state: JobState | null
}

export interface StoredJobPage {
  items: JobRecord[]
  nextCursor: JobPageCursor | null
}

interface LifecycleRunRow {
  job_id: string
  action: LifecycleAction
  idempotency_key: string
  request_id: string
  state: LifecycleRunState
  current_phase: LifecycleExecutionPhase | null
  protection_point_id: string | null
  recovery_required: number
  created_at: string
  updated_at: string
}

interface LifecycleReceiptRow {
  id: string
  job_id: string
  sequence: number
  phase: LifecycleExecutionPhase
  state: LifecycleReceiptState
  started_at: string
  finished_at: string | null
  summary: string
  error_code: string | null
  evidence_json: string
}

interface SaveRunRow {
  job_id: string
  operation: SaveJobOperation
  idempotency_key: string
  save_name: string | null
  backup_id: string | null
  expected_revision: string | null
  protection_request_id: string | null
  state: SaveJobRunState
  attempt_count: number
  result_status: SaveTransactionStatus | null
  result_backup_id: string | null
  result_protection_backup_id: string | null
  result_pair_bytes: number | null
  result_rollback: SaveJobResultSummary['rollback'] | null
  result_reused: number | null
  audit_stored: number | null
  result_cleanup_pending: number | null
  result_maintenance_required: number | null
  error_code: SaveTransactionErrorCode | SaveJobErrorCode | null
  recovery_required: number
  created_at: string
  updated_at: string
}

interface LifecycleProtectionRow extends LifecycleRunRow {
  job_kind: JobKind | null
  job_state: JobState | null
  job_started_at: string | null
  job_finished_at: string | null
  job_duration_ms: number | null
  job_error_code: string | null
  receipt_count: number
  invalid_receipt_count: number
  failed_receipt_count: number
  receipt_min_sequence: number | null
  receipt_max_sequence: number | null
  receipt_phase_sequence: string | null
}

interface SaveProtectionRow extends SaveRunRow {
  job_kind: JobKind | null
  job_state: JobState | null
  job_started_at: string | null
  job_finished_at: string | null
  job_duration_ms: number | null
  job_error_code: string | null
}

interface PlayerPresenceStateRow {
  singleton_id: number
  schema_version: number
  projection_json: string | null
  cursor_json: string
}

interface ObservabilityAlertStateRow {
  singleton_id: number
  schema_version: number
  revision: number
  payload_json: string
}

interface SqliteTableColumn {
  name: string
  type: string
  notnull: number
  pk: number
}

export class ControlDatabase implements PlayerPresenceHistoryPersistence, ObservabilityAlertStateStore {
  readonly #database: DatabaseSync
  #playerPresenceCheckpointRequired = true

  constructor(dataDirectory: string, inMemory = false) {
    fs.mkdirSync(dataDirectory, { recursive: true })
    this.#database = new DatabaseSync(inMemory ? ':memory:' : path.join(dataDirectory, 'control.db'))
    this.#database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;')
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'administrator'
          CHECK(role IN ('viewer', 'operator', 'administrator')),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        duration_ms INTEGER,
        summary TEXT NOT NULL,
        error_code TEXT
      );
      CREATE INDEX IF NOT EXISTS jobs_created_at_idx ON jobs(created_at DESC);
      CREATE INDEX IF NOT EXISTS jobs_created_at_id_idx ON jobs(created_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS lifecycle_runs (
        job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        request_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        current_phase TEXT,
        protection_point_id TEXT,
        recovery_required INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lifecycle_receipts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES lifecycle_runs(job_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        phase TEXT NOT NULL,
        state TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        summary TEXT NOT NULL,
        error_code TEXT,
        evidence_json TEXT NOT NULL,
        UNIQUE(job_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS lifecycle_receipts_job_idx
        ON lifecycle_receipts(job_id, sequence);
      CREATE INDEX IF NOT EXISTS lifecycle_runs_created_job_idx
        ON lifecycle_runs(created_at, job_id);
      CREATE TABLE IF NOT EXISTS lifecycle_locks (
        name TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES lifecycle_runs(job_id) ON DELETE CASCADE,
        acquired_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS save_runs (
        job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
        operation TEXT NOT NULL CHECK(operation IN ('backup', 'restore')),
        idempotency_key TEXT NOT NULL UNIQUE,
        save_name TEXT,
        backup_id TEXT,
        expected_revision TEXT,
        protection_request_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'succeeded', 'failed', 'interrupted')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
        result_status TEXT CHECK(result_status IS NULL OR result_status IN (
          'dry-run', 'succeeded', 'busy', 'rejected', 'revision-conflict',
          'failed', 'rolled-back', 'rollback-failed'
        )),
        result_backup_id TEXT,
        result_protection_backup_id TEXT,
        result_pair_bytes INTEGER CHECK(result_pair_bytes IS NULL OR result_pair_bytes >= 0),
        result_rollback TEXT CHECK(result_rollback IS NULL OR result_rollback IN ('not-required', 'succeeded', 'failed')),
        result_reused INTEGER CHECK(result_reused IS NULL OR result_reused IN (0, 1)),
        audit_stored INTEGER CHECK(audit_stored IS NULL OR audit_stored IN (0, 1)),
        result_cleanup_pending INTEGER CHECK(result_cleanup_pending IS NULL OR result_cleanup_pending IN (0, 1)),
        result_maintenance_required INTEGER CHECK(result_maintenance_required IS NULL OR result_maintenance_required IN (0, 1)),
        error_code TEXT,
        recovery_required INTEGER NOT NULL DEFAULT 0 CHECK(recovery_required IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(
          (operation = 'backup' AND save_name IS NOT NULL AND backup_id IS NULL
            AND expected_revision IS NULL AND protection_request_id IS NULL)
          OR
          (operation = 'restore' AND save_name IS NULL AND backup_id IS NOT NULL
            AND expected_revision IS NOT NULL AND protection_request_id IS NOT NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS save_runs_state_created_idx
        ON save_runs(state, created_at);
      CREATE INDEX IF NOT EXISTS save_runs_operation_created_job_idx
        ON save_runs(operation, created_at, job_id);
      CREATE TABLE IF NOT EXISTS save_reconciliation_receipts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES save_runs(job_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK(sequence >= 1),
        actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 128),
        reason TEXT NOT NULL CHECK(reason IN (
          'committed-cleanup', 'audit-repair', 'rolled-back-cleanup'
        )),
        requested_at TEXT NOT NULL,
        UNIQUE(job_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS save_reconciliation_receipts_job_idx
        ON save_reconciliation_receipts(job_id, sequence);
      CREATE TABLE IF NOT EXISTS observability_samples (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        observed_at TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK(length(payload_json) BETWEEN 2 AND 262144)
      );
      CREATE INDEX IF NOT EXISTS observability_samples_sequence_idx
        ON observability_samples(sequence DESC);
      CREATE TABLE IF NOT EXISTS observability_long_samples (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        observed_at TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK(length(payload_json) BETWEEN 2 AND 65536)
      );
      CREATE INDEX IF NOT EXISTS observability_long_samples_sequence_idx
        ON observability_long_samples(sequence DESC);
      CREATE TABLE IF NOT EXISTS observability_alert_state (
        singleton_id INTEGER PRIMARY KEY NOT NULL CHECK(singleton_id = 1),
        schema_version INTEGER NOT NULL CHECK(schema_version = 1),
        revision INTEGER NOT NULL CHECK(revision >= 1),
        payload_json TEXT NOT NULL CHECK(length(payload_json) BETWEEN 2 AND 4194304)
      );
    `)
    const sessionColumns = this.#database.prepare(
      'PRAGMA table_info(sessions)'
    ).all() as unknown as Array<{ name: string }>
    if (!sessionColumns.some((column) => column.name === 'role')) {
      this.#database.exec(
        "ALTER TABLE sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'administrator' " +
        "CHECK(role IN ('viewer', 'operator', 'administrator'))"
      )
    }
    const saveRunColumns = this.#database.prepare(
      'PRAGMA table_info(save_runs)'
    ).all() as unknown as Array<{ name: string }>
    if (!saveRunColumns.some((column) => column.name === 'result_cleanup_pending')) {
      this.#database.exec(
        'ALTER TABLE save_runs ADD COLUMN result_cleanup_pending INTEGER ' +
        'CHECK(result_cleanup_pending IS NULL OR result_cleanup_pending IN (0, 1))'
      )
    }
    if (!saveRunColumns.some((column) => column.name === 'result_maintenance_required')) {
      this.#database.exec(
        'ALTER TABLE save_runs ADD COLUMN result_maintenance_required INTEGER ' +
        'CHECK(result_maintenance_required IS NULL OR result_maintenance_required IN (0, 1))'
      )
    }
    this.#database.exec(`
      UPDATE save_runs
      SET result_cleanup_pending = CASE
        WHEN error_code IN ('SAVE_COMMIT_CLEANUP_PENDING', 'SAVE_ROLLBACK_CLEANUP_PENDING')
          THEN 1 ELSE 0 END
      WHERE result_status IS NOT NULL AND result_cleanup_pending IS NULL;
      UPDATE save_runs
      SET result_maintenance_required = CASE
        WHEN recovery_required = 1 OR result_status = 'rollback-failed' THEN 1 ELSE 0 END
      WHERE result_status IS NOT NULL AND result_maintenance_required IS NULL;
    `)
    try {
      this.#assertSaveReconciliationSchema()
    } catch (error) {
      this.#database.close()
      throw error
    }
    try {
      this.#assertObservabilityAlertSchema()
    } catch (error) {
      this.#database.close()
      throw error
    }
    try {
      this.#initializePlayerPresenceSchema()
    } catch (error) {
      this.#database.close()
      if (error instanceof PlayerSnapshotError) throw error
      throw new PlayerSnapshotError('PLAYER_HISTORY_SCHEMA_INVALID')
    }
  }

  createSession(
    tokenHash: string,
    username: string,
    expiresAt: string,
    role: ControlRole = 'administrator'
  ): void {
    this.#database.prepare(
      'INSERT INTO sessions(token_hash, username, role, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(tokenHash, username, role, expiresAt, new Date().toISOString())
  }

  getSession(tokenHash: string): SessionRow | null {
    const row = this.#database.prepare(
      'SELECT username, role, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?'
    ).get(tokenHash, new Date().toISOString()) as unknown as SessionRow | undefined
    return row ?? null
  }

  deleteSession(tokenHash: string): void {
    this.#database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
  }

  purgeExpiredSessions(): void {
    this.#database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString())
  }

  appendObservabilitySample(observedAt: string, payloadJson: string, capacity: number): void {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 4_096) {
      throw new Error('Observability capacity is invalid')
    }
    if (typeof observedAt !== 'string' || Number.isNaN(Date.parse(observedAt)) || observedAt.length > 64) {
      throw new Error('Observability timestamp is invalid')
    }
    if (typeof payloadJson !== 'string' || Buffer.byteLength(payloadJson, 'utf8') > 256 * 1_024) {
      throw new Error('Observability payload is invalid')
    }
    this.#transaction(() => {
      this.#database.prepare(
        'INSERT INTO observability_samples(observed_at, payload_json) VALUES (?, ?)'
      ).run(observedAt, payloadJson)
      this.#database.prepare(`
        DELETE FROM observability_samples
        WHERE sequence <= COALESCE((
          SELECT sequence FROM observability_samples ORDER BY sequence DESC LIMIT 1 OFFSET ?
        ), -1)
      `).run(capacity)
    })
  }

  appendObservabilitySampleWithLongWindow(
    observedAt: string,
    payloadJson: string,
    capacity: number,
    longPayloadJson: string,
    longCapacity: number
  ): void {
    this.#validateObservabilityWrite(observedAt, payloadJson, capacity)
    if (!Number.isInteger(longCapacity) || longCapacity < 1 || longCapacity > 86_400
        || typeof longPayloadJson !== 'string' || longPayloadJson.includes('\0')
        || Buffer.byteLength(longPayloadJson, 'utf8') < 2
        || Buffer.byteLength(longPayloadJson, 'utf8') > 64 * 1_024) {
      throw new Error('Observability long-window payload is invalid')
    }
    this.#transaction(() => {
      this.#database.prepare(
        'INSERT INTO observability_samples(observed_at, payload_json) VALUES (?, ?)'
      ).run(observedAt, payloadJson)
      this.#database.prepare(`
        DELETE FROM observability_samples
        WHERE sequence <= COALESCE((
          SELECT sequence FROM observability_samples ORDER BY sequence DESC LIMIT 1 OFFSET ?
        ), -1)
      `).run(capacity)
      this.#database.prepare(
        'INSERT INTO observability_long_samples(observed_at, payload_json) VALUES (?, ?)'
      ).run(observedAt, longPayloadJson)
      this.#database.prepare(`
        DELETE FROM observability_long_samples
        WHERE sequence <= COALESCE((
          SELECT sequence FROM observability_long_samples ORDER BY sequence DESC LIMIT 1 OFFSET ?
        ), -1)
      `).run(longCapacity)
    })
  }

  listObservabilitySamples(capacity: number): string[] {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 4_096) {
      throw new Error('Observability capacity is invalid')
    }
    const rows = this.#database.prepare(`
      SELECT payload_json FROM (
        SELECT sequence, payload_json
        FROM observability_samples
        ORDER BY sequence DESC
        LIMIT ?
      )
      ORDER BY sequence ASC
    `).all(capacity) as unknown as Array<{ payload_json: string }>
    return rows.map((row) => row.payload_json)
  }

  listObservabilityLongSamples(capacity: number): string[] {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 86_400) {
      throw new Error('Observability long-window capacity is invalid')
    }
    const rows = this.#database.prepare(`
      SELECT payload_json FROM (
        SELECT sequence, payload_json
        FROM observability_long_samples
        ORDER BY sequence DESC
        LIMIT ?
      )
      ORDER BY sequence ASC
    `).all(capacity) as unknown as Array<{ payload_json: string }>
    return rows.map((row) => row.payload_json)
  }

  read(): StoredObservabilityAlertState | null {
    this.#assertObservabilityAlertSchema()
    const rows = this.#database.prepare(`
      SELECT singleton_id, schema_version, revision, payload_json
      FROM observability_alert_state ORDER BY singleton_id ASC
    `).all() as unknown as ObservabilityAlertStateRow[]
    if (rows.length === 0) return null
    const row = rows[0]
    if (rows.length !== 1 || !row || row.singleton_id !== 1 || row.schema_version !== 1 ||
        !Number.isSafeInteger(row.revision) || row.revision < 1 ||
        typeof row.payload_json !== 'string' || row.payload_json.includes('\0') ||
        Buffer.byteLength(row.payload_json, 'utf8') < 2 ||
        Buffer.byteLength(row.payload_json, 'utf8') > 4 * 1_024 * 1_024) {
      throw new Error('Observability alert state is invalid')
    }
    return { revision: row.revision, payload: row.payload_json }
  }

  write(expectedRevision: number | null, payload: string): number {
    if ((expectedRevision !== null &&
        (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) ||
        typeof payload !== 'string' || payload.includes('\0') ||
        Buffer.byteLength(payload, 'utf8') < 2 ||
        Buffer.byteLength(payload, 'utf8') > 4 * 1_024 * 1_024) {
      throw new Error('Observability alert persistence request is invalid')
    }
    return this.#transaction(() => {
      this.#assertObservabilityAlertSchema()
      let revision: number
      if (expectedRevision === null) {
        const result = this.#database.prepare(`
          INSERT INTO observability_alert_state(
            singleton_id, schema_version, revision, payload_json
          ) VALUES (1, 1, 1, ?)
          ON CONFLICT(singleton_id) DO NOTHING
        `).run(payload)
        if (Number(result.changes) !== 1) throw new Error('Observability alert revision conflict')
        revision = 1
      } else {
        const result = this.#database.prepare(`
          UPDATE observability_alert_state
          SET revision = revision + 1, payload_json = ?
          WHERE singleton_id = 1 AND schema_version = 1 AND revision = ?
        `).run(payload, expectedRevision)
        if (Number(result.changes) !== 1) throw new Error('Observability alert revision conflict')
        revision = expectedRevision + 1
      }
      const stored = this.read()
      if (stored === null || stored.revision !== revision || stored.payload !== payload) {
        throw new Error('Observability alert persistence verification failed')
      }
      return revision
    })
  }

  loadPlayerPresenceHistory(): PlayerPresenceHistoryPersistenceState {
    const state = this.#readPlayerPresenceHistory()
    validatePlayerPresencePersistenceState(state)
    return state
  }

  prunePlayerPresenceHistory(
    capacity: number,
    cutoffUnixMs: number
  ): PlayerPresenceHistoryPersistenceState {
    this.#assertPlayerPresenceRetention(capacity, cutoffUnixMs)
    const result = this.#transaction(() => {
      validatePlayerPresencePersistenceState(this.#readPlayerPresenceHistory())
      const deletedRows = this.#prunePlayerPresenceRows(capacity, cutoffUnixMs)
      const state = this.#readPlayerPresenceHistory()
      validatePlayerPresencePersistenceState(state)
      return { state, deletedRows }
    })
    if (result.deletedRows > 0) this.#playerPresenceCheckpointRequired = true
    this.#checkpointPlayerPresenceRetention()
    return result.state
  }

  commitPlayerPresenceHistory(input: {
    expectedProjectionJson: string | null
    expectedCursorJson: string
    projectionJson: string | null
    cursorJson: string
    events: PlayerPresenceEventDraft[]
    capacity: number
    cutoffUnixMs: number
  }): PlayerPresenceHistoryPersistenceState & { insertedHistorySequences: number[] } {
    this.#assertPlayerPresenceRetention(input.capacity, input.cutoffUnixMs)
    if (!isBoundedNullableJson(input.expectedProjectionJson, 32_768) ||
        typeof input.expectedCursorJson !== 'string' || input.expectedCursorJson.includes('\0') ||
        Buffer.byteLength(input.expectedCursorJson, 'utf8') > 8_192 ||
        !isBoundedNullableJson(input.projectionJson, 32_768) ||
        typeof input.cursorJson !== 'string' || input.cursorJson.includes('\0') ||
        Buffer.byteLength(input.cursorJson, 'utf8') > 8_192 ||
        !Array.isArray(input.events) || input.events.length > 128) {
      throw new PlayerSnapshotError('PLAYER_HISTORY_PERSISTENCE_INVALID')
    }
    validatePlayerPresencePersistenceMetadata(input.expectedProjectionJson, input.expectedCursorJson)
    validatePlayerPresencePersistenceMetadata(input.projectionJson, input.cursorJson)
    input.events.forEach((event) => this.#assertPlayerPresenceEventDraft(event))

    const result = this.#transaction(() => {
      const state = this.#database.prepare(`
        SELECT singleton_id, schema_version, projection_json, cursor_json
        FROM player_presence_state WHERE singleton_id = 1
      `).get() as unknown as PlayerPresenceStateRow | undefined
      if (!state || state.schema_version !== 1) {
        throw new PlayerSnapshotError('PLAYER_HISTORY_SCHEMA_INVALID')
      }
      if (state.projection_json !== input.expectedProjectionJson ||
          state.cursor_json !== input.expectedCursorJson) {
        throw new PlayerSnapshotError('PLAYER_HISTORY_STATE_CONFLICT')
      }
      validatePlayerPresencePersistenceState(this.#readPlayerPresenceHistory())

      this.#database.prepare(`
        UPDATE player_presence_state
        SET projection_json = ?, cursor_json = ? WHERE singleton_id = 1
      `).run(input.projectionJson, input.cursorJson)
      const insert = this.#database.prepare(`
        INSERT INTO player_presence_events(
          type, occurred_at_unix_ms, session_id, session_player_id,
          display_name, online, joined_at_unix_ms, location
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const insertedHistorySequences: number[] = []
      for (const event of input.events) {
        const { player } = event
        const result = insert.run(
          event.type,
          event.occurredAtUnixMs,
          event.sessionId,
          player.sessionPlayerId,
          player.displayName,
          player.online ? 1 : 0,
          player.joinedAtUnixMs,
          player.location
        )
        const historySequence = Number(result.lastInsertRowid)
        if (!Number.isSafeInteger(historySequence) || historySequence <= 0) {
          throw new PlayerSnapshotError('PLAYER_HISTORY_PERSISTENCE_INVALID')
        }
        insertedHistorySequences.push(historySequence)
      }
      const deletedRows = this.#prunePlayerPresenceRows(input.capacity, input.cutoffUnixMs)
      const retained = this.#readPlayerPresenceHistory()
      validatePlayerPresencePersistenceState(retained)
      const retainedSequences = new Set(retained.events.map((event) => event.historySequence))
      return { stored: {
          ...retained,
          insertedHistorySequences: insertedHistorySequences.filter((sequence) => retainedSequences.has(sequence))
        }, deletedRows }
    })
    if (result.deletedRows > 0) this.#playerPresenceCheckpointRequired = true
    this.#checkpointPlayerPresenceRetention()
    return result.stored
  }

  createJob(kind: JobKind, actor: string, summary: string): JobRecord {
    const job: JobRecord = {
      id: randomUUID(), kind, state: 'queued', actor,
      createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
      durationMs: null, summary, errorCode: null
    }
    this.#database.prepare(`
      INSERT INTO jobs(id, kind, state, actor, created_at, summary)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(job.id, job.kind, job.state, job.actor, job.createdAt, job.summary)
    return job
  }

  updateJob(id: string, values: Partial<Pick<JobRecord, 'state' | 'startedAt' | 'finishedAt' | 'durationMs' | 'summary' | 'errorCode'>>): JobRecord {
    const current = this.getJob(id)
    if (!current) throw new Error(`Unknown job: ${id}`)
    const next = { ...current, ...values }
    this.#database.prepare(`
      UPDATE jobs SET state = ?, started_at = ?, finished_at = ?, duration_ms = ?, summary = ?, error_code = ?
      WHERE id = ?
    `).run(next.state, next.startedAt, next.finishedAt, next.durationMs, next.summary, next.errorCode, id)
    return next
  }

  getJob(id: string): JobRecord | null {
    const row = this.#database.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as JobRow | undefined
    return row ? this.#toJob(row) : null
  }

  listJobs(limit = 20): JobRecord[] {
    const rows = this.#database.prepare(
      'SELECT * FROM jobs ORDER BY created_at DESC, id DESC LIMIT ?'
    ).all(limit) as unknown as JobRow[]
    return rows.map((row) => this.#toJob(row))
  }

  listJobPage(query: JobPageQuery): StoredJobPage {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 5_000) {
      throw new Error('Invalid job page limit')
    }
    const conditions: string[] = []
    const values: Array<string | number> = []
    if (query.cursor !== null) {
      conditions.push('(created_at < ? OR (created_at = ? AND id < ?))')
      values.push(query.cursor.createdAt, query.cursor.createdAt, query.cursor.id)
    }
    if (query.kind !== null) {
      conditions.push('kind = ?')
      values.push(query.kind)
    }
    if (query.state !== null) {
      conditions.push('state = ?')
      values.push(query.state)
    }
    const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`
    const rows = this.#database.prepare(
      `SELECT * FROM jobs${where} ORDER BY created_at DESC, id DESC LIMIT ?`
    ).all(...values, query.limit + 1) as unknown as JobRow[]
    const hasMore = rows.length > query.limit
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows
    const last = pageRows.at(-1)
    return {
      items: pageRows.map((row) => this.#toJob(row)),
      nextCursor: hasMore && last ? { createdAt: last.created_at, id: last.id } : null
    }
  }

  createSaveJob(
    request: PersistedSaveJobRequest,
    actor: string,
    summary: string
  ): { job: JobRecord; run: StoredSaveJobRun; reused: boolean } {
    return this.#transaction(() => {
      const existing = this.#database.prepare(
        'SELECT * FROM save_runs WHERE idempotency_key = ?'
      ).get(request.idempotencyKey) as unknown as SaveRunRow | undefined
      if (existing) {
        const job = this.getJob(existing.job_id)
        if (!job) throw new Error(`Save job is missing: ${existing.job_id}`)
        return { job, run: this.#toSaveRun(existing), reused: true }
      }

      const job = this.createJob(this.#saveKind(request.operation), actor, summary)
      this.#database.prepare(`
        INSERT INTO save_runs(
          job_id, operation, idempotency_key, save_name, backup_id,
          expected_revision, protection_request_id, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
      `).run(
        job.id, request.operation, request.idempotencyKey, request.saveName,
        request.backupId, request.expectedRevision, request.protectionRequestId,
        job.createdAt, job.createdAt
      )
      const run = this.getSaveRun(job.id)
      if (!run) throw new Error(`Save run was not created: ${job.id}`)
      return { job, run, reused: false }
    })
  }

  getSaveRun(jobId: string): StoredSaveJobRun | null {
    const row = this.#database.prepare(
      'SELECT * FROM save_runs WHERE job_id = ?'
    ).get(jobId) as unknown as SaveRunRow | undefined
    return row ? this.#toSaveRun(row) : null
  }

  listActiveSaveRuns(): StoredSaveJobRun[] {
    const rows = this.#database.prepare(`
      SELECT * FROM save_runs
      WHERE state IN ('queued', 'running')
      ORDER BY created_at ASC, job_id ASC
    `).all() as unknown as SaveRunRow[]
    return rows.map((row) => this.#toSaveRun(row))
  }

  /**
   * Internal retention input. The query deliberately returns only fixed
   * workflow fields; no save path, revision, file content, or actor data is
   * exposed to the protection source.
   */
  listSaveRestoreBackupProtectionRecords(): SaveRestoreBackupProtectionRecord[] {
    const rows = this.#database.prepare(`
      WITH bounded_restore_runs AS MATERIALIZED (
        SELECT job_id
        FROM save_runs INDEXED BY save_runs_operation_created_job_idx
        WHERE operation = 'restore'
        ORDER BY created_at ASC, job_id ASC
        LIMIT ${MAX_RETENTION_PROTECTION_RECORDS + 1}
      )
      SELECT save_runs.*,
             jobs.kind AS job_kind,
             jobs.state AS job_state,
             jobs.started_at AS job_started_at,
             jobs.finished_at AS job_finished_at,
             jobs.duration_ms AS job_duration_ms
             , jobs.error_code AS job_error_code
      FROM bounded_restore_runs
      INNER JOIN save_runs ON save_runs.job_id = bounded_restore_runs.job_id
      LEFT JOIN jobs ON jobs.id = save_runs.job_id
      ORDER BY save_runs.created_at ASC, save_runs.job_id ASC
    `).all() as unknown as SaveProtectionRow[]
    return rows.map((row) => {
      const run = this.#toSaveRun(row)
      const result = run.result
      const jobStateMatches =
        (run.state === 'queued' && row.job_state === 'queued') ||
        (run.state === 'running' && row.job_state === 'running') ||
        (run.state === 'succeeded' && row.job_state === 'succeeded') ||
        ((run.state === 'failed' || run.state === 'interrupted') && row.job_state === 'failed')
      const jobTerminalComplete = row.job_finished_at !== null &&
        row.job_started_at !== null && row.job_duration_ms !== null && row.job_duration_ms >= 0 &&
        row.job_kind === 'save.restore'
      const terminalResultMatchesState = result !== null && (
        (run.state === 'succeeded' && result.status === 'succeeded' && result.rollback === 'not-required') ||
        (run.state === 'failed' &&
          ['busy', 'rejected', 'revision-conflict', 'failed', 'rolled-back'].includes(result.status) &&
          (result.status === 'rolled-back' ? result.rollback === 'succeeded' : result.rollback === 'not-required'))
      )
      const auditComplete = result !== null && (
        !['succeeded', 'rolled-back'].includes(result.status) || result.auditStored
      )
      const protectionIdentityMatches = run.protectionRequestId !== null &&
        row.result_protection_backup_id === `tx-${run.protectionRequestId.toLocaleLowerCase('en-US')}`
      const resultIdentityMatches = run.backupId !== null && row.result_backup_id === run.backupId &&
        Number.isSafeInteger(row.result_pair_bytes) && row.result_pair_bytes !== null && row.result_pair_bytes >= 0 &&
        (row.result_reused === 0 || row.result_reused === 1) &&
        (row.audit_stored === 0 || row.audit_stored === 1) &&
        (row.result_cleanup_pending === 0 || row.result_cleanup_pending === 1) &&
        (row.result_maintenance_required === 0 || row.result_maintenance_required === 1)
      const terminalErrorMatches = run.state === 'succeeded'
        ? run.errorCode === null && row.job_error_code === null
        : run.state === 'failed' && run.errorCode !== null && row.job_error_code === run.errorCode
      return {
        state: run.state,
        protectionRequestId: run.protectionRequestId,
        resultProtectionBackupId: row.result_protection_backup_id,
        recoveryRequired: row.recovery_required !== 0,
        terminalReceiptComplete: (run.state === 'succeeded' || run.state === 'failed') &&
          jobStateMatches && jobTerminalComplete && row.recovery_required === 0 && terminalResultMatchesState &&
          auditComplete && row.result_cleanup_pending === 0 && row.result_maintenance_required === 0 &&
          protectionIdentityMatches && resultIdentityMatches && terminalErrorMatches
      }
    })
  }

  claimQueuedSaveRun(
    jobId: string,
    expectedUpdatedAt: string,
    summary: string,
    reconciling = false
  ): { job: JobRecord; run: StoredSaveJobRun } | null {
    return this.#transaction(() => {
      const currentRun = this.getSaveRun(jobId)
      const currentJob = this.getJob(jobId)
      if (!currentRun || !currentJob) throw new Error(`Save job is missing: ${jobId}`)
      if (currentRun.state !== 'queued' || currentRun.updatedAt !== expectedUpdatedAt) return null
      const now = new Date().toISOString()
      const update = this.#database.prepare(`
        UPDATE save_runs
        SET state = 'running', attempt_count = attempt_count + 1,
            error_code = NULL, recovery_required = ?, updated_at = ?
        WHERE job_id = ? AND state = 'queued' AND updated_at = ?
      `).run(reconciling ? 1 : 0, now, jobId, expectedUpdatedAt)
      if (Number(update.changes) !== 1) return null
      const job = this.updateJob(jobId, {
        state: 'running',
        startedAt: currentJob.startedAt ?? now,
        finishedAt: null,
        durationMs: null,
        summary,
        errorCode: null
      })
      const run = this.getSaveRun(jobId)
      if (!run) throw new Error(`Save run is missing: ${jobId}`)
      return { job, run }
    })
  }

  interruptRunningSaveRun(
    jobId: string,
    expectedUpdatedAt: string,
    summary: string
  ): { job: JobRecord; run: StoredSaveJobRun } | null {
    return this.#transaction(() => {
      const currentRun = this.getSaveRun(jobId)
      const currentJob = this.getJob(jobId)
      if (!currentRun || !currentJob) throw new Error(`Save job is missing: ${jobId}`)
      if (currentRun.state !== 'running' || currentRun.updatedAt !== expectedUpdatedAt) return null
      const finishedAt = new Date()
      const startedAt = currentJob.startedAt ? new Date(currentJob.startedAt) : new Date(currentJob.createdAt)
      const update = this.#database.prepare(`
        UPDATE save_runs
        SET state = 'interrupted', error_code = 'SAVE_JOB_RECONCILIATION_UNCERTAIN',
            recovery_required = 1, updated_at = ?
        WHERE job_id = ? AND state = 'running' AND updated_at = ?
      `).run(finishedAt.toISOString(), jobId, expectedUpdatedAt)
      if (Number(update.changes) !== 1) return null
      const job = this.updateJob(jobId, {
        state: 'failed',
        finishedAt: finishedAt.toISOString(),
        durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        summary,
        errorCode: 'SAVE_JOB_RECONCILIATION_UNCERTAIN'
      })
      const run = this.getSaveRun(jobId)
      if (!run) throw new Error(`Save run is missing: ${jobId}`)
      return { job, run }
    })
  }

  getLatestSaveReconciliationReason(jobId: string): SaveJobReconciliationReason | null {
    const row = this.#database.prepare(`
      SELECT reason FROM save_reconciliation_receipts
      WHERE job_id = ? ORDER BY sequence DESC LIMIT 1
    `).get(jobId) as { reason: SaveJobReconciliationReason } | undefined
    return row?.reason ?? null
  }

  requeueSaveRunForReconciliation(
    jobId: string,
    expectedUpdatedAt: string,
    actor: string,
    reason: SaveJobReconciliationReason,
    summary: string
  ): { job: JobRecord; run: StoredSaveJobRun; reused: boolean } {
    if (typeof actor !== 'string' || actor.length < 1 || actor.length > 128 || /[\r\n\0]/.test(actor) ||
        typeof summary !== 'string' || summary.length < 1 || summary.length > 256 || /[\r\n\0]/.test(summary)) {
      throw new Error('Save reconciliation audit input is invalid')
    }
    return this.#transaction(() => {
      const currentRun = this.getSaveRun(jobId)
      const currentJob = this.getJob(jobId)
      if (!currentRun || !currentJob) throw new Error(`Save job is missing: ${jobId}`)
      if (currentRun.state === 'queued' || currentRun.state === 'running') {
        if (this.getLatestSaveReconciliationReason(jobId) === null) {
          throw new Error(`Save reconciliation conflict: ${jobId}`)
        }
        return { job: currentJob, run: currentRun, reused: true }
      }
      if (currentRun.state !== 'interrupted' || currentRun.updatedAt !== expectedUpdatedAt) {
        throw new Error(`Save reconciliation conflict: ${jobId}`)
      }
      const requestedAt = new Date().toISOString()
      const sequenceRow = this.#database.prepare(`
        SELECT COALESCE(MAX(sequence), 0) AS sequence
        FROM save_reconciliation_receipts WHERE job_id = ?
      `).get(jobId) as { sequence: number }
      this.#database.prepare(`
        INSERT INTO save_reconciliation_receipts(
          id, job_id, sequence, actor, reason, requested_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), jobId, sequenceRow.sequence + 1, actor, reason, requestedAt)
      const job = this.updateJob(jobId, {
        state: 'queued', startedAt: null, finishedAt: null, durationMs: null,
        summary, errorCode: null
      })
      this.#database.prepare(`
        UPDATE save_runs SET state = 'queued', error_code = NULL,
          recovery_required = 1, updated_at = ? WHERE job_id = ?
      `).run(requestedAt, jobId)
      const run = this.getSaveRun(jobId)
      if (!run) throw new Error(`Save run is missing: ${jobId}`)
      return { job, run, reused: false }
    })
  }

  completeSaveRun(
    jobId: string,
    state: Extract<SaveJobRunState, 'succeeded' | 'failed' | 'interrupted'>,
    summary: string,
    errorCode: SaveTransactionErrorCode | SaveJobErrorCode | null,
    recoveryRequired: boolean,
    result: SaveJobResultSummary | null
  ): { job: JobRecord; run: StoredSaveJobRun } {
    return this.#transaction(() => {
      const currentRun = this.getSaveRun(jobId)
      const currentJob = this.getJob(jobId)
      if (!currentRun || !currentJob) throw new Error(`Save job is missing: ${jobId}`)
      if (!['queued', 'running'].includes(currentRun.state)) {
        throw new Error(`Save job is already terminal: ${jobId}`)
      }
      const finishedAt = new Date()
      const startedAt = currentJob.startedAt ? new Date(currentJob.startedAt) : new Date(currentJob.createdAt)
      const job = this.updateJob(jobId, {
        state: state === 'succeeded' ? 'succeeded' : 'failed',
        finishedAt: finishedAt.toISOString(),
        durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        summary,
        errorCode
      })
      this.#database.prepare(`
        UPDATE save_runs SET
          state = ?, result_status = ?, result_backup_id = ?,
          result_protection_backup_id = ?, result_pair_bytes = ?,
          result_rollback = ?, result_reused = ?, audit_stored = ?,
          result_cleanup_pending = ?, result_maintenance_required = ?,
          error_code = ?, recovery_required = ?, updated_at = ?
        WHERE job_id = ?
      `).run(
        state,
        result?.status ?? null,
        result?.backupId ?? null,
        result?.protectionBackupId ?? null,
        result?.pairBytes ?? null,
        result?.rollback ?? null,
        result === null ? null : result.reused ? 1 : 0,
        result === null ? null : result.auditStored ? 1 : 0,
        result === null ? null : result.cleanupPending ? 1 : 0,
        result === null ? null : result.maintenanceRequired ? 1 : 0,
        errorCode,
        recoveryRequired ? 1 : 0,
        finishedAt.toISOString(),
        jobId
      )
      const run = this.getSaveRun(jobId)
      if (!run) throw new Error(`Save run is missing: ${jobId}`)
      return { job, run }
    })
  }

  createLifecycleJob(
    action: LifecycleAction,
    idempotencyKey: string,
    actor: string,
    summary: string
  ): { job: JobRecord; run: LifecycleRunRecord; reused: boolean } {
    return this.#transaction(() => {
      const existing = this.#database.prepare(
        'SELECT * FROM lifecycle_runs WHERE idempotency_key = ?'
      ).get(idempotencyKey) as unknown as LifecycleRunRow | undefined
      if (existing) {
        const job = this.getJob(existing.job_id)
        if (!job) throw new Error(`Lifecycle job is missing: ${existing.job_id}`)
        return { job, run: this.#toLifecycleRun(existing), reused: true }
      }

      const job = this.createJob(this.#executionKind(action), actor, summary)
      const now = job.createdAt
      const requestId = randomUUID()
      this.#database.prepare(`
        INSERT INTO lifecycle_runs(
          job_id, action, idempotency_key, request_id, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'queued', ?, ?)
      `).run(job.id, action, idempotencyKey, requestId, now, now)
      const run = this.getLifecycleRun(job.id)
      if (!run) throw new Error(`Lifecycle run was not created: ${job.id}`)
      return { job, run, reused: false }
    })
  }

  getLifecycleRun(jobId: string): LifecycleRunRecord | null {
    const row = this.#database.prepare(
      'SELECT * FROM lifecycle_runs WHERE job_id = ?'
    ).get(jobId) as unknown as LifecycleRunRow | undefined
    return row ? this.#toLifecycleRun(row) : null
  }

  listLifecycleReceipts(jobId: string): LifecycleReceiptRecord[] {
    const rows = this.#database.prepare(
      'SELECT * FROM lifecycle_receipts WHERE job_id = ? ORDER BY sequence ASC'
    ).all(jobId) as unknown as LifecycleReceiptRow[]
    return rows.map((row) => this.#toLifecycleReceipt(row))
  }

  /** Fixed-column lifecycle protection records consumed by backup retention. */
  listLifecycleBackupProtectionRecords(): LifecycleBackupProtectionRecord[] {
    const rows = this.#database.prepare(`
      WITH bounded_lifecycle_runs AS MATERIALIZED (
        SELECT job_id
        FROM lifecycle_runs INDEXED BY lifecycle_runs_created_job_idx
        ORDER BY created_at ASC, job_id ASC
        LIMIT ${MAX_RETENTION_PROTECTION_RECORDS + 1}
      )
      SELECT lifecycle_runs.*,
             jobs.kind AS job_kind,
             jobs.state AS job_state,
             jobs.started_at AS job_started_at,
             jobs.finished_at AS job_finished_at,
             jobs.duration_ms AS job_duration_ms,
             jobs.error_code AS job_error_code,
             COUNT(lifecycle_receipts.id) AS receipt_count,
             COALESCE(SUM(CASE
                WHEN lifecycle_receipts.id IS NOT NULL AND (
                     lifecycle_receipts.state NOT IN ('succeeded', 'failed') OR
                     lifecycle_receipts.finished_at IS NULL OR
                     (lifecycle_receipts.state = 'succeeded' AND lifecycle_receipts.error_code IS NOT NULL) OR
                     (lifecycle_receipts.state = 'failed' AND lifecycle_receipts.error_code IS NULL)
                )
                 THEN 1 ELSE 0 END), 0) AS invalid_receipt_count
             , COALESCE(SUM(CASE
                 WHEN lifecycle_receipts.state = 'failed' THEN 1 ELSE 0 END), 0) AS failed_receipt_count
             , (SELECT sequence
                  FROM lifecycle_receipts AS first_receipt
                 WHERE first_receipt.job_id = lifecycle_runs.job_id
                 ORDER BY sequence ASC LIMIT 1) AS receipt_min_sequence
             , (SELECT sequence
                  FROM lifecycle_receipts AS last_receipt
                 WHERE last_receipt.job_id = lifecycle_runs.job_id
                 ORDER BY sequence DESC LIMIT 1) AS receipt_max_sequence
             , (SELECT GROUP_CONCAT(phase, '|')
                  FROM (
                    SELECT phase
                      FROM lifecycle_receipts AS ordered_receipt
                     WHERE ordered_receipt.job_id = lifecycle_runs.job_id
                       AND ordered_receipt.sequence BETWEEN 1 AND ${MAX_LIFECYCLE_PROTECTION_RECEIPTS + 1}
                     ORDER BY sequence ASC
                  )) AS receipt_phase_sequence
      FROM bounded_lifecycle_runs
      INNER JOIN lifecycle_runs ON lifecycle_runs.job_id = bounded_lifecycle_runs.job_id
      LEFT JOIN jobs ON jobs.id = lifecycle_runs.job_id
      LEFT JOIN lifecycle_receipts
        ON lifecycle_receipts.job_id = lifecycle_runs.job_id
       AND lifecycle_receipts.sequence BETWEEN 1 AND ${MAX_LIFECYCLE_PROTECTION_RECEIPTS + 1}
      GROUP BY lifecycle_runs.job_id
      ORDER BY lifecycle_runs.created_at ASC, lifecycle_runs.job_id ASC
    `).all() as unknown as LifecycleProtectionRow[]
    return rows.map((row) => {
      const jobStateMatches =
        (row.state === 'queued' && row.job_state === 'queued') ||
        (row.state === 'running' && row.job_state === 'running') ||
        (row.state === 'succeeded' && row.job_state === 'succeeded') ||
        ((row.state === 'failed' || row.state === 'interrupted') && row.job_state === 'failed')
      const receiptSequenceComplete = row.receipt_count > 0 &&
        row.receipt_count <= MAX_LIFECYCLE_PROTECTION_RECEIPTS &&
        row.receipt_min_sequence === 1 && row.receipt_max_sequence === row.receipt_count
      const expectedSuccessfulPhases: Record<LifecycleAction, string> = {
        start: 'lock|preflight|start|verify-running',
        save: 'lock|preflight|protection-point|save',
        'graceful-stop': 'lock|preflight|protection-point|save|stop|verify-stopped',
        restart: 'lock|preflight|protection-point|save|stop|verify-stopped|start|verify-running'
      }
      const expectedJobKinds: Record<LifecycleAction, JobKind> = {
        start: 'game.start',
        save: 'game.save',
        'graceful-stop': 'game.stop',
        restart: 'game.restart'
      }
      return {
        requestId: row.request_id,
        action: row.action,
        state: row.state,
        protectionPointId: row.protection_point_id,
        recoveryRequired: row.recovery_required === 1,
        // Failed lifecycle transactions are retained conservatively. Their
        // rollback paths are action/phase dependent and cannot be reduced to
        // a count of terminal rows without losing crash-window evidence.
        terminalReceiptComplete: row.state === 'succeeded' &&
          row.recovery_required === 0 && jobStateMatches && row.job_finished_at !== null &&
          row.job_started_at !== null && row.job_duration_ms !== null && row.job_duration_ms >= 0 &&
          row.job_kind === expectedJobKinds[row.action] && receiptSequenceComplete &&
          row.job_error_code === null && row.invalid_receipt_count === 0 && row.failed_receipt_count === 0 &&
          row.receipt_phase_sequence === expectedSuccessfulPhases[row.action]
      }
    })
  }

  markLifecycleRunRunning(jobId: string, summary: string): { job: JobRecord; run: LifecycleRunRecord } {
    return this.#transaction(() => {
      const startedAt = new Date().toISOString()
      const job = this.updateJob(jobId, { state: 'running', startedAt, summary, errorCode: null })
      this.#database.prepare(`
        UPDATE lifecycle_runs SET state = 'running', updated_at = ? WHERE job_id = ?
      `).run(startedAt, jobId)
      const run = this.getLifecycleRun(jobId)
      if (!run) throw new Error(`Lifecycle run is missing: ${jobId}`)
      return { job, run }
    })
  }

  tryAcquireLifecycleLock(jobId: string): boolean {
    return this.#transaction(() => {
      const existing = this.#database.prepare(
        "SELECT job_id FROM lifecycle_locks WHERE name = 'global'"
      ).get() as unknown as { job_id: string } | undefined
      if (existing) return existing.job_id === jobId
      this.#database.prepare(`
        INSERT INTO lifecycle_locks(name, job_id, acquired_at) VALUES ('global', ?, ?)
      `).run(jobId, new Date().toISOString())
      return true
    })
  }

  isLifecycleLockAvailable(): boolean {
    const existing = this.#database.prepare(
      "SELECT job_id FROM lifecycle_locks WHERE name = 'global'"
    ).get() as unknown as { job_id: string } | undefined
    return !existing
  }

  startLifecyclePhase(
    jobId: string,
    phase: LifecycleExecutionPhase,
    summary: string
  ): LifecycleReceiptRecord {
    return this.#transaction(() => {
      const active = this.#database.prepare(`
        SELECT id FROM lifecycle_receipts WHERE job_id = ? AND state = 'running'
      `).get(jobId) as unknown as { id: string } | undefined
      if (active) throw new Error(`Lifecycle phase is already running: ${active.id}`)
      const sequenceRow = this.#database.prepare(`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
        FROM lifecycle_receipts WHERE job_id = ?
      `).get(jobId) as unknown as { next_sequence: number }
      const receipt: LifecycleReceiptRecord = {
        id: randomUUID(),
        jobId,
        sequence: sequenceRow.next_sequence,
        phase,
        state: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        summary,
        errorCode: null,
        evidence: {}
      }
      this.#database.prepare(`
        INSERT INTO lifecycle_receipts(
          id, job_id, sequence, phase, state, started_at, summary, evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        receipt.id, receipt.jobId, receipt.sequence, receipt.phase, receipt.state,
        receipt.startedAt, receipt.summary, '{}'
      )
      this.#database.prepare(`
        UPDATE lifecycle_runs SET current_phase = ?, updated_at = ? WHERE job_id = ?
      `).run(phase, receipt.startedAt, jobId)
      return receipt
    })
  }

  finishLifecyclePhase(
    receiptId: string,
    state: Exclude<LifecycleReceiptState, 'running'>,
    summary: string,
    errorCode: string | null,
    evidence: LifecycleEvidence
  ): LifecycleReceiptRecord {
    return this.#transaction(() => {
      const current = this.#database.prepare(
        'SELECT * FROM lifecycle_receipts WHERE id = ?'
      ).get(receiptId) as unknown as LifecycleReceiptRow | undefined
      if (!current) throw new Error(`Lifecycle receipt is missing: ${receiptId}`)
      if (current.state !== 'running') throw new Error(`Lifecycle receipt is already terminal: ${receiptId}`)
      const finishedAt = new Date().toISOString()
      this.#database.prepare(`
        UPDATE lifecycle_receipts
        SET state = ?, finished_at = ?, summary = ?, error_code = ?, evidence_json = ?
        WHERE id = ?
      `).run(state, finishedAt, summary, errorCode, JSON.stringify(evidence), receiptId)
      this.#database.prepare(`
        UPDATE lifecycle_runs SET updated_at = ? WHERE job_id = ?
      `).run(finishedAt, current.job_id)
      const updated = this.#database.prepare(
        'SELECT * FROM lifecycle_receipts WHERE id = ?'
      ).get(receiptId) as unknown as LifecycleReceiptRow
      return this.#toLifecycleReceipt(updated)
    })
  }

  setLifecycleProtectionPoint(jobId: string, protectionPointId: string): LifecycleRunRecord {
    const now = new Date().toISOString()
    this.#database.prepare(`
      UPDATE lifecycle_runs SET protection_point_id = ?, updated_at = ? WHERE job_id = ?
    `).run(protectionPointId, now, jobId)
    const run = this.getLifecycleRun(jobId)
    if (!run) throw new Error(`Lifecycle run is missing: ${jobId}`)
    return run
  }

  completeLifecycleRun(
    jobId: string,
    state: Extract<LifecycleRunState, 'succeeded' | 'failed' | 'interrupted'>,
    summary: string,
    errorCode: string | null,
    recoveryRequired: boolean
  ): { job: JobRecord; run: LifecycleRunRecord } {
    return this.#transaction(() => {
      const current = this.getJob(jobId)
      if (!current) throw new Error(`Lifecycle job is missing: ${jobId}`)
      const finishedAt = new Date()
      const startedAt = current.startedAt ? new Date(current.startedAt) : new Date(current.createdAt)
      const job = this.updateJob(jobId, {
        state: state === 'succeeded' ? 'succeeded' : 'failed',
        finishedAt: finishedAt.toISOString(),
        durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        summary,
        errorCode
      })
      this.#database.prepare(`
        UPDATE lifecycle_runs
        SET state = ?, recovery_required = ?, updated_at = ?
        WHERE job_id = ?
      `).run(state, recoveryRequired ? 1 : 0, finishedAt.toISOString(), jobId)
      this.#database.prepare(
        "DELETE FROM lifecycle_locks WHERE name = 'global' AND job_id = ?"
      ).run(jobId)
      const run = this.getLifecycleRun(jobId)
      if (!run) throw new Error(`Lifecycle run is missing: ${jobId}`)
      return { job, run }
    })
  }

  reconcileInterruptedLifecycleRuns(): Array<{ job: JobRecord; run: LifecycleRunRecord }> {
    return this.#transaction(() => {
      const active = this.#database.prepare(`
        SELECT * FROM lifecycle_runs WHERE state IN ('queued', 'running') ORDER BY created_at ASC
      `).all() as unknown as LifecycleRunRow[]
      const reconciled: Array<{ job: JobRecord; run: LifecycleRunRecord }> = []
      for (const row of active) {
        const now = new Date().toISOString()
        this.#database.prepare(`
          UPDATE lifecycle_receipts
          SET state = 'failed', finished_at = ?, summary = ?, error_code = ?
          WHERE job_id = ? AND state = 'running'
        `).run(now, '控制面重启时阶段仍在运行；不会自动重放', 'CONTROL_PLANE_RESTARTED', row.job_id)
        const sequenceRow = this.#database.prepare(`
          SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
          FROM lifecycle_receipts WHERE job_id = ?
        `).get(row.job_id) as unknown as { next_sequence: number }
        this.#database.prepare(`
          INSERT INTO lifecycle_receipts(
            id, job_id, sequence, phase, state, started_at, finished_at,
            summary, error_code, evidence_json
          ) VALUES (?, ?, ?, 'reconciliation', 'failed', ?, ?, ?, ?, ?)
        `).run(
          randomUUID(), row.job_id, sequenceRow.next_sequence, now, now,
          '检测到未完成生命周期事务；已停止恢复并要求人工核验',
          'LIFECYCLE_INTERRUPTED',
          JSON.stringify({ previousPhase: row.current_phase })
        )
        this.#database.prepare(`
          UPDATE lifecycle_runs
          SET state = 'interrupted', current_phase = 'reconciliation',
              recovery_required = 1, updated_at = ?
          WHERE job_id = ?
        `).run(now, row.job_id)
        const jobBefore = this.getJob(row.job_id)
        if (!jobBefore) throw new Error(`Lifecycle job is missing: ${row.job_id}`)
        const startedAt = jobBefore.startedAt ? new Date(jobBefore.startedAt) : new Date(jobBefore.createdAt)
        const job = this.updateJob(row.job_id, {
          state: 'failed',
          finishedAt: now,
          durationMs: Math.max(0, new Date(now).getTime() - startedAt.getTime()),
          summary: '生命周期事务因控制面重启而中断，未自动重放',
          errorCode: 'LIFECYCLE_INTERRUPTED'
        })
        this.#database.prepare('DELETE FROM lifecycle_locks WHERE job_id = ?').run(row.job_id)
        const run = this.getLifecycleRun(row.job_id)
        if (!run) throw new Error(`Lifecycle run is missing: ${row.job_id}`)
        reconciled.push({ job, run })
      }
      return reconciled
    })
  }

  close(): void {
    this.#database.close()
  }

  #toJob(row: JobRow): JobRecord {
    return {
      id: row.id, kind: row.kind, state: row.state, actor: row.actor,
      createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at,
      durationMs: row.duration_ms, summary: row.summary, errorCode: row.error_code
    }
  }

  #toLifecycleRun(row: LifecycleRunRow): LifecycleRunRecord {
    return {
      jobId: row.job_id,
      action: row.action,
      idempotencyKey: row.idempotency_key,
      requestId: row.request_id,
      state: row.state,
      currentPhase: row.current_phase,
      protectionPointId: row.protection_point_id,
      recoveryRequired: row.recovery_required === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  #toLifecycleReceipt(row: LifecycleReceiptRow): LifecycleReceiptRecord {
    return {
      id: row.id,
      jobId: row.job_id,
      sequence: row.sequence,
      phase: row.phase,
      state: row.state,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      summary: row.summary,
      errorCode: row.error_code,
      evidence: JSON.parse(row.evidence_json) as LifecycleEvidence
    }
  }

  #toSaveRun(row: SaveRunRow): StoredSaveJobRun {
    const result = row.result_status === null || row.result_backup_id === null ||
        row.result_pair_bytes === null || row.result_rollback === null ||
        row.result_reused === null || row.audit_stored === null
      ? null
      : {
          status: row.result_status,
          backupId: row.result_backup_id,
          protectionBackupId: row.result_protection_backup_id,
          pairBytes: row.result_pair_bytes,
          rollback: row.result_rollback,
          reused: row.result_reused === 1,
          auditStored: row.audit_stored === 1,
          cleanupPending: row.result_cleanup_pending === 1,
          maintenanceRequired: row.result_maintenance_required === 1
        }
    return {
      jobId: row.job_id,
      operation: row.operation,
      idempotencyKey: row.idempotency_key,
      saveName: row.save_name,
      backupId: row.backup_id,
      expectedRevision: row.expected_revision,
      protectionRequestId: row.protection_request_id,
      state: row.state,
      attemptCount: row.attempt_count,
      result,
      errorCode: row.error_code,
      recoveryRequired: row.recovery_required === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  #executionKind(action: LifecycleAction): Extract<JobKind, 'game.start' | 'game.save' | 'game.stop' | 'game.restart'> {
    if (action === 'start') return 'game.start'
    if (action === 'save') return 'game.save'
    if (action === 'graceful-stop') return 'game.stop'
    return 'game.restart'
  }

  #saveKind(operation: SaveJobOperation): Extract<JobKind, 'save.backup' | 'save.restore'> {
    return operation === 'backup' ? 'save.backup' : 'save.restore'
  }

  #initializePlayerPresenceSchema(): void {
    const secureDelete = this.#database.prepare('PRAGMA secure_delete').get() as unknown as {
      secure_delete: number
    } | undefined
    if (secureDelete?.secure_delete !== 1) {
      throw new PlayerSnapshotError('PLAYER_HISTORY_SCHEMA_INVALID')
    }
    const objectRows = this.#database.prepare(`
      SELECT name, type FROM sqlite_master
      WHERE name IN ('player_presence_state', 'player_presence_events')
      ORDER BY name ASC
    `).all() as unknown as Array<{ name: string; type: string }>

    if (objectRows.length === 0) {
      this.#transaction(() => {
        this.#database.exec(`
          CREATE TABLE player_presence_state (
            singleton_id INTEGER PRIMARY KEY NOT NULL CHECK(singleton_id = 1),
            schema_version INTEGER NOT NULL CHECK(schema_version = 1),
            projection_json TEXT CHECK(
              projection_json IS NULL OR length(projection_json) BETWEEN 2 AND 32768
            ),
            cursor_json TEXT NOT NULL CHECK(length(cursor_json) BETWEEN 2 AND 8192)
          );
          CREATE TABLE player_presence_events (
            history_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL CHECK(type IN ('join', 'leave')),
            occurred_at_unix_ms INTEGER NOT NULL CHECK(occurred_at_unix_ms > 0),
            session_id TEXT NOT NULL CHECK(length(session_id) = 36),
            session_player_id TEXT NOT NULL CHECK(length(session_player_id) BETWEEN 13 AND 19),
            display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 128),
            online INTEGER NOT NULL CHECK(online IN (0, 1)),
            joined_at_unix_ms INTEGER NOT NULL CHECK(joined_at_unix_ms > 0),
            location TEXT NOT NULL CHECK(length(location) BETWEEN 8 AND 21)
          );
          CREATE INDEX player_presence_events_retention_idx
            ON player_presence_events(occurred_at_unix_ms, history_sequence);
          INSERT INTO player_presence_state(
            singleton_id, schema_version, projection_json, cursor_json
          ) VALUES (1, 1, NULL, '[]');
        `)
      })
    } else if (objectRows.length !== 2 || objectRows.some((row) => row.type !== 'table')) {
      throw new PlayerSnapshotError('PLAYER_HISTORY_SCHEMA_INVALID')
    }

    this.#assertNoPlayerPresenceTriggers()
    this.#assertPlayerPresenceColumns('player_presence_state', [
      ['singleton_id', 'INTEGER', 1, 1],
      ['schema_version', 'INTEGER', 1, 0],
      ['projection_json', 'TEXT', 0, 0],
      ['cursor_json', 'TEXT', 1, 0]
    ])
    this.#assertPlayerPresenceColumns('player_presence_events', [
      ['history_sequence', 'INTEGER', 0, 1],
      ['type', 'TEXT', 1, 0],
      ['occurred_at_unix_ms', 'INTEGER', 1, 0],
      ['session_id', 'TEXT', 1, 0],
      ['session_player_id', 'TEXT', 1, 0],
      ['display_name', 'TEXT', 1, 0],
      ['online', 'INTEGER', 1, 0],
      ['joined_at_unix_ms', 'INTEGER', 1, 0],
      ['location', 'TEXT', 1, 0]
    ])
    this.#assertPlayerPresenceTableSql('player_presence_state', [
      'singleton_idintegerprimarykeynotnullcheck(singleton_id=1)',
      'schema_versionintegernotnullcheck(schema_version=1)',
      'projection_jsontextcheck(projection_jsonisnullorlength(projection_json)between2and32768)',
      'cursor_jsontextnotnullcheck(length(cursor_json)between2and8192)'
    ])
    this.#assertPlayerPresenceTableSql('player_presence_events', [
      'history_sequenceintegerprimarykeyautoincrement',
      "typetextnotnullcheck(typein('join','leave'))",
      'occurred_at_unix_msintegernotnullcheck(occurred_at_unix_ms>0)',
      'session_idtextnotnullcheck(length(session_id)=36)',
      'session_player_idtextnotnullcheck(length(session_player_id)between13and19)',
      'display_nametextnotnullcheck(length(display_name)between1and128)',
      'onlineintegernotnullcheck(onlinein(0,1))',
      'joined_at_unix_msintegernotnullcheck(joined_at_unix_ms>0)',
      'locationtextnotnullcheck(length(location)between8and21)'
    ])
    const stateRows = this.#database.prepare(`
      SELECT singleton_id, schema_version, projection_json, cursor_json FROM player_presence_state
    `).all() as unknown as PlayerPresenceStateRow[]
    if (stateRows.length !== 1 || stateRows[0]?.singleton_id !== 1 ||
        stateRows[0].schema_version !== 1 ||
        (stateRows[0].projection_json !== null && typeof stateRows[0].projection_json !== 'string')) {
      throw new PlayerSnapshotError('PLAYER_HISTORY_SCHEMA_INVALID')
    }
    validatePlayerPresencePersistenceMetadata(
      stateRows[0].projection_json,
      stateRows[0].cursor_json
    )
    this.#database.exec(`
      CREATE INDEX IF NOT EXISTS player_presence_events_retention_idx
        ON player_presence_events(occurred_at_unix_ms, history_sequence)
    `)
    const index = this.#database.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'index' AND name = 'player_presence_events_retention_idx'
    `).get() as unknown as { sql: string } | undefined
    if (!index || normalizeSql(index.sql) !==
        'createindexplayer_presence_events_retention_idxonplayer_presence_events(occurred_at_unix_ms,history_sequence)') {
      throw new PlayerSnapshotError('PLAYER_HISTORY_SCHEMA_INVALID')
    }
    validatePlayerPresencePersistenceState(this.#readPlayerPresenceHistory())
  }

  #assertPlayerPresenceColumns(
    tableName: 'player_presence_state' | 'player_presence_events',
    expected: Array<[name: string, type: string, notnull: number, pk: number]>
  ): void {
    const columns = this.#database.prepare(
      `PRAGMA table_info(${tableName})`
    ).all() as unknown as SqliteTableColumn[]
    if (columns.length !== expected.length || expected.some((item, index) => {
      const column = columns[index]
      return !column || column.name !== item[0] || column.type.toUpperCase() !== item[1] ||
        column.notnull !== item[2] || column.pk !== item[3]
    })) {
      throw new PlayerSnapshotError('PLAYER_HISTORY_SCHEMA_INVALID')
    }
  }

  #assertPlayerPresenceTableSql(
    tableName: 'player_presence_state' | 'player_presence_events',
    requiredFragments: string[]
  ): void {
    const row = this.#database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(tableName) as unknown as { sql: string } | undefined
    const normalized = row && typeof row.sql === 'string' ? normalizeSql(row.sql) : ''
    if (requiredFragments.some((fragment) => !normalized.includes(fragment))) {
      throw new PlayerSnapshotError('PLAYER_HISTORY_SCHEMA_INVALID')
    }
  }

  #readPlayerPresenceHistory(): PlayerPresenceHistoryPersistenceState {
    const stateRows = this.#database.prepare(`
      SELECT singleton_id, schema_version, projection_json, cursor_json
      FROM player_presence_state ORDER BY singleton_id ASC
    `).all() as unknown as PlayerPresenceStateRow[]
    if (stateRows.length !== 1 || stateRows[0]?.singleton_id !== 1 || stateRows[0].schema_version !== 1) {
      throw new PlayerSnapshotError('PLAYER_HISTORY_SCHEMA_INVALID')
    }
    const events = this.#database.prepare(`
      SELECT
        history_sequence AS historySequence,
        type AS type,
        occurred_at_unix_ms AS occurredAtUnixMs,
        session_id AS sessionId,
        session_player_id AS sessionPlayerId,
        display_name AS displayName,
        online AS online,
        joined_at_unix_ms AS joinedAtUnixMs,
        location AS location
      FROM player_presence_events
      ORDER BY history_sequence ASC
      LIMIT 2049
    `).all() as unknown as StoredPlayerPresenceEventRow[]
    if (events.length > 2_048) {
      throw new PlayerSnapshotError('PLAYER_HISTORY_PERSISTENCE_INVALID')
    }
    return {
      projectionJson: stateRows[0].projection_json,
      cursorJson: stateRows[0].cursor_json,
      events
    }
  }

  #prunePlayerPresenceRows(capacity: number, cutoffUnixMs: number): number {
    this.#assertNoPlayerPresenceTriggers()
    const timeResult = this.#database.prepare(`
      DELETE FROM player_presence_events WHERE occurred_at_unix_ms < ?
    `).run(cutoffUnixMs)
    const capacityResult = this.#database.prepare(`
      DELETE FROM player_presence_events
      WHERE history_sequence NOT IN (
        SELECT history_sequence FROM player_presence_events
        ORDER BY history_sequence DESC LIMIT ?
      )
    `).run(capacity)
    return Number(timeResult.changes) + Number(capacityResult.changes)
  }

  #assertNoPlayerPresenceTriggers(): void {
    const triggers = this.#database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger'
        AND tbl_name IN ('player_presence_state', 'player_presence_events')
      LIMIT 1
    `).all() as unknown as Array<{ name: string }>
    if (triggers.length > 0) {
      throw new PlayerSnapshotError('PLAYER_HISTORY_SCHEMA_INVALID')
    }
  }

  #checkpointPlayerPresenceRetention(): void {
    if (!this.#playerPresenceCheckpointRequired) return
    let row: { busy: number; log: number; checkpointed: number } | undefined
    try {
      row = this.#database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as unknown as
        { busy: number; log: number; checkpointed: number } | undefined
    } catch {
      throw new PlayerSnapshotError('PLAYER_HISTORY_RETENTION_CHECKPOINT_FAILED')
    }
    if (!row || row.busy !== 0) {
      throw new PlayerSnapshotError('PLAYER_HISTORY_RETENTION_CHECKPOINT_FAILED')
    }
    this.#playerPresenceCheckpointRequired = false
  }

  #assertObservabilityAlertSchema(): void {
    const table = this.#database.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'observability_alert_state'
    `).get() as unknown as { sql: string } | undefined
    if (!table || typeof table.sql !== 'string') {
      throw new Error('Observability alert schema is invalid')
    }
    const columns = this.#database.prepare(
      'PRAGMA table_info(observability_alert_state)'
    ).all() as unknown as SqliteTableColumn[]
    const expected: Array<[string, string, number, number]> = [
      ['singleton_id', 'INTEGER', 1, 1],
      ['schema_version', 'INTEGER', 1, 0],
      ['revision', 'INTEGER', 1, 0],
      ['payload_json', 'TEXT', 1, 0]
    ]
    if (columns.length !== expected.length || expected.some(([name, type, notnull, pk], index) => {
      const column = columns[index]
      return !column || column.name !== name || column.type.toUpperCase() !== type ||
        column.notnull !== notnull || column.pk !== pk
    })) {
      throw new Error('Observability alert schema is invalid')
    }
    const normalized = normalizeSql(table.sql)
    for (const fragment of [
      'singleton_idintegerprimarykeynotnullcheck(singleton_id=1)',
      'schema_versionintegernotnullcheck(schema_version=1)',
      'revisionintegernotnullcheck(revision>=1)',
      'payload_jsontextnotnullcheck(length(payload_json)between2and4194304)'
    ]) {
      if (!normalized.includes(fragment)) throw new Error('Observability alert schema is invalid')
    }
    const trigger = this.#database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND tbl_name = 'observability_alert_state'
      LIMIT 1
    `).get() as unknown as { name: string } | undefined
    if (trigger) throw new Error('Observability alert schema is invalid')
  }

  #assertSaveReconciliationSchema(): void {
    const table = this.#database.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'save_reconciliation_receipts'
    `).get() as unknown as { sql: string } | undefined
    if (!table || typeof table.sql !== 'string') {
      throw new Error('Save reconciliation schema is invalid')
    }
    const columns = this.#database.prepare(
      'PRAGMA table_info(save_reconciliation_receipts)'
    ).all() as unknown as SqliteTableColumn[]
    const expected: Array<[string, string, number, number]> = [
      ['id', 'TEXT', 0, 1],
      ['job_id', 'TEXT', 1, 0],
      ['sequence', 'INTEGER', 1, 0],
      ['actor', 'TEXT', 1, 0],
      ['reason', 'TEXT', 1, 0],
      ['requested_at', 'TEXT', 1, 0]
    ]
    if (columns.length !== expected.length || expected.some(([name, type, notnull, pk], index) => {
      const column = columns[index]
      return !column || column.name !== name || column.type.toUpperCase() !== type ||
        column.notnull !== notnull || column.pk !== pk
    })) {
      throw new Error('Save reconciliation schema is invalid')
    }
    const normalized = normalizeSql(table.sql)
    for (const fragment of [
      'idtextprimarykey',
      'job_idtextnotnullreferencessave_runs(job_id)ondeletecascade',
      'sequenceintegernotnullcheck(sequence>=1)',
      'actortextnotnullcheck(length(actor)between1and128)',
      "reasontextnotnullcheck(reasonin('committed-cleanup','audit-repair','rolled-back-cleanup'))",
      'requested_attextnotnull',
      'unique(job_id,sequence)'
    ]) {
      if (!normalized.includes(fragment)) throw new Error('Save reconciliation schema is invalid')
    }
    const foreignKeys = this.#database.prepare(
      'PRAGMA foreign_key_list(save_reconciliation_receipts)'
    ).all() as unknown as Array<{
      table: string
      from: string
      to: string
      on_delete: string
    }>
    if (foreignKeys.length !== 1 || foreignKeys[0]?.table !== 'save_runs' ||
        foreignKeys[0].from !== 'job_id' || foreignKeys[0].to !== 'job_id' ||
        foreignKeys[0].on_delete.toUpperCase() !== 'CASCADE') {
      throw new Error('Save reconciliation schema is invalid')
    }
    const trigger = this.#database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND tbl_name = 'save_reconciliation_receipts'
      LIMIT 1
    `).get() as unknown as { name: string } | undefined
    if (trigger) throw new Error('Save reconciliation schema is invalid')
  }

  #assertPlayerPresenceRetention(capacity: number, cutoffUnixMs: number): void {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 2_048 ||
        !Number.isSafeInteger(cutoffUnixMs) || cutoffUnixMs <= 0) {
      throw new PlayerSnapshotError('PLAYER_HISTORY_RETENTION_INVALID')
    }
  }

  #assertPlayerPresenceEventDraft(event: PlayerPresenceEventDraft): void {
    const player = event?.player
    if ((event.type !== 'join' && event.type !== 'leave') ||
        !Number.isSafeInteger(event.occurredAtUnixMs) || event.occurredAtUnixMs <= 0 ||
        typeof event.sessionId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.sessionId) ||
        typeof player !== 'object' || player === null ||
        typeof player.sessionPlayerId !== 'string' || !/^player-[0-9]{6,12}$/.test(player.sessionPlayerId) ||
        typeof player.displayName !== 'string' || player.displayName.trim().length === 0 ||
        [...player.displayName].length > 64 || Buffer.byteLength(player.displayName, 'utf8') > 128 ||
        /[\0\r\n]/.test(player.displayName) || player.online !== (event.type === 'join') ||
        !Number.isSafeInteger(player.joinedAtUnixMs) || player.joinedAtUnixMs <= 0 ||
        event.occurredAtUnixMs < player.joinedAtUnixMs - 5_000 ||
        typeof player.location !== 'string' ||
        !/^(?:deep-space|planet:[1-9][0-9]{0,9}|star:[1-9][0-9]{0,9})$/.test(player.location)) {
      throw new PlayerSnapshotError('PLAYER_HISTORY_PERSISTENCE_INVALID')
    }
  }

  #validateObservabilityWrite(observedAt: string, payloadJson: string, capacity: number): void {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 4_096) {
      throw new Error('Observability capacity is invalid')
    }
    if (typeof observedAt !== 'string' || Number.isNaN(Date.parse(observedAt)) || observedAt.length > 64) {
      throw new Error('Observability timestamp is invalid')
    }
    if (typeof payloadJson !== 'string' || payloadJson.includes('\0')
        || Buffer.byteLength(payloadJson, 'utf8') < 2
        || Buffer.byteLength(payloadJson, 'utf8') > 256 * 1_024) {
      throw new Error('Observability payload is invalid')
    }
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.#database.exec('COMMIT')
      return result
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }
}

function normalizeSql(sql: string): string {
  return sql.toLowerCase().replace(/\s+/g, '')
}

function isBoundedNullableJson(value: unknown, maximumBytes: number): value is string | null {
  return value === null || (typeof value === 'string' && !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') >= 2 && Buffer.byteLength(value, 'utf8') <= maximumBytes)
}

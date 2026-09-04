import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { DatabaseSync, type StatementResultingChanges } from 'node:sqlite'
import { z } from 'zod'
import type { ControlRole } from '../security/authorization.js'
import type {
  CutoverDesiredAuthority,
  CutoverPublicPhase,
  CutoverRollbackMode
} from './types.js'

const DATABASE_NAME = 'cutover-audit.db'
const MAX_EVENT_JSON_BYTES = 8 * 1024
const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 200
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,95}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/

export type CutoverAuditOperation = 'prepare' | 'activate' | 'rollback' | 'recover'
export type CutoverAuditOutcome = 'succeeded' | 'rejected' | 'failed' | 'recovery-required'

export interface CutoverAuditBeginInput {
  attemptId: string
  operation: CutoverAuditOperation
  requestId: string
  actorRole: ControlRole
  planFingerprint?: string | null
  rollbackMode?: CutoverRollbackMode | null
  desired?: CutoverDesiredAuthority | null
}

export interface CutoverAuditCompleteInput {
  attemptId: string
  outcome: CutoverAuditOutcome
  httpStatus: number
  errorCode?: string | null
  receiptPhase?: CutoverPublicPhase | null
  receiptReused?: boolean | null
}

interface CutoverAuditIdentity {
  attemptId: string
  operation: CutoverAuditOperation
  requestId: string
  actorRole: ControlRole
  planFingerprint?: string | null
  rollbackMode: CutoverRollbackMode | null
  desired: CutoverDesiredAuthority | null
}

export interface CutoverAuditStartedEvent extends CutoverAuditIdentity {
  format: 'dyson-control-cutover-audit-event'
  schemaVersion: 1
  sequence: 1
  event: 'started'
  recordedAt: string
}

export interface CutoverAuditTerminalEvent extends CutoverAuditIdentity {
  format: 'dyson-control-cutover-audit-event'
  schemaVersion: 1
  sequence: 2
  event: 'terminal'
  recordedAt: string
  outcome: CutoverAuditOutcome
  httpStatus: number
  errorCode: string | null
  receiptPhase: CutoverPublicPhase | null
  receiptReused: boolean | null
}

export type CutoverAuditEvent = CutoverAuditStartedEvent | CutoverAuditTerminalEvent

export interface CutoverAuditEventStore {
  begin(input: CutoverAuditBeginInput): Promise<CutoverAuditStartedEvent>
  complete(input: CutoverAuditCompleteInput): Promise<CutoverAuditTerminalEvent>
  listIncomplete(limit?: number): Promise<CutoverAuditStartedEvent[]>
  listRecent(limit?: number): Promise<CutoverAuditEvent[]>
}

export type CutoverAuditErrorCode =
  | 'CUTOVER_AUDIT_PATH_INVALID'
  | 'CUTOVER_AUDIT_INPUT_INVALID'
  | 'CUTOVER_AUDIT_DATA_INVALID'
  | 'CUTOVER_AUDIT_ATTEMPT_CONFLICT'
  | 'CUTOVER_AUDIT_ATTEMPT_NOT_FOUND'
  | 'CUTOVER_AUDIT_TERMINAL_CONFLICT'
  | 'CUTOVER_AUDIT_CLOSED'
  | 'CUTOVER_AUDIT_STORE_FAILED'

/** Raw filesystem and SQLite diagnostics are deliberately discarded. */
export class CutoverAuditError extends Error {
  readonly code: CutoverAuditErrorCode

  constructor(code: CutoverAuditErrorCode) {
    super(code)
    this.name = 'CutoverAuditError'
    this.code = code
  }
}

const inputRequestIdSchema = z.string().uuid().transform((value) => value.toLowerCase())
const inputAttemptIdSchema = z.string().uuid().transform((value) => value.toLowerCase())
  .pipe(z.string().regex(UUID_V4_PATTERN))
const persistedRequestIdSchema = z.string().regex(UUID_PATTERN)
const persistedAttemptIdSchema = z.string().regex(UUID_V4_PATTERN)
const operationSchema = z.enum(['prepare', 'activate', 'rollback', 'recover'])
const roleSchema = z.enum(['viewer', 'operator', 'administrator'])
const rollbackModeSchema = z.enum(['immediate-compensation', 'later-operator-rollback'])
const desiredSchema = z.enum(['previous', 'candidate'])
const publicPhaseSchema = z.enum([
  'prepared',
  'activated',
  'rolled-back-immediate',
  'rolled-back-later',
  'recovered-candidate',
  'recovered-previous'
])
const outcomeSchema = z.enum(['succeeded', 'rejected', 'failed', 'recovery-required'])
const timestampSchema = z.string().max(64).datetime({ offset: true })
const errorCodeSchema = z.string().max(96).regex(ERROR_CODE_PATTERN)
const sha256Schema = z.string().regex(SHA256_PATTERN)

const beginInputSchema = z.strictObject({
  attemptId: inputAttemptIdSchema,
  operation: operationSchema,
  requestId: inputRequestIdSchema,
  actorRole: roleSchema,
  planFingerprint: sha256Schema.nullish(),
  rollbackMode: rollbackModeSchema.nullish(),
  desired: desiredSchema.nullish()
}).superRefine((input, context) => {
  const rollback = input.operation === 'rollback' && input.rollbackMode !== null &&
    input.rollbackMode !== undefined && input.desired == null
  const recover = input.operation === 'recover' && input.rollbackMode == null &&
    input.desired !== null && input.desired !== undefined
  const ordinary = (input.operation === 'prepare' || input.operation === 'activate') &&
    input.rollbackMode == null && input.desired == null
  if (!rollback && !recover && !ordinary) context.addIssue({ code: 'custom', message: 'binding' })
})

const completeInputSchema = z.strictObject({
  attemptId: inputAttemptIdSchema,
  outcome: outcomeSchema,
  httpStatus: z.number().int().min(200).max(599),
  errorCode: errorCodeSchema.nullish(),
  receiptPhase: publicPhaseSchema.nullish(),
  receiptReused: z.boolean().nullish()
}).superRefine((input, context) => {
  const succeeded = input.outcome === 'succeeded'
  if (succeeded !== (input.httpStatus >= 200 && input.httpStatus < 300) ||
      succeeded !== (input.errorCode == null) ||
      ((input.receiptPhase == null) !== (input.receiptReused == null))) {
    context.addIssue({ code: 'custom', message: 'terminal' })
  }
})

const identityShape = {
  attemptId: persistedAttemptIdSchema,
  operation: operationSchema,
  requestId: persistedRequestIdSchema,
  actorRole: roleSchema,
  planFingerprint: sha256Schema.nullable().optional(),
  rollbackMode: rollbackModeSchema.nullable(),
  desired: desiredSchema.nullable()
} as const

const startedEventSchema = z.strictObject({
  format: z.literal('dyson-control-cutover-audit-event'),
  schemaVersion: z.literal(1),
  ...identityShape,
  sequence: z.literal(1),
  event: z.literal('started'),
  recordedAt: timestampSchema
}).superRefine((event, context) => assertOperationBinding(event, context))

const terminalEventSchema = z.strictObject({
  format: z.literal('dyson-control-cutover-audit-event'),
  schemaVersion: z.literal(1),
  ...identityShape,
  sequence: z.literal(2),
  event: z.literal('terminal'),
  recordedAt: timestampSchema,
  outcome: outcomeSchema,
  httpStatus: z.number().int().min(200).max(599),
  errorCode: errorCodeSchema.nullable(),
  receiptPhase: publicPhaseSchema.nullable(),
  receiptReused: z.boolean().nullable()
}).superRefine((event, context) => {
  assertOperationBinding(event, context)
  const succeeded = event.outcome === 'succeeded'
  if (succeeded !== (event.httpStatus >= 200 && event.httpStatus < 300) ||
      succeeded !== (event.errorCode === null) ||
      ((event.receiptPhase === null) !== (event.receiptReused === null))) {
    context.addIssue({ code: 'custom', message: 'terminal' })
  }
  assertTerminalOperationBinding(event, context)
})

interface EventRow {
  event_id: unknown
  attempt_id: unknown
  sequence: unknown
  event_kind: unknown
  operation: unknown
  request_id: unknown
  actor_role: unknown
  rollback_mode: unknown
  desired: unknown
  recorded_at: unknown
  outcome: unknown
  http_status: unknown
  error_code: unknown
  receipt_phase: unknown
  receipt_reused: unknown
  payload_json: unknown
}

interface AttemptRow {
  attempt_id: unknown
  started_event_id: unknown
  terminal_event_id: unknown
}

interface IncompleteRow extends EventRow, AttemptRow {
  observed_terminal_event_id: unknown
}

interface EncodedEvent<T extends CutoverAuditEvent> {
  value: T
  json: string
}

export function createCutoverAuditAttemptId(): string {
  return randomUUID()
}

/** Independent append-only audit event database for cutover mutations. */
export class SqliteCutoverAuditStore implements CutoverAuditEventStore {
  readonly #database: DatabaseSync
  #closed = false

  constructor(dataDirectory: string) {
    const resolvedDirectory = validateDataDirectory(dataDirectory)
    const databasePath = path.join(resolvedDirectory, DATABASE_NAME)
    assertOrdinaryDatabaseArtifacts(databasePath)

    let database: DatabaseSync | undefined
    try {
      database = new DatabaseSync(databasePath)
      configureDatabase(database)
      initializeDatabase(database)
    } catch (error) {
      try {
        database?.close()
      } catch {
        // The original stable error wins.
      }
      throw normalizeAuditError(error)
    }
    this.#database = database
  }

  async begin(input: CutoverAuditBeginInput): Promise<CutoverAuditStartedEvent> {
    return this.#execute(() => {
      const parsed = beginInputSchema.safeParse(input)
      if (!parsed.success) throw new CutoverAuditError('CUTOVER_AUDIT_INPUT_INVALID')
      const event = encodeStartedEvent({
        format: 'dyson-control-cutover-audit-event',
        schemaVersion: 1,
        attemptId: parsed.data.attemptId,
        operation: parsed.data.operation,
        requestId: parsed.data.requestId,
        actorRole: parsed.data.actorRole,
        planFingerprint: parsed.data.planFingerprint ?? null,
        rollbackMode: parsed.data.rollbackMode ?? null,
        desired: parsed.data.desired ?? null,
        sequence: 1,
        event: 'started',
        recordedAt: new Date().toISOString()
      })

      return this.#transaction(() => {
        const attempt = this.#readAttempt(event.value.attemptId)
        const orphan = this.#database.prepare(`
          SELECT 1 AS present FROM cutover_audit_events WHERE attempt_id = ? LIMIT 1
        `).get(event.value.attemptId)
        if (attempt !== null) throw new CutoverAuditError('CUTOVER_AUDIT_ATTEMPT_CONFLICT')
        if (orphan !== undefined) throw new CutoverAuditError('CUTOVER_AUDIT_DATA_INVALID')

        const result = this.#insertEvent(event)
        const eventId = safeRowId(result)
        const projection = this.#database.prepare(`
          INSERT INTO cutover_audit_attempts (
            attempt_id, started_event_id, terminal_event_id
          ) VALUES (?, ?, NULL)
        `).run(event.value.attemptId, eventId)
        assertOneChange(projection, 'CUTOVER_AUDIT_ATTEMPT_CONFLICT')
        return event.value
      })
    })
  }

  async complete(input: CutoverAuditCompleteInput): Promise<CutoverAuditTerminalEvent> {
    return this.#execute(() => {
      const parsed = completeInputSchema.safeParse(input)
      if (!parsed.success) throw new CutoverAuditError('CUTOVER_AUDIT_INPUT_INVALID')

      return this.#transaction(() => {
        const attempt = this.#readAttempt(parsed.data.attemptId)
        if (attempt === null) {
          const orphan = this.#database.prepare(`
            SELECT 1 AS present FROM cutover_audit_events WHERE attempt_id = ? LIMIT 1
          `).get(parsed.data.attemptId)
          throw new CutoverAuditError(orphan === undefined
            ? 'CUTOVER_AUDIT_ATTEMPT_NOT_FOUND'
            : 'CUTOVER_AUDIT_DATA_INVALID')
        }
        const started = this.#readEventById(attempt.startedEventId)
        if (started.value.sequence !== 1 || started.value.event !== 'started' ||
            started.value.attemptId !== parsed.data.attemptId) {
          throw new CutoverAuditError('CUTOVER_AUDIT_DATA_INVALID')
        }

        const existing = this.#readTerminal(parsed.data.attemptId)
        if (existing !== null) {
          if (attempt.terminalEventId !== existing.eventId) {
            throw new CutoverAuditError('CUTOVER_AUDIT_DATA_INVALID')
          }
          if (!sameCompletion(existing.event.value, parsed.data)) {
            throw new CutoverAuditError('CUTOVER_AUDIT_TERMINAL_CONFLICT')
          }
          return existing.event.value
        }
        if (attempt.terminalEventId !== null) {
          throw new CutoverAuditError('CUTOVER_AUDIT_DATA_INVALID')
        }

        const terminal = encodeTerminalEvent({
          format: 'dyson-control-cutover-audit-event',
          schemaVersion: 1,
          attemptId: started.value.attemptId,
          operation: started.value.operation,
          requestId: started.value.requestId,
          actorRole: started.value.actorRole,
          planFingerprint: started.value.planFingerprint ?? null,
          rollbackMode: started.value.rollbackMode,
          desired: started.value.desired,
          sequence: 2,
          event: 'terminal',
          recordedAt: new Date().toISOString(),
          outcome: parsed.data.outcome,
          httpStatus: parsed.data.httpStatus,
          errorCode: parsed.data.errorCode ?? null,
          receiptPhase: parsed.data.receiptPhase ?? null,
          receiptReused: parsed.data.receiptReused ?? null
        })
        const inserted = this.#insertEvent(terminal)
        const terminalEventId = safeRowId(inserted)
        const projection = this.#database.prepare(`
          UPDATE cutover_audit_attempts
             SET terminal_event_id = ?
           WHERE attempt_id = ? AND terminal_event_id IS NULL
        `).run(terminalEventId, terminal.value.attemptId)
        assertOneChange(projection, 'CUTOVER_AUDIT_TERMINAL_CONFLICT')
        return terminal.value
      })
    })
  }

  async listIncomplete(limit = DEFAULT_LIST_LIMIT): Promise<CutoverAuditStartedEvent[]> {
    return this.#execute(() => {
      const boundedLimit = parseLimit(limit)
      const rows = this.#database.prepare(`
        SELECT e.event_id, e.attempt_id, e.sequence, e.event_kind, e.operation,
               e.request_id, e.actor_role, e.rollback_mode, e.desired, e.recorded_at,
               e.outcome, e.http_status, e.error_code, e.receipt_phase,
               e.receipt_reused, e.payload_json, a.started_event_id, a.terminal_event_id,
               terminal.event_id AS observed_terminal_event_id
          FROM cutover_audit_attempts AS a
          JOIN cutover_audit_events AS e ON e.event_id = a.started_event_id
          LEFT JOIN cutover_audit_events AS terminal
            ON terminal.attempt_id = a.attempt_id AND terminal.sequence = 2
         WHERE a.terminal_event_id IS NULL
         ORDER BY a.started_event_id DESC
         LIMIT ?
      `).all(boundedLimit) as unknown as IncompleteRow[]
      return rows.map((row) => {
        const decoded = decodeEventRow(row)
        if (decoded.value.sequence !== 1 || decoded.value.event !== 'started' ||
            row.attempt_id !== decoded.value.attemptId ||
            row.started_event_id !== row.event_id || row.terminal_event_id !== null ||
            row.observed_terminal_event_id !== null) {
          throw new CutoverAuditError('CUTOVER_AUDIT_DATA_INVALID')
        }
        return decoded.value
      })
    })
  }

  async listRecent(limit = DEFAULT_LIST_LIMIT): Promise<CutoverAuditEvent[]> {
    return this.#execute(() => {
      const boundedLimit = parseLimit(limit)
      const rows = this.#database.prepare(`
        SELECT event_id, attempt_id, sequence, event_kind, operation, request_id,
               actor_role, rollback_mode, desired, recorded_at, outcome, http_status,
               error_code, receipt_phase, receipt_reused, payload_json
          FROM cutover_audit_events
         ORDER BY event_id DESC
         LIMIT ?
      `).all(boundedLimit) as unknown as EventRow[]
      return rows.map((row) => decodeEventRow(row).value)
    })
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    try {
      this.#database.close()
    } catch {
      throw new CutoverAuditError('CUTOVER_AUDIT_STORE_FAILED')
    }
  }

  #readAttempt(attemptId: string): { startedEventId: number; terminalEventId: number | null } | null {
    const row = this.#database.prepare(`
      SELECT attempt_id, started_event_id, terminal_event_id
        FROM cutover_audit_attempts
       WHERE attempt_id = ?
    `).get(attemptId) as AttemptRow | undefined
    if (row === undefined) return null
    if (row.attempt_id !== attemptId || !isSafePositiveInteger(row.started_event_id) ||
        (row.terminal_event_id !== null && !isSafePositiveInteger(row.terminal_event_id))) {
      throw new CutoverAuditError('CUTOVER_AUDIT_DATA_INVALID')
    }
    return {
      startedEventId: row.started_event_id,
      terminalEventId: row.terminal_event_id
    }
  }

  #readEventById(eventId: number): EncodedEvent<CutoverAuditEvent> {
    const row = this.#database.prepare(`
      SELECT event_id, attempt_id, sequence, event_kind, operation, request_id,
             actor_role, rollback_mode, desired, recorded_at, outcome, http_status,
             error_code, receipt_phase, receipt_reused, payload_json
        FROM cutover_audit_events
       WHERE event_id = ?
    `).get(eventId) as EventRow | undefined
    if (row === undefined || row.event_id !== eventId) {
      throw new CutoverAuditError('CUTOVER_AUDIT_DATA_INVALID')
    }
    return decodeEventRow(row)
  }

  #readTerminal(attemptId: string): {
    eventId: number
    event: EncodedEvent<CutoverAuditTerminalEvent>
  } | null {
    const row = this.#database.prepare(`
      SELECT event_id, attempt_id, sequence, event_kind, operation, request_id,
             actor_role, rollback_mode, desired, recorded_at, outcome, http_status,
             error_code, receipt_phase, receipt_reused, payload_json
        FROM cutover_audit_events
       WHERE attempt_id = ? AND sequence = 2
    `).get(attemptId) as EventRow | undefined
    if (row === undefined) return null
    const decoded = decodeEventRow(row)
    if (!isSafePositiveInteger(row.event_id) || decoded.value.sequence !== 2 ||
        decoded.value.event !== 'terminal') {
      throw new CutoverAuditError('CUTOVER_AUDIT_DATA_INVALID')
    }
    return {
      eventId: row.event_id,
      event: decoded as EncodedEvent<CutoverAuditTerminalEvent>
    }
  }

  #insertEvent(event: EncodedEvent<CutoverAuditEvent>): StatementResultingChanges {
    const terminal = event.value.sequence === 2 ? event.value : null
    return this.#database.prepare(`
      INSERT INTO cutover_audit_events (
        attempt_id, sequence, event_kind, operation, request_id, actor_role,
        rollback_mode, desired, recorded_at, outcome, http_status, error_code,
        receipt_phase, receipt_reused, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.value.attemptId,
      event.value.sequence,
      event.value.event,
      event.value.operation,
      event.value.requestId,
      event.value.actorRole,
      event.value.rollbackMode,
      event.value.desired,
      event.value.recordedAt,
      terminal?.outcome ?? null,
      terminal?.httpStatus ?? null,
      terminal?.errorCode ?? null,
      terminal?.receiptPhase ?? null,
      terminal?.receiptReused === null || terminal === null
        ? null
        : terminal.receiptReused ? 1 : 0,
      event.json
    )
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE')
    let active = true
    try {
      const result = operation()
      this.#database.exec('COMMIT')
      active = false
      return result
    } catch (error) {
      if (active) {
        try {
          this.#database.exec('ROLLBACK')
        } catch {
          // Never expose rollback diagnostics.
        }
      }
      throw error
    }
  }

  #execute<T>(operation: () => T): T {
    if (this.#closed) throw new CutoverAuditError('CUTOVER_AUDIT_CLOSED')
    try {
      return operation()
    } catch (error) {
      throw normalizeAuditError(error)
    }
  }
}

export { SqliteCutoverAuditStore as CutoverAuditStore }

function validateDataDirectory(dataDirectory: string): string {
  try {
    if (typeof dataDirectory !== 'string' || dataDirectory.length === 0 ||
        /[\0\r\n]/.test(dataDirectory) || !path.isAbsolute(dataDirectory)) {
      throw new CutoverAuditError('CUTOVER_AUDIT_PATH_INVALID')
    }
    const resolved = path.resolve(dataDirectory)
    const status = fs.lstatSync(resolved)
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new CutoverAuditError('CUTOVER_AUDIT_PATH_INVALID')
    }
    if (!sameFilesystemPath(fs.realpathSync.native(resolved), resolved)) {
      throw new CutoverAuditError('CUTOVER_AUDIT_PATH_INVALID')
    }
    return resolved
  } catch (error) {
    if (error instanceof CutoverAuditError) throw error
    throw new CutoverAuditError('CUTOVER_AUDIT_PATH_INVALID')
  }
}

function assertOrdinaryDatabaseArtifacts(databasePath: string): void {
  try {
    for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      if (!fs.existsSync(candidate)) continue
      const status = fs.lstatSync(candidate)
      if (!status.isFile() || status.isSymbolicLink()) {
        throw new CutoverAuditError('CUTOVER_AUDIT_PATH_INVALID')
      }
    }
  } catch (error) {
    if (error instanceof CutoverAuditError) throw error
    throw new CutoverAuditError('CUTOVER_AUDIT_PATH_INVALID')
  }
}

function sameFilesystemPath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const normalized = path.normalize(value)
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
  }
  return normalize(left) === normalize(right)
}

function configureDatabase(database: DatabaseSync): void {
  database.exec('PRAGMA busy_timeout = 5000;')
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA secure_delete = ON;
    PRAGMA trusted_schema = OFF;
  `)
  const mode = database.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown } | undefined
  if (typeof mode?.journal_mode !== 'string' || mode.journal_mode.toLowerCase() !== 'wal') {
    throw new CutoverAuditError('CUTOVER_AUDIT_STORE_FAILED')
  }
}

function initializeDatabase(database: DatabaseSync): void {
  runTransaction(database, () => {
    const expectedObjects = new Map<string, string>([
      ['cutover_audit_meta', 'table'],
      ['cutover_audit_events', 'table'],
      ['cutover_audit_attempts', 'table'],
      ['cutover_audit_events_recent_idx', 'index'],
      ['cutover_audit_attempts_incomplete_idx', 'index'],
      ['cutover_audit_events_immutable_update', 'trigger'],
      ['cutover_audit_events_immutable_delete', 'trigger'],
      ['cutover_audit_attempts_insert_binding', 'trigger'],
      ['cutover_audit_attempts_terminal_once', 'trigger'],
      ['cutover_audit_attempts_immutable_delete', 'trigger']
    ])
    const objects = database.prepare(`
      SELECT name, type
        FROM sqlite_master
       WHERE name IN (
         'cutover_audit_meta', 'cutover_audit_events', 'cutover_audit_attempts',
         'cutover_audit_events_recent_idx', 'cutover_audit_attempts_incomplete_idx',
         'cutover_audit_events_immutable_update', 'cutover_audit_events_immutable_delete',
         'cutover_audit_attempts_insert_binding', 'cutover_audit_attempts_terminal_once',
         'cutover_audit_attempts_immutable_delete'
       )
    `).all() as Array<{ name?: unknown; type?: unknown }>
    const fresh = objects.length === 0
    if (!fresh && (objects.length !== expectedObjects.size ||
        objects.some((entry) => typeof entry.name !== 'string' ||
          entry.type !== expectedObjects.get(entry.name)))) {
      throw new CutoverAuditError('CUTOVER_AUDIT_DATA_INVALID')
    }

    if (fresh) {
      database.exec(`
        CREATE TABLE cutover_audit_meta (
          singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
          schema_version INTEGER NOT NULL CHECK(schema_version = 1)
        ) STRICT;

        CREATE TABLE cutover_audit_events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          attempt_id TEXT NOT NULL
            REFERENCES cutover_audit_attempts(attempt_id) DEFERRABLE INITIALLY DEFERRED,
          sequence INTEGER NOT NULL CHECK(sequence IN (1, 2)),
          event_kind TEXT NOT NULL CHECK(
            (sequence = 1 AND event_kind = 'started') OR
            (sequence = 2 AND event_kind = 'terminal')
          ),
          operation TEXT NOT NULL CHECK(operation IN ('prepare', 'activate', 'rollback', 'recover')),
          request_id TEXT NOT NULL,
          actor_role TEXT NOT NULL CHECK(actor_role IN ('viewer', 'operator', 'administrator')),
          rollback_mode TEXT CHECK(
            rollback_mode IS NULL OR
            rollback_mode IN ('immediate-compensation', 'later-operator-rollback')
          ),
          desired TEXT CHECK(desired IS NULL OR desired IN ('previous', 'candidate')),
          recorded_at TEXT NOT NULL,
          outcome TEXT CHECK(
            outcome IS NULL OR outcome IN ('succeeded', 'rejected', 'failed', 'recovery-required')
          ),
          http_status INTEGER,
          error_code TEXT,
          receipt_phase TEXT,
          receipt_reused INTEGER CHECK(receipt_reused IS NULL OR receipt_reused IN (0, 1)),
          payload_json TEXT NOT NULL
            CHECK(json_valid(payload_json) = 1)
            CHECK(length(CAST(payload_json AS BLOB)) BETWEEN 2 AND ${MAX_EVENT_JSON_BYTES}),
          UNIQUE(attempt_id, sequence),
          CHECK(
            (sequence = 1 AND outcome IS NULL AND http_status IS NULL AND error_code IS NULL AND
              receipt_phase IS NULL AND receipt_reused IS NULL) OR
            (sequence = 2 AND outcome IS NOT NULL AND http_status IS NOT NULL)
          )
        ) STRICT;

        CREATE TABLE cutover_audit_attempts (
          attempt_id TEXT PRIMARY KEY,
          started_event_id INTEGER NOT NULL UNIQUE
            REFERENCES cutover_audit_events(event_id) ON DELETE RESTRICT,
          terminal_event_id INTEGER UNIQUE
            REFERENCES cutover_audit_events(event_id) ON DELETE RESTRICT,
          CHECK(terminal_event_id IS NULL OR terminal_event_id <> started_event_id)
        ) STRICT;

        CREATE INDEX cutover_audit_events_recent_idx
          ON cutover_audit_events(event_id DESC);
        CREATE INDEX cutover_audit_attempts_incomplete_idx
          ON cutover_audit_attempts(terminal_event_id, started_event_id DESC);

        CREATE TRIGGER cutover_audit_events_immutable_update
        BEFORE UPDATE ON cutover_audit_events
        BEGIN
          SELECT RAISE(ABORT, 'cutover-audit-event-immutable');
        END;

        CREATE TRIGGER cutover_audit_events_immutable_delete
        BEFORE DELETE ON cutover_audit_events
        BEGIN
          SELECT RAISE(ABORT, 'cutover-audit-event-immutable');
        END;

        CREATE TRIGGER cutover_audit_attempts_insert_binding
        BEFORE INSERT ON cutover_audit_attempts
        WHEN NEW.terminal_event_id IS NOT NULL OR NOT EXISTS (
          SELECT 1
            FROM cutover_audit_events AS started
           WHERE started.event_id = NEW.started_event_id
             AND started.attempt_id = NEW.attempt_id
             AND started.sequence = 1
             AND started.event_kind = 'started'
        )
        BEGIN
          SELECT RAISE(ABORT, 'cutover-audit-attempt-binding');
        END;

        CREATE TRIGGER cutover_audit_attempts_terminal_once
        BEFORE UPDATE ON cutover_audit_attempts
        WHEN OLD.attempt_id IS NOT NEW.attempt_id OR
             OLD.started_event_id IS NOT NEW.started_event_id OR
             OLD.terminal_event_id IS NOT NULL OR NEW.terminal_event_id IS NULL OR
             NOT EXISTS (
               SELECT 1
                 FROM cutover_audit_events AS terminal
                WHERE terminal.event_id = NEW.terminal_event_id
                  AND terminal.attempt_id = OLD.attempt_id
                  AND terminal.sequence = 2
                  AND terminal.event_kind = 'terminal'
             )
        BEGIN
          SELECT RAISE(ABORT, 'cutover-audit-attempt-binding');
        END;

        CREATE TRIGGER cutover_audit_attempts_immutable_delete
        BEFORE DELETE ON cutover_audit_attempts
        BEGIN
          SELECT RAISE(ABORT, 'cutover-audit-attempt-immutable');
        END;

        INSERT INTO cutover_audit_meta (singleton_id, schema_version) VALUES (1, 1);
      `)
    }

    const metadata = database.prepare(`
      SELECT singleton_id, schema_version FROM cutover_audit_meta WHERE singleton_id = 1
    `).get() as { singleton_id?: unknown; schema_version?: unknown } | undefined
    if (metadata?.singleton_id !== 1 || metadata.schema_version !== 1) {
      throw new CutoverAuditError('CUTOVER_AUDIT_DATA_INVALID')
    }
  })
}

function runTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec('BEGIN IMMEDIATE')
  let active = true
  try {
    const result = operation()
    database.exec('COMMIT')
    active = false
    return result
  } catch (error) {
    if (active) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // Preserve only the original stable error.
      }
    }
    throw error
  }
}

function decodeEventRow(row: EventRow): EncodedEvent<CutoverAuditEvent> {
  if (typeof row.payload_json !== 'string' || row.payload_json.includes('\0') ||
      Buffer.byteLength(row.payload_json, 'utf8') < 2 ||
      Buffer.byteLength(row.payload_json, 'utf8') > MAX_EVENT_JSON_BYTES) {
    throw new CutoverAuditError('CUTOVER_AUDIT_DATA_INVALID')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(row.payload_json) as unknown
  } catch {
    throw new CutoverAuditError('CUTOVER_AUDIT_DATA_INVALID')
  }
  const started = startedEventSchema.safeParse(parsed)
  const terminal = terminalEventSchema.safeParse(parsed)
  const value = started.success
    ? started.data as CutoverAuditStartedEvent
    : terminal.success
      ? terminal.data as CutoverAuditTerminalEvent
      : null
  if (value === null) throw new CutoverAuditError('CUTOVER_AUDIT_DATA_INVALID')
  const encoded = encodeEvent(value)
  const terminalValue = value.sequence === 2 ? value : null
  const expectedOutcome = terminalValue?.outcome ?? null
  const expectedHttpStatus = terminalValue?.httpStatus ?? null
  const expectedErrorCode = terminalValue?.errorCode ?? null
  const expectedReceiptPhase = terminalValue?.receiptPhase ?? null
  const expectedReceiptReused = terminalValue === null || terminalValue.receiptReused === null
    ? null
    : terminalValue.receiptReused ? 1 : 0
  if (!isSafePositiveInteger(row.event_id) || row.attempt_id !== value.attemptId ||
      row.sequence !== value.sequence || row.event_kind !== value.event ||
      row.operation !== value.operation || row.request_id !== value.requestId ||
      row.actor_role !== value.actorRole || row.rollback_mode !== value.rollbackMode ||
      row.desired !== value.desired || row.recorded_at !== value.recordedAt ||
      row.outcome !== expectedOutcome || row.http_status !== expectedHttpStatus ||
      row.error_code !== expectedErrorCode || row.receipt_phase !== expectedReceiptPhase ||
      row.receipt_reused !== expectedReceiptReused || row.payload_json !== encoded.json) {
    throw new CutoverAuditError('CUTOVER_AUDIT_DATA_INVALID')
  }
  return encoded
}

function encodeStartedEvent(value: unknown): EncodedEvent<CutoverAuditStartedEvent> {
  const parsed = startedEventSchema.safeParse(value)
  if (!parsed.success) throw new CutoverAuditError('CUTOVER_AUDIT_INPUT_INVALID')
  return encodeEvent(parsed.data as CutoverAuditStartedEvent)
}

function encodeTerminalEvent(value: unknown): EncodedEvent<CutoverAuditTerminalEvent> {
  const parsed = terminalEventSchema.safeParse(value)
  if (!parsed.success) throw new CutoverAuditError('CUTOVER_AUDIT_INPUT_INVALID')
  return encodeEvent(parsed.data as CutoverAuditTerminalEvent)
}

function encodeEvent<T extends CutoverAuditEvent>(value: T): EncodedEvent<T> {
  const json = canonicalJson(value)
  const bytes = Buffer.byteLength(json, 'utf8')
  if (bytes < 2 || bytes > MAX_EVENT_JSON_BYTES || json.includes('\0')) {
    throw new CutoverAuditError('CUTOVER_AUDIT_INPUT_INVALID')
  }
  return { value, json }
}

function assertOperationBinding(
  event: Pick<CutoverAuditIdentity, 'operation' | 'rollbackMode' | 'desired'>,
  context: z.core.$RefinementCtx
): void {
  const rollback = event.operation === 'rollback' && event.rollbackMode !== null &&
    event.desired === null
  const recover = event.operation === 'recover' && event.rollbackMode === null &&
    event.desired !== null
  const ordinary = (event.operation === 'prepare' || event.operation === 'activate') &&
    event.rollbackMode === null && event.desired === null
  if (!rollback && !recover && !ordinary) context.addIssue({ code: 'custom', message: 'binding' })
}

function assertTerminalOperationBinding(
  event: Pick<CutoverAuditTerminalEvent,
    'operation' | 'rollbackMode' | 'desired' | 'outcome' | 'receiptPhase' | 'receiptReused'>,
  context: z.core.$RefinementCtx
): void {
  if (event.outcome === 'succeeded') {
    const expectedPhase = event.operation === 'prepare'
      ? 'prepared'
      : event.operation === 'activate'
        ? 'activated'
        : event.operation === 'rollback'
          ? event.rollbackMode === 'immediate-compensation'
            ? 'rolled-back-immediate'
            : event.rollbackMode === 'later-operator-rollback'
              ? 'rolled-back-later'
              : null
          : event.operation === 'recover' && event.desired !== null
            ? `recovered-${event.desired}`
            : null
    if (expectedPhase === null || event.receiptPhase !== expectedPhase ||
        event.receiptReused === null) {
      context.addIssue({ code: 'custom', message: 'terminal-binding' })
    }
    return
  }

  if (event.receiptPhase === null) return
  const recoveredOrdinary = event.operation !== 'recover' &&
    (event.receiptPhase === 'recovered-candidate' || event.receiptPhase === 'recovered-previous') &&
    (event.outcome === 'failed' || event.outcome === 'recovery-required') &&
    (event.operation !== 'prepare' || event.receiptPhase === 'recovered-previous')
  if (!recoveredOrdinary) context.addIssue({ code: 'custom', message: 'terminal-binding' })
}

function sameCompletion(
  event: CutoverAuditTerminalEvent,
  input: z.infer<typeof completeInputSchema>
): boolean {
  return event.attemptId === input.attemptId && event.outcome === input.outcome &&
    event.httpStatus === input.httpStatus && event.errorCode === (input.errorCode ?? null) &&
    event.receiptPhase === (input.receiptPhase ?? null) &&
    event.receiptReused === (input.receiptReused ?? null)
}

function parseLimit(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_LIST_LIMIT) {
    throw new CutoverAuditError('CUTOVER_AUDIT_INPUT_INVALID')
  }
  return value as number
}

function safeRowId(result: StatementResultingChanges): number {
  const rowId = typeof result.lastInsertRowid === 'bigint'
    ? Number(result.lastInsertRowid)
    : result.lastInsertRowid
  if (!isSafePositiveInteger(rowId) || result.changes !== 1 && result.changes !== 1n) {
    throw new CutoverAuditError('CUTOVER_AUDIT_STORE_FAILED')
  }
  return rowId
}

function assertOneChange(result: StatementResultingChanges, code: CutoverAuditErrorCode): void {
  if (result.changes !== 1 && result.changes !== 1n) throw new CutoverAuditError(code)
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonical(value))
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, sortCanonical(entry)]))
  }
  return value
}

function normalizeAuditError(error: unknown): CutoverAuditError {
  return error instanceof CutoverAuditError
    ? error
    : new CutoverAuditError('CUTOVER_AUDIT_STORE_FAILED')
}

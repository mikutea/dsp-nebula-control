import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { DatabaseSync, type StatementResultingChanges } from 'node:sqlite'
import { z } from 'zod'
import { createInitialCutoverState } from './service.js'
import type {
  CutoverDurableStore,
  CutoverJournal,
  CutoverOperation,
  CutoverStoredReceipt,
  CutoverStoredState
} from './types.js'

const DATABASE_NAME = 'cutover.db'
const MAX_STATE_JSON_BYTES = 16 * 1024
const MAX_JOURNAL_JSON_BYTES = 128 * 1024
const MAX_RECEIPT_JSON_BYTES = 64 * 1024
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type CutoverSqliteStoreErrorCode =
  | 'CUTOVER_SQLITE_PATH_INVALID'
  | 'CUTOVER_SQLITE_INPUT_INVALID'
  | 'CUTOVER_SQLITE_AUTHORITY_REVISION_MISMATCH'
  | 'CUTOVER_SQLITE_DATA_INVALID'
  | 'CUTOVER_SQLITE_JOURNAL_CONFLICT'
  | 'CUTOVER_SQLITE_RECEIPT_CONFLICT'
  | 'CUTOVER_SQLITE_CAS_MISMATCH'
  | 'CUTOVER_SQLITE_CLOSED'
  | 'CUTOVER_SQLITE_STORE_FAILED'

/**
 * Deliberately contains only a stable code. SQLite diagnostics can include SQL
 * text and the database path, so raw causes never cross this adapter boundary.
 */
export class CutoverSqliteStoreError extends Error {
  readonly code: CutoverSqliteStoreErrorCode

  constructor(code: CutoverSqliteStoreErrorCode) {
    super(code)
    this.name = 'CutoverSqliteStoreError'
    this.code = code
  }
}

const sha256Schema = z.string().regex(SHA256_PATTERN)
const requestIdSchema = z.string().uuid().regex(UUID_PATTERN)
const authoritySchema = z.enum(['previous', 'candidate'])
const operationSchema = z.enum(['prepare', 'activate', 'rollback-immediate', 'rollback-later'])
const rollbackModeSchema = z.enum(['immediate-compensation', 'later-operator-rollback'])
const phaseSchema = z.enum([
  'prepared',
  'candidate-definition-intent',
  'candidate-defined-disabled',
  'save-protection-intent',
  'save-protected',
  'baseline-restore-intent',
  'baseline-restored',
  'disable-source-intent',
  'source-disabled',
  'stop-source-intent',
  'source-stopped',
  'launch-target-intent',
  'target-enabled',
  'target-start-intent',
  'target-started',
  'recovery-intent',
  'recovery-converging',
  'terminal'
])
const publicPhaseSchema = z.enum([
  'prepared',
  'activated',
  'rolled-back-immediate',
  'rolled-back-later',
  'recovered-candidate',
  'recovered-previous'
])

const publicSummarySchema = z.strictObject({
  candidateDefined: z.boolean(),
  candidateDisabled: z.boolean(),
  previousAuthorityEnabled: z.boolean(),
  candidateAuthorityEnabled: z.boolean(),
  previousRuntimeHealthy: z.boolean(),
  candidateRuntimeHealthy: z.boolean(),
  processesStopped: z.boolean(),
  portClosed: z.boolean(),
  uniqueAuthority: z.boolean(),
  saveProtected: z.boolean(),
  baselineRestored: z.boolean(),
  currentProgressProtected: z.boolean(),
  reused: z.boolean()
})

const previewReceiptSchema = z.strictObject({
  format: z.literal('dyson-control-cutover-preview'),
  schemaVersion: z.literal(1),
  operation: z.enum(['prepare', 'activate', 'rollback']),
  requestId: requestIdSchema,
  rollbackMode: rollbackModeSchema.nullable(),
  stateRevision: sha256Schema,
  evidenceDigest: sha256Schema,
  planFingerprint: sha256Schema,
  summary: publicSummarySchema
}).superRefine((preview, context) => {
  const coherent = preview.operation === 'rollback'
    ? preview.rollbackMode !== null
    : preview.rollbackMode === null
  if (!coherent || preview.summary.reused) {
    context.addIssue({ code: 'custom', message: 'preview-binding' })
  }
})

const authorityMutationSchema = z.strictObject({
  phase: z.enum(['not-started', 'intent-persisted', 'receipt-persisted']),
  method: z.enum(['defineCandidateDisabled', 'enableCandidateAuthority', 'disableCandidateAuthority']),
  mode: z.enum(['PrepareDisabled', 'Activate']),
  childRequestId: requestIdSchema.nullable(),
  attempt: z.number().int().min(0).max(64),
  state: z.enum(['idle', 'pending', 'succeeded', 'rolled-back', 'recovery-required']),
  receiptDigest: sha256Schema.nullable()
}).superRefine((transaction, context) => {
  if (transaction.mode !== authorityMutationModeForMethod(transaction.method)) {
    context.addIssue({ code: 'custom', message: 'authority-mutation-mode' })
  }
  const idle = transaction.phase === 'not-started' && transaction.childRequestId === null &&
    transaction.attempt === 0 && transaction.state === 'idle' && transaction.receiptDigest === null
  const pending = transaction.phase === 'intent-persisted' && transaction.childRequestId !== null &&
    transaction.attempt > 0 && transaction.state === 'pending' && transaction.receiptDigest === null
  const terminal = transaction.phase === 'receipt-persisted' && transaction.childRequestId !== null &&
    transaction.attempt > 0 && (
      ((transaction.state === 'succeeded' || transaction.state === 'rolled-back') &&
        transaction.receiptDigest !== null) || transaction.state === 'recovery-required'
    )
  if (!idle && !pending && !terminal) context.addIssue({ code: 'custom', message: 'transaction' })
})

const stateSchema = z.strictObject({
  format: z.literal('dyson-control-cutover-state'),
  schemaVersion: z.literal(1),
  authorityInventoryRevision: sha256Schema,
  revision: sha256Schema,
  prepared: z.boolean(),
  authority: authoritySchema,
  activationBaselineProtected: z.boolean(),
  lastActivationRequestId: requestIdSchema.nullable()
}).superRefine((state, context) => {
  const { revision, ...base } = state
  if (revision !== computeDigest(base)) context.addIssue({ code: 'custom', message: 'revision' })
  if (!state.prepared && (state.authority !== 'previous' || state.activationBaselineProtected ||
      state.lastActivationRequestId !== null)) {
    context.addIssue({ code: 'custom', message: 'unprepared-state' })
  }
  if (state.authority === 'candidate' && (!state.prepared || !state.activationBaselineProtected ||
      state.lastActivationRequestId === null)) {
    context.addIssue({ code: 'custom', message: 'candidate-state' })
  }
  if (state.authority === 'previous' && state.activationBaselineProtected) {
    context.addIssue({ code: 'custom', message: 'previous-state' })
  }
})

const journalSchema = z.strictObject({
  format: z.literal('dyson-control-cutover-journal'),
  schemaVersion: z.literal(1),
  requestId: requestIdSchema,
  authorityInventoryRevision: sha256Schema,
  fingerprint: sha256Schema,
  acceptedPreview: previewReceiptSchema.nullable(),
  operation: operationSchema,
  rollbackMode: rollbackModeSchema.nullable(),
  source: authoritySchema,
  target: authoritySchema,
  baseState: stateSchema,
  phase: phaseSchema,
  sequence: z.number().int().min(0).max(1_000),
  baselineSaveProtected: z.boolean(),
  baselineRestored: z.boolean(),
  currentProgressProtected: z.boolean(),
  possibleLiveMutation: z.boolean(),
  terminalDesired: authoritySchema.nullable(),
  evidence: publicSummarySchema,
  authorityMutation: authorityMutationSchema
}).superRefine((journal, context) => {
  if (journal.fingerprint !== operationFingerprint(
    journal.requestId,
    journal.operation,
    journal.rollbackMode,
    journal.authorityInventoryRevision
  )) {
    context.addIssue({ code: 'custom', message: 'fingerprint' })
  }
  if ((journal.phase === 'terminal') !== (journal.terminalDesired !== null)) {
    context.addIssue({ code: 'custom', message: 'terminal' })
  }
  if (journal.acceptedPreview !== null && (
    journal.acceptedPreview.requestId !== journal.requestId ||
    journal.acceptedPreview.operation !== publicOperationFor(journal.operation) ||
    journal.acceptedPreview.rollbackMode !== journal.rollbackMode ||
    journal.acceptedPreview.stateRevision !== journal.baseState.revision
  )) {
    context.addIssue({ code: 'custom', message: 'accepted-preview-binding' })
  }
  const correctBinding = journal.operation === 'prepare'
    ? journal.rollbackMode === null && journal.source === 'previous' && journal.target === 'previous'
    : journal.operation === 'activate'
      ? journal.rollbackMode === null && journal.source === 'previous' && journal.target === 'candidate'
      : journal.operation === 'rollback-immediate'
        ? journal.rollbackMode === 'immediate-compensation' && journal.source === 'candidate' &&
          journal.target === 'previous'
        : journal.rollbackMode === 'later-operator-rollback' && journal.source === 'candidate' &&
          journal.target === 'previous'
  if (!correctBinding) context.addIssue({ code: 'custom', message: 'binding' })
  if (journal.currentProgressProtected && journal.rollbackMode !== 'later-operator-rollback') {
    context.addIssue({ code: 'custom', message: 'progress-protection' })
  }
  if (journal.baselineRestored && !journal.baselineSaveProtected) {
    context.addIssue({ code: 'custom', message: 'baseline-restore' })
  }
  if ((journal.authorityMutation.phase === 'not-started' &&
       journal.authorityMutation.method !== authorityMutationMethodForOperation(journal.operation)) ||
      journal.baseState.authorityInventoryRevision !== journal.authorityInventoryRevision) {
    context.addIssue({ code: 'custom', message: 'authority-mutation-binding' })
  }
})

const receiptSchema = z.strictObject({
  requestId: requestIdSchema,
  phase: publicPhaseSchema,
  status: z.enum(['succeeded', 'rolled-back', 'failed-safe']),
  allowedDesired: z.array(authoritySchema).max(2),
  summary: publicSummarySchema,
  errorCode: z.null()
})

const storedReceiptSchema = z.strictObject({
  format: z.literal('dyson-control-cutover-receipt-envelope'),
  schemaVersion: z.literal(1),
  authorityInventoryRevision: sha256Schema,
  fingerprint: sha256Schema,
  acceptedPreview: previewReceiptSchema.nullable(),
  operation: operationSchema,
  receipt: receiptSchema
}).superRefine((envelope, context) => {
  if (envelope.fingerprint !== operationFingerprint(
    envelope.receipt.requestId,
    envelope.operation,
    rollbackModeForOperation(envelope.operation),
    envelope.authorityInventoryRevision
  )) {
    context.addIssue({ code: 'custom', message: 'fingerprint' })
  }
  if (envelope.acceptedPreview !== null && (
    envelope.acceptedPreview.requestId !== envelope.receipt.requestId ||
    envelope.acceptedPreview.operation !== publicOperationFor(envelope.operation) ||
    envelope.acceptedPreview.rollbackMode !== rollbackModeForOperation(envelope.operation)
  )) {
    context.addIssue({ code: 'custom', message: 'accepted-preview-binding' })
  }
  const allowedPhases: Record<CutoverOperation, readonly string[]> = {
    prepare: ['prepared', 'recovered-previous'],
    activate: ['activated', 'recovered-candidate', 'recovered-previous'],
    'rollback-immediate': ['rolled-back-immediate', 'recovered-candidate', 'recovered-previous'],
    'rollback-later': ['rolled-back-later', 'recovered-candidate', 'recovered-previous']
  }
  if (!allowedPhases[envelope.operation].includes(envelope.receipt.phase) ||
      envelope.receipt.allowedDesired.length !== 0 || envelope.receipt.summary.reused ||
      !receiptPhaseStatusCoherent(envelope.receipt)) {
    context.addIssue({ code: 'custom', message: 'receipt-semantics' })
  }
})

interface StateRow {
  authority_inventory_revision: unknown
  revision: unknown
  payload_json: unknown
}

interface JournalRow {
  request_id: unknown
  authority_inventory_revision: unknown
  fingerprint: unknown
  operation: unknown
  sequence: unknown
  phase: unknown
  payload_json: unknown
}

interface ReceiptRow {
  request_id: unknown
  authority_inventory_revision: unknown
  fingerprint: unknown
  operation: unknown
  payload_json: unknown
}

interface EncodedValue<T> {
  value: T
  json: string
}

/**
 * Independent WAL-backed durable store for the cutover state machine.
 * Construction never creates the data directory: deployment must provide one
 * fixed, already-validated ordinary directory.
 */
export class SqliteCutoverDurableStore implements CutoverDurableStore {
  readonly #database: DatabaseSync
  readonly #authorityInventoryRevision: string
  #closed = false

  constructor(dataDirectory: string, authorityInventoryRevision: string) {
    if (!SHA256_PATTERN.test(authorityInventoryRevision)) {
      throw new CutoverSqliteStoreError('CUTOVER_SQLITE_INPUT_INVALID')
    }
    const resolvedDirectory = validateDataDirectory(dataDirectory)
    const databasePath = path.join(resolvedDirectory, DATABASE_NAME)
    assertOrdinaryDatabaseArtifacts(databasePath)

    let database: DatabaseSync | undefined
    try {
      database = new DatabaseSync(databasePath)
      configureDatabase(database)
      initializeDatabase(database, authorityInventoryRevision)
    } catch (error) {
      try {
        database?.close()
      } catch {
        // The original stable error wins; close diagnostics are not returned.
      }
      throw normalizeStoreError(error)
    }

    this.#database = database
    this.#authorityInventoryRevision = authorityInventoryRevision
  }

  async readState(): Promise<unknown> {
    return this.#execute(() => this.#readRequiredState().value)
  }

  async readJournal(): Promise<unknown | null> {
    return this.#execute(() => this.#readJournal()?.value ?? null)
  }

  async readReceipt(requestId: string): Promise<unknown | null> {
    return this.#execute(() => {
      assertRequestId(requestId)
      return this.#readReceipt(requestId)?.value ?? null
    })
  }

  async createJournal(journal: CutoverJournal): Promise<void> {
    return this.#execute(() => {
      const encoded = encodeJournal(journal, this.#authorityInventoryRevision)
      if (encoded.value.sequence !== 0 || encoded.value.phase === 'terminal') {
        throw new CutoverSqliteStoreError('CUTOVER_SQLITE_INPUT_INVALID')
      }
      this.#transaction(() => {
        if (this.#readJournal() !== null) {
          throw new CutoverSqliteStoreError('CUTOVER_SQLITE_JOURNAL_CONFLICT')
        }
        if (this.#receiptExists(encoded.value.requestId)) {
          throw new CutoverSqliteStoreError('CUTOVER_SQLITE_RECEIPT_CONFLICT')
        }
        const state = this.#readRequiredState()
        if (!sameJson(state.value, encoded.value.baseState)) {
          throw new CutoverSqliteStoreError('CUTOVER_SQLITE_CAS_MISMATCH')
        }
        const changes = this.#database.prepare(`
          INSERT INTO cutover_journal (
            singleton_id, request_id, authority_inventory_revision, fingerprint,
            operation, sequence, phase, payload_json
          ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          encoded.value.requestId,
          encoded.value.authorityInventoryRevision,
          encoded.value.fingerprint,
          encoded.value.operation,
          encoded.value.sequence,
          encoded.value.phase,
          encoded.json
        )
        assertOneChange(changes, 'CUTOVER_SQLITE_JOURNAL_CONFLICT')
      })
    })
  }

  async replaceJournal(expectedSequence: number, journal: CutoverJournal): Promise<void> {
    return this.#execute(() => {
      assertExpectedSequence(expectedSequence, 999)
      const encoded = encodeJournal(journal, this.#authorityInventoryRevision)
      if (encoded.value.sequence !== expectedSequence + 1 || encoded.value.phase === 'terminal') {
        throw new CutoverSqliteStoreError('CUTOVER_SQLITE_INPUT_INVALID')
      }
      this.#transaction(() => {
        const current = this.#readJournal()
        if (current === null || current.value.phase === 'terminal' ||
            current.value.sequence !== expectedSequence ||
            !sameJournalIdentity(current.value, encoded.value)) {
          throw new CutoverSqliteStoreError('CUTOVER_SQLITE_CAS_MISMATCH')
        }
        if (this.#receiptExists(encoded.value.requestId) ||
            !sameJson(this.#readRequiredState().value, encoded.value.baseState)) {
          throw new CutoverSqliteStoreError('CUTOVER_SQLITE_CAS_MISMATCH')
        }
        const changes = this.#database.prepare(`
          UPDATE cutover_journal
             SET sequence = ?, phase = ?, payload_json = ?
           WHERE singleton_id = 1
             AND request_id = ?
             AND fingerprint = ?
             AND sequence = ?
             AND payload_json = ?
        `).run(
          encoded.value.sequence,
          encoded.value.phase,
          encoded.json,
          encoded.value.requestId,
          encoded.value.fingerprint,
          expectedSequence,
          current.json
        )
        assertOneChange(changes, 'CUTOVER_SQLITE_CAS_MISMATCH')
      })
    })
  }

  async commitTerminal(input: {
    expectedSequence: number
    journal: CutoverJournal
    nextState: CutoverStoredState
    receipt: CutoverStoredReceipt
  }): Promise<void> {
    return this.#execute(() => {
      assertExpectedSequence(input?.expectedSequence, 999)
      const journal = encodeJournal(input?.journal, this.#authorityInventoryRevision)
      const nextState = encodeState(input?.nextState, this.#authorityInventoryRevision)
      const receipt = encodeReceipt(input?.receipt, this.#authorityInventoryRevision)
      if (journal.value.phase !== 'terminal' ||
          journal.value.sequence !== input.expectedSequence + 1 ||
          receipt.value.receipt.requestId !== journal.value.requestId ||
          receipt.value.fingerprint !== journal.value.fingerprint ||
          !sameJson(receipt.value.acceptedPreview, journal.value.acceptedPreview) ||
          receipt.value.operation !== journal.value.operation ||
          !sameJson(receipt.value.receipt.summary, journal.value.evidence) ||
          journal.value.terminalDesired !== nextState.value.authority) {
        throw new CutoverSqliteStoreError('CUTOVER_SQLITE_INPUT_INVALID')
      }

      this.#transaction(() => {
        const state = this.#readRequiredState()
        const current = this.#readJournal()
        if (!sameJson(state.value, journal.value.baseState) || current === null ||
            current.value.phase === 'terminal' ||
            current.value.sequence !== input.expectedSequence ||
            !sameJournalIdentity(current.value, journal.value) ||
            !sameTerminalPredecessor(current.value, journal.value)) {
          throw new CutoverSqliteStoreError('CUTOVER_SQLITE_CAS_MISMATCH')
        }
        if (this.#receiptExists(journal.value.requestId)) {
          throw new CutoverSqliteStoreError('CUTOVER_SQLITE_RECEIPT_CONFLICT')
        }

        const journalChanges = this.#database.prepare(`
          UPDATE cutover_journal
             SET sequence = ?, phase = ?, payload_json = ?
           WHERE singleton_id = 1
             AND request_id = ?
             AND fingerprint = ?
             AND sequence = ?
             AND payload_json = ?
        `).run(
          journal.value.sequence,
          journal.value.phase,
          journal.json,
          journal.value.requestId,
          journal.value.fingerprint,
          input.expectedSequence,
          current.json
        )
        assertOneChange(journalChanges, 'CUTOVER_SQLITE_CAS_MISMATCH')

        const stateChanges = this.#database.prepare(`
          UPDATE cutover_state
             SET authority_inventory_revision = ?, revision = ?, payload_json = ?
           WHERE singleton_id = 1
             AND authority_inventory_revision = ?
             AND revision = ?
             AND payload_json = ?
        `).run(
          nextState.value.authorityInventoryRevision,
          nextState.value.revision,
          nextState.json,
          state.value.authorityInventoryRevision,
          state.value.revision,
          state.json
        )
        assertOneChange(stateChanges, 'CUTOVER_SQLITE_CAS_MISMATCH')

        const receiptChanges = this.#database.prepare(`
          INSERT INTO cutover_receipts (
            request_id, authority_inventory_revision, fingerprint, operation, payload_json
          ) VALUES (?, ?, ?, ?, ?)
        `).run(
          receipt.value.receipt.requestId,
          receipt.value.authorityInventoryRevision,
          receipt.value.fingerprint,
          receipt.value.operation,
          receipt.json
        )
        assertOneChange(receiptChanges, 'CUTOVER_SQLITE_RECEIPT_CONFLICT')
      })
    })
  }

  async clearTerminalJournal(input: {
    requestId: string
    fingerprint: string
    expectedSequence: number
  }): Promise<void> {
    return this.#execute(() => {
      assertRequestId(input?.requestId)
      if (!SHA256_PATTERN.test(input?.fingerprint) ||
          !Number.isInteger(input?.expectedSequence) || input.expectedSequence < 0 ||
          input.expectedSequence > 1_000) {
        throw new CutoverSqliteStoreError('CUTOVER_SQLITE_INPUT_INVALID')
      }
      this.#transaction(() => {
        const current = this.#readJournal()
        if (current === null) return
        if (current.value.phase !== 'terminal' ||
            current.value.requestId !== input.requestId ||
            current.value.fingerprint !== input.fingerprint ||
            current.value.sequence !== input.expectedSequence) {
          throw new CutoverSqliteStoreError('CUTOVER_SQLITE_CAS_MISMATCH')
        }
        const receipt = this.#readReceipt(input.requestId)
        const state = this.#readRequiredState()
        if (receipt === null || receipt.value.fingerprint !== current.value.fingerprint ||
            receipt.value.operation !== current.value.operation ||
            !sameJson(receipt.value.acceptedPreview, current.value.acceptedPreview) ||
            !sameJson(receipt.value.receipt.summary, current.value.evidence) ||
            current.value.terminalDesired !== state.value.authority) {
          throw new CutoverSqliteStoreError('CUTOVER_SQLITE_CAS_MISMATCH')
        }
        const changes = this.#database.prepare(`
          DELETE FROM cutover_journal
           WHERE singleton_id = 1
             AND request_id = ?
             AND fingerprint = ?
             AND sequence = ?
             AND phase = 'terminal'
             AND payload_json = ?
        `).run(input.requestId, input.fingerprint, input.expectedSequence, current.json)
        assertOneChange(changes, 'CUTOVER_SQLITE_CAS_MISMATCH')
      })
    })
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    try {
      this.#database.close()
    } catch {
      throw new CutoverSqliteStoreError('CUTOVER_SQLITE_STORE_FAILED')
    }
  }

  #readRequiredState(): EncodedValue<CutoverStoredState> {
    const row = this.#database.prepare(`
      SELECT authority_inventory_revision, revision, payload_json
        FROM cutover_state
       WHERE singleton_id = 1
    `).get() as StateRow | undefined
    if (row === undefined) throw new CutoverSqliteStoreError('CUTOVER_SQLITE_DATA_INVALID')
    return decodeStateRow(row, this.#authorityInventoryRevision)
  }

  #readJournal(): EncodedValue<CutoverJournal> | null {
    const row = this.#database.prepare(`
      SELECT request_id, authority_inventory_revision, fingerprint, operation,
             sequence, phase, payload_json
        FROM cutover_journal
       WHERE singleton_id = 1
    `).get() as JournalRow | undefined
    return row === undefined ? null : decodeJournalRow(row, this.#authorityInventoryRevision)
  }

  #readReceipt(requestId: string): EncodedValue<CutoverStoredReceipt> | null {
    const row = this.#database.prepare(`
      SELECT request_id, authority_inventory_revision, fingerprint, operation, payload_json
        FROM cutover_receipts
       WHERE request_id = ?
    `).get(requestId) as ReceiptRow | undefined
    return row === undefined ? null : decodeReceiptRow(row, this.#authorityInventoryRevision)
  }

  #receiptExists(requestId: string): boolean {
    return this.#database.prepare(`
      SELECT 1 AS present FROM cutover_receipts WHERE request_id = ?
    `).get(requestId) !== undefined
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
          // Never replace or enrich the stable original error with SQLite text.
        }
      }
      throw error
    }
  }

  #execute<T>(operation: () => T): T {
    if (this.#closed) throw new CutoverSqliteStoreError('CUTOVER_SQLITE_CLOSED')
    try {
      return operation()
    } catch (error) {
      throw normalizeStoreError(error)
    }
  }
}

// Alternate word order retained as a discoverable adapter name for wiring.
export { SqliteCutoverDurableStore as CutoverSqliteDurableStore }

function validateDataDirectory(dataDirectory: string): string {
  try {
    if (typeof dataDirectory !== 'string' || dataDirectory.length === 0 ||
        /[\0\r\n]/.test(dataDirectory) || !path.isAbsolute(dataDirectory)) {
      throw new CutoverSqliteStoreError('CUTOVER_SQLITE_PATH_INVALID')
    }
    const resolved = path.resolve(dataDirectory)
    const status = fs.lstatSync(resolved)
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new CutoverSqliteStoreError('CUTOVER_SQLITE_PATH_INVALID')
    }
    const canonical = fs.realpathSync.native(resolved)
    if (!sameFilesystemPath(canonical, resolved)) {
      throw new CutoverSqliteStoreError('CUTOVER_SQLITE_PATH_INVALID')
    }
    return resolved
  } catch (error) {
    if (error instanceof CutoverSqliteStoreError) throw error
    throw new CutoverSqliteStoreError('CUTOVER_SQLITE_PATH_INVALID')
  }
}

function assertOrdinaryDatabaseArtifacts(databasePath: string): void {
  try {
    for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      if (!fs.existsSync(candidate)) continue
      const status = fs.lstatSync(candidate)
      if (!status.isFile() || status.isSymbolicLink()) {
        throw new CutoverSqliteStoreError('CUTOVER_SQLITE_PATH_INVALID')
      }
    }
  } catch (error) {
    if (error instanceof CutoverSqliteStoreError) throw error
    throw new CutoverSqliteStoreError('CUTOVER_SQLITE_PATH_INVALID')
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
    throw new CutoverSqliteStoreError('CUTOVER_SQLITE_STORE_FAILED')
  }
}

function initializeDatabase(database: DatabaseSync, authorityInventoryRevision: string): void {
  runTransaction(database, () => {
    const expectedObjects = new Map<string, string>([
      ['cutover_state', 'table'],
      ['cutover_journal', 'table'],
      ['cutover_receipts', 'table'],
      ['cutover_receipts_immutable_update', 'trigger'],
      ['cutover_receipts_immutable_delete', 'trigger']
    ])
    const existingObjects = database.prepare(`
      SELECT name, type
        FROM sqlite_master
       WHERE name IN (
         'cutover_state', 'cutover_journal', 'cutover_receipts',
         'cutover_receipts_immutable_update', 'cutover_receipts_immutable_delete'
       )
    `).all() as Array<{ name?: unknown; type?: unknown }>
    const fresh = existingObjects.length === 0
    if (!fresh && (existingObjects.length !== expectedObjects.size ||
        existingObjects.some((entry) => typeof entry.name !== 'string' ||
          entry.type !== expectedObjects.get(entry.name)))) {
      throw new CutoverSqliteStoreError('CUTOVER_SQLITE_DATA_INVALID')
    }

    if (fresh) {
      database.exec(`
        CREATE TABLE cutover_state (
        singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
        authority_inventory_revision TEXT NOT NULL,
        revision TEXT NOT NULL,
        payload_json TEXT NOT NULL
          CHECK(json_valid(payload_json) = 1)
          CHECK(length(CAST(payload_json AS BLOB)) BETWEEN 2 AND ${MAX_STATE_JSON_BYTES})
      ) STRICT;

        CREATE TABLE cutover_journal (
        singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
        request_id TEXT NOT NULL,
        authority_inventory_revision TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        operation TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK(sequence BETWEEN 0 AND 1000),
        phase TEXT NOT NULL,
        payload_json TEXT NOT NULL
          CHECK(json_valid(payload_json) = 1)
          CHECK(length(CAST(payload_json AS BLOB)) BETWEEN 2 AND ${MAX_JOURNAL_JSON_BYTES})
      ) STRICT;

        CREATE TABLE cutover_receipts (
        request_id TEXT PRIMARY KEY,
        authority_inventory_revision TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        operation TEXT NOT NULL,
        payload_json TEXT NOT NULL
          CHECK(json_valid(payload_json) = 1)
          CHECK(length(CAST(payload_json AS BLOB)) BETWEEN 2 AND ${MAX_RECEIPT_JSON_BYTES})
      ) STRICT;

        CREATE TRIGGER cutover_receipts_immutable_update
        BEFORE UPDATE ON cutover_receipts
        BEGIN
          SELECT RAISE(ABORT, 'cutover-receipt-immutable');
        END;

        CREATE TRIGGER cutover_receipts_immutable_delete
        BEFORE DELETE ON cutover_receipts
        BEGIN
          SELECT RAISE(ABORT, 'cutover-receipt-immutable');
        END;
      `)
    }

    const row = database.prepare(`
      SELECT authority_inventory_revision, revision, payload_json
        FROM cutover_state
       WHERE singleton_id = 1
    `).get() as StateRow | undefined
    if (row === undefined) {
      if (!fresh) throw new CutoverSqliteStoreError('CUTOVER_SQLITE_DATA_INVALID')
      const initial = encodeState(createInitialCutoverState(authorityInventoryRevision), authorityInventoryRevision)
      const changes = database.prepare(`
        INSERT INTO cutover_state (
          singleton_id, authority_inventory_revision, revision, payload_json
        ) VALUES (1, ?, ?, ?)
      `).run(initial.value.authorityInventoryRevision, initial.value.revision, initial.json)
      assertOneChange(changes, 'CUTOVER_SQLITE_STORE_FAILED')
      return
    }
    decodeStateRow(row, authorityInventoryRevision)
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
        // The caller receives only the original stable error.
      }
    }
    throw error
  }
}

function decodeStateRow(
  row: StateRow,
  authorityInventoryRevision: string
): EncodedValue<CutoverStoredState> {
  const encoded = decodeState(row.payload_json, authorityInventoryRevision)
  if (row.authority_inventory_revision !== encoded.value.authorityInventoryRevision ||
      row.revision !== encoded.value.revision || row.payload_json !== encoded.json) {
    throw new CutoverSqliteStoreError('CUTOVER_SQLITE_DATA_INVALID')
  }
  return { value: encoded.value, json: row.payload_json as string }
}

function decodeJournalRow(
  row: JournalRow,
  authorityInventoryRevision: string
): EncodedValue<CutoverJournal> {
  const encoded = decodeJournal(row.payload_json, authorityInventoryRevision)
  if (row.request_id !== encoded.value.requestId ||
      row.authority_inventory_revision !== encoded.value.authorityInventoryRevision ||
      row.fingerprint !== encoded.value.fingerprint || row.operation !== encoded.value.operation ||
      row.sequence !== encoded.value.sequence || row.phase !== encoded.value.phase ||
      row.payload_json !== encoded.json) {
    throw new CutoverSqliteStoreError('CUTOVER_SQLITE_DATA_INVALID')
  }
  return { value: encoded.value, json: row.payload_json as string }
}

function decodeReceiptRow(
  row: ReceiptRow,
  authorityInventoryRevision: string
): EncodedValue<CutoverStoredReceipt> {
  const encoded = decodeReceipt(row.payload_json, authorityInventoryRevision)
  if (row.request_id !== encoded.value.receipt.requestId ||
      row.authority_inventory_revision !== encoded.value.authorityInventoryRevision ||
      row.fingerprint !== encoded.value.fingerprint || row.operation !== encoded.value.operation ||
      row.payload_json !== encoded.json) {
    throw new CutoverSqliteStoreError('CUTOVER_SQLITE_DATA_INVALID')
  }
  return { value: encoded.value, json: row.payload_json as string }
}

function encodeState(value: unknown, authorityInventoryRevision: string): EncodedValue<CutoverStoredState> {
  const parsed = stateSchema.safeParse(value)
  if (!parsed.success) throw new CutoverSqliteStoreError('CUTOVER_SQLITE_INPUT_INVALID')
  if (parsed.data.authorityInventoryRevision !== authorityInventoryRevision) {
    throw new CutoverSqliteStoreError('CUTOVER_SQLITE_AUTHORITY_REVISION_MISMATCH')
  }
  return encodeParsed(parsed.data as CutoverStoredState, MAX_STATE_JSON_BYTES)
}

function decodeState(value: unknown, authorityInventoryRevision: string): EncodedValue<CutoverStoredState> {
  const parsed = parseJson(value, MAX_STATE_JSON_BYTES)
  const result = stateSchema.safeParse(parsed)
  if (!result.success) throw new CutoverSqliteStoreError('CUTOVER_SQLITE_DATA_INVALID')
  if (result.data.authorityInventoryRevision !== authorityInventoryRevision) {
    throw new CutoverSqliteStoreError('CUTOVER_SQLITE_AUTHORITY_REVISION_MISMATCH')
  }
  return encodeParsed(result.data as CutoverStoredState, MAX_STATE_JSON_BYTES)
}

function encodeJournal(value: unknown, authorityInventoryRevision: string): EncodedValue<CutoverJournal> {
  const parsed = journalSchema.safeParse(value)
  if (!parsed.success) throw new CutoverSqliteStoreError('CUTOVER_SQLITE_INPUT_INVALID')
  if (parsed.data.authorityInventoryRevision !== authorityInventoryRevision) {
    throw new CutoverSqliteStoreError('CUTOVER_SQLITE_AUTHORITY_REVISION_MISMATCH')
  }
  return encodeParsed(parsed.data as CutoverJournal, MAX_JOURNAL_JSON_BYTES)
}

function decodeJournal(value: unknown, authorityInventoryRevision: string): EncodedValue<CutoverJournal> {
  const parsed = parseJson(value, MAX_JOURNAL_JSON_BYTES)
  const result = journalSchema.safeParse(parsed)
  if (!result.success) throw new CutoverSqliteStoreError('CUTOVER_SQLITE_DATA_INVALID')
  if (result.data.authorityInventoryRevision !== authorityInventoryRevision) {
    throw new CutoverSqliteStoreError('CUTOVER_SQLITE_AUTHORITY_REVISION_MISMATCH')
  }
  return encodeParsed(result.data as CutoverJournal, MAX_JOURNAL_JSON_BYTES)
}

function encodeReceipt(
  value: unknown,
  authorityInventoryRevision: string
): EncodedValue<CutoverStoredReceipt> {
  const parsed = storedReceiptSchema.safeParse(value)
  if (!parsed.success) throw new CutoverSqliteStoreError('CUTOVER_SQLITE_INPUT_INVALID')
  if (parsed.data.authorityInventoryRevision !== authorityInventoryRevision) {
    throw new CutoverSqliteStoreError('CUTOVER_SQLITE_AUTHORITY_REVISION_MISMATCH')
  }
  return encodeParsed(parsed.data as CutoverStoredReceipt, MAX_RECEIPT_JSON_BYTES)
}

function decodeReceipt(
  value: unknown,
  authorityInventoryRevision: string
): EncodedValue<CutoverStoredReceipt> {
  const parsed = parseJson(value, MAX_RECEIPT_JSON_BYTES)
  const result = storedReceiptSchema.safeParse(parsed)
  if (!result.success) throw new CutoverSqliteStoreError('CUTOVER_SQLITE_DATA_INVALID')
  if (result.data.authorityInventoryRevision !== authorityInventoryRevision) {
    throw new CutoverSqliteStoreError('CUTOVER_SQLITE_AUTHORITY_REVISION_MISMATCH')
  }
  return encodeParsed(result.data as CutoverStoredReceipt, MAX_RECEIPT_JSON_BYTES)
}

function encodeParsed<T>(value: T, maximumBytes: number): EncodedValue<T> {
  const json = canonicalJson(value)
  const bytes = Buffer.byteLength(json, 'utf8')
  if (bytes < 2 || bytes > maximumBytes || json.includes('\0')) {
    throw new CutoverSqliteStoreError('CUTOVER_SQLITE_INPUT_INVALID')
  }
  return { value, json }
}

function parseJson(value: unknown, maximumBytes: number): unknown {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new CutoverSqliteStoreError('CUTOVER_SQLITE_DATA_INVALID')
  }
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes < 2 || bytes > maximumBytes) {
    throw new CutoverSqliteStoreError('CUTOVER_SQLITE_DATA_INVALID')
  }
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new CutoverSqliteStoreError('CUTOVER_SQLITE_DATA_INVALID')
  }
}

function assertExpectedSequence(value: unknown, maximum: number): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new CutoverSqliteStoreError('CUTOVER_SQLITE_INPUT_INVALID')
  }
}

function assertRequestId(value: unknown): asserts value is string {
  if (!requestIdSchema.safeParse(value).success) {
    throw new CutoverSqliteStoreError('CUTOVER_SQLITE_INPUT_INVALID')
  }
}

function assertOneChange(
  result: StatementResultingChanges,
  code: CutoverSqliteStoreErrorCode
): void {
  if (result.changes !== 1 && result.changes !== 1n) throw new CutoverSqliteStoreError(code)
}

function sameJournalIdentity(left: CutoverJournal, right: CutoverJournal): boolean {
  return left.requestId === right.requestId &&
    left.authorityInventoryRevision === right.authorityInventoryRevision &&
    left.fingerprint === right.fingerprint && left.operation === right.operation &&
    left.rollbackMode === right.rollbackMode && left.source === right.source &&
    left.target === right.target && sameJson(left.baseState, right.baseState) &&
    sameJson(left.acceptedPreview, right.acceptedPreview)
}

function sameTerminalPredecessor(current: CutoverJournal, terminal: CutoverJournal): boolean {
  return current.baselineSaveProtected === terminal.baselineSaveProtected &&
    current.baselineRestored === terminal.baselineRestored &&
    current.currentProgressProtected === terminal.currentProgressProtected &&
    current.possibleLiveMutation === terminal.possibleLiveMutation &&
    sameJson(current.authorityMutation, terminal.authorityMutation)
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function authorityMutationMethodForOperation(
  operation: CutoverOperation
): CutoverJournal['authorityMutation']['method'] {
  if (operation === 'prepare') return 'defineCandidateDisabled'
  if (operation === 'activate') return 'enableCandidateAuthority'
  return 'disableCandidateAuthority'
}

function authorityMutationModeForMethod(
  method: CutoverJournal['authorityMutation']['method']
): CutoverJournal['authorityMutation']['mode'] {
  return method === 'enableCandidateAuthority' ? 'Activate' : 'PrepareDisabled'
}

function rollbackModeForOperation(operation: CutoverOperation): CutoverJournal['rollbackMode'] {
  return operation === 'rollback-immediate'
    ? 'immediate-compensation'
    : operation === 'rollback-later'
      ? 'later-operator-rollback'
      : null
}

function publicOperationFor(operation: CutoverOperation): 'prepare' | 'activate' | 'rollback' {
  return operation === 'rollback-immediate' || operation === 'rollback-later'
    ? 'rollback'
    : operation
}

function receiptPhaseStatusCoherent(receipt: CutoverStoredReceipt['receipt']): boolean {
  if (receipt.phase === 'prepared' || receipt.phase === 'activated' ||
      receipt.phase === 'recovered-candidate') {
    return receipt.status === 'succeeded'
  }
  if (receipt.phase === 'rolled-back-immediate' || receipt.phase === 'rolled-back-later') {
    return receipt.status === 'rolled-back'
  }
  return receipt.status === 'succeeded' || receipt.status === 'rolled-back'
}

function operationFingerprint(
  requestId: string,
  operation: CutoverOperation,
  rollbackMode: CutoverJournal['rollbackMode'],
  authorityInventoryRevision: string
): string {
  return computeDigest({ authorityInventoryRevision, operation, requestId, rollbackMode })
}

function computeDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
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

function normalizeStoreError(error: unknown): CutoverSqliteStoreError {
  return error instanceof CutoverSqliteStoreError
    ? error
    : new CutoverSqliteStoreError('CUTOVER_SQLITE_STORE_FAILED')
}

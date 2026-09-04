import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createInitialCutoverState } from './service.js'
import {
  CutoverSqliteStoreError,
  SqliteCutoverDurableStore,
  type CutoverSqliteStoreErrorCode
} from './sqlite-store.js'
import type {
  CutoverJournal,
  CutoverPublicSummary,
  CutoverStoredReceipt,
  CutoverStoredState
} from './types.js'

const AUTHORITY_INVENTORY_REVISION = 'a'.repeat(64)
const OTHER_AUTHORITY_INVENTORY_REVISION = 'b'.repeat(64)
const REQUEST_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_REQUEST_ID = '22222222-2222-4222-8222-222222222222'

describe('SqliteCutoverDurableStore', () => {
  let root: string
  let directory: string
  const stores: SqliteCutoverDurableStore[] = []

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dyson-cutover-sqlite-'))
    directory = path.join(root, 'data')
    fs.mkdirSync(directory)
  })

  afterEach(() => {
    for (const store of stores.reverse()) store.close()
    if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  function open(
    target = directory,
    revision = AUTHORITY_INVENTORY_REVISION
  ): SqliteCutoverDurableStore {
    const store = new SqliteCutoverDurableStore(target, revision)
    stores.push(store)
    return store
  }

  it('requires a fixed existing ordinary absolute data directory and rejects redirects', () => {
    expect(() => new SqliteCutoverDurableStore('relative-data', AUTHORITY_INVENTORY_REVISION))
      .toThrowError(codeError('CUTOVER_SQLITE_PATH_INVALID'))
    expect(() => new SqliteCutoverDurableStore(path.join(root, 'missing'), AUTHORITY_INVENTORY_REVISION))
      .toThrowError(codeError('CUTOVER_SQLITE_PATH_INVALID'))

    const target = path.join(root, 'target')
    const redirected = path.join(root, 'redirected')
    fs.mkdirSync(target)
    fs.symlinkSync(target, redirected, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => new SqliteCutoverDurableStore(redirected, AUTHORITY_INVENTORY_REVISION))
      .toThrowError(codeError('CUTOVER_SQLITE_PATH_INVALID'))
  })

  it('atomically initializes once, uses WAL, and never migrates an existing authority revision', async () => {
    const store = open()
    expect(await store.readState()).toEqual(createInitialCutoverState(AUTHORITY_INVENTORY_REVISION))

    const raw = new DatabaseSync(path.join(directory, 'cutover.db'), { readOnly: true })
    expect(raw.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' })
    expect(raw.prepare('SELECT COUNT(*) AS count FROM cutover_state').get()).toEqual({ count: 1 })
    raw.close()

    store.close()
    expect(() => new SqliteCutoverDurableStore(directory, OTHER_AUTHORITY_INVENTORY_REVISION))
      .toThrowError(codeError('CUTOVER_SQLITE_AUTHORITY_REVISION_MISMATCH'))

    const reopened = open()
    expect(await reopened.readState()).toEqual(createInitialCutoverState(AUTHORITY_INVENTORY_REVISION))
  })

  it('persists journal CAS, terminal state, immutable receipt, and clear across reopen', async () => {
    const store = open()
    const initial = await stateOf(store)
    const journal = prepareJournal(initial)
    await store.createJournal(journal)

    const advanced = advanceJournal(journal, 'candidate-definition-intent')
    await store.replaceJournal(journal.sequence, advanced)
    const terminal = terminalJournal(advanced)
    const nextState = preparedState()
    const receipt = prepareReceipt(terminal)
    await store.commitTerminal({
      expectedSequence: advanced.sequence,
      journal: terminal,
      nextState,
      receipt
    })
    store.close()

    const reopened = open()
    expect(await reopened.readState()).toEqual(nextState)
    expect(await reopened.readJournal()).toEqual(terminal)
    expect(await reopened.readReceipt(REQUEST_ID)).toEqual(receipt)
    await reopened.clearTerminalJournal({
      requestId: REQUEST_ID,
      fingerprint: terminal.fingerprint,
      expectedSequence: terminal.sequence
    })
    reopened.close()

    const afterClear = open()
    expect(await afterClear.readJournal()).toBeNull()
    expect(await afterClear.readReceipt(REQUEST_ID)).toEqual(receipt)
  })

  it('rejects pending-journal and immutable-receipt idempotency conflicts', async () => {
    const store = open()
    const initial = await stateOf(store)
    const journal = prepareJournal(initial)
    await store.createJournal(journal)
    await expectCode(store.createJournal(journal), 'CUTOVER_SQLITE_JOURNAL_CONFLICT', directory)

    const terminal = terminalJournal(journal)
    const nextState = preparedState()
    await store.commitTerminal({
      expectedSequence: journal.sequence,
      journal: terminal,
      nextState,
      receipt: prepareReceipt(terminal)
    })
    await store.clearTerminalJournal({
      requestId: terminal.requestId,
      fingerprint: terminal.fingerprint,
      expectedSequence: terminal.sequence
    })

    const replay = prepareJournal(nextState)
    await expectCode(store.createJournal(replay), 'CUTOVER_SQLITE_RECEIPT_CONFLICT', directory)
    expect(await store.readReceipt(REQUEST_ID)).toEqual(prepareReceipt(terminal))
  })

  it('serializes concurrent writers so exactly one expected-sequence CAS wins', async () => {
    const first = open()
    const second = open()
    const journal = prepareJournal(await stateOf(first))
    await first.createJournal(journal)

    const firstContender = advanceJournal(journal, 'candidate-definition-intent')
    const secondContender = advanceJournal(journal, 'candidate-defined-disabled')
    const results = await Promise.allSettled([
      first.replaceJournal(0, firstContender),
      second.replaceJournal(0, secondContender)
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejection = results.find((result) => result.status === 'rejected')
    expect(rejection).toMatchObject({
      status: 'rejected',
      reason: { code: 'CUTOVER_SQLITE_CAS_MISMATCH', message: 'CUTOVER_SQLITE_CAS_MISMATCH' }
    })
    expect(await first.readJournal()).toEqual(expect.objectContaining({
      sequence: 1,
      phase: expect.stringMatching(/^(candidate-definition-intent|candidate-defined-disabled)$/)
    }))
  })

  it('rolls back journal and state when receipt persistence fails inside terminal commit', async () => {
    const store = open()
    const initial = await stateOf(store)
    const journal = prepareJournal(initial)
    await store.createJournal(journal)

    const raw = new DatabaseSync(path.join(directory, 'cutover.db'))
    raw.exec(`
      CREATE TRIGGER cutover_test_abort_receipt
      BEFORE INSERT ON cutover_receipts
      BEGIN
        SELECT RAISE(ABORT, 'injected');
      END;
    `)
    raw.close()

    const terminal = terminalJournal(journal)
    await expectCode(store.commitTerminal({
      expectedSequence: journal.sequence,
      journal: terminal,
      nextState: preparedState(),
      receipt: prepareReceipt(terminal)
    }), 'CUTOVER_SQLITE_STORE_FAILED', directory)

    expect(await store.readState()).toEqual(initial)
    expect(await store.readJournal()).toEqual(journal)
    expect(await store.readReceipt(REQUEST_ID)).toBeNull()
  })

  it('refuses terminal commit when the persisted state is no longer the exact journal base', async () => {
    const store = open()
    const initial = await stateOf(store)
    const journal = prepareJournal(initial)
    await store.createJournal(journal)

    const driftedState = preparedState()
    const raw = new DatabaseSync(path.join(directory, 'cutover.db'))
    raw.prepare(`
      UPDATE cutover_state
         SET authority_inventory_revision = ?, revision = ?, payload_json = ?
       WHERE singleton_id = 1
    `).run(
      driftedState.authorityInventoryRevision,
      driftedState.revision,
      canonicalJson(driftedState)
    )
    raw.close()

    const terminal = terminalJournal(journal)
    await expectCode(store.commitTerminal({
      expectedSequence: journal.sequence,
      journal: terminal,
      nextState: driftedState,
      receipt: prepareReceipt(terminal)
    }), 'CUTOVER_SQLITE_CAS_MISMATCH', directory)
    expect(await store.readState()).toEqual(driftedState)
    expect(await store.readJournal()).toEqual(journal)
    expect(await store.readReceipt(REQUEST_ID)).toBeNull()
  })

  it('keeps a terminal journal on every wrong clear binding and makes the exact clear idempotent', async () => {
    const store = open()
    const journal = prepareJournal(await stateOf(store))
    await store.createJournal(journal)
    const terminal = terminalJournal(journal)
    await store.commitTerminal({
      expectedSequence: journal.sequence,
      journal: terminal,
      nextState: preparedState(),
      receipt: prepareReceipt(terminal)
    })

    await expectCode(store.clearTerminalJournal({
      requestId: OTHER_REQUEST_ID,
      fingerprint: terminal.fingerprint,
      expectedSequence: terminal.sequence
    }), 'CUTOVER_SQLITE_CAS_MISMATCH', directory)
    await expectCode(store.clearTerminalJournal({
      requestId: terminal.requestId,
      fingerprint: 'f'.repeat(64),
      expectedSequence: terminal.sequence
    }), 'CUTOVER_SQLITE_CAS_MISMATCH', directory)
    await expectCode(store.clearTerminalJournal({
      requestId: terminal.requestId,
      fingerprint: terminal.fingerprint,
      expectedSequence: terminal.sequence - 1
    }), 'CUTOVER_SQLITE_CAS_MISMATCH', directory)
    expect(await store.readJournal()).toEqual(terminal)

    const binding = {
      requestId: terminal.requestId,
      fingerprint: terminal.fingerprint,
      expectedSequence: terminal.sequence
    }
    await store.clearTerminalJournal(binding)
    await store.clearTerminalJournal(binding)
    expect(await store.readJournal()).toBeNull()
  })

  it('fails closed on malformed, projection-tampered, and oversized persisted JSON', async () => {
    const missingStateDirectory = createDataDirectory(root, 'missing-state')
    const missingState = open(missingStateDirectory)
    missingState.close()
    updateIgnoringChecks(missingStateDirectory, 'DELETE FROM cutover_state WHERE singleton_id = 1')
    expect(() => new SqliteCutoverDurableStore(
      missingStateDirectory,
      AUTHORITY_INVENTORY_REVISION
    )).toThrowError(codeError('CUTOVER_SQLITE_DATA_INVALID'))

    const malformedDirectory = createDataDirectory(root, 'malformed')
    const malformed = open(malformedDirectory)
    malformed.close()
    updateIgnoringChecks(malformedDirectory, `
      UPDATE cutover_state SET payload_json = '{not-json' WHERE singleton_id = 1
    `)
    expect(() => new SqliteCutoverDurableStore(
      malformedDirectory,
      AUTHORITY_INVENTORY_REVISION
    )).toThrowError(codeError('CUTOVER_SQLITE_DATA_INVALID'))

    const tamperedDirectory = createDataDirectory(root, 'tampered')
    const tampered = open(tamperedDirectory)
    const journal = prepareJournal(await stateOf(tampered))
    await tampered.createJournal(journal)
    tampered.close()
    const payload = { ...journal, phase: 'candidate-definition-intent' as const }
    updateIgnoringChecks(tamperedDirectory, `
      UPDATE cutover_journal SET payload_json = ? WHERE singleton_id = 1
    `, canonicalJson(payload))
    const tamperedReopen = open(tamperedDirectory)
    await expectCode(tamperedReopen.readJournal(), 'CUTOVER_SQLITE_DATA_INVALID', tamperedDirectory)

    const oversizedDirectory = createDataDirectory(root, 'oversized')
    const oversized = open(oversizedDirectory)
    await oversized.createJournal(prepareJournal(await stateOf(oversized)))
    oversized.close()
    updateIgnoringChecks(oversizedDirectory, `
      UPDATE cutover_journal SET payload_json = ? WHERE singleton_id = 1
    `, JSON.stringify({ padding: 'x'.repeat(160 * 1024) }))
    const oversizedReopen = open(oversizedDirectory)
    await expectCode(oversizedReopen.readJournal(), 'CUTOVER_SQLITE_DATA_INVALID', oversizedDirectory)
  })
})

function prepareJournal(state: CutoverStoredState): CutoverJournal {
  const fingerprint = operationFingerprint(REQUEST_ID, 'prepare', null, AUTHORITY_INVENTORY_REVISION)
  return {
    format: 'dyson-control-cutover-journal',
    schemaVersion: 1,
    requestId: REQUEST_ID,
    authorityInventoryRevision: AUTHORITY_INVENTORY_REVISION,
    fingerprint,
    acceptedPreview: null,
    operation: 'prepare',
    rollbackMode: null,
    source: 'previous',
    target: 'previous',
    baseState: state,
    phase: 'prepared',
    sequence: 0,
    baselineSaveProtected: false,
    baselineRestored: false,
    currentProgressProtected: false,
    possibleLiveMutation: false,
    terminalDesired: null,
    evidence: emptySummary(),
    authorityMutation: {
      phase: 'not-started',
      method: 'defineCandidateDisabled',
      mode: 'PrepareDisabled',
      childRequestId: null,
      attempt: 0,
      state: 'idle',
      receiptDigest: null
    }
  }
}

function advanceJournal(
  journal: CutoverJournal,
  phase: CutoverJournal['phase']
): CutoverJournal {
  return { ...journal, phase, sequence: journal.sequence + 1 }
}

function terminalJournal(journal: CutoverJournal): CutoverJournal {
  return {
    ...journal,
    phase: 'terminal',
    sequence: journal.sequence + 1,
    terminalDesired: 'previous',
    evidence: emptySummary()
  }
}

function preparedState(): CutoverStoredState {
  const base = {
    format: 'dyson-control-cutover-state' as const,
    schemaVersion: 1 as const,
    authorityInventoryRevision: AUTHORITY_INVENTORY_REVISION,
    prepared: true,
    authority: 'previous' as const,
    activationBaselineProtected: false,
    lastActivationRequestId: null
  }
  return { ...base, revision: digest(base) }
}

function prepareReceipt(journal: CutoverJournal): CutoverStoredReceipt {
  return {
    format: 'dyson-control-cutover-receipt-envelope',
    schemaVersion: 1,
    authorityInventoryRevision: AUTHORITY_INVENTORY_REVISION,
    fingerprint: journal.fingerprint,
    acceptedPreview: journal.acceptedPreview,
    operation: 'prepare',
    receipt: {
      requestId: REQUEST_ID,
      phase: 'prepared',
      status: 'succeeded',
      allowedDesired: [],
      summary: emptySummary(),
      errorCode: null
    }
  }
}

function emptySummary(): CutoverPublicSummary {
  return {
    candidateDefined: false,
    candidateDisabled: false,
    previousAuthorityEnabled: false,
    candidateAuthorityEnabled: false,
    previousRuntimeHealthy: false,
    candidateRuntimeHealthy: false,
    processesStopped: false,
    portClosed: false,
    uniqueAuthority: false,
    saveProtected: false,
    baselineRestored: false,
    currentProgressProtected: false,
    reused: false
  }
}

async function stateOf(store: SqliteCutoverDurableStore): Promise<CutoverStoredState> {
  return await store.readState() as CutoverStoredState
}

function createDataDirectory(root: string, name: string): string {
  const result = path.join(root, name)
  fs.mkdirSync(result)
  return result
}

function updateIgnoringChecks(directory: string, sql: string, parameter?: string): void {
  const raw = new DatabaseSync(path.join(directory, 'cutover.db'))
  raw.exec('PRAGMA ignore_check_constraints = ON')
  if (parameter === undefined) raw.exec(sql)
  else raw.prepare(sql).run(parameter)
  raw.close()
}

async function expectCode(
  promise: Promise<unknown>,
  code: CutoverSqliteStoreErrorCode,
  secretPath: string
): Promise<void> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason
  )
  expect(error).toBeInstanceOf(CutoverSqliteStoreError)
  expect(error).toMatchObject({ code, message: code })
  expect(String(error)).not.toContain(secretPath)
  expect(error).not.toHaveProperty('cause')
}

function codeError(code: CutoverSqliteStoreErrorCode): CutoverSqliteStoreError {
  return new CutoverSqliteStoreError(code)
}

function operationFingerprint(
  requestId: string,
  operation: 'prepare',
  rollbackMode: null,
  authorityInventoryRevision: string
): string {
  return digest({ authorityInventoryRevision, operation, requestId, rollbackMode })
}

function digest(value: unknown): string {
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

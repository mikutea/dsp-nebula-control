import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createCutoverAuditAttemptId,
  CutoverAuditError,
  SqliteCutoverAuditStore,
  type CutoverAuditBeginInput,
  type CutoverAuditCompleteInput,
  type CutoverAuditErrorCode
} from './audit.js'

describe('SqliteCutoverAuditStore', () => {
  let root: string
  let directory: string
  const stores: SqliteCutoverAuditStore[] = []

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dyson-cutover-audit-'))
    directory = createDirectory(root, 'data')
  })

  afterEach(() => {
    for (const store of stores.reverse()) store.close()
    if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  function open(target = directory): SqliteCutoverAuditStore {
    const store = new SqliteCutoverAuditStore(target)
    stores.push(store)
    return store
  }

  it('requires an existing ordinary absolute directory and rejects reparse redirects', () => {
    expect(() => new SqliteCutoverAuditStore('relative'))
      .toThrowError(codeError('CUTOVER_AUDIT_PATH_INVALID'))
    expect(() => new SqliteCutoverAuditStore(path.join(root, 'missing')))
      .toThrowError(codeError('CUTOVER_AUDIT_PATH_INVALID'))

    const target = createDirectory(root, 'target')
    const redirected = path.join(root, 'redirected')
    fs.symlinkSync(target, redirected, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => new SqliteCutoverAuditStore(redirected))
      .toThrowError(codeError('CUTOVER_AUDIT_PATH_INVALID'))
  })

  it('strictly rejects body, confirmation, command, and path fields before persistence', async () => {
    const store = open()
    const sensitiveFixture = 'ACTIVATE_SECRET_DO_NOT_PERSIST'
    const hostPath = 'C:\\Private\\Dyson\\start.ps1'
    await expectCode(store.begin({
      ...beginInput(1),
      confirmation: sensitiveFixture,
      body: { token: sensitiveFixture },
      path: hostPath,
      command: 'powershell secret.ps1'
    } as never), 'CUTOVER_AUDIT_INPUT_INVALID', directory, sensitiveFixture, hostPath)
    await expectCode(store.begin({
      ...beginInput(1),
      actorRole: 'root'
    } as never), 'CUTOVER_AUDIT_INPUT_INVALID', directory)
    expect(await store.listRecent()).toEqual([])

    const databaseBytes = fs.readFileSync(path.join(directory, 'cutover-audit.db'))
    expect(databaseBytes.includes(Buffer.from(sensitiveFixture))).toBe(false)
    expect(databaseBytes.includes(Buffer.from(hostPath))).toBe(false)
  })

  it('persists WAL started and terminal events across reopen and keeps events immutable', async () => {
    const store = open()
    const begin = beginInput(2, {
      operation: 'rollback',
      rollbackMode: 'immediate-compensation'
    })
    const started = await store.begin(begin)
    expect(started).toMatchObject({
      ...begin,
      rollbackMode: 'immediate-compensation',
      desired: null,
      sequence: 1,
      event: 'started'
    })
    expect(Object.keys(started).sort()).toEqual([
      'actorRole', 'attemptId', 'desired', 'event', 'format', 'operation', 'planFingerprint',
      'recordedAt', 'requestId', 'rollbackMode', 'schemaVersion', 'sequence'
    ])
    expect(await store.listIncomplete()).toEqual([started])

    const terminalInput = completeInput(2, {
      receiptPhase: 'rolled-back-immediate',
      receiptReused: false
    })
    const terminal = await store.complete(terminalInput)
    expect(terminal).toMatchObject({
      ...terminalInput,
      attemptId: begin.attemptId,
      operation: 'rollback',
      requestId: begin.requestId,
      actorRole: 'administrator',
      rollbackMode: 'immediate-compensation',
      desired: null,
      sequence: 2,
      event: 'terminal',
      errorCode: null
    })
    expect(await store.listIncomplete()).toEqual([])
    store.close()

    const reopened = open()
    expect(await reopened.listRecent()).toEqual([terminal, started])
    const raw = new DatabaseSync(path.join(directory, 'cutover-audit.db'))
    expect(raw.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' })
    expect(() => raw.exec(`UPDATE cutover_audit_events SET operation = 'activate'`)).toThrow()
    expect(() => raw.exec('DELETE FROM cutover_audit_events')).toThrow()
    raw.close()
    expect(await reopened.listRecent()).toEqual([terminal, started])
  })

  it('binds rollbackMode and desired only to their corresponding operations', async () => {
    const store = open()
    await expectCode(store.begin({
      ...beginInput(3),
      operation: 'prepare',
      rollbackMode: 'later-operator-rollback'
    }), 'CUTOVER_AUDIT_INPUT_INVALID', directory)
    await expectCode(store.begin({
      ...beginInput(3),
      operation: 'recover'
    }), 'CUTOVER_AUDIT_INPUT_INVALID', directory)

    const recovery = await store.begin({
      ...beginInput(3),
      operation: 'recover',
      desired: 'candidate'
    })
    expect(recovery).toMatchObject({
      operation: 'recover',
      rollbackMode: null,
      desired: 'candidate'
    })
    expect(createCutoverAuditAttemptId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })

  it('keeps attemptId unique and makes only an exact terminal replay idempotent', async () => {
    const store = open()
    const begin = beginInput(4)
    await store.begin(begin)
    await expectCode(store.begin(begin), 'CUTOVER_AUDIT_ATTEMPT_CONFLICT', directory)
    await expectCode(store.begin({ ...begin, requestId: requestId(40) }),
      'CUTOVER_AUDIT_ATTEMPT_CONFLICT', directory)

    const rejected: CutoverAuditCompleteInput = {
      attemptId: begin.attemptId,
      outcome: 'rejected',
      httpStatus: 409,
      errorCode: 'CUTOVER_NOT_PREPARED'
    }
    const terminal = await store.complete(rejected)
    expect(await store.complete(rejected)).toEqual(terminal)
    await expectCode(store.complete({
      ...rejected,
      httpStatus: 503,
      errorCode: 'CUTOVER_HTTP_UNAVAILABLE'
    }), 'CUTOVER_AUDIT_TERMINAL_CONFLICT', directory)
    expect(await store.listRecent()).toHaveLength(2)
  })

  it('serializes competing begin CAS and exact concurrent terminal replays', async () => {
    const first = open()
    const second = open()
    const begin = beginInput(5)
    const beginResults = await Promise.allSettled([
      first.begin(begin),
      second.begin({ ...begin, requestId: requestId(50) })
    ])
    expect(beginResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(beginResults.find((result) => result.status === 'rejected')).toMatchObject({
      status: 'rejected',
      reason: {
        code: 'CUTOVER_AUDIT_ATTEMPT_CONFLICT',
        message: 'CUTOVER_AUDIT_ATTEMPT_CONFLICT'
      }
    })

    const terminalInput = completeInput(5)
    const terminalResults = await Promise.all([
      first.complete(terminalInput),
      second.complete(terminalInput)
    ])
    expect(terminalResults[0]).toEqual(terminalResults[1])
    expect(await first.listRecent()).toHaveLength(2)
  })

  it('rolls back both begin and terminal append when a later transactional write fails', async () => {
    const store = open()
    const raw = new DatabaseSync(path.join(directory, 'cutover-audit.db'))
    raw.exec(`
      CREATE TRIGGER cutover_test_abort_attempt
      BEFORE INSERT ON cutover_audit_attempts
      BEGIN
        SELECT RAISE(ABORT, 'injected-attempt');
      END;
    `)
    raw.close()

    await expectCode(store.begin(beginInput(6)), 'CUTOVER_AUDIT_STORE_FAILED', directory)
    expect(await store.listRecent()).toEqual([])

    const repair = new DatabaseSync(path.join(directory, 'cutover-audit.db'))
    repair.exec(`
      DROP TRIGGER cutover_test_abort_attempt;
      CREATE TRIGGER cutover_test_abort_terminal
      BEFORE UPDATE OF terminal_event_id ON cutover_audit_attempts
      BEGIN
        SELECT RAISE(ABORT, 'injected-terminal');
      END;
    `)
    repair.close()
    const started = await store.begin(beginInput(6))
    await expectCode(store.complete(completeInput(6)), 'CUTOVER_AUDIT_STORE_FAILED', directory)
    expect(await store.listIncomplete()).toEqual([started])
    expect(await store.listRecent()).toEqual([started])
  })

  it('bounds recent and incomplete listings with indexed attempt projection', async () => {
    const store = open()
    const started = []
    for (let index = 10; index < 15; index += 1) {
      started.push(await store.begin(beginInput(index)))
    }
    await store.complete(completeInput(10))
    await store.complete(completeInput(12))

    expect((await store.listIncomplete(2)).map((event) => event.attemptId)).toEqual([
      attemptId(14),
      attemptId(13)
    ])
    expect(await store.listRecent(3)).toHaveLength(3)
    await expectCode(store.listRecent(0), 'CUTOVER_AUDIT_INPUT_INVALID', directory)
    await expectCode(store.listIncomplete(201), 'CUTOVER_AUDIT_INPUT_INVALID', directory)
    await expectCode(store.listRecent(1.5), 'CUTOVER_AUDIT_INPUT_INVALID', directory)
  })

  it('fails closed on canonical projection tampering and oversized persisted JSON', async () => {
    const tamperedDirectory = createDirectory(root, 'tampered')
    const tampered = open(tamperedDirectory)
    await tampered.begin(beginInput(20))
    tampered.close()
    rewriteEventPayload(tamperedDirectory, canonicalJson({ unexpected: true }))
    const tamperedReopen = open(tamperedDirectory)
    await expectCode(tamperedReopen.listRecent(), 'CUTOVER_AUDIT_DATA_INVALID', tamperedDirectory)

    const oversizedDirectory = createDirectory(root, 'oversized')
    const oversized = open(oversizedDirectory)
    await oversized.begin(beginInput(21))
    oversized.close()
    rewriteEventPayload(oversizedDirectory, JSON.stringify({ padding: 'x'.repeat(12 * 1024) }))
    const oversizedReopen = open(oversizedDirectory)
    await expectCode(oversizedReopen.listRecent(), 'CUTOVER_AUDIT_DATA_INVALID', oversizedDirectory)

    const projectionDirectory = createDirectory(root, 'projection')
    const projection = open(projectionDirectory)
    await projection.begin(beginInput(22))
    projection.close()
    rewriteEventProjection(projectionDirectory)
    const projectionReopen = open(projectionDirectory)
    await expectCode(projectionReopen.listRecent(), 'CUTOVER_AUDIT_DATA_INVALID', projectionDirectory)
  })

  it('accepts only code-shaped terminal errors and never returns host details', async () => {
    const store = open()
    const started = await store.begin(beginInput(30))
    const secretPath = 'D:\\Secrets\\production-save.zip'
    await expectCode(store.complete({
      attemptId: started.attemptId,
      outcome: 'failed',
      httpStatus: 503,
      errorCode: secretPath
    }), 'CUTOVER_AUDIT_INPUT_INVALID', directory, secretPath)
    await expectCode(store.complete({
      attemptId: started.attemptId,
      outcome: 'succeeded',
      httpStatus: 202,
      errorCode: 'CUTOVER_ADAPTER_FAILED'
    }), 'CUTOVER_AUDIT_INPUT_INVALID', directory)
    expect(JSON.stringify(await store.listRecent())).not.toContain(secretPath)
    expect(JSON.stringify(await store.listRecent())).not.toContain(directory)
  })

  it('binds successful and recovered terminal phases to the started operation', async () => {
    const store = open()
    await store.begin(beginInput(31, {
      operation: 'rollback',
      rollbackMode: 'later-operator-rollback'
    }))
    await expectCode(store.complete({
      attemptId: attemptId(31),
      outcome: 'succeeded',
      httpStatus: 202,
      receiptPhase: 'prepared',
      receiptReused: false
    }), 'CUTOVER_AUDIT_INPUT_INVALID', directory)
    await expectCode(store.complete({
      attemptId: attemptId(31),
      outcome: 'failed',
      httpStatus: 503,
      errorCode: 'CUTOVER_HTTP_UNAVAILABLE',
      receiptPhase: 'rolled-back-later',
      receiptReused: false
    }), 'CUTOVER_AUDIT_INPUT_INVALID', directory)
    await store.complete({
      attemptId: attemptId(31),
      outcome: 'recovery-required',
      httpStatus: 503,
      errorCode: 'CUTOVER_RECOVERY_REQUIRED',
      receiptPhase: 'recovered-previous',
      receiptReused: false
    })

    await store.begin(beginInput(32, {
      operation: 'recover',
      desired: 'candidate'
    }))
    await expectCode(store.complete({
      attemptId: attemptId(32),
      outcome: 'succeeded',
      httpStatus: 202,
      receiptPhase: 'recovered-previous',
      receiptReused: false
    }), 'CUTOVER_AUDIT_INPUT_INVALID', directory)
    await store.complete({
      attemptId: attemptId(32),
      outcome: 'succeeded',
      httpStatus: 202,
      receiptPhase: 'recovered-candidate',
      receiptReused: false
    })

    await store.begin(beginInput(33))
    await expectCode(store.complete({
      attemptId: attemptId(33),
      outcome: 'recovery-required',
      httpStatus: 503,
      errorCode: 'CUTOVER_RECOVERY_REQUIRED',
      receiptPhase: 'recovered-candidate',
      receiptReused: false
    }), 'CUTOVER_AUDIT_INPUT_INVALID', directory)
    await store.complete({
      attemptId: attemptId(33),
      outcome: 'recovery-required',
      httpStatus: 503,
      errorCode: 'CUTOVER_RECOVERY_REQUIRED',
      receiptPhase: 'recovered-previous',
      receiptReused: false
    })
  })
})

function beginInput(
  index: number,
  patch: Partial<CutoverAuditBeginInput> = {}
): CutoverAuditBeginInput {
  return {
    attemptId: attemptId(index),
    operation: 'prepare',
    requestId: requestId(index),
    actorRole: 'administrator',
    ...patch
  }
}

function completeInput(
  index: number,
  patch: Partial<CutoverAuditCompleteInput> = {}
): CutoverAuditCompleteInput {
  return {
    attemptId: attemptId(index),
    outcome: 'succeeded',
    httpStatus: 202,
    receiptPhase: 'prepared',
    receiptReused: false,
    ...patch
  }
}

function attemptId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`
}

function requestId(index: number): string {
  return `10000000-0000-4000-8000-${index.toString().padStart(12, '0')}`
}

function createDirectory(root: string, name: string): string {
  const result = path.join(root, name)
  fs.mkdirSync(result)
  return result
}

function rewriteEventPayload(directory: string, payload: string): void {
  const raw = new DatabaseSync(path.join(directory, 'cutover-audit.db'))
  raw.exec(`
    DROP TRIGGER cutover_audit_events_immutable_update;
    PRAGMA ignore_check_constraints = ON;
  `)
  raw.prepare('UPDATE cutover_audit_events SET payload_json = ? WHERE event_id = 1').run(payload)
  restoreImmutableUpdateTrigger(raw)
  raw.close()
}

function rewriteEventProjection(directory: string): void {
  const raw = new DatabaseSync(path.join(directory, 'cutover-audit.db'))
  raw.exec('DROP TRIGGER cutover_audit_events_immutable_update')
  raw.exec(`UPDATE cutover_audit_events SET operation = 'activate' WHERE event_id = 1`)
  restoreImmutableUpdateTrigger(raw)
  raw.close()
}

function restoreImmutableUpdateTrigger(database: DatabaseSync): void {
  database.exec(`
    CREATE TRIGGER cutover_audit_events_immutable_update
    BEFORE UPDATE ON cutover_audit_events
    BEGIN
      SELECT RAISE(ABORT, 'cutover-audit-event-immutable');
    END;
  `)
}

async function expectCode(
  promise: Promise<unknown>,
  code: CutoverAuditErrorCode,
  privatePath: string,
  ...secrets: string[]
): Promise<void> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason
  )
  expect(error).toBeInstanceOf(CutoverAuditError)
  expect(error).toMatchObject({ code, message: code })
  expect(error).not.toHaveProperty('cause')
  expect(String(error)).not.toContain(privatePath)
  for (const secret of secrets) expect(String(error)).not.toContain(secret)
}

function codeError(code: CutoverAuditErrorCode): CutoverAuditError {
  return new CutoverAuditError(code)
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

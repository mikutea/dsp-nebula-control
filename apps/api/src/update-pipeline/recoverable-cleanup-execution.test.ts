import { realpath, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { ControlDatabase } from '../storage/database.js'
import type { HostMutationOperationScope } from '../host-mutation/operation-coordinator.js'
import { createRecoverableCleanupPlan } from './recoverable-cleanup-plan.js'
import { FileCleanupMovePorts } from './recoverable-cleanup-files.js'
import { inspectCleanupObject } from './recoverable-cleanup-inventory.js'
import { executeCleanupJournal } from './recoverable-cleanup-execution.js'
const scope: HostMutationOperationScope = { signal: new AbortController().signal, assertActive() {}, toPowerShellBorrowArguments: () => [] }
it('recovers after real rename before checkpoint using reopened SQLite and then restores', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cleanup-execution-')))
  let db: ControlDatabase | undefined
  try {
    const control = path.join(root, 'control'), data = path.join(root, 'data')
    const opaqueId = '22222222-2222-4222-8222-222222222222', requestId = '11111111-1111-4111-8111-111111111111'
    await mkdir(path.join(control, 'history'), { recursive: true })
    const source = path.join(control, 'history', opaqueId + '.json')
    await writeFile(source, 'fictional history')
    const candidate = { kind: 'history' as const, opaqueId, ...(await inspectCleanupObject(source))! }
    const plan = createRecoverableCleanupPlan({ format: 'dyson-recoverable-component-cleanup-plan', schemaVersion: 1,
      requestId, expectedRevision: 'a'.repeat(64), candidates: [candidate] })
    const initial = { format: 'dyson-recoverable-cleanup-journal', schemaVersion: 1, requestId, direction: 'quarantine',
      actor: 'Administrator', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: null, state: 'running', completedCount: 0, plan }
    db = new ControlDatabase(data)
    const files = new FileCleanupMovePorts(control, requestId)
    await expect(executeCleanupJournal(initial, { scope, files, store: {
      loadCleanupJournal: id => db!.loadCleanupJournal(id),
      appendCleanupJournal: input => { if ((input as { completedCount: number }).completedCount === 1) throw new Error('CRASH_AFTER_MOVE'); return db!.appendCleanupJournal(input) }
    } })).rejects.toThrow('CRASH_AFTER_MOVE')
    expect(await files.inspect(candidate, 'source')).toBeNull()
    expect(db.loadCleanupJournal(requestId)?.completedCount).toBe(0)
    db.close(); db = new ControlDatabase(data)
    const terminal = await executeCleanupJournal(initial, { scope, files, store: db })
    expect(terminal.state).toBe('completed')
    expect(await executeCleanupJournal(initial, { scope, files, store: db })).toEqual(terminal)
    const restore = { ...initial, requestId: '33333333-3333-4333-8333-333333333333', direction: 'restore' }
    expect((await executeCleanupJournal(restore, { scope, files, store: db })).state).toBe('completed')
    expect(await files.inspect(candidate, 'source')).toMatchObject({ sha256: candidate.sha256 })
  } finally { db?.close(); await rm(root, { recursive: true, force: true }) }
})

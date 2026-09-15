import { expect, it } from 'vitest'
import { createRecoverableCleanupPlan } from './recoverable-cleanup-plan.js'
import { assertCleanupTransition, parseCleanupJournal } from './recoverable-cleanup-records.js'
const requestId = '11111111-1111-4111-8111-111111111111'
const plan = createRecoverableCleanupPlan({ format: 'dyson-recoverable-component-cleanup-plan', schemaVersion: 1,
  requestId, expectedRevision: 'a'.repeat(64), candidates: [
    { kind: 'history', opaqueId: '22222222-2222-4222-8222-222222222222', sha256: 'b'.repeat(64), sizeBytes: 1 }
  ] })
const journal = { format: 'dyson-recoverable-cleanup-journal', schemaVersion: 1, requestId,
  direction: 'quarantine', actor: 'Administrator', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: null,
  completedCount: 0, state: 'running', plan }
it('requires each checkpoint before a separately timestamped terminal', () => {
  const moved = { ...journal, completedCount: 1 }
  const terminal = { ...moved, state: 'completed', finishedAt: '2026-01-01T00:00:01.000Z' }
  expect(() => assertCleanupTransition(journal, moved)).not.toThrow()
  expect(() => assertCleanupTransition(moved, terminal)).not.toThrow()
  expect(() => assertCleanupTransition(terminal, terminal)).not.toThrow()
  expect(() => assertCleanupTransition(journal, terminal)).toThrow('UPDATE_CLEANUP_CHECKPOINT_GAP')
})
it('rejects replaced identity, plan, backwards time and shared restore IDs', () => {
  expect(() => assertCleanupTransition(journal, { ...journal, completedCount: 1, actor: 'Operator' })).toThrow()
  expect(() => parseCleanupJournal({ ...journal, plan: { ...plan, expectedRevision: 'c'.repeat(64) } })).toThrow()
  expect(() => parseCleanupJournal({ ...journal, completedCount: 1, state: 'completed', finishedAt: '2025-01-01T00:00:00.000Z' })).toThrow()
  expect(() => parseCleanupJournal({ ...journal, direction: 'restore' })).toThrow()
  expect(() => parseCleanupJournal({ ...journal, direction: 'restore', requestId: '33333333-3333-4333-8333-333333333333' })).not.toThrow()
})

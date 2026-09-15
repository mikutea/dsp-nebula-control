import { expect, it, vi } from 'vitest'
import { RecoverableCleanupHttpController } from './recoverable-cleanup-http.js'
import { createRecoverableCleanupPlan } from './recoverable-cleanup-plan.js'
import { parseCleanupJournal, type CleanupJournal } from './recoverable-cleanup-records.js'
const requestId = '11111111-1111-4111-8111-111111111111'
const plan = createRecoverableCleanupPlan({ format: 'dyson-recoverable-component-cleanup-plan', schemaVersion: 1, requestId,
  expectedRevision: 'a'.repeat(64), candidates: [{ kind: 'history', opaqueId: '22222222-2222-4222-8222-222222222222', sha256: 'b'.repeat(64), sizeBytes: 1 }] })
const request = { requestId, expectedRevision: plan.expectedRevision, expectedPlanSha256: plan.planSha256, confirmation: 'QUARANTINE_COMPONENT_MATERIAL' }
function fixture(enabled = true) {
  let stored: CleanupJournal | null = null
  const run = vi.fn(async (input: unknown) => {
    const journal = parseCleanupJournal(input)
    stored = parseCleanupJournal({ ...journal, completedCount: 1, state: 'completed', finishedAt: '2026-01-01T00:00:01.000Z' })
    return stored
  })
  const controller = new RecoverableCleanupHttpController({ store: {
    loadCleanupJournal: () => stored, appendCleanupJournal: input => parseCleanupJournal(input), listCleanupJournals: () => stored ? [stored] : []
  }, service: { previewRecoverableCleanup: async () => plan, runRecoverableCleanup: run },
  mutationEnabled: () => enabled, now: () => new Date('2026-01-01T00:00:00.000Z') })
  return { controller, run }
}
it('constructs identity from the authenticated caller and verifies persisted completion', async () => {
  const f = fixture()
  const result = await f.controller.execute(request, 'Administrator')
  expect(result).toMatchObject({ statusCode: 200, body: { ok: true, data: { actor: 'Administrator', state: 'completed' } } })
  expect(f.run.mock.calls[0]![0]).toMatchObject({ actor: 'Administrator', startedAt: '2026-01-01T00:00:00.000Z' })
  expect(await f.controller.execute({ ...request, actor: 'forged' }, 'Administrator')).toMatchObject({ statusCode: 400 })
  expect(f.run).toHaveBeenCalledOnce()
})
it('keeps mutation and recovery closed unless separately enabled', async () => {
  const f = fixture(false)
  expect(await f.controller.execute(request, 'Administrator')).toMatchObject({ statusCode: 423 })
  expect(await f.controller.recover({ ...request, direction: 'quarantine', confirmation: 'RECOVER_COMPONENT_CLEANUP' }, 'Administrator')).toMatchObject({ statusCode: 423 })
  expect(f.run).not.toHaveBeenCalled()
})

it('rebuilds a missing restore intent only from an explicit completed source', async () => {
  const restoreId = '33333333-3333-4333-8333-333333333333'
  const original = parseCleanupJournal({ format: 'dyson-recoverable-cleanup-journal', schemaVersion: 1, requestId, plan,
    actor: 'Administrator', direction: 'quarantine', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z', completedCount: 1, state: 'completed' })
  const stored = new Map([[requestId, original]])
  const preview = vi.fn(async () => plan)
  const run = vi.fn(async (input: unknown, _store: unknown, recovery?: boolean) => {
    const journal = parseCleanupJournal(input)
    expect(recovery).toBe(true)
    expect(journal).toMatchObject({ requestId: restoreId, direction: 'restore', actor: 'Operator' })
    const result = parseCleanupJournal({ ...journal, completedCount: 1, state: 'completed', finishedAt: '2026-01-01T00:00:03.000Z' })
    stored.set(restoreId, result); return result
  })
  const controller = new RecoverableCleanupHttpController({ store: { loadCleanupJournal: id => stored.get(id) ?? null,
    appendCleanupJournal: input => parseCleanupJournal(input), listCleanupJournals: () => [...stored.values()] },
    service: { previewRecoverableCleanup: preview, runRecoverableCleanup: run }, recoveryEnabled: () => true,
    now: () => new Date('2026-01-01T00:00:02.000Z') })
  expect(await controller.recover({ requestId: restoreId, sourceRequestId: requestId, direction: 'restore',
    expectedPlanSha256: plan.planSha256, confirmation: 'RECOVER_COMPONENT_CLEANUP' }, 'Operator')).toMatchObject({ statusCode: 200 })
  expect(preview).not.toHaveBeenCalled()
  expect(await controller.recover({ requestId: restoreId, expectedRevision: plan.expectedRevision, direction: 'quarantine',
    expectedPlanSha256: plan.planSha256, confirmation: 'RECOVER_COMPONENT_CLEANUP' }, 'Operator')).toMatchObject({ statusCode: 409 })
  expect(run).toHaveBeenCalledOnce()
})

it('returns a bounded failure for gate exceptions and rejects a foreign terminal', async () => {
  const wrong = parseCleanupJournal({ format: 'dyson-recoverable-cleanup-journal', schemaVersion: 1,
    requestId: '77777777-7777-4777-8777-777777777777', direction: 'restore', plan, actor: 'Administrator',
    startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z', completedCount: 1, state: 'completed' })
  const run = vi.fn(async () => wrong)
  const options = { store: { loadCleanupJournal: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(wrong),
    appendCleanupJournal: (input: unknown) => parseCleanupJournal(input), listCleanupJournals: () => [] },
    service: { previewRecoverableCleanup: async () => plan, runRecoverableCleanup: run },
    now: () => new Date('2026-01-01T00:00:00.000Z') }
  const brokenGate = new RecoverableCleanupHttpController({ ...options, mutationEnabled: () => { throw new Error('private diagnostic') } })
  expect(await brokenGate.execute(request, 'Administrator')).toEqual({ statusCode: 503, body: { ok: false, error: { code: 'UPDATE_CLEANUP_UNAVAILABLE' } } })
  expect(run).not.toHaveBeenCalled()
  const foreignReceipt = new RecoverableCleanupHttpController({ ...options, mutationEnabled: () => true })
  expect(await foreignReceipt.execute(request, 'Administrator')).toMatchObject({ statusCode: 503, body: { error: { code: 'UPDATE_CLEANUP_TERMINAL_UNPROVEN' } } })
})

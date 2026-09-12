import { afterEach, expect, it, vi } from 'vitest'
import { recoverableCleanupApi, type CleanupPlan } from './recoverable-cleanup-api'
afterEach(() => vi.unstubAllGlobals())
const requestId = '11111111-1111-4111-8111-111111111111'
const plan: CleanupPlan = { format: 'dyson-recoverable-component-cleanup-plan', schemaVersion: 1, requestId,
  expectedRevision: 'a'.repeat(64), planSha256: 'b'.repeat(64), candidates: [
    { kind: 'history', opaqueId: '22222222-2222-4222-8222-222222222222', sha256: 'c'.repeat(64), sizeBytes: 1 }
  ] }
const terminal = { format: 'dyson-recoverable-cleanup-journal', schemaVersion: 1, requestId, plan, direction: 'quarantine',
  state: 'completed', completedCount: 1, actor: 'Administrator', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z' }
const response = (data: unknown) => ({ ok: true, json: async () => ({ ok: true, data }) })
it('submits only plan bindings and reads back the exact persisted terminal', async () => {
  const fetch = vi.fn().mockResolvedValue(response(terminal)); vi.stubGlobal('fetch', fetch)
  expect(await recoverableCleanupApi.execute(plan)).toEqual(terminal)
  expect(fetch).toHaveBeenCalledTimes(2)
  const [url, options] = fetch.mock.calls[0]!
  expect(url).toBe('/api/v1/updates/cleanup/recoverable/execute')
  expect(JSON.parse(options.body)).toEqual({ requestId, expectedRevision: plan.expectedRevision, expectedPlanSha256: plan.planSha256, confirmation: 'QUARANTINE_COMPONENT_MATERIAL' })
  expect(options.credentials).toBe('same-origin')
})
it('rejects unfinished and mismatching terminal readbacks', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response(terminal)).mockResolvedValueOnce(response({ ...terminal, actor: 'Operator' }))
  vi.stubGlobal('fetch', fetch)
  await expect(recoverableCleanupApi.execute(plan)).rejects.toThrow()
  fetch.mockResolvedValue(response({ ...terminal, state: 'running' }))
  await expect(recoverableCleanupApi.receipt(requestId)).rejects.toThrow()
})
it('rejects path-shaped receipt IDs without sending a request', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  await expect(recoverableCleanupApi.receipt('../outside')).rejects.toThrow()
  expect(fetch).not.toHaveBeenCalled()
})

import { expect, it } from 'vitest'
import { createRecoverableCleanupPlan, assertRecoverableCleanupPlan } from './recoverable-cleanup-plan.js'
const history = { kind: 'history', opaqueId: '11111111-1111-4111-8111-111111111111', sha256: 'a'.repeat(64), sizeBytes: 128 }
const release = { kind: 'release', opaqueId: 'nebula-' + 'b'.repeat(32), sha256: 'c'.repeat(64), sizeBytes: 256 }
const input = { format: 'dyson-recoverable-component-cleanup-plan', schemaVersion: 1,
  requestId: '22222222-2222-4222-8222-222222222222', expectedRevision: 'd'.repeat(64), candidates: [history, release] }
it('binds the same material independently of inventory ordering', () => {
  const plan = createRecoverableCleanupPlan(input)
  expect(createRecoverableCleanupPlan({ ...input, candidates: [release, history] })).toEqual(plan)
  expect(() => assertRecoverableCleanupPlan({ requestId: plan.requestId, expectedRevision: plan.expectedRevision,
    expectedPlanSha256: plan.planSha256, confirmation: 'QUARANTINE_COMPONENT_MATERIAL' }, plan)).not.toThrow()
})
it('rejects changed material despite a reused request and plan hash', () => {
  const plan = createRecoverableCleanupPlan(input)
  const request = { requestId: plan.requestId, expectedRevision: plan.expectedRevision,
    expectedPlanSha256: plan.planSha256, confirmation: 'QUARANTINE_COMPONENT_MATERIAL' }
  expect(() => assertRecoverableCleanupPlan(request, { ...plan, candidates: [{ ...plan.candidates[0]!, sha256: 'f'.repeat(64) }] })).toThrow('UPDATE_CLEANUP_PLAN_CHANGED')
  expect(() => assertRecoverableCleanupPlan({ ...request, expectedRevision: 'f'.repeat(64) }, plan)).toThrow()
})
it('rejects duplicate sources, injected paths, and unbounded sizes', () => {
  expect(() => createRecoverableCleanupPlan({ ...input, candidates: [history, history] })).toThrow()
  expect(() => createRecoverableCleanupPlan({ ...input, candidates: [{ ...history, path: '../outside' }] })).toThrow()
  expect(() => createRecoverableCleanupPlan({ ...input, candidates: [{ ...history, sizeBytes: Number.MAX_SAFE_INTEGER }, release] })).toThrow()
})

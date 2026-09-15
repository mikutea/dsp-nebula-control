import { expect, it } from 'vitest'
import { RecoverableCleanupCoordinator } from './recoverable-cleanup-coordinator.js'
import { createRecoverableCleanupPlan } from './recoverable-cleanup-plan.js'
import type { HostMutationOperationOutcome, HostMutationOperationScope } from '../host-mutation/operation-coordinator.js'
it.each([false, true])('keeps eligibility failures nonmutating with recovery=%s', async recovery => {
  const requestId = '11111111-1111-4111-8111-111111111111'
  const plan = createRecoverableCleanupPlan({ format: 'dyson-recoverable-component-cleanup-plan', schemaVersion: 1, requestId,
    expectedRevision: 'a'.repeat(64), candidates: [{ kind: 'history', opaqueId: '22222222-2222-4222-8222-222222222222', sha256: 'b'.repeat(64), sizeBytes: 1 }] })
  const journal = { format: 'dyson-recoverable-cleanup-journal', schemaVersion: 1, requestId, plan, actor: 'Administrator',
    direction: 'quarantine', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: null, state: 'running', completedCount: 0 }
  let locked = false
  const scope: HostMutationOperationScope = { signal: new AbortController().signal, assertActive() { expect(locked).toBe(true) }, toPowerShellBorrowArguments: () => [] }
  const invoke = async <T>(work: (s: HostMutationOperationScope) => Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>) => {
    const result = await work(scope)
    expect(result.disposition).toBe(recovery ? 'abandon' : 'release')
    if (result.kind === 'throw') throw result.error
    return result.value
  }
  const unexpected = async (): Promise<never> => { throw new Error('UNEXPECTED_MUTATION') }
  const service = new RecoverableCleanupCoordinator({
    coordinator: { runExclusive: async (request, work) => { expect(request).toEqual({ operation: 'component-update-cleanup', requestId }); return invoke(work) } },
    recovery: { runRecoveryExclusive: async (request, work) => { expect(request).toEqual({ expectedOperation: 'component-update-cleanup', expectedRequestId: requestId }); return invoke(work) } },
    store: { loadCleanupJournal: () => null, appendCleanupJournal: unexpected },
    files: { inspect: unexpected, move: unexpected },
    withActivationLock: async (_scope, work) => { locked = true; try { return await work() } finally { locked = false } },
    validateEligibility: async () => { expect(locked).toBe(true); throw new Error('REVISION_CHANGED') }
  })
  await expect(recovery ? service.recover(journal) : service.execute(journal)).rejects.toThrow('REVISION_CHANGED')
})

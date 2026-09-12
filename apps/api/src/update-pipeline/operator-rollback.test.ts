import { describe, expect, it } from 'vitest'
import { OperatorRollbackCoordinator, type OperatorRollbackJournal, type OperatorRollbackReceipt,
  type OperatorRollbackPhase, type OperatorRollbackPlan } from './operator-rollback.js'
import type { HostMutationOperationOutcome, HostMutationOperationScope } from '../host-mutation/operation-coordinator.js'

const hash = 'a'.repeat(64)
const request = { requestId: '11111111-1111-4111-8111-111111111111',
  sourceRequestId: '22222222-2222-4222-8222-222222222222', expectedRevision: hash, expectedPlanSha256: hash }
const plan: OperatorRollbackPlan = { format: 'dyson-control-component-rollback-plan', schemaVersion: 1, dryRun: true,
  requestId: request.requestId, sourceRequestId: request.sourceRequestId, expectedRevision: hash,
  component: 'bepinex', targetVersion: '5.4.17.0', materialSha256: hash, rollbackBindingSha256: hash,
  sourceProtectionBackupId: 'source-backup', restoreFileCount: 1, removeFileCount: 0,
  planSha256: hash, currentConfigurationRevision: hash }

function fixture(failPhase?: OperatorRollbackPhase) {
  let stored: { journal: OperatorRollbackJournal; receipt: OperatorRollbackReceipt | null } | null = null
  let fail = failPhase
  const effects = new Set<string>()
  const calls: string[] = []
  const dispositions: string[] = []
  const scope: HostMutationOperationScope = { signal: new AbortController().signal,
    assertActive() {}, toPowerShellBorrowArguments: () => [] }
  const invoke = async <T>(work: (scope: HostMutationOperationScope) => Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>) => {
    const result = await work(scope)
    dispositions.push(result.disposition)
    if (result.kind === 'throw') throw result.error
    return result.value
  }
  const effect = (name: string) => { calls.push(name); effects.add(name) }
  const service = new OperatorRollbackCoordinator({
    coordinator: { runExclusive: async (input, work) => {
      expect(input).toEqual({ operation: 'component-update-rollback', requestId: request.requestId })
      return invoke(work)
    } },
    recovery: { runRecoveryExclusive: async (input, work) => {
      expect(input).toEqual({ expectedOperation: 'component-update-rollback', expectedRequestId: request.requestId })
      return invoke(work)
    } },
    store: {
      load: async () => structuredClone(stored),
      begin: async journal => { expect(stored).toBeNull(); stored = { journal: structuredClone(journal), receipt: null } },
      checkpoint: async (previous, journal) => {
        expect(stored!.journal.phase).toBe(previous)
        if (fail === journal.phase) { fail = undefined; throw new Error('CHECKPOINT_FAILURE') }
        stored!.journal = structuredClone(journal)
      },
      complete: async receipt => { stored!.receipt = structuredClone(receipt) }
    },
    ports: {
      preview: async () => plan,
      validateResume: async () => {},
      protectCurrent: async () => {
        effect('protect')
        return { configurationSnapshotId: request.requestId, configurationRevision: hash,
          serverModLockSha256: hash, serverModLockRevision: hash, previousLoadedSaveIdentity: hash,
          protectionBackupId: 'forward-backup', protectionManifestSha256: hash, bindingSha256: hash }
      },
      restoreFiles: async () => { effect('files') },
      restoreEnvironment: async () => { effect('environment') },
      verify: async () => { effect('verify') },
      commitState: async () => { effect('commit'); return 'b'.repeat(64) }
    }
  })
  return { service, effects, calls, dispositions }
}

describe('operator rollback checkpoint coordination', () => {
  it.each(['protected', 'files-restored', 'environment-restored', 'verified', 'state-committed'] as const)(
    'recovers a failed %s checkpoint under the exact prior operation', async phase => {
      const f = fixture(phase)
      await expect(f.service.execute(request)).rejects.toThrow('CHECKPOINT_FAILURE')
      expect(f.dispositions).toEqual(['abandon'])
      await expect(f.service.recover(request)).resolves.toMatchObject({ status: 'succeeded', recoveryRequired: false })
      expect([...f.effects]).toEqual(['protect', 'files', 'environment', 'verify', 'commit'])
      const stages = ['protected', 'files-restored', 'environment-restored', 'verified', 'state-committed']
      const actions = ['protect', 'files', 'environment', 'verify', 'commit']
      const failedIndex = stages.indexOf(phase)
      expect(f.calls).toEqual([...actions.slice(0, failedIndex + 1), ...actions.slice(failedIndex)])
      const calls = [...f.calls]
      await expect(f.service.execute(request)).resolves.toMatchObject({ status: 'succeeded' })
      expect(f.calls).toEqual(calls)
      expect(f.dispositions).toEqual(['abandon', 'release', 'release'])
    })
  it('rejects changed plans before writing an intent', async () => {
    const f = fixture()
    await expect(f.service.execute({ ...request, expectedPlanSha256: 'f'.repeat(64) })).rejects.toThrow('UPDATE_ROLLBACK_PLAN_CHANGED')
    expect(f.calls).toEqual([])
    expect(f.dispositions).toEqual(['release'])
  })
})

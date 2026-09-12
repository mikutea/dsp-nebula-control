import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { HostMutationLeaseError } from '../host-mutation/lease.js'
import {
  HostMutationOperationCoordinatorError,
  type HostMutationOperationCoordinator,
  type HostMutationOperationOutcome,
  type HostMutationOperationRequest,
  type HostMutationOperationScope,
  type HostMutationRecoveryOperationCoordinator,
  type HostMutationRecoveryOperationRequest
} from '../host-mutation/operation-coordinator.js'
import { CutoverService, createInitialCutoverState } from './service.js'
import {
  ACTIVATE_GSMANAGER_TO_DYSON,
  PREPARE_GSMANAGER_TO_DYSON,
  ROLLBACK_DYSON_TO_GSMANAGER,
  CutoverError,
  type CutoverAdapterRequest,
  type CutoverAdapterMutationRequest,
  type CutoverAuthorityMutationInvocation,
  type CutoverAuthorityMutationMethod,
  type CutoverAuthorityMutationRequest,
  type CutoverAuthorityMutationResult,
  type CutoverBaselineRestoreRequest,
  type CutoverDurableStore,
  type CutoverHostAdapter,
  type CutoverHostEvidence,
  type CutoverJournal,
  type CutoverSaveProtectionRequest,
  type CutoverStoredReceipt,
  type CutoverStoredState
} from './types.js'

type HostMutationOperation<T> = (
  scope: HostMutationOperationScope
) => Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>

const AUTHORITY_INVENTORY_REVISION = 'a'.repeat(64)

describe('provider-agnostic GSManager cutover', () => {
  it('prepares a disabled candidate without starting it or changing the previous runtime', async () => {
    const harness = createHarness()
    const before = clone(harness.adapter.evidence)

    const receipt = await prepareCutover(harness, id(1) )

    expect(receipt).toMatchObject({ phase: 'prepared', status: 'succeeded' })
    expect(harness.adapter.mutations).toEqual(['defineCandidateDisabled'])
    expect(harness.adapter.evidence).toEqual({
      ...before,
      candidateDefined: true,
      candidateEnabled: false
    })
    expect(harness.adapter.mutations).not.toContain('startCandidateRuntime')
    expect(harness.store.state).toMatchObject({ prepared: true, authority: 'previous' })
    expect(harness.store.receipts.get(id(1))?.acceptedPreview).toMatchObject({
      operation: 'prepare',
      requestId: id(1),
      stateRevision: expect.stringMatching(/^[0-9a-f]{64}$/),
      evidenceDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      planFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/)
    })
    expect(harness.coordinator.requests).toEqual([{ operation: 'gsmanager-cutover-prepare', requestId: id(1) }])
    expect(receipt).not.toHaveProperty('authorityInventoryRevision')
  })

  it('issues a stable server-authenticated preview with read-only host inspection and zero durable write', async () => {
    const harness = createHarness()
    const request = { requestId: id(40), operation: 'prepare' as const }

    const first = await harness.service.preview(request)
    const second = await harness.service.preview(request)

    expect(second).toEqual(first)
    expect(first).toMatchObject({
      format: 'dyson-control-cutover-preview',
      schemaVersion: 1,
      operation: 'prepare',
      requestId: id(40),
      rollbackMode: null,
      stateRevision: harness.store.state.revision,
      summary: { reused: false }
    })
    expect(first.evidenceDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(first.planFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(harness.coordinator.requests).toEqual([])
    expect(harness.adapter.seenSignals).toHaveLength(2)
    expect(harness.adapter.mutations).toEqual([])
    expect(harness.store.writeCount).toBe(0)
  })

  it('rejects a missing preview before store, lease, or host access', async () => {
    const harness = createHarness()

    await expect(harness.service.prepare({
      requestId: id(41),
      confirmation: PREPARE_GSMANAGER_TO_DYSON
    })).rejects.toMatchObject({ code: 'CUTOVER_PREVIEW_REQUIRED' })

    expect(harness.coordinator.requests).toEqual([])
    expect(harness.adapter.seenSignals).toEqual([])
    expect(harness.adapter.mutations).toEqual([])
    expect(harness.store.writeCount).toBe(0)
  })

  it('rejects cross-operation, stale-state, and live-evidence preview conflicts before mutation', async () => {
    const cross = createHarness()
    const crossRequestId = id(42)
    await prepareCutover(cross, id(46))
    const activatePlan = await previewPlan(cross, {
      requestId: crossRequestId,
      operation: 'activate'
    })
    cross.resetObservations()
    const crossWrites = cross.store.writeCount
    await expect(cross.service.prepare({
      requestId: crossRequestId,
      planFingerprint: activatePlan,
      confirmation: PREPARE_GSMANAGER_TO_DYSON
    })).rejects.toMatchObject({ code: 'CUTOVER_PREVIEW_CONFLICT' })
    expect(cross.adapter.mutations).toEqual([])
    expect(cross.store.writeCount).toBe(crossWrites)

    const stale = createHarness()
    const staleRequestId = id(43)
    const stalePlan = await previewPlan(stale, { requestId: staleRequestId, operation: 'prepare' })
    await prepareCutover(stale, id(44))
    stale.resetObservations()
    const staleWrites = stale.store.writeCount
    await expect(stale.service.prepare({
      requestId: staleRequestId,
      planFingerprint: stalePlan,
      confirmation: PREPARE_GSMANAGER_TO_DYSON
    })).rejects.toMatchObject({ code: 'CUTOVER_PREVIEW_CONFLICT' })
    expect(stale.adapter.mutations).toEqual([])
    expect(stale.store.writeCount).toBe(staleWrites)

    const drift = createHarness()
    const driftRequestId = id(45)
    const driftPlan = await previewPlan(drift, { requestId: driftRequestId, operation: 'prepare' })
    drift.adapter.evidence.candidateDefined = true
    const driftWrites = drift.store.writeCount
    await expect(drift.service.prepare({
      requestId: driftRequestId,
      planFingerprint: driftPlan,
      confirmation: PREPARE_GSMANAGER_TO_DYSON
    })).rejects.toMatchObject({ code: 'CUTOVER_PREVIEW_CONFLICT' })
    expect(drift.adapter.seenSignals).toHaveLength(1)
    expect(drift.adapter.mutations).toEqual([])
    expect(drift.store.writeCount).toBe(driftWrites)
  })

  it('projects only a cloned terminal receipt for interrupted HTTP audit reconciliation', async () => {
    const harness = createHarness()
    const lookup = {
      requestId: id(1),
      operation: 'prepare' as const
    }
    expect(await harness.service.getReceiptForAudit(lookup)).toBeNull()

    const prepared = await prepareCutover(harness, id(1) )
    const projected = await harness.service.getReceiptForAudit({
      ...lookup,
      requestId: id(1).toUpperCase()
    })
    expect(projected).toMatchObject({
      match: 'matched',
      storedOperation: 'prepare',
      receipt: prepared
    })
    expect(projected?.match).toBe('matched')
    if (projected?.match !== 'matched') throw new Error('expected matched receipt')
    expect(projected.receipt).not.toBe(prepared)
    expect(projected.receipt.summary).not.toBe(prepared.summary)
    ;(projected.receipt.summary as { candidateDefined: boolean }).candidateDefined = false
    expect(await harness.service.getReceiptForAudit(lookup)).toMatchObject({
      match: 'matched',
      receipt: { summary: { candidateDefined: true } }
    })
    expect(await harness.service.getReceiptForAudit({
      requestId: id(1),
      operation: 'rollback',
      rollbackMode: 'immediate-compensation'
    })).toEqual({ match: 'conflict' })
    expect(await harness.service.getReceiptForAudit({
      requestId: id(1),
      operation: 'prepare',
      planFingerprint: 'f'.repeat(64)
    })).toEqual({ match: 'conflict' })

    await expect(harness.service.getReceiptForAudit({
      requestId: 'not-a-uuid',
      operation: 'prepare'
    }))
      .rejects.toMatchObject({ code: 'CUTOVER_REQUEST_INVALID' })
  })

  it('binds durable replay to the construction-time authority inventory revision', async () => {
    const harness = createHarness()
    await prepareCutover(harness, id(21) )
    const writes = harness.store.writeCount
    const driftedService = new CutoverService({
      authorityInventoryRevision: 'b'.repeat(64),
      adapter: harness.adapter,
      store: harness.store,
      hostMutationCoordinator: harness.coordinator,
      hostMutationRecoveryCoordinator: harness.recoveryCoordinator
    })

    await expect(driftedService.prepare({
      confirmation: PREPARE_GSMANAGER_TO_DYSON,
      requestId: id(21),
      planFingerprint: harness.store.receipts.get(id(21))!.acceptedPreview!.planFingerprint
    }))
      .rejects.toMatchObject({ code: 'CUTOVER_AUTHORITY_DRIFT' })
    expect(harness.store.writeCount).toBe(writes)
    const envelope = harness.store.receipts.get(id(21))
    expect(envelope?.authorityInventoryRevision).toBe(AUTHORITY_INVENTORY_REVISION)
  })

  it('prepares a disabled candidate while preserving a stopped previous runtime', async () => {
    const harness = createHarness()
    harness.adapter.evidence = stoppedPreviousEvidence(false)

    const receipt = await prepareCutover(harness, id(24) )

    expect(receipt).toMatchObject({
      phase: 'prepared',
      summary: {
        previousAuthorityEnabled: true,
        processesStopped: true,
        portClosed: true,
        previousRuntimeHealthy: false
      }
    })
    expect(harness.adapter.mutations).toEqual(['defineCandidateDisabled'])
    expect(harness.adapter.mutations).not.toContain('startPreviousRuntime')
    expect(harness.adapter.evidence).toEqual(stoppedPreviousEvidence(true))
  })

  it('recovers a stopped previous prepare hard-exit without starting any runtime', async () => {
    const harness = createHarness()
    harness.adapter.evidence = stoppedPreviousEvidence(false)
    harness.adapter.hardExitAfter = 'defineCandidateDisabled'
    await expect(prepareCutover(harness, id(25) )).rejects.toBeInstanceOf(CutoverError)
    const child = clone(harness.store.journal!.authorityMutation)
    harness.adapter.hardExitAfter = null
    harness.resetObservations()

    const recovered = await harness.service.recoverInterrupted({ requestId: id(25), desired: 'previous' })

    expect(recovered).toMatchObject({
      phase: 'recovered-previous',
      summary: { candidateDefined: true, processesStopped: true, portClosed: true }
    })
    expect(harness.adapter.mutations).toEqual(['defineCandidateDisabled'])
    expect(harness.adapter.authorityInvocations).toEqual([expect.objectContaining({
      method: 'defineCandidateDisabled',
      invocation: {
        childRequestId: child.childRequestId,
        attempt: child.attempt,
        mode: 'PrepareDisabled',
        recovery: true
      }
    })])
    expect(harness.adapter.mutations).not.toContain('startPreviousRuntime')
    expect(harness.adapter.evidence).toEqual(stoppedPreviousEvidence(true))
    expect(harness.store.state).toMatchObject({ prepared: true, authority: 'previous' })
  })

  it('fails closed when a running prepare baseline becomes stopped during recovery', async () => {
    const harness = createHarness()
    harness.adapter.hardExitAfter = 'defineCandidateDisabled'
    await expect(prepareCutover(harness, id(26) )).rejects.toBeInstanceOf(CutoverError)
    harness.adapter.hardExitAfter = null
    harness.adapter.evidence = stoppedPreviousEvidence(true)
    harness.resetObservations()
    const writes = harness.store.writeCount

    await expect(harness.service.recoverInterrupted({ requestId: id(26), desired: 'previous' }))
      .rejects.toMatchObject({ code: 'CUTOVER_RECOVERY_EVIDENCE_INVALID' })
    expect(harness.adapter.mutations).toEqual([])
    expect(harness.store.writeCount).toBe(writes)
  })

  it('fails closed without a host mutation coordinator', async () => {
    const harness = createHarness({ ordinaryCoordinator: null })

    await expect(prepareCutover(harness, id(2) ))
      .rejects.toMatchObject({ code: 'CUTOVER_HOST_LEASE_UNAVAILABLE' })
    expect(harness.adapter.mutations).toEqual([])
    expect(harness.store.writeCount).toBe(0)
  })

  it.each([
    ['missing confirmation', { requestId: id(18) }, 'CUTOVER_CONFIRMATION_REQUIRED'],
    ['wrong confirmation', { requestId: id(18), confirmation: 'PREPARE' }, 'CUTOVER_CONFIRMATION_REQUIRED'],
    ['unknown field', {
      requestId: id(18),
      confirmation: PREPARE_GSMANAGER_TO_DYSON,
      task: 'private-host-task'
    }, 'CUTOVER_REQUEST_INVALID']
  ] as const)('requires the fixed prepare token for %s before lease, adapter, or store write', async (
    _name,
    input,
    code
  ) => {
    const harness = createHarness()

    await expect(harness.service.prepare(input)).rejects.toMatchObject({ code })
    expect(harness.coordinator.requests).toEqual([])
    expect(harness.adapter.seenSignals).toEqual([])
    expect(harness.adapter.mutations).toEqual([])
    expect(harness.store.writeCount).toBe(0)
  })

  it('fails a busy host lease before adapter calls or durable writes', async () => {
    const harness = createHarness()
    harness.coordinator.busy = true

    await expect(prepareCutover(harness, id(19))).rejects.toMatchObject({ code: 'CUTOVER_HOST_LEASE_BUSY' })
    expect(harness.adapter.seenSignals).toEqual([])
    expect(harness.adapter.mutations).toEqual([])
    expect(harness.store.writeCount).toBe(0)
  })

  it('requires the fixed activation token before any lease, adapter, or store write', async () => {
    const harness = createHarness()

    await expect(harness.service.activate({ requestId: id(18), confirmation: 'wrong-token' }))
      .rejects.toMatchObject({ code: 'CUTOVER_CONFIRMATION_REQUIRED' })
    expect(harness.coordinator.requests).toEqual([])
    expect(harness.adapter.mutations).toEqual([])
    expect(harness.store.writeCount).toBe(0)
  })

  it('recovers an interrupted prepare with no candidate definition as unprepared previous', async () => {
    const harness = createHarness()
    harness.adapter.hardExitBefore = 'defineCandidateDisabled'

    await expect(prepareCutover(harness, id(22) ))
      .rejects.toMatchObject({ code: 'CUTOVER_ADAPTER_FAILED' })
    expect(harness.adapter.evidence.candidateDefined).toBe(false)
    const child = clone(harness.store.journal!.authorityMutation)
    expect(child).toEqual({
      phase: 'intent-persisted',
      method: 'defineCandidateDisabled',
      mode: 'PrepareDisabled',
      childRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      attempt: 1,
      state: 'pending',
      receiptDigest: null
    })
    harness.adapter.hardExitBefore = null
    harness.adapter.authorityRecoveryResults.push({
      status: 'rolled-back',
      receiptDigest: 'b'.repeat(64)
    })

    const recovered = await harness.service.recoverInterrupted({ requestId: id(22), desired: 'previous' })

    expect(recovered).toMatchObject({
      phase: 'recovered-previous',
      status: 'rolled-back',
      summary: { candidateDefined: false }
    })
    expect(harness.store.state).toMatchObject({ prepared: false, authority: 'previous' })
    const invocation = harness.adapter.authorityInvocations.at(-1)!.invocation
    expect(invocation).toEqual({
      childRequestId: child.childRequestId,
      attempt: 1,
      mode: 'PrepareDisabled',
      recovery: true
    })
  })

  it('strictly rejects a malformed runtime-task child transaction skeleton', async () => {
    const harness = createHarness()
    harness.adapter.hardExitAfter = 'defineCandidateDisabled'
    await expect(prepareCutover(harness, id(23) )).rejects.toBeInstanceOf(CutoverError)
    expect(harness.store.journal).not.toBeNull()
    harness.store.journal!.authorityMutation = {
      ...harness.store.journal!.authorityMutation,
      phase: 'receipt-persisted',
      state: 'succeeded',
      receiptDigest: 'not-a-digest'
    }

    const status = await harness.service.recoveryStatus()

    expect(status).toMatchObject({
      status: 'evidence-invalid',
      errorCode: 'CUTOVER_RECOVERY_EVIDENCE_INVALID',
      allowedDesired: []
    })
  })

  it.each([
    ['authority', { unexpectedAuthorityPresent: true }],
    ['port', { portState: 'unknown' as const }],
    ['process', { processState: 'unknown' as const }]
  ])('rejects unknown %s drift with zero adapter and durable writes', async (_name, patch) => {
    const harness = createHarness()
    const requestId = randomUUID()
    const planFingerprint = await previewPlan(harness, { requestId, operation: 'prepare' })
    Object.assign(harness.adapter.evidence, patch)

    await expect(harness.service.prepare({
      requestId,
      planFingerprint,
      confirmation: PREPARE_GSMANAGER_TO_DYSON
    }))
      .rejects.toBeInstanceOf(CutoverError)
    expect(harness.adapter.mutations).toEqual([])
    expect(harness.store.writeCount).toBe(0)
    expect(harness.coordinator.outcomes.at(-1)?.disposition).toBe('release')
  })

  it('activates in the protected, single-authority order and forwards one lease signal', async () => {
    const harness = createHarness()
    await prepareCutover(harness, id(3) )
    harness.resetObservations()

    const receipt = await activateCutover(harness, id(4))

    expect(receipt).toMatchObject({
      phase: 'activated',
      status: 'succeeded',
      summary: {
        saveProtected: true,
        candidateAuthorityEnabled: true,
        candidateRuntimeHealthy: true,
        uniqueAuthority: true
      }
    })
    expect(harness.adapter.mutations).toEqual([
      'createSaveProtectionPoint:activation-baseline',
      'disablePreviousAuthority',
      'stopPreviousRuntime',
      'enableCandidateAuthority',
      'startCandidateRuntime'
    ])
    expect(harness.events.indexOf('journal:launch-target-intent'))
      .toBeLessThan(harness.events.indexOf('adapter:enableCandidateAuthority'))
    expect(new Set(harness.adapter.seenSignals)).toEqual(new Set([harness.coordinator.lastSignal]))
    expect(new Set(harness.adapter.seenScopes)).toEqual(new Set([harness.coordinator.lastScope]))
    expect(harness.store.state).toMatchObject({ authority: 'candidate', activationBaselineProtected: true })
  })

  it('uses exact runtime-task modes and never requests child recovery from ordinary APIs', async () => {
    const harness = createHarness()

    await prepareCutover(harness, id(27) )
    await activateCutover(harness, id(28))
    await rollbackCutover(harness, id(29), 'immediate-compensation')

    expect(harness.adapter.authorityInvocations.map(({ method, invocation }) => ({
      method,
      attempt: invocation.attempt,
      mode: invocation.mode,
      recovery: invocation.recovery
    }))).toEqual([
      { method: 'defineCandidateDisabled', attempt: 1, mode: 'PrepareDisabled', recovery: false },
      { method: 'enableCandidateAuthority', attempt: 1, mode: 'Activate', recovery: false },
      { method: 'disableCandidateAuthority', attempt: 1, mode: 'PrepareDisabled', recovery: false }
    ])
    expect(new Set(harness.adapter.authorityInvocations.map(({ invocation }) => invocation.childRequestId)).size)
      .toBe(3)
  })

  it('persists child recovery-required and leaves its consumption to explicit outer recovery only', async () => {
    const harness = createHarness()
    harness.adapter.authorityOrdinaryResults.push({
      status: 'recovery-required',
      receiptDigest: null
    })

    await expect(prepareCutover(harness, id(38) ))
      .rejects.toMatchObject({ code: 'CUTOVER_RECOVERY_REQUIRED' })
    const child = clone(harness.store.journal!.authorityMutation)
    expect(child).toMatchObject({
      phase: 'receipt-persisted',
      method: 'defineCandidateDisabled',
      mode: 'PrepareDisabled',
      attempt: 1,
      state: 'recovery-required',
      receiptDigest: null
    })
    expect(harness.adapter.authorityInvocations).toHaveLength(1)
    expect(harness.adapter.authorityInvocations[0]!.invocation.recovery).toBe(false)

    await expect(prepareCutover(harness, id(39) ))
      .rejects.toMatchObject({ code: 'CUTOVER_RECOVERY_REQUIRED' })
    expect(harness.adapter.authorityInvocations).toHaveLength(1)

    harness.adapter.authorityRecoveryResults.push({
      status: 'rolled-back',
      receiptDigest: 'f'.repeat(64)
    })
    const recovered = await harness.service.recoverInterrupted({ requestId: id(38), desired: 'previous' })

    expect(recovered).toMatchObject({
      phase: 'recovered-previous',
      status: 'rolled-back',
      summary: { candidateDefined: false }
    })
    expect(harness.adapter.authorityInvocations.at(-1)!.invocation).toEqual({
      childRequestId: child.childRequestId,
      attempt: 1,
      mode: 'PrepareDisabled',
      recovery: true
    })
  })

  it('recovers the same child id after script success and outer lease loss before receipt persistence', async () => {
    const harness = createHarness()
    await prepareCutover(harness, randomUUID() )
    harness.resetObservations()
    harness.adapter.afterMutation = (name) => {
      if (name === 'enableCandidateAuthority') harness.coordinator.loseLease()
    }

    await expect(activateCutover(harness, id(30))).rejects.toMatchObject({ code: 'CUTOVER_HOST_LEASE_LOST' })

    const pending = clone(harness.store.journal!.authorityMutation)
    expect(pending).toMatchObject({
      phase: 'intent-persisted',
      method: 'enableCandidateAuthority',
      mode: 'Activate',
      attempt: 1,
      state: 'pending',
      receiptDigest: null
    })
    expect(harness.adapter.authorityReceipts.has(pending.childRequestId!)).toBe(true)
    harness.resetObservations()

    const recovered = await harness.service.recoverInterrupted({ requestId: id(30), desired: 'candidate' })

    expect(recovered.phase).toBe('recovered-candidate')
    expect(harness.adapter.authorityInvocations).toHaveLength(1)
    expect(harness.adapter.authorityInvocations[0]).toMatchObject({
      method: 'enableCandidateAuthority',
      invocation: {
        childRequestId: pending.childRequestId,
        attempt: pending.attempt,
        mode: 'Activate',
        recovery: true
      }
    })
    expect(harness.adapter.authorityInvocations[0]!.scope).toBe(harness.recoveryCoordinator.lastScope)
  })

  it('does not replay a child whose succeeded receipt was durable before the outer lease was lost', async () => {
    const harness = createHarness()
    await prepareCutover(harness, randomUUID() )
    harness.resetObservations()
    harness.store.afterReplace = (journal) => {
      if (journal.authorityMutation.method === 'enableCandidateAuthority' &&
          journal.authorityMutation.phase === 'receipt-persisted' &&
          journal.authorityMutation.state === 'succeeded') {
        harness.store.afterReplace = null
        harness.coordinator.loseLease()
      }
    }

    await expect(activateCutover(harness, id(31))).rejects.toMatchObject({ code: 'CUTOVER_HOST_LEASE_LOST' })
    expect(harness.store.journal?.authorityMutation).toMatchObject({
      phase: 'receipt-persisted',
      method: 'enableCandidateAuthority',
      state: 'succeeded'
    })
    harness.resetObservations()

    const recovered = await harness.service.recoverInterrupted({ requestId: id(31), desired: 'candidate' })

    expect(recovered.phase).toBe('recovered-candidate')
    expect(harness.adapter.authorityInvocations).toEqual([])
    expect(harness.adapter.mutations).toEqual(['startCandidateRuntime'])
  })

  it('creates a new child id and increments attempt when child recovery rolled back but candidate is still desired', async () => {
    const harness = createHarness()
    await prepareCutover(harness, randomUUID() )
    harness.resetObservations()
    harness.adapter.hardExitBefore = 'enableCandidateAuthority'

    await expect(activateCutover(harness, id(32))).rejects.toMatchObject({ code: 'CUTOVER_ADAPTER_FAILED' })
    const pending = clone(harness.store.journal!.authorityMutation)
    harness.adapter.hardExitBefore = null
    harness.resetObservations()
    harness.adapter.authorityRecoveryResults.push({
      status: 'rolled-back',
      receiptDigest: 'c'.repeat(64)
    })

    const recovered = await harness.service.recoverInterrupted({ requestId: id(32), desired: 'candidate' })

    expect(recovered.phase).toBe('recovered-candidate')
    expect(harness.adapter.authorityInvocations).toHaveLength(2)
    const [recovery, retry] = harness.adapter.authorityInvocations
    expect(recovery).toMatchObject({
      method: 'enableCandidateAuthority',
      invocation: {
        childRequestId: pending.childRequestId,
        attempt: 1,
        mode: 'Activate',
        recovery: true
      }
    })
    expect(retry).toMatchObject({
      method: 'enableCandidateAuthority',
      invocation: { attempt: 2, mode: 'Activate', recovery: false }
    })
    expect(retry!.invocation.childRequestId).not.toBe(pending.childRequestId)
  })

  it('re-enables an already running candidate with a new child after durable rollback-disable success', async () => {
    const harness = createHarness()
    await prepareCutover(harness, randomUUID() )
    await activateCutover(harness, id(35))
    harness.resetObservations()
    harness.store.afterReplace = (journal) => {
      if (journal.authorityMutation.method === 'disableCandidateAuthority' &&
          journal.authorityMutation.phase === 'receipt-persisted' &&
          journal.authorityMutation.state === 'succeeded') {
        harness.store.afterReplace = null
        harness.coordinator.loseLease()
      }
    }

    await expect(rollbackCutover(harness, id(36), 'immediate-compensation')).rejects.toMatchObject({ code: 'CUTOVER_HOST_LEASE_LOST' })
    const disabled = clone(harness.store.journal!.authorityMutation)
    expect(disabled).toMatchObject({
      method: 'disableCandidateAuthority',
      mode: 'PrepareDisabled',
      attempt: 1,
      state: 'succeeded'
    })
    harness.resetObservations()

    const recovered = await harness.service.recoverInterrupted({ requestId: id(36), desired: 'candidate' })

    expect(recovered.phase).toBe('recovered-candidate')
    expect(harness.adapter.mutations).toEqual(['enableCandidateAuthority'])
    expect(harness.adapter.mutations).not.toContain('startCandidateRuntime')
    expect(harness.adapter.authorityInvocations[0]).toMatchObject({
      method: 'enableCandidateAuthority',
      invocation: { attempt: 2, mode: 'Activate', recovery: false }
    })
    expect(harness.adapter.authorityInvocations[0]!.invocation.childRequestId)
      .not.toBe(disabled.childRequestId)
  })

  it('treats succeeded-child task evidence drift as invalid before recovery writes', async () => {
    const harness = createHarness()
    await prepareCutover(harness, randomUUID() )
    harness.resetObservations()
    harness.store.afterReplace = (journal) => {
      if (journal.authorityMutation.method === 'enableCandidateAuthority' &&
          journal.authorityMutation.phase === 'receipt-persisted') {
        harness.store.afterReplace = null
        harness.coordinator.loseLease()
      }
    }
    await expect(activateCutover(harness, id(37))).rejects.toMatchObject({ code: 'CUTOVER_HOST_LEASE_LOST' })
    harness.adapter.evidence.candidateEnabled = false
    harness.resetObservations()
    const writes = harness.store.writeCount

    expect(await harness.service.recoveryStatus()).toMatchObject({
      status: 'interrupted',
      allowedDesired: [],
      errorCode: 'CUTOVER_RECOVERY_EVIDENCE_INVALID'
    })
    await expect(harness.service.recoverInterrupted({ requestId: id(37), desired: 'candidate' }))
      .rejects.toMatchObject({ code: 'CUTOVER_RECOVERY_EVIDENCE_INVALID' })
    expect(harness.adapter.mutations).toEqual([])
    expect(harness.store.writeCount).toBe(writes)
  })

  it('abandons recovery when a repeated child receipt digest does not match durable evidence', async () => {
    const harness = createHarness()
    harness.adapter.hardExitBefore = 'defineCandidateDisabled'
    await expect(prepareCutover(harness, id(33) ))
      .rejects.toMatchObject({ code: 'CUTOVER_ADAPTER_FAILED' })
    harness.adapter.hardExitBefore = null
    harness.store.journal!.authorityMutation = {
      ...harness.store.journal!.authorityMutation,
      phase: 'receipt-persisted',
      state: 'recovery-required',
      receiptDigest: 'd'.repeat(64)
    }
    harness.resetObservations()
    harness.adapter.authorityRecoveryResults.push({
      status: 'recovery-required',
      receiptDigest: 'e'.repeat(64)
    })
    const writes = harness.store.writeCount

    await expect(harness.service.recoverInterrupted({ requestId: id(33), desired: 'previous' }))
      .rejects.toMatchObject({ code: 'CUTOVER_RECOVERY_EVIDENCE_INVALID' })

    expect(harness.store.writeCount).toBe(writes)
    expect(harness.store.journal?.authorityMutation.receiptDigest).toBe('d'.repeat(64))
    expect(harness.recoveryCoordinator.outcomes.at(-1)?.disposition).toBe('abandon')
  })

  it.each([
    ['mode', { mode: 'Activate' }],
    ['child id', { childRequestId: 'not-a-uuid' }]
  ])('rejects a malformed authority child %s before recovery mutation', async (_name, patch) => {
    const harness = createHarness()
    harness.adapter.hardExitBefore = 'defineCandidateDisabled'
    await expect(prepareCutover(harness, id(34) ))
      .rejects.toMatchObject({ code: 'CUTOVER_ADAPTER_FAILED' })
    harness.adapter.hardExitBefore = null
    Object.assign(harness.store.journal!.authorityMutation, patch)
    harness.resetObservations()
    const writes = harness.store.writeCount

    const status = await harness.service.recoveryStatus()

    expect(status).toMatchObject({
      status: 'evidence-invalid',
      allowedDesired: [],
      errorCode: 'CUTOVER_RECOVERY_EVIDENCE_INVALID'
    })
    expect(harness.adapter.authorityInvocations).toEqual([])
    expect(harness.store.writeCount).toBe(writes)
  })

  it.each([
    'disablePreviousAuthority',
    'stopPreviousRuntime',
    'enableCandidateAuthority',
    'startCandidateRuntime'
  ] as const)('abandons a durable journal across the hard-exit window after %s', async (fault) => {
    const harness = createHarness()
    await prepareCutover(harness, randomUUID() )
    harness.resetObservations()
    harness.adapter.hardExitAfter = fault

    await expect(activateCutover(harness, id(5))).rejects.toMatchObject({ code: 'CUTOVER_ADAPTER_FAILED' })

    expect(harness.store.journal).not.toBeNull()
    expect(harness.store.receipts.size).toBe(1) // prepare receipt only
    expect(harness.coordinator.outcomes.at(-1)?.disposition).toBe('abandon')
    const status = await harness.service.recoveryStatus()
    expect(status.phase).toBe('recovery-required')
    expect(status.allowedDesired).toEqual(expect.arrayContaining(['candidate', 'previous']))
  })

  it('propagates lease loss, abandons the journal, and passes the aborted signal to the adapter', async () => {
    const harness = createHarness()
    await prepareCutover(harness, randomUUID() )
    harness.resetObservations()
    harness.adapter.afterMutation = (name) => {
      if (name === 'disablePreviousAuthority') harness.coordinator.loseLease()
    }

    await expect(activateCutover(harness, id(6))).rejects.toMatchObject({ code: 'CUTOVER_HOST_LEASE_LOST' })

    expect(harness.store.journal).not.toBeNull()
    expect(harness.coordinator.leaseLost).toBe(true)
    expect(harness.adapter.seenSignals.every((signal) => signal === harness.coordinator.lastSignal)).toBe(true)
    expect(harness.coordinator.lastSignal?.aborted).toBe(true)
  })

  it('blocks a double-start race when the old process appears after candidate enable', async () => {
    const harness = createHarness()
    await prepareCutover(harness, randomUUID() )
    harness.resetObservations()
    let candidateStoppedInspections = 0
    harness.adapter.beforeInspect = () => {
      if (harness.adapter.evidence.candidateEnabled && harness.adapter.evidence.processState === 'none') {
        candidateStoppedInspections += 1
        if (candidateStoppedInspections === 2) {
          Object.assign(harness.adapter.evidence, {
            processState: 'previous-only',
            portState: 'previous',
            previousHealthy: true,
            candidateHealthy: false
          } satisfies Partial<CutoverHostEvidence>)
        }
      }
    }

    await expect(activateCutover(harness, id(7))).rejects.toMatchObject({ code: 'CUTOVER_STOP_GATE_FAILED' })

    expect(harness.adapter.mutations).not.toContain('startCandidateRuntime')
    expect(harness.coordinator.outcomes.at(-1)?.disposition).toBe('abandon')
  })

  it('replays an immutable receipt idempotently without another lease or mutation', async () => {
    const harness = createHarness()
    const request = {
      requestId: id(8),
      planFingerprint: await previewPlan(harness, { requestId: id(8), operation: 'prepare' }),
      confirmation: PREPARE_GSMANAGER_TO_DYSON
    } as const
    const first = await harness.service.prepare(request)
    const coordinatorCalls = harness.coordinator.requests.length
    const mutationCalls = harness.adapter.mutations.length
    const writes = harness.store.writeCount

    const replay = await harness.service.prepare(request)

    expect(first.summary.reused).toBe(false)
    expect(replay.summary.reused).toBe(true)
    expect(harness.coordinator.requests).toHaveLength(coordinatorCalls)
    expect(harness.adapter.mutations).toHaveLength(mutationCalls)
    expect(harness.store.writeCount).toBe(writes)

    await expect(harness.service.prepare({
      ...request,
      planFingerprint: 'f'.repeat(64)
    })).rejects.toMatchObject({ code: 'CUTOVER_IDEMPOTENCY_CONFLICT' })
    expect(harness.coordinator.requests).toHaveLength(coordinatorCalls)
    expect(harness.adapter.mutations).toHaveLength(mutationCalls)
    expect(harness.store.writeCount).toBe(writes)
  })

  it('keeps immediate compensation on the activation baseline but protects live progress for later rollback', async () => {
    const harness = createHarness()
    await prepareCutover(harness, randomUUID() )
    await activateCutover(harness, id(9))
    harness.resetObservations()

    const immediate = await rollbackCutover(harness, id(10), 'immediate-compensation')
    expect(harness.adapter.savePurposes).toEqual([])
    expect(harness.adapter.baselineRestores).toEqual([id(9)])
    expect(immediate).toMatchObject({
      phase: 'rolled-back-immediate',
      summary: { saveProtected: true, baselineRestored: true, currentProgressProtected: false }
    })

    await activateCutover(harness, id(11))
    harness.resetObservations()
    const later = await rollbackCutover(harness, id(12), 'later-operator-rollback')
    expect(harness.adapter.savePurposes).toEqual(['later-candidate-progress'])
    expect(harness.adapter.baselineRestores).toEqual([])
    expect(later).toMatchObject({
      phase: 'rolled-back-later',
      summary: { saveProtected: true, currentProgressProtected: true }
    })
  })

  it.each(['candidate', 'previous'] as const)('finishes stopped-source task cleanup before recovering %s authority', async (desired) => {
    const harness = createHarness()
    await prepareCutover(harness, randomUUID())
    harness.adapter.hardExitAfter = 'stopPreviousRuntime'
    await expect(activateCutover(harness, id(131))).rejects.toBeInstanceOf(CutoverError)
    expect(harness.adapter.previousStopSignals).toBe(1)
    expect(harness.adapter.previousStopCleanupPending).toBe(true)
    harness.adapter.hardExitAfter = null
    harness.resetObservations()
    const recovered = await harness.service.recoverInterrupted({ requestId: id(131), desired })
    expect(recovered.phase).toBe(`recovered-${desired}`)
    expect(harness.adapter.previousStopSignals).toBe(1)
    expect(harness.adapter.previousStopCleanupPending).toBe(false)
    const enabled = desired === 'candidate' ? 'enableCandidateAuthority' : 'enablePreviousAuthority'
    expect(harness.adapter.mutations.indexOf('stopPreviousRuntime')).toBeLessThan(harness.adapter.mutations.indexOf(enabled))
  })

  it.each([true, false])('recovers a failed previous stop without re-signaling (game still running=%s)', async (running) => {
    const harness = createHarness()
    await prepareCutover(harness, randomUUID())
    const oldRuntime = { ...harness.adapter.evidence }
    harness.adapter.hardExitAfter = 'stopPreviousRuntime'
    await expect(activateCutover(harness, id(132))).rejects.toBeInstanceOf(CutoverError)
    harness.adapter.hardExitAfter = null
    harness.adapter.previousStopFailed = true
    if (running) Object.assign(harness.adapter.evidence, oldRuntime, { previousEnabled: false })
    const recovered = await harness.service.recoverInterrupted({ requestId: id(132), desired: 'previous' })
    expect(recovered.phase).toBe('recovered-previous')
    expect(harness.adapter.previousStopSignals).toBe(1)
    expect(harness.adapter.previousStopFailed).toBe(true)
    expect(harness.adapter.previousStopCleanupPending).toBe(false)
  })

  it('recovers an interrupted activation idempotently to the candidate terminal', async () => {
    const harness = createHarness()
    await prepareCutover(harness, randomUUID() )
    harness.resetObservations()
    harness.adapter.hardExitAfter = 'startCandidateRuntime'
    await expect(activateCutover(harness, id(13))).rejects.toMatchObject({ code: 'CUTOVER_ADAPTER_FAILED' })
    harness.adapter.hardExitAfter = null

    const recovered = await harness.service.recoverInterrupted({ requestId: id(13), desired: 'candidate' })

    expect(recovered.phase).toBe('recovered-candidate')
    expect(harness.store.state.authority).toBe('candidate')
    expect(harness.store.journal).toBeNull()
    expect(harness.recoveryCoordinator.requests).toEqual([{
      expectedOperation: 'gsmanager-cutover-activate',
      expectedRequestId: id(13)
    }])
    expect(await harness.service.recoverInterrupted({ requestId: id(13), desired: 'candidate' }))
      .toMatchObject({ summary: { reused: true } })
  })

  it('recovers an interrupted activation to the previous authority without starting two runtimes', async () => {
    const harness = createHarness()
    await prepareCutover(harness, randomUUID() )
    harness.resetObservations()
    harness.adapter.hardExitAfter = 'disablePreviousAuthority'
    await expect(activateCutover(harness, id(14))).rejects.toBeInstanceOf(CutoverError)
    harness.adapter.hardExitAfter = null
    harness.resetObservations()

    const recovered = await harness.service.recoverInterrupted({ requestId: id(14), desired: 'previous' })

    expect(recovered.phase).toBe('recovered-previous')
    expect(harness.adapter.mutations).toEqual(['stopPreviousRuntime', 'enablePreviousAuthority'])
    expect(harness.adapter.previousStopSignals).toBe(0)
    expect(harness.adapter.evidence.processState).toBe('previous-only')
    expect(harness.store.state.authority).toBe('previous')
  })

  it('restores the paired activation baseline when recovery leaves a started candidate for previous', async () => {
    const harness = createHarness()
    await prepareCutover(harness, randomUUID() )
    harness.adapter.hardExitAfter = 'startCandidateRuntime'
    await expect(activateCutover(harness, id(19))).rejects.toBeInstanceOf(CutoverError)
    harness.adapter.hardExitAfter = null
    harness.resetObservations()

    const recovered = await harness.service.recoverInterrupted({ requestId: id(19), desired: 'previous' })

    expect(harness.adapter.mutations).toEqual([
      'disableCandidateAuthority',
      'stopCandidateRuntime',
      'stopPreviousRuntime',
      'restoreActivationBaseline',
      'enablePreviousAuthority',
      'startPreviousRuntime'
    ])
    expect(harness.adapter.baselineRestores).toEqual([id(19)])
    expect(recovered.summary.baselineRestored).toBe(true)
  })

  it('rejects valid-but-drifted durable state before recovery writes or live mutations', async () => {
    const harness = createHarness()
    await prepareCutover(harness, randomUUID() )
    harness.adapter.hardExitAfter = 'disablePreviousAuthority'
    await expect(activateCutover(harness, id(20))).rejects.toBeInstanceOf(CutoverError)
    harness.adapter.hardExitAfter = null
    harness.store.state = clone(createInitialCutoverState(AUTHORITY_INVENTORY_REVISION))
    harness.resetObservations()
    const writes = harness.store.writeCount

    await expect(harness.service.recoverInterrupted({ requestId: id(20), desired: 'previous' }))
      .rejects.toMatchObject({ code: 'CUTOVER_RECOVERY_EVIDENCE_INVALID' })
    expect(harness.adapter.mutations).toEqual([])
    expect(harness.store.writeCount).toBe(writes)
    expect(harness.recoveryCoordinator.outcomes.at(-1)?.disposition).toBe('abandon')
  })

  it('does not auto-recover an interrupted operation through an ordinary API', async () => {
    const harness = createHarness()
    await prepareCutover(harness, randomUUID() )
    harness.adapter.hardExitAfter = 'disablePreviousAuthority'
    await expect(activateCutover(harness, id(15))).rejects.toBeInstanceOf(CutoverError)
    harness.adapter.hardExitAfter = null
    const mutations = harness.adapter.mutations.length
    const coordinatorCalls = harness.coordinator.requests.length

    await expect(prepareCutover(harness, id(16) ))
      .rejects.toMatchObject({ code: 'CUTOVER_RECOVERY_REQUIRED' })
    expect(harness.adapter.mutations).toHaveLength(mutations)
    expect(harness.coordinator.requests).toHaveLength(coordinatorCalls)
  })

  it('reconciles a terminal receipt after the broker is already clean', async () => {
    const harness = createHarness()
    harness.store.failNextClear = true
    const receipt = await prepareCutover(harness, id(17) )
    expect(receipt.phase).toBe('prepared')
    expect(harness.store.journal?.phase).toBe('terminal')
    harness.recoveryCoordinator.recoveryNotRequired = true

    const replay = await harness.service.recoverInterrupted({ requestId: id(17), desired: 'previous' })

    expect(replay.summary.reused).toBe(true)
    expect(harness.store.journal).toBeNull()
  })
})

function createHarness(options: { ordinaryCoordinator?: RecordingCoordinator | null } = {}) {
  const events: string[] = []
  const store = new MemoryStore(events)
  const adapter = new FakeCutoverAdapter(events)
  const coordinator = options.ordinaryCoordinator === undefined
    ? new RecordingCoordinator()
    : options.ordinaryCoordinator
  const recoveryCoordinator = new RecordingRecoveryCoordinator()
  const service = new CutoverService({
    authorityInventoryRevision: AUTHORITY_INVENTORY_REVISION,
    adapter,
    store,
    ...(coordinator === null ? {} : { hostMutationCoordinator: coordinator }),
    hostMutationRecoveryCoordinator: recoveryCoordinator
  })
  return {
    service,
    store,
    adapter,
    coordinator: coordinator ?? new RecordingCoordinator(),
    recoveryCoordinator,
    events,
    resetObservations: () => {
      adapter.mutations.length = 0
      adapter.authorityInvocations.length = 0
      adapter.savePurposes.length = 0
      adapter.baselineRestores.length = 0
      adapter.seenSignals.length = 0
      adapter.seenScopes.length = 0
      coordinator?.reset()
      recoveryCoordinator.reset()
      events.length = 0
      adapter.beforeInspect = null
      adapter.afterMutation = null
      adapter.hardExitBefore = null
      store.afterReplace = null
    }
  }
}

type CutoverHarness = ReturnType<typeof createHarness>

async function previewPlan(
  harness: CutoverHarness,
  request: Parameters<CutoverService['preview']>[0]
): Promise<string> {
  const preview = await harness.service.preview(request)
  // Existing mutation-path assertions should observe only the execute lease.
  harness.adapter.seenSignals.length = 0
  return preview.planFingerprint
}

async function prepareCutover(harness: CutoverHarness, requestId: string) {
  const planFingerprint = await previewPlan(harness, { requestId, operation: 'prepare' })
  return await harness.service.prepare({
    requestId,
    planFingerprint,
    confirmation: PREPARE_GSMANAGER_TO_DYSON
  })
}

async function activateCutover(harness: CutoverHarness, requestId: string) {
  const planFingerprint = await previewPlan(harness, { requestId, operation: 'activate' })
  return await harness.service.activate({
    requestId,
    planFingerprint,
    confirmation: ACTIVATE_GSMANAGER_TO_DYSON
  })
}

async function rollbackCutover(
  harness: CutoverHarness,
  requestId: string,
  mode: 'immediate-compensation' | 'later-operator-rollback'
) {
  const planFingerprint = await previewPlan(harness, { requestId, operation: 'rollback', mode })
  return await harness.service.rollback({
    requestId,
    mode,
    planFingerprint,
    confirmation: ROLLBACK_DYSON_TO_GSMANAGER
  })
}

class MemoryStore implements CutoverDurableStore {
  state: CutoverStoredState = clone(createInitialCutoverState(AUTHORITY_INVENTORY_REVISION))
  journal: CutoverJournal | null = null
  readonly receipts = new Map<string, CutoverStoredReceipt>()
  writeCount = 0
  failNextClear = false
  afterReplace: ((journal: CutoverJournal) => void) | null = null

  constructor(private readonly events: string[]) {}

  async readState(): Promise<unknown> { return clone(this.state) }
  async readJournal(): Promise<unknown | null> { return this.journal === null ? null : clone(this.journal) }
  async readReceipt(requestId: string): Promise<unknown | null> {
    const receipt = this.receipts.get(requestId)
    return receipt === undefined ? null : clone(receipt)
  }

  async createJournal(journal: CutoverJournal): Promise<void> {
    if (this.journal !== null) throw new Error('journal-exists')
    this.journal = clone(journal)
    this.writeCount += 1
    this.events.push(`journal:${journal.phase}`)
  }

  async replaceJournal(expectedSequence: number, journal: CutoverJournal): Promise<void> {
    this.assertJournal(expectedSequence, journal.requestId, journal.fingerprint)
    if (journal.sequence !== expectedSequence + 1) throw new Error('sequence')
    this.journal = clone(journal)
    this.writeCount += 1
    this.events.push(`journal:${journal.phase}`)
    this.afterReplace?.(clone(journal))
  }

  async commitTerminal(input: {
    expectedSequence: number
    journal: CutoverJournal
    nextState: CutoverStoredState
    receipt: CutoverStoredReceipt
  }): Promise<void> {
    this.assertJournal(input.expectedSequence, input.journal.requestId, input.journal.fingerprint)
    if (input.journal.phase !== 'terminal' || input.journal.sequence !== input.expectedSequence + 1 ||
        this.receipts.has(input.receipt.receipt.requestId)) throw new Error('terminal-conflict')
    this.journal = clone(input.journal)
    this.state = clone(input.nextState)
    this.receipts.set(input.receipt.receipt.requestId, clone(input.receipt))
    this.writeCount += 1
    this.events.push('journal:terminal')
  }

  async clearTerminalJournal(input: {
    requestId: string
    fingerprint: string
    expectedSequence: number
  }): Promise<void> {
    if (this.failNextClear) {
      this.failNextClear = false
      throw new Error('simulated-clear-failure')
    }
    if (this.journal === null) return
    this.assertJournal(input.expectedSequence, input.requestId, input.fingerprint)
    if (this.journal.phase !== 'terminal') throw new Error('not-terminal')
    this.journal = null
    this.writeCount += 1
    this.events.push('journal:cleared')
  }

  private assertJournal(sequence: number, requestId: string, fingerprint: string): void {
    if (this.journal === null || this.journal.sequence !== sequence ||
        this.journal.requestId !== requestId || this.journal.fingerprint !== fingerprint) {
      throw new Error('journal-cas')
    }
  }
}

class FakeCutoverAdapter implements CutoverHostAdapter {
  evidence: CutoverHostEvidence = previousEvidence(false)
  readonly mutations: string[] = []
  readonly authorityInvocations: Array<{
    method: CutoverAuthorityMutationMethod
    invocation: CutoverAuthorityMutationInvocation
    scope: HostMutationOperationScope
  }> = []
  readonly authorityOrdinaryResults: CutoverAuthorityMutationResult[] = []
  readonly authorityRecoveryResults: CutoverAuthorityMutationResult[] = []
  readonly authorityReceipts = new Map<string, CutoverAuthorityMutationResult>()
  readonly savePurposes: Array<CutoverSaveProtectionRequest['purpose']> = []
  readonly baselineRestores: string[] = []
  readonly seenSignals: AbortSignal[] = []
  readonly seenScopes: HostMutationOperationScope[] = []
  hardExitAfter: string | null = null
  hardExitBefore: string | null = null
  previousStopSignals = 0
  previousStopCleanupPending = false
  previousStopFailed = false
  beforeInspect: (() => void) | null = null
  afterMutation: ((name: string) => void) | null = null

  constructor(private readonly events: string[]) {}

  async inspect(request: CutoverAdapterRequest): Promise<CutoverHostEvidence> {
    this.seenSignals.push(request.signal)
    this.beforeInspect?.()
    return clone(this.evidence)
  }

  async defineCandidateDisabled(
    request: CutoverAuthorityMutationRequest
  ): Promise<CutoverAuthorityMutationResult> {
    return this.applyAuthorityMutation('defineCandidateDisabled', request, () => {
      this.evidence.candidateDefined = true
      this.evidence.candidateEnabled = false
    })
  }

  async createSaveProtectionPoint(request: CutoverSaveProtectionRequest): Promise<{ pairProtected: true; durable: true }> {
    this.savePurposes.push(request.purpose)
    this.apply(`createSaveProtectionPoint:${request.purpose}`, request, () => {})
    return { pairProtected: true, durable: true }
  }

  async restoreActivationBaseline(request: CutoverBaselineRestoreRequest): Promise<{ pairRestored: true; durable: true }> {
    this.baselineRestores.push(request.activationRequestId)
    this.apply('restoreActivationBaseline', request, () => {})
    return { pairRestored: true, durable: true }
  }

  async disablePreviousAuthority(request: CutoverAdapterMutationRequest): Promise<void> {
    this.apply('disablePreviousAuthority', request, () => { this.evidence.previousEnabled = false })
  }

  async stopPreviousRuntime(request: CutoverAdapterMutationRequest, options?: Readonly<{ reconcileOnly: true }>): Promise<void> {
    this.apply('stopPreviousRuntime', request, () => {
      if (!options?.reconcileOnly) {
        if (this.previousStopFailed) throw new Error('stop failed')
        if (this.evidence.processState === 'previous-only') this.previousStopSignals += 1
        Object.assign(this.evidence, stoppedRuntime())
      }
      this.previousStopCleanupPending = this.hardExitAfter === 'stopPreviousRuntime'
    })
  }

  async enableCandidateAuthority(
    request: CutoverAuthorityMutationRequest
  ): Promise<CutoverAuthorityMutationResult> {
    if (this.previousStopCleanupPending) throw new Error('previous stop cleanup required')
    return this.applyAuthorityMutation(
      'enableCandidateAuthority',
      request,
      () => { this.evidence.candidateEnabled = true }
    )
  }

  async startCandidateRuntime(request: CutoverAdapterMutationRequest): Promise<void> {
    this.apply('startCandidateRuntime', request, () => {
      Object.assign(this.evidence, {
        processState: 'candidate-only',
        portState: 'candidate',
        previousHealthy: false,
        candidateHealthy: true
      } satisfies Partial<CutoverHostEvidence>)
    })
  }

  async disableCandidateAuthority(
    request: CutoverAuthorityMutationRequest
  ): Promise<CutoverAuthorityMutationResult> {
    return this.applyAuthorityMutation(
      'disableCandidateAuthority',
      request,
      () => { this.evidence.candidateEnabled = false }
    )
  }

  async stopCandidateRuntime(request: CutoverAdapterMutationRequest): Promise<void> {
    this.apply('stopCandidateRuntime', request, () => { Object.assign(this.evidence, stoppedRuntime()) })
  }

  async enablePreviousAuthority(request: CutoverAdapterMutationRequest): Promise<void> {
    if (this.previousStopCleanupPending) throw new Error('previous stop cleanup required')
    this.apply('enablePreviousAuthority', request, () => { this.evidence.previousEnabled = true })
  }

  async startPreviousRuntime(request: CutoverAdapterMutationRequest): Promise<void> {
    this.apply('startPreviousRuntime', request, () => {
      Object.assign(this.evidence, {
        processState: 'previous-only',
        portState: 'previous',
        previousHealthy: true,
        candidateHealthy: false
      } satisfies Partial<CutoverHostEvidence>)
    })
  }

  private applyAuthorityMutation(
    method: CutoverAuthorityMutationMethod,
    request: CutoverAuthorityMutationRequest,
    action: () => void
  ): CutoverAuthorityMutationResult {
    const invocation = clone(request.authorityMutation)
    const expectedMode = method === 'enableCandidateAuthority' ? 'Activate' : 'PrepareDisabled'
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      invocation.childRequestId
    ) || !Number.isInteger(invocation.attempt) || invocation.attempt < 1 ||
        invocation.mode !== expectedMode || typeof invocation.recovery !== 'boolean') {
      throw new Error('invalid-authority-mutation-invocation')
    }
    this.authorityInvocations.push({ method, invocation, scope: request.hostMutation })
    let result: CutoverAuthorityMutationResult | null = null
    this.apply(method, request, () => {
      const override = invocation.recovery
        ? this.authorityRecoveryResults.shift()
        : this.authorityOrdinaryResults.shift()
      const stored = this.authorityReceipts.get(invocation.childRequestId)
      if (override !== undefined) {
        result = clone(override)
        if (override.status === 'succeeded') action()
      } else if (invocation.recovery && stored !== undefined) {
        result = clone(stored)
      } else {
        action()
        result = {
          status: 'succeeded',
          receiptDigest: authorityReceiptDigest(method, invocation)
        }
      }
      if (result.status !== 'recovery-required') {
        this.authorityReceipts.set(invocation.childRequestId, clone(result))
      }
    })
    if (result === null) throw new Error('authority-mutation-result-missing')
    return result
  }

  private apply(name: string, request: CutoverAdapterMutationRequest, action: () => void): void {
    this.seenSignals.push(request.signal)
    this.seenScopes.push(request.hostMutation)
    request.hostMutation.assertActive()
    this.mutations.push(name)
    this.events.push(`adapter:${name}`)
    if (this.hardExitBefore === name || (name.startsWith('createSaveProtectionPoint:') &&
        this.hardExitBefore === 'createSaveProtectionPoint')) {
      throw new Error('simulated-hard-exit-before-mutation')
    }
    action()
    this.afterMutation?.(name)
    request.hostMutation.assertActive()
    if (this.hardExitAfter === name || (name.startsWith('createSaveProtectionPoint:') &&
        this.hardExitAfter === 'createSaveProtectionPoint')) {
      throw new Error('simulated-hard-exit')
    }
  }
}

class RecordingCoordinator implements HostMutationOperationCoordinator {
  readonly requests: HostMutationOperationRequest[] = []
  readonly outcomes: HostMutationOperationOutcome<unknown>[] = []
  lastSignal: AbortSignal | null = null
  lastScope: HostMutationOperationScope | null = null
  leaseLost = false
  busy = false
  #controller = new AbortController()

  async runExclusive<T>(request: HostMutationOperationRequest, operation: HostMutationOperation<T>): Promise<T> {
    this.requests.push({ ...request })
    if (this.busy) throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_BUSY')
    this.#controller = new AbortController()
    this.leaseLost = false
    this.busy = false
    this.lastSignal = this.#controller.signal
    const scope: HostMutationOperationScope = {
      signal: this.#controller.signal,
      assertActive: () => {
        if (this.leaseLost) throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_LOST')
      },
      toPowerShellBorrowArguments: () => []
    }
    this.lastScope = scope
    try {
      const outcome = await operation(scope)
      this.outcomes.push(outcome as HostMutationOperationOutcome<unknown>)
      return unwrapOutcome(outcome)
    } catch (error) {
      if (error instanceof HostMutationLeaseError) {
        this.outcomes.push({ kind: 'throw', error, disposition: 'abandon' })
        throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_LOST')
      }
      throw error
    }
  }

  loseLease(): void {
    this.leaseLost = true
    this.#controller.abort()
  }

  reset(): void {
    this.requests.length = 0
    this.outcomes.length = 0
    this.leaseLost = false
    this.busy = false
    this.lastSignal = null
    this.lastScope = null
  }
}

class RecordingRecoveryCoordinator implements HostMutationRecoveryOperationCoordinator {
  readonly requests: HostMutationRecoveryOperationRequest[] = []
  readonly outcomes: HostMutationOperationOutcome<unknown>[] = []
  recoveryNotRequired = false
  lastScope: HostMutationOperationScope | null = null

  async runRecoveryExclusive<T>(
    request: HostMutationRecoveryOperationRequest,
    operation: HostMutationOperation<T>
  ): Promise<T> {
    this.requests.push({ ...request })
    if (this.recoveryNotRequired) {
      throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_RECOVERY_NOT_REQUIRED')
    }
    const scope: HostMutationOperationScope = {
      signal: new AbortController().signal,
      assertActive: () => {},
      toPowerShellBorrowArguments: () => []
    }
    this.lastScope = scope
    const outcome = await operation(scope)
    this.outcomes.push(outcome as HostMutationOperationOutcome<unknown>)
    return unwrapOutcome(outcome)
  }

  reset(): void {
    this.requests.length = 0
    this.outcomes.length = 0
    this.recoveryNotRequired = false
    this.lastScope = null
  }
}

function unwrapOutcome<T>(outcome: HostMutationOperationOutcome<T>): T {
  if (outcome.kind === 'return') return outcome.value
  throw outcome.error
}

function previousEvidence(candidateDefined: boolean): CutoverHostEvidence {
  return {
    previousDefined: true,
    previousEnabled: true,
    candidateDefined,
    candidateEnabled: false,
    unexpectedAuthorityPresent: false,
    processState: 'previous-only',
    portState: 'previous',
    previousHealthy: true,
    candidateHealthy: false
  }
}

function stoppedPreviousEvidence(candidateDefined: boolean): CutoverHostEvidence {
  return {
    previousDefined: true,
    previousEnabled: true,
    candidateDefined,
    candidateEnabled: false,
    unexpectedAuthorityPresent: false,
    processState: 'none',
    portState: 'closed',
    previousHealthy: false,
    candidateHealthy: false
  }
}

function stoppedRuntime(): Partial<CutoverHostEvidence> {
  return {
    processState: 'none',
    portState: 'closed',
    previousHealthy: false,
    candidateHealthy: false
  }
}

function id(suffix: number): string {
  return `00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`
}

function authorityReceiptDigest(
  method: CutoverAuthorityMutationMethod,
  invocation: CutoverAuthorityMutationInvocation
): string {
  return createHash('sha256').update(JSON.stringify({
    attempt: invocation.attempt,
    childRequestId: invocation.childRequestId,
    method,
    mode: invocation.mode
  })).digest('hex')
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

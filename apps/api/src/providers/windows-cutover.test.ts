import { describe, expect, it } from 'vitest'
import { HostMutationLeaseError } from '../host-mutation/lease.js'
import type { HostMutationOperationScope } from '../host-mutation/operation-coordinator.js'
import type {
  CutoverAuthorityMutationInvocation,
  CutoverAuthorityMutationRequest,
  CutoverHostEvidence
} from '../cutover/types.js'
import {
  WindowsCutoverAdapter,
  WindowsCutoverAdapterError,
  type WindowsCutoverCandidateTaskRequest,
  type WindowsCutoverFixedMutationRequest,
  type WindowsCutoverHostClient,
  type WindowsCutoverInspectionRequest,
  type WindowsCutoverSaveTransactionFacade
} from './windows-cutover.js'

const authorityRevision = 'a'.repeat(64)
const pairRevision = 'b'.repeat(64)
const restoredRevision = 'c'.repeat(64)
const receiptDigest = 'd'.repeat(64)

describe('broker-independent Windows cutover adapter', () => {
  it('strictly inspects bounded evidence and binds it to the construction inventory revision', async () => {
    const harness = createHarness()
    const controller = new AbortController()

    const result = await harness.adapter.inspect({ requestId: id(1), signal: controller.signal })

    expect(result).toEqual(previousEvidence())
    expect(harness.host.inspectionCalls).toEqual([{ requestId: id(1), signal: controller.signal }])

    harness.host.inspectionResult = {
      authorityInventoryRevision: 'e'.repeat(64),
      evidence: previousEvidence()
    }
    await expect(harness.adapter.inspect({ requestId: id(2), signal: controller.signal }))
      .rejects.toMatchObject({ code: 'WINDOWS_CUTOVER_AUTHORITY_REVISION_MISMATCH' })
  })

  it('rejects extra or malformed inspection evidence without exposing the host value', async () => {
    const harness = createHarness()
    harness.host.inspectionResult = {
      authorityInventoryRevision: authorityRevision,
      evidence: { ...previousEvidence(), path: 'C:\\Fictional\\secret.xml' }
    }

    const error = await captureError(harness.adapter.inspect({
      requestId: id(3),
      signal: new AbortController().signal
    }))

    expect(error).toEqual(expect.objectContaining<Partial<WindowsCutoverAdapterError>>({
      code: 'WINDOWS_CUTOVER_INSPECTION_FAILED',
      message: 'WINDOWS_CUTOVER_INSPECTION_FAILED'
    }))
    expect(JSON.stringify(error)).not.toContain('Fictional')
  })

  it('converges a sensitive inspection exception to a code-only adapter error', async () => {
    const harness = createHarness()
    harness.host.inspectionError = new Error('C:\\Fictional\\inspect.xml --secret')

    const error = await captureError(harness.adapter.inspect({
      requestId: id(37),
      signal: new AbortController().signal
    }))

    expect(error).toMatchObject({
      code: 'WINDOWS_CUTOVER_INSPECTION_FAILED',
      message: 'WINDOWS_CUTOVER_INSPECTION_FAILED'
    })
    expect(error).not.toHaveProperty('cause')
    expect(JSON.stringify(error)).not.toContain('Fictional')
  })

  it.each([
    ['defineCandidateDisabled', 'PrepareDisabled'],
    ['enableCandidateAuthority', 'Activate'],
    ['disableCandidateAuthority', 'PrepareDisabled']
  ] as const)('maps %s to the exact runtime-task mode and preserves the child invocation', async (method, mode) => {
    const harness = createHarness()
    const active = activeScope()
    const invocation: CutoverAuthorityMutationInvocation = {
      childRequestId: id(10),
      attempt: 3,
      mode,
      recovery: true
    }

    const result = await invokeCandidate(harness.adapter, method, {
      requestId: id(4),
      signal: active.scope.signal,
      hostMutation: active.scope,
      authorityMutation: invocation
    })

    expect(result.status).toBe('succeeded')
    expect(result.receiptDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(result.receiptDigest).not.toBe(receiptDigest)
    expect(harness.host.candidateCalls).toEqual([{
      outerRequestId: id(4),
      authorityMutation: invocation,
      hostMutation: active.scope
    }])
    expect(harness.host.candidateCalls[0]!.authorityMutation).toEqual(invocation)
    expect(active.assertions()).toBeGreaterThanOrEqual(2)
  })

  it.each([undefined, { reconcileOnly: true } as const])(
    'preserves the previous-stop reconciliation option without changing the mutation binding: %j',
    async (options) => {
      const harness = createHarness()
      const active = activeScope()
      const request = {
        requestId: id(7),
        signal: active.scope.signal,
        hostMutation: active.scope
      }

      if (options === undefined) await harness.adapter.stopPreviousRuntime(request)
      else await harness.adapter.stopPreviousRuntime(request, options)

      expect(harness.host.previousStopOptions).toStrictEqual([options])
      expect(harness.host.fixedCalls).toStrictEqual([{
        method: 'stopPreviousRuntime',
        request: { requestId: id(7), hostMutation: active.scope }
      }])
      expect(harness.host.fixedCalls[0]!.request.hostMutation).toBe(active.scope)
      expect(active.assertions()).toBeGreaterThanOrEqual(2)
    }
  )

  it('binds the terminal digest to every child invocation identity field', async () => {
    const harness = createHarness()
    const outerRequestId = id(24)
    const invocations: CutoverAuthorityMutationInvocation[] = [
      { childRequestId: id(25), attempt: 1, mode: 'Activate', recovery: false },
      { childRequestId: id(26), attempt: 1, mode: 'Activate', recovery: false },
      { childRequestId: id(25), attempt: 2, mode: 'Activate', recovery: false },
      { childRequestId: id(25), attempt: 1, mode: 'Activate', recovery: true },
      { childRequestId: id(25), attempt: 1, mode: 'PrepareDisabled', recovery: false }
    ]
    const results = []

    for (const invocation of invocations) {
      const active = activeScope()
      results.push(await invokeCandidate(
        harness.adapter,
        invocation.mode === 'Activate' ? 'enableCandidateAuthority' : 'defineCandidateDisabled',
        {
          requestId: outerRequestId,
          signal: active.scope.signal,
          hostMutation: active.scope,
          authorityMutation: invocation
        }
      ))
    }

    expect(new Set(results.map((result) => result.receiptDigest)).size).toBe(invocations.length)
    expect(harness.host.candidateCalls.map((call) => call.authorityMutation)).toEqual(invocations)
  })

  it('rejects an authority method/mode mismatch before calling the fixed host client', async () => {
    const harness = createHarness()
    const active = activeScope()

    await expect(harness.adapter.disableCandidateAuthority({
      requestId: id(5),
      signal: active.scope.signal,
      hostMutation: active.scope,
      authorityMutation: {
        childRequestId: id(11),
        attempt: 1,
        mode: 'Activate',
        recovery: false
      }
    })).rejects.toMatchObject({ code: 'WINDOWS_CUTOVER_REQUEST_INVALID' })
    expect(harness.host.candidateCalls).toEqual([])
  })

  it.each([
    { status: 'succeeded', receiptDigest: null },
    { status: 'rolled-back', receiptDigest: 'not-a-digest' },
    { status: 'recovery-required', receiptDigest },
    { status: 'succeeded', receiptDigest, command: 'fictional.exe' }
  ])('strictly rejects an invalid candidate transaction receipt %#', async (patch) => {
    const harness = createHarness()
    harness.host.candidateResult = candidateReceipt({
      outerRequestId: id(6),
      authorityMutation: {
        childRequestId: id(12),
        attempt: 1,
        mode: 'Activate',
        recovery: false
      },
      patch
    })
    const active = activeScope()

    const error = await captureError(harness.adapter.enableCandidateAuthority({
      requestId: id(6),
      signal: active.scope.signal,
      hostMutation: active.scope,
      authorityMutation: {
        childRequestId: id(12),
        attempt: 1,
        mode: 'Activate',
        recovery: false
      }
    }))

    expect(error).toMatchObject({
      code: 'WINDOWS_CUTOVER_CANDIDATE_TRANSACTION_FAILED',
      message: 'WINDOWS_CUTOVER_CANDIDATE_TRANSACTION_FAILED'
    })
    expect(JSON.stringify(error)).not.toContain('fictional.exe')
  })

  it('accepts recovery-required only with a null digest and never invokes terminal binding', async () => {
    const harness = createHarness()
    const active = activeScope()
    const invocation: CutoverAuthorityMutationInvocation = {
      childRequestId: id(40),
      attempt: 4,
      mode: 'Activate',
      recovery: true
    }
    harness.host.candidateResult = candidateReceipt({
      outerRequestId: id(41),
      authorityMutation: invocation,
      patch: { status: 'recovery-required', receiptDigest: null }
    })

    const result = await harness.adapter.enableCandidateAuthority({
      requestId: id(41),
      signal: active.scope.signal,
      hostMutation: active.scope,
      authorityMutation: invocation
    })

    expect(result).toEqual({ status: 'recovery-required', receiptDigest: null })
  })

  it('converges a sensitive candidate transaction exception to a code-only adapter error', async () => {
    const harness = createHarness()
    const active = activeScope()
    harness.host.candidateError = new Error('C:\\Fictional\\runtime-task.ps1 --secret')

    const error = await captureError(harness.adapter.defineCandidateDisabled({
      requestId: id(38),
      signal: active.scope.signal,
      hostMutation: active.scope,
      authorityMutation: {
        childRequestId: id(39),
        attempt: 1,
        mode: 'PrepareDisabled',
        recovery: false
      }
    }))

    expect(error).toMatchObject({
      code: 'WINDOWS_CUTOVER_CANDIDATE_TRANSACTION_FAILED',
      message: 'WINDOWS_CUTOVER_CANDIDATE_TRANSACTION_FAILED'
    })
    expect(error).not.toHaveProperty('cause')
    expect(JSON.stringify(error)).not.toContain('Fictional')
  })

  it.each([
    { outerRequestId: id(31) },
    { childRequestId: id(31) },
    { attempt: 2 },
    { mode: 'PrepareDisabled' },
    { recovery: true }
  ])('rejects a candidate receipt whose invocation binding is wrong %#', async (patch) => {
    const harness = createHarness()
    const invocation: CutoverAuthorityMutationInvocation = {
      childRequestId: id(30),
      attempt: 1,
      mode: 'Activate',
      recovery: false
    }
    harness.host.candidateResult = candidateReceipt({
      outerRequestId: id(29),
      authorityMutation: invocation,
      patch
    })
    const active = activeScope()

    await expect(harness.adapter.enableCandidateAuthority({
      requestId: id(29),
      signal: active.scope.signal,
      hostMutation: active.scope,
      authorityMutation: invocation
    })).rejects.toMatchObject({ code: 'WINDOWS_CUTOVER_CANDIDATE_TRANSACTION_FAILED' })
  })

  it.each([
    'disablePreviousAuthority',
    'stopPreviousRuntime',
    'enablePreviousAuthority',
    'startPreviousRuntime',
    'startCandidateRuntime',
    'stopCandidateRuntime'
  ] as const)('calls fixed host method %s with only request id and the identical scope', async (method) => {
    const harness = createHarness()
    const active = activeScope()

    await harness.adapter[method]({
      requestId: id(7),
      signal: active.scope.signal,
      hostMutation: active.scope
    })

    expect(harness.host.fixedCalls).toEqual([{
      method,
      request: { requestId: id(7), hostMutation: active.scope }
    }])
    expect(Object.keys(harness.host.fixedCalls[0]!.request).sort()).toEqual(['hostMutation', 'requestId'])
    expect(harness.host.fixedCalls[0]!.request.hostMutation).toBe(active.scope)
    expect(harness.host.fixedCalls[0]!.request.hostMutation.signal).toBe(active.scope.signal)
    expect(active.assertions()).toBeGreaterThanOrEqual(2)
  })

  it.each([
    { requestId: id(32), status: 'succeeded' },
    { requestId: id(33), status: 'failed' },
    { requestId: id(33), status: 'succeeded', taskName: 'FictionalTask' }
  ])('strictly rejects an invalid fixed host receipt %#', async (fixedResult) => {
    const harness = createHarness()
    const active = activeScope()
    harness.host.fixedResult = fixedResult

    const error = await captureError(harness.adapter.startCandidateRuntime({
      requestId: id(33),
      signal: active.scope.signal,
      hostMutation: active.scope
    }))

    expect(error).toMatchObject({
      code: 'WINDOWS_CUTOVER_HOST_MUTATION_FAILED',
      message: 'WINDOWS_CUTOVER_HOST_MUTATION_FAILED'
    })
    expect(JSON.stringify(error)).not.toContain('FictionalTask')
  })

  it('preserves lease loss instead of converting it into an adapter-domain failure', async () => {
    const harness = createHarness()
    const active = activeScope()
    harness.host.afterFixed = () => { active.lose() }

    await expect(harness.adapter.startCandidateRuntime({
      requestId: id(8),
      signal: active.scope.signal,
      hostMutation: active.scope
    })).rejects.toBeInstanceOf(HostMutationLeaseError)
    expect(active.scope.signal.aborted).toBe(true)
  })

  it('requires the adapter signal to be the same signal carried by the scope', async () => {
    const harness = createHarness()
    const active = activeScope()

    await expect(harness.adapter.stopCandidateRuntime({
      requestId: id(9),
      signal: new AbortController().signal,
      hostMutation: active.scope
    })).rejects.toMatchObject({ code: 'WINDOWS_CUTOVER_REQUEST_INVALID' })
    expect(harness.host.fixedCalls).toEqual([])
  })

  it('converges a sensitive host exception to a code-only adapter error', async () => {
    const harness = createHarness()
    const active = activeScope()
    harness.host.fixedError = new Error('C:\\Fictional\\task.xml --secret')

    const error = await captureError(harness.adapter.disablePreviousAuthority({
      requestId: id(13),
      signal: active.scope.signal,
      hostMutation: active.scope
    }))

    expect(error).toBeInstanceOf(WindowsCutoverAdapterError)
    expect(error).toMatchObject({
      code: 'WINDOWS_CUTOVER_HOST_MUTATION_FAILED',
      message: 'WINDOWS_CUTOVER_HOST_MUTATION_FAILED'
    })
    expect(error).not.toHaveProperty('cause')
    expect(JSON.stringify(error)).not.toContain('Fictional')
  })

  it('creates a clean audited protection point using only the outer id and fixed save name', async () => {
    const harness = createHarness()
    const active = activeScope()

    const result = await harness.adapter.createSaveProtectionPoint({
      requestId: id(14),
      signal: active.scope.signal,
      hostMutation: active.scope,
      purpose: 'activation-baseline'
    })

    expect(result).toEqual({ pairProtected: true, durable: true })
    expect(harness.saves.backupCalls).toEqual([{ requestId: id(14), saveName: '_lastexit_' }])
    expect(Object.keys(harness.saves.backupCalls[0]!).sort()).toEqual(['requestId', 'saveName'])
    expect(JSON.stringify(result)).not.toContain('tx-')
    expect(active.assertions()).toBeGreaterThanOrEqual(2)
  })

  it.each([
    { auditStored: false },
    { cleanupPending: true },
    { maintenanceRequired: true },
    { status: 'failed', errorCode: 'SAVE_COMMIT_FAILED' },
    { rollback: 'failed' }
  ])('rejects an unproven save protection result %#', async (patch) => {
    const harness = createHarness()
    harness.saves.backupPatch = patch
    const active = activeScope()

    await expect(harness.adapter.createSaveProtectionPoint({
      requestId: id(15),
      signal: active.scope.signal,
      hostMutation: active.scope,
      purpose: 'later-candidate-progress'
    })).rejects.toMatchObject({ code: 'WINDOWS_CUTOVER_SAVE_PROTECTION_FAILED' })
  })

  it('restores from the activation transaction with stable, distinct derived ids and the same host scope', async () => {
    const harness = createHarness()
    const firstScope = activeScope()
    const secondScope = activeScope()
    const input = {
      requestId: id(16),
      activationRequestId: id(17)
    }

    const first = await harness.adapter.restoreActivationBaseline({
      ...input,
      signal: firstScope.scope.signal,
      hostMutation: firstScope.scope
    })
    const second = await harness.adapter.restoreActivationBaseline({
      ...input,
      signal: secondScope.scope.signal,
      hostMutation: secondScope.scope
    })

    expect(first).toEqual({ pairRestored: true, durable: true })
    expect(second).toEqual(first)
    expect(harness.saves.inspectCalls).toEqual(['_lastexit_', '_lastexit_'])
    expect(harness.saves.restoreCalls).toHaveLength(2)
    const [firstCall, secondCall] = harness.saves.restoreCalls
    expect(firstCall!.request).toMatchObject({
      backupId: `tx-${id(17)}`,
      expectedRevision: pairRevision
    })
    expect(firstCall!.request.requestId).toBe(secondCall!.request.requestId)
    expect(firstCall!.request.protectionRequestId).toBe(secondCall!.request.protectionRequestId)
    expect(firstCall!.request.requestId).not.toBe(firstCall!.request.protectionRequestId)
    expect(firstCall!.request.requestId).not.toBe(input.requestId)
    expect(firstCall!.request.requestId).not.toBe(input.activationRequestId)
    expect(firstCall!.request.protectionRequestId).not.toBe(input.requestId)
    expect(firstCall!.request.protectionRequestId).not.toBe(input.activationRequestId)
    expect(firstCall!.request.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(firstCall!.request.protectionRequestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(firstCall!.scope).toBe(firstScope.scope)
    expect(secondCall!.scope).toBe(secondScope.scope)
    expect(JSON.stringify(first)).not.toContain(firstCall!.request.requestId)
    expect(JSON.stringify(first)).not.toContain(pairRevision)
  })

  it('binds derived restore ids to both outer and activation request identities', async () => {
    const harness = createHarness()
    const first = activeScope()
    const second = activeScope()

    await harness.adapter.restoreActivationBaseline({
      requestId: id(18), activationRequestId: id(19),
      signal: first.scope.signal, hostMutation: first.scope
    })
    await harness.adapter.restoreActivationBaseline({
      requestId: id(20), activationRequestId: id(19),
      signal: second.scope.signal, hostMutation: second.scope
    })

    expect(harness.saves.restoreCalls[0]!.request.requestId)
      .not.toBe(harness.saves.restoreCalls[1]!.request.requestId)
    expect(harness.saves.restoreCalls[0]!.request.protectionRequestId)
      .not.toBe(harness.saves.restoreCalls[1]!.request.protectionRequestId)
  })

  it.each([
    { auditStored: false },
    { cleanupPending: true },
    { maintenanceRequired: true },
    { status: 'rollback-failed', rollback: 'failed', errorCode: 'SAVE_ROLLBACK_FAILED' },
    { beforeRevision: 'e'.repeat(64) }
  ])('rejects an unproven baseline restore result %#', async (patch) => {
    const harness = createHarness()
    harness.saves.restorePatch = patch
    const active = activeScope()

    await expect(harness.adapter.restoreActivationBaseline({
      requestId: id(21),
      activationRequestId: id(22),
      signal: active.scope.signal,
      hostMutation: active.scope
    })).rejects.toMatchObject({ code: 'WINDOWS_CUTOVER_SAVE_RESTORE_FAILED' })
  })

  it('rejects extra save receipt fields and never exposes backup ids, revisions, or paths', async () => {
    const harness = createHarness()
    harness.saves.backupPatch = { backupPath: 'C:\\Fictional\\backup' }
    const active = activeScope()

    const error = await captureError(harness.adapter.createSaveProtectionPoint({
      requestId: id(23),
      signal: active.scope.signal,
      hostMutation: active.scope,
      purpose: 'activation-baseline'
    }))

    expect(error).toMatchObject({
      code: 'WINDOWS_CUTOVER_SAVE_PROTECTION_FAILED',
      message: 'WINDOWS_CUTOVER_SAVE_PROTECTION_FAILED'
    })
    expect(JSON.stringify(error)).not.toContain('Fictional')
    expect(JSON.stringify(harness.adapter)).toBe('{}')
  })

  it.each([
    ['backup', 'WINDOWS_CUTOVER_SAVE_PROTECTION_FAILED'],
    ['inspect', 'WINDOWS_CUTOVER_SAVE_RESTORE_FAILED'],
    ['restore', 'WINDOWS_CUTOVER_SAVE_RESTORE_FAILED']
  ] as const)('converges a sensitive %s facade exception to a code-only error', async (method, code) => {
    const harness = createHarness()
    const active = activeScope()
    harness.saves[`${method}Error`] = new Error('C:\\Fictional\\save --secret')

    const promise = method === 'backup'
      ? harness.adapter.createSaveProtectionPoint({
          requestId: id(34),
          signal: active.scope.signal,
          hostMutation: active.scope,
          purpose: 'activation-baseline'
        })
      : harness.adapter.restoreActivationBaseline({
          requestId: id(35),
          activationRequestId: id(36),
          signal: active.scope.signal,
          hostMutation: active.scope
        })
    const error = await captureError(promise)

    expect(error).toEqual(expect.objectContaining({ code, message: code }))
    expect(error).not.toHaveProperty('cause')
    expect(JSON.stringify(error)).not.toContain('Fictional')
  })

  it('fails construction closed without a bounded revision or every fixed capability', () => {
    const harness = createHarness()

    expect(() => new WindowsCutoverAdapter({
      authorityInventoryRevision: 'not-a-digest',
      hostClient: harness.host,
      saves: harness.saves
    })).toThrow(expect.objectContaining<Partial<WindowsCutoverAdapterError>>({
      code: 'WINDOWS_CUTOVER_OPTIONS_INVALID'
    }))
    expect(() => new WindowsCutoverAdapter({
      authorityInventoryRevision: authorityRevision,
      hostClient: { ...harness.host, startCandidateRuntime: undefined } as unknown as WindowsCutoverHostClient,
      saves: harness.saves
    })).toThrow(expect.objectContaining<Partial<WindowsCutoverAdapterError>>({
      code: 'WINDOWS_CUTOVER_OPTIONS_INVALID'
    }))
  })
})

function createHarness() {
  const host = new RecordingHostClient()
  const saves = new RecordingSaveFacade()
  const adapter = new WindowsCutoverAdapter({
    authorityInventoryRevision: authorityRevision,
    hostClient: host,
    saves
  })
  return { adapter, host, saves }
}

class RecordingHostClient implements WindowsCutoverHostClient {
  inspectionResult: unknown = {
    authorityInventoryRevision: authorityRevision,
    evidence: previousEvidence()
  }
  inspectionError: unknown = null
  candidateResult: unknown | null = null
  candidateError: unknown = null
  fixedResult: unknown | null = null
  fixedError: unknown = null
  afterFixed: (() => void) | null = null
  readonly inspectionCalls: WindowsCutoverInspectionRequest[] = []
  readonly candidateCalls: WindowsCutoverCandidateTaskRequest[] = []
  readonly fixedCalls: Array<{ method: string; request: WindowsCutoverFixedMutationRequest }> = []
  readonly previousStopOptions: Array<Readonly<{ reconcileOnly: true }> | undefined> = []

  async inspect(request: Readonly<WindowsCutoverInspectionRequest>): Promise<unknown> {
    this.inspectionCalls.push({ ...request })
    if (this.inspectionError !== null) throw this.inspectionError
    return structuredClone(this.inspectionResult)
  }

  async runCandidateTaskTransaction(request: Readonly<WindowsCutoverCandidateTaskRequest>): Promise<unknown> {
    this.candidateCalls.push({
      ...request,
      authorityMutation: { ...request.authorityMutation }
    })
    if (this.candidateError !== null) throw this.candidateError
    return structuredClone(this.candidateResult ?? candidateReceipt(request))
  }

  disablePreviousAuthority(request: Readonly<WindowsCutoverFixedMutationRequest>): Promise<unknown> {
    return this.fixed('disablePreviousAuthority', request)
  }

  stopPreviousRuntime(
    request: Readonly<WindowsCutoverFixedMutationRequest>,
    options?: Readonly<{ reconcileOnly: true }>
  ): Promise<unknown> {
    this.previousStopOptions.push(options)
    return this.fixed('stopPreviousRuntime', request)
  }

  enablePreviousAuthority(request: Readonly<WindowsCutoverFixedMutationRequest>): Promise<unknown> {
    return this.fixed('enablePreviousAuthority', request)
  }

  startPreviousRuntime(request: Readonly<WindowsCutoverFixedMutationRequest>): Promise<unknown> {
    return this.fixed('startPreviousRuntime', request)
  }

  startCandidateRuntime(request: Readonly<WindowsCutoverFixedMutationRequest>): Promise<unknown> {
    return this.fixed('startCandidateRuntime', request)
  }

  stopCandidateRuntime(request: Readonly<WindowsCutoverFixedMutationRequest>): Promise<unknown> {
    return this.fixed('stopCandidateRuntime', request)
  }

  private async fixed(method: string, request: Readonly<WindowsCutoverFixedMutationRequest>): Promise<unknown> {
    this.fixedCalls.push({ method, request: { ...request } })
    this.afterFixed?.()
    if (this.fixedError !== null) throw this.fixedError
    return structuredClone(this.fixedResult ?? { requestId: request.requestId, status: 'succeeded' })
  }
}

class RecordingSaveFacade implements WindowsCutoverSaveTransactionFacade {
  readonly inspectCalls: string[] = []
  readonly backupCalls: Array<{ requestId: string; saveName: string; dryRun?: boolean }> = []
  readonly restoreCalls: Array<{
    request: { requestId: string; backupId: string; expectedRevision: string; protectionRequestId: string; dryRun?: boolean }
    scope: SaveRestoreScope | undefined
  }> = []
  backupPatch: Record<string, unknown> = {}
  restorePatch: Record<string, unknown> = {}
  inspectError: unknown = null
  backupError: unknown = null
  restoreError: unknown = null

  async inspect(saveName: string): Promise<unknown> {
    this.inspectCalls.push(saveName)
    if (this.inspectError !== null) throw this.inspectError
    return {
      schemaVersion: 1,
      saveName,
      revision: pairRevision,
      dsvBytes: 100,
      serverBytes: 20,
      totalBytes: 120
    }
  }

  async backup(request: { requestId: string; saveName: string; dryRun?: boolean }): Promise<unknown> {
    this.backupCalls.push({ ...request })
    if (this.backupError !== null) throw this.backupError
    return makeSaveResult({
      requestId: request.requestId,
      operation: 'backup',
      backupId: `tx-${request.requestId}`,
      beforeRevision: pairRevision,
      afterRevision: pairRevision,
      patch: this.backupPatch
    })
  }

  async restore(
    request: { requestId: string; backupId: string; expectedRevision: string; protectionRequestId: string; dryRun?: boolean },
    scope?: SaveRestoreScope
  ): Promise<unknown> {
    this.restoreCalls.push({ request: { ...request }, scope })
    if (this.restoreError !== null) throw this.restoreError
    return makeSaveResult({
      requestId: request.requestId,
      operation: 'restore',
      backupId: request.backupId,
      protectionBackupId: `tx-${request.protectionRequestId}`,
      beforeRevision: request.expectedRevision,
      afterRevision: restoredRevision,
      patch: this.restorePatch
    })
  }
}

function candidateReceipt(input: {
  outerRequestId: string
  authorityMutation: CutoverAuthorityMutationInvocation
  patch?: Record<string, unknown>
}): Record<string, unknown> {
  return {
    outerRequestId: input.outerRequestId,
    childRequestId: input.authorityMutation.childRequestId,
    attempt: input.authorityMutation.attempt,
    mode: input.authorityMutation.mode,
    recovery: input.authorityMutation.recovery,
    status: 'succeeded',
    receiptDigest,
    ...input.patch
  }
}

type SaveRestoreScope = Pick<HostMutationOperationScope, 'signal' | 'assertActive'>

function makeSaveResult(input: {
  requestId: string
  operation: 'backup' | 'restore'
  backupId: string
  protectionBackupId?: string
  beforeRevision: string
  afterRevision: string
  patch?: Record<string, unknown>
}): Record<string, unknown> {
  const patch = input.patch ?? {}
  const status = String(patch.status ?? 'succeeded')
  const rollback = String(patch.rollback ?? 'not-required')
  const cleanupPending = Boolean(patch.cleanupPending ?? false)
  const maintenanceRequired = Boolean(patch.maintenanceRequired ?? false)
  const errorCode = typeof patch.errorCode === 'string' ? patch.errorCode : undefined
  const common = {
    schemaVersion: 1,
    requestId: input.requestId,
    operation: input.operation,
    status,
    dryRun: false,
    backupId: input.backupId,
    ...(input.protectionBackupId === undefined ? {} : { protectionBackupId: input.protectionBackupId }),
    reused: false,
    rollback,
    pairBytes: 120,
    cleanupPending,
    maintenanceRequired,
    beforeRevision: input.beforeRevision,
    afterRevision: input.afterRevision,
    ...(errorCode === undefined ? {} : { errorCode }),
    auditStored: patch.auditStored ?? true
  }
  const result = {
    ...common,
    audit: {
      schemaVersion: 1,
      requestId: input.requestId,
      action: input.operation === 'backup' ? 'save.backup' : 'save.restore',
      status,
      dryRun: false,
      backupId: input.backupId,
      ...(input.protectionBackupId === undefined ? {} : { protectionBackupId: input.protectionBackupId }),
      reused: false,
      rollback,
      cleanupPending,
      maintenanceRequired,
      startedAt: '2026-09-01T00:00:00.000Z',
      finishedAt: '2026-09-01T00:00:01.000Z',
      ...(errorCode === undefined ? {} : { errorCode })
    },
    ...patch
  }
  return result
}

function activeScope() {
  const controller = new AbortController()
  let lost = false
  let assertionCount = 0
  const scope: HostMutationOperationScope = {
    signal: controller.signal,
    assertActive: () => {
      assertionCount += 1
      if (lost) throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_LOST')
    },
    toPowerShellBorrowArguments: () => []
  }
  return {
    scope,
    lose: () => {
      lost = true
      controller.abort()
    },
    assertions: () => assertionCount
  }
}

async function invokeCandidate(
  adapter: WindowsCutoverAdapter,
  method: 'defineCandidateDisabled' | 'enableCandidateAuthority' | 'disableCandidateAuthority',
  request: CutoverAuthorityMutationRequest
) {
  if (method === 'defineCandidateDisabled') return await adapter.defineCandidateDisabled(request)
  if (method === 'enableCandidateAuthority') return await adapter.enableCandidateAuthority(request)
  return await adapter.disableCandidateAuthority(request)
}

function previousEvidence(): CutoverHostEvidence {
  return {
    previousDefined: true,
    previousEnabled: true,
    candidateDefined: true,
    candidateEnabled: false,
    unexpectedAuthorityPresent: false,
    processState: 'previous-only',
    portState: 'previous',
    previousHealthy: true,
    candidateHealthy: false
  }
}

function id(suffix: number): string {
  return `00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`
}

async function captureError(promise: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string }
  }
  throw new Error('expected rejection')
}

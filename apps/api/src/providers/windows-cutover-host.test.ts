import { describe, expect, it } from 'vitest'
import { HostMutationLeaseError } from '../host-mutation/lease.js'
import type { HostMutationOperationScope } from '../host-mutation/operation-coordinator.js'
import {
  FixedWindowsCutoverHostClient,
  WindowsCutoverHostClientError,
  type WindowsCutoverHostClientOptions,
  type WindowsCutoverHostScriptName,
  type WindowsCutoverPowerShellRunner
} from './windows-cutover-host.js'

const revision = 'a'.repeat(64)
const pairDigest = 'b'.repeat(64)
const requestFingerprint = 'c'.repeat(64)
const dataRoot = 'C:\\Fictional\\DysonControl\\data'
const projectRoot = 'C:\\Fictional\\DysonProject'
const profileFile = `${dataRoot}\\authority-inventory\\authority-profile.json`
const brokerRoot = `${dataRoot}\\cutover-broker`
const brokerProfileFile = `${brokerRoot}\\broker-profile.json`
const cutoverScriptRoot = 'C:\\ProgramData\\DysonControl\\current\\scripts\\windows'
const bootstrapRoot = 'C:\\ProgramData\\DysonControl\\game-bootstrap'
const transactionRoot = 'C:\\ProgramData\\DysonControl\\runtime-task-transactions'
const serviceUser = '.\\DysonServer'

describe('fixed Windows cutover host client', () => {
  it('calls only the fixed evidence script with construction-time bindings', async () => {
    const harness = createHarness()
    const controller = new AbortController()

    const result = await harness.client.inspect({ requestId: id(1), signal: controller.signal })

    expect(result).toEqual({ authorityInventoryRevision: revision, evidence: previousEvidence() })
    expect(harness.runner.calls).toEqual([{
      scriptName: 'Get-DysonCutoverEvidence.ps1',
      arguments_: commonArguments(id(1)),
      signal: controller.signal
    }])
  })

  it.each([
    ['disablePreviousAuthority', 'DisablePreviousAuthority'],
    ['stopPreviousRuntime', 'StopPreviousRuntime'],
    ['enablePreviousAuthority', 'EnablePreviousAuthority'],
    ['startPreviousRuntime', 'StartPreviousRuntime'],
    ['startCandidateRuntime', 'StartCandidateRuntime'],
    ['stopCandidateRuntime', 'StopCandidateRuntime']
  ] as const)('maps %s internally to the single fixed broker capability %s', async (method, action) => {
    const harness = createHarness()
    const active = activeScope()

    const result = await harness.client[method]({ requestId: id(2), hostMutation: active.scope })

    expect(result).toEqual({ requestId: id(2), status: 'succeeded' })
    const call = harness.runner.calls[0]!
    const brokerRequestId = argument(call.arguments_, '-BrokerRequestId')
    expect(brokerRequestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    )
    expect(harness.runner.calls).toEqual([{
      scriptName: 'Submit-DysonCutoverBrokerRequest.ps1',
      arguments_: brokerArguments(brokerRequestId, action, id(2), active.borrowArguments),
      signal: active.scope.signal
    }])
    expect(active.assertions()).toBeGreaterThanOrEqual(3)
  })

  it('derives a stable broker id for an exact replay and a different id for another capability', async () => {
    const first = createHarness()
    const second = createHarness()
    await first.client.disablePreviousAuthority({ requestId: id(33), hostMutation: activeScope().scope })
    await second.client.disablePreviousAuthority({ requestId: id(33), hostMutation: activeScope().scope })
    await second.client.stopPreviousRuntime({ requestId: id(33), hostMutation: activeScope().scope })

    const firstId = argument(first.runner.calls[0]!.arguments_, '-BrokerRequestId')
    const replayId = argument(second.runner.calls[0]!.arguments_, '-BrokerRequestId')
    const otherCapabilityId = argument(second.runner.calls[1]!.arguments_, '-BrokerRequestId')
    expect(replayId).toBe(firstId)
    expect(otherCapabilityId).not.toBe(firstId)
  })

  it('has no externally selectable action, script, task, path, or port field', async () => {
    const harness = createHarness()
    const active = activeScope()
    const malicious = {
      requestId: id(3),
      hostMutation: active.scope,
      action: 'StartCandidateRuntime',
      scriptName: 'Arbitrary.ps1',
      taskName: 'OtherTask',
      projectRoot: 'C:\\Other',
      gamePort: 1
    }

    const error = await captureError(harness.client.disablePreviousAuthority(malicious))

    expect(error).toMatchObject({
      code: 'WINDOWS_CUTOVER_HOST_REQUEST_INVALID',
      message: 'WINDOWS_CUTOVER_HOST_REQUEST_INVALID'
    })
    expect(harness.runner.calls).toEqual([])
  })

  it('submits the child transaction through the fixed privileged broker contract', async () => {
    const harness = createHarness()
    const active = activeScope()

    const result = await harness.client.runCandidateTaskTransaction({
      outerRequestId: id(4),
      authorityMutation: {
        childRequestId: id(5),
        attempt: 3,
        mode: 'Activate',
        recovery: false
      },
      hostMutation: active.scope
    })

    expect(result).toEqual({
      outerRequestId: id(4),
      childRequestId: id(5),
      attempt: 3,
      mode: 'Activate',
      recovery: false,
      status: 'succeeded',
      receiptDigest: pairDigest
    })
    const brokerRequestId = argument(
      harness.runner.calls[0]!.arguments_, '-BrokerRequestId'
    )
    expect(harness.runner.calls).toEqual([{
      scriptName: 'Submit-DysonCutoverBrokerRequest.ps1',
      arguments_: [
        ...brokerArguments(
          brokerRequestId, 'CandidateTaskTransaction', id(5), active.borrowArguments
        ),
        '-CandidateMode', 'Activate'
      ],
      signal: active.scope.signal
    }])
    const arguments_ = harness.runner.calls[0]!.arguments_
    expect(arguments_).not.toContain('-OuterRequestId')
    expect(arguments_).not.toContain('-Attempt')
    expect(arguments_).not.toContain('-Confirm:$false')
  })

  it('submits explicit recovery with only the fixed broker recovery switch added', async () => {
    const harness = createHarness()
    harness.runner.candidateStatus = 'rolled-back'
    harness.runner.candidateReused = true
    const active = activeScope()

    const result = await harness.client.runCandidateTaskTransaction({
      outerRequestId: id(6),
      authorityMutation: {
        childRequestId: id(7),
        attempt: 2,
        mode: 'PrepareDisabled',
        recovery: true
      },
      hostMutation: active.scope
    })

    expect(result).toMatchObject({
      outerRequestId: id(6), childRequestId: id(7), attempt: 2,
      mode: 'PrepareDisabled', recovery: true, status: 'rolled-back', receiptDigest: pairDigest
    })
    const brokerRequestId = argument(
      harness.runner.calls[0]!.arguments_, '-BrokerRequestId'
    )
    expect(harness.runner.calls[0]!.arguments_).toEqual([
      ...brokerArguments(
        brokerRequestId, 'CandidateTaskTransaction', id(7), active.borrowArguments
      ),
      '-CandidateMode', 'PrepareDisabled',
      '-CandidateRecover'
    ])
  })

  it('retrieves a durable rolled-back receipt with one exact ordinary replay', async () => {
    const harness = createHarness()
    harness.runner.failure = new Error('first process exits after a clean rollback')
    harness.runner.failuresRemaining = 1
    harness.runner.candidateStatus = 'rolled-back'
    harness.runner.candidateReused = true
    const active = activeScope()

    const result = await harness.client.runCandidateTaskTransaction({
      outerRequestId: id(21),
      authorityMutation: {
        childRequestId: id(22), attempt: 4, mode: 'PrepareDisabled', recovery: false
      },
      hostMutation: active.scope
    })

    expect(result).toMatchObject({
      outerRequestId: id(21), childRequestId: id(22), attempt: 4,
      mode: 'PrepareDisabled', recovery: false, status: 'rolled-back', receiptDigest: pairDigest
    })
    expect(harness.runner.calls).toHaveLength(2)
    expect(harness.runner.calls[0]!.arguments_).toEqual(harness.runner.calls[1]!.arguments_)
    expect(harness.runner.calls[0]!.arguments_).not.toContain('-CandidateRecover')
    expect(harness.runner.calls[0]!.signal).toBe(active.scope.signal)
    expect(harness.runner.calls[1]!.signal).toBe(active.scope.signal)
  })

  it('replays an ordinary failure at most once and leaves a pending intent for explicit recovery', async () => {
    const harness = createHarness()
    harness.runner.failure = new Error('fictional pending intent')
    harness.runner.failuresRemaining = 2
    const active = activeScope()

    const error = await captureError(harness.client.runCandidateTaskTransaction({
      outerRequestId: id(23),
      authorityMutation: {
        childRequestId: id(24), attempt: 1, mode: 'Activate', recovery: false
      },
      hostMutation: active.scope
    }))

    expect(error).toMatchObject({
      code: 'WINDOWS_CUTOVER_HOST_CANDIDATE_TRANSACTION_FAILED',
      message: 'WINDOWS_CUTOVER_HOST_CANDIDATE_TRANSACTION_FAILED'
    })
    expect(harness.runner.calls).toHaveLength(2)
    expect(harness.runner.calls[0]!.arguments_).toEqual(harness.runner.calls[1]!.arguments_)
  })

  it('does not replay after the borrowed host-mutation lease becomes inactive', async () => {
    const harness = createHarness()
    const active = activeScope()
    harness.runner.failure = new Error('fictional child exit')
    harness.runner.failuresRemaining = 1
    harness.runner.afterFailure = active.lose

    const error = await captureError(harness.client.runCandidateTaskTransaction({
      outerRequestId: id(25),
      authorityMutation: {
        childRequestId: id(26), attempt: 1, mode: 'Activate', recovery: false
      },
      hostMutation: active.scope
    }))

    expect(error).toBeInstanceOf(HostMutationLeaseError)
    expect(error).toMatchObject({ code: 'DYSON_HOST_MUTATION_LEASE_LOST' })
    expect(harness.runner.calls).toHaveLength(1)
  })

  it('never implicitly replays an explicit recovery failure', async () => {
    const harness = createHarness()
    harness.runner.failure = new Error('fictional recovery failure')
    harness.runner.failuresRemaining = 1
    const active = activeScope()

    await expect(harness.client.runCandidateTaskTransaction({
      outerRequestId: id(27),
      authorityMutation: {
        childRequestId: id(28), attempt: 2, mode: 'PrepareDisabled', recovery: true
      },
      hostMutation: active.scope
    })).rejects.toMatchObject({ code: 'WINDOWS_CUTOVER_HOST_CANDIDATE_TRANSACTION_FAILED' })
    expect(harness.runner.calls).toHaveLength(1)
    expect(harness.runner.calls[0]!.arguments_).toContain('-CandidateRecover')
  })

  it.each([
    { field: 'protocol', value: 'OTHER' },
    { field: 'schemaVersion', value: 3 },
    { field: 'requestId', value: id(9) },
    { field: 'mode', value: 'PrepareDisabled' },
    { field: 'serverTask', value: 'Other' },
    { field: 'terminalPairDigest', value: 'not-a-digest' },
    { field: 'extra', value: 'C:\\Fictional\\task.xml' }
  ])('rejects a candidate receipt that differs from the exact V2 contract: $field', async ({ field, value }) => {
    const harness = createHarness()
    harness.runner.mutateCandidateReceipt = (receipt) => ({ ...receipt, [field]: value })
    const active = activeScope()

    const error = await captureError(harness.client.runCandidateTaskTransaction({
      outerRequestId: id(8),
      authorityMutation: {
        childRequestId: id(10), attempt: 1, mode: 'Activate', recovery: false
      },
      hostMutation: active.scope
    }))

    expect(error).toMatchObject({
      code: 'WINDOWS_CUTOVER_HOST_CANDIDATE_TRANSACTION_FAILED',
      message: 'WINDOWS_CUTOVER_HOST_CANDIDATE_TRANSACTION_FAILED'
    })
    expect(JSON.stringify(error)).not.toContain('Fictional')
  })

  it.each([
    { field: 'protocol', value: 'OTHER' },
    { field: 'schemaVersion', value: 2 },
    { field: 'brokerRequestId', value: id(30) },
    { field: 'capability', value: 'StopCandidateRuntime' },
    { field: 'requestId', value: id(31) },
    { field: 'authorityInventoryRevision', value: 'd'.repeat(64) },
    { field: 'reused', value: 'false' },
    { field: 'extra', value: 'C:\\Fictional\\broker-private' }
  ])('rejects a broker result that is not exactly bound: $field', async ({ field, value }) => {
    const harness = createHarness()
    harness.runner.mutateBrokerResult = (receipt) => ({ ...receipt, [field]: value })
    const active = activeScope()

    const error = await captureError(harness.client.startCandidateRuntime({
      requestId: id(32), hostMutation: active.scope
    }))

    expect(error).toMatchObject({
      code: 'WINDOWS_CUTOVER_HOST_MUTATION_FAILED',
      message: 'WINDOWS_CUTOVER_HOST_MUTATION_FAILED'
    })
    expect(JSON.stringify(error)).not.toContain('broker-private')
  })

  it('rejects forged or augmented borrowed lease arguments before calling PowerShell', async () => {
    const harness = createHarness()
    const active = activeScope({
      borrowArguments: [
        '-DataRoot', dataRoot,
        '-LeaseInstanceId', id(11),
        '-LeaseToken', token(),
        '-Action', 'Arbitrary'
      ]
    })

    const error = await captureError(harness.client.stopCandidateRuntime({
      requestId: id(12), hostMutation: active.scope
    }))

    expect(error).toBeInstanceOf(WindowsCutoverHostClientError)
    expect(error).toMatchObject({ code: 'WINDOWS_CUTOVER_HOST_MUTATION_FAILED' })
    expect(harness.runner.calls).toEqual([])
  })

  it('rejects a borrowed lease for another data root before calling PowerShell', async () => {
    const harness = createHarness()
    const active = activeScope({ dataRoot: 'C:\\Fictional\\OtherData' })

    await expect(harness.client.runCandidateTaskTransaction({
      outerRequestId: id(13),
      authorityMutation: {
        childRequestId: id(14), attempt: 1, mode: 'PrepareDisabled', recovery: false
      },
      hostMutation: active.scope
    })).rejects.toMatchObject({ code: 'WINDOWS_CUTOVER_HOST_CANDIDATE_TRANSACTION_FAILED' })
    expect(harness.runner.calls).toEqual([])
  })

  it('strictly binds inspection and action receipts to request and inventory revision', async () => {
    const inspection = createHarness()
    inspection.runner.inspectionRevision = 'd'.repeat(64)
    await expect(inspection.client.inspect({
      requestId: id(15), signal: new AbortController().signal
    })).rejects.toMatchObject({ code: 'WINDOWS_CUTOVER_HOST_AUTHORITY_REVISION_MISMATCH' })

    const action = createHarness()
    action.runner.actionRequestId = id(16)
    const active = activeScope()
    await expect(action.client.startCandidateRuntime({
      requestId: id(17), hostMutation: active.scope
    })).rejects.toMatchObject({ code: 'WINDOWS_CUTOVER_HOST_MUTATION_FAILED' })
  })

  it('normalizes runner failures and malformed JSON without leaking raw output', async () => {
    const harness = createHarness()
    harness.runner.failure = new Error('C:\\Fictional\\private\\task.xml --token secret')

    const error = await captureError(harness.client.inspect({
      requestId: id(18), signal: new AbortController().signal
    }))

    expect(error).toMatchObject({
      code: 'WINDOWS_CUTOVER_HOST_INSPECTION_FAILED',
      message: 'WINDOWS_CUTOVER_HOST_INSPECTION_FAILED'
    })
    expect(error).not.toHaveProperty('cause')
    expect(JSON.stringify(error)).not.toContain('Fictional')

    harness.runner.failure = null
    harness.runner.rawOutput = '{"path":"C:\\\\Fictional\\\\private"}'
    const malformed = await captureError(harness.client.inspect({
      requestId: id(19), signal: new AbortController().signal
    }))
    expect(malformed).toMatchObject({ code: 'WINDOWS_CUTOVER_HOST_INSPECTION_FAILED' })
    expect(JSON.stringify(malformed)).not.toContain('Fictional')
  })

  it('normalizes an aborted inspection signal without calling the runner or exposing its reason', async () => {
    const harness = createHarness()
    const controller = new AbortController()
    controller.abort(new Error('C:\\Fictional\\private\\abort-reason'))

    const error = await captureError(harness.client.inspect({
      requestId: id(29), signal: controller.signal
    }))

    expect(error).toMatchObject({
      code: 'WINDOWS_CUTOVER_HOST_INSPECTION_FAILED',
      message: 'WINDOWS_CUTOVER_HOST_INSPECTION_FAILED'
    })
    expect(JSON.stringify(error)).not.toContain('Fictional')
    expect(harness.runner.calls).toEqual([])
  })

  it('preserves host lease loss and passes the identical lease signal to the runner', async () => {
    const harness = createHarness()
    const active = activeScope()
    harness.runner.afterRun = active.lose

    const error = await captureError(harness.client.enablePreviousAuthority({
      requestId: id(20), hostMutation: active.scope
    }))

    expect(error).toBeInstanceOf(HostMutationLeaseError)
    expect(error).toMatchObject({ code: 'DYSON_HOST_MUTATION_LEASE_LOST' })
    expect(harness.runner.calls[0]!.signal).toBe(active.scope.signal)
  })

  it.each([
    { profileFile: 'C:\\Fictional\\authority-profile.json' },
    { profileFile: `${dataRoot}\\other\\authority-profile.json` },
    { projectRoot: 'relative-project' },
    { cutoverScriptRoot: 'relative-scripts' },
    { cutoverScriptRoot: 'C:\\' },
    { serviceUser: 'bad\nuser' },
    { gamePort: 0 },
    { authorityInventoryRevision: 'nope' },
    { extra: 'not-allowed' }
  ])('fails closed on invalid construction bindings %#', (patch) => {
    expect(() => new FixedWindowsCutoverHostClient({
      ...baseOptions(new MockRunner()),
      ...patch
    } as WindowsCutoverHostClientOptions)).toThrowError(expect.objectContaining({
      code: 'WINDOWS_CUTOVER_HOST_OPTIONS_INVALID',
      message: 'WINDOWS_CUTOVER_HOST_OPTIONS_INVALID'
    }))
  })
})

class MockRunner implements WindowsCutoverPowerShellRunner {
  readonly calls: Array<{
    scriptName: WindowsCutoverHostScriptName
    arguments_: string[]
    signal: AbortSignal
  }> = []
  failure: Error | null = null
  failuresRemaining: number | null = null
  rawOutput: string | null = null
  afterRun: (() => void) | null = null
  afterFailure: (() => void) | null = null
  inspectionRevision = revision
  actionRequestId: string | null = null
  brokerRequestId: string | null = null
  brokerCapability: string | null = null
  brokerRequestIdBinding: string | null = null
  brokerRevision = revision
  candidateStatus: 'succeeded' | 'rolled-back' = 'succeeded'
  candidateReused = false
  mutateCandidateReceipt: ((receipt: Record<string, unknown>) => Record<string, unknown>) | null = null
  mutateBrokerResult: ((receipt: Record<string, unknown>) => Record<string, unknown>) | null = null

  async run(
    scriptName: WindowsCutoverHostScriptName,
    arguments_: string[],
    signal: AbortSignal
  ): Promise<string> {
    this.calls.push({ scriptName, arguments_: [...arguments_], signal })
    if (this.failure !== null && (this.failuresRemaining === null || this.failuresRemaining > 0)) {
      if (this.failuresRemaining !== null) this.failuresRemaining -= 1
      this.afterFailure?.()
      throw this.failure
    }
    if (this.rawOutput !== null) return this.rawOutput
    const requestId = argument(arguments_, '-RequestId')
    let result: Record<string, unknown>
    if (scriptName === 'Get-DysonCutoverEvidence.ps1') {
      result = {
        protocol: 'DYSON_CONTROL_CUTOVER_EVIDENCE_V1',
        schemaVersion: 1,
        requestId,
        authorityInventoryRevision: this.inspectionRevision,
        evidence: previousEvidence()
      }
    } else {
      const brokerRequestId = argument(arguments_, '-BrokerRequestId')
      const capability = argument(arguments_, '-Capability')
      let childReceipt: Record<string, unknown>
      if (capability === 'CandidateTaskTransaction') {
        childReceipt = {
          protocol: 'DYSON_CONTROL_RUNTIME_TASK_RECEIPT_V2',
          schemaVersion: 2,
          requestId,
          requestFingerprint,
          status: this.candidateStatus,
          mode: argument(arguments_, '-CandidateMode'),
          serverTask: 'Dyson-Nebula-Server',
          stopTask: 'Dyson-Nebula-Stop',
          terminalPairDigest: pairDigest,
          completedAt: '2026-09-01T00:00:00.0000000Z',
          reused: this.candidateReused
        }
        if (this.mutateCandidateReceipt !== null) {
          childReceipt = this.mutateCandidateReceipt(childReceipt)
        }
      } else {
        childReceipt = {
          protocol: 'DYSON_CONTROL_CUTOVER_ACTION_RECEIPT_V1',
          schemaVersion: 1,
          requestId: this.actionRequestId ?? requestId,
          authorityInventoryRevision: revision,
          action: capability,
          status: 'succeeded'
        }
      }
      result = {
        protocol: 'DYSON_CONTROL_CUTOVER_BROKER_RESULT_V1',
        schemaVersion: 1,
        brokerRequestId: this.brokerRequestId ?? brokerRequestId,
        capability: this.brokerCapability ?? capability,
        requestId: this.brokerRequestIdBinding ?? requestId,
        authorityInventoryRevision: this.brokerRevision,
        reused: false,
        childReceipt
      }
      if (this.mutateBrokerResult !== null) result = this.mutateBrokerResult(result)
    }
    this.afterRun?.()
    return JSON.stringify(result)
  }
}

function createHarness(): {
  runner: MockRunner
  client: FixedWindowsCutoverHostClient
} {
  const runner = new MockRunner()
  return { runner, client: new FixedWindowsCutoverHostClient(baseOptions(runner)) }
}

function baseOptions(runner: WindowsCutoverPowerShellRunner): WindowsCutoverHostClientOptions {
  return {
    projectRoot,
    profileFile,
    cutoverScriptRoot,
    runtimeBootstrapRoot: bootstrapRoot,
    runtimeTaskTransactionRoot: transactionRoot,
    serviceUser,
    gamePort: 8469,
    authorityInventoryRevision: revision,
    runner
  }
}

function brokerArguments(
  brokerRequestId: string,
  capability: string,
  requestId: string,
  borrowArguments: readonly string[]
): string[] {
  return [
    '-BrokerRoot', brokerRoot,
    '-BrokerProfileFile', brokerProfileFile,
    '-BrokerRequestId', brokerRequestId,
    '-Capability', capability,
    '-RequestId', requestId,
    '-AuthorityInventoryRevision', revision,
    '-ProjectRoot', projectRoot,
    '-DataRoot', dataRoot,
    '-AuthorityProfileFile', profileFile,
    '-CutoverScriptRoot', cutoverScriptRoot,
    '-RuntimeBootstrapRoot', bootstrapRoot,
    '-RuntimeTaskTransactionRoot', transactionRoot,
    '-ServiceUser', serviceUser,
    '-GamePort', '8469',
    '-LeaseInstanceId', borrowArguments[3]!,
    '-LeaseToken', borrowArguments[5]!
  ]
}

function commonArguments(requestId: string): string[] {
  return [
    '-ProjectRoot', projectRoot,
    '-ProfileFile', profileFile,
    '-RuntimeBootstrapRoot', bootstrapRoot,
    '-RuntimeTaskTransactionRoot', transactionRoot,
    '-ServiceUser', serviceUser,
    '-GamePort', '8469',
    '-AuthorityInventoryRevision', revision,
    '-RequestId', requestId
  ]
}

function previousEvidence(): Record<string, unknown> {
  return {
    previousDefined: true,
    previousEnabled: true,
    candidateDefined: false,
    candidateEnabled: false,
    unexpectedAuthorityPresent: false,
    processState: 'previous-only',
    portState: 'previous',
    previousHealthy: true,
    candidateHealthy: false
  }
}

function activeScope(options: {
  dataRoot?: string
  borrowArguments?: readonly string[]
} = {}): {
    scope: HostMutationOperationScope
    borrowArguments: readonly string[]
    assertions(): number
    lose(): void
} {
  const controller = new AbortController()
  let active = true
  let assertions = 0
  const borrowArguments = options.borrowArguments ?? [
    '-DataRoot', options.dataRoot ?? dataRoot,
    '-LeaseInstanceId', id(90),
    '-LeaseToken', token()
  ]
  const assertActive = () => {
    assertions += 1
    if (!active) throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_LOST')
  }
  return {
    scope: {
      signal: controller.signal,
      assertActive,
      toPowerShellBorrowArguments: () => {
        assertActive()
        return borrowArguments
      }
    },
    borrowArguments,
    assertions: () => assertions,
    lose: () => {
      active = false
      controller.abort(new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_LOST'))
    }
  }
}

function argument(arguments_: readonly string[], name: string): string {
  const index = arguments_.indexOf(name)
  if (index < 0 || index + 1 >= arguments_.length) throw new Error(`missing ${name}`)
  return arguments_[index + 1]!
}

function id(number: number): string {
  return `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
}

function token(): string {
  return 'A'.repeat(43)
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
    throw new Error('expected rejection')
  } catch (error) {
    return error
  }
}

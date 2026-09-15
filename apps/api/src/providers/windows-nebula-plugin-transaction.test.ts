import { describe, expect, it } from 'vitest'
import {
  HostMutationOperationCoordinatorError,
  type HostMutationOperationCoordinator,
  type HostMutationOperationOutcome,
  type HostMutationOperationRequest,
  type HostMutationOperationScope,
  type HostMutationRecoveryOperationCoordinator,
  type HostMutationRecoveryOperationRequest
} from '../host-mutation/operation-coordinator.js'
import {
  WindowsNebulaPluginTransactionError,
  WindowsNebulaPluginTransactionService,
  nebulaPluginApplyConfirmationPhrase,
  windowsNebulaPluginApplyOperation,
  windowsNebulaPluginRollbackOperation,
  type WindowsNebulaPluginTransactionPowerShellRunner,
  type WindowsNebulaPluginTransactionScriptName
} from './windows-nebula-plugin-transaction.js'

const jobBase = 'C:\\Fictional\\NebulaPrivateJobs'
const gameRoot = 'D:\\FictionalGames\\Dyson Sphere Program'
const dataRoot = 'D:\\FictionalData\\DysonControl'
const planDigest = 'a'.repeat(64)
const previewDigest = 'b'.repeat(64)
const receiptDigest = 'c'.repeat(64)
const currentTree = 'd'.repeat(64)
const originalReceipt = 'e'.repeat(64)
const leaseInstanceId = id(900)
const leaseToken = 'fictional-nebula-lease-token'.padEnd(43, 'x')
const windowStart = '2030-01-01T01:00:00.0000000Z'
const windowEnd = '2030-01-01T02:00:00.0000000Z'

describe('Windows Nebula whole-tree transaction service', () => {
  it('keeps plan and apply preview read-only and uses only derived fixed paths', async () => {
    const harness = createHarness()
    const signal = new AbortController().signal

    const plan = await harness.service.plan({
      requestId: id(1),
      currentPluginsTreeSha256: currentTree,
      maintenanceWindowStartUtc: windowStart,
      maintenanceWindowEndUtc: windowEnd,
      signal
    })
    const preview = await harness.service.previewApply({ requestId: id(1), signal })

    expect(plan).toEqual({
      requestId: id(1), targetRole: 'Server', mode: 'dry-run', executionEnabled: false,
      planDigest, productionChanged: false
    })
    expect(preview).toEqual({
      requestId: id(1), targetRole: 'Server', status: 'preview', mode: 'dry-run',
      planDigest, confirmationRequired: true, productionChanged: false
    })
    expect(harness.coordinator.ordinaryRequests).toEqual([])
    expect(harness.coordinator.recoveryRequests).toEqual([])
    expect(harness.runner.calls).toEqual([
      {
        scriptName: 'New-NebulaPluginCutoverPlan.ps1',
        arguments_: [
          '-RequestId', id(1), '-JobBase', jobBase, '-GameRoot', gameRoot,
          '-TargetRole', 'Server', '-CurrentPluginsTreeSha256', currentTree,
          '-CandidateManifestPath', candidateManifestPath(id(1)),
          '-MaintenanceWindowStartUtc', windowStart,
          '-MaintenanceWindowEndUtc', windowEnd, '-Backend', 'Windows'
        ],
        signal
      },
      {
        scriptName: 'Invoke-NebulaPluginCutover.ps1',
        arguments_: applyBaseArguments(id(1)),
        signal
      }
    ])
    expect(harness.runner.calls.flatMap((call) => call.arguments_)).not.toContain('-Apply')
    expect(harness.runner.calls.flatMap((call) => call.arguments_)).not.toContain('-Recover')
    expect(harness.runner.calls.flatMap((call) => call.arguments_))
      .not.toContain('-HostMutationLeaseToken')
  })

  it('binds ordinary apply to the fixed operation and exact request UUID', async () => {
    const harness = createHarness()
    const request = applyRequest(id(2))

    const result = await harness.service.apply(request)

    expect(harness.coordinator.ordinaryRequests).toEqual([{
      operation: windowsNebulaPluginApplyOperation,
      requestId: id(2)
    }])
    expect(harness.coordinator.recoveryRequests).toEqual([])
    expect(harness.coordinator.outcomes).toMatchObject([{ kind: 'return', disposition: 'release' }])
    expect(harness.runner.calls).toEqual([{
      scriptName: 'Invoke-NebulaPluginCutover.ps1',
      arguments_: [
        ...applyBaseArguments(id(2)),
        '-Apply', '-ConfirmationPhrase', request.confirmationPhrase,
        ...hostBorrowArguments(), '-Confirm:$false'
      ],
      signal: harness.scope.signal
    }])
    expect(result).toEqual({
      requestId: id(2), status: 'applied', receiptDigest, reused: false,
      quarantineRetained: true, candidateStageRetained: false
    })
    const publicText = JSON.stringify(result)
    expect(publicText).not.toContain(jobBase)
    expect(publicText).not.toContain(gameRoot)
    expect(publicText).not.toContain(dataRoot)
    expect(publicText).not.toContain(leaseToken)
    expect(publicText).not.toContain('candidate-manifest.json')
  })

  it('uses only runRecoveryExclusive for apply recovery and preserves the original binding', async () => {
    const harness = createHarness()
    const request = applyRequest(id(3))

    const result = await harness.service.recoverApply(request)

    expect(harness.coordinator.ordinaryRequests).toEqual([])
    expect(harness.coordinator.recoveryRequests).toEqual([{
      expectedOperation: windowsNebulaPluginApplyOperation,
      expectedRequestId: id(3)
    }])
    expect(harness.runner.calls[0]!.arguments_).toEqual([
      ...applyBaseArguments(id(3)),
      '-Apply', '-ConfirmationPhrase', request.confirmationPhrase,
      '-Recover', ...hostBorrowArguments(), '-Confirm:$false'
    ])
    expect(result).toEqual({
      requestId: id(3), status: 'rolled-back-recovery', receiptDigest, reused: false,
      quarantineRetained: false, candidateStageRetained: true
    })
  })

  it('previews rollback without a lease and validates the exact digest-bound phrase', async () => {
    const harness = createHarness()
    const signal = new AbortController().signal
    const request = rollbackReadRequest(id(4), id(5), signal)

    const result = await harness.service.previewRollback(request)

    expect(result).toEqual({
      originalRequestId: id(4), rollbackRequestId: id(5), status: 'preview', mode: 'dry-run',
      previewDigest,
      exactConfirmationPhrase: rollbackPhrase(id(5)),
      productionChanged: false
    })
    expect(harness.coordinator.ordinaryRequests).toEqual([])
    expect(harness.coordinator.recoveryRequests).toEqual([])
    expect(harness.runner.calls).toEqual([{
      scriptName: 'Restore-NebulaPluginCutover.ps1',
      arguments_: rollbackBaseArguments(id(4), id(5)),
      signal
    }])
    expect(harness.runner.calls[0]!.arguments_).not.toContain('-Apply')
  })

  it('binds ordinary rollback to the rollback UUID and fixed argv', async () => {
    const harness = createHarness()
    const request = rollbackMutationRequest(id(6), id(7))

    const result = await harness.service.rollback(request)

    expect(harness.coordinator.ordinaryRequests).toEqual([{
      operation: windowsNebulaPluginRollbackOperation,
      requestId: id(7)
    }])
    expect(harness.coordinator.recoveryRequests).toEqual([])
    expect(harness.runner.calls).toEqual([{
      scriptName: 'Restore-NebulaPluginCutover.ps1',
      arguments_: [
        ...rollbackBaseArguments(id(6), id(7)),
        '-Apply', '-ConfirmationPhrase', request.confirmationPhrase,
        ...hostBorrowArguments(), '-Confirm:$false'
      ],
      signal: harness.scope.signal
    }])
    expect(result).toEqual({
      originalRequestId: id(6), rollbackRequestId: id(7), status: 'rolled-back-manual',
      receiptDigest, reused: false, quarantineRetained: false, candidateStageRetained: true
    })
  })

  it('uses only runRecoveryExclusive for rollback recovery and binds the abandoned rollback', async () => {
    const harness = createHarness()
    const request = rollbackMutationRequest(id(8), id(9))

    const result = await harness.service.recoverRollback(request)

    expect(harness.coordinator.ordinaryRequests).toEqual([])
    expect(harness.coordinator.recoveryRequests).toEqual([{
      expectedOperation: windowsNebulaPluginRollbackOperation,
      expectedRequestId: id(9)
    }])
    expect(harness.runner.calls[0]!.arguments_).toEqual([
      ...rollbackBaseArguments(id(8), id(9)),
      '-Apply', '-ConfirmationPhrase', request.confirmationPhrase,
      '-Recover', ...hostBorrowArguments(), '-Confirm:$false'
    ])
    expect(result).toEqual({
      originalRequestId: id(8), rollbackRequestId: id(9),
      status: 'rollback-recovery-restored-candidate', receiptDigest, reused: false,
      quarantineRetained: true, candidateStageRetained: false
    })
  })

  it('translates only the exact six-element borrowed tuple to the final V3 parameter names', async () => {
    const harness = createHarness()
    await harness.service.apply(applyRequest(id(10)))

    const arguments_ = harness.runner.calls[0]!.arguments_
    expect(argument(arguments_, '-HostMutationDataRoot')).toBe(dataRoot)
    expect(argument(arguments_, '-HostMutationLeaseInstanceId')).toBe(leaseInstanceId)
    expect(argument(arguments_, '-HostMutationLeaseToken')).toBe(leaseToken)
    expect(arguments_).not.toContain('-DataRoot')
    expect(arguments_).not.toContain('-LeaseInstanceId')
    expect(arguments_).not.toContain('-LeaseToken')
  })

  it('returns a releaseable throw outcome when borrow binding is invalid before invocation', async () => {
    const harness = createHarness({
      borrowArguments: ['-DataRoot', 'D:\\Other', '-LeaseInstanceId', leaseInstanceId,
        '-LeaseToken', leaseToken]
    })

    const error = await captureError(harness.service.apply(applyRequest(id(11))))

    expect(error).toEqual(new WindowsNebulaPluginTransactionError(
      'WINDOWS_NEBULA_PLUGIN_TRANSACTION_BORROW_BINDING_INVALID'
    ))
    expect(harness.runner.calls).toEqual([])
    expect(harness.coordinator.outcomes).toMatchObject([{ kind: 'throw', disposition: 'release' }])
  })

  it('abandons on a wrong output kind or path-bearing schema extension', async () => {
    const privatePath = `${jobBase}\\${id(12)}\\candidate\\private.dll`
    const harness = createHarness({
      responder: (scriptName, arguments_) => {
        if (scriptName === 'Invoke-NebulaPluginCutover.ps1' && arguments_.includes('-Apply')) {
          return JSON.stringify({
            protocol: 'DYSON_NEBULA_PLUGIN_TRANSACTION_RECEIPT_V3',
            status: 'applied', requestId: id(12), targetRole: 'Server', receiptDigest,
            quarantineRetained: true, reused: false, candidatePath: privatePath
          })
        }
        return defaultOutput(scriptName, arguments_)
      }
    })

    const error = await captureError(harness.service.apply(applyRequest(id(12))))

    expect(error).toEqual(new WindowsNebulaPluginTransactionError(
      'WINDOWS_NEBULA_PLUGIN_TRANSACTION_RESULT_INVALID'
    ))
    expect(error.message).not.toContain(privatePath)
    expect(JSON.stringify(error)).not.toContain(privatePath)
    expect(harness.coordinator.outcomes).toMatchObject([{ kind: 'throw', disposition: 'abandon' }])
  })

  it('fails closed when the mutation scope is lost after the script returns', async () => {
    const harness = createHarness({ loseOnAssertion: 3 })

    const error = await captureError(harness.service.apply(applyRequest(id(13))))

    expect(error).toEqual(new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_LOST'))
    expect(harness.runner.calls).toHaveLength(1)
    expect(harness.coordinator.callbackFailures).toEqual(['HOST_MUTATION_LEASE_LOST'])
  })

  it('treats nonzero script exit as ambiguous, abandons, and strips stderr/path details', async () => {
    const harness = createHarness({
      failure: Object.assign(new Error(`${gameRoot} failed with exit 19`), {
        code: 'HOST_SCRIPT_FAILED', exitCode: 19
      })
    })

    const error = await captureError(harness.service.apply(applyRequest(id(14))))

    expect(error).toEqual(new WindowsNebulaPluginTransactionError(
      'WINDOWS_NEBULA_PLUGIN_TRANSACTION_SCRIPT_FAILED'
    ))
    expect(error.message).not.toContain(gameRoot)
    expect(error).not.toHaveProperty('exitCode')
    expect(harness.coordinator.outcomes).toMatchObject([{ kind: 'throw', disposition: 'abandon' }])
  })

  it.each([
    ['HOST_SCRIPT_TIMEOUT', 'WINDOWS_NEBULA_PLUGIN_TRANSACTION_TIMEOUT'],
    ['HOST_SCRIPT_ABORTED', 'WINDOWS_NEBULA_PLUGIN_TRANSACTION_CANCELLED']
  ] as const)('normalizes %s without exposing the runner error', async (runnerCode, expectedCode) => {
    const harness = createHarness({
      failure: Object.assign(new Error(`${jobBase} private runner failure`), { code: runnerCode })
    })

    const error = await captureError(harness.service.previewApply({
      requestId: id(15), signal: new AbortController().signal
    }))

    expect(error).toMatchObject({ code: expectedCode, message: expectedCode })
    expect(error.message).not.toContain(jobBase)
    expect(harness.coordinator.ordinaryRequests).toEqual([])
  })

  it.each([
    ['HOST_SCRIPT_TIMEOUT', 'WINDOWS_NEBULA_PLUGIN_TRANSACTION_TIMEOUT'],
    ['HOST_SCRIPT_ABORTED', 'WINDOWS_NEBULA_PLUGIN_TRANSACTION_CANCELLED']
  ] as const)('abandons a started mutation on %s', async (runnerCode, expectedCode) => {
    const harness = createHarness({
      failure: Object.assign(new Error('private mutation runner detail'), { code: runnerCode })
    })

    const error = await captureError(harness.service.apply(applyRequest(id(151))))

    expect(error).toMatchObject({ code: expectedCode, message: expectedCode })
    expect(harness.coordinator.outcomes).toMatchObject([{
      kind: 'throw', disposition: 'abandon'
    }])
  })

  it('rejects a pre-cancelled read without invoking any script', async () => {
    const harness = createHarness()
    const controller = new AbortController()
    controller.abort(new Error('private cancellation reason'))

    const error = await captureError(harness.service.previewApply({
      requestId: id(16), signal: controller.signal
    }))

    expect(error).toEqual(new WindowsNebulaPluginTransactionError(
      'WINDOWS_NEBULA_PLUGIN_TRANSACTION_CANCELLED'
    ))
    expect(harness.runner.calls).toEqual([])
  })

  it('rejects caller-selected scripts, paths, backend, role, or arbitrary args', async () => {
    const harness = createHarness()
    const malicious = {
      requestId: id(17), currentPluginsTreeSha256: currentTree,
      maintenanceWindowStartUtc: windowStart, maintenanceWindowEndUtc: windowEnd,
      signal: new AbortController().signal,
      scriptName: 'Arbitrary.ps1', candidateManifestPath: 'C:\\Private\\candidate.json',
      gameRoot: 'C:\\OtherGame', backend: 'Shadow', targetRole: 'Client',
      arguments: ['-TestFailurePoint', 'AfterIntent']
    }

    const error = await captureError(harness.service.plan(malicious))

    expect(error).toEqual(new WindowsNebulaPluginTransactionError(
      'WINDOWS_NEBULA_PLUGIN_TRANSACTION_REQUEST_INVALID'
    ))
    expect(harness.runner.calls).toEqual([])
  })

  it('rejects a confirmation phrase that is not bound to the exact UUID and digest', async () => {
    const harness = createHarness()

    const error = await captureError(harness.service.apply({
      requestId: id(171), planDigest,
      confirmationPhrase: `CONFIRM NEBULA PLUGIN CUTOVER ${id(172)} ${planDigest}`
    }))

    expect(error).toEqual(new WindowsNebulaPluginTransactionError(
      'WINDOWS_NEBULA_PLUGIN_TRANSACTION_REQUEST_INVALID'
    ))
    expect(harness.coordinator.ordinaryRequests).toEqual([])
    expect(harness.runner.calls).toEqual([])
  })

  it.each([
    ['2030-01-01T01:00:00+01:00', '2030-01-01T02:00:00+01:00'],
    ['2030-01-01T01:00:00Z', '2030-01-01T10:00:00Z']
  ])('rejects a non-UTC or over-eight-hour maintenance window', async (start, end) => {
    const harness = createHarness()
    const error = await captureError(harness.service.plan({
      requestId: id(173), currentPluginsTreeSha256: currentTree,
      maintenanceWindowStartUtc: start, maintenanceWindowEndUtc: end,
      signal: new AbortController().signal
    }))
    expect(error).toEqual(new WindowsNebulaPluginTransactionError(
      'WINDOWS_NEBULA_PLUGIN_TRANSACTION_REQUEST_INVALID'
    ))
    expect(harness.runner.calls).toEqual([])
  })

  it('verifies apply and rollback through fixed read-only scripts with strict safe results', async () => {
    const harness = createHarness()
    const signal = new AbortController().signal

    const apply = await harness.service.verifyApply({ requestId: id(18), signal })
    const rollback = await harness.service.verifyRollback({
      originalRequestId: id(18), rollbackRequestId: id(19), signal
    })

    expect(apply).toEqual({
      requestId: id(18), targetRole: 'Server', transactionStatus: 'applied', receiptDigest,
      contentAndAclExact: true, rollbackMaterialRetained: true
    })
    expect(rollback).toEqual({
      originalRequestId: id(18), rollbackRequestId: id(19),
      transactionStatus: 'rolled-back-manual', receiptDigest,
      contentAndAclExact: true, rollbackMaterialRetained: true
    })
    expect(harness.runner.calls.map((call) => call.scriptName)).toEqual([
      'Test-NebulaPluginCutover.ps1', 'Test-NebulaPluginRollback.ps1'
    ])
    expect(harness.coordinator.ordinaryRequests).toEqual([])
    expect(harness.coordinator.recoveryRequests).toEqual([])
    expect(JSON.stringify([apply, rollback])).not.toContain(jobBase)
    expect(JSON.stringify([apply, rollback])).not.toContain(leaseToken)
  })

  it('rejects malformed, oversized, or identity-mismatched script output', async () => {
    for (const output of [
      '{not-json',
      JSON.stringify({ ...JSON.parse(defaultOutput(
        'Invoke-NebulaPluginCutover.ps1', applyBaseArguments(id(20))
      )), requestId: id(21) }),
      JSON.stringify({ padding: 'x'.repeat(33 * 1024) })
    ]) {
      const harness = createHarness({ responder: () => output })
      const error = await captureError(harness.service.previewApply({
        requestId: id(20), signal: new AbortController().signal
      }))
      expect(error).toEqual(new WindowsNebulaPluginTransactionError(
        'WINDOWS_NEBULA_PLUGIN_TRANSACTION_RESULT_INVALID'
      ))
    }
  })
})

interface RunnerCall {
  scriptName: WindowsNebulaPluginTransactionScriptName
  arguments_: string[]
  signal: AbortSignal
}

class RecordingRunner implements WindowsNebulaPluginTransactionPowerShellRunner {
  readonly calls: RunnerCall[] = []
  readonly #responder: (scriptName: WindowsNebulaPluginTransactionScriptName, arguments_: string[]) => string
  readonly #failure: unknown

  constructor(options: HarnessOptions) {
    this.#responder = options.responder ?? defaultOutput
    this.#failure = options.failure
  }

  async run(
    scriptName: WindowsNebulaPluginTransactionScriptName,
    arguments_: string[],
    signal: AbortSignal
  ): Promise<string> {
    this.calls.push({ scriptName, arguments_: [...arguments_], signal })
    if (this.#failure !== undefined) throw this.#failure
    return this.#responder(scriptName, arguments_)
  }
}

class RecordingCoordinator implements
  HostMutationOperationCoordinator,
  HostMutationRecoveryOperationCoordinator {
  readonly ordinaryRequests: HostMutationOperationRequest[] = []
  readonly recoveryRequests: HostMutationRecoveryOperationRequest[] = []
  readonly outcomes: HostMutationOperationOutcome<unknown>[] = []
  readonly callbackFailures: string[] = []
  readonly #scope: HostMutationOperationScope

  constructor(scope: HostMutationOperationScope) {
    this.#scope = scope
  }

  async runExclusive<T>(
    request: HostMutationOperationRequest,
    operation: (scope: HostMutationOperationScope) =>
      Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>
  ): Promise<T> {
    this.ordinaryRequests.push({ ...request })
    return this.#invoke(operation)
  }

  async runRecoveryExclusive<T>(
    request: HostMutationRecoveryOperationRequest,
    operation: (scope: HostMutationOperationScope) =>
      Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>
  ): Promise<T> {
    this.recoveryRequests.push({ ...request })
    return this.#invoke(operation)
  }

  async #invoke<T>(
    operation: (scope: HostMutationOperationScope) =>
      Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>
  ): Promise<T> {
    let outcome: HostMutationOperationOutcome<T>
    try {
      outcome = await operation(this.#scope)
    } catch (error) {
      this.callbackFailures.push(error instanceof Error ? error.message : 'unknown')
      throw error
    }
    this.outcomes.push(outcome as HostMutationOperationOutcome<unknown>)
    if (outcome.kind === 'return') return outcome.value
    throw outcome.error
  }
}

interface HarnessOptions {
  borrowArguments?: readonly string[]
  loseOnAssertion?: number
  failure?: unknown
  responder?: (scriptName: WindowsNebulaPluginTransactionScriptName, arguments_: string[]) => string
}

function createHarness(options: HarnessOptions = {}): {
  service: WindowsNebulaPluginTransactionService
  runner: RecordingRunner
  coordinator: RecordingCoordinator
  scope: HostMutationOperationScope
} {
  const controller = new AbortController()
  let assertions = 0
  const scope: HostMutationOperationScope = {
    signal: controller.signal,
    assertActive: () => {
      assertions += 1
      if (assertions >= (options.loseOnAssertion ?? Number.POSITIVE_INFINITY)) {
        throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_LOST')
      }
    },
    toPowerShellBorrowArguments: () => options.borrowArguments ?? [
      '-DataRoot', dataRoot,
      '-LeaseInstanceId', leaseInstanceId,
      '-LeaseToken', leaseToken
    ]
  }
  const coordinator = new RecordingCoordinator(scope)
  const runner = new RecordingRunner(options)
  return {
    service: new WindowsNebulaPluginTransactionService({
      jobBase, gameRoot, dataRoot, targetRole: 'Server', runner,
      coordinator, recoveryCoordinator: coordinator
    }),
    runner,
    coordinator,
    scope
  }
}

function defaultOutput(
  scriptName: WindowsNebulaPluginTransactionScriptName,
  arguments_: string[]
): string {
  const requestId = argumentOrNull(arguments_, '-RequestId')
  const originalRequestId = argumentOrNull(arguments_, '-OriginalRequestId')
  const rollbackRequestId = argumentOrNull(arguments_, '-RollbackRequestId')
  if (scriptName === 'New-NebulaPluginCutoverPlan.ps1') {
    return JSON.stringify({
      protocol: 'DYSON_NEBULA_PLUGIN_TRANSACTION_PLAN_V3', requestId,
      targetRole: 'Server', mode: 'dry-run', executionEnabled: false,
      planDigest, productionChanged: false
    })
  }
  if (scriptName === 'Invoke-NebulaPluginCutover.ps1') {
    if (!arguments_.includes('-Apply')) {
      return JSON.stringify({
        protocol: 'DYSON_NEBULA_PLUGIN_TRANSACTION_PLAN_V3', status: 'preview',
        mode: 'dry-run', requestId, targetRole: 'Server', planDigest,
        confirmationRequired: true, productionChanged: false
      })
    }
    if (arguments_.includes('-Recover')) {
      return JSON.stringify({
        protocol: 'DYSON_NEBULA_PLUGIN_TRANSACTION_RECEIPT_V3',
        status: 'rolled-back-recovery', requestId, receiptDigest, reused: false
      })
    }
    return JSON.stringify({
      protocol: 'DYSON_NEBULA_PLUGIN_TRANSACTION_RECEIPT_V3', status: 'applied',
      requestId, targetRole: 'Server', receiptDigest, quarantineRetained: true, reused: false
    })
  }
  if (scriptName === 'Restore-NebulaPluginCutover.ps1') {
    if (!arguments_.includes('-Apply')) {
      return JSON.stringify({
        protocol: 'DYSON_NEBULA_PLUGIN_ROLLBACK_PREVIEW_V3', status: 'preview', mode: 'dry-run',
        rollbackRequestId, originalRequestId, previewDigest,
        exactConfirmationPhrase: rollbackPhrase(rollbackRequestId!), productionChanged: false
      })
    }
    if (arguments_.includes('-Recover')) {
      return JSON.stringify({
        protocol: 'DYSON_NEBULA_PLUGIN_TRANSACTION_RECEIPT_V3',
        status: 'rollback-recovery-restored-candidate', requestId: rollbackRequestId,
        receiptDigest, reused: false
      })
    }
    return JSON.stringify({
      protocol: 'DYSON_NEBULA_PLUGIN_TRANSACTION_RECEIPT_V3', status: 'rolled-back-manual',
      requestId: rollbackRequestId, originalRequestId, receiptDigest,
      candidateStageRetained: true, reused: false
    })
  }
  if (scriptName === 'Test-NebulaPluginCutover.ps1') {
    return JSON.stringify({
      protocol: 'DYSON_NEBULA_PLUGIN_TRANSACTION_RECEIPT_V3', status: 'verified',
      requestId, targetRole: 'Server', transactionStatus: 'applied', receiptDigest,
      contentAndAclExact: true, rollbackMaterialRetained: true
    })
  }
  return JSON.stringify({
    protocol: 'DYSON_NEBULA_PLUGIN_TRANSACTION_RECEIPT_V3', status: 'verified',
    operation: 'rollback', originalRequestId, rollbackRequestId,
    transactionStatus: 'rolled-back-manual', receiptDigest,
    contentAndAclExact: true, rollbackMaterialRetained: true
  })
}

function applyRequest(requestId: string): {
  requestId: string
  planDigest: string
  confirmationPhrase: string
} {
  return {
    requestId,
    planDigest,
    confirmationPhrase: nebulaPluginApplyConfirmationPhrase(requestId, planDigest)
  }
}

function rollbackReadRequest(
  originalRequestId: string,
  rollbackRequestId: string,
  signal: AbortSignal
): {
  originalRequestId: string
  rollbackRequestId: string
  originalReceiptSha256: string
  maintenanceWindowStartUtc: string
  maintenanceWindowEndUtc: string
  signal: AbortSignal
} {
  return {
    originalRequestId, rollbackRequestId, originalReceiptSha256: originalReceipt,
    maintenanceWindowStartUtc: windowStart, maintenanceWindowEndUtc: windowEnd, signal
  }
}

function rollbackMutationRequest(originalRequestId: string, rollbackRequestId: string): {
  originalRequestId: string
  rollbackRequestId: string
  originalReceiptSha256: string
  maintenanceWindowStartUtc: string
  maintenanceWindowEndUtc: string
  previewDigest: string
  confirmationPhrase: string
} {
  return {
    originalRequestId, rollbackRequestId, originalReceiptSha256: originalReceipt,
    maintenanceWindowStartUtc: windowStart, maintenanceWindowEndUtc: windowEnd,
    previewDigest, confirmationPhrase: rollbackPhrase(rollbackRequestId)
  }
}

function applyBaseArguments(requestId: string): string[] {
  return [
    '-RequestId', requestId, '-JobBase', jobBase, '-GameRoot', gameRoot,
    '-TargetRole', 'Server', '-PlanPath', planPath(requestId),
    '-CandidateManifestPath', candidateManifestPath(requestId), '-Backend', 'Windows'
  ]
}

function rollbackBaseArguments(originalRequestId: string, rollbackRequestId: string): string[] {
  return [
    '-OriginalRequestId', originalRequestId,
    '-RollbackRequestId', rollbackRequestId,
    '-JobBase', jobBase, '-GameRoot', gameRoot, '-TargetRole', 'Server',
    '-OriginalPlanPath', planPath(originalRequestId),
    '-OriginalReceiptSha256', originalReceipt,
    '-MaintenanceWindowStartUtc', windowStart,
    '-MaintenanceWindowEndUtc', windowEnd,
    '-Backend', 'Windows'
  ]
}

function hostBorrowArguments(): string[] {
  return [
    '-HostMutationDataRoot', dataRoot,
    '-HostMutationLeaseInstanceId', leaseInstanceId,
    '-HostMutationLeaseToken', leaseToken
  ]
}

function planPath(requestId: string): string {
  return `${jobBase}\\${requestId}\\evidence\\plugin-cutover-plan.json`
}

function candidateManifestPath(requestId: string): string {
  return `${jobBase}\\${requestId}\\evidence\\candidate-manifest.json`
}

function rollbackPhrase(rollbackRequestId: string): string {
  return `CONFIRM NEBULA PLUGIN ROLLBACK ${rollbackRequestId} ${previewDigest}`
}

function argument(arguments_: readonly string[], name: string): string {
  const index = arguments_.indexOf(name)
  if (index < 0 || index + 1 >= arguments_.length) throw new Error(`missing ${name}`)
  return arguments_[index + 1]!
}

function argumentOrNull(arguments_: readonly string[], name: string): string | null {
  const index = arguments_.indexOf(name)
  return index < 0 ? null : arguments_[index + 1] ?? null
}

function id(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) return error
    throw new Error('non-error rejection')
  }
  throw new Error('expected rejection')
}

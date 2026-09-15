import { EventEmitter } from 'node:events'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  HostMutationLeaseError,
  HostMutationLeaseManager,
  type HostMutationBrokerProcess,
  type HostMutationBrokerSpawner,
  type HostMutationLease,
  type HostMutationLeaseRequest
} from './lease.js'
import { HostMutationLifecycleCoordinator } from './lifecycle-coordinator.js'
import {
  HostMutationCoordinator,
  hostMutationReturn,
  hostMutationThrow,
  type HostMutationRecoveryOperationRequest
} from './operation-coordinator.js'

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..')
const scriptRoot = path.join(repositoryRoot, 'scripts', 'windows')

describe('generic host mutation operation coordinator', () => {
  it('releases a returned value and forwards the active lease signal', async () => {
    const runner = new FakeLeaseRunner()
    const coordinator = new HostMutationCoordinator(runner, { dataRoot: 'C:\\fictional-data' })

    const result = await coordinator.runExclusive(
      { operation: 'mod-deployment', requestId: '00000000-0000-4000-8000-000000000001' },
      async (scope) => {
        expect(scope.signal.aborted).toBe(false)
        expect(() => scope.assertActive()).not.toThrow()
        expect(scope.toPowerShellBorrowArguments()).toEqual([
          '-DataRoot', 'C:\\fictional-data',
          '-LeaseInstanceId', '00000000-0000-4000-8000-000000000009',
          '-LeaseToken', 'fictional-token'
        ])
        return hostMutationReturn('ok')
      }
    )

    expect(result).toBe('ok')
    expect(runner.abandoned).toBe(false)
    expect(runner.requests).toEqual([expect.objectContaining({
      dataRoot: 'C:\\fictional-data',
      owner: 'dyson-control-api',
      operation: 'mod-deployment'
    })])
  })

  it('releases before rethrowing an ordinary domain rejection', async () => {
    const runner = new FakeLeaseRunner()
    const coordinator = new HostMutationCoordinator(runner, { dataRoot: 'C:\\fictional-data' })
    const failure = new Error('DOMAIN_REJECTION')

    await expect(coordinator.runExclusive(
      { operation: 'save-restore', requestId: '00000000-0000-4000-8000-000000000002' },
      async () => hostMutationThrow(failure, 'release')
    )).rejects.toBe(failure)
    expect(runner.abandoned).toBe(false)
  })

  it('abandons while preserving either a returned recovery result or a thrown recovery error', async () => {
    const returnedRunner = new FakeLeaseRunner()
    const returnedCoordinator = new HostMutationCoordinator(returnedRunner, { dataRoot: 'C:\\fictional-data' })
    await expect(returnedCoordinator.runExclusive(
      { operation: 'save-restore', requestId: '00000000-0000-4000-8000-000000000003' },
      async () => hostMutationReturn('recovery-required', 'abandon')
    )).resolves.toBe('recovery-required')
    expect(returnedRunner.abandoned).toBe(true)

    const thrownRunner = new FakeLeaseRunner()
    const thrownCoordinator = new HostMutationCoordinator(thrownRunner, { dataRoot: 'C:\\fictional-data' })
    const failure = new Error('RECOVERY_REQUIRED')
    await expect(thrownCoordinator.runExclusive(
      { operation: 'update-activation', requestId: '00000000-0000-4000-8000-000000000004' },
      async () => hostMutationThrow(failure, 'abandon')
    )).rejects.toBe(failure)
    expect(thrownRunner.abandoned).toBe(true)
  })

  it('fails closed and abandons when the domain callback does not classify an exception', async () => {
    const runner = new FakeLeaseRunner()
    const coordinator = new HostMutationCoordinator(runner, { dataRoot: 'C:\\fictional-data' })

    await expect(coordinator.runExclusive(
      { operation: 'config-restore', requestId: '00000000-0000-4000-8000-000000000005' },
      async () => { throw new Error('UNCLASSIFIED') }
    )).rejects.toThrow('UNCLASSIFIED')
    expect(runner.abandoned).toBe(true)
  })

  it.each([
    ['DYSON_HOST_MUTATION_LEASE_BUSY', 'HOST_MUTATION_LEASE_BUSY'],
    ['DYSON_HOST_MUTATION_LEASE_RECORD_INVALID', 'HOST_MUTATION_LEASE_DIRTY'],
    ['DYSON_HOST_MUTATION_LEASE_RECOVERY_REQUIRED', 'HOST_MUTATION_LEASE_RECOVERY_REQUIRED'],
    ['DYSON_HOST_MUTATION_LEASE_BROKER_UNAVAILABLE', 'HOST_MUTATION_LEASE_UNAVAILABLE']
  ] as const)('maps acquire failure %s to %s', async (hostCode, publicCode) => {
    const runner = new FakeLeaseRunner()
    runner.acquireError = new HostMutationLeaseError(hostCode)
    const coordinator = new HostMutationCoordinator(runner, { dataRoot: 'C:\\fictional-data' })

    await expect(coordinator.runExclusive(
      { operation: 'config-restore', requestId: '00000000-0000-4000-8000-000000000006' },
      async () => hostMutationReturn(undefined)
    )).rejects.toMatchObject({ code: publicCode })
  })

  it('maps a broker failure after entry to lease lost without exposing broker detail', async () => {
    const runner = new FakeLeaseRunner()
    runner.failAfterOperation = true
    const coordinator = new HostMutationCoordinator(runner, { dataRoot: 'C:\\fictional-data' })

    await expect(coordinator.runExclusive(
      { operation: 'mod-deployment', requestId: '00000000-0000-4000-8000-000000000007' },
      async () => hostMutationReturn('never-observed')
    )).rejects.toMatchObject({ code: 'HOST_MUTATION_LEASE_LOST' })
  })
})

describe('explicit host mutation recovery coordinator', () => {
  it('fails closed when the trusted broker reports that no recovery is required', async () => {
    const harness = createRecoveryLeaseHarness('not-required', [{
      kind: 'error',
      code: 'DYSON_HOST_MUTATION_LEASE_RECOVERY_NOT_REQUIRED'
    }])
    let entered = false

    await expect(harness.coordinator.runRecoveryExclusive(
      recoveryRequest(),
      async () => {
        entered = true
        return hostMutationReturn('unexpected')
      }
    )).rejects.toMatchObject({ code: 'HOST_MUTATION_LEASE_RECOVERY_NOT_REQUIRED' })

    expect(entered).toBe(false)
    expect(harness.calls).toHaveLength(1)
    expect(harness.calls[0]).toContain('-ProbeRecovery')
    expect(harness.commands).toEqual([])
  })

  it.each([
    ['operation', { expectedOperation: 'update-activation', expectedRequestId: recoveryRequestId }],
    ['request', { expectedOperation: recoveryOperation, expectedRequestId: 'different-request' }]
  ] as const)('does not consume recovery evidence for a wrong expected %s', async (_field, request) => {
    const harness = createRecoveryLeaseHarness(`mismatch-${_field}`, [
      { kind: 'candidate', message: recoveryCandidate() }
    ])

    await expect(harness.coordinator.runRecoveryExclusive(
      request,
      async () => hostMutationReturn('unexpected')
    )).rejects.toMatchObject({ code: 'HOST_MUTATION_LEASE_RECOVERY_MISMATCH' })

    expect(harness.calls).toHaveLength(1)
    expect(harness.commands).toEqual([])
  })

  it('rejects caller-supplied binding fields before probing the broker', async () => {
    const harness = createRecoveryLeaseHarness('forged-binding', [])
    const forged = {
      ...recoveryRequest(),
      priorInstanceId: recoveryInstanceA,
      priorRecordDigest: recoveryDigestA
    } as unknown as HostMutationRecoveryOperationRequest

    await expect(harness.coordinator.runRecoveryExclusive(
      forged,
      async () => hostMutationReturn('unexpected')
    )).rejects.toMatchObject({ code: 'HOST_MUTATION_LEASE_RECOVERY_MISMATCH' })

    expect(harness.calls).toEqual([])
  })

  it('closes a probe-to-acquire race with the exact instance and digest binding', async () => {
    const harness = createRecoveryLeaseHarness('binding-race', [
      { kind: 'candidate', message: recoveryCandidate() },
      { kind: 'error', code: 'DYSON_HOST_MUTATION_LEASE_RECOVERY_BINDING_INVALID' }
    ])
    let entered = false

    await expect(harness.coordinator.runRecoveryExclusive(
      recoveryRequest(),
      async () => {
        entered = true
        return hostMutationReturn('unexpected')
      }
    )).rejects.toMatchObject({ code: 'HOST_MUTATION_LEASE_RECOVERY_MISMATCH' })

    expect(entered).toBe(false)
    expect(harness.calls).toHaveLength(2)
    expect(harness.calls[1]).toEqual(expect.arrayContaining([
      '-RecoveryPriorInstanceId', recoveryInstanceA,
      '-RecoveryPriorRecordDigest', recoveryDigestA
    ]))
    expect(harness.commands).toEqual([])
  })

  it('consumes one trusted binding while preserving the original domain identity', async () => {
    const harness = createRecoveryLeaseHarness('single-success', [
      { kind: 'candidate', message: recoveryCandidate() },
      { kind: 'ready' }
    ])

    await expect(harness.coordinator.runRecoveryExclusive(
      recoveryRequest(),
      async (scope) => {
        expect(scope.signal.aborted).toBe(false)
        expect(() => scope.assertActive()).not.toThrow()
        return hostMutationReturn('recovered')
      }
    )).resolves.toBe('recovered')

    expect(harness.calls).toHaveLength(2)
    expect(harness.calls[1]).toEqual(expect.arrayContaining([
      '-Operation', recoveryOperation,
      '-RequestId', recoveryRequestId,
      '-RecoveryPriorInstanceId', recoveryInstanceA,
      '-RecoveryPriorRecordDigest', recoveryDigestA
    ]))
    expect(harness.commands).toEqual(['RELEASE'])
  })

  it('keeps the original domain binding retryable after a recovery callback abandons', async () => {
    const harness = createRecoveryLeaseHarness('repeat-after-abandon', [
      { kind: 'candidate', message: recoveryCandidate() },
      { kind: 'ready', instanceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1' },
      {
        kind: 'candidate',
        message: recoveryCandidate({
          priorInstanceId: recoveryInstanceB,
          priorRecordDigest: recoveryDigestB,
          priorState: 'abandoned'
        })
      },
      { kind: 'ready', instanceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2' }
    ])

    await expect(harness.coordinator.runRecoveryExclusive(
      recoveryRequest(),
      async () => hostMutationReturn('still-needs-recovery', 'abandon')
    )).resolves.toBe('still-needs-recovery')
    await expect(harness.coordinator.runRecoveryExclusive(
      recoveryRequest(),
      async () => hostMutationReturn('recovered')
    )).resolves.toBe('recovered')

    expect(harness.commands).toEqual(['ABANDON', 'RELEASE'])
    for (const call of [harness.calls[1], harness.calls[3]]) {
      expect(call).toEqual(expect.arrayContaining([
        '-Operation', recoveryOperation,
        '-RequestId', recoveryRequestId
      ]))
    }
    expect(harness.calls[3]).toEqual(expect.arrayContaining([
      '-RecoveryPriorInstanceId', recoveryInstanceB,
      '-RecoveryPriorRecordDigest', recoveryDigestB
    ]))
  })

  it('rejects malformed recovery metadata without attempting acquisition', async () => {
    const harness = createRecoveryLeaseHarness('malformed-metadata', [{
      kind: 'candidate',
      message: { ...recoveryCandidate(), priorRequestId: 'contains whitespace' }
    }])

    await expect(harness.coordinator.runRecoveryExclusive(
      recoveryRequest(),
      async () => hostMutationReturn('unexpected')
    )).rejects.toMatchObject({ code: 'HOST_MUTATION_LEASE_UNAVAILABLE' })

    expect(harness.calls).toHaveLength(1)
    expect(harness.commands).toEqual([])
  })
})

describe('nested host mutation disposition propagation', () => {
  it('keeps a direct nested unclassified failure sticky after the outer holder catches it', async () => {
    const harness = createNestedLeaseHarness('direct-unclassified')
    const failure = new Error('NESTED_UNCLASSIFIED')

    const result = await harness.manager.runExclusive(
      leaseRequest(harness.dataRoot, 'direct-outer'),
      async (outerLease) => {
        await expect(harness.manager.runExclusive(
          leaseRequest(harness.dataRoot, 'direct-inner'),
          async () => { throw failure }
        )).rejects.toBe(failure)
        // Poisoning selects the eventual disposition without preventing bounded
        // compensation while the physical broker lease is still held.
        expect(() => outerLease.assertActive()).not.toThrow()
        return 'compensated'
      }
    )

    expect(result).toBe('compensated')
    expect(harness.calls()).toBe(1)
    expect(harness.commands).toEqual(['ABANDON'])
  })

  it('propagates generic-to-generic return+abandon through an outer release', async () => {
    const harness = createNestedLeaseHarness('generic-return-abandon')
    const coordinator = new HostMutationCoordinator(harness.manager, { dataRoot: harness.dataRoot })

    const result = await coordinator.runExclusive(
      operationRequest('generic-outer-return'),
      async (outerScope) => {
        const nested = await coordinator.runExclusive(
          operationRequest('generic-inner-return'),
          async () => hostMutationReturn('recovery-required', 'abandon')
        )
        expect(() => outerScope.assertActive()).not.toThrow()
        return hostMutationReturn(nested, 'release')
      }
    )

    expect(result).toBe('recovery-required')
    expect(harness.calls()).toBe(1)
    expect(harness.commands).toEqual(['ABANDON'])
  })

  it('propagates generic-to-generic throw+abandon even when the outer operation catches it', async () => {
    const harness = createNestedLeaseHarness('generic-throw-abandon')
    const coordinator = new HostMutationCoordinator(harness.manager, { dataRoot: harness.dataRoot })
    const failure = new Error('NESTED_RECOVERY_REQUIRED')

    const result = await coordinator.runExclusive(
      operationRequest('generic-outer-catch'),
      async () => {
        await expect(coordinator.runExclusive(
          operationRequest('generic-inner-throw'),
          async () => hostMutationThrow(failure, 'abandon')
        )).rejects.toBe(failure)
        return hostMutationReturn('caught-and-compensated', 'release')
      }
    )

    expect(result).toBe('caught-and-compensated')
    expect(harness.calls()).toBe(1)
    expect(harness.commands).toEqual(['ABANDON'])
  })

  it('propagates generic-to-lifecycle abandon through the shared manager', async () => {
    const harness = createNestedLeaseHarness('generic-lifecycle-abandon')
    const generic = new HostMutationCoordinator(harness.manager, { dataRoot: harness.dataRoot })
    const lifecycle = new HostMutationLifecycleCoordinator(harness.manager, { dataRoot: harness.dataRoot })

    const result = await generic.runExclusive(
      operationRequest('generic-lifecycle-outer'),
      async () => {
        const nested = await lifecycle.runExclusive(
          { requestId: 'lifecycle-inner-abandon', action: 'restart' },
          async () => ({ value: 'lifecycle-recovery-required', disposition: 'abandon' })
        )
        return hostMutationReturn(nested, 'release')
      }
    )

    expect(result).toBe('lifecycle-recovery-required')
    expect(harness.calls()).toBe(1)
    expect(harness.commands).toEqual(['ABANDON'])
  })

  it('propagates lifecycle-to-generic throw+abandon after the lifecycle operation catches it', async () => {
    const harness = createNestedLeaseHarness('lifecycle-generic-abandon')
    const generic = new HostMutationCoordinator(harness.manager, { dataRoot: harness.dataRoot })
    const lifecycle = new HostMutationLifecycleCoordinator(harness.manager, { dataRoot: harness.dataRoot })
    const failure = new Error('GENERIC_RECOVERY_REQUIRED')

    const result = await lifecycle.runExclusive(
      { requestId: 'lifecycle-outer-catch', action: 'restart' },
      async () => {
        await expect(generic.runExclusive(
          operationRequest('lifecycle-generic-inner'),
          async () => hostMutationThrow(failure, 'abandon')
        )).rejects.toBe(failure)
        return { value: 'lifecycle-compensated', disposition: 'release' }
      }
    )

    expect(result).toBe('lifecycle-compensated')
    expect(harness.calls()).toBe(1)
    expect(harness.commands).toEqual(['ABANDON'])
  })

  it('does not poison the shared scope for nested release results or release-classified exceptions', async () => {
    const harness = createNestedLeaseHarness('nested-release')
    const coordinator = new HostMutationCoordinator(harness.manager, { dataRoot: harness.dataRoot })
    const safeRejection = new Error('SAFE_DOMAIN_REJECTION')

    const result = await coordinator.runExclusive(
      operationRequest('release-outer'),
      async (outerScope) => {
        await expect(coordinator.runExclusive(
          operationRequest('release-inner-return'),
          async () => hostMutationReturn('nested-ok', 'release')
        )).resolves.toBe('nested-ok')
        await expect(coordinator.runExclusive(
          operationRequest('release-inner-throw'),
          async () => hostMutationThrow(safeRejection, 'release')
        )).rejects.toBe(safeRejection)
        expect(() => outerScope.assertActive()).not.toThrow()
        return hostMutationReturn('outer-ok', 'release')
      }
    )

    expect(result).toBe('outer-ok')
    expect(harness.calls()).toBe(1)
    expect(harness.commands).toEqual(['RELEASE'])
  })
})

class FakeLeaseRunner {
  readonly requests: HostMutationLeaseRequest[] = []
  acquireError: unknown = null
  failAfterOperation = false
  abandoned = false

  async runExclusive<T>(
    request: HostMutationLeaseRequest,
    action: (lease: HostMutationLease) => Promise<T> | T
  ): Promise<T> {
    this.requests.push(request)
    if (this.acquireError) throw this.acquireError
    const controller = new AbortController()
    try {
      const result = await action({
        signal: controller.signal,
        assertActive: () => undefined,
        toPowerShellBorrowArguments: () => [
          '-DataRoot', request.dataRoot,
          '-LeaseInstanceId', '00000000-0000-4000-8000-000000000009',
          '-LeaseToken', 'fictional-token'
        ]
      } as unknown as HostMutationLease)
      if (this.failAfterOperation) throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_RELEASE_FAILED')
      return result
    } catch (error) {
      this.abandoned = true
      throw error
    } finally {
      controller.abort()
    }
  }
}

function operationRequest(suffix: string) {
  return { operation: 'nested-test', requestId: suffix }
}

function leaseRequest(dataRoot: string, suffix: string): HostMutationLeaseRequest {
  return {
    dataRoot,
    owner: 'nested-test',
    operation: 'nested-test',
    requestId: suffix,
    acquireTimeoutMs: 100
  }
}

function createNestedLeaseHarness(label: string): {
  manager: HostMutationLeaseManager
  dataRoot: string
  commands: Array<'RELEASE' | 'ABANDON'>
  calls: () => number
} {
  const commands: Array<'RELEASE' | 'ABANDON'> = []
  let callCount = 0
  const spawnBroker: HostMutationBrokerSpawner = () => {
    callCount += 1
    return new RecordingBrokerProcess((command) => commands.push(command))
  }
  return {
    manager: new HostMutationLeaseManager({ scriptRoot, spawnBroker }),
    dataRoot: path.join(repositoryRoot, 'fictional-host-mutation-data', label),
    commands,
    calls: () => callCount
  }
}

class RecordingBrokerProcess extends EventEmitter implements HostMutationBrokerProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  #exited = false

  constructor(onCommand: (command: 'RELEASE' | 'ABANDON') => void) {
    super()
    this.stdin.on('data', (chunk: Buffer | string) => {
      const command = String(chunk).trim()
      if (command !== 'RELEASE' && command !== 'ABANDON') return
      onCommand(command)
      queueMicrotask(() => this.#exit(command === 'RELEASE' ? 0 : 22, null))
    })
    queueMicrotask(() => {
      this.stdout.write(JSON.stringify({
        protocol: 'DYSON_HOST_MUTATION_BROKER_V1',
        type: 'ready',
        dataRootIdentity: `sha256:${'b'.repeat(64)}`,
        instanceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        token: 'A'.repeat(43)
      }) + '\n')
    })
  }

  kill(): boolean {
    this.#exit(null, 'SIGTERM')
    return true
  }

  #exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#exited) return
    this.#exited = true
    this.stdin.destroy()
    this.stdout.end()
    this.stderr.end()
    queueMicrotask(() => this.emit('exit', code, signal))
  }
}

const recoveryOperation = 'save-restore'
const recoveryRequestId = 'restore-request-0001'
const recoveryInstanceA = '11111111-2222-4333-8444-555555555555'
const recoveryInstanceB = '66666666-7777-4888-8999-aaaaaaaaaaaa'
const recoveryDigestA = 'a'.repeat(64)
const recoveryDigestB = 'b'.repeat(64)

function recoveryRequest(): HostMutationRecoveryOperationRequest {
  return {
    expectedOperation: recoveryOperation,
    expectedRequestId: recoveryRequestId
  }
}

function recoveryCandidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: 'DYSON_HOST_MUTATION_BROKER_V1',
    type: 'recovery-candidate',
    dataRootIdentity: `sha256:${'c'.repeat(64)}`,
    priorInstanceId: recoveryInstanceA,
    priorRecordDigest: recoveryDigestA,
    priorState: 'recovery-required',
    priorOperation: recoveryOperation,
    priorRequestId: recoveryRequestId,
    ...overrides
  }
}

type RecoveryBrokerStep =
  | Readonly<{ kind: 'candidate'; message: Record<string, unknown> }>
  | Readonly<{ kind: 'error'; code: string }>
  | Readonly<{ kind: 'ready'; instanceId?: string }>

function createRecoveryLeaseHarness(
  label: string,
  steps: readonly RecoveryBrokerStep[]
): {
  coordinator: HostMutationCoordinator
  calls: string[][]
  commands: Array<'RELEASE' | 'ABANDON'>
} {
  const calls: string[][] = []
  const commands: Array<'RELEASE' | 'ABANDON'> = []
  let stepIndex = 0
  const spawnBroker: HostMutationBrokerSpawner = (_executable, arguments_) => {
    calls.push([...arguments_])
    const step = steps[stepIndex++]
    if (!step) throw new Error('UNEXPECTED_BROKER_SPAWN')
    return new ScriptedRecoveryBrokerProcess(step, (command) => commands.push(command))
  }
  const manager = new HostMutationLeaseManager({ scriptRoot, spawnBroker })
  return {
    coordinator: new HostMutationCoordinator(manager, {
      dataRoot: path.join(repositoryRoot, 'fictional-host-mutation-recovery', label)
    }),
    calls,
    commands
  }
}

class ScriptedRecoveryBrokerProcess extends EventEmitter implements HostMutationBrokerProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  #exited = false

  constructor(
    step: RecoveryBrokerStep,
    onCommand: (command: 'RELEASE' | 'ABANDON') => void
  ) {
    super()
    this.stdin.on('data', (chunk: Buffer | string) => {
      const command = String(chunk).trim()
      if (command !== 'RELEASE' && command !== 'ABANDON') return
      onCommand(command)
      queueMicrotask(() => this.#exit(command === 'RELEASE' ? 0 : 22, null))
    })
    queueMicrotask(() => {
      if (step.kind === 'ready') {
        this.stdout.write(JSON.stringify({
          protocol: 'DYSON_HOST_MUTATION_BROKER_V1',
          type: 'ready',
          dataRootIdentity: `sha256:${'d'.repeat(64)}`,
          instanceId: step.instanceId ?? 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          token: 'A'.repeat(43)
        }) + '\n')
        return
      }
      const message = step.kind === 'candidate'
        ? step.message
        : {
            protocol: 'DYSON_HOST_MUTATION_BROKER_V1',
            type: 'error',
            code: step.code,
            priorInstanceId: null,
            priorRecordDigest: null,
            priorState: null,
            priorOperation: null,
            priorRequestId: null
          }
      this.stdout.write(JSON.stringify(message) + '\n')
      queueMicrotask(() => this.#exit(step.kind === 'candidate' ? 0 : 20, null))
    })
  }

  kill(): boolean {
    this.#exit(null, 'SIGTERM')
    return true
  }

  #exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#exited) return
    this.#exited = true
    this.stdin.destroy()
    this.stdout.end()
    this.stderr.end()
    queueMicrotask(() => this.emit('exit', code, signal))
  }
}

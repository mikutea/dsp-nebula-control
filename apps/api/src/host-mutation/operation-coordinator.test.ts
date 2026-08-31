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
  hostMutationThrow
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

import { describe, expect, it } from 'vitest'
import {
  HostMutationLeaseError,
  type HostMutationLease,
  type HostMutationLeaseRequest
} from './lease.js'
import {
  HostMutationCoordinator,
  hostMutationReturn,
  hostMutationThrow
} from './operation-coordinator.js'

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

import { describe, expect, it } from 'vitest'
import type { HostMutationLease, HostMutationLeaseRequest } from './lease.js'
import { HostMutationLeaseError } from './lease.js'
import {
  HostMutationLifecycleCoordinator,
  LifecycleCoordinatorError
} from './lifecycle-coordinator.js'

describe('host-mutation lifecycle coordinator', () => {
  it('forwards one bounded lifecycle request and releases a successful outcome', async () => {
    const runner = new FakeLeaseRunner()
    const coordinator = new HostMutationLifecycleCoordinator(runner, {
      dataRoot: 'C:\\fixture\\data',
      owner: 'fixture-owner',
      acquireTimeoutMs: 321
    })

    const result = await coordinator.runExclusive(
      { requestId: 'request:fixture:0001', action: 'restart' },
      async (scope) => ({ value: scope.signal, disposition: 'release' })
    )

    expect(result).toBe(runner.signal)
    expect(runner.requests).toEqual([{
      dataRoot: 'C:\\fixture\\data',
      owner: 'fixture-owner',
      operation: 'lifecycle-restart',
      requestId: 'request:fixture:0001',
      acquireTimeoutMs: 321
    }])
    expect(runner.finishes).toEqual(['release'])
  })

  it('turns an explicit abandon outcome into broker abandon without leaking its private sentinel', async () => {
    const runner = new FakeLeaseRunner()
    const coordinator = new HostMutationLifecycleCoordinator(runner, { dataRoot: 'C:\\fixture\\data' })
    const expected = { state: 'failed', persisted: true }

    const result = await coordinator.runExclusive(
      { requestId: 'request:fixture:0002', action: 'save' },
      async () => ({ value: expected, disposition: 'abandon' })
    )

    expect(result).toBe(expected)
    expect(runner.finishes).toEqual(['abandon'])
  })

  it('recognizes abandon only by its private class identity', async () => {
    const runner = new FakeLeaseRunner()
    const coordinator = new HostMutationLifecycleCoordinator(runner, { dataRoot: 'C:\\fixture\\data' })
    const forged = { value: 'forged-sentinel' }

    await expect(coordinator.runExclusive(
      { requestId: 'request:fixture:0003', action: 'save' },
      async () => { throw forged }
    )).rejects.toBe(forged)
    expect(runner.finishes).toEqual(['abandon'])
  })

  it.each([
    ['DYSON_HOST_MUTATION_LEASE_BUSY', 'LIFECYCLE_HOST_LEASE_BUSY'],
    ['DYSON_HOST_MUTATION_LEASE_RECORD_INVALID', 'LIFECYCLE_HOST_LEASE_DIRTY'],
    ['DYSON_HOST_MUTATION_LEASE_RECOVERY_REQUIRED', 'LIFECYCLE_HOST_LEASE_RECOVERY_REQUIRED'],
    ['DYSON_HOST_MUTATION_LEASE_BROKER_PROTOCOL_FAILED', 'LIFECYCLE_HOST_LEASE_UNAVAILABLE']
  ] as const)('maps %s to the fixed safe lifecycle code %s', async (hostCode, lifecycleCode) => {
    const runner = new FakeLeaseRunner()
    runner.acquireError = new HostMutationLeaseError(hostCode, {
      priorInstanceId: '00000000-0000-0000-0000-000000000001',
      priorRecordDigest: 'a'.repeat(64),
      priorState: 'recovery-required'
    })
    const coordinator = new HostMutationLifecycleCoordinator(runner, { dataRoot: 'C:\\private-fixture' })

    let failure: unknown
    try {
      await coordinator.runExclusive(
        { requestId: 'request:fixture:0004', action: 'start' },
        async () => ({ value: null, disposition: 'release' })
      )
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(LifecycleCoordinatorError)
    expect(failure).toMatchObject({ code: lifecycleCode, message: lifecycleCode })
    expect(Object.keys(failure as object).sort()).toEqual(['code', 'name'])
  })

  it('fails closed when the lease becomes inactive before a release outcome completes', async () => {
    const runner = new FakeLeaseRunner()
    const coordinator = new HostMutationLifecycleCoordinator(runner, { dataRoot: 'C:\\fixture\\data' })

    await expect(coordinator.runExclusive(
      { requestId: 'request:fixture:0005', action: 'start' },
      async () => {
        runner.abort()
        return { value: 'must-not-release', disposition: 'release' }
      }
    )).rejects.toMatchObject({
      code: 'LIFECYCLE_HOST_LEASE_UNAVAILABLE'
    })
    expect(runner.finishes).toEqual(['abandon'])
  })
})

class FakeLeaseRunner {
  readonly requests: HostMutationLeaseRequest[] = []
  readonly finishes: Array<'release' | 'abandon'> = []
  readonly #controller = new AbortController()
  acquireError: unknown = null
  #active = true

  get signal(): AbortSignal {
    return this.#controller.signal
  }

  abort(): void {
    this.#active = false
    this.#controller.abort()
  }

  async runExclusive<T>(
    request: HostMutationLeaseRequest,
    action: (lease: HostMutationLease) => Promise<T> | T
  ): Promise<T> {
    this.requests.push(request)
    if (this.acquireError) throw this.acquireError
    const lease = {
      signal: this.signal,
      assertActive: () => {
        if (!this.#active) {
          throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_SCOPE_INACTIVE')
        }
      }
    } as HostMutationLease
    try {
      const result = await action(lease)
      this.finishes.push('release')
      return result
    } catch (error) {
      this.finishes.push('abandon')
      throw error
    }
  }
}

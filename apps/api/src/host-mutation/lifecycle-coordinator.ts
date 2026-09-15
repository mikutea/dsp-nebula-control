import type { LifecycleAction } from '../domain.js'
import {
  HostMutationLeaseError,
  type HostMutationLeaseManager
} from './lease.js'

export type LifecycleLeaseDisposition = 'release' | 'abandon'

export interface LifecycleCoordinatorRequest {
  requestId: string
  action: LifecycleAction
}

export interface LifecycleCoordinatorScope {
  readonly signal: AbortSignal
  assertActive(): void
  toPowerShellBorrowArguments(): readonly string[]
}

export interface LifecycleCoordinatorOutcome<T> {
  value: T
  disposition: LifecycleLeaseDisposition
}

export interface LifecycleMutationCoordinator {
  runExclusive<T>(
    request: LifecycleCoordinatorRequest,
    operation: (
      scope: LifecycleCoordinatorScope
    ) => Promise<LifecycleCoordinatorOutcome<T>> | LifecycleCoordinatorOutcome<T>
  ): Promise<T>
}

export type LifecycleCoordinatorErrorCode =
  | 'LIFECYCLE_HOST_LEASE_BUSY'
  | 'LIFECYCLE_HOST_LEASE_DIRTY'
  | 'LIFECYCLE_HOST_LEASE_RECOVERY_REQUIRED'
  | 'LIFECYCLE_HOST_LEASE_UNAVAILABLE'

export class LifecycleCoordinatorError extends Error {
  readonly code: LifecycleCoordinatorErrorCode

  constructor(code: LifecycleCoordinatorErrorCode) {
    super(code)
    this.name = 'LifecycleCoordinatorError'
    this.code = code
  }
}

export interface HostMutationLifecycleCoordinatorOptions {
  dataRoot: string
  owner?: string
  acquireTimeoutMs?: number
}

type HostMutationLeaseRunner = Pick<HostMutationLeaseManager, 'runExclusive'>

class AbandonLifecycleLease<T> {
  readonly value: T

  constructor(value: T) {
    this.value = value
  }
}

/**
 * Adapts HostMutationLeaseManager's throw-means-abandon contract to an explicit
 * lifecycle disposition without exposing the private abandon sentinel.
 */
export class HostMutationLifecycleCoordinator implements LifecycleMutationCoordinator {
  readonly #leaseRunner: HostMutationLeaseRunner
  readonly #dataRoot: string
  readonly #owner: string
  readonly #acquireTimeoutMs: number | undefined

  constructor(
    leaseRunner: HostMutationLeaseRunner,
    options: HostMutationLifecycleCoordinatorOptions
  ) {
    this.#leaseRunner = leaseRunner
    this.#dataRoot = options.dataRoot
    this.#owner = options.owner ?? 'dyson-control-api'
    this.#acquireTimeoutMs = options.acquireTimeoutMs
  }

  async runExclusive<T>(
    request: LifecycleCoordinatorRequest,
    operation: (
      scope: LifecycleCoordinatorScope
    ) => Promise<LifecycleCoordinatorOutcome<T>> | LifecycleCoordinatorOutcome<T>
  ): Promise<T> {
    try {
      return await this.#leaseRunner.runExclusive(
        {
          dataRoot: this.#dataRoot,
          owner: this.#owner,
          operation: `lifecycle-${request.action}`,
          requestId: request.requestId,
          ...(this.#acquireTimeoutMs === undefined
            ? {}
            : { acquireTimeoutMs: this.#acquireTimeoutMs })
        },
        async (lease) => {
          const outcome = await operation({
            signal: lease.signal,
            assertActive: () => { lease.assertActive() },
            toPowerShellBorrowArguments: () => lease.toPowerShellBorrowArguments()
          })
          if (outcome.disposition === 'abandon') {
            throw new AbandonLifecycleLease(outcome.value)
          }
          if (outcome.disposition !== 'release') {
            throw new LifecycleCoordinatorError('LIFECYCLE_HOST_LEASE_UNAVAILABLE')
          }
          lease.assertActive()
          return outcome.value
        }
      )
    } catch (error) {
      if (error instanceof AbandonLifecycleLease) return error.value as T
      if (error instanceof LifecycleCoordinatorError) throw error
      if (error instanceof HostMutationLeaseError) {
        throw new LifecycleCoordinatorError(mapHostMutationLeaseError(error.code))
      }
      throw error
    }
  }
}

function mapHostMutationLeaseError(code: string): LifecycleCoordinatorErrorCode {
  if (code === 'DYSON_HOST_MUTATION_LEASE_BUSY') return 'LIFECYCLE_HOST_LEASE_BUSY'
  if (code === 'DYSON_HOST_MUTATION_LEASE_RECORD_INVALID') return 'LIFECYCLE_HOST_LEASE_DIRTY'
  if (code === 'DYSON_HOST_MUTATION_LEASE_RECOVERY_REQUIRED') {
    return 'LIFECYCLE_HOST_LEASE_RECOVERY_REQUIRED'
  }
  return 'LIFECYCLE_HOST_LEASE_UNAVAILABLE'
}

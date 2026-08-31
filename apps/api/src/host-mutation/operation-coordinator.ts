import {
  HostMutationLeaseError,
  type HostMutationLeaseRecoveryBinding,
  type HostMutationLeaseManager
} from './lease.js'

export type HostMutationDisposition = 'release' | 'abandon'

export interface HostMutationOperationRequest {
  operation: string
  requestId: string
  /** Explicit operator-authorized recovery only; ordinary retries must omit it. */
  recovery?: HostMutationLeaseRecoveryBinding
}

export interface HostMutationOperationScope {
  readonly signal: AbortSignal
  assertActive(): void
  toPowerShellBorrowArguments(): readonly string[]
}

export type HostMutationOperationOutcome<T> =
  | Readonly<{
      kind: 'return'
      value: T
      disposition: HostMutationDisposition
    }>
  | Readonly<{
      kind: 'throw'
      error: unknown
      disposition: HostMutationDisposition
    }>

export interface HostMutationOperationCoordinator {
  runExclusive<T>(
    request: HostMutationOperationRequest,
    operation: (
      scope: HostMutationOperationScope
    ) => Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>
  ): Promise<T>
}

export type HostMutationOperationCoordinatorErrorCode =
  | 'HOST_MUTATION_LEASE_BUSY'
  | 'HOST_MUTATION_LEASE_DIRTY'
  | 'HOST_MUTATION_LEASE_RECOVERY_REQUIRED'
  | 'HOST_MUTATION_LEASE_LOST'
  | 'HOST_MUTATION_LEASE_UNAVAILABLE'

export class HostMutationOperationCoordinatorError extends Error {
  readonly code: HostMutationOperationCoordinatorErrorCode

  constructor(code: HostMutationOperationCoordinatorErrorCode) {
    super(code)
    this.name = 'HostMutationOperationCoordinatorError'
    this.code = code
  }
}

export interface HostMutationOperationCoordinatorOptions {
  dataRoot: string
  owner?: string
  acquireTimeoutMs?: number
}

type HostMutationLeaseRunner = Pick<HostMutationLeaseManager, 'runExclusive'>

class AbandonHostMutationOperation<T> {
  readonly outcome: HostMutationOperationOutcome<T>

  constructor(outcome: HostMutationOperationOutcome<T>) {
    this.outcome = outcome
  }
}

/**
 * Converts the broker's throw-means-abandon contract into an explicit outcome.
 * Domain services can therefore release the host lease after a proven-safe
 * rejection while still abandoning it after an unresolved host mutation.
 */
export class HostMutationCoordinator implements HostMutationOperationCoordinator {
  readonly #leaseRunner: HostMutationLeaseRunner
  readonly #dataRoot: string
  readonly #owner: string
  readonly #acquireTimeoutMs: number | undefined

  constructor(
    leaseRunner: HostMutationLeaseRunner,
    options: HostMutationOperationCoordinatorOptions
  ) {
    this.#leaseRunner = leaseRunner
    this.#dataRoot = options.dataRoot
    this.#owner = options.owner ?? 'dyson-control-api'
    this.#acquireTimeoutMs = options.acquireTimeoutMs
  }

  async runExclusive<T>(
    request: HostMutationOperationRequest,
    operation: (
      scope: HostMutationOperationScope
    ) => Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>
  ): Promise<T> {
    let entered = false
    try {
      const outcome = await this.#leaseRunner.runExclusive(
        {
          dataRoot: this.#dataRoot,
          owner: this.#owner,
          operation: request.operation,
          requestId: request.requestId,
          ...(request.recovery === undefined ? {} : { recovery: request.recovery }),
          ...(this.#acquireTimeoutMs === undefined
            ? {}
            : { acquireTimeoutMs: this.#acquireTimeoutMs })
        },
        async (lease) => {
          entered = true
          const result = await operation({
            signal: lease.signal,
            assertActive: () => { lease.assertActive() },
            toPowerShellBorrowArguments: () => lease.toPowerShellBorrowArguments()
          })
          assertOutcome(result)
          if (result.disposition === 'abandon') {
            throw new AbandonHostMutationOperation(result)
          }
          lease.assertActive()
          return result
        }
      )
      return unwrapOutcome(outcome)
    } catch (error) {
      if (error instanceof AbandonHostMutationOperation) {
        return unwrapOutcome(error.outcome as HostMutationOperationOutcome<T>)
      }
      if (error instanceof HostMutationOperationCoordinatorError) throw error
      if (error instanceof HostMutationLeaseError) {
        throw new HostMutationOperationCoordinatorError(
          entered ? 'HOST_MUTATION_LEASE_LOST' : mapAcquireError(error.code)
        )
      }
      throw error
    }
  }
}

export function hostMutationReturn<T>(
  value: T,
  disposition: HostMutationDisposition = 'release'
): HostMutationOperationOutcome<T> {
  return { kind: 'return', value, disposition }
}

export function hostMutationThrow<T = never>(
  error: unknown,
  disposition: HostMutationDisposition
): HostMutationOperationOutcome<T> {
  return { kind: 'throw', error, disposition }
}

function unwrapOutcome<T>(outcome: HostMutationOperationOutcome<T>): T {
  if (outcome.kind === 'return') return outcome.value
  throw outcome.error
}

function assertOutcome<T>(outcome: HostMutationOperationOutcome<T>): void {
  if (!outcome || typeof outcome !== 'object' ||
      (outcome.kind !== 'return' && outcome.kind !== 'throw') ||
      (outcome.disposition !== 'release' && outcome.disposition !== 'abandon')) {
    throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_UNAVAILABLE')
  }
  if (outcome.kind === 'return' && !Object.prototype.hasOwnProperty.call(outcome, 'value')) {
    throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_UNAVAILABLE')
  }
  if (outcome.kind === 'throw' && !Object.prototype.hasOwnProperty.call(outcome, 'error')) {
    throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_UNAVAILABLE')
  }
}

function mapAcquireError(code: string): HostMutationOperationCoordinatorErrorCode {
  if (code === 'DYSON_HOST_MUTATION_LEASE_BUSY') return 'HOST_MUTATION_LEASE_BUSY'
  if (code === 'DYSON_HOST_MUTATION_LEASE_RECORD_INVALID') return 'HOST_MUTATION_LEASE_DIRTY'
  if (code === 'DYSON_HOST_MUTATION_LEASE_RECOVERY_REQUIRED') {
    return 'HOST_MUTATION_LEASE_RECOVERY_REQUIRED'
  }
  return 'HOST_MUTATION_LEASE_UNAVAILABLE'
}

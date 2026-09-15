import {
  HostMutationLeaseError,
  type HostMutationLeaseRecoveryCandidate,
  type HostMutationLeaseManager,
  type HostMutationLeaseRequest
} from './lease.js'

export type HostMutationDisposition = 'release' | 'abandon'

export interface HostMutationOperationRequest {
  operation: string
  requestId: string
  /** Recovery bindings are never accepted through the ordinary domain API. */
  readonly recovery?: never
}

export interface HostMutationRecoveryOperationRequest {
  /** Exact operation persisted by the original domain mutation lease. */
  expectedOperation: string
  /** Exact request ID persisted by the original domain mutation lease. */
  expectedRequestId: string
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

/**
 * Explicit recovery is intentionally a separate capability. Domain callers
 * provide only the expected prior domain identity; instance/digest bindings
 * are discovered and consumed inside the trusted coordinator.
 */
export interface HostMutationRecoveryOperationCoordinator {
  runRecoveryExclusive<T>(
    request: HostMutationRecoveryOperationRequest,
    operation: (
      scope: HostMutationOperationScope
    ) => Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>
  ): Promise<T>
}

export type HostMutationOperationCoordinatorErrorCode =
  | 'HOST_MUTATION_LEASE_BUSY'
  | 'HOST_MUTATION_LEASE_DIRTY'
  | 'HOST_MUTATION_LEASE_RECOVERY_REQUIRED'
  | 'HOST_MUTATION_LEASE_RECOVERY_NOT_REQUIRED'
  | 'HOST_MUTATION_LEASE_RECOVERY_MISMATCH'
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

type HostMutationLeaseRunner = Pick<HostMutationLeaseManager, 'runExclusive'> &
  Partial<Pick<HostMutationLeaseManager, 'probeRecovery'>>

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
export class HostMutationCoordinator implements
  HostMutationOperationCoordinator,
  HostMutationRecoveryOperationCoordinator {
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
    return this.#runWithLease(
      {
        dataRoot: this.#dataRoot,
        owner: this.#owner,
        operation: request.operation,
        requestId: request.requestId,
        ...(this.#acquireTimeoutMs === undefined
          ? {}
          : { acquireTimeoutMs: this.#acquireTimeoutMs })
      },
      operation,
      'ordinary'
    )
  }

  async runRecoveryExclusive<T>(
    request: HostMutationRecoveryOperationRequest,
    operation: (
      scope: HostMutationOperationScope
    ) => Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>
  ): Promise<T> {
    if (!isExactRecoveryRequest(request) ||
        !isBoundedOperation(request.expectedOperation) ||
        !isBoundedRequestId(request.expectedRequestId)) {
      throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_RECOVERY_MISMATCH')
    }
    const probeRecovery = this.#leaseRunner.probeRecovery
    if (typeof probeRecovery !== 'function') {
      throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_UNAVAILABLE')
    }

    let candidate: HostMutationLeaseRecoveryCandidate
    try {
      candidate = await probeRecovery.call(this.#leaseRunner, {
        dataRoot: this.#dataRoot,
        owner: this.#owner,
        ...(this.#acquireTimeoutMs === undefined
          ? {}
          : { acquireTimeoutMs: this.#acquireTimeoutMs })
      })
    } catch (error) {
      if (error instanceof HostMutationOperationCoordinatorError) throw error
      if (error instanceof HostMutationLeaseError) {
        throw new HostMutationOperationCoordinatorError(mapRecoveryProbeError(error.code))
      }
      throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_UNAVAILABLE')
    }

    if (candidate.priorOperation !== request.expectedOperation ||
        candidate.priorRequestId !== request.expectedRequestId) {
      throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_RECOVERY_MISMATCH')
    }

    return this.#runWithLease(
      {
        dataRoot: this.#dataRoot,
        owner: this.#owner,
        // Preserve the original domain binding across repeated abandoned
        // recovery attempts; leaseKind and recoveryOf identify this lease.
        operation: candidate.priorOperation,
        requestId: candidate.priorRequestId,
        recovery: {
          priorInstanceId: candidate.priorInstanceId,
          priorRecordDigest: candidate.priorRecordDigest
        },
        ...(this.#acquireTimeoutMs === undefined
          ? {}
          : { acquireTimeoutMs: this.#acquireTimeoutMs })
      },
      operation,
      'recovery'
    )
  }

  async #runWithLease<T>(
    request: HostMutationLeaseRequest,
    operation: (
      scope: HostMutationOperationScope
    ) => Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>,
    mode: 'ordinary' | 'recovery'
  ): Promise<T> {
    let entered = false
    try {
      const outcome = await this.#leaseRunner.runExclusive(
        request,
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
          entered
            ? 'HOST_MUTATION_LEASE_LOST'
            : mode === 'recovery'
              ? mapRecoveryAcquireError(error.code)
              : mapAcquireError(error.code)
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

function mapRecoveryProbeError(code: string): HostMutationOperationCoordinatorErrorCode {
  if (code === 'DYSON_HOST_MUTATION_LEASE_BUSY') return 'HOST_MUTATION_LEASE_BUSY'
  if (code === 'DYSON_HOST_MUTATION_LEASE_RECORD_INVALID') return 'HOST_MUTATION_LEASE_DIRTY'
  if (code === 'DYSON_HOST_MUTATION_LEASE_RECOVERY_NOT_REQUIRED') {
    return 'HOST_MUTATION_LEASE_RECOVERY_NOT_REQUIRED'
  }
  return 'HOST_MUTATION_LEASE_UNAVAILABLE'
}

function mapRecoveryAcquireError(code: string): HostMutationOperationCoordinatorErrorCode {
  if (code === 'DYSON_HOST_MUTATION_LEASE_BUSY') return 'HOST_MUTATION_LEASE_BUSY'
  if (code === 'DYSON_HOST_MUTATION_LEASE_RECORD_INVALID') return 'HOST_MUTATION_LEASE_DIRTY'
  if (code === 'DYSON_HOST_MUTATION_LEASE_RECOVERY_NOT_REQUIRED') {
    return 'HOST_MUTATION_LEASE_RECOVERY_NOT_REQUIRED'
  }
  if (code === 'DYSON_HOST_MUTATION_LEASE_RECOVERY_BINDING_INVALID' ||
      code === 'DYSON_HOST_MUTATION_LEASE_RECOVERY_REQUIRED') {
    return 'HOST_MUTATION_LEASE_RECOVERY_MISMATCH'
  }
  return 'HOST_MUTATION_LEASE_UNAVAILABLE'
}

function isBoundedOperation(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value)
}

function isBoundedRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function isExactRecoveryRequest(value: unknown): value is HostMutationRecoveryOperationRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length === 2 && keys.includes('expectedOperation') && keys.includes('expectedRequestId')
}

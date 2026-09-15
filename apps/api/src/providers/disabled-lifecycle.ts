import type {
  LifecycleAction,
  LifecycleMutationAdapter,
  LifecycleOperationContext,
  LifecyclePhaseResult,
  LifecyclePreview,
  LifecyclePreviewContext,
  StatusProvider
} from '../domain.js'

/**
 * Default lifecycle adapter used until a target host is explicitly configured.
 * It keeps preview support available while making every mutation method inert.
 */
export class DisabledLifecycleAdapter implements LifecycleMutationAdapter {
  readonly mutationEnabled = false
  readonly #statusProvider: StatusProvider

  constructor(statusProvider: StatusProvider) {
    this.#statusProvider = statusProvider
  }

  previewLifecycle(action: LifecycleAction, _context: LifecyclePreviewContext): Promise<LifecyclePreview> {
    return this.#statusProvider.previewLifecycle(action)
  }

  createProtectionPoint(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    return this.#disabled()
  }

  requestSave(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    return this.#disabled()
  }

  requestGracefulStop(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    return this.#disabled()
  }

  verifyStopped(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    return this.#disabled()
  }

  requestStart(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    return this.#disabled()
  }

  verifyRunning(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    return this.#disabled()
  }

  requestRollbackStart(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    return this.#disabled()
  }

  #disabled(): Promise<never> {
    return Promise.reject(new Error('Lifecycle mutations are disabled'))
  }
}

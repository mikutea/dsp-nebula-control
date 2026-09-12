import {
  ObservabilityAlertEpisodeStateMachine,
  type AcknowledgeObservabilityAlertInput,
  type ObservabilityAlertEpisode,
  type ObservabilityAlertEpisodeIdFactory,
  type ObservabilityAlertProjection,
  type ObservabilityAlertStateMachineOptions
} from './alerts.js'

export interface StoredObservabilityAlertState {
  revision: number
  payload: string
}

export interface ObservabilityAlertStateStore {
  read(): StoredObservabilityAlertState | null
  /** Must atomically compare expectedRevision and publish the next payload. */
  write(expectedRevision: number | null, payload: string): number
}

export type PersistentObservabilityAlertErrorCode =
  | 'OBSERVABILITY_ALERT_PERSISTENCE_READ_FAILED'
  | 'OBSERVABILITY_ALERT_PERSISTENCE_STATE_INVALID'
  | 'OBSERVABILITY_ALERT_PERSISTENCE_CONFIGURATION_MISMATCH'
  | 'OBSERVABILITY_ALERT_PERSISTENCE_WRITE_UNCERTAIN'
  | 'OBSERVABILITY_ALERT_PERSISTENCE_RECOVERY_REQUIRED'

export class PersistentObservabilityAlertError extends Error {
  constructor(
    readonly code: PersistentObservabilityAlertErrorCode,
    options?: ErrorOptions
  ) {
    super(code, options)
    this.name = 'PersistentObservabilityAlertError'
  }
}

export interface PersistentObservabilityAlertsOptions extends ObservabilityAlertStateMachineOptions {
  store: ObservabilityAlertStateStore
}

/**
 * Transactional persistence wrapper around the pure alert reducer. Mutations
 * are applied to an isolated candidate, compare-and-swap persisted, and only
 * then published in memory. An uncertain write permanently closes mutations
 * for this instance so a restart can reconcile the authoritative store.
 */
export class PersistentObservabilityAlerts {
  readonly #store: ObservabilityAlertStateStore
  readonly #idFactory: ObservabilityAlertEpisodeIdFactory | undefined
  #machine: ObservabilityAlertEpisodeStateMachine
  #revision: number | null
  #recoveryRequired = false

  constructor(options: PersistentObservabilityAlertsOptions) {
    const { store, capacity, resolveAfterMissingSamples, idFactory } = options
    if (!store || typeof store.read !== 'function' || typeof store.write !== 'function') {
      throw new PersistentObservabilityAlertError('OBSERVABILITY_ALERT_PERSISTENCE_STATE_INVALID')
    }
    this.#store = store
    this.#idFactory = idFactory

    let stored: StoredObservabilityAlertState | null
    try {
      stored = store.read()
    } catch (error) {
      throw new PersistentObservabilityAlertError(
        'OBSERVABILITY_ALERT_PERSISTENCE_READ_FAILED', { cause: error }
      )
    }
    if (stored === null) {
      try {
        this.#machine = new ObservabilityAlertEpisodeStateMachine({
          capacity,
          resolveAfterMissingSamples,
          idFactory
        })
      } catch (error) {
        throw persistenceStateError(error)
      }
      this.#revision = null
      return
    }
    if (!isValidRevision(stored.revision) || typeof stored.payload !== 'string') {
      throw new PersistentObservabilityAlertError('OBSERVABILITY_ALERT_PERSISTENCE_STATE_INVALID')
    }
    try {
      this.#machine = ObservabilityAlertEpisodeStateMachine.hydrate(stored.payload, { idFactory })
    } catch (error) {
      throw persistenceStateError(error)
    }
    if ((capacity !== undefined && capacity !== this.#machine.capacity) ||
        (resolveAfterMissingSamples !== undefined &&
          resolveAfterMissingSamples !== this.#machine.resolveAfterMissingSamples)) {
      throw new PersistentObservabilityAlertError(
        'OBSERVABILITY_ALERT_PERSISTENCE_CONFIGURATION_MISMATCH'
      )
    }
    this.#revision = stored.revision
  }

  get revision(): number | null {
    return this.#revision
  }

  get recoveryRequired(): boolean {
    return this.#recoveryRequired
  }

  ingest(input: unknown): ObservabilityAlertProjection {
    this.#assertWritable()
    const candidate = this.#candidate()
    const projection = candidate.ingest(input)
    this.#commit(candidate)
    return projection
  }

  acknowledge(input: AcknowledgeObservabilityAlertInput | unknown): ObservabilityAlertEpisode {
    this.#assertWritable()
    const candidate = this.#candidate()
    const episode = candidate.acknowledge(input)
    this.#commit(candidate)
    return episode
  }

  list(): ObservabilityAlertEpisode[] {
    return this.#machine.list()
  }

  project(): ObservabilityAlertProjection {
    return this.#machine.project()
  }

  #candidate(): ObservabilityAlertEpisodeStateMachine {
    try {
      return ObservabilityAlertEpisodeStateMachine.hydrate(
        this.#machine.serialize(),
        { idFactory: this.#idFactory }
      )
    } catch (error) {
      throw persistenceStateError(error)
    }
  }

  #commit(candidate: ObservabilityAlertEpisodeStateMachine): void {
    const currentPayload = this.#machine.serializeJson()
    const nextPayload = candidate.serializeJson()
    if (nextPayload === currentPayload) return

    let nextRevision: number
    try {
      nextRevision = this.#store.write(this.#revision, nextPayload)
    } catch (error) {
      this.#recoveryRequired = true
      throw new PersistentObservabilityAlertError(
        'OBSERVABILITY_ALERT_PERSISTENCE_WRITE_UNCERTAIN', { cause: error }
      )
    }
    if (!isValidRevision(nextRevision) ||
        (this.#revision !== null && nextRevision <= this.#revision)) {
      this.#recoveryRequired = true
      throw new PersistentObservabilityAlertError(
        'OBSERVABILITY_ALERT_PERSISTENCE_WRITE_UNCERTAIN'
      )
    }
    this.#machine = candidate
    this.#revision = nextRevision
  }

  #assertWritable(): void {
    if (this.#recoveryRequired) {
      throw new PersistentObservabilityAlertError(
        'OBSERVABILITY_ALERT_PERSISTENCE_RECOVERY_REQUIRED'
      )
    }
  }
}

function isValidRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function persistenceStateError(error: unknown): PersistentObservabilityAlertError {
  return new PersistentObservabilityAlertError(
    'OBSERVABILITY_ALERT_PERSISTENCE_STATE_INVALID',
    { cause: error }
  )
}

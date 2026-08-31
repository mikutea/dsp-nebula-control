import type { ControlDatabase } from '../storage/database.js'
import { ObservabilityError } from './errors.js'
import { BoundedObservabilityHistory } from './history.js'
import { parseServerObservabilitySnapshot } from './snapshot.js'
import type {
  ObservabilityDownsampleResult,
  ServerObservabilitySnapshot
} from './types.js'

export interface ObservabilityHistoryStore {
  readonly capacity: number
  readonly size: number
  readonly droppedSamples: number
  ingest(input: unknown): ServerObservabilitySnapshot
  latest(): ServerObservabilitySnapshot | null
  list(): ServerObservabilitySnapshot[]
  downsample(maxPoints: number): ObservabilityDownsampleResult
}

/**
 * Keeps the bounded in-memory query model while persisting every accepted,
 * already-redacted snapshot in the control database. Reopening the process
 * reconstructs the same chronological window instead of resetting charts.
 */
export class PersistentObservabilityHistory implements ObservabilityHistoryStore {
  readonly #database: ControlDatabase
  readonly #history: BoundedObservabilityHistory
  readonly #capacity: number

  constructor(database: ControlDatabase, capacity = 720) {
    this.#database = database
    this.#history = new BoundedObservabilityHistory(capacity)
    this.#capacity = capacity
    for (const payload of database.listObservabilitySamples(capacity)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(payload)
      } catch (error) {
        throw new ObservabilityError('OBSERVABILITY_PERSISTENCE_INVALID', error)
      }
      try {
        this.#history.ingest(parsed)
      } catch (error) {
        throw new ObservabilityError('OBSERVABILITY_PERSISTENCE_INVALID', error)
      }
    }
  }

  get capacity(): number {
    return this.#history.capacity
  }

  get size(): number {
    return this.#history.size
  }

  get droppedSamples(): number {
    return this.#history.droppedSamples
  }

  ingest(input: unknown): ServerObservabilitySnapshot {
    const snapshot = parseServerObservabilitySnapshot(input)
    const latest = this.#history.latest()
    if (latest !== null && Date.parse(snapshot.observedAt) < Date.parse(latest.observedAt)) {
      throw new ObservabilityError('OBSERVABILITY_HISTORY_TIME_REGRESSION')
    }
    try {
      this.#database.appendObservabilitySample(snapshot.observedAt, JSON.stringify(snapshot), this.#capacity)
    } catch (error) {
      throw new ObservabilityError('OBSERVABILITY_PERSISTENCE_FAILED', error)
    }
    return this.#history.ingest(snapshot)
  }

  latest(): ServerObservabilitySnapshot | null {
    return this.#history.latest()
  }

  list(): ServerObservabilitySnapshot[] {
    return this.#history.list()
  }

  downsample(maxPoints: number): ObservabilityDownsampleResult {
    return this.#history.downsample(maxPoints)
  }
}

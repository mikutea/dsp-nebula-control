import type { ControlDatabase } from '../storage/database.js'
import { ObservabilityError } from './errors.js'
import { BoundedObservabilityHistory } from './history.js'
import { parseServerObservabilitySnapshot } from './snapshot.js'
import {
  BoundedObservabilityLongWindow,
  DEFAULT_OBSERVABILITY_LONG_WINDOW_CAPACITY,
  type ObservabilityLongWindowReport,
  type ObservabilityLongWindowSample
} from './long-window.js'
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
  readonly longWindowCapacity?: number
  longWindowReport?(): ObservabilityLongWindowReport
}

/**
 * Keeps the bounded in-memory query model while persisting every accepted,
 * already-redacted snapshot in the control database. Reopening the process
 * reconstructs the same chronological window instead of resetting charts.
 */
export class PersistentObservabilityHistory implements ObservabilityHistoryStore {
  readonly #database: ControlDatabase
  readonly #history: BoundedObservabilityHistory
  readonly #longWindow: BoundedObservabilityLongWindow
  readonly #capacity: number

  constructor(
    database: ControlDatabase,
    capacity = 720,
    longWindowCapacity = DEFAULT_OBSERVABILITY_LONG_WINDOW_CAPACITY
  ) {
    this.#database = database
    this.#history = new BoundedObservabilityHistory(capacity)
    this.#longWindow = new BoundedObservabilityLongWindow(longWindowCapacity)
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
    for (const payload of database.listObservabilityLongSamples(longWindowCapacity)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(payload)
      } catch (error) {
        throw new ObservabilityError('OBSERVABILITY_LONG_WINDOW_PERSISTENCE_INVALID', error)
      }
      try {
        this.#longWindow.ingest(parsed)
      } catch (error) {
        throw new ObservabilityError('OBSERVABILITY_LONG_WINDOW_PERSISTENCE_INVALID', error)
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

  get longWindowCapacity(): number { return this.#longWindow.capacity }
  get longWindowSize(): number { return this.#longWindow.size }
  get longWindowDroppedSamples(): number { return this.#longWindow.droppedSamples }

  ingest(input: unknown): ServerObservabilitySnapshot {
    const snapshot = parseServerObservabilitySnapshot(input)
    const latest = this.#history.latest()
    if (latest !== null && Date.parse(snapshot.observedAt) < Date.parse(latest.observedAt)) {
      throw new ObservabilityError('OBSERVABILITY_HISTORY_TIME_REGRESSION')
    }
    const longSample = this.#longWindow.prepare(snapshot)
    try {
      this.#database.appendObservabilitySampleWithLongWindow(
        snapshot.observedAt,
        JSON.stringify(snapshot),
        this.#capacity,
        JSON.stringify(longSample),
        this.#longWindow.capacity
      )
    } catch (error) {
      throw new ObservabilityError('OBSERVABILITY_PERSISTENCE_FAILED', error)
    }
    const stored = this.#history.ingest(snapshot)
    this.#longWindow.ingest(longSample)
    return stored
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

  listLongWindow(): ObservabilityLongWindowSample[] {
    return this.#longWindow.list()
  }

  longWindowReport(): ObservabilityLongWindowReport {
    return this.#longWindow.report()
  }
}

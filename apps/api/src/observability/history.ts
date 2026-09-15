import { ObservabilityError } from './errors.js'
import { parseServerObservabilitySnapshot } from './snapshot.js'
import type {
  NumericMetricAggregate,
  ObservabilityDownsamplePoint,
  ObservabilityDownsampleResult,
  ObservabilityHealthStatus,
  ObservabilityMetric,
  ServerObservabilitySnapshot
} from './types.js'

const maximumHistoryCapacity = 4_096
const maximumDownsamplePoints = 1_024

export class BoundedObservabilityHistory {
  readonly #capacity: number
  readonly #buffer: Array<ServerObservabilitySnapshot | undefined>
  #start = 0
  #size = 0
  #droppedSamples = 0
  #lastObservedAtUnixMs: number | null = null

  constructor(capacity = 720) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > maximumHistoryCapacity) {
      throw new ObservabilityError('OBSERVABILITY_HISTORY_LIMIT_INVALID')
    }
    this.#capacity = capacity
    this.#buffer = new Array<ServerObservabilitySnapshot | undefined>(capacity)
  }

  get capacity(): number {
    return this.#capacity
  }

  get size(): number {
    return this.#size
  }

  get droppedSamples(): number {
    return this.#droppedSamples
  }

  ingest(input: unknown): ServerObservabilitySnapshot {
    const snapshot = parseServerObservabilitySnapshot(input)
    const observedAtUnixMs = Date.parse(snapshot.observedAt)
    if (this.#lastObservedAtUnixMs !== null && observedAtUnixMs < this.#lastObservedAtUnixMs) {
      throw new ObservabilityError('OBSERVABILITY_HISTORY_TIME_REGRESSION')
    }

    const stored = structuredClone(snapshot)
    if (this.#size < this.#capacity) {
      const index = (this.#start + this.#size) % this.#capacity
      this.#buffer[index] = stored
      this.#size++
    } else {
      this.#buffer[this.#start] = stored
      this.#start = (this.#start + 1) % this.#capacity
      this.#droppedSamples++
    }
    this.#lastObservedAtUnixMs = observedAtUnixMs
    return structuredClone(stored)
  }

  latest(): ServerObservabilitySnapshot | null {
    if (this.#size === 0) return null
    const snapshot = this.#buffer[(this.#start + this.#size - 1) % this.#capacity]
    return snapshot === undefined ? null : structuredClone(snapshot)
  }

  list(): ServerObservabilitySnapshot[] {
    const snapshots: ServerObservabilitySnapshot[] = []
    for (let offset = 0; offset < this.#size; offset++) {
      const snapshot = this.#buffer[(this.#start + offset) % this.#capacity]
      if (snapshot !== undefined) snapshots.push(structuredClone(snapshot))
    }
    return snapshots
  }

  downsample(maxPoints: number): ObservabilityDownsampleResult {
    if (!Number.isInteger(maxPoints) || maxPoints < 1 || maxPoints > maximumDownsamplePoints) {
      throw new ObservabilityError('OBSERVABILITY_DOWNSAMPLE_LIMIT_INVALID')
    }
    const snapshots = this.list()
    if (snapshots.length === 0) {
      return {
        schemaVersion: 1,
        kind: 'server-observability-downsample',
        retainedSamples: 0,
        droppedSamples: this.#droppedSamples,
        points: []
      }
    }

    const pointCount = Math.min(maxPoints, snapshots.length)
    const points: ObservabilityDownsamplePoint[] = []
    for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
      const start = Math.floor((pointIndex * snapshots.length) / pointCount)
      const end = Math.floor(((pointIndex + 1) * snapshots.length) / pointCount)
      points.push(aggregatePoint(snapshots.slice(start, end)))
    }
    return {
      schemaVersion: 1,
      kind: 'server-observability-downsample',
      retainedSamples: snapshots.length,
      droppedSamples: this.#droppedSamples,
      points
    }
  }

  clear(): void {
    this.#buffer.fill(undefined)
    this.#start = 0
    this.#size = 0
    this.#droppedSamples = 0
    this.#lastObservedAtUnixMs = null
  }
}

function aggregatePoint(snapshots: ServerObservabilitySnapshot[]): ObservabilityDownsamplePoint {
  const first = snapshots[0]
  const last = snapshots[snapshots.length - 1]
  if (first === undefined || last === undefined) {
    throw new ObservabilityError('OBSERVABILITY_SNAPSHOT_INVALID')
  }

  let stateTransitions = 0
  for (let index = 1; index < snapshots.length; index++) {
    if (snapshots[index]?.runtime.state !== snapshots[index - 1]?.runtime.state) stateTransitions++
  }

  return {
    schemaVersion: 1,
    kind: 'server-observability-downsample-point',
    from: first.observedAt,
    to: last.observedAt,
    sampleCount: snapshots.length,
    metrics: {
      hostCpuPercent: aggregateNumeric(snapshots, (snapshot) => snapshot.host.cpu.totalPercent),
      hottestCorePercent: aggregateNumeric(snapshots, hottestCoreMetric),
      memoryUsedPercent: aggregateNumeric(snapshots, (snapshot) => snapshot.host.memory.usedPercent),
      availableMemoryBytes: aggregateNumeric(snapshots, (snapshot) => snapshot.host.memory.availableBytes),
      projectVolumeUsedPercent: aggregateNumeric(
        snapshots,
        (snapshot) => snapshot.host.storage.projectVolume.usedPercent
      ),
      projectVolumeAvailableBytes: aggregateNumeric(
        snapshots,
        (snapshot) => snapshot.host.storage.projectVolume.availableBytes
      ),
      saveVolumeUsedPercent: aggregateNumeric(
        snapshots,
        (snapshot) => snapshot.host.storage.saveVolume.usedPercent
      ),
      saveVolumeAvailableBytes: aggregateNumeric(
        snapshots,
        (snapshot) => snapshot.host.storage.saveVolume.availableBytes
      ),
      networkReceiveBytesPerSecond: aggregateNumeric(
        snapshots,
        (snapshot) => snapshot.host.network.receiveBytesPerSecond
      ),
      networkSendBytesPerSecond: aggregateNumeric(
        snapshots,
        (snapshot) => snapshot.host.network.sendBytesPerSecond
      ),
      networkInterfaceCount: aggregateNumeric(
        snapshots,
        (snapshot) => snapshot.host.network.sampledInterfaceCount
      ),
      processCpuPercent: aggregateNumeric(snapshots, (snapshot) => snapshot.process.cpuPercent),
      processCpuCoresUsed: aggregateNumeric(snapshots, (snapshot) => snapshot.process.cpuCoresUsed),
      processWorkingSetBytes: aggregateNumeric(snapshots, (snapshot) => snapshot.process.workingSetBytes),
      processPrivateBytes: aggregateNumeric(snapshots, (snapshot) => snapshot.process.privateBytes),
      ups: aggregateNumeric(snapshots, (snapshot) => snapshot.simulation.ups),
      tps: aggregateNumeric(snapshots, (snapshot) => snapshot.simulation.tps)
    },
    runtime: {
      lastState: last.runtime.state,
      stateTransitions,
      lastGamePortListening: structuredClone(last.runtime.gamePort.listening)
    },
    health: {
      worstStatus: worstHealthStatus(snapshots.map((snapshot) => snapshot.health.status)),
      hintCodes: [...new Set(snapshots.flatMap((snapshot) => snapshot.health.hints.map((hint) => hint.code)))]
        .sort((left, right) => left.localeCompare(right, 'en-US'))
    }
  }
}

function hottestCoreMetric(snapshot: ServerObservabilitySnapshot): ObservabilityMetric<number> {
  const perCore = snapshot.host.cpu.perCorePercent
  if (perCore.status === 'unavailable') return { ...perCore }
  return { status: 'available', value: Math.max(...perCore.value.map((core) => core.percent)) }
}

function aggregateNumeric(
  snapshots: ServerObservabilitySnapshot[],
  select: (snapshot: ServerObservabilitySnapshot) => ObservabilityMetric<number>
): NumericMetricAggregate {
  let observedSamples = 0
  let unavailableSamples = 0
  let minimum = Number.POSITIVE_INFINITY
  let maximum = Number.NEGATIVE_INFINITY
  let average = 0
  let last = 0

  for (const snapshot of snapshots) {
    const metric = select(snapshot)
    if (metric.status === 'unavailable') {
      unavailableSamples++
      continue
    }
    observedSamples++
    minimum = Math.min(minimum, metric.value)
    maximum = Math.max(maximum, metric.value)
    average += (metric.value - average) / observedSamples
    last = metric.value
  }

  if (observedSamples === 0) {
    return { status: 'unavailable', observedSamples: 0, unavailableSamples }
  }
  return { status: 'available', observedSamples, unavailableSamples, minimum, maximum, average, last }
}

function worstHealthStatus(statuses: ObservabilityHealthStatus[]): ObservabilityHealthStatus {
  const rank: Record<ObservabilityHealthStatus, number> = {
    healthy: 0,
    unknown: 1,
    warning: 2,
    critical: 3
  }
  return statuses.reduce((worst, status) => rank[status] > rank[worst] ? status : worst, 'healthy')
}

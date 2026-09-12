import { describe, expect, it } from 'vitest'
import { ObservabilityError } from './errors.js'
import { BoundedObservabilityHistory } from './history.js'
import { buildServerObservabilitySnapshot } from './snapshot.js'
import type { ObservabilityRuntimeState } from './types.js'

const baseTime = Date.parse('2026-08-30T12:00:00.000Z')

describe('bounded server observability history', () => {
  it('uses a fixed-size ring, evicts oldest samples, and returns defensive copies', () => {
    const history = new BoundedObservabilityHistory(3)
    for (let index = 0; index < 5; index++) history.ingest(snapshot(index, 10 + index))

    expect(history.capacity).toBe(3)
    expect(history.size).toBe(3)
    expect(history.droppedSamples).toBe(2)
    expect(history.list().map((entry) => entry.observedAt)).toEqual([
      observedAt(2), observedAt(3), observedAt(4)
    ])

    const latest = history.latest()!
    latest.source = 'mutated.fixture'
    expect(history.latest()?.source).toBe('fixture.observability')
    const listed = history.list()
    if (listed[0]?.host.cpu.totalPercent.status === 'available') {
      listed[0].host.cpu.totalPercent.value = 99
    }
    expect(history.list()[0]?.host.cpu.totalPercent).toEqual({ status: 'available', value: 12 })
  })

  it('rejects invalid bounds, invalid snapshots, and time regression', () => {
    expectCode(() => new BoundedObservabilityHistory(0), 'OBSERVABILITY_HISTORY_LIMIT_INVALID')
    expectCode(() => new BoundedObservabilityHistory(4_097), 'OBSERVABILITY_HISTORY_LIMIT_INVALID')

    const history = new BoundedObservabilityHistory(4)
    history.ingest(snapshot(2, 20))
    expectCode(() => history.ingest(snapshot(1, 10)), 'OBSERVABILITY_HISTORY_TIME_REGRESSION')
    expectCode(() => history.ingest({ observedAt: observedAt(3) }), 'OBSERVABILITY_SNAPSHOT_INVALID')
    expectCode(() => history.downsample(0), 'OBSERVABILITY_DOWNSAMPLE_LIMIT_INVALID')
    expectCode(() => history.downsample(1_025), 'OBSERVABILITY_DOWNSAMPLE_LIMIT_INVALID')
  })

  it('downsamples contiguous ranges with extrema, averages, last values, and missing counts', () => {
    const history = new BoundedObservabilityHistory(8)
    history.ingest(snapshot(0, 10, 50))
    history.ingest(snapshot(1, 20, null))
    history.ingest(snapshot(2, 30, 30))
    history.ingest(snapshot(3, 40, 25))
    history.ingest(snapshot(4, 50, 20))
    history.ingest(snapshot(5, 96, 15))

    const result = history.downsample(2)
    expect(result).toMatchObject({
      schemaVersion: 1,
      kind: 'server-observability-downsample',
      retainedSamples: 6,
      droppedSamples: 0
    })
    expect(result.points).toHaveLength(2)
    expect(result.points[0]).toMatchObject({
      from: observedAt(0),
      to: observedAt(2),
      sampleCount: 3,
      metrics: {
        hostCpuPercent: {
          status: 'available', observedSamples: 3, unavailableSamples: 0,
          minimum: 10, maximum: 30, average: 20, last: 30
        },
        ups: {
          status: 'available', observedSamples: 2, unavailableSamples: 1,
          minimum: 30, maximum: 50, average: 40, last: 30
        }
      }
    })
    expect(result.points[1]?.health.worstStatus).toBe('critical')
    expect(result.points[1]?.health.hintCodes).toContain('HOST_CPU_SATURATED')
  })

  it('retains explicit unavailable aggregates and runtime transitions', () => {
    const history = new BoundedObservabilityHistory(4)
    const first = snapshot(0, 20, null, 'starting')
    const second = snapshot(1, 25, null, 'running', false)
    history.ingest(first)
    history.ingest(second)

    const point = history.downsample(1).points[0]
    expect(point?.metrics.ups).toEqual({
      status: 'unavailable', observedSamples: 0, unavailableSamples: 2
    })
    expect(point?.metrics.networkReceiveBytesPerSecond).toEqual({
      status: 'available', observedSamples: 1, unavailableSamples: 1,
      minimum: 10_000, maximum: 10_000, average: 10_000, last: 10_000
    })
    expect(point?.metrics.saveVolumeUsedPercent).toEqual({
      status: 'available', observedSamples: 1, unavailableSamples: 1,
      minimum: 50, maximum: 50, average: 50, last: 50
    })
    expect(point?.runtime).toMatchObject({
      lastState: 'running', stateTransitions: 1,
      lastGamePortListening: { status: 'available', value: true }
    })
  })

  it('clears retained and eviction state', () => {
    const history = new BoundedObservabilityHistory(1)
    history.ingest(snapshot(0, 10))
    history.ingest(snapshot(1, 20))
    history.clear()
    expect(history.size).toBe(0)
    expect(history.droppedSamples).toBe(0)
    expect(history.latest()).toBeNull()
    expect(history.downsample(1).points).toEqual([])
  })
})

function snapshot(
  index: number,
  cpuPercent: number,
  ups: number | null = 60,
  state: ObservabilityRuntimeState = 'running',
  extendedTelemetry = true
) {
  return buildServerObservabilitySnapshot({
    schemaVersion: 1,
    observedAt: observedAt(index),
    source: 'fixture.observability',
    runtime: { state, processId: 4242 },
    host: {
      cpu: {
        logicalProcessorCount: 2,
        totalPercent: cpuPercent,
        cores: [{ index: 0, percent: cpuPercent }, { index: 1, percent: cpuPercent / 2 }]
      },
      memory: { totalBytes: 1_000_000, availableBytes: 500_000 },
      storage: extendedTelemetry
        ? {
            projectVolume: { totalBytes: 2_000_000, availableBytes: 1_000_000 },
            saveVolume: { totalBytes: 2_000_000, availableBytes: 1_000_000 }
          }
        : null,
      network: extendedTelemetry
        ? { receiveBytesPerSecond: 10_000 + index, sendBytesPerSecond: 5_000 + index, sampledInterfaceCount: 2 }
        : null
    },
    process: {
      cpuPercent: Math.min(cpuPercent, 100),
      cpuCoresUsed: 1.25,
      workingSetBytes: 250_000 + index * 1_000,
      privateBytes: 300_000 + index * 1_000,
      threadCount: 200
    },
    network: { gamePort: { port: 8469, listening: true } },
    simulation: { ups, tps: ups, targetUps: 60 },
    automation: { storageDependencyKind: 'none', projectRootAvailable: true }
  })
}

function observedAt(index: number): string {
  return new Date(baseTime + index * 1_000).toISOString()
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error(`expected ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(ObservabilityError)
    expect((error as ObservabilityError).code).toBe(code)
  }
}

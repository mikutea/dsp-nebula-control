import { describe, expect, it } from 'vitest'
import { ObservabilityError } from './errors.js'
import {
  buildServerObservabilitySnapshot,
  parseServerObservabilitySnapshot,
  type TrustedServerObservabilitySample
} from './snapshot.js'

const gibibyte = 1_024 ** 3

describe('server observability snapshot builder', () => {
  it('normalizes trusted metrics, derives only explicit arithmetic, and reports bottlenecks', () => {
    const snapshot = buildServerObservabilitySnapshot(sample())

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      kind: 'server-observability-snapshot',
      source: 'fixture.windows-status',
      runtime: {
        state: 'running',
        processId: { status: 'available', value: 4242 },
        startedAt: { status: 'available', value: '2026-08-30T11:00:00.000Z' },
        gamePort: {
          port: { status: 'available', value: 8469 },
          listening: { status: 'available', value: true }
        }
      },
      host: {
        cpu: {
          logicalProcessorCount: { status: 'available', value: 4 },
          totalPercent: { status: 'available', value: 50 },
          perCorePercent: { status: 'available' }
        },
        memory: {
          totalBytes: { status: 'available', value: 16 * gibibyte },
          availableBytes: { status: 'available', value: 8 * gibibyte },
          usedBytes: { status: 'available', value: 8 * gibibyte },
          usedPercent: { status: 'available', value: 50 }
        },
        storage: {
          projectVolume: { usedPercent: { status: 'available', value: 50 } },
          saveVolume: { usedPercent: { status: 'available', value: 25 } }
        },
        network: {
          receiveBytesPerSecond: { status: 'available', value: 125_000 },
          sendBytesPerSecond: { status: 'available', value: 48_000 },
          sampledInterfaceCount: { status: 'available', value: 2 }
        }
      }
    })
    expect(snapshot.host.cpu.perCorePercent).toEqual({
      status: 'available',
      value: [
        { index: 0, percent: 97 },
        { index: 1, percent: 35 },
        { index: 2, percent: 34 },
        { index: 3, percent: 34 }
      ]
    })
    expect(snapshot.health.status).toBe('warning')
    expect(snapshot.health.hints.map((hint) => hint.code)).toEqual(expect.arrayContaining([
      'SINGLE_CORE_SATURATION', 'SIMULATION_BELOW_TARGET'
    ]))
  })

  it('marks absent UPS and TPS as unavailable without manufacturing zero values', () => {
    const input = sample()
    delete input.simulation
    const snapshot = buildServerObservabilitySnapshot(input)

    expect(snapshot.simulation).toEqual({
      ups: { status: 'unavailable', reason: 'not-provided' },
      tps: { status: 'unavailable', reason: 'not-provided' },
      targetUps: { status: 'unavailable', reason: 'not-provided' }
    })
    expect(snapshot.health.hints).toContainEqual(expect.objectContaining({
      code: 'SIMULATION_TELEMETRY_UNAVAILABLE', severity: 'info'
    }))
    expect(JSON.stringify(snapshot.simulation)).not.toContain('"value":0')
  })

  it('marks missing stopped-process measurements as not applicable to a stopped process', () => {
    const input = sample()
    input.runtime = { state: 'stopped' }
    delete input.process
    input.network = { gamePort: { port: 8469, listening: false } }
    delete input.simulation
    const snapshot = buildServerObservabilitySnapshot(input)

    expect(snapshot.runtime.processId).toEqual({ status: 'unavailable', reason: 'process-not-running' })
    expect(snapshot.process.workingSetBytes).toEqual({
      status: 'unavailable', reason: 'process-not-running'
    })
    expect(snapshot.health.status).toBe('warning')
    expect(snapshot.health.hints.map((hint) => hint.code)).toContain('SINGLE_CORE_SATURATION')
  })

  it('reports critical host, process, port, and simulation pressure from supplied values', () => {
    const input = sample()
    input.host.cpu!.totalPercent = 97
    input.host.memory = { totalBytes: 100_000, availableBytes: 2_000 }
    input.process = {
      cpuPercent: 96,
      workingSetBytes: 95_000,
      privateBytes: 96_000,
      threadCount: 300
    }
    input.network = { gamePort: { port: 8469, listening: false } }
    input.simulation = { ups: 20, tps: 18, targetUps: 60 }
    const snapshot = buildServerObservabilitySnapshot(input)

    expect(snapshot.health.status).toBe('critical')
    expect(snapshot.health.hints.map((hint) => hint.code)).toEqual(expect.arrayContaining([
      'HOST_CPU_SATURATED',
      'MEMORY_EXHAUSTION',
      'PROCESS_CPU_PRESSURE',
      'PROCESS_MEMORY_DOMINANT',
      'GAME_PORT_NOT_LISTENING',
      'SIMULATION_BELOW_TARGET'
    ]))
  })

  it('reports bounded project/save volume pressure and explicit unavailable network collection', () => {
    const input = sample()
    input.host.storage = {
      projectVolume: { totalBytes: 100_000, availableBytes: 4_000 },
      saveVolume: { totalBytes: 100_000, availableBytes: 10_000 }
    }
    input.host.network = {
      receiveBytesPerSecond: null,
      sendBytesPerSecond: null,
      sampledInterfaceCount: null,
      unavailableReason: 'network-counters-unavailable'
    }
    const snapshot = buildServerObservabilitySnapshot(input)

    expect(snapshot.health.status).toBe('critical')
    expect(snapshot.health.hints).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PROJECT_VOLUME_EXHAUSTION', severity: 'critical' }),
      expect.objectContaining({ code: 'SAVE_VOLUME_PRESSURE', severity: 'warning' }),
      expect.objectContaining({ code: 'NETWORK_TELEMETRY_UNAVAILABLE', severity: 'info' })
    ]))
    expect(snapshot.host.network.receiveBytesPerSecond).toEqual({
      status: 'unavailable', reason: 'network-counters-unavailable'
    })
  })

  it('keeps an otherwise quiet snapshot unknown when essential health inputs are missing', () => {
    const input = sample()
    input.host = {}
    input.network = null
    input.process = null
    input.simulation = null
    const snapshot = buildServerObservabilitySnapshot(input)

    expect(snapshot.health.status).toBe('unknown')
    expect(snapshot.health.hints).toContainEqual(expect.objectContaining({ code: 'OBSERVABILITY_INCOMPLETE' }))
    expect(snapshot.health.unavailableMetrics).toEqual(expect.arrayContaining([
      'host.cpu.totalPercent', 'host.memory.usedPercent', 'runtime.gamePort.listening'
    ]))
  })

  it('fails closed when the project root, SMB mapping, or recovery task is unhealthy', () => {
    const input = sample()
    input.automation = {
      storageDependencyKind: 'smb-global-mapping',
      projectRootAvailable: false,
      globalMappingAvailable: false,
      storageTask: { state: 'disabled', lastResult: 1312 }
    }
    const snapshot = buildServerObservabilitySnapshot(input)

    expect(snapshot.health.status).toBe('critical')
    expect(snapshot.health.hints).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PROJECT_ROOT_UNAVAILABLE', severity: 'critical' }),
      expect.objectContaining({ code: 'SMB_GLOBAL_MAPPING_UNAVAILABLE', severity: 'critical' }),
      expect.objectContaining({ code: 'STORAGE_RECOVERY_TASK_FAILED', severity: 'critical' })
    ]))
  })

  it('does not require SMB-only metrics for a classified non-SMB project root', () => {
    const snapshot = buildServerObservabilitySnapshot(sample())
    expect(snapshot.automation.storageDependencyKind).toBe('none')
    expect(snapshot.automation.globalMappingAvailable.status).toBe('unavailable')
    expect(snapshot.health.hints.map((hint) => hint.code)).toEqual(expect.not.arrayContaining([
      'STORAGE_DEPENDENCY_UNCLASSIFIED', 'OBSERVABILITY_INCOMPLETE'
    ]))
  })

  it('rejects non-finite, out-of-range, oversized, and unknown input values', () => {
    const invalidValues: unknown[] = [
      withMutation((input) => { input.host.cpu!.totalPercent = Number.NaN }),
      withMutation((input) => { input.process!.workingSetBytes = Number.POSITIVE_INFINITY }),
      withMutation((input) => { input.host.cpu!.cores![0]!.percent = 101 }),
      withMutation((input) => { input.host.network!.receiveBytesPerSecond = -1 }),
      withMutation((input) => { input.host.network!.sendBytesPerSecond = null }),
      withMutation((input) => {
        Object.assign(input.host.network!, {
          receiveBytesPerSecond: null,
          sendBytesPerSecond: null,
          sampledInterfaceCount: null,
          unavailableReason: 'volume-unavailable'
        })
      }),
      withMutation((input) => {
        Object.assign(input.host.storage!.projectVolume!, {
          totalBytes: null,
          availableBytes: null,
          unavailableReason: 'network-counters-unavailable'
        })
      }),
      withMutation((input) => { input.source = 'x'.repeat(65) }),
      withMutation((input) => { input.process!.workingSetBytes = Number.MAX_SAFE_INTEGER + 1 }),
      { ...sample(), hostPath: 'C:\\Fictional' }
    ]
    for (const invalid of invalidValues) {
      expectObservabilityCode(() => buildServerObservabilitySnapshot(invalid), 'OBSERVABILITY_SAMPLE_INVALID')
    }
  })

  it('rejects duplicate or incomplete per-core sets and inconsistent memory totals', () => {
    expectObservabilityCode(() => buildServerObservabilitySnapshot(withMutation((input) => {
      input.host.cpu!.cores![1]!.index = 0
    })), 'OBSERVABILITY_CPU_CORE_DUPLICATE')

    expectObservabilityCode(() => buildServerObservabilitySnapshot(withMutation((input) => {
      input.host.cpu!.logicalProcessorCount = 8
    })), 'OBSERVABILITY_CPU_CORE_COUNT_MISMATCH')

    expectObservabilityCode(() => buildServerObservabilitySnapshot(withMutation((input) => {
      input.host.memory = { totalBytes: 1_000, availableBytes: 1_001 }
    })), 'OBSERVABILITY_MEMORY_RANGE_INVALID')

    expectObservabilityCode(() => buildServerObservabilitySnapshot(withMutation((input) => {
      input.host.storage!.saveVolume = { totalBytes: 1_000, availableBytes: 1_001 }
    })), 'OBSERVABILITY_VOLUME_RANGE_INVALID')
  })

  it('validates snapshots again at the history-facing trust boundary', () => {
    const snapshot = buildServerObservabilitySnapshot(sample())
    expectObservabilityCode(() => parseServerObservabilitySnapshot({
      ...snapshot,
      health: { ...snapshot.health, unavailableMetrics: ['simulation.ups', 'simulation.ups'] }
    }), 'OBSERVABILITY_SNAPSHOT_INVALID')
  })

  it('loads pre-automation snapshots only by normalizing storage evidence to unknown', () => {
    const snapshot = buildServerObservabilitySnapshot(sample())
    const { automation: _legacyMissingField, ...legacy } = snapshot
    const normalized = parseServerObservabilitySnapshot(legacy)

    expect(normalized.automation.storageDependencyKind).toBe('unknown')
    expect(normalized.automation.projectRootAvailable.status).toBe('unavailable')
    expect(normalized.health.status).not.toBe('healthy')
    expect(normalized.health.hints.map((hint) => hint.code)).toEqual(expect.arrayContaining([
      'STORAGE_DEPENDENCY_UNCLASSIFIED', 'OBSERVABILITY_INCOMPLETE'
    ]))
  })

  it('loads a pre-generation snapshot only with process identity marked unavailable', () => {
    const snapshot = buildServerObservabilitySnapshot(sample())
    const { startedAt: _legacyMissingField, ...legacyRuntime } = snapshot.runtime
    const normalized = parseServerObservabilitySnapshot({ ...snapshot, runtime: legacyRuntime })

    expect(normalized.runtime.startedAt).toEqual({ status: 'unavailable', reason: 'not-provided' })
    expect(normalized.health.status).not.toBe('healthy')
    expect(normalized.health.unavailableMetrics).toContain('runtime.startedAt')
  })
})

function sample(): TrustedServerObservabilitySample {
  return {
    schemaVersion: 1 as const,
    observedAt: '2026-08-30T12:00:00.000Z',
    source: 'fixture.windows-status',
    runtime: {
      state: 'running' as const,
      processId: 4242,
      startedAt: '2026-08-30T11:00:00.000Z'
    },
    host: {
      cpu: {
        logicalProcessorCount: 4,
        totalPercent: 50,
        cores: [
          { index: 3, percent: 34 },
          { index: 1, percent: 35 },
          { index: 0, percent: 97 },
          { index: 2, percent: 34 }
        ]
      },
      memory: { totalBytes: 16 * gibibyte, availableBytes: 8 * gibibyte },
      storage: {
        projectVolume: { totalBytes: 1_000_000, availableBytes: 500_000 },
        saveVolume: { totalBytes: 1_000_000, availableBytes: 750_000 }
      },
      network: {
        receiveBytesPerSecond: 125_000,
        sendBytesPerSecond: 48_000,
        sampledInterfaceCount: 2
      }
    },
    process: {
      cpuPercent: 45,
      cpuCoresUsed: 1.8,
      workingSetBytes: 4 * gibibyte,
      privateBytes: 5 * gibibyte,
      threadCount: 256
    },
    automation: {
      storageDependencyKind: 'none',
      projectRootAvailable: true
    },
    network: { gamePort: { port: 8469, listening: true } },
    simulation: { ups: 40, tps: 39, targetUps: 60 }
  }
}

function withMutation(mutate: (input: TrustedServerObservabilitySample) => void): TrustedServerObservabilitySample {
  const input = sample()
  mutate(input)
  return input
}

function expectObservabilityCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error(`expected ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(ObservabilityError)
    expect((error as ObservabilityError).code).toBe(code)
  }
}

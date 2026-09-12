import { describe, expect, it } from 'vitest'
import type { ServerStatus } from '../domain.js'
import type { AcceptedBridgeSimulationTelemetry } from '../bridge/file-client.js'
import {
  actualSimulationRates,
  buildBridgeRuntimeSession,
  buildBridgeSimulationTelemetry
} from '../bridge/protocol.js'
import { evaluateObservabilityHealth } from './health.js'
import { evaluateLateGameQualification } from './qualification.js'
import { buildObservabilityFromServerStatus } from './server-status.js'
import type { ServerObservabilityReadings, ServerObservabilitySnapshot } from './types.js'
import { WINDOWS_BRIDGE_OBSERVABILITY_SOURCE } from './windows-bridge.js'

describe('late-game telemetry qualification', () => {
  it('passes a complete six-hour window while retaining non-telemetry production drill boundaries', () => {
    const report = evaluateLateGameQualification(makeWindow(), () => new Date('2026-08-30T12:30:00.000Z'))

    expect(report).toMatchObject({
      profileId: 'late-game-6h-v1',
      result: 'pass',
      generatedAt: '2026-08-30T12:30:00.000Z',
      sampleCount: 361,
      spanMs: 21_600_000
    })
    expect(report.checks.every((check) => check.status === 'pass')).toBe(true)
    expect(report.remainingEvidence).toEqual([
      'SAVE_LATENCY_DRILL_REQUIRED',
      'REBOOT_RECOVERY_DRILL_REQUIRED',
      'CRASH_RECOVERY_DRILL_REQUIRED',
      'EXTERNAL_JOIN_SOAK_REQUIRED'
    ])
  })

  it('detects persistent low UPS, memory pressure, and one-core saturation with idle aggregate capacity', () => {
    const snapshots = makeWindow({ ups: 42, memoryUsedPercent: 95, hostCpuPercent: 32,
      hottestCorePercent: 99, processCpuCoresUsed: 1.1 })
    const report = evaluateLateGameQualification(snapshots)

    expect(report.result).toBe('fail')
    expect(check(report, 'simulation.ups-floor')).toMatchObject({ status: 'fail' })
    expect(check(report, 'simulation.tps-floor')).toMatchObject({ status: 'fail' })
    expect(check(report, 'host.memory-peak')).toMatchObject({ status: 'fail' })
    expect(check(report, 'host.hottest-core-saturation')).toMatchObject({ status: 'fail' })
    expect(check(report, 'process.single-core-bottleneck')).toMatchObject({ status: 'fail' })
  })

  it('reports insufficient evidence instead of passing a short or unavailable sample window', () => {
    const snapshots = makeWindow({ count: 8 }).map((snapshot) => {
      const { health: _health, ...base } = snapshot
      const readings: ServerObservabilityReadings = {
        ...base,
        simulation: {
          ...snapshot.simulation,
          ups: { status: 'unavailable' as const, reason: 'not-provided' as const }
        }
      }
      return { ...readings, health: evaluateObservabilityHealth(readings) }
    })
    const report = evaluateLateGameQualification(snapshots)

    expect(report.result).toBe('insufficient')
    expect(check(report, 'window.samples')).toMatchObject({ status: 'insufficient' })
    expect(check(report, 'window.duration')).toMatchObject({ status: 'insufficient' })
    expect(check(report, 'simulation.ups-coverage')).toMatchObject({ status: 'insufficient' })
    expect(check(report, 'simulation.ups-floor')).toMatchObject({ status: 'insufficient' })
    expect(check(report, 'simulation.tps-coverage')).toMatchObject({ status: 'pass' })
  })

  it('normalizes chronological order and rejects malformed snapshots through the common parser', () => {
    const reversed = makeWindow().reverse()
    const report = evaluateLateGameQualification(reversed)
    expect(report.from).toBe('2026-08-30T00:00:00.000Z')
    expect(report.to).toBe('2026-08-30T06:00:00.000Z')

    expect(() => evaluateLateGameQualification([{ observedAt: 'not-a-date' }])).toThrow(
      'OBSERVABILITY_SNAPSHOT_INVALID'
    )
  })

  it('does not let an arbitrary or fixture source claim actual UPS/TPS coverage', () => {
    const snapshots = makeWindow().map((snapshot) => ({ ...snapshot, source: 'fixture.synthetic-target' }))
    const report = evaluateLateGameQualification(snapshots)
    expect(report.result).toBe('insufficient')
    expect(check(report, 'simulation.ups-coverage')).toMatchObject({ status: 'insufficient' })
    expect(check(report, 'simulation.tps-coverage')).toMatchObject({ status: 'insufficient' })
    expect(check(report, 'simulation.ups-floor')).toMatchObject({ status: 'insufficient' })
    expect(check(report, 'simulation.tps-floor')).toMatchObject({ status: 'insufficient' })
  })

  it('fails closed on an SMB mapping interruption or recovery-task failure while non-SMB remains applicable', () => {
    const snapshots = makeWindow({ storageDependencyKind: 'smb-global-mapping' })
    snapshots[180] = makeSnapshot(snapshots[180]!.observedAt, {
      storageDependencyKind: 'smb-global-mapping', globalMappingAvailable: false
    })
    snapshots[181] = makeSnapshot(snapshots[181]!.observedAt, {
      storageDependencyKind: 'smb-global-mapping', storageTaskLastResult: 1312
    })
    const report = evaluateLateGameQualification(snapshots)
    expect(check(report, 'storage.smb-mapping-available')).toMatchObject({ status: 'fail' })
    expect(check(report, 'storage.recovery-task-healthy')).toMatchObject({ status: 'fail' })
    expect(report.result).toBe('fail')

    const nonSmb = evaluateLateGameQualification(makeWindow({ storageDependencyKind: 'none' }))
    expect(check(nonSmb, 'storage.smb-mapping-available')).toMatchObject({
      status: 'pass', observed: { mode: 'not-applicable' }
    })
  })
})

function check(report: ReturnType<typeof evaluateLateGameQualification>, id: string) {
  return report.checks.find((entry) => entry.id === id)
}

function makeWindow(options: {
  count?: number
  ups?: number
  memoryUsedPercent?: number
  hostCpuPercent?: number
  hottestCorePercent?: number
  processCpuCoresUsed?: number
  storageDependencyKind?: 'none' | 'smb-global-mapping'
  globalMappingAvailable?: boolean
  storageTaskLastResult?: number
} = {}): ServerObservabilitySnapshot[] {
  const count = options.count ?? 361
  return Array.from({ length: count }, (_, index) => makeSnapshot(
    new Date(Date.parse('2026-08-30T00:00:00.000Z') + index * 60_000).toISOString(),
    options
  ))
}

function makeSnapshot(
  observedAt: string,
  options: {
    ups?: number
    memoryUsedPercent?: number
    hostCpuPercent?: number
    hottestCorePercent?: number
    processCpuCoresUsed?: number
    storageDependencyKind?: 'none' | 'smb-global-mapping'
    globalMappingAvailable?: boolean
    storageTaskLastResult?: number
  }
): ServerObservabilitySnapshot {
  const gib = 1_024 * 1_024 * 1_024
  const memoryUsedPercent = options.memoryUsedPercent ?? 62
  const hostCpuPercent = options.hostCpuPercent ?? 48
  const memoryTotalGiB = 64
  const memoryFreeGiB = memoryTotalGiB * (100 - memoryUsedPercent) / 100
  const processStartedAt = '2026-08-29T23:00:00.000Z'
  const processStartedAtUnixMs = Date.parse(processStartedAt)
  const bridgeStartedAtUnixMs = Date.parse('2026-08-29T23:01:00.000Z')
  const observedAtUnixMs = Date.parse(observedAt)
  const ups = options.ups ?? 60
  const tickDelta = Math.round(ups * 2)
  const sequence = Math.floor((observedAtUnixMs - Date.parse('2026-08-30T00:00:00.000Z')) / 60_000) + 1
  const status: ServerStatus = {
    collectedAt: observedAt,
    serverName: 'Fictional DSP server', state: 'running',
    runtime: {
      targetUps: 60, onlinePlayers: 2, maxPlayers: 8, processId: 4242,
      processCoresUsed: options.processCpuCoresUsed ?? 4,
      workingSetGiB: 12, privateMemoryGiB: 14, threadCount: 240,
      priority: 'High', startedAt: processStartedAt,
      uptimeSeconds: Math.max(0, Math.floor((observedAtUnixMs - processStartedAtUnixMs) / 1_000))
    },
    host: {
      logicalProcessors: 16, processorGroups: 1, cpuPercent: hostCpuPercent,
      memoryTotalGiB, memoryFreeGiB,
      cpuCores: {
        samples: Array.from({ length: 16 }, (_, index) => ({
          index, percent: index === 0 ? (options.hottestCorePercent ?? 72) : 44
        })),
        unavailableReason: null
      },
      projectVolume: {
        totalBytes: 512 * gib, availableBytes: 240 * gib, usedPercent: 53.125, unavailableReason: null
      },
      saveVolume: {
        totalBytes: 1_024 * gib, availableBytes: 600 * gib, usedPercent: 41.40625, unavailableReason: null
      },
      network: {
        receiveBytesPerSecond: 12_500, sendBytesPerSecond: 4_200,
        sampledInterfaceCount: 2, unavailableReason: null
      }
    },
    versions: { dsp: null, nebula: null, bepInEx: null, compatible: null, gameLoaded: null, warnings: [] },
    save: {
      name: null, dsvPresent: false, serverPresent: false, consistent: false,
      lastSavedAt: null, dsvSizeMiB: null, serverSizeKiB: null,
      latestBackupAt: null, backupManifestPresent: false, backupPairPresent: false
    },
    automation: {
      serverTask: { state: null, lastResult: null, lastRunAt: null },
      stopTask: { state: null, lastResult: null, lastRunAt: null },
      storageTask: options.storageDependencyKind === 'smb-global-mapping'
        ? { state: 'ready', lastResult: options.storageTaskLastResult ?? 0, lastRunAt: observedAt }
        : { state: null, lastResult: null, lastRunAt: null },
      projectRootAvailable: true,
      globalMappingAvailable: options.storageDependencyKind === 'smb-global-mapping'
        ? (options.globalMappingAvailable ?? true)
        : null
    },
    connections: [{ id: 'game-port', label: 'Game port', status: 'healthy', detail: 'Provider fixture' }],
    capabilities: { refresh: true, start: false, save: false, gracefulStop: false, restart: false }
  }
  return buildObservabilityFromServerStatus(status, {
    source: WINDOWS_BRIDGE_OBSERVABILITY_SOURCE,
    gamePort: 8469,
    storageDependencyKind: options.storageDependencyKind ?? 'none',
    actualSimulationTelemetry: actualTelemetry({
      processStartedAtUnixMs, bridgeStartedAtUnixMs, observedAtUnixMs,
      sequence, tickDelta, upsMilli: Math.round(ups * 1_000)
    })
  })
}

function actualTelemetry(options: {
  processStartedAtUnixMs: number
  bridgeStartedAtUnixMs: number
  observedAtUnixMs: number
  sequence: number
  tickDelta: number
  upsMilli: number
}): AcceptedBridgeSimulationTelemetry {
  const secret = 'fictional-cross-runtime-secret-0123456789'
  const session = buildBridgeRuntimeSession({
    sessionId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', pluginVersion: '0.1.0', processId: 4242,
    processStartedAtUnixMs: options.processStartedAtUnixMs,
    bridgeStartedAtUnixMs: options.bridgeStartedAtUnixMs,
    issuedAtUnixMs: options.bridgeStartedAtUnixMs
  }, secret).session
  const tickStarted = options.sequence * 1_000
  const telemetry = buildBridgeSimulationTelemetry({
    sessionId: session.sessionId, processId: 4242,
    processStartedAtUnixMs: options.processStartedAtUnixMs,
    bridgeStartedAtUnixMs: options.bridgeStartedAtUnixMs,
    sequence: options.sequence,
    sampleStartedAtUnixMs: options.observedAtUnixMs - 2_000,
    sampleFinishedAtUnixMs: options.observedAtUnixMs,
    writtenAtUnixMs: options.observedAtUnixMs,
    windowDurationMs: 2_000,
    tickStarted, tickFinished: tickStarted + options.tickDelta,
    upsMilli: options.upsMilli, tpsMilli: options.tickDelta * 500
  }, secret).telemetry
  const rates = actualSimulationRates(telemetry)
  return { session, telemetry, actualUps: rates.ups, actualTps: rates.tps }
}

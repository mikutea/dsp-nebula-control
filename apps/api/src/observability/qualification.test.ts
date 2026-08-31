import { describe, expect, it } from 'vitest'
import { evaluateObservabilityHealth } from './health.js'
import { evaluateLateGameQualification } from './qualification.js'
import type { ServerObservabilityReadings, ServerObservabilitySnapshot } from './types.js'

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
  }
): ServerObservabilitySnapshot {
  const gib = 1_024 * 1_024 * 1_024
  const memoryUsedPercent = options.memoryUsedPercent ?? 62
  const hostCpuPercent = options.hostCpuPercent ?? 48
  const memoryTotalBytes = 64 * gib
  const memoryUsedBytes = Math.round(memoryTotalBytes * memoryUsedPercent / 100)
  const readings: ServerObservabilityReadings = {
    schemaVersion: 1,
    kind: 'server-observability-snapshot',
    observedAt,
    source: 'fictional.windows.server-status',
    runtime: {
      state: 'running',
      processId: { status: 'available', value: 4242 },
      gamePort: {
        port: { status: 'available', value: 8469 },
        listening: { status: 'available', value: true }
      }
    },
    host: {
      cpu: {
        logicalProcessorCount: { status: 'available', value: 16 },
        totalPercent: { status: 'available', value: hostCpuPercent },
        perCorePercent: {
          status: 'available',
          value: Array.from({ length: 16 }, (_, index) => ({
            index,
            percent: index === 0 ? (options.hottestCorePercent ?? 72) : 44
          }))
        }
      },
      memory: {
        totalBytes: { status: 'available', value: memoryTotalBytes },
        availableBytes: { status: 'available', value: memoryTotalBytes - memoryUsedBytes },
        usedBytes: { status: 'available', value: memoryUsedBytes },
        usedPercent: { status: 'available', value: memoryUsedPercent }
      },
      storage: {
        projectVolume: {
          totalBytes: { status: 'available', value: 512 * gib },
          availableBytes: { status: 'available', value: 240 * gib },
          usedBytes: { status: 'available', value: 272 * gib },
          usedPercent: { status: 'available', value: 53.125 }
        },
        saveVolume: {
          totalBytes: { status: 'available', value: 1_024 * gib },
          availableBytes: { status: 'available', value: 600 * gib },
          usedBytes: { status: 'available', value: 424 * gib },
          usedPercent: { status: 'available', value: 41.40625 }
        }
      },
      network: {
        receiveBytesPerSecond: { status: 'available', value: 12_500 },
        sendBytesPerSecond: { status: 'available', value: 4_200 },
        sampledInterfaceCount: { status: 'available', value: 2 }
      }
    },
    process: {
      cpuPercent: { status: 'available', value: 80 },
      cpuCoresUsed: { status: 'available', value: options.processCpuCoresUsed ?? 4 },
      workingSetBytes: { status: 'available', value: 12 * gib },
      privateBytes: { status: 'available', value: 14 * gib },
      threadCount: { status: 'available', value: 240 }
    },
    simulation: {
      ups: { status: 'available', value: options.ups ?? 60 },
      tps: { status: 'available', value: options.ups ?? 60 },
      targetUps: { status: 'available', value: 60 }
    }
  }
  return { ...readings, health: evaluateObservabilityHealth(readings) }
}

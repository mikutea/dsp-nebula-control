import { describe, expect, it } from 'vitest'
import type { ServerStatus } from '../domain.js'
import { buildObservabilityFromServerStatus } from './server-status.js'

const gibibyte = 1_024 ** 3

describe('ServerStatus observability adapter', () => {
  it('maps only measurements present in the trusted status contract', () => {
    const snapshot = buildObservabilityFromServerStatus(status(), {
      source: 'windows.server-status',
      gamePort: 8469
    })

    expect(snapshot.observedAt).toBe('2026-08-30T12:00:00.000Z')
    expect(snapshot.host.cpu.totalPercent).toEqual({ status: 'available', value: 37.5 })
    expect(snapshot.host.cpu.perCorePercent).toEqual({
      status: 'available',
      value: Array.from({ length: 16 }, (_, index) => ({ index, percent: index === 0 ? 72 : 18 }))
    })
    expect(snapshot.host.memory).toMatchObject({
      totalBytes: { status: 'available', value: 64 * gibibyte },
      availableBytes: { status: 'available', value: 40 * gibibyte },
      usedBytes: { status: 'available', value: 24 * gibibyte },
      usedPercent: { status: 'available', value: 37.5 }
    })
    expect(snapshot.host.storage).toMatchObject({
      projectVolume: {
        totalBytes: { status: 'available', value: 1_000_000 },
        availableBytes: { status: 'available', value: 400_000 },
        usedBytes: { status: 'available', value: 600_000 },
        usedPercent: { status: 'available', value: 60 }
      },
      saveVolume: {
        usedBytes: { status: 'available', value: 1_000_000 },
        usedPercent: { status: 'available', value: 50 }
      }
    })
    expect(snapshot.host.network).toEqual({
      receiveBytesPerSecond: { status: 'available', value: 12_500 },
      sendBytesPerSecond: { status: 'available', value: 4_200 },
      sampledInterfaceCount: { status: 'available', value: 2 }
    })
    expect(snapshot.process.cpuPercent).toEqual({ status: 'unavailable', reason: 'not-provided' })
    expect(snapshot.process.cpuCoresUsed).toEqual({ status: 'available', value: 2.75 })
    expect(snapshot.runtime.gamePort.listening).toEqual({ status: 'available', value: true })
    expect(snapshot.simulation).toEqual({
      ups: { status: 'unavailable', reason: 'not-provided' },
      tps: { status: 'unavailable', reason: 'not-provided' },
      targetUps: { status: 'available', value: 60 }
    })
  })

  it('keeps missing and unknown provider values explicitly unavailable', () => {
    const input = status()
    input.host.cpuPercent = null
    input.host.logicalProcessors = null
    input.host.memoryFreeGiB = null
    input.runtime.processCoresUsed = null
    input.runtime.targetUps = null
    input.connections[0]!.status = 'unknown'
    input.host.cpuCores = { samples: null, unavailableReason: 'cim-unavailable' }
    input.host.projectVolume = {
      totalBytes: null, availableBytes: null, usedPercent: null, unavailableReason: 'volume-unavailable'
    }
    input.host.saveVolume = {
      totalBytes: null, availableBytes: null, usedPercent: null, unavailableReason: 'volume-unavailable'
    }
    input.host.network = {
      receiveBytesPerSecond: null,
      sendBytesPerSecond: null,
      sampledInterfaceCount: null,
      unavailableReason: 'no-eligible-network-interface'
    }

    const snapshot = buildObservabilityFromServerStatus(input, {
      source: 'windows.server-status',
      gamePort: 8469
    })

    expect(snapshot.host.cpu.totalPercent).toEqual({
      status: 'unavailable', reason: 'source-reported-unavailable'
    })
    expect(snapshot.host.cpu.perCorePercent).toEqual({ status: 'unavailable', reason: 'cim-unavailable' })
    expect(snapshot.host.storage.projectVolume.usedPercent).toEqual({
      status: 'unavailable', reason: 'volume-unavailable'
    })
    expect(snapshot.host.network.receiveBytesPerSecond).toEqual({
      status: 'unavailable', reason: 'no-eligible-network-interface'
    })
    expect(snapshot.health.hints).toContainEqual(expect.objectContaining({
      code: 'NETWORK_TELEMETRY_UNAVAILABLE', severity: 'info'
    }))
    expect(snapshot.process.cpuCoresUsed).toEqual({
      status: 'unavailable', reason: 'source-reported-unavailable'
    })
    expect(snapshot.runtime.gamePort.listening).toEqual({
      status: 'unavailable', reason: 'source-reported-unavailable'
    })
    expect(snapshot.simulation.ups.status).toBe('unavailable')
    expect(snapshot.simulation.tps.status).toBe('unavailable')
    expect(snapshot.simulation.targetUps.status).toBe('unavailable')
  })

  it('lets the core report process and port contradictions', () => {
    const input = status()
    input.connections[0]!.status = 'warning'
    const snapshot = buildObservabilityFromServerStatus(input, {
      source: 'windows.server-status',
      gamePort: 8469
    })

    expect(snapshot.runtime.gamePort.listening).toEqual({ status: 'available', value: false })
    expect(snapshot.health.status).toBe('critical')
    expect(snapshot.health.hints).toContainEqual(expect.objectContaining({
      code: 'GAME_PORT_NOT_LISTENING', severity: 'critical'
    }))
  })
})

function status(): ServerStatus {
  return {
    collectedAt: '2026-08-30T12:00:00.000Z',
    serverName: 'Fictional DSP server',
    state: 'running',
    runtime: {
      targetUps: 60,
      onlinePlayers: 2,
      maxPlayers: 8,
      processId: 4242,
      processCoresUsed: 2.75,
      workingSetGiB: 6.25,
      privateMemoryGiB: 7,
      threadCount: 240,
      priority: 'High',
      startedAt: '2026-08-30T10:00:00.000Z',
      uptimeSeconds: 7_200
    },
    host: {
      logicalProcessors: 16,
      processorGroups: 1,
      cpuPercent: 37.5,
      memoryTotalGiB: 64,
      memoryFreeGiB: 40,
      cpuCores: {
        samples: Array.from({ length: 16 }, (_, index) => ({ index, percent: index === 0 ? 72 : 18 })),
        unavailableReason: null
      },
      projectVolume: {
        totalBytes: 1_000_000,
        availableBytes: 400_000,
        usedPercent: 60,
        unavailableReason: null
      },
      saveVolume: {
        totalBytes: 2_000_000,
        availableBytes: 1_000_000,
        usedPercent: 50,
        unavailableReason: null
      },
      network: {
        receiveBytesPerSecond: 12_500,
        sendBytesPerSecond: 4_200,
        sampledInterfaceCount: 2,
        unavailableReason: null
      }
    },
    versions: {
      dsp: null,
      nebula: null,
      bepInEx: null,
      compatible: null,
      gameLoaded: null,
      warnings: []
    },
    save: {
      name: null,
      dsvPresent: false,
      serverPresent: false,
      consistent: false,
      lastSavedAt: null,
      dsvSizeMiB: null,
      serverSizeKiB: null,
      latestBackupAt: null,
      backupManifestPresent: false,
      backupPairPresent: false
    },
    automation: {
      serverTask: { state: null, lastResult: null, lastRunAt: null },
      stopTask: { state: null, lastResult: null, lastRunAt: null },
      storageTask: { state: null, lastResult: null, lastRunAt: null },
      projectRootAvailable: true,
      globalMappingAvailable: null
    },
    connections: [
      { id: 'game-port', label: 'Game port', status: 'healthy', detail: 'Fixture listener' }
    ],
    capabilities: { refresh: true, start: false, save: false, gracefulStop: false, restart: false }
  }
}

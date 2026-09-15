import { describe, expect, it, vi } from 'vitest'
import type { ServerStatus } from '../domain.js'
import type { AcceptedBridgeSimulationTelemetry } from '../bridge/file-client.js'
import {
  BridgeProtocolError,
  actualSimulationRates,
  buildBridgeRuntimeSession,
  buildBridgeSimulationTelemetry
} from '../bridge/protocol.js'
import {
  WINDOWS_BRIDGE_OBSERVABILITY_SOURCE,
  collectWindowsBridgeObservability,
  type BridgeSimulationTelemetryReader
} from './windows-bridge.js'

describe('Windows signed bridge observability provider', () => {
  it('promotes only a generation-bound bridge reading to actual UPS/TPS', async () => {
    const input = status()
    const actual = actualTelemetry(input)
    const reader: BridgeSimulationTelemetryReader = {
      readSimulationTelemetry: vi.fn(async () => actual)
    }
    const collected = await collectWindowsBridgeObservability(input, reader, { gamePort: 8469 })

    expect(collected.telemetry).toEqual({
      status: 'actual', sequence: 7, writtenAt: '2026-08-30T10:00:04.000Z'
    })
    expect(collected.snapshot.source).toBe(WINDOWS_BRIDGE_OBSERVABILITY_SOURCE)
    expect(collected.snapshot.simulation).toEqual({
      ups: { status: 'available', value: 59.25 },
      tps: { status: 'available', value: 58.5 },
      targetUps: { status: 'available', value: 60 }
    })
    expect(reader.readSimulationTelemetry).toHaveBeenCalledWith({
      processId: 4242, processStartedAtUnixMs: Date.parse('2026-08-30T10:00:00.000Z')
    }, undefined)
  })

  it.each(['BRIDGE_SIGNATURE_INVALID', 'BRIDGE_TELEMETRY_REPLAY', 'BRIDGE_TELEMETRY_STALE'])(
    'fails closed when the bridge rejects evidence with %s',
    async (code) => {
      const reader: BridgeSimulationTelemetryReader = {
        readSimulationTelemetry: vi.fn(async () => { throw new BridgeProtocolError(code) })
      }
      const collected = await collectWindowsBridgeObservability(status(), reader, { gamePort: 8469 })
      expect(collected.telemetry).toEqual({ status: 'unavailable', reason: code })
      expect(collected.snapshot.simulation).toEqual({
        ups: { status: 'unavailable', reason: 'source-reported-unavailable' },
        tps: { status: 'unavailable', reason: 'source-reported-unavailable' },
        targetUps: { status: 'available', value: 60 }
      })
    }
  )

  it('does not query bridge telemetry without a verified running process identity', async () => {
    const input = status()
    input.state = 'stopped'
    input.runtime.processId = null
    input.runtime.startedAt = null
    const reader: BridgeSimulationTelemetryReader = {
      readSimulationTelemetry: vi.fn(async () => actualTelemetry(status()))
    }
    const collected = await collectWindowsBridgeObservability(input, reader, { gamePort: 8469 })
    expect(collected.telemetry).toEqual({ status: 'unavailable', reason: 'process-not-running' })
    expect(reader.readSimulationTelemetry).not.toHaveBeenCalled()
    expect(collected.snapshot.simulation.ups.status).toBe('unavailable')
  })
})

function actualTelemetry(input: ServerStatus): AcceptedBridgeSimulationTelemetry {
  const processStartedAtUnixMs = Date.parse(input.runtime.startedAt!)
  const bridgeStartedAtUnixMs = processStartedAtUnixMs + 1_000
  const secret = 'fictional-cross-runtime-secret-0123456789'
  const session = buildBridgeRuntimeSession({
    sessionId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', pluginVersion: '0.1.0',
    processId: input.runtime.processId!, processStartedAtUnixMs,
    bridgeStartedAtUnixMs, issuedAtUnixMs: bridgeStartedAtUnixMs
  }, secret).session
  const telemetry = buildBridgeSimulationTelemetry({
    sessionId: session.sessionId, processId: session.processId,
    processStartedAtUnixMs, bridgeStartedAtUnixMs, sequence: 7,
    sampleStartedAtUnixMs: processStartedAtUnixMs + 2_000,
    sampleFinishedAtUnixMs: processStartedAtUnixMs + 4_000,
    writtenAtUnixMs: processStartedAtUnixMs + 4_000,
    windowDurationMs: 2_000, tickStarted: 1_000, tickFinished: 1_117,
    upsMilli: 59_250, tpsMilli: 58_500
  }, secret).telemetry
  const rates = actualSimulationRates(telemetry)
  return { session, telemetry, actualUps: rates.ups, actualTps: rates.tps }
}

function status(): ServerStatus {
  return {
    collectedAt: '2026-08-30T10:00:05.000Z',
    serverName: 'Fictional DSP server', state: 'running',
    runtime: {
      targetUps: 60, onlinePlayers: 2, maxPlayers: 8, processId: 4242,
      processCoresUsed: 2, workingSetGiB: 6, privateMemoryGiB: 7,
      threadCount: 200, priority: 'High', startedAt: '2026-08-30T10:00:00.000Z', uptimeSeconds: 5
    },
    host: {
      logicalProcessors: 4, processorGroups: 1, cpuPercent: 40,
      memoryTotalGiB: 16, memoryFreeGiB: 8
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
      storageTask: { state: null, lastResult: null, lastRunAt: null },
      projectRootAvailable: true, globalMappingAvailable: null
    },
    connections: [{ id: 'game-port', label: 'Game port', status: 'healthy', detail: 'Fixture listener' }],
    capabilities: { refresh: true, start: false, save: false, gracefulStop: false, restart: false }
  }
}

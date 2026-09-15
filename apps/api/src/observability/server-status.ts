import type { ServerStatus } from '../domain.js'
import { BridgeProtocolError, actualSimulationRates } from '../bridge/protocol.js'
import type { AcceptedBridgeSimulationTelemetry } from '../bridge/file-client.js'
import { buildServerObservabilitySnapshot } from './snapshot.js'
import type { ServerObservabilitySnapshot } from './types.js'
import type { ObservabilityStorageDependencyKind } from './types.js'

const bytesPerGibibyte = 1_024 ** 3

export interface ServerStatusObservabilityOptions {
  source: string
  gamePort: number
  /**
   * Must be supplied by a production caller that knows the configured project
   * root. Omitting it is deliberately fail-closed when the provider cannot
   * prove a global mapping.
   */
  storageDependencyKind?: Exclude<ObservabilityStorageDependencyKind, 'unknown'>
  /** undefined preserves the legacy adapter; null means the real bridge source was unavailable. */
  actualSimulationTelemetry?: AcceptedBridgeSimulationTelemetry | null
}

/**
 * Maps the already-validated status-provider contract into observability.
 * Actual UPS/TPS are accepted only as a separately authenticated bridge
 * reading; target UPS always remains configuration rather than telemetry.
 */
export function buildObservabilityFromServerStatus(
  status: ServerStatus,
  options: ServerStatusObservabilityOptions
): ServerObservabilitySnapshot {
  const actualSimulation = validateActualSimulationTelemetry(status, options.actualSimulationTelemetry)
  const gameConnection = status.connections.find((connection) => connection.id === 'game-port')
  const listening = gameConnection === undefined
    ? undefined
    : gameConnection.status === 'healthy'
      ? true
      : gameConnection.status === 'warning'
        ? false
        : null

  return buildServerObservabilitySnapshot({
    schemaVersion: 1,
    observedAt: status.collectedAt,
    source: options.source,
    runtime: {
      state: status.state,
      processId: status.runtime.processId,
      startedAt: status.runtime.startedAt
    },
    host: {
      cpu: {
        logicalProcessorCount: status.host.logicalProcessors,
        totalPercent: status.host.cpuPercent,
        cores: status.host.cpuCores?.samples,
        coresUnavailableReason: status.host.cpuCores?.unavailableReason
      },
      memory: {
        totalBytes: gibibytesToBytes(status.host.memoryTotalGiB),
        availableBytes: gibibytesToBytes(status.host.memoryFreeGiB)
      },
      storage: {
        projectVolume: status.host.projectVolume === undefined
          ? undefined
          : {
              totalBytes: status.host.projectVolume.totalBytes,
              availableBytes: status.host.projectVolume.availableBytes,
              unavailableReason: status.host.projectVolume.unavailableReason
            },
        saveVolume: status.host.saveVolume === undefined
          ? undefined
          : {
              totalBytes: status.host.saveVolume.totalBytes,
              availableBytes: status.host.saveVolume.availableBytes,
              unavailableReason: status.host.saveVolume.unavailableReason
            }
      },
      network: status.host.network === undefined
        ? undefined
        : {
            receiveBytesPerSecond: status.host.network.receiveBytesPerSecond,
            sendBytesPerSecond: status.host.network.sendBytesPerSecond,
            sampledInterfaceCount: status.host.network.sampledInterfaceCount,
            unavailableReason: status.host.network.unavailableReason
          }
    },
    process: {
      // processCoresUsed is a core-equivalent measurement, not a percentage.
      cpuCoresUsed: status.runtime.processCoresUsed,
      workingSetBytes: gibibytesToBytes(status.runtime.workingSetGiB),
      privateBytes: gibibytesToBytes(status.runtime.privateMemoryGiB),
      threadCount: status.runtime.threadCount
    },
    network: {
      gamePort: { port: options.gamePort, listening }
    },
    simulation: {
      // targetUps is configuration only; actual values can only arrive through
      // the separately authenticated, generation-bound bridge reader.
      ups: actualSimulation?.actualUps ?? (options.actualSimulationTelemetry === null ? null : undefined),
      tps: actualSimulation?.actualTps ?? (options.actualSimulationTelemetry === null ? null : undefined),
      targetUps: status.runtime.targetUps
    },
    automation: {
      storageDependencyKind: options.storageDependencyKind
        ?? (status.automation.globalMappingAvailable === null ? 'unknown' : 'smb-global-mapping'),
      projectRootAvailable: status.automation.projectRootAvailable,
      globalMappingAvailable: options.storageDependencyKind === 'none'
        ? undefined
        : status.automation.globalMappingAvailable,
      storageTask: options.storageDependencyKind === 'none'
        ? undefined
        : {
            state: status.automation.storageTask.state,
            lastResult: status.automation.storageTask.lastResult
          }
    }
  })
}

function validateActualSimulationTelemetry(
  status: ServerStatus,
  telemetry: AcceptedBridgeSimulationTelemetry | null | undefined
): AcceptedBridgeSimulationTelemetry | null | undefined {
  if (telemetry === null || telemetry === undefined) return telemetry
  const expectedProcessStartedAtUnixMs = status.runtime.startedAt === null
    ? null
    : Date.parse(status.runtime.startedAt)
  const rates = actualSimulationRates(telemetry.telemetry)
  if (status.state !== 'running' || status.runtime.processId === null ||
      expectedProcessStartedAtUnixMs === null || !Number.isSafeInteger(expectedProcessStartedAtUnixMs) ||
      telemetry.session.processId !== status.runtime.processId ||
      telemetry.telemetry.processId !== status.runtime.processId ||
      telemetry.session.processStartedAtUnixMs !== expectedProcessStartedAtUnixMs ||
      telemetry.telemetry.processStartedAtUnixMs !== expectedProcessStartedAtUnixMs ||
      telemetry.session.sessionId !== telemetry.telemetry.sessionId ||
      telemetry.actualUps !== rates.ups || telemetry.actualTps !== rates.tps) {
    throw new BridgeProtocolError('BRIDGE_TELEMETRY_STATUS_MISMATCH')
  }
  return telemetry
}

function gibibytesToBytes(value: number | null): number | null {
  return value === null ? null : Math.round(value * bytesPerGibibyte)
}

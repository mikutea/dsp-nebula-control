import type { ServerStatus } from '../domain.js'
import { buildServerObservabilitySnapshot } from './snapshot.js'
import type { ServerObservabilitySnapshot } from './types.js'

const bytesPerGibibyte = 1_024 ** 3

export interface ServerStatusObservabilityOptions {
  source: string
  gamePort: number
}

/**
 * Maps the already-validated status-provider contract into observability.
 * Actual UPS/TPS remain absent: target UPS is configuration, not telemetry.
 */
export function buildObservabilityFromServerStatus(
  status: ServerStatus,
  options: ServerStatusObservabilityOptions
): ServerObservabilitySnapshot {
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
      processId: status.runtime.processId
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
      // targetUps is configuration only. Actual UPS and TPS remain unavailable.
      targetUps: status.runtime.targetUps
    }
  })
}

function gibibytesToBytes(value: number | null): number | null {
  return value === null ? null : Math.round(value * bytesPerGibibyte)
}

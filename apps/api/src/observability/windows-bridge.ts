import type { ServerStatus } from '../domain.js'
import type {
  AcceptedBridgeSimulationTelemetry,
  BridgeSimulationTelemetryExpectation
} from '../bridge/file-client.js'
import { BridgeProtocolError } from '../bridge/protocol.js'
import { buildObservabilityFromServerStatus } from './server-status.js'
import type { ServerObservabilitySnapshot } from './types.js'

export const WINDOWS_BRIDGE_OBSERVABILITY_SOURCE = 'windows.server-status.bridge-telemetry-v1' as const

export interface BridgeSimulationTelemetryReader {
  readSimulationTelemetry(
    expectation: BridgeSimulationTelemetryExpectation,
    signal?: AbortSignal
  ): Promise<AcceptedBridgeSimulationTelemetry>
}

export type WindowsBridgeTelemetryDisposition =
  | { status: 'actual'; sequence: number; writtenAt: string }
  | { status: 'unavailable'; reason: string }

export interface WindowsBridgeObservabilityCollection {
  snapshot: ServerObservabilitySnapshot
  telemetry: WindowsBridgeTelemetryDisposition
}

/**
 * Joins the Windows process snapshot with the signed in-process bridge sample.
 * Every rejected, missing, stale, replayed, or generation-mismatched sample is
 * represented as unavailable; targetUps is never promoted into an actual rate.
 */
export async function collectWindowsBridgeObservability(
  status: ServerStatus,
  reader: BridgeSimulationTelemetryReader,
  options: { gamePort: number; signal?: AbortSignal }
): Promise<WindowsBridgeObservabilityCollection> {
  options.signal?.throwIfAborted()
  let actual: AcceptedBridgeSimulationTelemetry | null = null
  let disposition: WindowsBridgeTelemetryDisposition
  const processStartedAtUnixMs = status.runtime.startedAt === null
    ? null
    : Date.parse(status.runtime.startedAt)
  if (status.state !== 'running') {
    disposition = { status: 'unavailable', reason: 'process-not-running' }
  } else if (status.runtime.processId === null || processStartedAtUnixMs === null ||
      !Number.isSafeInteger(processStartedAtUnixMs) || processStartedAtUnixMs <= 0) {
    disposition = { status: 'unavailable', reason: 'runtime-identity-unavailable' }
  } else {
    try {
      actual = await reader.readSimulationTelemetry({
        processId: status.runtime.processId,
        processStartedAtUnixMs
      }, options.signal)
      options.signal?.throwIfAborted()
      disposition = {
        status: 'actual',
        sequence: actual.telemetry.sequence,
        writtenAt: new Date(actual.telemetry.writtenAtUnixMs).toISOString()
      }
    } catch (error) {
      options.signal?.throwIfAborted()
      disposition = {
        status: 'unavailable',
        reason: error instanceof BridgeProtocolError ? error.code : 'bridge-telemetry-unavailable'
      }
    }
  }

  return {
    snapshot: buildObservabilityFromServerStatus(status, {
      source: WINDOWS_BRIDGE_OBSERVABILITY_SOURCE,
      gamePort: options.gamePort,
      actualSimulationTelemetry: actual
    }),
    telemetry: disposition
  }
}

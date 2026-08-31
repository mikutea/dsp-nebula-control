export const OBSERVABILITY_RUNTIME_STATES = [
  'running', 'stopped', 'starting', 'stopping', 'unknown'
] as const

export type ObservabilityRuntimeState = (typeof OBSERVABILITY_RUNTIME_STATES)[number]

export const OBSERVABILITY_UNAVAILABLE_REASONS = [
  'not-provided',
  'source-reported-unavailable',
  'dependency-unavailable',
  'process-not-running',
  'cim-unavailable',
  'volume-unavailable',
  'network-counters-unavailable',
  'no-eligible-network-interface',
  'inconsistent-sample'
] as const

export type ObservabilityUnavailableReason = (typeof OBSERVABILITY_UNAVAILABLE_REASONS)[number]

export interface AvailableMetric<T> {
  status: 'available'
  value: T
}

export interface UnavailableMetric {
  status: 'unavailable'
  reason: ObservabilityUnavailableReason
}

export type ObservabilityMetric<T> = AvailableMetric<T> | UnavailableMetric

export interface CoreCpuUsage {
  index: number
  percent: number
}

export const OBSERVABILITY_METRIC_PATHS = [
  'runtime.processId',
  'runtime.gamePort.port',
  'runtime.gamePort.listening',
  'host.cpu.logicalProcessorCount',
  'host.cpu.totalPercent',
  'host.cpu.perCorePercent',
  'host.memory.totalBytes',
  'host.memory.availableBytes',
  'host.memory.usedBytes',
  'host.memory.usedPercent',
  'host.storage.projectVolume.totalBytes',
  'host.storage.projectVolume.availableBytes',
  'host.storage.projectVolume.usedBytes',
  'host.storage.projectVolume.usedPercent',
  'host.storage.saveVolume.totalBytes',
  'host.storage.saveVolume.availableBytes',
  'host.storage.saveVolume.usedBytes',
  'host.storage.saveVolume.usedPercent',
  'host.network.receiveBytesPerSecond',
  'host.network.sendBytesPerSecond',
  'host.network.sampledInterfaceCount',
  'process.cpuPercent',
  'process.cpuCoresUsed',
  'process.workingSetBytes',
  'process.privateBytes',
  'process.threadCount',
  'simulation.ups',
  'simulation.tps',
  'simulation.targetUps'
] as const

export type ObservabilityMetricPath = (typeof OBSERVABILITY_METRIC_PATHS)[number]

export const OBSERVABILITY_HINT_CODES = [
  'HOST_CPU_PRESSURE',
  'HOST_CPU_SATURATED',
  'SINGLE_CORE_SATURATION',
  'MEMORY_PRESSURE',
  'MEMORY_EXHAUSTION',
  'PROJECT_VOLUME_PRESSURE',
  'PROJECT_VOLUME_EXHAUSTION',
  'SAVE_VOLUME_PRESSURE',
  'SAVE_VOLUME_EXHAUSTION',
  'NETWORK_TELEMETRY_UNAVAILABLE',
  'PROCESS_CPU_PRESSURE',
  'PROCESS_MEMORY_DOMINANT',
  'GAME_PORT_NOT_LISTENING',
  'UNEXPECTED_GAME_PORT_LISTENER',
  'RUNTIME_PROCESS_STATE_MISMATCH',
  'SIMULATION_BELOW_TARGET',
  'SIMULATION_TELEMETRY_UNAVAILABLE',
  'RUNTIME_STATE_UNKNOWN',
  'OBSERVABILITY_INCOMPLETE'
] as const

export type ObservabilityHintCode = (typeof OBSERVABILITY_HINT_CODES)[number]
export type ObservabilityHintSeverity = 'info' | 'warning' | 'critical'
export type ObservabilityHealthStatus = 'healthy' | 'unknown' | 'warning' | 'critical'

export interface ObservabilityHint {
  code: ObservabilityHintCode
  severity: ObservabilityHintSeverity
  message: string
  relatedMetrics: ObservabilityMetricPath[]
}

export interface ObservabilityHealth {
  status: ObservabilityHealthStatus
  hints: ObservabilityHint[]
  unavailableMetrics: ObservabilityMetricPath[]
}

export interface ServerObservabilityReadings {
  schemaVersion: 1
  kind: 'server-observability-snapshot'
  observedAt: string
  source: string
  runtime: {
    state: ObservabilityRuntimeState
    processId: ObservabilityMetric<number>
    gamePort: {
      port: ObservabilityMetric<number>
      listening: ObservabilityMetric<boolean>
    }
  }
  host: {
    cpu: {
      logicalProcessorCount: ObservabilityMetric<number>
      totalPercent: ObservabilityMetric<number>
      perCorePercent: ObservabilityMetric<CoreCpuUsage[]>
    }
    memory: {
      totalBytes: ObservabilityMetric<number>
      availableBytes: ObservabilityMetric<number>
      usedBytes: ObservabilityMetric<number>
      usedPercent: ObservabilityMetric<number>
    }
    storage: {
      projectVolume: VolumeObservabilityReadings
      saveVolume: VolumeObservabilityReadings
    }
    network: {
      receiveBytesPerSecond: ObservabilityMetric<number>
      sendBytesPerSecond: ObservabilityMetric<number>
      sampledInterfaceCount: ObservabilityMetric<number>
    }
  }
  process: {
    cpuPercent: ObservabilityMetric<number>
    cpuCoresUsed: ObservabilityMetric<number>
    workingSetBytes: ObservabilityMetric<number>
    privateBytes: ObservabilityMetric<number>
    threadCount: ObservabilityMetric<number>
  }
  simulation: {
    ups: ObservabilityMetric<number>
    tps: ObservabilityMetric<number>
    targetUps: ObservabilityMetric<number>
  }
}

export interface ServerObservabilitySnapshot extends ServerObservabilityReadings {
  health: ObservabilityHealth
}

export interface VolumeObservabilityReadings {
  totalBytes: ObservabilityMetric<number>
  availableBytes: ObservabilityMetric<number>
  usedBytes: ObservabilityMetric<number>
  usedPercent: ObservabilityMetric<number>
}

export interface AvailableNumericAggregate {
  status: 'available'
  observedSamples: number
  unavailableSamples: number
  minimum: number
  maximum: number
  average: number
  last: number
}

export interface UnavailableNumericAggregate {
  status: 'unavailable'
  observedSamples: 0
  unavailableSamples: number
}

export type NumericMetricAggregate = AvailableNumericAggregate | UnavailableNumericAggregate

export interface ObservabilityDownsamplePoint {
  schemaVersion: 1
  kind: 'server-observability-downsample-point'
  from: string
  to: string
  sampleCount: number
  metrics: {
    hostCpuPercent: NumericMetricAggregate
    hottestCorePercent: NumericMetricAggregate
    memoryUsedPercent: NumericMetricAggregate
    availableMemoryBytes: NumericMetricAggregate
    projectVolumeUsedPercent: NumericMetricAggregate
    projectVolumeAvailableBytes: NumericMetricAggregate
    saveVolumeUsedPercent: NumericMetricAggregate
    saveVolumeAvailableBytes: NumericMetricAggregate
    networkReceiveBytesPerSecond: NumericMetricAggregate
    networkSendBytesPerSecond: NumericMetricAggregate
    networkInterfaceCount: NumericMetricAggregate
    processCpuPercent: NumericMetricAggregate
    processCpuCoresUsed: NumericMetricAggregate
    processWorkingSetBytes: NumericMetricAggregate
    processPrivateBytes: NumericMetricAggregate
    ups: NumericMetricAggregate
    tps: NumericMetricAggregate
  }
  runtime: {
    lastState: ObservabilityRuntimeState
    stateTransitions: number
    lastGamePortListening: ObservabilityMetric<boolean>
  }
  health: {
    worstStatus: ObservabilityHealthStatus
    hintCodes: ObservabilityHintCode[]
  }
}

export interface ObservabilityDownsampleResult {
  schemaVersion: 1
  kind: 'server-observability-downsample'
  retainedSamples: number
  droppedSamples: number
  points: ObservabilityDownsamplePoint[]
}

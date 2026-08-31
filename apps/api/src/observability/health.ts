import type {
  ObservabilityHealth,
  ObservabilityHealthStatus,
  ObservabilityHint,
  ObservabilityHintCode,
  ObservabilityHintSeverity,
  ObservabilityMetric,
  ObservabilityMetricPath,
  ServerObservabilityReadings
} from './types.js'

export const OBSERVABILITY_THRESHOLDS = Object.freeze({
  hostCpuWarningPercent: 85,
  hostCpuCriticalPercent: 95,
  singleCoreWarningPercent: 95,
  memoryWarningPercent: 85,
  memoryCriticalPercent: 95,
  volumeWarningPercent: 85,
  volumeCriticalPercent: 95,
  processCpuWarningPercent: 90,
  processMemoryWarningFraction: 0.75,
  processMemoryCriticalFraction: 0.9,
  simulationWarningFractionOfTarget: 0.85,
  simulationCriticalFractionOfTarget: 0.5
})

type MetricAvailability = Pick<ObservabilityMetric<unknown>, 'status'>

export function evaluateObservabilityHealth(readings: ServerObservabilityReadings): ObservabilityHealth {
  const hints: ObservabilityHint[] = []
  const addHint = (
    code: ObservabilityHintCode,
    severity: ObservabilityHintSeverity,
    message: string,
    relatedMetrics: ObservabilityMetricPath[]
  ): void => {
    hints.push({ code, severity, message, relatedMetrics: [...new Set(relatedMetrics)] })
  }

  if (readings.host.cpu.totalPercent.status === 'available') {
    const value = readings.host.cpu.totalPercent.value
    if (value >= OBSERVABILITY_THRESHOLDS.hostCpuCriticalPercent) {
      addHint('HOST_CPU_SATURATED', 'critical', 'Host CPU utilization is at or above the critical threshold.', [
        'host.cpu.totalPercent'
      ])
    } else if (value >= OBSERVABILITY_THRESHOLDS.hostCpuWarningPercent) {
      addHint('HOST_CPU_PRESSURE', 'warning', 'Host CPU utilization is at or above the warning threshold.', [
        'host.cpu.totalPercent'
      ])
    }
  }

  if (readings.host.cpu.perCorePercent.status === 'available') {
    const hottest = Math.max(...readings.host.cpu.perCorePercent.value.map((core) => core.percent))
    const hostIsAlreadyBusy = readings.host.cpu.totalPercent.status === 'available'
      && readings.host.cpu.totalPercent.value >= OBSERVABILITY_THRESHOLDS.hostCpuWarningPercent
    if (hottest >= OBSERVABILITY_THRESHOLDS.singleCoreWarningPercent && !hostIsAlreadyBusy) {
      addHint(
        'SINGLE_CORE_SATURATION',
        'warning',
        'At least one logical processor is saturated while total host CPU is below threshold or unavailable.',
        ['host.cpu.perCorePercent', 'host.cpu.totalPercent']
      )
    }
  }

  if (readings.host.memory.usedPercent.status === 'available') {
    const value = readings.host.memory.usedPercent.value
    if (value >= OBSERVABILITY_THRESHOLDS.memoryCriticalPercent) {
      addHint('MEMORY_EXHAUSTION', 'critical', 'Host memory utilization is at or above the critical threshold.', [
        'host.memory.usedPercent', 'host.memory.availableBytes'
      ])
    } else if (value >= OBSERVABILITY_THRESHOLDS.memoryWarningPercent) {
      addHint('MEMORY_PRESSURE', 'warning', 'Host memory utilization is at or above the warning threshold.', [
        'host.memory.usedPercent', 'host.memory.availableBytes'
      ])
    }
  }

  const volumeChecks = [
    {
      metric: readings.host.storage.projectVolume.usedPercent,
      warningCode: 'PROJECT_VOLUME_PRESSURE' as const,
      criticalCode: 'PROJECT_VOLUME_EXHAUSTION' as const,
      usedPath: 'host.storage.projectVolume.usedPercent' as const,
      availablePath: 'host.storage.projectVolume.availableBytes' as const,
      label: 'Project volume'
    },
    {
      metric: readings.host.storage.saveVolume.usedPercent,
      warningCode: 'SAVE_VOLUME_PRESSURE' as const,
      criticalCode: 'SAVE_VOLUME_EXHAUSTION' as const,
      usedPath: 'host.storage.saveVolume.usedPercent' as const,
      availablePath: 'host.storage.saveVolume.availableBytes' as const,
      label: 'Save volume'
    }
  ]
  for (const check of volumeChecks) {
    if (check.metric.status !== 'available') continue
    if (check.metric.value >= OBSERVABILITY_THRESHOLDS.volumeCriticalPercent) {
      addHint(
        check.criticalCode,
        'critical',
        `${check.label} utilization is at or above the critical threshold.`,
        [check.usedPath, check.availablePath]
      )
    } else if (check.metric.value >= OBSERVABILITY_THRESHOLDS.volumeWarningPercent) {
      addHint(
        check.warningCode,
        'warning',
        `${check.label} utilization is at or above the warning threshold.`,
        [check.usedPath, check.availablePath]
      )
    }
  }

  if (readings.host.network.receiveBytesPerSecond.status === 'unavailable'
      || readings.host.network.sendBytesPerSecond.status === 'unavailable') {
    addHint(
      'NETWORK_TELEMETRY_UNAVAILABLE',
      'info',
      'Aggregate non-loopback network receive or send telemetry is unavailable.',
      ['host.network.receiveBytesPerSecond', 'host.network.sendBytesPerSecond']
    )
  }

  if (readings.process.cpuPercent.status === 'available'
      && readings.process.cpuPercent.value >= OBSERVABILITY_THRESHOLDS.processCpuWarningPercent) {
    addHint('PROCESS_CPU_PRESSURE', 'warning', 'Managed process CPU utilization is at or above the warning threshold.', [
      'process.cpuPercent'
    ])
  } else if (readings.process.cpuCoresUsed.status === 'available'
      && readings.host.cpu.logicalProcessorCount.status === 'available'
      && readings.process.cpuCoresUsed.value / readings.host.cpu.logicalProcessorCount.value >= 0.9) {
    addHint(
      'PROCESS_CPU_PRESSURE',
      'warning',
      'Managed process CPU core-equivalent use is at or above 90% of the reported logical processors.',
      ['process.cpuCoresUsed', 'host.cpu.logicalProcessorCount']
    )
  }

  if (readings.process.workingSetBytes.status === 'available'
      && readings.host.memory.totalBytes.status === 'available') {
    const fraction = readings.process.workingSetBytes.value / readings.host.memory.totalBytes.value
    if (fraction >= OBSERVABILITY_THRESHOLDS.processMemoryWarningFraction) {
      addHint(
        'PROCESS_MEMORY_DOMINANT',
        fraction >= OBSERVABILITY_THRESHOLDS.processMemoryCriticalFraction ? 'critical' : 'warning',
        'Managed process working set consumes a high fraction of total host memory.',
        ['process.workingSetBytes', 'host.memory.totalBytes']
      )
    }
  }

  if (readings.runtime.gamePort.listening.status === 'available') {
    if (readings.runtime.state === 'running' && !readings.runtime.gamePort.listening.value) {
      addHint(
        'GAME_PORT_NOT_LISTENING',
        'critical',
        'Runtime is reported as running but the configured game port is not listening.',
        ['runtime.gamePort.listening']
      )
    } else if (readings.runtime.state === 'stopped' && readings.runtime.gamePort.listening.value) {
      addHint(
        'UNEXPECTED_GAME_PORT_LISTENER',
        'warning',
        'Runtime is reported as stopped but the configured game port still has a listener.',
        ['runtime.gamePort.listening']
      )
    }
  }

  if (readings.runtime.state === 'stopped' && readings.runtime.processId.status === 'available') {
    addHint(
      'RUNTIME_PROCESS_STATE_MISMATCH',
      'warning',
      'Runtime is reported as stopped while a managed process identifier is still present.',
      ['runtime.processId']
    )
  }

  if (readings.simulation.ups.status === 'available' && readings.simulation.targetUps.status === 'available') {
    const fraction = readings.simulation.ups.value / readings.simulation.targetUps.value
    if (fraction < OBSERVABILITY_THRESHOLDS.simulationWarningFractionOfTarget) {
      addHint(
        'SIMULATION_BELOW_TARGET',
        fraction < OBSERVABILITY_THRESHOLDS.simulationCriticalFractionOfTarget ? 'critical' : 'warning',
        'Observed UPS is below the configured target threshold.',
        ['simulation.ups', 'simulation.targetUps']
      )
    }
  }

  if (readings.runtime.state === 'running'
      && readings.simulation.ups.status === 'unavailable'
      && readings.simulation.tps.status === 'unavailable') {
    addHint(
      'SIMULATION_TELEMETRY_UNAVAILABLE',
      'info',
      'The running process did not provide UPS or TPS telemetry; no simulation performance is inferred.',
      ['simulation.ups', 'simulation.tps']
    )
  }

  if (readings.runtime.state === 'unknown') {
    addHint(
      'RUNTIME_STATE_UNKNOWN',
      'info',
      'Runtime state is unknown; the snapshot does not infer running or stopped state.',
      []
    )
  }

  const unavailableMetrics = listUnavailableMetrics(readings)
  const essentialUnavailable = listEssentialUnavailableMetrics(readings)
  if (essentialUnavailable.length > 0) {
    addHint(
      'OBSERVABILITY_INCOMPLETE',
      'info',
      'One or more essential health metrics are unavailable; an overall healthy state is not asserted.',
      essentialUnavailable
    )
  }

  hints.sort((left, right) => {
    const severityDifference = severityRank(right.severity) - severityRank(left.severity)
    return severityDifference !== 0 ? severityDifference : left.code.localeCompare(right.code, 'en-US')
  })

  return {
    status: healthStatus(hints, essentialUnavailable.length > 0 || readings.runtime.state === 'unknown'),
    hints,
    unavailableMetrics
  }
}

function listUnavailableMetrics(readings: ServerObservabilityReadings): ObservabilityMetricPath[] {
  const metrics: Array<[ObservabilityMetricPath, MetricAvailability]> = [
    ['runtime.processId', readings.runtime.processId],
    ['runtime.gamePort.port', readings.runtime.gamePort.port],
    ['runtime.gamePort.listening', readings.runtime.gamePort.listening],
    ['host.cpu.logicalProcessorCount', readings.host.cpu.logicalProcessorCount],
    ['host.cpu.totalPercent', readings.host.cpu.totalPercent],
    ['host.cpu.perCorePercent', readings.host.cpu.perCorePercent],
    ['host.memory.totalBytes', readings.host.memory.totalBytes],
    ['host.memory.availableBytes', readings.host.memory.availableBytes],
    ['host.memory.usedBytes', readings.host.memory.usedBytes],
    ['host.memory.usedPercent', readings.host.memory.usedPercent],
    ['host.storage.projectVolume.totalBytes', readings.host.storage.projectVolume.totalBytes],
    ['host.storage.projectVolume.availableBytes', readings.host.storage.projectVolume.availableBytes],
    ['host.storage.projectVolume.usedBytes', readings.host.storage.projectVolume.usedBytes],
    ['host.storage.projectVolume.usedPercent', readings.host.storage.projectVolume.usedPercent],
    ['host.storage.saveVolume.totalBytes', readings.host.storage.saveVolume.totalBytes],
    ['host.storage.saveVolume.availableBytes', readings.host.storage.saveVolume.availableBytes],
    ['host.storage.saveVolume.usedBytes', readings.host.storage.saveVolume.usedBytes],
    ['host.storage.saveVolume.usedPercent', readings.host.storage.saveVolume.usedPercent],
    ['host.network.receiveBytesPerSecond', readings.host.network.receiveBytesPerSecond],
    ['host.network.sendBytesPerSecond', readings.host.network.sendBytesPerSecond],
    ['host.network.sampledInterfaceCount', readings.host.network.sampledInterfaceCount],
    ['process.cpuPercent', readings.process.cpuPercent],
    ['process.cpuCoresUsed', readings.process.cpuCoresUsed],
    ['process.workingSetBytes', readings.process.workingSetBytes],
    ['process.privateBytes', readings.process.privateBytes],
    ['process.threadCount', readings.process.threadCount],
    ['simulation.ups', readings.simulation.ups],
    ['simulation.tps', readings.simulation.tps],
    ['simulation.targetUps', readings.simulation.targetUps]
  ]
  return metrics.filter(([, metric]) => metric.status === 'unavailable').map(([path]) => path)
}

function listEssentialUnavailableMetrics(readings: ServerObservabilityReadings): ObservabilityMetricPath[] {
  const metrics: Array<[ObservabilityMetricPath, MetricAvailability]> = [
    ['host.cpu.totalPercent', readings.host.cpu.totalPercent],
    ['host.memory.usedPercent', readings.host.memory.usedPercent],
    ['runtime.gamePort.port', readings.runtime.gamePort.port],
    ['runtime.gamePort.listening', readings.runtime.gamePort.listening]
  ]
  if (readings.runtime.state === 'running') {
    metrics.push(
      ['runtime.processId', readings.runtime.processId],
      ['process.workingSetBytes', readings.process.workingSetBytes]
    )
  }
  return metrics.filter(([, metric]) => metric.status === 'unavailable').map(([path]) => path)
}

function severityRank(severity: ObservabilityHintSeverity): number {
  return severity === 'critical' ? 3 : severity === 'warning' ? 2 : 1
}

function healthStatus(hints: ObservabilityHint[], incomplete: boolean): ObservabilityHealthStatus {
  if (hints.some((hint) => hint.severity === 'critical')) return 'critical'
  if (hints.some((hint) => hint.severity === 'warning')) return 'warning'
  return incomplete ? 'unknown' : 'healthy'
}

import { parseServerObservabilitySnapshot } from './snapshot.js'
import type { ObservabilityMetric, ServerObservabilitySnapshot } from './types.js'
import { WINDOWS_BRIDGE_OBSERVABILITY_SOURCE } from './windows-bridge.js'

export const LATE_GAME_QUALIFICATION_PROFILE = Object.freeze({
  id: 'late-game-6h-v1',
  minimumSamples: 360,
  minimumSpanMs: 6 * 60 * 60 * 1_000,
  minimumRunningRatio: 0.99,
  maximumCriticalHealthRatio: 0.01,
  minimumMetricCoverage: 0.95,
  minimumUps: 55,
  minimumUpsComplianceRatio: 0.95,
  minimumTps: 55,
  minimumTpsComplianceRatio: 0.95,
  maximumHostCpuP95: 90,
  hottestCoreSaturationPercent: 97,
  maximumHottestCoreSaturationRatio: 0.1,
  maximumSingleCoreBottleneckRatio: 0.05,
  maximumMemoryUsedPercent: 90,
  maximumVolumeUsedPercent: 90,
  minimumVolumeAvailableBytes: 10 * 1_024 * 1_024 * 1_024
} as const)

export type QualificationStatus = 'pass' | 'fail' | 'insufficient'

export interface QualificationCheck {
  id: string
  status: QualificationStatus
  message: string
  observed: Record<string, number | string | null>
  required: Record<string, number | string>
}

export interface LateGameQualificationReport {
  schemaVersion: 1
  kind: 'dyson-late-game-qualification-report'
  profileId: typeof LATE_GAME_QUALIFICATION_PROFILE.id
  result: QualificationStatus
  generatedAt: string
  from: string | null
  to: string | null
  sampleCount: number
  spanMs: number
  checks: QualificationCheck[]
  remainingEvidence: readonly [
    'SAVE_LATENCY_DRILL_REQUIRED',
    'REBOOT_RECOVERY_DRILL_REQUIRED',
    'CRASH_RECOVERY_DRILL_REQUIRED',
    'EXTERNAL_JOIN_SOAK_REQUIRED'
  ]
}

/**
 * Evaluates one bounded telemetry window. A passing report proves only the
 * listed telemetry thresholds; it deliberately cannot promote the wider
 * production acceptance criterion without save/reboot/crash/external drills.
 */
export function evaluateLateGameQualification(
  input: readonly unknown[],
  now: () => Date = () => new Date()
): LateGameQualificationReport {
  const snapshots = input.map((snapshot) => parseServerObservabilitySnapshot(snapshot))
  const ordered = [...snapshots].sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt))
  const from = ordered[0]?.observedAt ?? null
  const to = ordered.at(-1)?.observedAt ?? null
  const spanMs = from === null || to === null ? 0 : Math.max(0, Date.parse(to) - Date.parse(from))
  const running = ordered.filter((snapshot) => snapshot.runtime.state === 'running')
  const checks: QualificationCheck[] = []

  checks.push(evidenceMinimumCheck(
    'window.samples', ordered.length, LATE_GAME_QUALIFICATION_PROFILE.minimumSamples,
    'The retained window contains enough independent samples.'
  ))
  checks.push(evidenceMinimumCheck(
    'window.duration', spanMs, LATE_GAME_QUALIFICATION_PROFILE.minimumSpanMs,
    'The retained window spans the fixed six-hour qualification period.'
  ))

  const runningRatio = ratio(running.length, ordered.length)
  checks.push(ratioMinimumCheck(
    'runtime.running-coverage', runningRatio, LATE_GAME_QUALIFICATION_PROFILE.minimumRunningRatio,
    'The managed runtime remained in the running state.'
  ))

  const criticalCount = ordered.filter((snapshot) => snapshot.health.status === 'critical').length
  checks.push(ratioMaximumCheck(
    'health.critical-ratio', ratio(criticalCount, ordered.length),
    LATE_GAME_QUALIFICATION_PROFILE.maximumCriticalHealthRatio,
    'Critical health samples remained within the allowed ratio.'
  ))

  // Only the Windows provider path that joined a signed, fresh, generation-
  // bound bridge sample may contribute actual simulation rates. A fixture or
  // targetUps value cannot satisfy either coverage gate.
  const actualProviderRunning = running.filter(
    (snapshot) => snapshot.source === WINDOWS_BRIDGE_OBSERVABILITY_SOURCE
  )
  const ups = availableValues(actualProviderRunning, (snapshot) => snapshot.simulation.ups)
  checks.push(coverageCheck('simulation.ups-coverage', ups.length, running.length))
  const upsCompliant = ups.filter((value) => value >= LATE_GAME_QUALIFICATION_PROFILE.minimumUps).length
  checks.push(ratioMinimumCheck(
    'simulation.ups-floor', ratio(upsCompliant, ups.length),
    LATE_GAME_QUALIFICATION_PROFILE.minimumUpsComplianceRatio,
    'At least 95% of available running samples sustained 55 UPS or more.',
    { p05: percentile(ups, 0.05), median: percentile(ups, 0.5) },
    { minimumUps: LATE_GAME_QUALIFICATION_PROFILE.minimumUps }
  ))

  const tps = availableValues(actualProviderRunning, (snapshot) => snapshot.simulation.tps)
  checks.push(coverageCheck('simulation.tps-coverage', tps.length, running.length))
  const tpsCompliant = tps.filter((value) => value >= LATE_GAME_QUALIFICATION_PROFILE.minimumTps).length
  checks.push(ratioMinimumCheck(
    'simulation.tps-floor', ratio(tpsCompliant, tps.length),
    LATE_GAME_QUALIFICATION_PROFILE.minimumTpsComplianceRatio,
    'At least 95% of available running samples sustained 55 actual TPS or more.',
    { p05: percentile(tps, 0.05), median: percentile(tps, 0.5) },
    { minimumTps: LATE_GAME_QUALIFICATION_PROFILE.minimumTps }
  ))

  const hostCpu = availableValues(running, (snapshot) => snapshot.host.cpu.totalPercent)
  checks.push(coverageCheck('host.cpu-coverage', hostCpu.length, running.length))
  checks.push(maximumCheck(
    'host.cpu-p95', percentile(hostCpu, 0.95), LATE_GAME_QUALIFICATION_PROFILE.maximumHostCpuP95,
    'The 95th percentile host CPU load retained headroom.'
  ))

  const hottestCore = availableValues(running, hottestCoreMetric)
  checks.push(coverageCheck('host.per-core-coverage', hottestCore.length, running.length))
  const saturatedCoreSamples = hottestCore.filter(
    (value) => value >= LATE_GAME_QUALIFICATION_PROFILE.hottestCoreSaturationPercent
  ).length
  checks.push(ratioMaximumCheck(
    'host.hottest-core-saturation', ratio(saturatedCoreSamples, hottestCore.length),
    LATE_GAME_QUALIFICATION_PROFILE.maximumHottestCoreSaturationRatio,
    'No logical core stayed saturated for an excessive share of the window.'
  ))

  const bottleneckEligible = running.flatMap((snapshot) => {
    const total = metricValue(snapshot.host.cpu.totalPercent)
    const hottest = metricValue(hottestCoreMetric(snapshot))
    const processCores = metricValue(snapshot.process.cpuCoresUsed)
    return total === null || hottest === null || processCores === null ? [] : [{ total, hottest, processCores }]
  })
  checks.push(coverageCheck('process.multicore-coverage', bottleneckEligible.length, running.length))
  const bottleneckSamples = bottleneckEligible.filter(({ total, hottest, processCores }) =>
    hottest >= LATE_GAME_QUALIFICATION_PROFILE.hottestCoreSaturationPercent && total < 75 && processCores < 1.5
  ).length
  checks.push(ratioMaximumCheck(
    'process.single-core-bottleneck', ratio(bottleneckSamples, bottleneckEligible.length),
    LATE_GAME_QUALIFICATION_PROFILE.maximumSingleCoreBottleneckRatio,
    'A saturated core with low aggregate CPU and low process core use was not persistent.'
  ))

  const memory = availableValues(running, (snapshot) => snapshot.host.memory.usedPercent)
  checks.push(coverageCheck('host.memory-coverage', memory.length, running.length))
  checks.push(maximumCheck(
    'host.memory-peak', maximum(memory), LATE_GAME_QUALIFICATION_PROFILE.maximumMemoryUsedPercent,
    'Peak host memory use stayed below the fixed pressure threshold.'
  ))

  for (const [id, selectUsed, selectAvailable] of [
    [
      'project',
      (snapshot: ServerObservabilitySnapshot) => snapshot.host.storage.projectVolume.usedPercent,
      (snapshot: ServerObservabilitySnapshot) => snapshot.host.storage.projectVolume.availableBytes
    ],
    [
      'save',
      (snapshot: ServerObservabilitySnapshot) => snapshot.host.storage.saveVolume.usedPercent,
      (snapshot: ServerObservabilitySnapshot) => snapshot.host.storage.saveVolume.availableBytes
    ]
  ] as const) {
    const used = availableValues(running, selectUsed)
    const available = availableValues(running, selectAvailable)
    checks.push(coverageCheck(`storage.${id}-coverage`, Math.min(used.length, available.length), running.length))
    checks.push(maximumCheck(
      `storage.${id}-peak-used`, maximum(used), LATE_GAME_QUALIFICATION_PROFILE.maximumVolumeUsedPercent,
      `Peak ${id} volume use stayed below the fixed pressure threshold.`
    ))
    checks.push(minimumCheck(
      `storage.${id}-minimum-free`, minimum(available), LATE_GAME_QUALIFICATION_PROFILE.minimumVolumeAvailableBytes,
      `The ${id} volume retained the fixed minimum free-space reserve.`
    ))
  }


  const classifiedDependencies = ordered.filter(
    (snapshot) => snapshot.automation.storageDependencyKind !== 'unknown'
  )
  checks.push(exactCoverageCheck(
    'storage.dependency-classification',
    classifiedDependencies.length,
    ordered.length,
    'Every retained sample classified the project storage dependency.'
  ))

  const projectRoot = availableBooleanValues(
    ordered,
    (snapshot) => snapshot.automation.projectRootAvailable
  )
  checks.push(exactCoverageCheck(
    'storage.project-root-coverage',
    projectRoot.length,
    ordered.length,
    'Project-root availability was observed in every retained sample.'
  ))
  checks.push(ratioMinimumCheck(
    'storage.project-root-available',
    ratio(projectRoot.filter(Boolean).length, projectRoot.length),
    1,
    'The configured project root remained continuously available.'
  ))

  const smbSamples = ordered.filter(
    (snapshot) => snapshot.automation.storageDependencyKind === 'smb-global-mapping'
  )
  if (smbSamples.length > 0) {
    const mappings = availableBooleanValues(
      smbSamples,
      (snapshot) => snapshot.automation.globalMappingAvailable
    )
    checks.push(exactCoverageCheck(
      'storage.smb-mapping-coverage',
      mappings.length,
      smbSamples.length,
      'SMB global-mapping availability was observed in every applicable sample.'
    ))
    checks.push(ratioMinimumCheck(
      'storage.smb-mapping-available',
      ratio(mappings.filter(Boolean).length, mappings.length),
      1,
      'The configured SMB global mapping remained continuously available.'
    ))

    const taskObservations = smbSamples.flatMap((snapshot) => {
      const state = snapshot.automation.storageTask.state
      const result = snapshot.automation.storageTask.lastResult
      return state.status === 'available' && result.status === 'available'
        ? [{ state: state.value, result: result.value }]
        : []
    })
    checks.push(exactCoverageCheck(
      'storage.recovery-task-coverage',
      taskObservations.length,
      smbSamples.length,
      'Storage recovery-task state and result were observed in every applicable sample.'
    ))
    checks.push(ratioMinimumCheck(
      'storage.recovery-task-healthy',
      ratio(taskObservations.filter(({ state, result }) =>
        (state === 'ready' || state === 'running') && result === 0).length, taskObservations.length),
      1,
      'The storage recovery task remained enabled and failure-free.'
    ))
  } else {
    checks.push(notApplicableCheck(
      'storage.smb-mapping-coverage',
      'No retained sample declared an SMB global-mapping dependency.'
    ))
    checks.push(notApplicableCheck(
      'storage.smb-mapping-available',
      'No retained sample declared an SMB global-mapping dependency.'
    ))
    checks.push(notApplicableCheck(
      'storage.recovery-task-coverage',
      'No retained sample declared an SMB global-mapping dependency.'
    ))
    checks.push(notApplicableCheck(
      'storage.recovery-task-healthy',
      'No retained sample declared an SMB global-mapping dependency.'
    ))
  }

  const result: QualificationStatus = checks.some((check) => check.status === 'insufficient')
    ? 'insufficient'
    : checks.some((check) => check.status === 'fail')
      ? 'fail'
      : 'pass'

  return {
    schemaVersion: 1,
    kind: 'dyson-late-game-qualification-report',
    profileId: LATE_GAME_QUALIFICATION_PROFILE.id,
    result,
    generatedAt: now().toISOString(),
    from,
    to,
    sampleCount: ordered.length,
    spanMs,
    checks,
    remainingEvidence: [
      'SAVE_LATENCY_DRILL_REQUIRED',
      'REBOOT_RECOVERY_DRILL_REQUIRED',
      'CRASH_RECOVERY_DRILL_REQUIRED',
      'EXTERNAL_JOIN_SOAK_REQUIRED'
    ]
  }
}

function hottestCoreMetric(snapshot: ServerObservabilitySnapshot): ObservabilityMetric<number> {
  const cores = snapshot.host.cpu.perCorePercent
  if (cores.status === 'unavailable') return cores
  return { status: 'available', value: Math.max(...cores.value.map((core) => core.percent)) }
}

function availableValues(
  snapshots: readonly ServerObservabilitySnapshot[],
  select: (snapshot: ServerObservabilitySnapshot) => ObservabilityMetric<number>
): number[] {
  return snapshots.flatMap((snapshot) => {
    const value = metricValue(select(snapshot))
    return value === null ? [] : [value]
  })
}

function availableBooleanValues(
  snapshots: readonly ServerObservabilitySnapshot[],
  select: (snapshot: ServerObservabilitySnapshot) => ObservabilityMetric<boolean>
): boolean[] {
  return snapshots.flatMap((snapshot) => {
    const metric = select(snapshot)
    return metric.status === 'available' ? [metric.value] : []
  })
}

function metricValue(metric: ObservabilityMetric<number>): number | null {
  return metric.status === 'available' ? metric.value : null
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index] ?? null
}

function maximum(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.max(...values)
}

function minimum(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.min(...values)
}

function minimumCheck(id: string, observed: number | null, required: number, message: string): QualificationCheck {
  return comparisonCheck(id, observed, required, 'minimum', message, (value) => value >= required)
}

function maximumCheck(id: string, observed: number | null, required: number, message: string): QualificationCheck {
  return comparisonCheck(id, observed, required, 'maximum', message, (value) => value <= required)
}

function ratioMinimumCheck(
  id: string,
  observed: number | null,
  required: number,
  message: string,
  extraObserved: Record<string, number | null> = {},
  extraRequired: Record<string, number> = {}
): QualificationCheck {
  return comparisonCheck(id, observed, required, 'minimumRatio', message, (value) => value >= required,
    extraObserved, extraRequired)
}

function ratioMaximumCheck(id: string, observed: number | null, required: number, message: string): QualificationCheck {
  return comparisonCheck(id, observed, required, 'maximumRatio', message, (value) => value <= required)
}

function coverageCheck(id: string, observedSamples: number, totalSamples: number): QualificationCheck {
  const observedRatio = ratio(observedSamples, totalSamples)
  const required = LATE_GAME_QUALIFICATION_PROFILE.minimumMetricCoverage
  return {
    id,
    status: observedRatio !== null && observedRatio >= required ? 'pass' : 'insufficient',
    message: 'The metric was available for enough running samples.',
    observed: { value: observedRatio, observedSamples, totalSamples },
    required: { minimumRatio: required }
  }
}

function exactCoverageCheck(
  id: string,
  observedSamples: number,
  totalSamples: number,
  message: string
): QualificationCheck {
  const observedRatio = ratio(observedSamples, totalSamples)
  return {
    id,
    status: observedRatio !== null && observedRatio === 1 ? 'pass' : 'insufficient',
    message,
    observed: { value: observedRatio, observedSamples, totalSamples },
    required: { minimumRatio: 1 }
  }
}

function notApplicableCheck(id: string, message: string): QualificationCheck {
  return {
    id,
    status: 'pass',
    message,
    observed: { mode: 'not-applicable' },
    required: { storageDependencyKind: 'smb-global-mapping' }
  }
}

function evidenceMinimumCheck(
  id: string,
  observed: number,
  required: number,
  message: string
): QualificationCheck {
  return {
    id,
    status: observed >= required ? 'pass' : 'insufficient',
    message,
    observed: { value: observed },
    required: { minimum: required }
  }
}

function comparisonCheck(
  id: string,
  observed: number | null,
  required: number,
  requiredKey: string,
  message: string,
  passes: (value: number) => boolean,
  extraObserved: Record<string, number | null> = {},
  extraRequired: Record<string, number> = {}
): QualificationCheck {
  return {
    id,
    status: observed === null ? 'insufficient' : passes(observed) ? 'pass' : 'fail',
    message,
    observed: { value: observed, ...extraObserved },
    required: { [requiredKey]: required, ...extraRequired }
  }
}

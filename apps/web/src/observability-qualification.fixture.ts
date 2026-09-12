import type {
  ObservabilityQualificationEnvelope, QualificationCheck, QualificationCheckId
} from './model'

const sampleCount = 361
const spanMs = 21_600_000
const tenGiB = 10_737_418_240

export function qualificationEnvelopeFixture(): ObservabilityQualificationEnvelope {
  return {
    data: {
      schemaVersion: 1,
      kind: 'dyson-late-game-qualification-report',
      profileId: 'late-game-6h-v1',
      result: 'pass',
      generatedAt: '2026-08-30T12:00:30.000Z',
      from: '2026-08-30T06:00:00.000Z',
      to: '2026-08-30T12:00:00.000Z',
      sampleCount,
      spanMs,
      checks: qualificationChecks(),
      continuity72h: {
        schemaVersion: 1,
        kind: 'dyson-observability-72h-continuity-report',
        result: 'pass',
        chainIntegrity: 'verified',
        sampleCount: 17_281,
        from: '2026-08-27T12:00:00.000Z',
        to: '2026-08-30T12:00:00.000Z',
        spanMs: 259_200_000,
        checks: longWindowChecks()
      },
      latency: {
        schemaVersion: 1,
        kind: 'dyson-server-receipt-latency-report',
        evidenceStatus: 'not-qualified',
        generatedAt: '2026-08-30T12:00:30.000Z',
        scannedJobs: 12,
        truncated: false,
        save: {
          operation: 'save', evidenceStatus: 'not-qualified', totalReceipts: 5,
          successfulReceipts: 4, failedReceipts: 1, incompleteReceipts: 0,
          p50Ms: 4_000, p95Ms: 8_000, maximumMs: 8_000
        },
        backup: {
          operation: 'backup', evidenceStatus: 'not-qualified', totalReceipts: 3,
          successfulReceipts: 2, failedReceipts: 0, incompleteReceipts: 1,
          p50Ms: 25_000, p95Ms: 32_000, maximumMs: 32_000
        }
      },
      remainingEvidence: [
        'SAVE_LATENCY_DRILL_REQUIRED',
        'REBOOT_RECOVERY_DRILL_REQUIRED',
        'CRASH_RECOVERY_DRILL_REQUIRED',
        'EXTERNAL_JOIN_SOAK_REQUIRED'
      ]
    },
    meta: { provider: 'windows', environment: 'test', capacity: 720, longWindowCapacity: 20_000 }
  }
}

export function makeQualificationInsufficient(
  envelope: ObservabilityQualificationEnvelope,
  checkId: QualificationCheckId
): ObservabilityQualificationEnvelope {
  const copy = structuredClone(envelope)
  const check = copy.data.checks.find((candidate) => candidate.id === checkId)
  if (!check) throw new Error(`Missing qualification fixture check: ${checkId}`)
  check.status = 'insufficient'
  for (const key of Object.keys(check.observed)) check.observed[key] = null
  if (Object.hasOwn(check.observed, 'observedSamples')) {
    check.observed.observedSamples = 0
    check.observed.totalSamples = 0
  }
  check.message = 'Upstream telemetry was unavailable for this fixed check.'
  copy.data.result = 'insufficient'
  return copy
}

function qualificationChecks(): QualificationCheck[] {
  const coverage = (id: QualificationCheckId, label: string): QualificationCheck => ({
    id,
    status: 'pass',
    message: `${label} coverage passed.`,
    observed: { value: 1, observedSamples: sampleCount, totalSamples: sampleCount },
    required: { minimumRatio: 0.95 }
  })
  const check = (
    id: QualificationCheckId,
    observed: QualificationCheck['observed'],
    required: QualificationCheck['required']
  ): QualificationCheck => ({ id, status: 'pass', message: `${id} passed.`, observed, required })

  return [
    check('window.samples', { value: sampleCount }, { minimum: 360 }),
    check('window.duration', { value: spanMs }, { minimum: spanMs }),
    check('runtime.running-coverage', { value: 0.995 }, { minimumRatio: 0.99 }),
    check('health.critical-ratio', { value: 0 }, { maximumRatio: 0.01 }),
    coverage('simulation.ups-coverage', 'UPS'),
    check('simulation.ups-floor', { value: 0.98, p05: 58.4, median: 60 }, {
      minimumRatio: 0.95, minimumUps: 55
    }),
    coverage('simulation.tps-coverage', 'TPS'),
    check('simulation.tps-floor', { value: 0.975, p05: 57.9, median: 60 }, {
      minimumRatio: 0.95, minimumTps: 55
    }),
    coverage('host.cpu-coverage', 'Host CPU'),
    check('host.cpu-p95', { value: 67.5 }, { maximum: 90 }),
    coverage('host.per-core-coverage', 'Per-core CPU'),
    check('host.hottest-core-saturation', { value: 0.02 }, { maximumRatio: 0.1 }),
    coverage('process.multicore-coverage', 'DSP multicore'),
    check('process.single-core-bottleneck', { value: 0.01 }, { maximumRatio: 0.05 }),
    coverage('host.memory-coverage', 'Memory'),
    check('host.memory-peak', { value: 72.25 }, { maximum: 90 }),
    coverage('storage.project-coverage', 'Project volume'),
    check('storage.project-peak-used', { value: 61.5 }, { maximum: 90 }),
    check('storage.project-minimum-free', { value: 24 * 1_024 ** 3 }, { minimum: tenGiB }),
    coverage('storage.save-coverage', 'Save volume'),
    check('storage.save-peak-used', { value: 54.75 }, { maximum: 90 }),
    check('storage.save-minimum-free', { value: 42 * 1_024 ** 3 }, { minimum: tenGiB }),
    check('storage.dependency-classification', {
      value: 1, observedSamples: sampleCount, totalSamples: sampleCount
    }, { minimumRatio: 1 }),
    check('storage.project-root-coverage', {
      value: 1, observedSamples: sampleCount, totalSamples: sampleCount
    }, { minimumRatio: 1 }),
    check('storage.project-root-available', { value: 1 }, { minimumRatio: 1 }),
    check('storage.smb-mapping-coverage', {
      value: 1, observedSamples: sampleCount, totalSamples: sampleCount
    }, { minimumRatio: 1 }),
    check('storage.smb-mapping-available', { value: 1 }, { minimumRatio: 1 }),
    check('storage.recovery-task-coverage', {
      value: 1, observedSamples: sampleCount, totalSamples: sampleCount
    }, { minimumRatio: 1 }),
    check('storage.recovery-task-healthy', { value: 1 }, { minimumRatio: 1 })
  ]
}

function longWindowChecks(): ObservabilityQualificationEnvelope['data']['continuity72h']['checks'] {
  const minimum = (id: 'window.samples' | 'window.duration', value: number, required: number) => ({
    id, status: 'pass' as const, observed: { value }, required: { minimum: required }
  })
  const exact = (id: Exclude<ObservabilityQualificationEnvelope['data']['continuity72h']['checks'][number]['id'],
    'window.samples' | 'window.duration' | 'window.maximum-gap'>, value: number | boolean) => ({
    id,
    status: 'pass' as const,
    observed: { value },
    required: { exact: typeof value === 'boolean' ? true : 1 }
  })
  return [
    minimum('window.samples', 17_281, 17_281),
    minimum('window.duration', 259_200_000, 259_200_000),
    { id: 'window.maximum-gap', status: 'pass', observed: { value: 15_000 }, required: { maximum: 30_000 } },
    exact('runtime.source-stable', 1),
    exact('runtime.identity-stable', 1),
    exact('runtime.running', true),
    exact('runtime.game-port-listening', true),
    exact('storage.dependency-kind-stable', 1),
    exact('storage.dependency-classified', true),
    exact('storage.project-root-available', true),
    exact('storage.smb-mapping-available', true),
    exact('storage.recovery-task-healthy', true)
  ]
}

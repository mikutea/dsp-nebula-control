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
      remainingEvidence: [
        'SAVE_LATENCY_DRILL_REQUIRED',
        'REBOOT_RECOVERY_DRILL_REQUIRED',
        'CRASH_RECOVERY_DRILL_REQUIRED',
        'EXTERNAL_JOIN_SOAK_REQUIRED'
      ]
    },
    meta: { provider: 'windows', environment: 'test', capacity: 720 }
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
    check('storage.save-minimum-free', { value: 42 * 1_024 ** 3 }, { minimum: tenGiB })
  ]
}

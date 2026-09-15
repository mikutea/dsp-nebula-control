import { createHash } from 'node:crypto'
import { z } from 'zod'
import { ObservabilityError } from './errors.js'
import { parseServerObservabilitySnapshot } from './snapshot.js'
import {
  OBSERVABILITY_RUNTIME_STATES,
  OBSERVABILITY_STORAGE_DEPENDENCY_KINDS,
  OBSERVABILITY_TASK_STATES,
  type ObservabilityMetric,
  type ServerObservabilitySnapshot
} from './types.js'

export const OBSERVABILITY_72H_DURATION_MS = 72 * 60 * 60 * 1_000
export const OBSERVABILITY_72H_SAMPLE_INTERVAL_MS = 15_000
export const OBSERVABILITY_72H_MINIMUM_SAMPLES =
  OBSERVABILITY_72H_DURATION_MS / OBSERVABILITY_72H_SAMPLE_INTERVAL_MS + 1
export const DEFAULT_OBSERVABILITY_LONG_WINDOW_CAPACITY = 20_000
export const MAXIMUM_OBSERVABILITY_LONG_WINDOW_CAPACITY = 86_400
export const DEFAULT_OBSERVABILITY_LONG_WINDOW_MAXIMUM_GAP_MS = 30_000

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const nullableFiniteNumber = z.number().finite().nullable()
const nullableSafeInteger = z.number().int().safe().nullable()

const unsignedLongWindowSampleSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('dyson-observability-long-window-sample'),
  observedAt: z.string().max(64).datetime({ offset: true }),
  source: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  predecessorSha256: digestSchema.nullable(),
  runtime: z.strictObject({
    state: z.enum(OBSERVABILITY_RUNTIME_STATES),
    processId: nullableSafeInteger,
    // Optional preserves digest verification for v1 samples persisted before
    // generation binding. Such samples are readable but cannot pass identity.
    processStartedAt: z.string().max(64).datetime({ offset: true }).nullable().optional(),
    gamePortListening: z.boolean().nullable()
  }),
  performance: z.strictObject({
    hostCpuPercent: nullableFiniteNumber,
    hottestCorePercent: nullableFiniteNumber,
    processCpuCoresUsed: nullableFiniteNumber,
    memoryUsedPercent: nullableFiniteNumber,
    processPrivateBytes: nullableSafeInteger,
    projectVolumeUsedPercent: nullableFiniteNumber,
    projectVolumeAvailableBytes: nullableSafeInteger,
    saveVolumeUsedPercent: nullableFiniteNumber,
    saveVolumeAvailableBytes: nullableSafeInteger,
    ups: nullableFiniteNumber,
    tps: nullableFiniteNumber
  }),
  storageDependency: z.strictObject({
    kind: z.enum(OBSERVABILITY_STORAGE_DEPENDENCY_KINDS),
    projectRootAvailable: z.boolean().nullable(),
    globalMappingAvailable: z.boolean().nullable(),
    storageTaskState: z.enum(OBSERVABILITY_TASK_STATES).nullable(),
    storageTaskLastResult: nullableSafeInteger
  }),
  health: z.strictObject({
    status: z.enum(['healthy', 'unknown', 'warning', 'critical'])
  })
}).superRefine((sample, context) => {
  if (sample.runtime.processStartedAt != null
      && Date.parse(sample.runtime.processStartedAt) > Date.parse(sample.observedAt)) {
    context.addIssue({
      code: 'custom',
      message: 'runtime start time cannot follow the observation time',
      path: ['runtime', 'processStartedAt']
    })
  }
})

const longWindowSampleSchema = unsignedLongWindowSampleSchema.extend({
  sampleSha256: digestSchema
})

type UnsignedLongWindowSample = z.infer<typeof unsignedLongWindowSampleSchema>
export type ObservabilityLongWindowSample = z.infer<typeof longWindowSampleSchema>

export type LongWindowCheckStatus = 'pass' | 'fail' | 'insufficient'

export interface ObservabilityLongWindowCheck {
  id: string
  status: LongWindowCheckStatus
  observed: Record<string, number | string | boolean | null>
  required: Record<string, number | string | boolean>
}

export interface ObservabilityLongWindowReport {
  schemaVersion: 1
  kind: 'dyson-observability-72h-continuity-report'
  result: LongWindowCheckStatus
  chainIntegrity: 'verified' | 'unknown'
  sampleCount: number
  from: string | null
  to: string | null
  spanMs: number
  checks: ObservabilityLongWindowCheck[]
}

export function buildObservabilityLongWindowSample(
  input: unknown,
  predecessorSha256: string | null
): ObservabilityLongWindowSample {
  const snapshot = parseServerObservabilitySnapshot(input)
  if (predecessorSha256 !== null && !digestSchema.safeParse(predecessorSha256).success) {
    throw new ObservabilityError('OBSERVABILITY_LONG_WINDOW_PREDECESSOR_INVALID')
  }
  const unsigned: UnsignedLongWindowSample = {
    schemaVersion: 1,
    kind: 'dyson-observability-long-window-sample',
    observedAt: snapshot.observedAt,
    source: snapshot.source,
    predecessorSha256,
    runtime: {
      state: snapshot.runtime.state,
      processId: metricValue(snapshot.runtime.processId),
      processStartedAt: metricValue(snapshot.runtime.startedAt),
      gamePortListening: metricValue(snapshot.runtime.gamePort.listening)
    },
    performance: {
      hostCpuPercent: metricValue(snapshot.host.cpu.totalPercent),
      hottestCorePercent: hottestCore(snapshot),
      processCpuCoresUsed: metricValue(snapshot.process.cpuCoresUsed),
      memoryUsedPercent: metricValue(snapshot.host.memory.usedPercent),
      processPrivateBytes: metricValue(snapshot.process.privateBytes),
      projectVolumeUsedPercent: metricValue(snapshot.host.storage.projectVolume.usedPercent),
      projectVolumeAvailableBytes: metricValue(snapshot.host.storage.projectVolume.availableBytes),
      saveVolumeUsedPercent: metricValue(snapshot.host.storage.saveVolume.usedPercent),
      saveVolumeAvailableBytes: metricValue(snapshot.host.storage.saveVolume.availableBytes),
      ups: metricValue(snapshot.simulation.ups),
      tps: metricValue(snapshot.simulation.tps)
    },
    storageDependency: {
      kind: snapshot.automation.storageDependencyKind,
      projectRootAvailable: metricValue(snapshot.automation.projectRootAvailable),
      globalMappingAvailable: metricValue(snapshot.automation.globalMappingAvailable),
      storageTaskState: metricValue(snapshot.automation.storageTask.state),
      storageTaskLastResult: metricValue(snapshot.automation.storageTask.lastResult)
    },
    health: { status: snapshot.health.status }
  }
  return { ...unsigned, sampleSha256: digest(unsigned) }
}

export function parseObservabilityLongWindowSample(input: unknown): ObservabilityLongWindowSample {
  const parsed = longWindowSampleSchema.safeParse(input)
  if (!parsed.success) {
    throw new ObservabilityError('OBSERVABILITY_LONG_WINDOW_SAMPLE_INVALID', parsed.error)
  }
  const { sampleSha256, ...unsigned } = parsed.data
  if (digest(unsigned) !== sampleSha256) {
    throw new ObservabilityError('OBSERVABILITY_LONG_WINDOW_DIGEST_MISMATCH')
  }
  return parsed.data
}

export class BoundedObservabilityLongWindow {
  readonly #capacity: number
  readonly #samples: ObservabilityLongWindowSample[] = []
  #droppedSamples = 0

  constructor(capacity = DEFAULT_OBSERVABILITY_LONG_WINDOW_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAXIMUM_OBSERVABILITY_LONG_WINDOW_CAPACITY) {
      throw new ObservabilityError('OBSERVABILITY_LONG_WINDOW_LIMIT_INVALID')
    }
    this.#capacity = capacity
  }

  get capacity(): number { return this.#capacity }
  get size(): number { return this.#samples.length }
  get droppedSamples(): number { return this.#droppedSamples }
  get chainHeadSha256(): string | null { return this.#samples.at(-1)?.sampleSha256 ?? null }

  prepare(input: unknown): ObservabilityLongWindowSample {
    const next = buildObservabilityLongWindowSample(input, this.chainHeadSha256)
    const latest = this.#samples.at(-1)
    if (latest && Date.parse(next.observedAt) <= Date.parse(latest.observedAt)) {
      throw new ObservabilityError('OBSERVABILITY_LONG_WINDOW_TIME_NOT_INCREASING')
    }
    return next
  }

  ingest(input: unknown): ObservabilityLongWindowSample {
    const parsed = parseObservabilityLongWindowSample(input)
    const latest = this.#samples.at(-1)
    if (latest) {
      if (parsed.predecessorSha256 !== latest.sampleSha256) {
        throw new ObservabilityError('OBSERVABILITY_LONG_WINDOW_CHAIN_MISMATCH')
      }
      if (Date.parse(parsed.observedAt) <= Date.parse(latest.observedAt)) {
        throw new ObservabilityError('OBSERVABILITY_LONG_WINDOW_TIME_NOT_INCREASING')
      }
    }
    this.#samples.push(structuredClone(parsed))
    if (this.#samples.length > this.#capacity) {
      this.#samples.shift()
      this.#droppedSamples++
    }
    return structuredClone(parsed)
  }

  list(): ObservabilityLongWindowSample[] {
    return structuredClone(this.#samples)
  }

  report(
    minimumSpanMs = OBSERVABILITY_72H_DURATION_MS,
    minimumSamples = OBSERVABILITY_72H_MINIMUM_SAMPLES,
    maximumGapMs = DEFAULT_OBSERVABILITY_LONG_WINDOW_MAXIMUM_GAP_MS
  ): ObservabilityLongWindowReport {
    return evaluateObservabilityLongWindow(this.#samples, minimumSpanMs, minimumSamples, maximumGapMs)
  }
}

export function evaluateObservabilityLongWindow(
  input: readonly unknown[],
  minimumSpanMs = OBSERVABILITY_72H_DURATION_MS,
  minimumSamples = OBSERVABILITY_72H_MINIMUM_SAMPLES,
  maximumGapMs = DEFAULT_OBSERVABILITY_LONG_WINDOW_MAXIMUM_GAP_MS
): ObservabilityLongWindowReport {
  if (!Number.isSafeInteger(minimumSpanMs) || minimumSpanMs < 1
      || !Number.isSafeInteger(minimumSamples) || minimumSamples < 2
      || !Number.isSafeInteger(maximumGapMs) || maximumGapMs < 1) {
    throw new ObservabilityError('OBSERVABILITY_LONG_WINDOW_PROFILE_INVALID')
  }
  const samples = input.map(parseObservabilityLongWindowSample)
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1]!
    const current = samples[index]!
    if (current.predecessorSha256 !== previous.sampleSha256) {
      throw new ObservabilityError('OBSERVABILITY_LONG_WINDOW_CHAIN_MISMATCH')
    }
    if (Date.parse(current.observedAt) <= Date.parse(previous.observedAt)) {
      throw new ObservabilityError('OBSERVABILITY_LONG_WINDOW_TIME_NOT_INCREASING')
    }
  }

  const first = samples[0]
  const last = samples.at(-1)
  const spanMs = first && last ? Date.parse(last.observedAt) - Date.parse(first.observedAt) : 0
  const gaps = samples.slice(1).map((sample, index) =>
    Date.parse(sample.observedAt) - Date.parse(samples[index]!.observedAt))
  const maxGap = gaps.length === 0 ? null : Math.max(...gaps)
  const checks: ObservabilityLongWindowCheck[] = [
    minimumCheck('window.samples', samples.length, minimumSamples),
    minimumCheck('window.duration', spanMs, minimumSpanMs),
    maximumCheck('window.maximum-gap', maxGap, maximumGapMs),
    equalityCheck('runtime.source-stable', new Set(samples.map((sample) => sample.source)).size, 1),
    equalityCheck('runtime.identity-stable', runtimeIdentityCount(samples), 1),
    booleanCheck(
      'runtime.running',
      samples.length > 0 && samples.every((sample) => sample.runtime.state === 'running'
        && sample.runtime.processId !== null)
    ),
    booleanCheck(
      'runtime.game-port-listening',
      samples.length > 0 && samples.every((sample) => sample.runtime.gamePortListening === true)
    ),
    equalityCheck(
      'storage.dependency-kind-stable',
      new Set(samples.map((sample) => sample.storageDependency.kind)).size,
      1
    ),
    booleanCheck(
      'storage.dependency-classified',
      samples.length > 0 && samples.every((sample) => sample.storageDependency.kind !== 'unknown')
    ),
    booleanCheck(
      'storage.project-root-available',
      samples.length > 0 && samples.every((sample) => sample.storageDependency.projectRootAvailable === true)
    )
  ]

  const smbSamples = samples.filter((sample) => sample.storageDependency.kind === 'smb-global-mapping')
  checks.push(booleanCheck(
    'storage.smb-mapping-available',
    smbSamples.length === 0 || smbSamples.every((sample) => sample.storageDependency.globalMappingAvailable === true)
  ))
  checks.push(booleanCheck(
    'storage.recovery-task-healthy',
    smbSamples.length === 0 || smbSamples.every((sample) =>
      (sample.storageDependency.storageTaskState === 'ready'
        || sample.storageDependency.storageTaskState === 'running')
      && sample.storageDependency.storageTaskLastResult === 0)
  ))

  const result: LongWindowCheckStatus = checks.some((check) => check.status === 'insufficient')
    ? 'insufficient'
    : checks.some((check) => check.status === 'fail') ? 'fail' : 'pass'
  return {
    schemaVersion: 1,
    kind: 'dyson-observability-72h-continuity-report',
    result,
    chainIntegrity: samples.length === 0 ? 'unknown' : 'verified',
    sampleCount: samples.length,
    from: first?.observedAt ?? null,
    to: last?.observedAt ?? null,
    spanMs,
    checks
  }
}

function metricValue<T>(metric: ObservabilityMetric<T>): T | null {
  return metric.status === 'available' ? metric.value : null
}

function hottestCore(snapshot: ServerObservabilitySnapshot): number | null {
  const metric = snapshot.host.cpu.perCorePercent
  return metric.status === 'available'
    ? Math.max(...metric.value.map((core) => core.percent))
    : null
}

function runtimeIdentityCount(samples: readonly ObservabilityLongWindowSample[]): number {
  if (samples.length === 0 || samples.some((sample) => sample.runtime.processStartedAt == null)) return 0
  return new Set(samples.map((sample) => JSON.stringify([
    sample.source,
    sample.runtime.state,
    sample.runtime.processId,
    sample.runtime.processStartedAt
  ]))).size
}

function digest(value: UnsignedLongWindowSample): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

function minimumCheck(id: string, value: number | null, required: number): ObservabilityLongWindowCheck {
  return {
    id,
    status: value === null ? 'insufficient' : value >= required ? 'pass' : 'insufficient',
    observed: { value },
    required: { minimum: required }
  }
}

function maximumCheck(id: string, value: number | null, required: number): ObservabilityLongWindowCheck {
  return {
    id,
    status: value === null ? 'insufficient' : value <= required ? 'pass' : 'fail',
    observed: { value },
    required: { maximum: required }
  }
}

function equalityCheck(id: string, value: number, required: number): ObservabilityLongWindowCheck {
  return {
    id,
    status: value === 0 ? 'insufficient' : value === required ? 'pass' : 'fail',
    observed: { value },
    required: { exact: required }
  }
}

function booleanCheck(id: string, value: boolean): ObservabilityLongWindowCheck {
  return {
    id,
    status: value ? 'pass' : 'fail',
    observed: { value },
    required: { exact: true }
  }
}

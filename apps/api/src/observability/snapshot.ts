import { z } from 'zod'
import { ObservabilityError } from './errors.js'
import { evaluateObservabilityHealth } from './health.js'
import {
  OBSERVABILITY_HINT_CODES,
  OBSERVABILITY_METRIC_PATHS,
  OBSERVABILITY_RUNTIME_STATES,
  OBSERVABILITY_UNAVAILABLE_REASONS,
  type CoreCpuUsage,
  type ObservabilityMetric,
  type ObservabilityUnavailableReason,
  type ServerObservabilityReadings,
  type ServerObservabilitySnapshot,
  type VolumeObservabilityReadings
} from './types.js'

const maximumLogicalProcessors = 4_096
const maximumSourceLength = 64
const maximumThreadCount = 1_000_000
const maximumSimulationRate = 10_000
const maximumSafeInteger = Number.MAX_SAFE_INTEGER

const percentageSchema = z.number().finite().min(0).max(100)
const byteCountSchema = z.number().int().min(0).max(maximumSafeInteger)
const positiveByteCountSchema = z.number().int().min(1).max(maximumSafeInteger)
const optionalPercentageSchema = percentageSchema.nullable().optional()
const optionalByteCountSchema = byteCountSchema.nullable().optional()
const optionalCpuUnavailableReasonSchema = z.enum([
  'not-provided',
  'source-reported-unavailable',
  'dependency-unavailable',
  'cim-unavailable',
  'inconsistent-sample'
]).nullable().optional()
const optionalVolumeUnavailableReasonSchema = z.enum([
  'not-provided',
  'source-reported-unavailable',
  'dependency-unavailable',
  'volume-unavailable',
  'inconsistent-sample'
]).nullable().optional()
const optionalNetworkUnavailableReasonSchema = z.enum([
  'not-provided',
  'source-reported-unavailable',
  'dependency-unavailable',
  'network-counters-unavailable',
  'no-eligible-network-interface',
  'inconsistent-sample'
]).nullable().optional()

const coreCpuSampleSchema = z.strictObject({
  index: z.number().int().min(0).max(maximumLogicalProcessors - 1),
  percent: percentageSchema
})

const trustedVolumeSampleSchema = z.strictObject({
  totalBytes: positiveByteCountSchema.nullable().optional(),
  availableBytes: optionalByteCountSchema,
  unavailableReason: optionalVolumeUnavailableReasonSchema
}).superRefine((value, context) => {
  const hasTotal = value.totalBytes !== undefined && value.totalBytes !== null
  const hasAvailable = value.availableBytes !== undefined && value.availableBytes !== null
  if (hasTotal !== hasAvailable) {
    context.addIssue({ code: 'custom', message: 'volume byte totals must be supplied as a pair' })
  }
  if ((hasTotal || hasAvailable) && value.unavailableReason !== undefined && value.unavailableReason !== null) {
    context.addIssue({ code: 'custom', message: 'available volume values cannot carry an unavailable reason' })
  }
})

const trustedHostNetworkSampleSchema = z.strictObject({
  receiveBytesPerSecond: optionalByteCountSchema,
  sendBytesPerSecond: optionalByteCountSchema,
  sampledInterfaceCount: z.number().int().min(1).max(maximumLogicalProcessors).nullable().optional(),
  unavailableReason: optionalNetworkUnavailableReasonSchema
}).superRefine((value, context) => {
  const availability = [value.receiveBytesPerSecond, value.sendBytesPerSecond, value.sampledInterfaceCount]
    .map((entry) => entry !== undefined && entry !== null)
  if (availability.some(Boolean) && !availability.every(Boolean)) {
    context.addIssue({ code: 'custom', message: 'network rate values must be supplied as one aggregate sample' })
  }
  if (availability.every(Boolean) && value.unavailableReason !== undefined && value.unavailableReason !== null) {
    context.addIssue({ code: 'custom', message: 'available network values cannot carry an unavailable reason' })
  }
})

type TrustedVolumeSample = z.infer<typeof trustedVolumeSampleSchema>

export const trustedServerObservabilitySampleSchema = z.strictObject({
  schemaVersion: z.literal(1),
  observedAt: z.string().max(64).datetime({ offset: true }),
  source: z.string().min(1).max(maximumSourceLength).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  runtime: z.strictObject({
    state: z.enum(OBSERVABILITY_RUNTIME_STATES),
    processId: z.number().int().min(1).max(4_294_967_295).nullable().optional()
  }),
  host: z.strictObject({
    cpu: z.strictObject({
      logicalProcessorCount: z.number().int().min(1).max(maximumLogicalProcessors).nullable().optional(),
      totalPercent: optionalPercentageSchema,
      cores: z.array(coreCpuSampleSchema).min(1).max(maximumLogicalProcessors).nullable().optional(),
      coresUnavailableReason: optionalCpuUnavailableReasonSchema
    }).superRefine((value, context) => {
      if (value.cores !== undefined && value.cores !== null
          && value.coresUnavailableReason !== undefined && value.coresUnavailableReason !== null) {
        context.addIssue({ code: 'custom', message: 'available core samples cannot carry an unavailable reason' })
      }
    }).nullable().optional(),
    memory: z.strictObject({
      totalBytes: positiveByteCountSchema.nullable().optional(),
      availableBytes: optionalByteCountSchema
    }).nullable().optional(),
    storage: z.strictObject({
      projectVolume: trustedVolumeSampleSchema.nullable().optional(),
      saveVolume: trustedVolumeSampleSchema.nullable().optional()
    }).nullable().optional(),
    network: trustedHostNetworkSampleSchema.nullable().optional()
  }),
  process: z.strictObject({
    cpuPercent: optionalPercentageSchema,
    cpuCoresUsed: z.number().finite().min(0).max(maximumLogicalProcessors).nullable().optional(),
    workingSetBytes: optionalByteCountSchema,
    privateBytes: optionalByteCountSchema,
    threadCount: z.number().int().min(0).max(maximumThreadCount).nullable().optional()
  }).nullable().optional(),
  network: z.strictObject({
    gamePort: z.strictObject({
      port: z.number().int().min(1).max(65_535),
      listening: z.boolean().nullable().optional()
    }).nullable().optional()
  }).nullable().optional(),
  simulation: z.strictObject({
    ups: z.number().finite().min(0).max(maximumSimulationRate).nullable().optional(),
    tps: z.number().finite().min(0).max(maximumSimulationRate).nullable().optional(),
    targetUps: z.number().finite().min(Number.EPSILON).max(maximumSimulationRate).nullable().optional()
  }).nullable().optional()
})

export type TrustedServerObservabilitySample = z.infer<typeof trustedServerObservabilitySampleSchema>

const unavailableMetricSchema = z.strictObject({
  status: z.literal('unavailable'),
  reason: z.enum(OBSERVABILITY_UNAVAILABLE_REASONS)
})

function metricSchema<T extends z.ZodType>(valueSchema: T) {
  return z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('available'), value: valueSchema }),
    unavailableMetricSchema
  ])
}

const coreCpuUsageSchema = z.strictObject({
  index: z.number().int().min(0).max(maximumLogicalProcessors - 1),
  percent: percentageSchema
})

const volumeObservabilitySchema = z.strictObject({
  totalBytes: metricSchema(positiveByteCountSchema),
  availableBytes: metricSchema(byteCountSchema),
  usedBytes: metricSchema(byteCountSchema),
  usedPercent: metricSchema(percentageSchema)
})

export const serverObservabilitySnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('server-observability-snapshot'),
  observedAt: z.string().max(64).datetime({ offset: true }),
  source: z.string().min(1).max(maximumSourceLength).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  runtime: z.strictObject({
    state: z.enum(OBSERVABILITY_RUNTIME_STATES),
    processId: metricSchema(z.number().int().min(1).max(4_294_967_295)),
    gamePort: z.strictObject({
      port: metricSchema(z.number().int().min(1).max(65_535)),
      listening: metricSchema(z.boolean())
    })
  }),
  host: z.strictObject({
    cpu: z.strictObject({
      logicalProcessorCount: metricSchema(z.number().int().min(1).max(maximumLogicalProcessors)),
      totalPercent: metricSchema(percentageSchema),
      perCorePercent: metricSchema(z.array(coreCpuUsageSchema).min(1).max(maximumLogicalProcessors))
    }),
    memory: z.strictObject({
      totalBytes: metricSchema(positiveByteCountSchema),
      availableBytes: metricSchema(byteCountSchema),
      usedBytes: metricSchema(byteCountSchema),
      usedPercent: metricSchema(percentageSchema)
    }),
    storage: z.strictObject({
      projectVolume: volumeObservabilitySchema,
      saveVolume: volumeObservabilitySchema
    }),
    network: z.strictObject({
      receiveBytesPerSecond: metricSchema(byteCountSchema),
      sendBytesPerSecond: metricSchema(byteCountSchema),
      sampledInterfaceCount: metricSchema(z.number().int().min(1).max(maximumLogicalProcessors))
    })
  }),
  process: z.strictObject({
    cpuPercent: metricSchema(percentageSchema),
    cpuCoresUsed: metricSchema(z.number().finite().min(0).max(maximumLogicalProcessors)),
    workingSetBytes: metricSchema(byteCountSchema),
    privateBytes: metricSchema(byteCountSchema),
    threadCount: metricSchema(z.number().int().min(0).max(maximumThreadCount))
  }),
  simulation: z.strictObject({
    ups: metricSchema(z.number().finite().min(0).max(maximumSimulationRate)),
    tps: metricSchema(z.number().finite().min(0).max(maximumSimulationRate)),
    targetUps: metricSchema(z.number().finite().min(Number.EPSILON).max(maximumSimulationRate))
  }),
  health: z.strictObject({
    status: z.enum(['healthy', 'unknown', 'warning', 'critical']),
    hints: z.array(z.strictObject({
      code: z.enum(OBSERVABILITY_HINT_CODES),
      severity: z.enum(['info', 'warning', 'critical']),
      message: z.string().min(1).max(256),
      relatedMetrics: z.array(z.enum(OBSERVABILITY_METRIC_PATHS)).max(8)
    })).max(24),
    unavailableMetrics: z.array(z.enum(OBSERVABILITY_METRIC_PATHS)).max(OBSERVABILITY_METRIC_PATHS.length)
  })
}).superRefine((snapshot, context) => {
  if (snapshot.host.cpu.perCorePercent.status === 'available') {
    addDuplicateIssue(
      snapshot.host.cpu.perCorePercent.value.map((core) => core.index),
      context,
      ['host', 'cpu', 'perCorePercent']
    )
  }
  if (snapshot.host.cpu.logicalProcessorCount.status === 'available'
      && snapshot.host.cpu.perCorePercent.status === 'available'
      && snapshot.host.cpu.logicalProcessorCount.value !== snapshot.host.cpu.perCorePercent.value.length) {
    context.addIssue({
      code: 'custom',
      message: 'logical processor count does not match per-core samples',
      path: ['host', 'cpu']
    })
  }
  if (snapshot.host.memory.totalBytes.status === 'available'
      && snapshot.host.memory.availableBytes.status === 'available'
      && snapshot.host.memory.availableBytes.value > snapshot.host.memory.totalBytes.value) {
    context.addIssue({
      code: 'custom',
      message: 'available memory exceeds total memory',
      path: ['host', 'memory']
    })
  }
  validateVolumeReadings(snapshot.host.storage.projectVolume, context, ['host', 'storage', 'projectVolume'])
  validateVolumeReadings(snapshot.host.storage.saveVolume, context, ['host', 'storage', 'saveVolume'])
  addDuplicateIssue(snapshot.health.hints.map((hint) => hint.code), context, ['health', 'hints'])
  addDuplicateIssue(snapshot.health.unavailableMetrics, context, ['health', 'unavailableMetrics'])
  const expectedHealth = evaluateObservabilityHealth(snapshot as ServerObservabilityReadings)
  if (JSON.stringify(snapshot.health) !== JSON.stringify(expectedHealth)) {
    context.addIssue({ code: 'custom', message: 'health summary does not match snapshot readings', path: ['health'] })
  }
})

export function buildServerObservabilitySnapshot(input: unknown): ServerObservabilitySnapshot {
  const sample = parseTrustedSample(input)
  assertSampleConsistency(sample)

  const cpu = sample.host.cpu
  const perCorePercent = coreMetric(cpu?.cores, cpu, cpu?.coresUnavailableReason)
  const logicalProcessorCount = numberMetric(cpu?.logicalProcessorCount, cpu)

  const totalBytes = numberMetric(sample.host.memory?.totalBytes, sample.host.memory)
  const availableBytes = numberMetric(sample.host.memory?.availableBytes, sample.host.memory)
  const usedBytes: ObservabilityMetric<number> = totalBytes.status === 'available'
    && availableBytes.status === 'available'
    ? available(totalBytes.value - availableBytes.value)
    : unavailable<number>('dependency-unavailable')
  const usedPercent: ObservabilityMetric<number> = usedBytes.status === 'available'
    && totalBytes.status === 'available'
    ? available((usedBytes.value / totalBytes.value) * 100)
    : unavailable<number>('dependency-unavailable')

  const projectVolume = buildVolumeReadings(sample.host.storage?.projectVolume)
  const saveVolume = buildVolumeReadings(sample.host.storage?.saveVolume)
  const hostNetwork = sample.host.network

  const processUnavailableReason = sample.runtime.state === 'stopped'
    ? 'process-not-running'
    : parentUnavailableReason(sample.process)
  const gamePort = sample.network?.gamePort

  const readings: ServerObservabilityReadings = {
    schemaVersion: 1,
    kind: 'server-observability-snapshot',
    observedAt: sample.observedAt,
    source: sample.source,
    runtime: {
      state: sample.runtime.state,
      processId: processMetric(sample.runtime.processId, sample.runtime.state, undefined),
      gamePort: {
        port: numberMetric(gamePort?.port, gamePort),
        listening: booleanMetric(gamePort?.listening, gamePort)
      }
    },
    host: {
      cpu: {
        logicalProcessorCount,
        totalPercent: numberMetric(cpu?.totalPercent, cpu),
        perCorePercent
      },
      memory: { totalBytes, availableBytes, usedBytes, usedPercent },
      storage: { projectVolume, saveVolume },
      network: {
        receiveBytesPerSecond: numberMetric(
          hostNetwork?.receiveBytesPerSecond,
          hostNetwork,
          hostNetwork?.unavailableReason
        ),
        sendBytesPerSecond: numberMetric(
          hostNetwork?.sendBytesPerSecond,
          hostNetwork,
          hostNetwork?.unavailableReason
        ),
        sampledInterfaceCount: numberMetric(
          hostNetwork?.sampledInterfaceCount,
          hostNetwork,
          hostNetwork?.unavailableReason
        )
      }
    },
    process: {
      cpuPercent: processNumberMetric(sample.process?.cpuPercent, processUnavailableReason),
      cpuCoresUsed: processNumberMetric(sample.process?.cpuCoresUsed, processUnavailableReason),
      workingSetBytes: processNumberMetric(sample.process?.workingSetBytes, processUnavailableReason),
      privateBytes: processNumberMetric(sample.process?.privateBytes, processUnavailableReason),
      threadCount: processNumberMetric(sample.process?.threadCount, processUnavailableReason)
    },
    simulation: {
      ups: numberMetric(sample.simulation?.ups, sample.simulation),
      tps: numberMetric(sample.simulation?.tps, sample.simulation),
      targetUps: numberMetric(sample.simulation?.targetUps, sample.simulation)
    }
  }

  return parseServerObservabilitySnapshot({ ...readings, health: evaluateObservabilityHealth(readings) })
}

export function parseServerObservabilitySnapshot(input: unknown): ServerObservabilitySnapshot {
  const parsed = serverObservabilitySnapshotSchema.safeParse(input)
  if (!parsed.success) throw new ObservabilityError('OBSERVABILITY_SNAPSHOT_INVALID', parsed.error)
  return parsed.data as ServerObservabilitySnapshot
}

function parseTrustedSample(input: unknown): TrustedServerObservabilitySample {
  const parsed = trustedServerObservabilitySampleSchema.safeParse(input)
  if (!parsed.success) throw new ObservabilityError('OBSERVABILITY_SAMPLE_INVALID', parsed.error)
  return parsed.data
}

function assertSampleConsistency(sample: TrustedServerObservabilitySample): void {
  const cpu = sample.host.cpu
  if (cpu?.cores !== undefined && cpu.cores !== null) {
    const indexes = cpu.cores.map((core) => core.index)
    if (new Set(indexes).size !== indexes.length) {
      throw new ObservabilityError('OBSERVABILITY_CPU_CORE_DUPLICATE')
    }
    const expectedCount = cpu.logicalProcessorCount ?? cpu.cores.length
    const sortedIndexes = [...indexes].sort((left, right) => left - right)
    if (cpu.cores.length !== expectedCount
        || sortedIndexes.some((index, position) => index !== position)) {
      throw new ObservabilityError('OBSERVABILITY_CPU_CORE_COUNT_MISMATCH')
    }
  }

  const memory = sample.host.memory
  if (memory?.totalBytes !== undefined && memory.totalBytes !== null
      && memory.availableBytes !== undefined && memory.availableBytes !== null
      && memory.availableBytes > memory.totalBytes) {
    throw new ObservabilityError('OBSERVABILITY_MEMORY_RANGE_INVALID')
  }

  for (const volume of [sample.host.storage?.projectVolume, sample.host.storage?.saveVolume]) {
    if (volume?.totalBytes !== undefined && volume.totalBytes !== null
        && volume.availableBytes !== undefined && volume.availableBytes !== null
        && volume.availableBytes > volume.totalBytes) {
      throw new ObservabilityError('OBSERVABILITY_VOLUME_RANGE_INVALID')
    }
  }
}

function available<T>(value: T): ObservabilityMetric<T> {
  return { status: 'available', value }
}

function unavailable<T>(reason: ObservabilityUnavailableReason): ObservabilityMetric<T> {
  return { status: 'unavailable', reason }
}

function numberMetric(
  value: number | null | undefined,
  parent: object | null | undefined,
  explicitReason?: ObservabilityUnavailableReason | null
): ObservabilityMetric<number> {
  return value === undefined || value === null
    ? unavailable(explicitReason ?? (value === null || parent === null ? 'source-reported-unavailable' : 'not-provided'))
    : available(value)
}

function booleanMetric(
  value: boolean | null | undefined,
  parent: object | null | undefined
): ObservabilityMetric<boolean> {
  return value === undefined || value === null
    ? unavailable(value === null || parent === null ? 'source-reported-unavailable' : 'not-provided')
    : available(value)
}

function processMetric(
  value: number | null | undefined,
  state: TrustedServerObservabilitySample['runtime']['state'],
  parent: object | null | undefined
): ObservabilityMetric<number> {
  if (value !== undefined && value !== null) return available(value)
  if (state === 'stopped') return unavailable('process-not-running')
  return unavailable(value === null || parent === null ? 'source-reported-unavailable' : 'not-provided')
}

function processNumberMetric(
  value: number | null | undefined,
  missingReason: ObservabilityUnavailableReason
): ObservabilityMetric<number> {
  if (value !== undefined && value !== null) return available(value)
  return unavailable(value === null ? 'source-reported-unavailable' : missingReason)
}

function coreMetric(
  value: CoreCpuUsage[] | null | undefined,
  parent: object | null | undefined,
  explicitReason?: ObservabilityUnavailableReason | null
): ObservabilityMetric<CoreCpuUsage[]> {
  if (value === undefined || value === null) {
    return unavailable(explicitReason ?? (value === null || parent === null ? 'source-reported-unavailable' : 'not-provided'))
  }
  return available(value.map((core) => ({ ...core })).sort((left, right) => left.index - right.index))
}

function buildVolumeReadings(
  volume: TrustedVolumeSample | null | undefined
): VolumeObservabilityReadings {
  const unavailableReason = volume?.unavailableReason
  const totalBytes = numberMetric(volume?.totalBytes, volume, unavailableReason)
  const availableBytes = numberMetric(volume?.availableBytes, volume, unavailableReason)
  const derivedReason: ObservabilityUnavailableReason = unavailableReason
    ?? (volume === null ? 'source-reported-unavailable' : 'dependency-unavailable')
  const usedBytes: ObservabilityMetric<number> = totalBytes.status === 'available'
    && availableBytes.status === 'available'
    ? available(totalBytes.value - availableBytes.value)
    : unavailable(derivedReason)
  const usedPercent: ObservabilityMetric<number> = usedBytes.status === 'available'
    && totalBytes.status === 'available'
    ? available((usedBytes.value / totalBytes.value) * 100)
    : unavailable(derivedReason)
  return { totalBytes, availableBytes, usedBytes, usedPercent }
}

function parentUnavailableReason(parent: object | null | undefined): ObservabilityUnavailableReason {
  return parent === null ? 'source-reported-unavailable' : 'not-provided'
}

function validateVolumeReadings(
  volume: VolumeObservabilityReadings,
  context: z.RefinementCtx,
  path: PropertyKey[]
): void {
  if (volume.totalBytes.status !== 'available' || volume.availableBytes.status !== 'available') return
  if (volume.availableBytes.value > volume.totalBytes.value) {
    context.addIssue({ code: 'custom', message: 'available volume bytes exceed total bytes', path })
    return
  }
  if (volume.usedBytes.status !== 'available' || volume.usedPercent.status !== 'available') {
    context.addIssue({ code: 'custom', message: 'derived volume readings are unavailable despite byte totals', path })
    return
  }
  const expectedUsed = volume.totalBytes.value - volume.availableBytes.value
  const expectedPercent = (expectedUsed / volume.totalBytes.value) * 100
  if (volume.usedBytes.value !== expectedUsed || Math.abs(volume.usedPercent.value - expectedPercent) > 1e-9) {
    context.addIssue({ code: 'custom', message: 'derived volume readings are inconsistent', path })
  }
}

function addDuplicateIssue(
  values: Array<string | number>,
  context: z.RefinementCtx,
  path: PropertyKey[]
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: 'custom', message: 'duplicate values are not allowed', path })
  }
}

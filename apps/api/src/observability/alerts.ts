import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parseServerObservabilitySnapshot } from './snapshot.js'
import {
  OBSERVABILITY_HINT_CODES,
  OBSERVABILITY_METRIC_PATHS,
  type ObservabilityHint,
  type ObservabilityHintCode,
  type ObservabilityHintSeverity,
  type ObservabilityMetricPath,
  type ServerObservabilitySnapshot
} from './types.js'

const defaultCapacity = 256
const maximumCapacity = 4_096
const defaultResolveAfterMissingSamples = 3
const maximumResolveAfterMissingSamples = 1_000
const maximumActorLength = 64
const maximumEpisodeIdLength = 96
const maximumSeverityHistoryEntries = 4_096
const maximumSerializedBytes = 4 * 1_024 * 1_024
const maximumSerializedDepth = 16
const maximumSerializedNodes = 100_000
const maximumRetainedEpisodes = maximumCapacity + OBSERVABILITY_HINT_CODES.length

const episodeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const actorPattern = /^[\p{L}\p{N}](?:[\p{L}\p{N} ._@:-]*[\p{L}\p{N}])?$/u
const digestPattern = /^[a-f0-9]{64}$/

const allowedSeveritiesByCode = {
  HOST_CPU_PRESSURE: ['warning'],
  HOST_CPU_SATURATED: ['critical'],
  SINGLE_CORE_SATURATION: ['warning'],
  MEMORY_PRESSURE: ['warning'],
  MEMORY_EXHAUSTION: ['critical'],
  PROJECT_VOLUME_PRESSURE: ['warning'],
  PROJECT_VOLUME_EXHAUSTION: ['critical'],
  SAVE_VOLUME_PRESSURE: ['warning'],
  SAVE_VOLUME_EXHAUSTION: ['critical'],
  NETWORK_TELEMETRY_UNAVAILABLE: ['info'],
  PROCESS_CPU_PRESSURE: ['warning'],
  PROCESS_MEMORY_DOMINANT: ['warning', 'critical'],
  GAME_PORT_NOT_LISTENING: ['critical'],
  UNEXPECTED_GAME_PORT_LISTENER: ['warning'],
  RUNTIME_PROCESS_STATE_MISMATCH: ['warning'],
  SIMULATION_BELOW_TARGET: ['warning', 'critical'],
  SIMULATION_TELEMETRY_UNAVAILABLE: ['info'],
  RUNTIME_STATE_UNKNOWN: ['info'],
  OBSERVABILITY_INCOMPLETE: ['info'],
  PROJECT_ROOT_UNAVAILABLE: ['critical'],
  SMB_GLOBAL_MAPPING_UNAVAILABLE: ['critical'],
  STORAGE_RECOVERY_TASK_FAILED: ['critical'],
  STORAGE_DEPENDENCY_UNCLASSIFIED: ['info']
} as const satisfies Record<ObservabilityHintCode, readonly ObservabilityHintSeverity[]>

const relatedMetricOptionsByCode = {
  HOST_CPU_PRESSURE: [['host.cpu.totalPercent']],
  HOST_CPU_SATURATED: [['host.cpu.totalPercent']],
  SINGLE_CORE_SATURATION: [['host.cpu.perCorePercent', 'host.cpu.totalPercent']],
  MEMORY_PRESSURE: [['host.memory.usedPercent', 'host.memory.availableBytes']],
  MEMORY_EXHAUSTION: [['host.memory.usedPercent', 'host.memory.availableBytes']],
  PROJECT_VOLUME_PRESSURE: [[
    'host.storage.projectVolume.usedPercent', 'host.storage.projectVolume.availableBytes'
  ]],
  PROJECT_VOLUME_EXHAUSTION: [[
    'host.storage.projectVolume.usedPercent', 'host.storage.projectVolume.availableBytes'
  ]],
  SAVE_VOLUME_PRESSURE: [[
    'host.storage.saveVolume.usedPercent', 'host.storage.saveVolume.availableBytes'
  ]],
  SAVE_VOLUME_EXHAUSTION: [[
    'host.storage.saveVolume.usedPercent', 'host.storage.saveVolume.availableBytes'
  ]],
  NETWORK_TELEMETRY_UNAVAILABLE: [[
    'host.network.receiveBytesPerSecond', 'host.network.sendBytesPerSecond'
  ]],
  PROCESS_CPU_PRESSURE: [
    ['process.cpuPercent'],
    ['process.cpuCoresUsed', 'host.cpu.logicalProcessorCount']
  ],
  PROCESS_MEMORY_DOMINANT: [['process.workingSetBytes', 'host.memory.totalBytes']],
  GAME_PORT_NOT_LISTENING: [['runtime.gamePort.listening']],
  UNEXPECTED_GAME_PORT_LISTENER: [['runtime.gamePort.listening']],
  RUNTIME_PROCESS_STATE_MISMATCH: [['runtime.processId']],
  SIMULATION_BELOW_TARGET: [['simulation.ups', 'simulation.targetUps']],
  SIMULATION_TELEMETRY_UNAVAILABLE: [['simulation.ups', 'simulation.tps']],
  RUNTIME_STATE_UNKNOWN: [[]],
  OBSERVABILITY_INCOMPLETE: [],
  PROJECT_ROOT_UNAVAILABLE: [['automation.projectRootAvailable']],
  SMB_GLOBAL_MAPPING_UNAVAILABLE: [['automation.globalMappingAvailable']],
  STORAGE_RECOVERY_TASK_FAILED: [[
    'automation.storageTask.state', 'automation.storageTask.lastResult'
  ]],
  STORAGE_DEPENDENCY_UNCLASSIFIED: [[]]
} as const satisfies Record<
  ObservabilityHintCode,
  readonly (readonly ObservabilityMetricPath[])[]
>

const incompleteMetricOrder: readonly ObservabilityMetricPath[] = [
  'host.cpu.totalPercent',
  'host.memory.usedPercent',
  'runtime.gamePort.port',
  'runtime.gamePort.listening',
  'runtime.processId',
  'runtime.startedAt',
  'process.workingSetBytes',
  'automation.projectRootAvailable',
  'automation.globalMappingAvailable',
  'automation.storageTask.state',
  'automation.storageTask.lastResult'
]

export const OBSERVABILITY_ALERT_ERROR_CODES = [
  'OBSERVABILITY_ALERT_CONFIGURATION_INVALID',
  'OBSERVABILITY_ALERT_INPUT_INVALID',
  'OBSERVABILITY_ALERT_TIME_REGRESSION',
  'OBSERVABILITY_ALERT_TIMESTAMP_CONFLICT',
  'OBSERVABILITY_ALERT_EPISODE_ID_INVALID',
  'OBSERVABILITY_ALERT_EPISODE_NOT_FOUND',
  'OBSERVABILITY_ALERT_EPISODE_RESOLVED',
  'OBSERVABILITY_ALERT_ACKNOWLEDGEMENT_CONFLICT',
  'OBSERVABILITY_ALERT_CAPACITY_EXCEEDED',
  'OBSERVABILITY_ALERT_STATE_INVALID'
] as const

export type ObservabilityAlertErrorCode = (typeof OBSERVABILITY_ALERT_ERROR_CODES)[number]

export class ObservabilityAlertError extends Error {
  readonly code: ObservabilityAlertErrorCode

  constructor(code: ObservabilityAlertErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause })
    this.name = 'ObservabilityAlertError'
    this.code = code
  }
}

export interface ObservabilityAlertEpisodeIdContext {
  sequence: number
  code: ObservabilityHintCode
  openedAt: string
}

export type ObservabilityAlertEpisodeIdFactory = (context: Readonly<ObservabilityAlertEpisodeIdContext>) => string

export interface ObservabilityAlertStateMachineOptions {
  /**
   * Soft total capacity. Open episodes are never evicted, so the retained
   * collection may exceed this limit until episodes resolve.
   */
  capacity?: number
  resolveAfterMissingSamples?: number
  idFactory?: ObservabilityAlertEpisodeIdFactory
}

export interface ObservabilityAlertHydrateOptions {
  idFactory?: ObservabilityAlertEpisodeIdFactory
}

export interface ObservabilityAlertSeverityHistoryEntry {
  severity: ObservabilityHintSeverity
  changedAt: string
}

export interface ObservabilityAlertAcknowledgement {
  actor: string
  acknowledgedAt: string
}

export interface ObservabilityAlertEpisode {
  id: string
  code: ObservabilityHintCode
  status: 'open' | 'resolved'
  currentSeverity: ObservabilityHintSeverity
  severityHistory: ObservabilityAlertSeverityHistoryEntry[]
  openedAt: string
  lastSeenAt: string
  observationCount: number
  consecutiveMissingSamples: number
  acknowledgement: ObservabilityAlertAcknowledgement | null
  resolvedAt: string | null
}

export interface ObservabilityAlertProjection {
  schemaVersion: 1
  kind: 'observability-alert-episode-projection'
  observedThrough: string | null
  capacity: number
  resolveAfterMissingSamples: number
  episodes: ObservabilityAlertEpisode[]
}

export interface AcknowledgeObservabilityAlertInput {
  episodeId: string
  actor: string
  acknowledgedAt: string
}

export interface SerializedObservabilityAlertEpisode {
  id: string
  code: ObservabilityHintCode
  relatedMetrics: ObservabilityMetricPath[]
  currentSeverity: ObservabilityHintSeverity
  severityHistory: ObservabilityAlertSeverityHistoryEntry[]
  openedAt: string
  lastSeenAt: string
  observationCount: number
  consecutiveMissingSamples: number
  acknowledgement: ObservabilityAlertAcknowledgement | null
  resolvedAt: string | null
}

interface SerializedSnapshotCursor {
  observedAt: string
  digest: string
}

export interface SerializedObservabilityAlertState {
  schemaVersion: 1
  kind: 'observability-alert-episode-state'
  capacity: number
  resolveAfterMissingSamples: number
  nextEpisodeSequence: number
  lastSnapshot: SerializedSnapshotCursor | null
  episodes: SerializedObservabilityAlertEpisode[]
}

const timestampSchema = z.string().min(1).max(64).datetime({ offset: true })
const episodeIdSchema = z.string().min(1).max(maximumEpisodeIdLength).regex(episodeIdPattern)
const actorSchema = z.string().min(1).max(maximumActorLength).refine(
  (actor) => actor === actor.trim() && actorPattern.test(actor)
)
const severitySchema = z.enum(['info', 'warning', 'critical'])
const severityHistoryEntrySchema = z.strictObject({
  severity: severitySchema,
  changedAt: timestampSchema
})
const acknowledgementSchema = z.strictObject({
  actor: actorSchema,
  acknowledgedAt: timestampSchema
})
const serializedEpisodeSchema = z.strictObject({
  id: episodeIdSchema,
  code: z.enum(OBSERVABILITY_HINT_CODES),
  relatedMetrics: z.array(z.enum(OBSERVABILITY_METRIC_PATHS)).max(8),
  currentSeverity: severitySchema,
  severityHistory: z.array(severityHistoryEntrySchema).min(1).max(maximumSeverityHistoryEntries),
  openedAt: timestampSchema,
  lastSeenAt: timestampSchema,
  observationCount: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  consecutiveMissingSamples: z.number().int().min(0).max(maximumResolveAfterMissingSamples),
  acknowledgement: acknowledgementSchema.nullable(),
  resolvedAt: timestampSchema.nullable()
})
const serializedStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('observability-alert-episode-state'),
  capacity: z.number().int().min(1).max(maximumCapacity),
  resolveAfterMissingSamples: z.number().int().min(1).max(maximumResolveAfterMissingSamples),
  nextEpisodeSequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  lastSnapshot: z.strictObject({
    observedAt: timestampSchema,
    digest: z.string().length(64).regex(digestPattern)
  }).nullable(),
  episodes: z.array(serializedEpisodeSchema).max(maximumRetainedEpisodes)
})
const acknowledgementInputSchema = z.strictObject({
  episodeId: episodeIdSchema,
  actor: actorSchema,
  acknowledgedAt: timestampSchema
})

/**
 * Pure in-memory alert-episode reducer. It has an explicit serialization
 * boundary but deliberately makes no persistence or delivery claims.
 */
export class ObservabilityAlertEpisodeStateMachine {
  #state: SerializedObservabilityAlertState
  readonly #idFactory: ObservabilityAlertEpisodeIdFactory

  constructor(options: ObservabilityAlertStateMachineOptions = {}) {
    const parsed = parseOptions(options)
    this.#idFactory = parsed.idFactory
    this.#state = {
      schemaVersion: 1,
      kind: 'observability-alert-episode-state',
      capacity: parsed.capacity,
      resolveAfterMissingSamples: parsed.resolveAfterMissingSamples,
      nextEpisodeSequence: 1,
      lastSnapshot: null,
      episodes: []
    }
  }

  static hydrate(
    input: unknown,
    options: ObservabilityAlertHydrateOptions = {}
  ): ObservabilityAlertEpisodeStateMachine {
    const parsedOptions = parseHydrateOptions(options)
    const state = parseSerializedState(input)
    const machine = new ObservabilityAlertEpisodeStateMachine({
      capacity: state.capacity,
      resolveAfterMissingSamples: state.resolveAfterMissingSamples,
      idFactory: parsedOptions.idFactory
    })
    machine.#state = structuredClone(state)
    return machine
  }

  get capacity(): number {
    return this.#state.capacity
  }

  get resolveAfterMissingSamples(): number {
    return this.#state.resolveAfterMissingSamples
  }

  get size(): number {
    return this.#state.episodes.length
  }

  ingest(input: unknown): ObservabilityAlertProjection {
    const snapshot = parseServerObservabilitySnapshot(input)
    const observedAtUnixMs = Date.parse(snapshot.observedAt)
    const digest = digestSnapshot(snapshot)
    const previous = this.#state.lastSnapshot

    if (previous !== null) {
      const previousUnixMs = Date.parse(previous.observedAt)
      if (observedAtUnixMs < previousUnixMs) {
        throw new ObservabilityAlertError('OBSERVABILITY_ALERT_TIME_REGRESSION')
      }
      if (observedAtUnixMs === previousUnixMs) {
        if (digest === previous.digest) return this.project()
        throw new ObservabilityAlertError('OBSERVABILITY_ALERT_TIMESTAMP_CONFLICT')
      }
    }

    const candidate = structuredClone(this.#state)
    const hints = new Map(snapshot.health.hints.map((hint) => [hint.code, hint]))
    const recoveryEvidenceIsComplete = snapshot.health.status !== 'unknown'
      && !hints.has('OBSERVABILITY_INCOMPLETE')
      && !hints.has('RUNTIME_STATE_UNKNOWN')
    const unavailableMetrics = new Set(snapshot.health.unavailableMetrics)

    for (const episode of candidate.episodes) {
      if (episode.resolvedAt !== null) continue
      const hint = hints.get(episode.code)
      if (hint !== undefined) {
        observeExistingEpisode(episode, hint, snapshot.observedAt)
      } else if (recoveryEvidenceIsComplete
          && episode.relatedMetrics.every((metric) => !unavailableMetrics.has(metric))) {
        episode.consecutiveMissingSamples++
        if (episode.consecutiveMissingSamples >= candidate.resolveAfterMissingSamples) {
          episode.resolvedAt = snapshot.observedAt
        }
      }
    }

    const orderedHints = [...hints.values()].sort((left, right) => compareText(left.code, right.code))
    for (const hint of orderedHints) {
      const alreadyOpen = candidate.episodes.some(
        (episode) => episode.code === hint.code && episode.resolvedAt === null
      )
      if (!alreadyOpen) {
        candidate.episodes.push(this.#newEpisode(candidate, hint, snapshot.observedAt))
      }
    }

    candidate.lastSnapshot = { observedAt: snapshot.observedAt, digest }
    candidate.episodes.sort(compareEpisodes)
    pruneResolvedEpisodes(candidate)
    validateStateInvariants(candidate)
    this.#state = candidate
    return this.project()
  }

  acknowledge(input: unknown): ObservabilityAlertEpisode {
    const parsed = acknowledgementInputSchema.safeParse(input)
    if (!parsed.success) {
      throw new ObservabilityAlertError('OBSERVABILITY_ALERT_INPUT_INVALID', parsed.error)
    }

    const candidate = structuredClone(this.#state)
    const episode = candidate.episodes.find((entry) => entry.id === parsed.data.episodeId)
    if (episode === undefined) {
      throw new ObservabilityAlertError('OBSERVABILITY_ALERT_EPISODE_NOT_FOUND')
    }

    if (episode.acknowledgement !== null) {
      if (episode.acknowledgement.actor === parsed.data.actor
          && episode.acknowledgement.acknowledgedAt === parsed.data.acknowledgedAt) {
        return projectEpisode(episode)
      }
      throw new ObservabilityAlertError('OBSERVABILITY_ALERT_ACKNOWLEDGEMENT_CONFLICT')
    }
    if (episode.resolvedAt !== null) {
      throw new ObservabilityAlertError('OBSERVABILITY_ALERT_EPISODE_RESOLVED')
    }
    if (Date.parse(parsed.data.acknowledgedAt) < Date.parse(episode.openedAt)) {
      throw new ObservabilityAlertError('OBSERVABILITY_ALERT_INPUT_INVALID')
    }

    episode.acknowledgement = {
      actor: parsed.data.actor,
      acknowledgedAt: parsed.data.acknowledgedAt
    }
    validateStateInvariants(candidate)
    this.#state = candidate
    return projectEpisode(episode)
  }

  list(): ObservabilityAlertEpisode[] {
    return this.#state.episodes.map(projectEpisode)
  }

  project(): ObservabilityAlertProjection {
    return {
      schemaVersion: 1,
      kind: 'observability-alert-episode-projection',
      observedThrough: this.#state.lastSnapshot?.observedAt ?? null,
      capacity: this.#state.capacity,
      resolveAfterMissingSamples: this.#state.resolveAfterMissingSamples,
      episodes: this.list()
    }
  }

  serialize(): SerializedObservabilityAlertState {
    return structuredClone(this.#state)
  }

  serializeJson(): string {
    return JSON.stringify(this.#state)
  }

  #newEpisode(
    state: SerializedObservabilityAlertState,
    hint: ObservabilityHint,
    openedAt: string
  ): SerializedObservabilityAlertEpisode {
    if (state.nextEpisodeSequence >= Number.MAX_SAFE_INTEGER) {
      throw new ObservabilityAlertError('OBSERVABILITY_ALERT_CAPACITY_EXCEEDED')
    }
    const context = Object.freeze({ sequence: state.nextEpisodeSequence, code: hint.code, openedAt })
    let id: unknown
    try {
      id = this.#idFactory(context)
    } catch (error) {
      throw new ObservabilityAlertError('OBSERVABILITY_ALERT_EPISODE_ID_INVALID', error)
    }
    const parsedId = episodeIdSchema.safeParse(id)
    if (!parsedId.success || state.episodes.some((episode) => episode.id === parsedId.data)) {
      throw new ObservabilityAlertError(
        'OBSERVABILITY_ALERT_EPISODE_ID_INVALID',
        parsedId.success ? undefined : parsedId.error
      )
    }
    state.nextEpisodeSequence++
    return {
      id: parsedId.data,
      code: hint.code,
      relatedMetrics: [...hint.relatedMetrics],
      currentSeverity: hint.severity,
      severityHistory: [{ severity: hint.severity, changedAt: openedAt }],
      openedAt,
      lastSeenAt: openedAt,
      observationCount: 1,
      consecutiveMissingSamples: 0,
      acknowledgement: null,
      resolvedAt: null
    }
  }
}

export function hydrateObservabilityAlertStateMachine(
  input: unknown,
  options: ObservabilityAlertHydrateOptions = {}
): ObservabilityAlertEpisodeStateMachine {
  return ObservabilityAlertEpisodeStateMachine.hydrate(input, options)
}

function observeExistingEpisode(
  episode: SerializedObservabilityAlertEpisode,
  hint: ObservabilityHint,
  observedAt: string
): void {
  if (episode.observationCount >= Number.MAX_SAFE_INTEGER) {
    throw new ObservabilityAlertError('OBSERVABILITY_ALERT_CAPACITY_EXCEEDED')
  }
  episode.observationCount++
  episode.lastSeenAt = observedAt
  episode.consecutiveMissingSamples = 0
  episode.relatedMetrics = [...hint.relatedMetrics]
  if (episode.currentSeverity === hint.severity) return
  if (episode.severityHistory.length >= maximumSeverityHistoryEntries) {
    throw new ObservabilityAlertError('OBSERVABILITY_ALERT_CAPACITY_EXCEEDED')
  }
  episode.currentSeverity = hint.severity
  episode.severityHistory.push({ severity: hint.severity, changedAt: observedAt })
}

function projectEpisode(episode: SerializedObservabilityAlertEpisode): ObservabilityAlertEpisode {
  return {
    id: episode.id,
    code: episode.code,
    status: episode.resolvedAt === null ? 'open' : 'resolved',
    currentSeverity: episode.currentSeverity,
    severityHistory: episode.severityHistory.map((entry) => ({ ...entry })),
    openedAt: episode.openedAt,
    lastSeenAt: episode.lastSeenAt,
    observationCount: episode.observationCount,
    consecutiveMissingSamples: episode.consecutiveMissingSamples,
    acknowledgement: episode.acknowledgement === null ? null : { ...episode.acknowledgement },
    resolvedAt: episode.resolvedAt
  }
}

function pruneResolvedEpisodes(state: SerializedObservabilityAlertState): void {
  while (state.episodes.length > state.capacity) {
    let oldestResolvedIndex = -1
    for (let index = 0; index < state.episodes.length; index++) {
      const episode = state.episodes[index]
      if (episode?.resolvedAt === null || episode === undefined) continue
      if (oldestResolvedIndex === -1
          || compareResolutionAge(episode, state.episodes[oldestResolvedIndex]!) < 0) {
        oldestResolvedIndex = index
      }
    }
    if (oldestResolvedIndex === -1) return
    state.episodes.splice(oldestResolvedIndex, 1)
  }
}

function compareResolutionAge(
  left: SerializedObservabilityAlertEpisode,
  right: SerializedObservabilityAlertEpisode
): number {
  const timeDifference = Date.parse(left.resolvedAt!) - Date.parse(right.resolvedAt!)
  if (timeDifference !== 0) return timeDifference
  return compareEpisodes(left, right)
}

function compareEpisodes(
  left: SerializedObservabilityAlertEpisode,
  right: SerializedObservabilityAlertEpisode
): number {
  const timeDifference = Date.parse(left.openedAt) - Date.parse(right.openedAt)
  return timeDifference !== 0 ? timeDifference : compareText(left.id, right.id)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function digestSnapshot(snapshot: ServerObservabilitySnapshot): string {
  return createHash('sha256').update(JSON.stringify(snapshot), 'utf8').digest('hex')
}

function defaultIdFactory(context: Readonly<ObservabilityAlertEpisodeIdContext>): string {
  return `alert-${context.sequence.toString().padStart(6, '0')}-${context.code}`
}

function parseOptions(options: unknown): Required<ObservabilityAlertStateMachineOptions> {
  if (!isPlainRecord(options)) {
    throw new ObservabilityAlertError('OBSERVABILITY_ALERT_CONFIGURATION_INVALID')
  }
  const allowedKeys = new Set(['capacity', 'resolveAfterMissingSamples', 'idFactory'])
  if (Object.keys(options).some((key) => !allowedKeys.has(key))) {
    throw new ObservabilityAlertError('OBSERVABILITY_ALERT_CONFIGURATION_INVALID')
  }
  const capacity = options.capacity ?? defaultCapacity
  const resolveAfterMissingSamples = options.resolveAfterMissingSamples ?? defaultResolveAfterMissingSamples
  const idFactory = options.idFactory ?? defaultIdFactory
  if (!Number.isInteger(capacity) || typeof capacity !== 'number'
      || capacity < 1 || capacity > maximumCapacity
      || !Number.isInteger(resolveAfterMissingSamples) || typeof resolveAfterMissingSamples !== 'number'
      || resolveAfterMissingSamples < 1
      || resolveAfterMissingSamples > maximumResolveAfterMissingSamples
      || typeof idFactory !== 'function') {
    throw new ObservabilityAlertError('OBSERVABILITY_ALERT_CONFIGURATION_INVALID')
  }
  return {
    capacity,
    resolveAfterMissingSamples,
    idFactory: idFactory as ObservabilityAlertEpisodeIdFactory
  }
}

function parseHydrateOptions(options: unknown): Required<ObservabilityAlertHydrateOptions> {
  if (!isPlainRecord(options)
      || Object.keys(options).some((key) => key !== 'idFactory')
      || (options.idFactory !== undefined && typeof options.idFactory !== 'function')) {
    throw new ObservabilityAlertError('OBSERVABILITY_ALERT_CONFIGURATION_INVALID')
  }
  return {
    idFactory: (options.idFactory ?? defaultIdFactory) as ObservabilityAlertEpisodeIdFactory
  }
}

function parseSerializedState(input: unknown): SerializedObservabilityAlertState {
  let decoded: unknown = input
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > maximumSerializedBytes) {
      throw new ObservabilityAlertError('OBSERVABILITY_ALERT_STATE_INVALID')
    }
    try {
      decoded = JSON.parse(input) as unknown
    } catch (error) {
      throw new ObservabilityAlertError('OBSERVABILITY_ALERT_STATE_INVALID', error)
    }
  }

  assertPlainJsonValue(decoded)
  let encoded: string
  try {
    encoded = JSON.stringify(decoded)
  } catch (error) {
    throw new ObservabilityAlertError('OBSERVABILITY_ALERT_STATE_INVALID', error)
  }
  if (Buffer.byteLength(encoded, 'utf8') > maximumSerializedBytes) {
    throw new ObservabilityAlertError('OBSERVABILITY_ALERT_STATE_INVALID')
  }

  const parsed = serializedStateSchema.safeParse(decoded)
  if (!parsed.success) {
    throw new ObservabilityAlertError('OBSERVABILITY_ALERT_STATE_INVALID', parsed.error)
  }
  const state = parsed.data as SerializedObservabilityAlertState
  validateStateInvariants(state)
  return state
}

function validateStateInvariants(state: SerializedObservabilityAlertState): void {
  const ids = new Set<string>()
  const openCodes = new Set<ObservabilityHintCode>()
  let previousEpisode: SerializedObservabilityAlertEpisode | undefined

  for (const episode of state.episodes) {
    if (ids.has(episode.id)) invalidState()
    ids.add(episode.id)
    if (previousEpisode !== undefined && compareEpisodes(previousEpisode, episode) > 0) invalidState()
    previousEpisode = episode

    if (Date.parse(episode.openedAt) > Date.parse(episode.lastSeenAt)) invalidState()
    if (new Set(episode.relatedMetrics).size !== episode.relatedMetrics.length
        || !relatedMetricsAreValid(episode.code, episode.relatedMetrics)) {
      invalidState()
    }
    const firstSeverity = episode.severityHistory[0]
    const lastSeverity = episode.severityHistory[episode.severityHistory.length - 1]
    if (firstSeverity === undefined || lastSeverity === undefined
        || firstSeverity.changedAt !== episode.openedAt
        || lastSeverity.severity !== episode.currentSeverity
        || episode.observationCount < episode.severityHistory.length) {
      invalidState()
    }
    for (let index = 0; index < episode.severityHistory.length; index++) {
      const entry = episode.severityHistory[index]!
      const allowedSeverities = allowedSeveritiesByCode[episode.code] as readonly ObservabilityHintSeverity[]
      if (!allowedSeverities.includes(entry.severity)
          || Date.parse(entry.changedAt) > Date.parse(episode.lastSeenAt)) {
        invalidState()
      }
      const previousEntry = episode.severityHistory[index - 1]
      if (previousEntry !== undefined
          && (Date.parse(previousEntry.changedAt) >= Date.parse(entry.changedAt)
            || previousEntry.severity === entry.severity)) {
        invalidState()
      }
    }

    if (episode.resolvedAt === null) {
      if (openCodes.has(episode.code)
          || episode.consecutiveMissingSamples >= state.resolveAfterMissingSamples) {
        invalidState()
      }
      openCodes.add(episode.code)
    } else if (Date.parse(episode.resolvedAt) <= Date.parse(episode.lastSeenAt)
        || episode.consecutiveMissingSamples !== state.resolveAfterMissingSamples) {
      invalidState()
    }

    if (episode.acknowledgement !== null) {
      const acknowledgedUnixMs = Date.parse(episode.acknowledgement.acknowledgedAt)
      if (acknowledgedUnixMs < Date.parse(episode.openedAt)
          || (episode.resolvedAt !== null && acknowledgedUnixMs > Date.parse(episode.resolvedAt))) {
        invalidState()
      }
    }

    if (state.lastSnapshot === null
        || Date.parse(episode.openedAt) > Date.parse(state.lastSnapshot.observedAt)
        || Date.parse(episode.lastSeenAt) > Date.parse(state.lastSnapshot.observedAt)
        || (episode.resolvedAt !== null
          && Date.parse(episode.resolvedAt) > Date.parse(state.lastSnapshot.observedAt))) {
      invalidState()
    }
  }

  if (state.nextEpisodeSequence <= state.episodes.length) invalidState()
  if (state.lastSnapshot === null
      && (state.episodes.length !== 0 || state.nextEpisodeSequence !== 1)) {
    invalidState()
  }
  if (state.episodes.length === 0 && state.nextEpisodeSequence !== 1) invalidState()
  if (state.episodes.length > state.capacity
      && state.episodes.some((episode) => episode.resolvedAt !== null)) {
    invalidState()
  }
}

function relatedMetricsAreValid(
  code: ObservabilityHintCode,
  metrics: ObservabilityMetricPath[]
): boolean {
  if (code === 'OBSERVABILITY_INCOMPLETE') {
    if (metrics.length === 0) return false
    let previousIndex = -1
    for (const metric of metrics) {
      const index = incompleteMetricOrder.indexOf(metric)
      if (index <= previousIndex) return false
      previousIndex = index
    }
    return true
  }
  const options = relatedMetricOptionsByCode[code] as readonly (readonly ObservabilityMetricPath[])[]
  return options.some((option) => option.length === metrics.length
    && option.every((metric, index) => metric === metrics[index]))
}

function invalidState(): never {
  throw new ObservabilityAlertError('OBSERVABILITY_ALERT_STATE_INVALID')
}

function assertPlainJsonValue(input: unknown): void {
  const visited = new Set<object>()
  let nodes = 0

  const visit = (value: unknown, depth: number): void => {
    nodes++
    if (nodes > maximumSerializedNodes || depth > maximumSerializedDepth) invalidState()
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) invalidState()
      return
    }
    if (typeof value !== 'object' || visited.has(value)) invalidState()
    visited.add(value)

    if (Array.isArray(value)) {
      const keys = Object.keys(value)
      if (keys.length !== value.length) invalidState()
      for (let index = 0; index < value.length; index++) {
        if (keys[index] !== String(index)) invalidState()
        visit(value[index], depth + 1)
      }
      return
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) invalidState()
    if (Object.getOwnPropertySymbols(value).length > 0) invalidState()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || !('value' in descriptor)) invalidState()
      if (key.length > 128) invalidState()
      visit(descriptor.value, depth + 1)
    }
  }

  visit(input, 0)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

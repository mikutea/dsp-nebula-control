import { z } from 'zod'

export type ServerState = 'running' | 'stopped' | 'starting' | 'stopping' | 'unknown'

export interface ControlCapabilities {
  refresh: boolean
  save: boolean
  gracefulStop: boolean
  restart: boolean
}

export interface VersionInventory {
  dsp: string | null
  nebula: string | null
  bepInEx: string | null
  compatible: boolean | null
  gameLoaded: boolean | null
  warnings: Array<'mod-bepinex-target-mismatch' | 'game-load-incomplete'>
}

export interface SavePairStatus {
  name: string | null
  dsvPresent: boolean
  serverPresent: boolean
  consistent: boolean
  lastSavedAt: string | null
  dsvSizeMiB: number | null
  serverSizeKiB: number | null
  latestBackupAt: string | null
  backupManifestPresent: boolean
  backupPairPresent: boolean
}

export interface HostStatus {
  logicalProcessors: number | null
  processorGroups: number | null
  cpuPercent: number | null
  memoryTotalGiB: number | null
  memoryFreeGiB: number | null
}

export interface ScheduledTaskStatus {
  state: 'running' | 'ready' | 'disabled' | 'queued' | 'unknown' | null
  lastResult: number | null
  lastRunAt: string | null
}

export interface AutomationStatus {
  serverTask: ScheduledTaskStatus
  stopTask: ScheduledTaskStatus
  storageTask: ScheduledTaskStatus
  projectRootAvailable: boolean
  globalMappingAvailable: boolean | null
}

export interface ConnectionCheck {
  id: 'game-port' | 'public-wss'
  label: string
  status: 'healthy' | 'warning' | 'unknown'
  detail: string
}

export interface ServerStatus {
  collectedAt: string
  serverName: string
  state: ServerState
  runtime: {
    targetUps: number | null
    onlinePlayers: number | null
    maxPlayers: number | null
    processId: number | null
    processCoresUsed: number | null
    workingSetGiB: number | null
    privateMemoryGiB: number | null
    threadCount: number | null
    priority: string | null
    startedAt: string | null
    uptimeSeconds: number | null
  }
  host: HostStatus
  versions: VersionInventory
  save: SavePairStatus
  automation: AutomationStatus
  connections: ConnectionCheck[]
  capabilities: ControlCapabilities
}

const nullableFiniteNumber = z.number().finite().nullable()
const nullableIsoDate = z.string().datetime({ offset: true }).nullable()
const scheduledTaskStatusSchema = z.strictObject({
  state: z.enum(['running', 'ready', 'disabled', 'queued', 'unknown']).nullable(),
  lastResult: z.number().int().nullable(),
  lastRunAt: nullableIsoDate
})

export const serverStatusSchema: z.ZodType<ServerStatus> = z.strictObject({
  collectedAt: z.string().datetime({ offset: true }),
  serverName: z.string().min(1).max(128),
  state: z.enum(['running', 'stopped', 'starting', 'stopping', 'unknown']),
  runtime: z.strictObject({
    targetUps: z.number().int().positive().nullable(),
    onlinePlayers: z.number().int().nonnegative().nullable(),
    maxPlayers: z.number().int().nonnegative().nullable(),
    processId: z.number().int().positive().nullable(),
    processCoresUsed: z.number().finite().nonnegative().nullable(),
    workingSetGiB: z.number().finite().nonnegative().nullable(),
    privateMemoryGiB: z.number().finite().nonnegative().nullable(),
    threadCount: z.number().int().nonnegative().nullable(),
    priority: z.string().max(32).nullable(),
    startedAt: nullableIsoDate,
    uptimeSeconds: z.number().int().nonnegative().nullable()
  }),
  host: z.strictObject({
    logicalProcessors: z.number().int().positive().nullable(),
    processorGroups: z.number().int().positive().nullable(),
    cpuPercent: z.number().finite().min(0).max(100).nullable(),
    memoryTotalGiB: nullableFiniteNumber,
    memoryFreeGiB: nullableFiniteNumber
  }),
  versions: z.strictObject({
    dsp: z.string().max(32).nullable(),
    nebula: z.string().max(32).nullable(),
    bepInEx: z.string().max(32).nullable(),
    compatible: z.boolean().nullable(),
    gameLoaded: z.boolean().nullable(),
    warnings: z.array(z.enum(['mod-bepinex-target-mismatch', 'game-load-incomplete'])).max(8)
  }),
  save: z.strictObject({
    name: z.string().max(260).nullable(),
    dsvPresent: z.boolean(),
    serverPresent: z.boolean(),
    consistent: z.boolean(),
    lastSavedAt: nullableIsoDate,
    dsvSizeMiB: nullableFiniteNumber,
    serverSizeKiB: nullableFiniteNumber,
    latestBackupAt: nullableIsoDate,
    backupManifestPresent: z.boolean(),
    backupPairPresent: z.boolean()
  }),
  automation: z.strictObject({
    serverTask: scheduledTaskStatusSchema,
    stopTask: scheduledTaskStatusSchema,
    storageTask: scheduledTaskStatusSchema,
    projectRootAvailable: z.boolean(),
    globalMappingAvailable: z.boolean().nullable()
  }),
  connections: z.array(z.strictObject({
    id: z.enum(['game-port', 'public-wss']),
    label: z.string().max(128),
    status: z.enum(['healthy', 'warning', 'unknown']),
    detail: z.string().max(256)
  })).max(8),
  capabilities: z.strictObject({
    refresh: z.boolean(),
    save: z.boolean(),
    gracefulStop: z.boolean(),
    restart: z.boolean()
  })
})

export type JobKind = 'status.refresh' | 'game.save' | 'game.stop' | 'game.restart'
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed'

export interface JobRecord {
  id: string
  kind: JobKind
  state: JobState
  actor: string
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  summary: string
  errorCode: string | null
}

export interface StatusProvider {
  readonly name: 'demo' | 'windows'
  collectStatus(): Promise<ServerStatus>
}

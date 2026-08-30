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
}

export interface SavePairStatus {
  name: string | null
  dsvPresent: boolean
  serverPresent: boolean
  consistent: boolean
  lastSavedAt: string | null
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
    threadCount: number | null
  }
  versions: VersionInventory
  save: SavePairStatus
  connections: ConnectionCheck[]
  capabilities: ControlCapabilities
}

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

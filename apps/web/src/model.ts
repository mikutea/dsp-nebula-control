export interface ServerStatus {
  collectedAt: string
  serverName: string
  state: 'running' | 'stopped' | 'starting' | 'stopping' | 'unknown'
  runtime: {
    targetUps: number | null
    onlinePlayers: number | null
    maxPlayers: number | null
    processId: number | null
    processCoresUsed: number | null
    workingSetGiB: number | null
    threadCount: number | null
  }
  versions: {
    dsp: string | null
    nebula: string | null
    bepInEx: string | null
    compatible: boolean | null
  }
  save: {
    name: string | null
    dsvPresent: boolean
    serverPresent: boolean
    consistent: boolean
    lastSavedAt: string | null
  }
  connections: Array<{
    id: 'game-port' | 'public-wss'
    label: string
    status: 'healthy' | 'warning' | 'unknown'
    detail: string
  }>
  capabilities: {
    refresh: boolean
    save: boolean
    gracefulStop: boolean
    restart: boolean
  }
}

export interface JobRecord {
  id: string
  kind: 'status.refresh' | 'game.save' | 'game.stop' | 'game.restart'
  state: 'queued' | 'running' | 'succeeded' | 'failed'
  actor: string
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  summary: string
  errorCode: string | null
}

export type NavKey =
  | 'overview' | 'game' | 'console' | 'players' | 'versions' | 'mods'
  | 'saves' | 'client' | 'server' | 'config' | 'tasks'

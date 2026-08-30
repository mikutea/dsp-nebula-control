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
    privateMemoryGiB: number | null
    threadCount: number | null
    priority: string | null
    startedAt: string | null
    uptimeSeconds: number | null
  }
  host: {
    logicalProcessors: number | null
    processorGroups: number | null
    cpuPercent: number | null
    memoryTotalGiB: number | null
    memoryFreeGiB: number | null
  }
  versions: {
    dsp: string | null
    nebula: string | null
    bepInEx: string | null
    compatible: boolean | null
    gameLoaded: boolean | null
    warnings: Array<'mod-bepinex-target-mismatch' | 'game-load-incomplete'>
  }
  save: {
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
  automation: {
    serverTask: ScheduledTaskStatus
    stopTask: ScheduledTaskStatus
    storageTask: ScheduledTaskStatus
    projectRootAvailable: boolean
    globalMappingAvailable: boolean | null
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

export interface ScheduledTaskStatus {
  state: 'running' | 'ready' | 'disabled' | 'queued' | 'unknown' | null
  lastResult: number | null
  lastRunAt: string | null
}

export interface JobRecord {
  id: string
  kind:
    | 'status.refresh'
    | 'game.save.preview' | 'game.stop.preview' | 'game.restart.preview'
    | 'game.save' | 'game.stop' | 'game.restart'
  state: 'queued' | 'running' | 'succeeded' | 'failed'
  actor: string
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  summary: string
  errorCode: string | null
}

export type LifecycleAction = 'save' | 'graceful-stop' | 'restart'
export type LifecycleCheckStatus = 'pass' | 'warning' | 'block' | 'not-applicable'
export type LifecycleCheckId =
  | 'project-root' | 'managed-process' | 'pid-file' | 'save-pair' | 'backup-pair'
  | 'server-task' | 'stop-task' | 'stop-task-principal' | 'stop-task-action'
  | 'stop-task-result' | 'task-history' | 'receipt-channel' | 'save-trigger'
  | 'execution-lock'
export type LifecycleBlockerCode =
  | 'project-root-unavailable' | 'managed-process-unverified' | 'pid-file-unverified'
  | 'save-pair-incomplete' | 'backup-pair-unverified' | 'server-task-missing'
  | 'stop-task-missing' | 'stop-task-principal-mismatch' | 'stop-task-not-interactive'
  | 'stop-task-action-unallowlisted' | 'stop-task-last-result-failed'
  | 'receipt-channel-missing' | 'save-trigger-unverified' | 'execution-disabled'

export interface LifecyclePreview {
  collectedAt: string
  action: LifecycleAction
  mode: 'dry-run'
  allowed: boolean
  executionEnabled: boolean
  checks: Array<{ id: LifecycleCheckId; status: LifecycleCheckStatus; message: string }>
  blockers: LifecycleBlockerCode[]
  rollback: {
    strategy: 'no-op' | 'restart-from-same-save' | 'paired-save-backup'
    ready: boolean
    summary: string
  }
}

export type NavKey =
  | 'overview' | 'game' | 'console' | 'players' | 'versions' | 'mods'
  | 'saves' | 'client' | 'server' | 'config' | 'tasks'

import { z } from 'zod'

export type ServerState = 'running' | 'stopped' | 'starting' | 'stopping' | 'unknown'

export interface ControlCapabilities {
  refresh: boolean
  start: boolean
  save: boolean
  gracefulStop: boolean
  restart: boolean
}

export type LifecycleAction = 'start' | 'save' | 'graceful-stop' | 'restart'
export type LifecycleCheckStatus = 'pass' | 'warning' | 'block' | 'not-applicable'
export type LifecycleCheckId =
  | 'project-root' | 'managed-executable' | 'managed-process' | 'pid-file' | 'game-port'
  | 'save-pair' | 'backup-pair'
  | 'server-task' | 'server-task-principal' | 'server-task-action'
  | 'stop-task' | 'stop-task-principal' | 'stop-task-action'
  | 'stop-task-result' | 'task-history' | 'receipt-channel' | 'save-trigger'
  | 'interactive-session' | 'steam-session' | 'lifecycle-broker' | 'execution-lock'
export type LifecycleBlockerCode =
  | 'project-root-unavailable' | 'managed-executable-unavailable'
  | 'managed-process-unverified' | 'server-already-running' | 'pid-file-unverified'
  | 'game-port-unverified' | 'game-port-listening'
  | 'save-pair-incomplete' | 'backup-pair-unverified' | 'server-task-missing'
  | 'server-task-disabled' | 'server-task-not-ready'
  | 'server-task-principal-mismatch' | 'server-task-not-interactive'
  | 'server-task-action-unallowlisted' | 'start-preflight-incomplete'
  | 'stop-task-missing' | 'stop-task-principal-mismatch' | 'stop-task-not-interactive'
  | 'stop-task-action-unallowlisted' | 'stop-task-last-result-failed'
  | 'receipt-channel-missing' | 'save-trigger-unverified' | 'execution-disabled'
  | 'interactive-session-missing' | 'interactive-session-ambiguous'
  | 'steam-session-missing' | 'task-definition-mismatch'
  | 'runtime-state-mismatch' | 'lifecycle-broker-unavailable' | 'execution-lock-busy'

export interface LifecycleCheck {
  id: LifecycleCheckId
  status: LifecycleCheckStatus
  message: string
}

export interface LifecyclePreview {
  collectedAt: string
  action: LifecycleAction
  mode: 'dry-run'
  allowed: boolean
  executionEnabled: boolean
  checks: LifecycleCheck[]
  blockers: LifecycleBlockerCode[]
  rollback: {
    strategy: 'no-op' | 'restart-from-same-save' | 'paired-save-backup'
    ready: boolean
    summary: string
  }
}

export type LifecycleExecutionPhase =
  | 'lock'
  | 'preflight'
  | 'protection-point'
  | 'save'
  | 'stop'
  | 'verify-stopped'
  | 'start'
  | 'verify-running'
  | 'rollback-start'
  | 'reconciliation'

export type LifecycleRunState = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted'
export type LifecycleReceiptState = 'running' | 'succeeded' | 'failed'
export type LifecycleEvidenceValue = string | number | boolean | null
export type LifecycleEvidence = Record<string, LifecycleEvidenceValue>

export interface LifecycleRunRecord {
  jobId: string
  action: LifecycleAction
  idempotencyKey: string
  requestId: string
  state: LifecycleRunState
  currentPhase: LifecycleExecutionPhase | null
  protectionPointId: string | null
  recoveryRequired: boolean
  createdAt: string
  updatedAt: string
}

export interface LifecycleReceiptRecord {
  id: string
  jobId: string
  sequence: number
  phase: LifecycleExecutionPhase
  state: LifecycleReceiptState
  startedAt: string
  finishedAt: string | null
  summary: string
  errorCode: string | null
  evidence: LifecycleEvidence
}

export interface LifecycleOperationContext {
  jobId: string
  requestId: string
  action: LifecycleAction
  protectionPointId: string | null
  signal: AbortSignal
  /**
   * Present only while the lifecycle transaction owns the process-wide host
   * mutation lease. Privileged host brokers must borrow this exact lease
   * instead of acquiring an unrelated nested mutation scope.
   */
  hostMutation?: LifecycleHostMutationScope
}

export interface LifecycleHostMutationScope {
  assertActive(): void
  toPowerShellBorrowArguments(): readonly string[]
}

export interface LifecyclePhaseResult {
  summary: string
  evidence?: LifecycleEvidence
  protectionPointId?: string
}

export interface LifecyclePreviewContext {
  executionLockReady: boolean
  /** Durable outer request id during execution preflight; absent for public previews. */
  requestId?: string
  /** Phase cancellation signal; public previews may omit it. */
  signal?: AbortSignal
  /** Only present for the execution preflight while the host lease is held. */
  hostMutation?: LifecycleHostMutationScope
}

export interface LifecycleMutationAdapter {
  readonly mutationEnabled: boolean
  previewLifecycle(action: LifecycleAction, context: LifecyclePreviewContext): Promise<LifecyclePreview>
  createProtectionPoint(context: LifecycleOperationContext): Promise<LifecyclePhaseResult>
  requestSave(context: LifecycleOperationContext): Promise<LifecyclePhaseResult>
  requestGracefulStop(context: LifecycleOperationContext): Promise<LifecyclePhaseResult>
  verifyStopped(context: LifecycleOperationContext): Promise<LifecyclePhaseResult>
  requestStart(context: LifecycleOperationContext): Promise<LifecyclePhaseResult>
  verifyRunning(context: LifecycleOperationContext): Promise<LifecyclePhaseResult>
  requestRollbackStart(context: LifecycleOperationContext): Promise<LifecyclePhaseResult>
}

export class LifecycleExecutionError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'LifecycleExecutionError'
    this.code = code
  }
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

export const HOST_TELEMETRY_UNAVAILABLE_REASONS = [
  'cim-unavailable',
  'volume-unavailable',
  'network-counters-unavailable',
  'no-eligible-network-interface',
  'inconsistent-sample'
] as const

export type HostTelemetryUnavailableReason = (typeof HOST_TELEMETRY_UNAVAILABLE_REASONS)[number]
export type HostCpuTelemetryUnavailableReason = Extract<
  HostTelemetryUnavailableReason,
  'cim-unavailable' | 'inconsistent-sample'
>
export type HostVolumeTelemetryUnavailableReason = Extract<
  HostTelemetryUnavailableReason,
  'volume-unavailable' | 'inconsistent-sample'
>
export type HostNetworkTelemetryUnavailableReason = Extract<
  HostTelemetryUnavailableReason,
  'network-counters-unavailable' | 'no-eligible-network-interface' | 'inconsistent-sample'
>

export interface HostCpuCoreSample {
  index: number
  percent: number
}

export interface HostCpuCoreTelemetry {
  samples: HostCpuCoreSample[] | null
  unavailableReason: HostCpuTelemetryUnavailableReason | null
}

export interface HostVolumeTelemetry {
  totalBytes: number | null
  availableBytes: number | null
  usedPercent: number | null
  unavailableReason: HostVolumeTelemetryUnavailableReason | null
}

export interface HostNetworkTelemetry {
  receiveBytesPerSecond: number | null
  sendBytesPerSecond: number | null
  sampledInterfaceCount: number | null
  unavailableReason: HostNetworkTelemetryUnavailableReason | null
}

export interface HostStatus {
  logicalProcessors: number | null
  processorGroups: number | null
  cpuPercent: number | null
  memoryTotalGiB: number | null
  memoryFreeGiB: number | null
  /** Optional only for backward-compatible trusted fixtures; Windows emits it. */
  cpuCores?: HostCpuCoreTelemetry
  /** Contains capacity only; no drive letter, UNC path, or volume identifier. */
  projectVolume?: HostVolumeTelemetry
  /** Contains capacity only; no save path or volume identifier. */
  saveVolume?: HostVolumeTelemetry
  /** Aggregate of eligible non-loopback interfaces; no interface identity. */
  network?: HostNetworkTelemetry
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
const nullableNonnegativeFiniteNumber = z.number().finite().nonnegative().nullable()
const nullableIsoDate = z.string().datetime({ offset: true }).nullable()
const safeByteCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const hostCpuTelemetryUnavailableReasonSchema = z.enum(['cim-unavailable', 'inconsistent-sample'])
const hostVolumeTelemetryUnavailableReasonSchema = z.enum(['volume-unavailable', 'inconsistent-sample'])
const hostNetworkTelemetryUnavailableReasonSchema = z.enum([
  'network-counters-unavailable', 'no-eligible-network-interface', 'inconsistent-sample'
])
const hostCpuCoreTelemetrySchema: z.ZodType<HostCpuCoreTelemetry> = z.strictObject({
  samples: z.array(z.strictObject({
    index: z.number().int().min(0).max(4_095),
    percent: z.number().finite().min(0).max(100)
  })).min(1).max(4_096).nullable(),
  unavailableReason: hostCpuTelemetryUnavailableReasonSchema.nullable()
}).superRefine((value, context) => {
  if ((value.samples === null) === (value.unavailableReason === null)) {
    context.addIssue({ code: 'custom', message: 'CPU core samples require exactly one availability state' })
  }
  if (value.samples !== null) {
    if (value.samples.some((sample, index) => sample.index !== index)) {
      context.addIssue({ code: 'custom', message: 'CPU core indexes must be complete and ordered', path: ['samples'] })
    }
  }
})
const hostVolumeTelemetrySchema: z.ZodType<HostVolumeTelemetry> = z.strictObject({
  totalBytes: safeByteCountSchema.positive().nullable(),
  availableBytes: safeByteCountSchema.nullable(),
  usedPercent: z.number().finite().min(0).max(100).nullable(),
  unavailableReason: hostVolumeTelemetryUnavailableReasonSchema.nullable()
}).superRefine((value, context) => {
  const valuesAvailable = value.totalBytes !== null && value.availableBytes !== null && value.usedPercent !== null
  const valuesUnavailable = value.totalBytes === null && value.availableBytes === null && value.usedPercent === null
  if ((!valuesAvailable && !valuesUnavailable) || valuesAvailable === (value.unavailableReason !== null)) {
    context.addIssue({ code: 'custom', message: 'volume telemetry availability is inconsistent' })
    return
  }
  if (valuesAvailable) {
    if (value.availableBytes! > value.totalBytes!) {
      context.addIssue({ code: 'custom', message: 'available volume bytes exceed total bytes' })
      return
    }
    const expected = ((value.totalBytes! - value.availableBytes!) / value.totalBytes!) * 100
    if (Math.abs(expected - value.usedPercent!) > 0.011) {
      context.addIssue({ code: 'custom', message: 'volume used percentage is inconsistent with byte totals' })
    }
  }
})
const hostNetworkTelemetrySchema: z.ZodType<HostNetworkTelemetry> = z.strictObject({
  receiveBytesPerSecond: safeByteCountSchema.nullable(),
  sendBytesPerSecond: safeByteCountSchema.nullable(),
  sampledInterfaceCount: z.number().int().min(1).max(4_096).nullable(),
  unavailableReason: hostNetworkTelemetryUnavailableReasonSchema.nullable()
}).superRefine((value, context) => {
  const valuesAvailable = value.receiveBytesPerSecond !== null
    && value.sendBytesPerSecond !== null
    && value.sampledInterfaceCount !== null
  const valuesUnavailable = value.receiveBytesPerSecond === null
    && value.sendBytesPerSecond === null
    && value.sampledInterfaceCount === null
  if ((!valuesAvailable && !valuesUnavailable) || valuesAvailable === (value.unavailableReason !== null)) {
    context.addIssue({ code: 'custom', message: 'network telemetry availability is inconsistent' })
  }
})
const hostStatusSchema: z.ZodType<HostStatus> = z.strictObject({
  logicalProcessors: z.number().int().positive().max(4_096).nullable(),
  processorGroups: z.number().int().positive().max(64).nullable(),
  cpuPercent: z.number().finite().min(0).max(100).nullable(),
  memoryTotalGiB: nullableNonnegativeFiniteNumber,
  memoryFreeGiB: nullableNonnegativeFiniteNumber,
  cpuCores: hostCpuCoreTelemetrySchema.optional(),
  projectVolume: hostVolumeTelemetrySchema.optional(),
  saveVolume: hostVolumeTelemetrySchema.optional(),
  network: hostNetworkTelemetrySchema.optional()
}).superRefine((value, context) => {
  if (value.memoryTotalGiB !== null && value.memoryFreeGiB !== null && value.memoryFreeGiB > value.memoryTotalGiB) {
    context.addIssue({ code: 'custom', message: 'free memory exceeds total memory' })
  }
  if (value.cpuCores?.samples !== null && value.cpuCores?.samples !== undefined
      && value.logicalProcessors !== null && value.cpuCores.samples.length !== value.logicalProcessors) {
    context.addIssue({ code: 'custom', message: 'CPU core count does not match logical processor count', path: ['cpuCores'] })
  }
})
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
  host: hostStatusSchema,
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
    start: z.boolean(),
    save: z.boolean(),
    gracefulStop: z.boolean(),
    restart: z.boolean()
  })
})

const lifecycleActionSchema = z.enum(['start', 'save', 'graceful-stop', 'restart'])
const lifecycleCheckIdSchema = z.enum([
  'project-root', 'managed-executable', 'managed-process', 'pid-file', 'game-port',
  'save-pair', 'backup-pair',
  'server-task', 'server-task-principal', 'server-task-action',
  'stop-task', 'stop-task-principal', 'stop-task-action',
  'stop-task-result', 'task-history', 'receipt-channel', 'save-trigger',
  'interactive-session', 'steam-session', 'lifecycle-broker', 'execution-lock'
])
const lifecycleBlockerSchema = z.enum([
  'project-root-unavailable', 'managed-executable-unavailable',
  'managed-process-unverified', 'server-already-running', 'pid-file-unverified',
  'game-port-unverified', 'game-port-listening',
  'save-pair-incomplete', 'backup-pair-unverified', 'server-task-missing',
  'server-task-disabled', 'server-task-not-ready',
  'server-task-principal-mismatch', 'server-task-not-interactive',
  'server-task-action-unallowlisted', 'start-preflight-incomplete',
  'stop-task-missing', 'stop-task-principal-mismatch', 'stop-task-not-interactive',
  'stop-task-action-unallowlisted', 'stop-task-last-result-failed',
  'receipt-channel-missing', 'save-trigger-unverified', 'execution-disabled',
  'interactive-session-missing', 'interactive-session-ambiguous',
  'steam-session-missing', 'task-definition-mismatch',
  'runtime-state-mismatch', 'lifecycle-broker-unavailable', 'execution-lock-busy'
])

export const lifecyclePreviewSchema: z.ZodType<LifecyclePreview> = z.strictObject({
  collectedAt: z.string().datetime({ offset: true }),
  action: lifecycleActionSchema,
  mode: z.literal('dry-run'),
  allowed: z.boolean(),
  executionEnabled: z.boolean(),
  checks: z.array(z.strictObject({
    id: lifecycleCheckIdSchema,
    status: z.enum(['pass', 'warning', 'block', 'not-applicable']),
    message: z.string().min(1).max(256)
  })).min(1).max(24),
  blockers: z.array(lifecycleBlockerSchema).max(24),
  rollback: z.strictObject({
    strategy: z.enum(['no-op', 'restart-from-same-save', 'paired-save-backup']),
    ready: z.boolean(),
    summary: z.string().min(1).max(256)
  })
})

export const lifecycleActionRequestSchema = z.strictObject({ action: lifecycleActionSchema })

export const lifecycleExecutionRequestSchema = z.strictObject({
  action: lifecycleActionSchema,
  idempotencyKey: z.string().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  confirmation: z.literal('EXECUTE')
})

export const jobKinds = [
  'status.refresh',
  'game.start.preview', 'game.save.preview', 'game.stop.preview', 'game.restart.preview',
  'game.start', 'game.save', 'game.stop', 'game.restart',
  'save.backup', 'save.restore',
  'player.notice.preview', 'player.notice',
  'audit.export'
] as const
export type JobKind = (typeof jobKinds)[number]

export const jobStates = ['queued', 'running', 'succeeded', 'failed'] as const
export type JobState = (typeof jobStates)[number]

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
  previewLifecycle(action: LifecycleAction, signal?: AbortSignal): Promise<LifecyclePreview>
}

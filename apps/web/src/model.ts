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
    start: boolean
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
    | 'game.start.preview' | 'game.save.preview' | 'game.stop.preview' | 'game.restart.preview'
    | 'game.start' | 'game.save' | 'game.stop' | 'game.restart'
    | 'save.backup' | 'save.restore'
  state: 'queued' | 'running' | 'succeeded' | 'failed'
  actor: string
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  summary: string
  errorCode: string | null
}

export type ControlRole = 'viewer' | 'operator' | 'administrator'

export type ControlPermission =
  | 'status.read' | 'status.refresh' | 'jobs.read' | 'observability.read' | 'observability.acknowledge'
  | 'players.read' | 'players.moderate'
  | 'console.read' | 'console.export' | 'console.command'
  | 'saves.read' | 'saves.backup' | 'saves.restore' | 'saves.transfer'
  | 'lifecycle.preview' | 'lifecycle.execute'
  | 'configuration.read' | 'configuration.preview' | 'configuration.apply'
  | 'updates.read' | 'updates.stage' | 'updates.activate'
  | 'mods.read' | 'mods.mutate' | 'client-profile.generate'

export interface SessionUser {
  name: string
  role: ControlRole
  permissions: ControlPermission[]
}

export type LifecycleAction = 'start' | 'save' | 'graceful-stop' | 'restart'
export type LifecycleCheckStatus = 'pass' | 'warning' | 'block' | 'not-applicable'
export type LifecycleCheckId =
  | 'project-root' | 'managed-executable' | 'managed-process' | 'pid-file' | 'game-port'
  | 'save-pair' | 'backup-pair'
  | 'server-task' | 'server-task-principal' | 'server-task-action'
  | 'stop-task' | 'stop-task-principal' | 'stop-task-action'
  | 'stop-task-result' | 'task-history' | 'receipt-channel' | 'save-trigger'
  | 'execution-lock'
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
  | 'execution-lock-busy'

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

export type LifecycleExecutionPhase =
  | 'lock' | 'preflight' | 'protection-point' | 'save' | 'stop'
  | 'verify-stopped' | 'start' | 'verify-running' | 'rollback-start' | 'reconciliation'

export interface LifecycleRunRecord {
  jobId: string
  action: LifecycleAction
  idempotencyKey: string
  requestId: string
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted'
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
  state: 'running' | 'succeeded' | 'failed'
  startedAt: string
  finishedAt: string | null
  summary: string
  errorCode: string | null
  evidence: Record<string, string | number | boolean | null>
}

export interface LifecycleExecutionResult {
  job: JobRecord
  run: LifecycleRunRecord
  receipts: LifecycleReceiptRecord[]
  reused: boolean
}

export type ConsoleCommandName =
  | 'server.start' | 'server.save' | 'server.stop' | 'server.restart'

export type ConsoleCommandConfirmation =
  | 'START_SERVER' | 'SAVE_SERVER' | 'STOP_SERVER' | 'RESTART_SERVER'

export interface ConsoleCommandPreview {
  mode: 'dry-run'
  command: ConsoleCommandName
  label: string
  requiredConfirmation: ConsoleCommandConfirmation
  lifecycle: LifecyclePreview
}

export interface SavePairCatalogItem {
  id: string
  name: string
  health: 'healthy' | 'incomplete' | 'corrupt'
  issues: string[]
  dsv: { bytes: number; modifiedAt: string } | null
  server: { bytes: number; modifiedAt: string } | null
  lastModifiedAt: string | null
  totalBytes: number
}

export interface BackupCatalogItem {
  schemaVersion: 1
  backupId: string
  saveName: string | null
  createdAt: string | null
  health: 'healthy' | 'incomplete' | 'corrupt'
  issues: string[]
  manifestPresent: boolean
  manifestValid: boolean
  pairPresent: boolean
  dsvBytes: number | null
  serverBytes: number | null
  totalBytes: number
}

export interface BackupAnnotation {
  backupId: string
  revision: number
  note: string | null
  protected: boolean
  updatedAt: string
}

export interface BackupAnnotationReceipt {
  schemaVersion: 1
  operation: 'annotate'
  requestId: string
  committedAt: string
  annotation: BackupAnnotation
}

export interface BackupRetentionPolicy {
  keepLastHealthy: number
  keepDailyDays: number
  keepWeeklyWeeks: number
  minimumHealthy: number
  allowUnhealthyDeletion: boolean
}

export interface BackupRetentionPlan {
  schemaVersion: 1
  mode: 'dry-run'
  referenceTime: string
  policy: BackupRetentionPolicy
  keep: Array<{
    backupId: string
    reasons: Array<'protected' | 'latest-healthy' | 'minimum-healthy' | 'daily' | 'weekly'>
  }>
  delete: Array<{
    backupId: string
    reason: 'outside-policy' | 'unhealthy-deletion-enabled'
  }>
  blocked: Array<{ backupId: string; reason: 'unhealthy-backup' }>
}

export interface BackupRetentionPreview {
  schemaVersion: 1
  mode: 'dry-run'
  referenceTime: string
  policy: BackupRetentionPolicy
  plan: BackupRetentionPlan
  excluded: Array<{
    backupId: string
    reason: 'created-at-unavailable' | 'redirected-entry'
  }>
  inventoryDigest: string
  previewDigest: string
}

export interface BackupRetirementReceipt {
  schemaVersion: 1
  operation: 'retire'
  requestId: string
  previewDigest: string
  committedAt: string
  retired: Array<{
    backupId: string
    saveName: string
    createdAt: string
    health: 'healthy' | 'incomplete' | 'corrupt'
    totalBytes: number
    evidenceDigest: string
  }>
  recoveryRequired: false
}

export interface BackupRetirementRestoreReceipt {
  schemaVersion: 1
  operation: 'restore-retired'
  requestId: string
  retirementRequestId: string
  committedAt: string
  restoredBackupIds: string[]
  recoveryRequired: false
}

export interface BackupRetentionPurgePreview {
  schemaVersion: 1
  mode: 'dry-run'
  retirementRequestId: string
  eligibleAt: string
  eligible: boolean
  retiredBackupIds: string[]
  totalBytes: number
  retirementReceiptDigest: string
  purgePreviewDigest: string
}

export interface BackupRetentionPurgeReceipt {
  schemaVersion: 1
  operation: 'purge-retired'
  requestId: string
  retirementRequestId: string
  committedAt: string
  purgedBackupIds: string[]
  bytesFreed: number
  recoveryRequired: false
}

export interface CatalogPage<T> {
  schemaVersion: 1
  kind: 'saves' | 'backups'
  generatedAt: string
  items: T[]
  page: { limit: number; returned: number; totalUnits: number; nextCursor: string | null }
  rejectedEntryCount: number
}

export interface SavePairRevision {
  schemaVersion: 1
  saveName: string
  revision: string
  dsvBytes: number
  serverBytes: number
  totalBytes: number
}

export interface SaveTransactionResult {
  schemaVersion: 1
  requestId: string
  operation: 'backup' | 'restore'
  status: 'dry-run' | 'succeeded' | 'busy' | 'rejected' | 'revision-conflict' | 'failed' | 'rolled-back' | 'rollback-failed'
  dryRun: boolean
  backupId: string
  protectionBackupId?: string
  reused: boolean
  rollback: 'not-required' | 'succeeded' | 'failed'
  pairBytes: number
  beforeRevision?: string
  afterRevision?: string
  errorCode?: string
  auditStored: boolean
}

export interface SaveJobResultSummary {
  status: SaveTransactionResult['status']
  backupId: string
  protectionBackupId: string | null
  pairBytes: number
  rollback: 'not-required' | 'succeeded' | 'failed'
  reused: boolean
  auditStored: boolean
}

export interface SaveJobRunRecord {
  jobId: string
  operation: 'backup' | 'restore'
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted'
  attemptCount: number
  result: SaveJobResultSummary | null
  errorCode: string | null
  recoveryRequired: boolean
  createdAt: string
  updatedAt: string
}

export interface SaveJobExecutionResult {
  job: JobRecord
  run: SaveJobRunRecord
  reused: boolean
}

export interface SavePairExportReceipt {
  format: 'dyson-control-save-transfer-receipt'
  schemaVersion: 1
  operation: 'export'
  requestId: string
  backupId: string
  archiveId: string
  saveName: string
  archiveBytes: number
  archiveSha256: string
  completedAt: string
  restoreExecuted: false
  reused: boolean
}

export interface SavePairImportReceipt {
  format: 'dyson-control-save-transfer-receipt'
  schemaVersion: 1
  operation: 'import'
  requestId: string
  inboxId: string
  saveName: string
  archiveBytes: number
  archiveSha256: string
  dsvBytes: number
  serverBytes: number
  completedAt: string
  restoreExecuted: false
  reused: boolean
}

export interface SavePairTransferDownload {
  blob: Blob
  fileName: string
  sizeBytes: number
  sha256: string
}

export type GameConfigFileId = 'nebula' | 'galaxy' | 'bepinex' | 'bridge'
export type PublicGameConfigValue = boolean | number | { configured: boolean }

export interface GameConfigEntry {
  id: string
  file: GameConfigFileId
  label: string
  description: string
  activation: 'server-restart' | 'new-game-only'
  type: 'boolean' | 'integer' | 'number' | 'secret'
  minimum?: number
  maximum?: number
  allowed?: number[]
  value: PublicGameConfigValue
  source: 'file' | 'default' | 'invalid'
}

export interface GameConfigSnapshot {
  revision: string
  entries: GameConfigEntry[]
  invalidSettingIds: string[]
}

export interface GameConfigPreview {
  mode: 'dry-run'
  baseRevision: string
  nextRevision: string
  restartRequired: boolean
  newGameOnlyChanged: boolean
  diff: Array<{
    id: string
    file: GameConfigFileId
    label: string
    activation: 'server-restart' | 'new-game-only'
    before: PublicGameConfigValue
    after: PublicGameConfigValue
    changed: boolean
  }>
}

export interface GameConfigTransactionResult {
  transactionId: string
  status: 'applied'
  dryRun: false
  baseRevision: string
  nextRevision: string
  changedSettingIds: string[]
  restartRequired: boolean
  newGameOnlyChanged: boolean
  snapshotId?: string
  auditStored: boolean
}

export type GameConfigHistorySnapshotKind = 'manual' | 'pre-restore'

export interface GameConfigHistorySnapshotSummary {
  format: 'dyson-control-game-config-snapshot'
  snapshotId: string
  kind: GameConfigHistorySnapshotKind
  createdAt: string
  revision: string
  manifestSha256: string
  fileCount: number
  totalBytes: number
}

export interface GameConfigHistorySnapshotFileDetail {
  id: GameConfigFileId
  present: boolean
  bytes: number
}

export interface GameConfigHistorySnapshotDetail extends GameConfigHistorySnapshotSummary {
  files: GameConfigHistorySnapshotFileDetail[]
}

export interface GameConfigHistoryFileDiff {
  id: GameConfigFileId
  beforePresent: boolean
  afterPresent: boolean
  changed: boolean
}

export interface GameConfigHistorySettingDiff {
  id: string
  file: GameConfigFileId
  before: PublicGameConfigValue
  after: PublicGameConfigValue
  changed: boolean
}

export interface GameConfigHistoryDiff {
  snapshotId: string
  currentRevision: string
  targetRevision: string
  files: GameConfigHistoryFileDiff[]
  settings: GameConfigHistorySettingDiff[]
}

export type GameConfigHistoryErrorCode =
  | 'CONFIG_HISTORY_REQUEST_INVALID'
  | 'CONFIG_HISTORY_REQUEST_CONFLICT'
  | 'CONFIG_HISTORY_ROOT_UNAVAILABLE'
  | 'CONFIG_HISTORY_STORAGE_UNAVAILABLE'
  | 'CONFIG_HISTORY_BUSY'
  | 'CONFIG_HISTORY_CAPACITY_EXCEEDED'
  | 'CONFIG_HISTORY_SNAPSHOT_INVALID'
  | 'CONFIG_HISTORY_REVISION_CONFLICT'
  | 'CONFIG_HISTORY_STOP_PROOF_REJECTED'
  | 'CONFIG_HISTORY_RECONCILIATION_REQUIRED'
  | 'CONFIG_HISTORY_COMMIT_FAILED'
  | 'CONFIG_HISTORY_ROLLBACK_FAILED'
  | 'CONFIG_HISTORY_INTERRUPTED_RECOVERED'
  | 'CONFIG_HISTORY_HTTP_REQUEST_INVALID'
  | 'CONFIG_HISTORY_HTTP_CONFIRMATION_INVALID'
  | 'CONFIG_HISTORY_HTTP_MUTATION_DISABLED'
  | 'CONFIG_HISTORY_HTTP_GATE_UNAVAILABLE'
  | 'CONFIG_HISTORY_HTTP_STOP_PROOF_UNAVAILABLE'
  | 'CONFIG_HISTORY_HTTP_RESPONSE_INVALID'
  | 'CONFIG_HISTORY_HTTP_UNAVAILABLE'
  | 'CONFIG_HISTORY_HTTP_SNAPSHOT_NOT_FOUND'

export type GameConfigHistoryRestoreStatus =
  | 'busy'
  | 'dry-run'
  | 'restored'
  | 'rejected'
  | 'rolled-back'
  | 'recovery-required'
  | 'interrupted-recovered'

export interface GameConfigHistoryRestoreReceipt {
  format: 'dyson-control-game-config-restore-receipt'
  version: 1
  requestId: string
  snapshotId: string
  protectionSnapshotId: string | null
  status: GameConfigHistoryRestoreStatus
  dryRun: boolean
  expectedCurrentRevision: string
  targetRevision: string | null
  finalRevision: string | null
  errorCode: GameConfigHistoryErrorCode | 'NONE'
  startedAt: string
  finishedAt: string
  persisted: boolean
  reused: boolean
}

export interface GameConfigHistoryRecoveryResult {
  requestId: string
  status: 'committed-cleanup' | 'interrupted-recovered' | 'recovery-required'
  finalRevision: string | null
  errorCode: GameConfigHistoryErrorCode | 'NONE'
}

export interface GameConfigHistoryRestoreRequest {
  requestId: string
  snapshotId: string
  expectedCurrentRevision: string
  dryRun: boolean
  confirmation: 'RESTORE_CONFIG_SNAPSHOT'
}

export type StructuredLogLevel =
  | 'trace' | 'debug' | 'info' | 'message' | 'warning' | 'error' | 'fatal' | 'unknown'

export interface StructuredLogEntry {
  schemaVersion: 1
  id: string
  timestamp: string | null
  level: StructuredLogLevel
  source: string
  text: string
  lineTruncated: boolean
}

export interface StructuredLogPage {
  schemaVersion: 1
  kind: 'bepinex-structured-log-page'
  observedAt: string
  entries: StructuredLogEntry[]
  cursor: string
  generation: number
  transition: 'none' | 'initial-tail' | 'initial-beginning' | 'rotated' | 'truncated'
  hasMore: boolean
  partialLinePending: boolean
  scannedBytes: number
  filteredOut: number
  redactionVersion: 1
}

export interface StructuredLogFilters {
  levels?: StructuredLogLevel[]
  text?: string
}

export interface StructuredLogReadRequest {
  cursor?: string
  start?: 'tail' | 'beginning'
  limit?: number
  filters?: StructuredLogFilters
}

export interface PublicPlayer {
  sessionPlayerId: string
  displayName: string
  online: boolean
  joinedAt: string
  location: string
}

export interface PlayerPresenceEvent {
  sequence: number
  type: 'join' | 'leave'
  occurredAt: string
  player: PublicPlayer
}

export interface PlayerRoster {
  schemaVersion: 1
  state: 'active' | 'inactive' | 'unavailable'
  authoritative: boolean
  observedAt: string
  sequence: number
  truncated: boolean
  playerCount: number | null
  players: PublicPlayer[] | null
  lastKnownPlayers: PublicPlayer[]
  recentEvents: PlayerPresenceEvent[]
}

export type PlayerCapabilityId =
  | 'observe-roster' | 'disconnect' | 'kick' | 'ban' | 'whitelist' | 'permission'

export interface PlayerCapabilityProjection {
  capability: PlayerCapabilityId
  availability: 'available' | 'unavailable'
  mode: 'read-only' | 'mutation'
  reasonCode: string
  reasonSummary: string
}

export interface PlayerCapabilitiesProjection {
  repository: string
  tag: string
  runtimeFileVersion: string
  commit: string
  verificationScope: string
  actionsEnabled: boolean
  observedAt: string
  capabilities: PlayerCapabilityProjection[]
}

export interface DiscoveredArtifact {
  artifactId: string
  downloadUrl: string
  fileName: string
  sizeBytes: number | null
  sha256: string | null
  integrity: 'provider-sha256' | 'locally-computed-required'
}

export interface DiscoveredNebulaRelease {
  provider: 'github'
  sourceId: 'github:NebulaModTeam/nebula'
  releaseId: number
  version: string
  publishedAt: string
  prerelease: boolean
  artifact: DiscoveredArtifact
}

export interface NebulaDiscoveryPage {
  items: DiscoveredNebulaRelease[]
  pagesFetched: number
  truncated: boolean
}

export type ArtifactAcquisitionProvider = 'github' | 'thunderstore'
export type ArtifactAcquisitionReleaseKind = 'nebula' | 'bepinex' | 'plugin'
export type ArtifactAcquisitionRegistrationStatus =
  | 'registered'
  | 'not-configured'
  | 'release-ineligible'
  | 'registration-failed'

/**
 * Redacted server-side candidate identity. A browser can reference this object
 * only by candidateId; it never receives an acquisition URL or host path here.
 */
export interface ArtifactAcquisitionCandidate {
  candidateId: string
  provider: ArtifactAcquisitionProvider
  release: {
    kind: ArtifactAcquisitionReleaseKind
    sourceId: string
    version: string
    dependencies?: string[]
    dependencyFingerprint?: string
  }
  artifact: {
    artifactId: string
    fileName: string
    sizeBytes: number | null
    sha256: string | null
    integrity: 'provider-sha256' | 'locally-computed-required'
  }
  expiresAt: string
}

export interface ArtifactAcquisitionRegistration {
  artifactId: string
  eligible: boolean
  status: ArtifactAcquisitionRegistrationStatus
  candidate: ArtifactAcquisitionCandidate | null
}

export interface ArtifactAcquisitionDiscoveryMeta {
  configured: boolean
  executionEnabled: boolean
  candidates: ArtifactAcquisitionRegistration[]
}

export interface NebulaDiscoveryEnvelope {
  data: NebulaDiscoveryPage
  meta: { acquisition: ArtifactAcquisitionDiscoveryMeta }
}

export type SupportedBepInExGithubVersion =
  | '5.4.22' | '5.4.22.0' | '5.4.23.2' | '5.4.23.3' | '5.4.23.4' | '5.4.23.5'

export type BepInExWindowsX64LayoutPolicyId =
  | 'bepinex5-win-x64-5.4.22-v1'
  | 'bepinex5-win-x64-5.4.23.2-5-v1'

export interface DiscoveredBepInExRelease {
  provider: 'github'
  sourceId: 'github:BepInEx/BepInEx'
  releaseId: number
  version: SupportedBepInExGithubVersion
  publishedAt: string
  layoutPolicy: BepInExWindowsX64LayoutPolicyId
  artifact: DiscoveredArtifact
}

export interface BepInExDiscoveryPage {
  items: DiscoveredBepInExRelease[]
  pagesFetched: number
  truncated: boolean
}

export interface BepInExDiscoveryEnvelope {
  data: BepInExDiscoveryPage
  meta: { acquisition: ArtifactAcquisitionDiscoveryMeta }
}

export type ComponentDiscoveryRelease = DiscoveredNebulaRelease | DiscoveredBepInExRelease

export interface DiscoveredModRelease {
  provider: 'thunderstore'
  sourceId: string
  dependencyId: string
  namespace: string
  name: string
  version: string
  dependencies: string[]
  publishedAt: string
  deprecated: boolean
  eligible: boolean
  blockers: Array<
    'package-deprecated' | 'version-inactive' | 'community-not-approved' | 'artifact-integrity-pending'
  >
  artifact: DiscoveredArtifact
}

export interface ThunderstoreDependencyClosure {
  roots: string[]
  order: 'dependencies-first'
  items: DiscoveredModRelease[]
  routes: ThunderstoreDependencyRoute[]
  nodeCount: number
  maximumDepth: number
  canAcquireAll: boolean
  blocked: Array<{
    dependencyId: string
    blockers: DiscoveredModRelease['blockers']
  }>
}

export type ThunderstoreDependencyRoute =
  | {
      dependencyId: string
      sourceId: string
      requiredVersion: string
      disposition: 'plugin'
      deploymentOwner: 'mods'
      resolution: 'mod-import-pipeline'
      directPluginAcquisitionAllowed: true
    }
  | {
      dependencyId: string
      sourceId: string
      requiredVersion: string
      disposition: 'managed-component'
      deploymentOwner: 'nebula'
      resolution: 'nebula-component-pipeline'
      directPluginAcquisitionAllowed: false
    }
  | {
      dependencyId: string
      sourceId: string
      requiredVersion: string
      disposition: 'external-prerequisite'
      deploymentOwner: 'bepinex'
      resolution: 'bepinex-component-inventory'
      directPluginAcquisitionAllowed: false
    }
  | {
      dependencyId: string
      sourceId: string
      requiredVersion: string
      disposition: 'unsupported-platform-package'
      deploymentOwner: null
      resolution: 'manual-policy-required'
      directPluginAcquisitionAllowed: false
    }

export interface ThunderstoreDiscoveryEnvelope {
  data: DiscoveredModRelease
  meta: { acquisition: ArtifactAcquisitionDiscoveryMeta }
}

export interface ThunderstoreDependencyClosureEnvelope {
  data: ThunderstoreDependencyClosure
  meta: { acquisition: ArtifactAcquisitionDiscoveryMeta }
}

export type ArtifactAcquisitionOperation =
  | 'load-server-registered-candidate'
  | 'acquire-exclusive-request-and-artifact-locks'
  | 'download-from-bound-provider'
  | 'stream-size-and-sha256-verification'
  | 'atomically-publish-fixed-inbox-artifact'
  | 'persist-acquisition-receipt'
  | 'release-exclusive-locks'

export interface ArtifactAcquisitionPlan {
  format: 'dyson-control-artifact-acquisition-plan'
  schemaVersion: 1
  dryRun: true
  candidate: ArtifactAcquisitionCandidate
  operations: ArtifactAcquisitionOperation[]
  staging: { automatic: false; nextAction: 'offline-artifact-staging' }
}

export interface ArtifactAcquisitionReceipt {
  format: 'dyson-control-artifact-acquisition-receipt'
  schemaVersion: 1
  requestId: string
  candidateId: string
  provider: ArtifactAcquisitionProvider
  release: ArtifactAcquisitionCandidate['release']
  artifact: {
    artifactId: string
    fileName: string
    sizeBytes: number
    sha256: string
    integrity: 'provider-verified' | 'locally-computed'
  }
  state: 'acquired'
  reused: boolean
  acquiredAt: string
}

export type SupportedComponentCandidatePreparationComponent = 'nebula' | 'bepinex'
export type ComponentCandidatePreparationComponent =
  | SupportedComponentCandidatePreparationComponent | 'bridge' | 'control'

export type NebulaWindowsLayoutPolicyId = 'nebula-official-windows-v0.9.22'
export type ComponentCandidatePreparationLayoutPolicy =
  | NebulaWindowsLayoutPolicyId | BepInExWindowsX64LayoutPolicyId

export type ComponentCandidatePreparationOperation =
  | 'load-validated-acquisition-receipt'
  | 'verify-fixed-inbox-artifact'
  | 'acquire-exclusive-request-and-artifact-locks'
  | 'validate-official-nebula-windows-layout-and-identity'
  | 'build-deterministic-server-managed-component-archive'
  | 'atomically-publish-fixed-inbox-artifact'
  | 'validate-reviewed-bepinex-windows-x64-layout'
  | 'stage-official-artifact-directly'
  | 'stage-verified-artifact'
  | 'persist-preparation-receipt'
  | 'release-exclusive-locks'

export interface ComponentCandidatePreparationUnavailable {
  format: 'dyson-control-component-preparation-unavailable'
  schemaVersion: 1
  available: false
  component: 'bridge' | 'control'
  acquisitionReceiptId: string
  reasonCode: 'CANDIDATE_PREPARATION_COMPONENT_UNAVAILABLE'
}

export interface AvailableComponentCandidatePreparationPlan {
  format: 'dyson-control-component-preparation-plan'
  schemaVersion: 1
  available: true
  dryRun: true
  component: SupportedComponentCandidatePreparationComponent
  acquisitionReceiptId: string
  source: {
    provider: 'github'
    sourceId: string
    version: string
    artifactId: string
    sizeBytes: number
    sha256: string
    integrity: 'provider-verified' | 'locally-computed'
  }
  prepared: {
    mode: 'normalized-nebula-windows' | 'official-bepinex-windows-x64-direct'
    artifactId: string
    layoutPolicy: ComponentCandidatePreparationLayoutPolicy
  }
  operations: readonly ComponentCandidatePreparationOperation[]
  activation: { automatic: false; nextAction: 'component-update-activation-preview' }
}

export type ComponentCandidatePreparationPlan =
  | AvailableComponentCandidatePreparationPlan | ComponentCandidatePreparationUnavailable

export interface ComponentReleaseManifestFile {
  relativePath: string
  sizeBytes: number
  sha256: string
}

export interface ComponentReleaseManifest {
  format: 'dyson-control-component-release'
  schemaVersion: 1
  component: ManagedUpdateComponent
  version: string
  artifactId: string
  layoutPolicy?: BepInExWindowsX64LayoutPolicyId
  files: ComponentReleaseManifestFile[]
}

export interface StagedArtifactManifest {
  format: 'dyson-control-staged-artifact'
  schemaVersion: 1
  artifactId: string
  artifactFile: 'artifact.bin'
  release: {
    kind: 'nebula' | 'bepinex' | 'plugin'
    sourceId: string
    version: string
  }
  sizeBytes: number
  sha256: string
  integrity: 'provider-verified' | 'locally-computed'
  stagedAt: string
  componentManifest?: ComponentReleaseManifest
}

export interface ComponentCandidatePreparationReceipt {
  format: 'dyson-control-component-preparation-receipt'
  schemaVersion: 1
  requestId: string
  component: SupportedComponentCandidatePreparationComponent
  acquisitionReceiptId: string
  source: AvailableComponentCandidatePreparationPlan['source']
  prepared: AvailableComponentCandidatePreparationPlan['prepared'] & {
    sizeBytes: number
    sha256: string
    integrity: 'provider-verified' | 'locally-computed' | 'normalized-locally-computed'
  }
  staging: { created: boolean; manifest: StagedArtifactManifest }
  state: 'staged'
  reused: boolean
  preparedAt: string
}

export type ComponentCandidatePreparationExecutionResult =
  | ComponentCandidatePreparationReceipt | ComponentCandidatePreparationUnavailable

export interface StagedModPackageManifest {
  format: 'dyson-control-staged-mod-package'
  schemaVersion: 1
  dependencyId: string
  sourceId: string
  version: string
  dependencies: string[]
  files: Array<{ relativePath: string; sizeBytes: number; sha256: string }>
}

export interface ThunderstoreModImportPlan {
  format: 'dyson-control-thunderstore-mod-import-plan'
  schemaVersion: 1
  dryRun: true
  acquisitionReceiptId: string
  artifact: { artifactId: string; sizeBytes: number; sha256: string }
  package: {
    dependencyId: string
    sourceId: string
    version: string
    dependencies: string[]
  }
  payload: { sha256: string; fileCount: number; sizeBytes: number }
  operations: [
    'load-validated-acquisition-receipt',
    'verify-fixed-inbox-artifact',
    'validate-thunderstore-root-manifest-and-exact-dependencies',
    'apply-bepinex-plugin-only-install-rules',
    'compute-canonical-payload-digest',
    'atomically-publish-mod-staging-package'
  ]
  deployment: { automatic: false; nextAction: 'mod-deployment-preview' }
}

export interface ThunderstoreModImportReceipt {
  format: 'dyson-control-thunderstore-mod-import-receipt'
  schemaVersion: 1
  requestId: string
  acquisitionReceiptId: string
  artifact: ThunderstoreModImportPlan['artifact']
  package: ThunderstoreModImportPlan['package']
  payload: ThunderstoreModImportPlan['payload'] & { manifest: StagedModPackageManifest }
  staging: { created: boolean }
  state: 'staged'
  reused: boolean
  importedAt: string
}

export type UpdateActivationComponent = 'dsp' | ManagedUpdateComponent
export type ManagedUpdateComponent = 'nebula' | 'bepinex' | 'bridge' | 'control'

export interface UpdateRuntimeInventory {
  dsp: string
  nebula: string
  bepInEx: string
  plugins: Array<{ sourceId: string; version: string }>
}

export interface UpdateCompatibilityStatus {
  format: 'dyson-control-trusted-compatibility-status'
  schemaVersion: 1
  available: boolean
  policyId: string | null
  policyRevision: string | null
  policyReviewedAt: string | null
  inventoryRevision: string
  inventory: UpdateRuntimeInventory
}

export interface UpdateCompatibilityPreparationRequest {
  requestId: string
  component: ManagedUpdateComponent
  artifactId: string
  sha256: string
  targetVersion: string
  expectedInventoryRevision: string
  expectedPolicyRevision: string
}

export interface UpdateCompatibilityReceipt {
  format: 'dyson-control-trusted-compatibility-receipt'
  schemaVersion: 1
  receiptId: string
  component: ManagedUpdateComponent
  artifactId: string
  artifactSha256: string
  targetVersion: string
  inventoryRevision: string
  policyId: string
  policyRevision: string
  matchedEntryId: string | null
  compatible: boolean
  issuedAt: string
  expiresAt: string
  reused: boolean
}

/**
 * Logical activation request only. The browser never chooses a host path,
 * download URL, executable, command, credential, or archive payload.
 */
export interface UpdateActivationRequest {
  requestId: string
  component: UpdateActivationComponent
  artifactId?: string | null
  sha256?: string | null
  targetVersion: string
  expectedRevision: string
  compatibilityReceiptId?: string
}

export type UpdateActivationConfirmation =
  | 'ACTIVATE_DSP_UPDATE'
  | 'ACTIVATE_NEBULA_UPDATE'
  | 'ACTIVATE_BEPINEX_UPDATE'
  | 'ACTIVATE_BRIDGE_UPDATE'
  | 'ACTIVATE_CONTROL_UPDATE'

export interface ActiveUpdateComponent {
  component: ManagedUpdateComponent
  version: string
  artifactId: string
  releaseId: string
}

export interface UpdateActivationState {
  revision: string
  recoveryRequired: boolean
  components: ActiveUpdateComponent[]
  historyEntries: number
}

export type UpdateCompatibilityReasonCode =
  | 'dsp-version-mismatch' | 'nebula-version-mismatch' | 'bepinex-version-mismatch'
  | 'plugin-missing' | 'plugin-version-mismatch'

export interface UpdateCompatibilityDecision {
  compatible: boolean
  matchedEntryId: string | null
  inventory: UpdateRuntimeInventory
  evaluations: Array<{
    entryId: string
    compatible: boolean
    reasons: Array<{
      code: UpdateCompatibilityReasonCode
      component: 'dsp' | 'nebula' | 'bepinex' | 'plugin'
      sourceId: string | null
      expected: string
      actual: string | null
    }>
  }>
}

export type UpdateActivationOperation =
  | 'acquire-global-update-lock'
  | 'verify-staged-artifact-and-archive'
  | 'assemble-immutable-release'
  | 'prove-process-stopped-and-port-closed'
  | 'create-paired-save-protection-point'
  | 'revalidate-stop-revision-and-compatibility'
  | 'atomically-switch-active-manifest'
  | 'publish-and-verify-fixed-live-component'
  | 'run-fixed-health-check'
  | 'rollback-and-verify-on-failure'
  | 'persist-audit-safe-receipt'
  | 'release-global-update-lock'

export interface UpdateActivationPlan {
  format: 'dyson-control-component-update-plan'
  schemaVersion: 1
  dryRun: true
  requestId: string
  component: ManagedUpdateComponent
  artifactId: string
  targetVersion: string
  expectedRevision: string
  compatibilityReceiptId: string
  releaseId: string
  fileCount: number
  expandedBytes: number
  compatibility: UpdateCompatibilityDecision
  operations: UpdateActivationOperation[]
  rollback: {
    automatic: true
    previousReleaseRequired: boolean
    recoveryRequiredIfUnproven: true
  }
}

export type UpdateActivationReceiptStatus = 'succeeded' | 'failed' | 'rolled-back' | 'rollback-failed'

export interface UpdateActivationReceipt {
  format: 'dyson-control-component-update-receipt'
  schemaVersion: 1
  requestId: string
  component: ManagedUpdateComponent
  artifactId: string
  compatibilityReceiptId: string
  targetVersion: string
  releaseId: string
  status: UpdateActivationReceiptStatus
  previousRevision: string
  resultingRevision: string
  protectionBackupId: string | null
  failureCode: string | null
  rollbackVerified: boolean
  recoveryRequired: boolean
  fileCount: number
  expandedBytes: number
  completedAt: string
  reused: boolean
}

export interface UpdateCleanupPlan {
  format: 'dyson-control-component-update-cleanup-plan'
  schemaVersion: 1
  dryRun: true
  executeSupported: false
  candidates: Array<{
    kind: 'history' | 'release'
    opaqueId: string
    recoverable: true
    reason: 'history-retention-exceeded' | 'unreferenced-release'
  }>
}

export type ModDeploymentOperation = 'install' | 'update' | 'enable' | 'disable' | 'remove'
export type ModClientRequirement = 'required' | 'optional' | 'not-required'

export interface ModServerLockEntry {
  dependencyId: string
  sourceId: string
  version: string
  sha256: string
  dependencies: string[]
  loadOrder: number
  root: boolean
  serverRequired: boolean
  clientRequirement: ModClientRequirement
}

export interface ModPlatformLockRequirement {
  dependencyId: string
  sourceId: string
  deploymentOwner: 'nebula' | 'bepinex'
  requiredVersion: string
}

export interface ModPlatformLock {
  format: 'dyson-control-mod-platform-lock'
  schemaVersion: 1
  serverLockSha256: string
  inventoryRevision: string | null
  requirements: ModPlatformLockRequirement[]
  digest: string
}

export interface VerifiedModManifestPreview {
  mode: 'dry-run'
  serverLock: {
    format: 'dyson-control-server-mod-lock'
    schemaVersion: 1
    mods: ModServerLockEntry[]
  }
  serverLockSha256: string
  clientParity: {
    format: 'dyson-control-client-parity'
    schemaVersion: 1
    serverLockSha256: string
    mods: Array<{
      sourceId: string
      version: string
      sha256: string
      serverRequired: boolean
      clientRequirement: ModClientRequirement
    }>
  }
  platformLock: ModPlatformLock
  platformRequirements: Array<{
    dependencyId: string
    sourceId: string
    deploymentOwner: 'nebula' | 'bepinex'
    requiredVersion: string
    actualVersion: string
    satisfied: true
  }>
}

export interface VerifiedModLockReceiptRequest {
  roots: string[]
  importReceiptIds: string[]
  policies: Array<{
    sourceId: string
    serverRequired: boolean
    clientRequirement: ModClientRequirement
  }>
}

export interface ModDeploymentRequest {
  requestId: string
  operation: ModDeploymentOperation
  package: { dependencyId: string; version: string }
  manifest: {
    serverLock: {
      format: 'dyson-control-server-mod-lock'
      schemaVersion: 1
      mods: ModServerLockEntry[]
    }
    clientParity: {
      format: 'dyson-control-client-parity'
      schemaVersion: 1
      serverLockSha256: string
      mods: Array<{
        sourceId: string
        version: string
        sha256: string
        serverRequired: boolean
        clientRequirement: ModClientRequirement
      }>
    }
    platformLock: ModPlatformLock
  }
  expectedRevision: string
}

export interface ModDeploymentStatePackage {
  dependencyId: string
  sourceId: string
  version: string
  enabled: boolean
  clientRequirement: ModClientRequirement
}

export interface ModDeploymentStateSummary {
  revision: string
  packages: ModDeploymentStatePackage[]
  enabledCount: number
  disabledCount: number
}

export interface ModDeploymentPreview {
  dryRun: true
  operation: ModDeploymentOperation
  package: { dependencyId: string; version: string }
  currentRevision: string
  nextRevision: string
  currentlyInstalled: boolean
  currentlyEnabled: boolean
  nextEnabled: boolean | null
  payloadFileCount: number
  payloadSizeBytes: number
  dependencyCount: number
  snapshotsUsed: number
  snapshotLimit: number
  stoppedStateRequiredForExecute: true
  recoverablePayloadPreserved: boolean
}

export interface ModDeploymentReceipt {
  format: 'dyson-control-mod-deployment-receipt'
  schemaVersion: 1
  requestId: string
  operation: ModDeploymentOperation
  package: { dependencyId: string; version: string }
  status: 'succeeded' | 'rolled-back' | 'rollback-failed'
  previousRevision: string
  newRevision: string | null
  rollback: 'not-needed' | 'succeeded' | 'failed'
  recoveryPointCreated: boolean
  recoverablePayloadPreserved: boolean
  payloadFileCount: number
  payloadSizeBytes: number
  errorCode: 'MOD_DEPLOYMENT_EXECUTION_FAILED' | 'MOD_DEPLOYMENT_ROLLBACK_FAILED' | null
  reused: boolean
}

export interface ModDeploymentRecoveryPlan {
  dryRun: true
  irreversible: true
  executeSupported: false
  candidates: Array<{
    id: string
    kind: 'snapshot' | 'failed-publication' | 'abandoned-pending'
  }>
}

export interface ClientProfileModEntry {
  sourceId: string
  version: string
  sha256: string
  requirement: 'required' | 'optional'
}

export interface GeneratedClientProfile {
  format: 'dyson-control-client-profile-artifact-set'
  schemaVersion: 1
  profile: {
    format: 'dyson-control-client-profile'
    schemaVersion: 1
    profileId: string
    displayName: string
    connection: {
      protocol: 'nebula'
      transport: 'direct'
      host: string
      port: number
      displayAddress: string
    }
    runtime: {
      dsp: string
      nebula: string
      bepInEx: string
      compatibilityEntryId: string
    }
    provenance: { serverLockSha256: string; clientParitySha256: string }
    mods: { required: ClientProfileModEntry[]; optional: ClientProfileModEntry[] }
  }
  clientModLock: {
    format: 'dyson-control-client-mod-lock'
    schemaVersion: 1
    serverLockSha256: string
    clientParitySha256: string
    mods: ClientProfileModEntry[]
  }
  parityReport: {
    format: 'dyson-control-client-parity-report'
    schemaVersion: 1
    validManifestPair: true
    runtimeCompatible: boolean
    canGenerate: boolean
    matchedCompatibilityEntryId: string | null
    serverLockSha256: string
    clientParitySha256: string
    counts: { server: number; required: number; optional: number; notRequired: number }
    required: Array<{ sourceId: string; version: string; sha256: string }>
    optional: Array<{ sourceId: string; version: string; sha256: string }>
    notRequired: Array<{ sourceId: string; version: string; reason: 'server-only' }>
    blockers: Array<{
      code: string
      compatibilityEntryId: string | null
      sourceId: string | null
      expected: string | null
      actual: string | null
    }>
    omittedBlockerCount: number
  }
  verificationChecklist: {
    format: 'dyson-control-client-verification-checklist'
    schemaVersion: 1
    serverLockSha256: string
    checks: Array<{
      id: string
      category: 'runtime' | 'mod'
      requirement: 'required' | 'optional'
      sourceId: string | null
      expectedVersion: string
      sha256: string | null
    }>
    excluded: Array<{
      sourceId: string
      version: string
      requirement: 'not-required'
      reason: 'server-only'
    }>
  }
  artifacts: Array<{
    entryName: string
    mediaType: 'application/json' | 'text/markdown' | 'text/plain'
    encoding: 'utf8'
    sizeBytes: number
    sha256: string
    content: string
  }>
  artifactSetSha256: string
  totalSizeBytes: number
}

export interface ClientProfileArchiveDownload {
  blob: Blob
  fileName: string
  sha256: string
  sizeBytes: number
}

export type ObservabilityUnavailableReason =
  | 'not-provided' | 'source-reported-unavailable' | 'dependency-unavailable' | 'process-not-running'
export type ObservabilityMetric<T> =
  | { status: 'available'; value: T }
  | { status: 'unavailable'; reason: ObservabilityUnavailableReason }
export type ObservabilityHealthStatus = 'healthy' | 'unknown' | 'warning' | 'critical'
export type ObservabilityHintSeverity = 'info' | 'warning' | 'critical'
export type ObservabilityHintCode =
  | 'HOST_CPU_PRESSURE' | 'HOST_CPU_SATURATED' | 'SINGLE_CORE_SATURATION'
  | 'MEMORY_PRESSURE' | 'MEMORY_EXHAUSTION'
  | 'PROJECT_VOLUME_PRESSURE' | 'PROJECT_VOLUME_EXHAUSTION'
  | 'SAVE_VOLUME_PRESSURE' | 'SAVE_VOLUME_EXHAUSTION'
  | 'NETWORK_TELEMETRY_UNAVAILABLE' | 'PROCESS_CPU_PRESSURE'
  | 'PROCESS_MEMORY_DOMINANT' | 'GAME_PORT_NOT_LISTENING'
  | 'UNEXPECTED_GAME_PORT_LISTENER' | 'RUNTIME_PROCESS_STATE_MISMATCH'
  | 'SIMULATION_BELOW_TARGET' | 'SIMULATION_TELEMETRY_UNAVAILABLE'
  | 'RUNTIME_STATE_UNKNOWN' | 'OBSERVABILITY_INCOMPLETE'

export interface ServerObservabilitySnapshot {
  schemaVersion: 1
  kind: 'server-observability-snapshot'
  observedAt: string
  source: string
  runtime: {
    state: ServerStatus['state']
    processId: ObservabilityMetric<number>
    gamePort: {
      port: ObservabilityMetric<number>
      listening: ObservabilityMetric<boolean>
    }
  }
  host: {
    cpu: {
      logicalProcessorCount: ObservabilityMetric<number>
      totalPercent: ObservabilityMetric<number>
      perCorePercent: ObservabilityMetric<Array<{ index: number; percent: number }>>
    }
    memory: {
      totalBytes: ObservabilityMetric<number>
      availableBytes: ObservabilityMetric<number>
      usedBytes: ObservabilityMetric<number>
      usedPercent: ObservabilityMetric<number>
    }
  }
  process: {
    cpuPercent: ObservabilityMetric<number>
    cpuCoresUsed: ObservabilityMetric<number>
    workingSetBytes: ObservabilityMetric<number>
    privateBytes: ObservabilityMetric<number>
    threadCount: ObservabilityMetric<number>
  }
  simulation: {
    ups: ObservabilityMetric<number>
    tps: ObservabilityMetric<number>
    targetUps: ObservabilityMetric<number>
  }
  health: {
    status: ObservabilityHealthStatus
    hints: Array<{
      code: ObservabilityHintCode
      severity: ObservabilityHintSeverity
      message: string
      relatedMetrics: string[]
    }>
    unavailableMetrics: string[]
  }
}

export interface ObservabilityAlertSeverityHistoryEntry {
  severity: ObservabilityHintSeverity
  changedAt: string
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
  acknowledgement: { actor: string; acknowledgedAt: string } | null
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

export interface ObservabilityAlertEnvelope {
  data: ObservabilityAlertProjection
  meta: { recoveryRequired: boolean }
}

export type NumericMetricAggregate =
  | {
      status: 'available'
      observedSamples: number
      unavailableSamples: number
      minimum: number
      maximum: number
      average: number
      last: number
    }
  | { status: 'unavailable'; observedSamples: 0; unavailableSamples: number }

export interface ObservabilityDownsamplePoint {
  schemaVersion: 1
  kind: 'server-observability-downsample-point'
  from: string
  to: string
  sampleCount: number
  metrics: {
    hostCpuPercent: NumericMetricAggregate
    hottestCorePercent: NumericMetricAggregate
    memoryUsedPercent: NumericMetricAggregate
    availableMemoryBytes: NumericMetricAggregate
    processCpuPercent: NumericMetricAggregate
    processCpuCoresUsed: NumericMetricAggregate
    processWorkingSetBytes: NumericMetricAggregate
    processPrivateBytes: NumericMetricAggregate
    ups: NumericMetricAggregate
    tps: NumericMetricAggregate
  }
  runtime: {
    lastState: ServerStatus['state']
    stateTransitions: number
    lastGamePortListening: ObservabilityMetric<boolean>
  }
  health: {
    worstStatus: ObservabilityHealthStatus
    hintCodes: ObservabilityHintCode[]
  }
}

export interface ObservabilityDownsampleResult {
  schemaVersion: 1
  kind: 'server-observability-downsample'
  retainedSamples: number
  droppedSamples: number
  points: ObservabilityDownsamplePoint[]
}

export type QualificationStatus = 'pass' | 'fail' | 'insufficient'
export type QualificationCheckId =
  | 'window.samples' | 'window.duration'
  | 'runtime.running-coverage' | 'health.critical-ratio'
  | 'simulation.ups-coverage' | 'simulation.ups-floor'
  | 'host.cpu-coverage' | 'host.cpu-p95'
  | 'host.per-core-coverage' | 'host.hottest-core-saturation'
  | 'process.multicore-coverage' | 'process.single-core-bottleneck'
  | 'host.memory-coverage' | 'host.memory-peak'
  | 'storage.project-coverage' | 'storage.project-peak-used' | 'storage.project-minimum-free'
  | 'storage.save-coverage' | 'storage.save-peak-used' | 'storage.save-minimum-free'

export type QualificationRemainingEvidence =
  | 'SAVE_LATENCY_DRILL_REQUIRED'
  | 'REBOOT_RECOVERY_DRILL_REQUIRED'
  | 'CRASH_RECOVERY_DRILL_REQUIRED'
  | 'EXTERNAL_JOIN_SOAK_REQUIRED'

export interface QualificationCheck {
  id: QualificationCheckId
  status: QualificationStatus
  message: string
  observed: Record<string, number | string | null>
  required: Record<string, number | string>
}

export interface LateGameQualificationReport {
  schemaVersion: 1
  kind: 'dyson-late-game-qualification-report'
  profileId: 'late-game-6h-v1'
  result: QualificationStatus
  generatedAt: string
  from: string | null
  to: string | null
  sampleCount: number
  spanMs: number
  checks: QualificationCheck[]
  remainingEvidence: [
    'SAVE_LATENCY_DRILL_REQUIRED',
    'REBOOT_RECOVERY_DRILL_REQUIRED',
    'CRASH_RECOVERY_DRILL_REQUIRED',
    'EXTERNAL_JOIN_SOAK_REQUIRED'
  ]
}

export interface ObservabilityQualificationEnvelope {
  data: LateGameQualificationReport
  meta: {
    provider: 'demo' | 'windows'
    environment: 'development' | 'test' | 'production'
    capacity: number
  }
}

export type NavKey =
  | 'overview' | 'game' | 'console' | 'players' | 'versions' | 'mods'
  | 'saves' | 'client' | 'server' | 'config' | 'tasks'

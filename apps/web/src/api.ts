import type {
  BackupCatalogItem, CatalogPage, GameConfigPreview, GameConfigSnapshot, GameConfigTransactionResult,
  GameConfigHistoryDiff, GameConfigHistoryRecoveryResult, GameConfigHistoryRestoreReceipt,
  GameConfigHistorySnapshotDetail, GameConfigHistorySnapshotSummary,
  ClientProfileArchiveDownload, GeneratedClientProfile,
  ConsoleCommandName, ConsoleCommandPreview, JobRecord, LifecycleAction, LifecycleExecutionResult,
  ArtifactAcquisitionPlan, ArtifactAcquisitionReceipt, BepInExDiscoveryEnvelope,
  ComponentCandidatePreparationExecutionResult, ComponentCandidatePreparationPlan,
  ComponentCandidatePreparationReceipt, LifecyclePreview, NebulaDiscoveryEnvelope,
  SupportedComponentCandidatePreparationComponent,
  ThunderstoreDependencyClosureEnvelope, ThunderstoreDiscoveryEnvelope,
  ThunderstoreModImportPlan, ThunderstoreModImportReceipt, VerifiedModLockReceiptRequest,
  VerifiedModManifestPreview,
  PlayerCapabilitiesProjection, PlayerRoster, SessionUser,
  ModDeploymentPreview, ModDeploymentReceipt, ModDeploymentRecoveryDesired,
  ModDeploymentRecoveryPlan, ModDeploymentRecoveryStatus, ModDeploymentRequest,
  ModDeploymentStateSummary,
  LateGameQualificationReport, ObservabilityDownsampleResult, ObservabilityQualificationEnvelope,
  ObservabilityAlertEnvelope, ObservabilityAlertEpisode,
  QualificationCheck, QualificationCheckId, QualificationStatus, ServerObservabilitySnapshot,
  BackupAnnotation, BackupAnnotationReceipt, BackupRetentionPolicy, BackupRetentionPreview,
  BackupRetirementReceipt, BackupRetirementRestoreReceipt,
  BackupRetentionPurgePreview, BackupRetentionPurgeReceipt,
  SaveJobExecutionResult, SavePairCatalogItem, SavePairExportReceipt, SavePairImportReceipt,
  SavePairRevision, SavePairTransferDownload, SaveTransactionResult, ServerStatus,
  StructuredLogFilters, StructuredLogPage, StructuredLogReadRequest,
  UpdateActivationConfirmation, UpdateActivationPlan, UpdateActivationReceipt,
  UpdateActivationRecoveryConfirmation, UpdateActivationRecoveryStatus,
  UpdateActivationRequest, UpdateActivationState, UpdateCleanupPlan,
  UpdateCompatibilityPreparationRequest, UpdateCompatibilityReceipt, UpdateCompatibilityStatus
} from './model'
import {
  isGameConfigHistorySnapshotId,
  isGameConfigRevision,
  parseGameConfigHistoryDetail,
  parseGameConfigHistoryDiff,
  parseGameConfigHistoryList,
  parseGameConfigHistoryRecoveryResults,
  parseGameConfigHistoryRestoreReceipt
} from './game-config-history-contract'

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code: string | null = null) { super(message) }
}

export class GameConfigHistoryApiError extends ApiError {
  constructor(
    status: number,
    message: string,
    code: string | null,
    readonly data: GameConfigHistoryRestoreReceipt | GameConfigHistoryRecoveryResult[] | null = null
  ) {
    super(status, message, code)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (init?.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null
    throw new ApiError(response.status, body?.error?.message ?? `HTTP ${response.status}`, body?.error?.code ?? null)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export const api = {
  session: () => request<{ user: SessionUser }>('/api/v1/auth/session'),
  login: (role: SessionUser['role'], password: string) => request<{ user: SessionUser }>('/api/v1/auth/login', {
    method: 'POST', body: JSON.stringify({ role, password })
  }),
  logout: () => request<void>('/api/v1/auth/logout', { method: 'POST' }),
  status: () => request<{
    data: ServerStatus
    meta: { provider: 'demo' | 'windows'; environment: 'development' | 'test' | 'production' }
  }>('/api/v1/status'),
  observabilitySnapshot: (signal?: AbortSignal) => request<{
    data: ServerObservabilitySnapshot
    meta: {
      provider: 'demo' | 'windows'
      environment: 'development' | 'test' | 'production'
      retainedSamples: number
      capacity: number
    }
  }>('/api/v1/observability/snapshot', { signal }),
  observabilityHistory: (points = 48, signal?: AbortSignal) => request<{
    data: ObservabilityDownsampleResult
    meta: {
      provider: 'demo' | 'windows'
      environment: 'development' | 'test' | 'production'
      capacity: number
    }
  }>(`/api/v1/observability/history?points=${encodeURIComponent(String(points))}`, { signal }),
  observabilityQualification: (signal?: AbortSignal) => observabilityQualification(signal),
  observabilityAlerts: (signal?: AbortSignal) => request<ObservabilityAlertEnvelope>(
    '/api/v1/observability/alerts', { signal, cache: 'no-store' }
  ),
  acknowledgeObservabilityAlert: (episodeId: string, signal?: AbortSignal) => request<{
    data: ObservabilityAlertEpisode
  }>(`/api/v1/observability/alerts/${encodeURIComponent(episodeId)}/acknowledge`, {
    method: 'POST', signal, body: JSON.stringify({ confirmation: 'ACKNOWLEDGE_ALERT' })
  }),
  jobs: () => request<{ data: JobRecord[] }>('/api/v1/jobs'),
  refresh: () => request<{ data: JobRecord }>('/api/v1/actions/refresh', { method: 'POST' }),
  previewLifecycle: (action: LifecycleAction) => request<{
    data: { job: JobRecord; preview: LifecyclePreview }
  }>('/api/v1/actions/lifecycle/preview', {
    method: 'POST', body: JSON.stringify({ action })
  }),
  executeLifecycle: (action: LifecycleAction, idempotencyKey: string) => request<{
    data: LifecycleExecutionResult
  }>('/api/v1/actions/lifecycle/execute', {
    method: 'POST', body: JSON.stringify({ action, idempotencyKey, confirmation: 'EXECUTE' })
  }),
  lifecycle: (id: string) => request<{ data: LifecycleExecutionResult }>(`/api/v1/lifecycle/${id}`),
  players: (signal?: AbortSignal) => request<{ data: PlayerRoster }>('/api/v1/players', { signal }),
  playerCapabilities: (signal?: AbortSignal) => request<{ data: PlayerCapabilitiesProjection }>(
    '/api/v1/players/capabilities', { signal }
  ),
  discoverNebula: (signal?: AbortSignal) => request<NebulaDiscoveryEnvelope>('/api/v1/updates/discovery/nebula', {
    method: 'POST', signal, body: JSON.stringify({})
  }),
  discoverBepInEx: (signal?: AbortSignal) => request<BepInExDiscoveryEnvelope>(
    '/api/v1/updates/discovery/bepinex', {
      method: 'POST', signal, body: JSON.stringify({})
    }
  ),
  discoverThunderstore: (namespace: string, name: string, signal?: AbortSignal) =>
    request<ThunderstoreDiscoveryEnvelope>('/api/v1/updates/discovery/thunderstore', {
      method: 'POST', signal, body: JSON.stringify({ namespace, name })
    }),
  discoverThunderstoreDependencies: (roots: string[], signal?: AbortSignal) =>
    request<ThunderstoreDependencyClosureEnvelope>(
      '/api/v1/updates/discovery/thunderstore/dependencies', {
        method: 'POST', signal, body: JSON.stringify({ roots })
      }
    ),
  previewArtifactAcquisition: (candidateId: string, signal?: AbortSignal) =>
    acquisitionRequest<ArtifactAcquisitionPlan>('/api/v1/updates/acquisition/preview', {
      method: 'POST', signal, body: JSON.stringify({ candidateId })
    }),
  executeArtifactAcquisition: (
    requestId: string,
    candidateId: string,
    signal?: AbortSignal
  ) => acquisitionRequest<ArtifactAcquisitionReceipt>('/api/v1/updates/acquisition/execute', {
    method: 'POST', signal,
    body: JSON.stringify({ requestId, candidateId, confirmation: 'ACQUIRE_UPDATE_ARTIFACT' })
  }),
  artifactAcquisitionReceipt: (requestId: string, signal?: AbortSignal) =>
    acquisitionRequest<ArtifactAcquisitionReceipt>(
      `/api/v1/updates/acquisition/receipts/${encodeURIComponent(requestId)}`, { signal }
    ),
  previewComponentCandidatePreparation: (
    component: SupportedComponentCandidatePreparationComponent,
    acquisitionReceiptId: string,
    signal?: AbortSignal
  ) => componentCandidatePreparationRequest<ComponentCandidatePreparationPlan>(
    '/api/v1/updates/preparation/component/preview', {
      method: 'POST', signal, body: JSON.stringify({ component, acquisitionReceiptId })
    }
  ),
  executeComponentCandidatePreparation: (
    requestId: string,
    component: SupportedComponentCandidatePreparationComponent,
    acquisitionReceiptId: string,
    signal?: AbortSignal
  ) => componentCandidatePreparationRequest<ComponentCandidatePreparationExecutionResult>(
    '/api/v1/updates/preparation/component/execute', {
      method: 'POST', signal,
      body: JSON.stringify({
        requestId,
        component,
        acquisitionReceiptId,
        confirmation: 'PREPARE_COMPONENT_CANDIDATE'
      })
    }
  ),
  componentCandidatePreparationReceipt: (requestId: string, signal?: AbortSignal) =>
    componentCandidatePreparationRequest<ComponentCandidatePreparationReceipt>(
      `/api/v1/updates/preparation/component/receipts/${encodeURIComponent(requestId)}`,
      { signal }
    ),
  previewThunderstoreModImport: (acquisitionReceiptId: string, signal?: AbortSignal) =>
    thunderstoreModImportRequest<ThunderstoreModImportPlan>('/api/v1/mods/import/preview', {
      method: 'POST', signal, body: JSON.stringify({ acquisitionReceiptId })
    }),
  executeThunderstoreModImport: (
    requestId: string,
    acquisitionReceiptId: string,
    signal?: AbortSignal
  ) => thunderstoreModImportRequest<ThunderstoreModImportReceipt>('/api/v1/mods/import/execute', {
    method: 'POST', signal,
    body: JSON.stringify({ requestId, acquisitionReceiptId, confirmation: 'IMPORT_THUNDERSTORE_MOD' })
  }),
  thunderstoreModImportReceipt: (requestId: string, signal?: AbortSignal) =>
    thunderstoreModImportRequest<ThunderstoreModImportReceipt>(
      `/api/v1/mods/import/receipts/${encodeURIComponent(requestId)}`, { signal }
    ),
  previewVerifiedModLock: (input: VerifiedModLockReceiptRequest, signal?: AbortSignal) => request<{
    data: VerifiedModManifestPreview
  }>('/api/v1/mods/verified-lock/preview', {
    method: 'POST', signal, body: JSON.stringify(input)
  }),
  updateCompatibilityStatus: (signal?: AbortSignal) => trustedCompatibilityStatus(signal),
  prepareUpdateCompatibility: (input: UpdateCompatibilityPreparationRequest, signal?: AbortSignal) =>
    prepareTrustedCompatibility(input, signal),
  updateCompatibilityReceipt: (receiptId: string, signal?: AbortSignal) =>
    readTrustedCompatibilityReceipt(receiptId, signal),
  updateActivationState: (signal?: AbortSignal) => activationRequest<UpdateActivationState>(
    '/api/v1/updates/activation/state', { signal }
  ),
  updateActivationRecoveryStatus: (signal?: AbortSignal) => activationRequest<UpdateActivationRecoveryStatus>(
    '/api/v1/updates/activation/recovery', { signal }
  ),
  updateActivationCleanupPreview: (signal?: AbortSignal) => activationRequest<UpdateCleanupPlan>(
    '/api/v1/updates/activation/cleanup/preview', { signal }
  ),
  previewUpdateActivation: (input: UpdateActivationRequest, signal?: AbortSignal) =>
    activationRequest<UpdateActivationPlan>('/api/v1/updates/activation/preview', {
      method: 'POST', signal, body: JSON.stringify(input)
    }),
  executeUpdateActivation: (
    input: UpdateActivationRequest,
    confirmation: UpdateActivationConfirmation,
    signal?: AbortSignal
  ) => activationRequest<UpdateActivationReceipt>('/api/v1/updates/activation/execute', {
    method: 'POST', signal, body: JSON.stringify({ ...input, confirmation })
  }),
  recoverUpdateActivation: (
    requestId: string,
    confirmation: UpdateActivationRecoveryConfirmation,
    signal?: AbortSignal
  ) => activationRequest<UpdateActivationReceipt>('/api/v1/updates/activation/recovery', {
    method: 'POST', signal, body: JSON.stringify({ requestId, confirmation })
  }),
  updateActivationReceipt: (requestId: string, signal?: AbortSignal) =>
    activationRequest<UpdateActivationReceipt>(
      `/api/v1/updates/activation/receipts/${encodeURIComponent(requestId)}`, { signal }
    ),
  modDeploymentState: (signal?: AbortSignal) => request<{
    data: ModDeploymentStateSummary
    meta: { executionEnabled: boolean }
  }>('/api/v1/mods/deployment/state', { signal }),
  modDeploymentRecovery: (signal?: AbortSignal) => request<{
    data: ModDeploymentRecoveryPlan
  }>('/api/v1/mods/deployment/recovery', { signal }),
  modDeploymentRecoveryStatus: (signal?: AbortSignal) => readModDeploymentRecoveryStatus(signal),
  recoverModDeployment: (
    requestId: string,
    desired: ModDeploymentRecoveryDesired,
    signal?: AbortSignal
  ) => request<{ data: ModDeploymentReceipt }>('/api/v1/mods/deployment/recovery/execute', {
    method: 'POST', signal, body: JSON.stringify({
      requestId,
      desired,
      confirmation: 'RECOVER_MOD_DEPLOYMENT'
    })
  }),
  previewModDeployment: (input: ModDeploymentRequest) => request<{
    data: ModDeploymentPreview
    meta: { executionEnabled: boolean }
  }>('/api/v1/mods/deployment/preview', {
    method: 'POST', body: JSON.stringify(input)
  }),
  executeModDeployment: (input: ModDeploymentRequest) => request<{
    data: ModDeploymentReceipt
  }>('/api/v1/mods/deployment/execute', {
    method: 'POST',
    body: JSON.stringify({
      request: input,
      confirmation: {
        action: 'EXECUTE_MOD_DEPLOYMENT',
        requestId: input.requestId,
        operation: input.operation,
        dependencyId: input.package.dependencyId,
        version: input.package.version,
        expectedRevision: input.expectedRevision
      }
    })
  }),
  generateClientProfile: (input: unknown) => request<{ data: GeneratedClientProfile }>(
    '/api/v1/client-profile/generate', { method: 'POST', body: JSON.stringify(input) }
  ),
  downloadClientProfileArchive: (input: unknown) => downloadClientProfileArchive(input),
  saves: (cursor?: string) => request<{ data: CatalogPage<SavePairCatalogItem> }>(
    `/api/v1/saves?pageSize=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
  ),
  backups: (cursor?: string) => request<{ data: CatalogPage<BackupCatalogItem> }>(
    `/api/v1/backups?pageSize=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
  ),
  verifyBackup: (backupId: string) => request<{ data: BackupCatalogItem }>(
    `/api/v1/backups/${encodeURIComponent(backupId)}/verify`
  ),
  backupAnnotations: (signal?: AbortSignal) => request<{ data: BackupAnnotation[] }>(
    '/api/v1/backups/retention/annotations', { signal, cache: 'no-store' }
  ),
  setBackupAnnotation: (input: {
    requestId: string
    backupId: string
    expectedRevision: number | null
    note: string | null
    protected: boolean
  }, signal?: AbortSignal) => request<{
    data: { receipt: BackupAnnotationReceipt; reused: boolean }
  }>('/api/v1/backups/retention/annotations', {
    method: 'POST',
    signal,
    body: JSON.stringify({ ...input, confirmation: 'UPDATE_BACKUP_ANNOTATION' })
  }),
  previewBackupRetention: (
    referenceTime: string,
    policy: BackupRetentionPolicy,
    signal?: AbortSignal
  ) => request<{ data: BackupRetentionPreview; meta: { executionEnabled: boolean } }>(
    '/api/v1/backups/retention/preview', {
      method: 'POST', signal, body: JSON.stringify({ referenceTime, policy })
    }
  ),
  executeBackupRetention: (input: {
    requestId: string
    previewDigest: string
    referenceTime: string
    policy: BackupRetentionPolicy
  }, signal?: AbortSignal) => request<{
    data: { receipt: BackupRetirementReceipt; reused: boolean }
  }>('/api/v1/backups/retention/execute', {
    method: 'POST', signal, body: JSON.stringify({ ...input, confirmation: 'RETIRE_BACKUPS' })
  }),
  restoreRetiredBackups: (
    requestId: string,
    retirementRequestId: string,
    signal?: AbortSignal
  ) => request<{
    data: { receipt: BackupRetirementRestoreReceipt; reused: boolean }
  }>('/api/v1/backups/retention/restore', {
    method: 'POST', signal,
    body: JSON.stringify({ requestId, retirementRequestId, confirmation: 'RESTORE_RETIRED_BACKUPS' })
  }),
  previewRetiredBackupPurge: (retirementRequestId: string, signal?: AbortSignal) => request<{
    data: BackupRetentionPurgePreview; meta: { executionEnabled: boolean }
  }>('/api/v1/backups/retention/purge/preview', {
    method: 'POST', signal, body: JSON.stringify({ retirementRequestId })
  }),
  purgeRetiredBackups: (input: {
    requestId: string
    retirementRequestId: string
    purgePreviewDigest: string
  }, signal?: AbortSignal) => request<{
    data: { receipt: BackupRetentionPurgeReceipt; reused: boolean }
  }>('/api/v1/backups/retention/purge/execute', {
    method: 'POST', signal, body: JSON.stringify({ ...input, confirmation: 'PURGE_RETIRED_BACKUPS' })
  }),
  saveRevision: (saveName: string) => request<{ data: SavePairRevision }>(
    `/api/v1/saves/${encodeURIComponent(saveName)}/revision`
  ),
  previewSaveBackup: (requestId: string, saveName: string) => request<{
    data: SaveTransactionResult; meta: { executionEnabled: boolean }
  }>('/api/v1/saves/backup/preview', {
    method: 'POST', body: JSON.stringify({ requestId, saveName })
  }),
  executeSaveBackup: (requestId: string, saveName: string) => request<{
    data: SaveJobExecutionResult
  }>('/api/v1/saves/backup/execute', {
    method: 'POST', body: JSON.stringify({ requestId, saveName, confirmation: 'CREATE_BACKUP' })
  }),
  previewSaveRestore: (input: {
    requestId: string; backupId: string; expectedRevision: string; protectionRequestId: string
  }) => request<{ data: SaveTransactionResult; meta: { executionEnabled: boolean } }>(
    '/api/v1/saves/restore/preview', { method: 'POST', body: JSON.stringify(input) }
  ),
  executeSaveRestore: (input: {
    requestId: string; backupId: string; expectedRevision: string; protectionRequestId: string
  }) => request<{ data: SaveJobExecutionResult }>(
    '/api/v1/saves/restore/execute', {
      method: 'POST', body: JSON.stringify({ ...input, confirmation: 'RESTORE_SAVE_PAIR' })
    }
  ),
  saveJob: (jobId: string) => request<{ data: SaveJobExecutionResult }>(
    `/api/v1/saves/jobs/${encodeURIComponent(jobId)}`
  ),
  prepareSavePairExport: (requestId: string, backupId: string, signal?: AbortSignal) =>
    prepareSavePairExport(requestId, backupId, signal),
  downloadSavePairExport: (
    requestId: string,
    receipt: SavePairExportReceipt,
    signal?: AbortSignal
  ) => downloadSavePairExport(requestId, receipt, signal),
  importSavePairArchive: (
    requestId: string,
    payload: ArrayBuffer,
    sha256: string,
    signal?: AbortSignal
  ) => importSavePairArchive(requestId, payload, sha256, signal),
  configuration: (signal?: AbortSignal) => request<{ data: GameConfigSnapshot }>(
    '/api/v1/configuration', { signal, cache: 'no-store' }
  ),
  previewConfiguration: (
    expectedRevision: string,
    changes: Array<{ id: string; value: boolean | number | string }>
  ) => request<{ data: GameConfigPreview }>('/api/v1/configuration/preview', {
    method: 'POST', body: JSON.stringify({ expectedRevision, changes })
  }),
  applyConfiguration: (
    expectedRevision: string,
    changes: Array<{ id: string; value: boolean | number | string }>
  ) => request<{ data: GameConfigTransactionResult }>('/api/v1/configuration/apply', {
    method: 'POST', body: JSON.stringify({ expectedRevision, changes, confirmation: 'APPLY_CONFIG' })
  }),
  gameConfigHistory: (signal?: AbortSignal) => gameConfigHistoryList(signal),
  gameConfigHistoryDetail: (snapshotId: string, signal?: AbortSignal) =>
    gameConfigHistoryDetail(snapshotId, signal),
  gameConfigHistoryDiff: (snapshotId: string, signal?: AbortSignal) =>
    gameConfigHistoryDiff(snapshotId, signal),
  gameConfigHistoryRestorePreview: (snapshotId: string, signal?: AbortSignal) =>
    gameConfigHistoryRestorePreview(snapshotId, signal),
  captureGameConfigHistory: (signal?: AbortSignal) => captureGameConfigHistory(signal),
  restoreGameConfigHistory: (
    requestId: string,
    snapshotId: string,
    expectedCurrentRevision: string,
    dryRun: boolean,
    signal?: AbortSignal
  ) => restoreGameConfigHistory(
    requestId, snapshotId, expectedCurrentRevision, dryRun, signal
  ),
  reconcileGameConfigHistory: (signal?: AbortSignal) => reconcileGameConfigHistory(signal),
  consoleLogs: (input: StructuredLogReadRequest) => request<{ data: StructuredLogPage }>(
    '/api/v1/console/logs/query', { method: 'POST', body: JSON.stringify(input) }
  ),
  previewConsoleCommand: (command: ConsoleCommandName) => request<{ data: ConsoleCommandPreview }>(
    '/api/v1/console/commands/preview', { method: 'POST', body: JSON.stringify({ command }) }
  ),
  executeConsoleCommand: (
    command: ConsoleCommandName,
    idempotencyKey: string,
    confirmation: ConsoleCommandPreview['requiredConfirmation']
  ) => request<{ data: LifecycleExecutionResult }>('/api/v1/console/commands/execute', {
    method: 'POST', body: JSON.stringify({ command, idempotencyKey, confirmation })
  }),
  downloadConsole: (filters: StructuredLogFilters) => downloadConsole(filters)
}

type GameConfigHistoryParser<T> = (value: unknown) => T | null

async function gameConfigHistoryList(signal?: AbortSignal): Promise<{
  data: GameConfigHistorySnapshotSummary[]
}> {
  return gameConfigHistoryRequest(
    '/api/v1/game-config/history', parseGameConfigHistoryList, { signal }
  )
}

async function gameConfigHistoryDetail(
  snapshotId: string,
  signal?: AbortSignal
): Promise<{ data: GameConfigHistorySnapshotDetail }> {
  assertGameConfigHistorySnapshotId(snapshotId)
  const normalizedSnapshotId = snapshotId.toLowerCase()
  return gameConfigHistoryRequest(
    `/api/v1/game-config/history/${encodeURIComponent(snapshotId)}`,
    (value) => {
      const detail = parseGameConfigHistoryDetail(value)
      return detail?.snapshotId === normalizedSnapshotId ? detail : null
    },
    { signal }
  )
}

async function gameConfigHistoryDiff(
  snapshotId: string,
  signal?: AbortSignal
): Promise<{ data: GameConfigHistoryDiff }> {
  assertGameConfigHistorySnapshotId(snapshotId)
  const normalizedSnapshotId = snapshotId.toLowerCase()
  return gameConfigHistoryRequest(
    `/api/v1/game-config/history/${encodeURIComponent(snapshotId)}/diff`,
    (value) => {
      const diff = parseGameConfigHistoryDiff(value)
      return diff?.snapshotId === normalizedSnapshotId ? diff : null
    },
    { signal }
  )
}

async function gameConfigHistoryRestorePreview(
  snapshotId: string,
  signal?: AbortSignal
): Promise<{ data: GameConfigHistoryDiff }> {
  assertGameConfigHistorySnapshotId(snapshotId)
  const normalizedSnapshotId = snapshotId.toLowerCase()
  return gameConfigHistoryRequest(
    `/api/v1/game-config/history/${encodeURIComponent(snapshotId)}/restore-preview`,
    (value) => {
      const preview = parseGameConfigHistoryDiff(value)
      return preview?.snapshotId === normalizedSnapshotId ? preview : null
    },
    { signal }
  )
}

async function captureGameConfigHistory(signal?: AbortSignal): Promise<{
  data: GameConfigHistorySnapshotDetail
}> {
  return gameConfigHistoryRequest(
    '/api/v1/game-config/history/capture',
    parseGameConfigHistoryDetail,
    {
      method: 'POST',
      signal,
      body: JSON.stringify({ confirmation: 'CREATE_CONFIG_SNAPSHOT' })
    }
  )
}

async function restoreGameConfigHistory(
  requestId: string,
  snapshotId: string,
  expectedCurrentRevision: string,
  dryRun: boolean,
  signal?: AbortSignal
): Promise<{ data: GameConfigHistoryRestoreReceipt }> {
  assertGameConfigHistorySnapshotId(requestId)
  assertGameConfigHistorySnapshotId(snapshotId)
  if (!isGameConfigRevision(expectedCurrentRevision) || typeof dryRun !== 'boolean') {
    throw gameConfigHistoryClientRequestInvalid()
  }
  const parseReceiptForRequest: GameConfigHistoryParser<GameConfigHistoryRestoreReceipt> = (value) => {
    const receipt = parseGameConfigHistoryRestoreReceipt(value)
    if (receipt === null || receipt.requestId !== requestId.toLowerCase()
        || receipt.snapshotId !== snapshotId.toLowerCase()
        || receipt.expectedCurrentRevision !== expectedCurrentRevision.toLowerCase()
        || receipt.dryRun !== dryRun
        || receipt.status !== (dryRun ? 'dry-run' : 'restored')) return null
    return receipt
  }
  const parseFailureReceiptForRequest: GameConfigHistoryParser<GameConfigHistoryRestoreReceipt> = (value) => {
    const receipt = parseGameConfigHistoryRestoreReceipt(value)
    if (receipt === null || receipt.requestId !== requestId.toLowerCase()
        || receipt.snapshotId !== snapshotId.toLowerCase()
        || receipt.expectedCurrentRevision !== expectedCurrentRevision.toLowerCase()
        || receipt.dryRun !== dryRun
        || receipt.status === 'dry-run' || receipt.status === 'restored') return null
    return receipt
  }
  return gameConfigHistoryRequest(
    '/api/v1/game-config/history/restore',
    parseReceiptForRequest,
    {
      method: 'POST',
      signal,
      body: JSON.stringify({
        requestId,
        snapshotId,
        expectedCurrentRevision,
        dryRun,
        confirmation: 'RESTORE_CONFIG_SNAPSHOT'
      })
    },
    parseFailureReceiptForRequest
  )
}

async function reconcileGameConfigHistory(signal?: AbortSignal): Promise<{
  data: GameConfigHistoryRecoveryResult[]
}> {
  return gameConfigHistoryRequest(
    '/api/v1/game-config/history/reconcile',
    parseGameConfigHistoryRecoveryResults,
    {
      method: 'POST',
      signal,
      body: JSON.stringify({ confirmation: 'RECONCILE_CONFIG_RESTORE' })
    },
    parseGameConfigHistoryRecoveryResults
  )
}

async function gameConfigHistoryRequest<T>(
  path: string,
  parseSuccess: GameConfigHistoryParser<T>,
  init: RequestInit = {},
  parseFailureData?: GameConfigHistoryParser<
    GameConfigHistoryRestoreReceipt | GameConfigHistoryRecoveryResult[]
  >
): Promise<{ data: T }> {
  const headers = new Headers(init.headers)
  if (init.body) headers.set('Content-Type', 'application/json')
  let response: Response
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...init,
      headers
    })
  } catch (error) {
    if (init.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
    throw new GameConfigHistoryApiError(
      503,
      '配置历史网络请求失败；所有写操作保持关闭。',
      'CONFIG_HISTORY_HTTP_UNAVAILABLE'
    )
  }
  const payload = await response.json().catch(() => null)
  if (response.ok) {
    if (!hasExactKeys(payload, ['ok', 'data']) || payload.ok !== true) {
      throw gameConfigHistoryResponseInvalid()
    }
    const data = parseSuccess(payload.data)
    if (data === null) throw gameConfigHistoryResponseInvalid()
    return { data }
  }

  const failure = parseGameConfigHistoryFailure(payload, parseFailureData)
  if (failure === null) throw gameConfigHistoryResponseInvalid()
  throw new GameConfigHistoryApiError(
    response.status,
    gameConfigHistoryErrorMessage(response.status, failure.code),
    failure.code,
    failure.data
  )
}

function parseGameConfigHistoryFailure(
  value: unknown,
  parseFailureData?: GameConfigHistoryParser<
    GameConfigHistoryRestoreReceipt | GameConfigHistoryRecoveryResult[]
  >
): {
  code: string
  data: GameConfigHistoryRestoreReceipt | GameConfigHistoryRecoveryResult[] | null
} | null {
  if (hasExactKeys(value, ['ok', 'error']) || hasExactKeys(value, ['ok', 'error', 'data'])) {
    if (value.ok !== false || !hasExactKeys(value.error, ['code']) || !isBoundedErrorCode(value.error.code)) {
      return null
    }
    if (!Object.hasOwn(value, 'data')) return { code: value.error.code, data: null }
    if (!parseFailureData) return null
    const data = parseFailureData(value.data)
    return data === null || !gameConfigHistoryFailureDataMatchesCode(data, value.error.code)
      ? null
      : { code: value.error.code, data }
  }

  // Authentication and same-origin pre-handlers use the application-wide
  // error envelope before the history controller is reached. Its message is
  // deliberately ignored so server text is never reflected into the UI.
  if (hasExactKeys(value, ['error'])
      && (hasExactKeys(value.error, ['code']) || hasExactKeys(value.error, ['code', 'message']))
      && isBoundedErrorCode(value.error.code)
      && (!Object.hasOwn(value.error, 'message') || typeof value.error.message === 'string')) {
    return { code: value.error.code, data: null }
  }
  return null
}

function gameConfigHistoryFailureDataMatchesCode(
  data: GameConfigHistoryRestoreReceipt | GameConfigHistoryRecoveryResult[],
  code: string
): boolean {
  if (Array.isArray(data)) {
    return data.some((result) => result.status === 'recovery-required' && result.errorCode === code)
  }
  return data.errorCode === code
}

function gameConfigHistoryErrorMessage(status: number, code: string): string {
  if (status === 401 || code === 'AUTH_REQUIRED') return '配置历史需要重新建立认证会话。'
  if (status === 403 || code === 'AUTHORIZATION_DENIED') return '当前角色没有执行该配置历史操作的服务端权限。'
  if (status === 404 || code === 'CONFIG_HISTORY_HTTP_SNAPSHOT_NOT_FOUND') {
    return code === 'NOT_FOUND'
      ? '配置历史 API 尚未接入当前服务。'
      : '所选配置快照不存在或已被受控清理。'
  }
  if (status === 409 || code === 'CONFIG_HISTORY_REVISION_CONFLICT') {
    return '当前配置 revision 已变化；必须重新读取、预演并执行 dry-run。'
  }
  if (status === 423 || code === 'CONFIG_HISTORY_HTTP_MUTATION_DISABLED') {
    return code === 'CONFIG_HISTORY_HTTP_MUTATION_DISABLED'
      ? '配置历史写入门禁保持关闭；未执行任何变更。'
      : '配置历史事务被停止态或独占锁门禁拒绝；未执行新的变更。'
  }
  if (status === 422 || status === 400) return '配置历史请求未通过固定字段或精确确认校验。'
  if (status === 503) return '配置历史服务、存储或停止态证明不可用；工作流保持 fail-closed。'
  return '配置历史请求失败；不会绕过预演、revision 或停止态门禁。'
}

function assertGameConfigHistorySnapshotId(value: string): void {
  if (typeof value !== 'string' || !isGameConfigHistorySnapshotId(value)) {
    throw gameConfigHistoryClientRequestInvalid()
  }
}

function gameConfigHistoryClientRequestInvalid(): GameConfigHistoryApiError {
  return new GameConfigHistoryApiError(
    400,
    '配置历史请求只能引用 UUIDv4 快照和 SHA-256 revision。',
    'CONFIG_HISTORY_CLIENT_REQUEST_INVALID'
  )
}

function gameConfigHistoryResponseInvalid(): GameConfigHistoryApiError {
  return new GameConfigHistoryApiError(
    502,
    '配置历史响应未通过客户端合同校验；不会展示或执行该数据。',
    'CONFIG_HISTORY_RESPONSE_INVALID'
  )
}

function isBoundedErrorCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(value)
}

type QualificationCheckMode =
  | 'evidence-minimum' | 'coverage' | 'ratio-minimum' | 'ratio-maximum'
  | 'minimum' | 'maximum'

interface QualificationCheckContract {
  mode: QualificationCheckMode
  observedKeys: readonly string[]
  required: Readonly<Record<string, number>>
}

const qualificationCheckIds = [
  'window.samples', 'window.duration',
  'runtime.running-coverage', 'health.critical-ratio',
  'simulation.ups-coverage', 'simulation.ups-floor',
  'host.cpu-coverage', 'host.cpu-p95',
  'host.per-core-coverage', 'host.hottest-core-saturation',
  'process.multicore-coverage', 'process.single-core-bottleneck',
  'host.memory-coverage', 'host.memory-peak',
  'storage.project-coverage', 'storage.project-peak-used', 'storage.project-minimum-free',
  'storage.save-coverage', 'storage.save-peak-used', 'storage.save-minimum-free'
] as const satisfies readonly QualificationCheckId[]

const qualificationCoverageCheckIds = new Set<QualificationCheckId>([
  'simulation.ups-coverage', 'host.cpu-coverage', 'host.per-core-coverage',
  'process.multicore-coverage', 'host.memory-coverage',
  'storage.project-coverage', 'storage.save-coverage'
])

const coverageContract: QualificationCheckContract = Object.freeze({
  mode: 'coverage',
  observedKeys: ['value', 'observedSamples', 'totalSamples'],
  required: { minimumRatio: 0.95 }
})

const qualificationCheckContracts: Record<QualificationCheckId, QualificationCheckContract> = {
  'window.samples': { mode: 'evidence-minimum', observedKeys: ['value'], required: { minimum: 360 } },
  'window.duration': { mode: 'evidence-minimum', observedKeys: ['value'], required: { minimum: 21_600_000 } },
  'runtime.running-coverage': { mode: 'ratio-minimum', observedKeys: ['value'], required: { minimumRatio: 0.99 } },
  'health.critical-ratio': { mode: 'ratio-maximum', observedKeys: ['value'], required: { maximumRatio: 0.01 } },
  'simulation.ups-coverage': coverageContract,
  'simulation.ups-floor': {
    mode: 'ratio-minimum', observedKeys: ['value', 'p05', 'median'],
    required: { minimumRatio: 0.95, minimumUps: 55 }
  },
  'host.cpu-coverage': coverageContract,
  'host.cpu-p95': { mode: 'maximum', observedKeys: ['value'], required: { maximum: 90 } },
  'host.per-core-coverage': coverageContract,
  'host.hottest-core-saturation': { mode: 'ratio-maximum', observedKeys: ['value'], required: { maximumRatio: 0.1 } },
  'process.multicore-coverage': coverageContract,
  'process.single-core-bottleneck': { mode: 'ratio-maximum', observedKeys: ['value'], required: { maximumRatio: 0.05 } },
  'host.memory-coverage': coverageContract,
  'host.memory-peak': { mode: 'maximum', observedKeys: ['value'], required: { maximum: 90 } },
  'storage.project-coverage': coverageContract,
  'storage.project-peak-used': { mode: 'maximum', observedKeys: ['value'], required: { maximum: 90 } },
  'storage.project-minimum-free': { mode: 'minimum', observedKeys: ['value'], required: { minimum: 10_737_418_240 } },
  'storage.save-coverage': coverageContract,
  'storage.save-peak-used': { mode: 'maximum', observedKeys: ['value'], required: { maximum: 90 } },
  'storage.save-minimum-free': { mode: 'minimum', observedKeys: ['value'], required: { minimum: 10_737_418_240 } }
}

const qualificationRemainingEvidence = [
  'SAVE_LATENCY_DRILL_REQUIRED',
  'REBOOT_RECOVERY_DRILL_REQUIRED',
  'CRASH_RECOVERY_DRILL_REQUIRED',
  'EXTERNAL_JOIN_SOAK_REQUIRED'
] as const

async function observabilityQualification(signal?: AbortSignal): Promise<ObservabilityQualificationEnvelope> {
  const response = await fetch('/api/v1/observability/qualification', {
    credentials: 'same-origin', signal
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { code?: string } } | null
    const code = body?.error?.code ?? null
    const message = response.status === 401 ? '观测资格报告需要重新建立认证会话。'
      : response.status === 403 ? '当前会话没有读取观测资格报告的权限。'
        : response.status === 503 ? '观测资格报告暂不可用；最后可信报告保持只读。'
          : '观测资格报告请求失败；不会把未知状态视为通过。'
    throw new ApiError(response.status, message, code)
  }
  const payload = await response.json().catch(() => null)
  const parsed = parseQualificationEnvelope(payload)
  if (parsed === null) {
    throw new ApiError(
      502,
      '观测资格报告未通过客户端合同校验；不会显示为通过。',
      'OBSERVABILITY_QUALIFICATION_RESPONSE_INVALID'
    )
  }
  return parsed
}

function parseQualificationEnvelope(value: unknown): ObservabilityQualificationEnvelope | null {
  if (!hasExactKeys(value, ['data', 'meta'])) return null
  const meta = value.meta
  const report = value.data
  if (!hasExactKeys(meta, ['provider', 'environment', 'capacity'])
      || !['demo', 'windows'].includes(String(meta.provider))
      || !['development', 'test', 'production'].includes(String(meta.environment))
      || !isBoundedSafeInteger(meta.capacity, 1, 1_000_000)) return null
  if (!hasExactKeys(report, [
    'schemaVersion', 'kind', 'profileId', 'result', 'generatedAt', 'from', 'to',
    'sampleCount', 'spanMs', 'checks', 'remainingEvidence'
  ])) return null
  const remainingEvidence = report.remainingEvidence
  if (report.schemaVersion !== 1 || report.kind !== 'dyson-late-game-qualification-report'
      || report.profileId !== 'late-game-6h-v1' || !isQualificationStatus(report.result)
      || !isIsoTimestamp(report.generatedAt) || !isBoundedSafeInteger(report.sampleCount, 0, meta.capacity)
      || !isBoundedSafeInteger(report.spanMs, 0, 31_536_000_000)
      || !Array.isArray(report.checks) || report.checks.length !== qualificationCheckIds.length
      || !Array.isArray(remainingEvidence)
      || !qualificationRemainingEvidence.every((entry, index) => remainingEvidence[index] === entry)
      || remainingEvidence.length !== qualificationRemainingEvidence.length) return null

  if (report.sampleCount === 0) {
    if (report.from !== null || report.to !== null || report.spanMs !== 0) return null
  } else {
    if (!isIsoTimestamp(report.from) || !isIsoTimestamp(report.to)) return null
    if (Math.max(0, Date.parse(report.to) - Date.parse(report.from)) !== report.spanMs) return null
  }

  const checks: QualificationCheck[] = []
  for (let index = 0; index < qualificationCheckIds.length; index += 1) {
    const id = qualificationCheckIds[index]!
    const parsedCheck = parseQualificationCheck(report.checks[index], id, report.sampleCount)
    if (parsedCheck === null) return null
    checks.push(parsedCheck)
  }
  const expectedResult: QualificationStatus = checks.some((check) => check.status === 'insufficient')
    ? 'insufficient'
    : checks.some((check) => check.status === 'fail') ? 'fail' : 'pass'
  if (report.result !== expectedResult) return null

  return {
    data: {
      schemaVersion: 1,
      kind: 'dyson-late-game-qualification-report',
      profileId: 'late-game-6h-v1',
      result: report.result,
      generatedAt: report.generatedAt,
      from: report.from,
      to: report.to,
      sampleCount: report.sampleCount,
      spanMs: report.spanMs,
      checks,
      remainingEvidence: [...qualificationRemainingEvidence]
    },
    meta: {
      provider: meta.provider as 'demo' | 'windows',
      environment: meta.environment as 'development' | 'test' | 'production',
      capacity: meta.capacity
    }
  }
}

function parseQualificationCheck(
  value: unknown,
  expectedId: QualificationCheckId,
  sampleCount: number
): QualificationCheck | null {
  if (!hasExactKeys(value, ['id', 'status', 'message', 'observed', 'required'])
      || value.id !== expectedId || !isQualificationStatus(value.status)
      || typeof value.message !== 'string' || value.message.length < 1 || value.message.length > 512) return null
  const contract = qualificationCheckContracts[expectedId]
  const requiredKeys = Object.keys(contract.required)
  const observed = value.observed
  const required = value.required
  if (!hasExactKeys(observed, contract.observedKeys) || !hasExactKeys(required, requiredKeys)) return null
  if (!requiredKeys.every((key) => required[key] === contract.required[key])) return null
  if (!contract.observedKeys.every((key) => isFiniteNumber(observed[key]) || observed[key] === null)) return null
  if (!qualificationObservedDomainValid(expectedId, observed, sampleCount)) return null
  if (qualificationExpectedStatus(contract, observed) !== value.status) return null

  return {
    id: expectedId,
    status: value.status,
    message: value.message,
    observed: { ...observed } as Record<string, number | string | null>,
    required: { ...required } as Record<string, number | string>
  }
}

function qualificationObservedDomainValid(
  id: QualificationCheckId,
  observed: Record<string, unknown>,
  sampleCount: number
): boolean {
  const value = observed.value
  if (qualificationCoverageCheckIds.has(id)) {
    const observedSamples = observed.observedSamples
    const totalSamples = observed.totalSamples
    if (!isBoundedSafeInteger(observedSamples, 0, sampleCount)
        || !isBoundedSafeInteger(totalSamples, 0, sampleCount)
        || observedSamples > totalSamples) return false
    const expectedRatio = totalSamples === 0 ? null : observedSamples / totalSamples
    return value === expectedRatio || (isFiniteNumber(value) && expectedRatio !== null
      && Math.abs(value - expectedRatio) <= Number.EPSILON * 8)
  }
  if (id === 'window.samples') return isBoundedSafeInteger(value, 0, sampleCount) && value === sampleCount
  if (id === 'window.duration') return isBoundedSafeInteger(value, 0, 31_536_000_000)
  if (id === 'simulation.ups-floor') {
    return isNullableBoundedNumber(value, 0, 1)
      && isNullableBoundedNumber(observed.p05, 0, 10_000)
      && isNullableBoundedNumber(observed.median, 0, 10_000)
      && (value === null ? observed.p05 === null && observed.median === null
        : observed.p05 !== null && observed.median !== null)
  }
  if (id === 'runtime.running-coverage' || id === 'health.critical-ratio'
      || id === 'host.hottest-core-saturation' || id === 'process.single-core-bottleneck') {
    return isNullableBoundedNumber(value, 0, 1)
  }
  if (id === 'host.cpu-p95' || id === 'host.memory-peak'
      || id === 'storage.project-peak-used' || id === 'storage.save-peak-used') {
    return isNullableBoundedNumber(value, 0, 100)
  }
  if (id === 'storage.project-minimum-free' || id === 'storage.save-minimum-free') {
    return value === null || isBoundedSafeInteger(value, 0, Number.MAX_SAFE_INTEGER)
  }
  return false
}

function qualificationExpectedStatus(
  contract: QualificationCheckContract,
  observed: Record<string, unknown>
): QualificationStatus {
  const value = observed.value
  if (contract.mode === 'evidence-minimum') {
    return isFiniteNumber(value) && value >= contract.required.minimum! ? 'pass' : 'insufficient'
  }
  if (contract.mode === 'coverage') {
    return isFiniteNumber(value) && value >= contract.required.minimumRatio! ? 'pass' : 'insufficient'
  }
  if (!isFiniteNumber(value)) return 'insufficient'
  if (contract.mode === 'ratio-minimum') return value >= contract.required.minimumRatio! ? 'pass' : 'fail'
  if (contract.mode === 'ratio-maximum') return value <= contract.required.maximumRatio! ? 'pass' : 'fail'
  if (contract.mode === 'minimum') return value >= contract.required.minimum! ? 'pass' : 'fail'
  return value <= contract.required.maximum! ? 'pass' : 'fail'
}

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key))
}

function isQualificationStatus(value: unknown): value is QualificationStatus {
  return value === 'pass' || value === 'fail' || value === 'insufficient'
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 20 && value.length <= 40 && Number.isFinite(Date.parse(value))
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNullableBoundedNumber(value: unknown, minimum: number, maximum: number): boolean {
  return value === null || (isFiniteNumber(value) && value >= minimum && value <= maximum)
}

function isBoundedSafeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

async function trustedCompatibilityStatus(signal?: AbortSignal): Promise<{ data: UpdateCompatibilityStatus }> {
  const result = await trustedCompatibilityRequest<unknown>('/api/v1/updates/compatibility/status', { signal })
  const status = normalizeTrustedCompatibilityStatus(result.data)
  if (status === null) {
    throw new ApiError(502, '兼容性状态未通过严格浏览器合同校验。', 'UPDATE_COMPATIBILITY_BROWSER_RESPONSE_INVALID')
  }
  return { data: status }
}

async function prepareTrustedCompatibility(
  input: UpdateCompatibilityPreparationRequest,
  signal?: AbortSignal
): Promise<{ data: UpdateCompatibilityReceipt }> {
  const result = await trustedCompatibilityRequest<unknown>('/api/v1/updates/compatibility/prepare', {
    method: 'POST',
    signal,
    body: JSON.stringify({
      requestId: input.requestId,
      component: input.component,
      artifactId: input.artifactId,
      sha256: input.sha256,
      targetVersion: input.targetVersion,
      expectedInventoryRevision: input.expectedInventoryRevision,
      expectedPolicyRevision: input.expectedPolicyRevision,
      confirmation: 'PREPARE_COMPATIBILITY_EVIDENCE'
    })
  })
  const receipt = normalizeTrustedCompatibilityReceipt(result.data)
  if (receipt === null) {
    throw new ApiError(502, '兼容性回执未通过严格浏览器合同校验。', 'UPDATE_COMPATIBILITY_BROWSER_RESPONSE_INVALID')
  }
  return { data: receipt }
}

async function readTrustedCompatibilityReceipt(
  receiptId: string,
  signal?: AbortSignal
): Promise<{ data: UpdateCompatibilityReceipt }> {
  const result = await trustedCompatibilityRequest<unknown>(
    `/api/v1/updates/compatibility/receipts/${encodeURIComponent(receiptId)}`,
    { signal }
  )
  const receipt = normalizeTrustedCompatibilityReceipt(result.data)
  if (receipt === null) {
    throw new ApiError(502, '兼容性回执未通过严格浏览器合同校验。', 'UPDATE_COMPATIBILITY_BROWSER_RESPONSE_INVALID')
  }
  return { data: receipt }
}

async function trustedCompatibilityRequest<T>(path: string, init?: RequestInit): Promise<{ data: T }> {
  const headers = new Headers(init?.headers)
  if (init?.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(path, { credentials: 'same-origin', ...init, headers })
  const body = await response.json().catch(() => null) as {
    ok?: boolean
    data?: T
    error?: { code?: string }
  } | null
  if (!response.ok || body?.ok !== true || body.data === undefined) {
    const code = body?.error?.code ?? null
    throw new ApiError(response.status, trustedCompatibilityErrorMessage(response.status, code), code)
  }
  return { data: body.data }
}

function trustedCompatibilityErrorMessage(status: number, code: string | null): string {
  if (code === 'UPDATE_COMPATIBILITY_POLICY_UNAVAILABLE') {
    return '服务端没有装配经过审阅的兼容性策略；激活保持锁定。'
  }
  if (code === 'UPDATE_COMPATIBILITY_RECEIPT_EXPIRED') {
    return '兼容性回执已经过期；请基于当前状态重新准备。'
  }
  if (code === 'UPDATE_COMPATIBILITY_POLICY_DRIFT') {
    return '服务端兼容性策略已经变化；请刷新策略状态并重新准备回执。'
  }
  if (code === 'UPDATE_COMPATIBILITY_INVENTORY_DRIFT') {
    return '运行时 inventory 已经变化；请刷新状态并重新准备兼容性回执。'
  }
  if (code === 'UPDATE_COMPATIBILITY_CONFLICT') {
    return '候选与服务端可信兼容性策略不兼容；激活保持锁定。'
  }
  if (code === 'UPDATE_COMPATIBILITY_CANDIDATE_MISMATCH') {
    return '兼容性回执与当前候选身份不一致；请重新准备。'
  }
  if (code === 'UPDATE_COMPATIBILITY_IDEMPOTENCY_CONFLICT') {
    return '该 request ID 已绑定到另一份兼容性准备请求。'
  }
  if (code === 'UPDATE_COMPATIBILITY_RECEIPT_NOT_FOUND') {
    return '没有找到该 UUID 对应的兼容性回执。'
  }
  if (status === 423 || code === 'UPDATE_COMPATIBILITY_RECEIPT_LIMIT_REACHED') {
    return '兼容性回执存储已达到有界上限；准备动作保持锁定。'
  }
  if (status === 422) return '兼容性准备请求未通过固定字段合同。'
  if (status === 403) return '当前角色没有准备兼容性回执的服务端权限。'
  return '服务端可信兼容性服务暂不可用；激活保持锁定。'
}

function normalizeTrustedCompatibilityStatus(input: unknown): UpdateCompatibilityStatus | null {
  if (!hasExactKeys(input, [
    'format', 'schemaVersion', 'available', 'policyId', 'policyRevision', 'policyReviewedAt',
    'inventoryRevision', 'inventory'
  ]) || input.format !== 'dyson-control-trusted-compatibility-status' || input.schemaVersion !== 1 ||
      typeof input.available !== 'boolean' || !isRevision(input.inventoryRevision) ||
      !hasExactKeys(input.inventory, ['dsp', 'nebula', 'bepInEx', 'plugins']) ||
      !isBoundedText(input.inventory.dsp, 1, 64) || !isBoundedText(input.inventory.nebula, 1, 64) ||
      !isBoundedText(input.inventory.bepInEx, 1, 64) || !Array.isArray(input.inventory.plugins) ||
      input.inventory.plugins.length > 256) return null
  if (!input.inventory.plugins.every((plugin) => hasExactKeys(plugin, ['sourceId', 'version']) &&
      isBoundedText(plugin.sourceId, 1, 160) && isBoundedText(plugin.version, 1, 64))) return null
  const policyFieldsValid = input.available
    ? isBoundedText(input.policyId, 3, 96) && isRevision(input.policyRevision) && isIsoTimestamp(input.policyReviewedAt)
    : input.policyId === null && input.policyRevision === null && input.policyReviewedAt === null
  if (!policyFieldsValid) return null
  return input as unknown as UpdateCompatibilityStatus
}

function normalizeTrustedCompatibilityReceipt(input: unknown): UpdateCompatibilityReceipt | null {
  if (!hasExactKeys(input, [
    'format', 'schemaVersion', 'receiptId', 'component', 'artifactId', 'artifactSha256',
    'targetVersion', 'inventoryRevision', 'policyId', 'policyRevision', 'matchedEntryId',
    'compatible', 'issuedAt', 'expiresAt', 'reused'
  ]) || input.format !== 'dyson-control-trusted-compatibility-receipt' || input.schemaVersion !== 1 ||
      !uuidPattern.test(String(input.receiptId)) || !isManagedUpdateComponent(input.component) ||
      !isBoundedText(input.artifactId, 16, 96) || !/^[a-z0-9][a-z0-9-]+$/.test(input.artifactId) ||
      !saveTransferSha256Pattern.test(String(input.artifactSha256)) ||
      !isBoundedText(input.targetVersion, 1, 64) || !isRevision(input.inventoryRevision) ||
      !isBoundedText(input.policyId, 3, 96) || !isRevision(input.policyRevision) ||
      !(input.matchedEntryId === null || isBoundedText(input.matchedEntryId, 1, 96)) ||
      typeof input.compatible !== 'boolean' || !isIsoTimestamp(input.issuedAt) ||
      !isIsoTimestamp(input.expiresAt) || Date.parse(input.expiresAt) <= Date.parse(input.issuedAt) ||
      typeof input.reused !== 'boolean') return null
  return input as unknown as UpdateCompatibilityReceipt
}

function isManagedUpdateComponent(value: unknown): value is UpdateCompatibilityReceipt['component'] {
  return value === 'nebula' || value === 'bepinex' || value === 'bridge' || value === 'control'
}

function isRevision(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function isBoundedText(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum
}

async function activationRequest<T>(path: string, init?: RequestInit): Promise<{ data: T }> {
  const headers = new Headers(init?.headers)
  if (init?.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(path, { credentials: 'same-origin', ...init, headers })
  const body = await response.json().catch(() => null) as {
    ok?: boolean
    data?: T
    error?: { code?: string; message?: string }
  } | null
  if (!response.ok || body?.ok !== true || body.data === undefined) {
    const code = body?.error?.code ?? null
    throw new ApiError(response.status, updateActivationErrorMessage(response.status, code), code)
  }
  return { data: body.data }
}

async function readModDeploymentRecoveryStatus(signal?: AbortSignal): Promise<{
  data: ModDeploymentRecoveryStatus
  meta: { executionEnabled: boolean }
}> {
  const result = await request<{ data: unknown; meta: unknown }>(
    '/api/v1/mods/deployment/recovery/status', { signal }
  )
  const status = normalizeModDeploymentRecoveryStatus(result.data)
  if (status === null || !hasExactKeys(result.meta, ['executionEnabled']) ||
      typeof result.meta.executionEnabled !== 'boolean') {
    throw new ApiError(
      502,
      '模组恢复状态未通过严格浏览器合同校验；普通模组写入保持锁定。',
      'MOD_DEPLOYMENT_RECOVERY_BROWSER_RESPONSE_INVALID'
    )
  }
  return { data: status, meta: { executionEnabled: result.meta.executionEnabled } }
}

function normalizeModDeploymentRecoveryStatus(input: unknown): ModDeploymentRecoveryStatus | null {
  if (!hasExactKeys(input, ['phase', 'requestId', 'operation', 'allowedDesired']) ||
      (input.phase !== 'ready' && input.phase !== 'recovery-required') ||
      !Array.isArray(input.allowedDesired) || input.allowedDesired.length > 2 ||
      !input.allowedDesired.every((desired) => desired === 'candidate' || desired === 'previous') ||
      new Set(input.allowedDesired).size !== input.allowedDesired.length) return null

  if (input.phase === 'ready') {
    return input.requestId === null && input.operation === null && input.allowedDesired.length === 0
      ? { phase: 'ready', requestId: null, operation: null, allowedDesired: [] }
      : null
  }
  if (typeof input.requestId !== 'string' || !uuidPattern.test(input.requestId) ||
      !['install', 'update', 'enable', 'disable', 'remove'].includes(String(input.operation)) ||
      input.allowedDesired.length < 1) return null
  return {
    phase: 'recovery-required',
    requestId: input.requestId.toLowerCase(),
    operation: input.operation as ModDeploymentRecoveryStatus['operation'],
    allowedDesired: [...input.allowedDesired] as Array<'candidate' | 'previous'>
  }
}

async function acquisitionRequest<T>(path: string, init?: RequestInit): Promise<{ data: T }> {
  const headers = new Headers(init?.headers)
  if (init?.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(path, { credentials: 'same-origin', ...init, headers })
  const body = await response.json().catch(() => null) as {
    ok?: boolean
    data?: T
    error?: { code?: string }
  } | null
  if (!response.ok || body?.ok !== true || body.data === undefined) {
    const code = body?.error?.code ?? null
    throw new ApiError(response.status, artifactAcquisitionErrorMessage(response.status, code), code)
  }
  return { data: body.data }
}

async function componentCandidatePreparationRequest<T>(
  path: string,
  init?: RequestInit
): Promise<{ data: T }> {
  const headers = new Headers(init?.headers)
  if (init?.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(path, { credentials: 'same-origin', ...init, headers })
  const body = await response.json().catch(() => null) as {
    ok?: boolean
    data?: T
    error?: { code?: string }
  } | null
  if (!response.ok || body?.ok !== true || body.data === undefined) {
    const code = body?.error?.code ?? null
    throw new ApiError(
      response.status,
      componentCandidatePreparationErrorMessage(response.status, code),
      code
    )
  }
  return { data: body.data }
}

function componentCandidatePreparationErrorMessage(status: number, code: string | null): string {
  if (status === 404) {
    return code === 'CANDIDATE_PREPARATION_RECEIPT_NOT_FOUND'
      ? '没有找到该 UUID 对应的组件候选准备回执。'
      : '找不到对应的持久制品获取回执。'
  }
  if (status === 422) {
    return '组件候选准备请求或官方制品布局未通过严格核验。'
  }
  if (status === 423) {
    if (code === 'CANDIDATE_PREPARATION_MUTATION_DISABLED') {
      return '组件候选准备门禁为 fail-closed；当前只允许读取与预演。'
    }
    return '组件候选准备资源正被占用；请稍后重新预演。'
  }
  if (status === 409) {
    return '组件候选准备身份或持久状态发生冲突；请重新获取并准备。'
  }
  if (status === 403) return '当前角色没有执行组件候选准备的服务端权限。'
  if (status === 503) return '组件候选准备服务暂不可用；激活保持锁定。'
  return '组件候选准备失败；激活保持锁定。'
}

async function thunderstoreModImportRequest<T>(path: string, init?: RequestInit): Promise<{ data: T }> {
  const headers = new Headers(init?.headers)
  if (init?.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(path, { credentials: 'same-origin', ...init, headers })
  const body = await response.json().catch(() => null) as {
    ok?: boolean
    data?: T
    error?: { code?: string }
  } | null
  if (!response.ok || body?.ok !== true || body.data === undefined) {
    const code = body?.error?.code ?? null
    throw new ApiError(response.status, thunderstoreModImportErrorMessage(response.status, code), code)
  }
  return { data: body.data }
}

function thunderstoreModImportErrorMessage(status: number, code: string | null): string {
  if (status === 423 || code === 'THUNDERSTORE_MOD_IMPORT_MUTATION_DISABLED') {
    return 'Thunderstore 模组导入门禁为 fail-closed；当前只允许校验与预演。'
  }
  if (code === 'THUNDERSTORE_MOD_IMPORT_NOT_CONFIGURED') {
    return 'Thunderstore 模组导入尚未配置固定 inbox、暂存根与状态根。'
  }
  if (code === 'THUNDERSTORE_MOD_IMPORT_ACQUISITION_NOT_FOUND') return '找不到对应的持久制品获取回执。'
  if (code === 'THUNDERSTORE_MOD_IMPORT_RECEIPT_NOT_FOUND') return '找不到对应的持久模组导入回执。'
  if (code === 'THUNDERSTORE_MOD_IMPORT_NON_PLUGIN_DESTINATION_UNSUPPORTED') {
    return '该包会写入 config、core、patchers 或 monomod；当前插件专属事务不会越权导入。'
  }
  if (code === 'THUNDERSTORE_MOD_IMPORT_RUNTIME_LAYOUT_UNSUPPORTED') {
    return '该包包含尚未支持的运行时布局；不会猜测安装目的地。'
  }
  if (status === 409) return '已获取制品、暂存包或幂等身份发生冲突；请重新读取持久回执。'
  if (status === 422) return 'Thunderstore ZIP、清单、依赖或插件布局未通过固定导入合同。'
  if (status === 403) return '当前角色没有执行模组导入的服务端权限。'
  return 'Thunderstore 模组导入暂不可用；不会绕过固定根目录与摘要校验。'
}

function artifactAcquisitionErrorMessage(status: number, code: string | null): string {
  if (status === 423 || code === 'UPDATE_ACQUISITION_MUTATION_DISABLED') {
    return '制品获取门禁为 fail-closed；当前只允许发现、查看与预演。'
  }
  if (code === 'UPDATE_ACQUISITION_NOT_CONFIGURED') return '受管制品获取尚未配置固定 inbox 与状态根。'
  if (code === 'ACQUISITION_CANDIDATE_EXPIRED') return '服务端候选已经过期；请重新执行官方版本发现。'
  if (code === 'ACQUISITION_CANDIDATE_INELIGIBLE') return '该版本未通过服务端候选资格门禁。'
  if (code === 'ACQUISITION_CANDIDATE_NOT_FOUND') return '服务端找不到该候选；请重新执行官方版本发现。'
  if (code === 'UPDATE_ACQUISITION_RECEIPT_NOT_FOUND') return '没有找到该 request ID 的持久获取回执。'
  if (code === 'ACQUISITION_IDEMPOTENCY_CONFLICT') return '该 request ID 已绑定到另一项制品获取请求。'
  if (status === 409) return '受管候选状态已经变化；请重新发现并预演。'
  if (status === 422) return '制品获取请求或上游字节未通过固定合同与完整性校验。'
  if (status === 403) return '当前角色没有执行制品获取的服务端权限。'
  return '受管制品获取暂不可用；不会尝试绕过服务端门禁。'
}

function updateActivationErrorMessage(status: number, code: string | null): string {
  if (status === 423 || code === 'UPDATE_ACTIVATION_HTTP_MUTATION_DISABLED') {
    return '组件激活门禁为 fail-closed；当前只允许读取与预演。'
  }
  if (code === 'UPDATE_ACTIVATION_NOT_CONFIGURED') return '组件激活事务尚未配置；当前只允许官方发现与离线暂存。'
  if (code === 'UPDATE_DSP_MANUAL_STEAM_REQUIRED') return 'DSP 本体必须通过已登录的 Steam 客户端手动更新。'
  if (code === 'UPDATE_RECOVERY_REQUIRED') return '组件状态要求先完成恢复核验，激活继续保持锁定。'
  if (code === 'UPDATE_ACTIVATION_HTTP_RECOVERY_NOT_REQUIRED' ||
      code === 'UPDATE_HOST_LEASE_RECOVERY_NOT_REQUIRED') {
    return '服务端已经没有与该事务匹配的待恢复租约；请刷新恢复状态。'
  }
  if (code === 'UPDATE_RECOVERY_REQUEST_MISMATCH' ||
      code === 'UPDATE_HOST_LEASE_RECOVERY_MISMATCH') {
    return '该 request ID 与服务端待恢复事务不匹配；未执行任何恢复写入。'
  }
  if (code === 'UPDATE_RECOVERY_EVIDENCE_CHANGED' || code === 'UPDATE_RECOVERY_EVIDENCE_INVALID' ||
      code === 'UPDATE_RECOVERY_TERMINAL_UNPROVEN') {
    return '恢复证据已变化或无法证明安全终态；全局恢复门禁保持关闭。'
  }
  if (status === 409) return '组件激活预条件已变化；请刷新 revision 和兼容性证据后重新预演。'
  if (status === 422) return '组件激活请求未通过固定字段或兼容性校验。'
  if (status === 403) return '当前角色没有执行组件激活的服务端权限。'
  return '组件激活工作流暂不可用；不会尝试绕过门禁。'
}

const savePairTransferMediaType = 'application/vnd.dyson-control.save-pair'
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const saveTransferBackupIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const saveTransferSha256Pattern = /^[0-9a-f]{64}$/

async function prepareSavePairExport(
  requestId: string,
  backupId: string,
  signal?: AbortSignal
): Promise<{ data: SavePairExportReceipt }> {
  if (!uuidPattern.test(requestId) || !saveTransferBackupIdPattern.test(backupId)) {
    throw new ApiError(400, '存档导出只能引用有效 request ID 和已验证 backup ID。', 'SAVE_TRANSFER_CLIENT_REQUEST_INVALID')
  }
  const response = await request<{ data: unknown }>('/api/v1/saves/transfers/exports', {
    method: 'POST', signal, body: JSON.stringify({ requestId, backupId })
  })
  if (!isExportReceipt(response.data, requestId, backupId)) {
    throw new ApiError(502, '存档导出回执未通过客户端合同校验。', 'SAVE_TRANSFER_EXPORT_RECEIPT_INVALID')
  }
  return { data: response.data }
}

async function downloadSavePairExport(
  requestId: string,
  receipt: SavePairExportReceipt,
  signal?: AbortSignal
): Promise<SavePairTransferDownload> {
  if (!uuidPattern.test(requestId) || receipt.requestId !== requestId || receipt.restoreExecuted !== false) {
    throw new ApiError(400, '存档导出下载请求与已验证回执不一致。', 'SAVE_TRANSFER_CLIENT_REQUEST_INVALID')
  }
  const response = await fetch(`/api/v1/saves/transfers/exports/${encodeURIComponent(requestId)}`, {
    credentials: 'same-origin', signal
  })
  if (!response.ok) throw await saveTransferResponseError(response, '存档导出下载失败。')

  const contentType = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  const contentLength = Number(response.headers.get('Content-Length'))
  const sha256 = response.headers.get('X-Dyson-Content-SHA256')?.toLowerCase() ?? ''
  const disposition = response.headers.get('Content-Disposition') ?? ''
  const expectedDisposition = `attachment; filename="dyson-save-${requestId}.dspair"`
  const cacheControl = response.headers.get('Cache-Control')?.toLowerCase() ?? ''
  if (contentType !== savePairTransferMediaType || !Number.isSafeInteger(contentLength) || contentLength < 1
      || contentLength !== receipt.archiveBytes || sha256 !== receipt.archiveSha256
      || disposition !== expectedDisposition || !cacheControl.includes('no-store')) {
    throw new ApiError(502, '存档导出响应缺少有效的长度、摘要或媒体类型。', 'SAVE_TRANSFER_DOWNLOAD_RESPONSE_INVALID')
  }
  const blob = await response.blob()
  if (blob.size !== contentLength) {
    throw new ApiError(502, '存档导出响应长度与实际内容不一致。', 'SAVE_TRANSFER_DOWNLOAD_RESPONSE_INVALID')
  }
  const computedSha256 = await sha256ArrayBuffer(await blob.arrayBuffer())
  if (computedSha256 !== sha256) {
    throw new ApiError(502, '存档导出内容未通过浏览器 SHA-256 复核。', 'SAVE_TRANSFER_DOWNLOAD_DIGEST_MISMATCH')
  }
  return {
    blob,
    fileName: `dyson-save-${requestId}.dyson-save-pair`,
    sizeBytes: contentLength,
    sha256
  }
}

async function importSavePairArchive(
  requestId: string,
  payload: ArrayBuffer,
  sha256: string,
  signal?: AbortSignal
): Promise<{ data: SavePairImportReceipt }> {
  const normalizedSha256 = sha256.toLowerCase()
  if (!uuidPattern.test(requestId) || payload.byteLength < 1 || !saveTransferSha256Pattern.test(normalizedSha256)) {
    throw new ApiError(400, '存档导入缺少有效 request ID、内容长度或 SHA-256。', 'SAVE_TRANSFER_CLIENT_REQUEST_INVALID')
  }
  const body = new Blob([payload], { type: savePairTransferMediaType })
  const response = await fetch(`/api/v1/saves/transfers/imports/${encodeURIComponent(requestId)}`, {
    method: 'POST',
    credentials: 'same-origin',
    signal,
    headers: {
      'Content-Type': savePairTransferMediaType,
      // Content-Length is a forbidden browser request header. The user agent
      // derives the exact wire length from this fixed Blob body.
      'X-Dyson-Content-SHA256': normalizedSha256
    },
    body
  })
  if (!response.ok) throw await saveTransferResponseError(response, '存档导入未进入隔离区。')
  const parsed = await response.json().catch(() => null) as { data?: unknown } | null
  if (!isImportReceipt(parsed?.data, requestId, body.size, normalizedSha256)) {
    throw new ApiError(502, '存档导入回执未通过客户端合同校验。', 'SAVE_TRANSFER_IMPORT_RECEIPT_INVALID')
  }
  return { data: parsed.data }
}

export async function sha256ArrayBuffer(payload: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new ApiError(503, '当前浏览器没有可用的 Web Crypto SHA-256。', 'SAVE_TRANSFER_CLIENT_CRYPTO_UNAVAILABLE')
  }
  const digest = await subtle.digest('SHA-256', payload)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function saveTransferResponseError(response: Response, fallback: string): Promise<ApiError> {
  const body = await response.json().catch(() => null) as {
    error?: { code?: string; message?: string }
  } | null
  return new ApiError(response.status, body?.error?.message ?? fallback, body?.error?.code ?? null)
}

function isExportReceipt(value: unknown, requestId: string, backupId: string): value is SavePairExportReceipt {
  if (!isRecord(value)) return false
  return value.format === 'dyson-control-save-transfer-receipt'
    && value.schemaVersion === 1
    && value.operation === 'export'
    && value.requestId === requestId
    && value.backupId === backupId
    && value.archiveId === `export-${requestId}`
    && typeof value.saveName === 'string' && value.saveName.length > 0
    && isPositiveSafeInteger(value.archiveBytes)
    && typeof value.archiveSha256 === 'string' && saveTransferSha256Pattern.test(value.archiveSha256)
    && typeof value.completedAt === 'string'
    && value.restoreExecuted === false
    && typeof value.reused === 'boolean'
}

function isImportReceipt(
  value: unknown,
  requestId: string,
  archiveBytes: number,
  archiveSha256: string
): value is SavePairImportReceipt {
  if (!isRecord(value)) return false
  return value.format === 'dyson-control-save-transfer-receipt'
    && value.schemaVersion === 1
    && value.operation === 'import'
    && value.requestId === requestId
    && value.inboxId === `import-${requestId}`
    && typeof value.saveName === 'string' && value.saveName.length > 0
    && value.archiveBytes === archiveBytes
    && value.archiveSha256 === archiveSha256
    && isPositiveSafeInteger(value.dsvBytes)
    && isPositiveSafeInteger(value.serverBytes)
    && typeof value.completedAt === 'string'
    && value.restoreExecuted === false
    && typeof value.reused === 'boolean'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

async function downloadClientProfileArchive(input: unknown): Promise<ClientProfileArchiveDownload> {
  const response = await fetch('/api/v1/client-profile/archive', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null
    throw new ApiError(response.status, body?.error?.message ?? `HTTP ${response.status}`, body?.error?.code ?? null)
  }

  const sha256 = response.headers.get('X-Dyson-Profile-SHA256') ?? ''
  const contentLength = response.headers.get('Content-Length')
  const disposition = response.headers.get('Content-Disposition') ?? ''
  const fileName = disposition.match(/filename="([A-Za-z0-9._-]+)"/)?.[1] ?? ''
  const blob = await response.blob()
  const sizeBytes = contentLength === null ? Number.NaN : Number(contentLength)
  if (!response.headers.get('Content-Type')?.toLowerCase().startsWith('application/zip')
      || fileName !== 'dyson-client-profile.zip' || !/^[0-9a-f]{64}$/.test(sha256)
      || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes !== blob.size) {
    throw new ApiError(502, '客户端 ZIP 响应缺少有效的完整性元数据', 'CLIENT_PROFILE_ARCHIVE_RESPONSE_INVALID')
  }
  return { blob, fileName, sha256, sizeBytes }
}

async function downloadConsole(filters: StructuredLogFilters): Promise<{
  blob: Blob
  fileName: string
  truncated: boolean
}> {
  const response = await fetch('/api/v1/console/logs/download', {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format: 'ndjson', start: 'beginning', filters })
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null
    throw new ApiError(response.status, body?.error?.message ?? `HTTP ${response.status}`, body?.error?.code ?? null)
  }
  const disposition = response.headers.get('Content-Disposition') ?? ''
  const fileName = disposition.match(/filename="([A-Za-z0-9._-]+)"/)?.[1] ?? 'dyson-console.ndjson'
  return {
    blob: await response.blob(), fileName,
    truncated: response.headers.get('X-Dyson-Console-Truncated') === 'true'
  }
}

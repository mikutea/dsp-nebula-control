import type {
  BackupCatalogItem, CatalogPage, GameConfigPreview, GameConfigSnapshot, GameConfigTransactionResult,
  GameConfigHistoryDiff, GameConfigHistoryRecoveryResult, GameConfigHistoryRestoreReceipt,
  GameConfigHistorySnapshotDetail, GameConfigHistorySnapshotSummary,
  ClientProfileArchiveDownload, GeneratedClientProfile,
  QualifiedClientArtifactDownload, QualifiedClientArtifactKind,
  QualifiedClientProfileIssueReference, QualifiedClientProfileIssueRequest,
  ConsoleCommandName, ConsoleCommandPreview, JobAuditExportDownload, JobAuditExportFormat,
  JobAuditExportInput, JobAuditExportPreview, JobKind, JobPage, JobPageQuery, JobRecord, JobState,
  LifecycleAction, LifecycleExecutionResult,
  ArtifactAcquisitionPlan, ArtifactAcquisitionReceipt, BepInExDiscoveryEnvelope,
  ComponentCandidatePreparationExecutionResult, ComponentCandidatePreparationPlan,
  ComponentCandidatePreparationReceipt, LifecyclePreview, NebulaDiscoveryEnvelope,
  CutoverDesiredAuthority, CutoverErrorCode, CutoverPreviewReceipt, CutoverPreviewRequest,
  CutoverReceipt, CutoverRecoveryStatus, CutoverRollbackMode,
  SupportedComponentCandidatePreparationComponent,
  ThunderstoreDependencyClosureEnvelope, ThunderstoreDiscoveryEnvelope,
  ThunderstoreModImportPlan, ThunderstoreModImportReceipt, VerifiedModLockReceiptRequest,
  VerifiedModManifestPreview,
  PlayerCapabilitiesProjection, PlayerNoticePlan, PlayerNoticePreviewInput, PlayerNoticeReceipt,
  PlayerRoster, SessionUser,
  ModDeploymentPreview, ModDeploymentReceipt, ModDeploymentReceiptHistoryPage, ModDeploymentRecoveryDesired,
  ModDeploymentRecoveryPlan, ModDeploymentRecoveryStatus, ModDeploymentRequest,
  ModDeploymentStateSummary, ManagedModConfigurationHistoryPage,
  ManagedModConfigurationPreview, ManagedModConfigurationReceipt,
  ManagedModConfigurationRequest, ManagedModConfigurationSchema, ManagedModConfigurationInspection,
  LateGameQualificationReport, ObservabilityDownsampleResult, ObservabilityQualificationEnvelope,
  ObservabilityLongWindowCheck, ObservabilityLongWindowCheckId, ObservabilityLongWindowReport,
  OperationLatencySummary, ServerReceiptLatencyReport,
  ObservabilityAlertEnvelope, ObservabilityAlertEpisode,
  QualificationCheck, QualificationCheckId, QualificationStatus, ServerObservabilitySnapshot,
  BackupAnnotation, BackupAnnotationReceipt, BackupRetentionPolicy, BackupRetentionPreview,
  BackupRetirementReceipt, BackupRetirementRestoreReceipt,
  BackupRetentionPurgePreview, BackupRetentionPurgeReceipt,
  SaveJobExecutionResult, SavePairCatalogItem, SavePairExportReceipt, SavePairImportReceipt,
  SavePairPromotionPlan, SavePairPromotionReceipt, SavePairRevision, SavePairTransferDownload,
  SaveTransactionResult, ServerStatus,
  StructuredLogFilters, StructuredLogPage, StructuredLogReadRequest,
  UpdateActivationConfirmation, UpdateActivationPlan, UpdateActivationReceipt,
  UpdateActivationRecoveryConfirmation, UpdateActivationRecoveryStatus,
  UpdateActivationRequest, UpdateActivationState, UpdateCleanupPlan,
  UpdateCompatibilityPreparationRequest, UpdateCompatibilityReceipt, UpdateCompatibilityStatus
} from './model'
import { jobKinds } from './model'
import {
  isGameConfigHistorySnapshotId,
  isGameConfigRevision,
  parseGameConfigHistoryDetail,
  parseGameConfigHistoryDiff,
  parseGameConfigHistoryList,
  parseGameConfigHistoryRecoveryResults,
  parseGameConfigHistoryRestoreReceipt
} from './game-config-history-contract'
import {
  normalizeSaveJobExecutionEnvelope,
  SAVE_JOB_RECONCILE_CONFIRMATION
} from './save-reconcile-contract'
import {
  isPlayerNoticePreviewInput,
  normalizePlayerNoticeExecutionEnvelope,
  normalizePlayerNoticePreviewEnvelope,
  normalizePlayerNoticeReceiptEnvelope
} from './player-notice-contract'

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code: string | null = null) { super(message) }
}

export class PlayerNoticeApiError extends ApiError {
  constructor(
    status: number,
    message: string,
    code: string | null,
    readonly data: { job: JobRecord; receipt: PlayerNoticeReceipt } | null = null
  ) {
    super(status, message, code)
  }
}

export const CUTOVER_PREPARE_CONFIRMATION = 'PREPARE_GSMANAGER_TO_DYSON' as const
export const CUTOVER_ACTIVATE_CONFIRMATION = 'ACTIVATE_GSMANAGER_TO_DYSON' as const
export const CUTOVER_ROLLBACK_CONFIRMATION = 'ROLLBACK_DYSON_TO_GSMANAGER' as const
export const CUTOVER_RECOVERY_CONFIRMATION = 'RECOVER_GSMANAGER_CUTOVER' as const
export const JOB_AUDIT_EXPORT_CONFIRMATION = 'EXPORT_JOB_AUDIT' as const
export const SAVE_PAIR_PROMOTION_CONFIRMATION = 'PROMOTE_IMPORTED_SAVE_PAIR' as const

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
  jobPage: (query: JobPageQuery = {}, signal?: AbortSignal) => readJobPage(query, signal),
  previewJobAuditExport: (input: JobAuditExportInput, signal?: AbortSignal) =>
    previewJobAuditExport(input, signal),
  exportJobAudit: (
    input: JobAuditExportInput,
    confirmation: typeof JOB_AUDIT_EXPORT_CONFIRMATION,
    signal?: AbortSignal
  ) => exportJobAudit(input, confirmation, signal),
  cutoverStatus: (signal?: AbortSignal) => readCutoverStatus(signal),
  previewCutover: (input: CutoverPreviewRequest, signal?: AbortSignal) =>
    runCutoverPreview(input, signal),
  prepareCutover: (
    requestId: string,
    planFingerprint: string,
    confirmation: typeof CUTOVER_PREPARE_CONFIRMATION,
    signal?: AbortSignal
  ) => runCutoverPrepare(requestId, planFingerprint, confirmation, signal),
  activateCutover: (
    requestId: string,
    planFingerprint: string,
    confirmation: typeof CUTOVER_ACTIVATE_CONFIRMATION,
    signal?: AbortSignal
  ) => runCutoverActivate(requestId, planFingerprint, confirmation, signal),
  rollbackCutover: (
    requestId: string,
    mode: CutoverRollbackMode,
    planFingerprint: string,
    confirmation: typeof CUTOVER_ROLLBACK_CONFIRMATION,
    signal?: AbortSignal
  ) => runCutoverRollback(requestId, mode, planFingerprint, confirmation, signal),
  recoverCutover: (
    requestId: string,
    desired: CutoverDesiredAuthority,
    confirmation: typeof CUTOVER_RECOVERY_CONFIRMATION,
    signal?: AbortSignal
  ) => runCutoverRecovery(requestId, desired, confirmation, signal),
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
  previewPlayerNotice: (input: PlayerNoticePreviewInput, signal?: AbortSignal) =>
    previewPlayerNotice(input, signal),
  executePlayerNotice: (
    input: PlayerNoticePreviewInput & {
      requestId: string
      confirmation: 'EXECUTE'
      expectedTargetJoinedAtUnixMs?: number
    },
    signal?: AbortSignal
  ) => executePlayerNotice(input, signal),
  playerNoticeReceipt: (
    input: PlayerNoticePreviewInput & { requestId: string; expectedTargetJoinedAtUnixMs?: number },
    signal?: AbortSignal
  ) => readPlayerNoticeReceipt(input, signal),
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
  modDeploymentReceipt: (requestId: string, signal?: AbortSignal) => request<{
    data: ModDeploymentReceipt
  }>(`/api/v1/mods/deployment/receipts/${encodeURIComponent(requestId)}`, { signal }),
  modDeploymentHistory: (
    input: { cursor?: string | null; pageSize?: number } = {},
    signal?: AbortSignal
  ) => {
    const query = new URLSearchParams()
    if (input.cursor) query.set('cursor', input.cursor)
    if (input.pageSize !== undefined) query.set('pageSize', String(input.pageSize))
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    return request<{ data: ModDeploymentReceiptHistoryPage }>(
      `/api/v1/mods/deployment/history${suffix}`, { signal }
    )
  },
  managedModConfigurationSchemas: (signal?: AbortSignal) => request<{
    data: ManagedModConfigurationSchema[]
    meta: { executionEnabled: boolean }
  }>('/api/v1/mods/configuration/schemas', { signal }),
  inspectManagedModConfiguration: (input: { schemaId: string; package: { dependencyId: string; version: string }; expectedDeploymentRevision: string }, signal?: AbortSignal) => request<{ data: ManagedModConfigurationInspection }>(
    '/api/v1/mods/configuration/inspect', { method: 'POST', signal, body: JSON.stringify(input) }),
  previewManagedModConfiguration: (input: ManagedModConfigurationRequest) => request<{
    data: ManagedModConfigurationPreview
    meta: { executionEnabled: boolean }
  }>('/api/v1/mods/configuration/preview', { method: 'POST', body: JSON.stringify(input) }),
  executeManagedModConfiguration: (input: ManagedModConfigurationRequest, requestFingerprint: string) => request<{ data: ManagedModConfigurationReceipt }>(
    '/api/v1/mods/configuration/execute', {
      method: 'POST', body: JSON.stringify({
        request: input,
        confirmation: {
          action: 'EXECUTE_MOD_CONFIGURATION', requestId: input.requestId, schemaId: input.schemaId,
          dependencyId: input.package.dependencyId, version: input.package.version,
          expectedDeploymentRevision: input.expectedDeploymentRevision,
          expectedConfigurationRevision: input.expectedConfigurationRevision,
          requestFingerprint,
          confirmation: 'CONFIGURE_MANAGED_MOD'
        }
      })
    }),
  managedModConfigurationReceipt: (requestId: string, signal?: AbortSignal) => request<{ data: ManagedModConfigurationReceipt }>(
    `/api/v1/mods/configuration/receipts/${encodeURIComponent(requestId)}`, { signal }),
  managedModConfigurationHistory: (input: { cursor?: string | null; pageSize?: number } = {}, signal?: AbortSignal) => {
    const query = new URLSearchParams()
    if (input.cursor) query.set('cursor', input.cursor)
    if (input.pageSize !== undefined) query.set('pageSize', String(input.pageSize))
    const suffix = query.size ? `?${query.toString()}` : ''
    return request<{ data: ManagedModConfigurationHistoryPage }>(`/api/v1/mods/configuration/history${suffix}`, { signal })
  },
  generateClientProfile: (input: unknown) => request<{ data: GeneratedClientProfile }>(
    '/api/v1/client-profile/generate', { method: 'POST', body: JSON.stringify(input) }
  ),
  downloadClientProfileArchive: (input: unknown) => downloadClientProfileArchive(input),
  issueQualifiedClientProfile: (input: QualifiedClientProfileIssueRequest) => request<{
    data: QualifiedClientProfileIssueReference
  }>('/api/v2/client-profile/issue', { method: 'POST', body: JSON.stringify(input) }),
  downloadQualifiedClientArtifact: (
    downloadId: string,
    kind: QualifiedClientArtifactKind,
    expected: { sha256: string; sizeBytes: number }
  ) => downloadQualifiedClientArtifact(downloadId, kind, expected),
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
  executeSaveBackup: (requestId: string, saveName: string) => saveJobRequest(
    '/api/v1/saves/backup/execute', {
    method: 'POST', body: JSON.stringify({ requestId, saveName, confirmation: 'CREATE_BACKUP' })
  }),
  previewSaveRestore: (input: {
    requestId: string; backupId: string; expectedRevision: string; protectionRequestId: string
  }) => request<{ data: SaveTransactionResult; meta: { executionEnabled: boolean } }>(
    '/api/v1/saves/restore/preview', { method: 'POST', body: JSON.stringify(input) }
  ),
  executeSaveRestore: (input: {
    requestId: string; backupId: string; expectedRevision: string; protectionRequestId: string
  }) => saveJobRequest(
    '/api/v1/saves/restore/execute', {
      method: 'POST', body: JSON.stringify({ ...input, confirmation: 'RESTORE_SAVE_PAIR' })
    }
  ),
  saveJob: (jobId: string, signal?: AbortSignal) => saveJobRequest(
    `/api/v1/saves/jobs/${encodeURIComponent(jobId)}`, { signal, cache: 'no-store' }
  ),
  reconcileSaveJob: (
    jobId: string,
    confirmation: typeof SAVE_JOB_RECONCILE_CONFIRMATION,
    signal?: AbortSignal
  ) => reconcileSaveJob(jobId, confirmation, signal),
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
  previewSavePairPromotion: (requestId: string, importRequestId: string, signal?: AbortSignal) =>
    previewSavePairPromotion(requestId, importRequestId, signal),
  executeSavePairPromotion: (
    requestId: string,
    importRequestId: string,
    confirmation: typeof SAVE_PAIR_PROMOTION_CONFIRMATION,
    signal?: AbortSignal
  ) => executeSavePairPromotion(requestId, importRequestId, confirmation, signal),
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
    changes: Array<{ id: string; value: boolean | number | string }>,
    requestId: string
  ) => request<{ data: GameConfigTransactionResult }>('/api/v1/configuration/apply', {
    method: 'POST', body: JSON.stringify({ expectedRevision, changes, requestId, confirmation: 'APPLY_CONFIG' })
  }),
  gameConfigHistory: (signal?: AbortSignal) => gameConfigHistoryList(signal),
  reconcileConfiguration: (requestId: string) => request<{ data: GameConfigTransactionResult }>('/api/v1/configuration/reconcile', {
    method: 'POST', body: JSON.stringify({ requestId, confirmation: 'RECONCILE_CONFIG' })
  }),
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

const jobStateValues = ['queued', 'running', 'succeeded', 'failed'] as const
const jobKindSet = new Set<string>(jobKinds)
const jobStateSet = new Set<string>(jobStateValues)
const jobAuditCursorPattern = /^[A-Za-z0-9_-]{16,512}$/
const jobAuditErrorCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/
const jobAuditUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const maximumJobAuditExportBytes = 2 * 1024 * 1024

async function readJobPage(query: JobPageQuery, signal?: AbortSignal): Promise<JobPage> {
  const normalized = normalizeJobPageQuery(query)
  const search = new URLSearchParams()
  if (normalized.pageSize !== undefined) search.set('pageSize', String(normalized.pageSize))
  if (normalized.cursor !== undefined) search.set('cursor', normalized.cursor)
  if (normalized.kind !== undefined) search.set('kind', normalized.kind)
  if (normalized.state !== undefined) search.set('state', normalized.state)
  const suffix = search.size > 0 ? `?${search.toString()}` : ''
  const response = await jobAuditFetch(`/api/v1/jobs${suffix}`, { signal, cache: 'no-store' })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) throw jobAuditHttpError(response.status, body)
  const page = normalizeJobPage(body)
  if (page === null) throw jobAuditResponseInvalid()
  return page
}

async function previewJobAuditExport(
  input: JobAuditExportInput,
  signal?: AbortSignal
): Promise<{ data: JobAuditExportPreview }> {
  const normalized = normalizeJobAuditExportInput(input)
  const response = await jobAuditFetch('/api/v1/jobs/audit/export/preview', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(normalized)
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) throw jobAuditHttpError(response.status, body)
  if (!hasExactKeys(body, ['data'])) throw jobAuditResponseInvalid()
  const preview = normalizeJobAuditExportPreview(body.data, normalized)
  if (preview === null) throw jobAuditResponseInvalid()
  return { data: preview }
}

async function exportJobAudit(
  input: JobAuditExportInput,
  confirmation: typeof JOB_AUDIT_EXPORT_CONFIRMATION,
  signal?: AbortSignal
): Promise<JobAuditExportDownload> {
  if (confirmation !== JOB_AUDIT_EXPORT_CONFIRMATION) throw jobAuditClientRequestInvalid()
  const normalized = normalizeJobAuditExportInput(input)
  const response = await jobAuditFetch('/api/v1/jobs/audit/export', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...normalized, confirmation: JOB_AUDIT_EXPORT_CONFIRMATION })
  })
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
    throw jobAuditHttpError(response.status, body)
  }

  const expectedFileName = normalized.format === 'json'
    ? 'dyson-job-audit.json' as const
    : 'dyson-job-audit.ndjson' as const
  const expectedContentType = normalized.format === 'json'
    ? 'application/json; charset=utf-8'
    : 'application/x-ndjson; charset=utf-8'
  if (response.headers.get('cache-control') !== 'no-store' ||
      response.headers.get('x-content-type-options') !== 'nosniff' ||
      response.headers.get('content-disposition') !== `attachment; filename="${expectedFileName}"` ||
      response.headers.get('content-type')?.toLowerCase() !== expectedContentType) {
    throw jobAuditResponseInvalid()
  }

  const bytes = await response.arrayBuffer()
  if (bytes.byteLength < 1 || bytes.byteLength > maximumJobAuditExportBytes) {
    throw jobAuditResponseInvalid()
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw jobAuditResponseInvalid()
  }
  const artifact = normalizeJobAuditExportArtifact(text, normalized)
  if (artifact === null) throw jobAuditResponseInvalid()
  return {
    blob: new Blob([bytes], { type: expectedContentType }),
    fileName: expectedFileName,
    format: normalized.format,
    byteLength: bytes.byteLength,
    recordCount: artifact.recordCount,
    truncated: artifact.truncated,
    nextCursor: artifact.nextCursor
  }
}

async function jobAuditFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(path, { credentials: 'same-origin', ...init })
  } catch (reason) {
    if (init?.signal?.aborted) throw reason
    throw new ApiError(
      0,
      '无法连接任务审计端点；读取和导出均保持 fail-closed。',
      'JOB_AUDIT_BROWSER_NETWORK_UNAVAILABLE'
    )
  }
}

function normalizeJobPageQuery(value: JobPageQuery): JobPageQuery {
  if (!isRecord(value) || Object.keys(value).some((key) =>
    !['pageSize', 'cursor', 'kind', 'state'].includes(key))) throw jobAuditClientRequestInvalid()
  const result: JobPageQuery = {}
  if (value.pageSize !== undefined) {
    const pageSize = value.pageSize
    if (typeof pageSize !== 'number' || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw jobAuditClientRequestInvalid()
    }
    result.pageSize = pageSize
  }
  if (value.cursor !== undefined) {
    if (!isJobAuditCursor(value.cursor)) throw jobAuditClientRequestInvalid()
    result.cursor = value.cursor
  }
  if (value.kind !== undefined) {
    if (!isJobKind(value.kind)) throw jobAuditClientRequestInvalid()
    result.kind = value.kind
  }
  if (value.state !== undefined) {
    if (!isJobState(value.state)) throw jobAuditClientRequestInvalid()
    result.state = value.state
  }
  return result
}

function normalizeJobAuditExportInput(value: JobAuditExportInput): JobAuditExportInput {
  if (!isRecord(value) || Object.keys(value).some((key) =>
    !['cursor', 'maximumRecords', 'kind', 'state', 'format'].includes(key)) ||
      !isJobAuditExportFormat(value.format)) throw jobAuditClientRequestInvalid()
  const result: JobAuditExportInput = { format: value.format }
  if (value.cursor !== undefined) {
    if (!isJobAuditCursor(value.cursor)) throw jobAuditClientRequestInvalid()
    result.cursor = value.cursor
  }
  if (value.maximumRecords !== undefined) {
    if (!Number.isSafeInteger(value.maximumRecords) ||
        value.maximumRecords < 1 || value.maximumRecords > 1_000) throw jobAuditClientRequestInvalid()
    result.maximumRecords = value.maximumRecords
  }
  if (value.kind !== undefined) {
    if (!isJobKind(value.kind)) throw jobAuditClientRequestInvalid()
    result.kind = value.kind
  }
  if (value.state !== undefined) {
    if (!isJobState(value.state)) throw jobAuditClientRequestInvalid()
    result.state = value.state
  }
  return result
}

function normalizeJobPage(value: unknown): JobPage | null {
  if (!hasExactKeys(value, ['data', 'page']) || !Array.isArray(value.data) ||
      !hasExactKeys(value.page, ['nextCursor']) || !isJobAuditCursorOrNull(value.page.nextCursor)) return null
  const records = value.data.map(normalizeJobRecord)
  if (records.some((record) => record === null)) return null
  return {
    data: records as JobRecord[],
    page: { nextCursor: value.page.nextCursor }
  }
}

function normalizeJobRecord(value: unknown): JobRecord | null {
  if (!hasExactKeys(value, [
    'id', 'kind', 'state', 'actor', 'createdAt', 'startedAt',
    'finishedAt', 'durationMs', 'summary', 'errorCode'
  ])) return null
  if (typeof value.id !== 'string' || !jobAuditUuidPattern.test(value.id) ||
      !isJobKind(value.kind) || !isJobState(value.state) ||
      typeof value.actor !== 'string' || value.actor.length < 1 || value.actor.length > 64 ||
      !/^[A-Za-z][A-Za-z0-9 ._-]*$/.test(value.actor) || !isIsoTimestamp(value.createdAt) ||
      !isIsoTimestampOrNull(value.startedAt) || !isIsoTimestampOrNull(value.finishedAt) ||
      !isNullableBoundedSafeInteger(value.durationMs, 0, 31_536_000_000) ||
      typeof value.summary !== 'string' || value.summary.length < 1 || value.summary.length > 256 ||
      /[\r\n]/.test(value.summary) || !isJobAuditErrorCodeOrNull(value.errorCode)) return null
  return {
    id: value.id,
    kind: value.kind,
    state: value.state,
    actor: value.actor,
    createdAt: value.createdAt,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    durationMs: value.durationMs as number | null,
    summary: value.summary,
    errorCode: value.errorCode
  }
}

function normalizeJobAuditExportPreview(
  value: unknown,
  input: JobAuditExportInput
): JobAuditExportPreview | null {
  if (!hasExactKeys(value, [
    'mode', 'format', 'recordCount', 'byteLength', 'truncated', 'nextCursor',
    'filters', 'requiredConfirmation'
  ]) || value.mode !== 'dry-run' || value.format !== input.format ||
      !isBoundedSafeInteger(value.recordCount, 0, 1_000) ||
      !isBoundedSafeInteger(value.byteLength, 1, maximumJobAuditExportBytes) ||
      typeof value.truncated !== 'boolean' || !isJobAuditCursorOrNull(value.nextCursor) ||
      value.truncated !== (value.nextCursor !== null) ||
      value.requiredConfirmation !== JOB_AUDIT_EXPORT_CONFIRMATION ||
      !hasExactKeys(value.filters, ['kind', 'state']) ||
      !(value.filters.kind === null || isJobKind(value.filters.kind)) ||
      !(value.filters.state === null || isJobState(value.filters.state)) ||
      value.filters.kind !== (input.kind ?? null) || value.filters.state !== (input.state ?? null)) return null
  return {
    mode: 'dry-run',
    format: input.format,
    recordCount: value.recordCount,
    byteLength: value.byteLength,
    truncated: value.truncated,
    nextCursor: value.nextCursor,
    filters: { kind: value.filters.kind, state: value.filters.state },
    requiredConfirmation: JOB_AUDIT_EXPORT_CONFIRMATION
  }
}

function normalizeJobAuditExportArtifact(
  text: string,
  input: JobAuditExportInput
): Pick<JobAuditExportDownload, 'recordCount' | 'truncated' | 'nextCursor'> | null {
  if (!text.endsWith('\n')) return null
  try {
    if (input.format === 'json') {
      return normalizeJobAuditJsonArtifact(JSON.parse(text), input)
    }
    const lines = text.slice(0, -1).split('\n')
    if (lines.length < 1 || lines.some((line) => line.length === 0 || line.includes('\r'))) return null
    const metadata = JSON.parse(lines[0]!) as unknown
    if (!hasExactKeys(metadata, [
      'protocol', 'schemaVersion', 'generatedAt', 'recordCount', 'truncated',
      'nextCursor', 'filters', 'type'
    ]) || metadata.type !== 'metadata') return null
    const jobs = lines.slice(1).map((line) => JSON.parse(line) as unknown)
    if (jobs.some((entry) => !hasExactKeys(entry, ['type', 'data']) ||
      entry.type !== 'job' || normalizeJobRecord(entry.data) === null)) return null
    return normalizeJobAuditArtifactMetadata(metadata, jobs.length, input)
  } catch {
    return null
  }
}

function normalizeJobAuditJsonArtifact(
  value: unknown,
  input: JobAuditExportInput
): Pick<JobAuditExportDownload, 'recordCount' | 'truncated' | 'nextCursor'> | null {
  if (!hasExactKeys(value, [
    'protocol', 'schemaVersion', 'generatedAt', 'recordCount', 'truncated',
    'nextCursor', 'filters', 'records'
  ]) || !Array.isArray(value.records) ||
      value.records.some((record) => normalizeJobRecord(record) === null)) return null
  return normalizeJobAuditArtifactMetadata(value, value.records.length, input)
}

function normalizeJobAuditArtifactMetadata(
  value: Record<string, unknown>,
  actualRecordCount: number,
  input: JobAuditExportInput
): Pick<JobAuditExportDownload, 'recordCount' | 'truncated' | 'nextCursor'> | null {
  if (value.protocol !== 'DYSON_CONTROL_JOB_AUDIT_EXPORT_V1' || value.schemaVersion !== 1 ||
      !isIsoTimestamp(value.generatedAt) ||
      !isBoundedSafeInteger(value.recordCount, 0, input.maximumRecords ?? 1_000) ||
      value.recordCount !== actualRecordCount || typeof value.truncated !== 'boolean' ||
      !isJobAuditCursorOrNull(value.nextCursor) || value.truncated !== (value.nextCursor !== null) ||
      !hasExactKeys(value.filters, ['kind', 'state']) ||
      value.filters.kind !== (input.kind ?? null) || value.filters.state !== (input.state ?? null)) return null
  return {
    recordCount: value.recordCount,
    truncated: value.truncated,
    nextCursor: value.nextCursor
  }
}

function jobAuditHttpError(status: number, body: unknown): ApiError {
  const code = safeJobAuditErrorCode(body)
  const message = status === 400
    ? '任务筛选、游标或导出参数无效；未执行任何导出。'
    : status === 401
      ? '当前会话已失效；任务审计保持只读锁定。'
      : status === 403
        ? '当前会话没有任务审计导出权限。'
        : status === 404
          ? '任务审计端点尚未配置。'
          : status === 413
            ? '审计导出超过固定 2 MiB 上限；请缩小记录数量。'
            : status === 423
              ? '任务审计导出门禁当前关闭；读取仍可继续。'
              : '任务审计服务暂不可用；没有执行下载。'
  return new ApiError(status, message, code)
}

function safeJobAuditErrorCode(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.error) ||
      typeof value.error.code !== 'string' || !jobAuditErrorCodePattern.test(value.error.code)) return null
  return value.error.code
}

function jobAuditClientRequestInvalid(): ApiError {
  return new ApiError(0, '浏览器拒绝了无效的任务审计参数。', 'JOB_AUDIT_BROWSER_REQUEST_INVALID')
}

function jobAuditResponseInvalid(): ApiError {
  return new ApiError(502, '任务审计响应未通过完整性校验。', 'JOB_AUDIT_BROWSER_RESPONSE_INVALID')
}

function isJobKind(value: unknown): value is JobKind {
  return typeof value === 'string' && jobKindSet.has(value)
}

function isJobState(value: unknown): value is JobState {
  return typeof value === 'string' && jobStateSet.has(value)
}

function isJobAuditExportFormat(value: unknown): value is JobAuditExportFormat {
  return value === 'json' || value === 'ndjson'
}

function isJobAuditCursor(value: unknown): value is string {
  return typeof value === 'string' && jobAuditCursorPattern.test(value)
}

function isJobAuditCursorOrNull(value: unknown): value is string | null {
  return value === null || isJobAuditCursor(value)
}

function isJobAuditErrorCodeOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && jobAuditErrorCodePattern.test(value))
}

function isIsoTimestampOrNull(value: unknown): value is string | null {
  return value === null || isIsoTimestamp(value)
}

function isNullableBoundedSafeInteger(
  value: unknown,
  minimum: number,
  maximum: number
): value is number | null {
  return value === null || isBoundedSafeInteger(value, minimum, maximum)
}

async function readCutoverStatus(signal?: AbortSignal): Promise<{ data: CutoverRecoveryStatus }> {
  return cutoverRequest('/api/v1/cutover/status', normalizeCutoverRecoveryStatus, {
    signal,
    cache: 'no-store'
  })
}

async function runCutoverPreview(
  input: CutoverPreviewRequest,
  signal?: AbortSignal
): Promise<{ data: CutoverPreviewReceipt }> {
  const request = normalizeCutoverPreviewRequest(input)
  return cutoverRequest(
    '/api/v1/cutover/preview',
    (value) => normalizeCutoverPreviewReceipt(value, request),
    { method: 'POST', signal, body: JSON.stringify(request) }
  )
}

async function runCutoverPrepare(
  requestId: string,
  planFingerprint: string,
  confirmation: typeof CUTOVER_PREPARE_CONFIRMATION,
  signal?: AbortSignal
): Promise<{ data: CutoverReceipt }> {
  if (confirmation !== CUTOVER_PREPARE_CONFIRMATION) throw cutoverClientRequestInvalid()
  const normalizedRequestId = normalizeCutoverRequestId(requestId)
  const normalizedPlanFingerprint = normalizeCutoverPlanFingerprint(planFingerprint)
  return cutoverRequest('/api/v1/cutover/prepare', (value) => normalizeCutoverReceipt(value, {
    requestId: normalizedRequestId,
    phase: 'prepared',
    statuses: ['succeeded']
  }), {
    method: 'POST',
    signal,
    body: JSON.stringify({
      requestId: normalizedRequestId,
      planFingerprint: normalizedPlanFingerprint,
      confirmation: CUTOVER_PREPARE_CONFIRMATION
    })
  })
}

async function runCutoverActivate(
  requestId: string,
  planFingerprint: string,
  confirmation: typeof CUTOVER_ACTIVATE_CONFIRMATION,
  signal?: AbortSignal
): Promise<{ data: CutoverReceipt }> {
  if (confirmation !== CUTOVER_ACTIVATE_CONFIRMATION) throw cutoverClientRequestInvalid()
  const normalizedRequestId = normalizeCutoverRequestId(requestId)
  const normalizedPlanFingerprint = normalizeCutoverPlanFingerprint(planFingerprint)
  return cutoverRequest('/api/v1/cutover/activate', (value) => normalizeCutoverReceipt(value, {
    requestId: normalizedRequestId,
    phase: 'activated',
    statuses: ['succeeded']
  }), {
    method: 'POST',
    signal,
    body: JSON.stringify({
      requestId: normalizedRequestId,
      planFingerprint: normalizedPlanFingerprint,
      confirmation: CUTOVER_ACTIVATE_CONFIRMATION
    })
  })
}

async function runCutoverRollback(
  requestId: string,
  mode: CutoverRollbackMode,
  planFingerprint: string,
  confirmation: typeof CUTOVER_ROLLBACK_CONFIRMATION,
  signal?: AbortSignal
): Promise<{ data: CutoverReceipt }> {
  if (!isCutoverRollbackMode(mode) || confirmation !== CUTOVER_ROLLBACK_CONFIRMATION) {
    throw cutoverClientRequestInvalid()
  }
  const normalizedRequestId = normalizeCutoverRequestId(requestId)
  const normalizedPlanFingerprint = normalizeCutoverPlanFingerprint(planFingerprint)
  return cutoverRequest('/api/v1/cutover/rollback', (value) => normalizeCutoverReceipt(value, {
    requestId: normalizedRequestId,
    phase: mode === 'immediate-compensation' ? 'rolled-back-immediate' : 'rolled-back-later',
    statuses: ['rolled-back']
  }), {
    method: 'POST',
    signal,
    body: JSON.stringify({
      requestId: normalizedRequestId,
      mode,
      planFingerprint: normalizedPlanFingerprint,
      confirmation: CUTOVER_ROLLBACK_CONFIRMATION
    })
  })
}

async function runCutoverRecovery(
  requestId: string,
  desired: CutoverDesiredAuthority,
  confirmation: typeof CUTOVER_RECOVERY_CONFIRMATION,
  signal?: AbortSignal
): Promise<{ data: CutoverReceipt }> {
  if (!isCutoverDesiredAuthority(desired) || confirmation !== CUTOVER_RECOVERY_CONFIRMATION) {
    throw cutoverClientRequestInvalid()
  }
  const normalizedRequestId = normalizeCutoverRequestId(requestId)
  return cutoverRequest('/api/v1/cutover/recover', (value) => normalizeCutoverReceipt(value, {
    requestId: normalizedRequestId,
    phase: desired === 'candidate' ? 'recovered-candidate' : 'recovered-previous',
    statuses: desired === 'candidate' ? ['succeeded'] : ['succeeded', 'rolled-back']
  }), {
    method: 'POST',
    signal,
    body: JSON.stringify({
      requestId: normalizedRequestId,
      desired,
      confirmation: CUTOVER_RECOVERY_CONFIRMATION
    })
  })
}

async function cutoverRequest<T>(
  path: string,
  normalize: (value: unknown) => T | null,
  init?: RequestInit
): Promise<{ data: T }> {
  const headers = new Headers(init?.headers)
  if (init?.body) headers.set('Content-Type', 'application/json')
  let response: Response
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers
    })
  } catch (reason) {
    if (init?.signal?.aborted) throw reason
    throw new ApiError(0, '无法连接 Cutover 状态端点；所有切换操作保持锁定。', 'CUTOVER_BROWSER_NETWORK_UNAVAILABLE')
  }

  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const code = safeCutoverFailureCode(body) ?? (
      response.status === 404 ? 'CUTOVER_HTTP_NOT_CONFIGURED' : 'CUTOVER_HTTP_REQUEST_FAILED'
    )
    throw new ApiError(response.status, trustedCutoverErrorMessage(response.status, code), code)
  }
  if (!hasExactKeys(body, ['ok', 'data']) || body.ok !== true) throw cutoverResponseInvalid()
  const data = normalize(body.data)
  if (data === null) throw cutoverResponseInvalid()
  return { data }
}

function normalizeCutoverRequestId(value: string): string {
  if (typeof value !== 'string' || value !== value.trim() || !uuidPattern.test(value)) {
    throw cutoverClientRequestInvalid()
  }
  return value.toLowerCase()
}

function normalizeCutoverPlanFingerprint(value: string): string {
  if (typeof value !== 'string' || value !== value.trim() || !sha256Pattern.test(value)) {
    throw cutoverClientRequestInvalid()
  }
  return value
}

function normalizeCutoverPreviewRequest(value: CutoverPreviewRequest): CutoverPreviewRequest {
  if (!isRecord(value) || typeof value.operation !== 'string') throw cutoverClientRequestInvalid()
  if (value.operation === 'prepare' || value.operation === 'activate') {
    if (!hasExactKeys(value, ['requestId', 'operation'])) throw cutoverClientRequestInvalid()
    return { requestId: normalizeCutoverRequestId(value.requestId), operation: value.operation }
  }
  if (value.operation === 'rollback' && hasExactKeys(value, ['requestId', 'operation', 'mode']) &&
      isCutoverRollbackMode(value.mode)) {
    return {
      requestId: normalizeCutoverRequestId(value.requestId),
      operation: 'rollback',
      mode: value.mode
    }
  }
  throw cutoverClientRequestInvalid()
}

function normalizeCutoverRecoveryStatus(value: unknown): CutoverRecoveryStatus | null {
  if (!hasExactKeys(value, [
    'schemaVersion', 'phase', 'status', 'mutationBlocked', 'recoveryRequired',
    'requestId', 'allowedDesired', 'summary', 'errorCode'
  ])) return null
  const summary = normalizeCutoverSummary(value.summary)
  const allowedDesired = normalizeCutoverAllowedDesired(value.allowedDesired)
  if (value.schemaVersion !== 1 || !isCutoverRecoveryPhase(value.phase) ||
      !isCutoverRecoveryState(value.status) || typeof value.mutationBlocked !== 'boolean' ||
      typeof value.recoveryRequired !== 'boolean' || summary === null || allowedDesired === null ||
      !isSafeCutoverErrorCodeOrNull(value.errorCode) || !isLowercaseUuidOrNull(value.requestId)) {
    return null
  }

  if (value.phase === 'ready') {
    if (value.status !== 'ready' || value.mutationBlocked || value.recoveryRequired ||
        value.requestId !== null || allowedDesired.length !== 0 || value.errorCode !== null) return null
  } else if (value.phase === 'recovery-required') {
    if (!value.mutationBlocked || !value.recoveryRequired || value.requestId === null ||
        !isRecoveryRequiredState(value.status)) return null
  } else if (value.status !== value.phase || !value.mutationBlocked || value.recoveryRequired ||
      value.requestId !== null || allowedDesired.length !== 0) {
    return null
  }

  return {
    schemaVersion: 1,
    phase: value.phase,
    status: value.status,
    mutationBlocked: value.mutationBlocked,
    recoveryRequired: value.recoveryRequired,
    requestId: value.requestId,
    allowedDesired,
    summary,
    errorCode: value.errorCode
  }
}

interface CutoverReceiptExpectation {
  requestId: string
  phase: CutoverReceipt['phase']
  statuses: readonly CutoverReceipt['status'][]
}

function normalizeCutoverReceipt(
  value: unknown,
  expected: CutoverReceiptExpectation
): CutoverReceipt | null {
  if (!hasExactKeys(value, [
    'requestId', 'phase', 'status', 'allowedDesired', 'summary', 'errorCode'
  ])) return null
  const summary = normalizeCutoverSummary(value.summary)
  const allowedDesired = normalizeCutoverAllowedDesired(value.allowedDesired)
  if (!isLowercaseUuid(value.requestId) || !isCutoverPublicPhase(value.phase) ||
      !isCutoverPublicStatus(value.status) || summary === null || allowedDesired === null ||
      !(value.errorCode === null || isCutoverCoreErrorCode(value.errorCode))) return null
  if (value.requestId !== expected.requestId || value.phase !== expected.phase ||
      !expected.statuses.includes(value.status) || value.status === 'failed-safe' ||
      allowedDesired.length !== 0 || value.errorCode !== null) return null
  return {
    requestId: value.requestId,
    phase: value.phase,
    status: value.status,
    allowedDesired,
    summary,
    errorCode: value.errorCode
  }
}

function normalizeCutoverPreviewReceipt(
  value: unknown,
  expected: CutoverPreviewRequest
): CutoverPreviewReceipt | null {
  if (!hasExactKeys(value, [
    'format', 'schemaVersion', 'operation', 'requestId', 'rollbackMode',
    'stateRevision', 'evidenceDigest', 'planFingerprint', 'summary'
  ])) return null
  const summary = normalizeCutoverSummary(value.summary)
  const rollbackMode = expected.operation === 'rollback' ? expected.mode : null
  if (value.format !== 'dyson-control-cutover-preview' || value.schemaVersion !== 1 ||
      value.operation !== expected.operation || value.requestId !== expected.requestId ||
      value.rollbackMode !== rollbackMode || !isLowercaseSha256(value.stateRevision) ||
      !isLowercaseSha256(value.evidenceDigest) || !isLowercaseSha256(value.planFingerprint) ||
      summary === null || summary.reused) return null
  return {
    format: 'dyson-control-cutover-preview',
    schemaVersion: 1,
    operation: expected.operation,
    requestId: expected.requestId,
    rollbackMode,
    stateRevision: value.stateRevision,
    evidenceDigest: value.evidenceDigest,
    planFingerprint: value.planFingerprint,
    summary
  }
}

function normalizeCutoverSummary(value: unknown): CutoverReceipt['summary'] | null {
  const keys = [
    'candidateDefined', 'candidateDisabled', 'previousAuthorityEnabled',
    'candidateAuthorityEnabled', 'previousRuntimeHealthy', 'candidateRuntimeHealthy',
    'processesStopped', 'portClosed', 'uniqueAuthority', 'saveProtected',
    'baselineRestored', 'currentProgressProtected', 'reused'
  ] as const
  if (!hasExactKeys(value, keys) || keys.some((key) => typeof value[key] !== 'boolean')) return null
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as unknown as CutoverReceipt['summary']
}

function normalizeCutoverAllowedDesired(value: unknown): CutoverDesiredAuthority[] | null {
  if (!Array.isArray(value) || value.length > 2 || value.some((item) => !isCutoverDesiredAuthority(item))) {
    return null
  }
  if (new Set(value).size !== value.length) return null
  return [...value]
}

function isCutoverDesiredAuthority(value: unknown): value is CutoverDesiredAuthority {
  return value === 'previous' || value === 'candidate'
}

function isCutoverRollbackMode(value: unknown): value is CutoverRollbackMode {
  return value === 'immediate-compensation' || value === 'later-operator-rollback'
}

function isCutoverPublicPhase(value: unknown): value is CutoverReceipt['phase'] {
  return value === 'prepared' || value === 'activated' || value === 'rolled-back-immediate' ||
    value === 'rolled-back-later' || value === 'recovered-candidate' || value === 'recovered-previous'
}

function isCutoverPublicStatus(value: unknown): value is CutoverReceipt['status'] {
  return value === 'succeeded' || value === 'rolled-back' || value === 'failed-safe'
}

function isCutoverRecoveryPhase(value: unknown): value is CutoverRecoveryStatus['phase'] {
  return value === 'pending' || value === 'reconciling' || value === 'ready' ||
    value === 'recovery-required' || value === 'unavailable'
}

function isCutoverRecoveryState(value: unknown): value is CutoverRecoveryStatus['status'] {
  return value === 'ready' || value === 'interrupted' || value === 'terminal-pending-release' ||
    value === 'evidence-invalid' || value === 'pending' || value === 'reconciling' || value === 'unavailable'
}

function isRecoveryRequiredState(value: unknown): boolean {
  return value === 'interrupted' || value === 'terminal-pending-release' || value === 'evidence-invalid'
}

function isLowercaseUuid(value: unknown): value is string {
  return typeof value === 'string' && value === value.toLowerCase() && uuidPattern.test(value)
}

function isLowercaseUuidOrNull(value: unknown): value is string | null {
  return value === null || isLowercaseUuid(value)
}

function isSafeCutoverErrorCodeOrNull(value: unknown): value is string | null {
  return value === null || isSafeCutoverErrorCode(value)
}

function safeCutoverFailureCode(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.error) || !isSafeCutoverErrorCode(value.error.code)) return null
  return value.error.code
}

function isSafeCutoverErrorCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,127}$/.test(value)
}

function isCutoverCoreErrorCode(value: unknown): value is CutoverErrorCode {
  return typeof value === 'string' && cutoverCoreErrorCodes.has(value as CutoverErrorCode)
}

function cutoverClientRequestInvalid(): ApiError {
  return new ApiError(400, 'Cutover 请求必须只包含有效 UUID、固定操作和精确确认。', 'CUTOVER_BROWSER_REQUEST_INVALID')
}

function cutoverResponseInvalid(): ApiError {
  return new ApiError(502, 'Cutover 响应未通过严格浏览器合同校验；所有切换操作保持锁定。', 'CUTOVER_BROWSER_RESPONSE_INVALID')
}

function trustedCutoverErrorMessage(status: number, code: string): string {
  if (status === 423 && code === 'CUTOVER_HTTP_MUTATION_BUSY') {
    return '已有 Cutover 事务正在处理；重复提交已被拒绝。'
  }
  if (status === 423 && code === 'CUTOVER_HTTP_RECOVERY_MUTATION_DISABLED') {
    return 'Cutover 恢复门禁默认关闭；当前只允许读取恢复状态。'
  }
  if (status === 423) return 'Cutover 普通切换门禁默认关闭；当前只允许读取与预演。'
  if (status === 404) return 'Cutover 控制链未部署或未启用；所有切换操作保持关闭。'
  if (status === 403) return '当前认证角色没有 Cutover 执行权限。'
  if (status === 422) return 'Cutover 请求或精确确认未通过服务端校验。'
  if (status === 409) return 'Cutover 当前阶段与所选操作不一致；请重新读取持久状态。'
  if (status === 503) return 'Cutover 安全终态暂不可证明；请读取恢复状态后再处理。'
  return 'Cutover 请求未完成；所有切换操作保持锁定。'
}

const cutoverCoreErrorCodes = new Set<CutoverErrorCode>([
  'CUTOVER_REQUEST_INVALID',
  'CUTOVER_CONFIRMATION_REQUIRED',
  'CUTOVER_ROLLBACK_CONFIRMATION_REQUIRED',
  'CUTOVER_PREVIEW_REQUIRED',
  'CUTOVER_PREVIEW_CONFLICT',
  'CUTOVER_IDEMPOTENCY_CONFLICT',
  'CUTOVER_NOT_PREPARED',
  'CUTOVER_NOT_CANDIDATE_ACTIVE',
  'CUTOVER_RECOVERY_REQUIRED',
  'CUTOVER_RECOVERY_NOT_REQUIRED',
  'CUTOVER_RECOVERY_TARGET_NOT_ALLOWED',
  'CUTOVER_RECOVERY_EVIDENCE_INVALID',
  'CUTOVER_DURABLE_STATE_INVALID',
  'CUTOVER_DURABLE_STORE_FAILED',
  'CUTOVER_AUTHORITY_DRIFT',
  'CUTOVER_RUNTIME_DRIFT',
  'CUTOVER_PREPARE_INVARIANT_FAILED',
  'CUTOVER_SAVE_PROTECTION_FAILED',
  'CUTOVER_SAVE_RESTORE_FAILED',
  'CUTOVER_STOP_GATE_FAILED',
  'CUTOVER_HEALTH_GATE_FAILED',
  'CUTOVER_UNIQUE_AUTHORITY_FAILED',
  'CUTOVER_ADAPTER_FAILED',
  'CUTOVER_HOST_LEASE_BUSY',
  'CUTOVER_HOST_LEASE_DIRTY',
  'CUTOVER_HOST_LEASE_RECOVERY_REQUIRED',
  'CUTOVER_HOST_LEASE_RECOVERY_NOT_REQUIRED',
  'CUTOVER_HOST_LEASE_RECOVERY_MISMATCH',
  'CUTOVER_HOST_LEASE_LOST',
  'CUTOVER_HOST_LEASE_UNAVAILABLE'
])

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
  'simulation.tps-coverage', 'simulation.tps-floor',
  'host.cpu-coverage', 'host.cpu-p95',
  'host.per-core-coverage', 'host.hottest-core-saturation',
  'process.multicore-coverage', 'process.single-core-bottleneck',
  'host.memory-coverage', 'host.memory-peak',
  'storage.project-coverage', 'storage.project-peak-used', 'storage.project-minimum-free',
  'storage.save-coverage', 'storage.save-peak-used', 'storage.save-minimum-free',
  'storage.dependency-classification',
  'storage.project-root-coverage', 'storage.project-root-available',
  'storage.smb-mapping-coverage', 'storage.smb-mapping-available',
  'storage.recovery-task-coverage', 'storage.recovery-task-healthy'
] as const satisfies readonly QualificationCheckId[]

const qualificationCoverageCheckIds = new Set<QualificationCheckId>([
  'simulation.ups-coverage', 'simulation.tps-coverage',
  'host.cpu-coverage', 'host.per-core-coverage',
  'process.multicore-coverage', 'host.memory-coverage',
  'storage.project-coverage', 'storage.save-coverage',
  'storage.dependency-classification', 'storage.project-root-coverage',
  'storage.smb-mapping-coverage', 'storage.recovery-task-coverage'
])

const coverageContract: QualificationCheckContract = Object.freeze({
  mode: 'coverage',
  observedKeys: ['value', 'observedSamples', 'totalSamples'],
  required: { minimumRatio: 0.95 }
})

const exactCoverageContract: QualificationCheckContract = Object.freeze({
  mode: 'coverage',
  observedKeys: ['value', 'observedSamples', 'totalSamples'],
  required: { minimumRatio: 1 }
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
  'simulation.tps-coverage': coverageContract,
  'simulation.tps-floor': {
    mode: 'ratio-minimum', observedKeys: ['value', 'p05', 'median'],
    required: { minimumRatio: 0.95, minimumTps: 55 }
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
  'storage.save-minimum-free': { mode: 'minimum', observedKeys: ['value'], required: { minimum: 10_737_418_240 } },
  'storage.dependency-classification': exactCoverageContract,
  'storage.project-root-coverage': exactCoverageContract,
  'storage.project-root-available': { mode: 'ratio-minimum', observedKeys: ['value'], required: { minimumRatio: 1 } },
  'storage.smb-mapping-coverage': exactCoverageContract,
  'storage.smb-mapping-available': { mode: 'ratio-minimum', observedKeys: ['value'], required: { minimumRatio: 1 } },
  'storage.recovery-task-coverage': exactCoverageContract,
  'storage.recovery-task-healthy': { mode: 'ratio-minimum', observedKeys: ['value'], required: { minimumRatio: 1 } }
}

const qualificationSmbConditionalCheckIds = new Set<QualificationCheckId>([
  'storage.smb-mapping-coverage', 'storage.smb-mapping-available',
  'storage.recovery-task-coverage', 'storage.recovery-task-healthy'
])

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
  if (!hasExactKeys(meta, ['provider', 'environment', 'capacity', 'longWindowCapacity'])
      || !['demo', 'windows'].includes(String(meta.provider))
      || !['development', 'test', 'production'].includes(String(meta.environment))
      || !isBoundedSafeInteger(meta.capacity, 1, 1_000_000)
      || !isBoundedSafeInteger(meta.longWindowCapacity, 0, 86_400)) return null
  if (!hasExactKeys(report, [
    'schemaVersion', 'kind', 'profileId', 'result', 'generatedAt', 'from', 'to',
    'sampleCount', 'spanMs', 'checks', 'continuity72h', 'latency', 'remainingEvidence'
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
  const continuity72h = parseLongWindowReport(report.continuity72h, meta.longWindowCapacity)
  const latency = parseServerReceiptLatencyReport(report.latency)
  if (continuity72h === null || latency === null) return null

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
      continuity72h,
      latency,
      remainingEvidence: [...qualificationRemainingEvidence]
    },
    meta: {
      provider: meta.provider as 'demo' | 'windows',
      environment: meta.environment as 'development' | 'test' | 'production',
      capacity: meta.capacity,
      longWindowCapacity: meta.longWindowCapacity
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
  if (qualificationSmbConditionalCheckIds.has(expectedId)
      && hasExactKeys(value.observed, ['mode'])
      && hasExactKeys(value.required, ['storageDependencyKind'])) {
    if (value.status !== 'pass' || value.observed.mode !== 'not-applicable'
        || value.required.storageDependencyKind !== 'smb-global-mapping') return null
    return {
      id: expectedId,
      status: 'pass',
      message: value.message,
      observed: { mode: 'not-applicable' },
      required: { storageDependencyKind: 'smb-global-mapping' }
    }
  }
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
  if (id === 'simulation.ups-floor' || id === 'simulation.tps-floor') {
    return isNullableBoundedNumber(value, 0, 1)
      && isNullableBoundedNumber(observed.p05, 0, 10_000)
      && isNullableBoundedNumber(observed.median, 0, 10_000)
      && (value === null ? observed.p05 === null && observed.median === null
        : observed.p05 !== null && observed.median !== null)
  }
  if (id === 'runtime.running-coverage' || id === 'health.critical-ratio'
      || id === 'host.hottest-core-saturation' || id === 'process.single-core-bottleneck'
      || id === 'storage.project-root-available' || id === 'storage.smb-mapping-available'
      || id === 'storage.recovery-task-healthy') {
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

const longWindowCheckIds = [
  'window.samples', 'window.duration', 'window.maximum-gap',
  'runtime.source-stable', 'runtime.identity-stable',
  'runtime.running', 'runtime.game-port-listening',
  'storage.dependency-kind-stable', 'storage.dependency-classified',
  'storage.project-root-available', 'storage.smb-mapping-available',
  'storage.recovery-task-healthy'
] as const satisfies readonly ObservabilityLongWindowCheckId[]

function parseLongWindowReport(value: unknown, capacity: number): ObservabilityLongWindowReport | null {
  if (!hasExactKeys(value, [
    'schemaVersion', 'kind', 'result', 'chainIntegrity', 'sampleCount',
    'from', 'to', 'spanMs', 'checks'
  ]) || value.schemaVersion !== 1 || value.kind !== 'dyson-observability-72h-continuity-report'
      || !isQualificationStatus(value.result)
      || !['verified', 'unknown'].includes(String(value.chainIntegrity))
      || !isBoundedSafeInteger(value.sampleCount, 0, capacity)
      || !isBoundedSafeInteger(value.spanMs, 0, 31_536_000_000)
      || !Array.isArray(value.checks) || value.checks.length !== longWindowCheckIds.length) return null
  if (value.sampleCount === 0) {
    if (value.from !== null || value.to !== null || value.spanMs !== 0 || value.chainIntegrity !== 'unknown') return null
  } else {
    if (!isIsoTimestamp(value.from) || !isIsoTimestamp(value.to)
        || Math.max(0, Date.parse(value.to) - Date.parse(value.from)) !== value.spanMs
        || value.chainIntegrity !== 'verified') return null
  }
  const checks: ObservabilityLongWindowCheck[] = []
  for (let index = 0; index < longWindowCheckIds.length; index++) {
    const parsed = parseLongWindowCheck(value.checks[index], longWindowCheckIds[index]!)
    if (parsed === null) return null
    checks.push(parsed)
  }
  const samplesCheck = checks.find((check) => check.id === 'window.samples')
  const durationCheck = checks.find((check) => check.id === 'window.duration')
  if (samplesCheck?.observed.value !== value.sampleCount
      || durationCheck?.observed.value !== value.spanMs) return null
  const expected: QualificationStatus = checks.some((check) => check.status === 'insufficient')
    ? 'insufficient'
    : checks.some((check) => check.status === 'fail') ? 'fail' : 'pass'
  if (value.result !== expected) return null
  return {
    schemaVersion: 1,
    kind: 'dyson-observability-72h-continuity-report',
    result: value.result,
    chainIntegrity: value.chainIntegrity as 'verified' | 'unknown',
    sampleCount: value.sampleCount,
    from: value.from as string | null,
    to: value.to as string | null,
    spanMs: value.spanMs,
    checks
  }
}

function parseLongWindowCheck(
  value: unknown,
  id: ObservabilityLongWindowCheckId
): ObservabilityLongWindowCheck | null {
  if (!hasExactKeys(value, ['id', 'status', 'observed', 'required'])
      || value.id !== id || !isQualificationStatus(value.status)
      || !hasExactKeys(value.observed, ['value'])) return null
  const observed = value.observed.value
  let required: Record<string, number | boolean>
  let expected: QualificationStatus
  if (id === 'window.samples' || id === 'window.duration') {
    const minimum = id === 'window.samples' ? 17_281 : 259_200_000
    if (!hasExactKeys(value.required, ['minimum']) || value.required.minimum !== minimum
        || !isBoundedSafeInteger(observed, 0, Number.MAX_SAFE_INTEGER)) return null
    required = { minimum }
    expected = observed >= minimum ? 'pass' : 'insufficient'
  } else if (id === 'window.maximum-gap') {
    if (!hasExactKeys(value.required, ['maximum']) || value.required.maximum !== 30_000
        || !(observed === null || isBoundedSafeInteger(observed, 1, Number.MAX_SAFE_INTEGER))) return null
    required = { maximum: 30_000 }
    expected = observed === null ? 'insufficient' : observed <= 30_000 ? 'pass' : 'fail'
  } else if (id === 'runtime.source-stable' || id === 'runtime.identity-stable'
      || id === 'storage.dependency-kind-stable') {
    if (!hasExactKeys(value.required, ['exact']) || value.required.exact !== 1
        || !isBoundedSafeInteger(observed, 0, Number.MAX_SAFE_INTEGER)) return null
    required = { exact: 1 }
    expected = observed === 0 ? 'insufficient' : observed === 1 ? 'pass' : 'fail'
  } else {
    if (!hasExactKeys(value.required, ['exact']) || value.required.exact !== true
        || typeof observed !== 'boolean') return null
    required = { exact: true }
    expected = observed ? 'pass' : 'fail'
  }
  if (value.status !== expected) return null
  return { id, status: value.status, observed: { value: observed }, required }
}

function parseServerReceiptLatencyReport(value: unknown): ServerReceiptLatencyReport | null {
  if (!hasExactKeys(value, [
    'schemaVersion', 'kind', 'evidenceStatus', 'generatedAt', 'scannedJobs',
    'truncated', 'save', 'backup'
  ]) || value.schemaVersion !== 1 || value.kind !== 'dyson-server-receipt-latency-report'
      || !['unknown', 'not-qualified'].includes(String(value.evidenceStatus))
      || !isIsoTimestamp(value.generatedAt) || !isBoundedSafeInteger(value.scannedJobs, 0, 5_000)
      || typeof value.truncated !== 'boolean'
      || (value.truncated && value.scannedJobs !== 5_000)) return null
  const save = parseOperationLatencySummary(value.save, 'save')
  const backup = parseOperationLatencySummary(value.backup, 'backup')
  if (save === null || backup === null) return null
  const expectedStatus = value.truncated || save.totalReceipts + backup.totalReceipts === 0
    ? 'unknown'
    : 'not-qualified'
  if (value.evidenceStatus !== expectedStatus) return null
  return {
    schemaVersion: 1,
    kind: 'dyson-server-receipt-latency-report',
    evidenceStatus: expectedStatus,
    generatedAt: value.generatedAt,
    scannedJobs: value.scannedJobs,
    truncated: value.truncated,
    save,
    backup
  }
}

function parseOperationLatencySummary(
  value: unknown,
  operation: 'save' | 'backup'
): OperationLatencySummary | null {
  if (!hasExactKeys(value, [
    'operation', 'evidenceStatus', 'totalReceipts', 'successfulReceipts',
    'failedReceipts', 'incompleteReceipts', 'p50Ms', 'p95Ms', 'maximumMs'
  ]) || value.operation !== operation
      || !['unknown', 'not-qualified'].includes(String(value.evidenceStatus))) return null
  if (!isBoundedSafeInteger(value.totalReceipts, 0, 100_000)
      || !isBoundedSafeInteger(value.successfulReceipts, 0, 100_000)
      || !isBoundedSafeInteger(value.failedReceipts, 0, 100_000)
      || !isBoundedSafeInteger(value.incompleteReceipts, 0, 100_000)) return null
  const totalReceipts = value.totalReceipts
  const successfulReceipts = value.successfulReceipts
  const failedReceipts = value.failedReceipts
  const incompleteReceipts = value.incompleteReceipts
  if (totalReceipts !== successfulReceipts + failedReceipts + incompleteReceipts) return null
  const durations = [value.p50Ms, value.p95Ms, value.maximumMs]
  if (!durations.every((duration) => duration === null
      || isBoundedSafeInteger(duration, 0, Number.MAX_SAFE_INTEGER))) return null
  if (successfulReceipts === 0) {
    if (durations.some((duration) => duration !== null)) return null
  } else if (durations.some((duration) => duration === null)
      || (value.p50Ms as number) > (value.p95Ms as number)
      || (value.p95Ms as number) > (value.maximumMs as number)) return null
  const evidenceStatus = totalReceipts === 0 ? 'unknown' : 'not-qualified'
  if (value.evidenceStatus !== evidenceStatus) return null
  return {
    operation,
    evidenceStatus,
    totalReceipts,
    successfulReceipts,
    failedReceipts,
    incompleteReceipts,
    p50Ms: value.p50Ms as number | null,
    p95Ms: value.p95Ms as number | null,
    maximumMs: value.maximumMs as number | null
  }
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

async function saveJobRequest(path: string, init?: RequestInit): Promise<{ data: SaveJobExecutionResult }> {
  const payload = await request<{ data: unknown }>(path, init)
  const parsed = normalizeSaveJobExecutionEnvelope(payload)
  if (parsed === null) {
    throw new ApiError(
      502,
      '存档任务响应未通过浏览器合同校验；恢复控制保持锁定。',
      'SAVE_JOB_BROWSER_RESPONSE_INVALID'
    )
  }
  return parsed
}

async function previewPlayerNotice(
  input: PlayerNoticePreviewInput,
  signal?: AbortSignal
): Promise<{ data: { job: JobRecord; plan: PlayerNoticePlan } }> {
  if (!isPlayerNoticePreviewInput(input)) {
    throw new ApiError(400, '玩家通知浏览器请求未通过固定字段校验。', 'PLAYER_NOTICE_BROWSER_REQUEST_INVALID')
  }
  const payload = await request<unknown>('/api/v1/players/notice/preview', {
    method: 'POST', signal, body: JSON.stringify(input)
  })
  const parsed = normalizePlayerNoticePreviewEnvelope(payload, input)
  if (parsed === null) {
    throw new ApiError(502, '玩家通知预演响应未通过浏览器合同校验。', 'PLAYER_NOTICE_BROWSER_RESPONSE_INVALID')
  }
  return parsed
}

async function executePlayerNotice(
  input: PlayerNoticePreviewInput & {
    requestId: string
    confirmation: 'EXECUTE'
    expectedTargetJoinedAtUnixMs?: number
  },
  signal?: AbortSignal
): Promise<{ data: { job: JobRecord; receipt: PlayerNoticeReceipt } }> {
  if (!isPlayerNoticePreviewInput({
    rosterGeneration: input.rosterGeneration,
    rosterSequence: input.rosterSequence,
    sessionPlayerId: input.sessionPlayerId,
    templateId: input.templateId
  }) || !uuidPattern.test(input.requestId) || input.confirmation !== 'EXECUTE') {
    throw new PlayerNoticeApiError(
      400, '玩家通知浏览器执行请求无效。', 'PLAYER_NOTICE_BROWSER_REQUEST_INVALID'
    )
  }

  if (input.expectedTargetJoinedAtUnixMs !== undefined &&
      (!Number.isSafeInteger(input.expectedTargetJoinedAtUnixMs) || input.expectedTargetJoinedAtUnixMs <= 0)) {
    throw new PlayerNoticeApiError(
      400, '玩家通知目标会话时间无效。', 'PLAYER_NOTICE_BROWSER_REQUEST_INVALID'
    )
  }
  const { expectedTargetJoinedAtUnixMs: _expectedTargetJoinedAtUnixMs, ...wireInput } = input
  const response = await fetch('/api/v1/players/notice', {
    credentials: 'same-origin',
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(wireInput)
  })
  const payload = await response.json().catch(() => null) as unknown
  const parsed = normalizePlayerNoticeExecutionEnvelope(payload, input)
  if (parsed !== null) {
    if (!response.ok) {
      throw new PlayerNoticeApiError(
        response.status,
        `玩家通知终止：${parsed.data.receipt.state}`,
        parsed.data.receipt.errorCode,
        parsed.data
      )
    }
    return parsed
  }
  if (!response.ok && isApiErrorEnvelope(payload)) {
    throw new PlayerNoticeApiError(
      response.status,
      payload.error.message ?? `HTTP ${response.status}`,
      payload.error.code ?? null
    )
  }
  throw new PlayerNoticeApiError(
    502,
    '玩家通知执行响应未通过浏览器合同校验；结果保持未知。',
    'PLAYER_NOTICE_BROWSER_RESPONSE_INVALID'
  )
}

async function readPlayerNoticeReceipt(
  input: PlayerNoticePreviewInput & { requestId: string; expectedTargetJoinedAtUnixMs?: number },
  signal?: AbortSignal
): Promise<{ data: { receipt: PlayerNoticeReceipt } }> {
  if (!isPlayerNoticePreviewInput({
    rosterGeneration: input.rosterGeneration,
    rosterSequence: input.rosterSequence,
    sessionPlayerId: input.sessionPlayerId,
    templateId: input.templateId
  }) || !uuidPattern.test(input.requestId) ||
      (input.expectedTargetJoinedAtUnixMs !== undefined &&
       (!Number.isSafeInteger(input.expectedTargetJoinedAtUnixMs) || input.expectedTargetJoinedAtUnixMs <= 0))) {
    throw new ApiError(
      400,
      '玩家通知回执查询参数未通过固定字段校验。',
      'PLAYER_NOTICE_BROWSER_REQUEST_INVALID'
    )
  }
  const payload = await request<unknown>(
    `/api/v1/players/notice/receipts/${encodeURIComponent(input.requestId.toLowerCase())}`,
    { signal, cache: 'no-store' }
  )
  const parsed = normalizePlayerNoticeReceiptEnvelope(payload, input)
  if (parsed === null) {
    throw new ApiError(
      502,
      '玩家通知回执未通过浏览器合同校验；请求继续保持锁定。',
      'PLAYER_NOTICE_BROWSER_RESPONSE_INVALID'
    )
  }
  return parsed
}

function isApiErrorEnvelope(value: unknown): value is {
  error: { code?: string; message?: string }
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const error = (value as Record<string, unknown>).error
  return typeof error === 'object' && error !== null && !Array.isArray(error)
}

async function reconcileSaveJob(
  jobId: string,
  confirmation: typeof SAVE_JOB_RECONCILE_CONFIRMATION,
  signal?: AbortSignal
): Promise<{ data: SaveJobExecutionResult }> {
  if (!uuidPattern.test(jobId) || confirmation !== SAVE_JOB_RECONCILE_CONFIRMATION) {
    throw new ApiError(
      400,
      '存档对账只接受有效作业 UUID 与精确确认词。',
      'SAVE_JOB_BROWSER_REQUEST_INVALID'
    )
  }
  return saveJobRequest(`/api/v1/saves/jobs/${encodeURIComponent(jobId)}/reconcile`, {
    method: 'POST',
    signal,
    body: JSON.stringify({ confirmation })
  })
}

const savePairTransferMediaType = 'application/vnd.dyson-control.save-pair'
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const sha256Pattern = /^[0-9a-f]{64}$/
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

async function previewSavePairPromotion(
  requestId: string,
  importRequestId: string,
  signal?: AbortSignal
): Promise<{ data: SavePairPromotionPlan }> {
  const input = normalizeSavePairPromotionRequest(requestId, importRequestId)
  const data = await savePairPromotionRequest(
    '/api/v1/saves/transfers/promotions/preview',
    input,
    signal
  )
  const plan = normalizeSavePairPromotionPlan(data, input)
  if (plan === null) throw savePairPromotionResponseInvalid()
  return { data: plan }
}

async function executeSavePairPromotion(
  requestId: string,
  importRequestId: string,
  confirmation: typeof SAVE_PAIR_PROMOTION_CONFIRMATION,
  signal?: AbortSignal
): Promise<{ data: SavePairPromotionReceipt }> {
  if (confirmation !== SAVE_PAIR_PROMOTION_CONFIRMATION) {
    throw savePairPromotionClientRequestInvalid()
  }
  const input = normalizeSavePairPromotionRequest(requestId, importRequestId)
  const data = await savePairPromotionRequest(
    '/api/v1/saves/transfers/promotions/execute',
    { ...input, confirmation: SAVE_PAIR_PROMOTION_CONFIRMATION },
    signal
  )
  const receipt = normalizeSavePairPromotionReceipt(data, input)
  if (receipt === null) throw savePairPromotionResponseInvalid()
  return { data: receipt }
}

function normalizeSavePairPromotionRequest(
  requestId: string,
  importRequestId: string
): { requestId: string; importRequestId: string } {
  if (requestId !== requestId.trim() || importRequestId !== importRequestId.trim() ||
      !uuidPattern.test(requestId) || !uuidPattern.test(importRequestId)) {
    throw savePairPromotionClientRequestInvalid()
  }
  return { requestId: requestId.toLowerCase(), importRequestId: importRequestId.toLowerCase() }
}

async function savePairPromotionRequest(
  path: '/api/v1/saves/transfers/promotions/preview' | '/api/v1/saves/transfers/promotions/execute',
  body: Record<string, string>,
  signal?: AbortSignal
): Promise<unknown> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    signal,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const parsed: unknown = await response.json().catch(() => null)
  if (!response.ok) throw savePairPromotionHttpError(response.status, parsed)
  if (!hasExactKeys(parsed, ['data'])) throw savePairPromotionResponseInvalid()
  return parsed.data
}

function normalizeSavePairPromotionPlan(
  value: unknown,
  expected: { requestId: string; importRequestId: string }
): SavePairPromotionPlan | null {
  const keys = [
    'format', 'schemaVersion', 'mode', 'requestId', 'importRequestId', 'inboxId', 'backupId',
    'saveName', 'sourceArchiveSha256', 'dsvBytes', 'serverBytes', 'requiredBytes',
    'availableBytes', 'allowed', 'blockers', 'reused', 'requiredConfirmation', 'effects',
    'executionEnabled'
  ] as const
  if (!hasExactKeys(value, keys) || value.format !== 'dyson-control-save-promotion-plan' ||
      value.schemaVersion !== 1 || value.mode !== 'dry-run' ||
      value.requestId !== expected.requestId || value.importRequestId !== expected.importRequestId ||
      value.inboxId !== `import-${expected.importRequestId}` || value.backupId !== `tx-${expected.requestId}` ||
      !isSavePromotionName(value.saveName) || !isLowercaseSha256(value.sourceArchiveSha256) ||
      !isPositiveSafeInteger(value.dsvBytes) || !isPositiveSafeInteger(value.serverBytes) ||
      !isPositiveSafeInteger(value.requiredBytes) ||
      !(value.availableBytes === null || isBoundedSafeInteger(value.availableBytes, 0, Number.MAX_SAFE_INTEGER)) ||
      typeof value.allowed !== 'boolean' || !Array.isArray(value.blockers) || value.blockers.length > 2 ||
      value.blockers.some((blocker) => blocker !== 'space-insufficient' && blocker !== 'space-unavailable') ||
      new Set(value.blockers).size !== value.blockers.length || typeof value.reused !== 'boolean' ||
      value.requiredConfirmation !== SAVE_PAIR_PROMOTION_CONFIRMATION ||
      typeof value.executionEnabled !== 'boolean' || !hasExactKeys(value.effects, [
        'quarantinePreserved', 'verifiedBackupCreated', 'liveSaveChanged', 'restoreExecuted'
      ]) || value.effects.quarantinePreserved !== true || value.effects.liveSaveChanged !== false ||
      value.effects.restoreExecuted !== false || typeof value.effects.verifiedBackupCreated !== 'boolean' ||
      value.effects.verifiedBackupCreated !== !value.reused ||
      value.allowed !== (value.reused || value.blockers.length === 0)) {
    return null
  }
  return value as unknown as SavePairPromotionPlan
}

function normalizeSavePairPromotionReceipt(
  value: unknown,
  expected: { requestId: string; importRequestId: string }
): SavePairPromotionReceipt | null {
  const keys = [
    'format', 'schemaVersion', 'operation', 'requestId', 'importRequestId', 'inboxId', 'backupId',
    'saveName', 'sourceArchiveSha256', 'manifestSha256', 'dsvBytes', 'serverBytes', 'completedAt',
    'restoreExecuted', 'reused'
  ] as const
  if (!hasExactKeys(value, keys) || value.format !== 'dyson-control-save-promotion-receipt' ||
      value.schemaVersion !== 1 || value.operation !== 'promote-import' ||
      value.requestId !== expected.requestId || value.importRequestId !== expected.importRequestId ||
      value.inboxId !== `import-${expected.importRequestId}` || value.backupId !== `tx-${expected.requestId}` ||
      !isSavePromotionName(value.saveName) || !isLowercaseSha256(value.sourceArchiveSha256) ||
      !isLowercaseSha256(value.manifestSha256) || !isPositiveSafeInteger(value.dsvBytes) ||
      !isPositiveSafeInteger(value.serverBytes) || !isIsoTimestamp(value.completedAt) ||
      value.restoreExecuted !== false || typeof value.reused !== 'boolean') {
    return null
  }
  return value as unknown as SavePairPromotionReceipt
}

function isSavePromotionName(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && value.length >= 1 && value.length <= 120 &&
    !/[\u0000-\u001f\u007f]/.test(value)
}

function isLowercaseSha256(value: unknown): value is string {
  return typeof value === 'string' && saveTransferSha256Pattern.test(value) && value === value.toLowerCase()
}

function savePairPromotionClientRequestInvalid(): ApiError {
  return new ApiError(
    400,
    '存档晋升只接受两个有效 UUID；服务器路径、URL 和命令不会被提交。',
    'SAVE_PROMOTION_CLIENT_REQUEST_INVALID'
  )
}

function savePairPromotionResponseInvalid(): ApiError {
  return new ApiError(
    502,
    '存档晋升响应未通过客户端固定合同校验。',
    'SAVE_PROMOTION_RESPONSE_INVALID'
  )
}

function savePairPromotionHttpError(status: number, body: unknown): ApiError {
  const code = isRecord(body) && isRecord(body.error) && typeof body.error.code === 'string' &&
    jobAuditErrorCodePattern.test(body.error.code) ? body.error.code : null
  return new ApiError(status, savePairPromotionErrorMessage(status, code), code)
}

function savePairPromotionErrorMessage(status: number, code: string | null): string {
  if (status === 403) return '当前会话没有将隔离存档晋升为已验证保护点的权限。'
  if (status === 423 && code === 'SAVE_TRANSFER_DISABLED') {
    return '存档传输写入门禁仍关闭；预演可读，但晋升执行保持锁定。'
  }
  if (status === 423) return '另一项主机变更或恢复门禁正在占用；晋升保持锁定。'
  if (status === 409) return '隔离存档、目标保护点或 request ID 绑定已变化；请重新生成预演。'
  if (status === 422) return '隔离存档、manifest、配对文件或 SHA-256 未通过服务端验证。'
  if (status === 400) return '存档晋升请求未通过固定 UUID 与确认词校验。'
  if (status === 503) return '存档晋升服务或固定数据根暂不可用；不会尝试绕过门禁。'
  return '存档晋升请求未完成；不会尝试绕过服务端门禁。'
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

const qualifiedClientArtifactContract: Record<QualifiedClientArtifactKind, {
  fileName: string
  mediaType: 'application/zip' | 'application/json'
  route: 'archive' | 'client' | 'runtime'
}> = {
  profile: { fileName: 'dyson-qualified-client-profile.zip', mediaType: 'application/zip', route: 'archive' },
  client: { fileName: 'dyson-qualified-nebula-client.zip', mediaType: 'application/zip', route: 'client' },
  runtime: { fileName: 'qualified-client-runtime.json', mediaType: 'application/json', route: 'runtime' }
}

async function downloadQualifiedClientArtifact(
  downloadId: string,
  kind: QualifiedClientArtifactKind,
  expected: { sha256: string; sizeBytes: number }
): Promise<QualifiedClientArtifactDownload> {
  const contract = qualifiedClientArtifactContract[kind]
  const response = await fetch(`/api/v2/client-profile/${contract.route}/${encodeURIComponent(downloadId)}`, {
    method: 'GET', credentials: 'same-origin', cache: 'no-store'
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null
    throw new ApiError(response.status, body?.error?.message ?? `HTTP ${response.status}`, body?.error?.code ?? null)
  }

  const sha256 = response.headers.get('X-Dyson-Content-SHA256') ?? ''
  const expectedSha256 = expected.sha256.startsWith('sha256:') ? expected.sha256.slice(7) : expected.sha256
  const contentLength = response.headers.get('Content-Length')
  const disposition = response.headers.get('Content-Disposition') ?? ''
  const fileName = disposition.match(/filename="([A-Za-z0-9._-]+)"/)?.[1] ?? ''
  const contentType = response.headers.get('Content-Type')?.split(';', 1)[0]?.toLowerCase() ?? ''
  const cacheDirectives = (response.headers.get('Cache-Control') ?? '').toLowerCase()
    .split(',').map((value) => value.trim())
  const blob = await response.blob()
  const sizeBytes = contentLength === null ? Number.NaN : Number(contentLength)
  if (contentType !== contract.mediaType || fileName !== contract.fileName ||
      !/^[0-9a-f]{64}$/.test(sha256) || sha256 !== expectedSha256 ||
      !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes !== blob.size ||
      sizeBytes !== expected.sizeBytes || !cacheDirectives.includes('no-store') ||
      response.headers.get('X-Content-Type-Options')?.toLowerCase() !== 'nosniff') {
    throw new ApiError(502, '资格客户端制品响应未通过签发回执绑定校验', 'QUALIFIED_CLIENT_ARTIFACT_RESPONSE_INVALID')
  }
  return { blob, fileName, sha256, sizeBytes, kind }
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

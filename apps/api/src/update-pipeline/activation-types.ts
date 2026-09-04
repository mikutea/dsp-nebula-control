import type { CompatibilityDecision } from '../updates/compatibility.js'
import type {
  HostMutationOperationCoordinator,
  HostMutationRecoveryOperationCoordinator,
  HostMutationOperationScope
} from '../host-mutation/operation-coordinator.js'
import type { TrustedCompatibilityAssertion } from './trusted-compatibility.js'
import { UpdatePipelineError } from './errors.js'

export type UpdateActivationComponent = 'dsp' | ManagedUpdateComponent
export type ManagedUpdateComponent = 'nebula' | 'bepinex' | 'bridge' | 'control'

/**
 * The request deliberately contains no path, URL, executable, argument, or
 * credential field. Artifact bytes must already exist in OfflineArtifactStager.
 */
export interface UpdateActivationRequest {
  requestId: string
  component: UpdateActivationComponent
  artifactId?: string | null
  sha256?: string | null
  targetVersion: string
  expectedRevision: string
  /** Opaque UUID issued by the server-owned compatibility evidence service. */
  compatibilityReceiptId?: string
}

export interface StoppedStateCheckRequest {
  requestId: string
  component: ManagedUpdateComponent
  phase: 'before-protection' | 'before-publish' | 'before-rollback'
}

export interface StoppedStateProof {
  processStopped: boolean
  portClosed: boolean
}

export interface SaveProtectionPointRequest {
  requestId: string
  purpose: 'component-update'
  component: ManagedUpdateComponent
  targetVersion: string
  expectedRevision: string
}

export interface SaveProtectionPointReceipt {
  requestId: string
  status: 'succeeded'
  backupId: string
  /** Digest of the canonical paired .dsv/.server protection manifest. */
  manifestSha256: string
  /** Opaque digest identity of the protected paired save. */
  saveIdentity: string
  pairProtected: true
  durable: true
}

export interface ComponentUpdateRollbackBaselineRequest {
  requestId: string
  component: ManagedUpdateComponent
  targetVersion: string
  expectedRevision: string
}

/**
 * Private durable rollback binding. Values are opaque identities or digests;
 * no path, command, account material, save name, or configuration content may
 * cross this adapter boundary.
 */
export interface ComponentUpdateRollbackBaseline {
  configurationSnapshotId: string
  configurationRevision: string
  serverModLockSha256: string
  serverModLockRevision: string
  previousLoadedSaveIdentity: string
}

export interface ComponentUpdateRollbackBinding extends ComponentUpdateRollbackBaseline {
  protectionBackupId: string
  protectionManifestSha256: string
  bindingSha256: string
}

export interface ComponentUpdateRollbackRestoreRequest {
  requestId: string
  component: ManagedUpdateComponent
  binding: ComponentUpdateRollbackBinding
}

/** Fresh read-back of every non-component rollback surface. */
export interface ComponentUpdateRollbackReadback {
  configurationSnapshotId: string
  configurationRevision: string
  serverModLockSha256: string
  serverModLockRevision: string
  protectionManifestSha256: string
  loadedSaveIdentity: string
}

export interface ComponentUpdateRollbackStepReceipt {
  restored: true
  rereadVerified: true
}

export interface FixedUpdateSmokeRequest {
  requestId: string
  component: ManagedUpdateComponent
  phase: 'candidate' | 'rollback' | 'reconcile-candidate'
  expectedVersion: string | null
  expectedReleaseId: string | null
  /** Exact opaque save identity captured before publication. */
  expectedLoadedSaveIdentity: string
}

export interface FixedUpdateSmokeResult {
  component: ManagedUpdateComponent
  observedVersion: string | null
  versionMatches: boolean
  bepInExLoaded: boolean
  nebulaLoaded: boolean
  processHealthy: boolean
  portHealthy: boolean
  /** One opaque identity for the process start generation under test. */
  startupGenerationId: string | null
  /** Must equal startupGenerationId and come from the signed Bridge heartbeat. */
  bridgeHeartbeatGenerationId: string | null
  /** Must equal startupGenerationId and come from the current-generation load log. */
  loadedSaveLogGenerationId: string | null
  /** Exact opaque save identity parsed from that current-generation load log. */
  loadedSaveIdentity: string | null
}

export interface ComponentUpdateActivationAdapters {
  verifyStoppedState(
    request: StoppedStateCheckRequest,
    hostMutation: HostMutationOperationScope
  ): Promise<StoppedStateProof>
  createSaveProtectionPoint(
    request: SaveProtectionPointRequest,
    hostMutation: HostMutationOperationScope
  ): Promise<SaveProtectionPointReceipt>
  /** Optional at construction so read-only preview remains available; execute fails closed when absent. */
  captureRollbackBaseline?(
    request: ComponentUpdateRollbackBaselineRequest,
    hostMutation: HostMutationOperationScope
  ): Promise<ComponentUpdateRollbackBaseline>
  restoreRollbackConfiguration?(
    request: ComponentUpdateRollbackRestoreRequest,
    hostMutation: HostMutationOperationScope
  ): Promise<ComponentUpdateRollbackStepReceipt>
  restoreRollbackServerModLock?(
    request: ComponentUpdateRollbackRestoreRequest,
    hostMutation: HostMutationOperationScope
  ): Promise<ComponentUpdateRollbackStepReceipt>
  restoreRollbackPairedSave?(
    request: ComponentUpdateRollbackRestoreRequest,
    hostMutation: HostMutationOperationScope
  ): Promise<ComponentUpdateRollbackStepReceipt>
  inspectRollbackReadback?(
    request: ComponentUpdateRollbackRestoreRequest,
    hostMutation: HostMutationOperationScope
  ): Promise<ComponentUpdateRollbackReadback>
  smoke(
    request: FixedUpdateSmokeRequest,
    hostMutation: HostMutationOperationScope
  ): Promise<FixedUpdateSmokeResult>
}

export interface ComponentUpdateActivationOptions extends ComponentUpdateActivationAdapters {
  projectRoot: string
  stagingRoot: string
  /** Fixed construction-time live component roots; HTTP requests never select them. */
  liveComponentRoots: FixedLiveComponentRoots
  compatibilityVerifier: {
    assertCurrent(receiptId: unknown, candidate: unknown): Promise<TrustedCompatibilityAssertion>
  }
  /**
   * Shared host-wide mutation coordinator. Execute/reconcile fail closed when
   * it is absent; read-only preview and inspection remain available.
   */
  hostMutationCoordinator?: HostMutationOperationCoordinator
  /**
   * Explicit administrator-triggered recovery capability. It is deliberately
   * separate from the ordinary coordinator so startup reconciliation cannot
   * acquire a recovery lease implicitly.
   */
  hostMutationRecoveryCoordinator?: HostMutationRecoveryOperationCoordinator
  maximumArchiveBytes?: number
  maximumFileBytes?: number
  maximumExpandedBytes?: number
  maximumFiles?: number
  maximumHistoryEntries?: number
  now?: () => Date
}

export interface FixedLiveComponentRoots {
  nebula: string
  bepinex: string
  bridge: string
  control: string
}

export interface ComponentArchiveFileSummary {
  relativePath: string
  sizeBytes: number
}

export interface ComponentArchiveSummary {
  component: ManagedUpdateComponent
  version: string
  artifactId: string
  fileCount: number
  expandedBytes: number
  files: ComponentArchiveFileSummary[]
}

export interface ComponentUpdateActivationPlan {
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
  compatibility: CompatibilityDecision
  operations: readonly [
    'acquire-global-update-lock',
    'verify-staged-artifact-and-archive',
    'assemble-immutable-release',
    'prove-process-stopped-and-port-closed',
    'capture-config-mod-lock-and-loaded-save-baseline',
    'create-paired-save-protection-point',
    'bind-rollback-context-journal',
    'revalidate-stop-revision-and-compatibility',
    'publish-and-verify-fixed-live-component',
    'run-fixed-health-check',
    'restore-component-config-mod-lock-and-paired-save-on-failure',
    'prove-current-generation-exact-save-load',
    'persist-audit-safe-receipt',
    'release-global-update-lock'
  ]
  rollback: {
    automatic: true
    previousReleaseRequired: boolean
    recoveryRequiredIfUnproven: true
  }
}

export type ComponentUpdateReceiptStatus = 'succeeded' | 'failed' | 'rolled-back' | 'rollback-failed'

export type ComponentUpdateRollbackStepStatus = 'not-required' | 'pending' | 'verified' | 'failed'

export interface ComponentUpdateRollbackSteps {
  component: ComponentUpdateRollbackStepStatus
  configuration: ComponentUpdateRollbackStepStatus
  serverModLock: ComponentUpdateRollbackStepStatus
  pairedSave: ComponentUpdateRollbackStepStatus
  previousSaveLoad: ComponentUpdateRollbackStepStatus
}

/** Audit-safe receipt: no filesystem path, artifact digest, command, URL, or secret. */
export interface ComponentUpdateActivationReceipt {
  format: 'dyson-control-component-update-receipt'
  schemaVersion: 1
  requestId: string
  component: ManagedUpdateComponent
  artifactId: string
  compatibilityReceiptId: string
  targetVersion: string
  releaseId: string
  status: ComponentUpdateReceiptStatus
  previousRevision: string
  resultingRevision: string
  protectionBackupId: string | null
  /** Canonical digest over the private journal rollback binding; never a path or secret. */
  rollbackBindingSha256: string | null
  rollbackSteps: ComponentUpdateRollbackSteps
  failureCode: string | null
  rollbackVerified: boolean
  recoveryRequired: boolean
  fileCount: number
  expandedBytes: number
  completedAt: string
  reused: boolean
}

export interface ActiveComponentSummary {
  component: ManagedUpdateComponent
  version: string
  artifactId: string
  releaseId: string
}

export interface ComponentUpdateStateSummary {
  revision: string
  recoveryRequired: boolean
  components: ActiveComponentSummary[]
  historyEntries: number
}

export interface ComponentUpdateCleanupCandidate {
  kind: 'history' | 'release'
  opaqueId: string
  recoverable: true
  reason: 'history-retention-exceeded' | 'unreferenced-release'
}

export interface ComponentUpdateCleanupPlan {
  format: 'dyson-control-component-update-cleanup-plan'
  schemaVersion: 1
  dryRun: true
  executeSupported: false
  candidates: ComponentUpdateCleanupCandidate[]
}

export class ComponentUpdateActivationError extends UpdatePipelineError {
  readonly receipt: ComponentUpdateActivationReceipt | null

  constructor(code: string, options?: ErrorOptions & { receipt?: ComponentUpdateActivationReceipt | null }) {
    // Filesystem and adapter errors can contain fixed paths or provider detail.
    // Keep the public error intentionally code-only; the persisted receipt is
    // likewise bounded and audit-safe.
    super(code)
    this.name = 'ComponentUpdateActivationError'
    this.receipt = options?.receipt ?? null
  }
}

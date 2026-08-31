import type { CompatibilityDecision } from '../updates/compatibility.js'
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
  pairProtected: true
  durable: true
}

export interface FixedUpdateSmokeRequest {
  requestId: string
  component: ManagedUpdateComponent
  phase: 'candidate' | 'rollback' | 'reconcile-candidate'
  expectedVersion: string | null
  expectedReleaseId: string | null
}

export interface FixedUpdateSmokeResult {
  component: ManagedUpdateComponent
  observedVersion: string | null
  versionMatches: boolean
  bepInExLoaded: boolean
  nebulaLoaded: boolean
  processHealthy: boolean
  portHealthy: boolean
}

export interface ComponentUpdateActivationAdapters {
  verifyStoppedState(request: StoppedStateCheckRequest): Promise<StoppedStateProof>
  createSaveProtectionPoint(request: SaveProtectionPointRequest): Promise<SaveProtectionPointReceipt>
  smoke(request: FixedUpdateSmokeRequest): Promise<FixedUpdateSmokeResult>
}

export interface ComponentUpdateActivationOptions extends ComponentUpdateActivationAdapters {
  projectRoot: string
  stagingRoot: string
  /** Fixed construction-time live component roots; HTTP requests never select them. */
  liveComponentRoots: FixedLiveComponentRoots
  compatibilityVerifier: {
    assertCurrent(receiptId: unknown, candidate: unknown): Promise<TrustedCompatibilityAssertion>
  }
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
    'create-paired-save-protection-point',
    'revalidate-stop-revision-and-compatibility',
    'publish-and-verify-fixed-live-component',
    'run-fixed-health-check',
    'rollback-and-verify-on-failure',
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

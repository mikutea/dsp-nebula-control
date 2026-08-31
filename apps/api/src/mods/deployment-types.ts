import type { ClientParityManifest, ServerModLock } from './manifest.js'
import type { ModPlatformLock } from './platform-lock.js'

export const MAX_STAGED_MOD_FILES = 128
export const MAX_STAGED_MOD_FILE_BYTES = 512 * 1024 * 1024
export const MAX_STAGED_MOD_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
export const MAX_DEPLOYED_MOD_TOTAL_BYTES = 8 * 1024 * 1024 * 1024
export const MAX_MOD_DEPLOYMENT_MANIFEST_BYTES = 2 * 1024 * 1024
export const DEFAULT_MOD_DEPLOYMENT_HISTORY_PAGE_SIZE = 20
export const MAX_MOD_DEPLOYMENT_HISTORY_PAGE_SIZE = 100
export const MAX_MOD_DEPLOYMENT_RECEIPT_ENTRIES = 10_000
export const MAX_MOD_DEPLOYMENT_HISTORY_CURSOR_LENGTH = 160

export type ModDeploymentOperation = 'install' | 'update' | 'enable' | 'disable' | 'remove'

export interface ModDeploymentRequest {
  requestId: string
  operation: ModDeploymentOperation
  package: {
    dependencyId: string
    version: string
  }
  manifest: {
    serverLock: ServerModLock
    clientParity: ClientParityManifest
    platformLock: ModPlatformLock
  }
  expectedRevision: string
}

export interface StagedModPackageFile {
  relativePath: string
  sizeBytes: number
  sha256: string
}

export interface StagedModPackageManifest {
  format: 'dyson-control-staged-mod-package'
  schemaVersion: 1
  dependencyId: string
  sourceId: string
  version: string
  dependencies: string[]
  files: StagedModPackageFile[]
}

export interface ModStoppedStateProof {
  processStopped: boolean
  portClosed: boolean
}

export interface ModDeploymentStatePackage {
  dependencyId: string
  sourceId: string
  version: string
  enabled: boolean
  clientRequirement: 'required' | 'optional' | 'not-required'
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

export type ModDeploymentReceiptStatus = 'succeeded' | 'rolled-back' | 'rollback-failed'

export interface ModDeploymentReceipt {
  format: 'dyson-control-mod-deployment-receipt'
  schemaVersion: 1
  requestId: string
  operation: ModDeploymentOperation
  package: { dependencyId: string; version: string }
  status: ModDeploymentReceiptStatus
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

export interface ModDeploymentReceiptHistoryQuery {
  cursor?: string | null
  pageSize?: number
}

export interface ModDeploymentReceiptHistoryItem {
  persistedAt: string
  receipt: ModDeploymentReceipt
}

export interface ModDeploymentReceiptHistoryPage {
  format: 'dyson-control-mod-deployment-receipt-history'
  schemaVersion: 1
  order: 'persisted-at-descending'
  items: ModDeploymentReceiptHistoryItem[]
  page: {
    limit: number
    returned: number
    totalReceipts: number
    nextCursor: string | null
  }
}

export interface ModDeploymentCleanupCandidate {
  id: string
  kind: 'snapshot' | 'failed-publication' | 'abandoned-pending'
}

export interface ModDeploymentCleanupPlan {
  dryRun: true
  irreversible: true
  executeSupported: false
  candidates: ModDeploymentCleanupCandidate[]
}

export type ModDeploymentFaultPhase = 'after-pending-built' | 'after-snapshot' | 'after-publish'

export interface ModDeploymentServiceOptions {
  stagingRoot: string
  pluginsRoot: string
  verifyStoppedState: () => Promise<ModStoppedStateProof>
  readPlatformInventory?: () => Promise<{
    inventoryRevision: string
    inventory: { nebula: string; bepInEx: string }
  }>
  maxSnapshots?: number
  faultInjector?: (phase: ModDeploymentFaultPhase) => void | Promise<void>
  now?: () => Date
}

export type ModDeploymentErrorCode =
  | 'MOD_DEPLOYMENT_REQUEST_INVALID'
  | 'MOD_DEPLOYMENT_RECEIPT_REQUEST_INVALID'
  | 'MOD_DEPLOYMENT_HISTORY_REQUEST_INVALID'
  | 'MOD_DEPLOYMENT_HISTORY_CURSOR_INVALID'
  | 'MOD_DEPLOYMENT_ROOT_INVALID'
  | 'MOD_DEPLOYMENT_ROOT_LINK_REJECTED'
  | 'MOD_DEPLOYMENT_PATH_ESCAPE'
  | 'MOD_DEPLOYMENT_BUSY'
  | 'MOD_DEPLOYMENT_REVISION_CONFLICT'
  | 'MOD_DEPLOYMENT_IDEMPOTENCY_CONFLICT'
  | 'MOD_DEPLOYMENT_RECOVERY_REQUIRED'
  | 'MOD_DEPLOYMENT_UNMANAGED_CONTENT'
  | 'MOD_DEPLOYMENT_STATE_INVALID'
  | 'MOD_DEPLOYMENT_MANIFEST_INVALID'
  | 'MOD_DEPLOYMENT_MANIFEST_STATE_MISMATCH'
  | 'MOD_DEPLOYMENT_PLATFORM_LOCK_INVALID'
  | 'MOD_DEPLOYMENT_PLATFORM_INVENTORY_UNAVAILABLE'
  | 'MOD_DEPLOYMENT_PLATFORM_INVENTORY_DRIFT'
  | 'MOD_DEPLOYMENT_PLATFORM_VERSION_MISMATCH'
  | 'MOD_DEPLOYMENT_TARGET_MISSING'
  | 'MOD_DEPLOYMENT_TARGET_MISMATCH'
  | 'MOD_DEPLOYMENT_ALREADY_INSTALLED'
  | 'MOD_DEPLOYMENT_NOT_INSTALLED'
  | 'MOD_DEPLOYMENT_ALREADY_ENABLED'
  | 'MOD_DEPLOYMENT_ALREADY_DISABLED'
  | 'MOD_DEPLOYMENT_NO_CHANGE'
  | 'MOD_DEPLOYMENT_DEPENDENCY_MISSING'
  | 'MOD_DEPLOYMENT_DEPENDENT_ACTIVE'
  | 'MOD_DEPLOYMENT_SOURCE_CONFLICT'
  | 'MOD_DEPLOYMENT_STAGING_MISSING'
  | 'MOD_DEPLOYMENT_STAGING_INVALID'
  | 'MOD_DEPLOYMENT_PAYLOAD_NAME_INVALID'
  | 'MOD_DEPLOYMENT_PAYLOAD_TYPE_INVALID'
  | 'MOD_DEPLOYMENT_PAYLOAD_COUNT_INVALID'
  | 'MOD_DEPLOYMENT_PAYLOAD_TOO_LARGE'
  | 'MOD_DEPLOYMENT_PAYLOAD_TAMPERED'
  | 'MOD_DEPLOYMENT_STOP_GATE_REJECTED'
  | 'MOD_DEPLOYMENT_SNAPSHOT_LIMIT'
  | 'MOD_DEPLOYMENT_EXECUTION_FAILED'
  | 'MOD_DEPLOYMENT_ROLLBACK_FAILED'

export class ModDeploymentError extends Error {
  readonly code: ModDeploymentErrorCode

  constructor(code: ModDeploymentErrorCode) {
    super(code)
    this.name = 'ModDeploymentError'
    this.code = code
  }
}

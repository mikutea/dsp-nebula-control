import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import {
  lstat,
  open,
  readdir,
  realpath,
  type FileHandle
} from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { GameConfigHistoryStopProofTokenProvider } from '../game-config/history-http.js'
import {
  GameConfigHistoryService,
  type GameConfigStopProofValidator
} from '../game-config/history.js'
import type {
  GameRuntimeReceiptSource,
  PublicGameRuntimeReceipt
} from '../lifecycle/game-runtime-receipts.js'
import {
  HostMutationOperationCoordinatorError,
  type HostMutationOperationCoordinator,
  type HostMutationOperationOutcome,
  type HostMutationOperationRequest,
  type HostMutationOperationScope
} from '../host-mutation/operation-coordinator.js'
import type { ModDeploymentService } from '../mods/deployment.js'
import type { ModDeploymentStateSummary } from '../mods/deployment-types.js'
import { protectionReferenceToBackupId } from '../saves/retention-protection-source.js'
import {
  MAX_MANIFEST_BYTES,
  backupManifestV1Schema,
  type BackupManifestV1
} from '../saves/schemas.js'
import {
  SaveTransactionService,
  type RuntimeStoppedEvidence
} from '../saves/transactions.js'
import type {
  ComponentUpdateRollbackBaselineRequest,
  ComponentUpdateRollbackRestoreRequest,
  FixedUpdateSmokeRequest
} from '../update-pipeline/activation-types.js'
import type { SteamManualHandoffRequest } from '../update-pipeline/steam-manual-handoff.js'
import { normalizeVersion } from '../updates/version.js'
import type {
  WindowsSteamManualHandoffTransactionProvider as WindowsSteamManualHandoffTransactionPort,
  WindowsUpdateActivationTransactionProvider as WindowsUpdateActivationTransactionPort
} from './windows-update-activation.js'
import type { WindowsRuntimeCompatibilitySource } from './windows-runtime-compatibility.js'
import type {
  AcceptedWindowsUpdateRuntimeEvidence,
  WindowsUpdateRuntimeEvidenceSource
} from './windows-update-runtime-evidence.js'

const fixedSaveName = '_lastexit_'
const requestIdSchema = z.string().uuid().transform((value) => value.toLowerCase())
const canonicalGuidSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
)
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
const versionSchema = z.string().trim().min(1).max(64)
const componentSchema = z.enum(['nebula', 'bepinex', 'bridge', 'control'])
const protectionReferenceSchema = z.string().regex(
  /^(?:save:|tx-)[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
)

const baselineRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  component: componentSchema,
  targetVersion: versionSchema,
  expectedRevision: sha256Schema
})
const protectionRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  backupId: protectionReferenceSchema
})
const rollbackBindingSchema = z.strictObject({
  previousComponentVersion: versionSchema.nullable().optional(),
  configurationSnapshotId: requestIdSchema,
  configurationRevision: sha256Schema,
  serverModLockSha256: sha256Schema,
  serverModLockRevision: sha256Schema,
  previousLoadedSaveIdentity: sha256Schema,
  protectionBackupId: protectionReferenceSchema,
  protectionManifestSha256: sha256Schema,
  bindingSha256: sha256Schema
})
const rollbackRestoreSchema = z.strictObject({
  requestId: requestIdSchema,
  component: componentSchema,
  binding: rollbackBindingSchema
})
const smokeRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  component: componentSchema,
  phase: z.enum(['candidate', 'rollback', 'reconcile-candidate']),
  expectedVersion: versionSchema.nullable(),
  expectedReleaseId: z.string().min(1).max(128).nullable(),
  expectedLoadedSaveIdentity: sha256Schema
})
const steamRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  targetVersion: versionSchema,
  expectedRevision: sha256Schema
})
const steamSampleRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  targetVersion: versionSchema
})
const steamLoadRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  targetVersion: versionSchema,
  expectedLoadedSaveIdentity: sha256Schema
})
const runtimeEvidenceSchema: z.ZodType<AcceptedWindowsUpdateRuntimeEvidence> = z.strictObject({
  processId: z.number().int().positive(),
  processStartedAtUnixMs: z.number().int().positive(),
  bridgeStartedAtUnixMs: z.number().int().positive(),
  loadedSaveObservedAtUnixMs: z.number().int().positive(),
  writtenAtUnixMs: z.number().int().positive(),
  startedAt: z.string().datetime({ offset: true }),
  startupGenerationId: sha256Schema,
  bridgeHeartbeatGenerationId: sha256Schema,
  loadedSaveLogGenerationId: sha256Schema,
  loadedSaveIdentity: sha256Schema
})
const runtimeReceiptSchema: z.ZodType<PublicGameRuntimeReceipt> = z.strictObject({
  protocol: z.literal('DYSON_CONTROL_GAME_RUNTIME_RECEIPT_V1'),
  schemaVersion: z.literal(1),
  attemptId: canonicalGuidSchema,
  bindingId: canonicalGuidSchema.nullable(),
  version: versionSchema.nullable(),
  outcome: z.enum(['clean-exit', 'abnormal-exit', 'startup-failure', 'finalization-failure']),
  errorCode: z.string().min(1).max(128).nullable(),
  restartExpected: z.boolean(),
  startedAt: z.string().min(1).max(64),
  publishedAt: z.string().min(1).max(64).nullable(),
  completedAt: z.string().min(1).max(64),
  projectRootIdentityVerified: z.boolean(),
  dataRootIdentityVerified: z.literal(true),
  receiptSha256: sha256Schema
})
const stoppedEvidenceSchema: z.ZodType<RuntimeStoppedEvidence> = z.strictObject({
  protocol: z.literal('DYSON_CONTROL_RUNTIME_V1'),
  expected: z.literal('stopped'),
  state: z.literal('matched'),
  processVerified: z.literal(true),
  gamePortListening: z.literal(false)
})
const modStateSchema: z.ZodType<ModDeploymentStateSummary> = z.strictObject({
  revision: sha256Schema,
  packages: z.array(z.strictObject({
    dependencyId: z.string().min(1).max(256),
    sourceId: z.string().min(1).max(256),
    version: versionSchema,
    enabled: z.boolean(),
    clientRequirement: z.enum(['required', 'optional', 'not-required'])
  })).max(512),
  enabledCount: z.number().int().nonnegative().max(512),
  disabledCount: z.number().int().nonnegative().max(512)
})

export interface WindowsUpdateTransactionProviderOptions {
  readPreviousComponentVersion?: (component: FixedUpdateSmokeRequest['component'], signal: AbortSignal) => Promise<string | null>
  /** Only trusted construction selects this root; requests cannot override it. */
  projectRoot: string
  configStopProof: {
    issue: GameConfigHistoryStopProofTokenProvider
    validate: GameConfigStopProofValidator
  }
  /** Existing fixed lifecycle-broker stopped proof used by SaveTransactionService. */
  verifyServiceStopped(signal?: AbortSignal): Promise<unknown>
  /** Existing fixed-root managed deployment authority. */
  modDeploymentService: Pick<ModDeploymentService, 'inspect'>
  /** Fixed-file, HMAC-authenticated runtime evidence reader. */
  runtimeEvidenceSource: WindowsUpdateRuntimeEvidenceSource
  /** Fresh trusted inventory evaluated against the configured reviewed policy. */
  runtimeCompatibilitySource: WindowsRuntimeCompatibilitySource
  /** Fixed runtime-bootstrap receipt reader used to bind stopped baselines. */
  gameRuntimeReceiptSource: Pick<GameRuntimeReceiptSource, 'list'>
}

export class WindowsUpdateTransactionProviderError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'WindowsUpdateTransactionProviderError'
    this.code = code
  }
}

/**
 * Production transaction authority for component activation. Every filesystem
 * location is derived from one construction-time project root. The provider
 * never executes a process and accepts no path, command, credential or Steam
 * account material. It also implements the official-Steam manual extension.
 */
export class WindowsUpdateActivationTransactionProvider implements
  WindowsUpdateActivationTransactionPort,
  WindowsSteamManualHandoffTransactionPort {
  readonly #projectRoot: string
  readonly #configRoot: string
  readonly #backupRoot: string
  readonly #configStopProof: WindowsUpdateTransactionProviderOptions['configStopProof']
  readonly #verifyServiceStopped: WindowsUpdateTransactionProviderOptions['verifyServiceStopped']
  readonly #saveTransactions: SaveTransactionService
  readonly #modDeploymentService: WindowsUpdateTransactionProviderOptions['modDeploymentService']
  readonly #runtimeEvidenceSource: WindowsUpdateRuntimeEvidenceSource
  readonly #runtimeCompatibilitySource: WindowsRuntimeCompatibilitySource
  readonly #readPreviousComponentVersion: WindowsUpdateTransactionProviderOptions['readPreviousComponentVersion']
  readonly #gameRuntimeReceiptSource: WindowsUpdateTransactionProviderOptions['gameRuntimeReceiptSource']

  constructor(options: WindowsUpdateTransactionProviderOptions) {
    if (!options || !isSafeAbsoluteRoot(options.projectRoot) ||
        typeof options.configStopProof?.issue !== 'function' ||
        typeof options.configStopProof?.validate !== 'function' ||
        typeof options.verifyServiceStopped !== 'function' ||
        typeof options.modDeploymentService?.inspect !== 'function' ||
        typeof options.runtimeEvidenceSource?.readCurrentRuntimeEvidence !== 'function' ||
        typeof options.runtimeEvidenceSource?.readPersistedRuntimeEvidence !== 'function' ||
        typeof options.runtimeCompatibilitySource?.inspect !== 'function' ||
        typeof options.gameRuntimeReceiptSource?.list !== 'function' ||
        (options.readPreviousComponentVersion !== undefined && typeof options.readPreviousComponentVersion !== 'function')) {
      throw new WindowsUpdateTransactionProviderError('WINDOWS_UPDATE_TRANSACTION_OPTIONS_INVALID')
    }
    this.#projectRoot = path.resolve(options.projectRoot)
    this.#configRoot = path.join(this.#projectRoot, 'server', 'BepInEx', 'config')
    this.#backupRoot = path.join(this.#projectRoot, 'backups', 'saves')
    this.#configStopProof = options.configStopProof
    this.#verifyServiceStopped = options.verifyServiceStopped
    this.#saveTransactions = new SaveTransactionService({
      saveRoot: path.join(this.#projectRoot, 'userdata', 'Save'),
      backupRoot: this.#backupRoot,
      verifyServiceStopped: options.verifyServiceStopped
    })
    this.#modDeploymentService = options.modDeploymentService
    this.#runtimeEvidenceSource = options.runtimeEvidenceSource
    this.#runtimeCompatibilitySource = options.runtimeCompatibilitySource
    this.#readPreviousComponentVersion = options.readPreviousComponentVersion
    this.#gameRuntimeReceiptSource = options.gameRuntimeReceiptSource
  }

  async captureRollbackBaseline(
    input: Readonly<ComponentUpdateRollbackBaselineRequest>,
    hostMutation: HostMutationOperationScope
  ): Promise<unknown> {
    hostMutation.assertActive()
    const request = parse(baselineRequestSchema, input, 'WINDOWS_UPDATE_TRANSACTION_REQUEST_INVALID')
    try {
      await assertNormalDirectory(this.#projectRoot, 'WINDOWS_UPDATE_TRANSACTION_ROOT_INVALID')
      await this.#proveStopped(hostMutation.signal)
      hostMutation.assertActive()
      const history = this.#history(hostMutation, deriveRequestId(request.requestId, 'config-capture'))
      const configuration = await history.capture()
      hostMutation.assertActive()
      const configurationReadback = await history.diff(configuration.snapshotId)
      if (configurationReadback.targetRevision !== configuration.revision ||
          configurationReadback.currentRevision !== configuration.revision) {
        throw new WindowsUpdateTransactionProviderError('WINDOWS_UPDATE_CONFIGURATION_SNAPSHOT_DRIFT')
      }
      const modLock = await this.#inspectStableModLock()
      const save = await this.#inspectFixedSave()
      await this.#proveStopped(hostMutation.signal)
      const loaded = await this.#readPersistedEvidence(hostMutation)
      const receipt = await this.#latestRuntimeReceipt()
      assertStoppedRuntimeBinding(loaded, receipt)
      const previousComponentVersion = this.#readPreviousComponentVersion === undefined
        ? undefined
        : versionSchema.nullable().parse(await this.#readPreviousComponentVersion(request.component, hostMutation.signal))
      if (loaded.loadedSaveIdentity !== save.identity) {
        throw new WindowsUpdateTransactionProviderError('WINDOWS_UPDATE_STOPPED_SAVE_BINDING_MISMATCH')
      }
      await this.#proveStopped(hostMutation.signal)
      hostMutation.assertActive()
      return {
        ...(previousComponentVersion === undefined ? {} : { previousComponentVersion: previousComponentVersion === null
          ? null : normalizeVersion(previousComponentVersion, request.component === 'bepinex' ? 'bepinex' : request.component === 'nebula' ? 'nebula' : 'plugin') }),
        configurationSnapshotId: configuration.snapshotId,
        configurationRevision: configuration.revision,
        serverModLockSha256: modLock.sha256,
        serverModLockRevision: modLock.revision,
        previousLoadedSaveIdentity: save.identity
      }
    } catch (error) {
      hostMutation.assertActive()
      throw providerError(error, 'WINDOWS_UPDATE_ROLLBACK_BASELINE_UNAVAILABLE')
    }
  }

  async inspectProtectionPoint(
    input: Readonly<{ requestId: string; backupId: string }>,
    hostMutation: HostMutationOperationScope
  ): Promise<unknown> {
    hostMutation.assertActive()
    const request = parse(protectionRequestSchema, input, 'WINDOWS_UPDATE_TRANSACTION_REQUEST_INVALID')
    try {
      const binding = await inspectProtectionBinding(this.#backupRoot, request.backupId)
      hostMutation.assertActive()
      return { manifestSha256: binding.manifestSha256, saveIdentity: binding.saveIdentity }
    } catch (error) {
      hostMutation.assertActive()
      throw providerError(error, 'WINDOWS_UPDATE_PROTECTION_POINT_INVALID')
    }
  }

  async restoreConfiguration(
    input: Readonly<ComponentUpdateRollbackRestoreRequest>,
    hostMutation: HostMutationOperationScope
  ): Promise<unknown> {
    hostMutation.assertActive()
    const request = parse(rollbackRestoreSchema, input, 'WINDOWS_UPDATE_TRANSACTION_REQUEST_INVALID')
    const restoreRequestId = deriveRequestId(request.requestId, 'config-restore')
    try {
      const history = this.#history(hostMutation, restoreRequestId)
      const before = await history.diff(request.binding.configurationSnapshotId)
      if (before.targetRevision !== request.binding.configurationRevision) {
        throw new WindowsUpdateTransactionProviderError('WINDOWS_UPDATE_CONFIGURATION_SNAPSHOT_MISMATCH')
      }
      if (before.currentRevision !== request.binding.configurationRevision) {
        const stopProofToken = await this.#configStopProof.issue({
          operation: 'restore',
          requestId: restoreRequestId,
          snapshotId: request.binding.configurationSnapshotId,
          expectedCurrentRevision: before.currentRevision,
          dryRun: false
        })
        hostMutation.assertActive()
        const receipt = await history.restore({
          requestId: restoreRequestId,
          snapshotId: request.binding.configurationSnapshotId,
          expectedCurrentRevision: before.currentRevision,
          stopProofToken,
          dryRun: false
        })
        if (receipt.status !== 'restored' || receipt.finalRevision !== request.binding.configurationRevision ||
            receipt.targetRevision !== request.binding.configurationRevision || !receipt.persisted) {
          throw new WindowsUpdateTransactionProviderError('WINDOWS_UPDATE_CONFIGURATION_RESTORE_FAILED')
        }
      }
      const after = await history.diff(request.binding.configurationSnapshotId)
      if (after.targetRevision !== request.binding.configurationRevision ||
          after.currentRevision !== request.binding.configurationRevision) {
        throw new WindowsUpdateTransactionProviderError('WINDOWS_UPDATE_CONFIGURATION_REREAD_MISMATCH')
      }
      hostMutation.assertActive()
      return verifiedReceipt()
    } catch (error) {
      hostMutation.assertActive()
      throw providerError(error, 'WINDOWS_UPDATE_CONFIGURATION_RESTORE_FAILED')
    }
  }

  async restoreServerModLock(
    input: Readonly<ComponentUpdateRollbackRestoreRequest>,
    hostMutation: HostMutationOperationScope
  ): Promise<unknown> {
    hostMutation.assertActive()
    const request = parse(rollbackRestoreSchema, input, 'WINDOWS_UPDATE_TRANSACTION_REQUEST_INVALID')
    try {
      // Component publication must never mutate the independently managed mod
      // tree. The existing mod authority has no restore-to-arbitrary-lock API,
      // so unchanged state is the only auditable successful rollback outcome.
      const current = await this.#inspectStableModLock()
      if (current.sha256 !== request.binding.serverModLockSha256 ||
          current.revision !== request.binding.serverModLockRevision) {
        throw new WindowsUpdateTransactionProviderError('WINDOWS_UPDATE_MOD_LOCK_DRIFT_UNRESTORABLE')
      }
      hostMutation.assertActive()
      return verifiedReceipt()
    } catch (error) {
      hostMutation.assertActive()
      throw providerError(error, 'WINDOWS_UPDATE_MOD_LOCK_RESTORE_FAILED')
    }
  }

  async restorePairedSave(
    input: Readonly<ComponentUpdateRollbackRestoreRequest>,
    hostMutation: HostMutationOperationScope
  ): Promise<unknown> {
    hostMutation.assertActive()
    const request = parse(rollbackRestoreSchema, input, 'WINDOWS_UPDATE_TRANSACTION_REQUEST_INVALID')
    try {
      const source = await inspectProtectionBinding(
        this.#backupRoot,
        request.binding.protectionBackupId
      )
      if (source.manifestSha256 !== request.binding.protectionManifestSha256 ||
          source.saveIdentity !== request.binding.previousLoadedSaveIdentity) {
        throw new WindowsUpdateTransactionProviderError('WINDOWS_UPDATE_SAVE_BINDING_MISMATCH')
      }
      const before = await this.#inspectFixedSave()
      if (before.identity !== request.binding.previousLoadedSaveIdentity) {
        const restoreRequestId = deriveRequestId(request.requestId, 'paired-save-restore')
        const protectionRequestId = deriveRequestId(request.requestId, 'paired-save-protection')
        const result = await this.#saveTransactions.restore({
          requestId: restoreRequestId,
          backupId: source.backupId,
          expectedRevision: before.revision,
          protectionRequestId,
          dryRun: false
        }, hostMutation)
        if (result.status !== 'succeeded' || result.rollback === 'failed' ||
            result.cleanupPending || result.maintenanceRequired || !result.auditStored ||
            result.afterRevision !== `pair-v1:${request.binding.previousLoadedSaveIdentity}`) {
          throw new WindowsUpdateTransactionProviderError('WINDOWS_UPDATE_SAVE_RESTORE_FAILED')
        }
      }
      const after = await this.#inspectFixedSave()
      if (after.identity !== request.binding.previousLoadedSaveIdentity) {
        throw new WindowsUpdateTransactionProviderError('WINDOWS_UPDATE_SAVE_REREAD_MISMATCH')
      }
      hostMutation.assertActive()
      return verifiedReceipt()
    } catch (error) {
      hostMutation.assertActive()
      throw providerError(error, 'WINDOWS_UPDATE_SAVE_RESTORE_FAILED')
    }
  }

  async inspectRollbackReadback(
    input: Readonly<ComponentUpdateRollbackRestoreRequest>,
    hostMutation: HostMutationOperationScope
  ): Promise<unknown> {
    hostMutation.assertActive()
    const request = parse(rollbackRestoreSchema, input, 'WINDOWS_UPDATE_TRANSACTION_REQUEST_INVALID')
    try {
      const history = this.#history(hostMutation, deriveRequestId(request.requestId, 'config-readback'))
      const [configuration, modLock, protection, save] = await Promise.all([
        history.diff(request.binding.configurationSnapshotId),
        this.#inspectStableModLock(),
        inspectProtectionBinding(this.#backupRoot, request.binding.protectionBackupId),
        this.#inspectFixedSave()
      ])
      hostMutation.assertActive()
      return {
        configurationSnapshotId: request.binding.configurationSnapshotId,
        configurationRevision: configuration.currentRevision,
        serverModLockSha256: modLock.sha256,
        serverModLockRevision: modLock.revision,
        protectionManifestSha256: protection.manifestSha256,
        loadedSaveIdentity: save.identity
      }
    } catch (error) {
      hostMutation.assertActive()
      throw providerError(error, 'WINDOWS_UPDATE_ROLLBACK_READBACK_FAILED')
    }
  }

  async probeRuntimeLoadEvidence(
    input: Readonly<FixedUpdateSmokeRequest>,
    hostMutation: HostMutationOperationScope
  ): Promise<unknown> {
    hostMutation.assertActive()
    const request = parse(smokeRequestSchema, input, 'WINDOWS_UPDATE_TRANSACTION_REQUEST_INVALID')
    try {
      const evidence = await this.#readCurrentEvidence(hostMutation)
      if (evidence.loadedSaveIdentity !== request.expectedLoadedSaveIdentity) {
        throw new WindowsUpdateTransactionProviderError('WINDOWS_UPDATE_EXACT_SAVE_LOAD_UNPROVEN')
      }
      return runtimeLoadResult(evidence)
    } catch (error) {
      hostMutation.assertActive()
      throw providerError(error, 'WINDOWS_UPDATE_RUNTIME_EVIDENCE_UNAVAILABLE')
    }
  }

  async captureSteamManualBaseline(
    input: Readonly<SteamManualHandoffRequest>,
    hostMutation: HostMutationOperationScope
  ): Promise<unknown> {
    hostMutation.assertActive()
    parse(steamRequestSchema, input, 'WINDOWS_UPDATE_TRANSACTION_REQUEST_INVALID')
    try {
      const evidenceBefore = await this.#readCurrentEvidence(hostMutation)
      const compatibility = await this.#readCompatibility(hostMutation)
      const save = await this.#inspectFixedSave()
      const evidenceAfter = await this.#readCurrentEvidence(hostMutation)
      assertSameRuntimeGeneration(evidenceBefore, evidenceAfter)
      if (!compatibility.compatible || evidenceAfter.loadedSaveIdentity !== save.identity) {
        throw new WindowsUpdateTransactionProviderError('WINDOWS_STEAM_BASELINE_UNPROVEN')
      }
      hostMutation.assertActive()
      return {
        dspVersion: normalizeVersion(compatibility.dspVersion, 'dsp'),
        compatibilityRevision: compatibility.compatibilityRevision,
        compatible: true,
        loadedSaveIdentity: save.identity
      }
    } catch (error) {
      hostMutation.assertActive()
      throw providerError(error, 'WINDOWS_STEAM_BASELINE_UNAVAILABLE')
    }
  }

  async resampleSteamManualRuntime(
    input: Readonly<{ requestId: string; targetVersion: string }>,
    hostMutation: HostMutationOperationScope
  ): Promise<unknown> {
    hostMutation.assertActive()
    const request = parse(steamSampleRequestSchema, input, 'WINDOWS_UPDATE_TRANSACTION_REQUEST_INVALID')
    const targetVersion = normalizeVersion(request.targetVersion, 'dsp')
    try {
      await this.#proveStopped(hostMutation.signal)
      hostMutation.assertActive()
      const sample = await this.#readCompatibility(hostMutation)
      hostMutation.assertActive()
      await this.#proveStopped(hostMutation.signal)
      if (normalizeVersion(sample.dspVersion, 'dsp') !== targetVersion) {
        throw new WindowsUpdateTransactionProviderError('WINDOWS_STEAM_RUNTIME_SAMPLE_MISMATCH')
      }
      hostMutation.assertActive()
      return {
        dspVersion: targetVersion,
        compatibilityRevision: sample.compatibilityRevision,
        compatible: sample.compatible
      }
    } catch (error) {
      hostMutation.assertActive()
      throw providerError(error, 'WINDOWS_STEAM_RUNTIME_SAMPLE_UNAVAILABLE')
    }
  }

  async probeSteamManualLoadEvidence(
    input: Readonly<{
      requestId: string
      targetVersion: string
      expectedLoadedSaveIdentity: string
    }>,
    hostMutation: HostMutationOperationScope
  ): Promise<unknown> {
    hostMutation.assertActive()
    const request = parse(steamLoadRequestSchema, input, 'WINDOWS_UPDATE_TRANSACTION_REQUEST_INVALID')
    const targetVersion = normalizeVersion(request.targetVersion, 'dsp')
    try {
      const evidenceBefore = await this.#readCurrentEvidence(hostMutation)
      const compatibility = await this.#readCompatibility(hostMutation)
      const evidenceAfter = await this.#readCurrentEvidence(hostMutation)
      assertSameRuntimeGeneration(evidenceBefore, evidenceAfter)
      if (!compatibility.compatible ||
          normalizeVersion(compatibility.dspVersion, 'dsp') !== targetVersion ||
          evidenceAfter.loadedSaveIdentity !== request.expectedLoadedSaveIdentity) {
        throw new WindowsUpdateTransactionProviderError('WINDOWS_STEAM_EXACT_SAVE_LOAD_UNPROVEN')
      }
      return {
        ...runtimeLoadResult(evidenceAfter),
        dspVersion: targetVersion,
        compatibilityRevision: compatibility.compatibilityRevision,
        compatible: true
      }
    } catch (error) {
      hostMutation.assertActive()
      throw providerError(error, 'WINDOWS_STEAM_LOAD_EVIDENCE_UNAVAILABLE')
    }
  }

  #history(hostMutation: HostMutationOperationScope, expectedRequestId: string): GameConfigHistoryService {
    return new GameConfigHistoryService({
      configRoot: this.#configRoot,
      validateStopProof: this.#configStopProof.validate,
      hostMutationCoordinator: borrowedCoordinator(hostMutation, expectedRequestId)
    })
  }

  async #inspectFixedSave(): Promise<{ revision: string; identity: string }> {
    const inspected = await this.#saveTransactions.inspect(fixedSaveName)
    if (inspected.saveName !== fixedSaveName || !/^pair-v1:[0-9a-f]{64}$/.test(inspected.revision)) {
      throw new WindowsUpdateTransactionProviderError('WINDOWS_UPDATE_SAVE_IDENTITY_INVALID')
    }
    return { revision: inspected.revision, identity: inspected.revision.slice('pair-v1:'.length) }
  }

  async #inspectStableModLock(): Promise<{ sha256: string; revision: string }> {
    const first = normalizeModState(await this.#modDeploymentService.inspect())
    const second = normalizeModState(await this.#modDeploymentService.inspect())
    const firstJson = canonicalJson(first)
    if (firstJson !== canonicalJson(second)) {
      throw new WindowsUpdateTransactionProviderError('WINDOWS_UPDATE_MOD_LOCK_CHANGED')
    }
    return { sha256: sha256(firstJson), revision: first.revision }
  }

  async #readCurrentEvidence(
    hostMutation: HostMutationOperationScope
  ): Promise<AcceptedWindowsUpdateRuntimeEvidence> {
    const evidence = runtimeEvidenceSchema.parse(
      await this.#runtimeEvidenceSource.readCurrentRuntimeEvidence(hostMutation.signal)
    )
    hostMutation.assertActive()
    if (evidence.startupGenerationId !== evidence.bridgeHeartbeatGenerationId ||
        evidence.startupGenerationId !== evidence.loadedSaveLogGenerationId ||
        Date.parse(evidence.startedAt) !== evidence.processStartedAtUnixMs) {
      throw new WindowsUpdateTransactionProviderError('WINDOWS_UPDATE_RUNTIME_GENERATION_MISMATCH')
    }
    return evidence
  }

  async #readPersistedEvidence(
    hostMutation: HostMutationOperationScope
  ): Promise<AcceptedWindowsUpdateRuntimeEvidence> {
    const evidence = runtimeEvidenceSchema.parse(
      await this.#runtimeEvidenceSource.readPersistedRuntimeEvidence(hostMutation.signal)
    )
    hostMutation.assertActive()
    if (evidence.startupGenerationId !== evidence.bridgeHeartbeatGenerationId ||
        evidence.startupGenerationId !== evidence.loadedSaveLogGenerationId ||
        Date.parse(evidence.startedAt) !== evidence.processStartedAtUnixMs) {
      throw new WindowsUpdateTransactionProviderError('WINDOWS_UPDATE_RUNTIME_GENERATION_MISMATCH')
    }
    return evidence
  }

  async #latestRuntimeReceipt(): Promise<PublicGameRuntimeReceipt> {
    const page = await this.#gameRuntimeReceiptSource.list({ limit: 2 })
    if (!page || typeof page !== 'object' || !Array.isArray(page.items) || page.items.length < 1 ||
        page.items.length > 2 || (page.nextCursor !== null && typeof page.nextCursor !== 'string')) {
      throw new WindowsUpdateTransactionProviderError('WINDOWS_UPDATE_RUNTIME_RECEIPT_INVALID')
    }
    return runtimeReceiptSchema.parse(page.items[0])
  }

  async #readCompatibility(hostMutation: HostMutationOperationScope): Promise<{
    dspVersion: string
    compatibilityRevision: string
    compatible: boolean
  }> {
    const evidence = z.strictObject({
      dspVersion: versionSchema,
      compatibilityRevision: sha256Schema,
      compatible: z.boolean()
    }).parse(await this.#runtimeCompatibilitySource.inspect(hostMutation.signal))
    hostMutation.assertActive()
    return evidence
  }

  async #proveStopped(signal: AbortSignal): Promise<void> {
    try {
      stoppedEvidenceSchema.parse(await this.#verifyServiceStopped(signal))
    } catch {
      signal.throwIfAborted()
      throw new WindowsUpdateTransactionProviderError('WINDOWS_UPDATE_STOPPED_PROOF_FAILED')
    }
  }
}

/**
 * Named Steam construction surface. It deliberately shares the same fixed-root
 * implementation so one instance can be passed directly to the adapter.
 */
export class WindowsSteamManualHandoffTransactionProvider extends
  WindowsUpdateActivationTransactionProvider {}

interface ProtectionBinding {
  backupId: string
  manifestSha256: string
  saveIdentity: string
}

async function inspectProtectionBinding(
  configuredBackupRoot: string,
  reference: string
): Promise<ProtectionBinding> {
  let backupId: string
  try {
    backupId = protectionReferenceToBackupId(reference)
  } catch {
    throw new WindowsUpdateTransactionProviderError('WINDOWS_UPDATE_PROTECTION_REFERENCE_INVALID')
  }
  const backupRoot = await assertNormalDirectory(
    configuredBackupRoot,
    'WINDOWS_UPDATE_PROTECTION_ROOT_INVALID'
  )
  const directory = await assertNormalDirectory(
    path.join(backupRoot, backupId),
    'WINDOWS_UPDATE_PROTECTION_DIRECTORY_INVALID'
  )
  if (!isPathWithin(backupRoot, directory)) {
    throw new WindowsUpdateTransactionProviderError('WINDOWS_UPDATE_PROTECTION_DIRECTORY_INVALID')
  }
  const manifestBytes = await readStableFile(
    path.join(directory, 'manifest.json'),
    MAX_MANIFEST_BYTES,
    false
  )
  let manifest: BackupManifestV1
  try {
    manifest = backupManifestV1Schema.parse(JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)
    ))
  } catch {
    throw new WindowsUpdateTransactionProviderError('WINDOWS_UPDATE_PROTECTION_MANIFEST_INVALID')
  }
  if (backupId !== `tx-${manifest.requestId.toLowerCase()}` || manifest.saveName !== fixedSaveName) {
    throw new WindowsUpdateTransactionProviderError('WINDOWS_UPDATE_PROTECTION_IDENTITY_MISMATCH')
  }
  const dsvName = `${fixedSaveName}.dsv`
  const serverName = `${fixedSaveName}.server`
  const dsvManifest = manifest.files.filter((entry) => entry.name === dsvName)
  const serverManifest = manifest.files.filter((entry) => entry.name === serverName)
  if (dsvManifest.length !== 1 || serverManifest.length !== 1) {
    throw new WindowsUpdateTransactionProviderError('WINDOWS_UPDATE_PROTECTION_MANIFEST_INVALID')
  }
  const entries = (await readdir(directory, { withFileTypes: true }))
    .map((entry) => ({ name: entry.name, file: entry.isFile() && !entry.isSymbolicLink() }))
    .sort((left, right) => compareText(left.name, right.name))
  const expectedEntries = [dsvName, 'manifest.json', serverName]
    .sort(compareText)
    .map((name) => ({ name, file: true }))
  if (canonicalJson(entries) !== canonicalJson(expectedEntries)) {
    throw new WindowsUpdateTransactionProviderError('WINDOWS_UPDATE_PROTECTION_DIRECTORY_INVALID')
  }
  const [dsv, server] = await Promise.all([
    hashStableFile(path.join(directory, dsvName)),
    hashStableFile(path.join(directory, serverName))
  ])
  const expectedDsv = dsvManifest[0]!
  const expectedServer = serverManifest[0]!
  if (dsv.bytes !== expectedDsv.bytes || dsv.sha256 !== expectedDsv.sha256.toLowerCase() ||
      server.bytes !== expectedServer.bytes || server.sha256 !== expectedServer.sha256.toLowerCase()) {
    throw new WindowsUpdateTransactionProviderError('WINDOWS_UPDATE_PROTECTION_PAIR_MISMATCH')
  }
  return {
    backupId,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    saveIdentity: pairIdentity(fixedSaveName, dsv, server)
  }
}

function borrowedCoordinator(
  outer: HostMutationOperationScope,
  expectedRequestId: string
): HostMutationOperationCoordinator {
  return {
    async runExclusive<T>(
      request: HostMutationOperationRequest,
      operation: (
        scope: HostMutationOperationScope
      ) => Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>
    ): Promise<T> {
      if (request.operation !== 'game-config-restore' || request.requestId !== expectedRequestId ||
          Object.keys(request).length !== 2) {
        throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_UNAVAILABLE')
      }
      outer.assertActive()
      const outcome = await operation(outer)
      assertHostMutationOutcome(outcome)
      if (outcome.kind === 'throw') throw outcome.error
      outer.assertActive()
      return outcome.value
    }
  }
}

function assertHostMutationOutcome<T>(outcome: HostMutationOperationOutcome<T>): void {
  if (!outcome || typeof outcome !== 'object' ||
      (outcome.kind !== 'return' && outcome.kind !== 'throw') ||
      (outcome.disposition !== 'release' && outcome.disposition !== 'abandon')) {
    throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_UNAVAILABLE')
  }
}

async function assertNormalDirectory(directory: string, code: string): Promise<string> {
  try {
    const resolved = path.resolve(directory)
    const info = await lstat(resolved)
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(resolved), resolved)) {
      throw new Error('invalid')
    }
    return resolved
  } catch {
    throw new WindowsUpdateTransactionProviderError(code)
  }
}

async function readStableFile(filePath: string, maximumBytes: number, allowEmpty: boolean): Promise<Buffer> {
  let handle: FileHandle | null = null
  try {
    const beforePath = await lstat(filePath)
    if (!beforePath.isFile() || beforePath.isSymbolicLink() ||
        (!allowEmpty && beforePath.size <= 0) || beforePath.size > maximumBytes ||
        !samePath(await realpath(filePath), filePath)) throw new Error('invalid')
    handle = await open(filePath, 'r')
    const before = await handle.stat()
    if (!sameFile(beforePath, before)) throw new Error('changed')
    const bytes = await handle.readFile()
    const after = await handle.stat()
    const afterPath = await lstat(filePath)
    if (bytes.length !== before.size || !sameFile(before, after) || !sameFile(after, afterPath)) {
      throw new Error('changed')
    }
    return bytes
  } catch {
    throw new WindowsUpdateTransactionProviderError('WINDOWS_UPDATE_PROTECTION_FILE_INVALID')
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function hashStableFile(filePath: string): Promise<{ bytes: number; sha256: string }> {
  let handle: FileHandle | null = null
  try {
    const beforePath = await lstat(filePath)
    if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.size <= 0 ||
        !samePath(await realpath(filePath), filePath)) throw new Error('invalid')
    handle = await open(filePath, 'r')
    const before = await handle.stat()
    if (!sameFile(beforePath, before)) throw new Error('changed')
    const digest = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let position = 0
    while (position < before.size) {
      const length = Math.min(buffer.length, before.size - position)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      if (bytesRead <= 0) throw new Error('truncated')
      digest.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    const after = await handle.stat()
    const afterPath = await lstat(filePath)
    if (position !== before.size || !sameFile(before, after) || !sameFile(after, afterPath)) {
      throw new Error('changed')
    }
    return { bytes: position, sha256: digest.digest('hex') }
  } catch {
    throw new WindowsUpdateTransactionProviderError('WINDOWS_UPDATE_PROTECTION_FILE_INVALID')
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function pairIdentity(
  saveName: string,
  dsv: { bytes: number; sha256: string },
  server: { bytes: number; sha256: string }
): string {
  return createHash('sha256')
    .update('dyson-save-pair-revision-v1\0', 'utf8')
    .update(saveName, 'utf8')
    .update('\0dsv\0', 'utf8')
    .update(String(dsv.bytes), 'utf8')
    .update('\0', 'utf8')
    .update(dsv.sha256, 'ascii')
    .update('\0server\0', 'utf8')
    .update(String(server.bytes), 'utf8')
    .update('\0', 'utf8')
    .update(server.sha256, 'ascii')
    .digest('hex')
}

function normalizeModState(input: unknown): ModDeploymentStateSummary {
  const parsed = modStateSchema.parse(input)
  if (parsed.enabledCount + parsed.disabledCount !== parsed.packages.length) {
    throw new WindowsUpdateTransactionProviderError('WINDOWS_UPDATE_MOD_LOCK_INVALID')
  }
  const packages = [...parsed.packages]
    .sort((left, right) => compareText(left.dependencyId, right.dependencyId) ||
      compareText(left.sourceId, right.sourceId))
  return { ...parsed, packages }
}

function runtimeLoadResult(evidence: AcceptedWindowsUpdateRuntimeEvidence): {
  processId: number
  startedAt: string
  startupGenerationId: string
  bridgeHeartbeatGenerationId: string
  loadedSaveLogGenerationId: string
  loadedSaveIdentity: string
} {
  return {
    processId: evidence.processId,
    startedAt: evidence.startedAt,
    startupGenerationId: evidence.startupGenerationId,
    bridgeHeartbeatGenerationId: evidence.bridgeHeartbeatGenerationId,
    loadedSaveLogGenerationId: evidence.loadedSaveLogGenerationId,
    loadedSaveIdentity: evidence.loadedSaveIdentity
  }
}

function assertSameRuntimeGeneration(
  before: AcceptedWindowsUpdateRuntimeEvidence,
  after: AcceptedWindowsUpdateRuntimeEvidence
): void {
  if (before.startupGenerationId !== after.startupGenerationId ||
      before.bridgeHeartbeatGenerationId !== after.bridgeHeartbeatGenerationId ||
      before.loadedSaveLogGenerationId !== after.loadedSaveLogGenerationId ||
      before.processId !== after.processId ||
      before.processStartedAtUnixMs !== after.processStartedAtUnixMs ||
      before.bridgeStartedAtUnixMs !== after.bridgeStartedAtUnixMs ||
      before.loadedSaveIdentity !== after.loadedSaveIdentity) {
    throw new WindowsUpdateTransactionProviderError('WINDOWS_UPDATE_RUNTIME_GENERATION_CHANGED')
  }
}

function assertStoppedRuntimeBinding(
  evidence: AcceptedWindowsUpdateRuntimeEvidence,
  receipt: PublicGameRuntimeReceipt
): void {
  if (!receipt.projectRootIdentityVerified || receipt.restartExpected ||
      receipt.publishedAt === null || receipt.outcome !== 'clean-exit') {
    throw new WindowsUpdateTransactionProviderError('WINDOWS_UPDATE_RUNTIME_RECEIPT_MISMATCH')
  }
  const startedAt = parseRuntimeTimestamp(receipt.startedAt)
  const publishedAt = parseRuntimeTimestamp(receipt.publishedAt)
  const completedAt = parseRuntimeTimestamp(receipt.completedAt)
  if (startedAt > publishedAt || publishedAt > completedAt ||
      evidence.processStartedAtUnixMs < startedAt ||
      evidence.processStartedAtUnixMs > completedAt ||
      evidence.bridgeStartedAtUnixMs < publishedAt ||
      evidence.bridgeStartedAtUnixMs > completedAt ||
      evidence.loadedSaveObservedAtUnixMs > completedAt ||
      evidence.writtenAtUnixMs > completedAt ||
      Date.parse(evidence.startedAt) !== evidence.processStartedAtUnixMs) {
    throw new WindowsUpdateTransactionProviderError('WINDOWS_UPDATE_RUNTIME_RECEIPT_MISMATCH')
  }
}

function parseRuntimeTimestamp(value: string): number {
  const normalized = value.replace(
    /\.(\d{3})\d*(Z|[+-]\d{2}:\d{2})$/,
    '.$1$2'
  )
  const parsed = Date.parse(normalized)
  if (!Number.isFinite(parsed)) {
    throw new WindowsUpdateTransactionProviderError('WINDOWS_UPDATE_RUNTIME_RECEIPT_INVALID')
  }
  return parsed
}

function verifiedReceipt(): { restored: true; rereadVerified: true } {
  return { restored: true, rereadVerified: true }
}

function deriveRequestId(requestId: string, purpose: string): string {
  const bytes = createHash('sha256')
    .update('dyson-control-update-provider-request-v1\0', 'utf8')
    .update(requestId, 'ascii')
    .update('\0', 'ascii')
    .update(purpose, 'ascii')
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function providerError(error: unknown, fallback: string): WindowsUpdateTransactionProviderError {
  return error instanceof WindowsUpdateTransactionProviderError
    ? error
    : new WindowsUpdateTransactionProviderError(fallback)
}

function parse<T>(schema: z.ZodType<T>, input: unknown, code: string): T {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new WindowsUpdateTransactionProviderError(code)
  return parsed.data
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonical(value))
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, child]) => [key, sortCanonical(child)]))
  }
  return value
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).replace(/[\\/]+$/, '').toLowerCase() ===
    path.resolve(right).replace(/[\\/]+$/, '').toLowerCase()
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
}

function isSafeAbsoluteRoot(value: unknown): value is string {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return false
  const resolved = path.resolve(value)
  return resolved !== path.parse(resolved).root
}

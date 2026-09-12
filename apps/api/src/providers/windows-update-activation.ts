import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  serverStatusSchema,
  type LifecycleMutationAdapter,
  type LifecycleOperationContext,
  type LifecyclePhaseResult,
  type StatusProvider
} from '../domain.js'
import type { HostMutationOperationScope } from '../host-mutation/operation-coordinator.js'
import {
  type ComponentUpdateActivationAdapters,
  type ComponentUpdateRollbackBaseline,
  type ComponentUpdateRollbackBaselineRequest,
  type ComponentUpdateRollbackReadback,
  type ComponentUpdateRollbackRestoreRequest,
  type ComponentUpdateRollbackStepReceipt,
  type FixedUpdateSmokeRequest,
  type FixedUpdateSmokeResult,
  type ManagedUpdateComponent,
  type SaveProtectionPointReceipt,
  type SaveProtectionPointRequest,
  type StoppedStateCheckRequest,
  type StoppedStateProof
} from '../update-pipeline/activation-types.js'
import type {
  SteamManualHandoffAdapters,
  SteamManualHandoffBaseline,
  SteamManualHandoffLoadEvidence,
  SteamManualHandoffProtectionReceipt,
  SteamManualHandoffRequest,
  SteamManualHandoffRuntimeSample
} from '../update-pipeline/steam-manual-handoff.js'
import { normalizeVersion } from '../updates/version.js'

const componentSchema = z.enum(['nebula', 'bepinex', 'bridge', 'control'])
const pluginComponentSchema = z.enum(['bridge', 'control'])
const requestIdSchema = z.string().uuid()
const boundedSummarySchema = z.string().min(1).max(512)
const boundedVersionSchema = z.string().trim().min(1).max(64)
const releaseIdSchema = z.string().regex(/^(?:nebula|bepinex|bridge|control)-[0-9a-f]{32}$/)
const safeByteCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
const opaqueSnapshotIdSchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)

const stoppedRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  component: componentSchema,
  phase: z.enum(['before-protection', 'before-publish', 'before-rollback'])
})

const protectionRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  purpose: z.literal('component-update'),
  component: componentSchema,
  targetVersion: boundedVersionSchema,
  expectedRevision: z.string().regex(/^[0-9a-f]{64}$/)
})

const smokeRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  component: componentSchema,
  phase: z.enum(['candidate', 'rollback', 'reconcile-candidate']),
  expectedVersion: boundedVersionSchema.nullable(),
  expectedReleaseId: releaseIdSchema.nullable(),
  expectedLoadedSaveIdentity: sha256Schema
}).superRefine((request, context) => {
  const unmanagedRollback = request.phase === 'rollback' && request.expectedVersion !== null && request.expectedReleaseId === null
  if (!unmanagedRollback && (request.expectedVersion === null) !== (request.expectedReleaseId === null)) {
    context.addIssue({ code: 'custom', message: 'expected version and release identity must both be present or absent' })
  }
  if (request.expectedReleaseId !== null && !request.expectedReleaseId.startsWith(`${request.component}-`)) {
    context.addIssue({ code: 'custom', message: 'release identity does not match the component' })
  }
})

const stoppedLifecycleResultSchema = z.strictObject({
  summary: boundedSummarySchema,
  evidence: z.strictObject({
    processVerified: z.literal(true),
    gamePortListening: z.literal(false),
    lifecycleState: z.literal('stopped_verified')
  })
})

const runningLifecycleResultSchema = z.strictObject({
  summary: boundedSummarySchema,
  evidence: z.strictObject({
    processVerified: z.literal(true),
    gamePortListening: z.literal(true),
    lifecycleState: z.literal('running_verified')
  })
})

const startLifecycleResultSchema = z.strictObject({
  summary: boundedSummarySchema,
  evidence: z.strictObject({
    dispatched: z.literal(true),
    recovered: z.boolean(),
    taskName: z.string().min(1).max(128),
    readyVerified: z.literal(true)
  })
})

const stopLifecycleResultSchema = z.strictObject({
  summary: boundedSummarySchema,
  evidence: z.strictObject({
    dispatched: z.literal(true),
    recovered: z.boolean(),
    taskName: z.string().min(1).max(128),
    readyVerified: z.literal(true)
  })
})

const protectionLifecycleResultSchema = z.strictObject({
  summary: boundedSummarySchema,
  protectionPointId: z.string().regex(/^save:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  evidence: z.strictObject({
    dsvBytes: safeByteCountSchema,
    serverBytes: safeByteCountSchema,
    manifestVerified: z.literal(true),
    sourcePairVerified: z.literal(true),
    mutationPerformed: z.boolean(),
    reused: z.boolean()
  })
})

const rollbackBaselineSchema: z.ZodType<ComponentUpdateRollbackBaseline> = z.strictObject({
  previousComponentVersion: boundedVersionSchema.nullable().optional(),
  configurationSnapshotId: opaqueSnapshotIdSchema,
  configurationRevision: sha256Schema,
  serverModLockSha256: sha256Schema,
  serverModLockRevision: sha256Schema,
  previousLoadedSaveIdentity: sha256Schema
})

const protectionBindingSchema = z.strictObject({
  manifestSha256: sha256Schema,
  saveIdentity: sha256Schema
})

const rollbackReadbackSchema: z.ZodType<ComponentUpdateRollbackReadback> = z.strictObject({
  configurationSnapshotId: opaqueSnapshotIdSchema,
  configurationRevision: sha256Schema,
  serverModLockSha256: sha256Schema,
  serverModLockRevision: sha256Schema,
  protectionManifestSha256: sha256Schema,
  loadedSaveIdentity: sha256Schema
})

const rollbackStepReceiptSchema: z.ZodType<ComponentUpdateRollbackStepReceipt> = z.strictObject({
  restored: z.literal(true),
  rereadVerified: z.literal(true)
})

const runtimeLoadEvidenceSchema = z.strictObject({
  processId: z.number().int().positive(),
  startedAt: z.string().datetime({ offset: true }),
  startupGenerationId: sha256Schema,
  bridgeHeartbeatGenerationId: sha256Schema,
  loadedSaveLogGenerationId: sha256Schema,
  loadedSaveIdentity: sha256Schema
})

const probedVersionSchema = boundedVersionSchema.nullable()

const steamManualRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  targetVersion: boundedVersionSchema,
  expectedRevision: sha256Schema
})
const steamManualProtectionRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  targetVersion: boundedVersionSchema
})
const steamManualRequestIdSchema = z.strictObject({ requestId: requestIdSchema })
const steamManualStartRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  targetVersion: boundedVersionSchema,
  expectedLoadedSaveIdentity: sha256Schema
})
const steamManualBaselineSchema: z.ZodType<SteamManualHandoffBaseline> = z.strictObject({
  dspVersion: boundedVersionSchema,
  compatibilityRevision: sha256Schema,
  compatible: z.literal(true),
  loadedSaveIdentity: sha256Schema
})
const steamManualRuntimeSchema: z.ZodType<SteamManualHandoffRuntimeSample> = z.strictObject({
  dspVersion: boundedVersionSchema,
  compatibilityRevision: sha256Schema,
  compatible: z.boolean()
})
const steamManualRuntimeLoadEvidenceSchema = z.strictObject({
  processId: z.number().int().positive(),
  startedAt: z.string().datetime({ offset: true }),
  dspVersion: boundedVersionSchema,
  compatibilityRevision: sha256Schema,
  compatible: z.boolean(),
  startupGenerationId: sha256Schema,
  bridgeHeartbeatGenerationId: sha256Schema,
  loadedSaveLogGenerationId: sha256Schema,
  loadedSaveIdentity: sha256Schema
})

export interface FixedComponentVersionProbeRequest {
  component: 'bridge' | 'control'
  signal: AbortSignal
}

/**
 * A construction-time fixed probe. Implementations may inspect only their own
 * preconfigured component locations; callers never provide a path or command.
 */
export type FixedComponentVersionProbe = (
  request: Readonly<FixedComponentVersionProbeRequest>
) => Promise<string | null>

export interface WindowsUpdateActivationAdaptersOptions {
  /** Per-phase deadline; internal configuration, never an HTTP argument. */
  lifecyclePhaseTimeoutMs?: number
  lifecycleAdapter: LifecycleMutationAdapter
  statusProvider: StatusProvider
  componentVersionProbe: FixedComponentVersionProbe
  /**
   * Fixed-root/broker-backed transaction evidence. It never receives a path,
   * command, Steam account, credential, or arbitrary argument from HTTP.
   */
  transactionProvider?: WindowsUpdateActivationTransactionProvider &
    Partial<WindowsSteamManualHandoffTransactionProvider>
}

export interface WindowsUpdateActivationTransactionProvider {
  inspectRollbackMaterial?(request: Readonly<ComponentUpdateRollbackRestoreRequest>): Promise<unknown>
  approveRollbackWarnings?(request: Readonly<FixedUpdateSmokeRequest>, warnings: readonly string[],
    hostMutation: HostMutationOperationScope): Promise<boolean>
  captureRollbackBaseline(
    request: Readonly<ComponentUpdateRollbackBaselineRequest>,
    hostMutation: HostMutationOperationScope
  ): Promise<unknown>
  inspectProtectionPoint(
    request: Readonly<{ requestId: string; backupId: string }>,
    hostMutation: HostMutationOperationScope
  ): Promise<unknown>
  restoreConfiguration(
    request: Readonly<ComponentUpdateRollbackRestoreRequest>,
    hostMutation: HostMutationOperationScope
  ): Promise<unknown>
  restoreServerModLock(
    request: Readonly<ComponentUpdateRollbackRestoreRequest>,
    hostMutation: HostMutationOperationScope
  ): Promise<unknown>
  restorePairedSave(
    request: Readonly<ComponentUpdateRollbackRestoreRequest>,
    hostMutation: HostMutationOperationScope
  ): Promise<unknown>
  inspectRollbackReadback(
    request: Readonly<ComponentUpdateRollbackRestoreRequest>,
    hostMutation: HostMutationOperationScope
  ): Promise<unknown>
  probeRuntimeLoadEvidence(
    request: Readonly<FixedUpdateSmokeRequest>,
    hostMutation: HostMutationOperationScope
  ): Promise<unknown>
}

/**
 * Optional fixed evidence extension used by the official-Steam manual handoff.
 * Implementations are construction-time capabilities and never receive account
 * material, executable paths, commands, or arbitrary client input.
 */
export interface WindowsSteamManualHandoffTransactionProvider {
  captureSteamManualBaseline(
    request: Readonly<SteamManualHandoffRequest>,
    hostMutation: HostMutationOperationScope
  ): Promise<unknown>
  resampleSteamManualRuntime(
    request: Readonly<{ requestId: string; targetVersion: string }>,
    hostMutation: HostMutationOperationScope
  ): Promise<unknown>
  probeSteamManualLoadEvidence(
    request: Readonly<{
      requestId: string
      targetVersion: string
      expectedLoadedSaveIdentity: string
    }>,
    hostMutation: HostMutationOperationScope
  ): Promise<unknown>
}

export class WindowsUpdateActivationAdapterError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'WindowsUpdateActivationAdapterError'
    this.code = code
  }
}

/**
 * Binds component activation to the existing fixed Windows lifecycle surface.
 * It owns no executable, path, task name, URL, credential, or shell argument.
 */
export class WindowsUpdateActivationAdapters implements ComponentUpdateActivationAdapters, SteamManualHandoffAdapters {
  readonly #lifecyclePhaseTimeoutMs: number
  readonly #lifecycleAdapter: LifecycleMutationAdapter
  readonly #statusProvider: StatusProvider
  readonly #componentVersionProbe: FixedComponentVersionProbe
  readonly #transactionProvider: (WindowsUpdateActivationTransactionProvider &
    Partial<WindowsSteamManualHandoffTransactionProvider>) | null

  constructor(options: WindowsUpdateActivationAdaptersOptions) {
    const phaseTimeout = options.lifecyclePhaseTimeoutMs ?? 600_000
    if (!Number.isSafeInteger(phaseTimeout) || phaseTimeout < 1 || phaseTimeout > 900_000) {
      throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_PHASE_TIMEOUT_INVALID')
    }
    this.#lifecyclePhaseTimeoutMs = phaseTimeout
    if (options.lifecycleAdapter.mutationEnabled !== true) {
      throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_LIFECYCLE_DISABLED')
    }
    if (options.statusProvider.name !== 'windows') {
      throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_STATUS_PROVIDER_INVALID')
    }
    if (typeof options.componentVersionProbe !== 'function') {
      throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_VERSION_PROBE_INVALID')
    }
    this.#lifecycleAdapter = options.lifecycleAdapter
    this.#statusProvider = options.statusProvider
    this.#componentVersionProbe = options.componentVersionProbe
    this.#transactionProvider = options.transactionProvider ?? null
  }

  async verifyStoppedState(
    input: StoppedStateCheckRequest,
    hostMutation: HostMutationOperationScope
  ): Promise<StoppedStateProof> {
    hostMutation.assertActive()
    const request = parseRequest(stoppedRequestSchema, input)
    const context = createLifecycleContext(
      request.requestId,
      `update-stop-check:${request.component}:${request.phase}:${request.requestId}`,
      hostMutation
    )
    try {
      stoppedLifecycleResultSchema.parse(await this.#runLifecyclePhase('verifyStopped', context))
      hostMutation.assertActive()
      return { processStopped: true, portClosed: true }
    } catch {
      hostMutation.assertActive()
      throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_STOP_PROOF_FAILED')
    }
  }

  async createSaveProtectionPoint(
    input: SaveProtectionPointRequest,
    hostMutation: HostMutationOperationScope
  ): Promise<SaveProtectionPointReceipt> {
    hostMutation.assertActive()
    const request = parseRequest(protectionRequestSchema, input)
    const context = createLifecycleContext(
      request.requestId,
      `update-save-protection:${request.component}:${request.requestId}`,
      hostMutation
    )
    try {
      const result = protectionLifecycleResultSchema.parse(
        await this.#runLifecyclePhase('createProtectionPoint', context)
      )
      hostMutation.assertActive()
      const binding = protectionBindingSchema.parse(await this.#requireTransactionProvider()
        .inspectProtectionPoint({
          requestId: request.requestId,
          backupId: result.protectionPointId.toLowerCase()
        }, hostMutation))
      hostMutation.assertActive()
      return {
        requestId: request.requestId,
        status: 'succeeded',
        backupId: result.protectionPointId.toLowerCase(),
        manifestSha256: binding.manifestSha256,
        saveIdentity: binding.saveIdentity,
        pairProtected: true,
        durable: true
      }
    } catch {
      hostMutation.assertActive()
      throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_SAVE_PROTECTION_FAILED')
    }
  }

  async captureRollbackBaseline(
    input: ComponentUpdateRollbackBaselineRequest,
    hostMutation: HostMutationOperationScope
  ): Promise<ComponentUpdateRollbackBaseline> {
    hostMutation.assertActive()
    const request = parseRequest(z.strictObject({
      requestId: requestIdSchema,
      component: componentSchema,
      targetVersion: boundedVersionSchema,
      expectedRevision: sha256Schema
    }), input)
    try {
      const result = rollbackBaselineSchema.parse(
        await this.#requireTransactionProvider().captureRollbackBaseline(request, hostMutation)
      )
      hostMutation.assertActive()
      return result
    } catch (error) {
      hostMutation.assertActive()
      if (error instanceof WindowsUpdateActivationAdapterError) throw error
      throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_ROLLBACK_BASELINE_FAILED')
    }
  }

  async restoreRollbackConfiguration(
    request: ComponentUpdateRollbackRestoreRequest,
    hostMutation: HostMutationOperationScope
  ): Promise<ComponentUpdateRollbackStepReceipt> {
    return await this.#restoreRollbackStep('configuration', request, hostMutation)
  }

  async restoreRollbackServerModLock(
    request: ComponentUpdateRollbackRestoreRequest,
    hostMutation: HostMutationOperationScope
  ): Promise<ComponentUpdateRollbackStepReceipt> {
    return await this.#restoreRollbackStep('server-mod-lock', request, hostMutation)
  }

  async restoreRollbackPairedSave(
    request: ComponentUpdateRollbackRestoreRequest,
    hostMutation: HostMutationOperationScope
  ): Promise<ComponentUpdateRollbackStepReceipt> {
    return await this.#restoreRollbackStep('paired-save', request, hostMutation)
  }

  async inspectRollbackMaterial(request: ComponentUpdateRollbackRestoreRequest) {
    const result = await this.#requireTransactionProvider().inspectRollbackMaterial?.(request)
    return z.strictObject({ configurationSnapshotVerified: z.literal(true), protectionVerified: z.literal(true),
      serverModLockVerified: z.literal(true), currentConfigurationRevision: sha256Schema }).parse(result)
  }

  async inspectRollbackReadback(
    request: ComponentUpdateRollbackRestoreRequest,
    hostMutation: HostMutationOperationScope
  ): Promise<ComponentUpdateRollbackReadback> {
    hostMutation.assertActive()
    try {
      const result = rollbackReadbackSchema.parse(
        await this.#requireTransactionProvider().inspectRollbackReadback(request, hostMutation)
      )
      hostMutation.assertActive()
      return result
    } catch (error) {
      hostMutation.assertActive()
      if (error instanceof WindowsUpdateActivationAdapterError) throw error
      throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_ROLLBACK_READBACK_FAILED')
    }
  }

  async captureBaseline(
    input: Readonly<SteamManualHandoffRequest>,
    hostMutation: HostMutationOperationScope
  ): Promise<SteamManualHandoffBaseline> {
    hostMutation.assertActive()
    const request = parseRequest(steamManualRequestSchema, input)
    try {
      const provider = this.#requireSteamTransactionProvider()
      const baseline = steamManualBaselineSchema.parse(
        await provider.captureSteamManualBaseline(request, hostMutation)
      )
      hostMutation.assertActive()
      return { ...baseline, dspVersion: normalizeVersion(baseline.dspVersion, 'dsp') }
    } catch (error) {
      hostMutation.assertActive()
      if (error instanceof WindowsUpdateActivationAdapterError) throw error
      throw new WindowsUpdateActivationAdapterError('WINDOWS_STEAM_HANDOFF_BASELINE_FAILED')
    }
  }

  async createProtectionPoint(
    input: Readonly<Pick<SteamManualHandoffRequest, 'requestId' | 'targetVersion'>>,
    hostMutation: HostMutationOperationScope
  ): Promise<SteamManualHandoffProtectionReceipt> {
    hostMutation.assertActive()
    const request = parseRequest(steamManualProtectionRequestSchema, input)
    const context = createLifecycleContext(
      deriveWindowsSteamHandoffLifecycleRequestId(request.requestId, 'prepare'),
      `steam-handoff-protection:${request.requestId}`,
      hostMutation
    )
    try {
      const result = protectionLifecycleResultSchema.parse(
        await this.#runLifecyclePhase('createProtectionPoint', context)
      )
      hostMutation.assertActive()
      const binding = protectionBindingSchema.parse(await this.#requireTransactionProvider()
        .inspectProtectionPoint({
          requestId: request.requestId,
          backupId: result.protectionPointId.toLowerCase()
        }, hostMutation))
      hostMutation.assertActive()
      return {
        requestId: request.requestId,
        backupId: result.protectionPointId.toLowerCase(),
        manifestSha256: binding.manifestSha256,
        saveIdentity: binding.saveIdentity,
        pairProtected: true,
        durable: true
      }
    } catch (error) {
      hostMutation.assertActive()
      if (error instanceof WindowsUpdateActivationAdapterError) throw error
      throw new WindowsUpdateActivationAdapterError('WINDOWS_STEAM_HANDOFF_PROTECTION_FAILED')
    }
  }

  async requestGracefulStop(
    input: Readonly<{ requestId: string }>,
    hostMutation: HostMutationOperationScope
  ): Promise<{ dispatched: true }> {
    hostMutation.assertActive()
    const request = parseRequest(steamManualRequestIdSchema, input)
    const context = createLifecycleContext(
      deriveWindowsSteamHandoffLifecycleRequestId(request.requestId, 'prepare'),
      `steam-handoff-stop:${request.requestId}`,
      hostMutation
    )
    try {
      stopLifecycleResultSchema.parse(await this.#runLifecyclePhase('requestGracefulStop', context))
      hostMutation.assertActive()
      return { dispatched: true }
    } catch {
      hostMutation.assertActive()
      throw new WindowsUpdateActivationAdapterError('WINDOWS_STEAM_HANDOFF_STOP_FAILED')
    }
  }

  async verifyStopped(
    input: Readonly<{ requestId: string }>,
    hostMutation: HostMutationOperationScope
  ): Promise<{ processStopped: true; portClosed: true }> {
    hostMutation.assertActive()
    const request = parseRequest(steamManualRequestIdSchema, input)
    const context = createLifecycleContext(
      deriveWindowsSteamHandoffLifecycleRequestId(request.requestId, 'prepare'),
      `steam-handoff-stop:${request.requestId}`,
      hostMutation
    )
    try {
      stoppedLifecycleResultSchema.parse(await this.#runLifecyclePhase('verifyStopped', context))
      hostMutation.assertActive()
      return { processStopped: true, portClosed: true }
    } catch {
      hostMutation.assertActive()
      throw new WindowsUpdateActivationAdapterError('WINDOWS_STEAM_HANDOFF_STOP_PROOF_FAILED')
    }
  }

  async resampleUpdatedRuntime(
    input: Readonly<{ requestId: string; targetVersion: string }>,
    hostMutation: HostMutationOperationScope
  ): Promise<SteamManualHandoffRuntimeSample> {
    hostMutation.assertActive()
    const request = parseRequest(steamManualProtectionRequestSchema, input)
    try {
      const provider = this.#requireSteamTransactionProvider()
      const sample = steamManualRuntimeSchema.parse(
        await provider.resampleSteamManualRuntime(request, hostMutation)
      )
      hostMutation.assertActive()
      return { ...sample, dspVersion: normalizeVersion(sample.dspVersion, 'dsp') }
    } catch (error) {
      hostMutation.assertActive()
      if (error instanceof WindowsUpdateActivationAdapterError) throw error
      throw new WindowsUpdateActivationAdapterError('WINDOWS_STEAM_HANDOFF_RESAMPLE_FAILED')
    }
  }

  async startAndVerifyExactSave(
    input: Readonly<{
      requestId: string
      targetVersion: string
      expectedLoadedSaveIdentity: string
    }>,
    hostMutation: HostMutationOperationScope
  ): Promise<SteamManualHandoffLoadEvidence> {
    hostMutation.assertActive()
    const request = parseRequest(steamManualStartRequestSchema, input)
    const context = createLifecycleContext(
      deriveWindowsSteamHandoffLifecycleRequestId(request.requestId, 'complete'),
      `steam-handoff-start:${request.requestId}`,
      hostMutation
    )
    let attemptedStart = false
    let primaryError: WindowsUpdateActivationAdapterError | null = null
    try {
      attemptedStart = true
      startLifecycleResultSchema.parse(await this.#runLifecyclePhase('requestStart', context))
      hostMutation.assertActive()
      runningLifecycleResultSchema.parse(await this.#runLifecyclePhase('verifyRunning', context))
      hostMutation.assertActive()
      const status = await this.#collectBoundedStatus()
      hostMutation.assertActive()
      const provider = this.#requireSteamTransactionProvider()
      const evidence = steamManualRuntimeLoadEvidenceSchema.parse(
        await provider.probeSteamManualLoadEvidence(request, hostMutation)
      )
      hostMutation.assertActive()
      const statusDspVersion = status.versions.dsp === null
        ? null
        : normalizeVersion(status.versions.dsp, 'dsp')
      const evidenceVersion = normalizeVersion(evidence.dspVersion, 'dsp')
      const currentGeneration = status.runtime.processId !== null && status.runtime.startedAt !== null &&
        evidence.processId === status.runtime.processId &&
        Date.parse(evidence.startedAt) === Date.parse(status.runtime.startedAt) &&
        evidence.startupGenerationId === evidence.bridgeHeartbeatGenerationId &&
        evidence.startupGenerationId === evidence.loadedSaveLogGenerationId
      const exactLoad = status.state === 'running' && status.versions.gameLoaded === true &&
        status.versions.compatible === true && status.versions.warnings.length === 0 &&
        evidence.compatible && statusDspVersion === request.targetVersion &&
        evidenceVersion === request.targetVersion && currentGeneration &&
        evidence.loadedSaveIdentity === request.expectedLoadedSaveIdentity
      if (!exactLoad) {
        throw new WindowsUpdateActivationAdapterError('WINDOWS_STEAM_HANDOFF_EXACT_SAVE_LOAD_UNPROVEN')
      }
      return {
        dspVersion: evidenceVersion,
        compatibilityRevision: evidence.compatibilityRevision,
        compatible: true,
        startupGenerationId: evidence.startupGenerationId,
        bridgeHeartbeatGenerationId: evidence.bridgeHeartbeatGenerationId,
        loadedSaveLogGenerationId: evidence.loadedSaveLogGenerationId,
        loadedSaveIdentity: evidence.loadedSaveIdentity
      }
    } catch (error) {
      primaryError = normalizeAdapterError(error, 'WINDOWS_STEAM_HANDOFF_START_FAILED')
    }

    if (attemptedStart) {
      try {
        stopLifecycleResultSchema.parse(await this.#runLifecyclePhase('requestGracefulStop', context))
      } catch {
        // Independent stopped-state proof below decides whether compensation is safe.
      }
      try {
        stoppedLifecycleResultSchema.parse(await this.#runLifecyclePhase('verifyStopped', context))
      } catch {
        throw new WindowsUpdateActivationAdapterError('WINDOWS_STEAM_HANDOFF_FAILED_STOP_UNPROVEN')
      }
    }
    hostMutation.assertActive()
    throw primaryError ?? new WindowsUpdateActivationAdapterError('WINDOWS_STEAM_HANDOFF_START_FAILED')
  }

  async smoke(
    input: FixedUpdateSmokeRequest,
    hostMutation: HostMutationOperationScope
  ): Promise<FixedUpdateSmokeResult> {
    hostMutation.assertActive()
    const request = parseRequest(smokeRequestSchema, input)
    const expectedVersion = normalizeExpectedVersion(request.component, request.expectedVersion)
    const smokeRequestId = deriveWindowsUpdateSmokeRequestId(request)
    const controller = new AbortController()
    const abortFromHostMutation = () => controller.abort(hostMutation.signal.reason)
    if (hostMutation.signal.aborted) abortFromHostMutation()
    else hostMutation.signal.addEventListener('abort', abortFromHostMutation, { once: true })
    const context = createLifecycleContext(smokeRequestId, `update-smoke:${smokeRequestId}`, hostMutation, controller.signal)
    let attemptedStart = false
    let stoppedProven = false
    let result: FixedUpdateSmokeResult | null = null
    let primaryError: WindowsUpdateActivationAdapterError | null = null

    try {
      attemptedStart = true
      try {
        hostMutation.assertActive()
        startLifecycleResultSchema.parse(await this.#runLifecyclePhase('requestStart', context))
        hostMutation.assertActive()
      } catch {
        hostMutation.assertActive()
        throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_SMOKE_START_FAILED')
      }

      try {
        hostMutation.assertActive()
        runningLifecycleResultSchema.parse(await this.#runLifecyclePhase('verifyRunning', context))
        hostMutation.assertActive()
      } catch {
        hostMutation.assertActive()
        throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_SMOKE_RUNNING_UNPROVEN')
      }

      let loadEvidence: z.infer<typeof runtimeLoadEvidenceSchema>
      try {
        loadEvidence = runtimeLoadEvidenceSchema.parse(
          await this.#requireTransactionProvider().probeRuntimeLoadEvidence(request, hostMutation)
        )
        hostMutation.assertActive()
      } catch (error) {
        hostMutation.assertActive()
        if (error instanceof WindowsUpdateActivationAdapterError) throw error
        throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_SMOKE_LOAD_EVIDENCE_FAILED')
      }
      const status = await this.#collectBoundedStatus()
      hostMutation.assertActive()
      const observedVersion = await this.#observeComponentVersion(request.component, status, controller.signal)
      hostMutation.assertActive()
      if (status.runtime.processId === null || status.runtime.startedAt === null ||
          loadEvidence.processId !== status.runtime.processId ||
          Date.parse(loadEvidence.startedAt) !== Date.parse(status.runtime.startedAt)) {
        throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_SMOKE_GENERATION_MISMATCH')
      }
      let loadingHealthy = status.versions.gameLoaded === true && status.versions.compatible === true &&
        status.versions.warnings.length === 0
      if (!loadingHealthy && request.phase === 'rollback' && status.versions.gameLoaded === true &&
          observedVersion === expectedVersion && status.versions.warnings.length > 0) {
        loadingHealthy = (await this.#requireTransactionProvider().approveRollbackWarnings?.(
          request, status.versions.warnings, hostMutation)) === true
        hostMutation.assertActive()
      }
      const normalizedBepInEx = normalizeStatusVersion(status.versions.bepInEx, 'bepinex')
      const normalizedNebula = normalizeStatusVersion(status.versions.nebula, 'nebula')
      const gamePortChecks = status.connections.filter((connection) => connection.id === 'game-port')

      result = {
        component: request.component,
        observedVersion,
        versionMatches: observedVersion === expectedVersion,
        bepInExLoaded: loadingHealthy && normalizedBepInEx !== null,
        nebulaLoaded: loadingHealthy && normalizedNebula !== null,
        processHealthy: status.state === 'running' && status.runtime.processId !== null,
        portHealthy: gamePortChecks.length === 1 && gamePortChecks[0]!.status === 'healthy',
        startupGenerationId: loadEvidence.startupGenerationId,
        bridgeHeartbeatGenerationId: loadEvidence.bridgeHeartbeatGenerationId,
        loadedSaveLogGenerationId: loadEvidence.loadedSaveLogGenerationId,
        loadedSaveIdentity: loadEvidence.loadedSaveIdentity
      }

      try {
        hostMutation.assertActive()
        stopLifecycleResultSchema.parse(await this.#runLifecyclePhase('requestGracefulStop', context))
        hostMutation.assertActive()
      } catch {
        hostMutation.assertActive()
        throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_SMOKE_STOP_FAILED')
      }
      try {
        hostMutation.assertActive()
        stoppedLifecycleResultSchema.parse(await this.#runLifecyclePhase('verifyStopped', context))
        hostMutation.assertActive()
        stoppedProven = true
      } catch {
        hostMutation.assertActive()
        throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_SMOKE_STOP_VERIFICATION_FAILED')
      }
    } catch (error) {
      primaryError = normalizeAdapterError(error, 'WINDOWS_UPDATE_SMOKE_FAILED')
    } finally {
      if (attemptedStart && !stoppedProven) {
        try {
          stopLifecycleResultSchema.parse(await this.#runLifecyclePhase('requestGracefulStop', context))
        } catch {
          // A failed stop dispatch is followed by an independent stopped-state proof.
        }
        try {
          stoppedLifecycleResultSchema.parse(await this.#runLifecyclePhase('verifyStopped', context))
          stoppedProven = true
        } catch {
          stoppedProven = false
        }
      }
      hostMutation.signal.removeEventListener('abort', abortFromHostMutation)
      controller.abort()
    }

    hostMutation.assertActive()
    if (!stoppedProven) {
      throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_SMOKE_STOP_UNPROVEN')
    }
    if (primaryError !== null) throw primaryError
    if (result === null) throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_SMOKE_FAILED')
    return result
  }

  async #restoreRollbackStep(
    step: 'configuration' | 'server-mod-lock' | 'paired-save',
    request: ComponentUpdateRollbackRestoreRequest,
    hostMutation: HostMutationOperationScope
  ): Promise<ComponentUpdateRollbackStepReceipt> {
    hostMutation.assertActive()
    const provider = this.#requireTransactionProvider()
    try {
      const raw = step === 'configuration'
        ? await provider.restoreConfiguration(request, hostMutation)
        : step === 'server-mod-lock'
          ? await provider.restoreServerModLock(request, hostMutation)
          : await provider.restorePairedSave(request, hostMutation)
      const receipt = rollbackStepReceiptSchema.parse(raw)
      hostMutation.assertActive()
      return receipt
    } catch (error) {
      hostMutation.assertActive()
      if (error instanceof WindowsUpdateActivationAdapterError) throw error
      throw new WindowsUpdateActivationAdapterError(
        step === 'configuration'
          ? 'WINDOWS_UPDATE_ROLLBACK_CONFIGURATION_FAILED'
          : step === 'server-mod-lock'
            ? 'WINDOWS_UPDATE_ROLLBACK_MOD_LOCK_FAILED'
            : 'WINDOWS_UPDATE_ROLLBACK_PAIRED_SAVE_FAILED'
      )
    }
  }

  #requireTransactionProvider(): WindowsUpdateActivationTransactionProvider {
    if (this.#transactionProvider === null) {
      throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_ROLLBACK_CAPABILITY_UNAVAILABLE')
    }
    return this.#transactionProvider
  }

  #requireSteamTransactionProvider(): WindowsUpdateActivationTransactionProvider &
    WindowsSteamManualHandoffTransactionProvider {
    const provider = this.#transactionProvider
    if (provider === null || typeof provider.captureSteamManualBaseline !== 'function' ||
        typeof provider.resampleSteamManualRuntime !== 'function' ||
        typeof provider.probeSteamManualLoadEvidence !== 'function') {
      throw new WindowsUpdateActivationAdapterError('WINDOWS_STEAM_HANDOFF_CAPABILITY_UNAVAILABLE')
    }
    return provider as WindowsUpdateActivationTransactionProvider & WindowsSteamManualHandoffTransactionProvider
  }

  async #runLifecyclePhase(
    method: 'verifyStopped' | 'verifyRunning' | 'createProtectionPoint' | 'requestStart' | 'requestGracefulStop',
    context: LifecycleOperationContext
  ): Promise<LifecyclePhaseResult> {
    context.hostMutation?.assertActive()
    context.signal.throwIfAborted()
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(new Error('WINDOWS_UPDATE_LIFECYCLE_PHASE_TIMEOUT')),
      this.#lifecyclePhaseTimeoutMs)
    const signal = AbortSignal.any([context.signal, deadline.signal])
    try {
      // Await cancellation acknowledgement from the real adapter before a
      // cleanup phase can run. Do not race a still-mutating task and release its lease.
      const result = await this.#lifecycleAdapter[method]({ ...context, signal })
      signal.throwIfAborted()
      context.hostMutation?.assertActive()
      return result
    } finally {
      clearTimeout(timer)
    }
  }

  async #collectBoundedStatus(): Promise<z.infer<typeof serverStatusSchema>> {
    try {
      return serverStatusSchema.parse(await this.#statusProvider.collectStatus())
    } catch {
      throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_SMOKE_STATUS_FAILED')
    }
  }

  async #observeComponentVersion(
    component: ManagedUpdateComponent,
    status: z.infer<typeof serverStatusSchema>,
    signal: AbortSignal
  ): Promise<string | null> {
    if (component === 'nebula') return normalizeStatusVersion(status.versions.nebula, 'nebula')
    if (component === 'bepinex') return normalizeStatusVersion(status.versions.bepInEx, 'bepinex')
    const fixedComponent = pluginComponentSchema.parse(component)
    try {
      const value = probedVersionSchema.parse(await this.#componentVersionProbe(Object.freeze({
        component: fixedComponent,
        signal
      })))
      return value === null ? null : normalizeVersion(value, 'plugin')
    } catch {
      throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_SMOKE_VERSION_PROBE_FAILED')
    }
  }
}

export function deriveWindowsUpdateSmokeRequestId(
  input: Pick<FixedUpdateSmokeRequest, 'requestId' | 'component' | 'phase'>
): string {
  const parsed = z.strictObject({
    requestId: requestIdSchema,
    component: componentSchema,
    phase: z.enum(['candidate', 'rollback', 'reconcile-candidate'])
  }).parse({ requestId: input.requestId, component: input.component, phase: input.phase })
  const digest = createHash('sha256')
    .update('dyson-control/windows-update-smoke/v1\0', 'utf8')
    .update(parsed.requestId.toLowerCase(), 'utf8')
    .update('\0', 'utf8')
    .update(parsed.component, 'utf8')
    .update('\0', 'utf8')
    .update(parsed.phase, 'utf8')
    .digest()
  digest[6] = (digest[6]! & 0x0f) | 0x50
  digest[8] = (digest[8]! & 0x3f) | 0x80
  const hexadecimal = digest.subarray(0, 16).toString('hex')
  return `${hexadecimal.slice(0, 8)}-${hexadecimal.slice(8, 12)}-${hexadecimal.slice(12, 16)}-` +
    `${hexadecimal.slice(16, 20)}-${hexadecimal.slice(20)}`
}

export function deriveWindowsSteamHandoffLifecycleRequestId(
  requestIdInput: string,
  phase: 'prepare' | 'complete'
): string {
  const requestId = requestIdSchema.parse(requestIdInput).toLowerCase()
  const digest = createHash('sha256')
    .update('dyson-control/windows-steam-handoff/v1\0', 'utf8')
    .update(requestId, 'utf8')
    .update('\0', 'utf8')
    .update(phase, 'utf8')
    .digest()
  digest[6] = (digest[6]! & 0x0f) | 0x50
  digest[8] = (digest[8]! & 0x3f) | 0x80
  const hexadecimal = digest.subarray(0, 16).toString('hex')
  return `${hexadecimal.slice(0, 8)}-${hexadecimal.slice(8, 12)}-${hexadecimal.slice(12, 16)}-` +
    `${hexadecimal.slice(16, 20)}-${hexadecimal.slice(20)}`
}

function createLifecycleContext(
  requestId: string,
  jobId: string,
  hostMutation: HostMutationOperationScope,
  signal: AbortSignal = hostMutation.signal
): LifecycleOperationContext {
  return Object.freeze({
    jobId,
    requestId: requestId.toLowerCase(),
    action: 'restart' as const,
    protectionPointId: null,
    hostMutation,
    signal
  })
}

function parseRequest<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  try {
    return schema.parse(input)
  } catch {
    throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_REQUEST_INVALID')
  }
}

function normalizeExpectedVersion(component: ManagedUpdateComponent, value: string | null): string | null {
  if (value === null) return null
  try {
    return normalizeVersion(value, component === 'nebula' ? 'nebula' : component === 'bepinex' ? 'bepinex' : 'plugin')
  } catch {
    throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_REQUEST_INVALID')
  }
}

function normalizeStatusVersion(value: string | null, component: 'nebula' | 'bepinex'): string | null {
  if (value === null) return null
  try {
    return normalizeVersion(value, component)
  } catch {
    throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_SMOKE_STATUS_FAILED')
  }
}

function normalizeAdapterError(error: unknown, fallback: string): WindowsUpdateActivationAdapterError {
  return error instanceof WindowsUpdateActivationAdapterError
    ? error
    : new WindowsUpdateActivationAdapterError(fallback)
}

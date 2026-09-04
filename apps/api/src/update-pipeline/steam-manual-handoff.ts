import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { hostname, uptime } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { HostMutationLeaseError } from '../host-mutation/lease.js'
import {
  HostMutationOperationCoordinatorError,
  hostMutationReturn,
  hostMutationThrow,
  type HostMutationOperationCoordinator,
  type HostMutationOperationScope,
  type HostMutationRecoveryOperationCoordinator
} from '../host-mutation/operation-coordinator.js'
import { normalizeVersion } from '../updates/version.js'

const requestIdSchema = z.string().uuid().transform((value) => value.toLowerCase())
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
const versionSchema = z.string().trim().min(1).max(64)
const isoDateSchema = z.string().datetime({ offset: true })
const opaqueIdSchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)

export const steamManualHandoffRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  targetVersion: versionSchema,
  expectedRevision: sha256Schema
})

export interface SteamManualHandoffRequest {
  requestId: string
  targetVersion: string
  expectedRevision: string
}

export interface SteamManualHandoffBaseline {
  dspVersion: string
  compatibilityRevision: string
  compatible: true
  loadedSaveIdentity: string
}

export interface SteamManualHandoffProtectionReceipt {
  requestId: string
  backupId: string
  manifestSha256: string
  saveIdentity: string
  pairProtected: true
  durable: true
}

export interface SteamManualHandoffRuntimeSample {
  dspVersion: string
  compatibilityRevision: string
  compatible: boolean
}

export interface SteamManualHandoffLoadEvidence extends SteamManualHandoffRuntimeSample {
  startupGenerationId: string
  bridgeHeartbeatGenerationId: string
  loadedSaveLogGenerationId: string
  loadedSaveIdentity: string
}

export interface SteamManualHandoffAdapters {
  captureBaseline(
    request: Readonly<SteamManualHandoffRequest>,
    hostMutation: HostMutationOperationScope
  ): Promise<SteamManualHandoffBaseline>
  createProtectionPoint(
    request: Readonly<Pick<SteamManualHandoffRequest, 'requestId' | 'targetVersion'>>,
    hostMutation: HostMutationOperationScope
  ): Promise<SteamManualHandoffProtectionReceipt>
  requestGracefulStop(
    request: Readonly<{ requestId: string }>,
    hostMutation: HostMutationOperationScope
  ): Promise<{ dispatched: true }>
  verifyStopped(
    request: Readonly<{ requestId: string }>,
    hostMutation: HostMutationOperationScope
  ): Promise<{ processStopped: true; portClosed: true }>
  resampleUpdatedRuntime(
    request: Readonly<{ requestId: string; targetVersion: string }>,
    hostMutation: HostMutationOperationScope
  ): Promise<SteamManualHandoffRuntimeSample>
  startAndVerifyExactSave(
    request: Readonly<{
      requestId: string
      targetVersion: string
      expectedLoadedSaveIdentity: string
    }>,
    hostMutation: HostMutationOperationScope
  ): Promise<SteamManualHandoffLoadEvidence>
}

export interface SteamManualHandoffOptions extends SteamManualHandoffAdapters {
  stateRoot: string
  hostMutationCoordinator?: HostMutationOperationCoordinator
  hostMutationRecoveryCoordinator?: HostMutationRecoveryOperationCoordinator
  handoffTimeoutMs?: number
  now?: () => Date
}

export type SteamManualHandoffPhase =
  | 'preparing'
  | 'awaiting-steam-client-update'
  | 'validating-client-update'
  | 'starting-and-verifying'
  | 'succeeded'
  | 'recovery-required'

export interface SteamManualHandoffSteps {
  protectionPoint: 'pending' | 'verified' | 'failed'
  gracefulStop: 'pending' | 'verified' | 'failed'
  stoppedProof: 'pending' | 'verified' | 'failed'
  operatorConfirmation: 'pending' | 'verified'
  versionResample: 'pending' | 'verified' | 'failed'
  compatibilityResample: 'pending' | 'verified' | 'failed'
  exactSaveLoad: 'pending' | 'verified' | 'failed'
}

export interface SteamManualHandoffReceipt {
  format: 'dyson-control-steam-manual-handoff-receipt'
  schemaVersion: 1
  requestId: string
  targetVersion: string
  phase: SteamManualHandoffPhase
  previousRevision: string
  resultingRevision: string
  transactionBindingSha256: string | null
  protectionBackupId: string | null
  protectionManifestSha256: string | null
  previousDspVersion: string | null
  compatibilityRevision: string | null
  startedAt: string
  expiresAt: string
  completedAt: string | null
  failureCode: string | null
  recoveryRequired: boolean
  steps: SteamManualHandoffSteps
  auditEvents: string[]
  reused: boolean
}

export interface SteamManualHandoffState {
  format: 'dyson-control-steam-manual-handoff-state'
  schemaVersion: 1
  revision: string
  recoveryRequired: boolean
  activeRequestId: string | null
  lastCompletedTargetVersion: string | null
  current: SteamManualHandoffReceipt | null
}

export interface SteamManualHandoffPlan {
  format: 'dyson-control-steam-manual-handoff-plan'
  schemaVersion: 1
  dryRun: true
  requestId: string
  targetVersion: string
  expectedRevision: string
  timeoutSeconds: number
  accountAutomation: false
  operations: readonly [
    'capture-runtime-and-save-baseline',
    'create-paired-save-protection-point',
    'request-graceful-stop',
    'prove-process-stopped-and-port-closed',
    'await-official-steam-client-update',
    'require-fixed-operator-confirmation',
    'resample-exact-dsp-version-and-compatibility',
    'start-and-prove-current-generation-exact-save-load',
    'persist-audit-receipt'
  ]
}

interface StoredStateBase {
  format: 'dyson-control-steam-manual-handoff-state'
  schemaVersion: 1
  recoveryRequired: boolean
  activeRequestId: string | null
  lastCompletedTargetVersion: string | null
}

interface AuditEvent {
  sequence: number
  event: string
  at: string
}

interface StoredJournal {
  format: 'dyson-control-steam-manual-handoff-journal-receipt'
  schemaVersion: 1
  requestFingerprint: string
  request: SteamManualHandoffRequest
  phase: SteamManualHandoffPhase
  previousRevision: string
  resultingRevision: string
  baseline: SteamManualHandoffBaseline | null
  protection: SteamManualHandoffProtectionReceipt | null
  transactionBindingSha256: string | null
  sampledRuntime: SteamManualHandoffRuntimeSample | null
  steps: SteamManualHandoffSteps
  startedAt: string
  expiresAt: string
  completedAt: string | null
  failureCode: string | null
  audit: AuditEvent[]
}

const baselineSchema: z.ZodType<SteamManualHandoffBaseline> = z.strictObject({
  dspVersion: versionSchema,
  compatibilityRevision: sha256Schema,
  compatible: z.literal(true),
  loadedSaveIdentity: sha256Schema
})

const protectionSchema: z.ZodType<SteamManualHandoffProtectionReceipt> = z.strictObject({
  requestId: requestIdSchema,
  backupId: opaqueIdSchema,
  manifestSha256: sha256Schema,
  saveIdentity: sha256Schema,
  pairProtected: z.literal(true),
  durable: z.literal(true)
})

const runtimeSampleSchema: z.ZodType<SteamManualHandoffRuntimeSample> = z.strictObject({
  dspVersion: versionSchema,
  compatibilityRevision: sha256Schema,
  compatible: z.boolean()
})

const loadEvidenceSchema: z.ZodType<SteamManualHandoffLoadEvidence> = z.strictObject({
  dspVersion: versionSchema,
  compatibilityRevision: sha256Schema,
  compatible: z.boolean(),
  startupGenerationId: sha256Schema,
  bridgeHeartbeatGenerationId: sha256Schema,
  loadedSaveLogGenerationId: sha256Schema,
  loadedSaveIdentity: sha256Schema
})

const stepsSchema: z.ZodType<SteamManualHandoffSteps> = z.strictObject({
  protectionPoint: z.enum(['pending', 'verified', 'failed']),
  gracefulStop: z.enum(['pending', 'verified', 'failed']),
  stoppedProof: z.enum(['pending', 'verified', 'failed']),
  operatorConfirmation: z.enum(['pending', 'verified']),
  versionResample: z.enum(['pending', 'verified', 'failed']),
  compatibilityResample: z.enum(['pending', 'verified', 'failed']),
  exactSaveLoad: z.enum(['pending', 'verified', 'failed'])
})

const auditSchema: z.ZodType<AuditEvent> = z.strictObject({
  sequence: z.number().int().min(1).max(32),
  event: z.string().min(1).max(96).regex(/^[a-z0-9-]+$/),
  at: isoDateSchema
})

const journalSchema: z.ZodType<StoredJournal> = z.strictObject({
  format: z.literal('dyson-control-steam-manual-handoff-journal-receipt'),
  schemaVersion: z.literal(1),
  requestFingerprint: sha256Schema,
  request: steamManualHandoffRequestSchema,
  phase: z.enum([
    'preparing', 'awaiting-steam-client-update', 'validating-client-update',
    'starting-and-verifying', 'succeeded', 'recovery-required'
  ]),
  previousRevision: sha256Schema,
  resultingRevision: sha256Schema,
  baseline: baselineSchema.nullable(),
  protection: protectionSchema.nullable(),
  transactionBindingSha256: sha256Schema.nullable(),
  sampledRuntime: runtimeSampleSchema.nullable(),
  steps: stepsSchema,
  startedAt: isoDateSchema,
  expiresAt: isoDateSchema,
  completedAt: isoDateSchema.nullable(),
  failureCode: z.string().regex(/^DSP_STEAM_HANDOFF_[A-Z0-9_]{1,72}$/).nullable(),
  audit: z.array(auditSchema).min(1).max(32)
}).superRefine((value, context) => {
  if (value.audit.some((event, index) => event.sequence !== index + 1)) {
    context.addIssue({ code: 'custom', message: 'audit sequence is not canonical' })
  }
  const bindingReady = value.baseline !== null && value.protection !== null && value.transactionBindingSha256 !== null
  if (value.phase !== 'preparing' && !bindingReady) {
    context.addIssue({ code: 'custom', message: 'handoff binding is incomplete' })
  }
})

const stateBaseSchema: z.ZodType<StoredStateBase> = z.strictObject({
  format: z.literal('dyson-control-steam-manual-handoff-state'),
  schemaVersion: z.literal(1),
  recoveryRequired: z.boolean(),
  activeRequestId: requestIdSchema.nullable(),
  lastCompletedTargetVersion: versionSchema.nullable()
})

const storedStateSchema = z.strictObject({
  format: z.literal('dyson-control-steam-manual-handoff-state'),
  schemaVersion: z.literal(1),
  recoveryRequired: z.boolean(),
  activeRequestId: requestIdSchema.nullable(),
  lastCompletedTargetVersion: versionSchema.nullable(),
  revision: sha256Schema
})

const initialStateBase: StoredStateBase = {
  format: 'dyson-control-steam-manual-handoff-state',
  schemaVersion: 1,
  recoveryRequired: false,
  activeRequestId: null,
  lastCompletedTargetVersion: null
}

export const initialSteamManualHandoffRevision = computeStateRevision(initialStateBase)

export class SteamManualHandoffError extends Error {
  readonly code: string
  readonly receipt: SteamManualHandoffReceipt | null

  constructor(code: string, options?: ErrorOptions & { receipt?: SteamManualHandoffReceipt | null }) {
    super(code, options)
    this.name = 'SteamManualHandoffError'
    this.code = code
    this.receipt = options?.receipt ?? null
  }
}

export class SteamManualHandoffService {
  readonly #stateRoot: string
  readonly #journalsRoot: string
  readonly #locksRoot: string
  readonly #hostMutationCoordinator: HostMutationOperationCoordinator | null
  readonly #hostMutationRecoveryCoordinator: HostMutationRecoveryOperationCoordinator | null
  readonly #adapters: SteamManualHandoffAdapters
  readonly #timeoutMs: number
  readonly #now: () => Date
  #tail: Promise<void> = Promise.resolve()

  constructor(options: SteamManualHandoffOptions) {
    if (!path.isAbsolute(options.stateRoot)) throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_ROOT_INVALID')
    this.#stateRoot = path.resolve(options.stateRoot)
    this.#journalsRoot = path.join(this.#stateRoot, 'transactions')
    this.#locksRoot = path.join(this.#stateRoot, '.locks')
    this.#hostMutationCoordinator = options.hostMutationCoordinator ?? null
    this.#hostMutationRecoveryCoordinator = options.hostMutationRecoveryCoordinator ?? null
    this.#timeoutMs = options.handoffTimeoutMs ?? 30 * 60 * 1_000
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1_000 || this.#timeoutMs > 24 * 60 * 60 * 1_000) {
      throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_TIMEOUT_INVALID')
    }
    for (const name of [
      'captureBaseline', 'createProtectionPoint', 'requestGracefulStop', 'verifyStopped',
      'resampleUpdatedRuntime', 'startAndVerifyExactSave'
    ] as const) {
      if (typeof options[name] !== 'function') throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_ADAPTER_INVALID')
    }
    this.#adapters = options
    this.#now = options.now ?? (() => new Date())
  }

  async preview(input: unknown): Promise<SteamManualHandoffPlan> {
    const request = normalizeRequest(input)
    const state = await this.#loadState(false)
    if (state.recoveryRequired || state.activeRequestId !== null) {
      throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_RECOVERY_REQUIRED')
    }
    if (state.revision !== request.expectedRevision) {
      throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_REVISION_CONFLICT')
    }
    return {
      format: 'dyson-control-steam-manual-handoff-plan',
      schemaVersion: 1,
      dryRun: true,
      requestId: request.requestId,
      targetVersion: request.targetVersion,
      expectedRevision: request.expectedRevision,
      timeoutSeconds: Math.floor(this.#timeoutMs / 1_000),
      accountAutomation: false,
      operations: [
        'capture-runtime-and-save-baseline',
        'create-paired-save-protection-point',
        'request-graceful-stop',
        'prove-process-stopped-and-port-closed',
        'await-official-steam-client-update',
        'require-fixed-operator-confirmation',
        'resample-exact-dsp-version-and-compatibility',
        'start-and-prove-current-generation-exact-save-load',
        'persist-audit-receipt'
      ]
    }
  }

  async begin(input: unknown): Promise<SteamManualHandoffReceipt> {
    const request = normalizeRequest(input)
    return await this.#serialize(async () => {
      await this.#initialize()
      return await this.#withLock(async () => {
        const existing = await this.#readJournal(request.requestId)
        if (existing !== null) return replayJournal(existing, request)
        const state = await this.#loadState(true)
        if (state.recoveryRequired || state.activeRequestId !== null) {
          throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_RECOVERY_REQUIRED')
        }
        if (state.revision !== request.expectedRevision) {
          throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_REVISION_CONFLICT')
        }
        if (this.#hostMutationCoordinator === null) {
          throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_HOST_LEASE_UNAVAILABLE')
        }
        try {
          return await this.#hostMutationCoordinator.runExclusive(
            { operation: 'dsp-steam-manual-handoff', requestId: request.requestId },
            async (scope) => {
              let journal: StoredJournal | null = null
              try {
                scope.assertActive()
                const baseline = baselineSchema.parse(await this.#adapters.captureBaseline(request, scope))
                scope.assertActive()
                const startedAt = this.#timestamp()
                journal = journalSchema.parse({
                  format: 'dyson-control-steam-manual-handoff-journal-receipt',
                  schemaVersion: 1,
                  requestFingerprint: fingerprintRequest(request),
                  request,
                  phase: 'preparing',
                  previousRevision: state.revision,
                  resultingRevision: state.revision,
                  baseline,
                  protection: null,
                  transactionBindingSha256: null,
                  sampledRuntime: null,
                  steps: pendingSteps(),
                  startedAt,
                  expiresAt: new Date(Date.parse(startedAt) + this.#timeoutMs).toISOString(),
                  completedAt: null,
                  failureCode: null,
                  audit: [{ sequence: 1, event: 'baseline-captured', at: startedAt }]
                })
                await this.#writeJournal(journal, scope)

                const protection = protectionSchema.parse(await this.#adapters.createProtectionPoint({
                  requestId: request.requestId,
                  targetVersion: request.targetVersion
                }, scope))
                scope.assertActive()
                if (protection.requestId !== request.requestId || protection.saveIdentity !== baseline.loadedSaveIdentity) {
                  throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_PROTECTION_MISMATCH')
                }
                const binding = bindingDigest(request, baseline, protection)
                journal = appendEvent({
                  ...journal,
                  protection,
                  transactionBindingSha256: binding,
                  steps: { ...journal.steps, protectionPoint: 'verified' }
                }, 'protection-verified', this.#timestamp())
                await this.#writeJournal(journal, scope)

                z.strictObject({ dispatched: z.literal(true) }).parse(
                  await this.#adapters.requestGracefulStop({ requestId: request.requestId }, scope)
                )
                scope.assertActive()
                journal = appendEvent({
                  ...journal,
                  steps: { ...journal.steps, gracefulStop: 'verified' }
                }, 'graceful-stop-dispatched', this.#timestamp())
                await this.#writeJournal(journal, scope)

                z.strictObject({ processStopped: z.literal(true), portClosed: z.literal(true) }).parse(
                  await this.#adapters.verifyStopped({ requestId: request.requestId }, scope)
                )
                scope.assertActive()
                const activeState = buildState({
                  ...stateBase(state), recoveryRequired: false, activeRequestId: request.requestId
                })
                journal = appendEvent({
                  ...journal,
                  phase: 'awaiting-steam-client-update',
                  resultingRevision: activeState.revision,
                  steps: { ...journal.steps, stoppedProof: 'verified' }
                }, 'awaiting-steam-client-update', this.#timestamp())
                await this.#writeJournal(journal, scope)
                await this.#writeState(activeState, scope)
                return hostMutationReturn(makeReceipt(journal, false), 'abandon')
              } catch (error) {
                if (error instanceof HostMutationLeaseError) throw error
                if (journal === null) return hostMutationThrow<SteamManualHandoffReceipt>(
                  normalizeError(error, 'DSP_STEAM_HANDOFF_BASELINE_FAILED'), 'release'
                )
                const failed = appendEvent({
                  ...journal,
                  phase: 'recovery-required',
                  completedAt: this.#timestamp(),
                  failureCode: safeFailureCode(error, 'DSP_STEAM_HANDOFF_PREPARATION_FAILED'),
                  steps: markCurrentStepFailed(journal.steps)
                }, 'recovery-required', this.#timestamp())
                await this.#writeJournal(failed, scope)
                await this.#writeState(buildState({
                  ...stateBase(state), recoveryRequired: true, activeRequestId: request.requestId
                }), scope)
                return hostMutationReturn(makeReceipt(failed, false), 'abandon')
              }
            }
          )
        } catch (error) {
          throw mapCoordinatorError(error)
        }
      })
    })
  }

  async confirm(requestIdInput: unknown): Promise<SteamManualHandoffReceipt> {
    const requestId = requestIdSchema.parse(requestIdInput)
    return await this.#serialize(async () => {
      await this.#initialize()
      return await this.#withLock(async () => {
        const before = await this.#requireJournal(requestId)
        if (before.phase === 'succeeded') return makeReceipt(before, true)
        if (before.phase === 'recovery-required') {
          throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_RECOVERY_REQUIRED', {
            receipt: makeReceipt(before, true)
          })
        }
        if (before.phase !== 'awaiting-steam-client-update') {
          throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_PHASE_CONFLICT')
        }
        if (this.#hostMutationRecoveryCoordinator === null) {
          throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_HOST_LEASE_UNAVAILABLE')
        }
        try {
          return await this.#hostMutationRecoveryCoordinator.runRecoveryExclusive(
            { expectedOperation: 'dsp-steam-manual-handoff', expectedRequestId: requestId },
            async (scope) => {
              let journal = await this.#requireJournal(requestId)
              if (this.#expired(journal)) {
                journal = await this.#persistRecoveryRequired(
                  journal, 'DSP_STEAM_HANDOFF_TIMEOUT', 'handoff-timeout', scope
                )
                return hostMutationReturn(makeReceipt(journal, false), 'abandon')
              }
              try {
                journal = appendEvent({
                  ...journal,
                  phase: 'validating-client-update',
                  steps: { ...journal.steps, operatorConfirmation: 'verified' }
                }, 'operator-confirmed', this.#timestamp())
                await this.#writeJournal(journal, scope)
                const sample = runtimeSampleSchema.parse(await this.#adapters.resampleUpdatedRuntime({
                  requestId,
                  targetVersion: journal.request.targetVersion
                }, scope))
                scope.assertActive()
                const normalizedObserved = normalizeVersion(sample.dspVersion, 'dsp')
                if (normalizedObserved !== journal.request.targetVersion) {
                  const retryable = appendEvent({
                    ...journal,
                    phase: 'awaiting-steam-client-update',
                    sampledRuntime: sample,
                    failureCode: 'DSP_STEAM_HANDOFF_VERSION_MISMATCH',
                    steps: {
                      ...journal.steps,
                      operatorConfirmation: 'pending',
                      versionResample: 'failed',
                      compatibilityResample: sample.compatible ? 'verified' : 'failed'
                    }
                  }, 'version-resample-rejected', this.#timestamp())
                  await this.#writeJournal(retryable, scope)
                  return hostMutationThrow<SteamManualHandoffReceipt>(
                    new SteamManualHandoffError('DSP_STEAM_HANDOFF_VERSION_MISMATCH'), 'abandon'
                  )
                }
                if (!sample.compatible) {
                  const retryable = appendEvent({
                    ...journal,
                    phase: 'awaiting-steam-client-update',
                    sampledRuntime: sample,
                    failureCode: 'DSP_STEAM_HANDOFF_COMPATIBILITY_CONFLICT',
                    steps: {
                      ...journal.steps,
                      operatorConfirmation: 'pending',
                      versionResample: 'verified',
                      compatibilityResample: 'failed'
                    }
                  }, 'compatibility-resample-rejected', this.#timestamp())
                  await this.#writeJournal(retryable, scope)
                  return hostMutationThrow<SteamManualHandoffReceipt>(
                    new SteamManualHandoffError('DSP_STEAM_HANDOFF_COMPATIBILITY_CONFLICT'), 'abandon'
                  )
                }
                journal = appendEvent({
                  ...journal,
                  phase: 'starting-and-verifying',
                  sampledRuntime: sample,
                  failureCode: null,
                  steps: {
                    ...journal.steps,
                    versionResample: 'verified',
                    compatibilityResample: 'verified'
                  }
                }, 'runtime-resampled', this.#timestamp())
                await this.#writeJournal(journal, scope)
                const baseline = requireBaseline(journal)
                const loaded = loadEvidenceSchema.parse(await this.#adapters.startAndVerifyExactSave({
                  requestId,
                  targetVersion: journal.request.targetVersion,
                  expectedLoadedSaveIdentity: baseline.loadedSaveIdentity
                }, scope))
                scope.assertActive()
                if (!exactLoadMatches(journal, loaded)) {
                  throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_EXACT_SAVE_LOAD_UNPROVEN')
                }
                const currentState = await this.#loadState(true)
                const succeededState = buildState({
                  ...stateBase(currentState),
                  recoveryRequired: false,
                  activeRequestId: null,
                  lastCompletedTargetVersion: journal.request.targetVersion
                })
                journal = appendEvent({
                  ...journal,
                  phase: 'succeeded',
                  resultingRevision: succeededState.revision,
                  completedAt: this.#timestamp(),
                  failureCode: null,
                  steps: { ...journal.steps, exactSaveLoad: 'verified' }
                }, 'handoff-succeeded', this.#timestamp())
                await this.#writeJournal(journal, scope)
                await this.#writeState(succeededState, scope)
                return hostMutationReturn(makeReceipt(journal, false), 'release')
              } catch (error) {
                if (error instanceof HostMutationLeaseError) throw error
                const failed = await this.#persistRecoveryRequired(
                  journal,
                  safeFailureCode(error, 'DSP_STEAM_HANDOFF_START_FAILED'),
                  'recovery-required',
                  scope
                )
                return hostMutationReturn(makeReceipt(failed, false), 'abandon')
              }
            }
          )
        } catch (error) {
          throw mapCoordinatorError(error)
        }
      })
    })
  }

  async reconcile(): Promise<SteamManualHandoffReceipt | null> {
    return await this.#serialize(async () => {
      await this.#initialize()
      return await this.#withLock(async () => {
        const active = await this.#activeJournals()
        if (active.length === 0) return null
        if (active.length > 1) throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_RECONCILIATION_AMBIGUOUS')
        const journal = active[0]!
        if (journal.phase === 'awaiting-steam-client-update' && !this.#expired(journal)) {
          return makeReceipt(journal, false)
        }
        if (journal.phase === 'recovery-required') return makeReceipt(journal, false)
        if (this.#hostMutationRecoveryCoordinator === null) {
          throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_HOST_LEASE_UNAVAILABLE')
        }
        try {
          return await this.#hostMutationRecoveryCoordinator.runRecoveryExclusive(
            { expectedOperation: 'dsp-steam-manual-handoff', expectedRequestId: journal.request.requestId },
            async (scope) => {
              const current = await this.#requireJournal(journal.request.requestId)
              const code = this.#expired(current)
                ? 'DSP_STEAM_HANDOFF_TIMEOUT'
                : 'DSP_STEAM_HANDOFF_INTERRUPTED'
              const failed = await this.#persistRecoveryRequired(current, code, 'restart-recovery-required', scope)
              return hostMutationReturn(makeReceipt(failed, false), 'abandon')
            }
          )
        } catch (error) {
          throw mapCoordinatorError(error)
        }
      })
    })
  }

  async getReceipt(requestIdInput: unknown): Promise<SteamManualHandoffReceipt | null> {
    const requestId = requestIdSchema.parse(requestIdInput)
    await this.#assertRoot(false)
    const journal = await this.#readJournal(requestId)
    if (journal === null) return null
    return makeReceipt(journal, false)
  }

  async getState(): Promise<SteamManualHandoffState> {
    await this.#assertRoot(false)
    const state = await this.#loadState(false)
    let current: SteamManualHandoffReceipt | null = null
    if (state.activeRequestId !== null) {
      const journal = await this.#readJournal(state.activeRequestId)
      if (journal === null) throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_STATE_INVALID')
      current = makeReceipt(journal, false)
    }
    return {
      ...state,
      recoveryRequired: state.recoveryRequired || current?.phase === 'recovery-required' ||
        (current !== null && this.#expiredReceipt(current)),
      current
    }
  }

  async #persistRecoveryRequired(
    journal: StoredJournal,
    failureCode: string,
    event: string,
    scope: HostMutationOperationScope
  ): Promise<StoredJournal> {
    const failed = appendEvent({
      ...journal,
      phase: 'recovery-required',
      failureCode,
      completedAt: this.#timestamp(),
      steps: markCurrentStepFailed(journal.steps)
    }, event, this.#timestamp())
    await this.#writeJournal(failed, scope)
    const state = await this.#loadState(true)
    await this.#writeState(buildState({
      ...stateBase(state), recoveryRequired: true, activeRequestId: journal.request.requestId
    }), scope)
    return failed
  }

  async #initialize(): Promise<void> {
    await mkdir(this.#stateRoot, { recursive: true })
    await Promise.all([mkdir(this.#journalsRoot, { recursive: true }), mkdir(this.#locksRoot, { recursive: true })])
    await this.#assertRoot(true)
    const statePath = path.join(this.#stateRoot, 'state.json')
    if (!await exists(statePath)) await writeAtomicJson(statePath, initialState(), undefined)
  }

  async #assertRoot(required: boolean): Promise<void> {
    const info = await lstat(this.#stateRoot).catch((error: unknown) => {
      if (!required && isNodeError(error, 'ENOENT')) return null
      throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_ROOT_INVALID')
    })
    if (info === null) return
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_ROOT_INVALID')
    }
  }

  async #loadState(required: boolean): Promise<z.infer<typeof storedStateSchema>> {
    const value = await readJson(path.join(this.#stateRoot, 'state.json'), required)
    if (value === null) return initialState()
    try {
      const state = storedStateSchema.parse(value)
      if (computeStateRevision(stateBase(state)) !== state.revision) throw new Error('revision mismatch')
      return state
    } catch (error) {
      throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_STATE_INVALID', { cause: error })
    }
  }

  async #writeState(state: z.infer<typeof storedStateSchema>, scope: HostMutationOperationScope): Promise<void> {
    if (computeStateRevision(stateBase(state)) !== state.revision) {
      throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_STATE_INVALID')
    }
    await writeAtomicJson(path.join(this.#stateRoot, 'state.json'), state, scope)
  }

  async #readJournal(requestId: string): Promise<StoredJournal | null> {
    const value = await readJson(path.join(this.#journalsRoot, `${requestId}.json`), false)
    if (value === null) return null
    try {
      const journal = journalSchema.parse(value)
      if (journal.request.requestId !== requestId ||
          journal.requestFingerprint !== fingerprintRequest(journal.request)) throw new Error('identity mismatch')
      if (journal.transactionBindingSha256 !== null && journal.baseline !== null && journal.protection !== null &&
          journal.transactionBindingSha256 !== bindingDigest(journal.request, journal.baseline, journal.protection)) {
        throw new Error('binding mismatch')
      }
      return journal
    } catch (error) {
      throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_JOURNAL_INVALID', { cause: error })
    }
  }

  async #requireJournal(requestId: string): Promise<StoredJournal> {
    const journal = await this.#readJournal(requestId)
    if (journal === null) throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_RECEIPT_NOT_FOUND')
    return journal
  }

  async #writeJournal(journal: StoredJournal, scope: HostMutationOperationScope): Promise<void> {
    await writeAtomicJson(
      path.join(this.#journalsRoot, `${journal.request.requestId}.json`),
      journalSchema.parse(journal),
      scope
    )
  }

  async #activeJournals(): Promise<StoredJournal[]> {
    const entries = await readdir(this.#journalsRoot, { withFileTypes: true })
    const result: StoredJournal[] = []
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^[0-9a-f-]{36}\.json$/i.test(entry.name)) {
        throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_JOURNAL_DIRECTORY_INVALID')
      }
      const journal = await this.#requireJournal(entry.name.slice(0, -5).toLowerCase())
      if (journal.phase !== 'succeeded') result.push(journal)
    }
    return result
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = path.join(this.#locksRoot, 'handoff.lock')
    const handle = await acquireLock(lockPath)
    try { return await operation() } finally {
      await handle.close().catch(() => undefined)
      await unlink(lockPath).catch(() => undefined)
    }
  }

  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail
    let release!: () => void
    this.#tail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try { return await operation() } finally { release() }
  }

  #expired(journal: StoredJournal): boolean {
    return this.#now().getTime() >= Date.parse(journal.expiresAt)
  }

  #expiredReceipt(receipt: SteamManualHandoffReceipt): boolean {
    return this.#now().getTime() >= Date.parse(receipt.expiresAt) &&
      receipt.phase !== 'succeeded' && receipt.phase !== 'recovery-required'
  }

  #timestamp(): string {
    const value = this.#now()
    if (!Number.isFinite(value.getTime())) throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_CLOCK_INVALID')
    return value.toISOString()
  }
}

function normalizeRequest(input: unknown): SteamManualHandoffRequest {
  let request: z.infer<typeof steamManualHandoffRequestSchema>
  try { request = steamManualHandoffRequestSchema.parse(input) } catch {
    throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_REQUEST_INVALID')
  }
  try {
    return { ...request, targetVersion: normalizeVersion(request.targetVersion, 'dsp') }
  } catch (error) {
    throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_REQUEST_INVALID', { cause: error })
  }
}

function pendingSteps(): SteamManualHandoffSteps {
  return {
    protectionPoint: 'pending', gracefulStop: 'pending', stoppedProof: 'pending',
    operatorConfirmation: 'pending', versionResample: 'pending',
    compatibilityResample: 'pending', exactSaveLoad: 'pending'
  }
}

function markCurrentStepFailed(steps: SteamManualHandoffSteps): SteamManualHandoffSteps {
  const next = { ...steps }
  if (next.protectionPoint === 'pending') next.protectionPoint = 'failed'
  else if (next.gracefulStop === 'pending') next.gracefulStop = 'failed'
  else if (next.stoppedProof === 'pending') next.stoppedProof = 'failed'
  else if (next.versionResample === 'pending') next.versionResample = 'failed'
  else if (next.compatibilityResample === 'pending') next.compatibilityResample = 'failed'
  else if (next.exactSaveLoad === 'pending') next.exactSaveLoad = 'failed'
  return next
}

function appendEvent(journal: StoredJournal, event: string, at: string): StoredJournal {
  return journalSchema.parse({
    ...journal,
    audit: [...journal.audit, { sequence: journal.audit.length + 1, event, at }]
  })
}

function fingerprintRequest(request: SteamManualHandoffRequest): string {
  return sha256(canonicalJson(request))
}

function bindingDigest(
  request: SteamManualHandoffRequest,
  baseline: SteamManualHandoffBaseline,
  protection: SteamManualHandoffProtectionReceipt
): string {
  return sha256(canonicalJson({ request, baseline, protection }))
}

function exactLoadMatches(journal: StoredJournal, evidence: SteamManualHandoffLoadEvidence): boolean {
  const baseline = requireBaseline(journal)
  return normalizeVersion(evidence.dspVersion, 'dsp') === journal.request.targetVersion &&
    evidence.compatible && evidence.compatibilityRevision === journal.sampledRuntime?.compatibilityRevision &&
    evidence.startupGenerationId === evidence.bridgeHeartbeatGenerationId &&
    evidence.startupGenerationId === evidence.loadedSaveLogGenerationId &&
    evidence.loadedSaveIdentity === baseline.loadedSaveIdentity
}

function requireBaseline(journal: StoredJournal): SteamManualHandoffBaseline {
  if (journal.baseline === null || journal.protection === null || journal.transactionBindingSha256 === null) {
    throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_BINDING_INVALID')
  }
  return journal.baseline
}

function makeReceipt(journal: StoredJournal, reused: boolean): SteamManualHandoffReceipt {
  return {
    format: 'dyson-control-steam-manual-handoff-receipt',
    schemaVersion: 1,
    requestId: journal.request.requestId,
    targetVersion: journal.request.targetVersion,
    phase: journal.phase,
    previousRevision: journal.previousRevision,
    resultingRevision: journal.resultingRevision,
    transactionBindingSha256: journal.transactionBindingSha256,
    protectionBackupId: journal.protection?.backupId ?? null,
    protectionManifestSha256: journal.protection?.manifestSha256 ?? null,
    previousDspVersion: journal.baseline?.dspVersion ?? null,
    compatibilityRevision: journal.sampledRuntime?.compatibilityRevision ?? journal.baseline?.compatibilityRevision ?? null,
    startedAt: journal.startedAt,
    expiresAt: journal.expiresAt,
    completedAt: journal.completedAt,
    failureCode: journal.failureCode,
    recoveryRequired: journal.phase === 'recovery-required',
    steps: structuredClone(journal.steps),
    auditEvents: journal.audit.map((event) => event.event),
    reused
  }
}

function replayJournal(journal: StoredJournal, request: SteamManualHandoffRequest): SteamManualHandoffReceipt {
  if (journal.requestFingerprint !== fingerprintRequest(request)) {
    throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_IDEMPOTENCY_CONFLICT')
  }
  return makeReceipt(journal, true)
}

function initialState(): z.infer<typeof storedStateSchema> {
  return { ...initialStateBase, revision: initialSteamManualHandoffRevision }
}

function buildState(base: StoredStateBase): z.infer<typeof storedStateSchema> {
  const parsed = stateBaseSchema.parse(base)
  return { ...parsed, revision: computeStateRevision(parsed) }
}

function stateBase(state: z.infer<typeof storedStateSchema>): StoredStateBase {
  const { revision: _revision, ...base } = state
  return stateBaseSchema.parse(base)
}

function computeStateRevision(base: StoredStateBase): string {
  return sha256(canonicalJson(base))
}

function safeFailureCode(error: unknown, fallback: string): string {
  if (error instanceof SteamManualHandoffError && /^DSP_STEAM_HANDOFF_[A-Z0-9_]{1,72}$/.test(error.code)) {
    return error.code
  }
  return fallback
}

function normalizeError(error: unknown, fallback: string): SteamManualHandoffError {
  return error instanceof SteamManualHandoffError ? error : new SteamManualHandoffError(fallback, { cause: error })
}

function mapCoordinatorError(error: unknown): SteamManualHandoffError {
  if (error instanceof SteamManualHandoffError) return error
  if (error instanceof HostMutationLeaseError) return new SteamManualHandoffError('DSP_STEAM_HANDOFF_HOST_LEASE_LOST')
  if (error instanceof HostMutationOperationCoordinatorError) {
    switch (error.code) {
      case 'HOST_MUTATION_LEASE_BUSY': return new SteamManualHandoffError('DSP_STEAM_HANDOFF_HOST_LEASE_BUSY')
      case 'HOST_MUTATION_LEASE_DIRTY':
      case 'HOST_MUTATION_LEASE_RECOVERY_REQUIRED':
        return new SteamManualHandoffError('DSP_STEAM_HANDOFF_RECOVERY_REQUIRED')
      case 'HOST_MUTATION_LEASE_RECOVERY_NOT_REQUIRED':
        return new SteamManualHandoffError('DSP_STEAM_HANDOFF_RECOVERY_BINDING_MISSING')
      case 'HOST_MUTATION_LEASE_RECOVERY_MISMATCH':
        return new SteamManualHandoffError('DSP_STEAM_HANDOFF_RECOVERY_BINDING_MISMATCH')
      default: return new SteamManualHandoffError('DSP_STEAM_HANDOFF_HOST_LEASE_UNAVAILABLE')
    }
  }
  return new SteamManualHandoffError('DSP_STEAM_HANDOFF_HOST_LEASE_UNAVAILABLE')
}

async function readJson(filePath: string, required: boolean): Promise<unknown | null> {
  try {
    const info = await lstat(filePath)
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 512 * 1_024) {
      throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_PERSISTENCE_INVALID')
    }
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    if (!required && isNodeError(error, 'ENOENT')) return null
    if (error instanceof SteamManualHandoffError) throw error
    throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_PERSISTENCE_INVALID', { cause: error })
  }
}

async function writeAtomicJson(
  filePath: string,
  value: unknown,
  scope?: HostMutationOperationScope
): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`
  let handle: FileHandle | null = null
  try {
    scope?.assertActive()
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    await handle.writeFile(`${canonicalJson(value)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    scope?.assertActive()
    await rename(temporary, filePath)
    scope?.assertActive()
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    if (error instanceof HostMutationLeaseError) throw error
    throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_PERSISTENCE_FAILED', { cause: error })
  }
}

async function acquireLock(lockPath: string): Promise<FileHandle> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      await handle.writeFile(`${canonicalJson({
        host: hostname(), bootId: currentBootId(), pid: process.pid, acquiredAt: new Date().toISOString()
      })}\n`, 'utf8')
      await handle.sync()
      return handle
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) {
        throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_LOCK_FAILED', { cause: error })
      }
      if (attempt > 0 || !await removeStaleLock(lockPath)) {
        throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_LOCK_BUSY')
      }
    }
  }
  throw new SteamManualHandoffError('DSP_STEAM_HANDOFF_LOCK_BUSY')
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>
    if (value.host !== hostname() || value.bootId !== currentBootId() ||
        typeof value.pid !== 'number' || !Number.isInteger(value.pid) || value.pid <= 0 || processAlive(value.pid)) {
      return false
    }
    await unlink(lockPath)
    return true
  } catch { return false }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return !isNodeError(error, 'ESRCH') }
}

function currentBootId(): string {
  return Math.round((Date.now() - uptime() * 1_000) / 60_000).toString(36)
}

async function exists(filePath: string): Promise<boolean> {
  return await lstat(filePath).then(() => true, (error: unknown) => {
    if (isNodeError(error, 'ENOENT')) return false
    throw error
  })
}

function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
function canonicalJson(value: unknown): string { return JSON.stringify(sortCanonical(value)) }
function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
      .map(([key, item]) => [key, sortCanonical(item)]))
  }
  return value
}
function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
}

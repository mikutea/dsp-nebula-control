import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { constants } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises'
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
  type HostMutationRecoveryOperationCoordinator,
  type HostMutationOperationScope
} from '../host-mutation/operation-coordinator.js'
import {
  type CompatibilityDecision,
  type NormalizedRuntimeInventory
} from '../updates/compatibility.js'
import { normalizeVersion, sha256Schema } from '../updates/version.js'
import {
  inspectComponentArchive,
  componentReleaseManifestSchema,
  verifyExtractedComponentRelease,
  type ComponentArchiveLimits,
  type ComponentReleaseManifest
} from './activation-archive.js'
import {
  ComponentUpdateActivationError,
  type ActiveComponentSummary,
  type ComponentUpdateActivationOptions,
  type ComponentUpdateActivationPlan,
  type ComponentUpdateActivationReceipt,
  type ComponentUpdateCleanupCandidate,
  type ComponentUpdateCleanupPlan,
  type ComponentUpdateStateSummary,
  type FixedUpdateSmokeRequest,
  type FixedUpdateSmokeResult,
  type ManagedUpdateComponent,
  type SaveProtectionPointReceipt,
  type StoppedStateCheckRequest,
  type StoppedStateProof,
  type UpdateActivationRequest
} from './activation-types.js'
import { FixedLiveComponentDeployment } from './activation-live.js'
import { stagedArtifactManifestSchema, type StagedArtifactManifest } from './staging.js'
import { TrustedCompatibilityError } from './trusted-compatibility.js'

const managedComponentSchema = z.enum(['nebula', 'bepinex', 'bridge', 'control'])
const updateComponentSchema = z.enum(['dsp', 'nebula', 'bepinex', 'bridge', 'control'])
const artifactIdSchema = z.string().min(16).max(96).regex(/^[a-z0-9][a-z0-9-]+$/)
const revisionSchema = z.string().regex(/^[0-9a-f]{64}$/)
const releaseIdSchema = z.string().regex(/^(?:nebula|bepinex|bridge|control)-[0-9a-f]{32}$/)
const isoDateSchema = z.string().datetime({ offset: true })
const backupIdSchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const requestIdSchema = z.string().uuid()

export const componentUpdateActivationRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  component: updateComponentSchema,
  artifactId: artifactIdSchema.nullable().optional(),
  sha256: sha256Schema.nullable().optional(),
  targetVersion: z.string().trim().min(1).max(64),
  expectedRevision: revisionSchema,
  compatibilityReceiptId: requestIdSchema.optional()
}).superRefine((value, context) => {
  if (value.component !== 'dsp') {
    if (value.artifactId === undefined || value.artifactId === null) {
      context.addIssue({ code: 'custom', message: 'managed update requires an artifact ID' })
    }
    if (value.sha256 === undefined || value.sha256 === null) {
      context.addIssue({ code: 'custom', message: 'managed update requires an artifact digest' })
    }
    if (value.compatibilityReceiptId === undefined) {
      context.addIssue({ code: 'custom', message: 'managed update requires a compatibility receipt' })
    }
  }
})

interface NormalizedActivationRequest {
  requestId: string
  component: ManagedUpdateComponent
  artifactId: string
  sha256: string
  targetVersion: string
  expectedRevision: string
  compatibilityReceiptId: string
}

interface StoredActiveComponent {
  component: ManagedUpdateComponent
  version: string
  artifactId: string
  sha256: string
  releaseId: string
}

interface StoredTransaction {
  requestId: string
  requestFingerprint: string
  component: ManagedUpdateComponent
  artifactId: string
  targetVersion: string
  compatibilityReceiptId: string
  releaseId: string
  previousRevision: string
  protectionBackupId: string
  fileCount: number
  expandedBytes: number
  activatedAt: string
}

interface ActivationHostMutationContext {
  readonly scope: HostMutationOperationScope
  readonly recoveryRequestId: string | null
  markPossibleWrite(): void
  resolvePossibleWrite(): void
  markLiveTerminalVerified(requestId: string, status: 'succeeded' | 'rolled-back'): void
  liveTerminalIsVerified(requestId: string, status: 'succeeded' | 'rolled-back'): boolean
  markRecoveryTerminalPersisted(requestId: string): void
  recoveryTerminalWasPersisted(requestId: string): boolean
}

type RecoveryEvidence =
  | Readonly<{
      kind: 'replay'
      envelope: StoredReceiptEnvelope
      requiresBrokerRelease: boolean
    }>
  | Readonly<{
      kind: 'pending'
      journal: StoredTransactionJournal
      receipt: StoredReceiptEnvelope | null
      state: StoredActiveState
      previousState: StoredActiveState
    }>

interface StoredActiveState {
  format: 'dyson-control-component-active-state'
  schemaVersion: 1
  revision: string
  recoveryRequired: boolean
  components: StoredActiveComponent[]
  lastTransaction: StoredTransaction | null
}

interface StoredReleaseRecord {
  format: 'dyson-control-component-immutable-release'
  schemaVersion: 1
  releaseId: string
  component: ManagedUpdateComponent
  artifactId: string
  artifactSha256: string
  version: string
  manifest: ComponentReleaseManifest
  createdAt: string
}

interface StoredReceiptEnvelope {
  format: 'dyson-control-component-update-receipt-envelope'
  schemaVersion: 1
  requestFingerprint: string
  receipt: ComponentUpdateActivationReceipt
}

interface StoredTransactionJournal {
  format: 'dyson-control-component-update-journal'
  schemaVersion: 1
  transaction: StoredTransaction
}

const storedComponentSchema: z.ZodType<StoredActiveComponent> = z.strictObject({
  component: managedComponentSchema,
  version: z.string().min(1).max(64),
  artifactId: artifactIdSchema,
  sha256: sha256Schema,
  releaseId: releaseIdSchema
})

const storedTransactionSchema: z.ZodType<StoredTransaction> = z.strictObject({
  requestId: requestIdSchema,
  requestFingerprint: revisionSchema,
  component: managedComponentSchema,
  artifactId: artifactIdSchema,
  targetVersion: z.string().min(1).max(64),
  compatibilityReceiptId: requestIdSchema,
  releaseId: releaseIdSchema,
  previousRevision: revisionSchema,
  protectionBackupId: backupIdSchema,
  fileCount: z.number().int().min(1).max(512),
  expandedBytes: z.number().int().min(0).max(2 * 1_024 * 1_024 * 1_024),
  activatedAt: isoDateSchema
})

const storedStateSchema: z.ZodType<StoredActiveState> = z.strictObject({
  format: z.literal('dyson-control-component-active-state'),
  schemaVersion: z.literal(1),
  revision: revisionSchema,
  recoveryRequired: z.boolean(),
  components: z.array(storedComponentSchema).max(4),
  lastTransaction: storedTransactionSchema.nullable()
}).superRefine((value, context) => {
  const sorted = [...value.components].sort(compareStoredComponents)
  if (JSON.stringify(sorted) !== JSON.stringify(value.components)) {
    context.addIssue({ code: 'custom', message: 'components are not canonical' })
  }
  if (new Set(value.components.map((component) => component.component)).size !== value.components.length) {
    context.addIssue({ code: 'custom', message: 'component identity is duplicated' })
  }
  for (const component of value.components) {
    try {
      if (normalizeManagedVersion(component.version, component.component) !== component.version ||
          component.sha256 !== component.sha256.toLowerCase() ||
          !component.releaseId.startsWith(`${component.component}-`)) {
        context.addIssue({ code: 'custom', message: 'component state is not normalized' })
      }
    } catch {
      context.addIssue({ code: 'custom', message: 'component state version is invalid' })
    }
  }
})

const releaseRecordSchema: z.ZodType<StoredReleaseRecord> = z.strictObject({
  format: z.literal('dyson-control-component-immutable-release'),
  schemaVersion: z.literal(1),
  releaseId: releaseIdSchema,
  component: managedComponentSchema,
  artifactId: artifactIdSchema,
  artifactSha256: sha256Schema,
  version: z.string().min(1).max(64),
  manifest: componentReleaseManifestSchema,
  createdAt: isoDateSchema
})

const receiptSchema: z.ZodType<ComponentUpdateActivationReceipt> = z.strictObject({
  format: z.literal('dyson-control-component-update-receipt'),
  schemaVersion: z.literal(1),
  requestId: requestIdSchema,
  component: managedComponentSchema,
  artifactId: artifactIdSchema,
  compatibilityReceiptId: requestIdSchema,
  targetVersion: z.string().min(1).max(64),
  releaseId: releaseIdSchema,
  status: z.enum(['succeeded', 'failed', 'rolled-back', 'rollback-failed']),
  previousRevision: revisionSchema,
  resultingRevision: revisionSchema,
  protectionBackupId: backupIdSchema.nullable(),
  failureCode: z.string().min(1).max(96).regex(/^[A-Z][A-Z0-9_]*$/).nullable(),
  rollbackVerified: z.boolean(),
  recoveryRequired: z.boolean(),
  fileCount: z.number().int().min(0).max(512),
  expandedBytes: z.number().int().min(0).max(2 * 1_024 * 1_024 * 1_024),
  completedAt: isoDateSchema,
  reused: z.boolean()
})

const receiptEnvelopeSchema: z.ZodType<StoredReceiptEnvelope> = z.strictObject({
  format: z.literal('dyson-control-component-update-receipt-envelope'),
  schemaVersion: z.literal(1),
  requestFingerprint: revisionSchema,
  receipt: receiptSchema
})

const journalSchema: z.ZodType<StoredTransactionJournal> = z.strictObject({
  format: z.literal('dyson-control-component-update-journal'),
  schemaVersion: z.literal(1),
  transaction: storedTransactionSchema
})

const stoppedProofSchema: z.ZodType<StoppedStateProof> = z.strictObject({
  processStopped: z.boolean(),
  portClosed: z.boolean()
})

const saveProtectionReceiptSchema: z.ZodType<SaveProtectionPointReceipt> = z.strictObject({
  requestId: requestIdSchema,
  status: z.literal('succeeded'),
  backupId: backupIdSchema,
  pairProtected: z.literal(true),
  durable: z.literal(true)
})

const smokeResultSchema: z.ZodType<FixedUpdateSmokeResult> = z.strictObject({
  component: managedComponentSchema,
  observedVersion: z.string().min(1).max(64).nullable(),
  versionMatches: z.boolean(),
  bepInExLoaded: z.boolean(),
  nebulaLoaded: z.boolean(),
  processHealthy: z.boolean(),
  portHealthy: z.boolean()
})

const activationLockSchema = z.strictObject({
  format: z.literal('dyson-control-component-update-lock'),
  schemaVersion: z.literal(1),
  host: z.string().min(1).max(255),
  bootId: z.string().min(1).max(64),
  pid: z.number().int().positive(),
  instanceId: z.string().uuid(),
  acquiredAt: isoDateSchema
})

const initialStateBase: Omit<StoredActiveState, 'revision'> = {
  format: 'dyson-control-component-active-state',
  schemaVersion: 1,
  recoveryRequired: false,
  components: [],
  lastTransaction: null
}

export const initialComponentUpdateRevision = computeStateRevision(initialStateBase)

/** Fixed provider identities accepted for each managed component. */
export const managedUpdateComponentSourceIds = Object.freeze({
  nebula: 'github:NebulaModTeam/nebula',
  bepinex: 'github:BepInEx/BepInEx',
  bridge: 'thunderstore:DysonControl/Bridge',
  control: 'thunderstore:DysonControl/Control'
} satisfies Record<ManagedUpdateComponent, string>)

export class ComponentUpdateActivationService {
  readonly #projectRoot: string
  readonly #stagingRoot: string
  readonly #controlRoot: string
  readonly #limits: ComponentArchiveLimits
  readonly #maximumHistoryEntries: number
  readonly #now: () => Date
  readonly #verifyStoppedState: ComponentUpdateActivationOptions['verifyStoppedState']
  readonly #createSaveProtectionPoint: ComponentUpdateActivationOptions['createSaveProtectionPoint']
  readonly #smoke: ComponentUpdateActivationOptions['smoke']
  readonly #compatibilityVerifier: ComponentUpdateActivationOptions['compatibilityVerifier']
  readonly #hostMutationCoordinator: HostMutationOperationCoordinator | null
  readonly #hostMutationRecoveryCoordinator: HostMutationRecoveryOperationCoordinator | null
  readonly #liveDeployment: FixedLiveComponentDeployment
  #activeHostMutationContext: ActivationHostMutationContext | null = null
  #tail: Promise<void> = Promise.resolve()

  constructor(options: ComponentUpdateActivationOptions) {
    if (!path.isAbsolute(options.projectRoot) || !path.isAbsolute(options.stagingRoot)) {
      throw new ComponentUpdateActivationError('UPDATE_ROOT_NOT_ABSOLUTE')
    }
    this.#projectRoot = path.resolve(options.projectRoot)
    this.#stagingRoot = path.resolve(options.stagingRoot)
    if (pathsOverlap(this.#projectRoot, this.#stagingRoot)) {
      throw new ComponentUpdateActivationError('UPDATE_ROOT_COLLISION')
    }
    this.#controlRoot = path.join(this.#projectRoot, '.dyson-control-updates')
    this.#limits = {
      maximumArchiveBytes: options.maximumArchiveBytes ?? 512 * 1_024 * 1_024,
      maximumFileBytes: options.maximumFileBytes ?? 256 * 1_024 * 1_024,
      maximumExpandedBytes: options.maximumExpandedBytes ?? 1_024 * 1_024 * 1_024,
      maximumFiles: options.maximumFiles ?? 512
    }
    if (Object.values(this.#limits).some((value) => !Number.isSafeInteger(value) || value <= 0) ||
        this.#limits.maximumFileBytes > this.#limits.maximumExpandedBytes ||
        this.#limits.maximumArchiveBytes > 2 * 1_024 * 1_024 * 1_024 || this.#limits.maximumFiles > 512) {
      throw new ComponentUpdateActivationError('UPDATE_LIMITS_INVALID')
    }
    this.#maximumHistoryEntries = options.maximumHistoryEntries ?? 8
    if (!Number.isInteger(this.#maximumHistoryEntries) || this.#maximumHistoryEntries < 1 || this.#maximumHistoryEntries > 64) {
      throw new ComponentUpdateActivationError('UPDATE_HISTORY_LIMIT_INVALID')
    }
    this.#now = options.now ?? (() => new Date())
    this.#verifyStoppedState = options.verifyStoppedState
    this.#createSaveProtectionPoint = options.createSaveProtectionPoint
    this.#smoke = options.smoke
    if (typeof options.compatibilityVerifier?.assertCurrent !== 'function') {
      throw new ComponentUpdateActivationError('UPDATE_COMPATIBILITY_VERIFIER_INVALID')
    }
    this.#compatibilityVerifier = options.compatibilityVerifier
    this.#hostMutationCoordinator = options.hostMutationCoordinator ?? null
    this.#hostMutationRecoveryCoordinator = options.hostMutationRecoveryCoordinator ?? null
    this.#liveDeployment = new FixedLiveComponentDeployment({
      immutableReleaseRoot: path.join(this.#controlRoot, 'releases'),
      controlRoot: path.join(this.#controlRoot, 'live-deployment'),
      componentRoots: options.liveComponentRoots,
      verifyStoppedState: async (request, hostMutation) => {
        hostMutation.assertActive()
        const proof = await this.#verifyStoppedState(request, hostMutation)
        hostMutation.assertActive()
        return proof
      },
      limits: this.#limits,
      now: this.#now
    })
  }

  async preview(input: unknown): Promise<ComponentUpdateActivationPlan> {
    const request = normalizeActivationRequest(input)
    await this.#assertRoots(false)
    const state = await this.#loadState(false)
    if (state.recoveryRequired) throw new ComponentUpdateActivationError('UPDATE_RECOVERY_REQUIRED')
    if (request.expectedRevision !== state.revision) throw new ComponentUpdateActivationError('UPDATE_REVISION_CONFLICT')
    await this.#assertHistoryCapacity(request.requestId, false)
    const staged = await this.#loadStagedArtifact(request)
    const decision = await this.#evaluateCandidateCompatibility(request, state)
    const inspected = await inspectComponentArchive({
      archivePath: staged.artifactPath,
      expectedComponent: request.component,
      expectedVersion: request.targetVersion,
      expectedArtifactId: request.artifactId,
      limits: this.#limits
    })
    assertStagedContentManifest(request, staged.manifest, inspected.manifest)
    this.#liveDeployment.assertSupportedManifest(request.component, inspected.manifest)
    return createActivationPlan(request, state, decision, inspected.summary.fileCount, inspected.summary.expandedBytes)
  }

  async execute(input: unknown): Promise<ComponentUpdateActivationReceipt> {
    const request = normalizeActivationRequest(input)
    return await this.#serialize(async () => {
      await this.#initialize()
      return await this.#withCrossInstanceLock(async () => {
        return await this.#runHostMutation(
          { operation: 'component-update-activation', requestId: request.requestId },
          async (context) => {
            await this.#reconcilePendingTransactions(context)
            const fingerprint = requestFingerprint(request)
            const existing = await this.#readReceipt(request.requestId)
            if (existing !== null) return handleExistingReceipt(existing, fingerprint)

            let state = await this.#loadState(true)
            const releaseId = createReleaseId(request)
            let fileCount = 0
            let expandedBytes = 0
            let protectionBackupId: string | null = null
            let journalPersisted = false
            try {
              if (state.recoveryRequired) throw new ComponentUpdateActivationError('UPDATE_RECOVERY_REQUIRED')
              if (request.expectedRevision !== state.revision) throw new ComponentUpdateActivationError('UPDATE_REVISION_CONFLICT')
              await this.#assertHistoryCapacity(request.requestId, true)
              const staged = await this.#loadStagedArtifact(request)
              await this.#evaluateCandidateCompatibility(request, state)
              const inspected = await inspectComponentArchive({
                archivePath: staged.artifactPath,
                expectedComponent: request.component,
                expectedVersion: request.targetVersion,
                expectedArtifactId: request.artifactId,
                limits: this.#limits
              })
              assertStagedContentManifest(request, staged.manifest, inspected.manifest)
              this.#liveDeployment.assertSupportedManifest(request.component, inspected.manifest)
              fileCount = inspected.summary.fileCount
              expandedBytes = inspected.summary.expandedBytes
              await this.#assembleImmutableRelease(request, staged, inspected.manifest, releaseId)
              await this.#requireStopped(
                { requestId: request.requestId, component: request.component, phase: 'before-protection' },
                context
              )
              const protection = await this.#createProtection(request, context)
              protectionBackupId = protection.backupId

              state = await this.#loadState(true)
              if (state.recoveryRequired) throw new ComponentUpdateActivationError('UPDATE_RECOVERY_REQUIRED')
              if (request.expectedRevision !== state.revision) throw new ComponentUpdateActivationError('UPDATE_REVISION_CONFLICT')
              const stagedAgain = await this.#loadStagedArtifact(request)
              if (stagedAgain.manifest.sha256 !== staged.manifest.sha256 || stagedAgain.manifest.sizeBytes !== staged.manifest.sizeBytes) {
                throw new ComponentUpdateActivationError('UPDATE_STAGED_ARTIFACT_CHANGED')
              }
              if (canonicalJson(stagedAgain.manifest.componentManifest ?? null) !==
                  canonicalJson(staged.manifest.componentManifest ?? null)) {
                throw new ComponentUpdateActivationError('UPDATE_STAGED_ARTIFACT_CHANGED')
              }
              await this.#evaluateCandidateCompatibility(request, state)
              await this.#verifyImmutableRelease(request, releaseId, inspected.manifest)
              await this.#requireStopped(
                { requestId: request.requestId, component: request.component, phase: 'before-publish' },
                context
              )

              const activatedAt = this.#timestamp()
              const transaction: StoredTransaction = {
                requestId: request.requestId,
                requestFingerprint: fingerprint,
                component: request.component,
                artifactId: request.artifactId,
                targetVersion: request.targetVersion,
                compatibilityReceiptId: request.compatibilityReceiptId,
                releaseId,
                previousRevision: state.revision,
                protectionBackupId: protection.backupId,
                fileCount,
                expandedBytes,
                activatedAt
              }
              await this.#persistHistory(request.requestId, state, context)
              context.markPossibleWrite()
              await this.#persistJournal(transaction, context)
              journalPersisted = true
              context.scope.assertActive()
              await this.#liveDeployment.publishCandidate(
                transactionToLiveRequest(transaction),
                context.scope
              )
              context.scope.assertActive()
              const candidateState = buildCandidateState(state, request, releaseId, transaction)
              await this.#writeActiveState(candidateState, context)
              return await this.#finishActivatedTransaction(transaction, state, candidateState, 'candidate', context)
            } catch (error) {
              if (error instanceof HostMutationLeaseError) throw error
              if (error instanceof CandidateHandledError) return error.receipt
              const normalized = normalizeError(error)
              const current = await this.#loadState(true).catch(() => state)
              if (journalPersisted || (current.lastTransaction?.requestId === request.requestId &&
                  current.lastTransaction.requestFingerprint === fingerprint)) {
                // The active switch is durable but its receipt is not. Leave the
                // immutable journal pending so restart reconciliation can prove the
                // candidate or compensate; never record a misleading terminal fail.
                throw new ComponentUpdateActivationError(normalized.code, { cause: normalized })
              }
              const receipt = createReceipt({
                request,
                releaseId,
                status: 'failed',
                previousRevision: state.revision,
                resultingRevision: current.revision,
                protectionBackupId,
                failureCode: normalized.code,
                rollbackVerified: false,
                recoveryRequired: current.recoveryRequired,
                fileCount,
                expandedBytes,
                completedAt: this.#timestamp()
              })
              await this.#persistReceipt(fingerprint, receipt, context).catch(() => undefined)
              throw new ComponentUpdateActivationError(normalized.code, { cause: normalized, receipt })
            }
          }
        )
      })
    })
  }

  async reconcile(): Promise<ComponentUpdateActivationReceipt | null> {
    return await this.#serialize(async () => {
      await this.#initialize()
      return await this.#withCrossInstanceLock(async () => await this.#runHostMutation(
        { operation: 'component-update-reconciliation', requestId: randomUUID() },
        async (context) => await this.#reconcilePendingTransactions(context)
      ))
    })
  }

  /**
   * Explicit administrator recovery entry point. The caller supplies only the
   * original activation request UUID; the host operation identity is fixed by
   * this service and low-level lease bindings never cross the domain boundary.
   */
  async recoverInterrupted(requestIdInput: unknown): Promise<ComponentUpdateActivationReceipt> {
    const requestId = requestIdSchema.parse(requestIdInput)
    return await this.#serialize(async () => {
      await this.#initialize()
      await this.#proveRecoveryEvidence(requestId)
      if (this.#hostMutationRecoveryCoordinator === null) {
        throw new ComponentUpdateActivationError('UPDATE_HOST_LEASE_UNAVAILABLE')
      }
      try {
        return await this.#runRecoveryHostMutation(requestId, async (context) => {
          return await this.#withCrossInstanceLock(async () => {
            await this.#convergeRecoveryTemporaryEvidence(requestId, context)
            // Re-read after the broker has consumed the exact recovery binding.
            // Recovery temporary evidence is converged only while both the
            // broker lease and the activation lock are held.
            const current = await this.#proveRecoveryEvidence(requestId)
            if (current.kind === 'replay') {
              const matchingJournal = (await this.#readAllJournals(requestId))
                .find((journal) => journal.transaction.requestId === requestId) ?? null
              if (current.envelope.receipt.status === 'failed') {
                if (matchingJournal !== null) {
                  throw new ComponentUpdateActivationError('UPDATE_RECOVERY_TERMINAL_UNPROVEN')
                }
              } else {
                if (matchingJournal === null) {
                  throw new ComponentUpdateActivationError('UPDATE_RECOVERY_TERMINAL_UNPROVEN')
                }
                assertReceiptBoundToTransaction(current.envelope, matchingJournal.transaction)
                await this.#proveRecoveryTerminalLayout(current.envelope, matchingJournal.transaction)
              }
              await this.#assertRecoveryReplayTerminal(current.envelope, requestId, context)
              context.markRecoveryTerminalPersisted(requestId)
              return { ...current.envelope.receipt, reused: true }
            }
            return await this.#reconcileJournal(current.journal, context, true)
          }, context)
        })
      } catch (error) {
        if (!(error instanceof ComponentUpdateActivationError) ||
            (error.code !== 'UPDATE_HOST_LEASE_RECOVERY_NOT_REQUIRED' &&
             error.code !== 'UPDATE_HOST_LEASE_RECOVERY_MISMATCH')) throw error
        // A clean broker or an unrelated recovery binding requires no mutation
        // for this already-proven terminal. Exact matching bindings enter the
        // recovery callback above and are released only after current layout
        // evidence has been revalidated while holding the recovery lease.
        const current = await this.#proveRecoveryEvidence(requestId)
        if (current.kind !== 'replay') throw error
        return { ...current.envelope.receipt, reused: true }
      }
    })
  }

  async getReceipt(requestIdInput: unknown): Promise<ComponentUpdateActivationReceipt | null> {
    const requestId = requestIdSchema.parse(requestIdInput)
    await this.#assertRoots(false)
    const envelope = await this.#readReceipt(requestId)
    return envelope === null ? null : { ...envelope.receipt, reused: false }
  }

  async getState(): Promise<ComponentUpdateStateSummary> {
    await this.#assertRoots(false)
    const state = await this.#loadState(false)
    const historyEntries = await this.#countHistory(false)
    return {
      revision: state.revision,
      recoveryRequired: state.recoveryRequired,
      components: state.components.map(toActiveSummary),
      historyEntries
    }
  }

  async previewCleanup(): Promise<ComponentUpdateCleanupPlan> {
    await this.#assertRoots(false)
    const state = await this.#loadState(false)
    const candidates: ComponentUpdateCleanupCandidate[] = []
    const history = await this.#readHistoryEntries(false)
    if (history.length >= this.#maximumHistoryEntries) {
      const countToFreeOneSlot = history.length - this.#maximumHistoryEntries + 1
      for (const entry of history.slice(0, countToFreeOneSlot)) {
        candidates.push({ kind: 'history', opaqueId: entry.requestId, recoverable: true, reason: 'history-retention-exceeded' })
      }
    }
    const referenced = new Set(state.components.map((component) => component.releaseId))
    for (const entry of history) {
      for (const component of entry.state.components) referenced.add(component.releaseId)
    }
    for (const releaseId of await this.#listReleaseIds(false)) {
      if (!referenced.has(releaseId)) {
        candidates.push({ kind: 'release', opaqueId: releaseId, recoverable: true, reason: 'unreferenced-release' })
      }
    }
    candidates.sort((left, right) => compareText(`${left.kind}:${left.opaqueId}`, `${right.kind}:${right.opaqueId}`))
    return {
      format: 'dyson-control-component-update-cleanup-plan',
      schemaVersion: 1,
      dryRun: true,
      executeSupported: false,
      candidates
    }
  }

  async #evaluateCandidateCompatibility(
    request: NormalizedActivationRequest,
    state: StoredActiveState
  ): Promise<CompatibilityDecision> {
    let assertion: Awaited<ReturnType<ComponentUpdateActivationOptions['compatibilityVerifier']['assertCurrent']>>
    try {
      assertion = await this.#compatibilityVerifier.assertCurrent(request.compatibilityReceiptId, {
        component: request.component,
        artifactId: request.artifactId,
        sha256: request.sha256,
        targetVersion: request.targetVersion
      })
    } catch (error) {
      const code = trustedCompatibilityErrorCode(error)
      throw new ComponentUpdateActivationError(code, { cause: error })
    }
    for (const active of state.components) {
      const actual = inventoryVersion(assertion.runtimeInventory, active.component)
      if (actual === null || actual !== active.version) {
        throw new ComponentUpdateActivationError('UPDATE_INVENTORY_DRIFT')
      }
    }
    if (!assertion.decision.compatible) throw new ComponentUpdateActivationError('UPDATE_COMPATIBILITY_CONFLICT')
    return assertion.decision
  }

  async #finishActivatedTransaction(
    transaction: StoredTransaction,
    previousState: StoredActiveState,
    candidateState: StoredActiveState,
    phase: 'candidate' | 'reconcile-candidate',
    context: ActivationHostMutationContext
  ): Promise<ComponentUpdateActivationReceipt> {
    const request = transactionToRequest(transaction)
    let candidateFailure = 'UPDATE_SMOKE_FAILED'
    let healthy = false
    try {
      const result = await this.#smokeChecked({
        requestId: transaction.requestId,
        component: transaction.component,
        phase,
        expectedVersion: transaction.targetVersion,
        expectedReleaseId: transaction.releaseId
      }, context)
      healthy = smokeIsHealthy(result, transaction.component, transaction.targetVersion)
      if (!healthy) candidateFailure = 'UPDATE_SMOKE_UNHEALTHY'
    } catch (error) {
      if (error instanceof HostMutationLeaseError) throw error
      candidateFailure = normalizeError(error).code === 'UPDATE_SMOKE_INVALID'
        ? 'UPDATE_SMOKE_INVALID'
        : 'UPDATE_SMOKE_FAILED'
    }
    if (healthy) {
      context.scope.assertActive()
      context.markPossibleWrite()
      await this.#liveDeployment.commitCandidate(
        transactionToLiveRequest(transaction),
        context.scope
      )
      context.scope.assertActive()
      const receipt = createReceipt({
        request,
        releaseId: transaction.releaseId,
        status: 'succeeded',
        previousRevision: previousState.revision,
        resultingRevision: candidateState.revision,
        protectionBackupId: transaction.protectionBackupId,
        failureCode: null,
        rollbackVerified: false,
        recoveryRequired: false,
        fileCount: transaction.fileCount,
        expandedBytes: transaction.expandedBytes,
        completedAt: this.#timestamp()
      })
      context.markLiveTerminalVerified(transaction.requestId, 'succeeded')
      await this.#persistReceipt(transaction.requestFingerprint, receipt, context)
      return receipt
    }

    let stoppedForRollback = false
    try {
      await this.#requireStopped({
        requestId: transaction.requestId,
        component: transaction.component,
        phase: 'before-rollback'
      }, context)
      stoppedForRollback = true
    } catch (error) {
      if (error instanceof HostMutationLeaseError) throw error
      stoppedForRollback = false
    }
    if (!stoppedForRollback) {
      const recoveryState = buildRecoveryState(candidateState, transaction)
      await this.#writeActiveState(recoveryState, context)
      const receipt = createReceipt({
        request,
        releaseId: transaction.releaseId,
        status: 'rollback-failed',
        previousRevision: previousState.revision,
        resultingRevision: recoveryState.revision,
        protectionBackupId: transaction.protectionBackupId,
        failureCode: 'UPDATE_ROLLBACK_STOP_UNPROVEN',
        rollbackVerified: false,
        recoveryRequired: true,
        fileCount: transaction.fileCount,
        expandedBytes: transaction.expandedBytes,
        completedAt: this.#timestamp()
      })
      await this.#persistReceipt(transaction.requestFingerprint, receipt, context)
      throw new CandidateHandledError(receipt)
    }

    try {
      context.scope.assertActive()
      context.markPossibleWrite()
      await this.#liveDeployment.rollbackCandidate(
        transactionToLiveRequest(transaction),
        context.scope
      )
      context.scope.assertActive()
      await this.#writeActiveState(previousState, context)
    } catch (error) {
      if (error instanceof HostMutationLeaseError) throw error
      const recoveryState = buildRecoveryState(candidateState, transaction)
      await this.#writeActiveState(recoveryState, context)
      const normalized = normalizeError(error)
      const receipt = createReceipt({
        request,
        releaseId: transaction.releaseId,
        status: 'rollback-failed',
        previousRevision: previousState.revision,
        resultingRevision: recoveryState.revision,
        protectionBackupId: transaction.protectionBackupId,
        failureCode: normalized.code.startsWith('UPDATE_LIVE_')
          ? normalized.code
          : 'UPDATE_ROLLBACK_SWITCH_FAILED',
        rollbackVerified: false,
        recoveryRequired: true,
        fileCount: transaction.fileCount,
        expandedBytes: transaction.expandedBytes,
        completedAt: this.#timestamp()
      })
      await this.#persistReceipt(transaction.requestFingerprint, receipt, context)
      throw new CandidateHandledError(receipt, { cause: error })
    }

    const previousComponent = previousState.components.find((component) => component.component === transaction.component)
    let rollbackVerified = false
    try {
      const rollback = await this.#smokeChecked({
        requestId: transaction.requestId,
        component: transaction.component,
        phase: 'rollback',
        expectedVersion: previousComponent?.version ?? null,
        expectedReleaseId: previousComponent?.releaseId ?? null
      }, context)
      rollbackVerified = smokeIsHealthy(rollback, transaction.component, previousComponent?.version ?? null)
    } catch (error) {
      if (error instanceof HostMutationLeaseError) throw error
      rollbackVerified = false
    }
    if (rollbackVerified) {
      const receipt = createReceipt({
        request,
        releaseId: transaction.releaseId,
        status: 'rolled-back',
        previousRevision: previousState.revision,
        resultingRevision: previousState.revision,
        protectionBackupId: transaction.protectionBackupId,
        failureCode: candidateFailure,
        rollbackVerified: true,
        recoveryRequired: false,
        fileCount: transaction.fileCount,
        expandedBytes: transaction.expandedBytes,
        completedAt: this.#timestamp()
      })
      context.markLiveTerminalVerified(transaction.requestId, 'rolled-back')
      await this.#persistReceipt(transaction.requestFingerprint, receipt, context)
      return receipt
    }

    const recoveryState = buildRecoveryState(previousState, transaction)
    await this.#writeActiveState(recoveryState, context)
    const receipt = createReceipt({
      request,
      releaseId: transaction.releaseId,
      status: 'rollback-failed',
      previousRevision: previousState.revision,
      resultingRevision: recoveryState.revision,
      protectionBackupId: transaction.protectionBackupId,
      failureCode: 'UPDATE_ROLLBACK_SMOKE_FAILED',
      rollbackVerified: false,
      recoveryRequired: true,
      fileCount: transaction.fileCount,
      expandedBytes: transaction.expandedBytes,
      completedAt: this.#timestamp()
    })
    await this.#persistReceipt(transaction.requestFingerprint, receipt, context)
    return receipt
  }

  async #reconcilePendingTransactions(
    context: ActivationHostMutationContext
  ): Promise<ComponentUpdateActivationReceipt | null> {
    const journals = await this.#readPendingJournals()
    if (journals.length === 0) return null
    if (journals.length > 1) throw new ComponentUpdateActivationError('UPDATE_RECONCILIATION_AMBIGUOUS')
    return await this.#reconcileJournal(journals[0]!, context, false)
  }

  async #reconcileJournal(
    journal: StoredTransactionJournal,
    context: ActivationHostMutationContext,
    allowRecoveryReceipt: boolean
  ): Promise<ComponentUpdateActivationReceipt | null> {
    // Any unresolved durable journal is evidence that a prior host write may
    // already have happened, even before this reconciliation performs I/O.
    context.markPossibleWrite()
    const existing = await this.#readReceipt(journal.transaction.requestId)
    if (existing !== null) {
      if (existing.requestFingerprint !== journal.transaction.requestFingerprint) {
        throw new ComponentUpdateActivationError('UPDATE_RECOVERY_EVIDENCE_INVALID')
      }
      if (!allowRecoveryReceipt || !existing.receipt.recoveryRequired) return null
    }
    const state = await this.#loadState(true)
    const previousState = await this.#loadHistory(journal.transaction.requestId)
    if (previousState.revision !== journal.transaction.previousRevision) {
      throw new ComponentUpdateActivationError('UPDATE_RECONCILIATION_UNCERTAIN')
    }
    if (state.lastTransaction?.requestId === journal.transaction.requestId &&
        state.lastTransaction.requestFingerprint === journal.transaction.requestFingerprint) {
      const active = state.components.find((component) => component.component === journal.transaction.component)
      let desired: 'candidate' | 'previous' = 'candidate'
      if (state.recoveryRequired) {
        if (!allowRecoveryReceipt) {
          throw new ComponentUpdateActivationError('UPDATE_RECONCILIATION_UNCERTAIN')
        }
        const layout = classifyRecoveryStateLayout(state, previousState, journal.transaction)
        if (layout === 'unknown') {
          throw new ComponentUpdateActivationError('UPDATE_RECOVERY_EVIDENCE_INVALID')
        }
        desired = layout
      } else if (active?.releaseId !== journal.transaction.releaseId ||
          active.version !== journal.transaction.targetVersion || active.artifactId !== journal.transaction.artifactId) {
        throw new ComponentUpdateActivationError('UPDATE_RECONCILIATION_UNCERTAIN')
      }
      let liveResult: 'candidate' | 'previous'
      try {
        context.scope.assertActive()
        liveResult = await this.#liveDeployment.reconcileCandidate(
          transactionToLiveRequest(journal.transaction),
          desired,
          context.scope
        )
        context.scope.assertActive()
      } catch (error) {
        if (error instanceof HostMutationLeaseError) throw error
        return await this.#recordLiveReconciliationFailure(journal.transaction, state, error, context)
      }
      if (liveResult === 'previous') {
        await this.#writeActiveState(previousState, context)
        return await this.#finishInterruptedPrevious(journal.transaction, previousState, context)
      }
      if (desired === 'previous') {
        throw new ComponentUpdateActivationError('UPDATE_RECONCILIATION_UNCERTAIN')
      }
      const candidateState = state.recoveryRequired
        ? clearRecoveryState(state, journal.transaction)
        : state
      if (candidateState !== state) await this.#writeActiveState(candidateState, context)
      return await this.#finishActivatedTransaction(
        journal.transaction,
        previousState,
        candidateState,
        'reconcile-candidate',
        context
      )
    }
    if (state.revision === previousState.revision) {
      try {
        context.scope.assertActive()
        await this.#liveDeployment.reconcileCandidate(
          transactionToLiveRequest(journal.transaction),
          'previous',
          context.scope
        )
        context.scope.assertActive()
      } catch (error) {
        if (error instanceof HostMutationLeaseError) throw error
        return await this.#recordLiveReconciliationFailure(journal.transaction, previousState, error, context)
      }
      return await this.#finishInterruptedPrevious(journal.transaction, previousState, context)
    }
    throw new ComponentUpdateActivationError('UPDATE_RECONCILIATION_UNCERTAIN')
  }

  async #finishInterruptedPrevious(
    transaction: StoredTransaction,
    previousState: StoredActiveState,
    context: ActivationHostMutationContext
  ): Promise<ComponentUpdateActivationReceipt> {
    const previousComponent = previousState.components.find((component) => component.component === transaction.component)
    let rollbackVerified = false
    try {
      const smoke = await this.#smokeChecked({
        requestId: transaction.requestId,
        component: transaction.component,
        phase: 'rollback',
        expectedVersion: previousComponent?.version ?? null,
        expectedReleaseId: previousComponent?.releaseId ?? null
      }, context)
      rollbackVerified = smokeIsHealthy(smoke, transaction.component, previousComponent?.version ?? null)
    } catch (error) {
      if (error instanceof HostMutationLeaseError) throw error
      rollbackVerified = false
    }
    if (!rollbackVerified) {
      const recoveryState = buildRecoveryState(previousState, transaction)
      await this.#writeActiveState(recoveryState, context)
      const failed = journalToReceipt(
        transaction,
        recoveryState,
        'rollback-failed',
        'UPDATE_RECONCILIATION_UNCERTAIN',
        false,
        true,
        this.#timestamp()
      )
      await this.#persistReceipt(transaction.requestFingerprint, failed, context)
      return failed
    }
    const rolledBack = journalToReceipt(
      transaction,
      previousState,
      'rolled-back',
      'UPDATE_INTERRUPTED',
      true,
      false,
      this.#timestamp()
    )
    context.markLiveTerminalVerified(transaction.requestId, 'rolled-back')
    await this.#persistReceipt(transaction.requestFingerprint, rolledBack, context)
    return rolledBack
  }

  async #recordLiveReconciliationFailure(
    transaction: StoredTransaction,
    state: StoredActiveState,
    error: unknown,
    context: ActivationHostMutationContext
  ): Promise<ComponentUpdateActivationReceipt> {
    const recoveryState = buildRecoveryState(state, transaction)
    await this.#writeActiveState(recoveryState, context)
    const normalized = normalizeError(error)
    const failed = journalToReceipt(
      transaction,
      recoveryState,
      'rollback-failed',
      normalized.code.startsWith('UPDATE_LIVE_') ? normalized.code : 'UPDATE_RECONCILIATION_UNCERTAIN',
      false,
      true,
      this.#timestamp()
    )
    await this.#persistReceipt(transaction.requestFingerprint, failed, context)
    return failed
  }

  async #assembleImmutableRelease(
    request: NormalizedActivationRequest,
    staged: { manifest: StagedArtifactManifest; artifactPath: string },
    manifest: ComponentReleaseManifest,
    releaseId: string
  ): Promise<void> {
    const componentRoot = managedChild(this.#controlRoot, 'releases', request.component)
    await mkdir(componentRoot, { recursive: true })
    await assertDirectory(componentRoot, this.#controlRoot)
    const destination = managedChild(componentRoot, releaseId)
    const existing = await lstat(destination).catch((error: unknown) => {
      if (isNodeError(error, 'ENOENT')) return null
      throw error
    })
    if (existing !== null) {
      await this.#verifyImmutableRelease(request, releaseId, manifest)
      return
    }
    const pending = managedChild(this.#controlRoot, '.pending', `${releaseId}-${randomUUID()}`)
    await mkdir(pending, { recursive: false })
    try {
      const payload = managedChild(pending, 'payload')
      await mkdir(payload, { recursive: false })
      const extracted = await inspectComponentArchive({
        archivePath: staged.artifactPath,
        expectedComponent: request.component,
        expectedVersion: request.targetVersion,
        expectedArtifactId: request.artifactId,
        limits: this.#limits,
        extractTo: payload
      })
      if (canonicalJson(extracted.manifest) !== canonicalJson(manifest)) {
        throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_CHANGED')
      }
      const record: StoredReleaseRecord = releaseRecordSchema.parse({
        format: 'dyson-control-component-immutable-release',
        schemaVersion: 1,
        releaseId,
        component: request.component,
        artifactId: request.artifactId,
        artifactSha256: request.sha256,
        version: request.targetVersion,
        manifest,
        createdAt: this.#timestamp()
      })
      await writeFile(managedChild(pending, 'release.json'), `${canonicalJson(record)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(pending, destination)
    } catch (error) {
      assertDescendant(this.#controlRoot, pending)
      await rm(pending, { recursive: true, force: true }).catch(() => undefined)
      if (error instanceof ComponentUpdateActivationError) throw error
      throw new ComponentUpdateActivationError('UPDATE_RELEASE_ASSEMBLY_FAILED', { cause: error })
    }
  }

  async #verifyImmutableRelease(
    request: NormalizedActivationRequest,
    releaseId: string,
    expectedManifest: ComponentReleaseManifest
  ): Promise<void> {
    const releaseRoot = managedChild(this.#controlRoot, 'releases', request.component, releaseId)
    await assertDirectory(releaseRoot, this.#controlRoot)
    const recordPath = managedChild(releaseRoot, 'release.json')
    const info = await lstat(recordPath).catch((error: unknown) => {
      throw new ComponentUpdateActivationError('UPDATE_RELEASE_RECORD_MISSING', { cause: error })
    })
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1_024 * 1_024) {
      throw new ComponentUpdateActivationError('UPDATE_RELEASE_RECORD_INVALID')
    }
    let record: StoredReleaseRecord
    try {
      record = releaseRecordSchema.parse(JSON.parse(await readFile(recordPath, 'utf8')))
    } catch (error) {
      throw new ComponentUpdateActivationError('UPDATE_RELEASE_RECORD_INVALID', { cause: error })
    }
    if (record.releaseId !== releaseId || record.component !== request.component || record.artifactId !== request.artifactId ||
        record.artifactSha256.toLowerCase() !== request.sha256 || record.version !== request.targetVersion ||
        canonicalJson(record.manifest) !== canonicalJson(expectedManifest)) {
      throw new ComponentUpdateActivationError('UPDATE_RELEASE_IDENTITY_MISMATCH')
    }
    await verifyExtractedComponentRelease(managedChild(releaseRoot, 'payload'), record.manifest, this.#limits)
  }

  async #loadStagedArtifact(request: NormalizedActivationRequest): Promise<{
    manifest: StagedArtifactManifest
    artifactPath: string
  }> {
    const releasesRoot = managedChild(this.#stagingRoot, 'releases')
    await assertDirectory(releasesRoot, this.#stagingRoot)
    const stagedRoot = managedChild(releasesRoot, request.artifactId)
    await assertDirectory(stagedRoot, releasesRoot)
    const manifestPath = managedChild(stagedRoot, 'manifest.json')
    const artifactPath = managedChild(stagedRoot, 'artifact.bin')
    const manifestInfo = await lstat(manifestPath).catch((error: unknown) => {
      throw new ComponentUpdateActivationError('UPDATE_STAGED_MANIFEST_MISSING', { cause: error })
    })
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 128 * 1_024) {
      throw new ComponentUpdateActivationError('UPDATE_STAGED_MANIFEST_INVALID')
    }
    let manifest: StagedArtifactManifest
    try {
      manifest = stagedArtifactManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
    } catch (error) {
      throw new ComponentUpdateActivationError('UPDATE_STAGED_MANIFEST_INVALID', { cause: error })
    }
    if (manifest.artifactId !== request.artifactId || manifest.sha256.toLowerCase() !== request.sha256 ||
        manifest.release.version !== request.targetVersion || !stagedIdentityMatches(request.component, manifest)) {
      throw new ComponentUpdateActivationError('UPDATE_STAGED_IDENTITY_MISMATCH')
    }
    const artifactInfo = await lstat(artifactPath, { bigint: true }).catch((error: unknown) => {
      throw new ComponentUpdateActivationError('UPDATE_STAGED_ARTIFACT_MISSING', { cause: error })
    })
    if (!artifactInfo.isFile() || artifactInfo.isSymbolicLink() || artifactInfo.size <= 0n ||
        artifactInfo.size > BigInt(this.#limits.maximumArchiveBytes)) {
      throw new ComponentUpdateActivationError('UPDATE_STAGED_ARTIFACT_INVALID')
    }
    if (artifactInfo.size !== BigInt(manifest.sizeBytes)) {
      throw new ComponentUpdateActivationError('UPDATE_STAGED_ARTIFACT_TAMPERED')
    }
    const stagedReal = await realpath(stagedRoot)
    const artifactReal = await realpath(artifactPath)
    assertDescendant(stagedReal, artifactReal)
    const measured = await hashFileSnapshot(artifactPath, this.#limits.maximumArchiveBytes, artifactInfo)
    if (measured.sizeBytes !== manifest.sizeBytes || measured.sha256 !== request.sha256) {
      throw new ComponentUpdateActivationError('UPDATE_STAGED_ARTIFACT_TAMPERED')
    }
    return { manifest, artifactPath }
  }

  async #requireStopped(
    request: StoppedStateCheckRequest,
    context: ActivationHostMutationContext
  ): Promise<void> {
    let proof: StoppedStateProof
    try {
      context.scope.assertActive()
      proof = stoppedProofSchema.parse(await this.#verifyStoppedState(request, context.scope))
      context.scope.assertActive()
    } catch (error) {
      context.scope.assertActive()
      if (error instanceof HostMutationLeaseError) throw error
      throw new ComponentUpdateActivationError('UPDATE_STOP_PROOF_INVALID', { cause: error })
    }
    if (!proof.processStopped || !proof.portClosed) throw new ComponentUpdateActivationError('UPDATE_SERVICE_STILL_RUNNING')
  }

  async #createProtection(
    request: NormalizedActivationRequest,
    context: ActivationHostMutationContext
  ): Promise<SaveProtectionPointReceipt> {
    let receipt: SaveProtectionPointReceipt
    try {
      context.scope.assertActive()
      context.markPossibleWrite()
      receipt = saveProtectionReceiptSchema.parse(await this.#createSaveProtectionPoint({
        requestId: request.requestId,
        purpose: 'component-update',
        component: request.component,
        targetVersion: request.targetVersion,
        expectedRevision: request.expectedRevision
      }, context.scope))
      context.scope.assertActive()
    } catch (error) {
      context.scope.assertActive()
      if (error instanceof HostMutationLeaseError) throw error
      throw new ComponentUpdateActivationError('UPDATE_SAVE_PROTECTION_FAILED', { cause: error })
    }
    if (receipt.requestId !== request.requestId) throw new ComponentUpdateActivationError('UPDATE_SAVE_PROTECTION_MISMATCH')
    // A valid durable, request-bound protection receipt closes this adapter
    // write window. Later precondition failures are ordinary safe rejections.
    context.resolvePossibleWrite()
    return receipt
  }

  async #smokeChecked(
    request: FixedUpdateSmokeRequest,
    context: ActivationHostMutationContext
  ): Promise<FixedUpdateSmokeResult> {
    try {
      context.scope.assertActive()
      context.markPossibleWrite()
      const result = smokeResultSchema.parse(await this.#smoke(request, context.scope))
      context.scope.assertActive()
      if (result.component !== request.component) throw new ComponentUpdateActivationError('UPDATE_SMOKE_INVALID')
      return result
    } catch (error) {
      context.scope.assertActive()
      if (error instanceof HostMutationLeaseError) throw error
      if (error instanceof ComponentUpdateActivationError) throw error
      throw new ComponentUpdateActivationError('UPDATE_SMOKE_INVALID', { cause: error })
    }
  }

  async #persistHistory(
    requestId: string,
    state: StoredActiveState,
    context: ActivationHostMutationContext
  ): Promise<void> {
    const historyPath = managedChild(this.#controlRoot, 'history', `${requestId}.json`)
    const existing = await readJsonIfPresent(historyPath)
    const envelope = { format: 'dyson-control-component-update-history', schemaVersion: 1, requestId, state }
    if (existing !== null) {
      if (canonicalJson(existing) !== canonicalJson(envelope)) throw new ComponentUpdateActivationError('UPDATE_HISTORY_CONFLICT')
      return
    }
    await writeImmutableJson(historyPath, envelope, context.scope)
  }

  async #loadHistory(requestId: string): Promise<StoredActiveState> {
    const historyPath = managedChild(this.#controlRoot, 'history', `${requestId}.json`)
    return await this.#loadHistoryPath(historyPath, requestId)
  }

  async #loadRecoveryHistory(requestId: string): Promise<StoredActiveState> {
    const historyRoot = managedChild(this.#controlRoot, 'history')
    const finalPath = managedChild(historyRoot, `${requestId}.json`)
    if (await pathExists(finalPath)) return await this.#loadHistoryPath(finalPath, requestId)
    const temporary = (await readdir(historyRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() &&
        isRecoveryTemporaryName(entry.name, requestId))
    if (temporary.length !== 1) {
      throw new ComponentUpdateActivationError(
        temporary.length === 0 ? 'UPDATE_HISTORY_MISSING' : 'UPDATE_RECOVERY_EVIDENCE_INVALID'
      )
    }
    return await this.#loadHistoryPath(managedChild(historyRoot, temporary[0]!.name), requestId)
  }

  async #loadHistoryPath(historyPath: string, requestId: string): Promise<StoredActiveState> {
    let value: unknown
    try {
      const info = await lstat(historyPath)
      if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 4 * 1_024 * 1_024) {
        throw new ComponentUpdateActivationError('UPDATE_HISTORY_INVALID')
      }
      value = JSON.parse(await readFile(historyPath, 'utf8'))
    } catch (error) {
      throw new ComponentUpdateActivationError('UPDATE_HISTORY_MISSING', { cause: error })
    }
    const envelopeSchema = z.strictObject({
      format: z.literal('dyson-control-component-update-history'),
      schemaVersion: z.literal(1),
      requestId: requestIdSchema,
      state: storedStateSchema
    })
    let envelope: z.infer<typeof envelopeSchema>
    try {
      envelope = envelopeSchema.parse(value)
      validateStoredStateRevision(envelope.state)
    } catch (error) {
      throw new ComponentUpdateActivationError('UPDATE_HISTORY_INVALID', { cause: error })
    }
    if (envelope.requestId !== requestId) throw new ComponentUpdateActivationError('UPDATE_HISTORY_INVALID')
    return envelope.state
  }

  async #persistJournal(
    transaction: StoredTransaction,
    context: ActivationHostMutationContext
  ): Promise<void> {
    const journalPath = managedChild(this.#controlRoot, 'transactions', `${transaction.requestId}.json`)
    const value = journalSchema.parse({
      format: 'dyson-control-component-update-journal',
      schemaVersion: 1,
      transaction
    })
    const existing = await readJsonIfPresent(journalPath)
    if (existing !== null) {
      if (canonicalJson(existing) !== canonicalJson(value)) throw new ComponentUpdateActivationError('UPDATE_JOURNAL_CONFLICT')
      return
    }
    await writeImmutableJson(journalPath, value, context.scope)
  }

  async #readPendingJournals(): Promise<StoredTransactionJournal[]> {
    const pending: StoredTransactionJournal[] = []
    for (const journal of await this.#readAllJournals()) {
      if (await this.#readReceipt(journal.transaction.requestId) === null) pending.push(journal)
    }
    return pending
  }

  async #readAllJournals(recoveryTemporaryRequestId?: string): Promise<StoredTransactionJournal[]> {
    const transactionsRoot = managedChild(this.#controlRoot, 'transactions')
    const entries = await readdir(transactionsRoot, { withFileTypes: true })
    const journals = new Map<string, StoredTransactionJournal>()
    for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
      const finalName = /^[0-9a-f-]{36}\.json$/i.test(entry.name)
      const recoveryTemporary = recoveryTemporaryRequestId !== undefined &&
        isRecoveryTemporaryName(entry.name, recoveryTemporaryRequestId)
      if (!entry.isFile() || entry.isSymbolicLink() || (!finalName && !recoveryTemporary)) {
        throw new ComponentUpdateActivationError('UPDATE_JOURNAL_DIRECTORY_INVALID')
      }
      let journal: StoredTransactionJournal
      try {
        const journalPath = managedChild(transactionsRoot, entry.name)
        const info = await lstat(journalPath)
        if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 256 * 1_024) {
          throw new ComponentUpdateActivationError('UPDATE_JOURNAL_INVALID')
        }
        journal = journalSchema.parse(JSON.parse(await readFile(journalPath, 'utf8')))
      } catch (error) {
        throw new ComponentUpdateActivationError('UPDATE_JOURNAL_INVALID', { cause: error })
      }
      if (finalName && `${journal.transaction.requestId}.json`.toLowerCase() !== entry.name.toLowerCase()) {
        throw new ComponentUpdateActivationError('UPDATE_JOURNAL_INVALID')
      }
      if (recoveryTemporary && journal.transaction.requestId !== recoveryTemporaryRequestId) {
        throw new ComponentUpdateActivationError('UPDATE_JOURNAL_INVALID')
      }
      const existing = journals.get(journal.transaction.requestId)
      if (existing !== undefined && canonicalJson(existing) !== canonicalJson(journal)) {
        throw new ComponentUpdateActivationError('UPDATE_JOURNAL_CONFLICT')
      }
      journals.set(journal.transaction.requestId, journal)
    }
    return [...journals.values()]
  }

  async #proveRecoveryEvidence(requestId: string): Promise<RecoveryEvidence> {
    const requestedReceipt = await this.#readReceipt(requestId)
    if (requestedReceipt !== null && !requestedReceipt.receipt.recoveryRequired) {
      if (!isCoherentTerminalReceipt(requestedReceipt.receipt)) {
        throw new ComponentUpdateActivationError('UPDATE_RECOVERY_EVIDENCE_INVALID')
      }
      const matchingJournal = (await this.#readAllJournals(requestId))
        .find((journal) => journal.transaction.requestId === requestId) ?? null
      if (matchingJournal !== null) {
        assertReceiptBoundToTransaction(requestedReceipt, matchingJournal.transaction)
      } else if (requestedReceipt.receipt.status !== 'failed') {
        throw new ComponentUpdateActivationError('UPDATE_RECOVERY_EVIDENCE_INVALID')
      }
      const requiresBrokerRelease = await this.#hasRecoveryReceipt(requestId)
      if (requiresBrokerRelease) {
        if (matchingJournal === null) {
          throw new ComponentUpdateActivationError('UPDATE_RECOVERY_EVIDENCE_INVALID')
        }
        await this.#proveRecoveryTerminalLayout(requestedReceipt, matchingJournal.transaction)
      }
      return { kind: 'replay', envelope: requestedReceipt, requiresBrokerRelease }
    }

    const unresolved: Array<{
      journal: StoredTransactionJournal
      receipt: StoredReceiptEnvelope | null
    }> = []
    for (const journal of await this.#readAllJournals(requestId)) {
      const receipt = await this.#readReceipt(journal.transaction.requestId)
      if (receipt !== null && receipt.requestFingerprint !== journal.transaction.requestFingerprint) {
        throw new ComponentUpdateActivationError('UPDATE_RECOVERY_EVIDENCE_INVALID')
      }
      if (receipt === null || receipt.receipt.recoveryRequired) {
        unresolved.push({ journal, receipt })
      }
    }
    if (unresolved.length === 0) {
      throw new ComponentUpdateActivationError('UPDATE_RECOVERY_NOT_PENDING')
    }
    if (unresolved.length > 1) {
      throw new ComponentUpdateActivationError('UPDATE_RECONCILIATION_AMBIGUOUS')
    }
    const target = unresolved[0]!
    if (target.journal.transaction.requestId !== requestId) {
      throw new ComponentUpdateActivationError('UPDATE_RECOVERY_REQUEST_MISMATCH')
    }
    if (requestedReceipt !== target.receipt) {
      // Both reads are within activation.lock. A non-identical object here is
      // expected because envelopes are reparsed; compare the canonical proof.
      if (canonicalJson(requestedReceipt) !== canonicalJson(target.receipt)) {
        throw new ComponentUpdateActivationError('UPDATE_RECOVERY_EVIDENCE_CHANGED')
      }
    }

    const [state, previousState] = await Promise.all([
      this.#loadState(true),
      this.#loadRecoveryHistory(requestId)
    ])
    const transaction = target.journal.transaction
    if (previousState.revision !== transaction.previousRevision ||
        !stateCanReconcileTransaction(state, previousState, transaction)) {
      throw new ComponentUpdateActivationError('UPDATE_RECOVERY_EVIDENCE_INVALID')
    }
    if (target.receipt !== null) {
      assertReceiptBoundToTransaction(target.receipt, transaction)
      const receipt = target.receipt.receipt
      const originalRecoveryState = state.recoveryRequired &&
        receipt.resultingRevision === state.revision &&
        sameStoredTransaction(state.lastTransaction, transaction)
      const interruptedRecoveryTransition = !state.recoveryRequired &&
        stateCanReconcileTransaction(state, previousState, transaction)
      if (!isRecoveryRequiredReceipt(receipt) ||
          (!originalRecoveryState && !interruptedRecoveryTransition)) {
        throw new ComponentUpdateActivationError('UPDATE_RECOVERY_EVIDENCE_INVALID')
      }
    }
    return {
      kind: 'pending',
      journal: target.journal,
      receipt: target.receipt,
      state,
      previousState
    }
  }

  async #hasRecoveryReceipt(requestId: string): Promise<boolean> {
    return await readJsonIfPresent(managedChild(
      this.#controlRoot,
      'recovery-receipts',
      `${requestId}.json`
    )) !== null
  }

  async #proveRecoveryTerminalLayout(
    envelope: StoredReceiptEnvelope,
    transaction: StoredTransaction
  ): Promise<void> {
    const [state, previousState] = await Promise.all([
      this.#loadState(true),
      this.#loadRecoveryHistory(transaction.requestId)
    ])
    if (previousState.revision !== transaction.previousRevision || state.recoveryRequired) {
      throw new ComponentUpdateActivationError('UPDATE_RECOVERY_EVIDENCE_INVALID')
    }
    const receipt = envelope.receipt
    if (receipt.status === 'succeeded') {
      if (!sameStoredTransaction(state.lastTransaction, transaction) ||
          classifyRecoveryStateLayout(state, previousState, transaction) !== 'candidate' ||
          receipt.resultingRevision !== state.revision) {
        throw new ComponentUpdateActivationError('UPDATE_RECOVERY_EVIDENCE_INVALID')
      }
      return
    }
    if (receipt.status !== 'rolled-back' || receipt.resultingRevision !== previousState.revision ||
        canonicalJson(state) !== canonicalJson(previousState)) {
      throw new ComponentUpdateActivationError('UPDATE_RECOVERY_EVIDENCE_INVALID')
    }
  }

  async #assertRecoveryReplayTerminal(
    envelope: StoredReceiptEnvelope,
    requestId: string,
    context: ActivationHostMutationContext
  ): Promise<void> {
    context.scope.assertActive()
    if (envelope.receipt.requestId !== requestId || envelope.receipt.recoveryRequired ||
        !isCoherentTerminalReceipt(envelope.receipt)) {
      throw new ComponentUpdateActivationError('UPDATE_RECOVERY_TERMINAL_UNPROVEN')
    }
    if (envelope.receipt.status === 'failed') {
      const state = await this.#loadState(true)
      if (state.recoveryRequired || envelope.receipt.previousRevision !== state.revision ||
          envelope.receipt.resultingRevision !== state.revision ||
          state.lastTransaction?.requestId === requestId) {
        throw new ComponentUpdateActivationError('UPDATE_RECOVERY_TERMINAL_UNPROVEN')
      }
      context.scope.assertActive()
      return
    }
    if (envelope.receipt.status !== 'succeeded' && envelope.receipt.status !== 'rolled-back') {
      throw new ComponentUpdateActivationError('UPDATE_RECOVERY_TERMINAL_UNPROVEN')
    }
    context.markLiveTerminalVerified(requestId, envelope.receipt.status)
    await this.#assertRecoveryTerminalReceipt(envelope.receipt, context)
    context.scope.assertActive()
  }

  async #persistReceipt(
    requestFingerprintValue: string,
    receipt: ComponentUpdateActivationReceipt,
    context?: ActivationHostMutationContext
  ): Promise<void> {
    const envelope = receiptEnvelopeSchema.parse({
      format: 'dyson-control-component-update-receipt-envelope',
      schemaVersion: 1,
      requestFingerprint: requestFingerprintValue,
      receipt: { ...receipt, reused: false }
    })
    const receiptPath = managedChild(this.#controlRoot, 'receipts', `${receipt.requestId}.json`)
    const existing = await this.#readReceipt(receipt.requestId)
    if (existing !== null) {
      if (canonicalJson(existing) === canonicalJson(envelope)) {
        if (context?.recoveryRequestId === receipt.requestId && !receipt.recoveryRequired) {
          await this.#assertRecoveryTerminalReceipt(receipt, context)
          context.markRecoveryTerminalPersisted(receipt.requestId)
        }
        return
      }
      if (context?.recoveryRequestId !== receipt.requestId ||
          !isValidRecoveryReceiptTransition(existing, envelope)) {
        throw new ComponentUpdateActivationError('UPDATE_IDEMPOTENCY_CONFLICT')
      }
      await this.#assertRecoveryTerminalReceipt(receipt, context)
      const recoveryReceiptPath = managedChild(
        this.#controlRoot,
        'recovery-receipts',
        `${receipt.requestId}.json`
      )
      await writeImmutableJson(recoveryReceiptPath, envelope, context.scope)
      context.markRecoveryTerminalPersisted(receipt.requestId)
      return
    }
    if (context?.recoveryRequestId === receipt.requestId && !receipt.recoveryRequired) {
      await this.#assertRecoveryTerminalReceipt(receipt, context)
      const recoveryReceiptPath = managedChild(
        this.#controlRoot,
        'recovery-receipts',
        `${receipt.requestId}.json`
      )
      await writeImmutableJson(recoveryReceiptPath, envelope, context.scope)
      context.markRecoveryTerminalPersisted(receipt.requestId)
      return
    }
    await writeImmutableJson(receiptPath, envelope, context?.scope)
    if (context?.recoveryRequestId === receipt.requestId && !receipt.recoveryRequired) {
      context.markRecoveryTerminalPersisted(receipt.requestId)
    }
  }

  async #readReceipt(requestId: string): Promise<StoredReceiptEnvelope | null> {
    const receiptPath = managedChild(this.#controlRoot, 'receipts', `${requestId}.json`)
    const recoveryReceiptPath = managedChild(
      this.#controlRoot,
      'recovery-receipts',
      `${requestId}.json`
    )
    const [value, recoveredValue] = await Promise.all([
      readJsonIfPresent(receiptPath),
      readJsonIfPresent(recoveryReceiptPath)
    ])
    if (value === null && recoveredValue === null) return null
    try {
      const envelope = value === null ? null : receiptEnvelopeSchema.parse(value)
      const recovered = recoveredValue === null ? null : receiptEnvelopeSchema.parse(recoveredValue)
      if (envelope?.receipt.requestId !== requestId && envelope !== null) {
        throw new Error('receipt/request mismatch')
      }
      if (recovered?.receipt.requestId !== requestId && recovered !== null) {
        throw new Error('recovery receipt/request mismatch')
      }
      if (recovered === null) return envelope
      if (envelope === null) {
        if (!isCoherentTerminalReceipt(recovered.receipt) ||
            (recovered.receipt.status !== 'succeeded' && recovered.receipt.status !== 'rolled-back')) {
          throw new Error('orphan recovery receipt is not terminal')
        }
        return recovered
      }
      if (!isValidRecoveryReceiptTransition(envelope, recovered)) {
        throw new Error('invalid recovery receipt transition')
      }
      return recovered
    } catch (error) {
      throw new ComponentUpdateActivationError('UPDATE_RECEIPT_INVALID', { cause: error })
    }
  }

  async #assertRecoveryTerminalReceipt(
    receipt: ComponentUpdateActivationReceipt,
    context: ActivationHostMutationContext
  ): Promise<void> {
    context.scope.assertActive()
    if (context.recoveryRequestId !== receipt.requestId || receipt.recoveryRequired ||
        (receipt.status !== 'succeeded' && receipt.status !== 'rolled-back') ||
        !context.liveTerminalIsVerified(receipt.requestId, receipt.status)) {
      throw new ComponentUpdateActivationError('UPDATE_RECOVERY_TERMINAL_UNPROVEN')
    }
    const state = await this.#loadState(true)
    if (state.recoveryRequired || state.revision !== receipt.resultingRevision) {
      throw new ComponentUpdateActivationError('UPDATE_RECOVERY_TERMINAL_UNPROVEN')
    }
    if (receipt.status === 'succeeded') {
      const active = state.components.find((component) => component.component === receipt.component)
      if (active?.releaseId !== receipt.releaseId || active.artifactId !== receipt.artifactId ||
          active.version !== receipt.targetVersion || receipt.failureCode !== null ||
          receipt.rollbackVerified) {
        throw new ComponentUpdateActivationError('UPDATE_RECOVERY_TERMINAL_UNPROVEN')
      }
    } else if (state.revision !== receipt.previousRevision || !receipt.rollbackVerified ||
        receipt.failureCode === null) {
      throw new ComponentUpdateActivationError('UPDATE_RECOVERY_TERMINAL_UNPROVEN')
    }
    context.scope.assertActive()
  }

  async #writeActiveState(
    state: StoredActiveState,
    context: ActivationHostMutationContext
  ): Promise<void> {
    validateStoredStateRevision(state)
    const activePath = managedChild(this.#controlRoot, 'active.json')
    const temporary = managedChild(this.#controlRoot, `.active-${randomUUID()}.tmp`)
    context.scope.assertActive()
    context.markPossibleWrite()
    try {
      await writeDurableExclusive(temporary, `${canonicalJson(state)}\n`)
      context.scope.assertActive()
      await rename(temporary, activePath)
      await syncDirectory(path.dirname(activePath))
      context.scope.assertActive()
    } catch (error) {
      if (error instanceof HostMutationLeaseError) throw error
      await unlink(temporary).catch(() => undefined)
      throw new ComponentUpdateActivationError('UPDATE_ACTIVE_SWITCH_FAILED', { cause: error })
    }
  }

  async #loadState(requireControlRoot: boolean): Promise<StoredActiveState> {
    const activePath = managedChild(this.#controlRoot, 'active.json')
    const value = await readJsonIfPresent(activePath)
    if (value === null) return initialStoredState()
    try {
      const state = storedStateSchema.parse(value)
      validateStoredStateRevision(state)
      return state
    } catch (error) {
      throw new ComponentUpdateActivationError('UPDATE_ACTIVE_STATE_INVALID', { cause: error })
    }
  }

  async #assertHistoryCapacity(requestId: string, requireDirectory: boolean): Promise<void> {
    const existing = await lstat(managedChild(this.#controlRoot, 'history', `${requestId}.json`)).catch((error: unknown) => {
      if (isNodeError(error, 'ENOENT')) return null
      throw error
    })
    if (existing !== null) return
    if (await this.#countHistory(requireDirectory) >= this.#maximumHistoryEntries) {
      throw new ComponentUpdateActivationError('UPDATE_HISTORY_LIMIT_REACHED')
    }
  }

  async #countHistory(requireDirectory: boolean): Promise<number> {
    return (await this.#readHistoryEntries(requireDirectory)).length
  }

  async #readHistoryEntries(requireDirectory: boolean): Promise<Array<{ requestId: string; state: StoredActiveState; mtimeMs: number }>> {
    const root = managedChild(this.#controlRoot, 'history')
    const rootInfo = await lstat(root).catch((error: unknown) => {
      if (!requireDirectory && isNodeError(error, 'ENOENT')) return null
      throw new ComponentUpdateActivationError('UPDATE_HISTORY_DIRECTORY_INVALID', { cause: error })
    })
    if (rootInfo === null) return []
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new ComponentUpdateActivationError('UPDATE_HISTORY_DIRECTORY_INVALID')
    const entries = await readdir(root, { withFileTypes: true })
    const result: Array<{ requestId: string; state: StoredActiveState; mtimeMs: number }> = []
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^[0-9a-f-]{36}\.json$/i.test(entry.name)) {
        throw new ComponentUpdateActivationError('UPDATE_HISTORY_DIRECTORY_INVALID')
      }
      const requestId = requestIdSchema.parse(entry.name.slice(0, -5))
      const [state, info] = await Promise.all([this.#loadHistory(requestId), stat(managedChild(root, entry.name))])
      result.push({ requestId, state, mtimeMs: info.mtimeMs })
    }
    return result.sort((left, right) => left.mtimeMs - right.mtimeMs || compareText(left.requestId, right.requestId))
  }

  async #listReleaseIds(requireDirectory: boolean): Promise<string[]> {
    const releasesRoot = managedChild(this.#controlRoot, 'releases')
    const info = await lstat(releasesRoot).catch((error: unknown) => {
      if (!requireDirectory && isNodeError(error, 'ENOENT')) return null
      throw error
    })
    if (info === null) return []
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ComponentUpdateActivationError('UPDATE_RELEASE_DIRECTORY_INVALID')
    const result: string[] = []
    for (const component of managedComponentSchema.options) {
      const componentRoot = managedChild(releasesRoot, component)
      const componentInfo = await lstat(componentRoot).catch((error: unknown) => isNodeError(error, 'ENOENT') ? null : Promise.reject(error))
      if (componentInfo === null) continue
      if (!componentInfo.isDirectory() || componentInfo.isSymbolicLink()) throw new ComponentUpdateActivationError('UPDATE_RELEASE_DIRECTORY_INVALID')
      const entries = await readdir(componentRoot, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !releaseIdSchema.safeParse(entry.name).success || !entry.name.startsWith(`${component}-`)) {
          throw new ComponentUpdateActivationError('UPDATE_RELEASE_DIRECTORY_INVALID')
        }
        result.push(entry.name)
      }
    }
    return result.sort(compareText)
  }

  async #assertRoots(controlMustExist: boolean): Promise<void> {
    await assertRootDirectory(this.#projectRoot)
    await assertRootDirectory(this.#stagingRoot)
    if (controlMustExist) await assertDirectory(this.#controlRoot, this.#projectRoot)
    else {
      const info = await lstat(this.#controlRoot).catch((error: unknown) => isNodeError(error, 'ENOENT') ? null : Promise.reject(error))
      if (info !== null) await assertDirectory(this.#controlRoot, this.#projectRoot)
    }
  }

  async #runHostMutation<T extends ComponentUpdateActivationReceipt | null>(
    request: Readonly<{ operation: string; requestId: string }>,
    operation: (context: ActivationHostMutationContext) => Promise<T>
  ): Promise<T> {
    if (this.#hostMutationCoordinator === null) {
      throw new ComponentUpdateActivationError('UPDATE_HOST_LEASE_UNAVAILABLE')
    }
    try {
      return await this.#hostMutationCoordinator.runExclusive(
        request,
        async (scope) => {
          let possibleWrite = false
          let liveTerminal: { requestId: string; status: 'succeeded' | 'rolled-back' } | null = null
          let recoveryTerminalRequestId: string | null = null
          const context: ActivationHostMutationContext = {
            scope,
            recoveryRequestId: null,
            markPossibleWrite: () => { possibleWrite = true },
            resolvePossibleWrite: () => { possibleWrite = false },
            markLiveTerminalVerified: (requestId, status) => { liveTerminal = { requestId, status } },
            liveTerminalIsVerified: (requestId, status) =>
              liveTerminal?.requestId === requestId && liveTerminal.status === status,
            markRecoveryTerminalPersisted: (requestId) => { recoveryTerminalRequestId = requestId },
            recoveryTerminalWasPersisted: (requestId) => recoveryTerminalRequestId === requestId
          }
          if (this.#activeHostMutationContext !== null) {
            return hostMutationThrow<T>(
              new ComponentUpdateActivationError('UPDATE_HOST_LEASE_UNAVAILABLE'),
              'abandon'
            )
          }
          this.#activeHostMutationContext = context
          try {
            scope.assertActive()
            const result = await operation(context)
            scope.assertActive()
            // A returned activation/reconciliation result is a durable terminal
            // boundary. Recovery receipts still abandon below; healthy or
            // proven rolled-back terminals may release after state validation.
            context.resolvePossibleWrite()
            const state = await this.#loadState(true)
            const recoveryRequired = result?.recoveryRequired === true || state.recoveryRequired
            return hostMutationReturn(result, recoveryRequired ? 'abandon' : 'release')
          } catch (error) {
            // Let the generic coordinator translate lease loss and preserve its
            // broker-owned abandon semantics. Domain failures are classified
            // explicitly below so a safe rejection can release the host lease.
            if (error instanceof HostMutationLeaseError) throw error
            const abandon = await this.#mustAbandonHostLease(error, possibleWrite)
            return hostMutationThrow<T>(error, abandon ? 'abandon' : 'release')
          } finally {
            this.#activeHostMutationContext = null
          }
        }
      )
    } catch (error) {
      if (error instanceof ComponentUpdateActivationError) throw error
      if (error instanceof HostMutationOperationCoordinatorError) {
        throw new ComponentUpdateActivationError(mapHostMutationCoordinatorCode(error.code))
      }
      if (error instanceof HostMutationLeaseError) {
        throw new ComponentUpdateActivationError('UPDATE_HOST_LEASE_LOST')
      }
      throw new ComponentUpdateActivationError('UPDATE_HOST_LEASE_UNAVAILABLE')
    }
  }

  async #runRecoveryHostMutation(
    requestId: string,
    operation: (context: ActivationHostMutationContext) => Promise<ComponentUpdateActivationReceipt | null>
  ): Promise<ComponentUpdateActivationReceipt> {
    if (this.#hostMutationRecoveryCoordinator === null) {
      throw new ComponentUpdateActivationError('UPDATE_HOST_LEASE_UNAVAILABLE')
    }
    try {
      return await this.#hostMutationRecoveryCoordinator.runRecoveryExclusive(
        {
          expectedOperation: 'component-update-activation',
          expectedRequestId: requestId
        },
        async (scope) => {
          let possibleWrite = false
          let liveTerminal: { requestId: string; status: 'succeeded' | 'rolled-back' } | null = null
          let recoveryTerminalRequestId: string | null = null
          const context: ActivationHostMutationContext = {
            scope,
            recoveryRequestId: requestId,
            markPossibleWrite: () => { possibleWrite = true },
            resolvePossibleWrite: () => { possibleWrite = false },
            markLiveTerminalVerified: (verifiedRequestId, status) => {
              liveTerminal = { requestId: verifiedRequestId, status }
            },
            liveTerminalIsVerified: (verifiedRequestId, status) =>
              liveTerminal?.requestId === verifiedRequestId && liveTerminal.status === status,
            markRecoveryTerminalPersisted: (persistedRequestId) => {
              recoveryTerminalRequestId = persistedRequestId
            },
            recoveryTerminalWasPersisted: (persistedRequestId) =>
              recoveryTerminalRequestId === persistedRequestId
          }
          if (this.#activeHostMutationContext !== null) {
            return hostMutationThrow<ComponentUpdateActivationReceipt>(
              new ComponentUpdateActivationError('UPDATE_HOST_LEASE_UNAVAILABLE'),
              'abandon'
            )
          }
          this.#activeHostMutationContext = context
          try {
            scope.assertActive()
            let result: ComponentUpdateActivationReceipt | null
            try {
              result = await operation(context)
            } catch (error) {
              if (error instanceof CandidateHandledError) result = error.receipt
              else throw error
            }
            scope.assertActive()
            if (result === null || result.requestId !== requestId) {
              throw new ComponentUpdateActivationError('UPDATE_RECOVERY_TERMINAL_UNPROVEN')
            }
            if (result.recoveryRequired) {
              return hostMutationReturn(result, 'abandon')
            }
            if (!context.recoveryTerminalWasPersisted(requestId)) {
              throw new ComponentUpdateActivationError('UPDATE_RECOVERY_TERMINAL_UNPROVEN')
            }
            context.resolvePossibleWrite()
            return hostMutationReturn(result, 'release')
          } catch (error) {
            // Every failure after explicit recovery acquisition is sticky. A
            // caller can retry only through another exact broker-bound recovery.
            if (error instanceof HostMutationLeaseError) throw error
            return hostMutationThrow<ComponentUpdateActivationReceipt>(error, 'abandon')
          } finally {
            this.#activeHostMutationContext = null
          }
        }
      )
    } catch (error) {
      if (error instanceof ComponentUpdateActivationError) throw error
      if (error instanceof HostMutationOperationCoordinatorError) {
        throw new ComponentUpdateActivationError(mapHostMutationCoordinatorCode(error.code))
      }
      if (error instanceof HostMutationLeaseError) {
        throw new ComponentUpdateActivationError('UPDATE_HOST_LEASE_LOST')
      }
      throw new ComponentUpdateActivationError('UPDATE_HOST_LEASE_UNAVAILABLE')
    }
  }

  async #mustAbandonHostLease(error: unknown, possibleWrite: boolean): Promise<boolean> {
    if (possibleWrite) return true
    if (error instanceof ComponentUpdateActivationError) {
      if (error.receipt?.recoveryRequired === true || hostLeaseRecoveryCodes.has(error.code)) return true
    }
    try {
      return (await this.#loadState(true)).recoveryRequired
    } catch {
      // If the durable state cannot be proven, releasing would allow another
      // host mutation to proceed across an unknown activation boundary.
      return true
    }
  }

  async #initialize(): Promise<void> {
    await this.#assertRoots(false)
    await mkdir(this.#controlRoot, { recursive: false }).catch((error: unknown) => {
      if (!isNodeError(error, 'EEXIST')) throw error
    })
    await assertDirectory(this.#controlRoot, this.#projectRoot)
    for (const name of [
      'releases', 'history', 'receipts', 'recovery-receipts', 'transactions', '.pending', '.locks'
    ]) {
      const directory = managedChild(this.#controlRoot, name)
      await mkdir(directory, { recursive: true })
      await assertDirectory(directory, this.#controlRoot)
    }
  }

  async #withCrossInstanceLock<T>(
    operation: () => Promise<T>,
    recoveryContext?: ActivationHostMutationContext
  ): Promise<T> {
    const lockPath = managedChild(this.#controlRoot, '.locks', 'activation.lock')
    const instanceId = randomUUID()
    const handle = await this.#acquireLock(lockPath, instanceId, recoveryContext)
    try {
      return await operation()
    } finally {
      await handle.close().catch(() => undefined)
      const current = await this.#readLock(lockPath).catch(() => null)
      if (current?.instanceId === instanceId) await unlink(lockPath).catch(() => undefined)
    }
  }

  async #acquireLock(
    lockPath: string,
    instanceId: string,
    recoveryContext?: ActivationHostMutationContext
  ): Promise<FileHandle> {
    const lock = activationLockSchema.parse({
      format: 'dyson-control-component-update-lock',
      schemaVersion: 1,
      host: hostname(),
      bootId: currentBootId(),
      pid: process.pid,
      instanceId,
      acquiredAt: this.#timestamp()
    })
    const candidatePath = managedChild(
      this.#controlRoot,
      '.locks',
      `.activation-${instanceId}.tmp`
    )
    try {
      // Publish a fully written record with one atomic hard link. A hard exit
      // can therefore leave either no activation.lock or a complete one, never
      // an O_EXCL-created empty/partial lock pathname.
      await writeDurableExclusive(candidatePath, `${canonicalJson(lock)}\n`)
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await link(candidatePath, lockPath)
          await syncDirectory(path.dirname(lockPath))
          const handle = await open(lockPath, constants.O_RDONLY)
          await unlink(candidatePath).catch(() => undefined)
          return handle
        } catch (error) {
          if (!isNodeError(error, 'EEXIST')) {
            const current = await this.#readLock(lockPath).catch(() => null)
            if (current?.instanceId === instanceId) await unlink(lockPath).catch(() => undefined)
            throw new ComponentUpdateActivationError('UPDATE_ACTIVATION_LOCK_FAILED', { cause: error })
          }
          const removed = attempt === 0 && (
            await this.#removeProvablyStaleLock(lockPath) ||
            (recoveryContext !== undefined &&
              await this.#removeInvalidRecoveryLock(lockPath, recoveryContext))
          )
          if (!removed) {
            throw new ComponentUpdateActivationError('UPDATE_ACTIVATION_LOCK_BUSY', { cause: error })
          }
        }
      }
      throw new ComponentUpdateActivationError('UPDATE_ACTIVATION_LOCK_BUSY')
    } finally {
      await unlink(candidatePath).catch(() => undefined)
    }
  }

  async #removeProvablyStaleLock(lockPath: string): Promise<boolean> {
    let lock: z.infer<typeof activationLockSchema>
    let identity: BigIntStats
    try {
      identity = await lstat(lockPath, { bigint: true })
      lock = await this.#readLock(lockPath)
    } catch {
      return false
    }
    if (lock.host !== hostname()) return false
    if (lock.bootId !== currentBootId()) {
      return await this.#unlinkLockIdentity(lockPath, identity)
    }
    if (processIsAlive(lock.pid)) return false
    return await this.#unlinkLockIdentity(lockPath, identity)
  }

  async #unlinkLockIdentity(lockPath: string, expected: BigIntStats): Promise<boolean> {
    const current = await lstat(lockPath, { bigint: true }).catch((error: unknown) => {
      if (isNodeError(error, 'ENOENT')) return null
      throw error
    })
    if (current === null) return true
    if (!sameFileIdentity(expected, current)) return false
    await unlink(lockPath)
    await syncDirectory(path.dirname(lockPath))
    return true
  }

  async #removeInvalidRecoveryLock(
    lockPath: string,
    context: ActivationHostMutationContext
  ): Promise<boolean> {
    // A valid live lock is never stolen. This recovery-only path handles the
    // O_EXCL-created zero/partial file left when the former process died before
    // its lock record became durable.
    try {
      await this.#readLock(lockPath)
      return false
    } catch {
      // Continue with strict pathname identity checks below.
    }
    const before = await lstat(lockPath, { bigint: true }).catch((error: unknown) => {
      if (isNodeError(error, 'ENOENT')) return null
      throw error
    })
    if (before === null) return true
    if (!before.isFile() || before.isSymbolicLink() || before.size > 2_048) return false
    context.scope.assertActive()
    const current = await lstat(lockPath, { bigint: true }).catch((error: unknown) => {
      if (isNodeError(error, 'ENOENT')) return null
      throw error
    })
    if (current === null) return true
    if (!sameFileIdentity(before, current)) return false
    context.scope.assertActive()
    await unlink(lockPath)
    await syncDirectory(path.dirname(lockPath))
    context.scope.assertActive()
    return true
  }

  async #convergeRecoveryTemporaryEvidence(
    requestId: string,
    context: ActivationHostMutationContext
  ): Promise<void> {
    await this.#convergeRecoveryTemporaryFile(
      managedChild(this.#controlRoot, 'history'),
      requestId,
      (value) => {
        const schema = z.strictObject({
          format: z.literal('dyson-control-component-update-history'),
          schemaVersion: z.literal(1),
          requestId: requestIdSchema,
          state: storedStateSchema
        })
        const envelope = schema.parse(value)
        validateStoredStateRevision(envelope.state)
        if (envelope.requestId !== requestId) throw new Error('history/request mismatch')
      },
      context
    )
    await this.#convergeRecoveryTemporaryFile(
      managedChild(this.#controlRoot, 'transactions'),
      requestId,
      (value) => {
        const journal = journalSchema.parse(value)
        if (journal.transaction.requestId !== requestId) throw new Error('journal/request mismatch')
      },
      context
    )
  }

  async #convergeRecoveryTemporaryFile(
    root: string,
    requestId: string,
    validate: (value: unknown) => void,
    context: ActivationHostMutationContext
  ): Promise<void> {
    const entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() &&
        isRecoveryTemporaryName(entry.name, requestId))
    if (entries.length > 1) {
      throw new ComponentUpdateActivationError('UPDATE_RECOVERY_EVIDENCE_INVALID')
    }
    if (entries.length === 0) return
    const temporary = managedChild(root, entries[0]!.name)
    const finalPath = managedChild(root, `${requestId}.json`)
    const temporaryValue = await readJsonIfPresent(temporary)
    if (temporaryValue === null) throw new ComponentUpdateActivationError('UPDATE_RECOVERY_EVIDENCE_INVALID')
    try {
      validate(temporaryValue)
    } catch (error) {
      throw new ComponentUpdateActivationError('UPDATE_RECOVERY_EVIDENCE_INVALID', { cause: error })
    }
    const finalValue = await readJsonIfPresent(finalPath)
    context.scope.assertActive()
    if (finalValue === null) {
      await rename(temporary, finalPath)
    } else {
      validate(finalValue)
      if (canonicalJson(finalValue) !== canonicalJson(temporaryValue)) {
        throw new ComponentUpdateActivationError('UPDATE_RECOVERY_EVIDENCE_INVALID')
      }
      await unlink(temporary)
    }
    await syncDirectory(root)
    context.scope.assertActive()
  }

  async #readLock(lockPath: string): Promise<z.infer<typeof activationLockSchema>> {
    const info = await lstat(lockPath)
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 2_048) {
      throw new ComponentUpdateActivationError('UPDATE_ACTIVATION_LOCK_INVALID')
    }
    try {
      return activationLockSchema.parse(JSON.parse(await readFile(lockPath, 'utf8')))
    } catch (error) {
      throw new ComponentUpdateActivationError('UPDATE_ACTIVATION_LOCK_INVALID', { cause: error })
    }
  }

  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void
    const previous = this.#tail
    this.#tail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  #timestamp(): string {
    const value = this.#now().toISOString()
    isoDateSchema.parse(value)
    return value
  }
}

function normalizeActivationRequest(input: unknown): NormalizedActivationRequest {
  let parsed: z.infer<typeof componentUpdateActivationRequestSchema>
  try {
    parsed = componentUpdateActivationRequestSchema.parse(input)
  } catch (error) {
    throw new ComponentUpdateActivationError('UPDATE_REQUEST_INVALID', { cause: error })
  }
  if (parsed.component === 'dsp') {
    try {
      normalizeVersion(parsed.targetVersion, 'dsp')
    } catch (error) {
      throw new ComponentUpdateActivationError('UPDATE_REQUEST_INVALID', { cause: error })
    }
    throw new ComponentUpdateActivationError('UPDATE_DSP_MANUAL_STEAM_REQUIRED')
  }
  try {
    return {
      requestId: parsed.requestId,
      component: parsed.component,
      artifactId: parsed.artifactId!,
      sha256: parsed.sha256!.toLowerCase(),
      targetVersion: normalizeManagedVersion(parsed.targetVersion, parsed.component),
      expectedRevision: parsed.expectedRevision,
      compatibilityReceiptId: parsed.compatibilityReceiptId!
    }
  } catch (error) {
    if (error instanceof ComponentUpdateActivationError) throw error
    throw new ComponentUpdateActivationError('UPDATE_REQUEST_INVALID', { cause: error })
  }
}

function inventoryVersion(inventory: NormalizedRuntimeInventory, component: ManagedUpdateComponent): string | null {
  if (component === 'nebula') return inventory.nebula
  if (component === 'bepinex') return inventory.bepInEx
  const sourceId = managedPluginSource(component).toLowerCase()
  return inventory.plugins.find((plugin) => plugin.sourceId.toLowerCase() === sourceId)?.version ?? null
}

function trustedCompatibilityErrorCode(error: unknown): string {
  if (!(error instanceof TrustedCompatibilityError)) return 'UPDATE_COMPATIBILITY_EVIDENCE_INVALID'
  return trustedCompatibilityActivationCodes.has(error.code)
    ? error.code
    : 'UPDATE_COMPATIBILITY_EVIDENCE_INVALID'
}

const trustedCompatibilityActivationCodes = new Set([
  'UPDATE_COMPATIBILITY_CANDIDATE_INVALID',
  'UPDATE_COMPATIBILITY_CANDIDATE_MISMATCH',
  'UPDATE_COMPATIBILITY_CONFLICT',
  'UPDATE_COMPATIBILITY_INVENTORY_DRIFT',
  'UPDATE_COMPATIBILITY_INVENTORY_UNAVAILABLE',
  'UPDATE_COMPATIBILITY_POLICY_DRIFT',
  'UPDATE_COMPATIBILITY_POLICY_UNAVAILABLE',
  'UPDATE_COMPATIBILITY_RECEIPT_EXPIRED',
  'UPDATE_COMPATIBILITY_RECEIPT_INVALID',
  'UPDATE_COMPATIBILITY_RECEIPT_NOT_FOUND',
  'UPDATE_COMPATIBILITY_ROOT_INVALID',
  'UPDATE_COMPATIBILITY_ROOT_UNAVAILABLE'
])

function managedPluginSource(component: 'bridge' | 'control'): string {
  return managedUpdateComponentSourceIds[component]
}

function stagedIdentityMatches(component: ManagedUpdateComponent, manifest: StagedArtifactManifest): boolean {
  const source = manifest.release.sourceId.toLowerCase()
  if (component === 'nebula') return manifest.release.kind === 'nebula' && source === managedUpdateComponentSourceIds.nebula.toLowerCase()
  if (component === 'bepinex') return manifest.release.kind === 'bepinex' && source === managedUpdateComponentSourceIds.bepinex.toLowerCase()
  return manifest.release.kind === 'plugin' && source === managedPluginSource(component).toLowerCase()
}

function assertStagedContentManifest(
  request: NormalizedActivationRequest,
  staged: StagedArtifactManifest,
  inspected: ComponentReleaseManifest
): void {
  if (request.component === 'bepinex') {
    if (staged.componentManifest === undefined ||
        canonicalJson(staged.componentManifest) !== canonicalJson(inspected)) {
      throw new ComponentUpdateActivationError('UPDATE_STAGED_CONTENT_MANIFEST_MISMATCH')
    }
  } else if (staged.componentManifest !== undefined) {
    throw new ComponentUpdateActivationError('UPDATE_STAGED_CONTENT_MANIFEST_UNEXPECTED')
  }
}

function createActivationPlan(
  request: NormalizedActivationRequest,
  state: StoredActiveState,
  compatibility: CompatibilityDecision,
  fileCount: number,
  expandedBytes: number
): ComponentUpdateActivationPlan {
  return {
    format: 'dyson-control-component-update-plan',
    schemaVersion: 1,
    dryRun: true,
    requestId: request.requestId,
    component: request.component,
    artifactId: request.artifactId,
    targetVersion: request.targetVersion,
    expectedRevision: request.expectedRevision,
    compatibilityReceiptId: request.compatibilityReceiptId,
    releaseId: createReleaseId(request),
    fileCount,
    expandedBytes,
    compatibility,
    operations: [
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
    ],
    rollback: {
      automatic: true,
      previousReleaseRequired: state.components.some((component) => component.component === request.component),
      recoveryRequiredIfUnproven: true
    }
  }
}

function buildCandidateState(
  previous: StoredActiveState,
  request: NormalizedActivationRequest,
  releaseId: string,
  transaction: StoredTransaction
): StoredActiveState {
  const components = previous.components.filter((component) => component.component !== request.component)
  components.push({
    component: request.component,
    version: request.targetVersion,
    artifactId: request.artifactId,
    sha256: request.sha256,
    releaseId
  })
  components.sort(compareStoredComponents)
  const base: Omit<StoredActiveState, 'revision'> = {
    format: 'dyson-control-component-active-state',
    schemaVersion: 1,
    recoveryRequired: false,
    components,
    lastTransaction: transaction
  }
  return { ...base, revision: computeStateRevision(base) }
}

function buildRecoveryState(state: StoredActiveState, transaction: StoredTransaction): StoredActiveState {
  const base: Omit<StoredActiveState, 'revision'> = {
    format: state.format,
    schemaVersion: state.schemaVersion,
    recoveryRequired: true,
    components: state.components,
    lastTransaction: transaction
  }
  return { ...base, revision: computeStateRevision(base) }
}

function clearRecoveryState(
  state: StoredActiveState,
  transaction: StoredTransaction
): StoredActiveState {
  if (!state.recoveryRequired || !sameStoredTransaction(state.lastTransaction, transaction)) {
    throw new ComponentUpdateActivationError('UPDATE_RECOVERY_EVIDENCE_INVALID')
  }
  const base: Omit<StoredActiveState, 'revision'> = {
    format: state.format,
    schemaVersion: state.schemaVersion,
    recoveryRequired: false,
    components: state.components,
    lastTransaction: transaction
  }
  return { ...base, revision: computeStateRevision(base) }
}

function stateCanReconcileTransaction(
  state: StoredActiveState,
  previousState: StoredActiveState,
  transaction: StoredTransaction
): boolean {
  if (state.revision === previousState.revision && canonicalJson(state) === canonicalJson(previousState)) {
    return true
  }
  if (!sameStoredTransaction(state.lastTransaction, transaction)) return false
  if (state.recoveryRequired) {
    return classifyRecoveryStateLayout(state, previousState, transaction) !== 'unknown'
  }
  return classifyRecoveryStateLayout(state, previousState, transaction) === 'candidate'
}

function classifyRecoveryStateLayout(
  state: StoredActiveState,
  previousState: StoredActiveState,
  transaction: StoredTransaction
): 'candidate' | 'previous' | 'unknown' {
  if (canonicalJson(state.components) === canonicalJson(previousState.components)) return 'previous'
  const active = state.components.find((component) => component.component === transaction.component)
  if (active?.releaseId !== transaction.releaseId || active.artifactId !== transaction.artifactId ||
      active.version !== transaction.targetVersion) {
    return 'unknown'
  }
  const currentOthers = state.components.filter((component) => component.component !== transaction.component)
  const previousOthers = previousState.components.filter((component) => component.component !== transaction.component)
  return canonicalJson(currentOthers) === canonicalJson(previousOthers) &&
    state.components.length === previousOthers.length + 1
    ? 'candidate'
    : 'unknown'
}

function sameStoredTransaction(
  left: StoredTransaction | null,
  right: StoredTransaction
): boolean {
  return left !== null && canonicalJson(left) === canonicalJson(right)
}

function isRecoveryRequiredReceipt(receipt: ComponentUpdateActivationReceipt): boolean {
  return receipt.status === 'rollback-failed' && receipt.recoveryRequired &&
    !receipt.rollbackVerified && receipt.failureCode !== null
}

function assertReceiptBoundToTransaction(
  envelope: StoredReceiptEnvelope,
  transaction: StoredTransaction
): void {
  const receipt = envelope.receipt
  if (envelope.requestFingerprint !== transaction.requestFingerprint) {
    throw new ComponentUpdateActivationError('UPDATE_RECOVERY_EVIDENCE_INVALID')
  }
  const bindings = [
    [receipt.requestId, transaction.requestId],
    [receipt.component, transaction.component],
    [receipt.artifactId, transaction.artifactId],
    [receipt.compatibilityReceiptId, transaction.compatibilityReceiptId],
    [receipt.targetVersion, transaction.targetVersion],
    [receipt.releaseId, transaction.releaseId],
    [receipt.previousRevision, transaction.previousRevision],
    [receipt.protectionBackupId, transaction.protectionBackupId],
    [receipt.fileCount, transaction.fileCount],
    [receipt.expandedBytes, transaction.expandedBytes]
  ] as const
  if (bindings.some(([actual, expected]) => actual !== expected)) {
    throw new ComponentUpdateActivationError('UPDATE_RECOVERY_EVIDENCE_INVALID')
  }
}

function isCoherentTerminalReceipt(receipt: ComponentUpdateActivationReceipt): boolean {
  if (receipt.recoveryRequired) return false
  if (receipt.status === 'succeeded') {
    return receipt.failureCode === null && !receipt.rollbackVerified
  }
  if (receipt.status === 'rolled-back') {
    return receipt.failureCode !== null && receipt.rollbackVerified &&
      receipt.resultingRevision === receipt.previousRevision
  }
  return receipt.status === 'failed' && receipt.failureCode !== null && !receipt.rollbackVerified
}

function isValidRecoveryReceiptTransition(
  original: StoredReceiptEnvelope,
  recovered: StoredReceiptEnvelope
): boolean {
  if (original.requestFingerprint !== recovered.requestFingerprint ||
      !isRecoveryRequiredReceipt(original.receipt) || recovered.receipt.recoveryRequired) {
    return false
  }
  const immutableKeys = [
    'requestId', 'component', 'artifactId', 'compatibilityReceiptId', 'targetVersion',
    'releaseId', 'previousRevision', 'protectionBackupId', 'fileCount', 'expandedBytes'
  ] as const
  if (immutableKeys.some((key) => original.receipt[key] !== recovered.receipt[key])) return false
  if (recovered.receipt.status === 'succeeded') {
    return recovered.receipt.failureCode === null && !recovered.receipt.rollbackVerified
  }
  return recovered.receipt.status === 'rolled-back' && recovered.receipt.failureCode !== null &&
    recovered.receipt.rollbackVerified &&
    recovered.receipt.resultingRevision === recovered.receipt.previousRevision
}

function initialStoredState(): StoredActiveState {
  return { ...initialStateBase, components: [], revision: initialComponentUpdateRevision }
}

function validateStoredStateRevision(state: StoredActiveState): void {
  const { revision, ...base } = state
  if (computeStateRevision(base) !== revision) throw new ComponentUpdateActivationError('UPDATE_STATE_REVISION_INVALID')
}

function computeStateRevision(state: Omit<StoredActiveState, 'revision'>): string {
  return createHash('sha256').update(canonicalJson(state)).digest('hex')
}

function createReleaseId(request: Pick<NormalizedActivationRequest, 'component' | 'targetVersion' | 'sha256'>): string {
  const suffix = createHash('sha256').update(`${request.component}\0${request.targetVersion}\0${request.sha256}`).digest('hex').slice(0, 32)
  return `${request.component}-${suffix}`
}

function requestFingerprint(request: NormalizedActivationRequest): string {
  return createHash('sha256').update(canonicalJson(request)).digest('hex')
}

function createReceipt(input: {
  request: Pick<NormalizedActivationRequest, 'requestId' | 'component' | 'artifactId' | 'targetVersion' | 'compatibilityReceiptId'>
  releaseId: string
  status: ComponentUpdateActivationReceipt['status']
  previousRevision: string
  resultingRevision: string
  protectionBackupId: string | null
  failureCode: string | null
  rollbackVerified: boolean
  recoveryRequired: boolean
  fileCount: number
  expandedBytes: number
  completedAt: string
}): ComponentUpdateActivationReceipt {
  return receiptSchema.parse({
    format: 'dyson-control-component-update-receipt',
    schemaVersion: 1,
    requestId: input.request.requestId,
    component: input.request.component,
    artifactId: input.request.artifactId,
    compatibilityReceiptId: input.request.compatibilityReceiptId,
    targetVersion: input.request.targetVersion,
    releaseId: input.releaseId,
    status: input.status,
    previousRevision: input.previousRevision,
    resultingRevision: input.resultingRevision,
    protectionBackupId: input.protectionBackupId,
    failureCode: input.failureCode,
    rollbackVerified: input.rollbackVerified,
    recoveryRequired: input.recoveryRequired,
    fileCount: input.fileCount,
    expandedBytes: input.expandedBytes,
    completedAt: input.completedAt,
    reused: false
  })
}

function journalToReceipt(
  transaction: StoredTransaction,
  resultingState: StoredActiveState,
  status: 'rolled-back' | 'rollback-failed',
  failureCode: string,
  rollbackVerified: boolean,
  recoveryRequired: boolean,
  completedAt: string
): ComponentUpdateActivationReceipt {
  return createReceipt({
    request: transactionToRequest(transaction),
    releaseId: transaction.releaseId,
    status,
    previousRevision: transaction.previousRevision,
    resultingRevision: resultingState.revision,
    protectionBackupId: transaction.protectionBackupId,
    failureCode,
    rollbackVerified,
    recoveryRequired,
    fileCount: transaction.fileCount,
    expandedBytes: transaction.expandedBytes,
    completedAt
  })
}

function transactionToRequest(transaction: StoredTransaction): Pick<NormalizedActivationRequest, 'requestId' | 'component' | 'artifactId' | 'targetVersion' | 'compatibilityReceiptId'> {
  return {
    requestId: transaction.requestId,
    component: transaction.component,
    artifactId: transaction.artifactId,
    compatibilityReceiptId: transaction.compatibilityReceiptId,
    targetVersion: transaction.targetVersion
  }
}

function transactionToLiveRequest(transaction: StoredTransaction): {
  requestId: string
  component: ManagedUpdateComponent
  releaseId: string
  artifactId: string
  targetVersion: string
} {
  return {
    requestId: transaction.requestId,
    component: transaction.component,
    releaseId: transaction.releaseId,
    artifactId: transaction.artifactId,
    targetVersion: transaction.targetVersion
  }
}

function handleExistingReceipt(envelope: StoredReceiptEnvelope, fingerprint: string): ComponentUpdateActivationReceipt {
  if (envelope.requestFingerprint !== fingerprint) throw new ComponentUpdateActivationError('UPDATE_IDEMPOTENCY_CONFLICT')
  const reused = { ...envelope.receipt, reused: true }
  if (reused.status === 'failed') {
    throw new ComponentUpdateActivationError(reused.failureCode ?? 'UPDATE_FAILED', { receipt: reused })
  }
  return reused
}

function smokeIsHealthy(result: FixedUpdateSmokeResult, component: ManagedUpdateComponent, expectedVersion: string | null): boolean {
  const observedNormalized = result.observedVersion === null
    ? null
    : normalizeManagedVersion(result.observedVersion, component)
  return result.component === component && result.versionMatches && observedNormalized === expectedVersion &&
    result.bepInExLoaded && result.nebulaLoaded && result.processHealthy && result.portHealthy
}

function normalizeManagedVersion(value: unknown, component: ManagedUpdateComponent): string {
  return normalizeVersion(value, component === 'nebula' ? 'nebula' : component === 'bepinex' ? 'bepinex' : 'plugin')
}

function toActiveSummary(component: StoredActiveComponent): ActiveComponentSummary {
  return {
    component: component.component,
    version: component.version,
    artifactId: component.artifactId,
    releaseId: component.releaseId
  }
}

async function hashFileSnapshot(
  filePath: string,
  maximumBytes: number,
  before: BigIntStats
): Promise<{ sizeBytes: number; sha256: string }> {
  const digest = createHash('sha256')
  let sizeBytes = 0
  for await (const chunk of createReadStream(filePath)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    sizeBytes += bytes.length
    if (sizeBytes > maximumBytes) throw new ComponentUpdateActivationError('UPDATE_STAGED_ARTIFACT_TOO_LARGE')
    digest.update(bytes)
  }
  const after = await lstat(filePath, { bigint: true })
  if (!sameFileSnapshot(before, after) || sizeBytes !== Number(after.size)) {
    throw new ComponentUpdateActivationError('UPDATE_STAGED_ARTIFACT_UNSTABLE')
  }
  return { sizeBytes, sha256: digest.digest('hex') }
}

function sameFileSnapshot(
  left: BigIntStats,
  right: BigIntStats
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

async function assertRootDirectory(root: string): Promise<void> {
  const info = await lstat(root).catch((error: unknown) => {
    throw new ComponentUpdateActivationError('UPDATE_ROOT_UNAVAILABLE', { cause: error })
  })
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ComponentUpdateActivationError('UPDATE_ROOT_INVALID')
  const resolved = await realpath(root)
  if (canonicalPath(resolved) !== canonicalPath(path.resolve(root))) {
    throw new ComponentUpdateActivationError('UPDATE_ROOT_REPARSE_FORBIDDEN')
  }
}

async function assertDirectory(directory: string, boundary: string): Promise<void> {
  assertDescendant(boundary, directory)
  const info = await lstat(directory).catch((error: unknown) => {
    throw new ComponentUpdateActivationError('UPDATE_DIRECTORY_INVALID', { cause: error })
  })
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ComponentUpdateActivationError('UPDATE_DIRECTORY_INVALID')
  const [boundaryReal, directoryReal] = await Promise.all([realpath(boundary), realpath(directory)])
  assertDescendant(boundaryReal, directoryReal)
}

function managedChild(root: string, ...segments: string[]): string {
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..' ||
      segment.includes('/') || segment.includes('\\') || segment.includes(':'))) {
    throw new ComponentUpdateActivationError('UPDATE_MANAGED_NAME_INVALID')
  }
  const candidate = path.resolve(root, ...segments)
  assertDescendant(root, candidate)
  return candidate
}

function assertDescendant(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ComponentUpdateActivationError('UPDATE_PATH_ESCAPE')
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right) || isDescendantOrEqual(left, right) || isDescendantOrEqual(right, left)
}

function isDescendantOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function canonicalPath(value: string): string {
  return process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
}

function currentBootId(): string {
  // Date.now() and os.uptime() use different clocks but their difference is
  // stable for one boot. Minute rounding tolerates sub-second sampling drift.
  return Math.round((Date.now() - uptime() * 1_000) / 60_000).toString(36)
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !isNodeError(error, 'ESRCH')
  }
}

function isRecoveryTemporaryName(name: string, requestId: string): boolean {
  const prefix = `${requestId}.json.`.toLowerCase()
  const lower = name.toLowerCase()
  if (!lower.startsWith(prefix) || !lower.endsWith('.tmp')) return false
  return requestIdSchema.safeParse(name.slice(prefix.length, -4)).success
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs && left.mtimeNs === right.mtimeNs &&
    left.size === right.size
}

async function pathExists(filePath: string): Promise<boolean> {
  return await lstat(filePath).then(() => true, (error: unknown) => {
    if (isNodeError(error, 'ENOENT')) return false
    throw error
  })
}

async function readJsonIfPresent(filePath: string): Promise<unknown | null> {
  try {
    const info = await lstat(filePath)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1_024 * 1_024) {
      throw new ComponentUpdateActivationError('UPDATE_PERSISTED_FILE_INVALID')
    }
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null
    if (error instanceof ComponentUpdateActivationError) throw error
    throw new ComponentUpdateActivationError('UPDATE_PERSISTED_FILE_INVALID', { cause: error })
  }
}

async function writeImmutableJson(
  filePath: string,
  value: unknown,
  scope?: HostMutationOperationScope
): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`
  try {
    scope?.assertActive()
    await writeDurableExclusive(temporary, `${canonicalJson(value)}\n`)
    scope?.assertActive()
    await rename(temporary, filePath)
    await syncDirectory(path.dirname(filePath))
    scope?.assertActive()
  } catch (error) {
    if (error instanceof HostMutationLeaseError) throw error
    await unlink(temporary).catch(() => undefined)
    throw new ComponentUpdateActivationError('UPDATE_PERSISTENCE_FAILED', { cause: error })
  }
}

async function writeDurableExclusive(filePath: string, content: string): Promise<void> {
  const handle = await open(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | null = null
  try {
    handle = await open(directory, constants.O_RDONLY)
    await handle.sync()
  } catch (error) {
    if (process.platform !== 'win32' || !isDirectorySyncUnsupported(error)) throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function isDirectorySyncUnsupported(error: unknown): boolean {
  return ['EINVAL', 'EPERM', 'EACCES', 'EISDIR'].some((code) => isNodeError(error, code))
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonical(value))
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => [key, sortCanonical(entry)]))
  }
  return value
}

function compareStoredComponents(left: StoredActiveComponent, right: StoredActiveComponent): number {
  return compareText(left.component, right.component)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
}

function normalizeError(error: unknown): ComponentUpdateActivationError {
  return error instanceof ComponentUpdateActivationError
    ? error
    : new ComponentUpdateActivationError('UPDATE_ACTIVATION_FAILED', { cause: error })
}

const hostLeaseRecoveryCodes = new Set([
  'UPDATE_ACTIVE_STATE_INVALID',
  'UPDATE_JOURNAL_CONFLICT',
  'UPDATE_JOURNAL_DIRECTORY_INVALID',
  'UPDATE_JOURNAL_INVALID',
  'UPDATE_RECEIPT_INVALID',
  'UPDATE_RECONCILIATION_AMBIGUOUS',
  'UPDATE_RECONCILIATION_UNCERTAIN',
  'UPDATE_RECOVERY_REQUIRED',
  'UPDATE_STATE_REVISION_INVALID'
])

function mapHostMutationCoordinatorCode(code: string): string {
  switch (code) {
    case 'HOST_MUTATION_LEASE_BUSY': return 'UPDATE_HOST_LEASE_BUSY'
    case 'HOST_MUTATION_LEASE_DIRTY': return 'UPDATE_HOST_LEASE_DIRTY'
    case 'HOST_MUTATION_LEASE_RECOVERY_REQUIRED': return 'UPDATE_HOST_LEASE_RECOVERY_REQUIRED'
    case 'HOST_MUTATION_LEASE_RECOVERY_NOT_REQUIRED': return 'UPDATE_HOST_LEASE_RECOVERY_NOT_REQUIRED'
    case 'HOST_MUTATION_LEASE_RECOVERY_MISMATCH': return 'UPDATE_HOST_LEASE_RECOVERY_MISMATCH'
    case 'HOST_MUTATION_LEASE_LOST': return 'UPDATE_HOST_LEASE_LOST'
    default: return 'UPDATE_HOST_LEASE_UNAVAILABLE'
  }
}

class CandidateHandledError extends Error {
  readonly receipt: ComponentUpdateActivationReceipt

  constructor(receipt: ComponentUpdateActivationReceipt, options?: ErrorOptions) {
    super(receipt.failureCode ?? receipt.status, options)
    this.receipt = receipt
  }
}

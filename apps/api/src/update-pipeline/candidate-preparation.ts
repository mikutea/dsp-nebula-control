import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink
} from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  artifactAcquisitionReceiptSchema,
  type ArtifactAcquisitionReceipt
} from './acquisition.js'
import {
  bepInExWindowsX64LayoutPolicyIds,
  resolveBepInExWindowsX64LayoutPolicy,
  type BepInExWindowsX64LayoutPolicyId
} from './bepinex-layout.js'
import { UpdatePipelineError } from './errors.js'
import {
  nebulaWindowsLayoutPolicyIds,
  prepareOfficialNebulaWindowsArchive,
  resolveNebulaWindowsLayoutPolicy,
  type NebulaWindowsLayoutPolicyId
} from './nebula-layout.js'
import {
  OfflineArtifactStager,
  stagedArtifactManifestSchema,
  type StagedArtifactManifest
} from './staging.js'
import { sha256Schema, sourceIdSchema } from '../updates/version.js'

const uuidSchema = z.string().uuid()
const componentSchema = z.enum(['nebula', 'bepinex', 'bridge', 'control'])
const supportedComponentSchema = z.enum(['nebula', 'bepinex'])
const unavailableComponentSchema = z.enum(['bridge', 'control'])
const artifactIdSchema = z.string().min(16).max(96).regex(/^[a-z0-9][a-z0-9-]+$/)
const isoDateSchema = z.string().datetime({ offset: true })
const maximumSupportedArtifactBytes = 2 * 1_024 * 1_024 * 1_024
const byteCountSchema = z.number().int().positive().max(maximumSupportedArtifactBytes)
const layoutPolicySchema = z.enum([
  nebulaWindowsLayoutPolicyIds.v0_9_22,
  bepInExWindowsX64LayoutPolicyIds.v5_4_22,
  bepInExWindowsX64LayoutPolicyIds.v5_4_23_2_through_5
])

export type ComponentCandidatePreparationComponent = z.infer<typeof componentSchema>
export type SupportedComponentCandidatePreparationComponent = z.infer<typeof supportedComponentSchema>

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

export const componentCandidatePreparationPreviewRequestSchema = z.strictObject({
  component: componentSchema,
  acquisitionReceiptId: uuidSchema
})

export const componentCandidatePreparationRequestSchema = z.strictObject({
  requestId: uuidSchema,
  component: componentSchema,
  acquisitionReceiptId: uuidSchema,
  confirmation: z.literal('PREPARE_COMPONENT_CANDIDATE')
})

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
    layoutPolicy: NebulaWindowsLayoutPolicyId | BepInExWindowsX64LayoutPolicyId
  }
  operations: readonly ComponentCandidatePreparationOperation[]
  activation: {
    automatic: false
    nextAction: 'component-update-activation-preview'
  }
}

export type ComponentCandidatePreparationPlan =
  | AvailableComponentCandidatePreparationPlan
  | ComponentCandidatePreparationUnavailable

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
  staging: {
    created: boolean
    manifest: StagedArtifactManifest
  }
  state: 'staged'
  reused: boolean
  preparedAt: string
}

export type ComponentCandidatePreparationExecutionResult =
  | ComponentCandidatePreparationReceipt
  | ComponentCandidatePreparationUnavailable

export const componentCandidatePreparationReceiptSchema: z.ZodType<ComponentCandidatePreparationReceipt> =
  z.strictObject({
    format: z.literal('dyson-control-component-preparation-receipt'),
    schemaVersion: z.literal(1),
    requestId: uuidSchema,
    component: supportedComponentSchema,
    acquisitionReceiptId: uuidSchema,
    source: z.strictObject({
      provider: z.literal('github'),
      sourceId: sourceIdSchema,
      version: z.string().trim().min(1).max(64),
      artifactId: artifactIdSchema,
      sizeBytes: byteCountSchema,
      sha256: sha256Schema,
      integrity: z.enum(['provider-verified', 'locally-computed'])
    }),
    prepared: z.strictObject({
      mode: z.enum(['normalized-nebula-windows', 'official-bepinex-windows-x64-direct']),
      artifactId: artifactIdSchema,
      layoutPolicy: layoutPolicySchema,
      sizeBytes: byteCountSchema,
      sha256: sha256Schema,
      integrity: z.enum(['provider-verified', 'locally-computed', 'normalized-locally-computed'])
    }),
    staging: z.strictObject({
      created: z.boolean(),
      manifest: stagedArtifactManifestSchema
    }),
    state: z.literal('staged'),
    reused: z.boolean(),
    preparedAt: isoDateSchema
  }).superRefine((value, context) => {
    const expectedSource = value.component === 'nebula'
      ? 'github:nebulamodteam/nebula'
      : 'github:bepinex/bepinex'
    const expectedKind = value.component
    if (value.source.sourceId.toLowerCase() !== expectedSource ||
        value.staging.manifest.release.kind !== expectedKind ||
        value.staging.manifest.release.sourceId.toLowerCase() !== expectedSource ||
        value.staging.manifest.release.version !== value.source.version ||
        value.staging.manifest.artifactId !== value.prepared.artifactId ||
        value.staging.manifest.sizeBytes !== value.prepared.sizeBytes ||
        value.staging.manifest.sha256 !== value.prepared.sha256) {
      context.addIssue({ code: 'custom', message: 'Preparation receipt identity is inconsistent' })
    }
    if (value.component === 'nebula') {
      if (value.prepared.mode !== 'normalized-nebula-windows' ||
          value.prepared.layoutPolicy !== nebulaWindowsLayoutPolicyIds.v0_9_22 ||
          value.prepared.artifactId !== preparedNebulaArtifactIdFromSource(value.source) ||
          value.prepared.integrity !== 'normalized-locally-computed' ||
          value.staging.manifest.integrity !== 'locally-computed') {
        context.addIssue({ code: 'custom', message: 'Nebula preparation receipt is inconsistent' })
      }
    } else if (value.prepared.mode !== 'official-bepinex-windows-x64-direct' ||
        !Object.values(bepInExWindowsX64LayoutPolicyIds).includes(
          value.prepared.layoutPolicy as BepInExWindowsX64LayoutPolicyId
        ) ||
        value.prepared.artifactId !== value.source.artifactId ||
        value.prepared.sizeBytes !== value.source.sizeBytes ||
        value.prepared.sha256 !== value.source.sha256 ||
        value.prepared.integrity !== value.source.integrity ||
        value.staging.manifest.integrity !== value.source.integrity) {
      context.addIssue({ code: 'custom', message: 'BepInEx preparation receipt is inconsistent' })
    }
    if (value.component === 'bepinex') {
      try {
        if (resolveBepInExWindowsX64LayoutPolicy(value.source.version).id !== value.prepared.layoutPolicy) {
          context.addIssue({ code: 'custom', message: 'BepInEx preparation policy is inconsistent' })
        }
      } catch {
        context.addIssue({ code: 'custom', message: 'BepInEx preparation version is unsupported' })
      }
    }
  })

const optionsSchema = z.strictObject({
  acquisitionInboxRoot: z.string().min(1).max(1_024),
  stateRoot: z.string().min(1).max(1_024),
  stagingRoot: z.string().min(1).max(1_024),
  maximumArchiveBytes: z.number().int().min(1_024).max(maximumSupportedArtifactBytes),
  maximumFileBytes: z.number().int().min(1_024).max(maximumSupportedArtifactBytes),
  maximumExpandedBytes: z.number().int().min(1_024).max(maximumSupportedArtifactBytes),
  maximumFiles: z.number().int().min(1).max(512)
}).superRefine((value, context) => {
  if (value.maximumFileBytes > value.maximumExpandedBytes) {
    context.addIssue({ code: 'custom', message: 'maximumFileBytes exceeds maximumExpandedBytes' })
  }
})

export interface ComponentCandidatePreparationAcquisition {
  getReceipt(requestId: unknown): Promise<ArtifactAcquisitionReceipt | null>
}

export interface ComponentCandidatePreparationOptions {
  acquisition: ComponentCandidatePreparationAcquisition
  acquisitionInboxRoot: string
  stateRoot: string
  stagingRoot: string
  maximumArchiveBytes?: number
  maximumFileBytes?: number
  maximumExpandedBytes?: number
  maximumFiles?: number
  now?: () => Date
}

interface PreparedRoots {
  receipts: string
  locks: string
}

interface VerifiedSource {
  receipt: ArtifactAcquisitionReceipt
  component: SupportedComponentCandidatePreparationComponent
  artifactPath: string
  preparedArtifactId: string
  layoutPolicy: NebulaWindowsLayoutPolicyId | BepInExWindowsX64LayoutPolicyId
}

interface MeasuredArtifact {
  sizeBytes: number
  sha256: string
}

interface AcquiredLock {
  handle: FileHandle
  path: string
}

/**
 * Converts an already-acquired, provider-bound component candidate into the
 * immutable staging format. Callers select only durable UUIDs and a component;
 * every filesystem location and source identity is fixed at construction.
 */
export class ComponentCandidatePreparationService {
  readonly #acquisition: ComponentCandidatePreparationAcquisition
  readonly #acquisitionInboxRoot: string
  readonly #stateRoot: string
  readonly #stagingRoot: string
  readonly #limits: {
    maximumArchiveBytes: number
    maximumFileBytes: number
    maximumExpandedBytes: number
    maximumFiles: number
  }
  readonly #now: () => Date
  readonly #stager: OfflineArtifactStager

  constructor(options: ComponentCandidatePreparationOptions) {
    const parsed = optionsSchema.parse({
      acquisitionInboxRoot: options.acquisitionInboxRoot,
      stateRoot: options.stateRoot,
      stagingRoot: options.stagingRoot,
      maximumArchiveBytes: options.maximumArchiveBytes ?? 512 * 1_024 * 1_024,
      maximumFileBytes: options.maximumFileBytes ?? 64 * 1_024 * 1_024,
      maximumExpandedBytes: options.maximumExpandedBytes ?? 1_024 * 1_024 * 1_024,
      maximumFiles: options.maximumFiles ?? 512
    })
    if (!path.isAbsolute(parsed.acquisitionInboxRoot) ||
        !path.isAbsolute(parsed.stateRoot) || !path.isAbsolute(parsed.stagingRoot)) {
      throw new UpdatePipelineError('CANDIDATE_PREPARATION_ROOT_NOT_ABSOLUTE')
    }
    this.#acquisitionInboxRoot = path.resolve(parsed.acquisitionInboxRoot)
    this.#stateRoot = path.resolve(parsed.stateRoot)
    this.#stagingRoot = path.resolve(parsed.stagingRoot)
    const roots = [this.#acquisitionInboxRoot, this.#stateRoot, this.#stagingRoot]
    for (let left = 0; left < roots.length; left += 1) {
      for (let right = left + 1; right < roots.length; right += 1) {
        if (pathsOverlap(roots[left]!, roots[right]!)) {
          throw new UpdatePipelineError('CANDIDATE_PREPARATION_ROOT_COLLISION')
        }
      }
    }
    this.#acquisition = options.acquisition
    this.#limits = {
      maximumArchiveBytes: parsed.maximumArchiveBytes,
      maximumFileBytes: parsed.maximumFileBytes,
      maximumExpandedBytes: parsed.maximumExpandedBytes,
      maximumFiles: parsed.maximumFiles
    }
    this.#now = options.now ?? (() => new Date())
    this.#stager = new OfflineArtifactStager({
      inboxRoot: this.#acquisitionInboxRoot,
      stagingRoot: this.#stagingRoot,
      maximumBytes: parsed.maximumArchiveBytes,
      now: this.#now
    })
  }

  async preview(input: unknown, signal?: AbortSignal): Promise<ComponentCandidatePreparationPlan> {
    const request = componentCandidatePreparationPreviewRequestSchema.parse(input)
    if (isUnavailableComponent(request.component)) {
      return unavailable(request.component, request.acquisitionReceiptId)
    }
    const source = await this.#loadVerifiedSource(request.component, request.acquisitionReceiptId, signal)
    return createPlan(source)
  }

  async execute(
    input: unknown,
    signal?: AbortSignal
  ): Promise<ComponentCandidatePreparationExecutionResult> {
    const request = componentCandidatePreparationRequestSchema.parse(input)
    if (isUnavailableComponent(request.component)) {
      return unavailable(request.component, request.acquisitionReceiptId)
    }
    assertNotAborted(signal)
    const roots = await this.#prepareRoots()
    const requestLock = await acquireLock(
      managedChild(roots.locks, `request-${request.requestId}.lock`),
      'CANDIDATE_PREPARATION_REQUEST_LOCK_BUSY'
    )
    let artifactLock: AcquiredLock | null = null
    let temporaryArtifact: string | null = null
    try {
      const receiptFile = managedChild(roots.receipts, `${request.requestId}.json`)
      const existing = await readOptionalPreparationReceipt(receiptFile)
      if (existing !== null) {
        if (existing.component !== request.component ||
            existing.acquisitionReceiptId !== request.acquisitionReceiptId) {
          throw new UpdatePipelineError('CANDIDATE_PREPARATION_IDEMPOTENCY_CONFLICT')
        }
        return { ...existing, reused: true }
      }

      let source = await this.#loadVerifiedSource(
        request.component,
        request.acquisitionReceiptId,
        signal
      )
      artifactLock = await acquireLock(
        managedChild(roots.locks, `artifact-${source.preparedArtifactId}.lock`),
        'CANDIDATE_PREPARATION_ARTIFACT_LOCK_BUSY'
      )
      const lockedSource = await this.#loadVerifiedSource(
        request.component,
        request.acquisitionReceiptId,
        signal
      )
      if (sourceFingerprint(source) !== sourceFingerprint(lockedSource)) {
        throw new UpdatePipelineError('CANDIDATE_PREPARATION_ACQUISITION_CHANGED')
      }
      source = lockedSource

      let prepared: ComponentCandidatePreparationReceipt['prepared']
      if (source.component === 'nebula') {
        const normalized = await prepareOfficialNebulaWindowsArchive({
          sourceArchivePath: source.artifactPath,
          version: source.receipt.release.version,
          artifactId: source.preparedArtifactId,
          limits: this.#limits
        })
        temporaryArtifact = managedChild(
          this.#acquisitionInboxRoot,
          `.prepare-${request.requestId}-${randomUUID()}.tmp`
        )
        await publishPreparedArtifact({
          inboxRoot: this.#acquisitionInboxRoot,
          target: managedChild(this.#acquisitionInboxRoot, `${source.preparedArtifactId}.artifact`),
          temporary: temporaryArtifact,
          bytes: normalized.archive,
          expected: { sizeBytes: normalized.sizeBytes, sha256: normalized.sha256 },
          maximumBytes: this.#limits.maximumArchiveBytes,
          signal
        })
        temporaryArtifact = null
        prepared = {
          mode: 'normalized-nebula-windows',
          artifactId: source.preparedArtifactId,
          layoutPolicy: normalized.policy,
          sizeBytes: normalized.sizeBytes,
          sha256: normalized.sha256,
          integrity: 'normalized-locally-computed'
        }
      } else {
        prepared = {
          mode: 'official-bepinex-windows-x64-direct',
          artifactId: source.receipt.artifact.artifactId,
          layoutPolicy: source.layoutPolicy,
          sizeBytes: source.receipt.artifact.sizeBytes,
          sha256: source.receipt.artifact.sha256,
          integrity: source.receipt.artifact.integrity
        }
      }

      const expected = prepared.integrity === 'provider-verified'
        ? { sizeBytes: prepared.sizeBytes, sha256: prepared.sha256 }
        : { sizeBytes: prepared.sizeBytes }
      const staged = await this.#stager.stage({
        artifactId: prepared.artifactId,
        release: {
          kind: source.component,
          sourceId: source.receipt.release.sourceId,
          version: source.receipt.release.version
        },
        expected
      }, signal)
      if (staged.manifest.artifactId !== prepared.artifactId ||
          staged.manifest.sizeBytes !== prepared.sizeBytes ||
          staged.manifest.sha256 !== prepared.sha256 ||
          staged.manifest.release.kind !== source.component ||
          staged.manifest.release.sourceId.toLowerCase() !== source.receipt.release.sourceId.toLowerCase() ||
          staged.manifest.release.version !== source.receipt.release.version ||
          staged.manifest.integrity !== expectedStagedIntegrity(prepared.integrity)) {
        throw new UpdatePipelineError('CANDIDATE_PREPARATION_STAGING_RESULT_INVALID')
      }

      const receipt = componentCandidatePreparationReceiptSchema.parse({
        format: 'dyson-control-component-preparation-receipt',
        schemaVersion: 1,
        requestId: request.requestId,
        component: source.component,
        acquisitionReceiptId: request.acquisitionReceiptId,
        source: publicSource(source.receipt),
        prepared,
        staging: { created: staged.created, manifest: staged.manifest },
        state: 'staged',
        reused: false,
        preparedAt: this.#now().toISOString()
      })
      await atomicWriteJson(receiptFile, receipt)
      return receipt
    } finally {
      if (temporaryArtifact !== null) {
        assertManagedPath(this.#acquisitionInboxRoot, temporaryArtifact)
        await rm(temporaryArtifact, { force: true }).catch(() => undefined)
      }
      if (artifactLock !== null) await releaseLock(artifactLock)
      await releaseLock(requestLock)
    }
  }

  async getReceipt(requestIdInput: unknown): Promise<ComponentCandidatePreparationReceipt | null> {
    const requestId = uuidSchema.parse(requestIdInput)
    const roots = await this.#prepareRoots()
    return await readOptionalPreparationReceipt(managedChild(roots.receipts, `${requestId}.json`))
  }

  async #loadVerifiedSource(
    component: SupportedComponentCandidatePreparationComponent,
    acquisitionReceiptId: string,
    signal?: AbortSignal
  ): Promise<VerifiedSource> {
    let receiptInput: ArtifactAcquisitionReceipt | null
    try {
      receiptInput = await this.#acquisition.getReceipt(acquisitionReceiptId)
    } catch (error) {
      if (error instanceof UpdatePipelineError) throw error
      throw new UpdatePipelineError('CANDIDATE_PREPARATION_ACQUISITION_UNAVAILABLE', { cause: error })
    }
    if (receiptInput === null) {
      throw new UpdatePipelineError('CANDIDATE_PREPARATION_ACQUISITION_RECEIPT_NOT_FOUND')
    }
    let receipt: ArtifactAcquisitionReceipt
    try {
      receipt = artifactAcquisitionReceiptSchema.parse(receiptInput)
    } catch (error) {
      throw new UpdatePipelineError('CANDIDATE_PREPARATION_ACQUISITION_RECEIPT_INVALID', { cause: error })
    }
    if (receipt.requestId !== acquisitionReceiptId) {
      throw new UpdatePipelineError('CANDIDATE_PREPARATION_ACQUISITION_RECEIPT_INVALID')
    }
    assertReceiptIdentity(component, receipt)
    await assertNormalDirectory(this.#acquisitionInboxRoot)
    const artifactPath = managedChild(
      this.#acquisitionInboxRoot,
      `${receipt.artifact.artifactId}.artifact`
    )
    const measured = await measureManagedArtifact(
      this.#acquisitionInboxRoot,
      artifactPath,
      this.#limits.maximumArchiveBytes,
      signal
    )
    if (measured.sizeBytes !== receipt.artifact.sizeBytes || measured.sha256 !== receipt.artifact.sha256) {
      throw new UpdatePipelineError('CANDIDATE_PREPARATION_ACQUIRED_ARTIFACT_CHANGED')
    }
    return {
      receipt,
      component,
      artifactPath,
      preparedArtifactId: component === 'nebula'
        ? preparedNebulaArtifactId(receipt)
        : receipt.artifact.artifactId,
      layoutPolicy: component === 'nebula'
        ? resolveNebulaWindowsLayoutPolicy(receipt.release.version).id
        : resolveBepInExWindowsX64LayoutPolicy(receipt.release.version).id
    }
  }

  async #prepareRoots(): Promise<PreparedRoots> {
    await Promise.all([
      mkdir(this.#acquisitionInboxRoot, { recursive: true }),
      mkdir(this.#stateRoot, { recursive: true })
    ])
    await Promise.all([
      assertNormalDirectory(this.#acquisitionInboxRoot),
      assertNormalDirectory(this.#stateRoot)
    ])
    const receipts = managedChild(this.#stateRoot, 'receipts')
    const locks = managedChild(this.#stateRoot, 'locks')
    await Promise.all([mkdir(receipts, { recursive: true }), mkdir(locks, { recursive: true })])
    await Promise.all([assertNormalDirectory(receipts), assertNormalDirectory(locks)])
    return { receipts, locks }
  }
}

function createPlan(source: VerifiedSource): AvailableComponentCandidatePreparationPlan {
  return {
    format: 'dyson-control-component-preparation-plan',
    schemaVersion: 1,
    available: true,
    dryRun: true,
    component: source.component,
    acquisitionReceiptId: source.receipt.requestId,
    source: publicSource(source.receipt),
    prepared: {
      mode: source.component === 'nebula'
        ? 'normalized-nebula-windows'
        : 'official-bepinex-windows-x64-direct',
      artifactId: source.preparedArtifactId,
      layoutPolicy: source.layoutPolicy
    },
    operations: source.component === 'nebula'
      ? [
          'load-validated-acquisition-receipt',
          'verify-fixed-inbox-artifact',
          'acquire-exclusive-request-and-artifact-locks',
          'validate-official-nebula-windows-layout-and-identity',
          'build-deterministic-server-managed-component-archive',
          'atomically-publish-fixed-inbox-artifact',
          'stage-verified-artifact',
          'persist-preparation-receipt',
          'release-exclusive-locks'
        ]
      : [
          'load-validated-acquisition-receipt',
          'verify-fixed-inbox-artifact',
          'acquire-exclusive-request-and-artifact-locks',
          'validate-reviewed-bepinex-windows-x64-layout',
          'stage-official-artifact-directly',
          'persist-preparation-receipt',
          'release-exclusive-locks'
        ],
    activation: { automatic: false, nextAction: 'component-update-activation-preview' }
  }
}

function unavailable(
  component: 'bridge' | 'control',
  acquisitionReceiptId: string
): ComponentCandidatePreparationUnavailable {
  return {
    format: 'dyson-control-component-preparation-unavailable',
    schemaVersion: 1,
    available: false,
    component,
    acquisitionReceiptId,
    reasonCode: 'CANDIDATE_PREPARATION_COMPONENT_UNAVAILABLE'
  }
}

function isUnavailableComponent(
  component: ComponentCandidatePreparationComponent
): component is 'bridge' | 'control' {
  return unavailableComponentSchema.safeParse(component).success
}

function publicSource(receipt: ArtifactAcquisitionReceipt): AvailableComponentCandidatePreparationPlan['source'] {
  return {
    provider: 'github',
    sourceId: receipt.release.sourceId,
    version: receipt.release.version,
    artifactId: receipt.artifact.artifactId,
    sizeBytes: receipt.artifact.sizeBytes,
    sha256: receipt.artifact.sha256,
    integrity: receipt.artifact.integrity
  }
}

function assertReceiptIdentity(
  component: SupportedComponentCandidatePreparationComponent,
  receipt: ArtifactAcquisitionReceipt
): void {
  const expectedSource = component === 'nebula'
    ? 'github:nebulamodteam/nebula'
    : 'github:bepinex/bepinex'
  if (receipt.provider !== 'github' || receipt.release.kind !== component ||
      receipt.release.sourceId.toLowerCase() !== expectedSource) {
    throw new UpdatePipelineError('CANDIDATE_PREPARATION_COMPONENT_MISMATCH')
  }
}

function preparedNebulaArtifactId(receipt: ArtifactAcquisitionReceipt): string {
  return preparedNebulaArtifactIdFromSource(publicSource(receipt))
}

function preparedNebulaArtifactIdFromSource(
  source: Pick<AvailableComponentCandidatePreparationPlan['source'],
  'sourceId' | 'version' | 'artifactId' | 'sizeBytes' | 'sha256'>
): string {
  const identity = canonicalJson({
    format: 'dyson-control-nebula-prepared-identity',
    schemaVersion: 1,
    sourceId: source.sourceId.toLowerCase(),
    version: source.version,
    artifactId: source.artifactId,
    sizeBytes: source.sizeBytes,
    sha256: source.sha256
  })
  return `prepared-nebula-${createHash('sha256').update(identity).digest('hex').slice(0, 40)}`
}

function expectedStagedIntegrity(
  integrity: ComponentCandidatePreparationReceipt['prepared']['integrity']
): StagedArtifactManifest['integrity'] {
  return integrity === 'provider-verified' ? 'provider-verified' : 'locally-computed'
}

function sourceFingerprint(source: VerifiedSource): string {
  return canonicalJson({
    component: source.component,
    receipt: source.receipt,
    preparedArtifactId: source.preparedArtifactId,
    layoutPolicy: source.layoutPolicy
  })
}

async function publishPreparedArtifact(input: {
  inboxRoot: string
  target: string
  temporary: string
  bytes: Buffer
  expected: MeasuredArtifact
  maximumBytes: number
  signal?: AbortSignal
}): Promise<void> {
  assertNotAborted(input.signal)
  const existing = await lstat(input.target).catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  })
  if (existing !== null) {
    const measured = await measureManagedArtifact(
      input.inboxRoot,
      input.target,
      input.maximumBytes,
      input.signal
    )
    if (measured.sizeBytes !== input.expected.sizeBytes || measured.sha256 !== input.expected.sha256) {
      throw new UpdatePipelineError('CANDIDATE_PREPARATION_INBOX_CONFLICT')
    }
    return
  }
  let handle: FileHandle | null = null
  try {
    handle = await open(input.temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    await handle.writeFile(input.bytes)
    await handle.sync()
    await handle.close()
    handle = null
    assertNotAborted(input.signal)
    await rename(input.temporary, input.target)
    const measured = await measureManagedArtifact(
      input.inboxRoot,
      input.target,
      input.maximumBytes,
      input.signal
    )
    if (measured.sizeBytes !== input.expected.sizeBytes || measured.sha256 !== input.expected.sha256) {
      throw new UpdatePipelineError('CANDIDATE_PREPARATION_INBOX_PUBLISH_FAILED')
    }
  } catch (error) {
    if (error instanceof UpdatePipelineError) throw error
    throw new UpdatePipelineError('CANDIDATE_PREPARATION_INBOX_PUBLISH_FAILED', { cause: error })
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(input.temporary, { force: true }).catch(() => undefined)
  }
}

async function measureManagedArtifact(
  root: string,
  file: string,
  maximumBytes: number,
  signal?: AbortSignal
): Promise<MeasuredArtifact> {
  assertManagedPath(root, file)
  const info = await lstat(file).catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) {
      throw new UpdatePipelineError('CANDIDATE_PREPARATION_ACQUIRED_ARTIFACT_NOT_FOUND', { cause: error })
    }
    throw error
  })
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > maximumBytes) {
    throw new UpdatePipelineError('CANDIDATE_PREPARATION_ACQUIRED_ARTIFACT_INVALID')
  }
  const [rootReal, fileReal] = await Promise.all([realpath(root), realpath(file)])
  if (!isDescendant(rootReal, fileReal)) {
    throw new UpdatePipelineError('CANDIDATE_PREPARATION_ACQUIRED_ARTIFACT_INVALID')
  }
  const handle = await open(file, constants.O_RDONLY)
  const digest = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let sizeBytes = 0
  try {
    while (true) {
      assertNotAborted(signal)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      sizeBytes += bytesRead
      if (sizeBytes > maximumBytes) {
        throw new UpdatePipelineError('CANDIDATE_PREPARATION_ARTIFACT_TOO_LARGE')
      }
      digest.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    await handle.close()
  }
  return { sizeBytes, sha256: digest.digest('hex') }
}

async function readOptionalPreparationReceipt(file: string): Promise<ComponentCandidatePreparationReceipt | null> {
  const raw = await readOptionalJson(file, 256 * 1_024)
  if (raw === null) return null
  try {
    return componentCandidatePreparationReceiptSchema.parse(raw)
  } catch (error) {
    throw new UpdatePipelineError('CANDIDATE_PREPARATION_RECEIPT_INVALID', { cause: error })
  }
}

async function readOptionalJson(file: string, maximumBytes: number): Promise<unknown | null> {
  const info = await lstat(file).catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  })
  if (info === null) return null
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > maximumBytes) {
    throw new UpdatePipelineError('CANDIDATE_PREPARATION_STATE_FILE_INVALID')
  }
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown
  } catch (error) {
    throw new UpdatePipelineError('CANDIDATE_PREPARATION_STATE_FILE_INVALID', { cause: error })
  }
}

async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  const temporary = path.join(path.dirname(file), `.tmp-${path.basename(file)}-${randomUUID()}`)
  let handle: FileHandle | null = null
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    await handle.writeFile(`${canonicalJson(value)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await rename(temporary, file)
  } catch (error) {
    throw new UpdatePipelineError('CANDIDATE_PREPARATION_STATE_WRITE_FAILED', { cause: error })
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function acquireLock(lockPath: string, code: string): Promise<AcquiredLock> {
  try {
    const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    await handle.writeFile(`${process.pid}\n`, 'utf8')
    return { handle, path: lockPath }
  } catch (error) {
    if (isNodeError(error, 'EEXIST')) throw new UpdatePipelineError(code, { cause: error })
    throw new UpdatePipelineError('CANDIDATE_PREPARATION_LOCK_FAILED', { cause: error })
  }
}

async function releaseLock(lock: AcquiredLock): Promise<void> {
  await lock.handle.close().catch(() => undefined)
  await unlink(lock.path).catch(() => undefined)
}

async function assertNormalDirectory(directory: string): Promise<void> {
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new UpdatePipelineError('CANDIDATE_PREPARATION_ROOT_INVALID')
  }
}

function managedChild(root: string, name: string): string {
  const child = path.resolve(root, name)
  assertManagedPath(root, child)
  return child
}

function assertManagedPath(root: string, candidate: string): void {
  if (!isDescendant(path.resolve(root), path.resolve(candidate))) {
    throw new UpdatePipelineError('CANDIDATE_PREPARATION_PATH_ESCAPE')
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = canonicalPath(left)
  const normalizedRight = canonicalPath(right)
  return normalizedLeft === normalizedRight ||
    isDescendant(normalizedLeft, normalizedRight) ||
    isDescendant(normalizedRight, normalizedLeft)
}

function isDescendant(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function canonicalPath(value: string): string {
  const normalized = path.resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonical(value))
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortCanonical(entry)]))
  }
  return value
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new UpdatePipelineError('CANDIDATE_PREPARATION_ABORTED')
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
}

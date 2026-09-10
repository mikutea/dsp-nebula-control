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
  unlink,
  writeFile
} from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { acquireCacheMutex, CacheMutexError, type CacheMutex } from './cache-mutex.js'
import path from 'node:path'
import { z } from 'zod'
import {
  parseThunderstoreDependency,
  thunderstoreDependencyIdSchema
} from '../mods/dependency.js'
import { normalizeVersion, sha256Schema, sourceIdSchema } from '../updates/version.js'
import {
  discoveredModReleaseSchema,
  discoveredNebulaReleaseSchema,
  type DiscoveredModRelease,
  type DiscoveredNebulaRelease
} from './discovery.js'
import {
  discoveredBepInExReleaseSchema,
  type DiscoveredBepInExRelease
} from './bepinex-discovery.js'
import { UpdatePipelineError } from './errors.js'
import type { FetchLike } from './http.js'
import {
  routeThunderstoreDependency,
  thunderstoreNonPluginAcquisitionErrorCode
} from './thunderstore-dependency-routing.js'

const candidateIdSchema = z.string().regex(/^candidate-[0-9a-f]{48}$/)
const artifactIdSchema = z.string().min(16).max(96).regex(/^[a-z0-9][a-z0-9-]+$/)
const safeFileNameSchema = z.string().min(5).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/i)
const isoDateSchema = z.string().datetime({ offset: true })
const uuidSchema = z.string().uuid()
const maximumSupportedArtifactBytes = 2 * 1_024 * 1_024 * 1_024
const byteCountSchema = z.number().int().positive().max(maximumSupportedArtifactBytes)

type AcquisitionProvider = 'github' | 'thunderstore'
type AcquiredReleaseKind = 'nebula' | 'bepinex' | 'plugin'

interface StoredArtifactCandidate {
  format: 'dyson-control-artifact-candidate'
  schemaVersion: 1
  candidateId: string
  provider: AcquisitionProvider
  release: {
    kind: AcquiredReleaseKind
    sourceId: string
    version: string
    dependencies?: string[]
    dependencyFingerprint?: string
  }
  artifact: {
    artifactId: string
    downloadUrl: string
    fileName: string
    sizeBytes: number | null
    sha256: string | null
    integrity: 'provider-sha256' | 'locally-computed-required'
  }
  registeredAt: string
  expiresAt: string
}

export interface ArtifactCandidateDescriptor {
  candidateId: string
  provider: AcquisitionProvider
  release: StoredArtifactCandidate['release']
  artifact: Omit<StoredArtifactCandidate['artifact'], 'downloadUrl'>
  expiresAt: string
}

export interface ArtifactAcquisitionPlan {
  format: 'dyson-control-artifact-acquisition-plan'
  schemaVersion: 1
  dryRun: true
  candidate: ArtifactCandidateDescriptor
  operations: Array<
    | 'load-server-registered-candidate'
    | 'acquire-exclusive-request-and-artifact-locks'
    | 'download-from-bound-provider'
    | 'stream-size-and-sha256-verification'
    | 'atomically-publish-fixed-inbox-artifact'
    | 'persist-acquisition-receipt'
    | 'release-exclusive-locks'
  >
  staging: { automatic: false; nextAction: 'offline-artifact-staging' }
}

export interface ArtifactAcquisitionReceipt {
  format: 'dyson-control-artifact-acquisition-receipt'
  schemaVersion: 1
  requestId: string
  candidateId: string
  provider: AcquisitionProvider
  release: StoredArtifactCandidate['release']
  artifact: {
    artifactId: string
    fileName: string
    sizeBytes: number
    sha256: string
    integrity: 'provider-verified' | 'locally-computed'
  }
  state: 'acquired'
  reused: boolean
  acquiredAt: string
}

export const artifactAcquisitionRequestSchema = z.strictObject({
  requestId: uuidSchema,
  candidateId: candidateIdSchema,
  confirmation: z.literal('ACQUIRE_UPDATE_ARTIFACT')
})

const storedCandidateSchema: z.ZodType<StoredArtifactCandidate> = z.strictObject({
  format: z.literal('dyson-control-artifact-candidate'),
  schemaVersion: z.literal(1),
  candidateId: candidateIdSchema,
  provider: z.enum(['github', 'thunderstore']),
  release: z.strictObject({
    kind: z.enum(['nebula', 'bepinex', 'plugin']),
    sourceId: sourceIdSchema,
    version: z.string().trim().min(1).max(64),
    dependencies: z.array(thunderstoreDependencyIdSchema).max(64).optional(),
    dependencyFingerprint: sha256Schema.optional()
  }),
  artifact: z.strictObject({
    artifactId: artifactIdSchema,
    downloadUrl: z.url().max(2_048),
    fileName: safeFileNameSchema,
    sizeBytes: byteCountSchema.nullable(),
    sha256: sha256Schema.nullable(),
    integrity: z.enum(['provider-sha256', 'locally-computed-required'])
  }),
  registeredAt: isoDateSchema,
  expiresAt: isoDateSchema
}).superRefine((value, context) => {
  const githubIdentityValid =
    (value.release.kind === 'nebula' &&
      value.release.sourceId.toLowerCase() === 'github:nebulamodteam/nebula') ||
    (value.release.kind === 'bepinex' &&
      value.release.sourceId.toLowerCase() === 'github:bepinex/bepinex')
  if (value.provider === 'github' && !githubIdentityValid) {
    context.addIssue({ code: 'custom', message: 'GitHub acquisition candidate identity is invalid' })
  }
  if (value.provider === 'thunderstore' && (value.release.kind !== 'plugin' ||
      !value.release.sourceId.toLowerCase().startsWith('thunderstore:'))) {
    context.addIssue({ code: 'custom', message: 'Thunderstore acquisition candidate identity is invalid' })
  }
  validateReleaseDependencyBinding(value.release, context)
  if (value.artifact.integrity === 'provider-sha256' &&
      (value.artifact.sizeBytes === null || value.artifact.sha256 === null)) {
    context.addIssue({ code: 'custom', message: 'Provider integrity metadata is incomplete' })
  }
  try {
    if (normalizeVersion(value.release.version, value.release.kind) !== value.release.version) {
      context.addIssue({ code: 'custom', message: 'Candidate version is not normalized' })
    }
    assertProviderUrl(new URL(value.artifact.downloadUrl), value.provider)
  } catch {
    context.addIssue({ code: 'custom', message: 'Candidate download boundary is invalid' })
  }
  const expectedId = candidateIdFor(candidateIdentity(value))
  if (expectedId !== value.candidateId) {
    context.addIssue({ code: 'custom', message: 'Candidate identifier does not match its immutable identity' })
  }
  if (Date.parse(value.expiresAt) <= Date.parse(value.registeredAt)) {
    context.addIssue({ code: 'custom', message: 'Candidate expiry is invalid' })
  }
})

export const artifactAcquisitionReceiptSchema: z.ZodType<ArtifactAcquisitionReceipt> = z.strictObject({
  format: z.literal('dyson-control-artifact-acquisition-receipt'),
  schemaVersion: z.literal(1),
  requestId: uuidSchema,
  candidateId: candidateIdSchema,
  provider: z.enum(['github', 'thunderstore']),
  release: z.strictObject({
    kind: z.enum(['nebula', 'bepinex', 'plugin']),
    sourceId: sourceIdSchema,
    version: z.string().trim().min(1).max(64),
    dependencies: z.array(thunderstoreDependencyIdSchema).max(64).optional(),
    dependencyFingerprint: sha256Schema.optional()
  }),
  artifact: z.strictObject({
    artifactId: artifactIdSchema,
    fileName: safeFileNameSchema,
    sizeBytes: byteCountSchema,
    sha256: sha256Schema,
    integrity: z.enum(['provider-verified', 'locally-computed'])
  }),
  state: z.literal('acquired'),
  reused: z.boolean(),
  acquiredAt: isoDateSchema
}).superRefine((value, context) => {
  const sourceId = value.release.sourceId.toLowerCase()
  const githubIdentityValid =
    (value.release.kind === 'nebula' && sourceId === 'github:nebulamodteam/nebula') ||
    (value.release.kind === 'bepinex' && sourceId === 'github:bepinex/bepinex')
  if ((value.provider === 'github' && !githubIdentityValid) ||
      (value.provider === 'thunderstore' &&
        (value.release.kind !== 'plugin' || !sourceId.startsWith('thunderstore:')))) {
    context.addIssue({ code: 'custom', message: 'Acquisition receipt source identity is invalid' })
  }
  validateReleaseDependencyBinding(value.release, context)
  try {
    if (normalizeVersion(value.release.version, value.release.kind) !== value.release.version) {
      context.addIssue({ code: 'custom', message: 'Acquisition receipt version is not normalized' })
    }
  } catch {
    context.addIssue({ code: 'custom', message: 'Acquisition receipt version is invalid' })
  }
})

const optionsSchema = z.strictObject({
  inboxRoot: z.string().min(1).max(1_024),
  stateRoot: z.string().min(1).max(1_024),
  maximumBytes: z.number().int().min(1_024).max(maximumSupportedArtifactBytes),
  timeoutMs: z.number().int().min(1_000).max(120_000),
  candidateTtlMs: z.number().int().min(60_000).max(7 * 24 * 60 * 60 * 1_000),
  maximumRedirects: z.number().int().min(0).max(5)
})

export interface ManagedArtifactAcquisitionOptions {
  inboxRoot: string
  stateRoot: string
  fetch: FetchLike
  maximumBytes?: number
  timeoutMs?: number
  candidateTtlMs?: number
  maximumRedirects?: number
  now?: () => Date
}

export class ManagedArtifactAcquisitionService {
  readonly #inboxRoot: string
  readonly #stateRoot: string
  readonly #fetch: FetchLike
  readonly #maximumBytes: number
  readonly #timeoutMs: number
  readonly #candidateTtlMs: number
  readonly #maximumRedirects: number
  readonly #now: () => Date

  constructor(options: ManagedArtifactAcquisitionOptions) {
    const parsed = optionsSchema.parse({
      inboxRoot: options.inboxRoot,
      stateRoot: options.stateRoot,
      maximumBytes: options.maximumBytes ?? 512 * 1_024 * 1_024,
      timeoutMs: options.timeoutMs ?? 60_000,
      candidateTtlMs: options.candidateTtlMs ?? 24 * 60 * 60 * 1_000,
      maximumRedirects: options.maximumRedirects ?? 3
    })
    if (!path.isAbsolute(parsed.inboxRoot) || !path.isAbsolute(parsed.stateRoot)) {
      throw new UpdatePipelineError('ACQUISITION_ROOT_NOT_ABSOLUTE')
    }
    this.#inboxRoot = path.resolve(parsed.inboxRoot)
    this.#stateRoot = path.resolve(parsed.stateRoot)
    if (canonicalPath(this.#inboxRoot) === canonicalPath(this.#stateRoot) ||
        isDescendant(this.#inboxRoot, this.#stateRoot) ||
        isDescendant(this.#stateRoot, this.#inboxRoot)) {
      throw new UpdatePipelineError('ACQUISITION_ROOT_COLLISION')
    }
    this.#fetch = options.fetch
    this.#maximumBytes = parsed.maximumBytes
    this.#timeoutMs = parsed.timeoutMs
    this.#candidateTtlMs = parsed.candidateTtlMs
    this.#maximumRedirects = parsed.maximumRedirects
    this.#now = options.now ?? (() => new Date())
  }

  async registerNebulaRelease(input: unknown): Promise<ArtifactCandidateDescriptor> {
    const release = discoveredNebulaReleaseSchema.parse(input)
    return this.#register(candidateFromNebula(release))
  }

  async registerBepInExRelease(input: unknown): Promise<ArtifactCandidateDescriptor> {
    const release = discoveredBepInExReleaseSchema.parse(input)
    return this.#register(candidateFromBepInEx(release))
  }

  async registerModRelease(input: unknown): Promise<ArtifactCandidateDescriptor> {
    const release = discoveredModReleaseSchema.parse(input)
    if (!release.eligible) throw new UpdatePipelineError('ACQUISITION_CANDIDATE_INELIGIBLE')
    const route = routeThunderstoreDependency(release)
    if (!route.directPluginAcquisitionAllowed) {
      throw new UpdatePipelineError(thunderstoreNonPluginAcquisitionErrorCode(route))
    }
    return this.#register(candidateFromMod(release))
  }

  async preview(candidateIdInput: unknown): Promise<ArtifactAcquisitionPlan> {
    const candidate = await this.#loadCandidate(candidateIdSchema.parse(candidateIdInput))
    return acquisitionPlan(candidate)
  }

  async acquire(input: unknown, signal?: AbortSignal): Promise<ArtifactAcquisitionReceipt> {
    const request = artifactAcquisitionRequestSchema.parse(input)
    const roots = await this.#prepareRoots()
    const requestLock = await acquireLock(
      managedChild(roots.locks, `request-${request.requestId}.lock`),
      'ACQUISITION_REQUEST_LOCK_BUSY'
    )
    let artifactLock: AcquiredLock | null = null
    let temporary: string | null = null
    try {
      const existingReceipt = await readOptionalReceipt(
        managedChild(roots.receipts, `${request.requestId}.json`)
      )
      if (existingReceipt !== null) {
        if (existingReceipt.candidateId !== request.candidateId) {
          throw new UpdatePipelineError('ACQUISITION_IDEMPOTENCY_CONFLICT')
        }
        return existingReceipt
      }

      const candidate = await this.#loadCandidate(request.candidateId, roots)
      artifactLock = await acquireLock(
        managedChild(roots.locks, `artifact-${candidate.artifact.artifactId}.lock`),
        'ACQUISITION_ARTIFACT_LOCK_BUSY'
      )
      const target = managedChild(this.#inboxRoot, `${candidate.artifact.artifactId}.artifact`)
      const existing = await inspectExistingArtifact(target, candidate, this.#maximumBytes, signal)
      let measured: MeasuredArtifact
      let reused: boolean
      if (existing !== null) {
        measured = existing
        reused = true
      } else {
        temporary = managedChild(this.#inboxRoot, `.acquire-${request.requestId}-${randomUUID()}.tmp`)
        measured = await this.#download(candidate, temporary, signal)
        await rename(temporary, target).catch((error: unknown) => {
          throw new UpdatePipelineError('ACQUISITION_INBOX_PUBLISH_FAILED', { cause: error })
        })
        temporary = null
        await assertRegularFileInside(this.#inboxRoot, target)
        reused = false
      }

      const receipt = artifactAcquisitionReceiptSchema.parse({
        format: 'dyson-control-artifact-acquisition-receipt',
        schemaVersion: 1,
        requestId: request.requestId,
        candidateId: request.candidateId,
        provider: candidate.provider,
        release: candidate.release,
        artifact: {
          artifactId: candidate.artifact.artifactId,
          fileName: candidate.artifact.fileName,
          sizeBytes: measured.sizeBytes,
          sha256: measured.sha256,
          integrity: candidate.artifact.sha256 === null ? 'locally-computed' : 'provider-verified'
        },
        state: 'acquired',
        reused,
        acquiredAt: this.#now().toISOString()
      })
      await atomicWriteJson(managedChild(roots.receipts, `${request.requestId}.json`), receipt)
      return receipt
    } finally {
      if (temporary !== null) {
        assertManagedPath(this.#inboxRoot, temporary)
        await rm(temporary, { force: true }).catch(() => undefined)
      }
      if (artifactLock !== null) await releaseLock(artifactLock)
      await releaseLock(requestLock)
    }
  }

  async getReceipt(requestIdInput: unknown): Promise<ArtifactAcquisitionReceipt | null> {
    const requestId = uuidSchema.parse(requestIdInput)
    const roots = await this.#prepareRoots()
    return readOptionalReceipt(managedChild(roots.receipts, `${requestId}.json`))
  }

  async #register(candidateInput: Omit<StoredArtifactCandidate, 'registeredAt' | 'expiresAt'>): Promise<ArtifactCandidateDescriptor> {
    const roots = await this.#prepareRoots()
    const lock = await acquireLock(
      managedChild(roots.locks, `candidate-${candidateInput.candidateId}.lock`),
      'ACQUISITION_CANDIDATE_LOCK_BUSY'
    )
    try {
      const destination = managedChild(roots.candidates, `${candidateInput.candidateId}.json`)
      const existing = await readOptionalCandidate(destination)
      if (existing !== null) {
        if (canonicalJson(candidateIdentity(existing)) !== canonicalJson(candidateIdentity(candidateInput))) {
          throw new UpdatePipelineError('ACQUISITION_CANDIDATE_CONFLICT')
        }
        if (Date.parse(existing.expiresAt) <= this.#now().getTime()) {
          throw new UpdatePipelineError('ACQUISITION_CANDIDATE_EXPIRED')
        }
        return descriptor(existing)
      }
      const registeredAt = this.#now()
      const candidate = storedCandidateSchema.parse({
        ...candidateInput,
        registeredAt: registeredAt.toISOString(),
        expiresAt: new Date(registeredAt.getTime() + this.#candidateTtlMs).toISOString()
      })
      await atomicWriteJson(destination, candidate)
      return descriptor(candidate)
    } finally {
      await releaseLock(lock)
    }
  }

  async #loadCandidate(candidateId: string, prepared?: PreparedRoots): Promise<StoredArtifactCandidate> {
    const roots = prepared ?? await this.#prepareRoots()
    const candidate = await readOptionalCandidate(managedChild(roots.candidates, `${candidateId}.json`))
    if (candidate === null) throw new UpdatePipelineError('ACQUISITION_CANDIDATE_NOT_FOUND')
    if (candidate.candidateId !== candidateId) throw new UpdatePipelineError('ACQUISITION_CANDIDATE_INVALID')
    if (Date.parse(candidate.expiresAt) <= this.#now().getTime()) {
      throw new UpdatePipelineError('ACQUISITION_CANDIDATE_EXPIRED')
    }
    return candidate
  }

  async #download(
    candidate: StoredArtifactCandidate,
    temporary: string,
    callerSignal?: AbortSignal
  ): Promise<MeasuredArtifact> {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort('timeout')
    }, this.#timeoutMs)
    const abortFromCaller = (): void => controller.abort(callerSignal?.reason ?? 'caller-aborted')
    if (callerSignal?.aborted === true) abortFromCaller()
    else callerSignal?.addEventListener('abort', abortFromCaller, { once: true })
    let handle: FileHandle | null = null
    try {
      const response = await fetchBoundProviderArtifact(
        this.#fetch,
        new URL(candidate.artifact.downloadUrl),
        candidate.provider,
        this.#maximumRedirects,
        controller.signal
      )
      const declaredLength = parseContentLength(response.headers.get('content-length'))
      if (declaredLength !== null && declaredLength > this.#maximumBytes) {
        throw new UpdatePipelineError('ACQUISITION_ARTIFACT_TOO_LARGE')
      }
      if (candidate.artifact.sizeBytes !== null && declaredLength !== null &&
          candidate.artifact.sizeBytes !== declaredLength) {
        throw new UpdatePipelineError('ACQUISITION_SIZE_MISMATCH')
      }
      if (response.body === null) throw new UpdatePipelineError('ACQUISITION_RESPONSE_BODY_MISSING')
      handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      const measured = await streamResponseToFile(response, handle, this.#maximumBytes, controller.signal)
      await handle.sync()
      await handle.close()
      handle = null
      if (candidate.artifact.sizeBytes !== null && candidate.artifact.sizeBytes !== measured.sizeBytes) {
        throw new UpdatePipelineError('ACQUISITION_SIZE_MISMATCH')
      }
      if (candidate.artifact.sha256 !== null && candidate.artifact.sha256 !== measured.sha256) {
        throw new UpdatePipelineError('ACQUISITION_SHA256_MISMATCH')
      }
      await assertZipSignature(temporary)
      return measured
    } catch (error) {
      if (error instanceof UpdatePipelineError) throw error
      if (controller.signal.aborted) {
        throw new UpdatePipelineError(
          timedOut ? 'ACQUISITION_REQUEST_TIMEOUT' : 'ACQUISITION_REQUEST_ABORTED',
          { cause: error }
        )
      }
      throw new UpdatePipelineError('ACQUISITION_REQUEST_FAILED', { cause: error })
    } finally {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', abortFromCaller)
      await handle?.close().catch(() => undefined)
    }
  }

  async #prepareRoots(): Promise<PreparedRoots> {
    await Promise.all([mkdir(this.#inboxRoot, { recursive: true }), mkdir(this.#stateRoot, { recursive: true })])
    await Promise.all([assertNormalDirectory(this.#inboxRoot), assertNormalDirectory(this.#stateRoot)])
    const candidates = managedChild(this.#stateRoot, 'candidates')
    const receipts = managedChild(this.#stateRoot, 'receipts')
    const locks = managedChild(this.#stateRoot, 'locks')
    await Promise.all([
      mkdir(candidates, { recursive: true }),
      mkdir(receipts, { recursive: true }),
      mkdir(locks, { recursive: true })
    ])
    await Promise.all([
      assertNormalDirectory(candidates),
      assertNormalDirectory(receipts),
      assertNormalDirectory(locks)
    ])
    return { candidates, receipts, locks }
  }
}

interface PreparedRoots { candidates: string; receipts: string; locks: string }
interface MeasuredArtifact { sizeBytes: number; sha256: string }

function candidateFromNebula(releaseInput: DiscoveredNebulaRelease): Omit<StoredArtifactCandidate, 'registeredAt' | 'expiresAt'> {
  const release = discoveredNebulaReleaseSchema.parse(releaseInput)
  const identity = {
    provider: 'github' as const,
    release: { kind: 'nebula' as const, sourceId: release.sourceId, version: release.version },
    artifact: release.artifact
  }
  return {
    format: 'dyson-control-artifact-candidate',
    schemaVersion: 1,
    candidateId: candidateIdFor(identity),
    ...identity
  }
}

function candidateFromBepInEx(
  releaseInput: DiscoveredBepInExRelease
): Omit<StoredArtifactCandidate, 'registeredAt' | 'expiresAt'> {
  const release = discoveredBepInExReleaseSchema.parse(releaseInput)
  const identity = {
    provider: 'github' as const,
    release: { kind: 'bepinex' as const, sourceId: release.sourceId, version: release.version },
    artifact: release.artifact
  }
  return {
    format: 'dyson-control-artifact-candidate',
    schemaVersion: 1,
    candidateId: candidateIdFor(identity),
    ...identity
  }
}

function candidateFromMod(releaseInput: DiscoveredModRelease): Omit<StoredArtifactCandidate, 'registeredAt' | 'expiresAt'> {
  const release = discoveredModReleaseSchema.parse(releaseInput)
  const dependencies = normalizeExactThunderstoreDependencies(release.dependencies)
  const identity = {
    provider: 'thunderstore' as const,
    release: {
      kind: 'plugin' as const,
      sourceId: release.sourceId,
      version: release.version,
      dependencies,
      dependencyFingerprint: thunderstoreDependencyFingerprint(dependencies)
    },
    artifact: release.artifact
  }
  return {
    format: 'dyson-control-artifact-candidate',
    schemaVersion: 1,
    candidateId: candidateIdFor(identity),
    ...identity
  }
}

function candidateIdentity(candidate: Pick<StoredArtifactCandidate, 'provider' | 'release' | 'artifact'>): {
  provider: AcquisitionProvider
  release: StoredArtifactCandidate['release']
  artifact: StoredArtifactCandidate['artifact']
} {
  return { provider: candidate.provider, release: candidate.release, artifact: candidate.artifact }
}

function candidateIdFor(identity: unknown): string {
  return `candidate-${createHash('sha256').update(canonicalJson(identity)).digest('hex').slice(0, 48)}`
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Canonical digest of the exact Thunderstore dependency declarations bound at
 * discovery time. It is part of the candidate identity and survives in the
 * durable acquisition receipt so import cannot silently substitute a new
 * dependency graph from the downloaded archive.
 */
export function thunderstoreDependencyFingerprint(dependenciesInput: unknown): string {
  const dependencies = normalizeExactThunderstoreDependencies(dependenciesInput)
  return createHash('sha256').update(canonicalJson(dependencies), 'utf8').digest('hex')
}

function normalizeExactThunderstoreDependencies(dependenciesInput: unknown): string[] {
  const parsed = z.array(thunderstoreDependencyIdSchema).max(64).parse(dependenciesInput)
    .map((dependencyId) => parseThunderstoreDependency(dependencyId).dependencyId)
    .sort(compareText)
  if (new Set(parsed.map((dependencyId) => dependencyId.toLowerCase())).size !== parsed.length) {
    throw new UpdatePipelineError('THUNDERSTORE_DEPENDENCY_DUPLICATE')
  }
  return parsed
}

function validateReleaseDependencyBinding(
  release: StoredArtifactCandidate['release'],
  context: z.RefinementCtx
): void {
  if (release.kind !== 'plugin') {
    if (release.dependencies !== undefined || release.dependencyFingerprint !== undefined) {
      context.addIssue({ code: 'custom', message: 'Non-plugin acquisition release has a dependency binding' })
    }
    return
  }
  if (release.dependencies === undefined || release.dependencyFingerprint === undefined) {
    context.addIssue({ code: 'custom', message: 'Plugin acquisition release dependency binding is missing' })
    return
  }
  try {
    const normalized = normalizeExactThunderstoreDependencies(release.dependencies)
    if (canonicalJson(normalized) !== canonicalJson(release.dependencies) ||
        thunderstoreDependencyFingerprint(normalized) !== release.dependencyFingerprint) {
      context.addIssue({ code: 'custom', message: 'Plugin acquisition dependency binding is invalid' })
    }
  } catch {
    context.addIssue({ code: 'custom', message: 'Plugin acquisition dependency binding is invalid' })
  }
}

function descriptor(candidate: StoredArtifactCandidate): ArtifactCandidateDescriptor {
  return {
    candidateId: candidate.candidateId,
    provider: candidate.provider,
    release: candidate.release,
    artifact: {
      artifactId: candidate.artifact.artifactId,
      fileName: candidate.artifact.fileName,
      sizeBytes: candidate.artifact.sizeBytes,
      sha256: candidate.artifact.sha256,
      integrity: candidate.artifact.integrity
    },
    expiresAt: candidate.expiresAt
  }
}

function acquisitionPlan(candidate: StoredArtifactCandidate): ArtifactAcquisitionPlan {
  return {
    format: 'dyson-control-artifact-acquisition-plan',
    schemaVersion: 1,
    dryRun: true,
    candidate: descriptor(candidate),
    operations: [
      'load-server-registered-candidate',
      'acquire-exclusive-request-and-artifact-locks',
      'download-from-bound-provider',
      'stream-size-and-sha256-verification',
      'atomically-publish-fixed-inbox-artifact',
      'persist-acquisition-receipt',
      'release-exclusive-locks'
    ],
    staging: { automatic: false, nextAction: 'offline-artifact-staging' }
  }
}

async function fetchBoundProviderArtifact(
  fetchImpl: FetchLike,
  initialUrl: URL,
  provider: AcquisitionProvider,
  maximumRedirects: number,
  signal: AbortSignal
): Promise<Response> {
  let url = initialUrl
  for (let redirectCount = 0; redirectCount <= maximumRedirects; redirectCount++) {
    assertProviderUrl(url, provider)
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: {
          accept: 'application/zip, application/octet-stream;q=0.9',
          'user-agent': 'dyson-control-artifact-acquisition/0.1'
        }
      })
    } catch (error) {
      if (signal.aborted) throw error
      throw new UpdatePipelineError('ACQUISITION_REQUEST_FAILED', { cause: error })
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirectCount === maximumRedirects) throw new UpdatePipelineError('ACQUISITION_REDIRECT_LIMIT')
      const location = response.headers.get('location')
      if (location === null) throw new UpdatePipelineError('ACQUISITION_REDIRECT_INVALID')
      let next: URL
      try { next = new URL(location, url) } catch (error) {
        throw new UpdatePipelineError('ACQUISITION_REDIRECT_INVALID', { cause: error })
      }
      assertProviderUrl(next, provider)
      url = next
      continue
    }
    if (!response.ok || response.status !== 200) {
      throw new UpdatePipelineError('ACQUISITION_HTTP_STATUS_INVALID')
    }
    if (response.url !== '') assertProviderUrl(new URL(response.url), provider)
    return response
  }
  throw new UpdatePipelineError('ACQUISITION_REDIRECT_LIMIT')
}

function assertProviderUrl(url: URL, provider: AcquisitionProvider): void {
  const host = url.hostname.toLowerCase()
  const githubHosts = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'])
  const thunderstoreHosts = new Set(['thunderstore.io', 'gcdn.thunderstore.io'])
  const allowed = provider === 'github' ? githubHosts : thunderstoreHosts
  if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443') ||
      url.username !== '' || url.password !== '' || url.hash !== '' || !allowed.has(host)) {
    throw new UpdatePipelineError('ACQUISITION_URL_NOT_ALLOWED')
  }
}

async function streamResponseToFile(
  response: Response,
  handle: FileHandle,
  maximumBytes: number,
  signal: AbortSignal
): Promise<MeasuredArtifact> {
  if (response.body === null) throw new UpdatePipelineError('ACQUISITION_RESPONSE_BODY_MISSING')
  const reader = response.body.getReader()
  const hash = createHash('sha256')
  let sizeBytes = 0
  try {
    while (true) {
      if (signal.aborted) throw new UpdatePipelineError('ACQUISITION_REQUEST_ABORTED')
      const { done, value } = await reader.read()
      if (done) break
      sizeBytes += value.byteLength
      if (sizeBytes > maximumBytes) throw new UpdatePipelineError('ACQUISITION_ARTIFACT_TOO_LARGE')
      hash.update(value)
      await handle.write(value)
    }
  } finally {
    reader.releaseLock()
  }
  if (sizeBytes <= 0) throw new UpdatePipelineError('ACQUISITION_ARTIFACT_EMPTY')
  return { sizeBytes, sha256: hash.digest('hex') }
}

async function inspectExistingArtifact(
  target: string,
  candidate: StoredArtifactCandidate,
  maximumBytes: number,
  signal?: AbortSignal
): Promise<MeasuredArtifact | null> {
  const info = await lstat(target).catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  })
  if (info === null) return null
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > maximumBytes) {
    throw new UpdatePipelineError('ACQUISITION_INBOX_CONFLICT')
  }
  if (candidate.artifact.sizeBytes !== null && info.size !== candidate.artifact.sizeBytes) {
    throw new UpdatePipelineError('ACQUISITION_INBOX_CONFLICT')
  }
  const measured = await measureFile(target, maximumBytes, signal)
  if (candidate.artifact.sha256 !== null && measured.sha256 !== candidate.artifact.sha256) {
    throw new UpdatePipelineError('ACQUISITION_INBOX_CONFLICT')
  }
  await assertZipSignature(target)
  return measured
}

async function measureFile(file: string, maximumBytes: number, signal?: AbortSignal): Promise<MeasuredArtifact> {
  const handle = await open(file, constants.O_RDONLY)
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let sizeBytes = 0
  try {
    while (true) {
      if (signal?.aborted === true) throw new UpdatePipelineError('ACQUISITION_REQUEST_ABORTED')
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      sizeBytes += bytesRead
      if (sizeBytes > maximumBytes) throw new UpdatePipelineError('ACQUISITION_ARTIFACT_TOO_LARGE')
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    await handle.close()
  }
  return { sizeBytes, sha256: hash.digest('hex') }
}

async function assertZipSignature(file: string): Promise<void> {
  const handle = await open(file, constants.O_RDONLY)
  const signature = Buffer.alloc(4)
  try {
    const { bytesRead } = await handle.read(signature, 0, 4, 0)
    if (bytesRead !== 4 || ![0x04034b50, 0x06054b50, 0x08074b50].includes(signature.readUInt32LE(0))) {
      throw new UpdatePipelineError('ACQUISITION_ARCHIVE_SIGNATURE_INVALID')
    }
  } finally {
    await handle.close()
  }
}

function parseContentLength(value: string | null): number | null {
  if (value === null) return null
  if (!/^\d+$/.test(value)) throw new UpdatePipelineError('ACQUISITION_CONTENT_LENGTH_INVALID')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new UpdatePipelineError('ACQUISITION_CONTENT_LENGTH_INVALID')
  }
  return parsed
}

type AcquiredLock = CacheMutex

async function acquireLock(lockPath: string, code: string): Promise<AcquiredLock> {
  try {
    return await acquireCacheMutex(lockPath)
  } catch (error) {
    if (error instanceof CacheMutexError && error.code === 'CACHE_MUTEX_BUSY') throw new UpdatePipelineError(code, { cause: error })
    throw new UpdatePipelineError('ACQUISITION_LOCK_FAILED', { cause: error })
  }
}

async function releaseLock(lock: AcquiredLock): Promise<void> {
  try { await lock.release() } catch (error) { throw new UpdatePipelineError('ACQUISITION_LOCK_FAILED', { cause: error }) }
}

async function readOptionalCandidate(file: string): Promise<StoredArtifactCandidate | null> {
  const raw = await readOptionalJson(file, 64 * 1_024)
  if (raw === null) return null
  try { return storedCandidateSchema.parse(raw) } catch (error) {
    throw new UpdatePipelineError('ACQUISITION_CANDIDATE_INVALID', { cause: error })
  }
}

async function readOptionalReceipt(file: string): Promise<ArtifactAcquisitionReceipt | null> {
  const raw = await readOptionalJson(file, 64 * 1_024)
  if (raw === null) return null
  try { return artifactAcquisitionReceiptSchema.parse(raw) } catch (error) {
    throw new UpdatePipelineError('ACQUISITION_RECEIPT_INVALID', { cause: error })
  }
}

async function readOptionalJson(file: string, maximumBytes: number): Promise<unknown | null> {
  const info = await lstat(file).catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  })
  if (info === null) return null
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > maximumBytes) {
    throw new UpdatePipelineError('ACQUISITION_STATE_FILE_INVALID')
  }
  try { return JSON.parse(await readFile(file, 'utf8')) as unknown } catch (error) {
    throw new UpdatePipelineError('ACQUISITION_STATE_FILE_INVALID', { cause: error })
  }
}

async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  const temporary = path.join(path.dirname(file), `.tmp-${path.basename(file)}-${randomUUID()}`)
  try {
    await writeFile(temporary, `${canonicalJson(value)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(temporary, file)
  } catch (error) {
    throw new UpdatePipelineError('ACQUISITION_STATE_WRITE_FAILED', { cause: error })
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function assertNormalDirectory(directory: string): Promise<void> {
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new UpdatePipelineError('ACQUISITION_ROOT_INVALID')
}

async function assertRegularFileInside(root: string, file: string): Promise<void> {
  assertManagedPath(root, file)
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink()) throw new UpdatePipelineError('ACQUISITION_INBOX_PUBLISH_FAILED')
  const [rootReal, fileReal] = await Promise.all([realpath(root), realpath(file)])
  if (!isDescendant(rootReal, fileReal)) throw new UpdatePipelineError('ACQUISITION_INBOX_PUBLISH_FAILED')
}

function managedChild(root: string, name: string): string {
  const child = path.resolve(root, name)
  assertManagedPath(root, child)
  return child
}

function assertManagedPath(root: string, candidate: string): void {
  if (!isDescendant(path.resolve(root), path.resolve(candidate))) {
    throw new UpdatePipelineError('ACQUISITION_PATH_ESCAPE')
  }
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

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
}

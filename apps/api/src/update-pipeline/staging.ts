import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { constants } from 'node:fs'
import { mkdir, lstat, open, readFile, realpath, rename, rm, unlink, writeFile, copyFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { normalizeVersion, sha256Schema, sourceIdSchema, type VersionComponent } from '../updates/version.js'
import { UpdatePipelineError } from './errors.js'
import {
  componentReleaseManifestSchema,
  inspectComponentArchive,
  type ComponentReleaseManifest
} from './activation-archive.js'
import { assertBepInExWindowsX64ManifestLayout } from './bepinex-layout.js'

export type StageableKind = Exclude<VersionComponent, 'dsp'>

export interface StagedArtifactManifest {
  format: 'dyson-control-staged-artifact'
  schemaVersion: 1
  artifactId: string
  artifactFile: 'artifact.bin'
  release: {
    kind: StageableKind
    sourceId: string
    version: string
  }
  sizeBytes: number
  sha256: string
  integrity: 'provider-verified' | 'locally-computed'
  stagedAt: string
  componentManifest?: ComponentReleaseManifest
}

export interface ArtifactStagePlan {
  format: 'dyson-control-artifact-stage-plan'
  schemaVersion: 1
  dryRun: true
  artifactId: string
  source: { location: 'fixed-inbox'; file: string }
  destination: { location: 'fixed-staging-store'; releaseId: string }
  operations: Array<
    | 'acquire-exclusive-lock'
    | 'read-fixed-inbox-artifact'
    | 'compute-size-and-sha256'
    | 'verify-provider-integrity-if-present'
    | 'copy-to-temporary-directory'
    | 'write-verification-manifest'
    | 'atomically-publish-immutable-stage'
    | 'release-exclusive-lock'
  >
  activation: { enabled: false; reason: 'staging-only' }
  rollback: {
    automatic: false
    strategy: 'remove-unreferenced-staged-release'
    preconditions: ['stage-not-activated', 'stage-not-referenced-by-another-plan']
  }
}

export interface StageArtifactResult {
  created: boolean
  manifest: StagedArtifactManifest
  plan: ArtifactStagePlan
}

const artifactIdSchema = z.string().min(16).max(96).regex(/^[a-z0-9][a-z0-9-]+$/)
const isoDateSchema = z.string().datetime({ offset: true })
const maximumArtifactBytes = 2 * 1_024 * 1_024 * 1_024
const sizeSchema = z.number().int().positive().max(maximumArtifactBytes)

const releaseSchema = z.strictObject({
  kind: z.enum(['nebula', 'bepinex', 'plugin']),
  sourceId: sourceIdSchema,
  version: z.string().trim().min(1).max(64)
})

export const artifactStageRequestSchema = z.strictObject({
  artifactId: artifactIdSchema,
  release: releaseSchema,
  expected: z.strictObject({
    sizeBytes: sizeSchema.optional(),
    sha256: sha256Schema.optional()
  })
})

export const stagedArtifactManifestSchema: z.ZodType<StagedArtifactManifest> = z.strictObject({
  format: z.literal('dyson-control-staged-artifact'),
  schemaVersion: z.literal(1),
  artifactId: artifactIdSchema,
  artifactFile: z.literal('artifact.bin'),
  release: z.strictObject({
    kind: z.enum(['nebula', 'bepinex', 'plugin']),
    sourceId: sourceIdSchema,
    version: z.string().min(1).max(64)
  }),
  sizeBytes: sizeSchema,
  sha256: sha256Schema,
  integrity: z.enum(['provider-verified', 'locally-computed']),
  stagedAt: isoDateSchema,
  componentManifest: componentReleaseManifestSchema.optional()
}).superRefine((value, context) => {
  try {
    if (normalizeVersion(value.release.version, value.release.kind) !== value.release.version) {
      context.addIssue({ code: 'custom', message: 'staged release version is not normalized' })
    }
  } catch {
    context.addIssue({ code: 'custom', message: 'staged release version is invalid' })
  }
  if (value.release.kind === 'nebula' &&
      value.release.sourceId.toLowerCase() !== 'github:nebulamodteam/nebula') {
    context.addIssue({ code: 'custom', message: 'staged Nebula identity is invalid' })
  }
  if (value.release.kind === 'plugin' &&
      !value.release.sourceId.toLowerCase().startsWith('thunderstore:')) {
    context.addIssue({ code: 'custom', message: 'staged plugin identity is invalid' })
  }
  if (value.release.kind === 'bepinex') {
    if (value.release.sourceId.toLowerCase() !== 'github:bepinex/bepinex') {
      context.addIssue({ code: 'custom', message: 'staged BepInEx identity is invalid' })
    }
    if (value.componentManifest === undefined || value.componentManifest.component !== 'bepinex' ||
        value.componentManifest.version !== value.release.version ||
        value.componentManifest.artifactId !== value.artifactId) {
      context.addIssue({ code: 'custom', message: 'staged BepInEx content manifest is invalid' })
    } else {
      try { assertBepInExWindowsX64ManifestLayout(value.componentManifest) } catch {
        context.addIssue({ code: 'custom', message: 'staged BepInEx layout policy is invalid' })
      }
    }
  } else if (value.componentManifest !== undefined) {
    context.addIssue({ code: 'custom', message: 'staged content manifest is not allowed for this release kind' })
  }
})

const stagerOptionsSchema = z.strictObject({
  inboxRoot: z.string().min(1).max(1_024),
  stagingRoot: z.string().min(1).max(1_024),
  maximumBytes: z.number().int().min(1_024).max(maximumArtifactBytes)
})

export interface OfflineArtifactStagerOptions {
  inboxRoot: string
  stagingRoot: string
  maximumBytes?: number
  now?: () => Date
}

export class OfflineArtifactStager {
  readonly #inboxRoot: string
  readonly #stagingRoot: string
  readonly #maximumBytes: number
  readonly #now: () => Date

  constructor(options: OfflineArtifactStagerOptions) {
    const parsed = stagerOptionsSchema.parse({
      inboxRoot: options.inboxRoot,
      stagingRoot: options.stagingRoot,
      maximumBytes: options.maximumBytes ?? 512 * 1_024 * 1_024
    })
    if (!path.isAbsolute(parsed.inboxRoot) || !path.isAbsolute(parsed.stagingRoot)) {
      throw new UpdatePipelineError('STAGING_ROOT_NOT_ABSOLUTE')
    }
    this.#inboxRoot = path.resolve(parsed.inboxRoot)
    this.#stagingRoot = path.resolve(parsed.stagingRoot)
    if (canonicalPath(this.#inboxRoot) === canonicalPath(this.#stagingRoot) ||
        isDescendant(this.#inboxRoot, this.#stagingRoot) ||
        isDescendant(this.#stagingRoot, this.#inboxRoot)) {
      throw new UpdatePipelineError('STAGING_ROOT_COLLISION')
    }
    this.#maximumBytes = parsed.maximumBytes
    this.#now = options.now ?? (() => new Date())
  }

  preview(input: unknown): ArtifactStagePlan {
    const request = normalizeStageRequest(input)
    return createArtifactStagePlan(request.artifactId)
  }

  async stage(input: unknown, signal?: AbortSignal): Promise<StageArtifactResult> {
    const request = normalizeStageRequest(input)
    assertNotAborted(signal)
    await mkdir(this.#inboxRoot, { recursive: true })
    await mkdir(this.#stagingRoot, { recursive: true })
    await assertFixedDirectory(this.#inboxRoot)
    await assertFixedDirectory(this.#stagingRoot)

    const releasesRoot = path.join(this.#stagingRoot, 'releases')
    const locksRoot = path.join(this.#stagingRoot, '.locks')
    await Promise.all([mkdir(releasesRoot, { recursive: true }), mkdir(locksRoot, { recursive: true })])
    await Promise.all([assertFixedDirectory(releasesRoot), assertFixedDirectory(locksRoot)])
    const destination = managedChild(releasesRoot, request.artifactId)
    const lockPath = managedChild(locksRoot, `${request.artifactId}.lock`)
    const sourcePath = managedChild(this.#inboxRoot, `${request.artifactId}.artifact`)
    const plan = createArtifactStagePlan(request.artifactId)
    let lockHandle: FileHandle
    try {
      lockHandle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    } catch (error) {
      if (isNodeError(error, 'EEXIST')) throw new UpdatePipelineError('STAGING_LOCK_BUSY', { cause: error })
      throw new UpdatePipelineError('STAGING_LOCK_FAILED', { cause: error })
    }
    try {
      await lockHandle.writeFile(`${process.pid}\n`, 'utf8')
    } catch (error) {
      await lockHandle.close().catch(() => undefined)
      await unlink(lockPath).catch(() => undefined)
      throw new UpdatePipelineError('STAGING_LOCK_FAILED', { cause: error })
    }

    let temporaryDirectory: string | null = null
    try {
      const existing = await readExistingManifest(destination, request, this.#maximumBytes, signal)
      if (existing !== null) return { created: false, manifest: existing, plan }

      const sourceInfo = await lstat(sourcePath).catch((error: unknown) => {
        if (isNodeError(error, 'ENOENT')) throw new UpdatePipelineError('STAGING_SOURCE_MISSING', { cause: error })
        throw error
      })
      if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
        throw new UpdatePipelineError('STAGING_SOURCE_NOT_REGULAR_FILE')
      }
      if (sourceInfo.size === 0) throw new UpdatePipelineError('STAGING_ARTIFACT_INVALID')
      if (sourceInfo.size > this.#maximumBytes) throw new UpdatePipelineError('STAGING_ARTIFACT_TOO_LARGE')
      await assertSourceInsideRoot(this.#inboxRoot, sourcePath)
      assertNotAborted(signal)

      temporaryDirectory = managedChild(
        this.#stagingRoot,
        `.tmp-${request.artifactId}-${randomUUID()}`
      )
      await mkdir(temporaryDirectory, { recursive: false })
      const temporaryArtifact = managedChild(temporaryDirectory, 'artifact.bin')
      await copyFile(sourcePath, temporaryArtifact, constants.COPYFILE_EXCL)
      const measured = await measureArtifact(temporaryArtifact, this.#maximumBytes, signal)
      if (request.expected.sizeBytes !== undefined && request.expected.sizeBytes !== measured.sizeBytes) {
        throw new UpdatePipelineError('STAGING_SIZE_MISMATCH')
      }
      if (request.expected.sha256 !== undefined && request.expected.sha256 !== measured.sha256) {
        throw new UpdatePipelineError('STAGING_SHA256_MISMATCH')
      }
      const componentManifest = request.release.kind === 'bepinex'
        ? (await inspectComponentArchive({
            archivePath: temporaryArtifact,
            expectedComponent: 'bepinex',
            expectedVersion: request.release.version,
            expectedArtifactId: request.artifactId,
            limits: {
              maximumArchiveBytes: this.#maximumBytes,
              maximumFileBytes: 64 * 1_024 * 1_024,
              maximumExpandedBytes: 256 * 1_024 * 1_024,
              maximumFiles: 64
            }
          })).manifest
        : undefined
      assertNotAborted(signal)
      const stagedAt = this.#now().toISOString()
      isoDateSchema.parse(stagedAt)
      const manifest = stagedArtifactManifestSchema.parse({
        format: 'dyson-control-staged-artifact',
        schemaVersion: 1,
        artifactId: request.artifactId,
        artifactFile: 'artifact.bin',
        release: request.release,
        sizeBytes: measured.sizeBytes,
        sha256: measured.sha256,
        integrity: request.expected.sha256 === undefined ? 'locally-computed' : 'provider-verified',
        stagedAt,
        ...(componentManifest === undefined ? {} : { componentManifest })
      })
      await writeFile(
        managedChild(temporaryDirectory, 'manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 }
      )
      assertNotAborted(signal)
      await rename(temporaryDirectory, destination)
      temporaryDirectory = null
      return { created: true, manifest, plan }
    } catch (error) {
      if (error instanceof UpdatePipelineError) throw error
      throw new UpdatePipelineError('STAGING_FAILED', { cause: error })
    } finally {
      if (temporaryDirectory !== null) {
        assertManagedPath(this.#stagingRoot, temporaryDirectory)
        await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined)
      }
      await lockHandle.close().catch(() => undefined)
      await unlink(lockPath).catch(() => undefined)
    }
  }
}

export function createArtifactStagePlan(artifactIdInput: unknown): ArtifactStagePlan {
  const artifactId = artifactIdSchema.parse(artifactIdInput)
  return {
    format: 'dyson-control-artifact-stage-plan',
    schemaVersion: 1,
    dryRun: true,
    artifactId,
    source: { location: 'fixed-inbox', file: `${artifactId}.artifact` },
    destination: { location: 'fixed-staging-store', releaseId: artifactId },
    operations: [
      'acquire-exclusive-lock',
      'read-fixed-inbox-artifact',
      'compute-size-and-sha256',
      'verify-provider-integrity-if-present',
      'copy-to-temporary-directory',
      'write-verification-manifest',
      'atomically-publish-immutable-stage',
      'release-exclusive-lock'
    ],
    activation: { enabled: false, reason: 'staging-only' },
    rollback: {
      automatic: false,
      strategy: 'remove-unreferenced-staged-release',
      preconditions: ['stage-not-activated', 'stage-not-referenced-by-another-plan']
    }
  }
}

async function readExistingManifest(
  destination: string,
  request: NormalizedStageRequest,
  maximumBytes: number,
  signal?: AbortSignal
): Promise<StagedArtifactManifest | null> {
  const destinationInfo = await lstat(destination).catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  })
  if (destinationInfo === null) return null
  if (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink()) {
    throw new UpdatePipelineError('STAGING_DESTINATION_INVALID')
  }
  const manifestPath = managedChild(destination, 'manifest.json')
  const manifestInfo = await lstat(manifestPath).catch((error: unknown) => {
    throw new UpdatePipelineError('STAGING_MANIFEST_INVALID', { cause: error })
  })
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 64 * 1_024) {
    throw new UpdatePipelineError('STAGING_MANIFEST_INVALID')
  }
  let manifest: StagedArtifactManifest
  try {
    manifest = stagedArtifactManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')) as unknown)
  } catch (error) {
    throw new UpdatePipelineError('STAGING_MANIFEST_INVALID', { cause: error })
  }
  if (manifest.artifactId !== request.artifactId ||
      manifest.release.kind !== request.release.kind ||
      manifest.release.sourceId.toLowerCase() !== request.release.sourceId.toLowerCase() ||
      manifest.release.version !== request.release.version ||
      (request.expected.sizeBytes !== undefined && request.expected.sizeBytes !== manifest.sizeBytes) ||
      (request.expected.sha256 !== undefined && request.expected.sha256 !== manifest.sha256)) {
    throw new UpdatePipelineError('STAGING_IDEMPOTENCY_CONFLICT')
  }
  const measured = await measureArtifact(managedChild(destination, manifest.artifactFile), maximumBytes, signal)
  if (measured.sizeBytes !== manifest.sizeBytes || measured.sha256 !== manifest.sha256) {
    throw new UpdatePipelineError('STAGING_PUBLISHED_ARTIFACT_INVALID')
  }
  return manifest
}

interface NormalizedStageRequest {
  artifactId: string
  release: { kind: StageableKind; sourceId: string; version: string }
  expected: { sizeBytes?: number; sha256?: string }
}

function normalizeStageRequest(input: unknown): NormalizedStageRequest {
  const parsed = artifactStageRequestSchema.parse(input)
  const release = {
    kind: parsed.release.kind,
    sourceId: parsed.release.sourceId,
    version: normalizeVersion(parsed.release.version, parsed.release.kind)
  }
  if (release.kind === 'nebula' && release.sourceId.toLowerCase() !== 'github:nebulamodteam/nebula') {
    throw new UpdatePipelineError('STAGING_RELEASE_IDENTITY_INVALID')
  }
  if (release.kind === 'plugin' && !release.sourceId.toLowerCase().startsWith('thunderstore:')) {
    throw new UpdatePipelineError('STAGING_RELEASE_IDENTITY_INVALID')
  }
  if (release.kind === 'bepinex' && release.sourceId.toLowerCase() !== 'github:bepinex/bepinex') {
    throw new UpdatePipelineError('STAGING_RELEASE_IDENTITY_INVALID')
  }
  return {
    artifactId: parsed.artifactId,
    release,
    expected: {
      ...(parsed.expected.sizeBytes === undefined ? {} : { sizeBytes: parsed.expected.sizeBytes }),
      ...(parsed.expected.sha256 === undefined ? {} : { sha256: parsed.expected.sha256.toLowerCase() })
    }
  }
}

async function measureArtifact(
  filePath: string,
  maximumBytes: number,
  signal?: AbortSignal
): Promise<{ sizeBytes: number; sha256: string }> {
  const fileInfo = await lstat(filePath)
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new UpdatePipelineError('STAGING_ARTIFACT_INVALID')
  if (fileInfo.size === 0) throw new UpdatePipelineError('STAGING_ARTIFACT_INVALID')
  if (fileInfo.size > maximumBytes) throw new UpdatePipelineError('STAGING_ARTIFACT_TOO_LARGE')
  const digest = createHash('sha256')
  let sizeBytes = 0
  const stream = createReadStream(filePath, { highWaterMark: 64 * 1_024 })
  try {
    for await (const chunk of stream) {
      assertNotAborted(signal)
      const bytes = chunk as Buffer
      sizeBytes += bytes.byteLength
      if (sizeBytes > maximumBytes) throw new UpdatePipelineError('STAGING_ARTIFACT_TOO_LARGE')
      digest.update(bytes)
    }
  } catch (error) {
    stream.destroy()
    throw error
  }
  return { sizeBytes, sha256: digest.digest('hex') }
}

async function assertFixedDirectory(root: string): Promise<void> {
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new UpdatePipelineError('STAGING_ROOT_INVALID')
}

async function assertSourceInsideRoot(root: string, source: string): Promise<void> {
  const [realRoot, realSource] = await Promise.all([realpath(root), realpath(source)])
  assertManagedPath(realRoot, realSource)
}

function managedChild(root: string, name: string): string {
  const candidate = path.resolve(root, name)
  assertManagedPath(root, candidate)
  return candidate
}

function assertManagedPath(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new UpdatePipelineError('STAGING_PATH_ESCAPE')
  }
}

function canonicalPath(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function isDescendant(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new UpdatePipelineError('STAGING_ABORTED')
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}

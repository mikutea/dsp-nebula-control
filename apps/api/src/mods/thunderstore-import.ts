import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  type FileHandle
} from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  artifactAcquisitionReceiptSchema,
  thunderstoreDependencyFingerprint,
  type ArtifactAcquisitionReceipt
} from '../update-pipeline/acquisition.js'
import {
  readValidatedZipArchive,
  type ComponentArchiveLimits,
  type ValidatedZipArchiveEntry
} from '../update-pipeline/activation-archive.js'
import { sha256Schema } from '../updates/version.js'
import {
  formatThunderstoreDependency,
  parseThunderstoreDependency,
  thunderstoreDependencyIdSchema,
  type ThunderstoreDependency
} from './dependency.js'
import {
  computeStagedModPayloadDigest,
  stagedModPackageManifestSchema
} from './deployment.js'
import {
  MAX_MOD_DEPLOYMENT_MANIFEST_BYTES,
  MAX_STAGED_MOD_FILE_BYTES,
  MAX_STAGED_MOD_FILES,
  MAX_STAGED_MOD_TOTAL_BYTES,
  type StagedModPackageFile,
  type StagedModPackageManifest
} from './deployment-types.js'

const uuidSchema = z.string().uuid()
const artifactIdSchema = z.string().min(16).max(96).regex(/^[a-z0-9][a-z0-9-]+$/)
const isoDateSchema = z.string().datetime({ offset: true })
const sourceIdSchema = z.string().regex(/^thunderstore:[A-Za-z0-9_]{1,64}\/[A-Za-z0-9_]{1,64}$/)
const byteCountSchema = z.number().int().positive().max(2 * 1_024 * 1_024 * 1_024)
const sourceIdPattern = /^thunderstore:([A-Za-z0-9_]{1,64})\/([A-Za-z0-9_]{1,64})$/
const packageManifestFileName = 'package-manifest.json'
const payloadDirectoryName = 'payload'
const maximumPackageManifestBytes = 64 * 1_024

const thunderstoreManifestSchema = z.object({
  name: z.string().min(1).max(128).regex(/^[A-Za-z0-9_]+$/),
  description: z.string().max(250),
  version_number: z.string().min(5).max(32).regex(/^\d{1,10}\.\d{1,10}\.\d{1,10}$/),
  dependencies: z.array(thunderstoreDependencyIdSchema).max(64),
  website_url: z.string().max(2_048)
})

export const thunderstoreModImportPreviewRequestSchema = z.strictObject({
  acquisitionReceiptId: uuidSchema
})

export const thunderstoreModImportRequestSchema = z.strictObject({
  requestId: uuidSchema,
  acquisitionReceiptId: uuidSchema,
  confirmation: z.literal('IMPORT_THUNDERSTORE_MOD')
})

export interface ThunderstoreModImportPlan {
  format: 'dyson-control-thunderstore-mod-import-plan'
  schemaVersion: 1
  dryRun: true
  acquisitionReceiptId: string
  artifact: {
    artifactId: string
    sizeBytes: number
    sha256: string
  }
  package: {
    dependencyId: string
    sourceId: string
    version: string
    dependencies: string[]
  }
  payload: {
    sha256: string
    fileCount: number
    sizeBytes: number
  }
  operations: readonly [
    'load-validated-acquisition-receipt',
    'verify-fixed-inbox-artifact',
    'validate-thunderstore-root-manifest-and-exact-dependencies',
    'apply-bepinex-plugin-only-install-rules',
    'compute-canonical-payload-digest',
    'atomically-publish-mod-staging-package'
  ]
  deployment: { automatic: false; nextAction: 'mod-deployment-preview' }
}

export interface ThunderstoreModImportReceipt {
  format: 'dyson-control-thunderstore-mod-import-receipt'
  schemaVersion: 1
  requestId: string
  acquisitionReceiptId: string
  artifact: ThunderstoreModImportPlan['artifact']
  package: ThunderstoreModImportPlan['package']
  payload: ThunderstoreModImportPlan['payload'] & {
    manifest: StagedModPackageManifest
  }
  staging: { created: boolean }
  state: 'staged'
  reused: boolean
  importedAt: string
}

export const thunderstoreModImportReceiptSchema: z.ZodType<ThunderstoreModImportReceipt> = z.strictObject({
  format: z.literal('dyson-control-thunderstore-mod-import-receipt'),
  schemaVersion: z.literal(1),
  requestId: uuidSchema,
  acquisitionReceiptId: uuidSchema,
  artifact: z.strictObject({
    artifactId: artifactIdSchema,
    sizeBytes: byteCountSchema,
    sha256: sha256Schema
  }),
  package: z.strictObject({
    dependencyId: thunderstoreDependencyIdSchema,
    sourceId: sourceIdSchema,
    version: z.string().min(5).max(32),
    dependencies: z.array(thunderstoreDependencyIdSchema).max(64)
  }),
  payload: z.strictObject({
    sha256: sha256Schema,
    fileCount: z.number().int().min(1).max(MAX_STAGED_MOD_FILES),
    sizeBytes: z.number().int().positive().max(MAX_STAGED_MOD_TOTAL_BYTES),
    manifest: stagedModPackageManifestSchema
  }),
  staging: z.strictObject({ created: z.boolean() }),
  state: z.literal('staged'),
  reused: z.boolean(),
  importedAt: isoDateSchema
}).superRefine((value, context) => {
  try {
    const identity = parseThunderstoreDependency(value.package.dependencyId)
    const manifest = stagedModPackageManifestSchema.parse(value.payload.manifest)
    const sizeBytes = manifest.files.reduce((total, file) => total + file.sizeBytes, 0)
    if (identity.sourceId !== value.package.sourceId || identity.version !== value.package.version ||
        manifest.dependencyId !== value.package.dependencyId || manifest.sourceId !== value.package.sourceId ||
        manifest.version !== value.package.version || value.payload.sha256 !== computeStagedModPayloadDigest(manifest) ||
        canonicalJson(manifest.dependencies) !== canonicalJson(value.package.dependencies) ||
        value.payload.fileCount !== manifest.files.length || value.payload.sizeBytes !== sizeBytes) {
      context.addIssue({ code: 'custom', message: 'Thunderstore import receipt identity is inconsistent' })
    }
  } catch {
    context.addIssue({ code: 'custom', message: 'Thunderstore import receipt payload is invalid' })
  }
})

export interface ThunderstoreModImportAcquisition {
  getReceipt(requestId: unknown): Promise<ArtifactAcquisitionReceipt | null>
  verifyReceiptAuthority?(requestId: unknown): Promise<void>
}

export interface ThunderstoreModImporterOptions {
  acquisition: ThunderstoreModImportAcquisition
  acquisitionInboxRoot: string
  stagingRoot: string
  stateRoot: string
  maximumArchiveBytes?: number
  maximumFileBytes?: number
  maximumExpandedBytes?: number
  maximumArchiveFiles?: number
  now?: () => Date
}

interface PreparedPackage {
  identity: ThunderstoreDependency
  dependencies: string[]
  manifest: StagedModPackageManifest
  files: Array<StagedModPackageFile & { bytes: Buffer }>
  payloadSha256: string
  payloadSizeBytes: number
}

interface VerifiedSource {
  receipt: ArtifactAcquisitionReceipt
  artifactPath: string
  prepared: PreparedPackage
}

interface ImportRoots {
  receipts: string
  locks: string
}

interface AcquiredLock {
  handle: FileHandle
  file: string
}

export class ThunderstoreModImportError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) {
    super(code, options)
    this.name = 'ThunderstoreModImportError'
  }
}

/**
 * Converts an already acquired immutable Thunderstore ZIP into the exact
 * package-manifest/payload layout consumed by ModDeploymentService. It only
 * implements the BepInEx plugin destination; config/core/patcher/monomod
 * packages fail explicitly until those ownership domains have transactions.
 */
export class ThunderstoreModImporter {
  readonly #acquisition: ThunderstoreModImportAcquisition
  readonly #acquisitionInboxRoot: string
  readonly #stagingRoot: string
  readonly #stateRoot: string
  readonly #limits: ComponentArchiveLimits
  readonly #now: () => Date

  constructor(options: ThunderstoreModImporterOptions) {
    const roots = [options.acquisitionInboxRoot, options.stagingRoot, options.stateRoot]
    if (roots.some((root) => typeof root !== 'string' || !path.isAbsolute(root))) {
      throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_ROOT_NOT_ABSOLUTE')
    }
    this.#acquisitionInboxRoot = path.resolve(options.acquisitionInboxRoot)
    this.#stagingRoot = path.resolve(options.stagingRoot)
    this.#stateRoot = path.resolve(options.stateRoot)
    for (let left = 0; left < roots.length; left += 1) {
      for (let right = left + 1; right < roots.length; right += 1) {
        if (pathsOverlap(path.resolve(roots[left]!), path.resolve(roots[right]!))) {
          throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_ROOT_COLLISION')
        }
      }
    }
    this.#acquisition = options.acquisition
    this.#limits = {
      maximumArchiveBytes: options.maximumArchiveBytes ?? 512 * 1_024 * 1_024,
      maximumFileBytes: options.maximumFileBytes ?? MAX_STAGED_MOD_FILE_BYTES,
      maximumExpandedBytes: options.maximumExpandedBytes ?? MAX_STAGED_MOD_TOTAL_BYTES,
      maximumFiles: options.maximumArchiveFiles ?? 256
    }
    if (this.#limits.maximumArchiveBytes < 1_024 ||
        this.#limits.maximumFileBytes < 1 ||
        this.#limits.maximumExpandedBytes < this.#limits.maximumFileBytes ||
        this.#limits.maximumFiles < 4 || this.#limits.maximumFiles > 512) {
      throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_LIMITS_INVALID')
    }
    this.#now = options.now ?? (() => new Date())
  }

  async preview(input: unknown, signal?: AbortSignal): Promise<ThunderstoreModImportPlan> {
    const request = thunderstoreModImportPreviewRequestSchema.parse(input)
    const source = await this.#loadVerifiedSource(request.acquisitionReceiptId, signal)
    return createPlan(source)
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<ThunderstoreModImportReceipt> {
    const request = thunderstoreModImportRequestSchema.parse(input)
    assertNotAborted(signal)
    const roots = await this.#prepareRoots()
    const requestLock = await acquireLock(
      managedChild(roots.locks, `request-${request.requestId}.lock`),
      'THUNDERSTORE_MOD_IMPORT_REQUEST_LOCK_BUSY'
    )
    let packageLock: AcquiredLock | null = null
    try {
      const receiptFile = managedChild(roots.receipts, `${request.requestId}.json`)
      const existing = await readReceipt(receiptFile)
      if (existing !== null) {
        if (existing.acquisitionReceiptId !== request.acquisitionReceiptId) {
          throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_IDEMPOTENCY_CONFLICT')
        }
        const source = await this.#loadVerifiedSource(request.acquisitionReceiptId, signal)
        assertReceiptMatchesSource(existing, source)
        await verifyPublishedPackage(this.#stagingRoot, source.prepared, signal)
        return { ...existing, reused: true }
      }

      let source = await this.#loadVerifiedSource(request.acquisitionReceiptId, signal)
      packageLock = await acquireLock(
        managedChild(roots.locks, `package-${hashText(source.prepared.identity.dependencyId)}.lock`),
        'THUNDERSTORE_MOD_IMPORT_PACKAGE_LOCK_BUSY'
      )
      const lockedSource = await this.#loadVerifiedSource(request.acquisitionReceiptId, signal)
      if (sourceFingerprint(source) !== sourceFingerprint(lockedSource)) {
        throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_SOURCE_CHANGED')
      }
      source = lockedSource
      const created = await publishPackage(this.#stagingRoot, request.requestId, source.prepared, signal)
      const receipt = thunderstoreModImportReceiptSchema.parse({
        format: 'dyson-control-thunderstore-mod-import-receipt',
        schemaVersion: 1,
        requestId: request.requestId,
        acquisitionReceiptId: request.acquisitionReceiptId,
        artifact: {
          artifactId: source.receipt.artifact.artifactId,
          sizeBytes: source.receipt.artifact.sizeBytes,
          sha256: source.receipt.artifact.sha256
        },
        package: {
          dependencyId: source.prepared.identity.dependencyId,
          sourceId: source.prepared.identity.sourceId,
          version: source.prepared.identity.version,
          dependencies: source.prepared.dependencies
        },
        payload: {
          sha256: source.prepared.payloadSha256,
          fileCount: source.prepared.manifest.files.length,
          sizeBytes: source.prepared.payloadSizeBytes,
          manifest: source.prepared.manifest
        },
        staging: { created },
        state: 'staged',
        reused: false,
        importedAt: this.#now().toISOString()
      })
      await atomicWriteJson(receiptFile, receipt)
      return receipt
    } finally {
      if (packageLock !== null) await releaseLock(packageLock)
      await releaseLock(requestLock)
    }
  }

  async getReceipt(requestIdInput: unknown): Promise<ThunderstoreModImportReceipt | null> {
    const requestId = uuidSchema.parse(requestIdInput)
    const roots = await this.#prepareRoots()
    return await readReceipt(managedChild(roots.receipts, `${requestId}.json`))
  }

  /**
   * Re-establishes every durable fact represented by an import receipt before
   * returning it to a downstream trust boundary. Unlike getReceipt(), this
   * method is intentionally expensive: it rereads the acquisition receipt,
   * hashes and parses the fixed inbox ZIP, reconstructs the prepared package,
   * and verifies the published staging manifest and every staged payload file.
   */
  async getVerifiedReceipt(
    requestIdInput: unknown,
    signal?: AbortSignal
  ): Promise<ThunderstoreModImportReceipt | null> {
    const requestId = uuidSchema.parse(requestIdInput)
    assertNotAborted(signal)
    const roots = await this.#prepareRoots()
    const receipt = await readReceipt(managedChild(roots.receipts, `${requestId}.json`))
    assertNotAborted(signal)
    if (receipt === null) return null
    if (receipt.requestId !== requestId) {
      throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_RECEIPT_VERIFICATION_FAILED')
    }
    try {
      const source = await this.#loadVerifiedSource(receipt.acquisitionReceiptId, signal)
      assertReceiptMatchesSource(receipt, source)
      await verifyPublishedPackage(this.#stagingRoot, source.prepared, signal)
      assertNotAborted(signal)
      return receipt
    } catch (error) {
      if (error instanceof ThunderstoreModImportError &&
          ['THUNDERSTORE_MOD_IMPORT_ABORTED', 'THUNDERSTORE_MOD_IMPORT_ACQUISITION_UNAVAILABLE']
            .includes(error.code)) {
        throw error
      }
      throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_RECEIPT_VERIFICATION_FAILED', {
        cause: error
      })
    }
  }

  async #loadVerifiedSource(acquisitionReceiptId: string, signal?: AbortSignal): Promise<VerifiedSource> {
    assertNotAborted(signal)
    let receiptInput: ArtifactAcquisitionReceipt | null
    try {
      receiptInput = await this.#acquisition.getReceipt(acquisitionReceiptId)
    } catch (error) {
      throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_ACQUISITION_UNAVAILABLE', { cause: error })
    }
    assertNotAborted(signal)
    if (receiptInput === null) {
      throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_ACQUISITION_NOT_FOUND')
    }
    let receipt: ArtifactAcquisitionReceipt
    try {
      receipt = artifactAcquisitionReceiptSchema.parse(receiptInput)
    } catch (error) {
      throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_ACQUISITION_INVALID', { cause: error })
    }
    if (receipt.requestId !== acquisitionReceiptId || receipt.provider !== 'thunderstore' ||
        receipt.release.kind !== 'plugin' || !sourceIdPattern.test(receipt.release.sourceId)) {
      throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_ACQUISITION_INVALID')
    }
    await this.#verifySourceAuthority(receipt)
    await assertNormalDirectory(this.#acquisitionInboxRoot)
    const artifactPath = managedChild(
      this.#acquisitionInboxRoot,
      `${receipt.artifact.artifactId}.artifact`
    )
    const measured = await measureFile(artifactPath, this.#limits.maximumArchiveBytes, signal)
    if (measured.sizeBytes !== receipt.artifact.sizeBytes || measured.sha256 !== receipt.artifact.sha256) {
      throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_ACQUIRED_ARTIFACT_CHANGED')
    }
    let entries: ValidatedZipArchiveEntry[]
    try {
      entries = await readValidatedZipArchive(artifactPath, this.#limits)
    } catch (error) {
      throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_ARCHIVE_INVALID', { cause: error })
    }
    await this.#verifySourceAuthority(receipt)
    return { receipt, artifactPath, prepared: preparePackage(receipt, entries) }
  }

  async #verifySourceAuthority(receipt: ArtifactAcquisitionReceipt): Promise<void> {
    if (receipt.artifact.trustedPolicyRevision === undefined) return
    try {
      if (this.#acquisition.verifyReceiptAuthority === undefined) throw new Error('authority unavailable')
      await this.#acquisition.verifyReceiptAuthority(receipt.requestId)
    } catch (error) {
      throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_ACQUISITION_UNAVAILABLE', { cause: error })
    }
  }

  async #prepareRoots(): Promise<ImportRoots> {
    await Promise.all([
      mkdir(this.#stagingRoot, { recursive: true }),
      mkdir(this.#stateRoot, { recursive: true })
    ])
    await Promise.all([
      assertNormalDirectory(this.#stagingRoot),
      assertNormalDirectory(this.#stateRoot)
    ])
    const receipts = managedChild(this.#stateRoot, 'receipts')
    const locks = managedChild(this.#stateRoot, 'locks')
    await Promise.all([mkdir(receipts, { recursive: true }), mkdir(locks, { recursive: true })])
    await Promise.all([assertNormalDirectory(receipts), assertNormalDirectory(locks)])
    return { receipts, locks }
  }
}

function preparePackage(
  receipt: ArtifactAcquisitionReceipt,
  entries: readonly ValidatedZipArchiveEntry[]
): PreparedPackage {
  const identity = identityFromReceipt(receipt)
  const byName = new Map(entries.map((entry) => [entry.name, entry]))
  for (const required of ['manifest.json', 'README.md', 'icon.png'] as const) {
    if (!byName.has(required)) throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_METADATA_MISSING')
  }
  const manifestEntry = byName.get('manifest.json')!
  if (manifestEntry.sizeBytes > maximumPackageManifestBytes) {
    throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_MANIFEST_INVALID')
  }
  let packageManifest: z.infer<typeof thunderstoreManifestSchema>
  try {
    packageManifest = thunderstoreManifestSchema.parse(JSON.parse(manifestEntry.bytes.toString('utf8')) as unknown)
  } catch (error) {
    throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_MANIFEST_INVALID', { cause: error })
  }
  if (packageManifest.name !== identity.name ||
      formatThunderstoreDependency({
        namespace: identity.namespace,
        name: packageManifest.name,
        version: packageManifest.version_number
      }).dependencyId !== identity.dependencyId) {
    throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_IDENTITY_MISMATCH')
  }
  const dependencies = packageManifest.dependencies
    .map((dependency) => parseThunderstoreDependency(dependency).dependencyId)
    .sort(compareText)
  if (new Set(dependencies.map((dependency) => dependency.toLowerCase())).size !== dependencies.length) {
    throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_DEPENDENCY_DUPLICATE')
  }
  const boundDependencies = receipt.release.dependencies
  const boundFingerprint = receipt.release.dependencyFingerprint
  if (boundDependencies === undefined || boundFingerprint === undefined) {
    throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_ACQUISITION_INVALID')
  }
  if (canonicalJson(dependencies) !== canonicalJson(boundDependencies) ||
      thunderstoreDependencyFingerprint(dependencies) !== boundFingerprint) {
    throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_DEPENDENCY_GRAPH_MISMATCH')
  }

  const projected: Array<StagedModPackageFile & { bytes: Buffer }> = []
  const outputNames = new Set<string>()
  for (const entry of entries) {
    const relativePath = projectPluginOnlyPath(entry.name)
    if (relativePath === null) continue
    const canonical = relativePath.toLowerCase()
    if (outputNames.has(canonical)) {
      throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_OUTPUT_CONFLICT')
    }
    outputNames.add(canonical)
    projected.push({
      relativePath,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
      bytes: entry.bytes
    })
  }
  projected.sort((left, right) => compareText(left.relativePath, right.relativePath))
  if (projected.length === 0 || projected.length > MAX_STAGED_MOD_FILES ||
      !projected.some((entry) => entry.relativePath.toLowerCase().endsWith('.dll'))) {
    throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_RUNTIME_PAYLOAD_MISSING')
  }
  const payloadSizeBytes = projected.reduce((total, entry) => total + entry.sizeBytes, 0)
  if (!Number.isSafeInteger(payloadSizeBytes) || payloadSizeBytes > MAX_STAGED_MOD_TOTAL_BYTES) {
    throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_PAYLOAD_TOO_LARGE')
  }
  const manifest = stagedModPackageManifestSchema.parse({
    format: 'dyson-control-staged-mod-package',
    schemaVersion: 1,
    dependencyId: identity.dependencyId,
    sourceId: identity.sourceId,
    version: identity.version,
    dependencies,
    files: projected.map(({ bytes: _bytes, ...file }) => file)
  })
  return {
    identity,
    dependencies,
    manifest,
    files: projected,
    payloadSha256: computeStagedModPayloadDigest(manifest),
    payloadSizeBytes
  }
}

function identityFromReceipt(receipt: ArtifactAcquisitionReceipt): ThunderstoreDependency {
  const match = sourceIdPattern.exec(receipt.release.sourceId)
  if (match === null) throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_ACQUISITION_INVALID')
  try {
    return formatThunderstoreDependency({
      namespace: match[1]!,
      name: match[2]!,
      version: receipt.release.version
    })
  } catch (error) {
    throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_ACQUISITION_INVALID', { cause: error })
  }
}

function projectPluginOnlyPath(sourcePathInput: string): string | null {
  if (sourcePathInput === 'manifest.json' || sourcePathInput === 'README.md' ||
      sourcePathInput === 'icon.png' || sourcePathInput === 'CHANGELOG.md') return null
  let sourcePath = sourcePathInput
  if (sourcePath.toLowerCase().startsWith('bepinex/')) sourcePath = sourcePath.slice('BepInEx/'.length)
  const parts = sourcePath.split('/')
  const top = parts[0]!.toLowerCase()
  if (top === 'config' || top === 'core' || top === 'patchers' || top === 'monomod') {
    throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_NON_PLUGIN_DESTINATION_UNSUPPORTED')
  }
  let output = top === 'plugins' ? parts.slice(1).join('/') : parts.at(-1)!
  if (output.length === 0 || output.toLowerCase().endsWith('.mm.dll')) {
    throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_NON_PLUGIN_DESTINATION_UNSUPPORTED')
  }
  if (!isSafeRuntimePath(output)) {
    throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_RUNTIME_LAYOUT_UNSUPPORTED')
  }
  return output
}

function isSafeRuntimePath(value: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/.test(value) || value.includes('//') || value.endsWith('/')) return false
  const segments = value.split('/')
  if (segments.some((segment) => segment === '.' || segment === '..' || segment.length === 0 ||
      segment.endsWith('.') || segment.endsWith(' ') || isWindowsDeviceName(segment))) return false
  return /\.(?:dll|json)$/i.test(value)
}

function isWindowsDeviceName(segment: string): boolean {
  const stem = segment.split('.')[0]!.toUpperCase()
  return stem === 'CON' || stem === 'PRN' || stem === 'AUX' || stem === 'NUL' ||
    /^COM[1-9]$/.test(stem) || /^LPT[1-9]$/.test(stem)
}

function createPlan(source: VerifiedSource): ThunderstoreModImportPlan {
  return {
    format: 'dyson-control-thunderstore-mod-import-plan',
    schemaVersion: 1,
    dryRun: true,
    acquisitionReceiptId: source.receipt.requestId,
    artifact: {
      artifactId: source.receipt.artifact.artifactId,
      sizeBytes: source.receipt.artifact.sizeBytes,
      sha256: source.receipt.artifact.sha256
    },
    package: {
      dependencyId: source.prepared.identity.dependencyId,
      sourceId: source.prepared.identity.sourceId,
      version: source.prepared.identity.version,
      dependencies: source.prepared.dependencies
    },
    payload: {
      sha256: source.prepared.payloadSha256,
      fileCount: source.prepared.manifest.files.length,
      sizeBytes: source.prepared.payloadSizeBytes
    },
    operations: [
      'load-validated-acquisition-receipt',
      'verify-fixed-inbox-artifact',
      'validate-thunderstore-root-manifest-and-exact-dependencies',
      'apply-bepinex-plugin-only-install-rules',
      'compute-canonical-payload-digest',
      'atomically-publish-mod-staging-package'
    ],
    deployment: { automatic: false, nextAction: 'mod-deployment-preview' }
  }
}

async function publishPackage(
  stagingRoot: string,
  requestId: string,
  prepared: PreparedPackage,
  signal?: AbortSignal
): Promise<boolean> {
  const destination = managedChild(stagingRoot, prepared.identity.dependencyId)
  const existing = await lstat(destination).catch((error: unknown) => isNodeError(error, 'ENOENT') ? null : Promise.reject(error))
  if (existing !== null) {
    await verifyPublishedPackage(stagingRoot, prepared, signal)
    return false
  }
  const temporary = managedChild(stagingRoot, `.import-${requestId}-${randomUUID()}`)
  try {
    await mkdir(temporary)
    const payloadRoot = managedChild(temporary, payloadDirectoryName)
    await mkdir(payloadRoot)
    for (const file of prepared.files) {
      assertNotAborted(signal)
      const destinationFile = resolvePayloadPath(payloadRoot, file.relativePath)
      await mkdir(path.dirname(destinationFile), { recursive: true })
      await writeExclusive(destinationFile, file.bytes)
    }
    await writeExclusive(
      managedChild(temporary, packageManifestFileName),
      Buffer.from(`${canonicalJson(prepared.manifest)}\n`, 'utf8')
    )
    await verifyPackageDirectory(temporary, prepared, signal)
    assertNotAborted(signal)
    await rename(temporary, destination)
    await verifyPublishedPackage(stagingRoot, prepared, signal)
    return true
  } catch (error) {
    if (error instanceof ThunderstoreModImportError) throw error
    throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_PUBLISH_FAILED', { cause: error })
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function verifyPublishedPackage(
  stagingRoot: string,
  prepared: PreparedPackage,
  signal?: AbortSignal
): Promise<void> {
  assertNotAborted(signal)
  const packageRoot = managedChild(stagingRoot, prepared.identity.dependencyId)
  await assertNormalDirectory(packageRoot)
  await verifyPackageDirectory(packageRoot, prepared, signal)
}

async function verifyPackageDirectory(
  packageRoot: string,
  prepared: PreparedPackage,
  signal?: AbortSignal
): Promise<void> {
  assertNotAborted(signal)
  const top = await readdir(packageRoot, { withFileTypes: true })
  const names = top.map((entry) => entry.name).sort(compareText)
  if (names.length !== 2 || names[0] !== packageManifestFileName || names[1] !== payloadDirectoryName ||
      top.some((entry) => entry.isSymbolicLink())) {
    throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_STAGING_CONFLICT')
  }
  const manifestFile = managedChild(packageRoot, packageManifestFileName)
  const manifestInfo = await lstat(manifestFile)
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > MAX_MOD_DEPLOYMENT_MANIFEST_BYTES) {
    throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_STAGING_CONFLICT')
  }
  let manifest: StagedModPackageManifest
  try {
    manifest = stagedModPackageManifestSchema.parse(JSON.parse(await readFile(manifestFile, 'utf8')) as unknown)
  } catch (error) {
    throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_STAGING_CONFLICT', { cause: error })
  }
  if (canonicalJson(manifest) !== canonicalJson(prepared.manifest) ||
      computeStagedModPayloadDigest(manifest) !== prepared.payloadSha256) {
    throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_STAGING_CONFLICT')
  }
  const payloadRoot = managedChild(packageRoot, payloadDirectoryName)
  await assertNormalDirectory(payloadRoot)
  const actual = await enumeratePayload(payloadRoot, signal)
  const expected = prepared.manifest.files.map((file) => file.relativePath)
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_STAGING_CONFLICT')
  }
  for (const file of prepared.manifest.files) {
    assertNotAborted(signal)
    const measured = await measureFile(resolvePayloadPath(payloadRoot, file.relativePath), file.sizeBytes, signal)
    if (measured.sizeBytes !== file.sizeBytes || measured.sha256 !== file.sha256) {
      throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_STAGING_CONFLICT')
    }
  }
}

async function enumeratePayload(root: string, signal?: AbortSignal): Promise<string[]> {
  const files: string[] = []
  const visit = async (directory: string, prefix: string): Promise<void> => {
    assertNotAborted(signal)
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => compareText(left.name, right.name))
    const names = new Set<string>()
    for (const entry of entries) {
      assertNotAborted(signal)
      const canonical = entry.name.toLowerCase()
      if (names.has(canonical) || entry.isSymbolicLink()) {
        throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_STAGING_CONFLICT')
      }
      names.add(canonical)
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await assertNormalDirectory(fullPath)
        await visit(fullPath, relativePath)
      } else if (entry.isFile() && isSafeRuntimePath(relativePath)) {
        files.push(relativePath)
      } else {
        throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_STAGING_CONFLICT')
      }
    }
  }
  await visit(root, '')
  return files.sort(compareText)
}

async function measureFile(file: string, maximumBytes: number, signal?: AbortSignal): Promise<{ sizeBytes: number; sha256: string }> {
  const info = await lstat(file).catch((error: unknown) => {
    throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_ARTIFACT_UNAVAILABLE', { cause: error })
  })
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > maximumBytes) {
    throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_ARTIFACT_INVALID')
  }
  const hash = createHash('sha256')
  let sizeBytes = 0
  const stream = createReadStream(file)
  try {
    for await (const chunk of stream) {
      assertNotAborted(signal)
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      sizeBytes += bytes.length
      if (sizeBytes > maximumBytes) throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_ARTIFACT_TOO_LARGE')
      hash.update(bytes)
    }
  } finally {
    stream.destroy()
  }
  return { sizeBytes, sha256: hash.digest('hex') }
}

async function writeExclusive(file: string, bytes: Buffer): Promise<void> {
  const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  const temporary = path.join(path.dirname(file), `.tmp-${path.basename(file)}-${randomUUID()}`)
  try {
    await writeExclusive(temporary, Buffer.from(`${canonicalJson(value)}\n`, 'utf8'))
    await rename(temporary, file)
  } catch (error) {
    throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_RECEIPT_WRITE_FAILED', { cause: error })
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function readReceipt(file: string): Promise<ThunderstoreModImportReceipt | null> {
  const info = await lstat(file).catch((error: unknown) => isNodeError(error, 'ENOENT') ? null : Promise.reject(error))
  if (info === null) return null
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 512 * 1_024) {
    throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_RECEIPT_INVALID')
  }
  try {
    return thunderstoreModImportReceiptSchema.parse(JSON.parse(await readFile(file, 'utf8')) as unknown)
  } catch (error) {
    throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_RECEIPT_INVALID', { cause: error })
  }
}

function assertReceiptMatchesSource(receipt: ThunderstoreModImportReceipt, source: VerifiedSource): void {
  if (receipt.artifact.artifactId !== source.receipt.artifact.artifactId ||
      receipt.artifact.sizeBytes !== source.receipt.artifact.sizeBytes ||
      receipt.artifact.sha256 !== source.receipt.artifact.sha256 ||
      receipt.package.dependencyId !== source.prepared.identity.dependencyId ||
      receipt.payload.sha256 !== source.prepared.payloadSha256 ||
      canonicalJson(receipt.payload.manifest) !== canonicalJson(source.prepared.manifest)) {
    throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_IDEMPOTENCY_CONFLICT')
  }
}

function sourceFingerprint(source: VerifiedSource): string {
  return hashText(canonicalJson({
    requestId: source.receipt.requestId,
    artifact: source.receipt.artifact,
    package: source.prepared.identity.dependencyId,
    dependencies: source.prepared.dependencies,
    payloadSha256: source.prepared.payloadSha256
  }))
}

async function acquireLock(file: string, busyCode: string): Promise<AcquiredLock> {
  try {
    const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    await handle.writeFile(`${process.pid}\n`, 'utf8')
    return { handle, file }
  } catch (error) {
    if (isNodeError(error, 'EEXIST')) throw new ThunderstoreModImportError(busyCode, { cause: error })
    throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_LOCK_FAILED', { cause: error })
  }
}

async function releaseLock(lock: AcquiredLock): Promise<void> {
  await lock.handle.close().catch(() => undefined)
  await unlink(lock.file).catch(() => undefined)
}

async function assertNormalDirectory(directory: string): Promise<void> {
  const info = await lstat(directory).catch((error: unknown) => {
    throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_ROOT_INVALID', { cause: error })
  })
  if (!info.isDirectory() || info.isSymbolicLink() || canonicalPath(await realpath(directory)) !== canonicalPath(directory)) {
    throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_ROOT_INVALID')
  }
}

function resolvePayloadPath(root: string, relativePath: string): string {
  if (!isSafeRuntimePath(relativePath)) throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_PATH_INVALID')
  return managedChild(root, ...relativePath.split('/'))
}

function managedChild(root: string, ...parts: string[]): string {
  const child = path.resolve(root, ...parts)
  if (!isDescendant(path.resolve(root), child)) throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_PATH_ESCAPE')
  return child
}

function pathsOverlap(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right) || isDescendant(left, right) || isDescendant(right, left)
}

function isDescendant(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function canonicalPath(value: string): string {
  const normalized = path.resolve(value).replace(/^\\\\\?\\/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
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

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_ABORTED')
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
}

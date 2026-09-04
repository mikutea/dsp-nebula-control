import { randomUUID } from 'node:crypto'
import { mkdir, lstat, open, realpath, rename, rmdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  assertDigestEqual,
  canonicalJson,
  parseStrictCanonicalJsonBytes,
  parseStrictJsonBytes,
  sha256Bytes,
  sha256Canonical
} from './canonical.js'
import {
  clientQualificationProjectionSchema,
  hostnameWssBinaryBindingSchema,
  hostnameWssContractBindingSchema,
  type ProtectedClientQualificationConsumer,
  type VerifyHostnameWssQualificationOptions
} from './qualification-v2.js'
import type { ProtectedClientQualificationStore } from './qualification-store.js'
import {
  generateQualifiedClientProfileV2,
  projectGeneratedQualifiedClientProfile,
  QUALIFIED_CLIENT_PROFILE_ZIP_FILE_NAME,
  QUALIFIED_NEBULA_CLIENT_ZIP_FILE_NAME,
  type GeneratedQualifiedClientProfile,
  type GeneratedQualifiedClientProfileMetadata
} from './qualified-generator.js'

export const QUALIFIED_CLIENT_ISSUE_PROTOCOL = 'DYSON_QUALIFIED_CLIENT_ISSUE_V1' as const

const ISSUE_INDEX_PROTOCOL = 'DYSON_QUALIFIED_CLIENT_ISSUE_INDEX_V1' as const
const RUNTIME_FILE_NAME = 'qualified-client-runtime.json' as const
const METADATA_FILE_NAME = 'metadata.json' as const
const RECEIPT_FILE_NAME = 'receipt.json' as const
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const uuidSchema = z.string().regex(UUID_PATTERN)
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const artifactDigestSchema = z.string().regex(/^(?:sha256:)?[0-9a-f]{64}$/)
const utcMillisecondsSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => new Date(Date.parse(value)).toISOString() === value)
const safeCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

const connectionSchema = z.strictObject({
  protocol: z.literal('nebula'),
  transport: z.literal('wss'),
  topology: z.literal('http-websocket-tunnel'),
  path: z.literal('/socket'),
  authoritySemantics: z.literal('hostname-preserved'),
  host: z.string().min(4).max(253),
  port: z.literal(443),
  displayAddress: z.string().min(8).max(257),
  websocketUrl: z.string().min(16).max(512)
})

const publicMetadataSchema = z.strictObject({
  format: z.literal('dyson-control-qualified-client-profile-issue'),
  schemaVersion: z.literal(1),
  productionQualified: z.literal(true),
  qualification: clientQualificationProjectionSchema,
  profile: z.strictObject({
    profileId: z.string().min(1).max(128),
    displayName: z.string().min(1).max(256),
    connection: connectionSchema,
    runtime: z.strictObject({
      dsp: z.string().min(1).max(128),
      nebula: z.string().min(1).max(128),
      bepInEx: z.string().min(1).max(128),
      compatibilityEntryId: z.string().min(1).max(128)
    }),
    provenance: z.strictObject({
      serverLockSha256: artifactDigestSchema,
      clientParitySha256: artifactDigestSchema,
      compatibilityPolicySha256: digestSchema,
      qualificationDocumentSha256: digestSchema
    }),
    requiredModCount: safeCountSchema,
    optionalModCount: safeCountSchema
  }),
  qualifiedClientRuntime: z.strictObject({
    format: z.literal('dyson-control-qualified-client-runtime'),
    schemaVersion: z.literal(1),
    qualification: clientQualificationProjectionSchema,
    connection: connectionSchema,
    contracts: hostnameWssContractBindingSchema,
    runtimeBinaries: hostnameWssBinaryBindingSchema,
    clientPayload: z.strictObject({
      fileName: z.literal(QUALIFIED_NEBULA_CLIENT_ZIP_FILE_NAME),
      manifestSha256: digestSchema,
      packageSha256: digestSchema,
      packageSizeBytes: safeCountSchema,
      treeSha256: digestSchema,
      fileCount: safeCountSchema
    }),
    profilePackage: z.strictObject({
      fileName: z.literal(QUALIFIED_CLIENT_PROFILE_ZIP_FILE_NAME),
      artifactSetSha256: artifactDigestSchema,
      zipSha256: artifactDigestSchema,
      zipSizeBytes: safeCountSchema
    }),
    policies: z.strictObject({
      serverLockSha256: digestSchema,
      clientParitySha256: digestSchema,
      compatibilityPolicySha256: digestSchema
    })
  }),
  artifacts: z.strictObject({
    profileArtifactSetSha256: artifactDigestSchema,
    profileArchive: z.strictObject({
      fileName: z.literal(QUALIFIED_CLIENT_PROFILE_ZIP_FILE_NAME),
      mediaType: z.literal('application/zip'),
      sizeBytes: safeCountSchema,
      sha256: artifactDigestSchema,
      entryCount: safeCountSchema
    }),
    qualifiedClientPayload: z.strictObject({
      fileName: z.literal(QUALIFIED_NEBULA_CLIENT_ZIP_FILE_NAME),
      mediaType: z.literal('application/zip'),
      sizeBytes: safeCountSchema,
      sha256: digestSchema
    }),
    qualifiedRuntime: z.strictObject({
      entryName: z.literal(RUNTIME_FILE_NAME),
      mediaType: z.literal('application/json'),
      sizeBytes: safeCountSchema,
      sha256: artifactDigestSchema
    })
  })
})

const issueReceiptSchema = z.strictObject({
  protocol: z.literal(QUALIFIED_CLIENT_ISSUE_PROTOCOL),
  schemaVersion: z.literal(1),
  downloadId: uuidSchema,
  qualificationId: uuidSchema,
  runId: uuidSchema,
  bindingSha256: digestSchema,
  expiresAtUtc: utcMillisecondsSchema,
  issuedAtUtc: utcMillisecondsSchema,
  metadataSha256: digestSchema,
  metadataSizeBytes: safeCountSchema,
  archiveSha256: digestSchema,
  archiveSizeBytes: safeCountSchema,
  clientPayloadSha256: digestSchema,
  clientPayloadSizeBytes: safeCountSchema,
  runtimeSha256: digestSchema,
  runtimeSizeBytes: safeCountSchema,
  receiptSha256: digestSchema
})

const issueIndexSchema = z.strictObject({
  protocol: z.literal(ISSUE_INDEX_PROTOCOL),
  schemaVersion: z.literal(1),
  qualificationId: uuidSchema,
  bindingSha256: digestSchema,
  downloadId: uuidSchema,
  issueReceiptSha256: digestSchema,
  indexSha256: digestSchema
})

type IssueReceipt = z.output<typeof issueReceiptSchema>
type IssueIndex = z.output<typeof issueIndexSchema>

export interface IssuedQualifiedClientProfileReference {
  downloadId: string
  issueReceiptSha256: string
  qualificationId: string
  bindingSha256: string
  expiresAtUtc: string
  metadata: GeneratedQualifiedClientProfileMetadata
  archive: {
    fileName: typeof QUALIFIED_CLIENT_PROFILE_ZIP_FILE_NAME
    mediaType: 'application/zip'
    sizeBytes: number
    sha256: string
  }
}

export interface IssuedQualifiedClientProfileArchive {
  downloadId: string
  fileName: typeof QUALIFIED_CLIENT_PROFILE_ZIP_FILE_NAME
  mediaType: 'application/zip'
  sizeBytes: number
  sha256: string
  bytes: Buffer
}

export interface IssuedQualifiedNebulaClientArchive {
  downloadId: string
  fileName: typeof QUALIFIED_NEBULA_CLIENT_ZIP_FILE_NAME
  mediaType: 'application/zip'
  sizeBytes: number
  sha256: string
  bytes: Buffer
}

export interface IssuedQualifiedClientRuntimeArtifact {
  downloadId: string
  fileName: typeof RUNTIME_FILE_NAME
  mediaType: 'application/json'
  sizeBytes: number
  sha256: string
  bytes: Buffer
}

export interface IssuedQualifiedClientProfileStore {
  issue(generated: GeneratedQualifiedClientProfile): Promise<IssuedQualifiedClientProfileReference>
  readMetadata(downloadId: string): Promise<IssuedQualifiedClientProfileReference>
  readArchive(downloadId: string): Promise<IssuedQualifiedClientProfileArchive>
  readClientPayload(downloadId: string): Promise<IssuedQualifiedNebulaClientArchive>
  readRuntimeArtifact(downloadId: string): Promise<IssuedQualifiedClientRuntimeArtifact>
}

export interface FileSystemIssuedQualifiedClientProfileStoreOptions {
  protectedRoot: string
  createDownloadId?: () => string
  clock?: () => Date
  maxMetadataBytes?: number
  maxRuntimeBytes?: number
  maxArchiveBytes?: number
  maxClientPayloadBytes?: number
}

/**
 * HTTP-safe issue boundary: consume once (idempotently in the protected
 * Windows ledger), persist immutable downloads, and return metadata only.
 */
export async function issueQualifiedClientProfileV2(
  request: unknown,
  qualificationStore: ProtectedClientQualificationStore,
  consumer: ProtectedClientQualificationConsumer,
  issuedStore: IssuedQualifiedClientProfileStore,
  options: VerifyHostnameWssQualificationOptions = {}
): Promise<IssuedQualifiedClientProfileReference> {
  const generated = await generateQualifiedClientProfileV2(request, qualificationStore, consumer, options)
  return await issuedStore.issue(generated)
}

interface PreparedIssue {
  qualificationId: string
  runId: string
  bindingSha256: string
  expiresAtUtc: string
  metadata: GeneratedQualifiedClientProfileMetadata
  metadataBytes: Buffer
  metadataSha256: string
  runtimeBytes: Buffer
  runtimeSha256: string
  archiveBytes: Buffer
  archiveSha256: string
  clientPayloadBytes: Buffer
  clientPayloadSha256: string
}

interface StoredObject {
  receipt: IssueReceipt
  metadata: GeneratedQualifiedClientProfileMetadata
  archiveBytes: Buffer
  runtimeBytes: Buffer
  clientPayloadBytes: Buffer
}

export class IssuedQualifiedClientProfileStoreError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'IssuedQualifiedClientProfileStoreError'
    this.code = code
  }
}

/**
 * Durable immutable issue store. qualificationId is the idempotency key;
 * downloadId is generated by the server and only resolves an already-issued
 * object. The archive path is never accepted from an HTTP request.
 */
export class FileSystemIssuedQualifiedClientProfileStore implements IssuedQualifiedClientProfileStore {
  readonly #root: string
  readonly #rootRealPath: string
  readonly #objectsRoot: string
  readonly #objectsRootRealPath: string
  readonly #indexesRoot: string
  readonly #indexesRootRealPath: string
  readonly #locksRoot: string
  readonly #createDownloadId: () => string
  readonly #clock: () => Date
  readonly #maxMetadataBytes: number
  readonly #maxRuntimeBytes: number
  readonly #maxArchiveBytes: number
  readonly #maxClientPayloadBytes: number

  private constructor(
    options: FileSystemIssuedQualifiedClientProfileStoreOptions,
    roots: {
      root: string
      rootRealPath: string
      objectsRoot: string
      objectsRootRealPath: string
      indexesRoot: string
      indexesRootRealPath: string
      locksRoot: string
    }
  ) {
    this.#root = roots.root
    this.#rootRealPath = roots.rootRealPath
    this.#objectsRoot = roots.objectsRoot
    this.#objectsRootRealPath = roots.objectsRootRealPath
    this.#indexesRoot = roots.indexesRoot
    this.#indexesRootRealPath = roots.indexesRootRealPath
    this.#locksRoot = roots.locksRoot
    this.#createDownloadId = options.createDownloadId ?? randomUUID
    this.#clock = options.clock ?? (() => new Date())
    this.#maxMetadataBytes = boundedLimit(options.maxMetadataBytes, 4 * 1024 * 1024)
    this.#maxRuntimeBytes = boundedLimit(options.maxRuntimeBytes, 4 * 1024 * 1024)
    this.#maxArchiveBytes = boundedLimit(options.maxArchiveBytes, 512 * 1024 * 1024)
    this.#maxClientPayloadBytes = boundedLimit(options.maxClientPayloadBytes, 1024 * 1024 * 1024)
  }

  static async open(
    options: FileSystemIssuedQualifiedClientProfileStoreOptions
  ): Promise<FileSystemIssuedQualifiedClientProfileStore> {
    if (!path.isAbsolute(options.protectedRoot)) fail('CLIENT_PROFILE_ISSUE_ROOT_INVALID')
    const configuredRoot = path.resolve(options.protectedRoot)
    const rootStat = await safeLstat(configuredRoot, 'CLIENT_PROFILE_ISSUE_ROOT_INVALID')
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('CLIENT_PROFILE_ISSUE_ROOT_INVALID')
    const rootRealPath = await safeRealpath(configuredRoot, 'CLIENT_PROFILE_ISSUE_ROOT_INVALID')
    const root = rootRealPath
    const objects = await ensureManagedDirectory(root, rootRealPath, 'objects')
    const indexes = await ensureManagedDirectory(root, rootRealPath, 'by-qualification')
    const locks = await ensureManagedDirectory(root, rootRealPath, 'locks')
    return new FileSystemIssuedQualifiedClientProfileStore(options, {
      root,
      rootRealPath,
      objectsRoot: objects.path,
      objectsRootRealPath: objects.realPath,
      indexesRoot: indexes.path,
      indexesRootRealPath: indexes.realPath,
      locksRoot: locks.path
    })
  }

  async issue(generated: GeneratedQualifiedClientProfile): Promise<IssuedQualifiedClientProfileReference> {
    const prepared = prepareIssue(generated)
    if (prepared.metadataBytes.byteLength > this.#maxMetadataBytes ||
        prepared.runtimeBytes.byteLength > this.#maxRuntimeBytes ||
        prepared.archiveBytes.byteLength > this.#maxArchiveBytes ||
        prepared.clientPayloadBytes.byteLength > this.#maxClientPayloadBytes) {
      fail('CLIENT_PROFILE_ISSUE_ARTIFACT_TOO_LARGE')
    }
    const existing = await this.#tryReadIndex(prepared.qualificationId)
    if (existing !== null) return await this.#resolveEquivalent(existing, prepared)

    const lockPath = path.join(this.#locksRoot, `${prepared.qualificationId}.lock`)
    let locked = false
    for (let attempt = 0; attempt < 40 && !locked; attempt += 1) {
      try {
        await mkdir(lockPath, { mode: 0o700 })
        locked = true
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) fail('CLIENT_PROFILE_ISSUE_LOCK_FAILED')
        const raced = await this.#tryReadIndex(prepared.qualificationId)
        if (raced !== null) return await this.#resolveEquivalent(raced, prepared)
        await delay(25)
      }
    }
    if (!locked) fail('CLIENT_PROFILE_ISSUE_BUSY')

    let publishedDownloadId: string | null = null
    try {
      const raced = await this.#tryReadIndex(prepared.qualificationId)
      if (raced !== null) return await this.#resolveEquivalent(raced, prepared)
      const published = await this.#publishObject(prepared)
      publishedDownloadId = published.downloadId
      const indexCore = {
        protocol: ISSUE_INDEX_PROTOCOL,
        schemaVersion: 1 as const,
        qualificationId: prepared.qualificationId,
        bindingSha256: prepared.bindingSha256,
        downloadId: published.downloadId,
        issueReceiptSha256: published.receiptSha256
      }
      const index: IssueIndex = { ...indexCore, indexSha256: sha256Canonical(indexCore) }
      await writeAtomic(this.#indexesRoot, `${prepared.qualificationId}.json`, Buffer.from(canonicalJson(index), 'utf8'))
      publishedDownloadId = null
      return await this.#referenceFor(index)
    } finally {
      await rmdir(lockPath).catch(() => undefined)
      if (publishedDownloadId !== null) await this.#removeUnindexedObject(publishedDownloadId)
    }
  }

  async readMetadata(downloadId: string): Promise<IssuedQualifiedClientProfileReference> {
    assertOpaqueId(downloadId)
    const stored = await this.#readObject(downloadId)
    const index = await this.#readIndex(stored.receipt.qualificationId)
    assertIndexObjectBinding(index, stored.receipt)
    return toReference(index, stored)
  }

  async readArchive(downloadId: string): Promise<IssuedQualifiedClientProfileArchive> {
    assertOpaqueId(downloadId)
    const stored = await this.#readObject(downloadId)
    const index = await this.#readIndex(stored.receipt.qualificationId)
    assertIndexObjectBinding(index, stored.receipt)
    return {
      downloadId,
      fileName: QUALIFIED_CLIENT_PROFILE_ZIP_FILE_NAME,
      mediaType: 'application/zip',
      sizeBytes: stored.receipt.archiveSizeBytes,
      sha256: stored.receipt.archiveSha256,
      bytes: Buffer.from(stored.archiveBytes)
    }
  }

  async readClientPayload(downloadId: string): Promise<IssuedQualifiedNebulaClientArchive> {
    assertOpaqueId(downloadId)
    const stored = await this.#readObject(downloadId)
    const index = await this.#readIndex(stored.receipt.qualificationId)
    assertIndexObjectBinding(index, stored.receipt)
    return {
      downloadId,
      fileName: QUALIFIED_NEBULA_CLIENT_ZIP_FILE_NAME,
      mediaType: 'application/zip',
      sizeBytes: stored.receipt.clientPayloadSizeBytes,
      sha256: stored.receipt.clientPayloadSha256,
      bytes: Buffer.from(stored.clientPayloadBytes)
    }
  }

  async readRuntimeArtifact(downloadId: string): Promise<IssuedQualifiedClientRuntimeArtifact> {
    assertOpaqueId(downloadId)
    const stored = await this.#readObject(downloadId)
    const index = await this.#readIndex(stored.receipt.qualificationId)
    assertIndexObjectBinding(index, stored.receipt)
    return {
      downloadId,
      fileName: RUNTIME_FILE_NAME,
      mediaType: 'application/json',
      sizeBytes: stored.receipt.runtimeSizeBytes,
      sha256: stored.receipt.runtimeSha256,
      bytes: Buffer.from(stored.runtimeBytes)
    }
  }

  async #resolveEquivalent(index: IssueIndex, prepared: PreparedIssue): Promise<IssuedQualifiedClientProfileReference> {
    const stored = await this.#readObject(index.downloadId)
    assertIndexObjectBinding(index, stored.receipt)
    const receipt = stored.receipt
    if (receipt.qualificationId !== prepared.qualificationId || receipt.runId !== prepared.runId ||
        receipt.bindingSha256 !== prepared.bindingSha256 || receipt.expiresAtUtc !== prepared.expiresAtUtc ||
        receipt.metadataSha256 !== prepared.metadataSha256 || receipt.metadataSizeBytes !== prepared.metadataBytes.length ||
        receipt.runtimeSha256 !== prepared.runtimeSha256 || receipt.runtimeSizeBytes !== prepared.runtimeBytes.length ||
        receipt.archiveSha256 !== prepared.archiveSha256 || receipt.archiveSizeBytes !== prepared.archiveBytes.length ||
        receipt.clientPayloadSha256 !== prepared.clientPayloadSha256 ||
        receipt.clientPayloadSizeBytes !== prepared.clientPayloadBytes.length) {
      fail('CLIENT_PROFILE_ISSUE_IDEMPOTENCY_CONFLICT')
    }
    return toReference(index, stored)
  }

  async #referenceFor(index: IssueIndex): Promise<IssuedQualifiedClientProfileReference> {
    const stored = await this.#readObject(index.downloadId)
    assertIndexObjectBinding(index, stored.receipt)
    return toReference(index, stored)
  }

  async #publishObject(prepared: PreparedIssue): Promise<{ downloadId: string; receiptSha256: string }> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const downloadId = this.#createDownloadId()
      assertOpaqueId(downloadId)
      const stagingName = `.staging-${downloadId}-${randomUUID()}`
      const stagingPath = path.join(this.#objectsRoot, stagingName)
      const finalPath = path.join(this.#objectsRoot, downloadId)
      await mkdir(stagingPath, { mode: 0o700 })
      let staged = true
      try {
        const now = this.#clock()
        if (!Number.isFinite(now.getTime())) fail('CLIENT_PROFILE_ISSUE_CLOCK_INVALID')
        const receiptCore = {
          protocol: QUALIFIED_CLIENT_ISSUE_PROTOCOL,
          schemaVersion: 1 as const,
          downloadId,
          qualificationId: prepared.qualificationId,
          runId: prepared.runId,
          bindingSha256: prepared.bindingSha256,
          expiresAtUtc: prepared.expiresAtUtc,
          issuedAtUtc: now.toISOString(),
          metadataSha256: prepared.metadataSha256,
          metadataSizeBytes: prepared.metadataBytes.length,
          archiveSha256: prepared.archiveSha256,
          archiveSizeBytes: prepared.archiveBytes.length,
          clientPayloadSha256: prepared.clientPayloadSha256,
          clientPayloadSizeBytes: prepared.clientPayloadBytes.length,
          runtimeSha256: prepared.runtimeSha256,
          runtimeSizeBytes: prepared.runtimeBytes.length
        }
        const receipt: IssueReceipt = { ...receiptCore, receiptSha256: sha256Canonical(receiptCore) }
        parseWithSchema(issueReceiptSchema, receipt, 'CLIENT_PROFILE_ISSUE_RECEIPT_INVALID')
        await writeExclusive(path.join(stagingPath, QUALIFIED_CLIENT_PROFILE_ZIP_FILE_NAME), prepared.archiveBytes)
        await writeExclusive(path.join(stagingPath, QUALIFIED_NEBULA_CLIENT_ZIP_FILE_NAME), prepared.clientPayloadBytes)
        await writeExclusive(path.join(stagingPath, RUNTIME_FILE_NAME), prepared.runtimeBytes)
        await writeExclusive(path.join(stagingPath, METADATA_FILE_NAME), prepared.metadataBytes)
        await writeExclusive(path.join(stagingPath, RECEIPT_FILE_NAME), Buffer.from(canonicalJson(receipt), 'utf8'))
        try {
          await rename(stagingPath, finalPath)
          staged = false
          return { downloadId, receiptSha256: receipt.receiptSha256 }
        } catch (error) {
          if (!hasCode(error, 'EEXIST') && !hasCode(error, 'ENOTEMPTY')) {
            fail('CLIENT_PROFILE_ISSUE_PUBLISH_FAILED')
          }
        }
      } finally {
        if (staged) await removeKnownObjectFiles(stagingPath)
      }
    }
    return fail('CLIENT_PROFILE_ISSUE_DOWNLOAD_ID_COLLISION')
  }

  async #tryReadIndex(qualificationId: string): Promise<IssueIndex | null> {
    assertOpaqueId(qualificationId)
    const file = path.join(this.#indexesRoot, `${qualificationId}.json`)
    try {
      return await this.#parseIndex(await readBounded(
        file, 64 * 1024, this.#indexesRoot, this.#indexesRootRealPath))
    } catch (error) {
      if (error instanceof IssuedQualifiedClientProfileStoreError &&
          error.code === 'CLIENT_PROFILE_ISSUE_FILE_NOT_FOUND') return null
      throw error
    }
  }

  async #readIndex(qualificationId: string): Promise<IssueIndex> {
    const index = await this.#tryReadIndex(qualificationId)
    if (index === null) fail('CLIENT_PROFILE_ISSUE_INDEX_UNAVAILABLE')
    return index
  }

  async #parseIndex(bytes: Uint8Array): Promise<IssueIndex> {
    const index = parseWithSchema(issueIndexSchema,
      parseStrictCanonicalJsonBytes(bytes, 'CLIENT_PROFILE_ISSUE_INDEX_INVALID'),
      'CLIENT_PROFILE_ISSUE_INDEX_INVALID')
    const { indexSha256, ...core } = index
    assertDigestEqual(sha256Canonical(core), indexSha256, 'CLIENT_PROFILE_ISSUE_INDEX_INVALID')
    return index
  }

  async #readObject(downloadId: string): Promise<StoredObject> {
    assertOpaqueId(downloadId)
    const objectPath = path.join(this.#objectsRoot, downloadId)
    const objectStat = await safeLstat(objectPath, 'CLIENT_PROFILE_ISSUE_OBJECT_UNAVAILABLE')
    if (!objectStat.isDirectory() || objectStat.isSymbolicLink()) fail('CLIENT_PROFILE_ISSUE_OBJECT_INVALID')
    const objectRealPath = await safeRealpath(objectPath, 'CLIENT_PROFILE_ISSUE_OBJECT_UNAVAILABLE')
    if (!pathWithin(objectRealPath, this.#objectsRootRealPath) || !samePath(objectPath, objectRealPath)) {
      fail('CLIENT_PROFILE_ISSUE_OBJECT_INVALID')
    }
    const [receiptBytes, metadataBytes, runtimeBytes, archiveBytes, clientPayloadBytes] = await Promise.all([
      readBounded(path.join(objectPath, RECEIPT_FILE_NAME), 64 * 1024, objectPath, objectRealPath),
      readBounded(path.join(objectPath, METADATA_FILE_NAME), this.#maxMetadataBytes, objectPath, objectRealPath),
      readBounded(path.join(objectPath, RUNTIME_FILE_NAME), this.#maxRuntimeBytes, objectPath, objectRealPath),
      readBounded(path.join(objectPath, QUALIFIED_CLIENT_PROFILE_ZIP_FILE_NAME),
        this.#maxArchiveBytes, objectPath, objectRealPath),
      readBounded(path.join(objectPath, QUALIFIED_NEBULA_CLIENT_ZIP_FILE_NAME),
        this.#maxClientPayloadBytes, objectPath, objectRealPath)
    ])
    const receipt = parseWithSchema(issueReceiptSchema, parseStrictCanonicalJsonBytes(
      receiptBytes, 'CLIENT_PROFILE_ISSUE_RECEIPT_INVALID'), 'CLIENT_PROFILE_ISSUE_RECEIPT_INVALID')
    const { receiptSha256, ...receiptCore } = receipt
    assertDigestEqual(sha256Canonical(receiptCore), receiptSha256, 'CLIENT_PROFILE_ISSUE_RECEIPT_INVALID')
    if (receipt.downloadId !== downloadId || receipt.metadataSizeBytes !== metadataBytes.byteLength ||
        receipt.runtimeSizeBytes !== runtimeBytes.byteLength || receipt.archiveSizeBytes !== archiveBytes.byteLength ||
        receipt.clientPayloadSizeBytes !== clientPayloadBytes.byteLength) {
      fail('CLIENT_PROFILE_ISSUE_OBJECT_INVALID')
    }
    assertDigestEqual(sha256Bytes(metadataBytes), receipt.metadataSha256, 'CLIENT_PROFILE_ISSUE_OBJECT_INVALID')
    assertDigestEqual(sha256Bytes(runtimeBytes), receipt.runtimeSha256, 'CLIENT_PROFILE_ISSUE_OBJECT_INVALID')
    assertDigestEqual(sha256Bytes(archiveBytes), receipt.archiveSha256, 'CLIENT_PROFILE_ISSUE_OBJECT_INVALID')
    assertDigestEqual(
      sha256Bytes(clientPayloadBytes), receipt.clientPayloadSha256, 'CLIENT_PROFILE_ISSUE_OBJECT_INVALID')
    const metadata = parseWithSchema(publicMetadataSchema, parseStrictCanonicalJsonBytes(
      metadataBytes, 'CLIENT_PROFILE_ISSUE_METADATA_INVALID'),
    'CLIENT_PROFILE_ISSUE_METADATA_INVALID') as GeneratedQualifiedClientProfileMetadata
    const runtime = parseStrictJsonBytes(runtimeBytes, 'CLIENT_PROFILE_ISSUE_RUNTIME_INVALID')
    if (canonicalJson(runtime) !== canonicalJson(metadata.qualifiedClientRuntime) ||
        metadata.qualification.qualificationId !== receipt.qualificationId ||
        metadata.qualification.runId !== receipt.runId ||
        metadata.qualification.bindingSha256 !== receipt.bindingSha256 ||
        metadata.qualification.expiresAtUtc !== receipt.expiresAtUtc ||
        toPrefixedDigest(metadata.artifacts.profileArchive.sha256) !== receipt.archiveSha256 ||
        metadata.artifacts.profileArchive.sizeBytes !== receipt.archiveSizeBytes ||
        toPrefixedDigest(metadata.artifacts.qualifiedClientPayload.sha256) !== receipt.clientPayloadSha256 ||
        metadata.artifacts.qualifiedClientPayload.sizeBytes !== receipt.clientPayloadSizeBytes ||
        metadata.qualifiedClientRuntime.clientPayload.packageSha256 !== receipt.clientPayloadSha256 ||
        metadata.qualifiedClientRuntime.clientPayload.packageSizeBytes !== receipt.clientPayloadSizeBytes ||
        toPrefixedDigest(metadata.artifacts.qualifiedRuntime.sha256) !== receipt.runtimeSha256 ||
        metadata.artifacts.qualifiedRuntime.sizeBytes !== receipt.runtimeSizeBytes) {
      fail('CLIENT_PROFILE_ISSUE_OBJECT_INVALID')
    }
    return {
      receipt,
      metadata,
      archiveBytes: Buffer.from(archiveBytes),
      runtimeBytes: Buffer.from(runtimeBytes),
      clientPayloadBytes: Buffer.from(clientPayloadBytes)
    }
  }

  async #removeUnindexedObject(downloadId: string): Promise<void> {
    if (!UUID_PATTERN.test(downloadId)) return
    await removeKnownObjectFiles(path.join(this.#objectsRoot, downloadId))
  }
}

function prepareIssue(generated: GeneratedQualifiedClientProfile): PreparedIssue {
  if (generated.productionQualified !== true) fail('CLIENT_PROFILE_ISSUE_NOT_QUALIFIED')
  const qualification = parseWithSchema(clientQualificationProjectionSchema, generated.qualification,
    'CLIENT_PROFILE_ISSUE_QUALIFICATION_INVALID')
  const metadata = parseWithSchema(publicMetadataSchema, projectGeneratedQualifiedClientProfile(generated),
    'CLIENT_PROFILE_ISSUE_METADATA_INVALID') as GeneratedQualifiedClientProfileMetadata
  if (canonicalJson(metadata.qualification) !== canonicalJson(qualification)) {
    fail('CLIENT_PROFILE_ISSUE_QUALIFICATION_MISMATCH')
  }
  const metadataBytes = Buffer.from(canonicalJson(metadata), 'utf8')
  const runtimeBytes = Buffer.from(generated.qualifiedRuntimeArtifact.content, 'utf8')
  const archiveBytes = Buffer.from(generated.profileArchive.bytes)
  const clientPayloadBytes = Buffer.from(generated.qualifiedClientPayload.bytes)
  const archiveSha256 = sha256Bytes(archiveBytes)
  const runtimeSha256 = sha256Bytes(runtimeBytes)
  const clientPayloadSha256 = sha256Bytes(clientPayloadBytes)
  if (generated.profileArchive.fileName !== QUALIFIED_CLIENT_PROFILE_ZIP_FILE_NAME ||
      generated.profileArchive.mediaType !== 'application/zip' ||
      generated.profileArchive.sizeBytes !== archiveBytes.length ||
      toPrefixedDigest(generated.profileArchive.sha256) !== archiveSha256 ||
      generated.qualifiedClientPayload.fileName !== QUALIFIED_NEBULA_CLIENT_ZIP_FILE_NAME ||
      generated.qualifiedClientPayload.mediaType !== 'application/zip' ||
      generated.qualifiedClientPayload.sizeBytes !== clientPayloadBytes.length ||
      toPrefixedDigest(generated.qualifiedClientPayload.sha256) !== clientPayloadSha256 ||
      generated.qualifiedClientPayload.sha256 !== generated.qualifiedClientRuntime.clientPayload.packageSha256 ||
      generated.qualifiedRuntimeArtifact.entryName !== RUNTIME_FILE_NAME ||
      generated.qualifiedRuntimeArtifact.mediaType !== 'application/json' ||
      generated.qualifiedRuntimeArtifact.sizeBytes !== runtimeBytes.length ||
      toPrefixedDigest(generated.qualifiedRuntimeArtifact.sha256) !== runtimeSha256 ||
      canonicalJson(parseStrictJsonBytes(runtimeBytes, 'CLIENT_PROFILE_ISSUE_RUNTIME_INVALID')) !==
        canonicalJson(metadata.qualifiedClientRuntime)) {
    fail('CLIENT_PROFILE_ISSUE_ARTIFACT_INVALID')
  }
  return {
    qualificationId: qualification.qualificationId,
    runId: qualification.runId,
    bindingSha256: qualification.bindingSha256,
    expiresAtUtc: qualification.expiresAtUtc,
    metadata,
    metadataBytes,
    metadataSha256: sha256Bytes(metadataBytes),
    runtimeBytes,
    runtimeSha256,
    archiveBytes,
    archiveSha256,
    clientPayloadBytes,
    clientPayloadSha256
  }
}

function toReference(index: IssueIndex, stored: StoredObject): IssuedQualifiedClientProfileReference {
  return {
    downloadId: index.downloadId,
    issueReceiptSha256: index.issueReceiptSha256,
    qualificationId: stored.receipt.qualificationId,
    bindingSha256: stored.receipt.bindingSha256,
    expiresAtUtc: stored.receipt.expiresAtUtc,
    metadata: stored.metadata,
    archive: {
      fileName: QUALIFIED_CLIENT_PROFILE_ZIP_FILE_NAME,
      mediaType: 'application/zip',
      sizeBytes: stored.receipt.archiveSizeBytes,
      sha256: stored.receipt.archiveSha256
    }
  }
}

function assertIndexObjectBinding(index: IssueIndex, receipt: IssueReceipt): void {
  if (index.qualificationId !== receipt.qualificationId || index.bindingSha256 !== receipt.bindingSha256 ||
      index.downloadId !== receipt.downloadId || index.issueReceiptSha256 !== receipt.receiptSha256) {
    fail('CLIENT_PROFILE_ISSUE_INDEX_BINDING_INVALID')
  }
}

async function ensureManagedDirectory(
  root: string,
  rootRealPath: string,
  name: string
): Promise<{ path: string; realPath: string }> {
  const child = path.join(root, name)
  await mkdir(child, { mode: 0o700 }).catch((error: unknown) => {
    if (!hasCode(error, 'EEXIST')) fail('CLIENT_PROFILE_ISSUE_ROOT_INVALID')
  })
  const stat = await safeLstat(child, 'CLIENT_PROFILE_ISSUE_ROOT_INVALID')
  const childRealPath = await safeRealpath(child, 'CLIENT_PROFILE_ISSUE_ROOT_INVALID')
  if (!stat.isDirectory() || stat.isSymbolicLink() || !pathWithin(childRealPath, rootRealPath) ||
      !samePath(child, childRealPath)) fail('CLIENT_PROFILE_ISSUE_ROOT_INVALID')
  return { path: child, realPath: childRealPath }
}

async function writeExclusive(file: string, bytes: Uint8Array): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(file, 'wx', 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
  } catch (error) {
    if (error instanceof IssuedQualifiedClientProfileStoreError) throw error
    return fail('CLIENT_PROFILE_ISSUE_WRITE_FAILED')
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function writeAtomic(root: string, fileName: string, bytes: Uint8Array): Promise<void> {
  const temporary = path.join(root, `.partial-${fileName}-${randomUUID()}`)
  const target = path.join(root, fileName)
  try {
    await writeExclusive(temporary, bytes)
    await rename(temporary, target)
  } catch (error) {
    if (error instanceof IssuedQualifiedClientProfileStoreError) throw error
    return fail('CLIENT_PROFILE_ISSUE_WRITE_FAILED')
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

async function readBounded(
  candidate: string,
  maximumBytes: number,
  parent: string,
  parentRealPath: string
): Promise<Uint8Array> {
  const absolute = path.resolve(candidate)
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    if (!pathWithin(absolute, parent)) fail('CLIENT_PROFILE_ISSUE_PATH_ESCAPE')
    const stat = await lstat(absolute)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximumBytes) {
      fail('CLIENT_PROFILE_ISSUE_FILE_INVALID')
    }
    const resolved = await realpath(absolute)
    if (!pathWithin(resolved, parentRealPath) || !samePath(absolute, resolved)) {
      fail('CLIENT_PROFILE_ISSUE_PATH_ESCAPE')
    }
    handle = await open(absolute, 'r')
    const before = await handle.stat()
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (!before.isFile() || before.size !== stat.size || bytes.byteLength !== before.size ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      fail('CLIENT_PROFILE_ISSUE_FILE_CHANGED')
    }
    return bytes
  } catch (error) {
    if (error instanceof IssuedQualifiedClientProfileStoreError) throw error
    if (hasCode(error, 'ENOENT')) return fail('CLIENT_PROFILE_ISSUE_FILE_NOT_FOUND')
    return fail('CLIENT_PROFILE_ISSUE_FILE_UNAVAILABLE')
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function removeKnownObjectFiles(directory: string): Promise<void> {
  for (const fileName of [RECEIPT_FILE_NAME, METADATA_FILE_NAME, RUNTIME_FILE_NAME,
    QUALIFIED_NEBULA_CLIENT_ZIP_FILE_NAME, QUALIFIED_CLIENT_PROFILE_ZIP_FILE_NAME]) {
    await unlink(path.join(directory, fileName)).catch(() => undefined)
  }
  await rmdir(directory).catch(() => undefined)
}

function toPrefixedDigest(value: string): string {
  if (/^[0-9a-f]{64}$/.test(value)) return `sha256:${value}`
  if (/^sha256:[0-9a-f]{64}$/.test(value)) return value
  return fail('CLIENT_PROFILE_ISSUE_DIGEST_INVALID')
}

function assertOpaqueId(value: string): void {
  if (!UUID_PATTERN.test(value)) fail('CLIENT_PROFILE_ISSUE_ID_INVALID')
}

function boundedLimit(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 2 * 1024 * 1024 * 1024) {
    fail('CLIENT_PROFILE_ISSUE_LIMIT_INVALID')
  }
  return selected
}

async function safeLstat(value: string, code: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  try {
    return await lstat(value)
  } catch {
    return fail(code)
  }
}

async function safeRealpath(value: string, code: string): Promise<string> {
  try {
    return await realpath(value)
  } catch {
    return fail(code)
  }
}

function pathWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right)
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function parseWithSchema<T>(schema: { parse(value: unknown): T }, value: unknown, code: string): T {
  try {
    return schema.parse(value)
  } catch {
    return fail(code)
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

function fail(code: string): never {
  throw new IssuedQualifiedClientProfileStoreError(code)
}

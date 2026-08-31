import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { constants } from 'node:fs'
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rmdir,
  statfs,
  unlink
} from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { hostname, uptime } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { verifyBackupPair } from './backups.js'
import { resolveNormalBackupDirectory, resolveNormalDirectory, safeImmediateChild } from './boundary.js'
import {
  canonicalManifestBytes,
  defaultSavePairTransportLimits,
  SaveTransferError,
  savePairTransportManifestSchema,
  verifySavePairTransportArchive,
  writeSavePairTransportArchive,
  type SavePairTransportFileSink,
  type SavePairTransportLimits,
  type SavePairTransportManifest,
  type SavePairTransportSourceEntry,
  type SavePairTransportWriteResult
} from './transfer-format.js'
import { backupIdSchema, backupManifestV1Schema, type BackupManifestV1 } from './schemas.js'

const requestIdSchema = z.string().uuid()
const sha256Schema = z.string().length(64).regex(/^[a-f0-9]{64}$/)
const isoDateSchema = z.string().datetime({ offset: true })
const receiptMaximumBytes = 16 * 1024
const rootChildNames = Object.freeze({
  exports: 'exports',
  inbox: 'inbox',
  receipts: 'receipts',
  staging: 'staging'
})

const exportRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  backupId: backupIdSchema
})
const importRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  declaredBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().length(64).regex(/^[a-fA-F0-9]{64}$/)
})
const openExportRequestSchema = z.strictObject({ requestId: requestIdSchema })

const exportReceiptSchema = z.strictObject({
  format: z.literal('dyson-control-save-transfer-receipt'),
  schemaVersion: z.literal(1),
  operation: z.literal('export'),
  requestId: requestIdSchema,
  backupId: backupIdSchema,
  archiveId: z.string().regex(/^export-[0-9a-f-]{36}$/),
  saveName: z.string().min(1).max(120),
  archiveBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  archiveSha256: sha256Schema,
  completedAt: isoDateSchema,
  restoreExecuted: z.literal(false),
  reused: z.boolean()
})
const importReceiptSchema = z.strictObject({
  format: z.literal('dyson-control-save-transfer-receipt'),
  schemaVersion: z.literal(1),
  operation: z.literal('import'),
  requestId: requestIdSchema,
  inboxId: z.string().regex(/^import-[0-9a-f-]{36}$/),
  saveName: z.string().min(1).max(120),
  archiveBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  archiveSha256: sha256Schema,
  dsvBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  serverBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  completedAt: isoDateSchema,
  restoreExecuted: z.literal(false),
  reused: z.boolean()
})
const exportEnvelopeSchema = z.strictObject({
  format: z.literal('dyson-control-save-transfer-receipt-envelope'),
  schemaVersion: z.literal(1),
  requestFingerprint: sha256Schema,
  receipt: exportReceiptSchema
})
const importEnvelopeSchema = z.strictObject({
  format: z.literal('dyson-control-save-transfer-receipt-envelope'),
  schemaVersion: z.literal(1),
  requestFingerprint: sha256Schema,
  receipt: importReceiptSchema
})

export type SavePairExportReceipt = z.infer<typeof exportReceiptSchema>
export type SavePairImportReceipt = z.infer<typeof importReceiptSchema>

export interface SavePairTransferServiceOptions {
  /** Fixed server-side roots. Request bodies never select filesystem paths. */
  backupRoot: string
  transportRoot: string
  limits?: Partial<SavePairTransportLimits>
  reserveFreeBytes?: number
  now?: () => Date
  availableBytes?: (fixedRoot: string) => Promise<number>
}

export interface SavePairExportDownload {
  receipt: SavePairExportReceipt
  source: AsyncIterable<Uint8Array>
}

interface PreparedTransferRoots {
  backupRoot: string
  transportRoot: string
  exportRoot: string
  inboxRoot: string
  receiptRoot: string
  stagingRoot: string
}

interface TrustedBackupSource {
  directory: string
  manifest: BackupManifestV1
  manifestSha256: string
  dsv: BackupManifestV1['files'][number]
  server: BackupManifestV1['files'][number]
}

interface ImportStage {
  directory: string
  ownedFiles: Set<string>
}

/**
 * Fixed-root save-pair transfer service. Import publishes only to quarantine;
 * there is intentionally no restore, active-save overwrite, or arbitrary path.
 */
export class SavePairTransferService {
  readonly #backupRoot: string
  readonly #transportRoot: string
  readonly #limits: SavePairTransportLimits
  readonly #reserveFreeBytes: number
  readonly #now: () => Date
  readonly #availableBytes: (fixedRoot: string) => Promise<number>
  #tail: Promise<void> = Promise.resolve()

  constructor(options: SavePairTransferServiceOptions) {
    if (!options || !path.isAbsolute(options.backupRoot) || !path.isAbsolute(options.transportRoot)) {
      throw new SaveTransferError('SAVE_TRANSFER_ROOT_INVALID')
    }
    this.#backupRoot = path.resolve(options.backupRoot)
    this.#transportRoot = path.resolve(options.transportRoot)
    if (pathsOverlap(this.#backupRoot, this.#transportRoot)) {
      throw new SaveTransferError('SAVE_TRANSFER_ROOT_COLLISION')
    }
    this.#limits = { ...defaultSavePairTransportLimits, ...options.limits }
    this.#reserveFreeBytes = options.reserveFreeBytes ?? 256 * 1024 * 1024
    if (!Number.isSafeInteger(this.#reserveFreeBytes) || this.#reserveFreeBytes < 0 ||
        this.#reserveFreeBytes > 64 * 1024 * 1024 * 1024) {
      throw new SaveTransferError('SAVE_TRANSFER_LIMITS_INVALID')
    }
    this.#now = options.now ?? (() => new Date())
    this.#availableBytes = options.availableBytes ?? availableFilesystemBytes
  }

  async exportBackup(input: unknown): Promise<SavePairExportReceipt> {
    const request = parseExportRequest(input)
    return await this.#serialize(async () => {
      const roots = await prepareRoots(this.#backupRoot, this.#transportRoot)
      return await withTransferLock(roots, async () => {
        const fingerprint = requestFingerprint('export', request)
        const existing = await readExportEnvelope(roots, request.requestId)
        if (existing !== null) {
          if (existing.requestFingerprint !== fingerprint || existing.receipt.backupId !== request.backupId) {
            throw new SaveTransferError('SAVE_TRANSFER_IDEMPOTENCY_CONFLICT')
          }
          await verifyPublishedExport(roots, existing.receipt, this.#limits)
          return { ...existing.receipt, reused: true }
        }

        const finalPath = exportArchivePath(roots, request.requestId)
        if (await pathExists(finalPath)) {
          const recovered = await recoverOrphanExport(
            roots,
            request,
            finalPath,
            this.#limits,
            this.#timestamp()
          )
          await persistExportEnvelope(roots, fingerprint, recovered)
          return { ...recovered, reused: true }
        }

        const trusted = await readTrustedBackupSource(roots.backupRoot, request.backupId)
        await this.#requireSpace(roots.stagingRoot, trusted.dsv.bytes + trusted.server.bytes + 1024 * 1024)
        const manifest = buildTransportManifest(trusted)
        const stagePath = safeImmediateChild(
          roots.stagingRoot,
          `.export-${request.requestId}-${randomUUID()}.partial`
        )
        let sink: FileHandleSink | null = null
        try {
          sink = await FileHandleSink.create(stagePath)
          const result = await writeSavePairTransportArchive({
            manifest,
            entries: [
              transportSourceEntry(trusted.directory, trusted.dsv, this.#limits.maximumInputChunkBytes),
              transportSourceEntry(trusted.directory, trusted.server, this.#limits.maximumInputChunkBytes)
            ],
            sink,
            limits: this.#limits
          })
          await sink.close()
          sink = null

          const verified = await verifyFixedArchive(stagePath, result, this.#limits)
          if (JSON.stringify(verified.manifest) !== JSON.stringify(manifest)) {
            throw new SaveTransferError('SAVE_TRANSFER_EXPORT_VERIFICATION_FAILED')
          }
          const after = await readTrustedBackupSource(roots.backupRoot, request.backupId)
          if (!sameTrustedBackup(trusted, after)) throw new SaveTransferError('SAVE_TRANSFER_SOURCE_CHANGED')

          await publishFileWithoutOverwrite(stagePath, finalPath)
          const receipt = exportReceiptSchema.parse({
            format: 'dyson-control-save-transfer-receipt',
            schemaVersion: 1,
            operation: 'export',
            requestId: request.requestId,
            backupId: request.backupId,
            archiveId: `export-${request.requestId}`,
            saveName: manifest.saveName,
            archiveBytes: result.bytes,
            archiveSha256: result.sha256,
            completedAt: this.#timestamp(),
            restoreExecuted: false,
            reused: false
          })
          await persistExportEnvelope(roots, fingerprint, receipt)
          return receipt
        } catch (error) {
          await sink?.abort().catch(() => undefined)
          await unlink(stagePath).catch(() => undefined)
          throw normalizeTransferError(error)
        }
      })
    })
  }

  async openExport(input: unknown): Promise<SavePairExportDownload> {
    const request = parseOpenExportRequest(input)
    const roots = await prepareRoots(this.#backupRoot, this.#transportRoot)
    const envelope = await readExportEnvelope(roots, request.requestId)
    if (envelope === null) throw new SaveTransferError('SAVE_TRANSFER_EXPORT_NOT_FOUND')
    await verifyPublishedExport(roots, envelope.receipt, this.#limits)
    const archivePath = exportArchivePath(roots, request.requestId)
    return {
      receipt: { ...envelope.receipt, reused: true },
      source: stableFileSource(archivePath, {
        bytes: envelope.receipt.archiveBytes,
        sha256: envelope.receipt.archiveSha256
      }, this.#limits.maximumInputChunkBytes)
    }
  }

  async importArchive(input: unknown, source: AsyncIterable<Uint8Array>): Promise<SavePairImportReceipt> {
    const request = parseImportRequest(input)
    if (source === null || typeof source !== 'object' || !(Symbol.asyncIterator in source)) {
      throw new SaveTransferError('SAVE_TRANSFER_REQUEST_INVALID')
    }
    return await this.#serialize(async () => {
      const roots = await prepareRoots(this.#backupRoot, this.#transportRoot)
      return await withTransferLock(roots, async () => {
        const fingerprint = requestFingerprint('import', request)
        const existing = await readImportEnvelope(roots, request.requestId)
        if (existing !== null) {
          if (existing.requestFingerprint !== fingerprint ||
              existing.receipt.archiveBytes !== request.declaredBytes ||
              existing.receipt.archiveSha256 !== request.sha256) {
            throw new SaveTransferError('SAVE_TRANSFER_IDEMPOTENCY_CONFLICT')
          }
          await verifyPublishedImport(roots, existing, this.#limits)
          return { ...existing.receipt, reused: true }
        }

        const finalDirectory = importInboxPath(roots, request.requestId)
        if (await pathExists(finalDirectory)) {
          const recovered = await recoverOrphanImport(roots, request, fingerprint, this.#limits)
          await persistImportEnvelope(roots, fingerprint, recovered)
          return { ...recovered, reused: true }
        }

        await this.#requireSpace(roots.stagingRoot, request.declaredBytes)
        const stage = await createImportStage(roots, request.requestId)
        try {
          const verified = await verifySavePairTransportArchive({
            source,
            declaredBytes: request.declaredBytes,
            declaredSha256: request.sha256,
            limits: this.#limits,
            createFileSink: async (file) => {
              const filePath = safeImmediateChild(stage.directory, file.name)
              stage.ownedFiles.add(filePath)
              return await ImportFileSink.create(filePath, file.bytes)
            }
          })
          const manifestPath = safeImmediateChild(stage.directory, 'manifest.json')
          stage.ownedFiles.add(manifestPath)
          await writeSmallOwnedFile(manifestPath, canonicalManifestBytes(verified.manifest))
          const receipt = importReceiptSchema.parse({
            format: 'dyson-control-save-transfer-receipt',
            schemaVersion: 1,
            operation: 'import',
            requestId: request.requestId,
            inboxId: `import-${request.requestId}`,
            saveName: verified.manifest.saveName,
            archiveBytes: verified.archiveBytes,
            archiveSha256: verified.archiveSha256,
            dsvBytes: verified.manifest.files[0]!.bytes,
            serverBytes: verified.manifest.files[1]!.bytes,
            completedAt: this.#timestamp(),
            restoreExecuted: false,
            reused: false
          })
          const metadataPath = safeImmediateChild(stage.directory, '.import-receipt.json')
          stage.ownedFiles.add(metadataPath)
          await writeSmallOwnedFile(metadataPath, receiptEnvelopeBytes(fingerprint, receipt))
          await verifyImportDirectory(stage.directory, fingerprint, receipt, this.#limits)
          await publishDirectoryWithoutOverwrite(stage.directory, finalDirectory)
          await persistImportEnvelope(roots, fingerprint, receipt)
          return receipt
        } catch (error) {
          await cleanupImportStage(stage).catch(() => undefined)
          throw normalizeTransferError(error)
        }
      })
    })
  }

  async #requireSpace(fixedRoot: string, neededBytes: number): Promise<void> {
    if (!Number.isSafeInteger(neededBytes) || neededBytes < 0 ||
        neededBytes > this.#limits.maximumArchiveBytes) {
      throw new SaveTransferError('SAVE_TRANSFER_ARCHIVE_TOO_LARGE')
    }
    let available: number
    try {
      available = await this.#availableBytes(fixedRoot)
    } catch (error) {
      throw new SaveTransferError('SAVE_TRANSFER_SPACE_UNAVAILABLE', { cause: error })
    }
    if (!Number.isSafeInteger(available) || available < 0) {
      throw new SaveTransferError('SAVE_TRANSFER_SPACE_UNAVAILABLE')
    }
    if (available < neededBytes + this.#reserveFreeBytes) {
      throw new SaveTransferError('SAVE_TRANSFER_SPACE_INSUFFICIENT')
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

function parseExportRequest(input: unknown): z.infer<typeof exportRequestSchema> {
  try {
    return exportRequestSchema.parse(input)
  } catch (error) {
    throw new SaveTransferError('SAVE_TRANSFER_REQUEST_INVALID', { cause: error })
  }
}

function parseImportRequest(input: unknown): z.infer<typeof importRequestSchema> {
  try {
    const parsed = importRequestSchema.parse(input)
    return { ...parsed, sha256: parsed.sha256.toLowerCase() }
  } catch (error) {
    throw new SaveTransferError('SAVE_TRANSFER_REQUEST_INVALID', { cause: error })
  }
}

function parseOpenExportRequest(input: unknown): z.infer<typeof openExportRequestSchema> {
  try {
    return openExportRequestSchema.parse(input)
  } catch (error) {
    throw new SaveTransferError('SAVE_TRANSFER_REQUEST_INVALID', { cause: error })
  }
}

async function prepareRoots(backupRoot: string, transportRoot: string): Promise<PreparedTransferRoots> {
  let preparedBackup: string
  let preparedTransport: string
  try {
    preparedBackup = await resolveNormalDirectory(backupRoot)
    await mkdir(transportRoot, { recursive: true, mode: 0o700 })
    preparedTransport = await resolveNormalDirectory(transportRoot)
  } catch (error) {
    throw new SaveTransferError('SAVE_TRANSFER_ROOT_UNAVAILABLE', { cause: error })
  }
  if (pathsOverlap(preparedBackup, preparedTransport)) throw new SaveTransferError('SAVE_TRANSFER_ROOT_COLLISION')
  const [exportRoot, inboxRoot, receiptRoot, stagingRoot] = await Promise.all([
    ensureNormalChildDirectory(preparedTransport, rootChildNames.exports),
    ensureNormalChildDirectory(preparedTransport, rootChildNames.inbox),
    ensureNormalChildDirectory(preparedTransport, rootChildNames.receipts),
    ensureNormalChildDirectory(preparedTransport, rootChildNames.staging)
  ])
  return {
    backupRoot: preparedBackup,
    transportRoot: preparedTransport,
    exportRoot,
    inboxRoot,
    receiptRoot,
    stagingRoot
  }
}

async function ensureNormalChildDirectory(root: string, name: string): Promise<string> {
  const child = safeImmediateChild(root, name)
  try {
    await mkdir(child, { mode: 0o700 })
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error
  }
  return await resolveNormalDirectory(child)
}

async function readTrustedBackupSource(backupRoot: string, backupId: string): Promise<TrustedBackupSource> {
  let verification
  try {
    verification = await verifyBackupPair({ backupRoot, backupId })
  } catch (error) {
    throw new SaveTransferError('SAVE_TRANSFER_BACKUP_UNAVAILABLE', { cause: error })
  }
  if (verification.health !== 'healthy' || !verification.manifestValid || !verification.pairPresent ||
      verification.saveName === null || verification.createdAt === null) {
    throw new SaveTransferError('SAVE_TRANSFER_BACKUP_UNHEALTHY')
  }
  const directory = await resolveNormalBackupDirectory(backupRoot, backupId)
  const manifestPath = safeImmediateChild(directory, 'manifest.json')
  const manifestFile = await readStableSmallFile(manifestPath, 16 * 1024)
  let manifest: BackupManifestV1
  try {
    manifest = backupManifestV1Schema.parse(JSON.parse(manifestFile.bytes.toString('utf8')) as unknown)
  } catch (error) {
    throw new SaveTransferError('SAVE_TRANSFER_BACKUP_MANIFEST_INVALID', { cause: error })
  }
  if (backupId !== `tx-${manifest.requestId.toLocaleLowerCase('en-US')}` ||
      manifest.saveName !== verification.saveName || manifest.createdAt !== verification.createdAt) {
    throw new SaveTransferError('SAVE_TRANSFER_BACKUP_MANIFEST_INVALID')
  }
  const dsv = manifest.files.find((entry) => entry.name === `${manifest.saveName}.dsv`)
  const server = manifest.files.find((entry) => entry.name === `${manifest.saveName}.server`)
  if (dsv === undefined || server === undefined || dsv.bytes <= 0 || server.bytes <= 0) {
    throw new SaveTransferError('SAVE_TRANSFER_BACKUP_MANIFEST_INVALID')
  }
  return {
    directory,
    manifest,
    manifestSha256: createHash('sha256').update(manifestFile.bytes).digest('hex'),
    dsv: { ...dsv, sha256: dsv.sha256.toLowerCase() },
    server: { ...server, sha256: server.sha256.toLowerCase() }
  }
}

function buildTransportManifest(source: TrustedBackupSource): SavePairTransportManifest {
  return savePairTransportManifestSchema.parse({
    format: 'dyson-control-save-pair-transport',
    schemaVersion: 1,
    saveName: source.manifest.saveName,
    generatedAt: source.manifest.createdAt,
    generation: { strategy: 'source-backup-created-at' },
    source: {
      kind: 'verified-backup',
      backupId: `tx-${source.manifest.requestId.toLocaleLowerCase('en-US')}`,
      createdAt: source.manifest.createdAt,
      manifestSha256: source.manifestSha256
    },
    files: [
      { name: source.dsv.name, bytes: source.dsv.bytes, sha256: source.dsv.sha256.toLowerCase() },
      { name: source.server.name, bytes: source.server.bytes, sha256: source.server.sha256.toLowerCase() }
    ]
  })
}

function transportSourceEntry(
  directory: string,
  expected: BackupManifestV1['files'][number],
  chunkBytes: number
): SavePairTransportSourceEntry {
  const filePath = safeImmediateChild(directory, expected.name)
  return {
    name: expected.name,
    bytes: expected.bytes,
    sha256: expected.sha256.toLowerCase(),
    source: stableFileSource(filePath, {
      bytes: expected.bytes,
      sha256: expected.sha256.toLowerCase()
    }, chunkBytes)
  }
}

async function* stableFileSource(
  filePath: string,
  expected: { bytes: number; sha256: string },
  chunkBytes: number
): AsyncIterable<Uint8Array> {
  await assertNormalFilePath(filePath)
  const handle = await open(filePath, 'r')
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || Number(before.size) !== expected.bytes) {
      throw new SaveTransferError('SAVE_TRANSFER_SOURCE_CHANGED')
    }
    const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, 1024 * 1024))
    const digest = createHash('sha256')
    let position = 0
    while (position < expected.bytes) {
      const length = Math.min(buffer.length, expected.bytes - position)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      if (bytesRead === 0) throw new SaveTransferError('SAVE_TRANSFER_SOURCE_CHANGED')
      const chunk = Buffer.from(buffer.subarray(0, bytesRead))
      digest.update(chunk)
      position += bytesRead
      yield chunk
    }
    const after = await handle.stat({ bigint: true })
    await assertNormalFilePath(filePath)
    if (!sameSnapshot(before, after) || position !== expected.bytes || digest.digest('hex') !== expected.sha256) {
      throw new SaveTransferError('SAVE_TRANSFER_SOURCE_CHANGED')
    }
  } finally {
    await handle.close()
  }
}

async function verifyFixedArchive(
  archivePath: string,
  expected: SavePairTransportWriteResult,
  limits: SavePairTransportLimits
) {
  await assertNormalFilePath(archivePath)
  return await verifySavePairTransportArchive({
    source: createReadStream(archivePath, { highWaterMark: Math.min(limits.maximumInputChunkBytes, 1024 * 1024) }),
    declaredBytes: expected.bytes,
    declaredSha256: expected.sha256,
    limits
  })
}

async function verifyPublishedExport(
  roots: PreparedTransferRoots,
  receipt: SavePairExportReceipt,
  limits: SavePairTransportLimits
): Promise<void> {
  const archivePath = exportArchivePath(roots, receipt.requestId)
  const verified = await verifyFixedArchive(archivePath, {
    bytes: receipt.archiveBytes,
    sha256: receipt.archiveSha256
  }, limits)
  if (verified.manifest.source.backupId !== receipt.backupId || verified.manifest.saveName !== receipt.saveName) {
    throw new SaveTransferError('SAVE_TRANSFER_STATE_INVALID')
  }
}

async function recoverOrphanExport(
  roots: PreparedTransferRoots,
  request: z.infer<typeof exportRequestSchema>,
  finalPath: string,
  limits: SavePairTransportLimits,
  completedAt: string
): Promise<SavePairExportReceipt> {
  const evidence = await hashStableFile(finalPath, limits.maximumArchiveBytes)
  const verified = await verifyFixedArchive(finalPath, evidence, limits)
  if (verified.manifest.source.backupId !== request.backupId) {
    throw new SaveTransferError('SAVE_TRANSFER_IDEMPOTENCY_CONFLICT')
  }
  return exportReceiptSchema.parse({
    format: 'dyson-control-save-transfer-receipt',
    schemaVersion: 1,
    operation: 'export',
    requestId: request.requestId,
    backupId: request.backupId,
    archiveId: `export-${request.requestId}`,
    saveName: verified.manifest.saveName,
    archiveBytes: evidence.bytes,
    archiveSha256: evidence.sha256,
    completedAt,
    restoreExecuted: false,
    reused: false
  })
}

async function createImportStage(roots: PreparedTransferRoots, requestId: string): Promise<ImportStage> {
  const directory = safeImmediateChild(roots.stagingRoot, `.import-${requestId}-${randomUUID()}`)
  await mkdir(directory, { mode: 0o700 })
  return { directory: await resolveNormalDirectory(directory), ownedFiles: new Set() }
}

async function verifyImportDirectory(
  directory: string,
  fingerprint: string,
  receipt: SavePairImportReceipt,
  limits: SavePairTransportLimits
): Promise<void> {
  const resolved = await resolveNormalDirectory(directory)
  const manifestFile = await readStableSmallFile(safeImmediateChild(resolved, 'manifest.json'), limits.maximumManifestBytes)
  let manifest: SavePairTransportManifest
  try {
    manifest = savePairTransportManifestSchema.parse(JSON.parse(manifestFile.bytes.toString('utf8')) as unknown)
  } catch (error) {
    throw new SaveTransferError('SAVE_TRANSFER_STATE_INVALID', { cause: error })
  }
  if (!manifestFile.bytes.equals(canonicalManifestBytes(manifest)) || manifest.saveName !== receipt.saveName ||
      manifest.files[0]?.bytes !== receipt.dsvBytes || manifest.files[1]?.bytes !== receipt.serverBytes) {
    throw new SaveTransferError('SAVE_TRANSFER_STATE_INVALID')
  }
  for (const file of manifest.files) {
    const evidence = await hashStableFile(safeImmediateChild(resolved, file.name), limits.maximumFileBytes)
    if (evidence.bytes !== file.bytes || evidence.sha256 !== file.sha256) {
      throw new SaveTransferError('SAVE_TRANSFER_STATE_INVALID')
    }
  }
  const metadata = await readImportMetadata(resolved)
  if (metadata.requestFingerprint !== fingerprint || JSON.stringify(metadata.receipt) !== JSON.stringify(receipt)) {
    throw new SaveTransferError('SAVE_TRANSFER_STATE_INVALID')
  }
}

async function verifyPublishedImport(
  roots: PreparedTransferRoots,
  envelope: z.infer<typeof importEnvelopeSchema>,
  limits: SavePairTransportLimits
): Promise<void> {
  await verifyImportDirectory(
    importInboxPath(roots, envelope.receipt.requestId),
    envelope.requestFingerprint,
    { ...envelope.receipt, reused: false },
    limits
  )
}

async function recoverOrphanImport(
  roots: PreparedTransferRoots,
  request: z.infer<typeof importRequestSchema>,
  fingerprint: string,
  limits: SavePairTransportLimits
): Promise<SavePairImportReceipt> {
  const directory = importInboxPath(roots, request.requestId)
  const metadata = await readImportMetadata(directory)
  if (metadata.requestFingerprint !== fingerprint ||
      metadata.receipt.archiveBytes !== request.declaredBytes ||
      metadata.receipt.archiveSha256 !== request.sha256) {
    throw new SaveTransferError('SAVE_TRANSFER_IDEMPOTENCY_CONFLICT')
  }
  await verifyImportDirectory(directory, fingerprint, metadata.receipt, limits)
  return metadata.receipt
}

async function readImportMetadata(directory: string): Promise<z.infer<typeof importEnvelopeSchema>> {
  const raw = await readStableSmallFile(safeImmediateChild(directory, '.import-receipt.json'), receiptMaximumBytes)
  try {
    return importEnvelopeSchema.parse(JSON.parse(raw.bytes.toString('utf8')) as unknown)
  } catch (error) {
    throw new SaveTransferError('SAVE_TRANSFER_STATE_INVALID', { cause: error })
  }
}

async function cleanupImportStage(stage: ImportStage): Promise<void> {
  let info
  try {
    info = await lstat(stage.directory)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return
    throw error
  }
  if (info.isSymbolicLink()) {
    await unlink(stage.directory)
    return
  }
  if (!info.isDirectory() || !samePath(await realpath(stage.directory), stage.directory)) {
    throw new SaveTransferError('SAVE_TRANSFER_STAGE_INVALID')
  }
  for (const filePath of stage.ownedFiles) await unlink(filePath).catch(() => undefined)
  await rmdir(stage.directory)
}

async function publishFileWithoutOverwrite(stagePath: string, finalPath: string): Promise<void> {
  if (await pathExists(finalPath)) throw new SaveTransferError('SAVE_TRANSFER_IDEMPOTENCY_CONFLICT')
  try {
    await link(stagePath, finalPath)
    await unlink(stagePath)
  } catch (error) {
    throw new SaveTransferError(
      isNodeError(error, 'EEXIST') ? 'SAVE_TRANSFER_IDEMPOTENCY_CONFLICT' : 'SAVE_TRANSFER_PUBLISH_FAILED',
      { cause: error }
    )
  }
}

async function publishDirectoryWithoutOverwrite(stagePath: string, finalPath: string): Promise<void> {
  if (await pathExists(finalPath)) throw new SaveTransferError('SAVE_TRANSFER_IDEMPOTENCY_CONFLICT')
  try {
    await rename(stagePath, finalPath)
  } catch (error) {
    throw new SaveTransferError(
      isNodeError(error, 'EEXIST') || isNodeError(error, 'ENOTEMPTY')
        ? 'SAVE_TRANSFER_IDEMPOTENCY_CONFLICT'
        : 'SAVE_TRANSFER_PUBLISH_FAILED',
      { cause: error }
    )
  }
}

async function readExportEnvelope(
  roots: PreparedTransferRoots,
  requestId: string
): Promise<z.infer<typeof exportEnvelopeSchema> | null> {
  return await readReceiptEnvelope(exportReceiptPath(roots, requestId), exportEnvelopeSchema)
}

async function readImportEnvelope(
  roots: PreparedTransferRoots,
  requestId: string
): Promise<z.infer<typeof importEnvelopeSchema> | null> {
  return await readReceiptEnvelope(importReceiptPath(roots, requestId), importEnvelopeSchema)
}

async function readReceiptEnvelope<T>(
  receiptPath: string,
  schema: z.ZodType<T>
): Promise<T | null> {
  if (!await pathExists(receiptPath)) return null
  const raw = await readStableSmallFile(receiptPath, receiptMaximumBytes)
  try {
    return schema.parse(JSON.parse(raw.bytes.toString('utf8')) as unknown)
  } catch (error) {
    throw new SaveTransferError('SAVE_TRANSFER_RECEIPT_INVALID', { cause: error })
  }
}

async function persistExportEnvelope(
  roots: PreparedTransferRoots,
  fingerprint: string,
  receipt: SavePairExportReceipt
): Promise<void> {
  await persistReceipt(exportReceiptPath(roots, receipt.requestId), exportEnvelopeSchema.parse({
    format: 'dyson-control-save-transfer-receipt-envelope',
    schemaVersion: 1,
    requestFingerprint: fingerprint,
    receipt: { ...receipt, reused: false }
  }))
}

async function persistImportEnvelope(
  roots: PreparedTransferRoots,
  fingerprint: string,
  receipt: SavePairImportReceipt
): Promise<void> {
  await persistReceipt(importReceiptPath(roots, receipt.requestId), importEnvelopeSchema.parse({
    format: 'dyson-control-save-transfer-receipt-envelope',
    schemaVersion: 1,
    requestFingerprint: fingerprint,
    receipt: { ...receipt, reused: false }
  }))
}

async function persistReceipt(finalPath: string, envelope: unknown): Promise<void> {
  const directory = path.dirname(finalPath)
  const partial = safeImmediateChild(directory, `.partial-${randomUUID()}.json`)
  try {
    await writeSmallOwnedFile(partial, Buffer.from(`${JSON.stringify(envelope)}\n`, 'utf8'))
    await publishFileWithoutOverwrite(partial, finalPath)
  } catch (error) {
    await unlink(partial).catch(() => undefined)
    throw normalizeTransferError(error)
  }
}

function receiptEnvelopeBytes(fingerprint: string, receipt: SavePairImportReceipt): Buffer {
  const envelope = importEnvelopeSchema.parse({
    format: 'dyson-control-save-transfer-receipt-envelope',
    schemaVersion: 1,
    requestFingerprint: fingerprint,
    receipt: { ...receipt, reused: false }
  })
  return Buffer.from(`${JSON.stringify(envelope)}\n`, 'utf8')
}

async function writeSmallOwnedFile(filePath: string, bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength < 1 || bytes.byteLength > receiptMaximumBytes) {
    throw new SaveTransferError('SAVE_TRANSFER_METADATA_INVALID')
  }
  const sink = await FileHandleSink.create(filePath)
  try {
    await sink.write(bytes)
    await sink.close()
  } catch (error) {
    await sink.abort().catch(() => undefined)
    throw error
  }
}

async function readStableSmallFile(filePath: string, maximumBytes: number): Promise<{ bytes: Buffer }> {
  await assertNormalFilePath(filePath)
  const handle = await open(filePath, 'r')
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size < 1 || before.size > BigInt(maximumBytes)) {
      throw new SaveTransferError('SAVE_TRANSFER_METADATA_INVALID')
    }
    const bytes = Buffer.allocUnsafe(Number(before.size))
    let position = 0
    while (position < bytes.length) {
      const result = await handle.read(bytes, position, bytes.length - position, position)
      if (result.bytesRead === 0) throw new SaveTransferError('SAVE_TRANSFER_METADATA_INVALID')
      position += result.bytesRead
    }
    const after = await handle.stat({ bigint: true })
    await assertNormalFilePath(filePath)
    if (!sameSnapshot(before, after)) throw new SaveTransferError('SAVE_TRANSFER_SOURCE_CHANGED')
    return { bytes }
  } finally {
    await handle.close()
  }
}

async function hashStableFile(filePath: string, maximumBytes: number): Promise<SavePairTransportWriteResult> {
  await assertNormalFilePath(filePath)
  const handle = await open(filePath, 'r')
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size < 1 || before.size > BigInt(maximumBytes) || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new SaveTransferError('SAVE_TRANSFER_ARCHIVE_TOO_LARGE')
    }
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let position = 0
    const size = Number(before.size)
    while (position < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position)
      if (bytesRead === 0) throw new SaveTransferError('SAVE_TRANSFER_ARCHIVE_TRUNCATED')
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    await assertNormalFilePath(filePath)
    if (!sameSnapshot(before, after)) throw new SaveTransferError('SAVE_TRANSFER_SOURCE_CHANGED')
    return { bytes: size, sha256: hash.digest('hex') }
  } finally {
    await handle.close()
  }
}

async function assertNormalFilePath(filePath: string): Promise<void> {
  try {
    const metadata = await lstat(filePath)
    if (!metadata.isFile() || metadata.isSymbolicLink() || !samePath(await realpath(filePath), filePath)) {
      throw new SaveTransferError('SAVE_TRANSFER_FILE_REDIRECTED')
    }
  } catch (error) {
    if (error instanceof SaveTransferError) throw error
    throw new SaveTransferError('SAVE_TRANSFER_FILE_UNAVAILABLE', { cause: error })
  }
}

class FileHandleSink {
  readonly #path: string
  #handle: FileHandle | null
  #position = 0

  private constructor(filePath: string, handle: FileHandle) {
    this.#path = filePath
    this.#handle = handle
  }

  static async create(filePath: string): Promise<FileHandleSink> {
    return new FileHandleSink(filePath, await open(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600))
  }

  async write(chunk: Uint8Array): Promise<void> {
    const handle = this.#handle
    if (handle === null) throw new SaveTransferError('SAVE_TRANSFER_SINK_CLOSED')
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    let offset = 0
    while (offset < bytes.length) {
      const result = await handle.write(bytes, offset, bytes.length - offset, this.#position)
      if (result.bytesWritten === 0) throw new SaveTransferError('SAVE_TRANSFER_WRITE_FAILED')
      offset += result.bytesWritten
      this.#position += result.bytesWritten
    }
  }

  async close(): Promise<void> {
    const handle = this.#handle
    if (handle === null) return
    this.#handle = null
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  async abort(): Promise<void> {
    const handle = this.#handle
    this.#handle = null
    await handle?.close().catch(() => undefined)
    await unlink(this.#path).catch(() => undefined)
  }
}

class ImportFileSink implements SavePairTransportFileSink {
  readonly #expectedBytes: number
  readonly #delegate: FileHandleSink
  #bytes = 0

  private constructor(delegate: FileHandleSink, expectedBytes: number) {
    this.#delegate = delegate
    this.#expectedBytes = expectedBytes
  }

  static async create(filePath: string, expectedBytes: number): Promise<ImportFileSink> {
    return new ImportFileSink(await FileHandleSink.create(filePath), expectedBytes)
  }

  async write(chunk: Uint8Array): Promise<void> {
    this.#bytes += chunk.byteLength
    if (this.#bytes > this.#expectedBytes) throw new SaveTransferError('SAVE_TRANSFER_ENTRY_TOO_LARGE')
    await this.#delegate.write(chunk)
  }

  async close(): Promise<void> {
    if (this.#bytes !== this.#expectedBytes) throw new SaveTransferError('SAVE_TRANSFER_ARCHIVE_TRUNCATED')
    await this.#delegate.close()
  }

  async abort(): Promise<void> {
    await this.#delegate.abort()
  }
}

async function withTransferLock<T>(roots: PreparedTransferRoots, operation: () => Promise<T>): Promise<T> {
  const lockPath = safeImmediateChild(roots.transportRoot, '.transfer.lock')
  const handle = await acquireTransferLock(lockPath)
  try {
    return await operation()
  } finally {
    await handle.close().catch(() => undefined)
    await unlink(lockPath).catch(() => undefined)
  }
}

const transferLockSchema = z.strictObject({
  format: z.literal('dyson-control-save-transfer-lock'),
  schemaVersion: z.literal(1),
  host: z.string().min(1).max(255),
  bootId: z.string().min(1).max(64),
  pid: z.number().int().positive()
})

async function acquireTransferLock(lockPath: string): Promise<FileHandle> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle: FileHandle
    try {
      handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) {
        throw new SaveTransferError('SAVE_TRANSFER_LOCK_FAILED', { cause: error })
      }
      if (attempt > 0 || !await removeProvablyStaleTransferLock(lockPath)) {
        throw new SaveTransferError('SAVE_TRANSFER_LOCK_BUSY', { cause: error })
      }
      continue
    }
    try {
      await handle.writeFile(`${JSON.stringify({
        format: 'dyson-control-save-transfer-lock',
        schemaVersion: 1,
        host: hostname(),
        bootId: currentBootId(),
        pid: process.pid
      })}\n`, 'utf8')
      await handle.sync()
      return handle
    } catch (error) {
      await handle.close().catch(() => undefined)
      await unlink(lockPath).catch(() => undefined)
      throw new SaveTransferError('SAVE_TRANSFER_LOCK_FAILED', { cause: error })
    }
  }
  throw new SaveTransferError('SAVE_TRANSFER_LOCK_BUSY')
}

async function removeProvablyStaleTransferLock(lockPath: string): Promise<boolean> {
  let parsed: z.infer<typeof transferLockSchema>
  try {
    const metadata = await lstat(lockPath)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > 2_048 ||
        !samePath(await realpath(lockPath), lockPath)) return false
    parsed = transferLockSchema.parse(JSON.parse(await readFile(lockPath, 'utf8')) as unknown)
  } catch {
    return false
  }
  if (parsed.host !== hostname()) return false
  if (parsed.bootId !== currentBootId() || !processIsAlive(parsed.pid)) {
    await unlink(lockPath).catch((error: unknown) => {
      if (!isNodeError(error, 'ENOENT')) throw error
    })
    return true
  }
  return false
}

function exportArchivePath(roots: PreparedTransferRoots, requestId: string): string {
  requestIdSchema.parse(requestId)
  return safeImmediateChild(roots.exportRoot, `export-${requestId}.dspair`)
}

function importInboxPath(roots: PreparedTransferRoots, requestId: string): string {
  requestIdSchema.parse(requestId)
  return safeImmediateChild(roots.inboxRoot, `import-${requestId}`)
}

function exportReceiptPath(roots: PreparedTransferRoots, requestId: string): string {
  requestIdSchema.parse(requestId)
  return safeImmediateChild(roots.receiptRoot, `export-${requestId}.json`)
}

function importReceiptPath(roots: PreparedTransferRoots, requestId: string): string {
  requestIdSchema.parse(requestId)
  return safeImmediateChild(roots.receiptRoot, `import-${requestId}.json`)
}

function requestFingerprint(operation: 'export' | 'import', request: unknown): string {
  return createHash('sha256').update(JSON.stringify({ operation, request }), 'utf8').digest('hex')
}

function sameTrustedBackup(left: TrustedBackupSource, right: TrustedBackupSource): boolean {
  return left.manifestSha256 === right.manifestSha256 && left.directory === right.directory &&
    JSON.stringify(left.manifest) === JSON.stringify(right.manifest)
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function currentBootId(): string {
  return Math.round((Date.now() - uptime() * 1_000) / 60_000).toString(36)
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isNodeError(error, 'EPERM')
  }
}

async function availableFilesystemBytes(fixedRoot: string): Promise<number> {
  const info = await statfs(fixedRoot, { bigint: true })
  const value = info.bavail * info.bsize
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value)
}

function pathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = `${normalizePath(left)}${path.sep}`
  const normalizedRight = `${normalizePath(right)}${path.sep}`
  return normalizedLeft.startsWith(normalizedRight) || normalizedRight.startsWith(normalizedLeft)
}

function normalizePath(value: string): string {
  return path.resolve(value).replace(/[\\/]+$/, '').toLocaleLowerCase('en-US')
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right)
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate)
    return true
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false
    throw error
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
}

function normalizeTransferError(error: unknown): SaveTransferError {
  if (error instanceof SaveTransferError) return error
  if (isNodeError(error, 'ENOSPC') || isNodeError(error, 'EDQUOT')) {
    return new SaveTransferError('SAVE_TRANSFER_SPACE_INSUFFICIENT')
  }
  return new SaveTransferError('SAVE_TRANSFER_FAILED', { cause: error })
}

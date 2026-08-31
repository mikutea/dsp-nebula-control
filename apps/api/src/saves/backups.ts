import { createHash } from 'node:crypto'
import { lstat, open, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import {
  readBoundedDirectory,
  resolveNormalBackupDirectory,
  resolveNormalDirectory,
  safeImmediateChild
} from './boundary.js'
import { decodeCatalogCursor, encodeCatalogCursor } from './cursor.js'
import {
  MAX_DIRECTORY_ENTRIES,
  MAX_MANIFEST_BYTES,
  backupCatalogPageSchema,
  backupCatalogQuerySchema,
  backupIdSchema,
  backupManifestV1Schema,
  backupVerificationSchema,
  type BackupCatalogPage,
  type BackupIssue,
  type BackupManifestV1,
  type BackupVerification
} from './schemas.js'

export interface BackupVerificationOptions {
  backupRoot: string
  backupId: string
}

export interface BackupCatalogOptions {
  backupRoot: string
  query?: unknown
  now?: Date
  maximumDirectoryEntries?: number
}

interface ManifestReadResult {
  manifest: BackupManifestV1 | null
  manifestPresent: boolean
  issue: BackupIssue | null
}

interface FileVerification {
  present: boolean
  bytes: number | null
  issues: BackupIssue[]
}

export async function verifyBackupPair(options: BackupVerificationOptions): Promise<BackupVerification> {
  const backupId = backupIdSchema.parse(options.backupId)
  const backupDirectory = await resolveNormalBackupDirectory(options.backupRoot, backupId)
  const manifestResult = await readManifest(backupDirectory, backupId)
  if (manifestResult.manifest === null) {
    const issues = manifestResult.issue === null ? ['manifest-invalid' as const] : [manifestResult.issue]
    return backupVerificationSchema.parse({
      schemaVersion: 1,
      backupId,
      saveName: null,
      createdAt: null,
      health: manifestResult.issue === 'manifest-missing' ? 'incomplete' : 'corrupt',
      issues,
      manifestPresent: manifestResult.manifestPresent,
      manifestValid: false,
      pairPresent: false,
      dsvBytes: null,
      serverBytes: null,
      totalBytes: 0
    })
  }

  const manifest = manifestResult.manifest
  const dsvEntry = manifest.files.find((entry) => entry.name === `${manifest.saveName}.dsv`)
  const serverEntry = manifest.files.find((entry) => entry.name === `${manifest.saveName}.server`)
  if (dsvEntry === undefined || serverEntry === undefined ||
      manifest.files.filter((entry) => entry.name === dsvEntry.name).length !== 1 ||
      manifest.files.filter((entry) => entry.name === serverEntry.name).length !== 1) {
    return invalidManifestResult(backupId, manifest, 'manifest-identity-mismatch')
  }

  const dsv = await verifyManifestFile(backupDirectory, dsvEntry, 'dsv')
  const server = await verifyManifestFile(backupDirectory, serverEntry, 'server')
  const issues = [...dsv.issues, ...server.issues]
  const pairPresent = dsv.present && server.present
  if (!pairPresent) issues.unshift('pair-incomplete')
  const incomplete = issues.every((issue) => issue === 'pair-incomplete')
  const health = issues.length === 0 ? 'healthy' : incomplete ? 'incomplete' : 'corrupt'

  return backupVerificationSchema.parse({
    schemaVersion: 1,
    backupId,
    saveName: manifest.saveName,
    createdAt: manifest.createdAt,
    health,
    issues,
    manifestPresent: true,
    manifestValid: true,
    pairPresent,
    dsvBytes: dsv.bytes,
    serverBytes: server.bytes,
    totalBytes: (dsv.bytes ?? 0) + (server.bytes ?? 0)
  })
}

export async function catalogBackups(options: BackupCatalogOptions): Promise<BackupCatalogPage> {
  const query = backupCatalogQuerySchema.parse(options.query ?? {})
  const offset = decodeCatalogCursor(query.cursor)
  const backupRoot = await resolveNormalDirectory(options.backupRoot)
  const directoryEntries = await readBoundedDirectory(
    backupRoot,
    options.maximumDirectoryEntries ?? MAX_DIRECTORY_ENTRIES
  )
  let rejectedEntryCount = 0
  const backupIds: string[] = []
  for (const entry of directoryEntries) {
    if (entry.kind === 'directory' && backupIdSchema.safeParse(entry.name).success) {
      backupIds.push(entry.name)
    } else if (entry.kind === 'directory' || entry.kind === 'redirected') {
      rejectedEntryCount += 1
    }
  }
  backupIds.sort((left, right) => left < right ? 1 : left > right ? -1 : 0)

  const selectedIds = backupIds.slice(offset, offset + query.pageSize)
  const items: BackupVerification[] = []
  // Hashing large save pairs is intentionally sequential to cap disk and memory pressure.
  for (const backupId of selectedIds) {
    items.push(await verifyBackupPair({ backupRoot, backupId }))
  }
  const nextOffset = offset + items.length

  return backupCatalogPageSchema.parse({
    schemaVersion: 1,
    kind: 'backups',
    generatedAt: (options.now ?? new Date()).toISOString(),
    items,
    page: {
      limit: query.pageSize,
      returned: items.length,
      totalUnits: backupIds.length,
      nextCursor: nextOffset < backupIds.length ? encodeCatalogCursor(nextOffset) : null
    },
    rejectedEntryCount
  })
}

async function readManifest(backupDirectory: string, backupId: string): Promise<ManifestReadResult> {
  const manifestPath = safeImmediateChild(backupDirectory, 'manifest.json')
  let metadata
  try {
    metadata = await lstat(manifestPath)
  } catch (error) {
    if (isMissing(error)) return { manifest: null, manifestPresent: false, issue: 'manifest-missing' }
    return { manifest: null, manifestPresent: false, issue: 'manifest-invalid' }
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    return { manifest: null, manifestPresent: true, issue: 'manifest-redirected' }
  }
  if (metadata.size <= 0 || metadata.size > MAX_MANIFEST_BYTES) {
    return { manifest: null, manifestPresent: true, issue: 'manifest-too-large' }
  }
  try {
    if (!samePath(await realpath(manifestPath), manifestPath)) {
      return { manifest: null, manifestPresent: true, issue: 'manifest-redirected' }
    }
    const raw = await readFile(manifestPath, 'utf8')
    const parsed = backupManifestV1Schema.safeParse(JSON.parse(raw) as unknown)
    if (!parsed.success) return { manifest: null, manifestPresent: true, issue: 'manifest-invalid' }
    if (backupId !== `tx-${parsed.data.requestId.toLocaleLowerCase('en-US')}`) {
      return { manifest: null, manifestPresent: true, issue: 'manifest-identity-mismatch' }
    }
    return { manifest: parsed.data, manifestPresent: true, issue: null }
  } catch {
    return { manifest: null, manifestPresent: true, issue: 'manifest-invalid' }
  }
}

async function verifyManifestFile(
  backupDirectory: string,
  expected: BackupManifestV1['files'][number],
  role: 'dsv' | 'server'
): Promise<FileVerification> {
  const redirectedIssue = role === 'dsv' ? 'redirected-dsv' : 'redirected-server'
  const emptyIssue = role === 'dsv' ? 'empty-dsv' : 'empty-server'
  const sizeIssue = role === 'dsv' ? 'size-mismatch-dsv' : 'size-mismatch-server'
  const hashIssue = role === 'dsv' ? 'hash-mismatch-dsv' : 'hash-mismatch-server'
  const readIssue = role === 'dsv' ? 'read-failed-dsv' : 'read-failed-server'
  const changedIssue = role === 'dsv'
    ? 'changed-during-verification-dsv'
    : 'changed-during-verification-server'
  const filePath = safeImmediateChild(backupDirectory, expected.name)

  try {
    const metadata = await lstat(filePath)
    if (metadata.isSymbolicLink() || !samePath(await realpath(filePath), filePath)) {
      return { present: false, bytes: null, issues: [redirectedIssue] }
    }
    if (!metadata.isFile()) return { present: false, bytes: null, issues: [readIssue] }
    const issues: BackupIssue[] = []
    if (metadata.size === 0) issues.push(emptyIssue)
    if (metadata.size !== expected.bytes) issues.push(sizeIssue)
    if (metadata.size === expected.bytes) {
      const evidence = await hashStableFile(filePath)
      if (evidence.changed) issues.push(changedIssue)
      else if (evidence.sha256 !== expected.sha256.toLocaleLowerCase('en-US')) issues.push(hashIssue)
    }
    return { present: true, bytes: metadata.size, issues }
  } catch (error) {
    if (isMissing(error)) return { present: false, bytes: null, issues: [] }
    return { present: false, bytes: null, issues: [readIssue] }
  }
}

async function hashStableFile(filePath: string): Promise<{ sha256: string, changed: boolean }> {
  const handle = await open(filePath, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new Error('not-file')
    const algorithm = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let position = 0
    while (position < before.size) {
      const length = Math.min(buffer.length, before.size - position)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      if (bytesRead === 0) break
      algorithm.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    const after = await handle.stat()
    return {
      sha256: algorithm.digest('hex'),
      changed: position !== before.size || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
    }
  } finally {
    await handle.close()
  }
}

function invalidManifestResult(
  backupId: string,
  manifest: BackupManifestV1,
  issue: BackupIssue
): BackupVerification {
  return backupVerificationSchema.parse({
    schemaVersion: 1,
    backupId,
    saveName: manifest.saveName,
    createdAt: manifest.createdAt,
    health: 'corrupt',
    issues: [issue],
    manifestPresent: true,
    manifestValid: false,
    pairPresent: false,
    dsvBytes: null,
    serverBytes: null,
    totalBytes: 0
  })
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => path.resolve(value).replace(/[\\/]+$/, '').toLocaleLowerCase('en-US')
  return normalize(left) === normalize(right)
}

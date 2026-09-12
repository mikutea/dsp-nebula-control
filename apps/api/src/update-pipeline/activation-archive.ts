import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createInflateRaw } from 'node:zlib'
import { z } from 'zod'
import { normalizeVersion, sha256Schema } from '../updates/version.js'
import { ComponentUpdateActivationError, type ComponentArchiveSummary, type ManagedUpdateComponent } from './activation-types.js'
import {
  assertBepInExWindowsX64ManifestLayout,
  bepInExWindowsX64LayoutPolicyIds,
  isKnownBepInExWindowsX64OwnedPath,
  resolveBepInExWindowsX64LayoutPolicy,
  type BepInExWindowsX64LayoutPolicyId
} from './bepinex-layout.js'
import { isManagedComponentOwnedPath } from './plugin-ownership.js'

const componentSchema = z.enum(['nebula', 'bepinex', 'bridge', 'control'])
const artifactIdSchema = z.string().min(16).max(96).regex(/^[a-z0-9][a-z0-9-]+$/)
const relativePathSchema = z.string().min(1).max(240)
const sizeSchema = z.number().int().min(0).max(2 * 1_024 * 1_024 * 1_024)

export interface ComponentReleaseManifestFile {
  relativePath: string
  sizeBytes: number
  sha256: string
}

export interface ComponentReleaseManifest {
  format: 'dyson-control-component-release'
  schemaVersion: 1
  component: ManagedUpdateComponent
  version: string
  artifactId: string
  layoutPolicy?: BepInExWindowsX64LayoutPolicyId
  files: ComponentReleaseManifestFile[]
}

export const componentReleaseManifestSchema: z.ZodType<ComponentReleaseManifest> = z.strictObject({
  format: z.literal('dyson-control-component-release'),
  schemaVersion: z.literal(1),
  component: componentSchema,
  version: z.string().trim().min(1).max(64),
  artifactId: artifactIdSchema,
  layoutPolicy: z.enum([
    bepInExWindowsX64LayoutPolicyIds.v5_4_22,
    bepInExWindowsX64LayoutPolicyIds.v5_4_23_2_through_5
  ]).optional(),
  files: z.array(z.strictObject({
    relativePath: relativePathSchema,
    sizeBytes: sizeSchema,
    sha256: sha256Schema
  })).max(512)
}).superRefine((manifest, context) => {
  if ((manifest.component === 'bepinex') !== (manifest.layoutPolicy !== undefined)) {
    context.addIssue({ code: 'custom', message: 'component layout policy mismatch' })
  }
})

export interface ComponentArchiveLimits {
  maximumArchiveBytes: number
  maximumFileBytes: number
  maximumExpandedBytes: number
  maximumFiles: number
}

export interface InspectComponentArchiveInput {
  archivePath: string
  expectedComponent: ManagedUpdateComponent
  expectedVersion: string
  expectedArtifactId: string
  limits: ComponentArchiveLimits
  extractTo?: string
}

export interface ValidatedZipArchiveEntry {
  name: string
  sizeBytes: number
  sha256: string
  bytes: Buffer
}

/**
 * Reads a bounded provider archive through the same ZIP parser used by update
 * activation. This is intentionally lower-level than component inspection:
 * callers must still apply a versioned package-layout policy before publishing
 * any returned entry as a managed component or mod payload.
 */
export async function readValidatedZipArchive(
  archivePath: string,
  limits: ComponentArchiveLimits
): Promise<ValidatedZipArchiveEntry[]> {
  validateLimits(limits)
  const archiveInfo = await lstat(archivePath).catch((error: unknown) => {
    throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_UNAVAILABLE', { cause: error })
  })
  if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink()) {
    throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_NOT_REGULAR_FILE')
  }
  if (archiveInfo.size <= 0 || archiveInfo.size > limits.maximumArchiveBytes) {
    throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_SIZE_INVALID')
  }
  const handle = await open(archivePath, 'r')
  try {
    const parsed = await parseZip(handle, archiveInfo.size, limits)
    const files = parsed.entries.filter((entry) => !entry.directory)
    if (files.length === 0 || files.length > limits.maximumFiles) {
      throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_FILE_COUNT_INVALID')
    }
    let expandedBytes = 0
    const result: ValidatedZipArchiveEntry[] = []
    for (const entry of files.sort((left, right) => compareText(canonicalName(left.name), canonicalName(right.name)))) {
      expandedBytes += entry.uncompressedSize
      if (!Number.isSafeInteger(expandedBytes) || expandedBytes > limits.maximumExpandedBytes) {
        throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_EXPANDED_TOO_LARGE')
      }
      const processed = await processZipEntry(
        archivePath,
        handle,
        parsed,
        entry,
        limits.maximumFileBytes,
        undefined,
        true
      )
      result.push({
        name: entry.name,
        sizeBytes: processed.sizeBytes,
        sha256: processed.sha256,
        bytes: processed.bytes!
      })
    }
    return result
  } finally {
    await handle.close()
  }
}

interface ZipEntry {
  name: string
  directory: boolean
  flags: number
  method: number
  crc32: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
  externalAttributes: number
  madeByPlatform: number
}

interface ParsedZip {
  archiveSize: number
  centralDirectoryOffset: number
  entries: ZipEntry[]
}

interface ProcessedEntry {
  sizeBytes: number
  sha256: string
  bytes?: Buffer
}

const embeddedManifestName = 'dyson-component-manifest.json'
const maximumManifestBytes = 1 * 1_024 * 1_024
const maximumCentralDirectoryBytes = 4 * 1_024 * 1_024
const eocdMinimumBytes = 22
const maximumEocdSearchBytes = 65_535 + eocdMinimumBytes
const centralSignature = 0x02014b50
const localSignature = 0x04034b50
const eocdSignature = 0x06054b50
const dataDescriptorSignature = 0x08074b50

export async function inspectComponentArchive(input: InspectComponentArchiveInput): Promise<{
  manifest: ComponentReleaseManifest
  summary: ComponentArchiveSummary
}> {
  validateLimits(input.limits)
  const archiveInfo = await lstat(input.archivePath).catch((error: unknown) => {
    throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_UNAVAILABLE', { cause: error })
  })
  if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink()) {
    throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_NOT_REGULAR_FILE')
  }
  if (archiveInfo.size <= 0 || archiveInfo.size > input.limits.maximumArchiveBytes) {
    throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_SIZE_INVALID')
  }

  const handle = await open(input.archivePath, 'r')
  try {
    const parsedZip = await parseZip(handle, archiveInfo.size, input.limits)
    if (input.expectedComponent === 'bepinex') {
      return await inspectOfficialBepInExWindowsX64Archive(input, handle, parsedZip)
    }
    const manifestEntries = parsedZip.entries.filter((entry) => !entry.directory && canonicalName(entry.name) === embeddedManifestName)
    if (manifestEntries.length !== 1 || manifestEntries[0]!.name !== embeddedManifestName) {
      throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_MANIFEST_MISSING')
    }
    const manifestEntry = manifestEntries[0]!
    if (manifestEntry.uncompressedSize > maximumManifestBytes || manifestEntry.compressedSize > maximumManifestBytes * 2) {
      throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_MANIFEST_TOO_LARGE')
    }
    const manifestBytes = (await processZipEntry(
      input.archivePath,
      handle,
      parsedZip,
      manifestEntry,
      maximumManifestBytes,
      undefined,
      true
    )).bytes!
    let manifestInput: unknown
    try {
      manifestInput = JSON.parse(manifestBytes.toString('utf8'))
    } catch (error) {
      throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_MANIFEST_INVALID', { cause: error })
    }
    let manifest: ComponentReleaseManifest
    try {
      manifest = componentReleaseManifestSchema.parse(manifestInput)
    } catch (error) {
      throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_MANIFEST_INVALID', { cause: error })
    }
    const expectedVersion = normalizeManagedVersion(input.expectedVersion, input.expectedComponent)
    const manifestVersion = normalizeManagedVersion(manifest.version, manifest.component)
    if (manifest.component !== input.expectedComponent || manifestVersion !== expectedVersion ||
        manifest.artifactId !== input.expectedArtifactId) {
      throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_IDENTITY_MISMATCH')
    }
    manifest = { ...manifest, version: manifestVersion, files: manifest.files.map((file) => ({
      ...file, sha256: file.sha256.toLowerCase()
    })) }

    const manifestFiles = new Map<string, ComponentReleaseManifestFile>()
    let expandedBytes = 0
    for (const file of manifest.files) {
      const normalized = validatePayloadPath(file.relativePath)
      if (normalized !== file.relativePath) throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_PATH_INVALID')
      if (!isAllowedPayloadName(manifest.component, file.relativePath)) {
        throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_FILE_TYPE_FORBIDDEN')
      }
      const key = canonicalName(file.relativePath)
      if (manifestFiles.has(key)) throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_DUPLICATE_FILE')
      if (file.sizeBytes > input.limits.maximumFileBytes) {
        throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_FILE_TOO_LARGE')
      }
      expandedBytes += file.sizeBytes
      if (!Number.isSafeInteger(expandedBytes) || expandedBytes > input.limits.maximumExpandedBytes) {
        throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_EXPANDED_TOO_LARGE')
      }
      manifestFiles.set(key, file)
    }
    if (manifest.files.length === 0 || manifest.files.length > input.limits.maximumFiles) {
      throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_FILE_COUNT_INVALID')
    }

    const payloadEntries = parsedZip.entries.filter((entry) => !entry.directory && entry.name !== embeddedManifestName)
    if (payloadEntries.length !== manifest.files.length) {
      throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_UNDECLARED_FILE')
    }
    const allowedDirectories = buildAllowedDirectories(manifest.files.map((file) => file.relativePath))
    for (const directory of parsedZip.entries.filter((entry) => entry.directory)) {
      const key = canonicalName(directory.name.replace(/\/$/, ''))
      if (!allowedDirectories.has(key)) throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_UNDECLARED_FILE')
    }

    if (input.extractTo !== undefined) {
      const outputInfo = await lstat(input.extractTo).catch((error: unknown) => {
        throw new ComponentUpdateActivationError('UPDATE_RELEASE_DIRECTORY_INVALID', { cause: error })
      })
      if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink()) {
        throw new ComponentUpdateActivationError('UPDATE_RELEASE_DIRECTORY_INVALID')
      }
    }

    const seen = new Set<string>()
    for (const entry of payloadEntries.sort((left, right) => compareText(canonicalName(left.name), canonicalName(right.name)))) {
      const key = canonicalName(entry.name)
      const declared = manifestFiles.get(key)
      if (declared === undefined || declared.relativePath !== entry.name) {
        throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_UNDECLARED_FILE')
      }
      if (seen.has(key)) throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_DUPLICATE_FILE')
      seen.add(key)
      if (entry.uncompressedSize !== declared.sizeBytes) {
        throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_SIZE_MISMATCH')
      }
      let destination: string | undefined
      if (input.extractTo !== undefined) {
        destination = path.resolve(input.extractTo, ...entry.name.split('/'))
        assertDescendant(input.extractTo, destination)
        await mkdir(path.dirname(destination), { recursive: true })
      }
      const processed = await processZipEntry(
        input.archivePath,
        handle,
        parsedZip,
        entry,
        input.limits.maximumFileBytes,
        destination,
        false
      )
      if (processed.sizeBytes !== declared.sizeBytes || processed.sha256 !== declared.sha256) {
        throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_CONTENT_MISMATCH')
      }
    }

    return {
      manifest,
      summary: {
        component: manifest.component,
        version: manifest.version,
        artifactId: manifest.artifactId,
        fileCount: manifest.files.length,
        expandedBytes,
        files: manifest.files.map((file) => ({ relativePath: file.relativePath, sizeBytes: file.sizeBytes }))
      }
    }
  } finally {
    await handle.close()
  }
}

async function inspectOfficialBepInExWindowsX64Archive(
  input: InspectComponentArchiveInput & { expectedComponent: ManagedUpdateComponent },
  handle: FileHandle,
  parsedZip: ParsedZip
): Promise<{ manifest: ComponentReleaseManifest; summary: ComponentArchiveSummary }> {
  const version = normalizeManagedVersion(input.expectedVersion, 'bepinex')
  const policy = resolveBepInExWindowsX64LayoutPolicy(version)
  if (policy.files.length > input.limits.maximumFiles) {
    throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_FILE_COUNT_INVALID')
  }
  const files = parsedZip.entries.filter((entry) => !entry.directory)
  if (files.length !== policy.files.length) throw new ComponentUpdateActivationError('UPDATE_BEPINEX_LAYOUT_INVALID')
  const byName = new Map(files.map((entry) => [canonicalName(entry.name), entry]))
  if (byName.size !== files.length) throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_DUPLICATE_FILE')
  const allowedDirectories = buildAllowedDirectories(policy.files)
  for (const directory of parsedZip.entries.filter((entry) => entry.directory)) {
    if (!allowedDirectories.has(canonicalName(directory.name.replace(/\/$/, '')))) {
      throw new ComponentUpdateActivationError('UPDATE_BEPINEX_LAYOUT_INVALID')
    }
  }
  await assertExtractionRoot(input.extractTo)

  let expandedBytes = 0
  const manifestFiles: ComponentReleaseManifestFile[] = []
  for (const relativePath of policy.files) {
    const entry = byName.get(canonicalName(relativePath))
    if (entry === undefined || entry.name !== relativePath) {
      throw new ComponentUpdateActivationError('UPDATE_BEPINEX_LAYOUT_INVALID')
    }
    if (entry.uncompressedSize > input.limits.maximumFileBytes) {
      throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_FILE_TOO_LARGE')
    }
    expandedBytes += entry.uncompressedSize
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > input.limits.maximumExpandedBytes) {
      throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_EXPANDED_TOO_LARGE')
    }
    let destination: string | undefined
    if (input.extractTo !== undefined) {
      destination = path.resolve(input.extractTo, ...relativePath.split('/'))
      assertDescendant(input.extractTo, destination)
      await mkdir(path.dirname(destination), { recursive: true })
    }
    const processed = await processZipEntry(
      input.archivePath,
      handle,
      parsedZip,
      entry,
      input.limits.maximumFileBytes,
      destination,
      false
    )
    manifestFiles.push({ relativePath, sizeBytes: processed.sizeBytes, sha256: processed.sha256 })
  }
  const manifest = componentReleaseManifestSchema.parse({
    format: 'dyson-control-component-release',
    schemaVersion: 1,
    component: 'bepinex',
    version,
    artifactId: input.expectedArtifactId,
    layoutPolicy: policy.id,
    files: manifestFiles
  })
  assertBepInExWindowsX64ManifestLayout(manifest)
  return {
    manifest,
    summary: {
      component: manifest.component,
      version: manifest.version,
      artifactId: manifest.artifactId,
      fileCount: manifest.files.length,
      expandedBytes,
      files: manifest.files.map((file) => ({ relativePath: file.relativePath, sizeBytes: file.sizeBytes }))
    }
  }
}

async function assertExtractionRoot(extractTo: string | undefined): Promise<void> {
  if (extractTo === undefined) return
  const outputInfo = await lstat(extractTo).catch((error: unknown) => {
    throw new ComponentUpdateActivationError('UPDATE_RELEASE_DIRECTORY_INVALID', { cause: error })
  })
  if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink()) {
    throw new ComponentUpdateActivationError('UPDATE_RELEASE_DIRECTORY_INVALID')
  }
}

export async function verifyExtractedComponentRelease(
  releasePayloadRoot: string,
  manifestInput: unknown,
  limits: ComponentArchiveLimits
): Promise<ComponentArchiveSummary> {
  let manifest: ComponentReleaseManifest
  try {
    manifest = componentReleaseManifestSchema.parse(manifestInput)
  } catch (error) {
    throw new ComponentUpdateActivationError('UPDATE_RELEASE_MANIFEST_INVALID', { cause: error })
  }
  validateComponentManifestLayout(manifest)
  const rootInfo = await lstat(releasePayloadRoot).catch((error: unknown) => {
    throw new ComponentUpdateActivationError('UPDATE_RELEASE_INVALID', { cause: error })
  })
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new ComponentUpdateActivationError('UPDATE_RELEASE_INVALID')
  const rootReal = await realpath(releasePayloadRoot)
  let expandedBytes = 0
  const expected = new Set<string>()
  const allowedDirectories = buildAllowedDirectories(manifest.files.map((file) => file.relativePath))
  for (const declared of manifest.files) {
    validatePayloadPath(declared.relativePath)
    if (!isAllowedPayloadName(manifest.component, declared.relativePath)) {
      throw new ComponentUpdateActivationError('UPDATE_RELEASE_FILE_TYPE_FORBIDDEN')
    }
    const key = canonicalName(declared.relativePath)
    if (expected.has(key)) throw new ComponentUpdateActivationError('UPDATE_RELEASE_MANIFEST_INVALID')
    expected.add(key)
    const filePath = path.resolve(releasePayloadRoot, ...declared.relativePath.split('/'))
    assertDescendant(releasePayloadRoot, filePath)
    const info = await lstat(filePath).catch((error: unknown) => {
      throw new ComponentUpdateActivationError('UPDATE_RELEASE_FILE_MISSING', { cause: error })
    })
    if (!info.isFile() || info.isSymbolicLink() || info.size !== declared.sizeBytes) {
      throw new ComponentUpdateActivationError('UPDATE_RELEASE_FILE_INVALID')
    }
    const real = await realpath(filePath)
    assertDescendant(rootReal, real)
    const measured = await hashRegularFile(filePath, limits.maximumFileBytes)
    if (measured.sizeBytes !== declared.sizeBytes || measured.sha256 !== declared.sha256.toLowerCase()) {
      throw new ComponentUpdateActivationError('UPDATE_RELEASE_CONTENT_MISMATCH')
    }
    expandedBytes += measured.sizeBytes
    if (expandedBytes > limits.maximumExpandedBytes) throw new ComponentUpdateActivationError('UPDATE_RELEASE_TOO_LARGE')
  }
  await assertReleaseContainsOnly(releasePayloadRoot, expected, allowedDirectories)
  return {
    component: manifest.component,
    version: manifest.version,
    artifactId: manifest.artifactId,
    fileCount: manifest.files.length,
    expandedBytes,
    files: manifest.files.map((file) => ({ relativePath: file.relativePath, sizeBytes: file.sizeBytes }))
  }
}

async function parseZip(handle: FileHandle, archiveSize: number, limits: ComponentArchiveLimits): Promise<ParsedZip> {
  const tailSize = Math.min(archiveSize, maximumEocdSearchBytes)
  const tail = await readExactly(handle, archiveSize - tailSize, tailSize)
  let eocdOffsetInTail = -1
  for (let offset = tail.length - eocdMinimumBytes; offset >= 0; offset--) {
    if (tail.readUInt32LE(offset) === eocdSignature && offset + eocdMinimumBytes + tail.readUInt16LE(offset + 20) === tail.length) {
      eocdOffsetInTail = offset
      break
    }
  }
  if (eocdOffsetInTail < 0) throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_ZIP_INVALID')
  const disk = tail.readUInt16LE(eocdOffsetInTail + 4)
  const centralDisk = tail.readUInt16LE(eocdOffsetInTail + 6)
  const diskEntries = tail.readUInt16LE(eocdOffsetInTail + 8)
  const totalEntries = tail.readUInt16LE(eocdOffsetInTail + 10)
  const centralSize = tail.readUInt32LE(eocdOffsetInTail + 12)
  const centralOffset = tail.readUInt32LE(eocdOffsetInTail + 16)
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries || totalEntries === 0 ||
      totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_ZIP_UNSUPPORTED')
  }
  if (totalEntries > limits.maximumFiles + 64 || centralSize <= 0 || centralSize > maximumCentralDirectoryBytes) {
    throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_FILE_COUNT_INVALID')
  }
  const absoluteEocdOffset = archiveSize - tailSize + eocdOffsetInTail
  if (centralOffset + centralSize !== absoluteEocdOffset) {
    throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_ZIP_INVALID')
  }
  const central = await readExactly(handle, centralOffset, centralSize)
  const entries: ZipEntry[] = []
  const names = new Set<string>()
  let cursor = 0
  for (let index = 0; index < totalEntries; index++) {
    if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== centralSignature) {
      throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_ZIP_INVALID')
    }
    const versionMadeBy = central.readUInt16LE(cursor + 4)
    const flags = central.readUInt16LE(cursor + 8)
    const method = central.readUInt16LE(cursor + 10)
    const crc32 = central.readUInt32LE(cursor + 16)
    const compressedSize = central.readUInt32LE(cursor + 20)
    const uncompressedSize = central.readUInt32LE(cursor + 24)
    const nameLength = central.readUInt16LE(cursor + 28)
    const extraLength = central.readUInt16LE(cursor + 30)
    const commentLength = central.readUInt16LE(cursor + 32)
    const diskStart = central.readUInt16LE(cursor + 34)
    const externalAttributes = central.readUInt32LE(cursor + 38)
    const localHeaderOffset = central.readUInt32LE(cursor + 42)
    const next = cursor + 46 + nameLength + extraLength + commentLength
    if (nameLength === 0 || next > central.length || diskStart !== 0 ||
        compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_ZIP_UNSUPPORTED')
    }
    if ((flags & 0x0001) !== 0 || (flags & ~0x0808) !== 0 || (method !== 0 && method !== 8)) {
      throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_ZIP_UNSUPPORTED')
    }
    const extra = central.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength)
    if (containsZip64Extra(extra)) throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_ZIP_UNSUPPORTED')
    const nameBytes = central.subarray(cursor + 46, cursor + 46 + nameLength)
    const name = decodeZipName(nameBytes, flags)
    const directory = name.endsWith('/')
    validateZipEntryName(name, directory)
    const key = canonicalName(name.replace(/\/$/, ''))
    if (names.has(key)) throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_DUPLICATE_FILE')
    names.add(key)
    const madeByPlatform = versionMadeBy >>> 8
    const unixMode = externalAttributes >>> 16
    if ((madeByPlatform === 3 && (unixMode & 0xf000) === 0xa000) || (externalAttributes & 0x400) !== 0) {
      throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_LINK_FORBIDDEN')
    }
    if (!directory && uncompressedSize > limits.maximumFileBytes && name !== embeddedManifestName) {
      throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_FILE_TOO_LARGE')
    }
    if (directory && (compressedSize !== 0 || uncompressedSize !== 0)) {
      throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_ZIP_INVALID')
    }
    entries.push({
      name, directory, flags, method, crc32, compressedSize, uncompressedSize,
      localHeaderOffset, externalAttributes, madeByPlatform
    })
    cursor = next
  }
  if (cursor !== central.length) throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_ZIP_INVALID')
  return { archiveSize, centralDirectoryOffset: centralOffset, entries }
}

async function processZipEntry(
  archivePath: string,
  handle: FileHandle,
  parsed: ParsedZip,
  entry: ZipEntry,
  maximumBytes: number,
  destination: string | undefined,
  collect: boolean
): Promise<ProcessedEntry> {
  const header = await readExactly(handle, entry.localHeaderOffset, 30)
  if (header.readUInt32LE(0) !== localSignature) throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_ZIP_INVALID')
  const flags = header.readUInt16LE(6)
  const method = header.readUInt16LE(8)
  const crc32 = header.readUInt32LE(14)
  const compressedSize = header.readUInt32LE(18)
  const uncompressedSize = header.readUInt32LE(22)
  const nameLength = header.readUInt16LE(26)
  const extraLength = header.readUInt16LE(28)
  const usesDataDescriptor = (entry.flags & 0x0008) !== 0
  const localValuesMatch = usesDataDescriptor
    ? (crc32 === 0 || crc32 === entry.crc32) &&
      (compressedSize === 0 || compressedSize === entry.compressedSize) &&
      (uncompressedSize === 0 || uncompressedSize === entry.uncompressedSize)
    : crc32 === entry.crc32 && compressedSize === entry.compressedSize && uncompressedSize === entry.uncompressedSize
  if (flags !== entry.flags || method !== entry.method || !localValuesMatch) {
    throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_ZIP_INVALID')
  }
  const nameBytes = await readExactly(handle, entry.localHeaderOffset + 30, nameLength)
  if (decodeZipName(nameBytes, flags) !== entry.name) throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_ZIP_INVALID')
  const localExtra = await readExactly(handle, entry.localHeaderOffset + 30 + nameLength, extraLength)
  if (containsZip64Extra(localExtra)) throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_ZIP_UNSUPPORTED')
  const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength
  const dataEndExclusive = dataOffset + entry.compressedSize
  if (!Number.isSafeInteger(dataEndExclusive) || dataOffset < 0 || dataEndExclusive > parsed.centralDirectoryOffset) {
    throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_ZIP_INVALID')
  }
  if (usesDataDescriptor) {
    await validateDataDescriptor(handle, dataEndExclusive, parsed.centralDirectoryOffset, entry)
  }
  let source: Readable
  if (entry.compressedSize === 0) {
    source = Readable.from([])
  } else {
    source = createReadStream(archivePath, { start: dataOffset, end: dataEndExclusive - 1 })
  }
  const decoded: Readable = entry.method === 8 ? source.pipe(createInflateRaw()) : source
  const digest = createHash('sha256')
  let crc = 0xffffffff
  let sizeBytes = 0
  const chunks: Buffer[] = []
  let output: FileHandle | null = null
  try {
    if (destination !== undefined) output = await open(destination, 'wx', 0o600)
    for await (const inputChunk of decoded) {
      const chunk = Buffer.isBuffer(inputChunk) ? inputChunk : Buffer.from(inputChunk as Uint8Array)
      sizeBytes += chunk.length
      if (sizeBytes > maximumBytes || sizeBytes > entry.uncompressedSize) {
        throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_EXPANSION_INVALID')
      }
      digest.update(chunk)
      crc = updateCrc32(crc, chunk)
      if (collect) chunks.push(chunk)
      if (output !== null) await output.write(chunk)
    }
  } catch (error) {
    if (error instanceof ComponentUpdateActivationError) throw error
    throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_EXTRACTION_FAILED', { cause: error })
  } finally {
    await output?.close().catch(() => undefined)
  }
  const finalCrc = (crc ^ 0xffffffff) >>> 0
  if (sizeBytes !== entry.uncompressedSize || finalCrc !== entry.crc32) {
    throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_CRC_MISMATCH')
  }
  return { sizeBytes, sha256: digest.digest('hex'), bytes: collect ? Buffer.concat(chunks, sizeBytes) : undefined }
}

async function validateDataDescriptor(
  handle: FileHandle,
  offset: number,
  centralDirectoryOffset: number,
  entry: ZipEntry
): Promise<void> {
  if (offset + 12 > centralDirectoryOffset) throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_ZIP_INVALID')
  const first = await readExactly(handle, offset, 4)
  const signed = first.readUInt32LE(0) === dataDescriptorSignature
  const descriptorSize = signed ? 16 : 12
  if (offset + descriptorSize > centralDirectoryOffset) {
    throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_ZIP_INVALID')
  }
  const descriptor = signed
    ? await readExactly(handle, offset + 4, 12)
    : Buffer.concat([first, await readExactly(handle, offset + 4, 8)])
  if (descriptor.readUInt32LE(0) !== entry.crc32 ||
      descriptor.readUInt32LE(4) !== entry.compressedSize ||
      descriptor.readUInt32LE(8) !== entry.uncompressedSize) {
    throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_ZIP_INVALID')
  }
}

async function readExactly(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0) {
    throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_ZIP_INVALID')
  }
  const buffer = Buffer.allocUnsafe(length)
  let offset = 0
  while (offset < length) {
    const read = await handle.read(buffer, offset, length - offset, position + offset)
    if (read.bytesRead === 0) throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_ZIP_INVALID')
    offset += read.bytesRead
  }
  return buffer
}

function validateLimits(limits: ComponentArchiveLimits): void {
  const values = [limits.maximumArchiveBytes, limits.maximumFileBytes, limits.maximumExpandedBytes, limits.maximumFiles]
  if (values.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
      limits.maximumFileBytes > limits.maximumExpandedBytes || limits.maximumArchiveBytes > 2 * 1_024 * 1_024 * 1_024 ||
      limits.maximumFiles > 512) {
    throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_LIMITS_INVALID')
  }
}

function validateZipEntryName(name: string, directory: boolean): void {
  const value = directory ? name.slice(0, -1) : name
  validatePayloadPath(value)
  if (directory && !name.endsWith('/')) throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_PATH_INVALID')
}

function validatePayloadPath(value: string): string {
  if (value.length === 0 || value.length > 240 || value.includes('\0') || value.includes('\\') || /[:<>"|?*]/.test(value) ||
      value.startsWith('/') || value.endsWith('/') || !/^[\x20-\x7e]+$/.test(value)) {
    throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_PATH_INVALID')
  }
  const segments = value.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..' || segment.length > 100 ||
      segment.endsWith('.') || segment.endsWith(' ') || isWindowsDeviceName(segment))) {
    throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_PATH_INVALID')
  }
  return segments.join('/')
}

function isWindowsDeviceName(segment: string): boolean {
  const stem = segment.split('.')[0]!.toUpperCase()
  return stem === 'CON' || stem === 'PRN' || stem === 'AUX' || stem === 'NUL' ||
    /^COM[1-9]$/.test(stem) || /^LPT[1-9]$/.test(stem)
}

function isAllowedPayloadName(component: ManagedUpdateComponent, value: string): boolean {
  if (component === 'bepinex') return isKnownBepInExWindowsX64OwnedPath(value)
  return isManagedComponentOwnedPath(component, value)
}

function validateComponentManifestLayout(manifest: ComponentReleaseManifest): void {
  if (manifest.component === 'bepinex') assertBepInExWindowsX64ManifestLayout(manifest)
  else if (manifest.layoutPolicy !== undefined) throw new ComponentUpdateActivationError('UPDATE_RELEASE_MANIFEST_INVALID')
}

function decodeZipName(value: Buffer, flags: number): string {
  if ((flags & 0x0800) === 0 && value.some((byte) => byte > 0x7f)) {
    throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_FILENAME_ENCODING_INVALID')
  }
  const decoded = value.toString('utf8')
  if (Buffer.from(decoded, 'utf8').equals(value) === false && (flags & 0x0800) !== 0) {
    throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_FILENAME_ENCODING_INVALID')
  }
  return decoded
}

function containsZip64Extra(extra: Buffer): boolean {
  let offset = 0
  while (offset < extra.length) {
    if (offset + 4 > extra.length) return true
    const id = extra.readUInt16LE(offset)
    const length = extra.readUInt16LE(offset + 2)
    if (offset + 4 + length > extra.length) return true
    if (id === 0x0001) return true
    offset += 4 + length
  }
  return false
}

function buildAllowedDirectories(files: readonly string[]): Set<string> {
  const result = new Set<string>()
  for (const file of files) {
    const parts = file.split('/')
    parts.pop()
    let current = ''
    for (const part of parts) {
      current = current.length === 0 ? part : `${current}/${part}`
      result.add(canonicalName(current))
    }
  }
  return result
}

async function hashRegularFile(filePath: string, maximumBytes: number): Promise<{ sizeBytes: number; sha256: string }> {
  const digest = createHash('sha256')
  let sizeBytes = 0
  for await (const chunk of createReadStream(filePath)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    sizeBytes += bytes.length
    if (sizeBytes > maximumBytes) throw new ComponentUpdateActivationError('UPDATE_RELEASE_FILE_TOO_LARGE')
    digest.update(bytes)
  }
  return { sizeBytes, sha256: digest.digest('hex') }
}

async function assertReleaseContainsOnly(
  root: string,
  expectedFiles: ReadonlySet<string>,
  allowedDirectories: ReadonlySet<string>
): Promise<void> {
  const { readdir } = await import('node:fs/promises')
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new ComponentUpdateActivationError('UPDATE_RELEASE_LINK_FORBIDDEN')
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!allowedDirectories.has(canonicalName(relative))) {
          throw new ComponentUpdateActivationError('UPDATE_RELEASE_UNDECLARED_FILE')
        }
        await walk(absolute, relative)
      } else if (entry.isFile()) {
        if (!expectedFiles.has(canonicalName(relative))) throw new ComponentUpdateActivationError('UPDATE_RELEASE_UNDECLARED_FILE')
      } else {
        throw new ComponentUpdateActivationError('UPDATE_RELEASE_FILE_INVALID')
      }
    }
  }
  await walk(root, '')
}

function normalizeManagedVersion(value: unknown, component: ManagedUpdateComponent): string {
  return normalizeVersion(value, component === 'bepinex' ? 'bepinex' : component === 'nebula' ? 'nebula' : 'plugin')
}

function canonicalName(value: string): string {
  return value.toLowerCase()
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function assertDescendant(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  if (relative === '' || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_PATH_ESCAPE')
  }
}

const crc32Table = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function updateCrc32(current: number, bytes: Buffer): number {
  let crc = current >>> 0
  for (const byte of bytes) crc = (crc32Table[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0
  return crc
}

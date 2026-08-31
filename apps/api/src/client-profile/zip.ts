import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { normalizeVersion } from '../updates/version.js'
import {
  ClientProfileArtifactError,
  assertPublicArtifactContent,
  assertSafeArtifactEntryName,
  buildClientProfileArtifacts
} from './artifact.js'
import { renderClientProfileInstallInstructions } from './generator.js'
import {
  MAX_CLIENT_PROFILE_ARTIFACT_BYTES,
  MAX_CLIENT_PROFILE_TOTAL_BYTES,
  clientModLockDocumentSchema,
  clientParityValidationReportSchema,
  clientProfileDocumentSchema,
  clientVerificationChecklistSchema,
  generatedClientProfileSchema,
  type ClientModLockDocument,
  type ClientParityValidationReport,
  type ClientProfileArtifact,
  type ClientProfileDocument,
  type ClientVerificationChecklist,
  type GeneratedClientProfile
} from './types.js'

const ZIP_LOCAL_SIGNATURE = 0x04034b50
const ZIP_CENTRAL_SIGNATURE = 0x02014b50
const ZIP_END_SIGNATURE = 0x06054b50
const ZIP_VERSION = 20
const ZIP_UTF8_FLAG = 0x0800
const ZIP_STORE_METHOD = 0
const ZIP_FIXED_TIME = 0
const ZIP_FIXED_DATE = 0x0021
const ZIP_LOCAL_HEADER_BYTES = 30
const ZIP_CENTRAL_HEADER_BYTES = 46
const ZIP_END_BYTES = 22
const ZIP_OVERHEAD_ALLOWANCE_BYTES = 16 * 1024

export const CLIENT_PROFILE_ZIP_FILE_NAME = 'dyson-client-profile.zip' as const
export const CLIENT_PROFILE_ZIP_ENTRY_NAMES = [
  'CHECKSUMS.sha256',
  'INSTALL.md',
  'client-mod-lock.json',
  'client-profile.json',
  'parity-report.json',
  'verification-checklist.json'
] as const
export const MAX_CLIENT_PROFILE_ZIP_BYTES = MAX_CLIENT_PROFILE_TOTAL_BYTES + ZIP_OVERHEAD_ALLOWANCE_BYTES

type ClientProfileZipEntryName = typeof CLIENT_PROFILE_ZIP_ENTRY_NAMES[number]

const MEDIA_TYPES: Record<ClientProfileZipEntryName, ClientProfileArtifact['mediaType']> = {
  'CHECKSUMS.sha256': 'text/plain',
  'INSTALL.md': 'text/markdown',
  'client-mod-lock.json': 'application/json',
  'client-profile.json': 'application/json',
  'parity-report.json': 'application/json',
  'verification-checklist.json': 'application/json'
}

const ALLOWED_ENTRY_NAMES = new Set<string>(CLIENT_PROFILE_ZIP_ENTRY_NAMES)

export type ClientProfileZipErrorCode =
  | 'CLIENT_PROFILE_ZIP_INPUT_INVALID'
  | 'CLIENT_PROFILE_ZIP_ENTRY_COUNT_INVALID'
  | 'CLIENT_PROFILE_ZIP_ENTRY_NAME_INVALID'
  | 'CLIENT_PROFILE_ZIP_ENTRY_DUPLICATE'
  | 'CLIENT_PROFILE_ZIP_ENTRY_TYPE_INVALID'
  | 'CLIENT_PROFILE_ZIP_ENTRY_TOO_LARGE'
  | 'CLIENT_PROFILE_ZIP_ARCHIVE_TOO_LARGE'
  | 'CLIENT_PROFILE_ZIP_PRIVATE_MATERIAL'
  | 'CLIENT_PROFILE_ZIP_ARTIFACT_MISMATCH'
  | 'CLIENT_PROFILE_ZIP_CHECKSUMS_MISMATCH'
  | 'CLIENT_PROFILE_ZIP_DOCUMENT_INVALID'
  | 'CLIENT_PROFILE_ZIP_DOCUMENT_MISMATCH'
  | 'CLIENT_PROFILE_ZIP_MALFORMED'
  | 'CLIENT_PROFILE_ZIP_UNSUPPORTED'
  | 'CLIENT_PROFILE_ZIP_SYMLINK_REJECTED'
  | 'CLIENT_PROFILE_ZIP_CRC_MISMATCH'

export class ClientProfileZipError extends Error {
  readonly code: ClientProfileZipErrorCode

  constructor(code: ClientProfileZipErrorCode) {
    super(code)
    this.name = 'ClientProfileZipError'
    this.code = code
  }
}

export interface ClientProfileZipArchive {
  fileName: typeof CLIENT_PROFILE_ZIP_FILE_NAME
  mediaType: 'application/zip'
  bytes: Buffer
  sizeBytes: number
  sha256: string
  entryCount: typeof CLIENT_PROFILE_ZIP_ENTRY_NAMES.length
}

export interface VerifiedClientProfileZipEntry {
  entryName: ClientProfileZipEntryName
  sizeBytes: number
  sha256: string
}

export interface ClientProfileZipVerification {
  format: 'dyson-control-client-profile-zip-verification'
  schemaVersion: 1
  valid: true
  archiveSha256: string
  sizeBytes: number
  artifactSetSha256: string
  profileId: string
  entries: VerifiedClientProfileZipEntry[]
}

interface ValidatedArtifactSet {
  artifacts: ClientProfileArtifact[]
  artifactSetSha256: string
  documents: ClientProfileDocuments
}

interface ClientProfileDocuments {
  profile: ClientProfileDocument
  clientModLock: ClientModLockDocument
  parityReport: ClientParityValidationReport
  verificationChecklist: ClientVerificationChecklist
}

interface StoredZipEntry {
  entryName: ClientProfileZipEntryName
  data: Buffer
  crc32: number
}

interface CentralDirectoryEntry {
  entryName: string
  flags: number
  method: number
  modifiedTime: number
  modifiedDate: number
  crc32: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
}

/** Builds the only downloadable archive shape accepted by this project. */
export function buildClientProfileZip(input: GeneratedClientProfile): ClientProfileZipArchive {
  const parsed = generatedClientProfileSchema.safeParse(input)
  if (!parsed.success) throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_INPUT_INVALID')

  const validated = validateArtifacts(parsed.data.artifacts, parsed.data)
  const storedEntries = validated.artifacts.map((artifact): StoredZipEntry => {
    const data = Buffer.from(artifact.content, 'utf8')
    return { entryName: asAllowedEntryName(artifact.entryName), data, crc32: crc32(data) }
  })
  const bytes = writeStoredZip(storedEntries)
  if (bytes.length > MAX_CLIENT_PROFILE_ZIP_BYTES) {
    throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_ARCHIVE_TOO_LARGE')
  }
  return {
    fileName: CLIENT_PROFILE_ZIP_FILE_NAME,
    mediaType: 'application/zip',
    bytes,
    sizeBytes: bytes.length,
    sha256: sha256Bytes(bytes),
    entryCount: CLIENT_PROFILE_ZIP_ENTRY_NAMES.length
  }
}

/** Independently parses and verifies a stored ZIP without trusting builder metadata. */
export function verifyClientProfileZip(input: Uint8Array): ClientProfileZipVerification {
  if (!(input instanceof Uint8Array)) throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_INPUT_INVALID')
  if (input.byteLength > MAX_CLIENT_PROFILE_ZIP_BYTES) {
    throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_ARCHIVE_TOO_LARGE')
  }
  const bytes = Buffer.from(input)
  try {
    const entries = readStoredZip(bytes)
    const artifacts = entries.map((entry): ClientProfileArtifact => {
      const entryName = asAllowedEntryName(entry.entryName)
      const content = decodeUtf8(entry.data)
      return {
        entryName,
        mediaType: MEDIA_TYPES[entryName],
        encoding: 'utf8',
        sizeBytes: entry.data.length,
        sha256: sha256Bytes(entry.data),
        content
      }
    })
    const validated = validateArtifacts(artifacts)
    return {
      format: 'dyson-control-client-profile-zip-verification',
      schemaVersion: 1,
      valid: true,
      archiveSha256: sha256Bytes(bytes),
      sizeBytes: bytes.length,
      artifactSetSha256: validated.artifactSetSha256,
      profileId: validated.documents.profile.profileId,
      entries: validated.artifacts.map((artifact) => ({
        entryName: asAllowedEntryName(artifact.entryName),
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256
      }))
    }
  } catch (error) {
    if (error instanceof ClientProfileZipError) throw error
    throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_MALFORMED')
  }
}

function validateArtifacts(
  artifacts: readonly ClientProfileArtifact[],
  expected?: GeneratedClientProfile
): ValidatedArtifactSet {
  if (artifacts.length !== CLIENT_PROFILE_ZIP_ENTRY_NAMES.length) {
    throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_ENTRY_COUNT_INVALID')
  }

  const normalizedNames: string[] = []
  for (const artifact of artifacts) {
    try {
      normalizedNames.push(assertSafeArtifactEntryName(artifact.entryName).toLowerCase())
    } catch (error) {
      mapArtifactError(error)
    }
  }
  if (new Set(normalizedNames).size !== normalizedNames.length) {
    throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_ENTRY_DUPLICATE')
  }

  for (const artifact of artifacts) {
    if (!ALLOWED_ENTRY_NAMES.has(artifact.entryName)) {
      throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_ENTRY_NAME_INVALID')
    }
    const entryName = asAllowedEntryName(artifact.entryName)
    if (artifact.mediaType !== MEDIA_TYPES[entryName] || artifact.encoding !== 'utf8') {
      throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_ENTRY_TYPE_INVALID')
    }
  }

  let rebuilt: ReturnType<typeof buildClientProfileArtifacts>
  try {
    rebuilt = buildClientProfileArtifacts(artifacts.map((artifact) => ({
      entryName: artifact.entryName,
      mediaType: artifact.mediaType,
      content: artifact.content
    })))
  } catch (error) {
    mapArtifactError(error)
  }

  for (const artifact of rebuilt!.artifacts) {
    const supplied = artifacts.find((candidate) => candidate.entryName === artifact.entryName)
    if (supplied === undefined || supplied.sizeBytes !== artifact.sizeBytes ||
        supplied.sha256.toLowerCase() !== artifact.sha256 || supplied.content !== artifact.content) {
      throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_ARTIFACT_MISMATCH')
    }
  }
  if (expected !== undefined &&
      (expected.totalSizeBytes !== rebuilt!.totalSizeBytes ||
       expected.artifactSetSha256.toLowerCase() !== rebuilt!.artifactSetSha256)) {
    throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_ARTIFACT_MISMATCH')
  }

  const checksums = rebuilt!.artifacts.find((artifact) => artifact.entryName === 'CHECKSUMS.sha256')
  const expectedChecksums = rebuilt!.artifacts
    .filter((artifact) => artifact.entryName !== 'CHECKSUMS.sha256')
    .map((artifact) => `${artifact.sha256}  ${artifact.entryName}\n`)
    .join('')
  if (checksums?.content !== expectedChecksums) {
    throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_CHECKSUMS_MISMATCH')
  }

  const documents = validateDocuments(rebuilt!.artifacts)
  if (expected !== undefined &&
      (!isDeepStrictEqual(documents.profile, expected.profile) ||
       !isDeepStrictEqual(documents.clientModLock, expected.clientModLock) ||
       !isDeepStrictEqual(documents.parityReport, expected.parityReport) ||
       !isDeepStrictEqual(documents.verificationChecklist, expected.verificationChecklist))) {
    throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_ARTIFACT_MISMATCH')
  }
  return {
    artifacts: rebuilt!.artifacts,
    artifactSetSha256: rebuilt!.artifactSetSha256,
    documents
  }
}

function validateDocuments(artifacts: readonly ClientProfileArtifact[]): ClientProfileDocuments {
  for (const artifact of artifacts) {
    assertArchiveContentIsPublic(artifact.content)
  }

  const profile = parseJsonDocument(
    artifactContent(artifacts, 'client-profile.json'),
    (value) => clientProfileDocumentSchema.parse(value)
  )
  const clientModLock = parseJsonDocument(
    artifactContent(artifacts, 'client-mod-lock.json'),
    (value) => clientModLockDocumentSchema.parse(value)
  )
  const parityReport = parseJsonDocument(
    artifactContent(artifacts, 'parity-report.json'),
    (value) => clientParityValidationReportSchema.parse(value)
  )
  const verificationChecklist = parseJsonDocument(
    artifactContent(artifacts, 'verification-checklist.json'),
    (value) => clientVerificationChecklistSchema.parse(value)
  )

  assertCanonicalJson(artifactContent(artifacts, 'client-profile.json'), profile)
  assertCanonicalJson(artifactContent(artifacts, 'client-mod-lock.json'), clientModLock)
  assertCanonicalJson(artifactContent(artifacts, 'parity-report.json'), parityReport)
  assertCanonicalJson(artifactContent(artifacts, 'verification-checklist.json'), verificationChecklist)

  if (!parityReport.canGenerate || !parityReport.runtimeCompatible || parityReport.matchedCompatibilityEntryId === null ||
      profile.runtime.compatibilityEntryId !== parityReport.matchedCompatibilityEntryId ||
      profile.provenance.serverLockSha256 !== clientModLock.serverLockSha256 ||
      profile.provenance.serverLockSha256 !== parityReport.serverLockSha256 ||
      profile.provenance.clientParitySha256 !== clientModLock.clientParitySha256 ||
      profile.provenance.clientParitySha256 !== parityReport.clientParitySha256 ||
      verificationChecklist.serverLockSha256 !== clientModLock.serverLockSha256) {
    throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_DOCUMENT_MISMATCH')
  }

  const expectedRequired = profile.mods.required.map(({ requirement: _requirement, ...entry }) => entry)
  const expectedOptional = profile.mods.optional.map(({ requirement: _requirement, ...entry }) => entry)
  const expectedLockMods = [...profile.mods.required, ...profile.mods.optional].sort(compareClientMods)
  if (!isDeepStrictEqual(parityReport.required, expectedRequired) ||
      !isDeepStrictEqual(parityReport.optional, expectedOptional) ||
      !isDeepStrictEqual(clientModLock.mods, expectedLockMods)) {
    throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_DOCUMENT_MISMATCH')
  }

  const expectedChecklist: ClientVerificationChecklist = {
    format: 'dyson-control-client-verification-checklist',
    schemaVersion: 1,
    serverLockSha256: clientModLock.serverLockSha256,
    checks: [
      {
        id: 'runtime:bepinex', category: 'runtime', requirement: 'required', sourceId: null,
        expectedVersion: normalizeVersion(profile.runtime.bepInEx, 'bepinex'), sha256: null
      },
      {
        id: 'runtime:dsp', category: 'runtime', requirement: 'required', sourceId: null,
        expectedVersion: normalizeVersion(profile.runtime.dsp, 'dsp'), sha256: null
      },
      {
        id: 'runtime:nebula', category: 'runtime', requirement: 'required', sourceId: null,
        expectedVersion: normalizeVersion(profile.runtime.nebula, 'nebula'), sha256: null
      },
      ...expectedLockMods.map((mod) => ({
        id: `mod:${mod.sourceId.toLowerCase()}`,
        category: 'mod' as const,
        requirement: mod.requirement,
        sourceId: mod.sourceId,
        expectedVersion: mod.version,
        sha256: mod.sha256
      }))
    ],
    excluded: parityReport.notRequired.map((entry) => ({
      sourceId: entry.sourceId,
      version: entry.version,
      requirement: 'not-required' as const,
      reason: 'server-only' as const
    }))
  }
  if (!isDeepStrictEqual(verificationChecklist, expectedChecklist)) {
    throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_DOCUMENT_MISMATCH')
  }

  const expectedInstall = renderClientProfileInstallInstructions(profile, parityReport.counts.notRequired)
  if (artifactContent(artifacts, 'INSTALL.md') !== expectedInstall) {
    throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_DOCUMENT_MISMATCH')
  }
  return { profile, clientModLock, parityReport, verificationChecklist }
}

function writeStoredZip(entries: readonly StoredZipEntry[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.entryName, 'utf8')
    const localHeader = Buffer.alloc(ZIP_LOCAL_HEADER_BYTES)
    localHeader.writeUInt32LE(ZIP_LOCAL_SIGNATURE, 0)
    localHeader.writeUInt16LE(ZIP_VERSION, 4)
    localHeader.writeUInt16LE(ZIP_UTF8_FLAG, 6)
    localHeader.writeUInt16LE(ZIP_STORE_METHOD, 8)
    localHeader.writeUInt16LE(ZIP_FIXED_TIME, 10)
    localHeader.writeUInt16LE(ZIP_FIXED_DATE, 12)
    localHeader.writeUInt32LE(entry.crc32, 14)
    localHeader.writeUInt32LE(entry.data.length, 18)
    localHeader.writeUInt32LE(entry.data.length, 22)
    localHeader.writeUInt16LE(nameBytes.length, 26)
    localHeader.writeUInt16LE(0, 28)
    localParts.push(localHeader, nameBytes, entry.data)

    const centralHeader = Buffer.alloc(ZIP_CENTRAL_HEADER_BYTES)
    centralHeader.writeUInt32LE(ZIP_CENTRAL_SIGNATURE, 0)
    centralHeader.writeUInt16LE(ZIP_VERSION, 4)
    centralHeader.writeUInt16LE(ZIP_VERSION, 6)
    centralHeader.writeUInt16LE(ZIP_UTF8_FLAG, 8)
    centralHeader.writeUInt16LE(ZIP_STORE_METHOD, 10)
    centralHeader.writeUInt16LE(ZIP_FIXED_TIME, 12)
    centralHeader.writeUInt16LE(ZIP_FIXED_DATE, 14)
    centralHeader.writeUInt32LE(entry.crc32, 16)
    centralHeader.writeUInt32LE(entry.data.length, 20)
    centralHeader.writeUInt32LE(entry.data.length, 24)
    centralHeader.writeUInt16LE(nameBytes.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(localOffset, 42)
    centralParts.push(centralHeader, nameBytes)
    localOffset += ZIP_LOCAL_HEADER_BYTES + nameBytes.length + entry.data.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(ZIP_END_BYTES)
  end.writeUInt32LE(ZIP_END_SIGNATURE, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(localOffset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, centralDirectory, end])
}

function readStoredZip(bytes: Buffer): Array<{ entryName: string; data: Buffer }> {
  if (bytes.length < ZIP_END_BYTES) throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_MALFORMED')
  const endOffset = bytes.length - ZIP_END_BYTES
  assertRange(bytes, endOffset, ZIP_END_BYTES)
  if (bytes.readUInt32LE(endOffset) !== ZIP_END_SIGNATURE ||
      bytes.readUInt16LE(endOffset + 4) !== 0 || bytes.readUInt16LE(endOffset + 6) !== 0 ||
      bytes.readUInt16LE(endOffset + 20) !== 0) {
    throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_MALFORMED')
  }
  const entryCount = bytes.readUInt16LE(endOffset + 8)
  const totalEntryCount = bytes.readUInt16LE(endOffset + 10)
  const centralSize = bytes.readUInt32LE(endOffset + 12)
  const centralOffset = bytes.readUInt32LE(endOffset + 16)
  if (entryCount !== CLIENT_PROFILE_ZIP_ENTRY_NAMES.length || totalEntryCount !== entryCount) {
    throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_ENTRY_COUNT_INVALID')
  }
  if (centralOffset + centralSize !== endOffset || centralOffset > endOffset) {
    throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_MALFORMED')
  }

  const centralEntries: CentralDirectoryEntry[] = []
  let cursor = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    assertRange(bytes, cursor, ZIP_CENTRAL_HEADER_BYTES)
    if (bytes.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) {
      throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_MALFORMED')
    }
    const versionMadeBy = bytes.readUInt16LE(cursor + 4)
    const versionNeeded = bytes.readUInt16LE(cursor + 6)
    const flags = bytes.readUInt16LE(cursor + 8)
    const method = bytes.readUInt16LE(cursor + 10)
    const modifiedTime = bytes.readUInt16LE(cursor + 12)
    const modifiedDate = bytes.readUInt16LE(cursor + 14)
    const nameLength = bytes.readUInt16LE(cursor + 28)
    const extraLength = bytes.readUInt16LE(cursor + 30)
    const commentLength = bytes.readUInt16LE(cursor + 32)
    const diskStart = bytes.readUInt16LE(cursor + 34)
    const internalAttributes = bytes.readUInt16LE(cursor + 36)
    const externalAttributes = bytes.readUInt32LE(cursor + 38)
    const entryEnd = cursor + ZIP_CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength
    assertRange(bytes, cursor, entryEnd - cursor)
    if (entryEnd > endOffset || versionMadeBy !== ZIP_VERSION || versionNeeded !== ZIP_VERSION ||
        flags !== ZIP_UTF8_FLAG || method !== ZIP_STORE_METHOD || modifiedTime !== ZIP_FIXED_TIME ||
        modifiedDate !== ZIP_FIXED_DATE || extraLength !== 0 || commentLength !== 0 || diskStart !== 0 ||
        internalAttributes !== 0) {
      throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_UNSUPPORTED')
    }
    if (externalAttributes !== 0) {
      throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_SYMLINK_REJECTED')
    }
    centralEntries.push({
      entryName: decodeUtf8(bytes.subarray(cursor + ZIP_CENTRAL_HEADER_BYTES, cursor + ZIP_CENTRAL_HEADER_BYTES + nameLength)),
      flags,
      method,
      modifiedTime,
      modifiedDate,
      crc32: bytes.readUInt32LE(cursor + 16),
      compressedSize: bytes.readUInt32LE(cursor + 20),
      uncompressedSize: bytes.readUInt32LE(cursor + 24),
      localOffset: bytes.readUInt32LE(cursor + 42)
    })
    cursor = entryEnd
  }
  if (cursor !== endOffset) throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_MALFORMED')

  const normalizedNames: string[] = []
  for (const entry of centralEntries) {
    try {
      normalizedNames.push(assertSafeArtifactEntryName(entry.entryName).toLowerCase())
    } catch (error) {
      mapArtifactError(error)
    }
  }
  if (new Set(normalizedNames).size !== normalizedNames.length) {
    throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_ENTRY_DUPLICATE')
  }
  if (!centralEntries.every((entry, index) => entry.entryName === CLIENT_PROFILE_ZIP_ENTRY_NAMES[index])) {
    throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_ENTRY_NAME_INVALID')
  }

  const extracted: Array<{ entryName: string; data: Buffer }> = []
  let expectedLocalOffset = 0
  let totalSize = 0
  for (const entry of centralEntries) {
    if (entry.uncompressedSize > MAX_CLIENT_PROFILE_ARTIFACT_BYTES ||
        entry.compressedSize !== entry.uncompressedSize) {
      throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_ENTRY_TOO_LARGE')
    }
    totalSize += entry.uncompressedSize
    if (totalSize > MAX_CLIENT_PROFILE_TOTAL_BYTES) {
      throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_ARCHIVE_TOO_LARGE')
    }
    if (entry.localOffset !== expectedLocalOffset) {
      throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_MALFORMED')
    }
    assertRange(bytes, entry.localOffset, ZIP_LOCAL_HEADER_BYTES)
    const offset = entry.localOffset
    if (bytes.readUInt32LE(offset) !== ZIP_LOCAL_SIGNATURE || bytes.readUInt16LE(offset + 4) !== ZIP_VERSION ||
        bytes.readUInt16LE(offset + 6) !== entry.flags || bytes.readUInt16LE(offset + 8) !== entry.method ||
        bytes.readUInt16LE(offset + 10) !== entry.modifiedTime || bytes.readUInt16LE(offset + 12) !== entry.modifiedDate ||
        bytes.readUInt32LE(offset + 14) !== entry.crc32 || bytes.readUInt32LE(offset + 18) !== entry.compressedSize ||
        bytes.readUInt32LE(offset + 22) !== entry.uncompressedSize) {
      throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_MALFORMED')
    }
    const nameLength = bytes.readUInt16LE(offset + 26)
    const extraLength = bytes.readUInt16LE(offset + 28)
    const nameStart = offset + ZIP_LOCAL_HEADER_BYTES
    const dataStart = nameStart + nameLength + extraLength
    const dataEnd = dataStart + entry.uncompressedSize
    assertRange(bytes, nameStart, nameLength + extraLength + entry.uncompressedSize)
    if (extraLength !== 0 || dataEnd > centralOffset || decodeUtf8(bytes.subarray(nameStart, nameStart + nameLength)) !== entry.entryName) {
      throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_MALFORMED')
    }
    const data = Buffer.from(bytes.subarray(dataStart, dataEnd))
    if (crc32(data) !== entry.crc32) throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_CRC_MISMATCH')
    extracted.push({ entryName: entry.entryName, data })
    expectedLocalOffset = dataEnd
  }
  if (expectedLocalOffset !== centralOffset) throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_MALFORMED')
  return extracted
}

function parseJsonDocument<T>(content: string, parse: (value: unknown) => T): T {
  try {
    return parse(JSON.parse(content) as unknown)
  } catch {
    throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_DOCUMENT_INVALID')
  }
}

function assertCanonicalJson(content: string, value: unknown): void {
  if (content !== `${JSON.stringify(value, null, 2)}\n`) {
    throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_DOCUMENT_INVALID')
  }
}

function artifactContent(artifacts: readonly ClientProfileArtifact[], entryName: ClientProfileZipEntryName): string {
  const artifact = artifacts.find((candidate) => candidate.entryName === entryName)
  if (artifact === undefined) throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_ENTRY_NAME_INVALID')
  return artifact.content
}

function assertArchiveContentIsPublic(content: string): void {
  try {
    assertPublicArtifactContent(content)
  } catch (error) {
    mapArtifactError(error)
  }
  if (/[^\t\n\r\x20-\x7e]/.test(content) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content) ||
      /["']?(?:password|passwd|secret|token|api[_-]?key|credential|private[_-]?key)["']?\s*[:=]/i.test(content) ||
      /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----/i.test(content) ||
      /[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i.test(content) ||
      /(?:^|[\s"'=])\/(?:root|mnt|data|games?|programdata|windows)\//im.test(content)) {
    throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_PRIVATE_MATERIAL')
  }
}

function asAllowedEntryName(entryName: string): ClientProfileZipEntryName {
  if (!ALLOWED_ENTRY_NAMES.has(entryName)) {
    throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_ENTRY_NAME_INVALID')
  }
  return entryName as ClientProfileZipEntryName
}

function mapArtifactError(error: unknown): never {
  if (error instanceof ClientProfileArtifactError) {
    if (error.code === 'CLIENT_PROFILE_ARTIFACT_PRIVATE_MATERIAL') {
      throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_PRIVATE_MATERIAL')
    }
    if (error.code === 'CLIENT_PROFILE_ARTIFACT_NAME_INVALID') {
      throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_ENTRY_NAME_INVALID')
    }
    if (error.code === 'CLIENT_PROFILE_ARTIFACT_DUPLICATE') {
      throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_ENTRY_DUPLICATE')
    }
    if (error.code === 'CLIENT_PROFILE_ARTIFACT_TOO_LARGE') {
      throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_ENTRY_TOO_LARGE')
    }
    if (error.code === 'CLIENT_PROFILE_ARTIFACT_SET_TOO_LARGE') {
      throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_ARCHIVE_TOO_LARGE')
    }
  }
  throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_INPUT_INVALID')
}

function decodeUtf8(value: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value)
  } catch {
    throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_DOCUMENT_INVALID')
  }
}

function assertRange(bytes: Buffer, offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
      offset > bytes.length || length > bytes.length - offset) {
    throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_MALFORMED')
  }
}

function compareClientMods(left: ClientProfileDocument['mods']['required'][number], right: ClientProfileDocument['mods']['required'][number]): number {
  const requirementOrder = { required: 0, optional: 1 }
  return requirementOrder[left.requirement] - requirementOrder[right.requirement] ||
    compareText(left.sourceId.toLowerCase(), right.sourceId.toLowerCase()) || compareText(left.version, right.version)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function crc32(value: Uint8Array): number {
  let checksum = 0xffffffff
  for (const byte of value) checksum = CRC32_TABLE[(checksum ^ byte) & 0xff]! ^ (checksum >>> 8)
  return (checksum ^ 0xffffffff) >>> 0
}

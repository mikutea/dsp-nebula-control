import { createHash } from 'node:crypto'
import { buildClientProfileArtifacts, sha256, type ClientProfileArtifactInput } from './artifact.js'
import { assertDigestEqual, sha256Bytes } from './canonical.js'
import { generateClientProfile } from './generator.js'
import {
  consumeVerifiedHostnameWssQualification,
  verifyHostnameWssQualification,
  type ClientQualificationProjection,
  type ProtectedClientQualificationConsumer,
  type VerifyHostnameWssQualificationOptions,
  type VerifiedHostnameWssQualification
} from './qualification-v2.js'
import type { ProtectedClientQualificationStore } from './qualification-store.js'
import type {
  ClientModLockDocument,
  ClientParityValidationReport,
  ClientProfileArtifact,
  ClientProfileModEntry,
  ClientVerificationChecklist
} from './types.js'

export const QUALIFIED_CLIENT_PROFILE_ZIP_FILE_NAME = 'dyson-qualified-client-profile.zip' as const
export const QUALIFIED_NEBULA_CLIENT_ZIP_FILE_NAME = 'dyson-qualified-nebula-client.zip' as const

export interface QualifiedClientProfileDocument {
  format: 'dyson-control-client-profile'
  schemaVersion: 2
  profileId: string
  displayName: string
  productionQualification: ClientQualificationProjection
  connection: VerifiedHostnameWssQualification['connection'] & {
    websocketUrl: string
  }
  runtime: {
    dsp: string
    nebula: string
    bepInEx: string
    compatibilityEntryId: string
  }
  provenance: {
    serverLockSha256: string
    clientParitySha256: string
    compatibilityPolicySha256: string
    qualificationDocumentSha256: string
  }
  mods: {
    required: ClientProfileModEntry[]
    optional: ClientProfileModEntry[]
  }
}

export interface QualifiedClientRuntimeDocument {
  format: 'dyson-control-qualified-client-runtime'
  schemaVersion: 1
  qualification: ClientQualificationProjection
  connection: QualifiedClientProfileDocument['connection']
  contracts: VerifiedHostnameWssQualification['bindings']
  runtimeBinaries: VerifiedHostnameWssQualification['binaries']
  clientPayload: {
    fileName: typeof QUALIFIED_NEBULA_CLIENT_ZIP_FILE_NAME
    manifestSha256: string
    packageSha256: string
    packageSizeBytes: number
    treeSha256: string
    fileCount: number
  }
  profilePackage: {
    fileName: typeof QUALIFIED_CLIENT_PROFILE_ZIP_FILE_NAME
    artifactSetSha256: string
    zipSha256: string
    zipSizeBytes: number
  }
  policies: {
    serverLockSha256: string
    clientParitySha256: string
    compatibilityPolicySha256: string
  }
}

export interface QualifiedClientProfileArchive {
  fileName: typeof QUALIFIED_CLIENT_PROFILE_ZIP_FILE_NAME
  mediaType: 'application/zip'
  bytes: Buffer
  sizeBytes: number
  sha256: string
  entryCount: number
}

export interface QualifiedNebulaClientArchive {
  fileName: typeof QUALIFIED_NEBULA_CLIENT_ZIP_FILE_NAME
  mediaType: 'application/zip'
  bytes: Buffer
  sizeBytes: number
  sha256: string
}

export interface GeneratedQualifiedClientProfile {
  format: 'dyson-control-qualified-client-profile-artifact-set'
  schemaVersion: 2
  productionQualified: true
  qualification: ClientQualificationProjection
  profile: QualifiedClientProfileDocument
  clientModLock: ClientModLockDocument
  parityReport: ClientParityValidationReport
  verificationChecklist: ClientVerificationChecklist
  qualifiedClientRuntime: QualifiedClientRuntimeDocument
  profileArtifacts: ClientProfileArtifact[]
  profileArtifactSetSha256: string
  profileArchive: QualifiedClientProfileArchive
  qualifiedClientPayload: QualifiedNebulaClientArchive
  qualifiedRuntimeArtifact: ClientProfileArtifact
}

export interface GeneratedQualifiedClientProfileMetadata {
  format: 'dyson-control-qualified-client-profile-issue'
  schemaVersion: 1
  productionQualified: true
  qualification: ClientQualificationProjection
  profile: {
    profileId: string
    displayName: string
    connection: QualifiedClientProfileDocument['connection']
    runtime: QualifiedClientProfileDocument['runtime']
    provenance: QualifiedClientProfileDocument['provenance']
    requiredModCount: number
    optionalModCount: number
  }
  qualifiedClientRuntime: QualifiedClientRuntimeDocument
  artifacts: {
    profileArtifactSetSha256: string
    profileArchive: Omit<QualifiedClientProfileArchive, 'bytes'>
    qualifiedClientPayload: Omit<QualifiedNebulaClientArchive, 'bytes'>
    qualifiedRuntime: Pick<ClientProfileArtifact, 'entryName' | 'mediaType' | 'sizeBytes' | 'sha256'>
  }
}

/** Low-level artifact builder. Never serialize this result directly because it owns archive bytes. */
export async function generateQualifiedClientProfileV2(
  request: unknown,
  store: ProtectedClientQualificationStore,
  consumer: ProtectedClientQualificationConsumer,
  options: VerifyHostnameWssQualificationOptions = {}
): Promise<GeneratedQualifiedClientProfile> {
  const verified = await verifyHostnameWssQualification(request, store, options)
  const clientPayloadBytes = Buffer.from(await store.readClientPackage(verified.qualificationId))
  const clientPayloadSha256 = sha256Bytes(clientPayloadBytes)
  assertDigestEqual(
    clientPayloadSha256,
    verified.bindings.clientPackageSha256,
    'CLIENT_QUALIFICATION_CLIENT_PACKAGE_CHANGED'
  )
  const qualification = await consumeVerifiedHostnameWssQualification(verified, consumer)
  const legacy = generateClientProfile(verified.assessedProfile.input)
  const connection: QualifiedClientProfileDocument['connection'] = {
    ...verified.connection,
    websocketUrl: `wss://${verified.connection.host}:443/socket`
  }
  const profile: QualifiedClientProfileDocument = {
    format: 'dyson-control-client-profile',
    schemaVersion: 2,
    profileId: legacy.profile.profileId,
    displayName: legacy.profile.displayName,
    productionQualification: qualification,
    connection,
    runtime: legacy.profile.runtime,
    provenance: {
      serverLockSha256: legacy.profile.provenance.serverLockSha256,
      clientParitySha256: legacy.profile.provenance.clientParitySha256,
      compatibilityPolicySha256: verified.bindings.compatibilityPolicySha256,
      qualificationDocumentSha256: verified.documentSha256
    },
    mods: legacy.profile.mods
  }

  const baseArtifacts = buildQualifiedProfileBaseArtifacts(
    profile,
    legacy.clientModLock,
    legacy.parityReport,
    legacy.verificationChecklist
  )
  const baseBuilt = buildClientProfileArtifacts(baseArtifacts)
  const checksums = baseBuilt.artifacts.map((artifact) =>
    `${artifact.sha256}  ${artifact.entryName}\n`).join('')
  const profileBuilt = buildClientProfileArtifacts([
    ...baseArtifacts,
    { entryName: 'CHECKSUMS.sha256', mediaType: 'text/plain', content: checksums }
  ])
  const archive = buildQualifiedProfileArchive(profileBuilt.artifacts)
  const qualifiedClientRuntime: QualifiedClientRuntimeDocument = {
    format: 'dyson-control-qualified-client-runtime',
    schemaVersion: 1,
    qualification,
    connection,
    contracts: verified.bindings,
    runtimeBinaries: verified.binaries,
    clientPayload: {
      fileName: QUALIFIED_NEBULA_CLIENT_ZIP_FILE_NAME,
      manifestSha256: verified.bindings.clientManifestSha256,
      packageSha256: verified.bindings.clientPackageSha256,
      packageSizeBytes: clientPayloadBytes.length,
      treeSha256: verified.clientManifest.treeSha256,
      fileCount: verified.clientManifest.files.length
    },
    profilePackage: {
      fileName: QUALIFIED_CLIENT_PROFILE_ZIP_FILE_NAME,
      artifactSetSha256: profileBuilt.artifactSetSha256,
      zipSha256: archive.sha256,
      zipSizeBytes: archive.sizeBytes
    },
    policies: {
      serverLockSha256: verified.bindings.serverLockSha256,
      clientParitySha256: verified.bindings.clientParitySha256,
      compatibilityPolicySha256: verified.bindings.compatibilityPolicySha256
    }
  }
  const runtimeBuilt = buildClientProfileArtifacts([{
    entryName: 'qualified-client-runtime.json',
    mediaType: 'application/json',
    content: serializeJson(qualifiedClientRuntime)
  }])

  return {
    format: 'dyson-control-qualified-client-profile-artifact-set',
    schemaVersion: 2,
    productionQualified: true,
    qualification,
    profile,
    clientModLock: legacy.clientModLock,
    parityReport: legacy.parityReport,
    verificationChecklist: legacy.verificationChecklist,
    qualifiedClientRuntime,
    profileArtifacts: profileBuilt.artifacts,
    profileArtifactSetSha256: profileBuilt.artifactSetSha256,
    profileArchive: archive,
    qualifiedClientPayload: {
      fileName: QUALIFIED_NEBULA_CLIENT_ZIP_FILE_NAME,
      mediaType: 'application/zip',
      bytes: clientPayloadBytes,
      sizeBytes: clientPayloadBytes.length,
      sha256: clientPayloadSha256
    },
    qualifiedRuntimeArtifact: runtimeBuilt.artifacts[0]!
  }
}

/**
 * Safe JSON projection for an issued result. Archive bytes are intentionally
 * available only through the issued-profile archive store.
 */
export function projectGeneratedQualifiedClientProfile(
  generated: GeneratedQualifiedClientProfile
): GeneratedQualifiedClientProfileMetadata {
  const { bytes: _archiveBytes, ...profileArchive } = generated.profileArchive
  const { bytes: _clientPayloadBytes, ...qualifiedClientPayload } = generated.qualifiedClientPayload
  const runtimeArtifact = generated.qualifiedRuntimeArtifact
  return {
    format: 'dyson-control-qualified-client-profile-issue',
    schemaVersion: 1,
    productionQualified: true,
    qualification: generated.qualification,
    profile: {
      profileId: generated.profile.profileId,
      displayName: generated.profile.displayName,
      connection: generated.profile.connection,
      runtime: generated.profile.runtime,
      provenance: generated.profile.provenance,
      requiredModCount: generated.profile.mods.required.length,
      optionalModCount: generated.profile.mods.optional.length
    },
    qualifiedClientRuntime: generated.qualifiedClientRuntime,
    artifacts: {
      profileArtifactSetSha256: generated.profileArtifactSetSha256,
      profileArchive,
      qualifiedClientPayload,
      qualifiedRuntime: {
        entryName: runtimeArtifact.entryName,
        mediaType: runtimeArtifact.mediaType,
        sizeBytes: runtimeArtifact.sizeBytes,
        sha256: runtimeArtifact.sha256
      }
    }
  }
}

function buildQualifiedProfileBaseArtifacts(
  profile: QualifiedClientProfileDocument,
  clientModLock: ClientModLockDocument,
  parityReport: ClientParityValidationReport,
  verificationChecklist: ClientVerificationChecklist
): ClientProfileArtifactInput[] {
  return [
    {
      entryName: 'INSTALL.md',
      mediaType: 'text/markdown',
      content: renderQualifiedInstallInstructions(profile, parityReport.counts.notRequired)
    },
    { entryName: 'client-mod-lock.json', mediaType: 'application/json', content: serializeJson(clientModLock) },
    { entryName: 'client-profile.json', mediaType: 'application/json', content: serializeJson(profile) },
    { entryName: 'parity-report.json', mediaType: 'application/json', content: serializeJson(parityReport) },
    {
      entryName: 'verification-checklist.json', mediaType: 'application/json',
      content: serializeJson(verificationChecklist)
    }
  ]
}

function renderQualifiedInstallInstructions(profile: QualifiedClientProfileDocument, excludedCount: number): string {
  return `# ${profile.displayName} qualified client profile\n\n` +
    `This metadata profile is bound to one protected hostname-preserving WSS qualification.\n\n` +
    `## Required runtime\n\n` +
    `- Dyson Sphere Program ${profile.runtime.dsp}\n` +
    `- BepInEx ${profile.runtime.bepInEx}\n` +
    `- Nebula ${profile.runtime.nebula}\n\n` +
    `## Verify and join\n\n` +
    `1. Verify qualified-client-runtime.json before using this profile.\n` +
    `2. Install each required entry in client-mod-lock.json and verify every SHA-256.\n` +
    `3. Do not install the ${excludedCount} server-only entr${excludedCount === 1 ? 'y' : 'ies'}.\n` +
    `4. Use the exact qualified hostname-preserving Nebula runtime recorded in that file.\n` +
    `5. Join ${profile.connection.displayAddress}; it uses WSS at ${profile.connection.websocketUrl}.\n\n` +
    `Private join material is intentionally absent. This profile does not contain the licensed game.\n`
}

function buildQualifiedProfileArchive(artifacts: readonly ClientProfileArtifact[]): QualifiedClientProfileArchive {
  const sorted = [...artifacts].sort((left, right) => compareOrdinal(left.entryName, right.entryName))
  const entries = sorted.map((artifact) => {
    const bytes = Buffer.from(artifact.content, 'utf8')
    if (bytes.byteLength !== artifact.sizeBytes || sha256(artifact.content) !== artifact.sha256) {
      throw new Error('CLIENT_QUALIFICATION_PROFILE_ARTIFACT_INVALID')
    }
    return { name: artifact.entryName, bytes, crc32: crc32(bytes) }
  })
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x0021, 12)
    local.writeUInt32LE(entry.crc32, 14)
    local.writeUInt32LE(entry.bytes.length, 18)
    local.writeUInt32LE(entry.bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, name, entry.bytes)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x0021, 14)
    central.writeUInt32LE(entry.crc32, 16)
    central.writeUInt32LE(entry.bytes.length, 20)
    central.writeUInt32LE(entry.bytes.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(localOffset, 42)
    centralParts.push(central, name)
    localOffset += local.length + name.length + entry.bytes.length
  }
  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(localOffset, 16)
  const bytes = Buffer.concat([...localParts, centralDirectory, end])
  return {
    fileName: QUALIFIED_CLIENT_PROFILE_ZIP_FILE_NAME,
    mediaType: 'application/zip',
    bytes,
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    entryCount: entries.length
  }
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
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

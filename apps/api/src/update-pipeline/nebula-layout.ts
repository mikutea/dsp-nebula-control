import { createHash } from 'node:crypto'
import { z } from 'zod'
import { normalizeVersion } from '../updates/version.js'
import {
  componentReleaseManifestSchema,
  readValidatedZipArchive,
  type ComponentArchiveLimits,
  type ComponentReleaseManifest,
  type ValidatedZipArchiveEntry
} from './activation-archive.js'
import { ComponentUpdateActivationError } from './activation-types.js'

export const nebulaWindowsLayoutPolicyIds = Object.freeze({
  v0_9_22: 'nebula-official-windows-v0.9.22'
} as const)

export type NebulaWindowsLayoutPolicyId = typeof nebulaWindowsLayoutPolicyIds[keyof typeof nebulaWindowsLayoutPolicyIds]

export interface NebulaWindowsLayoutPolicy {
  id: NebulaWindowsLayoutPolicyId
  version: '0.9.22'
  sourceFiles: readonly string[]
  runtimeFiles: readonly string[]
}

export interface PreparedNebulaComponentArchive {
  policy: NebulaWindowsLayoutPolicyId
  manifest: ComponentReleaseManifest
  archive: Buffer
  sizeBytes: number
  sha256: string
}

const artifactIdSchema = z.string().min(16).max(96).regex(/^[a-z0-9][a-z0-9-]+$/)
const packageManifestSchema = z.strictObject({
  name: z.string().min(1).max(64),
  description: z.string().max(1_024),
  version_number: z.string().min(1).max(64),
  dependencies: z.array(z.string().min(5).max(160)).max(64),
  website_url: z.string().url().max(2_048)
})

const mainRoot = 'nebula-NebulaMultiplayerMod'
const apiRoot = 'nebula-NebulaMultiplayerModApi'

const v0_9_22SourceFiles = Object.freeze([
  `${mainRoot}/CHANGELOG.md`,
  `${mainRoot}/discord_game_sdk_dotnet.dll`,
  `${mainRoot}/discord_game_sdk_dotnet.pdb`,
  `${mainRoot}/discord_game_sdk.bundle`,
  `${mainRoot}/discord_game_sdk.dll`,
  `${mainRoot}/discord_game_sdk.dll.lib`,
  `${mainRoot}/discord_game_sdk.dylib`,
  `${mainRoot}/discord_game_sdk.so`,
  `${mainRoot}/icon.png`,
  `${mainRoot}/K4os.Compression.LZ4.dll`,
  `${mainRoot}/K4os.Compression.LZ4.License`,
  `${mainRoot}/K4os.Compression.LZ4.Streams.dll`,
  `${mainRoot}/K4os.Hash.xxHash.dll`,
  `${mainRoot}/K4os.Hash.xxHash.License`,
  `${mainRoot}/manifest.json`,
  `${mainRoot}/nebula.LICENSE`,
  `${mainRoot}/nebulabundle`,
  `${mainRoot}/NebulaModel.dll`,
  `${mainRoot}/NebulaModel.pdb`,
  `${mainRoot}/NebulaNetwork.dll`,
  `${mainRoot}/NebulaNetwork.pdb`,
  `${mainRoot}/NebulaPatcher.dll`,
  `${mainRoot}/NebulaPatcher.pdb`,
  `${mainRoot}/NebulaWorld.dll`,
  `${mainRoot}/NebulaWorld.pdb`,
  `${mainRoot}/Networking/Serialization/LICENSE.txt`,
  `${mainRoot}/Networking/Serialization/README.txt`,
  `${mainRoot}/Open.Nat.dll`,
  `${mainRoot}/README.md`,
  `${mainRoot}/System.Buffers.dll`,
  `${mainRoot}/System.IO.Pipelines.dll`,
  `${mainRoot}/System.Memory.dll`,
  `${mainRoot}/System.Numerics.Vectors.dll`,
  `${mainRoot}/System.Runtime.CompilerServices.Unsafe.dll`,
  `${mainRoot}/System.Threading.Tasks.Extensions.dll`,
  `${mainRoot}/Unity.TextMeshPro.dll`,
  `${mainRoot}/websocket-sharp.dll`,
  `${mainRoot}/websocket-sharp.License`,
  `${apiRoot}/icon.png`,
  `${apiRoot}/manifest.json`,
  `${apiRoot}/nebula.LICENSE`,
  `${apiRoot}/NebulaAPI.dll`,
  `${apiRoot}/NebulaAPI.pdb`,
  `${apiRoot}/README.md`
].sort(compareText))

const v0_9_22RuntimeFiles = Object.freeze([
  `${mainRoot}/discord_game_sdk_dotnet.dll`,
  `${mainRoot}/discord_game_sdk.dll`,
  `${mainRoot}/K4os.Compression.LZ4.dll`,
  `${mainRoot}/K4os.Compression.LZ4.Streams.dll`,
  `${mainRoot}/K4os.Hash.xxHash.dll`,
  `${mainRoot}/manifest.json`,
  `${mainRoot}/nebulabundle`,
  `${mainRoot}/NebulaModel.dll`,
  `${mainRoot}/NebulaNetwork.dll`,
  `${mainRoot}/NebulaPatcher.dll`,
  `${mainRoot}/NebulaWorld.dll`,
  `${mainRoot}/Open.Nat.dll`,
  `${mainRoot}/System.Buffers.dll`,
  `${mainRoot}/System.IO.Pipelines.dll`,
  `${mainRoot}/System.Memory.dll`,
  `${mainRoot}/System.Numerics.Vectors.dll`,
  `${mainRoot}/System.Runtime.CompilerServices.Unsafe.dll`,
  `${mainRoot}/System.Threading.Tasks.Extensions.dll`,
  `${mainRoot}/Unity.TextMeshPro.dll`,
  `${mainRoot}/websocket-sharp.dll`,
  `${apiRoot}/manifest.json`,
  `${apiRoot}/NebulaAPI.dll`
].sort(compareText))

const policyV0_9_22: NebulaWindowsLayoutPolicy = Object.freeze({
  id: nebulaWindowsLayoutPolicyIds.v0_9_22,
  version: '0.9.22',
  sourceFiles: v0_9_22SourceFiles,
  runtimeFiles: v0_9_22RuntimeFiles
})

export function resolveNebulaWindowsLayoutPolicy(versionInput: unknown): NebulaWindowsLayoutPolicy {
  const version = normalizeVersion(versionInput, 'nebula')
  if (version === policyV0_9_22.version) return policyV0_9_22
  throw new ComponentUpdateActivationError('UPDATE_NEBULA_LAYOUT_UNSUPPORTED')
}

export function isNebulaManagedRuntimePath(relativePath: string): boolean {
  if (relativePath === `plugins/${mainRoot}/nebulabundle`) return true
  if (!relativePath.startsWith(`plugins/${mainRoot}/`) && !relativePath.startsWith(`plugins/${apiRoot}/`)) return false
  return /\.(?:dll|json)$/i.test(relativePath)
}

export async function prepareOfficialNebulaWindowsArchive(input: {
  sourceArchivePath: string
  version: unknown
  artifactId: unknown
  limits: ComponentArchiveLimits
}): Promise<PreparedNebulaComponentArchive> {
  const policy = resolveNebulaWindowsLayoutPolicy(input.version)
  const artifactId = artifactIdSchema.parse(input.artifactId)
  const source = await readValidatedZipArchive(input.sourceArchivePath, input.limits)
  assertExactSourceLayout(source, policy)
  assertPackageIdentity(source, policy)

  const byName = new Map(source.map((entry) => [entry.name, entry]))
  const payload = policy.runtimeFiles.map((sourceName) => {
    const entry = byName.get(sourceName)
    if (entry === undefined) throw new ComponentUpdateActivationError('UPDATE_NEBULA_LAYOUT_INVALID')
    return {
      relativePath: `plugins/${sourceName}`,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
      bytes: entry.bytes
    }
  })
  const manifest = componentReleaseManifestSchema.parse({
    format: 'dyson-control-component-release',
    schemaVersion: 1,
    component: 'nebula',
    version: policy.version,
    artifactId,
    files: payload.map(({ relativePath, sizeBytes, sha256 }) => ({ relativePath, sizeBytes, sha256 }))
  })
  const manifestBytes = Buffer.from(`${canonicalJson(manifest)}\n`, 'utf8')
  const archive = buildStoredZip([
    { name: 'dyson-component-manifest.json', bytes: manifestBytes },
    ...payload.map((entry) => ({ name: entry.relativePath, bytes: entry.bytes }))
  ])
  return {
    policy: policy.id,
    manifest,
    archive,
    sizeBytes: archive.length,
    sha256: createHash('sha256').update(archive).digest('hex')
  }
}

function assertExactSourceLayout(source: readonly ValidatedZipArchiveEntry[], policy: NebulaWindowsLayoutPolicy): void {
  const names = source.map((entry) => entry.name).sort(compareText)
  if (names.length !== policy.sourceFiles.length || names.some((name, index) => name !== policy.sourceFiles[index])) {
    throw new ComponentUpdateActivationError('UPDATE_NEBULA_LAYOUT_INVALID')
  }
}

function assertPackageIdentity(source: readonly ValidatedZipArchiveEntry[], policy: NebulaWindowsLayoutPolicy): void {
  const byName = new Map(source.map((entry) => [entry.name, entry]))
  const main = parsePackageManifest(byName.get(`${mainRoot}/manifest.json`))
  const api = parsePackageManifest(byName.get(`${apiRoot}/manifest.json`))
  if (main.name !== 'NebulaMultiplayerMod' || main.version_number !== policy.version ||
      main.website_url !== 'https://github.com/NebulaModTeam/nebula' ||
      api.name !== 'NebulaMultiplayerModApi' || api.version_number !== '2.1.0' ||
      api.website_url !== 'https://github.com/NebulaModTeam/nebula' ||
      !main.dependencies.includes(`nebula-NebulaMultiplayerModApi-${api.version_number}`)) {
    throw new ComponentUpdateActivationError('UPDATE_NEBULA_IDENTITY_INVALID')
  }
}

function parsePackageManifest(entry: ValidatedZipArchiveEntry | undefined): z.infer<typeof packageManifestSchema> {
  if (entry === undefined || entry.sizeBytes > 32 * 1_024) {
    throw new ComponentUpdateActivationError('UPDATE_NEBULA_IDENTITY_INVALID')
  }
  try {
    return packageManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes)) as unknown)
  } catch (error) {
    throw new ComponentUpdateActivationError('UPDATE_NEBULA_IDENTITY_INVALID', { cause: error })
  }
}

function buildStoredZip(entriesInput: Array<{ name: string; bytes: Buffer }>): Buffer {
  const entries = [...entriesInput].sort((left, right) => compareText(left.name, right.name))
  const names = new Set<string>()
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const key = entry.name.toLowerCase()
    if (names.has(key)) throw new ComponentUpdateActivationError('UPDATE_ARCHIVE_DUPLICATE_FILE')
    names.add(key)
    const name = Buffer.from(entry.name, 'utf8')
    const checksum = crc32(entry.bytes)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(entry.bytes.length, 18)
    local.writeUInt32LE(entry.bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, entry.bytes)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(entry.bytes.length, 20)
    central.writeUInt32LE(entry.bytes.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + entry.bytes.length
  }
  const centralDirectory = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDirectory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, centralDirectory, eocd])
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

const crc32Table = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc32Table[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0
  return (crc ^ 0xffffffff) >>> 0
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectComponentArchive } from './activation-archive.js'
import {
  isNebulaManagedRuntimePath,
  nebulaWindowsLayoutPolicyIds,
  prepareOfficialNebulaWindowsArchive,
  resolveNebulaWindowsLayoutPolicy
} from './nebula-layout.js'

const roots: string[] = []
const limits = {
  maximumArchiveBytes: 64 * 1_024 * 1_024,
  maximumFileBytes: 32 * 1_024 * 1_024,
  maximumExpandedBytes: 64 * 1_024 * 1_024,
  maximumFiles: 128
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('official Nebula Windows component preparation', () => {
  it('normalizes the exact official 0.9.22 layout into a deterministic activatable component archive', async () => {
    const fixture = await makeFixture()
    const artifactId = 'nebula-prepared-artifact-0922'
    const first = await prepareOfficialNebulaWindowsArchive({
      sourceArchivePath: fixture.source,
      version: 'v0.9.22',
      artifactId,
      limits
    })
    const second = await prepareOfficialNebulaWindowsArchive({
      sourceArchivePath: fixture.source,
      version: '0.9.22',
      artifactId,
      limits
    })

    expect(first.policy).toBe(nebulaWindowsLayoutPolicyIds.v0_9_22)
    expect(second.archive).toEqual(first.archive)
    expect(first.sha256).toBe(createHash('sha256').update(first.archive).digest('hex'))
    expect(first.manifest).toMatchObject({ component: 'nebula', version: '0.9.22', artifactId })
    expect(first.manifest.files.length).toBe(resolveNebulaWindowsLayoutPolicy('0.9.22').runtimeFiles.length)
    expect(first.manifest.files.every((entry) => isNebulaManagedRuntimePath(entry.relativePath))).toBe(true)
    expect(first.manifest.files.some((entry) => entry.relativePath.endsWith('/nebulabundle'))).toBe(true)
    expect(first.manifest.files.some((entry) => entry.relativePath.endsWith('.pdb'))).toBe(false)
    expect(first.manifest.files.some((entry) => /\.(?:so|dylib|bundle|lib)$/i.test(entry.relativePath))).toBe(false)

    const prepared = path.join(fixture.root, 'prepared.zip')
    await writeFile(prepared, first.archive)
    const inspected = await inspectComponentArchive({
      archivePath: prepared,
      expectedComponent: 'nebula',
      expectedVersion: '0.9.22',
      expectedArtifactId: artifactId,
      limits
    })
    expect(inspected.manifest).toEqual(first.manifest)
    expect(inspected.summary.fileCount).toBe(first.manifest.files.length)
  })

  it('rejects missing, extra, and case-colliding upstream entries before producing a component', async () => {
    for (const mutation of ['missing', 'extra', 'collision'] as const) {
      const fixture = await makeFixture(mutation)
      await expect(prepareOfficialNebulaWindowsArchive({
        sourceArchivePath: fixture.source,
        version: '0.9.22',
        artifactId: 'nebula-prepared-layout-invalid',
        limits
      })).rejects.toThrow(mutation === 'collision' ? 'UPDATE_ARCHIVE_DUPLICATE_FILE' : 'UPDATE_NEBULA_LAYOUT_INVALID')
    }
  })

  it('binds both embedded package identities, API dependency, and version', async () => {
    for (const mutation of ['main-version', 'api-version', 'website', 'api-dependency'] as const) {
      const fixture = await makeFixture(mutation)
      await expect(prepareOfficialNebulaWindowsArchive({
        sourceArchivePath: fixture.source,
        version: '0.9.22',
        artifactId: 'nebula-prepared-identity-invalid',
        limits
      })).rejects.toThrow('UPDATE_NEBULA_IDENTITY_INVALID')
    }
  })

  it('fails closed for an unreviewed future layout instead of treating arbitrary DLLs as compatible', async () => {
    const fixture = await makeFixture()
    await expect(prepareOfficialNebulaWindowsArchive({
      sourceArchivePath: fixture.source,
      version: '0.9.23',
      artifactId: 'nebula-prepared-unsupported',
      limits
    })).rejects.toThrow('UPDATE_NEBULA_LAYOUT_UNSUPPORTED')
    expect(() => resolveNebulaWindowsLayoutPolicy('../0.9.22')).toThrow()
  })

  it('owns only the two reviewed Nebula subtrees and the one extensionless runtime bundle', () => {
    expect(isNebulaManagedRuntimePath('plugins/nebula-NebulaMultiplayerMod/NebulaWorld.dll')).toBe(true)
    expect(isNebulaManagedRuntimePath('plugins/nebula-NebulaMultiplayerModApi/NebulaAPI.dll')).toBe(true)
    expect(isNebulaManagedRuntimePath('plugins/nebula-NebulaMultiplayerMod/nebulabundle')).toBe(true)
    expect(isNebulaManagedRuntimePath('plugins/another-mod/NebulaWorld.dll')).toBe(false)
    expect(isNebulaManagedRuntimePath('plugins/nebula-NebulaMultiplayerMod/install.exe')).toBe(false)
    expect(isNebulaManagedRuntimePath('plugins/nebula-NebulaMultiplayerMod/discord_game_sdk.so')).toBe(false)
  })
})

type Mutation = 'missing' | 'extra' | 'collision' | 'main-version' | 'api-version' | 'website' | 'api-dependency'

async function makeFixture(mutation?: Mutation): Promise<{ root: string; source: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'dyson-nebula-layout-'))
  roots.push(root)
  const policy = resolveNebulaWindowsLayoutPolicy('0.9.22')
  const mainManifest = {
    name: 'NebulaMultiplayerMod',
    description: 'Fictional Nebula layout fixture',
    version_number: mutation === 'main-version' ? '0.9.21' : '0.9.22',
    dependencies: mutation === 'api-dependency'
      ? ['nebula-NebulaMultiplayerModApi-2.0.0']
      : ['xiaoye97-BepInEx-5.4.17', 'nebula-NebulaMultiplayerModApi-2.1.0'],
    website_url: mutation === 'website' ? 'https://example.invalid/not-nebula' : 'https://github.com/NebulaModTeam/nebula'
  }
  const apiManifest = {
    name: 'NebulaMultiplayerModApi',
    description: 'Fictional Nebula API layout fixture',
    version_number: mutation === 'api-version' ? '2.0.0' : '2.1.0',
    dependencies: ['xiaoye97-BepInEx-5.4.17'],
    website_url: 'https://github.com/NebulaModTeam/nebula'
  }
  let files = policy.sourceFiles.map((name) => ({
    name,
    bytes: name.endsWith('/manifest.json')
      ? Buffer.from(JSON.stringify(name.includes('MultiplayerModApi') ? apiManifest : mainManifest), 'utf8')
      : Buffer.from(`fixture:${name}`, 'utf8')
  }))
  if (mutation === 'missing') files = files.slice(1)
  if (mutation === 'extra') files.push({ name: 'nebula-NebulaMultiplayerMod/unreviewed.dll', bytes: Buffer.from('extra') })
  if (mutation === 'collision') {
    const existing = files.find((entry) => entry.name.endsWith('/NebulaWorld.dll'))!
    files.push({ name: existing.name.toLowerCase(), bytes: Buffer.from('collision') })
  }
  const source = path.join(root, 'source.zip')
  await writeFile(source, buildStoredZip(files))
  return { root, source }
}

function buildStoredZip(files: Array<{ name: string; bytes: Buffer }>): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const checksum = crc32(file.bytes)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(file.bytes.length, 18)
    local.writeUInt32LE(file.bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, file.bytes)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(file.bytes.length, 20)
    central.writeUInt32LE(file.bytes.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + file.bytes.length
  }
  const central = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, central, eocd])
}

const crcTable = (() => {
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
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0
  return (crc ^ 0xffffffff) >>> 0
}

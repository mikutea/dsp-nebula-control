import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ComponentUpdateActivationError,
  bepInExWindowsX64LayoutPolicyIds,
  inspectComponentArchive,
  resolveBepInExWindowsX64LayoutPolicy,
  verifyExtractedComponentRelease
} from './index.js'

const temporaryRoots: string[] = []
const commonFiles = [
  'BepInEx/core/0Harmony.dll',
  'BepInEx/core/0Harmony.xml',
  'BepInEx/core/0Harmony20.dll',
  'BepInEx/core/BepInEx.dll',
  'BepInEx/core/BepInEx.Harmony.dll',
  'BepInEx/core/BepInEx.Harmony.xml',
  'BepInEx/core/BepInEx.Preloader.dll',
  'BepInEx/core/BepInEx.Preloader.xml',
  'BepInEx/core/BepInEx.xml',
  'BepInEx/core/HarmonyXInterop.dll',
  'BepInEx/core/Mono.Cecil.dll',
  'BepInEx/core/Mono.Cecil.Mdb.dll',
  'BepInEx/core/Mono.Cecil.Pdb.dll',
  'BepInEx/core/Mono.Cecil.Rocks.dll',
  'BepInEx/core/MonoMod.RuntimeDetour.dll',
  'BepInEx/core/MonoMod.RuntimeDetour.xml',
  'BepInEx/core/MonoMod.Utils.dll',
  'BepInEx/core/MonoMod.Utils.xml',
  'changelog.txt',
  'doorstop_config.ini',
  'winhttp.dll'
] as const
const doorstop4Files = ['.doorstop_version', ...commonFiles] as const
const limits = {
  maximumArchiveBytes: 16 * 1_024 * 1_024,
  maximumFileBytes: 4 * 1_024 * 1_024,
  maximumExpandedBytes: 32 * 1_024 * 1_024,
  maximumFiles: 64
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

describe('versioned BepInEx Windows x64 archive policy', () => {
  it('pins only the reviewed official 5.4.22 and 5.4.23.2-.5 path sets', () => {
    expect(resolveBepInExWindowsX64LayoutPolicy('5.4.22')).toEqual({
      id: bepInExWindowsX64LayoutPolicyIds.v5_4_22,
      files: commonFiles
    })
    expect(resolveBepInExWindowsX64LayoutPolicy('5.4.23.5')).toEqual({
      id: bepInExWindowsX64LayoutPolicyIds.v5_4_23_2_through_5,
      files: doorstop4Files
    })
    expect(() => resolveBepInExWindowsX64LayoutPolicy('5.4.23.6'))
      .toThrowError(expect.objectContaining({ code: 'UPDATE_BEPINEX_VERSION_LAYOUT_UNSUPPORTED' }))
  })

  it('streams, hashes, extracts, and independently verifies every official-layout payload', async () => {
    const fixture = await createFixture()
    const payloads = makePayloads(doorstop4Files, '5.4.23.2')
    await writeFile(fixture.archivePath, buildZip(payloads))

    const inspected = await inspectComponentArchive({
      archivePath: fixture.archivePath,
      expectedComponent: 'bepinex',
      expectedVersion: '5.4.23.2',
      expectedArtifactId: 'bepinex-artifact-fixture',
      limits,
      extractTo: fixture.extractRoot
    })

    expect(inspected.manifest).toMatchObject({
      component: 'bepinex',
      layoutPolicy: bepInExWindowsX64LayoutPolicyIds.v5_4_23_2_through_5,
      files: expect.arrayContaining([
        expect.objectContaining({ relativePath: 'winhttp.dll', sha256: sha256(Buffer.from('5.4.23.2:winhttp.dll')) })
      ])
    })
    expect(inspected.summary.fileCount).toBe(22)
    expect(await readFile(path.join(fixture.extractRoot, 'BepInEx', 'core', 'BepInEx.dll'), 'utf8'))
      .toBe('5.4.23.2:BepInEx/core/BepInEx.dll')
    await expect(verifyExtractedComponentRelease(fixture.extractRoot, inspected.manifest, limits))
      .resolves.toMatchObject({ component: 'bepinex', fileCount: 22 })
  })

  it.each([
    ['unknown config', [...makePayloads(doorstop4Files, '5.4.23.2'), payload('BepInEx/config/BepInEx.cfg')], 'UPDATE_BEPINEX_LAYOUT_INVALID'],
    ['executable script', [...makePayloads(doorstop4Files, '5.4.23.2'), payload('install.ps1')], 'UPDATE_BEPINEX_LAYOUT_INVALID'],
    ['ADS', replacePayload(doorstop4Files, 'winhttp.dll', 'winhttp.dll:evil'), 'UPDATE_ARCHIVE_PATH_INVALID'],
    ['device name', [...makePayloads(doorstop4Files, '5.4.23.2'), payload('BepInEx/core/CON.dll')], 'UPDATE_ARCHIVE_PATH_INVALID'],
    ['case collision', [...makePayloads(doorstop4Files, '5.4.23.2'), payload('WINHTTP.DLL')], 'UPDATE_ARCHIVE_DUPLICATE_FILE'],
    ['path escape', replacePayload(doorstop4Files, 'winhttp.dll', '../winhttp.dll'), 'UPDATE_ARCHIVE_PATH_INVALID'],
    ['symlink entry', makePayloads(doorstop4Files, '5.4.23.2').map((entry) => entry.name === 'winhttp.dll'
      ? { ...entry, unixMode: 0o120777 }
      : entry), 'UPDATE_ARCHIVE_LINK_FORBIDDEN']
  ] as const)('rejects %s without extracting anything', async (_name, payloads, code) => {
    const fixture = await createFixture()
    await writeFile(fixture.archivePath, buildZip([...payloads]))
    await expect(inspectComponentArchive({
      archivePath: fixture.archivePath,
      expectedComponent: 'bepinex',
      expectedVersion: '5.4.23.2',
      expectedArtifactId: 'bepinex-artifact-fixture',
      limits,
      extractTo: fixture.extractRoot
    })).rejects.toMatchObject({ code })
  })

  it('rejects missing files, unsupported versions, tight limits, and undeclared immutable-release content', async () => {
    const fixture = await createFixture()
    const archive = buildZip(makePayloads(doorstop4Files.slice(1), '5.4.23.2'))
    await writeFile(fixture.archivePath, archive)
    const input = {
      archivePath: fixture.archivePath,
      expectedComponent: 'bepinex' as const,
      expectedVersion: '5.4.23.2',
      expectedArtifactId: 'bepinex-artifact-fixture',
      limits
    }
    await expect(inspectComponentArchive(input)).rejects.toMatchObject({ code: 'UPDATE_BEPINEX_LAYOUT_INVALID' })

    await writeFile(fixture.archivePath, buildZip(makePayloads(doorstop4Files, '5.4.23.2')))
    await expect(inspectComponentArchive({ ...input, expectedVersion: '5.4.23.6' }))
      .rejects.toMatchObject({ code: 'UPDATE_BEPINEX_VERSION_LAYOUT_UNSUPPORTED' })
    await expect(inspectComponentArchive({ ...input, limits: { ...limits, maximumFiles: 20 } }))
      .rejects.toMatchObject({ code: 'UPDATE_ARCHIVE_FILE_COUNT_INVALID' })

    const inspected = await inspectComponentArchive({ ...input, extractTo: fixture.extractRoot })
    await mkdir(path.join(fixture.extractRoot, 'BepInEx', 'config'))
    await writeFile(path.join(fixture.extractRoot, 'BepInEx', 'config', 'BepInEx.cfg'), 'user file cannot enter immutable release')
    await expect(verifyExtractedComponentRelease(fixture.extractRoot, inspected.manifest, limits))
      .rejects.toMatchObject({ code: 'UPDATE_RELEASE_UNDECLARED_FILE' })
  })
})

interface FixturePayload {
  name: string
  bytes: Buffer
  method?: 0 | 8
  unixMode?: number
}

async function createFixture(): Promise<{ archivePath: string; extractRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'dyson-bepinex-layout-'))
  temporaryRoots.push(root)
  const extractRoot = path.join(root, 'extract')
  await mkdir(extractRoot)
  return { archivePath: path.join(root, 'package.zip'), extractRoot }
}

function makePayloads(files: readonly string[], version: string): FixturePayload[] {
  return files.map((name) => ({ name, bytes: Buffer.from(`${version}:${name}`) }))
}

function payload(name: string): FixturePayload {
  return { name, bytes: Buffer.from(`fixture:${name}`) }
}

function replacePayload(files: readonly string[], from: string, to: string): FixturePayload[] {
  return makePayloads(files, '5.4.23.2').map((entry) => entry.name === from ? { ...entry, name: to } : entry)
}

function buildZip(files: FixturePayload[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const method = file.method ?? 0
    const compressed = method === 8 ? deflateRawSync(file.bytes) : file.bytes
    const checksum = crc32(file.bytes)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(file.bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(file.bytes.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((((file.unixMode ?? 0o100644) & 0xffff) << 16) >>> 0, 38)
    central.writeUInt32LE(localOffset, 42)
    centralParts.push(central, name)
    localOffset += local.length + name.length + compressed.length
  }
  const central = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...localParts, central, eocd])
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0
  return (crc ^ 0xffffffff) >>> 0
}

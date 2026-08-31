import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OfflineArtifactStager } from './staging.js'
import { resolveBepInExWindowsX64LayoutPolicy } from './bepinex-layout.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(path.join(tmpdir(), 'dyson-stage-')))
  temporaryRoots.push(root)
  const inboxRoot = path.join(root, 'inbox')
  const stagingRoot = path.join(root, 'staging')
  await mkdir(inboxRoot)
  const artifactId = `artifact-${'a'.repeat(40)}`
  const bytes = Buffer.from('fictional offline artifact fixture', 'utf8')
  await writeFile(path.join(inboxRoot, `${artifactId}.artifact`), bytes)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const request = {
    artifactId,
    release: { kind: 'nebula', sourceId: 'github:NebulaModTeam/nebula', version: '0.9.22' },
    expected: { sizeBytes: bytes.byteLength, sha256 }
  }
  return { root, inboxRoot, stagingRoot, artifactId, bytes, sha256, request }
}

describe('offline artifact staging', () => {
  it('verifies and atomically publishes a fixed-inbox artifact, then reuses it idempotently', async () => {
    const value = await fixture()
    const stager = new OfflineArtifactStager({
      inboxRoot: value.inboxRoot,
      stagingRoot: value.stagingRoot,
      now: () => new Date('2026-08-30T03:00:00Z')
    })
    const preview = stager.preview(value.request)
    expect(preview).toMatchObject({ dryRun: true, activation: { enabled: false }, artifactId: value.artifactId })
    expect(JSON.stringify(preview)).not.toContain(value.root)

    const first = await stager.stage(value.request)
    expect(first).toMatchObject({
      created: true,
      manifest: {
        artifactId: value.artifactId,
        sizeBytes: value.bytes.byteLength,
        sha256: value.sha256,
        integrity: 'provider-verified'
      }
    })
    const published = path.join(value.stagingRoot, 'releases', value.artifactId)
    await expect(readFile(path.join(published, 'artifact.bin'))).resolves.toEqual(value.bytes)
    const second = await stager.stage(value.request)
    expect(second.created).toBe(false)
    expect(second.manifest).toEqual(first.manifest)
  })

  it('cleans its temporary directory after integrity failure and leaves no published release', async () => {
    const value = await fixture()
    const stager = new OfflineArtifactStager({ inboxRoot: value.inboxRoot, stagingRoot: value.stagingRoot })
    await expect(stager.stage({
      ...value.request,
      expected: { ...value.request.expected, sha256: 'f'.repeat(64) }
    })).rejects.toThrow('STAGING_SHA256_MISMATCH')
    const entries = await readdir(value.stagingRoot)
    expect(entries.filter((entry) => entry.startsWith('.tmp-'))).toEqual([])
    await expect(readdir(path.join(value.stagingRoot, 'releases'))).resolves.toEqual([])
  })

  it('uses an exclusive lock and detects later tampering instead of silently reusing bytes', async () => {
    const value = await fixture()
    const stager = new OfflineArtifactStager({ inboxRoot: value.inboxRoot, stagingRoot: value.stagingRoot })
    await mkdir(path.join(value.stagingRoot, '.locks'), { recursive: true })
    await writeFile(path.join(value.stagingRoot, '.locks', `${value.artifactId}.lock`), 'fixture')
    await expect(stager.stage(value.request)).rejects.toThrow('STAGING_LOCK_BUSY')
    await rm(path.join(value.stagingRoot, '.locks', `${value.artifactId}.lock`))

    await stager.stage(value.request)
    await writeFile(
      path.join(value.stagingRoot, 'releases', value.artifactId, 'artifact.bin'),
      'tampered fixture'
    )
    await expect(stager.stage(value.request)).rejects.toThrow('STAGING_PUBLISHED_ARTIFACT_INVALID')
  })

  it('rejects paths, URLs, DSP updates, and unknown fields at the stage boundary', async () => {
    const value = await fixture()
    const stager = new OfflineArtifactStager({ inboxRoot: value.inboxRoot, stagingRoot: value.stagingRoot })
    await expect(stager.stage({
      ...value.request,
      artifactId: '../escape',
      url: 'https://attacker.example/artifact.zip'
    })).rejects.toThrow()
    await expect(stager.stage({
      artifactId: value.artifactId,
      release: { kind: 'dsp', sourceId: 'steam:1366540', version: '0.10.34.28529' },
      expected: {}
    })).rejects.toThrow()
  })

  it('stages only an official-layout BepInEx archive and persists every payload hash', async () => {
    const root = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(path.join(tmpdir(), 'dyson-bepinex-stage-')))
    temporaryRoots.push(root)
    const inboxRoot = path.join(root, 'inbox')
    const stagingRoot = path.join(root, 'staging')
    await mkdir(inboxRoot)
    const artifactId = 'bepinex-artifact-stage1'
    const policy = resolveBepInExWindowsX64LayoutPolicy('5.4.23.2')
    const payloads = policy.files.map((name) => ({ name, bytes: Buffer.from(`stage:${name}`) }))
    const archive = buildStoredZip(payloads)
    await writeFile(path.join(inboxRoot, `${artifactId}.artifact`), archive)
    const digest = createHash('sha256').update(archive).digest('hex')
    const request = {
      artifactId,
      release: { kind: 'bepinex' as const, sourceId: 'github:BepInEx/BepInEx', version: '5.4.23.2' },
      expected: { sizeBytes: archive.length, sha256: digest }
    }

    const result = await new OfflineArtifactStager({ inboxRoot, stagingRoot }).stage(request)
    expect(result.manifest.componentManifest).toMatchObject({
      component: 'bepinex',
      layoutPolicy: policy.id,
      artifactId,
      files: expect.arrayContaining(payloads.map((entry) => expect.objectContaining({
        relativePath: entry.name,
        sizeBytes: entry.bytes.length,
        sha256: createHash('sha256').update(entry.bytes).digest('hex')
      })))
    })
    expect(result.manifest.componentManifest?.files).toHaveLength(policy.files.length)
    const serialized = await readFile(path.join(stagingRoot, 'releases', artifactId, 'manifest.json'), 'utf8')
    expect(serialized).not.toContain(root)

    await expect(new OfflineArtifactStager({ inboxRoot, stagingRoot: path.join(root, 'other-stage') }).stage({
      ...request,
      release: { ...request.release, sourceId: 'github:someone/else' }
    })).rejects.toThrow('STAGING_RELEASE_IDENTITY_INVALID')
  })

  it('does not publish a BepInEx stage containing an unknown executable payload', async () => {
    const root = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(path.join(tmpdir(), 'dyson-bepinex-stage-invalid-')))
    temporaryRoots.push(root)
    const inboxRoot = path.join(root, 'inbox')
    const stagingRoot = path.join(root, 'staging')
    await mkdir(inboxRoot)
    const artifactId = 'bepinex-artifact-stage2'
    const policy = resolveBepInExWindowsX64LayoutPolicy('5.4.23.2')
    const archive = buildStoredZip([
      ...policy.files.map((name) => ({ name, bytes: Buffer.from(name) })),
      { name: 'install.ps1', bytes: Buffer.from('not allowed') }
    ])
    await writeFile(path.join(inboxRoot, `${artifactId}.artifact`), archive)

    await expect(new OfflineArtifactStager({ inboxRoot, stagingRoot }).stage({
      artifactId,
      release: { kind: 'bepinex', sourceId: 'github:BepInEx/BepInEx', version: '5.4.23.2' },
      expected: { sizeBytes: archive.length, sha256: createHash('sha256').update(archive).digest('hex') }
    })).rejects.toThrow('UPDATE_BEPINEX_LAYOUT_INVALID')
    await expect(readdir(path.join(stagingRoot, 'releases'))).resolves.toEqual([])
  })
})

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

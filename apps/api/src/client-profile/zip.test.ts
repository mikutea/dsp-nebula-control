import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { generateModManifests } from '../mods/manifest.js'
import {
  CLIENT_PROFILE_ZIP_ENTRY_NAMES,
  CLIENT_PROFILE_ZIP_FILE_NAME,
  MAX_CLIENT_PROFILE_ARTIFACT_BYTES,
  MAX_CLIENT_PROFILE_ZIP_BYTES,
  buildClientProfileZip,
  generateClientProfile,
  verifyClientProfileZip,
  type GeneratedClientProfile
} from './index.js'

const digest = (character: string): string => character.repeat(64)

function generateFixture(): GeneratedClientProfile {
  const manifests = generateModManifests({
    roots: ['Fictional-MultiplayerRoot-2.0.0', 'Fictional-CosmeticLights-1.1.0'],
    packages: [
      {
        dependencyId: 'Fictional-CosmeticLights-1.1.0',
        sha256: digest('c'),
        dependencies: [],
        serverRequired: false,
        clientRequirement: 'optional'
      },
      {
        dependencyId: 'Fictional-MultiplayerRoot-2.0.0',
        sha256: digest('b'),
        dependencies: ['Fictional-ServerHelper-1.0.0'],
        serverRequired: true,
        clientRequirement: 'required'
      },
      {
        dependencyId: 'Fictional-ServerHelper-1.0.0',
        sha256: digest('a'),
        dependencies: [],
        serverRequired: true,
        clientRequirement: 'not-required'
      }
    ]
  })
  return generateClientProfile({
    schemaVersion: 1,
    profile: {
      profileId: 'fictional-dyson',
      displayName: 'Fictional Dyson Server',
      connection: { host: 'example.com', port: 8469 }
    },
    compatibility: {
      inventory: {
        dsp: '0.10.34.28529',
        nebula: '0.9.22.2',
        bepInEx: '5.4.17.0',
        plugins: [{
          sourceId: 'thunderstore:NebulaModTeam/NebulaMultiplayerMod',
          version: '0.9.22.2'
        }]
      },
      matrix: {
        schemaVersion: 1,
        entries: [{
          id: 'supported-fictional-example',
          core: {
            dsp: { equals: '0.10.34.28529' },
            nebula: { equals: '0.9.22.2' },
            bepInEx: { equals: '5.4.17.0' }
          },
          plugins: [{
            sourceId: 'thunderstore:NebulaModTeam/NebulaMultiplayerMod',
            range: { equals: '0.9.22.2' },
            required: true
          }]
        }]
      }
    },
    serverLock: manifests.serverLock,
    clientParity: manifests.clientParity
  })
}

describe('deterministic client profile ZIP', () => {
  it('produces byte-identical stored archives and independently verifies the fixed metadata set', () => {
    const generated = generateFixture()
    const first = buildClientProfileZip(generated)
    const second = buildClientProfileZip(structuredClone(generated))

    expect(first.fileName).toBe(CLIENT_PROFILE_ZIP_FILE_NAME)
    expect(first.mediaType).toBe('application/zip')
    expect(first.sizeBytes).toBe(first.bytes.length)
    expect(first.sha256).toBe(createHash('sha256').update(first.bytes).digest('hex'))
    expect(first.bytes.equals(second.bytes)).toBe(true)
    expect(second.sha256).toBe(first.sha256)

    const verified = verifyClientProfileZip(first.bytes)
    expect(verified).toMatchObject({
      valid: true,
      profileId: 'fictional-dyson',
      archiveSha256: first.sha256,
      sizeBytes: first.sizeBytes,
      artifactSetSha256: generated.artifactSetSha256
    })
    expect(verified.entries.map((entry) => entry.entryName)).toEqual(CLIENT_PROFILE_ZIP_ENTRY_NAMES)
    expect(first.bytes.includes(Buffer.from('PK\x03\x04', 'binary'))).toBe(true)
  })

  it('rejects payload tampering through CRC validation before trusting text content', () => {
    const archive = buildClientProfileZip(generateFixture())
    const tampered = Buffer.from(archive.bytes)
    const marker = Buffer.from('Fictional Dyson Server', 'utf8')
    const markerOffset = tampered.indexOf(marker)
    expect(markerOffset).toBeGreaterThan(0)
    tampered[markerOffset] = tampered[markerOffset]! ^ 1

    expect(() => verifyClientProfileZip(tampered)).toThrow('CLIENT_PROFILE_ZIP_CRC_MISMATCH')
  })

  it('rejects a checksum manifest altered with internally repaired ZIP CRC fields', () => {
    const archive = buildClientProfileZip(generateFixture())
    const tampered = Buffer.from(archive.bytes)
    const firstDataOffset = 30 + tampered.readUInt16LE(26) + tampered.readUInt16LE(28)
    tampered[firstDataOffset] = tampered[firstDataOffset] === 0x61 ? 0x62 : 0x61
    repairFirstEntryCrc(tampered)

    expect(() => verifyClientProfileZip(tampered)).toThrow('CLIENT_PROFILE_ZIP_CHECKSUMS_MISMATCH')
  })

  it('rejects exact and case-insensitive duplicate artifact names before archive creation', () => {
    const generated = structuredClone(generateFixture())
    const profile = generated.artifacts.find((artifact) => artifact.entryName === 'client-profile.json')!
    profile.entryName = 'CLIENT-MOD-LOCK.JSON'

    expect(() => buildClientProfileZip(generated)).toThrow('CLIENT_PROFILE_ZIP_ENTRY_DUPLICATE')
  })

  it('rejects zip-slip names in both the logical input and an otherwise intact archive', () => {
    const generated = structuredClone(generateFixture())
    generated.artifacts.find((artifact) => artifact.entryName === 'INSTALL.md')!.entryName = '../evil.md'
    expect(() => buildClientProfileZip(generated)).toThrow('CLIENT_PROFILE_ZIP_ENTRY_NAME_INVALID')

    const archive = buildClientProfileZip(generateFixture())
    const tampered = replaceAllSameLength(archive.bytes, 'INSTALL.md', '../evil.md')
    expect(() => verifyClientProfileZip(tampered)).toThrow('CLIENT_PROFILE_ZIP_ENTRY_NAME_INVALID')
  })

  it('rejects binary names, symlink concepts, credentials, and real filesystem paths', () => {
    const binary = structuredClone(generateFixture())
    binary.artifacts.find((artifact) => artifact.entryName === 'INSTALL.md')!.entryName = 'BepInEx/plugin.dll'
    expect(() => buildClientProfileZip(binary)).toThrow('CLIENT_PROFILE_ZIP_ENTRY_NAME_INVALID')

    const symlinkInput = structuredClone(generateFixture()) as GeneratedClientProfile & {
      artifacts: Array<GeneratedClientProfile['artifacts'][number] & { symlinkTarget?: string }>
    }
    symlinkInput.artifacts[0]!.symlinkTarget = 'client-profile.json'
    expect(() => buildClientProfileZip(symlinkInput)).toThrow('CLIENT_PROFILE_ZIP_INPUT_INVALID')

    for (const privateLine of ['serverPassword=fictional-value', 'installPath=C:\\Fictional\\DSP']) {
      const privateProfile = structuredClone(generateFixture())
      privateProfile.artifacts.find((artifact) => artifact.entryName === 'INSTALL.md')!.content += `\n${privateLine}\n`
      expect(() => buildClientProfileZip(privateProfile)).toThrow('CLIENT_PROFILE_ZIP_PRIVATE_MATERIAL')
    }

    const archive = buildClientProfileZip(generateFixture())
    const externalAttributes = Buffer.from(archive.bytes)
    const centralOffset = readCentralOffset(externalAttributes)
    externalAttributes.writeUInt32LE(0xa0000000, centralOffset + 38)
    expect(() => verifyClientProfileZip(externalAttributes)).toThrow('CLIENT_PROFILE_ZIP_SYMLINK_REJECTED')
  })

  it('enforces per-entry and total archive byte limits before allocating or extracting content', () => {
    const archive = buildClientProfileZip(generateFixture())
    const oversizedEntry = Buffer.from(archive.bytes)
    const centralOffset = readCentralOffset(oversizedEntry)
    oversizedEntry.writeUInt32LE(MAX_CLIENT_PROFILE_ARTIFACT_BYTES + 1, centralOffset + 20)
    oversizedEntry.writeUInt32LE(MAX_CLIENT_PROFILE_ARTIFACT_BYTES + 1, centralOffset + 24)
    expect(() => verifyClientProfileZip(oversizedEntry)).toThrow('CLIENT_PROFILE_ZIP_ENTRY_TOO_LARGE')

    expect(() => verifyClientProfileZip(Buffer.alloc(MAX_CLIENT_PROFILE_ZIP_BYTES + 1))).toThrow(
      'CLIENT_PROFILE_ZIP_ARCHIVE_TOO_LARGE'
    )
  })

  it('fails closed for malformed headers, unsupported compression, and noncanonical timestamps', () => {
    const archive = buildClientProfileZip(generateFixture())

    const malformed = Buffer.from(archive.bytes)
    malformed.writeUInt32LE(0, 0)
    expect(() => verifyClientProfileZip(malformed)).toThrow('CLIENT_PROFILE_ZIP_MALFORMED')

    const compressed = Buffer.from(archive.bytes)
    compressed.writeUInt16LE(8, 8)
    expect(() => verifyClientProfileZip(compressed)).toThrow('CLIENT_PROFILE_ZIP_MALFORMED')

    const timestamped = Buffer.from(archive.bytes)
    const centralOffset = readCentralOffset(timestamped)
    timestamped.writeUInt16LE(1, centralOffset + 12)
    expect(() => verifyClientProfileZip(timestamped)).toThrow('CLIENT_PROFILE_ZIP_UNSUPPORTED')
  })
})

function readCentralOffset(archive: Buffer): number {
  return archive.readUInt32LE(archive.length - 22 + 16)
}

function repairFirstEntryCrc(archive: Buffer): void {
  const nameLength = archive.readUInt16LE(26)
  const extraLength = archive.readUInt16LE(28)
  const dataLength = archive.readUInt32LE(22)
  const dataOffset = 30 + nameLength + extraLength
  const checksum = crc32(archive.subarray(dataOffset, dataOffset + dataLength))
  archive.writeUInt32LE(checksum, 14)
  archive.writeUInt32LE(checksum, readCentralOffset(archive) + 16)
}

function replaceAllSameLength(input: Buffer, before: string, after: string): Buffer {
  const beforeBytes = Buffer.from(before, 'utf8')
  const afterBytes = Buffer.from(after, 'utf8')
  if (beforeBytes.length !== afterBytes.length) throw new Error('test replacement length mismatch')
  const result = Buffer.from(input)
  let count = 0
  let offset = 0
  while (offset < result.length) {
    const found = result.indexOf(beforeBytes, offset)
    if (found < 0) break
    afterBytes.copy(result, found)
    offset = found + afterBytes.length
    count += 1
  }
  if (count !== 3) throw new Error(`expected three ZIP filename occurrences, received ${count}`)
  return result
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

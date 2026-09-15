import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalManifestBytes,
  SavePairTransferService,
  verifyBackupPair,
  verifySavePairTransportArchive,
  type SavePairTransportManifest
} from './index.js'

const temporaryRoots: string[] = []
const fixedNow = new Date('2026-08-30T12:00:00.000Z')

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

describe('save-pair transfer archive and quarantine', () => {
  it.each(['path', 'url', 'command', 'credential', 'temporaryFile'])(
    'rejects the arbitrary request field %s before filesystem or stream use',
    async (field) => {
      const fixture = await seedBackup('Strict_Save', Buffer.from('dsv'), Buffer.from('server'))
      const service = makeService(fixture)
      await expect(service.exportBackup({
        requestId: randomUUID(), backupId: fixture.backupId, [field]: 'C:\\private\\input'
      })).rejects.toMatchObject({ code: 'SAVE_TRANSFER_REQUEST_INVALID' })
      let consumed = false
      async function* source(): AsyncIterable<Uint8Array> {
        consumed = true
        yield Buffer.from('untrusted')
      }
      await expect(service.importArchive({
        requestId: randomUUID(), declaredBytes: 9, sha256: 'a'.repeat(64), [field]: 'https://untrusted.invalid'
      }, source())).rejects.toMatchObject({ code: 'SAVE_TRANSFER_REQUEST_INVALID' })
      expect(consumed).toBe(false)
      await expect(lstat(fixture.transportRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it('exports a verified backup reproducibly, independently verifies it, and reuses the UUID', async () => {
    const fixture = await seedBackup('Complete_Save', Buffer.from('dsv-content'), Buffer.from('server-content'))
    const service = makeService(fixture)
    const firstRequest = { requestId: randomUUID(), backupId: fixture.backupId }
    const first = await service.exportBackup(firstRequest)
    expect(first).toMatchObject({ operation: 'export', backupId: fixture.backupId, reused: false, restoreExecuted: false })

    const download = await service.openExport({ requestId: firstRequest.requestId })
    const archive = await collect(download.source)
    expect(archive.length).toBe(first.archiveBytes)
    expect(hash(archive)).toBe(first.archiveSha256)
    const verified = await verifySavePairTransportArchive({
      source: chunks(archive, 7),
      declaredBytes: archive.length,
      declaredSha256: hash(archive)
    })
    expect(verified.manifest).toMatchObject({
      saveName: fixture.saveName,
      generatedAt: fixture.createdAt,
      generation: { strategy: 'source-backup-created-at' },
      source: { kind: 'verified-backup', backupId: fixture.backupId }
    })

    const repeated = await service.exportBackup(firstRequest)
    expect(repeated).toMatchObject({ archiveSha256: first.archiveSha256, reused: true })
    const otherBackupId = await addBackup(fixture, 'Other_Save', Buffer.from('other-dsv'), Buffer.from('other-server'))
    await expect(service.exportBackup({ requestId: firstRequest.requestId, backupId: otherBackupId }))
      .rejects.toMatchObject({ code: 'SAVE_TRANSFER_IDEMPOTENCY_CONFLICT' })

    const secondRequest = { requestId: randomUUID(), backupId: fixture.backupId }
    const second = await service.exportBackup(secondRequest)
    const secondArchive = await collect((await service.openExport({ requestId: secondRequest.requestId })).source)
    expect(second.archiveSha256).toBe(first.archiveSha256)
    expect(secondArchive.equals(archive)).toBe(true)
    expect(JSON.stringify(first)).not.toContain(fixture.root)
  })

  it('imports only into a fixed inbox, never restores, and handles replay and conflict', async () => {
    const fixture = await seedBackup('Inbox_Save', Buffer.from('late-dsv'), Buffer.from('late-server'))
    const service = makeService(fixture)
    const exportId = randomUUID()
    const exported = await service.exportBackup({ requestId: exportId, backupId: fixture.backupId })
    const archive = await collect((await service.openExport({ requestId: exportId })).source)
    const activeSentinel = path.join(fixture.root, 'active-save-must-not-change.dsv')
    await writeFile(activeSentinel, 'active-original', 'utf8')
    const request = { requestId: randomUUID(), declaredBytes: archive.length, sha256: exported.archiveSha256 }

    const imported = await service.importArchive(request, chunks(archive, 11))
    expect(imported).toMatchObject({ operation: 'import', saveName: fixture.saveName, reused: false, restoreExecuted: false })
    const inbox = path.join(fixture.transportRoot, 'inbox', `import-${request.requestId}`)
    expect((await readdir(inbox)).sort()).toEqual([
      '.import-receipt.json',
      `${fixture.saveName}.dsv`,
      `${fixture.saveName}.server`,
      'manifest.json'
    ].sort())
    await expect(readFile(path.join(inbox, `${fixture.saveName}.dsv`), 'utf8')).resolves.toBe('late-dsv')
    await expect(readFile(path.join(inbox, `${fixture.saveName}.server`), 'utf8')).resolves.toBe('late-server')
    await expect(readFile(activeSentinel, 'utf8')).resolves.toBe('active-original')

    let replaySourceConsumed = false
    async function* shouldNotConsume(): AsyncIterable<Uint8Array> {
      replaySourceConsumed = true
      throw new Error('must not consume a proven replay')
    }
    const replay = await service.importArchive(request, shouldNotConsume())
    expect(replay.reused).toBe(true)
    expect(replaySourceConsumed).toBe(false)

    await expect(service.importArchive({ ...request, sha256: 'f'.repeat(64) }, chunks(archive, 13)))
      .rejects.toMatchObject({ code: 'SAVE_TRANSFER_IDEMPOTENCY_CONFLICT' })
  })

  it('previews and atomically promotes quarantine into a verified backup without restoring live saves', async () => {
    const fixture = await seedBackup('Promoted_Save', Buffer.from('promoted-dsv'), Buffer.from('promoted-server'))
    const service = makeService(fixture)
    const exportId = randomUUID()
    const exported = await service.exportBackup({ requestId: exportId, backupId: fixture.backupId })
    const archive = await collect((await service.openExport({ requestId: exportId })).source)
    const importId = randomUUID()
    await service.importArchive({
      requestId: importId, declaredBytes: archive.length, sha256: exported.archiveSha256
    }, chunks(archive, 9))

    const activeSentinel = path.join(fixture.root, 'active-save-must-remain.dsv')
    await writeFile(activeSentinel, 'active-original', 'utf8')
    const requestId = randomUUID()
    const backupId = `tx-${requestId}`
    const receiptPath = path.join(fixture.transportRoot, 'receipts', `promotion-${requestId}.json`)
    const preview = await service.previewImportPromotion({ requestId, importRequestId: importId })
    expect(preview).toMatchObject({
      mode: 'dry-run', allowed: true, reused: false, backupId,
      requiredConfirmation: 'PROMOTE_IMPORTED_SAVE_PAIR',
      effects: {
        quarantinePreserved: true,
        verifiedBackupCreated: true,
        liveSaveChanged: false,
        restoreExecuted: false
      }
    })
    await expect(lstat(path.join(fixture.backupRoot, backupId))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(receiptPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(service.promoteImport({
      requestId, importRequestId: importId, confirmation: 'PROMOTE'
    })).rejects.toMatchObject({ code: 'SAVE_TRANSFER_REQUEST_INVALID' })

    const interruptedStage = path.join(fixture.backupRoot, `.promotion-${requestId}.partial`)
    await mkdir(interruptedStage)
    await writeFile(path.join(interruptedStage, `${fixture.saveName}.dsv`), 'partial')
    const receipt = await service.promoteImport({
      requestId, importRequestId: importId, confirmation: 'PROMOTE_IMPORTED_SAVE_PAIR'
    })
    expect(receipt).toMatchObject({
      operation: 'promote-import', requestId, importRequestId: importId,
      backupId, saveName: fixture.saveName, reused: false, restoreExecuted: false
    })
    expect(receipt.sourceArchiveSha256).toBe(exported.archiveSha256)
    await expect(lstat(interruptedStage)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(verifyBackupPair({ backupRoot: fixture.backupRoot, backupId })).resolves.toMatchObject({
      health: 'healthy', manifestValid: true, pairPresent: true, saveName: fixture.saveName
    })
    await expect(readFile(activeSentinel, 'utf8')).resolves.toBe('active-original')
    await expect(readFile(
      path.join(fixture.transportRoot, 'inbox', `import-${importId}`, `${fixture.saveName}.dsv`),
      'utf8'
    )).resolves.toBe('promoted-dsv')

    const replay = await service.promoteImport({
      requestId, importRequestId: importId, confirmation: 'PROMOTE_IMPORTED_SAVE_PAIR'
    })
    expect(replay).toMatchObject({ manifestSha256: receipt.manifestSha256, reused: true })
    const replayPreview = await service.previewImportPromotion({ requestId, importRequestId: importId })
    expect(replayPreview).toMatchObject({ allowed: true, reused: true })

    await rm(receiptPath)
    const recovered = await makeService(fixture).promoteImport({
      requestId, importRequestId: importId, confirmation: 'PROMOTE_IMPORTED_SAVE_PAIR'
    })
    expect(recovered).toMatchObject({ manifestSha256: receipt.manifestSha256, reused: true })
    await expect(lstat(receiptPath)).resolves.toMatchObject({ isFile: expect.any(Function) })
  })

  it('fails promotion closed on quarantine tampering, destination conflict, and insufficient space', async () => {
    const fixture = await seedBackup('Promotion_Guards', Buffer.from('guard-dsv'), Buffer.from('guard-server'))
    const service = makeService(fixture)
    const exportId = randomUUID()
    const exported = await service.exportBackup({ requestId: exportId, backupId: fixture.backupId })
    const archive = await collect((await service.openExport({ requestId: exportId })).source)
    const importId = randomUUID()
    await service.importArchive({
      requestId: importId, declaredBytes: archive.length, sha256: exported.archiveSha256
    }, chunks(archive, 13))
    const inboxDsv = path.join(
      fixture.transportRoot, 'inbox', `import-${importId}`, `${fixture.saveName}.dsv`
    )
    await writeFile(inboxDsv, 'tampered-dsv')
    await expect(service.previewImportPromotion({ requestId: randomUUID(), importRequestId: importId }))
      .rejects.toMatchObject({ code: 'SAVE_TRANSFER_STATE_INVALID' })
    await writeFile(inboxDsv, 'guard-dsv')

    const conflictRequestId = randomUUID()
    await writeConflictingPromotionBackup(fixture, conflictRequestId)
    await expect(service.previewImportPromotion({
      requestId: conflictRequestId, importRequestId: importId
    })).rejects.toMatchObject({ code: 'SAVE_TRANSFER_IDEMPOTENCY_CONFLICT' })

    const noSpace = makeService(fixture, { availableBytes: async () => 0 })
    const noSpaceRequestId = randomUUID()
    await expect(noSpace.previewImportPromotion({
      requestId: noSpaceRequestId, importRequestId: importId
    })).resolves.toMatchObject({ allowed: false, blockers: ['space-insufficient'] })
    await expect(noSpace.promoteImport({
      requestId: noSpaceRequestId,
      importRequestId: importId,
      confirmation: 'PROMOTE_IMPORTED_SAVE_PAIR'
    })).rejects.toMatchObject({ code: 'SAVE_TRANSFER_SPACE_INSUFFICIENT' })
    await expect(lstat(path.join(fixture.backupRoot, `tx-${noSpaceRequestId}`)))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects tampering, CRC corruption, truncation, and trailing data even with a matching outer digest', async () => {
    const fixture = await seedBackup('Integrity_Save', Buffer.from('1234567890'), Buffer.from('sidecar'))
    const service = makeService(fixture)
    const requestId = randomUUID()
    await service.exportBackup({ requestId, backupId: fixture.backupId })
    const archive = await collect((await service.openExport({ requestId })).source)
    const records = locateRecords(archive)

    const tampered = Buffer.from(archive)
    tampered[records[1]!.dataOffset]! ^= 0xff
    await expectVerifyFailure(tampered, 'SAVE_TRANSFER_ENTRY_HASH_MISMATCH')

    const badCrc = Buffer.from(archive)
    badCrc.writeUInt32BE((badCrc.readUInt32BE(records[1]!.crcOffset) ^ 1) >>> 0, records[1]!.crcOffset)
    await expectVerifyFailure(badCrc, 'SAVE_TRANSFER_ENTRY_CRC_MISMATCH')

    const truncated = archive.subarray(0, archive.length - 9)
    await expectVerifyFailure(truncated, 'SAVE_TRANSFER_ARCHIVE_TRUNCATED')

    const trailing = Buffer.concat([archive, Buffer.from('extra')])
    await expectVerifyFailure(trailing, 'SAVE_TRANSFER_ARCHIVE_TRAILING_DATA')
  })

  it.each([
    '../escape.dsv',
    'C:escape.dsv',
    '\\\\host\\share.dsv',
    'save.dsv:ads',
    'CON.dsv'
  ])('rejects unsafe transport entry name %s', async (unsafeName) => {
    const built = rawArchive(unsafeName, 'Safe_Save.server')
    await expectVerifyFailure(built, 'SAVE_TRANSFER_ENTRY_NAME_INVALID')
  })

  it('rejects duplicate, extra, and bomb-shaped entries before allocation or publication', async () => {
    const duplicate = rawArchive('Safe_Save.dsv', 'Safe_Save.dsv')
    await expectVerifyFailure(duplicate, 'SAVE_TRANSFER_ENTRY_DUPLICATE')

    const extra = rawArchive('Safe_Save.dsv', 'Safe_Save.server')
    extra.writeUInt16BE(4, 16)
    await expectVerifyFailure(extra, 'SAVE_TRANSFER_ENTRY_COUNT_INVALID')

    const bomb = rawArchive('Safe_Save.dsv', 'Safe_Save.server', 32 * 1024 * 1024)
    await expect(verifySavePairTransportArchive({
      source: chunks(bomb, 31),
      declaredBytes: bomb.length,
      declaredSha256: hash(bomb),
      limits: { maximumArchiveBytes: 4 * 1024 * 1024, maximumPairBytes: 3 * 1024 * 1024, maximumFileBytes: 1024 * 1024 }
    })).rejects.toMatchObject({ code: 'SAVE_TRANSFER_ENTRY_TOO_LARGE' })
  })

  it('fails closed on an inbox reparse point and leaves the redirected target untouched', async () => {
    const fixture = await seedBackup('Redirect_Save', Buffer.from('dsv'), Buffer.from('server'))
    const service = makeService(fixture)
    const exportId = randomUUID()
    const exported = await service.exportBackup({ requestId: exportId, backupId: fixture.backupId })
    const archive = await collect((await service.openExport({ requestId: exportId })).source)
    const importId = randomUUID()
    const outside = path.join(fixture.root, 'outside')
    await mkdir(outside)
    const inboxRoot = path.join(fixture.transportRoot, 'inbox')
    await symlink(outside, path.join(inboxRoot, `import-${importId}`), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(service.importArchive({ requestId: importId, declaredBytes: archive.length, sha256: exported.archiveSha256 }, chunks(archive, 17)))
      .rejects.toMatchObject({ code: 'SAVE_TRANSFER_FILE_UNAVAILABLE' })
    expect(await readdir(outside)).toEqual([])
  })

  it('cleans an interrupted import stage and fails early on insufficient space', async () => {
    const fixture = await seedBackup('Interrupted_Save', Buffer.from('dsv'), Buffer.from('server'))
    const service = makeService(fixture)
    const exportId = randomUUID()
    const exported = await service.exportBackup({ requestId: exportId, backupId: fixture.backupId })
    const archive = await collect((await service.openExport({ requestId: exportId })).source)
    async function* interrupted(): AsyncIterable<Uint8Array> {
      yield archive.subarray(0, Math.min(100, archive.length))
      throw new Error('simulated transport interruption')
    }
    await expect(service.importArchive({
      requestId: randomUUID(), declaredBytes: archive.length, sha256: exported.archiveSha256
    }, interrupted())).rejects.toMatchObject({ code: 'SAVE_TRANSFER_SOURCE_INTERRUPTED' })
    expect(await readdir(path.join(fixture.transportRoot, 'staging'))).toEqual([])

    const noSpace = makeService(fixture, { availableBytes: async () => 0 })
    await expect(noSpace.importArchive({
      requestId: randomUUID(), declaredBytes: archive.length, sha256: exported.archiveSha256
    }, chunks(archive, 23))).rejects.toMatchObject({ code: 'SAVE_TRANSFER_SPACE_INSUFFICIENT' })
  })

  it('detects a TOCTOU replacement after download validation but before streaming', async () => {
    const fixture = await seedBackup('Race_Save', Buffer.from('race-dsv'), Buffer.from('race-server'))
    const service = makeService(fixture)
    const requestId = randomUUID()
    const receipt = await service.exportBackup({ requestId, backupId: fixture.backupId })
    const download = await service.openExport({ requestId })
    const archivePath = path.join(fixture.transportRoot, 'exports', `export-${requestId}.dspair`)
    const replaced = Buffer.from(await readFile(archivePath))
    replaced[Math.floor(replaced.length / 2)]! ^= 0xff
    expect(replaced.length).toBe(receipt.archiveBytes)
    await writeFile(archivePath, replaced)

    await expect(collect(download.source)).rejects.toMatchObject({ code: 'SAVE_TRANSFER_SOURCE_CHANGED' })
  })

  it('streams a late-game-adjacent sparse pair with bounded chunks', async () => {
    const fixture = await seedSparseBackup('Late_Game_Save', 24 * 1024 * 1024)
    const service = makeService(fixture)
    const requestId = randomUUID()
    const receipt = await service.exportBackup({ requestId, backupId: fixture.backupId })
    expect(receipt.archiveBytes).toBeGreaterThan(24 * 1024 * 1024)

    const download = await service.openExport({ requestId })
    const digest = createHash('sha256')
    let bytes = 0
    let maximumChunk = 0
    for await (const chunk of download.source) {
      bytes += chunk.byteLength
      maximumChunk = Math.max(maximumChunk, chunk.byteLength)
      digest.update(chunk)
    }
    expect(bytes).toBe(receipt.archiveBytes)
    expect(digest.digest('hex')).toBe(receipt.archiveSha256)
    expect(maximumChunk).toBeLessThanOrEqual(1024 * 1024)
  }, 30_000)
})

interface Fixture {
  root: string
  backupRoot: string
  transportRoot: string
  backupId: string
  saveName: string
  createdAt: string
}

async function seedBackup(saveName: string, dsv: Buffer, server: Buffer): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'dyson-transfer-'))
  temporaryRoots.push(root)
  const backupRoot = path.join(root, 'backups')
  const transportRoot = path.join(root, 'transport')
  await mkdir(backupRoot)
  const requestId = randomUUID()
  const backupId = `tx-${requestId}`
  const directory = path.join(backupRoot, backupId)
  await mkdir(directory)
  await Promise.all([
    writeFile(path.join(directory, `${saveName}.dsv`), dsv),
    writeFile(path.join(directory, `${saveName}.server`), server)
  ])
  const createdAt = '2026-08-30T10:00:00.000Z'
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
    protocol: 'DYSON_CONTROL_PROTECTION_V1',
    schemaVersion: 1,
    requestId,
    createdAt,
    saveName,
    files: [
      { name: `${saveName}.dsv`, bytes: dsv.length, sha256: hash(dsv) },
      { name: `${saveName}.server`, bytes: server.length, sha256: hash(server) }
    ]
  }))
  return { root, backupRoot, transportRoot, backupId, saveName, createdAt }
}

async function seedSparseBackup(saveName: string, dsvBytes: number): Promise<Fixture> {
  const fixture = await seedBackup(saveName, Buffer.from('placeholder'), Buffer.from('server-sidecar'))
  const dsvPath = path.join(fixture.backupRoot, fixture.backupId, `${saveName}.dsv`)
  const handle = await open(dsvPath, 'w')
  await handle.truncate(dsvBytes)
  await handle.close()
  const requestId = fixture.backupId.slice(3)
  const createdAt = fixture.createdAt
  const dsvSha = await hashFile(dsvPath)
  const server = await readFile(path.join(fixture.backupRoot, fixture.backupId, `${saveName}.server`))
  await writeFile(path.join(fixture.backupRoot, fixture.backupId, 'manifest.json'), JSON.stringify({
    protocol: 'DYSON_CONTROL_PROTECTION_V1', schemaVersion: 1, requestId, createdAt, saveName,
    files: [
      { name: `${saveName}.dsv`, bytes: dsvBytes, sha256: dsvSha },
      { name: `${saveName}.server`, bytes: server.length, sha256: hash(server) }
    ]
  }))
  return fixture
}

async function addBackup(fixture: Fixture, saveName: string, dsv: Buffer, server: Buffer): Promise<string> {
  const requestId = randomUUID()
  const backupId = `tx-${requestId}`
  const directory = path.join(fixture.backupRoot, backupId)
  await mkdir(directory)
  await Promise.all([
    writeFile(path.join(directory, `${saveName}.dsv`), dsv),
    writeFile(path.join(directory, `${saveName}.server`), server)
  ])
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
    protocol: 'DYSON_CONTROL_PROTECTION_V1', schemaVersion: 1, requestId,
    createdAt: fixture.createdAt, saveName,
    files: [
      { name: `${saveName}.dsv`, bytes: dsv.length, sha256: hash(dsv) },
      { name: `${saveName}.server`, bytes: server.length, sha256: hash(server) }
    ]
  }))
  return backupId
}

async function writeConflictingPromotionBackup(fixture: Fixture, requestId: string): Promise<void> {
  const directory = path.join(fixture.backupRoot, `tx-${requestId}`)
  const dsv = Buffer.from('foreign-dsv')
  const server = Buffer.from('foreign-server')
  await mkdir(directory)
  await Promise.all([
    writeFile(path.join(directory, `${fixture.saveName}.dsv`), dsv),
    writeFile(path.join(directory, `${fixture.saveName}.server`), server)
  ])
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
    protocol: 'DYSON_CONTROL_PROTECTION_V1', schemaVersion: 1, requestId,
    createdAt: fixture.createdAt, saveName: fixture.saveName,
    files: [
      { name: `${fixture.saveName}.dsv`, bytes: dsv.length, sha256: hash(dsv) },
      { name: `${fixture.saveName}.server`, bytes: server.length, sha256: hash(server) }
    ]
  }))
}

function makeService(
  fixture: Fixture,
  overrides: Partial<ConstructorParameters<typeof SavePairTransferService>[0]> = {}
): SavePairTransferService {
  return new SavePairTransferService({
    backupRoot: fixture.backupRoot,
    transportRoot: fixture.transportRoot,
    reserveFreeBytes: 0,
    availableBytes: async () => Number.MAX_SAFE_INTEGER,
    now: () => fixedNow,
    ...overrides
  })
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = []
  let length = 0
  for await (const chunk of source) {
    parts.push(Buffer.from(chunk))
    length += chunk.byteLength
  }
  return Buffer.concat(parts, length)
}

async function* chunks(bytes: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + size))
  }
}

async function expectVerifyFailure(bytes: Buffer, code: string): Promise<void> {
  await expect(verifySavePairTransportArchive({
    source: chunks(bytes, 19), declaredBytes: bytes.length, declaredSha256: hash(bytes)
  })).rejects.toMatchObject({ code })
}

function rawArchive(dsvName: string, serverName: string, dsvDeclaredBytes?: number): Buffer {
  const saveName = 'Safe_Save'
  const dsv = Buffer.from('dsv')
  const server = Buffer.from('server')
  const manifest: SavePairTransportManifest = {
    format: 'dyson-control-save-pair-transport', schemaVersion: 1, saveName,
    generatedAt: '2026-08-30T10:00:00.000Z', generation: { strategy: 'source-backup-created-at' },
    source: {
      kind: 'verified-backup', backupId: `tx-${randomUUID()}`,
      createdAt: '2026-08-30T10:00:00.000Z', manifestSha256: 'a'.repeat(64)
    },
    files: [
      { name: `${saveName}.dsv`, bytes: dsv.length, sha256: hash(dsv) },
      { name: `${saveName}.server`, bytes: server.length, sha256: hash(server) }
    ]
  }
  return Buffer.concat([
    Buffer.from('DYSONPAIRARCHV1\n', 'ascii'), u16(3),
    rawRecord('manifest.json', canonicalManifestBytes(manifest)),
    rawRecord(dsvName, dsv, dsvDeclaredBytes),
    rawRecord(serverName, server),
    Buffer.from('DYSONPAIREND1\n', 'ascii')
  ])
}

function rawRecord(name: string, data: Buffer, declaredBytes = data.length): Buffer {
  const nameBytes = Buffer.from(name, 'utf8')
  return Buffer.concat([
    u16(nameBytes.length), nameBytes, u64(declaredBytes), data,
    Buffer.from(hash(data), 'hex'), u32(crc32(data))
  ])
}

function locateRecords(archive: Buffer): Array<{ dataOffset: number; crcOffset: number }> {
  const records: Array<{ dataOffset: number; crcOffset: number }> = []
  let offset = 18
  for (let index = 0; index < 3; index++) {
    const nameLength = archive.readUInt16BE(offset)
    offset += 2 + nameLength
    const bytes = Number(archive.readBigUInt64BE(offset))
    offset += 8
    const dataOffset = offset
    offset += bytes + 32
    const crcOffset = offset
    offset += 4
    records.push({ dataOffset, crcOffset })
  }
  return records
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function hashFile(filePath: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) digest.update(chunk)
  return digest.digest('hex')
}

function u16(value: number): Buffer {
  const output = Buffer.allocUnsafe(2); output.writeUInt16BE(value); return output
}
function u32(value: number): Buffer {
  const output = Buffer.allocUnsafe(4); output.writeUInt32BE(value); return output
}
function u64(value: number): Buffer {
  const output = Buffer.allocUnsafe(8); output.writeBigUInt64BE(BigInt(value)); return output
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  return (value ^ 0xffffffff) >>> 0
}

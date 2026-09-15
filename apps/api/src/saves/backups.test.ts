import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { catalogBackups, verifyBackupPair } from './backups.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('backup manifest verification', () => {
  it('verifies a complete .dsv + .server unit against schema-v1 lengths and SHA-256 hashes', async () => {
    const fixture = await backupFixture('Complete_Save')
    const result = await verifyBackupPair({ backupRoot: fixture.root, backupId: fixture.backupId })
    expect(result).toEqual({
      schemaVersion: 1,
      backupId: fixture.backupId,
      saveName: 'Complete_Save',
      createdAt: '2026-08-30T00:00:00.000Z',
      health: 'healthy',
      issues: [],
      manifestPresent: true,
      manifestValid: true,
      pairPresent: true,
      dsvBytes: 21,
      serverBytes: 24,
      totalBytes: 45
    })
  })

  it('reports an absent sidecar as an incomplete atomic unit', async () => {
    const fixture = await backupFixture('Missing_Backup_Sidecar', { omitServer: true })
    const result = await verifyBackupPair({ backupRoot: fixture.root, backupId: fixture.backupId })
    expect(result).toMatchObject({
      health: 'incomplete', pairPresent: false, issues: ['pair-incomplete'], serverBytes: null
    })
  })

  it('detects same-length content tampering without returning hashes or contents', async () => {
    const fixture = await backupFixture('Tampered_Save')
    await writeFile(path.join(fixture.directory, 'Tampered_Save.dsv'), 'x'.repeat(21), 'utf8')
    const result = await verifyBackupPair({ backupRoot: fixture.root, backupId: fixture.backupId })
    expect(result).toMatchObject({ health: 'corrupt', issues: ['hash-mismatch-dsv'] })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(fixture.root)
    expect(serialized).not.toContain('fictional-dsv-payload')
    expect(collectKeys(result)).not.toEqual(expect.arrayContaining(['path', 'root', 'content', 'sha256']))
  })

  it('rejects manifest extensions and directory identity mismatches', async () => {
    const fixture = await backupFixture('Strict_Manifest', { extraManifestField: true })
    await expect(verifyBackupPair({
      backupRoot: fixture.root,
      backupId: '../escape'
    })).rejects.toBeDefined()
    const result = await verifyBackupPair({ backupRoot: fixture.root, backupId: fixture.backupId })
    expect(result).toMatchObject({ health: 'corrupt', manifestValid: false, issues: ['manifest-invalid'] })
  })

  it('catalogs and verifies only the requested bounded backup page', async () => {
    const first = await backupFixture('First')
    await backupFixture('Second', { root: first.root })
    const pageOne = await catalogBackups({
      backupRoot: first.root,
      query: { cursor: null, pageSize: 1 },
      now: new Date('2026-08-30T01:00:00.000Z')
    })
    expect(pageOne.items).toHaveLength(1)
    expect(pageOne.page).toMatchObject({ limit: 1, returned: 1, totalUnits: 2 })
    expect(pageOne.page.nextCursor).not.toBeNull()
    const pageTwo = await catalogBackups({
      backupRoot: first.root,
      query: { cursor: pageOne.page.nextCursor, pageSize: 1 },
      now: new Date('2026-08-30T01:00:00.000Z')
    })
    expect(pageTwo.items).toHaveLength(1)
    expect(pageTwo.page.nextCursor).toBeNull()
  })
})

interface BackupFixtureOptions {
  root?: string
  omitServer?: boolean
  extraManifestField?: boolean
}

async function backupFixture(saveName: string, options: BackupFixtureOptions = {}): Promise<{
  root: string
  directory: string
  backupId: string
}> {
  const root = options.root ?? await mkdtemp(path.join(tmpdir(), 'dyson-backup-catalog-fixture-'))
  if (options.root === undefined) temporaryRoots.push(root)
  const requestId = randomUUID()
  const backupId = `tx-${requestId}`
  const directory = path.join(root, backupId)
  await mkdir(directory, { recursive: true })
  const dsv = 'fictional-dsv-payload'
  const server = 'fictional-server-sidecar'
  await writeFile(path.join(directory, `${saveName}.dsv`), dsv, 'utf8')
  if (!options.omitServer) await writeFile(path.join(directory, `${saveName}.server`), server, 'utf8')
  const manifest = {
    protocol: 'DYSON_CONTROL_PROTECTION_V1',
    schemaVersion: 1,
    requestId,
    createdAt: '2026-08-30T00:00:00.000Z',
    saveName,
    files: [
      { name: `${saveName}.dsv`, bytes: Buffer.byteLength(dsv), sha256: hash(dsv) },
      { name: `${saveName}.server`, bytes: Buffer.byteLength(server), sha256: hash(server) }
    ],
    ...(options.extraManifestField ? { unexpected: true } : {})
  }
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest), 'utf8')
  return { root, directory, backupId }
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectKeys)
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, child]) => [key, ...collectKeys(child)])
}

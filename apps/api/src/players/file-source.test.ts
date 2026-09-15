import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FilePlayerSnapshotSource } from './file-source.js'
import { buildPlayerSnapshot } from './protocol.js'

const secret = 'fictional-file-player-source-secret-0123456789'
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('file player snapshot source', () => {
  it('reads a fresh signed atomic-snapshot payload', async () => {
    const fixture = await createFixture(Date.now())
    const source = new FilePlayerSnapshotSource({
      controlRoot: fixture.controlRoot,
      secretFile: fixture.secretFile,
      maximumAgeMs: 5_000
    })
    await expect(source.read()).resolves.toMatchObject({
      state: 'active', playerCount: 1, players: [{ displayName: 'Nova' }]
    })
  })

  it('rejects stale, tampered, oversized, and missing snapshots', async () => {
    const stale = await createFixture(Date.now() - 20_000)
    await expect(new FilePlayerSnapshotSource({
      controlRoot: stale.controlRoot, secretFile: stale.secretFile, maximumAgeMs: 5_000
    }).read()).rejects.toThrow('PLAYER_SNAPSHOT_STALE')

    const tampered = await createFixture(Date.now())
    const playerFile = path.join(tampered.controlRoot, 'players')
    await fs.writeFile(playerFile, (await fs.readFile(playerFile, 'utf8')).replace('state=active', 'state=inactive'))
    await expect(new FilePlayerSnapshotSource({
      controlRoot: tampered.controlRoot, secretFile: tampered.secretFile
    }).read()).rejects.toThrow('PLAYER_SNAPSHOT_SIGNATURE_INVALID')

    const oversized = await createFixture(Date.now())
    await fs.writeFile(path.join(oversized.controlRoot, 'players'), 'x'.repeat(32_769))
    await expect(new FilePlayerSnapshotSource({
      controlRoot: oversized.controlRoot, secretFile: oversized.secretFile
    }).read()).rejects.toThrow('PLAYER_SNAPSHOT_FILE_INVALID')

    const missing = await createFixture(Date.now())
    await fs.rm(path.join(missing.controlRoot, 'players'))
    await expect(new FilePlayerSnapshotSource({
      controlRoot: missing.controlRoot, secretFile: missing.secretFile
    }).read()).rejects.toThrow('PLAYER_SNAPSHOT_FILE_UNAVAILABLE')
  })
})

async function createFixture(writtenAtUnixMs: number) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyson-player-source-'))
  temporaryRoots.push(root)
  const controlRoot = path.join(root, 'control')
  const secretFile = path.join(root, 'secret')
  await fs.mkdir(controlRoot)
  await fs.writeFile(secretFile, secret)
  const payload = buildPlayerSnapshot({
    sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    writtenAtUnixMs,
    sequence: 1,
    state: 'active',
    truncated: false,
    players: [{
      sessionPlayerId: 'player-000001', displayName: 'Nova', online: true,
      joinedAtUnixMs: writtenAtUnixMs - 1_000, location: 'planet:101'
    }]
  }, secret).payload
  await fs.writeFile(path.join(controlRoot, 'players'), payload)
  return { controlRoot, secretFile }
}

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildPlayerCapabilitySnapshot } from './capabilities.js'
import { FilePlayerCapabilitySource } from './capability-source.js'

const secret = 'fictional-file-capability-source-secret-0123456789'
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('file player capability source', () => {
  it('reads a fresh signed declaration and preserves the fail-closed action flag', async () => {
    const fixture = await createFixture(Date.now())
    const source = new FilePlayerCapabilitySource({
      controlRoot: fixture.controlRoot,
      secretFile: fixture.secretFile,
      maximumAgeMs: 5_000
    })
    await expect(source.read()).resolves.toMatchObject({
      actionsEnabled: false,
      capabilities: expect.arrayContaining([{
        capability: 'ban', availability: 'unavailable', mode: 'mutation',
        verifiedReasonCode: 'UPSTREAM_BAN_API_ABSENT'
      }])
    })
  })

  it('rejects stale, tampered, oversized, and missing declarations', async () => {
    const stale = await createFixture(Date.now() - 20_000)
    await expect(new FilePlayerCapabilitySource({
      controlRoot: stale.controlRoot, secretFile: stale.secretFile, maximumAgeMs: 5_000
    }).read()).rejects.toThrow('PLAYER_CAPABILITY_STALE')

    const tampered = await createFixture(Date.now())
    const capabilityFile = path.join(tampered.controlRoot, 'player-capabilities')
    await fs.writeFile(
      capabilityFile,
      (await fs.readFile(capabilityFile, 'utf8')).replace('actionsEnabled=false', 'actionsEnabled=true')
    )
    await expect(new FilePlayerCapabilitySource({
      controlRoot: tampered.controlRoot, secretFile: tampered.secretFile
    }).read()).rejects.toThrow('PLAYER_CAPABILITY_ACTIONS_INVALID')

    const oversized = await createFixture(Date.now())
    await fs.writeFile(path.join(oversized.controlRoot, 'player-capabilities'), 'x'.repeat(8_193))
    await expect(new FilePlayerCapabilitySource({
      controlRoot: oversized.controlRoot, secretFile: oversized.secretFile
    }).read()).rejects.toThrow('PLAYER_CAPABILITY_FILE_INVALID')

    const missing = await createFixture(Date.now())
    await fs.rm(path.join(missing.controlRoot, 'player-capabilities'))
    await expect(new FilePlayerCapabilitySource({
      controlRoot: missing.controlRoot, secretFile: missing.secretFile
    }).read()).rejects.toThrow('PLAYER_CAPABILITY_FILE_UNAVAILABLE')
  })
})

async function createFixture(writtenAtUnixMs: number) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyson-player-capability-source-'))
  temporaryRoots.push(root)
  const controlRoot = path.join(root, 'control')
  const secretFile = path.join(root, 'secret')
  await fs.mkdir(controlRoot)
  await fs.writeFile(secretFile, secret)
  const payload = buildPlayerCapabilitySnapshot({
    sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    writtenAtUnixMs
  }, secret).payload
  await fs.writeFile(path.join(controlRoot, 'player-capabilities'), payload)
  return { controlRoot, secretFile }
}

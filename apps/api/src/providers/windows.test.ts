import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WindowsProvider } from './windows.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Windows status provider', () => {
  it('parses a fictional read-only installation without returning host paths', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'dyson-control-fixture-'))
    temporaryRoots.push(projectRoot)

    const logRoot = path.join(projectRoot, 'server', 'BepInEx')
    const saveRoot = path.join(projectRoot, 'userdata', 'Save')
    const backupRoot = path.join(projectRoot, 'backups', 'saves', '20260101-120000-Fictional_Save')
    await Promise.all([
      mkdir(logRoot, { recursive: true }),
      mkdir(saveRoot, { recursive: true }),
      mkdir(backupRoot, { recursive: true })
    ])

    await writeFile(path.join(logRoot, 'LogOutput.log'), [
      '[Message: BepInEx] BepInEx 5.4.17.0 - DSPGAME',
      '[Info: BepInEx] Loading [NebulaMultiplayerMod 0.9.22.2]',
      '[Info: NebulaMultiplayerMod] Loading game version 0.10.34.28529',
      '[Info: NebulaMultiplayerMod] Starting dedicated server, loading save : Fictional_Save',
      '[Info: NebulaMultiplayerMod] ==== Game load completed ===='
    ].join('\r\n'), 'utf8')
    await Promise.all([
      writeFile(path.join(saveRoot, 'Fictional_Save.dsv'), 'fictional-save', 'utf8'),
      writeFile(path.join(saveRoot, 'Fictional_Save.server'), 'fictional-sidecar', 'utf8'),
      writeFile(path.join(backupRoot, 'Fictional_Save.dsv'), 'fictional-save', 'utf8'),
      writeFile(path.join(backupRoot, 'Fictional_Save.server'), 'fictional-sidecar', 'utf8'),
      writeFile(path.join(backupRoot, 'manifest.json'), '{"fixture":true}', 'utf8')
    ])

    const repositoryRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..')
    const provider = new WindowsProvider({
      projectRoot,
      scriptRoot: path.join(repositoryRoot, 'scripts', 'windows'),
      timeoutMs: 30_000
    })
    const status = await provider.collectStatus()

    expect(status.state).toBe('stopped')
    expect(status.versions).toMatchObject({
      dsp: '0.10.34.28529', nebula: '0.9.22.2', bepInEx: '5.4.17.0',
      compatible: true, gameLoaded: true, warnings: []
    })
    expect(status.save).toMatchObject({
      name: 'Fictional_Save', dsvPresent: true, serverPresent: true, consistent: true,
      backupManifestPresent: true, backupPairPresent: true
    })
    expect(status.host.logicalProcessors).toBeGreaterThan(0)
    expect(status.capabilities).toEqual({ refresh: true, save: false, gracefulStop: false, restart: false })
    expect(JSON.stringify(status)).not.toContain(projectRoot)
  }, 45_000)
})

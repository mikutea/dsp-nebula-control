import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
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
    const saveFixture = 'fictional-save'
    const sidecarFixture = 'fictional-sidecar'
    await Promise.all([
      writeFile(path.join(saveRoot, 'Fictional_Save.dsv'), saveFixture, 'utf8'),
      writeFile(path.join(saveRoot, 'Fictional_Save.server'), sidecarFixture, 'utf8'),
      writeFile(path.join(backupRoot, 'Fictional_Save.dsv'), saveFixture, 'utf8'),
      writeFile(path.join(backupRoot, 'Fictional_Save.server'), sidecarFixture, 'utf8'),
      writeFile(path.join(backupRoot, 'manifest.json'), JSON.stringify({
        schemaVersion: 1,
        saveName: 'Fictional_Save',
        files: [
          { name: 'Fictional_Save.dsv', bytes: Buffer.byteLength(saveFixture), sha256: createHash('sha256').update(saveFixture).digest('hex') },
          { name: 'Fictional_Save.server', bytes: Buffer.byteLength(sidecarFixture), sha256: createHash('sha256').update(sidecarFixture).digest('hex') }
        ]
      }), 'utf8')
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

    const preview = await provider.previewLifecycle('graceful-stop')
    expect(preview).toMatchObject({
      action: 'graceful-stop', mode: 'dry-run', allowed: false, executionEnabled: false
    })
    expect(preview.blockers).toEqual(expect.arrayContaining([
      'managed-process-unverified', 'pid-file-unverified', 'execution-disabled'
    ]))
    expect(preview.checks.map((check) => check.id)).toEqual(expect.arrayContaining([
      'managed-process', 'save-pair', 'stop-task', 'receipt-channel', 'execution-lock'
    ]))
    const backupCheck = preview.checks.find((check) => check.id === 'backup-pair')
    expect(backupCheck?.message).toBe('The latest paired backup matches its hash manifest.')
    expect(backupCheck?.status).toBe('pass')
    expect(preview.blockers).not.toContain('backup-pair-unverified')
    expect(JSON.stringify(preview)).not.toContain(projectRoot)

    await writeFile(path.join(backupRoot, 'Fictional_Save.dsv'), 'tampered-backup', 'utf8')
    const tamperedPreview = await provider.previewLifecycle('restart')
    expect(tamperedPreview.checks.find((check) => check.id === 'backup-pair')?.status).toBe('block')
    expect(tamperedPreview.blockers).toContain('backup-pair-unverified')
  }, 45_000)
})

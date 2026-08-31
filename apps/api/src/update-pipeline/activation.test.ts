import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { hostname, tmpdir, uptime } from 'node:os'
import { deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ComponentUpdateActivationError,
  ComponentUpdateActivationService,
  initialComponentUpdateRevision,
  resolveBepInExWindowsX64LayoutPolicy,
  type ComponentUpdateActivationAdapters,
  type FixedUpdateSmokeRequest,
  type ManagedUpdateComponent,
  type TrustedCompatibilityAssertion
} from './index.js'

const temporaryRoots: string[] = []
const compatibilityFixtures = new Map<string, {
  inventory: ReturnType<typeof baseInventory>
  candidate: ReturnType<typeof baseInventory>
  compatible: boolean
}>()

const officialBepInExCommonFiles = [
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

afterEach(async () => {
  compatibilityFixtures.clear()
  await Promise.all(temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

describe('component update activation transaction', () => {
  it.each([
    ['nebula', '0.9.1', 'github:NebulaModTeam/nebula', 'nebula', 'plugins/nebula-NebulaMultiplayerMod/Nebula.dll'],
    ['bridge', '0.2.0', 'thunderstore:DysonControl/Bridge', 'plugin', 'plugins/dyson-control-bridge/DysonControlBridge.dll'],
    ['control', '0.2.0', 'thunderstore:DysonControl/Control', 'plugin', 'plugins/dyson-control/DysonControl.dll']
  ] as const)('previews and activates a verified %s release with an idempotent receipt', async (
    component,
    targetVersion,
    sourceId,
    stageKind,
    payloadName
  ) => {
    const fixture = await createFixture()
    const staged = await stageComponent(fixture.stagingRoot, {
      component,
      targetVersion,
      sourceId,
      stageKind,
      artifactId: `${component}-artifact-0001`,
      payloads: [{ name: payloadName, bytes: Buffer.from(`${component}-binary`) }]
    })
    const controlled = createAdapters()
    const service = createService(fixture, controlled.adapters)
    const request = makeRequest(component, targetVersion, staged, initialComponentUpdateRevision)

    const plan = await service.preview(request)
    expect(plan).toMatchObject({ dryRun: true, component, fileCount: 1, targetVersion })
    expect(await pathExists(path.join(fixture.projectRoot, '.dyson-control-updates'))).toBe(false)

    const receipt = await service.execute(request)
    expect(receipt).toMatchObject({ status: 'succeeded', component, targetVersion, reused: false, recoveryRequired: false })
    expect(controlled.stopPhases).toEqual([
      'before-protection',
      'before-publish',
      'before-publish',
      'before-publish'
    ])
    expect(controlled.protectionCalls).toBe(1)
    expect(controlled.smokeCalls).toEqual(['candidate'])
    const repeated = await service.execute(request)
    expect(repeated).toMatchObject({ status: 'succeeded', reused: true })
    expect(controlled.protectionCalls).toBe(1)
    expect((await service.getState()).components).toEqual([
      expect.objectContaining({ component, version: targetVersion, artifactId: staged.artifactId })
    ])
    expect(await readFile(path.join(fixture.liveRoot, payloadName), 'utf8')).toBe(`${component}-binary`)
    const serialized = JSON.stringify(receipt)
    expect(serialized).not.toContain(fixture.root)
    expect(serialized).not.toContain(staged.sha256)
  })

  it('previews and activates a complete official-layout BepInEx Windows x64 package', async () => {
    const fixture = await createFixture()
    const staged = await stageComponent(fixture.stagingRoot, {
      component: 'bepinex',
      targetVersion: '5.4.22',
      sourceId: 'github:BepInEx/BepInEx',
      stageKind: 'bepinex',
      artifactId: 'bepinex-artifact-0001',
      payloads: makeBepInExPayloads('5.4.22')
    })
    const controlled = createAdapters()
    const service = createService(fixture, controlled.adapters)
    const request = makeRequest('bepinex', '5.4.22', staged, initialComponentUpdateRevision)

    await expect(service.preview(request)).resolves.toMatchObject({ component: 'bepinex', fileCount: 21 })
    await expect(service.execute(request)).resolves.toMatchObject({ component: 'bepinex', status: 'succeeded' })
    expect(await readFile(path.join(fixture.liveRoot, 'winhttp.dll'), 'utf8')).toBe('5.4.22:winhttp.dll')
    expect(await readFile(path.join(fixture.liveRoot, 'BepInEx', 'core', 'BepInEx.dll'), 'utf8'))
      .toBe('5.4.22:BepInEx/core/BepInEx.dll')
  })

  it('upgrades BepInEx without owning user config/plugins and removes only stale bootstrap files', async () => {
    const fixture = await createFixture()
    const adapters = createAdapters()
    const service = createService(fixture, adapters.adapters)
    const v23 = await stageComponent(fixture.stagingRoot, {
      component: 'bepinex', targetVersion: '5.4.23.2', sourceId: 'github:BepInEx/BepInEx',
      stageKind: 'bepinex', artifactId: 'bepinex-artifact-2302', payloads: makeBepInExPayloads('5.4.23.2')
    })
    const installed = await service.execute(makeRequest('bepinex', '5.4.23.2', v23, initialComponentUpdateRevision))
    const config = path.join(fixture.liveRoot, 'BepInEx', 'config', 'BepInEx.cfg')
    const plugin = path.join(fixture.liveRoot, 'BepInEx', 'plugins', 'UserPlugin.dll')
    await Promise.all([mkdir(path.dirname(config), { recursive: true }), mkdir(path.dirname(plugin), { recursive: true })])
    await Promise.all([writeFile(config, 'user-config'), writeFile(plugin, 'user-plugin')])

    const v22 = await stageComponent(fixture.stagingRoot, {
      component: 'bepinex', targetVersion: '5.4.22', sourceId: 'github:BepInEx/BepInEx',
      stageKind: 'bepinex', artifactId: 'bepinex-artifact-2200', payloads: makeBepInExPayloads('5.4.22')
    })
    const downgraded = await service.execute(makeRequest(
      'bepinex', '5.4.22', v22, installed.resultingRevision, baseInventory({ bepInEx: '5.4.23.2' })
    ))
    expect(downgraded.status).toBe('succeeded')
    expect(await pathExists(path.join(fixture.liveRoot, '.doorstop_version'))).toBe(false)
    expect(await readFile(config, 'utf8')).toBe('user-config')
    expect(await readFile(plugin, 'utf8')).toBe('user-plugin')
  })

  it('compensates a failed BepInEx bootstrap upgrade and restores every previous owned file', async () => {
    const fixture = await createFixture()
    const v22 = await stageComponent(fixture.stagingRoot, {
      component: 'bepinex', targetVersion: '5.4.22', sourceId: 'github:BepInEx/BepInEx',
      stageKind: 'bepinex', artifactId: 'bepinex-artifact-old1', payloads: makeBepInExPayloads('5.4.22')
    })
    const v23 = await stageComponent(fixture.stagingRoot, {
      component: 'bepinex', targetVersion: '5.4.23.2', sourceId: 'github:BepInEx/BepInEx',
      stageKind: 'bepinex', artifactId: 'bepinex-artifact-new1', payloads: makeBepInExPayloads('5.4.23.2')
    })
    const adapters = createAdapters({
      smoke: async (request) => request.phase === 'candidate' && request.expectedVersion === '5.4.23.2'
        ? smokeResult(request, false)
        : smokeResult(request, true)
    })
    const service = createService(fixture, adapters.adapters)
    const installed = await service.execute(makeRequest('bepinex', '5.4.22', v22, initialComponentUpdateRevision))
    const result = await service.execute(makeRequest(
      'bepinex', '5.4.23.2', v23, installed.resultingRevision, baseInventory({ bepInEx: '5.4.22' })
    ))

    expect(result).toMatchObject({ status: 'rolled-back', rollbackVerified: true })
    expect(await readFile(path.join(fixture.liveRoot, 'winhttp.dll'), 'utf8')).toBe('5.4.22:winhttp.dll')
    expect(await readFile(path.join(fixture.liveRoot, 'BepInEx', 'core', 'BepInEx.dll'), 'utf8'))
      .toBe('5.4.22:BepInEx/core/BepInEx.dll')
    expect(await pathExists(path.join(fixture.liveRoot, '.doorstop_version'))).toBe(false)
  })

  it('keeps DSP as an explicit manual Steam-client operation and invokes no adapter', async () => {
    const fixture = await createFixture()
    const controlled = createAdapters()
    const service = createService(fixture, controlled.adapters)
    await expect(service.execute({
      requestId: randomUUID(),
      component: 'dsp',
      targetVersion: '0.10.33.26727',
      expectedRevision: initialComponentUpdateRevision
    })).rejects.toMatchObject({ code: 'UPDATE_DSP_MANUAL_STEAM_REQUIRED' })
    expect(controlled.protectionCalls).toBe(0)
    expect(controlled.stopPhases).toEqual([])
    expect(controlled.smokeCalls).toEqual([])
    expect(await pathExists(path.join(fixture.projectRoot, '.dyson-control-updates'))).toBe(false)
  })

  it('rejects stage tampering, embedded-manifest tampering, zip-slip, extra DLLs, and archive links', async () => {
    const cases: Array<{
      name: string
      build: (fixture: Fixture) => Promise<Staged>
      expectedCode: string
    }> = [
      {
        name: 'outer stage bytes',
        build: async (fixture) => {
          const staged = await stageComponent(fixture.stagingRoot, defaultStage())
          await writeFile(staged.artifactPath, Buffer.from('changed-after-staging'))
          return staged
        },
        expectedCode: 'UPDATE_STAGED_ARTIFACT_TAMPERED'
      },
      {
        name: 'embedded payload digest',
        build: async (fixture) => await stageComponent(fixture.stagingRoot, {
          ...defaultStage(),
          declaredFiles: [{ name: 'plugins/nebula-NebulaMultiplayerMod/Nebula.dll', bytes: Buffer.from('tamper') }]
        }),
        expectedCode: 'UPDATE_ARCHIVE_CONTENT_MISMATCH'
      },
      {
        name: 'zip slip',
        build: async (fixture) => await stageComponent(fixture.stagingRoot, {
          ...defaultStage(),
          payloads: [{ name: '../escape.dll', bytes: Buffer.from('escape') }],
          declaredFiles: [{ name: '../escape.dll', bytes: Buffer.from('escape') }]
        }),
        expectedCode: 'UPDATE_ARCHIVE_PATH_INVALID'
      },
      {
        name: 'extra DLL',
        build: async (fixture) => await stageComponent(fixture.stagingRoot, {
          ...defaultStage(),
          payloads: [
            { name: 'plugins/nebula-NebulaMultiplayerMod/Nebula.dll', bytes: Buffer.from('nebula') },
            { name: 'plugins/nebula-NebulaMultiplayerMod/Injected.dll', bytes: Buffer.from('injected') }
          ],
          declaredFiles: [{ name: 'plugins/nebula-NebulaMultiplayerMod/Nebula.dll', bytes: Buffer.from('nebula') }]
        }),
        expectedCode: 'UPDATE_ARCHIVE_UNDECLARED_FILE'
      },
      {
        name: 'non DLL/JSON payload',
        build: async (fixture) => await stageComponent(fixture.stagingRoot, {
          ...defaultStage(),
          payloads: [{ name: 'README.txt', bytes: Buffer.from('not executable payload') }]
        }),
        expectedCode: 'UPDATE_ARCHIVE_FILE_TYPE_FORBIDDEN'
      },
      {
        name: 'symlink entry',
        build: async (fixture) => await stageComponent(fixture.stagingRoot, {
          ...defaultStage(),
          payloads: [{ name: 'plugins/nebula-NebulaMultiplayerMod/Nebula.dll', bytes: Buffer.from('nebula'), unixMode: 0o120777 }]
        }),
        expectedCode: 'UPDATE_ARCHIVE_LINK_FORBIDDEN'
      }
    ]

    for (const testCase of cases) {
      const fixture = await createFixture()
      const staged = await testCase.build(fixture)
      const service = createService(fixture, createAdapters().adapters)
      await expect(service.execute(makeRequest('nebula', '0.9.1', staged, initialComponentUpdateRevision)))
        .rejects.toMatchObject({ code: testCase.expectedCode })
    }
  })

  it('fails closed on a linked fixed root', async () => {
    const fixture = await createFixture()
    const actual = path.join(fixture.root, 'actual-staging')
    const linked = path.join(fixture.root, 'linked-staging')
    await mkdir(actual)
    await symlink(actual, linked, process.platform === 'win32' ? 'junction' : 'dir')
    const service = new ComponentUpdateActivationService({
      projectRoot: fixture.projectRoot,
      stagingRoot: linked,
      liveComponentRoots: liveComponentRoots(fixture),
      compatibilityVerifier: createCompatibilityVerifier(),
      ...createAdapters().adapters
    })
    const staged: Staged = { artifactId: 'nebula-artifact-0001', sha256: '0'.repeat(64), artifactPath: '' }
    await expect(service.preview(makeRequest('nebula', '0.9.1', staged, initialComponentUpdateRevision)))
      .rejects.toMatchObject({ code: 'UPDATE_ROOT_INVALID' })
  })

  it('requires both stopped-process/closed-port proof and a durable paired-save protection receipt', async () => {
    const fixture = await createFixture()
    const staged = await stageComponent(fixture.stagingRoot, defaultStage())
    const running = createAdapters({ stopped: false })
    await expect(createService(fixture, running.adapters).execute(
      makeRequest('nebula', '0.9.1', staged, initialComponentUpdateRevision)
    )).rejects.toMatchObject({ code: 'UPDATE_SERVICE_STILL_RUNNING' })
    expect(running.protectionCalls).toBe(0)

    const brokenProtection = createAdapters({ protectionValid: false })
    await expect(createService(fixture, brokenProtection.adapters).execute(
      makeRequest('nebula', '0.9.1', staged, initialComponentUpdateRevision)
    )).rejects.toMatchObject({ code: 'UPDATE_SAVE_PROTECTION_FAILED' })
    expect(brokenProtection.protectionCalls).toBe(1)
  })

  it('rejects compatibility evidence drift and optimistic revision conflicts before any lifecycle gate', async () => {
    const fixture = await createFixture()
    const staged = await stageComponent(fixture.stagingRoot, defaultStage())
    const controlled = createAdapters()
    const service = createService(fixture, controlled.adapters)
    const revisionConflict = makeRequest('nebula', '0.9.1', staged, 'f'.repeat(64))
    await expect(service.execute(revisionConflict)).rejects.toMatchObject({ code: 'UPDATE_REVISION_CONFLICT' })

    const incompatible = makeRequest('nebula', '0.9.1', staged, initialComponentUpdateRevision)
    compatibilityFixtures.get(incompatible.compatibilityReceiptId)!.compatible = false
    await expect(service.execute(incompatible)).rejects.toMatchObject({ code: 'UPDATE_COMPATIBILITY_CONFLICT' })
    expect(controlled.stopPhases).toEqual([])
    expect(controlled.protectionCalls).toBe(0)
  })

  it('serializes one instance, rejects a concurrent cross-instance mutation, and preserves UUID idempotency', async () => {
    const fixture = await createFixture()
    const staged = await stageComponent(fixture.stagingRoot, defaultStage())
    let releaseStop!: () => void
    let enteredStop!: () => void
    const entered = new Promise<void>((resolve) => { enteredStop = resolve })
    const wait = new Promise<void>((resolve) => { releaseStop = resolve })
    const controlled = createAdapters({
      stoppedVerifier: async (request) => {
        if (request.phase === 'before-protection') {
          enteredStop()
          await wait
        }
        return { processStopped: true, portClosed: true }
      }
    })
    const firstService = createService(fixture, controlled.adapters)
    const secondService = createService(fixture, controlled.adapters)
    const request = makeRequest('nebula', '0.9.1', staged, initialComponentUpdateRevision)
    const first = firstService.execute(request)
    await entered
    await expect(secondService.execute(request)).rejects.toMatchObject({ code: 'UPDATE_ACTIVATION_LOCK_BUSY' })
    releaseStop()
    expect((await first).status).toBe('succeeded')
    expect((await secondService.execute(request)).reused).toBe(true)
  })

  it('reclaims only a provably dead same-host lock so restart reconciliation is not stranded', async () => {
    const fixture = await createFixture()
    const staged = await stageComponent(fixture.stagingRoot, defaultStage())
    const service = createService(fixture, createAdapters().adapters)
    const request = makeRequest('nebula', '0.9.1', staged, initialComponentUpdateRevision)
    await service.execute(request)
    const lockPath = path.join(fixture.projectRoot, '.dyson-control-updates', '.locks', 'activation.lock')
    await writeFile(lockPath, JSON.stringify({
      format: 'dyson-control-component-update-lock',
      schemaVersion: 1,
      host: hostname(),
      bootId: Math.round((Date.now() - uptime() * 1_000) / 60_000).toString(36),
      pid: 2_147_483_647,
      instanceId: randomUUID(),
      acquiredAt: '2026-08-30T12:00:00.000Z'
    }))
    expect((await service.execute(request)).reused).toBe(true)
    expect(await pathExists(lockPath)).toBe(false)
  })

  it('atomically rolls back a failed candidate and marks recoveryRequired if rollback smoke cannot be proven', async () => {
    const rollbackFixture = await createFixture()
    const v1 = await stageComponent(rollbackFixture.stagingRoot, defaultStage({ artifactId: 'nebula-artifact-0001', targetVersion: '0.9.1' }))
    const v2 = await stageComponent(rollbackFixture.stagingRoot, defaultStage({
      artifactId: 'nebula-artifact-0002',
      targetVersion: '0.9.2',
      payloads: [{ name: 'plugins/nebula-NebulaMultiplayerMod/Nebula.dll', bytes: Buffer.from('nebula-v2') }]
    }))
    const adapters = createAdapters({
      smoke: async (request) => request.phase === 'candidate' && request.expectedVersion === '0.9.2'
        ? smokeResult(request, false)
        : smokeResult(request, true)
    })
    const service = createService(rollbackFixture, adapters.adapters)
    const first = await service.execute(makeRequest('nebula', '0.9.1', v1, initialComponentUpdateRevision))
    const currentInventory = baseInventory({ nebula: '0.9.1' })
    const rolledBack = await service.execute(makeRequest('nebula', '0.9.2', v2, first.resultingRevision, currentInventory))
    expect(rolledBack).toMatchObject({ status: 'rolled-back', rollbackVerified: true, resultingRevision: first.resultingRevision })
    expect((await service.getState()).components[0]).toMatchObject({ version: '0.9.1' })
    expect(await readFile(path.join(rollbackFixture.liveRoot, 'plugins', 'nebula-NebulaMultiplayerMod', 'Nebula.dll'), 'utf8')).toBe('nebula')

    const recoveryFixture = await createFixture()
    const recoveryV1 = await stageComponent(recoveryFixture.stagingRoot, defaultStage({ artifactId: 'nebula-artifact-1001', targetVersion: '0.9.1' }))
    const recoveryV2 = await stageComponent(recoveryFixture.stagingRoot, defaultStage({ artifactId: 'nebula-artifact-1002', targetVersion: '0.9.2' }))
    const recoveryAdapters = createAdapters({
      smoke: async (request) => request.expectedVersion === '0.9.1' && request.phase === 'candidate'
        ? smokeResult(request, true)
        : smokeResult(request, false)
    })
    const recoveryService = createService(recoveryFixture, recoveryAdapters.adapters)
    const installed = await recoveryService.execute(makeRequest('nebula', '0.9.1', recoveryV1, initialComponentUpdateRevision))
    const failed = await recoveryService.execute(makeRequest(
      'nebula', '0.9.2', recoveryV2, installed.resultingRevision, baseInventory({ nebula: '0.9.1' })
    ))
    expect(failed).toMatchObject({ status: 'rollback-failed', recoveryRequired: true, rollbackVerified: false })
    expect((await recoveryService.getState()).recoveryRequired).toBe(true)
    const v3 = await stageComponent(recoveryFixture.stagingRoot, defaultStage({ artifactId: 'nebula-artifact-1003', targetVersion: '0.9.3' }))
    await expect(recoveryService.execute(makeRequest(
      'nebula', '0.9.3', v3, failed.resultingRevision, baseInventory({ nebula: '0.9.1' })
    ))).rejects.toMatchObject({ code: 'UPDATE_RECOVERY_REQUIRED' })
  })

  it('reconciles a committed activation after restart without recreating the save protection point', async () => {
    const fixture = await createFixture()
    const staged = await stageComponent(fixture.stagingRoot, defaultStage())
    const controlled = createAdapters()
    const firstService = createService(fixture, controlled.adapters)
    const request = makeRequest('nebula', '0.9.1', staged, initialComponentUpdateRevision)
    const receipt = await firstService.execute(request)
    await rm(path.join(fixture.projectRoot, '.dyson-control-updates', 'receipts', `${request.requestId}.json`))

    const restarted = createService(fixture, controlled.adapters)
    const reconciled = await restarted.reconcile()
    expect(reconciled).toMatchObject({ requestId: request.requestId, status: 'succeeded' })
    expect(controlled.protectionCalls).toBe(1)
    expect(controlled.smokeCalls).toContain('reconcile-candidate')
    expect((await restarted.getReceipt(request.requestId))?.resultingRevision).toBe(receipt.resultingRevision)
  })

  it('compensates real live files after an interrupted active-state switch', async () => {
    const fixture = await createFixture()
    const liveFile = path.join(fixture.liveRoot, 'plugins', 'nebula-NebulaMultiplayerMod', 'Nebula.dll')
    await mkdir(path.dirname(liveFile), { recursive: true })
    await writeFile(liveFile, 'previous-nebula')
    const staged = await stageComponent(fixture.stagingRoot, defaultStage({
      artifactId: 'nebula-artifact-interrupt',
      payloads: [{ name: 'plugins/nebula-NebulaMultiplayerMod/Nebula.dll', bytes: Buffer.from('candidate-nebula') }]
    }))
    let publishProofs = 0
    const controlled = createAdapters({
      stoppedVerifier: async (request) => {
        if (request.phase === 'before-publish' && ++publishProofs === 2) {
          await mkdir(path.join(fixture.projectRoot, '.dyson-control-updates', 'active.json'))
        }
        return { processStopped: true, portClosed: true }
      }
    })
    const request = makeRequest('nebula', '0.9.1', staged, initialComponentUpdateRevision)

    await expect(createService(fixture, controlled.adapters).execute(request))
      .rejects.toMatchObject({ code: 'UPDATE_ACTIVE_SWITCH_FAILED' })
    expect(await readFile(liveFile, 'utf8')).toBe('candidate-nebula')
    await rm(path.join(fixture.projectRoot, '.dyson-control-updates', 'active.json'), { recursive: true })

    const recovered = await createService(fixture, controlled.adapters).reconcile()
    expect(recovered).toMatchObject({ status: 'rolled-back', rollbackVerified: true, failureCode: 'UPDATE_INTERRUPTED' })
    expect(await readFile(liveFile, 'utf8')).toBe('previous-nebula')
  })

  it('bounds immutable history, offers cleanup only as a recoverable dry-run, and never deletes automatically', async () => {
    const fixture = await createFixture()
    const v1 = await stageComponent(fixture.stagingRoot, defaultStage({ artifactId: 'nebula-artifact-2001', targetVersion: '0.9.1' }))
    const v2 = await stageComponent(fixture.stagingRoot, defaultStage({ artifactId: 'nebula-artifact-2002', targetVersion: '0.9.2' }))
    const service = createService(fixture, createAdapters().adapters, { maximumHistoryEntries: 1 })
    const installed = await service.execute(makeRequest('nebula', '0.9.1', v1, initialComponentUpdateRevision))
    await expect(service.execute(makeRequest(
      'nebula', '0.9.2', v2, installed.resultingRevision, baseInventory({ nebula: '0.9.1' })
    ))).rejects.toMatchObject({ code: 'UPDATE_HISTORY_LIMIT_REACHED' })
    const cleanup = await service.previewCleanup()
    expect(cleanup).toMatchObject({ dryRun: true, executeSupported: false })
    expect(cleanup.candidates).toContainEqual(expect.objectContaining({ kind: 'history', recoverable: true }))
    expect((await service.getState()).historyEntries).toBe(1)
  })

  it('streams a large compressed late-game-adjacent component without whole-artifact API buffering', async () => {
    const fixture = await createFixture()
    const large = Buffer.alloc(8 * 1_024 * 1_024, 0x5a)
    const staged = await stageComponent(fixture.stagingRoot, {
      ...defaultStage({ artifactId: 'nebula-artifact-large', targetVersion: '0.9.1' }),
      payloads: [{ name: 'plugins/nebula-NebulaMultiplayerMod/Nebula.dll', bytes: large, method: 8 }]
    })
    const service = createService(fixture, createAdapters().adapters, {
      maximumArchiveBytes: 32 * 1_024 * 1_024,
      maximumFileBytes: 16 * 1_024 * 1_024,
      maximumExpandedBytes: 24 * 1_024 * 1_024
    })
    const receipt = await service.execute(makeRequest('nebula', '0.9.1', staged, initialComponentUpdateRevision))
    expect(receipt).toMatchObject({ status: 'succeeded', expandedBytes: large.length })
  })
})

interface Fixture {
  root: string
  projectRoot: string
  stagingRoot: string
  liveRoot: string
}

interface Staged {
  artifactId: string
  sha256: string
  artifactPath: string
}

interface Payload {
  name: string
  bytes: Buffer
  method?: 0 | 8
  unixMode?: number
}

interface StageOptions {
  component: ManagedUpdateComponent
  targetVersion: string
  sourceId: string
  stageKind: 'nebula' | 'bepinex' | 'plugin'
  artifactId: string
  payloads: Payload[]
  declaredFiles?: Payload[]
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'dyson-update-activation-'))
  temporaryRoots.push(root)
  const projectRoot = path.join(root, 'project')
  const stagingRoot = path.join(root, 'staging')
  const liveRoot = path.join(root, 'live')
  await Promise.all([
    mkdir(projectRoot),
    mkdir(path.join(stagingRoot, 'releases'), { recursive: true }),
    mkdir(path.join(liveRoot, 'plugins'), { recursive: true })
  ])
  return { root, projectRoot, stagingRoot, liveRoot }
}

function defaultStage(overrides: Partial<StageOptions> = {}): StageOptions {
  return {
    component: 'nebula',
    targetVersion: '0.9.1',
    sourceId: 'github:NebulaModTeam/nebula',
    stageKind: 'nebula',
    artifactId: 'nebula-artifact-0001',
    payloads: [{ name: 'plugins/nebula-NebulaMultiplayerMod/Nebula.dll', bytes: Buffer.from('nebula') }],
    ...overrides
  }
}

async function stageComponent(stagingRoot: string, options: StageOptions): Promise<Staged> {
  const manifestFiles = options.declaredFiles ?? options.payloads
  const embedded = {
    format: 'dyson-control-component-release',
    schemaVersion: 1,
    component: options.component,
    version: options.targetVersion,
    artifactId: options.artifactId,
    ...(options.component === 'bepinex'
      ? { layoutPolicy: resolveBepInExWindowsX64LayoutPolicy(options.targetVersion).id }
      : {}),
    files: manifestFiles.map((file) => ({
      relativePath: file.name,
      sizeBytes: file.bytes.length,
      sha256: sha256(file.bytes)
    }))
  }
  const archive = options.component === 'bepinex'
    ? buildZip(options.payloads)
    : buildZip([
        { name: 'dyson-component-manifest.json', bytes: Buffer.from(JSON.stringify(embedded), 'utf8') },
        ...options.payloads
      ])
  const digest = sha256(archive)
  const releaseRoot = path.join(stagingRoot, 'releases', options.artifactId)
  await mkdir(releaseRoot, { recursive: true })
  const artifactPath = path.join(releaseRoot, 'artifact.bin')
  await writeFile(artifactPath, archive)
  await writeFile(path.join(releaseRoot, 'manifest.json'), JSON.stringify({
    format: 'dyson-control-staged-artifact',
    schemaVersion: 1,
    artifactId: options.artifactId,
    artifactFile: 'artifact.bin',
    release: { kind: options.stageKind, sourceId: options.sourceId, version: options.targetVersion },
    sizeBytes: archive.length,
    sha256: digest,
    integrity: 'provider-verified',
    stagedAt: '2026-08-30T10:00:00.000Z',
    ...(options.component === 'bepinex' ? { componentManifest: embedded } : {})
  }))
  return { artifactId: options.artifactId, sha256: digest, artifactPath }
}

function makeBepInExPayloads(version: '5.4.22' | '5.4.23.2'): Payload[] {
  const files = version === '5.4.22'
    ? [...officialBepInExCommonFiles]
    : ['.doorstop_version', ...officialBepInExCommonFiles]
  return files.map((name) => ({ name, bytes: Buffer.from(`${version}:${name}`) }))
}

function makeRequest(
  component: ManagedUpdateComponent,
  targetVersion: string,
  staged: Staged,
  expectedRevision: string,
  inventory = baseInventory()
) {
  const candidate = structuredClone(inventory)
  if (component === 'nebula') candidate.nebula = targetVersion
  else if (component === 'bepinex') candidate.bepInEx = targetVersion
  else {
    const sourceId = component === 'bridge' ? 'thunderstore:DysonControl/Bridge' : 'thunderstore:DysonControl/Control'
    candidate.plugins = candidate.plugins.filter((plugin) => plugin.sourceId.toLowerCase() !== sourceId.toLowerCase())
    candidate.plugins.push({ sourceId, version: targetVersion })
  }
  const compatibilityReceiptId = randomUUID()
  compatibilityFixtures.set(compatibilityReceiptId, {
    inventory: structuredClone(inventory),
    candidate,
    compatible: true
  })
  return {
    requestId: randomUUID(),
    component,
    artifactId: staged.artifactId,
    sha256: staged.sha256,
    targetVersion,
    expectedRevision,
    compatibilityReceiptId
  }
}

function baseInventory(overrides: Partial<{ dsp: string; nebula: string; bepInEx: string; plugins: Array<{ sourceId: string; version: string }> }> = {}) {
  return {
    dsp: '0.10.33.26727',
    nebula: '0.9.0',
    bepInEx: '5.4.21',
    plugins: [] as Array<{ sourceId: string; version: string }>,
    ...overrides
  }
}

function createAdapters(options: {
  stopped?: boolean
  protectionValid?: boolean
  stoppedVerifier?: ComponentUpdateActivationAdapters['verifyStoppedState']
  smoke?: ComponentUpdateActivationAdapters['smoke']
} = {}) {
  const stopPhases: string[] = []
  const smokeCalls: string[] = []
  let protectionCalls = 0
  const adapters: ComponentUpdateActivationAdapters = {
    verifyStoppedState: async (request) => {
      stopPhases.push(request.phase)
      if (options.stoppedVerifier !== undefined) return await options.stoppedVerifier(request)
      return { processStopped: options.stopped ?? true, portClosed: options.stopped ?? true }
    },
    createSaveProtectionPoint: async (request) => {
      protectionCalls++
      if (options.protectionValid === false) return { requestId: request.requestId, status: 'succeeded', backupId: 'bad' } as never
      return {
        requestId: request.requestId,
        status: 'succeeded',
        backupId: `backup-${request.requestId}`,
        pairProtected: true,
        durable: true
      }
    },
    smoke: async (request) => {
      smokeCalls.push(request.phase)
      return options.smoke === undefined ? smokeResult(request, true) : await options.smoke(request)
    }
  }
  return {
    adapters,
    stopPhases,
    smokeCalls,
    get protectionCalls() { return protectionCalls }
  }
}

function smokeResult(request: FixedUpdateSmokeRequest, healthy: boolean) {
  return {
    component: request.component,
    observedVersion: request.expectedVersion,
    versionMatches: healthy,
    bepInExLoaded: healthy,
    nebulaLoaded: healthy,
    processHealthy: healthy,
    portHealthy: healthy
  }
}

function createService(
  fixture: Fixture,
  adapters: ComponentUpdateActivationAdapters,
  limits: Partial<{ maximumArchiveBytes: number; maximumFileBytes: number; maximumExpandedBytes: number; maximumFiles: number; maximumHistoryEntries: number }> = {}
): ComponentUpdateActivationService {
  return new ComponentUpdateActivationService({
    projectRoot: fixture.projectRoot,
    stagingRoot: fixture.stagingRoot,
    liveComponentRoots: liveComponentRoots(fixture),
    compatibilityVerifier: createCompatibilityVerifier(),
    now: () => new Date('2026-08-30T12:00:00.000Z'),
    ...adapters,
    ...limits
  })
}

function createCompatibilityVerifier() {
  return {
    assertCurrent: async (receiptId: unknown, candidateInput: unknown): Promise<TrustedCompatibilityAssertion> => {
      if (typeof receiptId !== 'string') throw new Error('missing compatibility receipt')
      const fixture = compatibilityFixtures.get(receiptId)
      if (!fixture) throw new Error('unknown compatibility receipt')
      const candidate = candidateInput as { component: ManagedUpdateComponent; artifactId: string; sha256: string; targetVersion: string }
      return {
        receipt: {
          format: 'dyson-control-trusted-compatibility-receipt', schemaVersion: 1,
          receiptId, component: candidate.component, artifactId: candidate.artifactId,
          artifactSha256: candidate.sha256, targetVersion: candidate.targetVersion,
          inventoryRevision: '1'.repeat(64), policyId: 'test-policy', policyRevision: '2'.repeat(64),
          matchedEntryId: fixture.compatible ? 'candidate' : null, compatible: fixture.compatible,
          issuedAt: '2026-08-30T11:59:00.000Z', expiresAt: '2026-08-30T12:10:00.000Z', reused: false
        },
        runtimeInventory: fixture.inventory,
        decision: {
          compatible: fixture.compatible,
          matchedEntryId: fixture.compatible ? 'candidate' : null,
          inventory: fixture.candidate,
          evaluations: [{
            entryId: 'candidate', compatible: fixture.compatible,
            reasons: fixture.compatible ? [] : [{
              code: 'nebula-version-mismatch', component: 'nebula', sourceId: null,
              expected: '=0.9.9', actual: candidate.targetVersion
            }]
          }]
        }
      }
    }
  }
}

function liveComponentRoots(fixture: Fixture) {
  return { nebula: fixture.liveRoot, bepinex: fixture.liveRoot, bridge: fixture.liveRoot, control: fixture.liveRoot }
}

function buildZip(files: Payload[]): Buffer {
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

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate)
    return true
  } catch (error) {
    return false
  }
}

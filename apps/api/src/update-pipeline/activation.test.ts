import { ControlDatabase } from '../storage/database.js'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { hostname, tmpdir, uptime } from 'node:os'
import { deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { HostMutationLeaseError } from '../host-mutation/lease.js'
import { FileOperatorRollbackStore } from './operator-rollback-store.js'
import {
  HostMutationOperationCoordinatorError,
  type HostMutationDisposition,
  type HostMutationOperationCoordinator,
  type HostMutationOperationOutcome,
  type HostMutationOperationRequest,
  type HostMutationOperationScope,
  type HostMutationRecoveryOperationCoordinator,
  type HostMutationRecoveryOperationRequest
} from '../host-mutation/operation-coordinator.js'
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
  it('refuses operator recovery when restored live bytes changed after the checkpoint', async () => {
    const fixture = await createFixture()
    let failConfiguration = false
    const controlled = createAdapters({ restoreConfiguration: async () => {
      if (failConfiguration) throw new Error('injected configuration interruption')
      return { restored: true, rereadVerified: true }
    } })
    const recovery = new TestHostMutationRecoveryCoordinator()
    const service = createService(fixture, controlled.adapters, { hostMutationRecoveryCoordinator: recovery })
    const firstStage = await stageComponent(fixture.stagingRoot, defaultStage())
    const first = await service.execute(makeRequest('nebula', '0.9.1', firstStage, initialComponentUpdateRevision))
    const secondStage = await stageComponent(fixture.stagingRoot, defaultStage({ targetVersion: '0.9.2',
      artifactId: 'nebula-recovery-readback-test', payloads: [{
        name: 'plugins/nebula-NebulaMultiplayerMod/Nebula.dll', bytes: Buffer.from('newer-nebula')
      }] }))
    const source = makeRequest('nebula', '0.9.2', secondStage, first.resultingRevision, baseInventory({ nebula: '0.9.1' }))
    const installed = await service.execute(source)
    const request = { requestId: randomUUID(), sourceRequestId: source.requestId, expectedRevision: installed.resultingRevision }
    const plan = await service.previewRollback(request)
    const input = { ...request, expectedPlanSha256: plan.planSha256 }
    failConfiguration = true
    await expect(service.executeRollback(input)).rejects.toBeDefined()
    const live = path.join(liveComponentRoots(fixture).nebula, 'plugins/nebula-NebulaMultiplayerMod/Nebula.dll')
    await writeFile(live, 'foreign-edit')
    failConfiguration = false
    await expect(createService(fixture, controlled.adapters, { hostMutationRecoveryCoordinator: recovery }).recoverRollback(input))
      .rejects.toMatchObject({ code: 'UPDATE_LIVE_TARGET_CHANGED' })
    expect(await readFile(live, 'utf8')).toBe('foreign-edit')
    expect(recovery.requests.at(-1)).toEqual({ expectedOperation: 'component-update-rollback', expectedRequestId: request.requestId })
    await expect(service.getState()).resolves.toMatchObject({ recoveryRequired: true })
  })

  it('coordinates committed rollback with protection, environment restoration, health and durable state', async () => {
    const fixture = await createFixture()
    const controlled = createAdapters()
    const service = createService(fixture, controlled.adapters, {
      hostMutationRecoveryCoordinator: new TestHostMutationRecoveryCoordinator()
    })
    const firstStage = await stageComponent(fixture.stagingRoot, defaultStage())
    const first = await service.execute(makeRequest('nebula', '0.9.1', firstStage, initialComponentUpdateRevision))
    const secondStage = await stageComponent(fixture.stagingRoot, defaultStage({ targetVersion: '0.9.2',
      artifactId: 'nebula-artifact-full-rollback', payloads: [{
        name: 'plugins/nebula-NebulaMultiplayerMod/Nebula.dll', bytes: Buffer.from('newer-nebula')
      }] }))
    const source = makeRequest('nebula', '0.9.2', secondStage, first.resultingRevision, baseInventory({ nebula: '0.9.1' }))
    const installed = await service.execute(source)
    const request = { requestId: randomUUID(), sourceRequestId: source.requestId, expectedRevision: installed.resultingRevision }
    const plan = await service.previewRollback(request)
    const protections = controlled.protectionCalls
    const previousRollbackCalls = controlled.rollbackCalls.length
    const receipt = await service.executeRollback({ ...request, expectedPlanSha256: plan.planSha256 })
    expect(receipt).toMatchObject({ status: 'succeeded', recoveryRequired: false, sourceRequestId: source.requestId,
      resultingRevision: first.resultingRevision })
    expect(controlled.protectionCalls).toBe(protections + 1)
    expect(controlled.rollbackCalls.slice(previousRollbackCalls)).toEqual(['configuration', 'server-mod-lock', 'paired-save', 'readback'])
    expect(controlled.smokeCalls.at(-1)).toBe('rollback')
    expect(await service.getState()).toMatchObject({ revision: first.resultingRevision, recoveryRequired: false })
    expect((await service.getReceipt(source.requestId))?.status).toBe('succeeded')
    const repeated = await service.executeRollback({ ...request, expectedPlanSha256: plan.planSha256 })
    expect(repeated).toEqual(receipt)
    expect(controlled.protectionCalls).toBe(protections + 1)
  })

  it('previews rollback only for the current successful transaction without mutation', async () => {
    const fixture = await createFixture()
    const controlled = createAdapters()
    const service = createService(fixture, controlled.adapters, { hostMutationCoordinator: new TestHostMutationCoordinator() })
    const firstStage = await stageComponent(fixture.stagingRoot, defaultStage())
    const firstRequest = makeRequest('nebula', '0.9.1', firstStage, initialComponentUpdateRevision)
    const first = await service.execute(firstRequest)
    const secondStage = await stageComponent(fixture.stagingRoot, defaultStage({
      targetVersion: '0.9.2', artifactId: 'nebula-artifact-rollback-2',
      payloads: [{ name: 'plugins/nebula-NebulaMultiplayerMod/Nebula.dll', bytes: Buffer.from('new-nebula') }]
    }))
    const secondRequest = makeRequest('nebula', '0.9.2', secondStage, first.resultingRevision, baseInventory({ nebula: '0.9.1' }))
    const second = await service.execute(secondRequest)
    const protectionCalls = controlled.protectionCalls
    const request = { requestId: randomUUID(), sourceRequestId: secondRequest.requestId,
      expectedRevision: second.resultingRevision }
    await expect(service.previewRollback(request)).resolves.toMatchObject({
      dryRun: true, component: 'nebula', targetVersion: '0.9.1', restoreFileCount: 1,
      materialSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      currentConfigurationRevision: '1'.repeat(64),
      planSha256: expect.stringMatching(/^[0-9a-f]{64}$/)
    })
    expect(controlled.protectionCalls).toBe(protectionCalls)
    await expect(service.previewRollback({ ...request, sourceRequestId: firstRequest.requestId }))
      .rejects.toMatchObject({ code: 'UPDATE_ROLLBACK_SOURCE_NOT_CURRENT' })
    await expect(service.previewRollback({ ...request, expectedRevision: first.resultingRevision }))
      .rejects.toMatchObject({ code: 'UPDATE_REVISION_CONFLICT' })
    const plan = await service.previewRollback(request)
    const store = new FileOperatorRollbackStore(path.join(fixture.projectRoot, '.dyson-control-updates', 'operator-rollbacks'))
    await store.begin({ request: { ...request, expectedPlanSha256: plan.planSha256 }, plan,
      phase: 'prepared', protection: null, resultingRevision: null }, {
      signal: new AbortController().signal, assertActive() {}, toPowerShellBorrowArguments: () => []
    })
    await expect(service.getState()).resolves.toMatchObject({ recoveryRequired: true })
    await expect(service.execute(secondRequest)).rejects.toMatchObject({ code: 'UPDATE_OPERATOR_ROLLBACK_RECOVERY_REQUIRED' })
    await expect(service.reconcile()).rejects.toMatchObject({ code: 'UPDATE_OPERATOR_ROLLBACK_RECOVERY_REQUIRED' })
    await expect(service.previewCleanup()).rejects.toMatchObject({ code: 'UPDATE_OPERATOR_ROLLBACK_RECOVERY_REQUIRED' })
    await expect(service.recoverInterrupted(secondRequest.requestId))
      .rejects.toMatchObject({ code: 'UPDATE_OPERATOR_ROLLBACK_RECOVERY_REQUIRED' })
  })

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
    const coordinator = new TestHostMutationCoordinator()
    const service = createService(fixture, controlled.adapters, { hostMutationCoordinator: coordinator })
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
    expect(coordinator.assertActiveCalls).toBeGreaterThanOrEqual(15)
    expect(coordinator.dispositions).toEqual(['release'])
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

  it('rolls back a first managed update to the captured existing component version', async () => {
    const fixture = await createFixture()
    const oldCore = path.join(fixture.liveRoot, 'BepInEx', 'core', 'BepInEx.dll')
    await mkdir(path.dirname(oldCore), { recursive: true })
    await writeFile(oldCore, 'previous-unmanaged-bepinex')
    const candidate = await stageComponent(fixture.stagingRoot, {
      component: 'bepinex', targetVersion: '5.4.23.2', sourceId: 'github:BepInEx/BepInEx',
      stageKind: 'bepinex', artifactId: 'bepinex-unmanaged-rollback', payloads: makeBepInExPayloads('5.4.23.2')
    })
    const observedRollbackVersions: Array<string | null> = []
    const controlled = createAdapters({ baseline: async () => ({
      previousComponentVersion: '5.4.17.0', configurationSnapshotId: 'config-snapshot-fixture',
      configurationRevision: '1'.repeat(64), serverModLockSha256: '2'.repeat(64),
      serverModLockRevision: '3'.repeat(64), previousLoadedSaveIdentity: 'c'.repeat(64)
    }), smoke: async request => {
      if (request.phase === 'rollback') {
        observedRollbackVersions.push(request.expectedVersion)
        expect(request.expectedReleaseId).toBeNull()
        return { ...smokeResult(request, true), observedVersion: '5.4.17.0', versionMatches: request.expectedVersion === '5.4.17.0' }
      }
      return smokeResult(request, false)
    } })
    const service = createService(fixture, controlled.adapters)
    const result = await service.execute(makeRequest('bepinex', '5.4.23.2', candidate, initialComponentUpdateRevision))
    expect(result).toMatchObject({ status: 'rolled-back', rollbackVerified: true, recoveryRequired: false })
    expect(observedRollbackVersions).toEqual(['5.4.17.0'])
    expect(await readFile(oldCore, 'utf8')).toBe('previous-unmanaged-bepinex')
  })

  it('rejects predecessor version drift before protecting or replacing an already managed component', async () => {
    const fixture = await createFixture()
    let previousComponentVersion: string | null = null
    const controlled = createAdapters({ baseline: async () => ({
      previousComponentVersion, configurationSnapshotId: 'config-snapshot-fixture',
      configurationRevision: '1'.repeat(64), serverModLockSha256: '2'.repeat(64),
      serverModLockRevision: '3'.repeat(64), previousLoadedSaveIdentity: 'c'.repeat(64)
    }) })
    const service = createService(fixture, controlled.adapters)
    const old = await stageComponent(fixture.stagingRoot, defaultStage({ artifactId: 'nebula-baseline-drift-old' }))
    const installed = await service.execute(makeRequest('nebula', '0.9.1', old, initialComponentUpdateRevision))
    previousComponentVersion = '0.8.0'
    const candidate = await stageComponent(fixture.stagingRoot, defaultStage({ artifactId: 'nebula-baseline-drift-new', targetVersion: '0.9.2' }))
    await expect(service.execute(makeRequest('nebula', '0.9.2', candidate, installed.resultingRevision,
      baseInventory({ nebula: '0.9.1' })))).rejects.toMatchObject({ code: 'UPDATE_PREVIOUS_COMPONENT_VERSION_MISMATCH' })
    expect(controlled.protectionCalls).toBe(1)
    expect(await readFile(path.join(fixture.liveRoot, 'plugins', 'nebula-NebulaMultiplayerMod', 'Nebula.dll'), 'utf8')).toBe('nebula')
  })

  it('binds rollback to config, mod-lock, protection manifest and exact save then restores and rereads each surface', async () => {
    const fixture = await createFixture()
    const old = await stageComponent(fixture.stagingRoot, defaultStage({
      artifactId: 'nebula-artifact-rollback-old', targetVersion: '0.9.1'
    }))
    const candidate = await stageComponent(fixture.stagingRoot, defaultStage({
      artifactId: 'nebula-artifact-rollback-new', targetVersion: '0.9.2',
      payloads: [{
        name: 'plugins/nebula-NebulaMultiplayerMod/Nebula.dll',
        bytes: Buffer.from('candidate-nebula')
      }]
    }))
    const controlled = createAdapters({
      smoke: async (request) => smokeResult(
        request,
        !(request.phase === 'candidate' && request.expectedVersion === '0.9.2')
      )
    })
    const service = createService(fixture, controlled.adapters)
    const installed = await service.execute(makeRequest(
      'nebula', '0.9.1', old, initialComponentUpdateRevision
    ))
    const rolledBack = await service.execute(makeRequest(
      'nebula', '0.9.2', candidate, installed.resultingRevision,
      baseInventory({ nebula: '0.9.1' })
    ))

    expect(rolledBack).toMatchObject({
      status: 'rolled-back', rollbackVerified: true, recoveryRequired: false,
      rollbackBindingSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      rollbackSteps: {
        component: 'verified', configuration: 'verified', serverModLock: 'verified',
        pairedSave: 'verified', previousSaveLoad: 'verified'
      }
    })
    expect(controlled.rollbackCalls.slice(-6)).toEqual([
      'configuration', 'readback', 'server-mod-lock', 'readback', 'paired-save', 'readback'
    ])
    const journal = JSON.parse(await readFile(path.join(
      fixture.projectRoot, '.dyson-control-updates', 'transactions', `${rolledBack.requestId}.json`
    ), 'utf8')) as { transaction: { rollback: Record<string, unknown> } }
    expect(journal.transaction.rollback).toMatchObject({
      configurationSnapshotId: 'config-snapshot-fixture',
      configurationRevision: '1'.repeat(64),
      serverModLockSha256: '2'.repeat(64),
      serverModLockRevision: '3'.repeat(64),
      protectionManifestSha256: 'd'.repeat(64),
      previousLoadedSaveIdentity: 'c'.repeat(64),
      bindingSha256: rolledBack.rollbackBindingSha256
    })
  })

  it('fails rollback closed when any non-component restoration cannot be executed or reread', async () => {
    const fixture = await createFixture()
    const old = await stageComponent(fixture.stagingRoot, defaultStage({
      artifactId: 'nebula-artifact-config-old', targetVersion: '0.9.1'
    }))
    const candidate = await stageComponent(fixture.stagingRoot, defaultStage({
      artifactId: 'nebula-artifact-config-new', targetVersion: '0.9.2'
    }))
    const controlled = createAdapters({
      smoke: async (request) => smokeResult(
        request,
        !(request.phase === 'candidate' && request.expectedVersion === '0.9.2')
      ),
      restoreConfiguration: async () => { throw new Error('fixture restore unavailable') }
    })
    const service = createService(fixture, controlled.adapters)
    const installed = await service.execute(makeRequest(
      'nebula', '0.9.1', old, initialComponentUpdateRevision
    ))
    const failed = await service.execute(makeRequest(
      'nebula', '0.9.2', candidate, installed.resultingRevision,
      baseInventory({ nebula: '0.9.1' })
    ))

    expect(failed).toMatchObject({
      status: 'rollback-failed', rollbackVerified: false, recoveryRequired: true,
      failureCode: 'UPDATE_ROLLBACK_CONFIGURATION_FAILED',
      rollbackSteps: {
        component: 'verified', configuration: 'failed', serverModLock: 'pending',
        pairedSave: 'pending', previousSaveLoad: 'pending'
      }
    })
    expect((await service.getState()).recoveryRequired).toBe(true)
    expect(controlled.rollbackCalls.slice(-1)).toEqual(['configuration'])
  })

  it('rejects old-version process/port health when the current startup generation lacks the exact previous save load', async () => {
    const fixture = await createFixture()
    const old = await stageComponent(fixture.stagingRoot, defaultStage({
      artifactId: 'nebula-artifact-save-old', targetVersion: '0.9.1'
    }))
    const candidate = await stageComponent(fixture.stagingRoot, defaultStage({
      artifactId: 'nebula-artifact-save-new', targetVersion: '0.9.2'
    }))
    const controlled = createAdapters({
      smoke: async (request) => {
        const healthy = smokeResult(request, true)
        if (request.phase === 'candidate' && request.expectedVersion === '0.9.2') {
          return smokeResult(request, false)
        }
        if (request.phase === 'rollback') {
          return { ...healthy, loadedSaveIdentity: 'f'.repeat(64) }
        }
        return healthy
      }
    })
    const service = createService(fixture, controlled.adapters)
    const installed = await service.execute(makeRequest(
      'nebula', '0.9.1', old, initialComponentUpdateRevision
    ))
    const failed = await service.execute(makeRequest(
      'nebula', '0.9.2', candidate, installed.resultingRevision,
      baseInventory({ nebula: '0.9.1' })
    ))

    expect(failed).toMatchObject({
      status: 'rollback-failed', rollbackVerified: false, recoveryRequired: true,
      failureCode: 'UPDATE_ROLLBACK_SMOKE_FAILED',
      rollbackSteps: { previousSaveLoad: 'failed' }
    })
  })

  it('rejects execution before protection or publication when rollback adapters are not wired', async () => {
    const fixture = await createFixture()
    const staged = await stageComponent(fixture.stagingRoot, defaultStage())
    const controlled = createAdapters()
    const {
      captureRollbackBaseline: _capture,
      restoreRollbackConfiguration: _config,
      restoreRollbackServerModLock: _lock,
      restoreRollbackPairedSave: _save,
      inspectRollbackReadback: _readback,
      ...legacyAdapters
    } = controlled.adapters
    const service = createService(fixture, legacyAdapters)

    await expect(service.execute(makeRequest(
      'nebula', '0.9.1', staged, initialComponentUpdateRevision
    ))).rejects.toMatchObject({ code: 'UPDATE_ROLLBACK_CAPABILITY_UNAVAILABLE' })
    expect(controlled.protectionCalls).toBe(0)
    expect(await pathExists(path.join(
      fixture.liveRoot, 'plugins', 'nebula-NebulaMultiplayerMod', 'Nebula.dll'
    ))).toBe(false)
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

  it('keeps read-only preview available but fails execute and reconcile closed without the shared host lease coordinator', async () => {
    const fixture = await createFixture()
    const staged = await stageComponent(fixture.stagingRoot, defaultStage())
    const request = makeRequest('nebula', '0.9.1', staged, initialComponentUpdateRevision)
    const service = new ComponentUpdateActivationService({
      projectRoot: fixture.projectRoot,
      stagingRoot: fixture.stagingRoot,
      liveComponentRoots: liveComponentRoots(fixture),
      compatibilityVerifier: createCompatibilityVerifier(),
      ...createAdapters().adapters
    })

    await expect(service.preview(request)).resolves.toMatchObject({ dryRun: true })
    await expect(service.execute(request)).rejects.toMatchObject({ code: 'UPDATE_HOST_LEASE_UNAVAILABLE' })
    await expect(service.reconcile()).rejects.toMatchObject({ code: 'UPDATE_HOST_LEASE_UNAVAILABLE' })
  })

  it('acquires the local activation lock before the host lease and releases the lease for a safe preflight rejection', async () => {
    const fixture = await createFixture()
    const staged = await stageComponent(fixture.stagingRoot, defaultStage())
    const coordinator = new TestHostMutationCoordinator()
    const lockPath = path.join(fixture.projectRoot, '.dyson-control-updates', '.locks', 'activation.lock')
    coordinator.onEnter = async () => {
      expect((await lstat(lockPath)).isFile()).toBe(true)
    }
    const request = makeRequest('nebula', '0.9.1', staged, 'f'.repeat(64))

    await expect(createService(fixture, createAdapters().adapters, { hostMutationCoordinator: coordinator }).execute(request))
      .rejects.toMatchObject({ code: 'UPDATE_REVISION_CONFLICT' })
    expect(coordinator.requests).toEqual([{
      operation: 'component-update-activation',
      requestId: request.requestId
    }])
    expect(coordinator.dispositions).toEqual(['release'])
  })

  it('forwards the active lease signal and borrow arguments to every lifecycle adapter call', async () => {
    const fixture = await createFixture()
    const staged = await stageComponent(fixture.stagingRoot, defaultStage())
    const coordinator = new TestHostMutationCoordinator()
    const observedScopes: HostMutationOperationScope[] = []
    const controlled = createAdapters({
      stoppedVerifier: async (_request, hostMutation) => {
        observedScopes.push(hostMutation)
        return { processStopped: true, portClosed: true }
      },
      protection: async (request, hostMutation) => {
        observedScopes.push(hostMutation)
        return {
          requestId: request.requestId,
          status: 'succeeded',
          backupId: `backup-${request.requestId}`,
          manifestSha256: 'd'.repeat(64),
          saveIdentity: 'c'.repeat(64),
          pairProtected: true,
          durable: true
        }
      },
      smoke: async (request, hostMutation) => {
        observedScopes.push(hostMutation)
        return smokeResult(request, true)
      }
    })

    await expect(createService(fixture, controlled.adapters, { hostMutationCoordinator: coordinator }).execute(
      makeRequest('nebula', '0.9.1', staged, initialComponentUpdateRevision)
    )).resolves.toMatchObject({ status: 'succeeded' })
    expect(observedScopes.length).toBeGreaterThanOrEqual(6)
    for (const scope of observedScopes) {
      expect(scope.signal).toBe(coordinator.controller.signal)
      expect(scope.toPowerShellBorrowArguments()).toEqual(coordinator.borrowArguments)
    }
  })

  it('maps an adapter cancellation wrapper to host lease lost when the shared signal is aborted', async () => {
    const fixture = await createFixture()
    const staged = await stageComponent(fixture.stagingRoot, defaultStage())
    const coordinator = new TestHostMutationCoordinator()
    const controlled = createAdapters({
      stoppedVerifier: async (_request, hostMutation) => {
        expect(hostMutation.signal).toBe(coordinator.controller.signal)
        coordinator.controller.abort()
        throw new Error('adapter wrapped cancellation')
      }
    })

    await expect(createService(fixture, controlled.adapters, { hostMutationCoordinator: coordinator }).execute(
      makeRequest('nebula', '0.9.1', staged, initialComponentUpdateRevision)
    )).rejects.toMatchObject({ code: 'UPDATE_HOST_LEASE_LOST' })
    expect(controlled.protectionCalls).toBe(0)
    expect(coordinator.abandoned).toBe(true)
  })

  it('stops before smoke and abandons when the lease is lost immediately after live publish', async () => {
    const fixture = await createFixture()
    const staged = await stageComponent(fixture.stagingRoot, defaultStage())
    const coordinator = new TestHostMutationCoordinator()
    const controlled = createAdapters()
    let assertionsAfterFinalStopProof = 0
    coordinator.onAssertActive = () => {
      if (controlled.stopPhases.length === 4 && ++assertionsAfterFinalStopProof === 2) {
        throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_LOST')
      }
    }

    await expect(createService(fixture, controlled.adapters, { hostMutationCoordinator: coordinator }).execute(
      makeRequest('nebula', '0.9.1', staged, initialComponentUpdateRevision)
    )).rejects.toMatchObject({ code: 'UPDATE_HOST_LEASE_LOST' })
    expect(controlled.smokeCalls).toEqual([])
    expect(coordinator.abandoned).toBe(true)
  })

  it.each([
    ['HOST_MUTATION_LEASE_BUSY', 'UPDATE_HOST_LEASE_BUSY'],
    ['HOST_MUTATION_LEASE_DIRTY', 'UPDATE_HOST_LEASE_DIRTY'],
    ['HOST_MUTATION_LEASE_RECOVERY_REQUIRED', 'UPDATE_HOST_LEASE_RECOVERY_REQUIRED'],
    ['HOST_MUTATION_LEASE_LOST', 'UPDATE_HOST_LEASE_LOST'],
    ['HOST_MUTATION_LEASE_UNAVAILABLE', 'UPDATE_HOST_LEASE_UNAVAILABLE']
  ] as const)('maps host coordinator failure %s to %s without entering adapters', async (hostCode, updateCode) => {
    const fixture = await createFixture()
    const staged = await stageComponent(fixture.stagingRoot, defaultStage())
    const controlled = createAdapters()
    const coordinator = new TestHostMutationCoordinator()
    coordinator.acquireError = new HostMutationOperationCoordinatorError(hostCode)

    await expect(createService(fixture, controlled.adapters, { hostMutationCoordinator: coordinator }).execute(
      makeRequest('nebula', '0.9.1', staged, initialComponentUpdateRevision)
    )).rejects.toMatchObject({ code: updateCode })
    expect(controlled.stopPhases).toEqual([])
    expect(controlled.protectionCalls).toBe(0)
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
    const recoveryCoordinator = new TestHostMutationCoordinator()
    const recoveryService = createService(recoveryFixture, recoveryAdapters.adapters, {
      hostMutationCoordinator: recoveryCoordinator
    })
    const installed = await recoveryService.execute(makeRequest('nebula', '0.9.1', recoveryV1, initialComponentUpdateRevision))
    const failed = await recoveryService.execute(makeRequest(
      'nebula', '0.9.2', recoveryV2, installed.resultingRevision, baseInventory({ nebula: '0.9.1' })
    ))
    expect(failed).toMatchObject({ status: 'rollback-failed', recoveryRequired: true, rollbackVerified: false })
    expect(recoveryCoordinator.dispositions.at(-1)).toBe('abandon')
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

    const reconciliationCoordinator = new TestHostMutationCoordinator()
    const restarted = createService(fixture, controlled.adapters, {
      hostMutationCoordinator: reconciliationCoordinator
    })
    const reconciled = await restarted.reconcile()
    expect(reconciled).toMatchObject({ requestId: request.requestId, status: 'succeeded' })
    expect(controlled.protectionCalls).toBe(1)
    expect(controlled.smokeCalls).toContain('reconcile-candidate')
    expect(reconciliationCoordinator.requests).toHaveLength(1)
    expect(reconciliationCoordinator.requests[0]).toMatchObject({
      operation: 'component-update-reconciliation'
    })
    expect(reconciliationCoordinator.requests[0]).not.toHaveProperty('recovery')
    expect(reconciliationCoordinator.dispositions).toEqual(['release'])
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
    const coordinator = new TestHostMutationCoordinator()
    const request = makeRequest('nebula', '0.9.1', staged, initialComponentUpdateRevision)

    await expect(createService(fixture, controlled.adapters, { hostMutationCoordinator: coordinator }).execute(request))
      .rejects.toMatchObject({ code: 'UPDATE_ACTIVE_SWITCH_FAILED' })
    expect(coordinator.dispositions).toEqual(['abandon'])
    expect(await readFile(liveFile, 'utf8')).toBe('candidate-nebula')
    await rm(path.join(fixture.projectRoot, '.dyson-control-updates', 'active.json'), { recursive: true })

    const recovered = await createService(fixture, controlled.adapters).reconcile()
    expect(recovered).toMatchObject({ status: 'rolled-back', rollbackVerified: true, failureCode: 'UPDATE_INTERRUPTED' })
    expect(await readFile(liveFile, 'utf8')).toBe('previous-nebula')
  })

  it('proves the exact interrupted request before touching the recovery broker and fails closed without it', async () => {
    const emptyFixture = await createFixture()
    const emptyRecoveryCoordinator = new TestHostMutationRecoveryCoordinator()
    await expect(createService(emptyFixture, createAdapters().adapters, {
      hostMutationCoordinator: new TestHostMutationCoordinator(),
      hostMutationRecoveryCoordinator: emptyRecoveryCoordinator
    }).recoverInterrupted(randomUUID())).rejects.toMatchObject({
      code: 'UPDATE_RECOVERY_NOT_PENDING'
    })
    expect(emptyRecoveryCoordinator.requests).toEqual([])

    const interrupted = await prepareInterruptedActivation()
    const recoveryCoordinator = new TestHostMutationRecoveryCoordinator()
    const service = createService(interrupted.fixture, interrupted.controlled.adapters, {
      hostMutationCoordinator: new TestHostMutationCoordinator(),
      hostMutationRecoveryCoordinator: recoveryCoordinator
    })

    await expect(service.recoverInterrupted(randomUUID())).rejects.toMatchObject({
      code: 'UPDATE_RECOVERY_REQUEST_MISMATCH'
    })
    expect(recoveryCoordinator.requests).toEqual([])

    const withoutRecoveryCapability = createService(
      interrupted.fixture,
      interrupted.controlled.adapters,
      { hostMutationCoordinator: new TestHostMutationCoordinator() }
    )
    await expect(withoutRecoveryCapability.recoverInterrupted(interrupted.request.requestId))
      .rejects.toMatchObject({ code: 'UPDATE_HOST_LEASE_UNAVAILABLE' })
    expect(recoveryCoordinator.requests).toEqual([])
  })

  it('keeps ordinary restart reconciliation on the ordinary lease path', async () => {
    const interrupted = await prepareInterruptedActivation()
    const ordinaryCoordinator = new TestHostMutationCoordinator()
    ordinaryCoordinator.acquireError = new HostMutationOperationCoordinatorError(
      'HOST_MUTATION_LEASE_RECOVERY_REQUIRED'
    )
    const recoveryCoordinator = new TestHostMutationRecoveryCoordinator()
    const service = createService(interrupted.fixture, interrupted.controlled.adapters, {
      hostMutationCoordinator: ordinaryCoordinator,
      hostMutationRecoveryCoordinator: recoveryCoordinator
    })

    await expect(service.reconcile()).rejects.toMatchObject({
      code: 'UPDATE_HOST_LEASE_RECOVERY_REQUIRED'
    })
    expect(ordinaryCoordinator.requests).toHaveLength(1)
    expect(ordinaryCoordinator.requests[0]).toMatchObject({
      operation: 'component-update-reconciliation'
    })
    expect(ordinaryCoordinator.requests[0]).not.toHaveProperty('recovery')
    expect(recoveryCoordinator.requests).toEqual([])
  })

  it('recovers one exact interrupted activation and replays its durable terminal receipt idempotently', async () => {
    const interrupted = await prepareInterruptedActivation()
    const recoveryCoordinator = new TestHostMutationRecoveryCoordinator()
    const ordinaryCoordinator = new TestHostMutationCoordinator()
    const service = createService(interrupted.fixture, interrupted.controlled.adapters, {
      hostMutationCoordinator: ordinaryCoordinator,
      hostMutationRecoveryCoordinator: recoveryCoordinator
    })

    const recovered = await service.recoverInterrupted(interrupted.request.requestId)
    expect(recovered).toMatchObject({
      requestId: interrupted.request.requestId,
      status: 'rolled-back',
      rollbackVerified: true,
      recoveryRequired: false,
      reused: false
    })
    expect(recoveryCoordinator.requests).toEqual([{
      expectedOperation: 'component-update-activation',
      expectedRequestId: interrupted.request.requestId
    }])
    expect(recoveryCoordinator.dispositions).toEqual(['release'])
    expect(ordinaryCoordinator.requests).toEqual([])
    expect((await service.getState()).recoveryRequired).toBe(false)
    expect(await readFile(interrupted.liveFile, 'utf8')).toBe('previous-nebula')

    await expect(service.recoverInterrupted(interrupted.request.requestId)).resolves.toMatchObject({
      status: 'rolled-back',
      reused: true,
      recoveryRequired: false
    })
    expect(recoveryCoordinator.requests).toHaveLength(2)
    expect(recoveryCoordinator.dispositions).toEqual(['release'])
  })

  it('abandons the recovery lease when durable evidence changes after acquisition', async () => {
    const interrupted = await prepareInterruptedActivation()
    const recoveryCoordinator = new TestHostMutationRecoveryCoordinator()
    recoveryCoordinator.onEnter = async () => {
      await writeFile(path.join(
        interrupted.fixture.projectRoot,
        '.dyson-control-updates',
        'transactions',
        `${interrupted.request.requestId}.json`
      ), '{}\n')
    }
    const service = createService(interrupted.fixture, interrupted.controlled.adapters, {
      hostMutationCoordinator: new TestHostMutationCoordinator(),
      hostMutationRecoveryCoordinator: recoveryCoordinator
    })

    await expect(service.recoverInterrupted(interrupted.request.requestId)).rejects.toMatchObject({
      code: 'UPDATE_JOURNAL_INVALID'
    })
    expect(recoveryCoordinator.requests).toEqual([{
      expectedOperation: 'component-update-activation',
      expectedRequestId: interrupted.request.requestId
    }])
    expect(recoveryCoordinator.dispositions).toEqual(['abandon'])
    expect(recoveryCoordinator.abandoned).toBe(true)
  })

  it('rejects a recovery receipt that is not fully bound to its journal before broker entry', async () => {
    const interrupted = await prepareInterruptedActivation()
    const firstCoordinator = new TestHostMutationRecoveryCoordinator()
    const failing = createService(interrupted.fixture, createAdapters({
      smoke: async (request) => smokeResult(request, false)
    }).adapters, {
      hostMutationCoordinator: new TestHostMutationCoordinator(),
      hostMutationRecoveryCoordinator: firstCoordinator
    })
    await expect(failing.recoverInterrupted(interrupted.request.requestId)).resolves.toMatchObject({
      status: 'rollback-failed',
      recoveryRequired: true
    })

    const receiptPath = path.join(
      interrupted.fixture.projectRoot,
      '.dyson-control-updates',
      'receipts',
      `${interrupted.request.requestId}.json`
    )
    const envelope = JSON.parse(await readFile(receiptPath, 'utf8')) as {
      receipt: { protectionBackupId: string }
    }
    envelope.receipt.protectionBackupId = 'unrelated-backup'
    await writeFile(receiptPath, `${JSON.stringify(envelope)}\n`)

    const recoveryCoordinator = new TestHostMutationRecoveryCoordinator()
    const service = createService(interrupted.fixture, createAdapters().adapters, {
      hostMutationCoordinator: new TestHostMutationCoordinator(),
      hostMutationRecoveryCoordinator: recoveryCoordinator
    })
    await expect(service.recoverInterrupted(interrupted.request.requestId)).rejects.toMatchObject({
      code: 'UPDATE_RECOVERY_EVIDENCE_INVALID'
    })
    expect(recoveryCoordinator.requests).toEqual([])
  })

  it('converges strict hard-exit history, journal, and partial-lock evidence only under recovery', async () => {
    const interrupted = await prepareInterruptedActivation()
    const controlRoot = path.join(interrupted.fixture.projectRoot, '.dyson-control-updates')
    const historyPath = path.join(controlRoot, 'history', `${interrupted.request.requestId}.json`)
    const journalPath = path.join(controlRoot, 'transactions', `${interrupted.request.requestId}.json`)
    const historyTemporary = `${historyPath}.${randomUUID()}.tmp`
    const journalTemporary = `${journalPath}.${randomUUID()}.tmp`
    await rename(historyPath, historyTemporary)
    await rename(journalPath, journalTemporary)
    const lockPath = path.join(controlRoot, '.locks', 'activation.lock')
    await writeFile(lockPath, '')

    const ordinaryCoordinator = new TestHostMutationCoordinator()
    const ordinary = createService(interrupted.fixture, interrupted.controlled.adapters, {
      hostMutationCoordinator: ordinaryCoordinator
    })
    await expect(ordinary.reconcile()).rejects.toMatchObject({
      code: 'UPDATE_ACTIVATION_LOCK_BUSY'
    })
    expect(await pathExists(lockPath)).toBe(true)
    expect(await pathExists(historyTemporary)).toBe(true)
    expect(await pathExists(journalTemporary)).toBe(true)
    expect(ordinaryCoordinator.requests).toEqual([])

    const recoveryCoordinator = new TestHostMutationRecoveryCoordinator()
    const recovery = createService(interrupted.fixture, interrupted.controlled.adapters, {
      hostMutationCoordinator: new TestHostMutationCoordinator(),
      hostMutationRecoveryCoordinator: recoveryCoordinator
    })
    await expect(recovery.recoverInterrupted(interrupted.request.requestId)).resolves.toMatchObject({
      status: 'rolled-back',
      recoveryRequired: false
    })
    expect(recoveryCoordinator.dispositions).toEqual(['release'])
    expect(await pathExists(lockPath)).toBe(false)
    expect(await pathExists(historyTemporary)).toBe(false)
    expect(await pathExists(journalTemporary)).toBe(false)
    expect(await pathExists(historyPath)).toBe(true)
    expect(await pathExists(journalPath)).toBe(true)
  })

  it('re-enters the exact recovery broker when a terminal receipt outlives broker release', async () => {
    const interrupted = await prepareInterruptedActivation()
    const firstCoordinator = new TestHostMutationRecoveryCoordinator()
    const first = createService(interrupted.fixture, interrupted.controlled.adapters, {
      hostMutationCoordinator: new TestHostMutationCoordinator(),
      hostMutationRecoveryCoordinator: firstCoordinator
    })
    await expect(first.recoverInterrupted(interrupted.request.requestId)).resolves.toMatchObject({
      status: 'rolled-back'
    })
    const liveBefore = await readFile(interrupted.liveFile, 'utf8')

    // A fresh pending coordinator models hard exit after the terminal recovery
    // receipt became durable but before the broker persisted release.
    const pendingCoordinator = new TestHostMutationRecoveryCoordinator()
    const retried = createService(interrupted.fixture, interrupted.controlled.adapters, {
      hostMutationCoordinator: new TestHostMutationCoordinator(),
      hostMutationRecoveryCoordinator: pendingCoordinator
    })
    await expect(retried.recoverInterrupted(interrupted.request.requestId)).resolves.toMatchObject({
      status: 'rolled-back',
      reused: true
    })
    expect(pendingCoordinator.requests).toEqual([{
      expectedOperation: 'component-update-activation',
      expectedRequestId: interrupted.request.requestId
    }])
    expect(pendingCoordinator.dispositions).toEqual(['release'])
    expect(await readFile(interrupted.liveFile, 'utf8')).toBe(liveBefore)
  })

  it('releases an exact abandoned broker binding after an ordinary succeeded receipt is durable', async () => {
    const fixture = await createFixture()
    const staged = await stageComponent(fixture.stagingRoot, defaultStage({
      artifactId: 'nebula-artifact-terminal-success',
      targetVersion: '0.9.1'
    }))
    const controlled = createAdapters()
    const request = makeRequest('nebula', '0.9.1', staged, initialComponentUpdateRevision)
    const receipt = await createService(fixture, controlled.adapters).execute(request)
    expect(receipt).toMatchObject({ status: 'succeeded', recoveryRequired: false })
    const liveFile = path.join(
      fixture.liveRoot,
      'plugins',
      'nebula-NebulaMultiplayerMod',
      'Nebula.dll'
    )
    const liveBefore = await readFile(liveFile, 'utf8')
    const stopPhasesBefore = [...controlled.stopPhases]
    const smokeCallsBefore = [...controlled.smokeCalls]
    const protectionCallsBefore = controlled.protectionCalls

    // A fresh pending coordinator models hard exit after the ordinary terminal
    // receipt became durable but before the broker persisted RELEASE.
    const recoveryCoordinator = new TestHostMutationRecoveryCoordinator()
    const restarted = createService(fixture, controlled.adapters, {
      hostMutationCoordinator: new TestHostMutationCoordinator(),
      hostMutationRecoveryCoordinator: recoveryCoordinator
    })
    await expect(restarted.recoverInterrupted(request.requestId)).resolves.toMatchObject({
      requestId: request.requestId,
      status: 'succeeded',
      reused: true
    })
    expect(recoveryCoordinator.requests).toEqual([{
      expectedOperation: 'component-update-activation',
      expectedRequestId: request.requestId
    }])
    expect(recoveryCoordinator.dispositions).toEqual(['release'])
    expect(await readFile(liveFile, 'utf8')).toBe(liveBefore)
    expect(controlled.stopPhases).toEqual(stopPhasesBefore)
    expect(controlled.smokeCalls).toEqual(smokeCallsBefore)
    expect(controlled.protectionCalls).toBe(protectionCallsBefore)
  })

  it('releases an exact abandoned broker binding after an ordinary rolled-back receipt is durable', async () => {
    const fixture = await createFixture()
    const v1 = await stageComponent(fixture.stagingRoot, defaultStage({
      artifactId: 'nebula-artifact-terminal-rollback-v1',
      targetVersion: '0.9.1'
    }))
    const v2 = await stageComponent(fixture.stagingRoot, defaultStage({
      artifactId: 'nebula-artifact-terminal-rollback-v2',
      targetVersion: '0.9.2',
      payloads: [{
        name: 'plugins/nebula-NebulaMultiplayerMod/Nebula.dll',
        bytes: Buffer.from('nebula-v2')
      }]
    }))
    const controlled = createAdapters({
      smoke: async (request) => request.phase === 'candidate' && request.expectedVersion === '0.9.2'
        ? smokeResult(request, false)
        : smokeResult(request, true)
    })
    const service = createService(fixture, controlled.adapters)
    const installed = await service.execute(makeRequest(
      'nebula', '0.9.1', v1, initialComponentUpdateRevision
    ))
    const request = makeRequest(
      'nebula', '0.9.2', v2, installed.resultingRevision, baseInventory({ nebula: '0.9.1' })
    )
    const receipt = await service.execute(request)
    expect(receipt).toMatchObject({ status: 'rolled-back', recoveryRequired: false })
    const liveFile = path.join(
      fixture.liveRoot,
      'plugins',
      'nebula-NebulaMultiplayerMod',
      'Nebula.dll'
    )
    const liveBefore = await readFile(liveFile, 'utf8')
    const stopPhasesBefore = [...controlled.stopPhases]
    const smokeCallsBefore = [...controlled.smokeCalls]
    const protectionCallsBefore = controlled.protectionCalls

    const recoveryCoordinator = new TestHostMutationRecoveryCoordinator()
    const restarted = createService(fixture, controlled.adapters, {
      hostMutationCoordinator: new TestHostMutationCoordinator(),
      hostMutationRecoveryCoordinator: recoveryCoordinator
    })
    await expect(restarted.recoverInterrupted(request.requestId)).resolves.toMatchObject({
      requestId: request.requestId,
      status: 'rolled-back',
      reused: true
    })
    expect(recoveryCoordinator.requests).toEqual([{
      expectedOperation: 'component-update-activation',
      expectedRequestId: request.requestId
    }])
    expect(recoveryCoordinator.dispositions).toEqual(['release'])
    expect(await readFile(liveFile, 'utf8')).toBe(liveBefore)
    expect(controlled.stopPhases).toEqual(stopPhasesBefore)
    expect(controlled.smokeCalls).toEqual(smokeCallsBefore)
    expect(controlled.protectionCalls).toBe(protectionCallsBefore)
  })

  it('replays an ordinary terminal only after the broker proves recovery is not required', async () => {
    const fixture = await createFixture()
    const staged = await stageComponent(fixture.stagingRoot, defaultStage({
      artifactId: 'nebula-artifact-terminal-clean-broker',
      targetVersion: '0.9.1'
    }))
    const controlled = createAdapters()
    const request = makeRequest('nebula', '0.9.1', staged, initialComponentUpdateRevision)
    await createService(fixture, controlled.adapters).execute(request)
    const recoveryCoordinator = new TestHostMutationRecoveryCoordinator()
    recoveryCoordinator.recoveryPending = false
    const restarted = createService(fixture, controlled.adapters, {
      hostMutationCoordinator: new TestHostMutationCoordinator(),
      hostMutationRecoveryCoordinator: recoveryCoordinator
    })

    await expect(restarted.recoverInterrupted(request.requestId)).resolves.toMatchObject({
      requestId: request.requestId,
      status: 'succeeded',
      reused: true
    })
    expect(recoveryCoordinator.requests).toEqual([{
      expectedOperation: 'component-update-activation',
      expectedRequestId: request.requestId
    }])
    expect(recoveryCoordinator.dispositions).toEqual([])
  })

  it('releases an exact abandoned broker binding for a proven pre-journal failed receipt', async () => {
    const fixture = await createFixture()
    const staged = await stageComponent(fixture.stagingRoot, defaultStage({
      artifactId: 'nebula-artifact-terminal-failed',
      targetVersion: '0.9.1'
    }))
    const controlled = createAdapters({ stopped: false })
    const request = makeRequest('nebula', '0.9.1', staged, initialComponentUpdateRevision)
    await expect(createService(fixture, controlled.adapters).execute(request)).rejects.toMatchObject({
      code: 'UPDATE_SERVICE_STILL_RUNNING',
      receipt: expect.objectContaining({ status: 'failed', recoveryRequired: false })
    })
    const stopPhasesBefore = [...controlled.stopPhases]
    const recoveryCoordinator = new TestHostMutationRecoveryCoordinator()
    const restarted = createService(fixture, controlled.adapters, {
      hostMutationCoordinator: new TestHostMutationCoordinator(),
      hostMutationRecoveryCoordinator: recoveryCoordinator
    })

    await expect(restarted.recoverInterrupted(request.requestId)).resolves.toMatchObject({
      requestId: request.requestId,
      status: 'failed',
      reused: true
    })
    expect(recoveryCoordinator.dispositions).toEqual(['release'])
    expect(controlled.stopPhases).toEqual(stopPhasesBefore)
  })

  it('never treats a terminal receipt persisted at lease loss as broker release', async () => {
    const interrupted = await prepareInterruptedActivation()
    const recoveryReceiptPath = path.join(
      interrupted.fixture.projectRoot,
      '.dyson-control-updates',
      'recovery-receipts',
      `${interrupted.request.requestId}.json`
    )
    const lostCoordinator = new TestHostMutationRecoveryCoordinator()
    lostCoordinator.onAssertActive = () => {
      if (existsSync(recoveryReceiptPath)) lostCoordinator.controller.abort()
    }
    const lost = createService(interrupted.fixture, interrupted.controlled.adapters, {
      hostMutationCoordinator: new TestHostMutationCoordinator(),
      hostMutationRecoveryCoordinator: lostCoordinator
    })
    await expect(lost.recoverInterrupted(interrupted.request.requestId)).rejects.toMatchObject({
      code: 'UPDATE_HOST_LEASE_LOST'
    })
    expect(await pathExists(recoveryReceiptPath)).toBe(true)
    expect(lostCoordinator.abandoned).toBe(true)
    expect(lostCoordinator.dispositions).toEqual([])

    const retryCoordinator = new TestHostMutationRecoveryCoordinator()
    const retry = createService(interrupted.fixture, interrupted.controlled.adapters, {
      hostMutationCoordinator: new TestHostMutationCoordinator(),
      hostMutationRecoveryCoordinator: retryCoordinator
    })
    await expect(retry.recoverInterrupted(interrupted.request.requestId)).resolves.toMatchObject({
      status: 'rolled-back',
      reused: true
    })
    expect(retryCoordinator.requests).toHaveLength(1)
    expect(retryCoordinator.dispositions).toEqual(['release'])
  })

  it('maps recovery lease loss without releasing the consumed recovery binding', async () => {
    const interrupted = await prepareInterruptedActivation()
    const recoveryCoordinator = new TestHostMutationRecoveryCoordinator()
    recoveryCoordinator.onEnter = () => recoveryCoordinator.controller.abort()
    const service = createService(interrupted.fixture, interrupted.controlled.adapters, {
      hostMutationCoordinator: new TestHostMutationCoordinator(),
      hostMutationRecoveryCoordinator: recoveryCoordinator
    })

    await expect(service.recoverInterrupted(interrupted.request.requestId)).rejects.toMatchObject({
      code: 'UPDATE_HOST_LEASE_LOST'
    })
    expect(recoveryCoordinator.requests).toHaveLength(1)
    expect(recoveryCoordinator.dispositions).toEqual([])
    expect(recoveryCoordinator.abandoned).toBe(true)
  })

  it('abandons a failed recovery and later appends a proven terminal receipt without overwriting evidence', async () => {
    const interrupted = await prepareInterruptedActivation()
    const failingAdapters = createAdapters({
      smoke: async (request) => smokeResult(request, false)
    })
    const firstRecoveryCoordinator = new TestHostMutationRecoveryCoordinator()
    const failingService = createService(interrupted.fixture, failingAdapters.adapters, {
      hostMutationCoordinator: new TestHostMutationCoordinator(),
      hostMutationRecoveryCoordinator: firstRecoveryCoordinator
    })

    const failed = await failingService.recoverInterrupted(interrupted.request.requestId)
    expect(failed).toMatchObject({
      status: 'rollback-failed',
      recoveryRequired: true,
      rollbackVerified: false
    })
    expect(firstRecoveryCoordinator.dispositions).toEqual(['abandon'])
    expect((await failingService.getState()).recoveryRequired).toBe(true)

    // Simulate a later recovery crash after restoring the durable previous
    // active state but before appending its terminal recovery receipt.
    const controlRoot = path.join(interrupted.fixture.projectRoot, '.dyson-control-updates')
    const history = JSON.parse(await readFile(
      path.join(controlRoot, 'history', `${interrupted.request.requestId}.json`),
      'utf8'
    )) as { state: unknown }
    await writeFile(path.join(controlRoot, 'active.json'), `${JSON.stringify(history.state)}\n`)

    const healthyRecoveryCoordinator = new TestHostMutationRecoveryCoordinator()
    const healthyService = createService(interrupted.fixture, createAdapters().adapters, {
      hostMutationCoordinator: new TestHostMutationCoordinator(),
      hostMutationRecoveryCoordinator: healthyRecoveryCoordinator
    })
    const recovered = await healthyService.recoverInterrupted(interrupted.request.requestId)
    expect(recovered).toMatchObject({
      status: 'rolled-back',
      recoveryRequired: false,
      rollbackVerified: true
    })
    expect(healthyRecoveryCoordinator.dispositions).toEqual(['release'])

    const original = JSON.parse(await readFile(
      path.join(controlRoot, 'receipts', `${interrupted.request.requestId}.json`),
      'utf8'
    )) as { receipt: { status: string; recoveryRequired: boolean } }
    const terminal = JSON.parse(await readFile(
      path.join(controlRoot, 'recovery-receipts', `${interrupted.request.requestId}.json`),
      'utf8'
    )) as { receipt: { status: string; recoveryRequired: boolean } }
    expect(original.receipt).toMatchObject({ status: 'rollback-failed', recoveryRequired: true })
    expect(terminal.receipt).toMatchObject({ status: 'rolled-back', recoveryRequired: false })
  })

  it('replays an existing receipt without consuming an unrelated recovery lease', async () => {
    const fixture = await createFixture()
    const v1 = await stageComponent(fixture.stagingRoot, defaultStage({
      artifactId: 'nebula-artifact-replay-v1',
      targetVersion: '0.9.1'
    }))
    const v1Adapters = createAdapters()
    const firstRequest = makeRequest('nebula', '0.9.1', v1, initialComponentUpdateRevision)
    const firstReceipt = await createService(fixture, v1Adapters.adapters).execute(firstRequest)
    const activePath = path.join(fixture.projectRoot, '.dyson-control-updates', 'active.json')
    const previousActive = await readFile(activePath, 'utf8')

    const v2 = await stageComponent(fixture.stagingRoot, defaultStage({
      artifactId: 'nebula-artifact-replay-v2',
      targetVersion: '0.9.2',
      payloads: [{
        name: 'plugins/nebula-NebulaMultiplayerMod/Nebula.dll',
        bytes: Buffer.from('nebula-v2')
      }]
    }))
    let publishProofs = 0
    const interruptedAdapters = createAdapters({
      stoppedVerifier: async (request) => {
        if (request.phase === 'before-publish' && ++publishProofs === 2) {
          await rm(activePath)
          await mkdir(activePath)
        }
        return { processStopped: true, portClosed: true }
      }
    })
    const secondRequest = makeRequest(
      'nebula',
      '0.9.2',
      v2,
      firstReceipt.resultingRevision,
      baseInventory({ nebula: '0.9.1' })
    )
    await expect(createService(fixture, interruptedAdapters.adapters).execute(secondRequest))
      .rejects.toMatchObject({ code: 'UPDATE_ACTIVE_SWITCH_FAILED' })
    await rm(activePath, { recursive: true, force: true })
    await writeFile(activePath, previousActive)

    const recoveryCoordinator = new TestHostMutationRecoveryCoordinator()
    recoveryCoordinator.acquireError = new HostMutationOperationCoordinatorError(
      'HOST_MUTATION_LEASE_RECOVERY_MISMATCH'
    )
    const service = createService(fixture, interruptedAdapters.adapters, {
      hostMutationCoordinator: new TestHostMutationCoordinator(),
      hostMutationRecoveryCoordinator: recoveryCoordinator
    })
    await expect(service.recoverInterrupted(firstRequest.requestId)).resolves.toMatchObject({
      requestId: firstRequest.requestId,
      status: 'succeeded',
      reused: true
    })
    expect(recoveryCoordinator.requests).toEqual([{
      expectedOperation: 'component-update-activation',
      expectedRequestId: firstRequest.requestId
    }])
    expect(recoveryCoordinator.dispositions).toEqual([])
    expect(await pathExists(path.join(
      fixture.projectRoot,
      '.dyson-control-updates',
      'transactions',
      `${secondRequest.requestId}.json`
    ))).toBe(true)
    expect(await service.getReceipt(secondRequest.requestId)).toBeNull()
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
    expect(cleanup.candidates.filter(candidate => candidate.kind === 'history')).toEqual([])
    expect((await service.getState()).historyEntries).toBe(1)
  })

  it('blocks update and rollback entry points while cleanup requires recovery', async () => {
    const fixture = await createFixture()
    const controlled = createAdapters()
    const service = createService(fixture, controlled.adapters, { hasPendingCleanup: async () => true })
    const staged = await stageComponent(fixture.stagingRoot, defaultStage())
    const request = makeRequest('nebula', '0.9.1', staged, initialComponentUpdateRevision)
    await expect(service.getState()).resolves.toMatchObject({ recoveryRequired: true })
    await expect(service.preview(request)).rejects.toMatchObject({ code: 'UPDATE_CLEANUP_RECOVERY_REQUIRED' })
    await expect(service.execute(request)).rejects.toMatchObject({ code: 'UPDATE_CLEANUP_RECOVERY_REQUIRED' })
    await expect(service.executeRollback({})).rejects.toMatchObject({ code: 'UPDATE_CLEANUP_RECOVERY_REQUIRED' })
    await expect(service.previewCleanup()).rejects.toMatchObject({ code: 'UPDATE_CLEANUP_RECOVERY_REQUIRED' })
    expect(controlled.protectionCalls).toBe(0)
  })

  it('offers older history while retaining the current successful update predecessor', async () => {
    const fixture = await createFixture()
    const service = createService(fixture, createAdapters().adapters, { maximumHistoryEntries: 2, hostMutationRecoveryCoordinator: new TestHostMutationRecoveryCoordinator() })
    const first = await stageComponent(fixture.stagingRoot, defaultStage({ artifactId: 'nebula-retention-first', targetVersion: '0.9.1' }))
    const firstRequest = makeRequest('nebula', '0.9.1', first, initialComponentUpdateRevision)
    const installed = await service.execute(firstRequest)
    const second = await stageComponent(fixture.stagingRoot, defaultStage({ artifactId: 'nebula-retention-second', targetVersion: '0.9.2' }))
    const secondRequest = makeRequest('nebula', '0.9.2', second, installed.resultingRevision, baseInventory({ nebula: '0.9.1' }))
    await service.execute(secondRequest)
    const plan = await service.previewCleanup()
    expect(plan.candidates.filter(candidate => candidate.kind === 'history')).toEqual([
      { kind: 'history', opaqueId: firstRequest.requestId, recoverable: true, reason: 'history-retention-exceeded' }
    ])
    expect((await service.getState()).historyEntries).toBe(2)
    const cleanupRequestId = randomUUID()
    const bound = await service.previewRecoverableCleanup(cleanupRequestId)
    expect(bound).toMatchObject({ requestId: cleanupRequestId,
      candidates: [expect.objectContaining({ kind: 'history', opaqueId: firstRequest.requestId,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/), sizeBytes: expect.any(Number) })] })
    expect(bound.candidates[0]!.sizeBytes).toBeGreaterThan(0)
    expect(await service.previewRecoverableCleanup(cleanupRequestId)).toEqual(bound)
    const database = new ControlDatabase(path.join(fixture.root, 'cleanup-data'))
    try {
      const journal = { format: 'dyson-recoverable-cleanup-journal', schemaVersion: 1, requestId: cleanupRequestId,
        direction: 'quarantine', actor: 'Administrator', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: null,
        state: 'running', completedCount: 0, plan: bound }
      expect((await service.runRecoverableCleanup(journal, database)).state).toBe('completed')
      expect((await service.getState()).historyEntries).toBe(1)
      const restore = { ...journal, requestId: randomUUID(), direction: 'restore' }
      expect((await service.runRecoverableCleanup(restore, database)).state).toBe('completed')
      expect((await service.getState()).historyEntries).toBe(2)
    } finally { database.close() }


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
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'dyson-update-activation-')))
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
  protection?: ComponentUpdateActivationAdapters['createSaveProtectionPoint']
  baseline?: NonNullable<ComponentUpdateActivationAdapters['captureRollbackBaseline']>
  restoreConfiguration?: NonNullable<ComponentUpdateActivationAdapters['restoreRollbackConfiguration']>
  restoreServerModLock?: NonNullable<ComponentUpdateActivationAdapters['restoreRollbackServerModLock']>
  restorePairedSave?: NonNullable<ComponentUpdateActivationAdapters['restoreRollbackPairedSave']>
  readback?: NonNullable<ComponentUpdateActivationAdapters['inspectRollbackReadback']>
  smoke?: ComponentUpdateActivationAdapters['smoke']
} = {}) {
  const stopPhases: string[] = []
  const smokeCalls: string[] = []
  const rollbackCalls: string[] = []
  let protectionCalls = 0
  const adapters: ComponentUpdateActivationAdapters = {
    verifyStoppedState: async (request, hostMutation) => {
      stopPhases.push(request.phase)
      if (options.stoppedVerifier !== undefined) return await options.stoppedVerifier(request, hostMutation)
      return { processStopped: options.stopped ?? true, portClosed: options.stopped ?? true }
    },
    createSaveProtectionPoint: async (request, hostMutation) => {
      protectionCalls++
      if (options.protection !== undefined) return await options.protection(request, hostMutation)
      if (options.protectionValid === false) return { requestId: request.requestId, status: 'succeeded', backupId: 'bad' } as never
      return {
        requestId: request.requestId,
        status: 'succeeded',
        backupId: `backup-${request.requestId}`,
        manifestSha256: 'd'.repeat(64),
        saveIdentity: 'c'.repeat(64),
        pairProtected: true,
        durable: true
      }
    },
    inspectRollbackMaterial: async () => ({ configurationSnapshotVerified: true, protectionVerified: true,
      serverModLockVerified: true, currentConfigurationRevision: '1'.repeat(64) }),
    captureRollbackBaseline: async (request, hostMutation) => options.baseline === undefined ? ({
      configurationSnapshotId: 'config-snapshot-fixture',
      configurationRevision: '1'.repeat(64),
      serverModLockSha256: '2'.repeat(64),
      serverModLockRevision: '3'.repeat(64),
      previousLoadedSaveIdentity: 'c'.repeat(64)
    }) : await options.baseline(request, hostMutation),
    restoreRollbackConfiguration: async (request, hostMutation) => {
      rollbackCalls.push('configuration')
      return options.restoreConfiguration === undefined
        ? { restored: true, rereadVerified: true }
        : await options.restoreConfiguration(request, hostMutation)
    },
    restoreRollbackServerModLock: async (request, hostMutation) => {
      rollbackCalls.push('server-mod-lock')
      return options.restoreServerModLock === undefined
        ? { restored: true, rereadVerified: true }
        : await options.restoreServerModLock(request, hostMutation)
    },
    restoreRollbackPairedSave: async (request, hostMutation) => {
      rollbackCalls.push('paired-save')
      return options.restorePairedSave === undefined
        ? { restored: true, rereadVerified: true }
        : await options.restorePairedSave(request, hostMutation)
    },
    inspectRollbackReadback: async (request, hostMutation) => {
      rollbackCalls.push('readback')
      if (options.readback !== undefined) return await options.readback(request, hostMutation)
      return {
      configurationSnapshotId: 'config-snapshot-fixture',
      configurationRevision: '1'.repeat(64),
      serverModLockSha256: '2'.repeat(64),
      serverModLockRevision: '3'.repeat(64),
      protectionManifestSha256: 'd'.repeat(64),
      loadedSaveIdentity: 'c'.repeat(64)
      }
    },
    smoke: async (request, hostMutation) => {
      smokeCalls.push(request.phase)
      return options.smoke === undefined ? smokeResult(request, true) : await options.smoke(request, hostMutation)
    }
  }
  return {
    adapters,
    stopPhases,
    smokeCalls,
    rollbackCalls,
    get protectionCalls() { return protectionCalls }
  }
}

function smokeResult(request: FixedUpdateSmokeRequest, healthy: boolean) {
  const generation = 'e'.repeat(64)
  return {
    component: request.component,
    observedVersion: request.expectedVersion,
    versionMatches: healthy,
    bepInExLoaded: healthy,
    nebulaLoaded: healthy,
    processHealthy: healthy,
    portHealthy: healthy,
    startupGenerationId: healthy ? generation : null,
    bridgeHeartbeatGenerationId: healthy ? generation : null,
    loadedSaveLogGenerationId: healthy ? generation : null,
    loadedSaveIdentity: healthy ? request.expectedLoadedSaveIdentity : null
  }
}

async function prepareInterruptedActivation() {
  const fixture = await createFixture()
  const liveFile = path.join(
    fixture.liveRoot,
    'plugins',
    'nebula-NebulaMultiplayerMod',
    'Nebula.dll'
  )
  await mkdir(path.dirname(liveFile), { recursive: true })
  await writeFile(liveFile, 'previous-nebula')
  const staged = await stageComponent(fixture.stagingRoot, defaultStage({
    artifactId: 'nebula-artifact-explicit-recovery',
    payloads: [{
      name: 'plugins/nebula-NebulaMultiplayerMod/Nebula.dll',
      bytes: Buffer.from('candidate-nebula')
    }]
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
  let failure: unknown
  try {
    await createService(fixture, controlled.adapters, {
      hostMutationCoordinator: new TestHostMutationCoordinator()
    }).execute(request)
  } catch (error) {
    failure = error
  }
  if (!(failure instanceof ComponentUpdateActivationError) || failure.code !== 'UPDATE_ACTIVE_SWITCH_FAILED') {
    throw failure ?? new Error('interrupted activation fixture unexpectedly succeeded')
  }
  await rm(path.join(fixture.projectRoot, '.dyson-control-updates', 'active.json'), {
    recursive: true,
    force: true
  })
  return { fixture, liveFile, request, controlled }
}

function createService(
  fixture: Fixture,
  adapters: ComponentUpdateActivationAdapters,
  limits: Partial<{
    maximumArchiveBytes: number
    maximumFileBytes: number
    maximumExpandedBytes: number
    maximumFiles: number
    maximumHistoryEntries: number
    hasPendingCleanup: () => Promise<boolean>
    hostMutationCoordinator: HostMutationOperationCoordinator
    hostMutationRecoveryCoordinator: HostMutationRecoveryOperationCoordinator
  }> = {}
): ComponentUpdateActivationService {
  return new ComponentUpdateActivationService({
    projectRoot: fixture.projectRoot,
    stagingRoot: fixture.stagingRoot,
    liveComponentRoots: liveComponentRoots(fixture),
    compatibilityVerifier: createCompatibilityVerifier(),
    hostMutationCoordinator: limits.hostMutationCoordinator ?? new TestHostMutationCoordinator(),
    now: () => new Date('2026-08-30T12:00:00.000Z'),
    ...adapters,
    ...limits
  })
}

class TestHostMutationCoordinator implements HostMutationOperationCoordinator {
  readonly requests: HostMutationOperationRequest[] = []
  readonly dispositions: HostMutationDisposition[] = []
  readonly controller = new AbortController()
  readonly borrowArguments = ['-LeaseInstanceId', 'test-instance', '-LeaseToken', 'test-token'] as const
  assertActiveCalls = 0
  acquireError: unknown = null
  onEnter: ((request: HostMutationOperationRequest) => void | Promise<void>) | null = null
  onAssertActive: (() => void) | null = null
  abandoned = false

  async runExclusive<T>(
    request: HostMutationOperationRequest,
    operation: (scope: HostMutationOperationScope) => Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>
  ): Promise<T> {
    this.requests.push({ ...request })
    if (this.acquireError !== null) throw this.acquireError
    await this.onEnter?.(request)
    try {
      const outcome = await operation({
        signal: this.controller.signal,
        assertActive: () => {
          this.assertActiveCalls++
          if (this.controller.signal.aborted) {
            throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_LOST')
          }
          this.onAssertActive?.()
        },
        toPowerShellBorrowArguments: () => this.borrowArguments
      })
      this.dispositions.push(outcome.disposition)
      if (outcome.disposition === 'abandon') this.abandoned = true
      if (outcome.kind === 'throw') throw outcome.error
      return outcome.value
    } catch (error) {
      if (error instanceof HostMutationLeaseError) this.abandoned = true
      throw error
    }
  }
}

class TestHostMutationRecoveryCoordinator implements HostMutationRecoveryOperationCoordinator {
  readonly requests: HostMutationRecoveryOperationRequest[] = []
  readonly dispositions: HostMutationDisposition[] = []
  readonly controller = new AbortController()
  acquireError: unknown = null
  onEnter: ((request: HostMutationRecoveryOperationRequest) => void | Promise<void>) | null = null
  onAssertActive: (() => void) | null = null
  abandoned = false
  recoveryPending = true

  async runRecoveryExclusive<T>(
    request: HostMutationRecoveryOperationRequest,
    operation: (
      scope: HostMutationOperationScope
    ) => Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>
  ): Promise<T> {
    this.requests.push({ ...request })
    if (this.acquireError !== null) throw this.acquireError
    if (!this.recoveryPending) {
      throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_RECOVERY_NOT_REQUIRED')
    }
    await this.onEnter?.(request)
    try {
      const outcome = await operation({
        signal: this.controller.signal,
        assertActive: () => {
          if (this.controller.signal.aborted) {
            throw new HostMutationLeaseError('DYSON_HOST_MUTATION_LEASE_LOST')
          }
          this.onAssertActive?.()
        },
        toPowerShellBorrowArguments: () => [
          '-LeaseInstanceId', 'recovery-test-instance', '-LeaseToken', 'recovery-test-token'
        ]
      })
      this.dispositions.push(outcome.disposition)
      if (outcome.disposition === 'abandon') this.abandoned = true
      else this.recoveryPending = false
      if (outcome.kind === 'throw') throw outcome.error
      return outcome.value
    } catch (error) {
      if (error instanceof HostMutationLeaseError) this.abandoned = true
      throw error
    }
  }
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

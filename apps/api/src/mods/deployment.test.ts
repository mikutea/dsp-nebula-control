import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ModDeploymentService,
  computeStagedModPayloadDigest
} from './deployment.js'
import type {
  ModDeploymentFaultPhase,
  ModDeploymentOperation,
  ModDeploymentRequest,
  ModDeploymentServiceOptions,
  StagedModPackageManifest
} from './deployment-types.js'
import { createModPlatformLock } from './platform-lock.js'
import { parseThunderstoreDependency } from './dependency.js'
import { generateModManifests, type GeneratedModManifests } from './manifest.js'
import { partitionThunderstorePluginDependencies } from '../update-pipeline/thunderstore-dependency-routing.js'

interface StagedFixturePackage {
  dependencyId: string
  sha256: string
  dependencies: string[]
  serverRequired: true
  clientRequirement: 'required' | 'optional' | 'not-required'
}

interface Harness {
  root: string
  stagingRoot: string
  pluginsRoot: string
  service: ModDeploymentService
}

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('mod deployment transaction core', () => {
  it('revalidates a verified platform lock for preview, execution, and idempotent replay', async () => {
    let inventoryRevision = 'c'.repeat(64)
    let inventoryReads = 0
    const harness = await createHarness({
      readPlatformInventory: async () => {
        inventoryReads += 1
        return {
          inventoryRevision,
          inventory: { nebula: '0.9.22', bepInEx: '5.4.17' }
        }
      }
    })
    const staged = await stagePackage(harness.stagingRoot, 'Fictional-PlatformBoundMod-1.0.0', {
      'PlatformBoundMod.dll': Buffer.from('fictional-platform-bound-mod')
    })
    const generated = manifests([staged], [staged.dependencyId])
    const request = makeRequest('install', staged, generated, (await harness.service.inspect()).revision)
    request.manifest.platformLock = platformLockFor(generated, inventoryRevision)

    await expect(harness.service.preview(request)).resolves.toMatchObject({ dryRun: true })
    await expect(harness.service.execute(request)).resolves.toMatchObject({ status: 'succeeded', reused: false })
    expect(inventoryReads).toBe(2)

    inventoryRevision = 'd'.repeat(64)
    await expect(harness.service.execute(request)).rejects.toThrow('MOD_DEPLOYMENT_PLATFORM_INVENTORY_DRIFT')
    expect(inventoryReads).toBe(3)
  })

  it('fails closed for unavailable, drifted, or exact-version-mismatched trusted platform inventory', async () => {
    const unavailable = await createHarness({
      readPlatformInventory: async () => { throw new Error('fictional inventory unavailable') }
    })
    const staged = await stagePackage(unavailable.stagingRoot, 'Fictional-PlatformGateMod-1.0.0', {
      'PlatformGateMod.dll': Buffer.from('fictional-platform-gate-mod')
    })
    const generated = manifests([staged], [staged.dependencyId])
    const request = makeRequest('install', staged, generated, (await unavailable.service.inspect()).revision)
    request.manifest.platformLock = platformLockFor(generated, 'c'.repeat(64))
    await expect(unavailable.service.preview(request))
      .rejects.toThrow('MOD_DEPLOYMENT_PLATFORM_INVENTORY_UNAVAILABLE')

    const drifted = await createHarness({
      readPlatformInventory: async () => ({
        inventoryRevision: 'd'.repeat(64),
        inventory: { nebula: '0.9.22', bepInEx: '5.4.17' }
      })
    })
    const driftedRequest = structuredClone(request)
    driftedRequest.expectedRevision = (await drifted.service.inspect()).revision
    await expect(drifted.service.preview(driftedRequest))
      .rejects.toThrow('MOD_DEPLOYMENT_PLATFORM_INVENTORY_DRIFT')

    const mismatched = await createHarness({
      readPlatformInventory: async () => ({
        inventoryRevision: 'c'.repeat(64),
        inventory: { nebula: '0.9.23', bepInEx: '5.4.17' }
      })
    })
    const mismatchedRequest = structuredClone(request)
    mismatchedRequest.expectedRevision = (await mismatched.service.inspect()).revision
    await expect(mismatched.service.preview(mismatchedRequest))
      .rejects.toThrow('MOD_DEPLOYMENT_PLATFORM_VERSION_MISMATCH')
  })

  it('rejects malformed or server-lock-detached platform locks before inventory access', async () => {
    let inventoryReads = 0
    const harness = await createHarness({
      readPlatformInventory: async () => {
        inventoryReads += 1
        return {
          inventoryRevision: 'c'.repeat(64),
          inventory: { nebula: '0.9.22', bepInEx: '5.4.17' }
        }
      }
    })
    const staged = await stagePackage(harness.stagingRoot, 'Fictional-MalformedLockMod-1.0.0', {
      'MalformedLockMod.dll': Buffer.from('fictional-malformed-lock-mod')
    })
    const generated = manifests([staged], [staged.dependencyId])
    const request = makeRequest('install', staged, generated, (await harness.service.inspect()).revision)
    request.manifest.platformLock = {
      ...platformLockFor(generated, 'c'.repeat(64)),
      digest: 'f'.repeat(64)
    }
    await expect(harness.service.preview(request)).rejects.toThrow('MOD_DEPLOYMENT_PLATFORM_LOCK_INVALID')
    expect(inventoryReads).toBe(0)
  })

  it('defines an empty platform lock as inventory-independent but still server-lock-bound', async () => {
    let inventoryReads = 0
    const harness = await createHarness({
      readPlatformInventory: async () => {
        inventoryReads += 1
        throw new Error('must not be read for an empty platform lock')
      }
    })
    const staged = await stagePackage(harness.stagingRoot, 'Fictional-NoPlatformMod-1.0.0', {
      'NoPlatformMod.dll': Buffer.from('fictional-no-platform-mod')
    })
    const generated = manifests([staged], [staged.dependencyId])
    const request = makeRequest('install', staged, generated, (await harness.service.inspect()).revision)
    expect(request.manifest.platformLock).toMatchObject({ inventoryRevision: null, requirements: [] })
    await expect(harness.service.preview(request)).resolves.toMatchObject({ dryRun: true })
    expect(inventoryReads).toBe(0)
  })

  it('previews and executes install, update, disable, enable, and recoverable remove', async () => {
    const harness = await createHarness()
    const v1 = await stagePackage(harness.stagingRoot, 'Fictional-ExampleMod-1.0.0', {
      'ExampleMod.dll': Buffer.from('fictional-dll-v1'),
      'config/settings.json': Buffer.from('{"enabled":true}\n')
    })
    const v2 = await stagePackage(harness.stagingRoot, 'Fictional-ExampleMod-2.0.0', {
      'ExampleMod.dll': Buffer.from('fictional-dll-v2'),
      'config/settings.json': Buffer.from('{"enabled":true,"version":2}\n')
    })
    const v1Manifests = manifests([v1], [v1.dependencyId])
    const v2Manifests = manifests([v2], [v2.dependencyId])

    let state = await harness.service.inspect()
    const install = makeRequest('install', v1, v1Manifests, state.revision)
    const installPreview = await harness.service.preview(install)
    expect(installPreview).toMatchObject({
      dryRun: true,
      operation: 'install',
      currentlyInstalled: false,
      currentlyEnabled: false,
      nextEnabled: true,
      payloadFileCount: 2,
      stoppedStateRequiredForExecute: true
    })
    const installed = await harness.service.execute(install)
    expect(installed).toMatchObject({ status: 'succeeded', rollback: 'not-needed', reused: false })

    state = await harness.service.inspect()
    expect(state.packages).toEqual([expect.objectContaining({
      dependencyId: v1.dependencyId, version: '1.0.0', enabled: true
    })])
    const update = makeRequest('update', v2, v2Manifests, state.revision)
    expect(await harness.service.preview(update)).toMatchObject({ operation: 'update', nextEnabled: true })
    expect(await harness.service.execute(update)).toMatchObject({ status: 'succeeded' })

    state = await harness.service.inspect()
    const disable = makeRequest('disable', v2, v2Manifests, state.revision)
    expect(await harness.service.preview(disable)).toMatchObject({
      operation: 'disable', currentlyEnabled: true, nextEnabled: false, recoverablePayloadPreserved: true
    })
    expect(await harness.service.execute(disable)).toMatchObject({
      status: 'succeeded', recoverablePayloadPreserved: true
    })

    state = await harness.service.inspect()
    const enable = makeRequest('enable', v2, v2Manifests, state.revision)
    expect(await harness.service.preview(enable)).toMatchObject({
      operation: 'enable', currentlyEnabled: false, nextEnabled: true
    })
    expect(await harness.service.execute(enable)).toMatchObject({ status: 'succeeded' })

    state = await harness.service.inspect()
    const removeRequest = makeRequest('remove', v2, v2Manifests, state.revision)
    expect(await harness.service.preview(removeRequest)).toMatchObject({
      operation: 'remove', nextEnabled: null, recoverablePayloadPreserved: true
    })
    const removed = await harness.service.execute(removeRequest)
    expect(removed).toMatchObject({
      status: 'succeeded', recoveryPointCreated: true, recoverablePayloadPreserved: true
    })
    expect((await harness.service.inspect()).packages).toEqual([])

    const cleanup = await harness.service.previewCleanup()
    expect(cleanup).toMatchObject({ dryRun: true, irreversible: true, executeSupported: false })
    expect(cleanup.candidates.filter((candidate) => candidate.kind === 'snapshot')).toHaveLength(5)
    expect(JSON.stringify({ installPreview, installed, removed, cleanup })).not.toMatch(
      /(?:[A-Za-z]:\\|\\\\|\/tmp\/|stagingRoot|pluginsRoot)/i
    )
  })

  it('requires a fresh stopped-process and closed-port proof before and immediately before publication', async () => {
    let checks = 0
    const harness = await createHarness({
      verifyStoppedState: async () => {
        checks += 1
        return { processStopped: checks > 1, portClosed: true }
      }
    })
    const staged = await stagePackage(harness.stagingRoot, 'Fictional-GatedMod-1.0.0', {
      'GatedMod.dll': Buffer.from('fictional-gated-dll')
    })
    const generated = manifests([staged], [staged.dependencyId])
    const state = await harness.service.inspect()
    const request = makeRequest('install', staged, generated, state.revision)

    await expect(harness.service.preview(request)).resolves.toMatchObject({ dryRun: true })
    expect(checks).toBe(0)
    await expect(harness.service.execute(request)).rejects.toThrow('MOD_DEPLOYMENT_STOP_GATE_REJECTED')
    expect(checks).toBe(1)
    expect((await harness.service.inspect()).revision).toBe(state.revision)
  })

  it('fails closed on missing dependencies, active dependents, and client parity tampering', async () => {
    const harness = await createHarness()
    const core = await stagePackage(harness.stagingRoot, 'Fictional-CoreLib-1.0.0', {
      'CoreLib.dll': Buffer.from('fictional-core')
    })
    const main = await stagePackage(harness.stagingRoot, 'Fictional-MainMod-1.0.0', {
      'MainMod.dll': Buffer.from('fictional-main')
    }, { dependencies: [core.dependencyId] })
    const coreOnly = manifests([core], [core.dependencyId])
    const full = manifests([core, main], [main.dependencyId])

    let state = await harness.service.inspect()
    await harness.service.execute(makeRequest('install', core, coreOnly, state.revision))
    state = await harness.service.inspect()
    await harness.service.execute(makeRequest('disable', core, coreOnly, state.revision))

    state = await harness.service.inspect()
    await expect(harness.service.preview(makeRequest('install', main, full, state.revision)))
      .rejects.toThrow('MOD_DEPLOYMENT_DEPENDENCY_MISSING')
    await harness.service.execute(makeRequest('enable', core, coreOnly, state.revision))
    state = await harness.service.inspect()
    await harness.service.execute(makeRequest('install', main, full, state.revision))

    state = await harness.service.inspect()
    await expect(harness.service.preview(makeRequest('disable', core, full, state.revision)))
      .rejects.toThrow('MOD_DEPLOYMENT_DEPENDENT_ACTIVE')
    await expect(harness.service.preview(makeRequest('remove', core, full, state.revision)))
      .rejects.toThrow('MOD_DEPLOYMENT_DEPENDENT_ACTIVE')

    const tampered = structuredClone(full)
    tampered.clientParity.serverLockSha256 = 'f'.repeat(64)
    await expect(harness.service.preview(makeRequest('update', main, tampered, state.revision)))
      .rejects.toThrow('MOD_DEPLOYMENT_MANIFEST_INVALID')
  })

  it('rejects staging tampering, unlisted file types, path traversal, and symbolic links', async () => {
    const tamperedHarness = await createHarness()
    const tampered = await stagePackage(tamperedHarness.stagingRoot, 'Fictional-TamperedMod-1.0.0', {
      'TamperedMod.dll': Buffer.from('original-fictional-content')
    })
    const tamperedManifests = manifests([tampered], [tampered.dependencyId])
    await writeFile(join(tamperedHarness.stagingRoot, tampered.dependencyId, 'payload', 'TamperedMod.dll'),
      'changed-fictional-content')
    await expect(tamperedHarness.service.preview(makeRequest(
      'install', tampered, tamperedManifests, (await tamperedHarness.service.inspect()).revision
    ))).rejects.toThrow('MOD_DEPLOYMENT_PAYLOAD_TAMPERED')

    const extraHarness = await createHarness()
    const extra = await stagePackage(extraHarness.stagingRoot, 'Fictional-ExtraFileMod-1.0.0', {
      'ExtraFileMod.dll': Buffer.from('fictional-content')
    })
    await writeFile(join(extraHarness.stagingRoot, extra.dependencyId, 'payload', 'README.md'), 'not allowed')
    await expect(extraHarness.service.preview(makeRequest(
      'install', extra, manifests([extra], [extra.dependencyId]), (await extraHarness.service.inspect()).revision
    ))).rejects.toThrow('MOD_DEPLOYMENT_PAYLOAD_TYPE_INVALID')

    const escapeHarness = await createHarness()
    const escaped = await stagePackage(escapeHarness.stagingRoot, 'Fictional-EscapeMod-1.0.0', {
      'EscapeMod.dll': Buffer.from('fictional-content')
    })
    const escapedManifestPath = join(escapeHarness.stagingRoot, escaped.dependencyId, 'package-manifest.json')
    const escapedManifest = JSON.parse(await readFile(escapedManifestPath, 'utf8')) as StagedModPackageManifest
    escapedManifest.files[0]!.relativePath = '../evil.dll'
    await writeFile(escapedManifestPath, `${JSON.stringify(escapedManifest, null, 2)}\n`)
    await expect(escapeHarness.service.preview(makeRequest(
      'install', escaped, manifests([escaped], [escaped.dependencyId]), (await escapeHarness.service.inspect()).revision
    ))).rejects.toThrow('MOD_DEPLOYMENT_STAGING_INVALID')

    const linkHarness = await createHarness()
    const linked = await stagePackage(linkHarness.stagingRoot, 'Fictional-LinkedMod-1.0.0', {
      'LinkedMod.dll': Buffer.from('fictional-link-target')
    })
    const linkedFile = join(linkHarness.stagingRoot, linked.dependencyId, 'payload', 'LinkedMod.dll')
    const outsideFile = join(linkHarness.root, 'outside-fictional.dll')
    await writeFile(outsideFile, 'fictional-link-target')
    await rm(linkedFile)
    try {
      await symlink(outsideFile, linkedFile, 'file')
      await expect(linkHarness.service.preview(makeRequest(
        'install', linked, manifests([linked], [linked.dependencyId]), (await linkHarness.service.inspect()).revision
      ))).rejects.toThrow('MOD_DEPLOYMENT_ROOT_LINK_REJECTED')
    } catch (error) {
      if (!isSymlinkPrivilegeError(error)) throw error
    }
  })

  it('enforces UUID idempotency, revision conflicts, strict logical input, and source conflicts', async () => {
    const harness = await createHarness()
    const v1 = await stagePackage(harness.stagingRoot, 'Fictional-IdentityMod-1.0.0', {
      'IdentityMod.dll': Buffer.from('fictional-v1')
    })
    const v2 = await stagePackage(harness.stagingRoot, 'Fictional-IdentityMod-2.0.0', {
      'IdentityMod.dll': Buffer.from('fictional-v2')
    })
    const v1Manifest = manifests([v1], [v1.dependencyId])
    const initial = await harness.service.inspect()
    const request = makeRequest('install', v1, v1Manifest, initial.revision)
    const first = await harness.service.execute(request)
    const repeated = await harness.service.execute(structuredClone(request))
    expect(first.reused).toBe(false)
    expect(repeated).toMatchObject({ status: 'succeeded', reused: true, newRevision: first.newRevision })

    const conflictingId = { ...request, operation: 'remove' as const }
    await expect(harness.service.execute(conflictingId)).rejects.toThrow('MOD_DEPLOYMENT_IDEMPOTENCY_CONFLICT')

    await expect(harness.service.preview(makeRequest('update', v2, manifests([v2], [v2.dependencyId]), initial.revision)))
      .rejects.toThrow('MOD_DEPLOYMENT_REVISION_CONFLICT')
    const current = await harness.service.inspect()
    await expect(harness.service.preview(makeRequest('install', v2, manifests([v2], [v2.dependencyId]), current.revision)))
      .rejects.toThrow('MOD_DEPLOYMENT_SOURCE_CONFLICT')

    const withPath = { ...makeRequest('update', v2, manifests([v2], [v2.dependencyId]), current.revision),
      stagingPath: 'C:\\Fictional\\Mods', command: 'fictional.exe' } as ModDeploymentRequest
    await expect(harness.service.preview(withPath)).rejects.toThrow('MOD_DEPLOYMENT_REQUEST_INVALID')
  })

  it('queries exact durable receipts and paginates bounded history with a stable keyset cursor', async () => {
    const persistedTimes = [
      '2026-08-30T10:00:00.000Z',
      '2026-08-30T10:00:00.000Z',
      '2026-08-30T10:02:00.000Z'
    ]
    let persistedTimeIndex = 0
    const harness = await createHarness({
      now: () => new Date(persistedTimes[persistedTimeIndex++]!)
    })
    const v1 = await stagePackage(harness.stagingRoot, 'Fictional-HistoryMod-1.0.0', {
      'HistoryMod.dll': Buffer.from('fictional-history-v1')
    })
    const v2 = await stagePackage(harness.stagingRoot, 'Fictional-HistoryMod-2.0.0', {
      'HistoryMod.dll': Buffer.from('fictional-history-v2')
    })
    const requestIds = [
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000003'
    ] as const

    let state = await harness.service.inspect()
    const install = makeRequest('install', v1, manifests([v1], [v1.dependencyId]), state.revision, requestIds[0])
    await harness.service.execute(install)
    state = await harness.service.inspect()
    const update = makeRequest('update', v2, manifests([v2], [v2.dependencyId]), state.revision, requestIds[1])
    await harness.service.execute(update)
    state = await harness.service.inspect()
    const disable = makeRequest('disable', v2, manifests([v2], [v2.dependencyId]), state.revision, requestIds[2])
    await harness.service.execute(disable)

    await expect(harness.service.getReceipt(requestIds[1])).resolves.toMatchObject({
      requestId: requestIds[1], operation: 'update', reused: false
    })
    await expect(harness.service.getReceipt('10000000-0000-4000-8000-000000000099')).resolves.toBeNull()

    const first = await harness.service.history({ cursor: null, pageSize: 2 })
    expect(first).toMatchObject({
      format: 'dyson-control-mod-deployment-receipt-history',
      schemaVersion: 1,
      order: 'persisted-at-descending',
      page: { limit: 2, returned: 2, totalReceipts: 3 }
    })
    expect(first.items.map((item) => [item.persistedAt, item.receipt.requestId])).toEqual([
      [persistedTimes[2], requestIds[2]],
      [persistedTimes[1], requestIds[1]]
    ])
    expect(first.page.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/)

    const second = await harness.service.history({ cursor: first.page.nextCursor, pageSize: 2 })
    expect(second.items.map((item) => item.receipt.requestId)).toEqual([requestIds[0]])
    expect(second.page).toEqual({ limit: 2, returned: 1, totalReceipts: 3, nextCursor: null })
    const defaultPage = await harness.service.history()
    expect(defaultPage.page).toMatchObject({ limit: 20, returned: 3, totalReceipts: 3, nextCursor: null })
    expect(JSON.stringify({ first, second, defaultPage })).not.toMatch(
      /(?:[A-Za-z]:\\|\\\\|\/tmp\/|stagingRoot|pluginsRoot|fingerprint)/i
    )

    await expect(harness.service.getReceipt('not-a-uuid'))
      .rejects.toThrow('MOD_DEPLOYMENT_RECEIPT_REQUEST_INVALID')
    await expect(harness.service.history({ cursor: null, pageSize: 101 }))
      .rejects.toThrow('MOD_DEPLOYMENT_HISTORY_REQUEST_INVALID')
    await expect(harness.service.history({ cursor: null, pageSize: 2, path: 'C:\\Fictional\\Private' }))
      .rejects.toThrow('MOD_DEPLOYMENT_HISTORY_REQUEST_INVALID')
    await expect(harness.service.history({ cursor: 'not-a-canonical-cursor', pageSize: 2 }))
      .rejects.toThrow('MOD_DEPLOYMENT_HISTORY_CURSOR_INVALID')
  })

  it('fails receipt lookup and history closed when a persisted receipt is corrupt', async () => {
    const harness = await createHarness()
    const staged = await stagePackage(harness.stagingRoot, 'Fictional-CorruptReceiptMod-1.0.0', {
      'CorruptReceiptMod.dll': Buffer.from('fictional-corrupt-receipt')
    })
    const requestId = '20000000-0000-4000-8000-000000000001'
    const request = makeRequest(
      'install', staged, manifests([staged], [staged.dependencyId]),
      (await harness.service.inspect()).revision, requestId
    )
    await harness.service.execute(request)
    const receiptPath = join(harness.root, '.plugins.dyson-control', 'receipts', `${requestId}.json`)
    await writeFile(receiptPath, '{"unexpected":"corrupt"}\n', 'utf8')

    await expect(harness.service.getReceipt(requestId)).rejects.toThrow('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    await expect(harness.service.history()).rejects.toThrow('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
  })

  it('serializes concurrent calls and uses a filesystem lock across service instances', async () => {
    let releaseGate!: () => void
    let enteredGate!: () => void
    const gateEntered = new Promise<void>((resolvePromise) => { enteredGate = resolvePromise })
    const gateRelease = new Promise<void>((resolvePromise) => { releaseGate = resolvePromise })
    let gateCalls = 0
    const harness = await createHarness({
      verifyStoppedState: async () => {
        gateCalls += 1
        if (gateCalls === 1) {
          enteredGate()
          await gateRelease
        }
        return { processStopped: true, portClosed: true }
      }
    })
    const staged = await stagePackage(harness.stagingRoot, 'Fictional-ConcurrentMod-1.0.0', {
      'ConcurrentMod.dll': Buffer.from('fictional-concurrent')
    })
    const generated = manifests([staged], [staged.dependencyId])
    const request = makeRequest('install', staged, generated, (await harness.service.inspect()).revision)
    const firstExecution = harness.service.execute(request)
    await gateEntered

    const secondInstance = new ModDeploymentService({
      stagingRoot: harness.stagingRoot,
      pluginsRoot: harness.pluginsRoot,
      verifyStoppedState: async () => ({ processStopped: true, portClosed: true })
    })
    await expect(secondInstance.preview(request)).rejects.toThrow('MOD_DEPLOYMENT_BUSY')
    releaseGate()
    await expect(firstExecution).resolves.toMatchObject({ status: 'succeeded' })

    const sameRequestResults = await Promise.all([
      harness.service.execute(request),
      harness.service.execute(request)
    ])
    expect(sameRequestResults.every((receipt) => receipt.reused)).toBe(true)
  })

  it('rolls back byte-for-byte state after an atomic publication fault and preserves failed payload recovery', async () => {
    const fault: ModDeploymentFaultPhase = 'after-publish'
    const harness = await createHarness()
    const v1 = await stagePackage(harness.stagingRoot, 'Fictional-RollbackMod-1.0.0', {
      'RollbackMod.dll': Buffer.from('fictional-stable-content'),
      'config.json': Buffer.from('{"stable":true}\n')
    })
    const v2 = await stagePackage(harness.stagingRoot, 'Fictional-RollbackMod-2.0.0', {
      'RollbackMod.dll': Buffer.from('fictional-failed-update-content'),
      'config.json': Buffer.from('{"stable":false}\n')
    })
    const initial = await harness.service.inspect()
    await harness.service.execute(makeRequest('install', v1, manifests([v1], [v1.dependencyId]), initial.revision))
    const before = await harness.service.inspect()
    const beforeBytes = await treeDigest(harness.pluginsRoot)

    const faultingService = new ModDeploymentService({
      stagingRoot: harness.stagingRoot,
      pluginsRoot: harness.pluginsRoot,
      verifyStoppedState: async () => ({ processStopped: true, portClosed: true }),
      faultInjector: async (phase) => {
        if (phase === fault) throw new Error('fictional injected publication failure')
      }
    })
    const request = makeRequest('update', v2, manifests([v2], [v2.dependencyId]), before.revision)
    const receipt = await faultingService.execute(request)

    expect(receipt).toMatchObject({
      status: 'rolled-back',
      rollback: 'succeeded',
      previousRevision: before.revision,
      newRevision: before.revision,
      errorCode: 'MOD_DEPLOYMENT_EXECUTION_FAILED'
    })
    expect(await faultingService.inspect()).toEqual(before)
    expect(await treeDigest(harness.pluginsRoot)).toBe(beforeBytes)
    expect(await faultingService.execute(request)).toMatchObject({ status: 'rolled-back', reused: true })
    expect((await faultingService.previewCleanup()).candidates).toContainEqual({
      id: `failed-${request.requestId}`,
      kind: 'failed-publication'
    })
  })

  it('keeps preview available at the finite snapshot limit but refuses another publication', async () => {
    const harness = await createHarness({ maxSnapshots: 1 })
    const v1 = await stagePackage(harness.stagingRoot, 'Fictional-SnapshotMod-1.0.0', {
      'SnapshotMod.dll': Buffer.from('fictional-snapshot-v1')
    })
    const v2 = await stagePackage(harness.stagingRoot, 'Fictional-SnapshotMod-2.0.0', {
      'SnapshotMod.dll': Buffer.from('fictional-snapshot-v2')
    })
    let state = await harness.service.inspect()
    await harness.service.execute(makeRequest('install', v1, manifests([v1], [v1.dependencyId]), state.revision))
    state = await harness.service.inspect()
    const update = makeRequest('update', v2, manifests([v2], [v2.dependencyId]), state.revision)
    await expect(harness.service.preview(update)).resolves.toMatchObject({ snapshotsUsed: 1, snapshotLimit: 1 })
    await expect(harness.service.execute(update)).rejects.toThrow('MOD_DEPLOYMENT_SNAPSHOT_LIMIT')
    expect(await harness.service.inspect()).toEqual(state)
  })

  it('streams a multi-megabyte staged payload within the configured file and total bounds', async () => {
    const harness = await createHarness()
    const largeBytes = Buffer.alloc(8 * 1024 * 1024, 0x5a)
    const staged = await stagePackage(harness.stagingRoot, 'Fictional-LargeMod-1.0.0', {
      'LargeMod.dll': largeBytes
    })
    const generated = manifests([staged], [staged.dependencyId])
    const request = makeRequest('install', staged, generated, (await harness.service.inspect()).revision)
    const preview = await harness.service.preview(request)
    expect(preview).toMatchObject({ payloadFileCount: 1, payloadSizeBytes: largeBytes.length })
    const receipt = await harness.service.execute(request)
    expect(receipt).toMatchObject({ status: 'succeeded', payloadSizeBytes: largeBytes.length })
  })
})

async function createHarness(overrides: Partial<ModDeploymentServiceOptions> = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dyson-mod-deployment-'))
  temporaryRoots.push(root)
  const stagingRoot = join(root, 'staging')
  const pluginsRoot = join(root, 'plugins')
  await mkdir(stagingRoot)
  await mkdir(pluginsRoot)
  const service = new ModDeploymentService({
    stagingRoot,
    pluginsRoot,
    verifyStoppedState: async () => ({ processStopped: true, portClosed: true }),
    ...overrides
  })
  return { root, stagingRoot, pluginsRoot, service }
}

async function stagePackage(
  stagingRoot: string,
  dependencyId: string,
  contents: Readonly<Record<string, Buffer>>,
  options: {
    dependencies?: string[]
    clientRequirement?: 'required' | 'optional' | 'not-required'
  } = {}
): Promise<StagedFixturePackage> {
  const identity = parseThunderstoreDependency(dependencyId)
  const packageRoot = join(stagingRoot, dependencyId)
  const payloadRoot = join(packageRoot, 'payload')
  await mkdir(payloadRoot, { recursive: true })
  const files = Object.entries(contents).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([relativePath, bytes]) => ({
      relativePath,
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex')
    }))
  for (const [relativePath, bytes] of Object.entries(contents)) {
    const destination = join(payloadRoot, ...relativePath.split('/'))
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, bytes)
  }
  const stagedManifest: StagedModPackageManifest = {
    format: 'dyson-control-staged-mod-package',
    schemaVersion: 1,
    dependencyId,
    sourceId: identity.sourceId,
    version: identity.version,
    dependencies: [...(options.dependencies ?? [])].sort(),
    files
  }
  await writeFile(join(packageRoot, 'package-manifest.json'), `${JSON.stringify(stagedManifest, null, 2)}\n`)
  return {
    dependencyId,
    sha256: computeStagedModPayloadDigest(stagedManifest),
    dependencies: [...(options.dependencies ?? [])],
    serverRequired: true,
    clientRequirement: options.clientRequirement ?? 'required'
  }
}

function manifests(packages: readonly StagedFixturePackage[], roots: string[]): GeneratedModManifests {
  return generateModManifests({ roots, packages })
}

function platformLockFor(generated: GeneratedModManifests, inventoryRevision: string) {
  const requirements = partitionThunderstorePluginDependencies([
    'nebula-NebulaMultiplayerModApi-0.9.22'
  ]).platformRequirements
  return createModPlatformLock({
    serverLockSha256: generated.serverLockSha256,
    inventoryRevision,
    requirements
  })
}

function makeRequest(
  operation: ModDeploymentOperation,
  target: StagedFixturePackage,
  generated: GeneratedModManifests,
  expectedRevision: string,
  requestId = randomUUID()
): ModDeploymentRequest {
  return {
    requestId,
    operation,
    package: {
      dependencyId: target.dependencyId,
      version: parseThunderstoreDependency(target.dependencyId).version
    },
    manifest: {
      serverLock: generated.serverLock,
      clientParity: generated.clientParity,
      platformLock: createModPlatformLock({
        serverLockSha256: generated.serverLockSha256,
        inventoryRevision: null,
        requirements: []
      })
    },
    expectedRevision
  }
}

function isSymlinkPrivilegeError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'UNKNOWN')
}

async function treeDigest(root: string): Promise<string> {
  const hash = createHash('sha256')
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    for (const entry of entries) {
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      hash.update(`${entry.isDirectory() ? 'd' : 'f'}\u0000${relativePath}\n`, 'utf8')
      if (entry.isDirectory()) await visit(join(directory, entry.name), relativePath)
      else hash.update(await readFile(join(directory, entry.name)))
    }
  }
  await visit(root, '')
  return hash.digest('hex')
}

import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
import {
  HostMutationOperationCoordinatorError,
  type HostMutationOperationCoordinator,
  type HostMutationOperationOutcome,
  type HostMutationOperationRequest,
  type HostMutationOperationScope,
  type HostMutationRecoveryOperationCoordinator,
  type HostMutationRecoveryOperationRequest
} from '../host-mutation/operation-coordinator.js'

type HostMutationOperation<T> = (
  scope: HostMutationOperationScope
) => Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>

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
  it('reports a minimal ready recovery status without creating recovery evidence', async () => {
    const harness = await createHarness()
    const before = await treeDigest(harness.root)
    await expect(harness.service.recoveryStatus()).resolves.toEqual({
      phase: 'ready',
      requestId: null,
      operation: null,
      allowedDesired: []
    })
    expect(await treeDigest(harness.root)).toBe(before)
  })

  it('revalidates a verified platform lock for new execution but replays a terminal receipt immutably', async () => {
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
    expect(inventoryReads).toBe(4)
    await expect(harness.service.recoveryStatus()).resolves.toEqual({
      phase: 'ready', requestId: null, operation: null, allowedDesired: []
    })

    inventoryRevision = 'd'.repeat(64)
    await expect(harness.service.execute(request)).resolves.toMatchObject({ status: 'succeeded', reused: true })
    expect(inventoryReads).toBe(4)
  })

  it('rejects platform drift that occurs while a new execution waits for the host lease', async () => {
    let inventoryRevision = 'c'.repeat(64)
    let inventoryReads = 0
    const coordinator = new RecordingHostMutationCoordinator(() => {
      inventoryRevision = 'd'.repeat(64)
    })
    const harness = await createHarness({
      hostMutationCoordinator: coordinator,
      readPlatformInventory: async () => {
        inventoryReads += 1
        return {
          inventoryRevision,
          inventory: { nebula: '0.9.22', bepInEx: '5.4.17' }
        }
      }
    })
    const staged = await stagePackage(harness.stagingRoot, 'Fictional-LeaseDriftMod-1.0.0', {
      'LeaseDriftMod.dll': Buffer.from('fictional-lease-drift-mod')
    })
    const generated = manifests([staged], [staged.dependencyId])
    const request = makeRequest('install', staged, generated, (await harness.service.inspect()).revision)
    request.manifest.platformLock = platformLockFor(generated, inventoryRevision)
    const before = await treeDigest(harness.pluginsRoot)

    await expect(harness.service.execute(request))
      .rejects.toThrow('MOD_DEPLOYMENT_PLATFORM_INVENTORY_DRIFT')

    expect(inventoryReads).toBe(2)
    expect(await treeDigest(harness.pluginsRoot)).toBe(before)
    expect(coordinator.outcomes).toMatchObject([{ kind: 'throw', disposition: 'release' }])
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

  it('coordinates only new executions and releases the host lease for success and safe rejection', async () => {
    const coordinator = new RecordingHostMutationCoordinator()
    let stoppedChecks = 0
    const stoppedSignals: Array<AbortSignal | undefined> = []
    const harness = await createHarness({
      hostMutationCoordinator: coordinator,
      verifyStoppedState: async (signal) => {
        stoppedChecks += 1
        stoppedSignals.push(signal)
        return { processStopped: true, portClosed: true }
      }
    })
    const staged = await stagePackage(harness.stagingRoot, 'Fictional-HostLeaseMod-1.0.0', {
      'HostLeaseMod.dll': Buffer.from('fictional-host-lease-mod')
    })
    const generated = manifests([staged], [staged.dependencyId])
    const request = makeRequest('install', staged, generated, (await harness.service.inspect()).revision)

    await expect(harness.service.preview(request)).resolves.toMatchObject({ dryRun: true })
    expect(coordinator.requests).toEqual([])
    const receipt = await harness.service.execute(request)
    expect(receipt).toMatchObject({ status: 'succeeded', reused: false })
    expect(stoppedChecks).toBe(2)
    expect(stoppedSignals).toEqual([
      coordinator.scopes[0]!.signal,
      coordinator.scopes[0]!.signal
    ])
    expect(coordinator.requests).toEqual([{
      operation: 'mod-deployment-install',
      requestId: request.requestId
    }])
    expect(coordinator.outcomes).toEqual([
      expect.objectContaining({ kind: 'return', disposition: 'release' })
    ])

    await expect(harness.service.execute(structuredClone(request)))
      .resolves.toMatchObject({ status: 'succeeded', reused: true })
    expect(coordinator.requests).toHaveLength(1)

    const rejectedCoordinator = new RecordingHostMutationCoordinator()
    const rejectedHarness = await createHarness({
      hostMutationCoordinator: rejectedCoordinator,
      verifyStoppedState: async () => ({ processStopped: false, portClosed: true })
    })
    const rejectedPackage = await stagePackage(
      rejectedHarness.stagingRoot,
      'Fictional-HostLeaseRejectedMod-1.0.0',
      { 'HostLeaseRejectedMod.dll': Buffer.from('fictional-host-lease-rejected-mod') }
    )
    const rejectedManifests = manifests([rejectedPackage], [rejectedPackage.dependencyId])
    const rejectedRequest = makeRequest(
      'install',
      rejectedPackage,
      rejectedManifests,
      (await rejectedHarness.service.inspect()).revision
    )
    const beforeRejected = await treeDigest(rejectedHarness.pluginsRoot)

    await expect(rejectedHarness.service.execute(rejectedRequest))
      .rejects.toThrow('MOD_DEPLOYMENT_STOP_GATE_REJECTED')
    expect(rejectedCoordinator.outcomes).toEqual([
      expect.objectContaining({ kind: 'throw', disposition: 'release' })
    ])
    expect(await treeDigest(rejectedHarness.pluginsRoot)).toBe(beforeRejected)
  })

  it('fails closed without a host coordinator before stopped proof or live publication', async () => {
    let stoppedChecks = 0
    const recoveryCoordinator = new RecordingHostMutationRecoveryCoordinator()
    const harness = await createHarness()
    const service = new ModDeploymentService({
      stagingRoot: harness.stagingRoot,
      pluginsRoot: harness.pluginsRoot,
      hostMutationRecoveryCoordinator: recoveryCoordinator,
      verifyStoppedState: async () => {
        stoppedChecks += 1
        return { processStopped: true, portClosed: true }
      }
    })
    const staged = await stagePackage(harness.stagingRoot, 'Fictional-HostLeaseMissingMod-1.0.0', {
      'HostLeaseMissingMod.dll': Buffer.from('fictional-host-lease-missing-mod')
    })
    const generated = manifests([staged], [staged.dependencyId])
    const request = makeRequest('install', staged, generated, (await service.inspect()).revision)
    const before = await treeDigest(harness.pluginsRoot)

    await expect(service.preview(request)).resolves.toMatchObject({ dryRun: true })
    await expect(service.execute(request)).rejects.toThrow('MOD_DEPLOYMENT_HOST_LEASE_UNAVAILABLE')
    expect(stoppedChecks).toBe(0)
    expect(recoveryCoordinator.requests).toEqual([])
    expect(await treeDigest(harness.pluginsRoot)).toBe(before)
  })

  it('holds the local filesystem lock while host lease acquisition is pending', async () => {
    let hostLeaseEntered!: () => void
    let allowHostLease!: () => void
    const entered = new Promise<void>((resolvePromise) => { hostLeaseEntered = resolvePromise })
    const allowed = new Promise<void>((resolvePromise) => { allowHostLease = resolvePromise })
    const coordinator: HostMutationOperationCoordinator = {
      async runExclusive<T>(
        _request: HostMutationOperationRequest,
        operation: HostMutationOperation<T>
      ): Promise<T> {
        hostLeaseEntered()
        await allowed
        return unwrapHostMutationOutcome(await operation(activeHostMutationScope()))
      }
    }
    const harness = await createHarness({ hostMutationCoordinator: coordinator })
    const staged = await stagePackage(harness.stagingRoot, 'Fictional-HostLeaseOrderMod-1.0.0', {
      'HostLeaseOrderMod.dll': Buffer.from('fictional-host-lease-order-mod')
    })
    const generated = manifests([staged], [staged.dependencyId])
    const request = makeRequest('install', staged, generated, (await harness.service.inspect()).revision)
    const execution = harness.service.execute(request)
    await entered

    const secondInstance = new ModDeploymentService({
      stagingRoot: harness.stagingRoot,
      pluginsRoot: harness.pluginsRoot,
      verifyStoppedState: async () => ({ processStopped: true, portClosed: true })
    })
    await expect(secondInstance.preview(request)).rejects.toThrow('MOD_DEPLOYMENT_BUSY')
    allowHostLease()
    await expect(execution).resolves.toMatchObject({ status: 'succeeded' })
  })

  it('preserves an exact-content replacement transaction lock on normal release', async () => {
    const harness = await createHarness()
    const lockPath = join(harness.root, '.plugins.dyson-control', 'transaction.lock')
    const displacedPath = `${lockPath}.displaced`
    const service = new ModDeploymentService({
      stagingRoot: harness.stagingRoot,
      pluginsRoot: harness.pluginsRoot,
      hostMutationCoordinator: new RecordingHostMutationCoordinator(),
      verifyStoppedState: async () => ({ processStopped: true, portClosed: true }),
      faultInjector: async (phase) => {
        if (phase !== 'after-pending-built') return
        const exactContent = await readFile(lockPath)
        await rename(lockPath, displacedPath)
        await writeFile(lockPath, exactContent)
        throw new Error('fictional replacement after pending build')
      }
    })
    const staged = await stagePackage(harness.stagingRoot, 'Fictional-LockIdentity-1.0.0', {
      'LockIdentity.dll': Buffer.from('fictional-lock-identity')
    })
    const request = makeRequest(
      'install', staged, manifests([staged], [staged.dependencyId]), (await harness.service.inspect()).revision
    )

    await expect(service.execute(request)).rejects.toThrow('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    expect(existsSync(lockPath)).toBe(true)
    expect(existsSync(displacedPath)).toBe(true)
  })

  it('abandons the host lease for rollback-failed and unknown write outcomes', async () => {
    const coordinator = new RecordingHostMutationCoordinator()
    const harness = await createHarness({ hostMutationCoordinator: coordinator })
    const v1 = await stagePackage(harness.stagingRoot, 'Fictional-HostAbandonMod-1.0.0', {
      'HostAbandonMod.dll': Buffer.from('fictional-host-abandon-v1')
    })
    const v2 = await stagePackage(harness.stagingRoot, 'Fictional-HostAbandonMod-2.0.0', {
      'HostAbandonMod.dll': Buffer.from('fictional-host-abandon-v2')
    })
    const initial = await harness.service.inspect()
    await harness.service.execute(makeRequest('install', v1, manifests([v1], [v1.dependencyId]), initial.revision))
    coordinator.reset()

    const before = await harness.service.inspect()
    const request = makeRequest('update', v2, manifests([v2], [v2.dependencyId]), before.revision)
    const rollbackFailingService = new ModDeploymentService({
      stagingRoot: harness.stagingRoot,
      pluginsRoot: harness.pluginsRoot,
      hostMutationCoordinator: coordinator,
      verifyStoppedState: async () => ({ processStopped: true, portClosed: true }),
      faultInjector: async (phase) => {
        if (phase !== 'after-publish') return
        const snapshotId = `snapshot-${before.revision.slice(0, 16)}-${request.requestId}`
        await rm(join(harness.root, '.plugins.dyson-control', 'snapshots', snapshotId), {
          recursive: true,
          force: true
        })
        throw new Error('fictional rollback failure')
      }
    })

    await expect(rollbackFailingService.execute(request)).resolves.toMatchObject({
      status: 'rollback-failed',
      rollback: 'failed',
      errorCode: 'MOD_DEPLOYMENT_ROLLBACK_FAILED'
    })
    await expect(rollbackFailingService.recoveryStatus())
      .rejects.toThrow('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    expect(coordinator.outcomes).toEqual([
      expect.objectContaining({ kind: 'return', disposition: 'abandon' })
    ])

    const unknownCoordinator = new RecordingHostMutationCoordinator()
    const unknownHarness = await createHarness({
      hostMutationCoordinator: unknownCoordinator,
      faultInjector: async (phase) => {
        if (phase === 'after-pending-built') throw new Error('fictional unknown write failure')
      }
    })
    const unknownPackage = await stagePackage(
      unknownHarness.stagingRoot,
      'Fictional-UnknownWriteMod-1.0.0',
      { 'UnknownWriteMod.dll': Buffer.from('fictional-unknown-write-mod') }
    )
    const unknownManifests = manifests([unknownPackage], [unknownPackage.dependencyId])
    const unknownRequest = makeRequest(
      'install',
      unknownPackage,
      unknownManifests,
      (await unknownHarness.service.inspect()).revision
    )
    const beforeUnknown = await treeDigest(unknownHarness.pluginsRoot)

    await expect(unknownHarness.service.execute(unknownRequest))
      .rejects.toThrow('MOD_DEPLOYMENT_EXECUTION_FAILED')
    expect(unknownCoordinator.outcomes).toEqual([
      expect.objectContaining({ kind: 'throw', disposition: 'abandon' })
    ])
    expect(await treeDigest(unknownHarness.pluginsRoot)).toBe(beforeUnknown)
  })

  it.each([
    ['HOST_MUTATION_LEASE_BUSY', 'MOD_DEPLOYMENT_HOST_LEASE_BUSY'],
    ['HOST_MUTATION_LEASE_DIRTY', 'MOD_DEPLOYMENT_HOST_LEASE_DIRTY'],
    ['HOST_MUTATION_LEASE_RECOVERY_REQUIRED', 'MOD_DEPLOYMENT_HOST_LEASE_RECOVERY_REQUIRED'],
    ['HOST_MUTATION_LEASE_LOST', 'MOD_DEPLOYMENT_HOST_LEASE_LOST'],
    ['HOST_MUTATION_LEASE_UNAVAILABLE', 'MOD_DEPLOYMENT_HOST_LEASE_UNAVAILABLE']
  ] as const)('maps %s before stopped proof or live publication', async (coordinatorCode, deploymentCode) => {
    let stoppedChecks = 0
    const coordinator: HostMutationOperationCoordinator = {
      async runExclusive(): Promise<never> {
        throw new HostMutationOperationCoordinatorError(coordinatorCode)
      }
    }
    const harness = await createHarness({
      hostMutationCoordinator: coordinator,
      verifyStoppedState: async () => {
        stoppedChecks += 1
        return { processStopped: true, portClosed: true }
      }
    })
    const staged = await stagePackage(harness.stagingRoot, 'Fictional-HostLeaseFailureMod-1.0.0', {
      'HostLeaseFailureMod.dll': Buffer.from('fictional-host-lease-failure-mod')
    })
    const generated = manifests([staged], [staged.dependencyId])
    const request = makeRequest('install', staged, generated, (await harness.service.inspect()).revision)
    const before = await treeDigest(harness.pluginsRoot)

    await expect(harness.service.execute(request)).rejects.toThrow(deploymentCode)
    expect(stoppedChecks).toBe(0)
    expect(await treeDigest(harness.pluginsRoot)).toBe(before)
  })

  it('maps lease loss after the second stopped proof and before live publication', async () => {
    let activeAssertions = 0
    let stoppedChecks = 0
    const coordinator: HostMutationOperationCoordinator = {
      async runExclusive<T>(
        _request: HostMutationOperationRequest,
        operation: HostMutationOperation<T>
      ): Promise<T> {
        const scope = activeHostMutationScope(() => {
          activeAssertions += 1
          if (stoppedChecks === 2) {
            throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_LOST')
          }
        })
        return unwrapHostMutationOutcome(await operation(scope))
      }
    }
    const harness = await createHarness({
      hostMutationCoordinator: coordinator,
      verifyStoppedState: async (signal) => {
        expect(signal).toBeInstanceOf(AbortSignal)
        stoppedChecks += 1
        return { processStopped: true, portClosed: true }
      }
    })
    const staged = await stagePackage(harness.stagingRoot, 'Fictional-HostLeaseLostMod-1.0.0', {
      'HostLeaseLostMod.dll': Buffer.from('fictional-host-lease-lost-mod')
    })
    const generated = manifests([staged], [staged.dependencyId])
    const request = makeRequest('install', staged, generated, (await harness.service.inspect()).revision)
    const before = await treeDigest(harness.pluginsRoot)

    await expect(harness.service.execute(request)).rejects.toThrow('MOD_DEPLOYMENT_HOST_LEASE_LOST')
    expect(stoppedChecks).toBe(2)
    expect(activeAssertions).toBeGreaterThanOrEqual(7)
    expect(await treeDigest(harness.pluginsRoot)).toBe(before)
  })

  it('preserves the transaction lock when lease loss leaves an initial journal pending', async () => {
    let lost = false
    const coordinator: HostMutationOperationCoordinator = {
      async runExclusive<T>(
        _request: HostMutationOperationRequest,
        operation: HostMutationOperation<T>
      ): Promise<T> {
        return unwrapHostMutationOutcome(await operation(activeHostMutationScope(() => {
          if (lost) throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_LOST')
        })))
      }
    }
    const harness = await createHarness({
      hostMutationCoordinator: coordinator,
      faultInjector: async (phase) => {
        if (phase === 'after-journal-pending-synced') lost = true
      }
    })
    const staged = await stagePackage(harness.stagingRoot, 'Fictional-InitialJournalLost-1.0.0', {
      'InitialJournalLost.dll': Buffer.from('initial-journal-lost')
    })
    const request = makeRequest(
      'install', staged, manifests([staged], [staged.dependencyId]), (await harness.service.inspect()).revision
    )
    await expect(harness.service.execute(request)).rejects.toThrow('MOD_DEPLOYMENT_HOST_LEASE_LOST')

    const controlRoot = join(harness.root, '.plugins.dyson-control')
    expect(existsSync(join(controlRoot, 'transaction.lock'))).toBe(true)
    expect(existsSync(join(controlRoot, 'journals', `${request.requestId}.pending`))).toBe(true)
    const restarted = new ModDeploymentService({
      stagingRoot: harness.stagingRoot,
      pluginsRoot: harness.pluginsRoot,
      verifyStoppedState: async () => ({ processStopped: true, portClosed: true })
    })
    await expect(restarted.reconcileInterrupted(
      request.requestId, 'previous', activeHostMutationScope()
    )).resolves.toMatchObject({ status: 'rolled-back' })
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
      hostMutationCoordinator: new RecordingHostMutationCoordinator(),
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

    const recoveryCoordinator = new RecordingHostMutationRecoveryCoordinator()
    const replayService = new ModDeploymentService({
      stagingRoot: harness.stagingRoot,
      pluginsRoot: harness.pluginsRoot,
      hostMutationRecoveryCoordinator: recoveryCoordinator,
      verifyStoppedState: async () => ({ processStopped: true, portClosed: true })
    })
    const terminalEvidence = await treeDigest(harness.root)
    await expect(replayService.recoverInterrupted(request.requestId, 'candidate')).rejects.toMatchObject({
      code: 'MOD_DEPLOYMENT_RECOVERY_TARGET_NOT_ALLOWED'
    })
    expect(recoveryCoordinator.requests).toEqual([])
    expect(recoveryCoordinator.outcomes).toEqual([])
    expect(await treeDigest(harness.root)).toBe(terminalEvidence)
  })

  it.each([
    ['after-journal-pending-synced', 'previous', 'rolled-back', '1.0.0', ['previous']],
    ['after-snapshot', 'previous', 'rolled-back', '1.0.0', ['previous']],
    ['after-publish', 'candidate', 'succeeded', '2.0.0', ['candidate', 'previous']],
    ['after-receipt-pending-synced', 'candidate', 'succeeded', '2.0.0', ['candidate']],
    ['after-rollback-receipt-pending-synced', 'previous', 'rolled-back', '1.0.0', ['previous']],
    ['after-rollback-failed-move', 'previous', 'rolled-back', '1.0.0', ['previous']],
    ['after-rollback-restore', 'previous', 'rolled-back', '1.0.0', ['previous']]
  ] as const)(
    'recovers byte-exactly after a hard process exit at %s',
    async (crashPhase, desired, expectedStatus, expectedVersion, allowedDesired) => {
      const harness = await createHarness()
      const dependencyName = `HardExit_${crashPhase.replaceAll('-', '_')}`
      const v1 = await stagePackage(harness.stagingRoot, `Fictional-${dependencyName}-1.0.0`, {
        'HardExit.dll': Buffer.from(`stable-${crashPhase}`),
        'config.json': Buffer.from('{"version":1}\n')
      })
      const v2 = await stagePackage(harness.stagingRoot, `Fictional-${dependencyName}-2.0.0`, {
        'HardExit.dll': Buffer.from(`candidate-${crashPhase}`),
        'config.json': Buffer.from('{"version":2}\n')
      })
      await harness.service.execute(makeRequest(
        'install', v1, manifests([v1], [v1.dependencyId]), (await harness.service.inspect()).revision
      ))
      const before = await harness.service.inspect()
      const previousDigest = await treeDigest(harness.pluginsRoot)
      const request = makeRequest('update', v2, manifests([v2], [v2.dependencyId]), before.revision)
      const requestPath = join(harness.root, `hard-exit-${request.requestId}.json`)
      await writeFile(requestPath, `${JSON.stringify(request)}\n`, 'utf8')

      await expect(runHardExitFixture(harness, requestPath, crashPhase)).resolves.toBe(86)

      const restarted = new ModDeploymentService({
        stagingRoot: harness.stagingRoot,
        pluginsRoot: harness.pluginsRoot,
        hostMutationCoordinator: new RecordingHostMutationCoordinator(),
        verifyStoppedState: async () => ({ processStopped: true, portClosed: true })
      })
      const evidenceBeforeReplay = await treeDigest(harness.root)
      const recoveryStatus = await restarted.recoveryStatus()
      expect(recoveryStatus).toEqual({
        phase: 'recovery-required',
        requestId: request.requestId,
        operation: 'update',
        allowedDesired
      })
      expect(Object.keys(recoveryStatus).sort()).toEqual([
        'allowedDesired', 'operation', 'phase', 'requestId'
      ])
      expect(JSON.stringify(recoveryStatus)).not.toMatch(/fingerprint|manifest|plugins|staging|snapshot/i)
      expect(await treeDigest(harness.root)).toBe(evidenceBeforeReplay)
      await expect(restarted.execute(request)).rejects.toThrow('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
      expect(await treeDigest(harness.root)).toBe(evidenceBeforeReplay)

      const candidateDigest = crashPhase === 'after-publish' || crashPhase === 'after-receipt-pending-synced'
        ? await treeDigest(harness.pluginsRoot)
        : null
      if (crashPhase === 'after-snapshot') {
        const snapshotRoot = join(
          harness.root,
          '.plugins.dyson-control',
          'snapshots',
          `snapshot-${before.revision.slice(0, 16)}-${request.requestId}`
        )
        const lostScope = activeHostMutationScope(() => {
          if (existsSync(harness.pluginsRoot) && !existsSync(snapshotRoot)) {
            throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_LOST')
          }
        })
        await expect(restarted.reconcileInterrupted(request.requestId, desired, lostScope))
          .rejects.toMatchObject({ code: 'HOST_MUTATION_LEASE_LOST' })
        expect(await treeDigest(harness.pluginsRoot)).toBe(previousDigest)
        expect(existsSync(join(harness.root, '.plugins.dyson-control', 'transaction.lock'))).toBe(true)
        expect(existsSync(join(
          harness.root, '.plugins.dyson-control', 'journals', `${request.requestId}.json`
        ))).toBe(true)
      }
      const receipt = await restarted.reconcileInterrupted(request.requestId, desired, activeHostMutationScope())
      expect(receipt).toMatchObject({ status: expectedStatus, previousRevision: before.revision })
      expect(await treeDigest(harness.pluginsRoot)).toBe(
        expectedStatus === 'succeeded' ? candidateDigest : previousDigest
      )
      expect((await restarted.inspect()).packages).toEqual([
        expect.objectContaining({ version: expectedVersion, enabled: true })
      ])
      const controlRoot = join(harness.root, '.plugins.dyson-control')
      expect(existsSync(join(controlRoot, 'transaction.lock'))).toBe(false)
      expect(existsSync(join(controlRoot, 'journals', `${request.requestId}.json`))).toBe(false)
    },
    15_000
  )

  it('rejects an unsupported durable recovery target before acquiring the recovery capability or writing', async () => {
    const harness = await createHarness()
    const v1 = await stagePackage(harness.stagingRoot, 'Fictional-WrongRecoveryTarget-1.0.0', {
      'WrongRecoveryTarget.dll': Buffer.from('stable-wrong-recovery-target')
    })
    const v2 = await stagePackage(harness.stagingRoot, 'Fictional-WrongRecoveryTarget-2.0.0', {
      'WrongRecoveryTarget.dll': Buffer.from('candidate-wrong-recovery-target')
    })
    await harness.service.execute(makeRequest(
      'install', v1, manifests([v1], [v1.dependencyId]), (await harness.service.inspect()).revision
    ))
    const before = await harness.service.inspect()
    const request = makeRequest('update', v2, manifests([v2], [v2.dependencyId]), before.revision)
    const requestPath = join(harness.root, `wrong-recovery-target-${request.requestId}.json`)
    await writeFile(requestPath, `${JSON.stringify(request)}\n`, 'utf8')
    await expect(runHardExitFixture(harness, requestPath, 'after-snapshot')).resolves.toBe(86)

    const recoveryCoordinator = new RecordingHostMutationRecoveryCoordinator()
    const restarted = new ModDeploymentService({
      stagingRoot: harness.stagingRoot,
      pluginsRoot: harness.pluginsRoot,
      hostMutationRecoveryCoordinator: recoveryCoordinator,
      verifyStoppedState: async () => ({ processStopped: true, portClosed: true })
    })
    await expect(restarted.recoveryStatus()).resolves.toEqual({
      phase: 'recovery-required',
      requestId: request.requestId,
      operation: 'update',
      allowedDesired: ['previous']
    })
    const durableEvidence = await treeDigest(harness.root)

    await expect(restarted.recoverInterrupted(request.requestId, 'candidate')).rejects.toMatchObject({
      code: 'MOD_DEPLOYMENT_RECOVERY_TARGET_NOT_ALLOWED'
    })
    expect(recoveryCoordinator.requests).toEqual([])
    expect(recoveryCoordinator.outcomes).toEqual([])
    expect(await treeDigest(harness.root)).toBe(durableEvidence)
    await expect(restarted.recoveryStatus()).resolves.toEqual({
      phase: 'recovery-required',
      requestId: request.requestId,
      operation: 'update',
      allowedDesired: ['previous']
    })
  }, 15_000)

  it('resumes a fully written journal pending after lease loss and converges on retry', async () => {
    const harness = await createHarness()
    const v1 = await stagePackage(harness.stagingRoot, 'Fictional-JournalPendingLost-1.0.0', {
      'JournalPendingLost.dll': Buffer.from('stable-journal-pending-lost')
    })
    const v2 = await stagePackage(harness.stagingRoot, 'Fictional-JournalPendingLost-2.0.0', {
      'JournalPendingLost.dll': Buffer.from('candidate-journal-pending-lost')
    })
    await harness.service.execute(makeRequest(
      'install', v1, manifests([v1], [v1.dependencyId]), (await harness.service.inspect()).revision
    ))
    const before = await harness.service.inspect()
    const beforeDigest = await treeDigest(harness.pluginsRoot)
    const request = makeRequest('update', v2, manifests([v2], [v2.dependencyId]), before.revision)
    const requestPath = join(harness.root, `journal-pending-lost-${request.requestId}.json`)
    await writeFile(requestPath, `${JSON.stringify(request)}\n`, 'utf8')
    await expect(runHardExitFixture(harness, requestPath, 'after-publish')).resolves.toBe(86)

    let loseLease = false
    const faulting = new ModDeploymentService({
      stagingRoot: harness.stagingRoot,
      pluginsRoot: harness.pluginsRoot,
      verifyStoppedState: async () => ({ processStopped: true, portClosed: true }),
      faultInjector: async (phase) => {
        if (phase === 'after-journal-pending-synced') loseLease = true
      }
    })
    const lostScope = activeHostMutationScope(() => {
      if (loseLease) throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_LOST')
    })
    await expect(faulting.reconcileInterrupted(request.requestId, 'previous', lostScope))
      .rejects.toMatchObject({ code: 'HOST_MUTATION_LEASE_LOST' })
    const journalRoot = join(harness.root, '.plugins.dyson-control', 'journals')
    expect(existsSync(join(journalRoot, `${request.requestId}.json`))).toBe(true)
    expect(existsSync(join(journalRoot, `${request.requestId}.pending`))).toBe(true)

    const restarted = new ModDeploymentService({
      stagingRoot: harness.stagingRoot,
      pluginsRoot: harness.pluginsRoot,
      verifyStoppedState: async () => ({ processStopped: true, portClosed: true })
    })
    await expect(restarted.reconcileInterrupted(
      request.requestId, 'previous', activeHostMutationScope()
    )).resolves.toMatchObject({ status: 'rolled-back' })
    expect(await treeDigest(harness.pluginsRoot)).toBe(beforeDigest)
  })

  it('keeps its transaction lock when lease loss is observed after the final identity read', async () => {
    const harness = await createHarness()
    const staged = await stagePackage(harness.stagingRoot, 'Fictional-FinalLockLease-1.0.0', {
      'FinalLockLease.dll': Buffer.from('final-lock-lease')
    })
    const request = makeRequest(
      'install', staged, manifests([staged], [staged.dependencyId]), (await harness.service.inspect()).revision
    )
    const requestPath = join(harness.root, `final-lock-lease-${request.requestId}.json`)
    await writeFile(requestPath, `${JSON.stringify(request)}\n`, 'utf8')
    await expect(runHardExitFixture(harness, requestPath, 'after-publish')).resolves.toBe(86)

    const controlRoot = join(harness.root, '.plugins.dyson-control')
    const journalPath = join(controlRoot, 'journals', `${request.requestId}.json`)
    const lockPath = join(controlRoot, 'transaction.lock')
    let terminalCleanupAssertions = 0
    const loseAtFinalLockCheck = activeHostMutationScope(() => {
      if (!existsSync(journalPath)) {
        terminalCleanupAssertions += 1
        if (terminalCleanupAssertions === 3) {
          throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_LOST')
        }
      }
    })
    const restarted = new ModDeploymentService({
      stagingRoot: harness.stagingRoot,
      pluginsRoot: harness.pluginsRoot,
      verifyStoppedState: async () => ({ processStopped: true, portClosed: true })
    })
    await expect(restarted.reconcileInterrupted(request.requestId, 'candidate', loseAtFinalLockCheck))
      .rejects.toMatchObject({ code: 'HOST_MUTATION_LEASE_LOST' })
    expect(terminalCleanupAssertions).toBe(3)
    expect(existsSync(lockPath)).toBe(true)
    await expect(restarted.recoveryStatus()).resolves.toEqual({
      phase: 'recovery-required',
      requestId: request.requestId,
      operation: 'install',
      allowedDesired: ['candidate']
    })

    await expect(restarted.reconcileInterrupted(
      request.requestId, 'candidate', activeHostMutationScope()
    )).resolves.toMatchObject({ status: 'succeeded', reused: true })
    await expect(restarted.recoveryStatus()).resolves.toEqual({
      phase: 'ready', requestId: null, operation: null, allowedDesired: []
    })
    expect(existsSync(lockPath)).toBe(false)
    await expect(restarted.reconcileInterrupted(
      request.requestId, 'candidate', activeHostMutationScope()
    )).resolves.toMatchObject({ status: 'succeeded', reused: true })
  })

  it('derives the exact recovery lease binding from durable evidence and releases only after terminal replay', async () => {
    const harness = await createHarness()
    const staged = await stagePackage(harness.stagingRoot, 'Fictional-RecoveryCoordinator-1.0.0', {
      'RecoveryCoordinator.dll': Buffer.from('recovery-coordinator')
    })
    const request = makeRequest(
      'install', staged, manifests([staged], [staged.dependencyId]), (await harness.service.inspect()).revision
    )
    const requestPath = join(harness.root, `recovery-coordinator-${request.requestId}.json`)
    await writeFile(requestPath, `${JSON.stringify(request)}\n`, 'utf8')
    await expect(runHardExitFixture(harness, requestPath, 'after-publish')).resolves.toBe(86)

    const recoveryCoordinator = new RecordingHostMutationRecoveryCoordinator()
    const restarted = new ModDeploymentService({
      stagingRoot: harness.stagingRoot,
      pluginsRoot: harness.pluginsRoot,
      hostMutationRecoveryCoordinator: recoveryCoordinator,
      verifyStoppedState: async () => ({ processStopped: true, portClosed: true })
    })
    recoveryCoordinator.assertActive = () => {
      throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_LOST')
    }
    await expect(restarted.recoverInterrupted(request.requestId, 'candidate'))
      .rejects.toThrow('MOD_DEPLOYMENT_HOST_LEASE_LOST')
    recoveryCoordinator.assertActive = () => {}
    await expect(restarted.recoverInterrupted(request.requestId, 'candidate'))
      .resolves.toMatchObject({ status: 'succeeded' })
    expect(recoveryCoordinator.requests).toEqual([
      {
        expectedOperation: 'mod-deployment-install',
        expectedRequestId: request.requestId
      },
      {
        expectedOperation: 'mod-deployment-install',
        expectedRequestId: request.requestId
      }
    ])
    expect(recoveryCoordinator.outcomes).toEqual([
      expect.objectContaining({ kind: 'return', disposition: 'release' })
    ])

    recoveryCoordinator.recoveryNotRequired = true
    await expect(restarted.recoverInterrupted(request.requestId, 'candidate'))
      .resolves.toMatchObject({ status: 'succeeded', reused: true })
  })

  it('does not acquire the recovery capability for a journal pending with a foreign binding', async () => {
    const harness = await createHarness()
    const staged = await stagePackage(harness.stagingRoot, 'Fictional-ForeignJournalPending-1.0.0', {
      'ForeignJournalPending.dll': Buffer.from('foreign-journal-pending')
    })
    const request = makeRequest(
      'install', staged, manifests([staged], [staged.dependencyId]), (await harness.service.inspect()).revision
    )
    const requestPath = join(harness.root, `foreign-journal-pending-${request.requestId}.json`)
    await writeFile(requestPath, `${JSON.stringify(request)}\n`, 'utf8')
    await expect(runHardExitFixture(harness, requestPath, 'after-journal-pending-synced')).resolves.toBe(86)

    const pendingPath = join(
      harness.root, '.plugins.dyson-control', 'journals', `${request.requestId}.pending`
    )
    const pending = JSON.parse(await readFile(pendingPath, 'utf8')) as Record<string, unknown>
    pending.fingerprint = 'f'.repeat(64)
    await writeFile(pendingPath, `${JSON.stringify(pending, null, 2)}\n`, 'utf8')
    const evidence = await treeDigest(harness.root)
    const recoveryCoordinator = new RecordingHostMutationRecoveryCoordinator()
    const restarted = new ModDeploymentService({
      stagingRoot: harness.stagingRoot,
      pluginsRoot: harness.pluginsRoot,
      hostMutationRecoveryCoordinator: recoveryCoordinator,
      verifyStoppedState: async () => ({ processStopped: true, portClosed: true })
    })

    await expect(restarted.recoveryStatus()).rejects.toThrow('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    expect(await treeDigest(harness.root)).toBe(evidence)
    await expect(restarted.recoverInterrupted(request.requestId, 'previous'))
      .rejects.toThrow('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    expect(recoveryCoordinator.requests).toEqual([])
    expect(await treeDigest(harness.root)).toBe(evidence)
  })

  it('preserves a foreign receipt pending instead of publishing it as a terminal result', async () => {
    const harness = await createHarness()
    const staged = await stagePackage(harness.stagingRoot, 'Fictional-ForeignReceiptPending-1.0.0', {
      'ForeignReceiptPending.dll': Buffer.from('foreign-receipt-pending')
    })
    const request = makeRequest(
      'install', staged, manifests([staged], [staged.dependencyId]), (await harness.service.inspect()).revision
    )
    const requestPath = join(harness.root, `foreign-receipt-pending-${request.requestId}.json`)
    await writeFile(requestPath, `${JSON.stringify(request)}\n`, 'utf8')
    await expect(runHardExitFixture(harness, requestPath, 'after-receipt-pending-synced')).resolves.toBe(86)

    const pendingPath = join(
      harness.root, '.plugins.dyson-control', 'receipts', `${request.requestId}.pending`
    )
    const pending = JSON.parse(await readFile(pendingPath, 'utf8')) as Record<string, unknown>
    pending.fingerprint = 'f'.repeat(64)
    await writeFile(pendingPath, `${JSON.stringify(pending, null, 2)}\n`, 'utf8')
    const evidence = await treeDigest(harness.root)
    const restarted = new ModDeploymentService({
      stagingRoot: harness.stagingRoot,
      pluginsRoot: harness.pluginsRoot,
      verifyStoppedState: async () => ({ processStopped: true, portClosed: true })
    })

    await expect(restarted.reconcileInterrupted(
      request.requestId, 'candidate', activeHostMutationScope()
    )).rejects.toThrow('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    expect(await treeDigest(harness.root)).toBe(evidence)
  })

  it('recovers a committed-state receipt repair interrupted after its pending file was synced', async () => {
    const harness = await createHarness()
    const staged = await stagePackage(harness.stagingRoot, 'Fictional-ReceiptRepairPending-1.0.0', {
      'ReceiptRepairPending.dll': Buffer.from('receipt-repair-pending')
    })
    const request = makeRequest(
      'install', staged, manifests([staged], [staged.dependencyId]), (await harness.service.inspect()).revision
    )
    await harness.service.execute(request)
    const controlRoot = join(harness.root, '.plugins.dyson-control')
    await rm(join(controlRoot, 'receipts', `${request.requestId}.json`))

    const interruptedRepair = new ModDeploymentService({
      stagingRoot: harness.stagingRoot,
      pluginsRoot: harness.pluginsRoot,
      hostMutationCoordinator: new RecordingHostMutationCoordinator(),
      verifyStoppedState: async () => ({ processStopped: true, portClosed: true }),
      faultInjector: async (phase) => {
        if (phase === 'after-receipt-pending-synced') throw new Error('fictional receipt repair interruption')
      }
    })
    await expect(interruptedRepair.execute(request)).rejects.toThrow('fictional receipt repair interruption')
    expect(existsSync(join(controlRoot, 'transaction.lock'))).toBe(true)
    expect(existsSync(join(controlRoot, 'receipts', `${request.requestId}.pending`))).toBe(true)

    const restarted = new ModDeploymentService({
      stagingRoot: harness.stagingRoot,
      pluginsRoot: harness.pluginsRoot,
      verifyStoppedState: async () => ({ processStopped: true, portClosed: true })
    })
    await expect(restarted.reconcileInterrupted(
      request.requestId, 'candidate', activeHostMutationScope()
    )).resolves.toMatchObject({ status: 'succeeded', reused: true })
    expect(existsSync(join(controlRoot, 'transaction.lock'))).toBe(false)
  })

  it('performs zero writes when interrupted recovery evidence contains foreign bytes', async () => {
    const harness = await createHarness()
    const v1 = await stagePackage(harness.stagingRoot, 'Fictional-ForeignRecovery-1.0.0', {
      'ForeignRecovery.dll': Buffer.from('stable-foreign-recovery')
    })
    const v2 = await stagePackage(harness.stagingRoot, 'Fictional-ForeignRecovery-2.0.0', {
      'ForeignRecovery.dll': Buffer.from('candidate-foreign-recovery')
    })
    await harness.service.execute(makeRequest(
      'install', v1, manifests([v1], [v1.dependencyId]), (await harness.service.inspect()).revision
    ))
    const before = await harness.service.inspect()
    const request = makeRequest('update', v2, manifests([v2], [v2.dependencyId]), before.revision)
    const requestPath = join(harness.root, `foreign-${request.requestId}.json`)
    await writeFile(requestPath, `${JSON.stringify(request)}\n`, 'utf8')
    await expect(runHardExitFixture(harness, requestPath, 'after-snapshot')).resolves.toBe(86)

    const pendingRoot = join(harness.root, '.plugins.dyson-control', 'pending', request.requestId)
    const payloadDirectory = (await readdir(pendingRoot, { withFileTypes: true }))
      .find((entry) => entry.isDirectory())
    expect(payloadDirectory).toBeDefined()
    await writeFile(join(pendingRoot, payloadDirectory!.name, 'ForeignRecovery.dll'), 'foreign-bytes')
    const evidence = await treeDigest(harness.root)
    const restarted = new ModDeploymentService({
      stagingRoot: harness.stagingRoot,
      pluginsRoot: harness.pluginsRoot,
      hostMutationCoordinator: new RecordingHostMutationCoordinator(),
      verifyStoppedState: async () => ({ processStopped: true, portClosed: true })
    })

    await expect(restarted.reconcileInterrupted(
      request.requestId, 'previous', activeHostMutationScope()
    )).rejects.toThrow('MOD_DEPLOYMENT_RECOVERY_REQUIRED')
    expect(await treeDigest(harness.root)).toBe(evidence)
    expect(existsSync(join(harness.root, '.plugins.dyson-control', 'transaction.lock'))).toBe(true)
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
    hostMutationCoordinator: new RecordingHostMutationCoordinator(),
    verifyStoppedState: async () => ({ processStopped: true, portClosed: true }),
    ...overrides
  })
  return { root, stagingRoot, pluginsRoot, service }
}

async function runHardExitFixture(
  harness: Harness,
  requestPath: string,
  crashPhase: ModDeploymentFaultPhase | 'after-rollback-receipt-pending-synced'
): Promise<number | null> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  const apiRoot = join(moduleDirectory, '..', '..')
  const fixturePath = join(moduleDirectory, 'deployment-hard-exit.fixture.ts')
  return await new Promise<number | null>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [
      '--import', 'tsx', fixturePath,
      harness.stagingRoot, harness.pluginsRoot, requestPath, crashPhase
    ], {
      cwd: apiRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 86) resolvePromise(code)
      else reject(new Error(`hard-exit fixture failed with ${String(code)}: ${stderr.slice(0, 2_000)}`))
    })
  })
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

class RecordingHostMutationCoordinator implements HostMutationOperationCoordinator {
  readonly requests: HostMutationOperationRequest[] = []
  readonly outcomes: HostMutationOperationOutcome<unknown>[] = []
  readonly scopes: HostMutationOperationScope[] = []

  constructor(private readonly beforeEnter: (() => void | Promise<void>) | null = null) {}

  async runExclusive<T>(
    request: HostMutationOperationRequest,
    operation: HostMutationOperation<T>
  ): Promise<T> {
    this.requests.push({ ...request })
    await this.beforeEnter?.()
    const scope = activeHostMutationScope()
    this.scopes.push(scope)
    const outcome = await operation(scope)
    this.outcomes.push(outcome as HostMutationOperationOutcome<unknown>)
    return unwrapHostMutationOutcome(outcome)
  }

  reset(): void {
    this.requests.length = 0
    this.outcomes.length = 0
    this.scopes.length = 0
  }
}

class RecordingHostMutationRecoveryCoordinator implements HostMutationRecoveryOperationCoordinator {
  readonly requests: HostMutationRecoveryOperationRequest[] = []
  readonly outcomes: HostMutationOperationOutcome<unknown>[] = []
  recoveryNotRequired = false
  assertActive: () => void = () => {}

  async runRecoveryExclusive<T>(
    request: HostMutationRecoveryOperationRequest,
    operation: HostMutationOperation<T>
  ): Promise<T> {
    this.requests.push({ ...request })
    if (this.recoveryNotRequired) {
      throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_RECOVERY_NOT_REQUIRED')
    }
    const outcome = await operation(activeHostMutationScope(this.assertActive))
    this.outcomes.push(outcome as HostMutationOperationOutcome<unknown>)
    return unwrapHostMutationOutcome(outcome)
  }
}

function activeHostMutationScope(assertActive: () => void = () => {}): HostMutationOperationScope {
  return {
    signal: new AbortController().signal,
    assertActive,
    toPowerShellBorrowArguments: () => []
  }
}

function unwrapHostMutationOutcome<T>(outcome: HostMutationOperationOutcome<T>): T {
  if (outcome.kind === 'return') return outcome.value
  throw outcome.error
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

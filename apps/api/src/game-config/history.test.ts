import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectGameConfiguration, type GameConfigFiles } from './planner.js'
import {
  HostMutationOperationCoordinatorError,
  type HostMutationOperationCoordinator,
  type HostMutationOperationOutcome,
  type HostMutationOperationRequest,
  type HostMutationOperationScope
} from '../host-mutation/operation-coordinator.js'
import {
  GameConfigHistoryError,
  GameConfigHistoryService,
  type GameConfigHistoryLimits,
  type GameConfigHistoryTestHooks,
  type GameConfigStopProofValidator,
  type RestoreGameConfigurationRequest
} from './history.js'

type HostMutationOperation<T> = (
  scope: HostMutationOperationScope
) => Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>

const managed = {
  nebula: {
    name: 'nebula.cfg',
    initial: '[Nebula - Settings]\r\nAutoPauseEnabled = true\r\nServerPassword = fictional-history-old\r\nHostPort = 8469\r\n'
  },
  galaxy: {
    name: 'nebulaGameDescSettings.cfg',
    initial: '[Basic]\nstarCount = 64\nresourceMultiplier = 1\n\n[General]\nisPeaceMode = false\n'
  },
  bepinex: {
    name: 'BepInEx.cfg',
    initial: '[Logging.Console]\r\nEnabled = true\r\n'
  },
  bridge: {
    name: 'io.github.mikutea.dyson-control-bridge.cfg',
    initial: '[Bridge]\nEnabled = false\n\n[Timing]\nPollMilliseconds = 250\n'
  }
} as const

const temporaryRoots: string[] = []

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    await rm(temporaryRoots.pop()!, { recursive: true, force: true })
  }
})

describe('game configuration snapshot history', () => {
  it('captures deterministic manifests and exposes list, detail, and redacted diffs', async () => {
    const firstRoot = await seedRoot()
    const secondRoot = await seedRoot()
    const ids = [uuid(1), uuid(2)]
    const first = createService(firstRoot, { ids })
    const second = createService(secondRoot, { ids })

    const firstSnapshot = await first.capture()
    const secondSnapshot = await second.capture()
    expect(firstSnapshot).toEqual(secondSnapshot)
    const firstManifest = await snapshotManifest(firstRoot, firstSnapshot.snapshotId)
    const secondManifest = await snapshotManifest(secondRoot, secondSnapshot.snapshotId)
    expect(firstManifest.equals(secondManifest)).toBe(true)

    await writeFile(
      path.join(firstRoot, managed.nebula.name),
      managed.nebula.initial.replace('fictional-history-old', 'fictional-history-new'),
      'utf8'
    )
    await writeFile(
      path.join(firstRoot, managed.galaxy.name),
      managed.galaxy.initial.replace('resourceMultiplier = 1', 'resourceMultiplier = 8'),
      'utf8'
    )

    expect(await first.list()).toEqual([expect.objectContaining({
      snapshotId: firstSnapshot.snapshotId,
      manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/)
    })])
    expect((await first.detail(firstSnapshot.snapshotId)).files).toHaveLength(4)
    const diff = await first.diff(firstSnapshot.snapshotId)
    const password = diff.settings.find((entry) => entry.id === 'nebula.server-password')
    expect(password).toEqual(expect.objectContaining({
      before: { configured: true }, after: { configured: true }, changed: true
    }))
    expect(diff.settings.find((entry) => entry.id === 'galaxy.resource-multiplier'))
      .toEqual(expect.objectContaining({ before: 8, after: 1, changed: true }))
    const serialized = JSON.stringify(diff)
    expect(serialized).not.toContain('fictional-history-old')
    expect(serialized).not.toContain('fictional-history-new')
    expect(serialized).not.toContain(firstRoot)
  })

  it('keeps capture, list, detail, and diff outside the host mutation lease', async () => {
    const root = await seedRoot()
    const coordinator: HostMutationOperationCoordinator = {
      async runExclusive(): Promise<never> {
        throw new Error('read-only history path requested a host lease')
      }
    }
    const service = createService(root, {
      coordinator,
      ids: [uuid(3), uuid(4)]
    })

    const snapshot = await service.capture()
    await expect(service.list()).resolves.toHaveLength(1)
    await expect(service.detail(snapshot.snapshotId)).resolves.toMatchObject({
      snapshotId: snapshot.snapshotId
    })
    await expect(service.diff(snapshot.snapshotId)).resolves.toMatchObject({
      snapshotId: snapshot.snapshotId
    })
  })

  it('fails a new restore closed without a coordinator before stopped proof or live publication', async () => {
    const root = await seedRoot()
    const snapshot = await createService(root, { ids: [uuid(5), uuid(6)] }).capture()
    await mutateCurrent(root)
    const before = await readManagedBuffers(root)
    let validations = 0
    const service = createService(root, {
      coordinator: null,
      validator: () => { validations += 1; return true }
    })

    await expect(service.restore(
      makeRestore(snapshot.snapshotId, await currentRevision(root), uuid(7))
    )).rejects.toMatchObject({ code: 'CONFIG_HISTORY_HOST_LEASE_UNAVAILABLE' })
    expect(validations).toBe(0)
    expectBuffers(await readManagedBuffers(root), before)
  })

  it('rejects a tampered snapshot and never returns its file hashes or contents', async () => {
    const root = await seedRoot()
    const service = createService(root, { ids: [uuid(10), uuid(11)] })
    const snapshot = await service.capture()
    const originalManifest = await snapshotManifest(root, snapshot.snapshotId)
    await writeFile(
      snapshotFile(root, snapshot.snapshotId, 'manifest.json'),
      JSON.stringify(JSON.parse(originalManifest.toString('utf8')), null, 2),
      'utf8'
    )
    await expect(service.detail(snapshot.snapshotId)).rejects.toMatchObject({
      code: 'CONFIG_HISTORY_SNAPSHOT_INVALID'
    })
    await writeFile(snapshotFile(root, snapshot.snapshotId, 'manifest.json'), originalManifest)
    await writeFile(snapshotFile(root, snapshot.snapshotId, 'nebula.bin'), 'tampered', 'utf8')

    await expect(service.detail(snapshot.snapshotId)).rejects.toMatchObject({
      code: 'CONFIG_HISTORY_SNAPSHOT_INVALID'
    })
    const current = await currentRevision(root)
    const receipt = await service.restore(makeRestore(snapshot.snapshotId, current, uuid(12)))
    expect(receipt).toMatchObject({
      status: 'rejected', errorCode: 'CONFIG_HISTORY_SNAPSHOT_INVALID', persisted: true
    })
    expect(JSON.stringify(receipt)).not.toContain('sha256')
    expect(JSON.stringify(receipt)).not.toContain(root)
  })

  it('requires both the optimistic revision and an injected stopped-state proof', async () => {
    const root = await seedRoot()
    const capture = createService(root, { ids: [uuid(20), uuid(21)] })
    const snapshot = await capture.capture()
    await mutateCurrent(root)
    const before = await readManagedBuffers(root)
    const rejectedProof = createService(root, {
      validator: () => false,
      ids: [uuid(22)]
    })
    const current = await currentRevision(root)

    const proofReceipt = await rejectedProof.restore(makeRestore(snapshot.snapshotId, current, uuid(23)))
    expect(proofReceipt).toMatchObject({
      status: 'rejected', errorCode: 'CONFIG_HISTORY_STOP_PROOF_REJECTED'
    })
    expectBuffers(await readManagedBuffers(root), before)

    const conflict = await createService(root, { ids: [uuid(24)] }).restore(
      makeRestore(snapshot.snapshotId, snapshot.revision, uuid(25))
    )
    expect(conflict).toMatchObject({
      status: 'rejected', errorCode: 'CONFIG_HISTORY_REVISION_CONFLICT'
    })
    expectBuffers(await readManagedBuffers(root), before)
  })

  it('coordinates a new restore, propagates its abort signal, and releases safe outcomes', async () => {
    const root = await seedRoot()
    const snapshot = await createService(root, { ids: [uuid(100), uuid(101)] }).capture()
    await mutateCurrent(root)
    const coordinator = new RecordingHostMutationCoordinator()
    const proofSignals: Array<AbortSignal | undefined> = []
    const service = createService(root, {
      coordinator,
      ids: [uuid(102)],
      validator: (_context, signal) => {
        proofSignals.push(signal)
        return true
      }
    })
    const request = makeRestore(snapshot.snapshotId, await currentRevision(root), uuid(103))

    await expect(service.restore(request)).resolves.toMatchObject({ status: 'restored' })
    expect(coordinator.requests).toEqual([{
      operation: 'game-config-restore',
      requestId: request.requestId
    }])
    expect(coordinator.outcomes).toEqual([
      expect.objectContaining({ kind: 'return', disposition: 'release' })
    ])
    expect(proofSignals.length).toBeGreaterThan(1)
    expect(proofSignals.every((signal) => signal === coordinator.scopes[0]!.signal)).toBe(true)
    expect(coordinator.activeAssertions).toBeGreaterThan(proofSignals.length * 2)

    const replayCoordinator: HostMutationOperationCoordinator = {
      async runExclusive(): Promise<never> {
        throw new Error('durable receipt replay requested a host lease')
      }
    }
    await expect(createService(root, { coordinator: replayCoordinator }).restore({
      ...request,
      stopProofToken: 'fictional-replacement-stop-proof'
    })).resolves.toMatchObject({ status: 'restored', reused: true })

    const rejectedRoot = await seedRoot()
    const rejectedSnapshot = await createService(rejectedRoot, {
      ids: [uuid(104), uuid(105)]
    }).capture()
    await mutateCurrent(rejectedRoot)
    const rejectedCoordinator = new RecordingHostMutationCoordinator()
    const rejected = createService(rejectedRoot, {
      coordinator: rejectedCoordinator,
      validator: () => false
    })
    await expect(rejected.restore(makeRestore(
      rejectedSnapshot.snapshotId,
      await currentRevision(rejectedRoot),
      uuid(106)
    ))).resolves.toMatchObject({
      status: 'rejected',
      errorCode: 'CONFIG_HISTORY_STOP_PROOF_REJECTED'
    })
    expect(rejectedCoordinator.outcomes).toEqual([
      expect.objectContaining({ kind: 'return', disposition: 'release' })
    ])
  })

  it('persists a dry-run receipt without creating protection history or changing bytes', async () => {
    const root = await seedRoot()
    const capture = createService(root, { ids: [uuid(26), uuid(27)] })
    const snapshot = await capture.capture()
    await mutateCurrent(root)
    const before = await readManagedBuffers(root)
    let validations = 0
    const service = createService(root, {
      validator: () => { validations++; return true }
    })
    const request = {
      ...makeRestore(snapshot.snapshotId, await currentRevision(root), uuid(28)),
      dryRun: true
    }

    const receipt = await service.restore(request)
    expect(receipt).toMatchObject({
      status: 'dry-run', dryRun: true, protectionSnapshotId: null, persisted: true
    })
    expect(validations).toBe(1)
    expectBuffers(await readManagedBuffers(root), before)
    expect(await service.list()).toHaveLength(1)
  })

  it('re-verifies target bytes after a TOCTOU hook and before any publication', async () => {
    const root = await seedRoot()
    const capture = createService(root, { ids: [uuid(30), uuid(31)] })
    const snapshot = await capture.capture()
    await mutateCurrent(root)
    const before = await readManagedBuffers(root)
    let tampered = false
    const service = createService(root, {
      ids: [uuid(32)],
      hooks: {
        async onPhase(phase) {
          if (phase === 'after-target-read' && !tampered) {
            tampered = true
            await writeFile(snapshotFile(root, snapshot.snapshotId, 'nebula.bin'), 'changed-after-read', 'utf8')
          }
        }
      }
    })

    const receipt = await service.restore(
      makeRestore(snapshot.snapshotId, await currentRevision(root), uuid(33))
    )
    expect(receipt).toMatchObject({
      status: 'rejected', errorCode: 'CONFIG_HISTORY_SNAPSHOT_INVALID'
    })
    expectBuffers(await readManagedBuffers(root), before)
  })

  it('returns busy to a concurrent contender while the fixed durable lock is owned', async () => {
    const root = await seedRoot()
    const capture = createService(root, { ids: [uuid(40), uuid(41)] })
    const snapshot = await capture.capture()
    await mutateCurrent(root)
    const revision = await currentRevision(root)
    let entered!: () => void
    let release!: () => void
    const held = new Promise<void>((resolve) => { entered = resolve })
    const resume = new Promise<void>((resolve) => { release = resolve })
    const first = createService(root, {
      ids: [uuid(42)],
      hooks: {
        async onPhase(phase, detail) {
          if (phase === 'before-publish-file' && detail.index === 0) {
            entered()
            await resume
          }
        }
      }
    })
    const request = makeRestore(snapshot.snapshotId, revision, uuid(43))
    const firstPromise = first.restore(request)
    await held
    const contenderCoordinator = new RecordingHostMutationCoordinator()
    const contender = await createService(root, {
      coordinator: contenderCoordinator
    }).restore({ ...request, requestId: uuid(44) })
    release()

    expect(contender).toMatchObject({ status: 'busy', errorCode: 'CONFIG_HISTORY_BUSY', persisted: false })
    expect(contenderCoordinator.requests).toEqual([])
    expect((await firstPromise).status).toBe('restored')
  })

  it.each([
    ['HOST_MUTATION_LEASE_BUSY', 'CONFIG_HISTORY_HOST_LEASE_BUSY'],
    ['HOST_MUTATION_LEASE_DIRTY', 'CONFIG_HISTORY_HOST_LEASE_DIRTY'],
    ['HOST_MUTATION_LEASE_RECOVERY_REQUIRED', 'CONFIG_HISTORY_HOST_LEASE_RECOVERY_REQUIRED'],
    ['HOST_MUTATION_LEASE_LOST', 'CONFIG_HISTORY_HOST_LEASE_LOST'],
    ['HOST_MUTATION_LEASE_UNAVAILABLE', 'CONFIG_HISTORY_HOST_LEASE_UNAVAILABLE']
  ] as const)('maps %s before stopped proof or live publication', async (coordinatorCode, historyCode) => {
    const root = await seedRoot()
    const snapshot = await createService(root, { ids: [uuid(110), uuid(111)] }).capture()
    await mutateCurrent(root)
    const before = await readManagedBuffers(root)
    let validations = 0
    const coordinator: HostMutationOperationCoordinator = {
      async runExclusive(): Promise<never> {
        throw new HostMutationOperationCoordinatorError(coordinatorCode)
      }
    }
    const service = createService(root, {
      coordinator,
      validator: () => { validations += 1; return true }
    })

    await expect(service.restore(makeRestore(
      snapshot.snapshotId,
      await currentRevision(root),
      uuid(112)
    ))).rejects.toMatchObject({ code: historyCode })
    expect(validations).toBe(0)
    expectBuffers(await readManagedBuffers(root), before)
  })

  it('maps lease loss after a cancellable stopped proof before any live publication', async () => {
    const root = await seedRoot()
    const snapshot = await createService(root, { ids: [uuid(120), uuid(121)] }).capture()
    await mutateCurrent(root)
    const before = await readManagedBuffers(root)
    const abortController = new AbortController()
    let lost = false
    const coordinator: HostMutationOperationCoordinator = {
      async runExclusive<T>(
        _request: HostMutationOperationRequest,
        operation: HostMutationOperation<T>
      ): Promise<T> {
        const scope: HostMutationOperationScope = {
          signal: abortController.signal,
          assertActive: () => {
            if (lost) throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_LOST')
          },
          toPowerShellBorrowArguments: () => []
        }
        return unwrapHostMutationOutcome(await operation(scope))
      }
    }
    const service = createService(root, {
      coordinator,
      validator: (_context, signal) => {
        expect(signal).toBe(abortController.signal)
        lost = true
        abortController.abort()
        return true
      }
    })

    await expect(service.restore(makeRestore(
      snapshot.snapshotId,
      await currentRevision(root),
      uuid(122)
    ))).rejects.toMatchObject({ code: 'CONFIG_HISTORY_HOST_LEASE_LOST' })
    expect(abortController.signal.aborted).toBe(true)
    expectBuffers(await readManagedBuffers(root), before)
  })

  it('checks lease activity in the first live rename window', async () => {
    const root = await seedRoot()
    const snapshot = await createService(root, { ids: [uuid(130), uuid(131)] }).capture()
    await mutateCurrent(root)
    const before = await readManagedBuffers(root)
    let assertions = 0
    const coordinator: HostMutationOperationCoordinator = {
      async runExclusive<T>(
        _request: HostMutationOperationRequest,
        operation: HostMutationOperation<T>
      ): Promise<T> {
        const scope = activeHostMutationScope(() => {
          assertions += 1
          if (assertions === 5) {
            throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_LOST')
          }
        })
        return unwrapHostMutationOutcome(await operation(scope))
      }
    }
    const service = createService(root, {
      coordinator,
      ids: [uuid(132)]
    })

    await expect(service.restore(makeRestore(
      snapshot.snapshotId,
      await currentRevision(root),
      uuid(133)
    ))).rejects.toMatchObject({ code: 'CONFIG_HISTORY_HOST_LEASE_LOST' })
    expect(assertions).toBe(5)
    expectBuffers(await readManagedBuffers(root), before)
  })

  it('checks lease activity after the durable terminal receipt without undoing the commit', async () => {
    const root = await seedRoot()
    const target = await readManagedBuffers(root)
    const snapshot = await createService(root, { ids: [uuid(150), uuid(151)] }).capture()
    await mutateCurrent(root)
    let assertions = 0
    const coordinator: HostMutationOperationCoordinator = {
      async runExclusive<T>(
        _request: HostMutationOperationRequest,
        operation: HostMutationOperation<T>
      ): Promise<T> {
        const scope = activeHostMutationScope(() => {
          assertions += 1
          if (assertions === 19) {
            throw new HostMutationOperationCoordinatorError('HOST_MUTATION_LEASE_LOST')
          }
        })
        return unwrapHostMutationOutcome(await operation(scope))
      }
    }
    const service = createService(root, {
      coordinator,
      ids: [uuid(152)]
    })
    const request = makeRestore(snapshot.snapshotId, await currentRevision(root), uuid(153))

    await expect(service.restore(request)).rejects.toMatchObject({
      code: 'CONFIG_HISTORY_HOST_LEASE_LOST'
    })
    expect(assertions).toBe(19)
    expectBuffers(await readManagedBuffers(root), target)
    await expect(createService(root, { coordinator: null }).restore(request)).resolves.toMatchObject({
      status: 'restored',
      reused: true
    })
  })

  it('rolls a partial multi-file failure back byte-for-byte and persists an audit-safe receipt', async () => {
    const root = await seedRoot()
    const capture = createService(root, { ids: [uuid(50), uuid(51)] })
    const snapshot = await capture.capture()
    await mutateCurrent(root)
    const before = await readManagedBuffers(root)
    const coordinator = new RecordingHostMutationCoordinator()
    const service = createService(root, {
      coordinator,
      ids: [uuid(52)],
      hooks: {
        onPhase(phase, detail) {
          if (phase === 'before-publish-file' && detail.index === 1) {
            throw new Error('private failure detail')
          }
        }
      }
    })

    const receipt = await service.restore(
      makeRestore(snapshot.snapshotId, await currentRevision(root), uuid(53))
    )
    expect(receipt).toMatchObject({
      status: 'rolled-back', errorCode: 'CONFIG_HISTORY_COMMIT_FAILED', persisted: true
    })
    expect(receipt.protectionSnapshotId).toMatch(/^[0-9a-f-]{36}$/)
    expect(coordinator.outcomes).toEqual([
      expect.objectContaining({ kind: 'return', disposition: 'release' })
    ])
    expectBuffers(await readManagedBuffers(root), before)
    const stored = await readReceipt(root, receipt.requestId)
    expect(stored).not.toContain('fictional-history-old')
    expect(stored).not.toContain('fictional-history-new')
    expect(stored).not.toContain('fictional-stop-proof')
    expect(stored).not.toContain('private failure detail')
    expect(stored).not.toContain(root)
  })

  it('abandons the host lease when live publication outlives every terminal receipt write', async () => {
    const root = await seedRoot()
    const snapshot = await createService(root, { ids: [uuid(160), uuid(161)] }).capture()
    await mutateCurrent(root)
    const before = await readManagedBuffers(root)
    const request = makeRestore(snapshot.snapshotId, await currentRevision(root), uuid(162))
    const coordinator = new RecordingHostMutationCoordinator()
    let blockedReceipt = false
    const service = createService(root, {
      coordinator,
      ids: [uuid(163)],
      hooks: {
        async onPhase(phase, detail) {
          if (phase === 'after-publish-file' && detail.index === 3 && !blockedReceipt) {
            blockedReceipt = true
            await mkdir(path.join(
              root,
              '.dyson-control',
              'config-history',
              'receipts',
              `${request.requestId}.json`
            ))
          }
        }
      }
    })

    await expect(service.restore(request)).rejects.toMatchObject({
      code: 'CONFIG_HISTORY_REQUEST_CONFLICT'
    })
    expect(blockedReceipt).toBe(true)
    expect(coordinator.outcomes).toEqual([
      expect.objectContaining({ kind: 'throw', disposition: 'abandon' })
    ])
    expectBuffers(await readManagedBuffers(root), before)
  })

  it('never unlinks a replacement lock file and clears only the in-process ownership', async () => {
    const root = await seedRoot()
    const snapshot = await createService(root, { ids: [uuid(170), uuid(171)] }).capture()
    await mutateCurrent(root)
    const lockPath = path.join(root, '.dyson-control', 'configuration.lock')
    const displacedLockPath = path.join(root, '.dyson-control', 'configuration.lock.original')
    const replacement = 'fictional replacement lock\n'
    let replaced = false
    const service = createService(root, {
      ids: [uuid(172)],
      hooks: {
        async onPhase(phase) {
          if (phase !== 'before-lock-release' || replaced) return
          replaced = true
          await rename(lockPath, displacedLockPath)
          await writeFile(lockPath, replacement, 'utf8')
        }
      }
    })

    await expect(service.restore(makeRestore(
      snapshot.snapshotId,
      await currentRevision(root),
      uuid(173)
    ))).rejects.toMatchObject({ code: 'CONFIG_HISTORY_STORAGE_UNAVAILABLE' })
    expect(replaced).toBe(true)
    await expect(readFile(lockPath, 'utf8')).resolves.toBe(replacement)

    await rm(lockPath)
    const recovered = createService(root, { ids: [uuid(174), uuid(175)] })
    await expect(recovered.capture()).resolves.toMatchObject({ kind: 'manual' })
  })

  it('returns the same durable receipt for an idempotent request and rejects changed parameters', async () => {
    const root = await seedRoot()
    const capture = createService(root, { ids: [uuid(60), uuid(61)] })
    const snapshot = await capture.capture()
    await mutateCurrent(root)
    let validations = 0
    const validator: GameConfigStopProofValidator = () => { validations++; return true }
    const service = createService(root, { ids: [uuid(62)], validator })
    const request = makeRestore(snapshot.snapshotId, await currentRevision(root), uuid(63))

    const first = await service.restore(request)
    const validationCount = validations
    const second = await createService(root, { validator }).restore({
      ...request,
      stopProofToken: 'fictional-replacement-stop-proof'
    })
    expect(first.status).toBe('restored')
    expect(second).toEqual({ ...first, reused: true })
    expect(validations).toBe(validationCount)

    await expect(createService(root, { validator }).restore({
      ...request,
      expectedCurrentRevision: snapshot.revision
    })).rejects.toMatchObject({ code: 'CONFIG_HISTORY_REQUEST_CONFLICT' })
  })

  it('recovers an interrupted publication after a new service instance starts', async () => {
    const root = await seedRoot()
    const capture = createService(root, { ids: [uuid(70), uuid(71)] })
    const snapshot = await capture.capture()
    await mutateCurrent(root)
    const before = await readManagedBuffers(root)
    const request = makeRestore(snapshot.snapshotId, await currentRevision(root), uuid(72))
    const interruptedCoordinator = new RecordingHostMutationCoordinator()
    const interrupted = createService(root, {
      coordinator: interruptedCoordinator,
      ids: [uuid(73)],
      hooks: { simulateInterruptionAfterFileIndex: 0 }
    })

    await expect(interrupted.restore(request)).rejects.toThrow('TEST_SIMULATED_PROCESS_EXIT')
    expect(interruptedCoordinator.outcomes).toEqual([
      expect.objectContaining({ kind: 'throw', disposition: 'abandon' })
    ])
    expect((await readManagedBuffers(root)).nebula.equals(before.nebula)).toBe(false)
    const journal = await readFile(path.join(
      root, '.dyson-control', 'config-history', 'pending', `restore-${request.requestId}`, 'journal.json'
    ), 'utf8')
    expect(journal).not.toContain('fictional-stop-proof')
    expect(journal).not.toContain(root)

    const reconcileCoordinator = new RecordingHostMutationCoordinator()
    const restarted = createService(root, {
      coordinator: reconcileCoordinator,
      ids: [uuid(74)]
    })
    const recovery = await restarted.reconcileInterrupted('fictional-stop-proof')
    expect(recovery).toEqual([expect.objectContaining({
      requestId: request.requestId,
      status: 'interrupted-recovered',
      errorCode: 'CONFIG_HISTORY_INTERRUPTED_RECOVERED'
    })])
    expect(reconcileCoordinator.requests).toEqual([{
      operation: 'game-config-reconcile',
      requestId: uuid(74)
    }])
    expect(reconcileCoordinator.outcomes).toEqual([
      expect.objectContaining({ kind: 'return', disposition: 'release' })
    ])
    expectBuffers(await readManagedBuffers(root), before)
    const repeated = await restarted.restore(request)
    expect(repeated).toMatchObject({ status: 'interrupted-recovered', reused: true, persisted: true })
  })

  it.each(['malformed-receipt', 'foreign-fingerprint', 'later-edit'] as const)(
    'preserves evidence and live bytes when recovery encounters %s', async mode => {
      const root = await seedRoot()
      const snapshot = await createService(root, { ids: [uuid(170), uuid(171)] }).capture()
      await mutateCurrent(root)
      const request = makeRestore(snapshot.snapshotId, await currentRevision(root), uuid(172))
      await expect(createService(root, { ids: [uuid(173)],
        hooks: { simulateInterruptionAfterFileIndex: 0 }
      }).restore(request)).rejects.toThrow('TEST_SIMULATED_PROCESS_EXIT')
      const pending = path.join(root, '.dyson-control', 'config-history', 'pending', `restore-${request.requestId}`)
      const journalPath = path.join(pending, 'journal.json')
      const journalBytes = await readFile(journalPath)
      const receiptPath = path.join(root, '.dyson-control', 'config-history', 'receipts', `${request.requestId}.json`)
      if (mode === 'malformed-receipt') {
        await writeFile(receiptPath, '{incomplete receipt')
      } else {
        expect((await createService(root, { ids: [uuid(174)] }).reconcileInterrupted('fictional-stop-proof'))[0]!.status)
          .toBe('interrupted-recovered')
        // Recreate only the retained journal to model a crash at terminal cleanup.
        await mkdir(pending)
        await writeFile(journalPath, journalBytes)
        if (mode === 'foreign-fingerprint') {
          const stored = JSON.parse(await readFile(receiptPath, 'utf8'))
          stored.fingerprint = '0'.repeat(64)
          await writeFile(receiptPath, JSON.stringify(stored))
        } else {
          await writeFile(path.join(root, 'nebula.cfg'), 'later administrator configuration\n')
        }
      }
      const before = await readManagedBuffers(root)
      const receiptBytes = await readFile(receiptPath)
      const result = await createService(root, { ids: [uuid(175)] }).reconcileInterrupted('fictional-stop-proof')
      expect(result).toEqual([expect.objectContaining({ requestId: request.requestId, status: 'recovery-required',
        errorCode: mode === 'later-edit' ? 'CONFIG_HISTORY_REVISION_CONFLICT' : 'CONFIG_HISTORY_RECONCILIATION_REQUIRED' })])
      expectBuffers(await readManagedBuffers(root), before)
      expect(await readFile(receiptPath)).toEqual(receiptBytes)
      expect(await readFile(journalPath)).toEqual(journalBytes)
    }
  )

  it('fails reconciliation closed without a coordinator and abandons unresolved recovery', async () => {
    const root = await seedRoot()
    const snapshot = await createService(root, { ids: [uuid(140), uuid(141)] }).capture()
    await mutateCurrent(root)
    const request = makeRestore(snapshot.snapshotId, await currentRevision(root), uuid(142))
    await expect(createService(root, {
      ids: [uuid(143)],
      hooks: { simulateInterruptionAfterFileIndex: 0 }
    }).restore(request)).rejects.toThrow('TEST_SIMULATED_PROCESS_EXIT')
    const interruptedBytes = await readManagedBuffers(root)
    let validations = 0

    await expect(createService(root, {
      coordinator: null,
      ids: [uuid(144)],
      validator: () => { validations += 1; return true }
    }).reconcileInterrupted('fictional-stop-proof')).rejects.toMatchObject({
      code: 'CONFIG_HISTORY_HOST_LEASE_UNAVAILABLE'
    })
    expect(validations).toBe(0)
    expectBuffers(await readManagedBuffers(root), interruptedBytes)

    const coordinator = new RecordingHostMutationCoordinator()
    const unresolved = await createService(root, {
      coordinator,
      ids: [uuid(145)],
      validator: () => false
    }).reconcileInterrupted('fictional-stop-proof')
    expect(unresolved).toEqual([expect.objectContaining({
      status: 'recovery-required',
      errorCode: 'CONFIG_HISTORY_STOP_PROOF_REJECTED'
    })])
    expect(coordinator.outcomes).toEqual([
      expect.objectContaining({ kind: 'return', disposition: 'abandon' })
    ])
    expectBuffers(await readManagedBuffers(root), interruptedBytes)
  })

  it('keeps a failed rollback as a recoverable orphan and repairs it on explicit reconciliation', async () => {
    const root = await seedRoot()
    const capture = createService(root, { ids: [uuid(80), uuid(81)] })
    const snapshot = await capture.capture()
    await mutateCurrent(root)
    const before = await readManagedBuffers(root)
    const request = makeRestore(snapshot.snapshotId, await currentRevision(root), uuid(82))
    const failedCoordinator = new RecordingHostMutationCoordinator()
    const failed = createService(root, {
      coordinator: failedCoordinator,
      ids: [uuid(83)],
      hooks: {
        onPhase(phase, detail) {
          if (phase === 'before-publish-file' && detail.index === 1) throw new Error('commit')
          if (phase === 'before-rollback') throw new Error('rollback')
        }
      }
    })

    const receipt = await failed.restore(request)
    expect(receipt).toMatchObject({
      status: 'recovery-required', errorCode: 'CONFIG_HISTORY_ROLLBACK_FAILED'
    })
    expect(failedCoordinator.outcomes).toEqual([
      expect.objectContaining({ kind: 'return', disposition: 'abandon' })
    ])
    const restarted = createService(root, { ids: [uuid(84)] })
    const recovery = await restarted.reconcileInterrupted('fictional-stop-proof')
    expect(recovery[0]).toMatchObject({ status: 'interrupted-recovered' })
    expectBuffers(await readManagedBuffers(root), before)
  })

  it('fails closed on redirected roots, unsafe IDs, and configured capacity limits', async () => {
    const actual = await seedRoot()
    const linkParent = await mkdtemp(path.join(tmpdir(), 'dyson-config-history-link-'))
    temporaryRoots.push(linkParent)
    const link = path.join(linkParent, 'redirected')
    let linked = true
    try {
      await symlink(actual, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if (hasCode(error, 'EPERM') || hasCode(error, 'EACCES')) linked = false
      else throw error
    }
    if (linked) {
      await expect(createService(link, { ids: [uuid(90)] }).capture()).rejects.toMatchObject({
        code: expect.stringMatching(/^CONFIG_HISTORY_(?:ROOT|STORAGE)_UNAVAILABLE$/)
      })
    }

    const limited = createService(actual, {
      ids: [uuid(91), uuid(92), uuid(93), uuid(94)],
      limits: { maximumSnapshots: 1 }
    })
    const first = await limited.capture()
    await expect(limited.capture()).rejects.toMatchObject({ code: 'CONFIG_HISTORY_CAPACITY_EXCEEDED' })
    await expect(limited.detail('../escape')).rejects.toBeInstanceOf(GameConfigHistoryError)
    expect((await limited.detail(first.snapshotId)).snapshotId).toBe(first.snapshotId)
  })
})

interface ServiceOverrides {
  ids?: string[]
  validator?: GameConfigStopProofValidator
  hooks?: GameConfigHistoryTestHooks
  limits?: GameConfigHistoryLimits
  coordinator?: HostMutationOperationCoordinator | null
}

function createService(root: string, overrides: ServiceOverrides = {}): GameConfigHistoryService {
  const ids = [...(overrides.ids ?? [])]
  return new GameConfigHistoryService({
    configRoot: root,
    validateStopProof: overrides.validator ?? (() => true),
    ...(overrides.coordinator === null
      ? {}
      : { hostMutationCoordinator: overrides.coordinator ?? new RecordingHostMutationCoordinator() }),
    now: () => new Date('2026-08-30T08:00:00.000Z'),
    createId: () => {
      const next = ids.shift()
      if (!next) throw new Error('test UUID source exhausted')
      return next
    },
    ...(overrides.hooks === undefined ? {} : { testHooks: overrides.hooks }),
    ...(overrides.limits === undefined ? {} : { limits: overrides.limits })
  })
}

async function seedRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dyson-config-history-'))
  temporaryRoots.push(root)
  await Promise.all(Object.values(managed).map((file) =>
    writeFile(path.join(root, file.name), file.initial, 'utf8')
  ))
  return root
}

async function mutateCurrent(root: string): Promise<void> {
  await writeFile(
    path.join(root, managed.nebula.name),
    managed.nebula.initial
      .replace('AutoPauseEnabled = true', 'AutoPauseEnabled = false')
      .replace('fictional-history-old', 'fictional-history-new'),
    'utf8'
  )
  await writeFile(
    path.join(root, managed.galaxy.name),
    managed.galaxy.initial.replace('resourceMultiplier = 1', 'resourceMultiplier = 5'),
    'utf8'
  )
}

async function currentRevision(root: string): Promise<string> {
  const files = Object.fromEntries(await Promise.all(
    Object.entries(managed).map(async ([id, file]) => [id, await readFile(path.join(root, file.name), 'utf8')])
  )) as GameConfigFiles
  return inspectGameConfiguration(files).revision
}

async function readManagedBuffers(root: string): Promise<Record<keyof typeof managed, Buffer>> {
  return Object.fromEntries(await Promise.all(
    Object.entries(managed).map(async ([id, file]) => [id, await readFile(path.join(root, file.name))])
  )) as Record<keyof typeof managed, Buffer>
}

function expectBuffers(
  actual: Record<keyof typeof managed, Buffer>,
  expected: Record<keyof typeof managed, Buffer>
): void {
  for (const id of Object.keys(managed) as Array<keyof typeof managed>) {
    expect(actual[id].equals(expected[id])).toBe(true)
  }
}

function makeRestore(
  snapshotId: string,
  expectedCurrentRevision: string,
  requestId: string
): RestoreGameConfigurationRequest {
  return {
    requestId,
    snapshotId,
    expectedCurrentRevision,
    stopProofToken: 'fictional-stop-proof'
  }
}

function snapshotFile(root: string, snapshotId: string, fileName: string): string {
  return path.join(root, '.dyson-control', 'config-history', 'snapshots', snapshotId, fileName)
}

async function snapshotManifest(root: string, snapshotId: string): Promise<Buffer> {
  return readFile(snapshotFile(root, snapshotId, 'manifest.json'))
}

async function readReceipt(root: string, requestId: string): Promise<string> {
  return readFile(path.join(
    root, '.dyson-control', 'config-history', 'receipts', `${requestId}.json`
  ), 'utf8')
}

class RecordingHostMutationCoordinator implements HostMutationOperationCoordinator {
  readonly requests: HostMutationOperationRequest[] = []
  readonly outcomes: HostMutationOperationOutcome<unknown>[] = []
  readonly scopes: HostMutationOperationScope[] = []
  activeAssertions = 0

  async runExclusive<T>(
    request: HostMutationOperationRequest,
    operation: HostMutationOperation<T>
  ): Promise<T> {
    this.requests.push({ ...request })
    const scope = activeHostMutationScope(() => { this.activeAssertions += 1 })
    this.scopes.push(scope)
    const outcome = await operation(scope)
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

function uuid(value: number): string {
  const suffix = value.toString(16).padStart(12, '0')
  return `00000000-0000-4000-8000-${suffix}`
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

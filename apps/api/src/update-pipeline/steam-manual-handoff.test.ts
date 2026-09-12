import { randomUUID } from 'node:crypto'
import { realpath, link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir, uptime } from 'node:os'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  HostMutationDisposition,
  HostMutationOperationCoordinator,
  HostMutationOperationOutcome,
  HostMutationOperationRequest,
  HostMutationOperationScope,
  HostMutationRecoveryOperationCoordinator,
  HostMutationRecoveryOperationRequest
} from '../host-mutation/operation-coordinator.js'
import {
  initialSteamManualHandoffRevision,
  SteamManualHandoffError,
  SteamManualHandoffService,
  type SteamManualHandoffAdapters
} from './steam-manual-handoff.js'

const roots: string[] = []
const saveIdentity = 'a'.repeat(64)
const manifestSha256 = 'b'.repeat(64)
const compatibilityRevision = 'c'.repeat(64)
const generation = 'd'.repeat(64)

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

describe('official Steam client manual handoff transaction', () => {
  it.each(['previous-boot', 'same-boot', 'live-owner', 'foreign-host', 'future-boot', 'malformed', 'hard-linked'] as const)(
    'reclaims only a verified dead local lock: %s', async mode => {
      const fixture = await createFixture()
      const lockRoot = path.join(fixture.stateRoot, '.locks')
      await mkdir(lockRoot, { recursive: true })
      const lockPath = path.join(lockRoot, 'handoff.lock')
      const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true, timeout: 10_000 })
      expect(child.status).toBe(0)
      const boot = Math.round((Date.now() - uptime() * 1_000) / 60_000)
      const value = { host: mode === 'foreign-host' ? 'fictional-other-host' : hostname(),
        bootId: (boot + (mode === 'previous-boot' ? -60 : mode === 'future-boot' ? 60 : 0)).toString(36),
        pid: mode === 'live-owner' ? process.pid : child.pid, acquiredAt: new Date(Date.now() - 60_000).toISOString() }
      const bytes = mode === 'malformed' ? '{broken lock' : JSON.stringify(value)
      await writeFile(lockPath, bytes)
      if (mode === 'hard-linked') await link(lockPath, path.join(lockRoot, 'retained-link'))
      if (mode === 'previous-boot' || mode === 'same-boot') {
        expect(await fixture.service.begin(makeRequest())).toMatchObject({ phase: 'awaiting-steam-client-update' })
        expect(fixture.events).toContain('verify-stopped')
        await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      } else {
        await expect(fixture.service.begin(makeRequest())).rejects.toMatchObject({ code: 'DSP_STEAM_HANDOFF_LOCK_BUSY' })
        expect(await readFile(lockPath, 'utf8')).toBe(bytes)
        expect(fixture.events).toEqual([])
      }
    }
  )

  it('previews with zero filesystem or adapter mutation and advertises no account automation', async () => {
    const fixture = await createFixture()
    const request = makeRequest()
    const plan = await fixture.service.preview(request)

    expect(plan).toMatchObject({
      dryRun: true,
      accountAutomation: false,
      requestId: request.requestId,
      targetVersion: request.targetVersion
    })
    expect(plan.operations).toContain('await-official-steam-client-update')
    expect(fixture.events).toEqual([])
    await expect(readFile(path.join(fixture.stateRoot, 'state.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('creates protection, gracefully stops, persists awaiting receipt, and replays the UUID idempotently', async () => {
    const fixture = await createFixture()
    const request = makeRequest()
    const first = await fixture.service.begin(request)

    expect(first).toMatchObject({
      phase: 'awaiting-steam-client-update',
      recoveryRequired: false,
      protectionBackupId: `save:${request.requestId}`,
      protectionManifestSha256: manifestSha256,
      transactionBindingSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      steps: {
        protectionPoint: 'verified', gracefulStop: 'verified', stoppedProof: 'verified',
        operatorConfirmation: 'pending'
      },
      reused: false
    })
    expect(fixture.events).toEqual(['baseline', 'protection', 'graceful-stop', 'verify-stopped'])
    expect(fixture.ordinary.dispositions).toEqual(['abandon'])
    const stored = JSON.parse(await readFile(path.join(
      fixture.stateRoot, 'transactions', `${request.requestId}.json`
    ), 'utf8')) as Record<string, unknown>
    expect(stored).toMatchObject({
      format: 'dyson-control-steam-manual-handoff-journal-receipt',
      phase: 'awaiting-steam-client-update',
      transactionBindingSha256: first.transactionBindingSha256
    })
    expect(JSON.stringify(stored)).not.toMatch(/password|guard|cookie|token|account/i)

    const replay = await fixture.service.begin(request)
    expect(replay).toMatchObject({ phase: 'awaiting-steam-client-update', reused: true })
    expect(fixture.events).toHaveLength(4)
  })

  it('resamples the exact DSP version and compatibility before proving exact save load in one startup generation', async () => {
    const fixture = await createFixture()
    const request = makeRequest()
    await fixture.service.begin(request)
    const completed = await fixture.service.confirm(request.requestId)

    expect(completed).toMatchObject({
      phase: 'succeeded', recoveryRequired: false, failureCode: null,
      steps: {
        operatorConfirmation: 'verified', versionResample: 'verified',
        compatibilityResample: 'verified', exactSaveLoad: 'verified'
      }
    })
    expect(fixture.events).toEqual([
      'baseline', 'protection', 'graceful-stop', 'verify-stopped', 'resample', 'start-and-load'
    ])
    expect(fixture.recovery.dispositions).toEqual(['release'])
    await expect(fixture.service.confirm(request.requestId)).resolves.toMatchObject({
      phase: 'succeeded', reused: true
    })
    await expect(fixture.service.getState()).resolves.toMatchObject({
      recoveryRequired: false, activeRequestId: null,
      lastCompletedTargetVersion: request.targetVersion,
      revision: completed.resultingRevision
    })
  })

  it('keeps a fixed-confirmation retry awaiting when Steam has not reached the exact target version', async () => {
    const fixture = await createFixture({ observedVersion: '0.10.34.28529' })
    const request = makeRequest()
    await fixture.service.begin(request)

    await expect(fixture.service.confirm(request.requestId)).rejects.toMatchObject({
      code: 'DSP_STEAM_HANDOFF_VERSION_MISMATCH'
    })
    await expect(fixture.service.getReceipt(request.requestId)).resolves.toMatchObject({
      phase: 'awaiting-steam-client-update',
      failureCode: 'DSP_STEAM_HANDOFF_VERSION_MISMATCH',
      recoveryRequired: false,
      steps: { versionResample: 'failed', operatorConfirmation: 'pending' }
    })
    expect(fixture.events).not.toContain('start-and-load')
    expect(fixture.recovery.dispositions).toEqual(['abandon'])
  })

  it('survives service restart while awaiting and fails an expired handoff closed to durable recovery', async () => {
    let now = new Date('2026-09-01T10:00:00.000Z')
    const fixture = await createFixture({ now: () => now, timeoutMs: 1_000 })
    const request = makeRequest()
    await fixture.service.begin(request)
    const restarted = new SteamManualHandoffService({
      stateRoot: fixture.stateRoot,
      hostMutationCoordinator: fixture.ordinary,
      hostMutationRecoveryCoordinator: fixture.recovery,
      handoffTimeoutMs: 1_000,
      now: () => now,
      ...fixture.adapters
    })
    await expect(restarted.reconcile()).resolves.toMatchObject({
      phase: 'awaiting-steam-client-update', recoveryRequired: false
    })

    now = new Date('2026-09-01T10:00:02.000Z')
    const timedOut = await restarted.reconcile()
    expect(timedOut).toMatchObject({
      phase: 'recovery-required', recoveryRequired: true,
      failureCode: 'DSP_STEAM_HANDOFF_TIMEOUT'
    })
    await expect(restarted.getState()).resolves.toMatchObject({ recoveryRequired: true })
    expect(fixture.recovery.dispositions).toEqual(['abandon'])
  })

  it('never treats process health as completion when Bridge/log generation or exact loaded save is wrong', async () => {
    const fixture = await createFixture({ loadedSaveIdentity: 'f'.repeat(64) })
    const request = makeRequest()
    await fixture.service.begin(request)
    const failed = await fixture.service.confirm(request.requestId)

    expect(failed).toMatchObject({
      phase: 'recovery-required', recoveryRequired: true,
      failureCode: 'DSP_STEAM_HANDOFF_EXACT_SAVE_LOAD_UNPROVEN',
      steps: { exactSaveLoad: 'failed' }
    })
    expect(fixture.recovery.dispositions).toEqual(['abandon'])
  })

  it('rejects UUID reuse with a different target without touching the host again', async () => {
    const fixture = await createFixture()
    const request = makeRequest()
    await fixture.service.begin(request)
    await expect(fixture.service.begin({ ...request, targetVersion: '0.10.34.28529' }))
      .rejects.toBeInstanceOf(SteamManualHandoffError)
    await expect(fixture.service.begin({ ...request, targetVersion: '0.10.34.28529' }))
      .rejects.toMatchObject({ code: 'DSP_STEAM_HANDOFF_IDEMPOTENCY_CONFLICT' })
    expect(fixture.events).toHaveLength(4)
  })
})

interface FixtureOptions {
  now?: () => Date
  timeoutMs?: number
  observedVersion?: string
  compatible?: boolean
  loadedSaveIdentity?: string
  bridgeGeneration?: string
  logGeneration?: string
}

async function createFixture(options: FixtureOptions = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'dyson-steam-handoff-')))
  roots.push(root)
  const stateRoot = path.join(root, 'state')
  const events: string[] = []
  const ordinary = new TestCoordinator()
  const recovery = new TestRecoveryCoordinator()
  const adapters: SteamManualHandoffAdapters = {
    captureBaseline: async () => {
      events.push('baseline')
      return {
        dspVersion: '0.10.34.28529', compatibilityRevision, compatible: true,
        loadedSaveIdentity: saveIdentity
      }
    },
    createProtectionPoint: async (request) => {
      events.push('protection')
      return {
        requestId: request.requestId,
        backupId: `save:${request.requestId}`,
        manifestSha256,
        saveIdentity,
        pairProtected: true,
        durable: true
      }
    },
    requestGracefulStop: async () => { events.push('graceful-stop'); return { dispatched: true } },
    verifyStopped: async () => {
      events.push('verify-stopped')
      return { processStopped: true, portClosed: true }
    },
    resampleUpdatedRuntime: async () => {
      events.push('resample')
      return {
        dspVersion: options.observedVersion ?? '0.10.35.29485',
        compatibilityRevision: 'e'.repeat(64),
        compatible: options.compatible ?? true
      }
    },
    startAndVerifyExactSave: async () => {
      events.push('start-and-load')
      return {
        dspVersion: '0.10.35.29485',
        compatibilityRevision: 'e'.repeat(64),
        compatible: true,
        startupGenerationId: generation,
        bridgeHeartbeatGenerationId: options.bridgeGeneration ?? generation,
        loadedSaveLogGenerationId: options.logGeneration ?? generation,
        loadedSaveIdentity: options.loadedSaveIdentity ?? saveIdentity
      }
    }
  }
  const service = new SteamManualHandoffService({
    stateRoot,
    hostMutationCoordinator: ordinary,
    hostMutationRecoveryCoordinator: recovery,
    handoffTimeoutMs: options.timeoutMs,
    now: options.now ?? (() => new Date('2026-09-01T10:00:00.000Z')),
    ...adapters
  })
  return { service, stateRoot, events, ordinary, recovery, adapters }
}

function makeRequest() {
  return {
    requestId: randomUUID(),
    targetVersion: '0.10.35.29485',
    expectedRevision: initialSteamManualHandoffRevision
  }
}

class TestCoordinator implements HostMutationOperationCoordinator {
  readonly dispositions: HostMutationDisposition[] = []
  readonly scope = testScope()

  async runExclusive<T>(
    _request: HostMutationOperationRequest,
    operation: (scope: HostMutationOperationScope) =>
      Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>
  ): Promise<T> {
    const outcome = await operation(this.scope)
    this.dispositions.push(outcome.disposition)
    if (outcome.kind === 'throw') throw outcome.error
    return outcome.value
  }
}

class TestRecoveryCoordinator implements HostMutationRecoveryOperationCoordinator {
  readonly dispositions: HostMutationDisposition[] = []
  readonly scope = testScope()

  async runRecoveryExclusive<T>(
    _request: HostMutationRecoveryOperationRequest,
    operation: (scope: HostMutationOperationScope) =>
      Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>
  ): Promise<T> {
    const outcome = await operation(this.scope)
    this.dispositions.push(outcome.disposition)
    if (outcome.kind === 'throw') throw outcome.error
    return outcome.value
  }
}

function testScope(): HostMutationOperationScope {
  return {
    signal: new AbortController().signal,
    assertActive: () => undefined,
    toPowerShellBorrowArguments: () => []
  }
}

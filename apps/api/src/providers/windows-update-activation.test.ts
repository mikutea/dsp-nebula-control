import { describe, expect, it } from 'vitest'
import type {
  LifecycleAction,
  LifecycleMutationAdapter,
  LifecycleOperationContext,
  LifecyclePhaseResult,
  LifecyclePreview,
  LifecyclePreviewContext,
  ServerStatus,
  StatusProvider
} from '../domain.js'
import type { FixedUpdateSmokeRequest } from '../update-pipeline/activation-types.js'
import type { HostMutationOperationScope } from '../host-mutation/operation-coordinator.js'
import {
  WindowsUpdateActivationAdapterError,
  WindowsUpdateActivationAdapters,
  deriveWindowsSteamHandoffLifecycleRequestId,
  deriveWindowsUpdateSmokeRequestId,
  type FixedComponentVersionProbeRequest,
  type WindowsSteamManualHandoffTransactionProvider,
  type WindowsUpdateActivationTransactionProvider
} from './windows-update-activation.js'

const requestId = '11111111-1111-4111-8111-111111111111'
const revision = 'a'.repeat(64)
const saveIdentity = 'c'.repeat(64)
const protectionManifestSha256 = 'd'.repeat(64)
const startupGenerationId = 'e'.repeat(64)
const hostMutationScope: HostMutationOperationScope = {
  signal: new AbortController().signal,
  assertActive: () => undefined,
  toPowerShellBorrowArguments: () => []
}

describe('Windows component update activation adapters', () => {
  it('strictly maps stopped proof and a verified save protection point', async () => {
    const fixture = createFixture()

    await expect(fixture.adapter.verifyStoppedState({
      requestId,
      component: 'nebula',
      phase: 'before-protection'
    }, hostMutationScope)).resolves.toEqual({ processStopped: true, portClosed: true })
    await expect(fixture.adapter.createSaveProtectionPoint({
      requestId,
      purpose: 'component-update',
      component: 'nebula',
      targetVersion: '0.9.22',
      expectedRevision: revision
    }, hostMutationScope)).resolves.toEqual({
      requestId,
      status: 'succeeded',
      backupId: `save:${requestId}`,
      manifestSha256: protectionManifestSha256,
      saveIdentity,
      pairProtected: true,
      durable: true
    })

    expect(fixture.lifecycle.contexts.map((entry) => entry.method)).toEqual([
      'verifyStopped',
      'createProtectionPoint'
    ])
    expect(fixture.lifecycle.contexts.every((entry) => entry.context.action === 'restart')).toBe(true)
    expect(fixture.lifecycle.contexts.every((entry) => entry.context.protectionPointId === null)).toBe(true)
    expect(fixture.lifecycle.contexts.every(
      (entry) => entry.context.signal === hostMutationScope.signal
    )).toBe(true)
  })

  it('rejects incomplete stopped evidence and an unverified or unbounded protection receipt', async () => {
    const stopped = createFixture()
    stopped.lifecycle.stoppedResult = {
      summary: 'fixture stopped proof',
      evidence: { processVerified: true, gamePortListening: true }
    }
    await expect(stopped.adapter.verifyStoppedState({
      requestId, component: 'nebula', phase: 'before-publish'
    }, hostMutationScope)).rejects.toEqual(expect.objectContaining<Partial<WindowsUpdateActivationAdapterError>>({
      code: 'WINDOWS_UPDATE_STOP_PROOF_FAILED'
    }))

    const protection = createFixture()
    protection.lifecycle.protectionResult = {
      summary: 'fixture protection',
      protectionPointId: `save:${requestId}`,
      evidence: { dsvBytes: 10, serverBytes: 5, manifestVerified: false, reused: false }
    }
    await expect(protection.adapter.createSaveProtectionPoint({
      requestId, purpose: 'component-update', component: 'nebula', targetVersion: '0.9.22', expectedRevision: revision
    }, hostMutationScope)).rejects.toEqual(expect.objectContaining<Partial<WindowsUpdateActivationAdapterError>>({
      code: 'WINDOWS_UPDATE_SAVE_PROTECTION_FAILED'
    }))

    protection.lifecycle.protectionResult = {
      summary: 'fixture protection',
      protectionPointId: 'save:C:\\not-an-id',
      evidence: { dsvBytes: 10, serverBytes: 5, manifestVerified: true, reused: false }
    }
    await expect(protection.adapter.createSaveProtectionPoint({
      requestId, purpose: 'component-update', component: 'nebula', targetVersion: '0.9.22', expectedRevision: revision
    }, hostMutationScope)).rejects.toMatchObject({ code: 'WINDOWS_UPDATE_SAVE_PROTECTION_FAILED' })
  })

  it('runs the fixed smoke sequence and returns the server to proven stopped state', async () => {
    const fixture = createFixture()
    const request = smokeRequest('nebula', 'candidate', '0.9.22')
    const expectedContextId = deriveWindowsUpdateSmokeRequestId(request)

    await expect(fixture.adapter.smoke(request, hostMutationScope)).resolves.toEqual({
      component: 'nebula',
      observedVersion: '0.9.22',
      versionMatches: true,
      bepInExLoaded: true,
      nebulaLoaded: true,
      processHealthy: true,
      portHealthy: true,
      startupGenerationId,
      bridgeHeartbeatGenerationId: startupGenerationId,
      loadedSaveLogGenerationId: startupGenerationId,
      loadedSaveIdentity: saveIdentity
    })
    expect(fixture.events).toEqual(['start', 'verify-running', 'status', 'stop', 'verify-stopped'])
    expect(fixture.lifecycle.contexts.map((entry) => entry.context.requestId)).toEqual([
      expectedContextId, expectedContextId, expectedContextId, expectedContextId
    ])
    expect(fixture.lifecycle.contexts.every((entry) => entry.context.jobId === `update-smoke:${expectedContextId}`)).toBe(true)
    expect(expectedContextId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(fixture.probeCalls).toEqual([])
  })

  it('accepts an unmanaged predecessor version only for rollback, never for candidate activation', async () => {
    const status = healthyStatus()
    status.versions.bepInEx = '5.4.17.0'
    const rollback = createFixture({ status })
    const request = { ...smokeRequest('bepinex', 'rollback', '5.4.17.0'), expectedReleaseId: null }
    expect(await rollback.adapter.smoke(request, hostMutationScope))
      .toMatchObject({ observedVersion: '5.4.17.0', versionMatches: true, processHealthy: true })
    const candidate = createFixture({ status })
    await expect(candidate.adapter.smoke({ ...request, phase: 'candidate' }, hostMutationScope))
      .rejects.toMatchObject({ code: 'WINDOWS_UPDATE_REQUEST_INVALID' })
    expect(candidate.events).toEqual([])
  })

  it('derives the same lifecycle context for an idempotent smoke and separates phase/component contexts', async () => {
    const first = createFixture()
    const request = smokeRequest('nebula', 'candidate', '0.9.22')
    await first.adapter.smoke(request, hostMutationScope)
    const firstIds = first.lifecycle.contexts.map((entry) => entry.context.requestId)
    first.events.length = 0
    first.lifecycle.contexts.length = 0
    await first.adapter.smoke(request, hostMutationScope)
    expect(first.lifecycle.contexts.map((entry) => entry.context.requestId)).toEqual(firstIds)

    expect(deriveWindowsUpdateSmokeRequestId(request)).not.toBe(deriveWindowsUpdateSmokeRequestId({
      requestId, component: 'nebula', phase: 'rollback'
    }))
    expect(deriveWindowsUpdateSmokeRequestId(request)).not.toBe(deriveWindowsUpdateSmokeRequestId({
      requestId, component: 'bepinex', phase: 'candidate'
    }))
  })

  it('uses only the construction-time fixed probe for bridge/control and reports a version mismatch', async () => {
    const fixture = createFixture({ probedVersion: '0.2.1' })
    const result = await fixture.adapter.smoke(
      smokeRequest('bridge', 'candidate', '0.2.0'), hostMutationScope
    )

    expect(result).toMatchObject({
      component: 'bridge', observedVersion: '0.2.1', versionMatches: false,
      bepInExLoaded: true, nebulaLoaded: true, processHealthy: true, portHealthy: true
    })
    expect(fixture.events).toEqual(['start', 'verify-running', 'status', 'probe:bridge', 'stop', 'verify-stopped'])
    expect(fixture.probeCalls).toHaveLength(1)
    expect(Object.keys(fixture.probeCalls[0]!).sort()).toEqual(['component', 'signal'])
    expect(fixture.probeCalls[0]!.component).toBe('bridge')
    expect(Object.isFrozen(fixture.probeCalls[0]!)).toBe(true)
  })

  it('requires the exact RC release and never treats its numeric file version as equivalent', async () => {
    const exactRelease = createFixture({ probedVersion: '0.1.0-rc.1' })
    await expect(exactRelease.adapter.smoke(
      smokeRequest('bridge', 'candidate', '0.1.0-rc.1'), hostMutationScope
    )).resolves.toMatchObject({
      component: 'bridge', observedVersion: '0.1.0-rc.1', versionMatches: true
    })

    const numericFileVersion = createFixture({ probedVersion: '0.1.0.0' })
    await expect(numericFileVersion.adapter.smoke(
      smokeRequest('bridge', 'candidate', '0.1.0-rc.1'), hostMutationScope
    )).resolves.toMatchObject({
      component: 'bridge', observedVersion: '0.1.0.0', versionMatches: false
    })
  })

  it('fails closed when current-generation load evidence cannot bind to runtime status and still stops', async () => {
    const status = healthyStatus()
    status.state = 'unknown'
    status.runtime.processId = null
    status.versions.gameLoaded = false
    status.versions.compatible = false
    status.versions.warnings = ['game-load-incomplete']
    status.connections[0] = { ...status.connections[0]!, status: 'warning' }
    const fixture = createFixture({ status })

    await expect(fixture.adapter.smoke(
      smokeRequest('nebula', 'candidate', '0.9.22'), hostMutationScope
    )).rejects.toMatchObject({ code: 'WINDOWS_UPDATE_SMOKE_LOAD_EVIDENCE_FAILED' })
    expect(fixture.events.slice(-2)).toEqual(['stop', 'verify-stopped'])
  })

  it('compensates a failed start and preserves the primary failure after proving stopped', async () => {
    const fixture = createFixture()
    fixture.lifecycle.startFailures = 1

    await expect(fixture.adapter.smoke(
      smokeRequest('nebula', 'candidate', '0.9.22'), hostMutationScope
    ))
      .rejects.toMatchObject({ code: 'WINDOWS_UPDATE_SMOKE_START_FAILED' })
    expect(fixture.events).toEqual(['start', 'stop', 'verify-stopped'])
  })

  it('retries graceful stop in finally and fails the smoke even when compensation proves stopped', async () => {
    const fixture = createFixture()
    fixture.lifecycle.stopFailures = 1

    await expect(fixture.adapter.smoke(
      smokeRequest('nebula', 'candidate', '0.9.22'), hostMutationScope
    ))
      .rejects.toMatchObject({ code: 'WINDOWS_UPDATE_SMOKE_STOP_FAILED' })
    expect(fixture.events).toEqual([
      'start', 'verify-running', 'status', 'stop', 'stop', 'verify-stopped'
    ])
  })

  it('compensates status/probe exceptions and never reports success from provider failure', async () => {
    const statusFailure = createFixture({ statusFailure: true })
    await expect(statusFailure.adapter.smoke(
      smokeRequest('nebula', 'candidate', '0.9.22'), hostMutationScope
    ))
      .rejects.toMatchObject({ code: 'WINDOWS_UPDATE_SMOKE_STATUS_FAILED' })
    expect(statusFailure.events).toEqual(['start', 'verify-running', 'status', 'stop', 'verify-stopped'])

    const probeFailure = createFixture({ probeFailure: true })
    await expect(probeFailure.adapter.smoke(
      smokeRequest('control', 'candidate', '0.2.0'), hostMutationScope
    ))
      .rejects.toMatchObject({ code: 'WINDOWS_UPDATE_SMOKE_VERSION_PROBE_FAILED' })
    expect(probeFailure.events).toEqual([
      'start', 'verify-running', 'status', 'probe:control', 'stop', 'verify-stopped'
    ])
  })

  it('overrides every primary result when stopped state cannot be proven', async () => {
    const fixture = createFixture()
    fixture.lifecycle.stopFailures = 2
    fixture.lifecycle.verifyStoppedFailures = 1

    await expect(fixture.adapter.smoke(
      smokeRequest('nebula', 'candidate', '0.9.22'), hostMutationScope
    ))
      .rejects.toMatchObject({ code: 'WINDOWS_UPDATE_SMOKE_STOP_UNPROVEN' })
    expect(fixture.events).toEqual([
      'start', 'verify-running', 'status', 'stop', 'stop', 'verify-stopped'
    ])
  })

  it('rejects arbitrary request fields before lifecycle or probe invocation and disables non-Windows/demo wiring', async () => {
    const fixture = createFixture()
    await expect(fixture.adapter.smoke({
      ...smokeRequest('nebula', 'candidate', '0.9.22'),
      path: 'C:\\Fictional\\payload',
      command: 'not-allowed',
      url: 'https://untrusted.invalid'
    } as never, hostMutationScope)).rejects.toMatchObject({ code: 'WINDOWS_UPDATE_REQUEST_INVALID' })
    expect(fixture.events).toEqual([])

    const disabled = new FakeLifecycleAdapter([])
    Object.defineProperty(disabled, 'mutationEnabled', { value: false })
    expect(() => new WindowsUpdateActivationAdapters({
      lifecycleAdapter: disabled,
      statusProvider: new FakeStatusProvider([], healthyStatus()),
      componentVersionProbe: async () => null
    })).toThrowError(expect.objectContaining({ code: 'WINDOWS_UPDATE_LIFECYCLE_DISABLED' }))

    const demo = new FakeStatusProvider([], healthyStatus())
    Object.defineProperty(demo, 'name', { value: 'demo' })
    expect(() => new WindowsUpdateActivationAdapters({
      lifecycleAdapter: new FakeLifecycleAdapter([]),
      statusProvider: demo,
      componentVersionProbe: async () => null
    })).toThrowError(expect.objectContaining({ code: 'WINDOWS_UPDATE_STATUS_PROVIDER_INVALID' }))
  })

  it('maps the fixed Windows protection/stop boundary for the official Steam-client handoff', async () => {
    const fixture = createFixture()
    const targetVersion = '0.10.33.26727'

    await expect(fixture.adapter.captureBaseline({
      requestId, targetVersion, expectedRevision: revision
    }, hostMutationScope)).resolves.toEqual({
      dspVersion: targetVersion,
      compatibilityRevision: '7'.repeat(64),
      compatible: true,
      loadedSaveIdentity: saveIdentity
    })
    await expect(fixture.adapter.createProtectionPoint({
      requestId, targetVersion
    }, hostMutationScope)).resolves.toEqual({
      requestId,
      backupId: `save:${requestId}`,
      manifestSha256: protectionManifestSha256,
      saveIdentity,
      pairProtected: true,
      durable: true
    })
    await expect(fixture.adapter.requestGracefulStop({ requestId }, hostMutationScope))
      .resolves.toEqual({ dispatched: true })
    await expect(fixture.adapter.verifyStopped({ requestId }, hostMutationScope))
      .resolves.toEqual({ processStopped: true, portClosed: true })
    const lifecycleId = deriveWindowsSteamHandoffLifecycleRequestId(requestId, 'prepare')
    expect(fixture.lifecycle.contexts.slice(-3).map((entry) => entry.context.requestId))
      .toEqual([lifecycleId, lifecycleId, lifecycleId])
  })

  it('resamples and starts only from fixed evidence, proving exact save plus one bridge/log generation', async () => {
    const fixture = createFixture()
    const targetVersion = '0.10.33.26727'

    await expect(fixture.adapter.resampleUpdatedRuntime({ requestId, targetVersion }, hostMutationScope))
      .resolves.toEqual({
        dspVersion: targetVersion,
        compatibilityRevision: '8'.repeat(64),
        compatible: true
      })
    await expect(fixture.adapter.startAndVerifyExactSave({
      requestId, targetVersion, expectedLoadedSaveIdentity: saveIdentity
    }, hostMutationScope)).resolves.toEqual({
      dspVersion: targetVersion,
      compatibilityRevision: '8'.repeat(64),
      compatible: true,
      startupGenerationId,
      bridgeHeartbeatGenerationId: startupGenerationId,
      loadedSaveLogGenerationId: startupGenerationId,
      loadedSaveIdentity: saveIdentity
    })
    expect(fixture.events).toEqual(['start', 'verify-running', 'status'])
    expect(fixture.events).not.toContain('stop')
  })

  it('compensates and fails closed when health exists but current-generation exact-save proof is wrong', async () => {
    const fixture = createFixture({ steamBridgeGeneration: 'f'.repeat(64) })
    const targetVersion = '0.10.33.26727'

    await expect(fixture.adapter.startAndVerifyExactSave({
      requestId, targetVersion, expectedLoadedSaveIdentity: saveIdentity
    }, hostMutationScope)).rejects.toMatchObject({
      code: 'WINDOWS_STEAM_HANDOFF_EXACT_SAVE_LOAD_UNPROVEN'
    })
    expect(fixture.events).toEqual([
      'start', 'verify-running', 'status', 'stop', 'verify-stopped'
    ])
  })

  it('fails closed before Windows lifecycle mutation when the fixed Steam evidence provider is absent', async () => {
    const events: string[] = []
    const adapter = new WindowsUpdateActivationAdapters({
      lifecycleAdapter: new FakeLifecycleAdapter(events),
      statusProvider: new FakeStatusProvider(events, healthyStatus()),
      componentVersionProbe: async () => null
    })
    await expect(adapter.captureBaseline({
      requestId, targetVersion: '0.10.33.26727', expectedRevision: revision
    }, hostMutationScope)).rejects.toMatchObject({ code: 'WINDOWS_STEAM_HANDOFF_CAPABILITY_UNAVAILABLE' })
    expect(events).toEqual([])
  })
})

interface FixtureOptions {
  status?: ServerStatus
  statusFailure?: boolean
  probedVersion?: string | null
  probeFailure?: boolean
  steamBridgeGeneration?: string
  steamLogGeneration?: string
  steamLoadedSaveIdentity?: string
}

function createFixture(options: FixtureOptions = {}) {
  const events: string[] = []
  const lifecycle = new FakeLifecycleAdapter(events)
  const statusProvider = new FakeStatusProvider(events, options.status ?? healthyStatus())
  statusProvider.failure = options.statusFailure ?? false
  const probeCalls: Readonly<FixedComponentVersionProbeRequest>[] = []
  const adapter = new WindowsUpdateActivationAdapters({
    lifecycleAdapter: lifecycle,
    statusProvider,
    componentVersionProbe: async (request) => {
      events.push(`probe:${request.component}`)
      probeCalls.push(request)
      if (options.probeFailure === true) throw new Error('fixture probe failure')
      return options.probedVersion ?? '0.2.0'
    },
    transactionProvider: fakeTransactionProvider(options.status ?? healthyStatus(), options)
  })
  return { adapter, lifecycle, statusProvider, events, probeCalls }
}

function smokeRequest(
  component: FixedUpdateSmokeRequest['component'],
  phase: FixedUpdateSmokeRequest['phase'],
  expectedVersion: string | null
): FixedUpdateSmokeRequest {
  return {
    requestId,
    component,
    phase,
    expectedVersion,
    expectedReleaseId: expectedVersion === null ? null : `${component}-${'b'.repeat(32)}`,
    expectedLoadedSaveIdentity: saveIdentity
  }
}

function fakeTransactionProvider(
  status: ServerStatus,
  options: FixtureOptions = {}
): WindowsUpdateActivationTransactionProvider & WindowsSteamManualHandoffTransactionProvider {
  const readback = {
    configurationSnapshotId: 'config-snapshot-fixture',
    configurationRevision: '1'.repeat(64),
    serverModLockSha256: '2'.repeat(64),
    serverModLockRevision: '3'.repeat(64),
    protectionManifestSha256,
    loadedSaveIdentity: saveIdentity
  }
  return {
    captureRollbackBaseline: async () => ({
      configurationSnapshotId: readback.configurationSnapshotId,
      configurationRevision: readback.configurationRevision,
      serverModLockSha256: readback.serverModLockSha256,
      serverModLockRevision: readback.serverModLockRevision,
      previousLoadedSaveIdentity: saveIdentity
    }),
    inspectProtectionPoint: async () => ({ manifestSha256: protectionManifestSha256, saveIdentity }),
    restoreConfiguration: async () => ({ restored: true, rereadVerified: true }),
    restoreServerModLock: async () => ({ restored: true, rereadVerified: true }),
    restorePairedSave: async () => ({ restored: true, rereadVerified: true }),
    inspectRollbackReadback: async () => readback,
    probeRuntimeLoadEvidence: async () => ({
      processId: status.runtime.processId,
      startedAt: status.runtime.startedAt,
      startupGenerationId,
      bridgeHeartbeatGenerationId: startupGenerationId,
      loadedSaveLogGenerationId: startupGenerationId,
      loadedSaveIdentity: saveIdentity
    }),
    captureSteamManualBaseline: async () => ({
      dspVersion: status.versions.dsp,
      compatibilityRevision: '7'.repeat(64),
      compatible: true,
      loadedSaveIdentity: saveIdentity
    }),
    resampleSteamManualRuntime: async () => ({
      dspVersion: status.versions.dsp,
      compatibilityRevision: '8'.repeat(64),
      compatible: true
    }),
    probeSteamManualLoadEvidence: async () => ({
      processId: status.runtime.processId,
      startedAt: status.runtime.startedAt,
      dspVersion: status.versions.dsp,
      compatibilityRevision: '8'.repeat(64),
      compatible: true,
      startupGenerationId,
      bridgeHeartbeatGenerationId: options.steamBridgeGeneration ?? startupGenerationId,
      loadedSaveLogGenerationId: options.steamLogGeneration ?? startupGenerationId,
      loadedSaveIdentity: options.steamLoadedSaveIdentity ?? saveIdentity
    })
  }
}

class FakeLifecycleAdapter implements LifecycleMutationAdapter {
  readonly mutationEnabled = true
  readonly contexts: Array<{ method: string; context: LifecycleOperationContext }> = []
  readonly #events: string[]
  startFailures = 0
  stopFailures = 0
  verifyStoppedFailures = 0
  stoppedResult: LifecyclePhaseResult = {
    summary: 'fixture stopped proof',
    evidence: { processVerified: true, gamePortListening: false }
  }
  protectionResult: LifecyclePhaseResult = {
    summary: 'fixture protection point',
    protectionPointId: `save:${requestId}`,
    evidence: { dsvBytes: 1024, serverBytes: 256, manifestVerified: true, reused: false }
  }

  constructor(events: string[]) {
    this.#events = events
  }

  previewLifecycle(_action: LifecycleAction, _context: LifecyclePreviewContext): Promise<LifecyclePreview> {
    throw new Error('not used by update activation adapter')
  }

  async createProtectionPoint(context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    this.#record('createProtectionPoint', context)
    return this.protectionResult
  }

  requestSave(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    throw new Error('not used by update activation adapter')
  }

  async requestGracefulStop(context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    this.#events.push('stop')
    this.#record('requestGracefulStop', context)
    if (this.stopFailures > 0) {
      this.stopFailures--
      throw new Error('fixture stop failure')
    }
    return { summary: 'fixture stopped', evidence: { outcome: 'stopped', processVerified: true } }
  }

  async verifyStopped(context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    this.#events.push('verify-stopped')
    this.#record('verifyStopped', context)
    if (this.verifyStoppedFailures > 0) {
      this.verifyStoppedFailures--
      throw new Error('fixture stopped proof failure')
    }
    return this.stoppedResult
  }

  async requestStart(context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    this.#events.push('start')
    this.#record('requestStart', context)
    if (this.startFailures > 0) {
      this.startFailures--
      throw new Error('fixture start failure')
    }
    return { summary: 'fixture started', evidence: { outcome: 'started', processVerified: true } }
  }

  async verifyRunning(context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    this.#events.push('verify-running')
    this.#record('verifyRunning', context)
    return { summary: 'fixture running', evidence: { processVerified: true, gamePortListening: true } }
  }

  requestRollbackStart(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    throw new Error('not used by update activation adapter')
  }

  #record(method: string, context: LifecycleOperationContext): void {
    this.contexts.push({ method, context })
  }
}

class FakeStatusProvider implements StatusProvider {
  readonly name = 'windows' as const
  readonly #events: string[]
  readonly #status: ServerStatus
  failure = false

  constructor(events: string[], status: ServerStatus) {
    this.#events = events
    this.#status = status
  }

  async collectStatus(): Promise<ServerStatus> {
    this.#events.push('status')
    if (this.failure) throw new Error('fixture status failure')
    return structuredClone(this.#status)
  }

  previewLifecycle(_action: LifecycleAction): Promise<LifecyclePreview> {
    throw new Error('not used by update activation adapter')
  }
}

function healthyStatus(): ServerStatus {
  return {
    collectedAt: '2026-08-30T12:00:00.000Z',
    serverName: 'Fictional DSP server',
    state: 'running',
    runtime: {
      targetUps: 60,
      onlinePlayers: 0,
      maxPlayers: 20,
      processId: 4242,
      processCoresUsed: 2,
      workingSetGiB: 4,
      privateMemoryGiB: 5,
      threadCount: 100,
      priority: 'High',
      startedAt: '2026-08-30T11:59:00.000Z',
      uptimeSeconds: 60
    },
    host: {
      logicalProcessors: 8,
      processorGroups: 1,
      cpuPercent: 10,
      memoryTotalGiB: 32,
      memoryFreeGiB: 24
    },
    versions: {
      dsp: '0.10.33.26727',
      nebula: '0.9.22',
      bepInEx: '5.4.22',
      compatible: true,
      gameLoaded: true,
      warnings: []
    },
    save: {
      name: 'Fictional_Save',
      dsvPresent: true,
      serverPresent: true,
      consistent: true,
      lastSavedAt: '2026-08-30T11:58:00.000Z',
      dsvSizeMiB: 100,
      serverSizeKiB: 100,
      latestBackupAt: '2026-08-30T11:55:00.000Z',
      backupManifestPresent: true,
      backupPairPresent: true
    },
    automation: {
      serverTask: { state: 'running', lastResult: 0, lastRunAt: '2026-08-30T11:59:00.000Z' },
      stopTask: { state: 'ready', lastResult: 0, lastRunAt: '2026-08-30T11:55:00.000Z' },
      storageTask: { state: 'ready', lastResult: 0, lastRunAt: '2026-08-30T11:50:00.000Z' },
      projectRootAvailable: true,
      globalMappingAvailable: true
    },
    connections: [
      { id: 'game-port', label: 'Fictional game port', status: 'healthy', detail: 'Fictional listener is healthy' },
      { id: 'public-wss', label: 'Fictional public check', status: 'unknown', detail: 'Not used by smoke' }
    ],
    capabilities: { refresh: true, start: true, save: true, gracefulStop: true, restart: true }
  }
}

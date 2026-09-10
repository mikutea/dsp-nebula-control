import { describe, expect, it, vi } from 'vitest'
import { WindowsLifecycleBrokerClientError } from './windows-lifecycle-broker.js'
import type { BridgeHeartbeat, BridgeReceipt } from '../bridge/protocol.js'
import {
  LifecycleExecutionError,
  type LifecycleAction,
  type LifecycleOperationContext,
  type LifecyclePreview,
  type ServerStatus,
  type StatusProvider
} from '../domain.js'
import { DemoProvider } from './demo.js'
import type { LifecycleScriptName, LifecycleScriptRunner } from './powershell-runner.js'
import type {
  LifecycleBrokerDispatchEvidence,
  LifecycleBrokerPreflightEvidence,
  LifecycleBrokerStatusEvidence,
  WindowsLifecycleBrokerClient
} from './windows-lifecycle-broker.js'
import { WindowsLifecycleAdapter, type LifecycleBridgeClient } from './windows-lifecycle.js'

const requestId = '11111111-2222-4333-8444-555555555555'

describe('Windows lifecycle adapter', () => {
  it('turns a live compatible game bridge heartbeat into an executable save preview', async () => {
    const adapter = createAdapter().adapter
    const preview = await adapter.previewLifecycle('save')

    expect(preview).toMatchObject({ allowed: true, executionEnabled: true, blockers: [] })
    expect(preview.checks.find((check) => check.id === 'save-trigger')).toMatchObject({ status: 'pass' })
    expect(preview.checks.find((check) => check.id === 'execution-lock')).toMatchObject({ status: 'pass' })

    const busyPreview = await adapter.previewLifecycle('save', { executionLockReady: false })
    expect(busyPreview.allowed).toBe(false)
    expect(busyPreview.blockers).toContain('execution-lock-busy')
    expect(busyPreview.checks.find((check) => check.id === 'execution-lock')).toMatchObject({ status: 'block' })
  })

  it('maps fixed host scripts and the signed bridge receipt into bounded phase results', async () => {
    const { adapter, runner, bridge, broker } = createAdapter()
    const context = operationContext('restart')

    await expect(adapter.createProtectionPoint(context)).resolves.toMatchObject({
      protectionPointId: `save:${requestId}`,
      evidence: {
        manifestVerified: true, sourcePairVerified: true, mutationPerformed: true,
        dsvBytes: 1024, serverBytes: 256
      }
    })
    await expect(adapter.requestSave(context)).resolves.toMatchObject({
      evidence: {
        generationId: 'generation-v1:6899cf8e7a311b70bbb961477ea9e650c852dcf19ae760488a9183d9518172bd',
        saveAdvanced: true,
        dsvBytes: 2048,
        serverBytes: 512
      }
    })
    await expect(adapter.requestGracefulStop(context)).resolves.toMatchObject({
      evidence: { dispatched: true, taskName: 'Dyson-Nebula-Stop', readyVerified: true }
    })
    await expect(adapter.verifyStopped(context)).resolves.toMatchObject({
      evidence: { processVerified: true, gamePortListening: false }
    })
    await expect(adapter.requestStart(context)).resolves.toMatchObject({
      evidence: { dispatched: true, taskName: 'Dyson-Nebula-Server', readyVerified: true }
    })
    await expect(adapter.verifyRunning(context)).resolves.toMatchObject({
      evidence: { processVerified: true, gamePortListening: true }
    })
    await expect(adapter.requestRollbackStart(context)).resolves.toMatchObject({
      evidence: { dispatched: true, taskName: 'Dyson-Nebula-Server', readyVerified: true }
    })

    expect(bridge.saveRequestIds).toEqual([requestId])
    expect(runner.calls.map((call) => call.scriptName)).toEqual(['New-DysonSaveProtectionPoint.ps1'])
    expect(runner.calls[0]?.arguments).toEqual([
      '-ProjectRoot', 'C:\\Fictional\\Dyson', '-RequestId', requestId
    ])
    expect(broker.dispatches.map((call) => call.operation)).toEqual([
      'graceful-stop', 'start', 'rollback-start'
    ])
    expect(broker.verifications.map((call) => call.expected)).toEqual(['stopped', 'running'])
  })

  it('allows a stopped-runtime start preview without probing the unavailable in-game bridge', async () => {
    const fixture = createAdapter(new StartReadyStatusProvider())
    fixture.bridge.probeFailure = true

    const preview = await fixture.adapter.previewLifecycle('start')

    expect(preview).toMatchObject({ action: 'start', allowed: true, executionEnabled: true, blockers: [] })
    expect(preview.rollback).toMatchObject({ strategy: 'no-op', ready: true })
    expect(fixture.bridge.probeCalls).toBe(0)
  })

  it('uses the SYSTEM broker as the authoritative source when legacy preflight omits runtime evidence', async () => {
    const provider = new StartReadyStatusProvider()
    provider.omitGamePortEvidence = true
    const fixture = createAdapter(provider)

    const preview = await fixture.adapter.previewLifecycle('start')

    expect(preview.allowed).toBe(true)
    expect(preview.checks.find((check) => check.id === 'game-port')).toMatchObject({ status: 'pass' })
    expect(fixture.runner.calls).toEqual([])
  })

  it('fails closed when the SYSTEM lifecycle broker is unavailable', async () => {
    const fixture = createAdapter(new StartReadyStatusProvider())
    fixture.broker.preflightFailure = true

    const preview = await fixture.adapter.previewLifecycle('start')

    expect(preview.allowed).toBe(false)
    expect(preview.blockers).toEqual(expect.arrayContaining([
      'lifecycle-broker-unavailable', 'start-preflight-incomplete'
    ]))
    expect(preview.checks.find((check) => check.id === 'lifecycle-broker'))
      .toMatchObject({ status: 'block' })
  })

  it('never reports an allowed preview when broker-derived checks are blocking', async () => {
    const fixture = createAdapter(new StartReadyStatusProvider())
    fixture.broker.preflightOverride = {
      ...await fixture.broker.preflight({
        action: 'start', signal: new AbortController().signal
      }),
      runtime: {
        ...brokerRuntime('stopped'),
        steam: { status: 'missing', pid: null, sessionId: null }
      }
    }

    const preview = await fixture.adapter.previewLifecycle('start')

    expect(preview.allowed).toBe(false)
    expect(preview.checks.find((check) => check.id === 'steam-session')).toMatchObject({ status: 'block' })
  })

  it('fails verification when an injected broker contradicts the requested runtime state', async () => {
    const fixture = createAdapter()
    fixture.broker.verifyOverride = {
      expected: 'running', matched: false, blockers: [], runtime: brokerRuntime('stopped')
    }

    await expect(fixture.adapter.verifyRunning(operationContext('start'))).rejects.toMatchObject({
      code: 'WINDOWS_LIFECYCLE_BROKER_RESULT_INVALID'
    })
  })

  it('keeps execution blocked for a stale or incompatible bridge and preserves bridge failure codes', async () => {
    const fixture = createAdapter()
    fixture.bridge.pluginVersion = '9.9.9'
    const preview = await fixture.adapter.previewLifecycle('save')
    expect(preview.allowed).toBe(false)
    expect(preview.blockers).toContain('save-trigger-unverified')

    fixture.bridge.failedSaveCode = 'GAME_NOT_READY'
    await expect(fixture.adapter.requestSave(operationContext('save'))).rejects.toEqual(
      expect.objectContaining<Partial<LifecycleExecutionError>>({ code: 'GAME_NOT_READY' })
    )
  })

  it('rejects legacy and wrong-slot success receipts from injected bridge adapters', async () => {
    const legacy = createAdapter()
    legacy.bridge.receiptMode = 'legacy-v1'
    await expect(legacy.adapter.requestSave(operationContext('save'))).rejects.toEqual(
      expect.objectContaining<Partial<LifecycleExecutionError>>({ code: 'BRIDGE_RECEIPT_V2_REQUIRED' })
    )

    const wrongSlot = createAdapter()
    wrongSlot.bridge.receiptMode = 'wrong-slot'
    await expect(wrongSlot.adapter.requestSave(operationContext('save'))).rejects.toEqual(
      expect.objectContaining<Partial<LifecycleExecutionError>>({ code: 'BRIDGE_RECEIPT_INCONSISTENT' })
    )
  })

  it('rejects missing V2 evidence and false changed semantics from injected adapters', async () => {
    const incomplete = createAdapter()
    incomplete.bridge.receiptMode = 'missing-evidence'
    await expect(incomplete.adapter.requestSave(operationContext('save'))).rejects.toEqual(
      expect.objectContaining<Partial<LifecycleExecutionError>>({ code: 'BRIDGE_RECEIPT_V2_REQUIRED' })
    )

    const unchanged = createAdapter()
    unchanged.bridge.receiptMode = 'unchanged'
    await expect(unchanged.adapter.requestSave(operationContext('save'))).rejects.toEqual(
      expect.objectContaining<Partial<LifecycleExecutionError>>({ code: 'BRIDGE_RECEIPT_INCONSISTENT' })
    )
  })

  it('rejects malformed host receipts with one stable adapter error', async () => {
    const fixture = createAdapter()
    fixture.runner.malformedProtection = true
    await expect(fixture.adapter.createProtectionPoint(operationContext('save'))).rejects.toEqual(
      expect.objectContaining<Partial<LifecycleExecutionError>>({ code: 'HOST_RECEIPT_INVALID' })
    )

    const preview = createAdapter()
    preview.runner.previewProtection = true
    await expect(preview.adapter.createProtectionPoint(operationContext('save'))).rejects.toEqual(
      expect.objectContaining<Partial<LifecycleExecutionError>>({ code: 'HOST_RECEIPT_INVALID' })
    )
  })

  it('accepts only request-bound, self-consistent protection execution receipts', async () => {
    const reused = createAdapter()
    reused.runner.protectionMode = 'reused'
    await expect(reused.adapter.createProtectionPoint(operationContext('save'))).resolves.toMatchObject({
      protectionPointId: `save:${requestId}`,
      evidence: {
        sourcePairVerified: true, manifestVerified: true,
        mutationPerformed: false, reused: true
      }
    })

    const wrongPoint = createAdapter()
    wrongPoint.runner.protectionMode = 'wrong-point'
    await expect(wrongPoint.adapter.createProtectionPoint(operationContext('save'))).rejects.toEqual(
      expect.objectContaining<Partial<LifecycleExecutionError>>({ code: 'HOST_RECEIPT_MISMATCH' })
    )

    const inconsistent = createAdapter()
    inconsistent.runner.protectionMode = 'inconsistent'
    await expect(inconsistent.adapter.createProtectionPoint(operationContext('save'))).rejects.toEqual(
      expect.objectContaining<Partial<LifecycleExecutionError>>({ code: 'HOST_RECEIPT_INVALID' })
    )

    const unverified = createAdapter()
    unverified.runner.protectionMode = 'source-unverified'
    await expect(unverified.adapter.createProtectionPoint(operationContext('save'))).rejects.toEqual(
      expect.objectContaining<Partial<LifecycleExecutionError>>({ code: 'HOST_RECEIPT_INVALID' })
    )
  })
})

class FakeBridgeClient implements LifecycleBridgeClient {
  pluginVersion = '0.1.0-rc.24'
  probeFailure = false
  probeCalls = 0
  failedSaveCode: string | null = null
  receiptMode: 'valid-v2' | 'legacy-v1' | 'wrong-slot' | 'missing-evidence' | 'unchanged' = 'valid-v2'
  readonly saveRequestIds: string[] = []

  async probe(): Promise<BridgeHeartbeat> {
    this.probeCalls += 1
    if (this.probeFailure) throw new Error('fixture bridge is unavailable')
    const now = Date.now()
    return {
      protocol: 'DYSON_CONTROL_HEARTBEAT_V1', pluginVersion: this.pluginVersion,
      processId: 4242, startedAtUnixMs: now - 60_000, writtenAtUnixMs: now,
      state: 'ready', hmac: '0'.repeat(64)
    }
  }

  async requestSave(id = requestId): Promise<BridgeReceipt> {
    this.saveRequestIds.push(id)
    const now = Date.now()
    if (this.failedSaveCode) {
      return {
        protocol: 'DYSON_CONTROL_RECEIPT_V2', requestId: id, action: 'save', state: 'failed',
        startedAtUnixMs: now, finishedAtUnixMs: now + 1,
        saveName: '_unavailable_', saveTimeBefore: -1n, saveTimeAfter: -1n,
        dsvBytes: -1, dsvWriteTimeUtcTicks: -1n,
        serverBytes: -1, serverWriteTimeUtcTicks: -1n,
        dsvChanged: false, serverChanged: false,
        errorCode: this.failedSaveCode, hmac: '0'.repeat(64)
      }
    }
    if (this.receiptMode === 'legacy-v1') {
      return {
        protocol: 'DYSON_CONTROL_RECEIPT_V1', requestId: id, action: 'save', state: 'succeeded',
        startedAtUnixMs: now, finishedAtUnixMs: now + 25,
        saveTimeBefore: 100, saveTimeAfter: 101, dsvBytes: 2048, serverBytes: 512,
        errorCode: 'NONE', hmac: '0'.repeat(64)
      }
    }
    const receipt: BridgeReceipt = {
      protocol: 'DYSON_CONTROL_RECEIPT_V2', requestId: id, action: 'save', state: 'succeeded',
      startedAtUnixMs: now, finishedAtUnixMs: now + 25,
      saveName: this.receiptMode === 'wrong-slot' ? '_autosave_' : '_lastexit_',
      saveTimeBefore: 100n, saveTimeAfter: 101n,
      dsvBytes: 2048, dsvWriteTimeUtcTicks: 638817408010000001n,
      serverBytes: 512, serverWriteTimeUtcTicks: 638817408010000002n,
      dsvChanged: this.receiptMode !== 'unchanged', serverChanged: true,
      errorCode: 'NONE', hmac: '0'.repeat(64)
    }
    if (this.receiptMode === 'missing-evidence') delete receipt.serverWriteTimeUtcTicks
    return receipt
  }
}

class FakeLifecycleScriptRunner implements LifecycleScriptRunner {
  readonly calls: Array<{ scriptName: LifecycleScriptName; arguments: string[] }> = []
  malformedProtection = false
  previewProtection = false
  protectionMode: 'created' | 'reused' | 'wrong-point' | 'inconsistent' | 'source-unverified' = 'created'

  async run(scriptName: LifecycleScriptName, arguments_: string[]): Promise<string> {
    this.calls.push({ scriptName, arguments: arguments_ })
    if (scriptName === 'New-DysonSaveProtectionPoint.ps1') {
      if (this.malformedProtection) return '{"unexpected":true}'
      if (this.previewProtection) {
        return JSON.stringify({
          protocol: 'DYSON_CONTROL_PROTECTION_V1', schemaVersion: 1, requestId,
          state: 'preview', dryRun: true, mutationPerformed: false,
          protectionPointId: `save:${requestId}`, sourcePairVerified: true,
          dsvBytes: 1024, serverBytes: 256, manifestVerified: false, reused: false,
          wouldCreate: true, wouldRemoveStaleStaging: false
        })
      }
      return JSON.stringify({
        protocol: 'DYSON_CONTROL_PROTECTION_V1', schemaVersion: 1, requestId,
        state: 'succeeded', dryRun: false,
        mutationPerformed: this.protectionMode !== 'reused',
        protectionPointId: this.protectionMode === 'wrong-point'
          ? 'save:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
          : `save:${requestId}`,
        sourcePairVerified: this.protectionMode !== 'source-unverified',
        dsvBytes: 1024, serverBytes: 256, manifestVerified: true,
        reused: this.protectionMode === 'reused' || this.protectionMode === 'inconsistent'
      })
    }
    throw new Error(`Unexpected lifecycle script fixture: ${scriptName}`)
  }
}

function createAdapter(statusProvider: StatusProvider = new DemoProvider()): {
  adapter: WindowsLifecycleAdapter
  bridge: FakeBridgeClient
  runner: FakeLifecycleScriptRunner
  broker: FakeLifecycleBrokerClient
} {
  const bridge = new FakeBridgeClient()
  const runner = new FakeLifecycleScriptRunner()
  const broker = new FakeLifecycleBrokerClient()
  const adapter = new WindowsLifecycleAdapter({
    projectRoot: 'C:\\Fictional\\Dyson',
    runtimeBootstrapRoot: 'C:\\Program Files\\DysonControl\\bootstrap',
    statusProvider,
    scriptRunner: runner,
    brokerClient: broker,
    bridgeClient: bridge
  })
  return { adapter, bridge, runner, broker }
}

function operationContext(action: LifecycleAction): LifecycleOperationContext {
  return {
    jobId: 'fixture-job', requestId, action, protectionPointId: null,
    signal: new AbortController().signal,
    hostMutation: {
      assertActive: () => undefined,
      toPowerShellBorrowArguments: () => [
        '-DataRoot', 'C:\\Fictional\\DysonData',
        '-LeaseInstanceId', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        '-LeaseToken', 'A'.repeat(43)
      ]
    }
  }
}

class FakeLifecycleBrokerClient implements WindowsLifecycleBrokerClient {
  preflightFailure = false
  preflightOverride: LifecycleBrokerPreflightEvidence | null = null
  verifyOverride: Awaited<ReturnType<WindowsLifecycleBrokerClient['verify']>> | null = null
  readonly dispatches: Array<{ operation: 'start' | 'graceful-stop' | 'rollback-start' }> = []
  readonly verifications: Array<{ expected: 'running' | 'stopped' }> = []

  async preflight(input: {
    action: LifecycleAction
    outerRequestId?: string
    signal: AbortSignal
  }): Promise<LifecycleBrokerPreflightEvidence> {
    if (this.preflightFailure) throw new Error('fixture lifecycle broker is unavailable')
    if (this.preflightOverride) return this.preflightOverride
    const stopped = input.action === 'start'
    return {
      action: input.action,
      allowed: true,
      blockers: [],
      task: {
        valid: true,
        server: { name: 'Dyson-Nebula-Server', path: '\\', state: 'Ready' },
        stop: { name: 'Dyson-Nebula-Stop', path: '\\', state: 'Ready' }
      },
      runtime: brokerRuntime(stopped ? 'stopped' : 'running'),
      dispatch: { attempted: false, taskName: null }
    }
  }

  async dispatch(input: {
    operation: 'start' | 'graceful-stop' | 'rollback-start'
    outerRequestId: string
    signal: AbortSignal
  }): Promise<LifecycleBrokerDispatchEvidence> {
    this.dispatches.push({ operation: input.operation })
    return {
      operation: input.operation,
      dispatched: true,
      blockers: [],
      taskName: input.operation === 'graceful-stop' ? 'Dyson-Nebula-Stop' : 'Dyson-Nebula-Server',
      taskPath: '\\',
      readyVerified: true
    }
  }

  async verify(input: {
    expected: 'running' | 'stopped'
    outerRequestId: string
    signal: AbortSignal
  }) {
    this.verifications.push({ expected: input.expected })
    if (this.verifyOverride) return this.verifyOverride
    return {
      expected: input.expected,
      matched: true,
      blockers: [],
      runtime: brokerRuntime(input.expected)
    }
  }

  async status(): Promise<LifecycleBrokerStatusEvidence> {
    const runtime = brokerRuntime('running')
    return {
      lifecycleState: runtime.lifecycleState,
      task: {
        valid: true,
        server: { name: 'Dyson-Nebula-Server', path: '\\', state: 'Running' },
        stop: { name: 'Dyson-Nebula-Stop', path: '\\', state: 'Ready' }
      },
      runtime
    }
  }
}

function brokerRuntime(expected: 'running' | 'stopped') {
  const running = expected === 'running'
  return {
    lifecycleState: running ? 'running_verified' as const : 'stopped_verified' as const,
    session: { status: 'verified' as const, id: 3, count: 1 },
    steam: { status: 'verified' as const, pid: 300, sessionId: 3 },
    process: running
      ? { status: 'verified' as const, pid: 4242, owner: 'FICTIONAL\\DysonGame', sessionId: 3 }
      : { status: 'absent' as const, pid: null, owner: null, sessionId: null },
    port: { port: 8469, listenerCount: running ? 1 : 0 },
    pidFile: { present: running, valid: running }
  }
}

class StartReadyStatusProvider implements StatusProvider {
  readonly name = 'windows' as const
  omitGamePortEvidence = false

  collectStatus(): Promise<ServerStatus> {
    throw new Error('not used by this fixture')
  }

  async previewLifecycle(action: LifecycleAction): Promise<LifecyclePreview> {
    const checks: LifecyclePreview['checks'] = [
      { id: 'project-root', status: 'pass', message: 'fixture project root is available' },
      { id: 'managed-executable', status: 'pass', message: 'fixture executable is fixed and available' },
      { id: 'managed-process', status: 'pass', message: 'fixture managed process is stopped' },
      { id: 'pid-file', status: 'pass', message: 'fixture PID file is absent' },
      { id: 'save-pair', status: 'pass', message: 'fixture save pair is ready' },
      { id: 'server-task', status: 'pass', message: 'fixture start task exists' },
      { id: 'server-task-principal', status: 'pass', message: 'fixture task principal is fixed' },
      { id: 'server-task-action', status: 'pass', message: 'fixture start action is allowlisted' },
      { id: 'receipt-channel', status: 'pass', message: 'fixture receipt channel is ready' },
      { id: 'execution-lock', status: 'block', message: 'provider does not enable execution' }
    ]
    if (!this.omitGamePortEvidence) {
      checks.splice(4, 0, { id: 'game-port', status: 'pass', message: 'fixture game port is stopped' })
    }
    return {
      collectedAt: new Date().toISOString(), action, mode: 'dry-run',
      allowed: false, executionEnabled: false, checks,
      blockers: ['execution-disabled'],
      rollback: { strategy: 'no-op', ready: true, summary: 'start does not change the save pair' }
    }
  }
}

describe('lifecycle verification transitions', () => {
  it.each(['running', 'stopped'] as const)('waits for %s using fresh read-only observations', async expected => {
    const {adapter,broker} = createAdapter()
    const verify = vi.spyOn(broker, 'verify').mockRejectedValueOnce(
      new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_BLOCKED', {blockers:['state_mismatch']}))
    const context = operationContext(expected === 'running' ? 'start' : 'graceful-stop')
    await (expected === 'running' ? adapter.verifyRunning(context) : adapter.verifyStopped(context))
    expect(verify).toHaveBeenCalledTimes(2)
    expect(verify.mock.calls[0]![0].outerRequestId).toBe(requestId)
    expect(verify.mock.calls[1]![0].outerRequestId).not.toBe(requestId)
    expect(broker.dispatches).toHaveLength(0)
  })

  it('cancels a pending observation without retrying or dispatching a task', async () => {
    const {adapter,broker} = createAdapter()
    const verify = vi.spyOn(broker,'verify').mockRejectedValue(
      new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_BLOCKED',{blockers:['process_unverifiable']}))
    const controller = new AbortController()
    const pending = adapter.verifyRunning({...operationContext('start'),signal:controller.signal})
    const timer = setTimeout(()=>controller.abort(),20)
    try { await expect(pending).rejects.toMatchObject({code:'HOST_SCRIPT_ABORTED'}) }
    finally { clearTimeout(timer) }
    expect(verify).toHaveBeenCalledTimes(1)
    expect(broker.dispatches).toHaveLength(0)
  })

  it('does not retry a permanent blocker', async () => {
    const {adapter,broker} = createAdapter()
    const verify = vi.spyOn(broker,'verify').mockRejectedValue(
      new WindowsLifecycleBrokerClientError('WINDOWS_LIFECYCLE_BROKER_BLOCKED',{blockers:['task_definition_mismatch']}))
    await expect(adapter.verifyRunning(operationContext('start'))).rejects.toMatchObject({code:'WINDOWS_LIFECYCLE_BROKER_BLOCKED'})
    expect(verify).toHaveBeenCalledTimes(1)
  })
})
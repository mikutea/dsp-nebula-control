import { describe, expect, it } from 'vitest'
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
    const { adapter, runner, bridge } = createAdapter()
    const context = operationContext('restart')

    await expect(adapter.createProtectionPoint(context)).resolves.toMatchObject({
      protectionPointId: `save:${requestId}`,
      evidence: { manifestVerified: true, dsvBytes: 1024, serverBytes: 256 }
    })
    await expect(adapter.requestSave(context)).resolves.toMatchObject({
      evidence: { saveAdvanced: true, dsvBytes: 2048, serverBytes: 512 }
    })
    await expect(adapter.requestGracefulStop(context)).resolves.toMatchObject({
      evidence: { outcome: 'stopped', processVerified: true }
    })
    await expect(adapter.verifyStopped(context)).resolves.toMatchObject({
      evidence: { processVerified: true, gamePortListening: false }
    })
    await expect(adapter.requestStart(context)).resolves.toMatchObject({
      evidence: { outcome: 'started', processVerified: true }
    })
    await expect(adapter.verifyRunning(context)).resolves.toMatchObject({
      evidence: { processVerified: true, gamePortListening: true }
    })
    await expect(adapter.requestRollbackStart(context)).resolves.toMatchObject({
      evidence: { outcome: 'started', processVerified: true }
    })

    expect(bridge.saveRequestIds).toEqual([requestId])
    expect(runner.calls.map((call) => call.scriptName)).toEqual([
      'New-DysonSaveProtectionPoint.ps1',
      'Invoke-DysonScheduledTask.ps1',
      'Test-DysonRuntimeState.ps1',
      'Invoke-DysonScheduledTask.ps1',
      'Test-DysonRuntimeState.ps1',
      'Invoke-DysonScheduledTask.ps1'
    ])
    expect(runner.calls[1]?.arguments).toEqual(expect.arrayContaining(['-Operation', 'graceful-stop']))
    expect(runner.calls[3]?.arguments).toEqual([
      '-ProjectRoot', 'C:\\Fictional\\Dyson',
      '-RequestId', requestId,
      '-Operation', 'start',
      '-TaskName', 'Dyson-Nebula-Server',
      '-GamePort', '8469'
    ])
    expect(runner.calls[5]?.arguments).toEqual(expect.arrayContaining(['-Operation', 'rollback-start']))
  })

  it('allows a stopped-runtime start preview without probing the unavailable in-game bridge', async () => {
    const fixture = createAdapter(new StartReadyStatusProvider())
    fixture.bridge.probeFailure = true

    const preview = await fixture.adapter.previewLifecycle('start')

    expect(preview).toMatchObject({ action: 'start', allowed: true, executionEnabled: true, blockers: [] })
    expect(preview.rollback).toMatchObject({ strategy: 'no-op', ready: true })
    expect(fixture.bridge.probeCalls).toBe(0)
  })

  it('fails closed when a start preview omits any required stopped-runtime evidence', async () => {
    const provider = new StartReadyStatusProvider()
    provider.omitGamePortEvidence = true
    const fixture = createAdapter(provider)

    const preview = await fixture.adapter.previewLifecycle('start')

    expect(preview.allowed).toBe(false)
    expect(preview.blockers).toContain('start-preflight-incomplete')
    expect(fixture.runner.calls).toEqual([])
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

  it('rejects malformed host receipts with one stable adapter error', async () => {
    const fixture = createAdapter()
    fixture.runner.malformedProtection = true
    await expect(fixture.adapter.createProtectionPoint(operationContext('save'))).rejects.toEqual(
      expect.objectContaining<Partial<LifecycleExecutionError>>({ code: 'HOST_RECEIPT_INVALID' })
    )
  })
})

class FakeBridgeClient implements LifecycleBridgeClient {
  pluginVersion = '0.1.0'
  probeFailure = false
  probeCalls = 0
  failedSaveCode: string | null = null
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
        protocol: 'DYSON_CONTROL_RECEIPT_V1', requestId: id, action: 'save', state: 'failed',
        startedAtUnixMs: now, finishedAtUnixMs: now + 1,
        saveTimeBefore: -1, saveTimeAfter: -1, dsvBytes: -1, serverBytes: -1,
        errorCode: this.failedSaveCode, hmac: '0'.repeat(64)
      }
    }
    return {
      protocol: 'DYSON_CONTROL_RECEIPT_V1', requestId: id, action: 'save', state: 'succeeded',
      startedAtUnixMs: now, finishedAtUnixMs: now + 25,
      saveTimeBefore: 100, saveTimeAfter: 101, dsvBytes: 2048, serverBytes: 512,
      errorCode: 'NONE', hmac: '0'.repeat(64)
    }
  }
}

class FakeLifecycleScriptRunner implements LifecycleScriptRunner {
  readonly calls: Array<{ scriptName: LifecycleScriptName; arguments: string[] }> = []
  malformedProtection = false

  async run(scriptName: LifecycleScriptName, arguments_: string[]): Promise<string> {
    this.calls.push({ scriptName, arguments: arguments_ })
    if (scriptName === 'New-DysonSaveProtectionPoint.ps1') {
      if (this.malformedProtection) return '{"unexpected":true}'
      return JSON.stringify({
        protocol: 'DYSON_CONTROL_PROTECTION_V1', requestId, state: 'succeeded',
        protectionPointId: `save:${requestId}`, dsvBytes: 1024, serverBytes: 256,
        manifestVerified: true, reused: false
      })
    }
    if (scriptName === 'Invoke-DysonScheduledTask.ps1') {
      const operation = argumentValue(arguments_, '-Operation') as 'graceful-stop' | 'start' | 'rollback-start'
      return JSON.stringify({
        protocol: 'DYSON_CONTROL_TASK_RECEIPT_V1', requestId, operation, state: 'succeeded',
        outcome: operation === 'graceful-stop' ? 'stopped' : 'started', processVerified: true,
        writtenAt: new Date().toISOString()
      })
    }
    const expected = argumentValue(arguments_, '-Expected') as 'running' | 'stopped'
    return JSON.stringify({
      protocol: 'DYSON_CONTROL_RUNTIME_V1', expected, state: 'matched', processVerified: true,
      gamePortListening: expected === 'running'
    })
  }
}

function createAdapter(statusProvider: StatusProvider = new DemoProvider()): {
  adapter: WindowsLifecycleAdapter
  bridge: FakeBridgeClient
  runner: FakeLifecycleScriptRunner
} {
  const bridge = new FakeBridgeClient()
  const runner = new FakeLifecycleScriptRunner()
  const adapter = new WindowsLifecycleAdapter({
    projectRoot: 'C:\\Fictional\\Dyson',
    statusProvider,
    scriptRunner: runner,
    bridgeClient: bridge
  })
  return { adapter, bridge, runner }
}

function operationContext(action: LifecycleAction): LifecycleOperationContext {
  return {
    jobId: 'fixture-job', requestId, action, protectionPointId: null,
    signal: new AbortController().signal
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

function argumentValue(arguments_: string[], name: string): string {
  const index = arguments_.indexOf(name)
  if (index < 0 || !arguments_[index + 1]) throw new Error(`Missing fixture argument: ${name}`)
  return arguments_[index + 1]!
}

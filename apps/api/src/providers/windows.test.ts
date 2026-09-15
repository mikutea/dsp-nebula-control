import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { serverStatusSchema } from '../domain.js'
import { DemoProvider } from './demo.js'
import { applyBrokerStatus, WindowsProvider } from './windows.js'
import type { WindowsLifecycleBrokerClient, LifecycleBrokerStatusEvidence } from './windows-lifecycle-broker.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Windows status provider', () => {
  it('uses fresh broker process measurements when the unprivileged collector cannot read the process', async () => {
    const collected = await new DemoProvider().collectStatus()
    collected.runtime.processId = null
    const base = await new FixtureLifecycleBrokerClient().status()
    const now = Date.now()
    const evidence: LifecycleBrokerStatusEvidence = {
      ...base, lifecycleState: 'running_verified',
      runtime: { ...base.runtime, lifecycleState: 'running_verified',
        process: { status: 'verified', pid: 2202, owner: 'FictionalGame', sessionId: 3 } },
      processTelemetry: { processId: 2202, startedAtUnixMs: now - 60_000, sampledAtUnixMs: now,
        processCoresUsed: 1.25, workingSetGiB: 2, privateMemoryGiB: 3, threadCount: 42 }
    }
    expect(applyBrokerStatus(collected, evidence).runtime).toMatchObject({
      processId: 2202, processCoresUsed: 1.25, privateMemoryGiB: 3, threadCount: 42, uptimeSeconds: 60
    })
    for (const patch of [{ processId: 9999 }, { sampledAtUnixMs: now - 31_000 },
      { sampledAtUnixMs: now + 60_000 }, { startedAtUnixMs: now + 1 }]) {
      const bad = { ...evidence, processTelemetry: { ...evidence.processTelemetry!, ...patch } }
      expect(applyBrokerStatus(collected, bad).runtime).toMatchObject({
        processId: 2202, processCoresUsed: null, privateMemoryGiB: null, threadCount: null, uptimeSeconds: null
      })
    }
    expect(applyBrokerStatus(collected, { ...evidence, processTelemetry: null }).runtime.privateMemoryGiB).toBeNull()
  })
  it('rejects non-finite, negative, partial, identifying, and inconsistent host telemetry', async () => {
    const baseline = await new DemoProvider().collectStatus()
    const invalid = [
      mutate(baseline, (status) => { status.host.cpuCores!.samples![0]!.percent = Number.NaN }),
      mutate(baseline, (status) => { status.host.network!.receiveBytesPerSecond = -1 }),
      mutate(baseline, (status) => { status.host.network!.sendBytesPerSecond = null }),
      mutate(baseline, (status) => { status.host.projectVolume!.availableBytes = status.host.projectVolume!.totalBytes! + 1 }),
      mutate(baseline, (status) => { status.host.saveVolume!.usedPercent = 12.34 }),
      mutate(baseline, (status) => { status.host.cpuCores!.samples!.pop() }),
      mutate(baseline, (status) => {
        Object.assign(status.host.cpuCores!, { samples: null, unavailableReason: 'volume-unavailable' })
      }),
      mutate(baseline, (status) => {
        Object.assign(status.host.projectVolume!, {
          totalBytes: null, availableBytes: null, usedPercent: null,
          unavailableReason: 'network-counters-unavailable'
        })
      }),
      mutate(baseline, (status) => {
        Object.assign(status.host.network!, { interfaceName: 'fictional-adapter' })
      })
    ]
    for (const value of invalid) expect(serverStatusSchema.safeParse(value).success).toBe(false)
    expect(serverStatusSchema.parse(baseline).host.network).toMatchObject({
      receiveBytesPerSecond: 1_250_000,
      sampledInterfaceCount: 2,
      unavailableReason: null
    })
  })

  it('does not mix fixed broker task state with legacy collector task telemetry', async () => {
    const collected = await new DemoProvider().collectStatus()
    collected.automation.serverTask = {
      state: 'running', lastResult: 267_009, lastRunAt: '2026-08-31T01:02:03.000Z'
    }
    collected.automation.stopTask = {
      state: 'ready', lastResult: 1, lastRunAt: '2026-08-31T02:03:04.000Z'
    }
    const storageTask = structuredClone(collected.automation.storageTask)
    const evidence = await new FixtureLifecycleBrokerClient().status()

    const status = applyBrokerStatus(collected, evidence)

    expect(status.automation).toEqual({
      ...collected.automation,
      serverTask: { state: 'ready', lastResult: null, lastRunAt: null },
      stopTask: { state: 'disabled', lastResult: null, lastRunAt: null },
      storageTask
    })
    expect(Object.keys(status.automation.serverTask).sort()).toEqual(['lastResult', 'lastRunAt', 'state'])
    expect(Object.keys(status.automation.stopTask).sort()).toEqual(['lastResult', 'lastRunAt', 'state'])
  })

  it('does not spawn the legacy preflight collector for an already-aborted preview', async () => {
    const repositoryRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..')
    const provider = new WindowsProvider({
      projectRoot: path.join(tmpdir(), 'fictional-dyson-preview'),
      scriptRoot: path.join(repositoryRoot, 'scripts', 'windows'),
      runtimeBootstrapRoot: path.join(repositoryRoot, 'scripts', 'windows', 'bootstrap'),
      timeoutMs: 30_000,
      gamePort: 8469
    })
    const controller = new AbortController()
    controller.abort()

    await expect(provider.previewLifecycle('start', controller.signal)).rejects.toThrow('STATUS_COLLECTOR_ABORTED')
  })

  it('parses a fictional read-only installation without returning host paths', async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'dyson-control-fixture-'))
    temporaryRoots.push(fixtureRoot)
    const projectRoot = await realpath(fixtureRoot)

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
    const broker = new FixtureLifecycleBrokerClient()
    const scriptRoot = await createIsolatedStatusScripts(projectRoot, repositoryRoot)
    const provider = new WindowsProvider({
      projectRoot,
      scriptRoot,
      runtimeBootstrapRoot: path.join(repositoryRoot, 'scripts', 'windows', 'bootstrap'),
      timeoutMs: 30_000,
      gamePort: 65432,
      serverTaskName: 'Dyson-Fixture-Missing-Server-Task',
      stopTaskName: 'Dyson-Fixture-Missing-Stop-Task',
      lifecycleBrokerClient: broker
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
    if (status.host.cpuCores?.samples === null) {
      expect(status.host.cpuCores.unavailableReason).toMatch(/^(?:cim-unavailable|inconsistent-sample)$/)
    } else {
      expect(status.host.cpuCores?.unavailableReason).toBeNull()
      expect(status.host.cpuCores?.samples).toHaveLength(status.host.logicalProcessors!)
      expect(status.host.cpuCores?.samples.map((sample) => sample.index)).toEqual(
        Array.from({ length: status.host.logicalProcessors! }, (_, index) => index)
      )
    }
    expect(status.host.projectVolume).toMatchObject({ unavailableReason: null })
    expect(status.host.projectVolume?.totalBytes).toBeGreaterThan(0)
    expect(status.host.projectVolume?.availableBytes).toBeGreaterThanOrEqual(0)
    expect(status.host.saveVolume).toMatchObject({
      unavailableReason: null,
      totalBytes: status.host.projectVolume?.totalBytes
    })
    expect(status.host.saveVolume?.availableBytes).toBeGreaterThanOrEqual(0)
    // Both roots are on the fixture volume, but PowerShell samples them at
    // different instants and the filesystem can allocate blocks in between.
    // Equality of the stable total proves the shared capacity boundary without
    // asserting a volatile free-space counter.
    if (status.host.network?.unavailableReason === null) {
      expect(status.host.network.sampledInterfaceCount).toBeGreaterThan(0)
      expect(status.host.network.receiveBytesPerSecond).toBeGreaterThanOrEqual(0)
      expect(status.host.network.sendBytesPerSecond).toBeGreaterThanOrEqual(0)
    } else {
      expect(status.host.network?.unavailableReason).toMatch(
        /^(?:network-counters-unavailable|no-eligible-network-interface|inconsistent-sample)$/
      )
      expect(status.host.network?.sampledInterfaceCount).toBeNull()
    }
    expect(status.capabilities).toEqual({ refresh: true, start: false, save: false, gracefulStop: false, restart: false })
    expect(status.connections.find((connection) => connection.id === 'game-port')).toMatchObject({
      label: 'Game port 65432',
      status: 'warning',
      detail: '固定 SYSTEM 生命周期代理确认游戏服务已停止'
    })
    expect(status.automation).toMatchObject({
      serverTask: { state: 'ready', lastResult: null, lastRunAt: null },
      stopTask: { state: 'disabled', lastResult: null, lastRunAt: null }
    })
    const serializedStatus = JSON.stringify(status)
    expect(serializedStatus).not.toContain(projectRoot)
    expect(serializedStatus).not.toMatch(/(?:interfaceName|interfaceId|macAddress|ipAddress|volumeId|driveLetter)/i)

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

    await writeFile(path.join(projectRoot, 'server', 'DSPGAME.exe'), 'fictional-executable', 'utf8')
    const startPreview = await provider.previewLifecycle('start')
    expect(startPreview).toMatchObject({
      action: 'start', allowed: false, executionEnabled: false,
      rollback: { strategy: 'no-op', ready: true }
    })
    expect(startPreview.blockers).toContain('server-task-missing')
    expect(startPreview.blockers).not.toContain('managed-process-unverified')
    expect(startPreview.blockers).not.toContain('game-port-listening')
    expect(startPreview.checks.find((check) => check.id === 'managed-process')).toMatchObject({ status: 'pass' })
    expect(startPreview.checks.find((check) => check.id === 'game-port')).toMatchObject({ status: 'pass' })

    await writeFile(path.join(backupRoot, 'Fictional_Save.dsv'), 'tampered-backup', 'utf8')
    const tamperedPreview = await provider.previewLifecycle('restart')
    expect(tamperedPreview.checks.find((check) => check.id === 'backup-pair')?.status).toBe('block')
    expect(tamperedPreview.blockers).toContain('backup-pair-unverified')

    broker.unavailable = true
    const failClosedStatus = await provider.collectStatus()
    expect(failClosedStatus).toMatchObject({
      state: 'unknown',
      runtime: { processId: null },
      automation: {
        serverTask: { state: 'unknown', lastResult: null, lastRunAt: null },
        stopTask: { state: 'unknown', lastResult: null, lastRunAt: null }
      }
    })
    expect(failClosedStatus.connections.find((connection) => connection.id === 'game-port'))
      .toMatchObject({ status: 'unknown' })
  }, 45_000)
})

async function createIsolatedStatusScripts(projectRoot: string, repositoryRoot: string): Promise<string> {
  const root = path.join(projectRoot, 'fixture-scripts')
  await mkdir(root)
  const productionRoot = path.join(repositoryRoot, 'scripts', 'windows')
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
  for (const name of ['Get-DysonStatus.ps1', 'Get-DysonLifecyclePreflight.ps1']) {
    // Retain the real collectors, file parsing, and native host metrics. Only
    // the fictional game's process/port/task inventory belongs to the fixture.
    await writeFile(path.join(root, name), `
param([string]$ProjectRoot, [int]$GamePort, [string]$ServerTaskName, [string]$StopTaskName,
  [string]$AllowedScriptRoot, [string]$AllowedTaskScriptRoot, [string]$Action)
$ErrorActionPreference = 'Stop'
function Get-Process { [CmdletBinding()] param([string]$Name)
  if ($Name -cne 'DSPGAME') { throw 'Unexpected fixture process query' }
}
function Get-NetTCPConnection { [CmdletBinding()] param([string]$State, [int]$LocalPort) }
function Get-ScheduledTask { [CmdletBinding()] param([string]$TaskName, [string]$TaskPath)
  throw 'The fictional host has no scheduled tasks'
}
function Get-ScheduledTaskInfo { [CmdletBinding()] param([string]$TaskName, [string]$TaskPath)
  throw 'The fictional host has no scheduled tasks'
}
if ($PSBoundParameters.ContainsKey('AllowedScriptRoot')) {
  $PSBoundParameters['AllowedScriptRoot'] = ${literal(productionRoot)}
}
& ${literal(path.join(productionRoot, name))} @PSBoundParameters
`, 'utf8')
  }
  return root
}

class FixtureLifecycleBrokerClient implements WindowsLifecycleBrokerClient {
  unavailable = false

  preflight(): ReturnType<WindowsLifecycleBrokerClient['preflight']> {
    return Promise.reject(new Error('not used by status fixture'))
  }

  dispatch(): ReturnType<WindowsLifecycleBrokerClient['dispatch']> {
    return Promise.reject(new Error('not used by status fixture'))
  }

  verify(): ReturnType<WindowsLifecycleBrokerClient['verify']> {
    return Promise.reject(new Error('not used by status fixture'))
  }

  async status() {
    if (this.unavailable) throw new Error('fixture lifecycle broker unavailable')
    return {
      lifecycleState: 'stopped_verified' as const,
      task: {
        valid: true,
        server: { name: 'Dyson-Nebula-Server' as const, path: '\\' as const, state: 'Ready' },
        stop: { name: 'Dyson-Nebula-Stop' as const, path: '\\' as const, state: 'Disabled' }
      },
      runtime: {
        lifecycleState: 'stopped_verified' as const,
        session: { status: 'verified' as const, id: 3, count: 1 },
        steam: { status: 'verified' as const, pid: 300, sessionId: 3 },
        process: { status: 'absent' as const, pid: null, owner: null, sessionId: null },
        port: { port: 65432, listenerCount: 0 },
        pidFile: { present: false, valid: false }
      }
    }
  }
}

function mutate<T>(input: T, change: (value: T) => void): T {
  const value = structuredClone(input)
  change(value)
  return value
}

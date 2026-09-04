import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  lifecyclePreviewSchema, serverStatusSchema,
  type LifecycleAction, type LifecyclePreview, type ServerStatus, type StatusProvider
} from '../domain.js'
import type {
  LifecycleBrokerStatusEvidence,
  WindowsLifecycleBrokerClient
} from './windows-lifecycle-broker.js'

export interface WindowsProviderOptions {
  projectRoot: string
  scriptRoot: string
  runtimeBootstrapRoot?: string | null
  timeoutMs: number
  gamePort?: number
  serverTaskName?: string
  stopTaskName?: string
  lifecycleBrokerClient?: WindowsLifecycleBrokerClient | null
}

export class WindowsProvider implements StatusProvider {
  readonly name = 'windows' as const
  readonly #options: WindowsProviderOptions

  constructor(options: WindowsProviderOptions) {
    this.#options = options
  }

  async collectStatus(): Promise<ServerStatus> {
    const scriptPath = await this.#resolveScript('Get-DysonStatus.ps1')
    const output = await this.#runPowerShell(scriptPath, [
      '-ProjectRoot', this.#options.projectRoot,
      '-GamePort', String(this.#options.gamePort ?? 8469),
      '-ServerTaskName', this.#options.serverTaskName ?? 'Dyson-Nebula-Server',
      '-StopTaskName', this.#options.stopTaskName ?? 'Dyson-Nebula-Stop'
    ])
    const parsed = serverStatusSchema.parse(JSON.parse(output) as unknown)
    const status: ServerStatus = {
      ...parsed,
      capabilities: { refresh: true, start: false, save: false, gracefulStop: false, restart: false }
    }
    if (!this.#options.lifecycleBrokerClient) return status
    try {
      const evidence = await this.#options.lifecycleBrokerClient.status({
        signal: AbortSignal.timeout(this.#options.timeoutMs)
      })
      return applyBrokerStatus(status, evidence)
    } catch {
      return applyUnavailableBrokerStatus(status)
    }
  }

  async previewLifecycle(action: LifecycleAction, signal?: AbortSignal): Promise<LifecyclePreview> {
    const scriptPath = await this.#resolveScript('Get-DysonLifecyclePreflight.ps1')
    const arguments_ = [
      '-ProjectRoot', this.#options.projectRoot,
      '-AllowedScriptRoot', this.#options.scriptRoot,
      '-Action', action,
      '-GamePort', String(this.#options.gamePort ?? 8469),
      '-ServerTaskName', this.#options.serverTaskName ?? 'Dyson-Nebula-Server',
      '-StopTaskName', this.#options.stopTaskName ?? 'Dyson-Nebula-Stop'
    ]
    if (this.#options.runtimeBootstrapRoot) {
      arguments_.push('-AllowedTaskScriptRoot', this.#options.runtimeBootstrapRoot)
    }
    const output = await this.#runPowerShell(scriptPath, arguments_, signal)
    const parsed = lifecyclePreviewSchema.parse(JSON.parse(output) as unknown)
    const blockers = parsed.blockers.includes('execution-disabled')
      ? parsed.blockers
      : [...parsed.blockers, 'execution-disabled' as const]
    return {
      ...parsed,
      allowed: false,
      executionEnabled: false,
      blockers
    }
  }

  async #resolveScript(fileName: 'Get-DysonStatus.ps1' | 'Get-DysonLifecyclePreflight.ps1'): Promise<string> {
    const scriptPath = path.resolve(this.#options.scriptRoot, fileName)
    this.#assertInsideScriptRoot(scriptPath)
    await fs.access(scriptPath)
    return scriptPath
  }

  #assertInsideScriptRoot(scriptPath: string): void {
    const relative = path.relative(path.resolve(this.#options.scriptRoot), scriptPath)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Status script resolved outside the allowlisted script root')
    }
  }

  #runPowerShell(scriptPath: string, scriptArguments: string[], signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return Promise.reject(new Error('STATUS_COLLECTOR_ABORTED'))
    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath, ...scriptArguments
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        callback()
      }
      const abort = () => {
        child.kill()
        finish(() => reject(new Error('STATUS_COLLECTOR_ABORTED')))
      }
      const timer = setTimeout(() => {
        child.kill()
        finish(() => reject(new Error('STATUS_COLLECTOR_TIMEOUT')))
      }, this.#options.timeoutMs)
      timer.unref()
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
      child.once('error', (error) => finish(() => reject(error)))
      child.once('exit', (code) => {
        finish(() => {
          if (code === 0) resolve(stdout.trim())
          else reject(new Error(`Status collector failed with exit code ${code}: ${stderr.trim()}`))
        })
      })
    })
  }
}

export function applyBrokerStatus(
  status: ServerStatus,
  evidence: LifecycleBrokerStatusEvidence
): ServerStatus {
  const state = !evidence.task.valid
    ? 'unknown' as const
    : evidence.lifecycleState === 'running_verified'
    ? 'running' as const
    : evidence.lifecycleState === 'stopped_verified'
      ? 'stopped' as const
      : 'unknown' as const
  const processId = state === 'running' && evidence.runtime.process.status === 'verified'
    ? evidence.runtime.process.pid
    : null
  const preserveProcessTelemetry = state === 'running' && processId !== null &&
    status.runtime.processId === processId
  const taskEvidenceTrusted = evidence.task.valid
  return {
    ...status,
    state,
    runtime: {
      ...status.runtime,
      processId,
      processCoresUsed: preserveProcessTelemetry ? status.runtime.processCoresUsed : null,
      workingSetGiB: preserveProcessTelemetry ? status.runtime.workingSetGiB : null,
      privateMemoryGiB: preserveProcessTelemetry ? status.runtime.privateMemoryGiB : null,
      threadCount: preserveProcessTelemetry ? status.runtime.threadCount : null,
      priority: preserveProcessTelemetry ? status.runtime.priority : null,
      startedAt: preserveProcessTelemetry ? status.runtime.startedAt : null,
      uptimeSeconds: preserveProcessTelemetry ? status.runtime.uptimeSeconds : null
    },
    automation: {
      ...status.automation,
      serverTask: {
        state: taskEvidenceTrusted ? normalizeTaskState(evidence.task.server.state) : 'unknown',
        lastResult: null,
        lastRunAt: null
      },
      stopTask: {
        state: taskEvidenceTrusted ? normalizeTaskState(evidence.task.stop.state) : 'unknown',
        lastResult: null,
        lastRunAt: null
      }
    },
    connections: status.connections.map((connection) => connection.id !== 'game-port'
      ? connection
      : brokerGamePortConnection(connection, evidence))
  }
}

function applyUnavailableBrokerStatus(status: ServerStatus): ServerStatus {
  return {
    ...status,
    state: 'unknown',
    runtime: {
      ...status.runtime,
      processId: null,
      processCoresUsed: null,
      workingSetGiB: null,
      privateMemoryGiB: null,
      threadCount: null,
      priority: null,
      startedAt: null,
      uptimeSeconds: null
    },
    automation: {
      ...status.automation,
      serverTask: { state: 'unknown', lastResult: null, lastRunAt: null },
      stopTask: { state: 'unknown', lastResult: null, lastRunAt: null }
    },
    connections: status.connections.map((connection) => connection.id !== 'game-port'
      ? connection
      : {
          ...connection,
          status: 'unknown',
          detail: '固定 SYSTEM 生命周期代理不可用，运行状态不作推断'
        })
  }
}

function brokerGamePortConnection(
  connection: ServerStatus['connections'][number],
  evidence: LifecycleBrokerStatusEvidence
): ServerStatus['connections'][number] {
  if (evidence.lifecycleState === 'running_verified' && evidence.runtime.port.listenerCount === 1) {
    return {
      ...connection,
      status: 'healthy',
      detail: '固定 SYSTEM 生命周期代理确认游戏进程与监听端口一致'
    }
  }
  if (evidence.lifecycleState === 'stopped_verified' && evidence.runtime.port.listenerCount === 0) {
    return {
      ...connection,
      status: 'warning',
      detail: '固定 SYSTEM 生命周期代理确认游戏服务已停止'
    }
  }
  return {
    ...connection,
    status: 'unknown',
    detail: '游戏进程与监听端口未形成可验证的一致结论'
  }
}

function normalizeTaskState(value: string): ServerStatus['automation']['serverTask']['state'] {
  switch (value.trim().toLowerCase()) {
    case 'running': return 'running'
    case 'ready': return 'ready'
    case 'disabled': return 'disabled'
    case 'queued': return 'queued'
    default: return 'unknown'
  }
}

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  lifecyclePreviewSchema, serverStatusSchema,
  type LifecycleAction, type LifecyclePreview, type ServerStatus, type StatusProvider
} from '../domain.js'

export interface WindowsProviderOptions {
  projectRoot: string
  scriptRoot: string
  timeoutMs: number
  gamePort?: number
  serverTaskName?: string
  stopTaskName?: string
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
    return {
      ...parsed,
      capabilities: { refresh: true, start: false, save: false, gracefulStop: false, restart: false }
    }
  }

  async previewLifecycle(action: LifecycleAction): Promise<LifecyclePreview> {
    const scriptPath = await this.#resolveScript('Get-DysonLifecyclePreflight.ps1')
    const output = await this.#runPowerShell(scriptPath, [
      '-ProjectRoot', this.#options.projectRoot,
      '-AllowedScriptRoot', this.#options.scriptRoot,
      '-Action', action,
      '-GamePort', String(this.#options.gamePort ?? 8469)
    ])
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

  #runPowerShell(scriptPath: string, scriptArguments: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath, ...scriptArguments
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => child.kill(), this.#options.timeoutMs)
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('exit', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve(stdout.trim())
        else reject(new Error(`Status collector failed with exit code ${code}: ${stderr.trim()}`))
      })
    })
  }
}

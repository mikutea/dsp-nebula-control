import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ServerStatus, StatusProvider } from '../domain.js'

export interface WindowsProviderOptions {
  projectRoot: string
  scriptRoot: string
  timeoutMs: number
}

export class WindowsProvider implements StatusProvider {
  readonly name = 'windows' as const
  readonly #options: WindowsProviderOptions

  constructor(options: WindowsProviderOptions) {
    this.#options = options
  }

  async collectStatus(): Promise<ServerStatus> {
    const scriptPath = path.resolve(this.#options.scriptRoot, 'Get-DysonStatus.ps1')
    this.#assertInsideScriptRoot(scriptPath)
    await fs.access(scriptPath)
    const output = await this.#runPowerShell(scriptPath)
    const parsed = JSON.parse(output) as ServerStatus
    return {
      ...parsed,
      capabilities: { refresh: true, save: false, gracefulStop: false, restart: false }
    }
  }

  #assertInsideScriptRoot(scriptPath: string): void {
    const relative = path.relative(path.resolve(this.#options.scriptRoot), scriptPath)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Status script resolved outside the allowlisted script root')
    }
  }

  #runPowerShell(scriptPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath, '-ProjectRoot', this.#options.projectRoot
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

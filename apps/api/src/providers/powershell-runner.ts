import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

const lifecycleScriptNames = [
  'New-DysonSaveProtectionPoint.ps1',
  'Invoke-DysonScheduledTask.ps1',
  'Test-DysonRuntimeState.ps1',
  'Get-DysonManagedPluginVersion.ps1'
] as const
const lifecycleScriptNameAllowlist = new Set<string>(lifecycleScriptNames)

export type LifecycleScriptName = (typeof lifecycleScriptNames)[number]

export interface LifecycleScriptRunner {
  run(scriptName: LifecycleScriptName, scriptArguments: string[], signal: AbortSignal): Promise<string>
}

export class PowerShellRunnerError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'PowerShellRunnerError'
    this.code = code
  }
}

export class PowerShellLifecycleRunner implements LifecycleScriptRunner {
  readonly #scriptRoot: string
  readonly #timeoutMs: number
  readonly #maximumOutputBytes: number

  constructor(scriptRoot: string, timeoutMs: number, maximumOutputBytes = 64 * 1024) {
    this.#scriptRoot = path.resolve(scriptRoot)
    this.#timeoutMs = timeoutMs
    this.#maximumOutputBytes = maximumOutputBytes
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
      throw new PowerShellRunnerError('HOST_TIMEOUT_INVALID')
    }
    if (!Number.isInteger(maximumOutputBytes) || maximumOutputBytes < 1_024 || maximumOutputBytes > 1024 * 1024) {
      throw new PowerShellRunnerError('HOST_OUTPUT_LIMIT_INVALID')
    }
  }

  async run(scriptName: LifecycleScriptName, scriptArguments: string[], signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    if (!lifecycleScriptNameAllowlist.has(scriptName)) {
      throw new PowerShellRunnerError('HOST_SCRIPT_INVALID')
    }
    const scriptPath = path.resolve(this.#scriptRoot, scriptName)
    const relative = path.relative(this.#scriptRoot, scriptPath)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new PowerShellRunnerError('HOST_SCRIPT_INVALID')
    }
    await fs.access(scriptPath).catch(() => {
      throw new PowerShellRunnerError('HOST_SCRIPT_UNAVAILABLE')
    })
    for (const argument of scriptArguments) {
      if (typeof argument !== 'string' || argument.length > 1_024 || /[\r\n\0]/.test(argument)) {
        throw new PowerShellRunnerError('HOST_ARGUMENT_INVALID')
      }
    }

    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath, ...scriptArguments
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let outputBytes = 0
      let terminalCode: string | null = null
      let settled = false

      const failAndStop = (code: string) => {
        if (!terminalCode) terminalCode = code
        child.kill()
      }
      const onAbort = () => failAndStop('HOST_SCRIPT_ABORTED')
      signal.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => failAndStop('HOST_SCRIPT_TIMEOUT'), this.#timeoutMs)

      const collect = (chunk: Buffer | string, keep: boolean) => {
        const text = String(chunk)
        outputBytes += Buffer.byteLength(text, 'utf8')
        if (outputBytes > this.#maximumOutputBytes) {
          failAndStop('HOST_OUTPUT_LIMIT_EXCEEDED')
          return
        }
        if (keep) stdout += text
      }
      child.stdout.on('data', (chunk: Buffer | string) => collect(chunk, true))
      child.stderr.on('data', (chunk: Buffer | string) => collect(chunk, false))
      child.once('error', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        reject(new PowerShellRunnerError(terminalCode ?? 'HOST_SCRIPT_START_FAILED'))
      })
      child.once('exit', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        if (terminalCode) reject(new PowerShellRunnerError(terminalCode))
        else if (code !== 0) reject(new PowerShellRunnerError('HOST_SCRIPT_FAILED'))
        else resolve(stdout.trim())
      })
    })
  }
}

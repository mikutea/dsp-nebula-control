import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  WindowsCutoverHostScriptName,
  WindowsCutoverPowerShellRunner
} from './windows-cutover-host.js'
import type {
  WindowsNebulaPluginTransactionPowerShellRunner,
  WindowsNebulaPluginTransactionScriptName
} from './windows-nebula-plugin-transaction.js'
import type {
  HostnameWssQualificationScriptName,
  WindowsHostnameWssQualificationPowerShellRunner
} from './windows-hostname-wss-qualification.js'

const lifecycleScriptNames = [
  'New-DysonSaveProtectionPoint.ps1',
  'Get-DysonManagedPluginVersion.ps1',
  'Submit-DysonLifecycleBrokerRequest.ps1'
] as const

export type LifecycleScriptName = (typeof lifecycleScriptNames)[number]
type AllowedPowerShellScriptName =
  | LifecycleScriptName
  | WindowsCutoverHostScriptName
  | WindowsNebulaPluginTransactionScriptName
  | HostnameWssQualificationScriptName

const allowedScriptPaths = {
  'New-DysonSaveProtectionPoint.ps1': ['New-DysonSaveProtectionPoint.ps1'],
  'Get-DysonManagedPluginVersion.ps1': ['Get-DysonManagedPluginVersion.ps1'],
  'Submit-DysonLifecycleBrokerRequest.ps1': [
    'lifecycle-broker', 'Submit-DysonLifecycleBrokerRequest.ps1'
  ],
  'Get-DysonCutoverEvidence.ps1': ['cutover', 'Get-DysonCutoverEvidence.ps1'],
  'Submit-DysonCutoverBrokerRequest.ps1': [
    'cutover-broker', 'Submit-DysonCutoverBrokerRequest.ps1'
  ],
  'New-NebulaPluginCutoverPlan.ps1': [
    'nebula-private-build', 'New-NebulaPluginCutoverPlan.ps1'
  ],
  'Invoke-NebulaPluginCutover.ps1': [
    'nebula-private-build', 'Invoke-NebulaPluginCutover.ps1'
  ],
  'Restore-NebulaPluginCutover.ps1': [
    'nebula-private-build', 'Restore-NebulaPluginCutover.ps1'
  ],
  'Test-NebulaPluginCutover.ps1': [
    'nebula-private-build', 'Test-NebulaPluginCutover.ps1'
  ],
  'Test-NebulaPluginRollback.ps1': [
    'nebula-private-build', 'Test-NebulaPluginRollback.ps1'
  ],
  'Test-DysonHostnameWssQualification.ps1': [
    'network', 'Test-DysonHostnameWssQualification.ps1'
  ]
} as const satisfies Readonly<Record<AllowedPowerShellScriptName, readonly string[]>>

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

export function resolvePowerShellScriptPath(scriptRoot: string, scriptName: string): string {
  const resolvedRoot = path.resolve(scriptRoot)
  if (!Object.hasOwn(allowedScriptPaths, scriptName)) {
    throw new PowerShellRunnerError('HOST_SCRIPT_INVALID')
  }
  const scriptSegments = allowedScriptPaths[scriptName as AllowedPowerShellScriptName]

  const scriptPath = path.resolve(resolvedRoot, ...scriptSegments)
  const relative = path.relative(resolvedRoot, scriptPath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new PowerShellRunnerError('HOST_SCRIPT_INVALID')
  }
  return scriptPath
}

export class PowerShellLifecycleRunner implements
  LifecycleScriptRunner,
  WindowsCutoverPowerShellRunner,
  WindowsNebulaPluginTransactionPowerShellRunner,
  WindowsHostnameWssQualificationPowerShellRunner {
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

  run(scriptName: LifecycleScriptName, scriptArguments: string[], signal: AbortSignal): Promise<string>
  run(scriptName: WindowsCutoverHostScriptName, scriptArguments: string[], signal: AbortSignal): Promise<string>
  run(
    scriptName: WindowsNebulaPluginTransactionScriptName,
    scriptArguments: string[],
    signal: AbortSignal
  ): Promise<string>
  run(
    scriptName: HostnameWssQualificationScriptName,
    scriptArguments: string[],
    signal: AbortSignal
  ): Promise<string>
  async run(
    scriptName: AllowedPowerShellScriptName,
    scriptArguments: string[],
    signal: AbortSignal
  ): Promise<string> {
    if (signal.aborted) {
      throw new PowerShellRunnerError('HOST_SCRIPT_ABORTED')
    }
    const scriptPath = resolvePowerShellScriptPath(this.#scriptRoot, scriptName)
    await fs.access(scriptPath).catch(() => {
      throw new PowerShellRunnerError('HOST_SCRIPT_UNAVAILABLE')
    })
    if (signal.aborted) {
      throw new PowerShellRunnerError('HOST_SCRIPT_ABORTED')
    }
    if (!Array.isArray(scriptArguments) || scriptArguments.some((argument) =>
      typeof argument !== 'string' || argument.length > 1_024 || /[\r\n\0]/.test(argument))) {
      throw new PowerShellRunnerError('HOST_ARGUMENT_INVALID')
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
      if (signal.aborted) failAndStop('HOST_SCRIPT_ABORTED')

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

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WindowsCutoverPowerShellRunner } from './windows-cutover-host.js'
import type { WindowsHostnameWssQualificationPowerShellRunner } from './windows-hostname-wss-qualification.js'
import type { WindowsNebulaPluginTransactionPowerShellRunner } from './windows-nebula-plugin-transaction.js'
import {
  PowerShellLifecycleRunner,
  PowerShellRunnerError,
  resolvePowerShellScriptPath,
  type LifecycleScriptRunner
} from './powershell-runner.js'

const scriptRoot = path.resolve('fictional', 'windows-scripts')

describe('PowerShellLifecycleRunner script allowlist', () => {
  it('maps only the read-only evidence and fixed broker submission entrypoints', () => {
    expect(resolvePowerShellScriptPath(scriptRoot, 'Get-DysonCutoverEvidence.ps1')).toBe(
      path.resolve(scriptRoot, 'cutover', 'Get-DysonCutoverEvidence.ps1')
    )
    expect(resolvePowerShellScriptPath(scriptRoot, 'Submit-DysonCutoverBrokerRequest.ps1')).toBe(
      path.resolve(scriptRoot, 'cutover-broker', 'Submit-DysonCutoverBrokerRequest.ps1')
    )
  })

  it.each([
    'Invoke-DysonCutoverAction.ps1',
    'Install-DysonRuntimeTasks.ps1',
    'Invoke-DysonScheduledTask.ps1',
    'Test-DysonRuntimeState.ps1'
  ])('does not expose the privileged mutation script directly: %s', (scriptName) => {
    expect(() => resolvePowerShellScriptPath(scriptRoot, scriptName)).toThrowError(
      new PowerShellRunnerError('HOST_SCRIPT_INVALID')
    )
  })

  it.each([
    'Unknown-DysonScript.ps1',
    '../Get-DysonCutoverEvidence.ps1',
    'cutover/Get-DysonCutoverEvidence.ps1',
    'cutover-broker\\Submit-DysonCutoverBrokerRequest.ps1',
    'nebula-private-build/Invoke-NebulaPluginCutover.ps1',
    '..\\nebula-private-build\\Invoke-NebulaPluginCutover.ps1',
    'New-NebulaPrivateBuild.ps1',
    'C:\\fictional\\Get-DysonCutoverEvidence.ps1'
  ])('rejects an unenumerated or path-bearing script name: %s', (scriptName) => {
    expect(() => resolvePowerShellScriptPath(scriptRoot, scriptName)).toThrowError(
      new PowerShellRunnerError('HOST_SCRIPT_INVALID')
    )
  })

  it.each([
    'New-DysonSaveProtectionPoint.ps1',
    'Get-DysonManagedPluginVersion.ps1',
    'Submit-DysonLifecycleBrokerRequest.ps1'
  ])('preserves the existing lifecycle mapping for %s', (scriptName) => {
    const expected = scriptName === 'Submit-DysonLifecycleBrokerRequest.ps1'
      ? path.resolve(scriptRoot, 'lifecycle-broker', scriptName)
      : path.resolve(scriptRoot, scriptName)
    expect(resolvePowerShellScriptPath(scriptRoot, scriptName)).toBe(expected)
  })

  it.each([
    'New-NebulaPluginCutoverPlan.ps1',
    'Invoke-NebulaPluginCutover.ps1',
    'Restore-NebulaPluginCutover.ps1',
    'Test-NebulaPluginCutover.ps1',
    'Test-NebulaPluginRollback.ps1'
  ])('maps the fixed Nebula transaction entrypoint below nebula-private-build: %s', (scriptName) => {
    expect(resolvePowerShellScriptPath(scriptRoot, scriptName)).toBe(
      path.resolve(scriptRoot, 'nebula-private-build', scriptName)
    )
  })

  it('maps only the fixed hostname WSS qualification wrapper below network', () => {
    expect(resolvePowerShellScriptPath(scriptRoot, 'Test-DysonHostnameWssQualification.ps1')).toBe(
      path.resolve(scriptRoot, 'network', 'Test-DysonHostnameWssQualification.ps1')
    )
  })

  it('is structurally usable by both lifecycle and cutover providers', () => {
    const runner = new PowerShellLifecycleRunner(scriptRoot, 5_000)
    const lifecycleRunner: LifecycleScriptRunner = runner
    const cutoverRunner: WindowsCutoverPowerShellRunner = runner
    const nebulaTransactionRunner: WindowsNebulaPluginTransactionPowerShellRunner = runner
    const hostnameQualificationRunner: WindowsHostnameWssQualificationPowerShellRunner = runner

    expect(lifecycleRunner).toBe(runner)
    expect(cutoverRunner).toBe(runner)
    expect(nebulaTransactionRunner).toBe(runner)
    expect(hostnameQualificationRunner).toBe(runner)
  })

  it('normalizes a pre-aborted request to a code-only runner error', async () => {
    const runner = new PowerShellLifecycleRunner(scriptRoot, 5_000)
    const controller = new AbortController()
    controller.abort(new Error('untrusted-abort-reason'))

    await expect(runner.run(
      'Get-DysonCutoverEvidence.ps1',
      [],
      controller.signal
    )).rejects.toMatchObject({
      name: 'PowerShellRunnerError',
      code: 'HOST_SCRIPT_ABORTED',
      message: 'HOST_SCRIPT_ABORTED'
    })
  })

  it('normalizes an invalid argument to a code-only runner error before spawning', async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dyson-powershell-runner-'))
    try {
      const brokerDirectory = path.join(fixtureRoot, 'cutover-broker')
      await fs.mkdir(brokerDirectory)
      await fs.writeFile(path.join(brokerDirectory, 'Submit-DysonCutoverBrokerRequest.ps1'), '')
      const runner = new PowerShellLifecycleRunner(fixtureRoot, 5_000)

      await expect(runner.run(
        'Submit-DysonCutoverBrokerRequest.ps1',
        ['line-one\nline-two'],
        new AbortController().signal
      )).rejects.toMatchObject({
        name: 'PowerShellRunnerError',
        code: 'HOST_ARGUMENT_INVALID',
        message: 'HOST_ARGUMENT_INVALID'
      })
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true })
    }
  })
})

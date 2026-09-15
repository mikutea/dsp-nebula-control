import { describe, expect, it } from 'vitest'
import type { LifecycleScriptName, LifecycleScriptRunner } from './powershell-runner.js'
import {
  createWindowsManagedPluginVersionProbe,
  fixedWindowsManagedPluginFileNames,
  fixedWindowsManagedPluginIdentities,
  WindowsManagedPluginVersionProbe,
  WindowsManagedPluginVersionProbeError
} from './windows-managed-plugin-version.js'

describe('Windows managed plugin version probe', () => {
  it.each([
    ['bridge', 'DysonControlBridge.dll', 'plugins/dyson-control-bridge/DysonControlBridge.dll'],
    ['control', 'DysonControl.dll', 'plugins/dyson-control/DysonControl.dll']
  ] as const)('invokes one fixed script for %s and normalizes its version', async (component, fileName, relativePath) => {
    const runner = new FakeScriptRunner()
    runner.output = response({ component, fileName, relativePath, version: 'v01.002.0003.0' })
    const probe = createWindowsManagedPluginVersionProbe({
      projectRoot: fixtureProjectRoot(),
      scriptRunner: runner
    })
    const signal = new AbortController().signal

    await expect(probe({ component, signal })).resolves.toBe('1.2.3.0')
    expect(runner.calls).toEqual([{
      scriptName: 'Get-DysonManagedPluginVersion.ps1',
      arguments: ['-ProjectRoot', fixtureProjectRoot(), '-Component', component],
      signal
    }])
    expect(fixedWindowsManagedPluginFileNames[component]).toBe(fileName)
    expect(fixedWindowsManagedPluginIdentities[component]).toEqual(expect.objectContaining({ fileName, relativePath }))
  })

  it('forwards the exact abort signal without creating a caller-controlled host surface', async () => {
    const runner = new FakeScriptRunner()
    const instance = new WindowsManagedPluginVersionProbe({
      projectRoot: fixtureProjectRoot(),
      scriptRunner: runner
    })
    const signal = new AbortController().signal

    await instance.probe({ component: 'bridge', signal })

    expect(runner.calls[0]?.signal).toBe(signal)
    expect(runner.calls[0]?.scriptName).toBe('Get-DysonManagedPluginVersion.ps1')
  })

  it('returns null only for the fixed script\'s explicit absent state', async () => {
    const runner = new FakeScriptRunner()
    runner.output = response({ state: 'absent', version: null })
    const probe = createWindowsManagedPluginVersionProbe({
      projectRoot: fixtureProjectRoot(), scriptRunner: runner
    })
    await expect(probe({ component: 'bridge', signal: new AbortController().signal })).resolves.toBeNull()
  })

  it.each([
    { component: 'bridge', signal: new AbortController().signal, path: 'C:\\Outside.dll' },
    { component: 'bridge', signal: new AbortController().signal, fileName: 'Other.dll' },
    { component: 'bridge', signal: new AbortController().signal, command: 'whoami' },
    { component: 'nebula', signal: new AbortController().signal },
    { component: 'control' }
  ])('rejects malformed or expanded invocation input before the host runner', async (input) => {
    const runner = new FakeScriptRunner()
    const probe = createWindowsManagedPluginVersionProbe({
      projectRoot: fixtureProjectRoot(),
      scriptRunner: runner
    })

    await expect(probe(input as never)).rejects.toEqual(expect.objectContaining<Partial<WindowsManagedPluginVersionProbeError>>({
      code: 'WINDOWS_PLUGIN_VERSION_PROBE_REQUEST_INVALID',
      message: 'WINDOWS_PLUGIN_VERSION_PROBE_REQUEST_INVALID'
    }))
    expect(runner.calls).toEqual([])
  })

  it.each([
    ['extra field', response({ extra: true })],
    ['wrong protocol', response({ protocol: 'OTHER' })],
    ['wrong component', response({
      component: 'control',
      fileName: 'DysonControl.dll',
      relativePath: 'plugins/dyson-control/DysonControl.dll'
    })],
    ['wrong fixed file', response({ fileName: 'DysonControl.dll' })],
    ['wrong fixed relative path', response({ relativePath: 'plugins/dyson-control/DysonControl.dll' })],
    ['missing version', JSON.stringify({
      protocol: 'DYSON_CONTROL_MANAGED_PLUGIN_VERSION_V1', component: 'bridge',
      fileName: 'DysonControlBridge.dll',
      relativePath: 'plugins/dyson-control-bridge/DysonControlBridge.dll',
      state: 'available'
    })],
    ['invalid version', response({ version: 'not-a-version' })],
    ['non-JSON output', 'host diagnostic text']
  ])('fails closed for a %s response without reflecting its content', async (_case, output) => {
    const runner = new FakeScriptRunner()
    runner.output = output
    const probe = createWindowsManagedPluginVersionProbe({
      projectRoot: fixtureProjectRoot(),
      scriptRunner: runner
    })

    await expect(probe({
      component: 'bridge', signal: new AbortController().signal
    })).rejects.toEqual(expect.objectContaining<Partial<WindowsManagedPluginVersionProbeError>>({
      code: 'WINDOWS_PLUGIN_VERSION_PROBE_FAILED',
      message: 'WINDOWS_PLUGIN_VERSION_PROBE_FAILED'
    }))
  })

  it('maps host failures to one code-only probe error', async () => {
    const runner = new FakeScriptRunner()
    runner.failure = new Error('fixture absolute path and host details')
    const probe = createWindowsManagedPluginVersionProbe({
      projectRoot: fixtureProjectRoot(),
      scriptRunner: runner
    })

    await expect(probe({
      component: 'control', signal: new AbortController().signal
    })).rejects.toEqual(expect.objectContaining<Partial<WindowsManagedPluginVersionProbeError>>({
      code: 'WINDOWS_PLUGIN_VERSION_PROBE_FAILED',
      message: 'WINDOWS_PLUGIN_VERSION_PROBE_FAILED'
    }))
  })

  it.each([
    '',
    'relative\\Dyson',
    `${fixtureProjectRoot()}\nother`,
    `${fixtureProjectRoot()}\0other`
  ])('rejects a non-fixed project root at construction', (projectRoot) => {
    expect(() => new WindowsManagedPluginVersionProbe({
      projectRoot,
      scriptRunner: new FakeScriptRunner()
    })).toThrow(expect.objectContaining<Partial<WindowsManagedPluginVersionProbeError>>({
      code: 'WINDOWS_PLUGIN_VERSION_PROBE_CONFIG_INVALID'
    }))
  })
})

interface FixtureResponseOverrides {
  protocol?: string
  component?: 'bridge' | 'control'
  fileName?: 'DysonControlBridge.dll' | 'DysonControl.dll'
  relativePath?:
    | 'plugins/dyson-control-bridge/DysonControlBridge.dll'
    | 'plugins/dyson-control/DysonControl.dll'
  state?: string
  version?: string | null
  extra?: boolean
}

function response(overrides: FixtureResponseOverrides = {}): string {
  return JSON.stringify({
    protocol: 'DYSON_CONTROL_MANAGED_PLUGIN_VERSION_V1',
    component: 'bridge',
    fileName: 'DysonControlBridge.dll',
    relativePath: 'plugins/dyson-control-bridge/DysonControlBridge.dll',
    state: 'available',
    version: '0.1.0',
    ...overrides
  })
}

function fixtureProjectRoot(): string {
  return process.platform === 'win32' ? 'C:\\Fictional\\Dyson' : '/fictional/dyson'
}

class FakeScriptRunner implements LifecycleScriptRunner {
  readonly calls: Array<{
    scriptName: LifecycleScriptName
    arguments: string[]
    signal: AbortSignal
  }> = []
  output = response()
  failure: Error | null = null

  async run(scriptName: LifecycleScriptName, arguments_: string[], signal: AbortSignal): Promise<string> {
    this.calls.push({ scriptName, arguments: [...arguments_], signal })
    if (this.failure !== null) throw this.failure
    return this.output
  }
}

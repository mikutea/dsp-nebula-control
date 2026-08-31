import { afterEach, describe, expect, it } from 'vitest'
import { copyFile, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { normalizeVersion } from '../updates/version.js'
import { PowerShellLifecycleRunner, type LifecycleScriptName } from './powershell-runner.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.runIf(process.platform === 'win32')('Windows managed plugin version host script', () => {
  it('reads FileVersionInfo from only the fixed bridge DLL and emits the bounded protocol', async () => {
    const projectRoot = await createProjectFixture()
    await installVersionedFixture(projectRoot, 'bridge')

    const output = JSON.parse(await createRunner().run(
      'Get-DysonManagedPluginVersion.ps1',
      ['-ProjectRoot', projectRoot, '-Component', 'bridge'],
      new AbortController().signal
    ))

    expect(output).toEqual({
      protocol: 'DYSON_CONTROL_MANAGED_PLUGIN_VERSION_V1',
      component: 'bridge',
      fileName: 'DysonControlBridge.dll',
      relativePath: 'plugins/dyson-control-bridge/DysonControlBridge.dll',
      state: 'available',
      version: normalizeVersion(process.versions.node, 'plugin')
    })
  }, 30_000)

  it('reports the fixed component as explicitly absent when its DLL is missing', async () => {
    const projectRoot = await createProjectFixture()

    const output = JSON.parse(await createRunner().run(
      'Get-DysonManagedPluginVersion.ps1',
      ['-ProjectRoot', projectRoot, '-Component', 'control'],
      new AbortController().signal
    ))
    expect(output).toEqual({
      protocol: 'DYSON_CONTROL_MANAGED_PLUGIN_VERSION_V1',
      component: 'control',
      fileName: 'DysonControl.dll',
      relativePath: 'plugins/dyson-control/DysonControl.dll',
      state: 'absent',
      version: null
    })
  }, 30_000)

  it('rejects a reparse-point component entry', async () => {
    const projectRoot = await createProjectFixture()
    const target = path.join(projectRoot, 'junction-target')
    await mkdir(target)
    await symlink(target, pluginDirectoryPath(projectRoot, 'control'), 'junction')

    await expect(createRunner().run(
      'Get-DysonManagedPluginVersion.ps1',
      ['-ProjectRoot', projectRoot, '-Component', 'control'],
      new AbortController().signal
    )).rejects.toMatchObject({ code: 'HOST_SCRIPT_FAILED' })
  }, 30_000)

  it('does not accept a caller-selected path or unknown component', async () => {
    const projectRoot = await createProjectFixture()
    await installVersionedFixture(projectRoot, 'bridge')
    const runner = createRunner()

    await expect(runner.run(
      'Get-DysonManagedPluginVersion.ps1',
      ['-ProjectRoot', projectRoot, '-Component', 'bridge', '-Path', process.execPath],
      new AbortController().signal
    )).rejects.toMatchObject({ code: 'HOST_SCRIPT_FAILED' })
    await expect(runner.run(
      'Get-DysonManagedPluginVersion.ps1',
      ['-ProjectRoot', projectRoot, '-Component', 'nebula'],
      new AbortController().signal
    )).rejects.toMatchObject({ code: 'HOST_SCRIPT_FAILED' })
  }, 30_000)
})

describe('Windows managed plugin version script policy', () => {
  it('contains only the fixed component-to-DLL mapping and FileVersionInfo probe', async () => {
    const source = await readFile(scriptPath(), 'utf8')

    expect(source).toContain("[ValidateSet('bridge', 'control')]")
    expect(source).toContain("directoryName = 'dyson-control-bridge'")
    expect(source).toContain("directoryName = 'dyson-control'")
    expect(source).toContain("relativePath = 'plugins/dyson-control-bridge/DysonControlBridge.dll'")
    expect(source).toContain("relativePath = 'plugins/dyson-control/DysonControl.dll'")
    expect(source).toContain('[System.Diagnostics.FileVersionInfo]::GetVersionInfo')
    expect(source).toContain('[System.IO.FileAttributes]::ReparsePoint')
    expect(source).not.toMatch(
      /\[Parameter\([^\r\n]*\)\]\[[^\]]+\]\$(?:Path|Dll|FileName|Command)\b/i
    )
    expect(source).not.toMatch(/\b(?:Invoke-Expression|Start-Process|Get-Content|Add-Content|Set-Content)\b/i)
  })

  it('keeps the PowerShell runner allowlist enforced at runtime', async () => {
    const scriptRoot = await mkdtemp(path.join(tmpdir(), 'dyson-script-allowlist-fixture-'))
    temporaryRoots.push(scriptRoot)
    await writeFile(path.join(scriptRoot, 'Unlisted.ps1'), "Write-Output 'should-not-run'", 'utf8')
    const runner = new PowerShellLifecycleRunner(scriptRoot, 5_000)

    await expect(runner.run(
      'Unlisted.ps1' as LifecycleScriptName,
      [],
      new AbortController().signal
    )).rejects.toMatchObject({ code: 'HOST_SCRIPT_INVALID' })
  })
})

async function createProjectFixture(): Promise<string> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'dyson-plugin-version-fixture-'))
  temporaryRoots.push(projectRoot)
  await mkdir(path.join(projectRoot, 'server', 'BepInEx', 'plugins'), { recursive: true })
  return projectRoot
}

async function installVersionedFixture(projectRoot: string, component: 'bridge' | 'control'): Promise<void> {
  const destination = pluginPath(projectRoot, component)
  await mkdir(path.dirname(destination), { recursive: true })
  try {
    await link(process.execPath, destination)
  } catch {
    await copyFile(process.execPath, destination)
  }
}

function pluginDirectoryPath(projectRoot: string, component: 'bridge' | 'control'): string {
  return path.join(
    projectRoot,
    'server',
    'BepInEx',
    'plugins',
    component === 'bridge' ? 'dyson-control-bridge' : 'dyson-control'
  )
}

function pluginPath(projectRoot: string, component: 'bridge' | 'control'): string {
  return path.join(
    pluginDirectoryPath(projectRoot, component),
    component === 'bridge' ? 'DysonControlBridge.dll' : 'DysonControl.dll'
  )
}

function createRunner(): PowerShellLifecycleRunner {
  return new PowerShellLifecycleRunner(path.dirname(scriptPath()), 20_000)
}

function scriptPath(): string {
  const repositoryRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..')
  return path.join(repositoryRoot, 'scripts', 'windows', 'Get-DysonManagedPluginVersion.ps1')
}

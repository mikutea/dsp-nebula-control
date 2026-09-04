import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PowerShellLifecycleRunner } from './powershell-runner.js'

const temporaryRoots: string[] = []
const requestId = '11111111-2222-4333-8444-555555555555'

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Windows lifecycle host scripts', () => {
  it('creates, verifies, and idempotently reuses an atomic paired-save protection point', async () => {
    const projectRoot = await createProjectFixture()
    const runner = createRunner()
    const arguments_ = ['-ProjectRoot', projectRoot, '-RequestId', requestId]
    const first = JSON.parse(await runner.run(
      'New-DysonSaveProtectionPoint.ps1', arguments_, new AbortController().signal
    ))
    expect(first).toMatchObject({
      protocol: 'DYSON_CONTROL_PROTECTION_V1', schemaVersion: 1, requestId,
      state: 'succeeded', dryRun: false, mutationPerformed: true,
      protectionPointId: `save:${requestId}`, sourcePairVerified: true,
      manifestVerified: true, reused: false
    })

    const protectionRoot = path.join(projectRoot, 'backups', 'saves', `tx-${requestId}`)
    const manifest = JSON.parse(await readFile(path.join(protectionRoot, 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({
      protocol: 'DYSON_CONTROL_PROTECTION_V1', schemaVersion: 1, requestId,
      saveName: '_lastexit_'
    })
    expect(manifest.files).toHaveLength(2)
    expect(await readFile(path.join(protectionRoot, '_lastexit_.dsv'), 'utf8')).toBe('fictional-save')
    expect(await readFile(path.join(protectionRoot, '_lastexit_.server'), 'utf8')).toBe('fictional-sidecar')

    const manifestBeforePreview = await readFile(path.join(protectionRoot, 'manifest.json'), 'utf8')
    const protectedFilesBeforePreview = await Promise.all([
      stat(path.join(protectionRoot, 'manifest.json')),
      stat(path.join(protectionRoot, '_lastexit_.dsv')),
      stat(path.join(protectionRoot, '_lastexit_.server'))
    ])
    await Promise.all([
      writeFile(path.join(projectRoot, 'userdata', 'Save', '_lastexit_.dsv'), 'newer-live-save', 'utf8'),
      writeFile(path.join(projectRoot, 'userdata', 'Save', '_lastexit_.server'), 'newer-live-sidecar', 'utf8')
    ])
    const changedLiveReuse = JSON.parse(await runner.run(
      'New-DysonSaveProtectionPoint.ps1', arguments_, new AbortController().signal
    ))
    expect(changedLiveReuse).toMatchObject({
      state: 'succeeded', dryRun: false, mutationPerformed: false,
      sourcePairVerified: true, dsvBytes: 14, serverBytes: 17,
      reused: true, manifestVerified: true
    })
    await rm(path.join(projectRoot, 'userdata', 'Save'), { recursive: true })
    const reusePreview = JSON.parse(await runner.run(
      'New-DysonSaveProtectionPoint.ps1', [...arguments_, '-WhatIf'], new AbortController().signal
    ))
    expect(reusePreview).toEqual({
      protocol: 'DYSON_CONTROL_PROTECTION_V1', schemaVersion: 1, requestId,
      state: 'preview', dryRun: true, mutationPerformed: false,
      protectionPointId: `save:${requestId}`, sourcePairVerified: true,
      dsvBytes: 14, serverBytes: 17, manifestVerified: true, reused: true,
      wouldCreate: false, wouldRemoveStaleStaging: false
    })
    expect(await readFile(path.join(protectionRoot, 'manifest.json'), 'utf8')).toBe(manifestBeforePreview)
    const protectedFilesAfterPreview = await Promise.all([
      stat(path.join(protectionRoot, 'manifest.json')),
      stat(path.join(protectionRoot, '_lastexit_.dsv')),
      stat(path.join(protectionRoot, '_lastexit_.server'))
    ])
    expect(protectedFilesAfterPreview.map(({ mtimeMs, size }) => ({ mtimeMs, size })))
      .toEqual(protectedFilesBeforePreview.map(({ mtimeMs, size }) => ({ mtimeMs, size })))

    const reused = JSON.parse(await runner.run(
      'New-DysonSaveProtectionPoint.ps1', arguments_, new AbortController().signal
    ))
    expect(reused).toMatchObject({
      state: 'succeeded', dryRun: false, mutationPerformed: false,
      sourcePairVerified: true, dsvBytes: 14, serverBytes: 17,
      reused: true, manifestVerified: true
    })

    await writeFile(path.join(protectionRoot, '_lastexit_.dsv'), 'tampered', 'utf8')
    await expect(runner.run(
      'New-DysonSaveProtectionPoint.ps1', arguments_, new AbortController().signal
    )).rejects.toMatchObject({ code: 'HOST_SCRIPT_FAILED' })
  }, 30_000)

  it('returns a stable redacted WhatIf receipt without creating, deleting, moving, or writing files', async () => {
    const projectRoot = await createProjectFixture({ backupRoot: false })
    const runner = createRunner()
    const previewArguments = [
      '-ProjectRoot', projectRoot, '-RequestId', requestId, '-WhatIf'
    ]

    const first = JSON.parse(await runner.run(
      'New-DysonSaveProtectionPoint.ps1', previewArguments, new AbortController().signal
    ))
    const second = JSON.parse(await runner.run(
      'New-DysonSaveProtectionPoint.ps1', previewArguments, new AbortController().signal
    ))
    expect(second).toEqual(first)
    expect(first).toEqual({
      protocol: 'DYSON_CONTROL_PROTECTION_V1', schemaVersion: 1, requestId,
      state: 'preview', dryRun: true, mutationPerformed: false,
      protectionPointId: `save:${requestId}`, sourcePairVerified: true,
      dsvBytes: 14, serverBytes: 17, manifestVerified: false, reused: false,
      wouldCreate: true, wouldRemoveStaleStaging: false
    })
    expect(JSON.stringify(first)).not.toContain(projectRoot)
    await expect(readdir(path.join(projectRoot, 'backups'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(path.join(projectRoot, 'userdata', 'Save', '_lastexit_.dsv'), 'utf8'))
      .toBe('fictional-save')
    expect(await readFile(path.join(projectRoot, 'userdata', 'Save', '_lastexit_.server'), 'utf8'))
      .toBe('fictional-sidecar')

    const saveBackupRoot = path.join(projectRoot, 'backups', 'saves')
    const stagingRoot = path.join(saveBackupRoot, `.staging-${requestId}`)
    await mkdir(stagingRoot, { recursive: true })
    await writeFile(path.join(stagingRoot, 'keep.txt'), 'unchanged-staging', 'utf8')
    const stalePreview = JSON.parse(await runner.run(
      'New-DysonSaveProtectionPoint.ps1', previewArguments, new AbortController().signal
    ))
    expect(stalePreview).toMatchObject({
      state: 'preview', dryRun: true, mutationPerformed: false,
      wouldCreate: true, wouldRemoveStaleStaging: true
    })
    expect(await readdir(saveBackupRoot)).toEqual([`.staging-${requestId}`])
    expect(await readFile(path.join(stagingRoot, 'keep.txt'), 'utf8')).toBe('unchanged-staging')
    await expect(readFile(
      path.join(saveBackupRoot, `tx-${requestId}`, 'manifest.json'), 'utf8'
    )).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  it('verifies a stopped fixture and durably reconciles an already-stopped task request', async () => {
    const projectRoot = await createProjectFixture()
    const gamePort = '65431'
    const repositoryRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..')
    const taskScriptRoot = path.join(repositoryRoot, 'scripts', 'windows')
    const runtime = JSON.parse(await runLegacyHostScript(
      'Test-DysonRuntimeState.ps1',
      ['-ProjectRoot', projectRoot, '-Expected', 'stopped', '-GamePort', gamePort]
    ))
    expect(runtime).toEqual({
      protocol: 'DYSON_CONTROL_RUNTIME_V1', expected: 'stopped', state: 'matched',
      processVerified: true, gamePortListening: false
    })

    const taskArguments = [
      '-ProjectRoot', projectRoot, '-RequestId', requestId,
      '-Operation', 'graceful-stop', '-TaskName', 'Fictional-Dyson-Stop',
      '-AllowedTaskScriptRoot', taskScriptRoot, '-GamePort', gamePort
    ]
    const receipt = JSON.parse(await runLegacyHostScript(
      'Invoke-DysonScheduledTask.ps1', taskArguments
    ))
    expect(receipt).toMatchObject({
      protocol: 'DYSON_CONTROL_TASK_RECEIPT_V1', requestId,
      operation: 'graceful-stop', state: 'succeeded', outcome: 'already-stopped',
      processVerified: true
    })
    const durableReceipt = JSON.parse(await readFile(
      path.join(projectRoot, 'run', 'control-receipts', `${requestId}.graceful-stop.json`), 'utf8'
    ))
    expect(durableReceipt).toEqual(receipt)
  }, 30_000)

  it('refuses to start a stopped fixture when the fixed scheduled task is unavailable', async () => {
    const projectRoot = await createProjectFixture()
    const repositoryRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..')
    const taskScriptRoot = path.join(repositoryRoot, 'scripts', 'windows')
    await writeFile(path.join(projectRoot, 'server', 'DSPGAME.exe'), 'fictional-executable', 'utf8')

    await expect(runLegacyHostScript(
      'Invoke-DysonScheduledTask.ps1',
      [
        '-ProjectRoot', projectRoot, '-RequestId', requestId,
        '-Operation', 'start', '-TaskName', 'Fictional-Missing-Dyson-Start',
        '-AllowedTaskScriptRoot', taskScriptRoot,
        '-GamePort', '65431'
      ]
    )).rejects.toMatchObject({ code: 'HOST_SCRIPT_FAILED' })

    await expect(readFile(
      path.join(projectRoot, 'run', 'control-receipts', `${requestId}.start.json`), 'utf8'
    )).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  it('keeps every start boundary fail closed for DSPGAME outside the fixed executable', async () => {
    const repositoryRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..')
    const scriptRoot = path.join(repositoryRoot, 'scripts', 'windows')
    const sources = await Promise.all([
      'Get-DysonLifecyclePreflight.ps1',
      'Invoke-DysonScheduledTask.ps1',
      'Test-DysonRuntimeState.ps1',
      'Start-DysonServer.ps1'
    ].map((name) => readFile(path.join(scriptRoot, name), 'utf8')))
    for (const source of sources) {
      expect(source).toContain('$verifiedManagedProcess = $false')
      expect(source).toMatch(/if \(-not \$verifiedManagedProcess\)/)
    }
    expect(sources[0]).toContain("-Blocker 'managed-process-unverified'")
    expect(sources[1]).toContain('A DSP process is running outside the fixed managed executable.')
    expect(sources[2]).toContain('$unverifiedDspProcessCount -gt 0')
    expect(sources[3]).toContain('A DSP process is already running outside the fixed managed executable.')
  })
})

async function createProjectFixture(options: { backupRoot?: boolean } = {}): Promise<string> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'dyson-lifecycle-host-fixture-'))
  temporaryRoots.push(projectRoot)
  const directories = [
    mkdir(path.join(projectRoot, 'server'), { recursive: true }),
    mkdir(path.join(projectRoot, 'userdata', 'Save'), { recursive: true }),
    mkdir(path.join(projectRoot, 'run'), { recursive: true })
  ]
  if (options.backupRoot !== false) {
    directories.push(mkdir(path.join(projectRoot, 'backups', 'saves'), { recursive: true }))
  }
  await Promise.all(directories)
  await Promise.all([
    writeFile(path.join(projectRoot, 'server', 'DSPGAME.exe'), 'fictional-executable', 'utf8'),
    writeFile(path.join(projectRoot, 'userdata', 'Save', '_lastexit_.dsv'), 'fictional-save', 'utf8'),
    writeFile(path.join(projectRoot, 'userdata', 'Save', '_lastexit_.server'), 'fictional-sidecar', 'utf8')
  ])
  return projectRoot
}

function createRunner(): PowerShellLifecycleRunner {
  const repositoryRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..')
  return new PowerShellLifecycleRunner(path.join(repositoryRoot, 'scripts', 'windows'), 20_000)
}

const execFileAsync = promisify(execFile)

async function runLegacyHostScript(
  scriptName: 'Invoke-DysonScheduledTask.ps1' | 'Test-DysonRuntimeState.ps1',
  arguments_: string[]
): Promise<string> {
  const repositoryRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..')
  try {
    const result = await execFileAsync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(repositoryRoot, 'scripts', 'windows', scriptName),
      ...arguments_
    ], { encoding: 'utf8', windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 })
    return result.stdout.trim()
  } catch {
    const error = new Error('HOST_SCRIPT_FAILED') as Error & { code: string }
    error.code = 'HOST_SCRIPT_FAILED'
    throw error
  }
}

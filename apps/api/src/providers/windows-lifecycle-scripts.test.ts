import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
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
      protocol: 'DYSON_CONTROL_PROTECTION_V1', requestId, state: 'succeeded',
      protectionPointId: `save:${requestId}`, manifestVerified: true, reused: false
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

    const reused = JSON.parse(await runner.run(
      'New-DysonSaveProtectionPoint.ps1', arguments_, new AbortController().signal
    ))
    expect(reused).toMatchObject({ state: 'succeeded', reused: true, manifestVerified: true })

    await writeFile(path.join(protectionRoot, '_lastexit_.dsv'), 'tampered', 'utf8')
    await expect(runner.run(
      'New-DysonSaveProtectionPoint.ps1', arguments_, new AbortController().signal
    )).rejects.toMatchObject({ code: 'HOST_SCRIPT_FAILED' })
  }, 30_000)

  it('verifies a stopped fixture and durably reconciles an already-stopped task request', async () => {
    const projectRoot = await createProjectFixture()
    const runner = createRunner()
    const gamePort = '65431'
    const runtime = JSON.parse(await runner.run(
      'Test-DysonRuntimeState.ps1',
      ['-ProjectRoot', projectRoot, '-Expected', 'stopped', '-GamePort', gamePort],
      new AbortController().signal
    ))
    expect(runtime).toEqual({
      protocol: 'DYSON_CONTROL_RUNTIME_V1', expected: 'stopped', state: 'matched',
      processVerified: true, gamePortListening: false
    })

    const taskArguments = [
      '-ProjectRoot', projectRoot, '-RequestId', requestId,
      '-Operation', 'graceful-stop', '-TaskName', 'Fictional-Dyson-Stop', '-GamePort', gamePort
    ]
    const receipt = JSON.parse(await runner.run(
      'Invoke-DysonScheduledTask.ps1', taskArguments, new AbortController().signal
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
    const runner = createRunner()
    await writeFile(path.join(projectRoot, 'server', 'DSPGAME.exe'), 'fictional-executable', 'utf8')

    await expect(runner.run(
      'Invoke-DysonScheduledTask.ps1',
      [
        '-ProjectRoot', projectRoot, '-RequestId', requestId,
        '-Operation', 'start', '-TaskName', 'Fictional-Missing-Dyson-Start',
        '-GamePort', '65431'
      ],
      new AbortController().signal
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

async function createProjectFixture(): Promise<string> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'dyson-lifecycle-host-fixture-'))
  temporaryRoots.push(projectRoot)
  await Promise.all([
    mkdir(path.join(projectRoot, 'server'), { recursive: true }),
    mkdir(path.join(projectRoot, 'userdata', 'Save'), { recursive: true }),
    mkdir(path.join(projectRoot, 'backups', 'saves'), { recursive: true }),
    mkdir(path.join(projectRoot, 'run'), { recursive: true })
  ])
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

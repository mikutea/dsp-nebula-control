import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FileBridgeClient } from '../bridge/file-client.js'
import {
  buildBridgeHeartbeat,
  buildBridgeReceipt,
  computeBridgeSaveGenerationId,
  parseBridgeRequest
} from '../bridge/protocol.js'
import { ControlDatabase } from '../storage/database.js'
import { EventHub } from '../services/event-hub.js'
import { LifecycleService } from '../services/lifecycle-service.js'
import { DemoProvider } from './demo.js'
import { PowerShellLifecycleRunner } from './powershell-runner.js'
import { WindowsLifecycleAdapter } from './windows-lifecycle.js'

const temporaryRoots: string[] = []
const secret = 'fictional-integration-bridge-secret-0123456789'

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Windows save lifecycle integration', () => {
  it('runs protection, signed in-game save, durable receipts, and idempotency as one transaction', async () => {
    const fixture = await createFixture()
    const repositoryRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..')
    const bridgeClient = new FileBridgeClient({
      controlRoot: fixture.controlRoot,
      secretFile: fixture.secretFile,
      timeoutMs: 5_000,
      pollMs: 25,
      requestLifetimeMs: 5_000
    })
    const adapter = new WindowsLifecycleAdapter({
      projectRoot: fixture.projectRoot,
      statusProvider: new DemoProvider(),
      scriptRunner: new PowerShellLifecycleRunner(path.join(repositoryRoot, 'scripts', 'windows'), 10_000),
      bridgeClient
    })
    const database = new ControlDatabase('unused', true)
    const service = new LifecycleService(database, adapter, new EventHub(), 10_000)
    const simulatedPlugin = completeNextSave(fixture)

    const result = await service.execute('save', 'save:windows-integration:0001', 'Administrator')
    const expectedGenerationId = await simulatedPlugin
    expect(result.job).toMatchObject({ state: 'succeeded', errorCode: null })
    expect(result.run).toMatchObject({
      state: 'succeeded', recoveryRequired: false,
      protectionPointId: `save:${result.run.requestId}`
    })
    expect(result.receipts.map((receipt) => [receipt.phase, receipt.state])).toEqual([
      ['lock', 'succeeded'], ['preflight', 'succeeded'],
      ['protection-point', 'succeeded'], ['save', 'succeeded']
    ])
    expect(result.receipts.at(-1)?.evidence).toMatchObject({
      generationId: expectedGenerationId,
      saveAdvanced: true,
      dsvBytes: 20,
      serverBytes: 23
    })

    const protectionRoot = path.join(
      fixture.projectRoot, 'backups', 'saves', `tx-${result.run.requestId}`
    )
    expect(await readFile(path.join(protectionRoot, '_lastexit_.dsv'), 'utf8')).toBe('before-save')
    expect(await readFile(path.join(fixture.saveRoot, '_lastexit_.dsv'), 'utf8')).toBe('after-save-pair-data')

    const duplicate = await service.execute('save', 'save:windows-integration:0001', 'Administrator')
    expect(duplicate).toMatchObject({ reused: true, job: { id: result.job.id, state: 'succeeded' } })
    expect(duplicate.receipts.at(-1)?.evidence).toMatchObject({ generationId: expectedGenerationId })
    expect((await readdir(path.join(fixture.controlRoot, 'requests')))).toEqual([])
    database.close()
  }, 30_000)
})

interface Fixture {
  projectRoot: string
  saveRoot: string
  controlRoot: string
  secretFile: string
}

async function createFixture(): Promise<Fixture> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'dyson-windows-lifecycle-integration-'))
  temporaryRoots.push(projectRoot)
  const saveRoot = path.join(projectRoot, 'userdata', 'Save')
  const controlRoot = path.join(projectRoot, 'run', 'control-bridge')
  const secretFile = path.join(projectRoot, 'run', 'bridge.secret')
  await Promise.all([
    mkdir(path.join(projectRoot, 'server'), { recursive: true }),
    mkdir(saveRoot, { recursive: true }),
    mkdir(path.join(projectRoot, 'backups', 'saves'), { recursive: true }),
    mkdir(path.join(controlRoot, 'requests'), { recursive: true }),
    mkdir(path.join(controlRoot, 'receipts'), { recursive: true })
  ])
  await Promise.all([
    writeFile(path.join(saveRoot, '_lastexit_.dsv'), 'before-save', 'utf8'),
    writeFile(path.join(saveRoot, '_lastexit_.server'), 'before-sidecar', 'utf8'),
    writeFile(secretFile, secret, 'utf8')
  ])
  const now = Date.now()
  const heartbeat = buildBridgeHeartbeat({
    pluginVersion: '0.1.0', processId: 4242,
    startedAtUnixMs: now - 60_000, writtenAtUnixMs: now
  }, secret)
  await writeFile(path.join(controlRoot, 'heartbeat'), heartbeat.payload, 'utf8')
  return { projectRoot, saveRoot, controlRoot, secretFile }
}

async function completeNextSave(fixture: Fixture): Promise<string> {
  const requestFile = await waitForRequest(fixture.controlRoot)
  const request = parseBridgeRequest(
    await readFile(path.join(fixture.controlRoot, 'requests', requestFile), 'utf8'), secret
  )
  const dsv = 'after-save-pair-data'
  const sidecar = 'after-save-sidecar-data'
  await Promise.all([
    writeFile(path.join(fixture.saveRoot, '_lastexit_.dsv'), dsv, 'utf8'),
    writeFile(path.join(fixture.saveRoot, '_lastexit_.server'), sidecar, 'utf8')
  ])
  const [dsvStats, serverStats] = await Promise.all([
    stat(path.join(fixture.saveRoot, '_lastexit_.dsv'), { bigint: true }),
    stat(path.join(fixture.saveRoot, '_lastexit_.server'), { bigint: true })
  ])
  const dotNetUnixEpochTicks = 621355968000000000n
  const startedAtUnixMs = Date.now()
  const receipt = buildBridgeReceipt({
    requestId: request.requestId,
    action: 'save',
    state: 'succeeded',
    startedAtUnixMs,
    finishedAtUnixMs: startedAtUnixMs + 30,
    saveName: '_lastexit_',
    saveTimeBefore: 100,
    saveTimeAfter: 101,
    dsvBytes: Buffer.byteLength(dsv),
    dsvWriteTimeUtcTicks: dotNetUnixEpochTicks + dsvStats.mtimeNs / 100n,
    serverBytes: Buffer.byteLength(sidecar),
    serverWriteTimeUtcTicks: dotNetUnixEpochTicks + serverStats.mtimeNs / 100n,
    dsvChanged: true,
    serverChanged: true,
    errorCode: 'NONE'
  }, secret)
  const temporary = path.join(fixture.controlRoot, 'receipts', `.partial-${request.requestId}`)
  await writeFile(temporary, receipt.payload, 'utf8')
  await rename(temporary, path.join(fixture.controlRoot, 'receipts', `${request.requestId}.receipt`))
  await rm(path.join(fixture.controlRoot, 'requests', requestFile), { force: true })
  return computeBridgeSaveGenerationId(receipt.receipt)
}

async function waitForRequest(controlRoot: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const files = (await readdir(path.join(controlRoot, 'requests'))).filter((file) => file.endsWith('.request'))
    if (files[0]) return files[0]
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('The simulated game bridge did not receive a save request')
}

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FileBridgeClient } from './file-client.js'
import {
  BridgeProtocolError,
  buildBridgeHeartbeat,
  buildBridgeReceipt,
  parseBridgeRequest
} from './protocol.js'

const temporaryRoots: string[] = []
const secret = 'fictional-bridge-secret-that-is-long-enough-123456'

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('file bridge client', () => {
  it('writes one signed request and accepts a matching signed receipt', async () => {
    const fixture = await createFixture()
    const client = new FileBridgeClient({
      controlRoot: fixture.controlRoot,
      secretFile: fixture.secretFile,
      timeoutMs: 2_000,
      pollMs: 25,
      requestLifetimeMs: 1_500
    })

    const pending = client.requestSave()
    const requestFile = await waitForRequest(fixture.controlRoot)
    const request = parseBridgeRequest(
      await readFile(path.join(fixture.controlRoot, 'requests', requestFile), 'utf8'),
      secret
    )
    const startedAtUnixMs = Date.now()
    const receipt = buildBridgeReceipt({
      requestId: request.requestId,
      action: 'save',
      state: 'succeeded',
      startedAtUnixMs,
      finishedAtUnixMs: startedAtUnixMs + 40,
      saveTimeBefore: 100,
      saveTimeAfter: 101,
      dsvBytes: 1_024,
      serverBytes: 256,
      errorCode: 'NONE'
    }, secret)
    await writeReceipt(fixture.controlRoot, request.requestId, receipt.payload)

    await expect(pending).resolves.toMatchObject({
      requestId: request.requestId,
      action: 'save',
      state: 'succeeded',
      errorCode: 'NONE'
    })
  })

  it('returns an existing signed receipt without creating a duplicate request', async () => {
    const fixture = await createFixture()
    const requestId = 'd98998ce-ff36-4c31-a4a0-85e2dd2c4fb0'
    const now = Date.now()
    const receipt = buildBridgeReceipt({
      requestId,
      action: 'save',
      state: 'failed',
      startedAtUnixMs: now,
      finishedAtUnixMs: now + 1,
      saveTimeBefore: -1,
      saveTimeAfter: -1,
      dsvBytes: -1,
      serverBytes: -1,
      errorCode: 'GAME_NOT_READY'
    }, secret)
    await writeReceipt(fixture.controlRoot, requestId, receipt.payload)
    const client = new FileBridgeClient({
      controlRoot: fixture.controlRoot,
      secretFile: fixture.secretFile,
      timeoutMs: 1_000
    })

    await expect(client.requestSave(requestId)).resolves.toMatchObject({ state: 'failed', errorCode: 'GAME_NOT_READY' })
    expect(await readdir(path.join(fixture.controlRoot, 'requests'))).toEqual([])
  })

  it('rejects a tampered receipt', async () => {
    const fixture = await createFixture()
    const client = new FileBridgeClient({
      controlRoot: fixture.controlRoot,
      secretFile: fixture.secretFile,
      timeoutMs: 2_000,
      pollMs: 25,
      requestLifetimeMs: 1_500
    })
    const pending = client.requestSave()
    const requestFile = await waitForRequest(fixture.controlRoot)
    const request = parseBridgeRequest(
      await readFile(path.join(fixture.controlRoot, 'requests', requestFile), 'utf8'),
      secret
    )
    const now = Date.now()
    const receipt = buildBridgeReceipt({
      requestId: request.requestId,
      action: 'save',
      state: 'failed',
      startedAtUnixMs: now,
      finishedAtUnixMs: now + 1,
      saveTimeBefore: -1,
      saveTimeAfter: -1,
      dsvBytes: -1,
      serverBytes: -1,
      errorCode: 'SAVE_CALL_FAILED'
    }, secret)
    const tampered = receipt.payload.replace(/hmac=([0-9a-f])/, (_match, first: string) => `hmac=${first === '0' ? '1' : '0'}`)
    await writeReceipt(fixture.controlRoot, request.requestId, tampered)

    await expect(pending).rejects.toMatchObject({
      code: 'BRIDGE_SIGNATURE_INVALID'
    })
  })

  it('times out with a fixed error when no receipt arrives', async () => {
    const fixture = await createFixture()
    const client = new FileBridgeClient({
      controlRoot: fixture.controlRoot,
      secretFile: fixture.secretFile,
      timeoutMs: 1_000,
      pollMs: 25,
      requestLifetimeMs: 1_000
    })

    await expect(client.requestSave()).rejects.toMatchObject({
      code: 'BRIDGE_RECEIPT_TIMEOUT'
    })
  })

  it('rejects an oversized receipt before parsing it', async () => {
    const fixture = await createFixture()
    const requestId = '86c35626-6a3c-4688-bf00-b925661ac38a'
    await writeReceipt(fixture.controlRoot, requestId, 'x'.repeat(4097))
    const client = new FileBridgeClient({
      controlRoot: fixture.controlRoot,
      secretFile: fixture.secretFile,
      timeoutMs: 1_000
    })

    await expect(client.requestSave(requestId)).rejects.toMatchObject({
      code: 'BRIDGE_RECEIPT_FILE_INVALID'
    })
  })

  it('accepts only a fresh signed heartbeat from the running game bridge', async () => {
    const fixture = await createFixture()
    const now = Date.now()
    const heartbeat = buildBridgeHeartbeat({
      pluginVersion: '0.1.0', processId: 4242,
      startedAtUnixMs: now - 60_000, writtenAtUnixMs: now
    }, secret)
    await writeFile(path.join(fixture.controlRoot, 'heartbeat'), heartbeat.payload, 'utf8')
    const client = new FileBridgeClient({
      controlRoot: fixture.controlRoot, secretFile: fixture.secretFile,
      timeoutMs: 1_000, heartbeatMaxAgeMs: 2_000
    })

    await expect(client.probe()).resolves.toMatchObject({
      pluginVersion: '0.1.0', processId: 4242, state: 'ready'
    })

    const stale = buildBridgeHeartbeat({
      pluginVersion: '0.1.0', processId: 4242,
      startedAtUnixMs: now - 60_000, writtenAtUnixMs: now - 3_000
    }, secret)
    await writeFile(path.join(fixture.controlRoot, 'heartbeat'), stale.payload, 'utf8')
    await expect(client.probe()).rejects.toMatchObject({ code: 'BRIDGE_HEARTBEAT_STALE' })
  })

  it('stops polling a save receipt when its lifecycle phase is aborted', async () => {
    const fixture = await createFixture()
    const client = new FileBridgeClient({
      controlRoot: fixture.controlRoot,
      secretFile: fixture.secretFile,
      timeoutMs: 5_000,
      pollMs: 25,
      requestLifetimeMs: 5_000
    })
    const controller = new AbortController()
    const pending = client.requestSave(undefined, controller.signal)
    await waitForRequest(fixture.controlRoot)
    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: 'BRIDGE_REQUEST_ABORTED' })
  })
})

async function createFixture(): Promise<{ controlRoot: string; secretFile: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'dyson-control-bridge-'))
  temporaryRoots.push(root)
  const controlRoot = path.join(root, 'control')
  await Promise.all([
    mkdir(path.join(controlRoot, 'requests'), { recursive: true }),
    mkdir(path.join(controlRoot, 'receipts'), { recursive: true })
  ])
  const secretFile = path.join(root, 'bridge.secret')
  await writeFile(secretFile, `${secret}\n`, 'utf8')
  return { controlRoot, secretFile }
}

async function waitForRequest(controlRoot: string): Promise<string> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const files = (await readdir(path.join(controlRoot, 'requests'))).filter((file) => file.endsWith('.request'))
    if (files[0]) return files[0]
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('request file was not created')
}

async function writeReceipt(controlRoot: string, requestId: string, payload: string): Promise<void> {
  const receiptsRoot = path.join(controlRoot, 'receipts')
  const temporary = path.join(receiptsRoot, `.partial-${requestId}`)
  await writeFile(temporary, payload, 'utf8')
  await rename(temporary, path.join(receiptsRoot, `${requestId}.receipt`))
}

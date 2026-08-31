import { createHmac } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileBridgeClient } from './file-client.js'
import {
  BridgeProtocolError,
  buildBridgeHeartbeat,
  buildBridgeReceipt,
  computeBridgeSaveGenerationId,
  parseBridgeRequest
} from './protocol.js'

const temporaryRoots: string[] = []
const secret = 'fictional-bridge-secret-that-is-long-enough-123456'

afterEach(async () => {
  vi.restoreAllMocks()
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
      saveName: '_lastexit_',
      saveTimeBefore: 100,
      saveTimeAfter: 101,
      dsvBytes: 1_024,
      dsvWriteTimeUtcTicks: 638817408010000001n,
      serverBytes: 256,
      serverWriteTimeUtcTicks: 638817408010000002n,
      dsvChanged: true,
      serverChanged: true,
      errorCode: 'NONE'
    }, secret)
    await writeReceipt(fixture.controlRoot, request.requestId, receipt.payload)

    const resolved = await pending
    expect(resolved).toMatchObject({
      requestId: request.requestId,
      action: 'save',
      state: 'succeeded',
      saveName: '_lastexit_',
      errorCode: 'NONE'
    })
    expect(computeBridgeSaveGenerationId(resolved)).toMatch(/^generation-v1:[0-9a-f]{64}$/)
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
      saveName: '_unavailable_',
      saveTimeBefore: -1,
      saveTimeAfter: -1,
      dsvBytes: -1,
      dsvWriteTimeUtcTicks: -1,
      serverBytes: -1,
      serverWriteTimeUtcTicks: -1,
      dsvChanged: false,
      serverChanged: false,
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
      saveName: '_unavailable_',
      saveTimeBefore: -1,
      saveTimeAfter: -1,
      dsvBytes: -1,
      dsvWriteTimeUtcTicks: -1,
      serverBytes: -1,
      serverWriteTimeUtcTicks: -1,
      dsvChanged: false,
      serverChanged: false,
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

  it('rejects a correctly signed legacy V1 receipt in the production client', async () => {
    const fixture = await createFixture()
    const requestId = '77777777-8888-4999-8aaa-bbbbbbbbbbbb'
    const legacyPayload = [
      'protocol=DYSON_CONTROL_RECEIPT_V1',
      `requestId=${requestId}`,
      'action=save',
      'state=succeeded',
      'startedAtUnixMs=1788081001000',
      'finishedAtUnixMs=1788081003500',
      'saveTimeBefore=1788080000',
      'saveTimeAfter=1788081003',
      'dsvBytes=1024',
      'serverBytes=256',
      'errorCode=NONE',
      'hmac=77c1c35697dcc76eaa733f5b60ccf7ca9f63bfe3cd7e6bfd156ec3e18affe99e',
      ''
    ].join('\n')
    await writeReceipt(fixture.controlRoot, requestId, legacyPayload)
    const client = new FileBridgeClient({
      controlRoot: fixture.controlRoot,
      secretFile: fixture.secretFile,
      timeoutMs: 1_000
    })

    await expect(client.requestSave(requestId)).rejects.toMatchObject({
      code: 'BRIDGE_PAYLOAD_INVALID'
    })
    expect(await readdir(path.join(fixture.controlRoot, 'requests'))).toEqual([])
  })

  it('rejects a correctly signed V2 success receipt for a non-last-exit slot', async () => {
    const fixture = await createFixture()
    const requestId = '77777777-8888-4999-8aaa-cccccccccccc'
    const now = Date.now()
    const valid = buildBridgeReceipt({
      requestId, action: 'save', state: 'succeeded',
      startedAtUnixMs: now, finishedAtUnixMs: now + 1,
      saveName: '_lastexit_', saveTimeBefore: 100, saveTimeAfter: 101,
      dsvBytes: 1024, dsvWriteTimeUtcTicks: 638817408010000001n,
      serverBytes: 256, serverWriteTimeUtcTicks: 638817408010000002n,
      dsvChanged: true, serverChanged: true, errorCode: 'NONE'
    }, secret)
    const wrongSlot = resignReceipt(
      valid.payload.replace('saveName=_lastexit_', 'saveName=_autosave_'),
      secret
    )
    await writeReceipt(fixture.controlRoot, requestId, wrongSlot)
    const client = new FileBridgeClient({
      controlRoot: fixture.controlRoot,
      secretFile: fixture.secretFile,
      timeoutMs: 1_000
    })

    await expect(client.requestSave(requestId)).rejects.toMatchObject({
      code: 'BRIDGE_RECEIPT_INCONSISTENT'
    })
    expect(await readdir(path.join(fixture.controlRoot, 'requests'))).toEqual([])
  })

  it.each([
    ['forward', 1_000_000_000],
    ['backward', -1_000_000_000]
  ] as const)('uses monotonic receipt timeout across a wall-clock step %s', async (_direction, step) => {
    const fixture = await createFixture()
    const baseUnixMs = 1_788_081_000_000
    let calls = 0
    vi.spyOn(Date, 'now').mockImplementation(() => (++calls <= 2 ? baseUnixMs : baseUnixMs + step))
    const client = new FileBridgeClient({
      controlRoot: fixture.controlRoot,
      secretFile: fixture.secretFile,
      timeoutMs: 1_000,
      pollMs: 25,
      requestLifetimeMs: 1_000
    })
    const startedAtMonotonicMs = performance.now()

    await expect(client.requestSave()).rejects.toMatchObject({ code: 'BRIDGE_RECEIPT_TIMEOUT' })
    expect(performance.now() - startedAtMonotonicMs).toBeGreaterThanOrEqual(900)
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

function resignReceipt(payload: string, signingSecret: string): string {
  const lines = payload.trimEnd().split('\n')
  const hmacIndex = lines.findIndex((line) => line.startsWith('hmac='))
  if (hmacIndex < 0) throw new Error('fixture receipt does not contain hmac')
  const signedValues = lines.slice(0, hmacIndex).map((line) => line.slice(line.indexOf('=') + 1))
  const hmac = createHmac('sha256', Buffer.from(signingSecret, 'utf8'))
    .update(signedValues.join('\n'), 'utf8')
    .digest('hex')
  lines[hmacIndex] = `hmac=${hmac}`
  return `${lines.join('\n')}\n`
}

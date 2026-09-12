import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildBridgeHeartbeat,
  buildBridgeRuntimeSession,
  type BridgeHeartbeat
} from '../bridge/protocol.js'
import {
  WINDOWS_UPDATE_RUNTIME_EVIDENCE_FILE,
  WINDOWS_UPDATE_RUNTIME_SESSION_FILE,
  WindowsUpdateRuntimeEvidenceReader,
  buildWindowsUpdateRuntimeEvidence,
  parseWindowsUpdateRuntimeEvidence
} from './windows-update-runtime-evidence.js'

const secret = 'fictional-cross-runtime-secret-0123456789'
const sessionId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
const processId = 4242
const processStartedAtUnixMs = 1_788_080_000_000
const bridgeStartedAtUnixMs = 1_788_081_000_000
const observedAtUnixMs = 1_788_081_004_000
const dsvSha256 = 'a'.repeat(64)
const serverSha256 = 'b'.repeat(64)

const crossRuntimePayload =
  'protocol=DYSON_CONTROL_LOADED_SAVE_EVIDENCE_V1\n' +
  'sessionId=bbbbbbbb-cccc-4ddd-8eee-ffffffffffff\n' +
  'pluginVersion=0.1.0\n' +
  'processId=4242\n' +
  'processStartedAtUnixMs=1788080000000\n' +
  'bridgeStartedAtUnixMs=1788081000000\n' +
  'observationGeneration=3\n' +
  'observedAtUnixMs=1788081004000\n' +
  'writtenAtUnixMs=1788081004000\n' +
  'saveName=_lastexit_\n' +
  'dsvBytes=5242880\n' +
  'dsvWriteTimeUtcTicks=638817408010000001\n' +
  'dsvSha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' +
  'serverBytes=22016\n' +
  'serverWriteTimeUtcTicks=638817408010000777\n' +
  'serverSha256=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n' +
  'hmac=39f7848082f8f134e09073effdffc5affafae1361764141dfe8ad9cc8fe16a72\n'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('WindowsUpdateRuntimeEvidenceReader', () => {
  it('distinguishes an unpublished evidence file from corrupt evidence', async () => {
    const f = await createFixture(observedAtUnixMs + 1_000)
    const file = path.join(f.controlRoot, WINDOWS_UPDATE_RUNTIME_EVIDENCE_FILE)
    await rm(file)
    await expect(f.reader.readCurrentRuntimeEvidence()).rejects.toMatchObject({
      code: 'WINDOWS_UPDATE_RUNTIME_EVIDENCE_NOT_READY'
    })
    await writeFile(file, 'not valid signed evidence')
    await expect(f.reader.readCurrentRuntimeEvidence()).rejects.not.toMatchObject({
      code: 'WINDOWS_UPDATE_RUNTIME_EVIDENCE_NOT_READY'
    })
  })

  it('shares the exact loaded-save HMAC vector with the C# Bridge', async () => {
    // Read the producer's public vector directly: a second handwritten fixture
    // previously drifted to a different field and signing input under the same V1.
    const producerTests = await readFile(path.resolve(import.meta.dirname,
      '..', '..', '..', '..', 'integrations', 'dyson-control-bridge', 'protocol-tests', 'Program.cs'), 'utf8')
    const declaration = producerTests.match(/private const string LoadedSaveEvidencePayload\s*=([\s\S]*?);/)
    expect(declaration).not.toBeNull()
    const producerPayload = [...declaration![1]!.matchAll(/"(?:[^"\\]|\\.)*"/g)]
      .map(([literal]) => JSON.parse(literal) as string).join('')
    expect(producerPayload).toBe(crossRuntimePayload)
    const built = buildWindowsUpdateRuntimeEvidence(evidenceInput(), secret)
    expect(built.payload).toBe(producerPayload)
    expect(parseWindowsUpdateRuntimeEvidence(producerPayload, secret)).toMatchObject({
      sessionId,
      processId,
      saveName: '_lastexit_',
      dsvWriteTimeUtcTicks: 638_817_408_010_000_001n,
      serverWriteTimeUtcTicks: 638_817_408_010_000_777n
    })
  })

  it('rejects the divergent base64 save-name wire format rather than accepting two V1 formats', () => {
    const divergentPayload = crossRuntimePayload
      .replace('saveName=_lastexit_', 'saveNameB64=X2xhc3RleGl0Xw')
      .replace('39f7848082f8f134e09073effdffc5affafae1361764141dfe8ad9cc8fe16a72',
        'b091d7fb4a122872daec763da2f697af21db08280048c085b3d52ff53dfd4c39')
    expect(() => parseWindowsUpdateRuntimeEvidence(divergentPayload, secret))
      .toThrow('WINDOWS_UPDATE_EVIDENCE_PAYLOAD_INVALID')
  })

  it('accepts an old durable load observation only when the current signed session and heartbeat match', async () => {
    const fixture = await createFixture(observedAtUnixMs + 86_400_000)
    const current = await fixture.reader.readCurrentRuntimeEvidence()
    expect(current).toEqual(expect.objectContaining({
      processId,
      processStartedAtUnixMs,
      bridgeStartedAtUnixMs,
      loadedSaveObservedAtUnixMs: observedAtUnixMs,
      loadedSaveIdentity: pairIdentity(5_242_880, dsvSha256, 22_016, serverSha256)
    }))
    expect(current.startupGenerationId).toMatch(/^[0-9a-f]{64}$/)
    expect(current.bridgeHeartbeatGenerationId).toBe(current.startupGenerationId)
    expect(current.loadedSaveLogGenerationId).toBe(current.startupGenerationId)
    expect(fixture.probes).toHaveLength(2)

    await expect(fixture.reader.readPersistedRuntimeEvidence()).resolves.toEqual(current)
    expect(fixture.probes).toHaveLength(2)
  })

  it('accepts the normalized Bridge secret when its pinned SHA-256 digest matches', async () => {
    const fixture = await createFixture(observedAtUnixMs + 10_000)
    await writeFile(fixture.secretFile, `${secret}\r\n`, 'utf8')
    const reader = new WindowsUpdateRuntimeEvidenceReader({
      controlRoot: fixture.controlRoot,
      secretFile: fixture.secretFile,
      expectedSecretSha256: createHash('sha256').update(secret, 'utf8').digest('hex'),
      bridgeClient: fixture.bridgeClient,
      now: () => observedAtUnixMs + 10_000
    })

    await expect(reader.readCurrentRuntimeEvidence()).resolves.toMatchObject({ processId })
  })

  it('rejects a valid replacement secret even when the runtime records are re-signed', async () => {
    const fixture = await createFixture(observedAtUnixMs + 10_000)
    const replacementSecret = 'fictional-replacement-secret-9876543210'
    const replacementSession = buildBridgeRuntimeSession({
      sessionId,
      pluginVersion: '0.1.0',
      processId,
      processStartedAtUnixMs,
      bridgeStartedAtUnixMs,
      issuedAtUnixMs: bridgeStartedAtUnixMs
    }, replacementSecret)
    const replacementEvidence = buildWindowsUpdateRuntimeEvidence(evidenceInput(), replacementSecret)
    await Promise.all([
      writeFile(fixture.secretFile, replacementSecret, 'utf8'),
      writeFile(
        path.join(fixture.controlRoot, WINDOWS_UPDATE_RUNTIME_SESSION_FILE),
        replacementSession.payload,
        'utf8'
      ),
      writeFile(
        path.join(fixture.controlRoot, WINDOWS_UPDATE_RUNTIME_EVIDENCE_FILE),
        replacementEvidence.payload,
        'utf8'
      )
    ])
    const reader = new WindowsUpdateRuntimeEvidenceReader({
      controlRoot: fixture.controlRoot,
      secretFile: fixture.secretFile,
      expectedSecretSha256: createHash('sha256').update(secret, 'utf8').digest('hex'),
      bridgeClient: fixture.bridgeClient,
      now: () => observedAtUnixMs + 10_000
    })

    await expect(reader.readPersistedRuntimeEvidence()).rejects.toMatchObject({
      name: 'WindowsUpdateRuntimeEvidenceError',
      message: 'WINDOWS_UPDATE_EVIDENCE_SECRET_INVALID',
      code: 'WINDOWS_UPDATE_EVIDENCE_SECRET_INVALID'
    })
  })

  it('fails closed on tampering, a different signed session, and a changed heartbeat generation', async () => {
    const tampered = await createFixture(observedAtUnixMs + 10_000)
    await writeFile(
      path.join(tampered.controlRoot, WINDOWS_UPDATE_RUNTIME_EVIDENCE_FILE),
      crossRuntimePayload.replace(`dsvSha256=${dsvSha256}`, `dsvSha256=${'c'.repeat(64)}`),
      'utf8'
    )
    await expect(tampered.reader.readCurrentRuntimeEvidence()).rejects.toMatchObject({
      code: 'WINDOWS_UPDATE_EVIDENCE_HMAC_INVALID'
    })

    const wrongSession = await createFixture(observedAtUnixMs + 10_000)
    const otherSession = buildBridgeRuntimeSession({
      sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      pluginVersion: '0.1.0',
      processId,
      processStartedAtUnixMs,
      bridgeStartedAtUnixMs,
      issuedAtUnixMs: bridgeStartedAtUnixMs
    }, secret)
    await writeFile(
      path.join(wrongSession.controlRoot, WINDOWS_UPDATE_RUNTIME_SESSION_FILE),
      otherSession.payload,
      'utf8'
    )
    await expect(wrongSession.reader.readCurrentRuntimeEvidence()).rejects.toMatchObject({
      code: 'WINDOWS_UPDATE_RUNTIME_GENERATION_MISMATCH'
    })

    const changedHeartbeat = await createFixture(observedAtUnixMs + 10_000, (index, heartbeat) =>
      index === 0 ? heartbeat : { ...heartbeat, processId: heartbeat.processId + 1 })
    await expect(changedHeartbeat.reader.readCurrentRuntimeEvidence()).rejects.toMatchObject({
      code: 'WINDOWS_UPDATE_RUNTIME_GENERATION_MISMATCH'
    })
  })

  it('rejects future evidence and reparse-point control roots', async () => {
    const future = await createFixture(observedAtUnixMs + 10_000)
    const futureEvidence = buildWindowsUpdateRuntimeEvidence({
      ...evidenceInput(),
      observedAtUnixMs: observedAtUnixMs + 20_000,
      writtenAtUnixMs: observedAtUnixMs + 20_000
    }, secret)
    await writeFile(
      path.join(future.controlRoot, WINDOWS_UPDATE_RUNTIME_EVIDENCE_FILE),
      futureEvidence.payload,
      'utf8'
    )
    await expect(future.reader.readPersistedRuntimeEvidence()).rejects.toMatchObject({
      code: 'WINDOWS_UPDATE_RUNTIME_EVIDENCE_FUTURE'
    })

    const fixture = await createFixture(observedAtUnixMs + 10_000)
    const linkRoot = path.join(path.dirname(fixture.root), `${path.basename(fixture.root)}-junction`)
    temporaryRoots.push(linkRoot)
    await symlink(fixture.controlRoot, linkRoot, process.platform === 'win32' ? 'junction' : 'dir')
    const reader = new WindowsUpdateRuntimeEvidenceReader({
      controlRoot: linkRoot,
      secretFile: fixture.secretFile,
      bridgeClient: fixture.bridgeClient,
      now: () => observedAtUnixMs + 10_000
    })
    await expect(reader.readCurrentRuntimeEvidence()).rejects.toMatchObject({
      code: 'WINDOWS_UPDATE_EVIDENCE_ROOT_INVALID'
    })
  })

  it('rejects non-canonical fields and constructor-time unsafe roots', () => {
    expect(() => parseWindowsUpdateRuntimeEvidence(
      crossRuntimePayload.replace('protocol=', 'extra=x\nprotocol='),
      secret
    )).toThrow('WINDOWS_UPDATE_EVIDENCE_PAYLOAD_INVALID')
    expect(() => new WindowsUpdateRuntimeEvidenceReader({
      controlRoot: path.parse(process.cwd()).root,
      secretFile: path.join(process.cwd(), 'secret'),
      bridgeClient: { async probe() { throw new Error('unused') } }
    })).toThrow('WINDOWS_UPDATE_EVIDENCE_OPTIONS_INVALID')
    for (const expectedSecretSha256 of ['a'.repeat(63), 'A'.repeat(64), `${'a'.repeat(64)} `]) {
      expect(() => new WindowsUpdateRuntimeEvidenceReader({
        controlRoot: path.join(process.cwd(), 'control'),
        secretFile: path.join(process.cwd(), 'secret'),
        expectedSecretSha256,
        bridgeClient: { async probe() { throw new Error('unused') } }
      })).toThrow('WINDOWS_UPDATE_EVIDENCE_OPTIONS_INVALID')
    }
  })
})

function evidenceInput() {
  return {
    sessionId,
    pluginVersion: '0.1.0',
    processId,
    processStartedAtUnixMs,
    bridgeStartedAtUnixMs,
    observationGeneration: 3,
    observedAtUnixMs,
    writtenAtUnixMs: observedAtUnixMs,
    dsvBytes: 5_242_880,
    dsvWriteTimeUtcTicks: '638817408010000001',
    dsvSha256,
    serverBytes: 22_016,
    serverWriteTimeUtcTicks: '638817408010000777',
    serverSha256
  }
}

async function createFixture(
  now: number,
  alterHeartbeat: (index: number, heartbeat: BridgeHeartbeat) => BridgeHeartbeat = (_index, value) => value
) {
  const root = await mkdtemp(path.join(tmpdir(), 'dyson-update-evidence-'))
  temporaryRoots.push(root)
  const controlRoot = path.join(root, 'control')
  const secretFile = path.join(root, 'secret')
  await mkdir(controlRoot)
  await writeFile(secretFile, secret, 'utf8')
  const session = buildBridgeRuntimeSession({
    sessionId,
    pluginVersion: '0.1.0',
    processId,
    processStartedAtUnixMs,
    bridgeStartedAtUnixMs,
    issuedAtUnixMs: bridgeStartedAtUnixMs
  }, secret)
  const evidence = buildWindowsUpdateRuntimeEvidence(evidenceInput(), secret)
  await Promise.all([
    writeFile(path.join(controlRoot, WINDOWS_UPDATE_RUNTIME_SESSION_FILE), session.payload, 'utf8'),
    writeFile(path.join(controlRoot, WINDOWS_UPDATE_RUNTIME_EVIDENCE_FILE), evidence.payload, 'utf8')
  ])
  const heartbeat = buildBridgeHeartbeat({
    pluginVersion: '0.1.0',
    processId,
    startedAtUnixMs: bridgeStartedAtUnixMs,
    writtenAtUnixMs: now
  }, secret).heartbeat
  const probes: number[] = []
  const bridgeClient = {
    async probe(): Promise<BridgeHeartbeat> {
      const index = probes.length
      probes.push(index)
      return alterHeartbeat(index, heartbeat)
    }
  }
  return {
    root,
    controlRoot,
    secretFile,
    bridgeClient,
    probes,
    reader: new WindowsUpdateRuntimeEvidenceReader({
      controlRoot,
      secretFile,
      bridgeClient,
      now: () => now
    })
  }
}

function pairIdentity(
  dsvBytes: number,
  dsvHash: string,
  serverBytes: number,
  serverHash: string
): string {
  return createHash('sha256')
    .update('dyson-save-pair-revision-v1\0_lastexit_\0dsv\0', 'utf8')
    .update(String(dsvBytes), 'utf8')
    .update('\0', 'utf8')
    .update(dsvHash, 'ascii')
    .update('\0server\0', 'utf8')
    .update(String(serverBytes), 'utf8')
    .update('\0', 'utf8')
    .update(serverHash, 'ascii')
    .digest('hex')
}

import { describe, expect, it } from 'vitest'
import {
  buildBridgeHeartbeat,
  buildBridgeRequest,
  buildBridgeReceipt,
  buildBridgeRuntimeSession,
  buildBridgeSimulationTelemetry,
  computeBridgeSaveGenerationId,
  actualSimulationRates,
  parseBridgeHeartbeat,
  parseBridgeReceipt,
  parseBridgeRequest,
  parseBridgeRuntimeSession,
  parseBridgeSimulationTelemetry,
  type BridgeReceiptV2Input
} from './protocol.js'

const secret = 'fictional-cross-runtime-secret-0123456789'
const requestPayload = [
  'protocol=DYSON_CONTROL_REQUEST_V1',
  'requestId=11111111-2222-4333-8444-555555555555',
  'createdAtUnixMs=1788081000000',
  'expiresAtUnixMs=1788081015000',
  'action=save',
  'nonce=ABCDEFGHIJKLMNOPQRSTUV',
  'hmac=b1259d0dfd035395c0e797d91d1e76fda3531c264c391d4bdc0fb3aa3d43d54a',
  ''
].join('\n')
const canonicalReceiptInput = {
  requestId: '11111111-2222-4333-8444-555555555555',
  action: 'save',
  state: 'succeeded',
  startedAtUnixMs: 1788081001000,
  finishedAtUnixMs: 1788081003500,
  saveName: '_lastexit_',
  saveTimeBefore: 1788080000n,
  saveTimeAfter: 1788081003n,
  dsvBytes: 5_242_880,
  dsvWriteTimeUtcTicks: 638817408010000001n,
  serverBytes: 22_016,
  serverWriteTimeUtcTicks: 638817408010000777n,
  dsvChanged: true,
  serverChanged: true,
  errorCode: 'NONE'
} satisfies BridgeReceiptV2Input
const receiptPayload = [
  'protocol=DYSON_CONTROL_RECEIPT_V2',
  'requestId=11111111-2222-4333-8444-555555555555',
  'action=save',
  'state=succeeded',
  'startedAtUnixMs=1788081001000',
  'finishedAtUnixMs=1788081003500',
  'saveName=_lastexit_',
  'saveTimeBefore=1788080000',
  'saveTimeAfter=1788081003',
  'dsvBytes=5242880',
  'dsvWriteTimeUtcTicks=638817408010000001',
  'serverBytes=22016',
  'serverWriteTimeUtcTicks=638817408010000777',
  'dsvChanged=true',
  'serverChanged=true',
  'errorCode=NONE',
  'hmac=614136ceb2a204b2b9e25b969b33bf931e89f7d792e06f15bbcf9208f6be8da4',
  ''
].join('\n')
const generationId = 'generation-v1:25776f27535c4eb66e45c074cfaa700ed15bce62281f65220483a5659f8d5e8d'
const oneFileMissingPayload = [
  'protocol=DYSON_CONTROL_RECEIPT_V2',
  'requestId=22222222-3333-4444-8555-666666666666',
  'action=save',
  'state=failed',
  'startedAtUnixMs=1788081004000',
  'finishedAtUnixMs=1788081005000',
  'saveName=_lastexit_',
  'saveTimeBefore=1788081003',
  'saveTimeAfter=1788081004',
  'dsvBytes=-1',
  'dsvWriteTimeUtcTicks=-1',
  'serverBytes=22032',
  'serverWriteTimeUtcTicks=638817408020000777',
  'dsvChanged=true',
  'serverChanged=true',
  'errorCode=SAVE_PAIR_MISSING',
  'hmac=3eeda6e09a8b4fa36e480ce4b246bf8f17875e979934acb3ce205ecee4daa5ac',
  ''
].join('\n')
const bothFilesMissingPayload = [
  'protocol=DYSON_CONTROL_RECEIPT_V2',
  'requestId=33333333-4444-4555-8666-777777777777',
  'action=save',
  'state=failed',
  'startedAtUnixMs=1788081006000',
  'finishedAtUnixMs=1788081007000',
  'saveName=_lastexit_',
  'saveTimeBefore=1788081003',
  'saveTimeAfter=1788081004',
  'dsvBytes=-1',
  'dsvWriteTimeUtcTicks=-1',
  'serverBytes=-1',
  'serverWriteTimeUtcTicks=-1',
  'dsvChanged=true',
  'serverChanged=true',
  'errorCode=SAVE_PAIR_MISSING',
  'hmac=64413d6d559dc5b987d775ca988802eff61c8526443f4842cd62c8f8720464cb',
  ''
].join('\n')
const heartbeatPayload = [
  'protocol=DYSON_CONTROL_HEARTBEAT_V1',
  'pluginVersion=0.1.0',
  'processId=4242',
  'startedAtUnixMs=1788080000000',
  'writtenAtUnixMs=1788081004000',
  'state=ready',
  'hmac=272dea72a7446db521b006f22718777f0cb4443a05022a76d4fffe2c1a06f6f2',
  ''
].join('\n')
const runtimeSessionPayload = [
  'protocol=DYSON_CONTROL_RUNTIME_SESSION_V1',
  'sessionId=bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
  'pluginVersion=0.1.0',
  'processId=4242',
  'processStartedAtUnixMs=1788080000000',
  'bridgeStartedAtUnixMs=1788081000000',
  'issuedAtUnixMs=1788081000000',
  'hmac=95fd6dfd32fca0deed984c68cdcd475d65a842004f596c5e5874a938c75e4b28',
  ''
].join('\n')
const simulationTelemetryPayload = [
  'protocol=DYSON_CONTROL_SIMULATION_TELEMETRY_V1',
  'sessionId=bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
  'processId=4242',
  'processStartedAtUnixMs=1788080000000',
  'bridgeStartedAtUnixMs=1788081000000',
  'sequence=7',
  'sampleStartedAtUnixMs=1788081001000',
  'sampleFinishedAtUnixMs=1788081003000',
  'writtenAtUnixMs=1788081003000',
  'windowDurationMs=2000',
  'tickStarted=1000',
  'tickFinished=1120',
  'upsMilli=59875',
  'tpsMilli=60000',
  'upsSource=fpscontroller-stopwatch',
  'tpsSource=gamemain-tick-wallclock',
  'hmac=1142702c6adc9c87e93de149922017b4d26465e7923a5aab109035f104d75a95',
  ''
].join('\n')

describe('bridge request V1 and receipt V2 cross-runtime vectors', () => {
  it('parses the canonical C# and TypeScript request vector', () => {
    expect(parseBridgeRequest(requestPayload, secret)).toMatchObject({
      requestId: canonicalReceiptInput.requestId,
      action: 'save',
      createdAtUnixMs: 1788081000000,
      expiresAtUnixMs: 1788081015000
    })
  })

  it('shares an exact V2 receipt vector and preserves ticks above 2^53', () => {
    const built = buildBridgeReceipt(canonicalReceiptInput, secret)
    expect(built.payload).toBe(receiptPayload)
    const parsed = parseBridgeReceipt(receiptPayload, secret)
    expect(parsed).toMatchObject({ saveName: '_lastexit_', dsvChanged: true, serverChanged: true })
    expect(parsed.dsvWriteTimeUtcTicks).toBe(638817408010000001n)
    expect(parsed.serverWriteTimeUtcTicks).toBe(638817408010000777n)
    expect(parsed.dsvWriteTimeUtcTicks).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER))
  })

  it('computes a cross-runtime generation identity that excludes requestId', () => {
    const first = buildBridgeReceipt(canonicalReceiptInput, secret).receipt
    const second = buildBridgeReceipt({
      ...canonicalReceiptInput,
      requestId: '99999999-8888-4777-8666-555555555555'
    }, secret).receipt
    expect(computeBridgeSaveGenerationId(first)).toBe(generationId)
    expect(computeBridgeSaveGenerationId(second)).toBe(generationId)
  })

  it('distinguishes equal-sized save generations by LastSaveTime and paired write identities', () => {
    const first = buildBridgeReceipt(canonicalReceiptInput, secret).receipt
    const laterSaveTime = buildBridgeReceipt({
      ...canonicalReceiptInput,
      saveTimeAfter: BigInt(canonicalReceiptInput.saveTimeAfter) + 1n
    }, secret).receipt
    const laterServerWrite = buildBridgeReceipt({
      ...canonicalReceiptInput,
      serverWriteTimeUtcTicks: BigInt(canonicalReceiptInput.serverWriteTimeUtcTicks) + 1n
    }, secret).receipt

    expect(computeBridgeSaveGenerationId(laterSaveTime)).not.toBe(computeBridgeSaveGenerationId(first))
    expect(computeBridgeSaveGenerationId(laterServerWrite)).not.toBe(computeBridgeSaveGenerationId(first))
  })

  it('requires LastSaveTime and both pinned-Nebula file identities to advance', () => {
    expect(() => buildBridgeReceipt({
      ...canonicalReceiptInput,
      saveTimeAfter: canonicalReceiptInput.saveTimeBefore
    }, secret)).toThrow('BRIDGE_RECEIPT_INCONSISTENT')
    expect(() => buildBridgeReceipt({
      ...canonicalReceiptInput,
      dsvChanged: false
    }, secret)).toThrow('BRIDGE_RECEIPT_INCONSISTENT')
    expect(() => buildBridgeReceipt({
      ...canonicalReceiptInput,
      serverChanged: false
    }, secret)).toThrow('BRIDGE_RECEIPT_INCONSISTENT')
  })

  it('binds V2 success to exact _lastexit_ and reserves _unavailable_ for failures', () => {
    expect(() => buildBridgeReceipt({ ...canonicalReceiptInput, saveName: '_autosave_' }, secret))
      .toThrow('BRIDGE_RECEIPT_INCONSISTENT')
    expect(() => buildBridgeReceipt({ ...canonicalReceiptInput, saveName: '_unavailable_' }, secret))
      .toThrow('BRIDGE_RECEIPT_INCONSISTENT')
    expect(() => buildBridgeReceipt({
      ...canonicalReceiptInput,
      state: 'failed',
      saveName: '_autosave_',
      errorCode: 'SAVE_CALL_FAILED'
    }, secret)).toThrow('BRIDGE_RECEIPT_INCONSISTENT')

    const unavailable = buildBridgeReceipt({
      ...canonicalReceiptInput,
      state: 'failed',
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
    expect(parseBridgeReceipt(unavailable.payload, secret)).toMatchObject({
      state: 'failed', saveName: '_unavailable_', errorCode: 'GAME_NOT_READY'
    })
  })

  it('round-trips failed receipts when one or both post-save files disappeared', () => {
    const oneMissing = buildBridgeReceipt({
      requestId: '22222222-3333-4444-8555-666666666666', action: 'save', state: 'failed',
      startedAtUnixMs: 1788081004000, finishedAtUnixMs: 1788081005000,
      saveName: '_lastexit_', saveTimeBefore: 1788081003n, saveTimeAfter: 1788081004n,
      dsvBytes: -1, dsvWriteTimeUtcTicks: -1n,
      serverBytes: 22_032, serverWriteTimeUtcTicks: 638817408020000777n,
      dsvChanged: true, serverChanged: true, errorCode: 'SAVE_PAIR_MISSING'
    }, secret)
    const bothMissing = buildBridgeReceipt({
      requestId: '33333333-4444-4555-8666-777777777777', action: 'save', state: 'failed',
      startedAtUnixMs: 1788081006000, finishedAtUnixMs: 1788081007000,
      saveName: '_lastexit_', saveTimeBefore: 1788081003n, saveTimeAfter: 1788081004n,
      dsvBytes: -1, dsvWriteTimeUtcTicks: -1n,
      serverBytes: -1, serverWriteTimeUtcTicks: -1n,
      dsvChanged: true, serverChanged: true, errorCode: 'SAVE_PAIR_MISSING'
    }, secret)
    expect(oneMissing.payload).toBe(oneFileMissingPayload)
    expect(bothMissing.payload).toBe(bothFilesMissingPayload)
    expect(parseBridgeReceipt(oneFileMissingPayload, secret)).toMatchObject({
      state: 'failed', dsvBytes: -1, dsvChanged: true, serverChanged: true
    })
    expect(parseBridgeReceipt(bothFilesMissingPayload, secret)).toMatchObject({
      state: 'failed', dsvBytes: -1, serverBytes: -1, dsvChanged: true, serverChanged: true
    })
  })

  it.each(['01', '+1', '-0', '1.0', '9223372036854775808'])(
    'rejects a non-canonical or out-of-range tick value %s',
    (invalid) => {
      expect(() => parseBridgeReceipt(
        receiptPayload.replace('dsvWriteTimeUtcTicks=638817408010000001', `dsvWriteTimeUtcTicks=${invalid}`),
        secret
      )).toThrow('BRIDGE_INT64_INVALID')
    }
  )

  it('rejects missing fields, duplicate keys, legacy V1, and non-canonical Unix times', () => {
    const missing = receiptPayload.split('\n')
      .filter((line) => !line.startsWith('serverWriteTimeUtcTicks='))
      .join('\n')
    const duplicate = receiptPayload.replace('serverBytes=22016', 'dsvBytes=22016')
    const legacyV1 = receiptPayload.replace('DYSON_CONTROL_RECEIPT_V2', 'DYSON_CONTROL_RECEIPT_V1')
    const nonCanonicalTime = receiptPayload.replace('startedAtUnixMs=1788081001000', 'startedAtUnixMs=01788081001000')
    expect(() => parseBridgeReceipt(missing, secret)).toThrow('BRIDGE_PAYLOAD_INVALID')
    expect(() => parseBridgeReceipt(duplicate, secret)).toThrow('BRIDGE_PAYLOAD_INVALID')
    expect(() => parseBridgeReceipt(legacyV1, secret)).toThrow('BRIDGE_LITERAL_INVALID')
    expect(() => parseBridgeReceipt(nonCanonicalTime, secret)).toThrow('BRIDGE_NUMBER_INVALID')
  })

  it('uses canonical RFC GUIDs and rejects every wire BOM', () => {
    expect(buildBridgeRequest('11111111-2222-8333-8444-555555555555', secret).request.requestId)
      .toBe('11111111-2222-8333-8444-555555555555')
    expect(() => buildBridgeRequest('11111111-2222-0333-8444-555555555555', secret))
      .toThrow('BRIDGE_REQUEST_ID_INVALID')
    expect(() => buildBridgeRequest('11111111-2222-4333-7444-555555555555', secret))
      .toThrow('BRIDGE_REQUEST_ID_INVALID')
    expect(() => parseBridgeRequest(
      requestPayload.replace('createdAtUnixMs=1788081000000', 'createdAtUnixMs=01788081000000'),
      secret
    )).toThrow('BRIDGE_NUMBER_INVALID')
    expect(() => parseBridgeRequest(`\uFEFF${requestPayload}`, secret)).toThrow('BRIDGE_PAYLOAD_INVALID')
    expect(() => parseBridgeReceipt(`\uFEFF${receiptPayload}`, secret)).toThrow('BRIDGE_PAYLOAD_INVALID')
    expect(() => parseBridgeHeartbeat(`\uFEFF${heartbeatPayload}`, secret)).toThrow('BRIDGE_PAYLOAD_INVALID')
    expect(() => parseBridgeRequest(requestPayload.replace('action=save', 'action=sa\uFEFFve'), secret))
      .toThrow('BRIDGE_PAYLOAD_INVALID')
  })

  it('rejects HMAC and signed generation-field tampering', () => {
    const changedHmac = receiptPayload.replace(/hmac=([0-9a-f])/, (_match, first: string) =>
      `hmac=${first === '0' ? '1' : '0'}`)
    const changedName = receiptPayload.replace('saveName=_lastexit_', 'saveName=_autosave_')
    const changedTick = receiptPayload.replace(
      'serverWriteTimeUtcTicks=638817408010000777',
      'serverWriteTimeUtcTicks=638817408010000778'
    )
    expect(() => parseBridgeReceipt(changedHmac, secret)).toThrow('BRIDGE_SIGNATURE_INVALID')
    expect(() => parseBridgeReceipt(changedName, secret)).toThrow('BRIDGE_RECEIPT_INCONSISTENT')
    expect(() => parseBridgeReceipt(changedTick, secret)).toThrow('BRIDGE_SIGNATURE_INVALID')
  })

  it('rejects a one-byte request-signature change', () => {
    expect(() => parseBridgeRequest(requestPayload.replace('hmac=b', 'hmac=0'), secret))
      .toThrow('BRIDGE_SIGNATURE_INVALID')
  })

  it('shares a signed live-heartbeat vector across C# and TypeScript', () => {
    expect(buildBridgeHeartbeat({
      pluginVersion: '0.1.0',
      processId: 4242,
      startedAtUnixMs: 1788080000000,
      writtenAtUnixMs: 1788081004000
    }, secret).payload).toBe(heartbeatPayload)
    expect(parseBridgeHeartbeat(heartbeatPayload, secret)).toMatchObject({
      pluginVersion: '0.1.0', processId: 4242, state: 'ready'
    })
  })

  it('shares signed runtime-session and actual telemetry vectors across C# and TypeScript', () => {
    const session = buildBridgeRuntimeSession({
      sessionId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
      pluginVersion: '0.1.0', processId: 4242,
      processStartedAtUnixMs: 1788080000000,
      bridgeStartedAtUnixMs: 1788081000000,
      issuedAtUnixMs: 1788081000000
    }, secret)
    expect(session.payload).toBe(runtimeSessionPayload)
    expect(parseBridgeRuntimeSession(runtimeSessionPayload, secret)).toMatchObject({
      sessionId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', processId: 4242
    })

    const telemetry = buildBridgeSimulationTelemetry({
      sessionId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', processId: 4242,
      processStartedAtUnixMs: 1788080000000, bridgeStartedAtUnixMs: 1788081000000,
      sequence: 7, sampleStartedAtUnixMs: 1788081001000,
      sampleFinishedAtUnixMs: 1788081003000, writtenAtUnixMs: 1788081003000,
      windowDurationMs: 2000, tickStarted: 1000, tickFinished: 1120,
      upsMilli: 59875, tpsMilli: 60000
    }, secret)
    expect(telemetry.payload).toBe(simulationTelemetryPayload)
    const parsed = parseBridgeSimulationTelemetry(simulationTelemetryPayload, secret)
    expect(actualSimulationRates(parsed)).toEqual({ ups: 59.875, tps: 60 })
  })

  it('rejects telemetry tampering, wrong measurement sources, and tick/wall inconsistencies', () => {
    expect(() => parseBridgeRuntimeSession(
      runtimeSessionPayload.replace('processId=4242', 'processId=4243'), secret
    )).toThrow('BRIDGE_SIGNATURE_INVALID')
    expect(() => parseBridgeSimulationTelemetry(
      simulationTelemetryPayload.replace('upsMilli=59875', 'upsMilli=59876'), secret
    )).toThrow('BRIDGE_SIGNATURE_INVALID')
    expect(() => parseBridgeSimulationTelemetry(
      simulationTelemetryPayload.replace('upsSource=fpscontroller-stopwatch', 'upsSource=config-target'), secret
    )).toThrow('BRIDGE_LITERAL_INVALID')
    expect(() => buildBridgeSimulationTelemetry({
      sessionId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', processId: 4242,
      processStartedAtUnixMs: 1788080000000, bridgeStartedAtUnixMs: 1788081000000,
      sequence: 7, sampleStartedAtUnixMs: 1788081001000,
      sampleFinishedAtUnixMs: 1788081003000, writtenAtUnixMs: 1788081003000,
      windowDurationMs: 2000, tickStarted: 1000, tickFinished: 1120,
      upsMilli: 60000, tpsMilli: 59990
    }, secret)).toThrow('BRIDGE_TELEMETRY_INCONSISTENT')
  })
})

import { describe, expect, it } from 'vitest'
import {
  buildBridgeHeartbeat,
  buildBridgeReceipt,
  parseBridgeHeartbeat,
  parseBridgeRequest
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
const receiptPayload = [
  'protocol=DYSON_CONTROL_RECEIPT_V1',
  'requestId=11111111-2222-4333-8444-555555555555',
  'action=save',
  'state=succeeded',
  'startedAtUnixMs=1788081001000',
  'finishedAtUnixMs=1788081003500',
  'saveTimeBefore=1788080000',
  'saveTimeAfter=1788081003',
  'dsvBytes=5242880',
  'serverBytes=22016',
  'errorCode=NONE',
  'hmac=ae20a2ab9be050ab4ebabf48dae7aaeee85d4ff6baf41c219e95d384a61bd0d3',
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

describe('bridge protocol V1 cross-runtime vectors', () => {
  it('parses the canonical C# and TypeScript request vector', () => {
    expect(parseBridgeRequest(requestPayload, secret)).toMatchObject({
      requestId: '11111111-2222-4333-8444-555555555555',
      action: 'save',
      createdAtUnixMs: 1788081000000,
      expiresAtUnixMs: 1788081015000
    })
  })

  it('serializes the canonical C# and TypeScript receipt vector', () => {
    expect(buildBridgeReceipt({
      requestId: '11111111-2222-4333-8444-555555555555',
      action: 'save',
      state: 'succeeded',
      startedAtUnixMs: 1788081001000,
      finishedAtUnixMs: 1788081003500,
      saveTimeBefore: 1788080000,
      saveTimeAfter: 1788081003,
      dsvBytes: 5242880,
      serverBytes: 22016,
      errorCode: 'NONE'
    }, secret).payload).toBe(receiptPayload)
  })

  it('rejects a one-byte request-signature change', () => {
    expect(() => parseBridgeRequest(requestPayload.replace('hmac=b', 'hmac=0'), secret)).toThrow('BRIDGE_SIGNATURE_INVALID')
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
})

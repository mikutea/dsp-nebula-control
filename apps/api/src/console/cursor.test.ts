import { describe, expect, it } from 'vitest'
import { StructuredLogCursorCodec } from './cursor.js'
import { ConsoleLogError } from './errors.js'

const secret = 'fictional-console-cursor-secret-with-32-bytes-minimum'
const fingerprint = 'a'.repeat(64)

describe('structured log cursor', () => {
  it('round-trips deterministic signed cursor state', () => {
    const codec = new StructuredLogCursorCodec(secret)
    const state = {
      version: 1 as const,
      fingerprint,
      offset: 4096,
      generation: 2,
      skipRemainder: true,
      anchor: 'b'.repeat(64)
    }
    const first = codec.encode(state)
    const second = codec.encode(state)
    expect(first).toBe(second)
    expect(codec.decode(first)).toEqual(state)
    expect(first).not.toContain(fingerprint)
  })

  it('rejects a tampered cursor and a cursor signed by another service secret', () => {
    const codec = new StructuredLogCursorCodec(secret)
    const cursor = codec.encode({
      version: 1, fingerprint, offset: 0, generation: 0, skipRemainder: false, anchor: null
    })
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`
    expect(() => codec.decode(tampered)).toThrowError(expect.objectContaining({
      code: 'CONSOLE_LOG_CURSOR_SIGNATURE_INVALID'
    }))
    const other = new StructuredLogCursorCodec('different-fictional-secret-that-is-also-long-enough')
    expect(() => other.decode(cursor)).toThrowError(expect.objectContaining({
      code: 'CONSOLE_LOG_CURSOR_SIGNATURE_INVALID'
    }))
  })

  it('rejects short secrets and structurally impossible states', () => {
    expect(() => new StructuredLogCursorCodec('too-short')).toThrowError(ConsoleLogError)
    const codec = new StructuredLogCursorCodec(secret)
    expect(() => codec.encode({
      version: 1, fingerprint, offset: 0, generation: 0,
      skipRemainder: false, anchor: 'c'.repeat(64)
    })).toThrowError(expect.objectContaining({ code: 'CONSOLE_LOG_CURSOR_INVALID' }))
  })
})

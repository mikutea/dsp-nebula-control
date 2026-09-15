import { createHmac, timingSafeEqual } from 'node:crypto'
import { CONSOLE_LOG_LIMITS } from './limits.js'
import { ConsoleLogError } from './errors.js'

export interface StructuredLogCursorState {
  version: 1
  fingerprint: string
  offset: number
  generation: number
  skipRemainder: boolean
  anchor: string | null
}

interface CursorPayload {
  v: 1
  f: string
  o: number
  g: number
  s: 0 | 1
  a: string | null
}

export class StructuredLogCursorCodec {
  readonly #secret: Buffer

  constructor(secret: string | Buffer) {
    const bytes = Buffer.isBuffer(secret) ? Buffer.from(secret) : Buffer.from(secret, 'utf8')
    if (bytes.length < 32 || bytes.length > 1024) {
      throw new ConsoleLogError('CONSOLE_LOG_CURSOR_SECRET_INVALID')
    }
    this.#secret = bytes
  }

  encode(state: StructuredLogCursorState): string {
    assertCursorState(state)
    const payload: CursorPayload = {
      v: 1,
      f: state.fingerprint,
      o: state.offset,
      g: state.generation,
      s: state.skipRemainder ? 1 : 0,
      a: state.anchor
    }
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    const signature = this.#sign(encoded)
    return `${encoded}.${signature}`
  }

  decode(cursor: string): StructuredLogCursorState {
    if (cursor.length < 3 || cursor.length > CONSOLE_LOG_LIMITS.maximumCursorCharacters) {
      throw new ConsoleLogError('CONSOLE_LOG_CURSOR_INVALID')
    }
    const parts = cursor.split('.')
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new ConsoleLogError('CONSOLE_LOG_CURSOR_INVALID')
    }
    const expected = Buffer.from(this.#sign(parts[0]), 'ascii')
    const supplied = Buffer.from(parts[1], 'ascii')
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      throw new ConsoleLogError('CONSOLE_LOG_CURSOR_SIGNATURE_INVALID')
    }

    let payload: unknown
    try {
      payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as unknown
    } catch {
      throw new ConsoleLogError('CONSOLE_LOG_CURSOR_INVALID')
    }
    if (!isCursorPayload(payload)) throw new ConsoleLogError('CONSOLE_LOG_CURSOR_INVALID')
    const state: StructuredLogCursorState = {
      version: 1,
      fingerprint: payload.f,
      offset: payload.o,
      generation: payload.g,
      skipRemainder: payload.s === 1,
      anchor: payload.a
    }
    assertCursorState(state)
    return state
  }

  #sign(encoded: string): string {
    return createHmac('sha256', this.#secret).update('dyson-console-cursor-v1\0').update(encoded).digest('base64url')
  }
}

function isCursorPayload(value: unknown): value is CursorPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.join(',') !== 'a,f,g,o,s,v') return false
  return record.v === 1
    && typeof record.f === 'string'
    && typeof record.o === 'number'
    && typeof record.g === 'number'
    && (record.s === 0 || record.s === 1)
    && (record.a === null || typeof record.a === 'string')
}

function assertCursorState(state: StructuredLogCursorState): void {
  if (state.version !== 1
    || !/^[a-f0-9]{64}$/.test(state.fingerprint)
    || !Number.isSafeInteger(state.offset) || state.offset < 0
    || !Number.isSafeInteger(state.generation) || state.generation < 0
    || (state.anchor !== null && !/^[a-f0-9]{64}$/.test(state.anchor))) {
    throw new ConsoleLogError('CONSOLE_LOG_CURSOR_INVALID')
  }
  if (state.offset === 0 && state.anchor !== null) {
    throw new ConsoleLogError('CONSOLE_LOG_CURSOR_INVALID')
  }
}

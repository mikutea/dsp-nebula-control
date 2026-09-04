import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue }

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/

export class ClientQualificationCryptographyError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'ClientQualificationCryptographyError'
    this.code = code
  }
}

/**
 * Serializes JSON with ordinal, case-sensitive object-key ordering. Arrays keep
 * their supplied order. The output is compact UTF-8 JSON without a BOM.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(toCanonicalValue(value))
}

export function sha256Bytes(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

export function sha256Canonical(value: unknown): string {
  return sha256Bytes(Buffer.from(canonicalJson(value), 'utf8'))
}

export function hmacSha256Canonical(value: unknown, key: Uint8Array): string {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
    throw new ClientQualificationCryptographyError('CLIENT_QUALIFICATION_HMAC_KEY_INVALID')
  }
  return `sha256:${createHmac('sha256', key).update(canonicalJson(value), 'utf8').digest('hex')}`
}

export function assertDigestEqual(actual: string, expected: string, code: string): void {
  if (!DIGEST_PATTERN.test(actual) || !DIGEST_PATTERN.test(expected)) {
    throw new ClientQualificationCryptographyError(code)
  }
  const actualBytes = Buffer.from(actual.slice('sha256:'.length), 'hex')
  const expectedBytes = Buffer.from(expected.slice('sha256:'.length), 'hex')
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new ClientQualificationCryptographyError(code)
  }
}

export function parseStrictJsonBytes(value: Uint8Array, code: string): unknown {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new ClientQualificationCryptographyError(code)
  }
  if (value.byteLength >= 3 && value[0] === 0xef && value[1] === 0xbb && value[2] === 0xbf) {
    throw new ClientQualificationCryptographyError(code)
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(value)
  } catch {
    throw new ClientQualificationCryptographyError(code)
  }
  if (text.charCodeAt(0) === 0xfeff || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
    throw new ClientQualificationCryptographyError(code)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ClientQualificationCryptographyError(code)
  }
}

export function parseStrictCanonicalJsonBytes(value: Uint8Array, code: string): unknown {
  const parsed = parseStrictJsonBytes(value, code)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(value)
  if (text !== canonicalJson(parsed)) {
    throw new ClientQualificationCryptographyError(code)
  }
  return parsed
}

export function bareSha256(value: string, code: string): string {
  if (!DIGEST_PATTERN.test(value)) throw new ClientQualificationCryptographyError(code)
  return value.slice('sha256:'.length)
}

function toCanonicalValue(value: unknown): CanonicalJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new ClientQualificationCryptographyError('CLIENT_QUALIFICATION_CANONICAL_JSON_INVALID')
    }
    return value
  }
  if (Array.isArray(value)) return value.map(toCanonicalValue)
  if (typeof value !== 'object') {
    throw new ClientQualificationCryptographyError('CLIENT_QUALIFICATION_CANONICAL_JSON_INVALID')
  }
  const source = value as Record<string, unknown>
  const result: Record<string, CanonicalJsonValue> = {}
  for (const key of Object.keys(source).sort(compareOrdinal)) {
    const entry = source[key]
    if (entry === undefined) {
      throw new ClientQualificationCryptographyError('CLIENT_QUALIFICATION_CANONICAL_JSON_INVALID')
    }
    result[key] = toCanonicalValue(entry)
  }
  return result
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

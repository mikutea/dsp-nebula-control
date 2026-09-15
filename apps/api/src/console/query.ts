import { ConsoleLogError } from './errors.js'
import { CONSOLE_LOG_LIMITS } from './limits.js'
import { redactStructuredLogSource, redactStructuredLogText } from './redaction.js'
import {
  STRUCTURED_LOG_LEVELS,
  type NormalizedStructuredLogFilters,
  type NormalizedStructuredLogReadRequest,
  type StructuredLogFilters,
  type StructuredLogLevel,
  type StructuredLogReadRequest,
  type StructuredLogStart
} from './types.js'

const readKeys = new Set(['cursor', 'start', 'maxBytes', 'limit', 'filters'])
const filterKeys = new Set(['levels', 'source', 'from', 'to', 'text'])
const levelSet = new Set<string>(STRUCTURED_LOG_LEVELS)

export interface QueryPolicy {
  maximumReadBytes: number
  maximumResults: number
}

export function normalizeStructuredLogReadRequest(
  input: unknown,
  policy: QueryPolicy
): NormalizedStructuredLogReadRequest {
  const record = asStrictRecord(input ?? {}, readKeys)
  const cursor = normalizeCursor(record.cursor)
  const start = normalizeStart(record.start)
  if (cursor !== null && record.start !== undefined) invalid()
  const maxBytes = normalizeInteger(
    record.maxBytes,
    CONSOLE_LOG_LIMITS.defaultReadBytes,
    CONSOLE_LOG_LIMITS.minimumReadBytes,
    policy.maximumReadBytes
  )
  const limit = normalizeInteger(record.limit, CONSOLE_LOG_LIMITS.defaultResults, 1, policy.maximumResults)
  return {
    cursor,
    start,
    maxBytes,
    limit,
    filters: normalizeStructuredLogFilters(record.filters)
  }
}

export function normalizeStructuredLogFilters(input: unknown): NormalizedStructuredLogFilters {
  const record = asStrictRecord(input ?? {}, filterKeys)
  let levels: ReadonlySet<StructuredLogLevel> | null = null
  if (record.levels !== undefined) {
    if (!Array.isArray(record.levels) || record.levels.length < 1 || record.levels.length > STRUCTURED_LOG_LEVELS.length) {
      invalid()
    }
    const parsed = record.levels.map((level) => {
      if (typeof level !== 'string' || !levelSet.has(level)) invalid()
      return level as StructuredLogLevel
    })
    if (new Set(parsed).size !== parsed.length) invalid()
    levels = new Set(parsed)
  }
  const rawSource = normalizeFilterText(record.source, CONSOLE_LOG_LIMITS.maximumSourceFilterCharacters)
  const rawText = normalizeFilterText(record.text, CONSOLE_LOG_LIMITS.maximumTextFilterCharacters)
  const source = rawSource === null ? null : redactStructuredLogSource(rawSource).toLocaleLowerCase('en-US')
  const text = rawText === null ? null : redactStructuredLogText(rawText).toLocaleLowerCase('en-US')
  const from = normalizeTimestamp(record.from)
  const to = normalizeTimestamp(record.to)
  if (from !== null && to !== null && from > to) invalid()
  return { levels, source, fromUnixMs: from, toUnixMs: to, text }
}

export function publicFilters(filters: NormalizedStructuredLogFilters): StructuredLogFilters {
  return {
    ...(filters.levels === null ? {} : { levels: [...filters.levels] }),
    ...(filters.source === null ? {} : { source: filters.source }),
    ...(filters.fromUnixMs === null ? {} : { from: new Date(filters.fromUnixMs).toISOString() }),
    ...(filters.toUnixMs === null ? {} : { to: new Date(filters.toUnixMs).toISOString() }),
    ...(filters.text === null ? {} : { text: filters.text })
  }
}

function asStrictRecord(input: unknown, allowed: ReadonlySet<string>): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) invalid()
  const record = input as Record<string, unknown>
  if (Object.keys(record).some((key) => !allowed.has(key))) invalid()
  return record
}

function normalizeCursor(input: unknown): string | null {
  if (input === undefined || input === null) return null
  if (typeof input !== 'string' || input.length < 3 || input.length > CONSOLE_LOG_LIMITS.maximumCursorCharacters) invalid()
  return input
}

function normalizeStart(input: unknown): StructuredLogStart {
  if (input === undefined) return 'tail'
  if (input !== 'tail' && input !== 'beginning') invalid()
  return input
}

function normalizeInteger(input: unknown, fallback: number, minimum: number, maximum: number): number {
  if (input === undefined) return Math.min(fallback, maximum)
  if (!Number.isInteger(input) || (input as number) < minimum || (input as number) > maximum) invalid()
  return input as number
}

function normalizeFilterText(input: unknown, maximum: number): string | null {
  if (input === undefined) return null
  if (typeof input !== 'string') invalid()
  const normalized = input.trim()
  if (normalized.length < 1 || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) invalid()
  return normalized.toLocaleLowerCase('en-US')
}

function normalizeTimestamp(input: unknown): number | null {
  if (input === undefined) return null
  if (typeof input !== 'string' || input.length < 20 || input.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(input)) invalid()
  const parsed = Date.parse(input)
  if (!Number.isFinite(parsed)) invalid()
  return parsed
}

function invalid(): never {
  throw new ConsoleLogError('CONSOLE_LOG_QUERY_INVALID')
}

export type { StructuredLogReadRequest }

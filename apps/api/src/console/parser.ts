import { createHash } from 'node:crypto'
import { redactStructuredLogSource, redactStructuredLogText } from './redaction.js'
import type {
  NormalizedStructuredLogFilters,
  StructuredLogEntry,
  StructuredLogLevel
} from './types.js'

const structuredLine = /^(?:(?:\[([^\]]+)\]|(\d{4}-\d{2}-\d{2}[T ][^\s]+))\s+)?\[\s*(Trace|Debug|Info|Message|Warning|Warn|Error|Fatal)\s*:\s*([^\]]{1,256})\]\s*(.*)$/i
const unknownTimestamp = /^(?:\[([^\]]+)\]|(\d{4}-\d{2}-\d{2}[T ][^\s]+))\s+(.*)$/

export interface ParsedStructuredLogLine {
  timestamp: string | null
  timestampUnixMs: number | null
  level: StructuredLogLevel
  source: string
  text: string
}

export function parseStructuredLogLine(input: string): ParsedStructuredLogLine | null {
  const clean = input.replace(/\u0000/g, '').trimEnd()
  if (clean.trim().length === 0) return null
  const match = structuredLine.exec(clean)
  if (match) {
    const parsedTime = parseAbsoluteTimestamp(match[1] ?? match[2] ?? null)
    return {
      ...parsedTime,
      level: normalizeLevel(match[3] ?? ''),
      source: redactStructuredLogSource(match[4] ?? 'runtime'),
      text: redactStructuredLogText(match[5] ?? '')
    }
  }
  const timestampMatch = unknownTimestamp.exec(clean)
  const parsedTime = parseAbsoluteTimestamp(timestampMatch?.[1] ?? timestampMatch?.[2] ?? null)
  return {
    ...parsedTime,
    level: 'unknown',
    source: 'runtime',
    text: redactStructuredLogText(timestampMatch?.[3] ?? clean)
  }
}

export function buildStructuredLogEntry(
  parsed: ParsedStructuredLogLine,
  fingerprint: string,
  generation: number,
  startOffset: number,
  endOffset: number,
  lineTruncated: boolean
): StructuredLogEntry {
  const id = createHash('sha256')
    .update('dyson-structured-log-entry-v1\0')
    .update(fingerprint)
    .update('\0')
    .update(String(generation))
    .update('\0')
    .update(String(startOffset))
    .update('\0')
    .update(String(endOffset))
    .digest('hex')
    .slice(0, 32)
  return { schemaVersion: 1, id, timestamp: parsed.timestamp, level: parsed.level,
    source: parsed.source, text: parsed.text, lineTruncated }
}

export function matchesStructuredLogFilters(
  parsed: ParsedStructuredLogLine,
  filters: NormalizedStructuredLogFilters
): boolean {
  if (filters.levels !== null && !filters.levels.has(parsed.level)) return false
  if (filters.source !== null && !parsed.source.toLocaleLowerCase('en-US').includes(filters.source)) return false
  if (filters.text !== null && !parsed.text.toLocaleLowerCase('en-US').includes(filters.text)) return false
  if (filters.fromUnixMs !== null || filters.toUnixMs !== null) {
    if (parsed.timestampUnixMs === null) return false
    if (filters.fromUnixMs !== null && parsed.timestampUnixMs < filters.fromUnixMs) return false
    if (filters.toUnixMs !== null && parsed.timestampUnixMs > filters.toUnixMs) return false
  }
  return true
}

function normalizeLevel(value: string): StructuredLogLevel {
  switch (value.trim().toLocaleLowerCase('en-US')) {
    case 'trace': return 'trace'
    case 'debug': return 'debug'
    case 'info': return 'info'
    case 'message': return 'message'
    case 'warning':
    case 'warn': return 'warning'
    case 'error': return 'error'
    case 'fatal': return 'fatal'
    default: return 'unknown'
  }
}

function parseAbsoluteTimestamp(value: string | null): { timestamp: string | null; timestampUnixMs: number | null } {
  if (value === null || !/^\d{4}-\d{2}-\d{2}(?:T|\s)/.test(value)) {
    return { timestamp: null, timestampUnixMs: null }
  }
  const candidate = value.includes('T') ? value : value.replace(' ', 'T')
  const parsed = Date.parse(candidate)
  if (!Number.isFinite(parsed)) return { timestamp: null, timestampUnixMs: null }
  return { timestamp: new Date(parsed).toISOString(), timestampUnixMs: parsed }
}

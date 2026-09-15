import { ConsoleLogError } from './errors.js'
import { CONSOLE_LOG_LIMITS } from './limits.js'
import { normalizeStructuredLogFilters, publicFilters } from './query.js'
import { redactStructuredLogSource, redactStructuredLogText } from './redaction.js'
import { StructuredLogReader } from './reader.js'
import type {
  StructuredLogDownload,
  StructuredLogDownloadPlan,
  StructuredLogDownloadRequest,
  StructuredLogEntry,
  StructuredLogFilters,
  StructuredLogStart
} from './types.js'

const downloadKeys = new Set(['format', 'start', 'filters', 'maxResults', 'maxOutputBytes', 'maxScanBytes'])

export function createStructuredLogDownloadPlan(
  input: StructuredLogDownloadRequest | unknown = {},
  now: Date = new Date()
): StructuredLogDownloadPlan {
  const record = strictRecord(input, downloadKeys)
  const format = normalizeFormat(record.format)
  const start = normalizeStart(record.start)
  const normalizedFilters = normalizeStructuredLogFilters(record.filters)
  const filters = redactPublicFilters(publicFilters(normalizedFilters))
  const maxResults = integer(record.maxResults, CONSOLE_LOG_LIMITS.defaultDownloadResults,
    1, CONSOLE_LOG_LIMITS.maximumDownloadResults)
  const maxOutputBytes = integer(record.maxOutputBytes, CONSOLE_LOG_LIMITS.defaultDownloadOutputBytes,
    1024, CONSOLE_LOG_LIMITS.maximumDownloadOutputBytes)
  const maxScanBytes = integer(record.maxScanBytes, CONSOLE_LOG_LIMITS.defaultDownloadScanBytes,
    CONSOLE_LOG_LIMITS.minimumReadBytes, CONSOLE_LOG_LIMITS.maximumDownloadScanBytes)
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  return {
    schemaVersion: 1,
    kind: 'bepinex-structured-log-download-plan',
    format,
    fileName: `dyson-console-${stamp}.${format === 'json' ? 'json' : 'ndjson'}`,
    contentType: format === 'json'
      ? 'application/json; charset=utf-8'
      : 'application/x-ndjson; charset=utf-8',
    start,
    filters,
    maxResults,
    maxOutputBytes,
    maxScanBytes,
    pageSize: Math.min(CONSOLE_LOG_LIMITS.absoluteMaximumResults, maxResults),
    redactionRequired: true,
    rawHostOutputIncluded: false
  }
}

export async function executeStructuredLogDownload(
  reader: StructuredLogReader,
  plan: StructuredLogDownloadPlan,
  signal?: AbortSignal
): Promise<StructuredLogDownload> {
  assertPlan(plan)
  const entries: StructuredLogEntry[] = []
  let cursor: string | null = null
  let scannedBytes = 0
  let truncated = false
  let lastCursor = ''

  for (let pageNumber = 0; pageNumber < CONSOLE_LOG_LIMITS.maximumDownloadPages; pageNumber++) {
    if (signal?.aborted) throw new ConsoleLogError('CONSOLE_LOG_READ_ABORTED')
    const remainingResults = plan.maxResults - entries.length
    const remainingScanBytes = plan.maxScanBytes - scannedBytes
    if (remainingResults <= 0 || remainingScanBytes < CONSOLE_LOG_LIMITS.minimumReadBytes) {
      truncated = true
      break
    }
    const maxBytes = Math.min(reader.limits.maximumReadBytes, remainingScanBytes)
    const page = await reader.read({
      ...(cursor === null ? { start: plan.start } : { cursor }),
      maxBytes,
      limit: Math.min(reader.limits.maximumResults, plan.pageSize, remainingResults),
      filters: plan.filters
    }, signal)
    scannedBytes += page.scannedBytes
    const previousCursor: string | null = cursor
    cursor = page.cursor

    for (const entry of page.entries) {
      if (!fitsOutput(plan, [...entries, entry])) {
        truncated = true
        break
      }
      entries.push(entry)
    }
    if (truncated) break
    if (!page.hasMore) break
    if (cursor === previousCursor || cursor === lastCursor) {
      truncated = true
      break
    }
    lastCursor = cursor
    if (pageNumber === CONSOLE_LOG_LIMITS.maximumDownloadPages - 1) truncated = true
  }

  if (cursor === null) {
    throw new ConsoleLogError('CONSOLE_LOG_DOWNLOAD_INVALID')
  }
  const body = serialize(plan, entries)
  const outputBytes = Buffer.byteLength(body, 'utf8')
  if (outputBytes > plan.maxOutputBytes) throw new ConsoleLogError('CONSOLE_LOG_DOWNLOAD_INVALID')
  return { plan, body, entries: entries.length, outputBytes, scannedBytes, truncated, finalCursor: cursor }
}

function serialize(plan: StructuredLogDownloadPlan, entries: StructuredLogEntry[]): string {
  if (plan.format === 'ndjson') return entries.map((entry) => JSON.stringify(entry)).join('\n')
  return JSON.stringify({ schemaVersion: 1, kind: 'bepinex-structured-log-download', entries })
}

function fitsOutput(plan: StructuredLogDownloadPlan, entries: StructuredLogEntry[]): boolean {
  return Buffer.byteLength(serialize(plan, entries), 'utf8') <= plan.maxOutputBytes
}

function redactPublicFilters(filters: StructuredLogFilters): StructuredLogFilters {
  return {
    ...filters,
    ...(filters.source === undefined ? {} : { source: redactStructuredLogSource(filters.source).toLocaleLowerCase('en-US') }),
    ...(filters.text === undefined ? {} : { text: redactStructuredLogText(filters.text).toLocaleLowerCase('en-US') })
  }
}

function strictRecord(input: unknown, allowed: ReadonlySet<string>): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) invalid()
  const record = input as Record<string, unknown>
  if (Object.keys(record).some((key) => !allowed.has(key))) invalid()
  return record
}

function normalizeFormat(input: unknown): 'ndjson' | 'json' {
  if (input === undefined) return 'ndjson'
  if (input !== 'ndjson' && input !== 'json') invalid()
  return input
}

function normalizeStart(input: unknown): StructuredLogStart {
  if (input === undefined) return 'beginning'
  if (input !== 'tail' && input !== 'beginning') invalid()
  return input
}

function integer(input: unknown, fallback: number, minimum: number, maximum: number): number {
  if (input === undefined) return fallback
  if (!Number.isSafeInteger(input) || (input as number) < minimum || (input as number) > maximum) invalid()
  return input as number
}

function assertPlan(plan: StructuredLogDownloadPlan): void {
  if (plan.schemaVersion !== 1 || plan.kind !== 'bepinex-structured-log-download-plan'
    || (plan.format !== 'json' && plan.format !== 'ndjson')
    || plan.redactionRequired !== true || plan.rawHostOutputIncluded !== false
    || !Number.isSafeInteger(plan.maxResults) || plan.maxResults < 1
    || plan.maxResults > CONSOLE_LOG_LIMITS.maximumDownloadResults
    || !Number.isSafeInteger(plan.maxOutputBytes) || plan.maxOutputBytes < 1024
    || plan.maxOutputBytes > CONSOLE_LOG_LIMITS.maximumDownloadOutputBytes
    || !Number.isSafeInteger(plan.maxScanBytes) || plan.maxScanBytes < CONSOLE_LOG_LIMITS.minimumReadBytes
    || plan.maxScanBytes > CONSOLE_LOG_LIMITS.maximumDownloadScanBytes) invalid()
}

function invalid(): never {
  throw new ConsoleLogError('CONSOLE_LOG_DOWNLOAD_INVALID')
}

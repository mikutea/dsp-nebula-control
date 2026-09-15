export const STRUCTURED_LOG_LEVELS = [
  'trace', 'debug', 'info', 'message', 'warning', 'error', 'fatal', 'unknown'
] as const

export type StructuredLogLevel = (typeof STRUCTURED_LOG_LEVELS)[number]
export type StructuredLogStart = 'tail' | 'beginning'
export type StructuredLogTransition = 'none' | 'initial-tail' | 'initial-beginning' | 'rotated' | 'truncated'

export interface StructuredLogFilters {
  levels?: StructuredLogLevel[]
  source?: string
  from?: string
  to?: string
  text?: string
}

export interface StructuredLogReadRequest {
  cursor?: string | null
  start?: StructuredLogStart
  maxBytes?: number
  limit?: number
  filters?: StructuredLogFilters
}

export interface NormalizedStructuredLogFilters {
  levels: ReadonlySet<StructuredLogLevel> | null
  source: string | null
  fromUnixMs: number | null
  toUnixMs: number | null
  text: string | null
}

export interface NormalizedStructuredLogReadRequest {
  cursor: string | null
  start: StructuredLogStart
  maxBytes: number
  limit: number
  filters: NormalizedStructuredLogFilters
}

export interface StructuredLogEntry {
  schemaVersion: 1
  id: string
  timestamp: string | null
  level: StructuredLogLevel
  source: string
  text: string
  lineTruncated: boolean
}

export interface StructuredLogPage {
  schemaVersion: 1
  kind: 'bepinex-structured-log-page'
  observedAt: string
  entries: StructuredLogEntry[]
  cursor: string
  generation: number
  transition: StructuredLogTransition
  hasMore: boolean
  partialLinePending: boolean
  scannedBytes: number
  filteredOut: number
  limits: {
    fileBytes: number
    lineBytes: number
    readBytes: number
    results: number
  }
  redactionVersion: 1
}

export interface StructuredLogDownloadRequest {
  format?: 'ndjson' | 'json'
  start?: StructuredLogStart
  filters?: StructuredLogFilters
  maxResults?: number
  maxOutputBytes?: number
  maxScanBytes?: number
}

export interface StructuredLogDownloadPlan {
  schemaVersion: 1
  kind: 'bepinex-structured-log-download-plan'
  format: 'ndjson' | 'json'
  fileName: string
  contentType: 'application/x-ndjson; charset=utf-8' | 'application/json; charset=utf-8'
  start: StructuredLogStart
  filters: StructuredLogFilters
  maxResults: number
  maxOutputBytes: number
  maxScanBytes: number
  pageSize: number
  redactionRequired: true
  rawHostOutputIncluded: false
}

export interface StructuredLogDownload {
  plan: StructuredLogDownloadPlan
  body: string
  entries: number
  outputBytes: number
  scannedBytes: number
  truncated: boolean
  finalCursor: string
}

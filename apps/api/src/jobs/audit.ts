import { Buffer } from 'node:buffer'
import { z } from 'zod'
import {
  jobKinds,
  jobStates,
  type JobKind,
  type JobRecord,
  type JobState
} from '../domain.js'
import {
  ControlDatabase,
  type JobPageCursor,
  type StoredJobPage
} from '../storage/database.js'

export const DEFAULT_JOB_PAGE_SIZE = 20
export const MAX_JOB_PAGE_SIZE = 100
export const MAX_JOB_AUDIT_EXPORT_RECORDS = 1_000
export const MAX_JOB_AUDIT_EXPORT_BYTES = 2 * 1024 * 1024
export const JOB_AUDIT_EXPORT_CONFIRMATION = 'EXPORT_JOB_AUDIT' as const

const cursorTextSchema = z.string().min(16).max(512).regex(/^[A-Za-z0-9_-]+$/)
const jobKindSchema = z.enum(jobKinds)
const jobStateSchema = z.enum(jobStates)
const exportFormatSchema = z.enum(['json', 'ndjson'])

export const jobListQuerySchema = z.strictObject({
  cursor: cursorTextSchema.optional(),
  pageSize: z.coerce.number().int().min(1).max(MAX_JOB_PAGE_SIZE).optional(),
  kind: jobKindSchema.optional(),
  state: jobStateSchema.optional()
})

export const jobAuditExportPreviewSchema = z.strictObject({
  cursor: cursorTextSchema.optional(),
  maximumRecords: z.number().int().min(1).max(MAX_JOB_AUDIT_EXPORT_RECORDS).optional(),
  kind: jobKindSchema.optional(),
  state: jobStateSchema.optional(),
  format: exportFormatSchema
})

export const jobAuditExportExecutionSchema = jobAuditExportPreviewSchema.extend({
  confirmation: z.literal(JOB_AUDIT_EXPORT_CONFIRMATION)
}).strict()

export interface JobPageInput {
  cursor?: string
  pageSize?: number
  kind?: JobKind
  state?: JobState
}

export interface JobPageResult {
  items: JobRecord[]
  nextCursor: string | null
}

export interface JobAuditExportInput {
  cursor?: string
  maximumRecords?: number
  kind?: JobKind
  state?: JobState
  format: 'json' | 'ndjson'
}

export interface JobAuditExportPreview {
  mode: 'dry-run'
  format: 'json' | 'ndjson'
  recordCount: number
  byteLength: number
  truncated: boolean
  nextCursor: string | null
  filters: { kind: JobKind | null; state: JobState | null }
  requiredConfirmation: typeof JOB_AUDIT_EXPORT_CONFIRMATION
}

export interface JobAuditExportArtifact extends Omit<JobAuditExportPreview, 'mode' | 'requiredConfirmation'> {
  protocol: 'DYSON_CONTROL_JOB_AUDIT_EXPORT_V1'
  schemaVersion: 1
  generatedAt: string
  fileName: 'dyson-job-audit.json' | 'dyson-job-audit.ndjson'
  contentType: 'application/json; charset=utf-8' | 'application/x-ndjson; charset=utf-8'
  bytes: Buffer
}

export type JobAuditErrorCode =
  | 'JOB_AUDIT_REQUEST_INVALID'
  | 'JOB_AUDIT_CURSOR_INVALID'
  | 'JOB_AUDIT_RECORD_INVALID'
  | 'JOB_AUDIT_EXPORT_TOO_LARGE'

export class JobAuditError extends Error {
  readonly code: JobAuditErrorCode

  constructor(code: JobAuditErrorCode) {
    super(code)
    this.name = 'JobAuditError'
    this.code = code
  }
}

export class JobAuditService {
  readonly #database: ControlDatabase
  readonly #clock: () => Date

  constructor(database: ControlDatabase, clock: () => Date = () => new Date()) {
    this.#database = database
    this.#clock = clock
  }

  list(input: JobPageInput = {}): JobPageResult {
    const parsed = jobListQuerySchema.safeParse(input)
    if (!parsed.success) throw new JobAuditError('JOB_AUDIT_REQUEST_INVALID')
    const page = this.#database.listJobPage({
      limit: parsed.data.pageSize ?? DEFAULT_JOB_PAGE_SIZE,
      cursor: parsed.data.cursor === undefined ? null : decodeCursor(parsed.data.cursor),
      kind: parsed.data.kind ?? null,
      state: parsed.data.state ?? null
    })
    return publicPage(page)
  }

  preview(input: JobAuditExportInput): JobAuditExportPreview {
    const artifact = this.#build(input)
    return {
      mode: 'dry-run',
      format: artifact.format,
      recordCount: artifact.recordCount,
      byteLength: artifact.byteLength,
      truncated: artifact.truncated,
      nextCursor: artifact.nextCursor,
      filters: artifact.filters,
      requiredConfirmation: JOB_AUDIT_EXPORT_CONFIRMATION
    }
  }

  export(input: JobAuditExportInput): JobAuditExportArtifact {
    return this.#build(input)
  }

  #build(input: JobAuditExportInput): JobAuditExportArtifact {
    const parsed = jobAuditExportPreviewSchema.safeParse(input)
    if (!parsed.success) throw new JobAuditError('JOB_AUDIT_REQUEST_INVALID')
    const limit = parsed.data.maximumRecords ?? MAX_JOB_AUDIT_EXPORT_RECORDS
    const page = this.#database.listJobPage({
      limit,
      cursor: parsed.data.cursor === undefined ? null : decodeCursor(parsed.data.cursor),
      kind: parsed.data.kind ?? null,
      state: parsed.data.state ?? null
    })
    const records = page.items.map(assertPublicJobRecord)
    const generatedAt = this.#clock().toISOString()
    const nextCursor = page.nextCursor === null ? null : encodeCursor(page.nextCursor)
    const filters = { kind: parsed.data.kind ?? null, state: parsed.data.state ?? null }
    const envelope = {
      protocol: 'DYSON_CONTROL_JOB_AUDIT_EXPORT_V1' as const,
      schemaVersion: 1 as const,
      generatedAt,
      recordCount: records.length,
      truncated: nextCursor !== null,
      nextCursor,
      filters,
      records
    }
    const text = parsed.data.format === 'json'
      ? `${JSON.stringify(envelope, null, 2)}\n`
      : [
          JSON.stringify({ ...envelope, records: undefined, type: 'metadata' }),
          ...records.map((record) => JSON.stringify({ type: 'job', data: record }))
        ].join('\n') + '\n'
    const bytes = Buffer.from(text, 'utf8')
    if (bytes.byteLength > MAX_JOB_AUDIT_EXPORT_BYTES) {
      throw new JobAuditError('JOB_AUDIT_EXPORT_TOO_LARGE')
    }
    return {
      protocol: envelope.protocol,
      schemaVersion: envelope.schemaVersion,
      generatedAt,
      format: parsed.data.format,
      recordCount: records.length,
      byteLength: bytes.byteLength,
      truncated: nextCursor !== null,
      nextCursor,
      filters,
      fileName: parsed.data.format === 'json' ? 'dyson-job-audit.json' : 'dyson-job-audit.ndjson',
      contentType: parsed.data.format === 'json'
        ? 'application/json; charset=utf-8'
        : 'application/x-ndjson; charset=utf-8',
      bytes
    }
  }
}

function publicPage(page: StoredJobPage): JobPageResult {
  return {
    items: page.items.map(assertPublicJobRecord),
    nextCursor: page.nextCursor === null ? null : encodeCursor(page.nextCursor)
  }
}

function encodeCursor(cursor: JobPageCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, createdAt: cursor.createdAt, id: cursor.id }), 'utf8')
    .toString('base64url')
}

function decodeCursor(value: string): JobPageCursor {
  try {
    if (!cursorTextSchema.safeParse(value).success) throw new Error('invalid cursor text')
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    const parsed = z.strictObject({
      v: z.literal(1),
      createdAt: z.string().datetime({ offset: true }).max(64),
      id: z.string().uuid()
    }).safeParse(decoded)
    if (!parsed.success) throw new Error('invalid cursor payload')
    const canonical = encodeCursor({ createdAt: parsed.data.createdAt, id: parsed.data.id })
    if (canonical !== value) throw new Error('non-canonical cursor')
    return { createdAt: parsed.data.createdAt, id: parsed.data.id }
  } catch {
    throw new JobAuditError('JOB_AUDIT_CURSOR_INVALID')
  }
}

function assertPublicJobRecord(record: JobRecord): JobRecord {
  const timestamp = z.string().datetime({ offset: true }).max(64).nullable()
  const parsed = z.strictObject({
    id: z.string().uuid(),
    kind: jobKindSchema,
    state: jobStateSchema,
    actor: z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9 ._-]*$/),
    createdAt: z.string().datetime({ offset: true }).max(64),
    startedAt: timestamp,
    finishedAt: timestamp,
    durationMs: z.number().int().min(0).max(31_536_000_000).nullable(),
    summary: z.string().min(1).max(256).regex(/^[^\r\n]*$/),
    errorCode: z.string().min(1).max(128).regex(/^[A-Z][A-Z0-9_]*$/).nullable()
  }).safeParse(record)
  if (!parsed.success) throw new JobAuditError('JOB_AUDIT_RECORD_INVALID')
  return parsed.data
}

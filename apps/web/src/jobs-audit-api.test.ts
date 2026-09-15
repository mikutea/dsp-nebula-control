import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, JOB_AUDIT_EXPORT_CONFIRMATION } from './api'
import type {
  JobAuditExportFormat, JobAuditExportInput, JobRecord
} from './model'

const cursor = 'eyJ2IjoxLCJwYWdlIjoyfQ'
const nextCursor = 'eyJ2IjoxLCJwYWdlIjozfQ'

afterEach(() => vi.unstubAllGlobals())

describe('bounded task and audit web client', () => {
  it('builds a bounded stable-cursor query and strictly validates the page envelope', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({
      data: [jobFixture()], page: { nextCursor }
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.jobPage({
      pageSize: 2, cursor, kind: 'status.refresh', state: 'succeeded'
    })).resolves.toEqual({ data: [jobFixture()], page: { nextCursor } })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/v1/jobs?pageSize=2&cursor=${cursor}&kind=status.refresh&state=succeeded`
    )
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store' })
  })

  it('rejects overbroad pages and invalid filters before exposing records', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({
      data: [jobFixture()], page: { nextCursor: null }, unexpected: 'server-extension'
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.jobPage()).rejects.toMatchObject({
      status: 502, code: 'JOB_AUDIT_BROWSER_RESPONSE_INVALID'
    })
    await expect(api.jobPage({ pageSize: 101 })).rejects.toMatchObject({
      status: 0, code: 'JOB_AUDIT_BROWSER_REQUEST_INVALID'
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('previews only the fixed export schema and ignores arbitrary server messages', async () => {
    const input: JobAuditExportInput = {
      cursor, maximumRecords: 100, kind: 'status.refresh', state: 'failed', format: 'ndjson'
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: previewFixture(input) }))
      .mockResolvedValueOnce(jsonResponse({
        error: { code: 'JOB_AUDIT_EXPORT_DISABLED', message: 'C:\\private\\token=do-not-render' }
      }, 423))
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.previewJobAuditExport(input)).resolves.toEqual({ data: previewFixture(input) })
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual(input)
    const failure = await api.previewJobAuditExport(input).then(() => null, (reason: unknown) => reason)
    expect(failure).toBeInstanceOf(ApiError)
    expect(failure).toMatchObject({ status: 423, code: 'JOB_AUDIT_EXPORT_DISABLED' })
    expect((failure as Error).message).not.toMatch(/private|token|do-not-render/i)
  })

  it.each(['json', 'ndjson'] as const)(
    'validates and returns the fixed %s attachment without accepting a server filename',
    async (format) => {
      const input: JobAuditExportInput = {
        maximumRecords: 100, kind: 'status.refresh', state: 'succeeded', format
      }
      const artifact = artifactText(format, input)
      const fileName = format === 'json' ? 'dyson-job-audit.json' : 'dyson-job-audit.ndjson'
      const contentType = format === 'json'
        ? 'application/json; charset=utf-8'
        : 'application/x-ndjson; charset=utf-8'
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(artifact, {
        status: 200,
        headers: {
          'cache-control': 'no-store',
          'content-disposition': `attachment; filename="${fileName}"`,
          'content-type': contentType,
          'x-content-type-options': 'nosniff'
        }
      }))
      vi.stubGlobal('fetch', fetchMock)

      const result = await api.exportJobAudit(input, JOB_AUDIT_EXPORT_CONFIRMATION)
      expect(result).toMatchObject({
        fileName, format, recordCount: 1, truncated: false, nextCursor: null
      })
      expect(result.byteLength).toBe(new TextEncoder().encode(artifact).byteLength)
      expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
        ...input, confirmation: JOB_AUDIT_EXPORT_CONFIRMATION
      })
    }
  )

  it('rejects a mismatched confirmation and a malformed attachment without downloading either', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}\n', {
      status: 200,
      headers: {
        'cache-control': 'no-store',
        'content-disposition': 'attachment; filename="attacker.txt"',
        'content-type': 'text/plain',
        'x-content-type-options': 'nosniff'
      }
    }))
    vi.stubGlobal('fetch', fetchMock)
    const input: JobAuditExportInput = { maximumRecords: 10, format: 'json' }

    await expect(api.exportJobAudit(
      input,
      'EXPORT' as typeof JOB_AUDIT_EXPORT_CONFIRMATION
    )).rejects.toMatchObject({ code: 'JOB_AUDIT_BROWSER_REQUEST_INVALID' })
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(api.exportJobAudit(input, JOB_AUDIT_EXPORT_CONFIRMATION)).rejects.toMatchObject({
      status: 502, code: 'JOB_AUDIT_BROWSER_RESPONSE_INVALID'
    })
  })
})

function jobFixture(): JobRecord {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    kind: 'status.refresh',
    state: 'succeeded',
    actor: 'Administrator',
    createdAt: '2026-09-01T00:00:00.000Z',
    startedAt: '2026-09-01T00:00:00.100Z',
    finishedAt: '2026-09-01T00:00:00.250Z',
    durationMs: 150,
    summary: 'Refreshed bounded server status',
    errorCode: null
  }
}

function previewFixture(input: JobAuditExportInput) {
  return {
    mode: 'dry-run' as const,
    format: input.format,
    recordCount: 1,
    byteLength: 512,
    truncated: true,
    nextCursor,
    filters: { kind: input.kind ?? null, state: input.state ?? null },
    requiredConfirmation: JOB_AUDIT_EXPORT_CONFIRMATION
  }
}

function artifactText(format: JobAuditExportFormat, input: JobAuditExportInput): string {
  const metadata = {
    protocol: 'DYSON_CONTROL_JOB_AUDIT_EXPORT_V1',
    schemaVersion: 1,
    generatedAt: '2026-09-01T00:01:00.000Z',
    recordCount: 1,
    truncated: false,
    nextCursor: null,
    filters: { kind: input.kind ?? null, state: input.state ?? null }
  }
  if (format === 'json') return `${JSON.stringify({ ...metadata, records: [jobFixture()] }, null, 2)}\n`
  return `${JSON.stringify({ ...metadata, type: 'metadata' })}\n${JSON.stringify({ type: 'job', data: jobFixture() })}\n`
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

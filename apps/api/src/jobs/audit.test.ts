import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ControlDatabase } from '../storage/database.js'
import {
  JOB_AUDIT_EXPORT_CONFIRMATION,
  JobAuditError,
  JobAuditService
} from './audit.js'

let root = ''
let database: ControlDatabase
let service: JobAuditService

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dyson-job-audit-'))
  database = new ControlDatabase(root, true)
  service = new JobAuditService(database, () => new Date('2026-01-02T03:04:05.000Z'))
})

afterEach(() => {
  database.close()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('bounded job audit projection', () => {
  it('uses a stable opaque keyset cursor without duplicates', () => {
    for (let index = 0; index < 5; index += 1) {
      database.createJob('status.refresh', 'Administrator', `状态刷新 ${index}`)
    }

    const first = service.list({ pageSize: 2 })
    const second = service.list({ pageSize: 2, cursor: first.nextCursor! })
    const third = service.list({ pageSize: 2, cursor: second.nextCursor! })

    expect(first.items).toHaveLength(2)
    expect(second.items).toHaveLength(2)
    expect(third.items).toHaveLength(1)
    expect(third.nextCursor).toBeNull()
    expect(new Set([...first.items, ...second.items, ...third.items].map((item) => item.id)).size).toBe(5)
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('filters by kind and state before applying the page boundary', () => {
    const failed = database.createJob('game.save', 'Operator', '保存失败')
    database.updateJob(failed.id, {
      state: 'failed',
      startedAt: failed.createdAt,
      finishedAt: failed.createdAt,
      durationMs: 0,
      errorCode: 'SAVE_FAILED'
    })
    database.createJob('status.refresh', 'Administrator', '状态刷新')

    const page = service.list({ pageSize: 10, kind: 'game.save', state: 'failed' })
    expect(page.items).toEqual([
      expect.objectContaining({ id: failed.id, kind: 'game.save', state: 'failed' })
    ])
  })

  it('previews and renders bounded JSON and NDJSON without changing the database', () => {
    database.createJob('status.refresh', 'Administrator', '状态刷新')

    const preview = service.preview({ format: 'json', maximumRecords: 10 })
    expect(preview).toMatchObject({
      mode: 'dry-run',
      format: 'json',
      recordCount: 1,
      truncated: false,
      requiredConfirmation: JOB_AUDIT_EXPORT_CONFIRMATION
    })
    expect(database.listJobs()).toHaveLength(1)

    const json = service.export({ format: 'json', maximumRecords: 10 })
    expect(json.fileName).toBe('dyson-job-audit.json')
    expect(json.contentType).toBe('application/json; charset=utf-8')
    expect(JSON.parse(json.bytes.toString('utf8'))).toMatchObject({
      protocol: 'DYSON_CONTROL_JOB_AUDIT_EXPORT_V1',
      schemaVersion: 1,
      generatedAt: '2026-01-02T03:04:05.000Z',
      recordCount: 1,
      records: [expect.objectContaining({ summary: '状态刷新' })]
    })

    const ndjson = service.export({ format: 'ndjson', maximumRecords: 10 })
    const lines = ndjson.bytes.toString('utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(lines).toEqual([
      expect.objectContaining({ type: 'metadata', protocol: 'DYSON_CONTROL_JOB_AUDIT_EXPORT_V1' }),
      expect.objectContaining({ type: 'job', data: expect.objectContaining({ summary: '状态刷新' }) })
    ])
  })

  it('fails closed on tampered cursors and unsafe persisted projections', () => {
    database.createJob('status.refresh', 'Administrator', '安全记录')
    database.createJob('status.refresh', 'Administrator', '另一条安全记录')
    const first = service.list({ pageSize: 1 })
    expect(first.nextCursor).not.toBeNull()
    database.createJob('status.refresh', 'C:\\private\\actor', '不安全记录')

    expect(() => service.list({ pageSize: 1, cursor: `${first.nextCursor!}A` }))
      .toThrow(expect.objectContaining<Partial<JobAuditError>>({ code: 'JOB_AUDIT_CURSOR_INVALID' }))
    expect(() => service.export({ format: 'json', maximumRecords: 10 }))
      .toThrow(expect.objectContaining<Partial<JobAuditError>>({ code: 'JOB_AUDIT_RECORD_INVALID' }))
  })

  it('enforces page and export bounds at the service boundary', () => {
    expect(() => service.list({ pageSize: 101 }))
      .toThrow(expect.objectContaining<Partial<JobAuditError>>({ code: 'JOB_AUDIT_REQUEST_INVALID' }))
    expect(() => service.export({ format: 'json', maximumRecords: 1_001 }))
      .toThrow(expect.objectContaining<Partial<JobAuditError>>({ code: 'JOB_AUDIT_REQUEST_INVALID' }))
    expect(() => service.export({ format: 'csv' } as never))
      .toThrow(expect.objectContaining<Partial<JobAuditError>>({ code: 'JOB_AUDIT_REQUEST_INVALID' }))
  })
})

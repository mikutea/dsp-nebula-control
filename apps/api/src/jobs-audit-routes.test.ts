import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApplication, type BuiltApplication } from './app.js'
import { loadConfig } from './config.js'
import { hashPassword } from './security/password.js'

const origin = 'http://127.0.0.1:13010'
const passwords = {
  viewer: 'fictional-job-viewer-password',
  operator: 'fictional-job-operator-password',
  administrator: 'fictional-job-admin-password'
} as const
let viewerPasswordHash = ''
let operatorPasswordHash = ''
let application: BuiltApplication | null = null

beforeAll(async () => {
  [viewerPasswordHash, operatorPasswordHash] = await Promise.all([
    hashPassword(passwords.viewer),
    hashPassword(passwords.operator)
  ])
})

afterEach(async () => {
  await application?.close()
  application = null
})

describe('bounded task and audit routes', () => {
  it('paginates and filters durable jobs while rejecting a tampered cursor', async () => {
    await buildFixture()
    const administrator = await login('administrator')
    for (let index = 0; index < 3; index += 1) {
      const refresh = await inject(administrator, 'POST', '/api/v1/actions/refresh')
      expect(refresh.statusCode).toBe(202)
    }

    const first = await inject(administrator, 'GET', '/api/v1/jobs?pageSize=2&kind=status.refresh')
    expect(first.statusCode).toBe(200)
    expect(first.json().data).toHaveLength(2)
    expect(first.json().page.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/)

    const second = await inject(
      administrator,
      'GET',
      `/api/v1/jobs?pageSize=2&kind=status.refresh&cursor=${first.json().page.nextCursor}`
    )
    expect(second.statusCode).toBe(200)
    expect(second.json().data).toHaveLength(1)
    expect(second.json().page.nextCursor).toBeNull()

    const tampered = await inject(
      administrator,
      'GET',
      `/api/v1/jobs?cursor=${first.json().page.nextCursor}A`
    )
    expect(tampered.statusCode).toBe(400)
    expect(tampered.json().error.code).toBe('JOB_AUDIT_CURSOR_INVALID')
  })

  it('keeps export administrator-only, confirmed, bounded, downloadable, and itself audited', async () => {
    await buildFixture()
    const operator = await login('operator')
    const administrator = await login('administrator')

    const denied = await inject(operator, 'POST', '/api/v1/jobs/audit/export/preview', {
      format: 'json', maximumRecords: 100
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json().error.code).toBe('AUTHORIZATION_DENIED')

    const preview = await inject(administrator, 'POST', '/api/v1/jobs/audit/export/preview', {
      format: 'json', maximumRecords: 100
    })
    expect(preview.statusCode).toBe(200)
    expect(preview.json().data).toMatchObject({
      mode: 'dry-run',
      format: 'json',
      truncated: false,
      requiredConfirmation: 'EXPORT_JOB_AUDIT'
    })

    const mismatch = await inject(administrator, 'POST', '/api/v1/jobs/audit/export', {
      format: 'json', maximumRecords: 100, confirmation: 'EXPORT'
    })
    expect(mismatch.statusCode).toBe(400)

    const download = await inject(administrator, 'POST', '/api/v1/jobs/audit/export', {
      format: 'json', maximumRecords: 100, confirmation: 'EXPORT_JOB_AUDIT'
    })
    expect(download.statusCode).toBe(200)
    expect(download.headers['cache-control']).toBe('no-store')
    expect(download.headers['content-disposition']).toBe('attachment; filename="dyson-job-audit.json"')
    expect(download.headers['content-type']).toMatch(/^application\/json/)
    expect(JSON.parse(download.body)).toMatchObject({
      protocol: 'DYSON_CONTROL_JOB_AUDIT_EXPORT_V1',
      schemaVersion: 1,
      records: expect.any(Array)
    })
    expect(download.body).not.toMatch(/password|secret|cookie|token|\\\\|[A-Z]:\\/i)

    const auditJobs = await inject(administrator, 'GET', '/api/v1/jobs?kind=audit.export')
    expect(auditJobs.statusCode).toBe(200)
    expect(auditJobs.json().data).toEqual([
      expect.objectContaining({ kind: 'audit.export', state: 'succeeded', actor: 'Administrator' })
    ])
  })
})

async function buildFixture() {
  application = await buildApplication(loadConfig({
    NODE_ENV: 'test',
    DYSON_PROVIDER: 'demo',
    DYSON_PUBLIC_ORIGIN: origin,
    DYSON_DEV_ADMIN_PASSWORD: passwords.administrator,
    DYSON_VIEWER_PASSWORD_HASH: viewerPasswordHash,
    DYSON_OPERATOR_PASSWORD_HASH: operatorPasswordHash
  }))
}

async function login(role: keyof typeof passwords): Promise<string> {
  const response = await application!.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin },
    payload: { role, password: passwords[role] }
  })
  expect(response.statusCode).toBe(200)
  return response.cookies[0]!.value
}

function inject(
  cookie: string,
  method: 'GET' | 'POST',
  url: string,
  payload?: object
) {
  return application!.app.inject({
    method,
    url,
    headers: method === 'POST' ? { origin } : undefined,
    cookies: { dyson_session: cookie },
    payload
  })
}

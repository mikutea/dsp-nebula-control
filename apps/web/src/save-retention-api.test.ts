import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'
import type { BackupRetentionPolicy } from './model'

const requestId = '11111111-2222-4333-8444-555555555555'
const retirementRequestId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const backupId = 'tx-99999999-8888-4777-8666-555555555555'
const policy: BackupRetentionPolicy = {
  keepLastHealthy: 3,
  keepDailyDays: 14,
  keepWeeklyWeeks: 8,
  minimumHealthy: 2,
  allowUnhealthyDeletion: false
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('save retention web client contract', () => {
  it('updates only one logical annotation with optimistic revision and a fixed confirmation', async () => {
    const fetchMock = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(body).toEqual({
        requestId,
        backupId,
        expectedRevision: 2,
        note: '长期节点',
        protected: true,
        confirmation: 'UPDATE_BACKUP_ANNOTATION'
      })
      assertNoAmbientAuthority(body)
      return jsonResponse({ data: { receipt: {}, reused: false } }, 201)
    })
    vi.stubGlobal('fetch', fetchMock)

    await api.setBackupAnnotation({
      requestId, backupId, expectedRevision: 2, note: '长期节点', protected: true
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/backups/retention/annotations',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' })
    )
  })

  it('keeps dry-run and retirement execution as digest-bound separate requests', async () => {
    const bodies: unknown[] = []
    const fetchMock = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return jsonResponse({ data: {}, meta: { executionEnabled: true } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const referenceTime = '2026-08-31T12:00:00.000Z'
    const previewDigest = 'a'.repeat(64)

    await api.previewBackupRetention(referenceTime, policy)
    await api.executeBackupRetention({ requestId, previewDigest, referenceTime, policy })

    expect(bodies).toEqual([
      { referenceTime, policy },
      { requestId, previewDigest, referenceTime, policy, confirmation: 'RETIRE_BACKUPS' }
    ])
    for (const body of bodies) assertNoAmbientAuthority(body)
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/v1/backups/retention/preview', expect.objectContaining({
      method: 'POST', credentials: 'same-origin'
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/v1/backups/retention/execute', expect.objectContaining({
      method: 'POST', credentials: 'same-origin'
    }))
  })

  it('separates recoverable restore from irreversible purge preview and execution', async () => {
    const requests: Array<{ path: string; body: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ path: String(path), body: JSON.parse(String(init?.body)) })
      return jsonResponse({ data: {}, meta: { executionEnabled: true } })
    }))
    const purgePreviewDigest = 'b'.repeat(64)

    await api.restoreRetiredBackups(requestId, retirementRequestId)
    await api.previewRetiredBackupPurge(retirementRequestId)
    await api.purgeRetiredBackups({ requestId, retirementRequestId, purgePreviewDigest })

    expect(requests).toEqual([
      {
        path: '/api/v1/backups/retention/restore',
        body: { requestId, retirementRequestId, confirmation: 'RESTORE_RETIRED_BACKUPS' }
      },
      {
        path: '/api/v1/backups/retention/purge/preview',
        body: { retirementRequestId }
      },
      {
        path: '/api/v1/backups/retention/purge/execute',
        body: { requestId, retirementRequestId, purgePreviewDigest, confirmation: 'PURGE_RETIRED_BACKUPS' }
      }
    ])
    for (const request of requests) assertNoAmbientAuthority(request.body)
  })

  it('preserves a fail-closed mutation response instead of presenting local success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      error: { code: 'SAVE_RETENTION_MUTATIONS_DISABLED', message: 'retention disabled' }
    }, 423)))
    const error = await api.executeBackupRetention({
      requestId,
      previewDigest: 'a'.repeat(64),
      referenceTime: '2026-08-31T12:00:00.000Z',
      policy
    }).then(() => null, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      status: 423,
      code: 'SAVE_RETENTION_MUTATIONS_DISABLED',
      message: 'retention disabled'
    })
  })
})

function assertNoAmbientAuthority(value: unknown): void {
  expect(JSON.stringify(value)).not.toMatch(/"(?:path|root|url|command|script|credential|secret|token)"\s*:/i)
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

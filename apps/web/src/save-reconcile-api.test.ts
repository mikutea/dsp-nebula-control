import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'
import { SAVE_JOB_RECONCILE_CONFIRMATION } from './save-reconcile-contract'

const jobId = '11111111-2222-4333-8444-555555555555'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('save reconciliation web client', () => {
  it('strictly reads the same save job without caching', async () => {
    const payload = executionFixture()
    const fetchMock = vi.fn(async () => jsonResponse({ data: payload }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.saveJob(jobId)).resolves.toEqual({ data: payload })
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/saves/jobs/${jobId}`,
      expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' })
    )
  })

  it('posts the exact confirmation once and accepts a queued reconciliation', async () => {
    const queued = executionFixture({ state: 'queued' })
    const fetchMock = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json')
      expect(JSON.parse(String(init?.body))).toEqual({ confirmation: SAVE_JOB_RECONCILE_CONFIRMATION })
      return jsonResponse({ data: queued }, 202)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.reconcileSaveJob(jobId, SAVE_JOB_RECONCILE_CONFIRMATION))
      .resolves.toEqual({ data: queued })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/saves/jobs/${jobId}/reconcile`,
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' })
    )
  })

  it('rejects an invalid UUID or confirmation locally without fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const unsafe = api.reconcileSaveJob as unknown as (
      id: string,
      confirmation: string
    ) => Promise<unknown>

    await expect(unsafe('not-a-uuid', SAVE_JOB_RECONCILE_CONFIRMATION))
      .rejects.toMatchObject({ status: 400, code: 'SAVE_JOB_BROWSER_REQUEST_INVALID' })
    await expect(unsafe(jobId, 'RETRY_SAVE_JOB'))
      .rejects.toMatchObject({ status: 400, code: 'SAVE_JOB_BROWSER_REQUEST_INVALID' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails closed on response drift and preserves bounded server gate codes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      data: { ...executionFixture(), internalPath: 'C:\\Fictional\\private-save' }
    })))
    await expect(api.saveJob(jobId)).rejects.toMatchObject({
      status: 502,
      code: 'SAVE_JOB_BROWSER_RESPONSE_INVALID'
    })

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      error: { code: 'SAVE_JOB_RECONCILE_NOT_ALLOWED', message: 'not allowed' }
    }, 409)))
    const error = await api.reconcileSaveJob(jobId, SAVE_JOB_RECONCILE_CONFIRMATION)
      .then(() => null, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 409, code: 'SAVE_JOB_RECONCILE_NOT_ALLOWED' })
  })
})

function executionFixture(patch: { state?: 'queued' | 'running' | 'interrupted' } = {}) {
  const state = patch.state ?? 'interrupted'
  const createdAt = '2026-09-04T12:00:00.000Z'
  return {
    job: {
      id: jobId,
      kind: 'save.restore' as const,
      state: state === 'interrupted' ? 'failed' as const : state,
      actor: 'administrator',
      createdAt,
      startedAt: state === 'queued' ? null : '2026-09-04T12:00:01.000Z',
      finishedAt: state === 'interrupted' ? '2026-09-04T12:00:02.000Z' : null,
      durationMs: state === 'interrupted' ? 1000 : null,
      summary: '受控存档恢复事务等待持久化对账',
      errorCode: state === 'interrupted' ? 'SAVE_COMMIT_CLEANUP_PENDING' : null
    },
    run: {
      jobId,
      operation: 'restore' as const,
      state,
      attemptCount: state === 'interrupted' ? 1 : 2,
      result: {
        status: 'succeeded' as const,
        backupId: 'tx-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        protectionBackupId: 'tx-99999999-8888-4777-8666-555555555555',
        pairBytes: 1024,
        rollback: 'not-required' as const,
        reused: false,
        auditStored: true,
        cleanupPending: true,
        maintenanceRequired: true
      },
      errorCode: state === 'interrupted' ? 'SAVE_COMMIT_CLEANUP_PENDING' : null,
      recoveryRequired: true,
      createdAt,
      updatedAt: '2026-09-04T12:00:03.000Z'
    },
    reused: state !== 'interrupted'
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { api, ApiError, JOB_AUDIT_EXPORT_CONFIRMATION } from './api'
import { TasksAuditWorkspace } from './TasksAuditWorkspace'
import type {
  ControlPermission, ControlRole, JobAuditExportPreview, JobPage, JobRecord, SessionUser
} from './model'

const cursor = 'eyJ2IjoxLCJwYWdlIjoyfQ'
const originalCreateObjectUrl = URL.createObjectURL
const originalRevokeObjectUrl = URL.revokeObjectURL

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectUrl })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectUrl })
})

describe('TasksAuditWorkspace', () => {
  it('gives a Viewer stable cursor pagination, filters, refresh, and a truthful read-only boundary', async () => {
    const list = vi.spyOn(api, 'jobPage').mockImplementation(async (query = {}) =>
      query.cursor ? page(jobFixture('second-page-task', 2), null) : page(jobFixture('first-page-task', 1), cursor))
    render(<TasksAuditWorkspace user={user('viewer', ['jobs.read'])} />)

    await screen.findByText('first-page-task')
    expect(screen.getByText('当前角色仅可读取')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '下一页任务' }))
    await screen.findByText('second-page-task')
    expect(list.mock.calls[1]?.[0]).toMatchObject({ pageSize: 20, cursor })

    fireEvent.click(screen.getByRole('button', { name: '上一页任务' }))
    await screen.findByText('first-page-task')
    fireEvent.change(screen.getByLabelText('任务类型'), { target: { value: 'audit.export' } })
    await waitFor(() => expect(list.mock.calls.at(-1)?.[0]).toEqual({ pageSize: 20, kind: 'audit.export' }))
    fireEvent.change(screen.getByLabelText('任务状态'), { target: { value: 'failed' } })
    await waitFor(() => expect(list.mock.calls.at(-1)?.[0]).toEqual({
      pageSize: 20, kind: 'audit.export', state: 'failed'
    }))
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThanOrEqual(6))
  })

  it('keeps an Operator read-only even if a tampered permission list includes jobs.export', async () => {
    vi.spyOn(api, 'jobPage').mockResolvedValue(page(jobFixture('operator-readable'), null))
    const preview = vi.spyOn(api, 'previewJobAuditExport')
    render(<TasksAuditWorkspace user={user('operator', ['jobs.read', 'jobs.export'])} />)

    await screen.findByText('operator-readable')
    expect(screen.getByText('当前角色仅可读取')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '生成预演' })).toBeNull()
    expect(preview).not.toHaveBeenCalled()
  })

  it('requires an Administrator preview, exact confirmation, fresh preflight, and verified download', async () => {
    vi.spyOn(api, 'jobPage').mockResolvedValue(page(jobFixture('downloadable-audit'), null))
    const preview = vi.spyOn(api, 'previewJobAuditExport').mockResolvedValue({ data: previewFixture() })
    const download = vi.spyOn(api, 'exportJobAudit').mockResolvedValue({
      blob: new Blob(['fixture']),
      fileName: 'dyson-job-audit.json',
      format: 'json',
      byteLength: 7,
      recordCount: 1,
      truncated: false,
      nextCursor: null
    })
    const createObjectUrl = vi.fn(() => 'blob:job-audit-fixture')
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    render(<TasksAuditWorkspace user={administrator()} />)

    await screen.findByText('downloadable-audit')
    fireEvent.click(screen.getByRole('button', { name: '生成预演' }))
    await screen.findByText('DRY-RUN 预演')
    const execute = screen.getByRole('button', { name: '校验并下载' }) as HTMLButtonElement
    expect(execute.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('审计导出确认令牌'), {
      target: { value: JOB_AUDIT_EXPORT_CONFIRMATION }
    })
    expect(execute.disabled).toBe(false)
    fireEvent.click(execute)

    await screen.findByText('附件已通过浏览器完整性校验并下载')
    expect(preview).toHaveBeenCalledTimes(2)
    expect(preview.mock.calls[0]?.[0]).toEqual({ format: 'json', maximumRecords: 100 })
    expect(download).toHaveBeenCalledWith(
      { format: 'json', maximumRecords: 100 },
      JOB_AUDIT_EXPORT_CONFIRMATION,
      expect.any(AbortSignal)
    )
    expect(createObjectUrl).toHaveBeenCalledTimes(1)
    expect(click).toHaveBeenCalledTimes(1)
    expect((click.mock.instances[0] as unknown as HTMLAnchorElement).download).toBe('dyson-job-audit.json')
  })

  it('refreshes a changed preflight and refuses export until the Administrator confirms again', async () => {
    vi.spyOn(api, 'jobPage').mockResolvedValue(page(jobFixture('drift-audit'), null))
    const changed = { ...previewFixture(), recordCount: 2, byteLength: 640 }
    vi.spyOn(api, 'previewJobAuditExport')
      .mockResolvedValueOnce({ data: previewFixture() })
      .mockResolvedValueOnce({ data: changed })
    const download = vi.spyOn(api, 'exportJobAudit')
    render(<TasksAuditWorkspace user={administrator()} />)

    await screen.findByText('drift-audit')
    fireEvent.click(screen.getByRole('button', { name: '生成预演' }))
    await screen.findByText('DRY-RUN 预演')
    fireEvent.change(screen.getByLabelText('审计导出确认令牌'), {
      target: { value: JOB_AUDIT_EXPORT_CONFIRMATION }
    })
    fireEvent.click(screen.getByRole('button', { name: '校验并下载' }))

    await screen.findByText('预演已经刷新')
    expect(screen.getByText(/持久任务历史在确认期间发生变化/)).toBeTruthy()
    expect((screen.getByLabelText('审计导出确认令牌') as HTMLInputElement).value).toBe('')
    expect(download).not.toHaveBeenCalled()
  })

  it('latches 403/423 as fail-closed and never renders an arbitrary server message', async () => {
    vi.spyOn(api, 'jobPage').mockResolvedValue(page(jobFixture('locked-audit'), null))
    const preview = vi.spyOn(api, 'previewJobAuditExport').mockRejectedValue(
      new ApiError(423, 'C:\\secret\\token=arbitrary-server-message', 'JOB_AUDIT_EXPORT_DISABLED')
    )
    render(<TasksAuditWorkspace user={administrator()} />)

    await screen.findByText('locked-audit')
    fireEvent.click(screen.getByRole('button', { name: '生成预演' }))
    await screen.findByText('导出门禁已锁定')
    expect(screen.getByText('服务端审计导出门禁当前关闭。')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/secret|arbitrary-server-message/i)
    const button = screen.getByRole('button', { name: '生成预演' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(preview).toHaveBeenCalledTimes(1)
  })

  it('prevents duplicate preview submissions and exposes a safe browser-side cancel state', async () => {
    vi.spyOn(api, 'jobPage').mockResolvedValue(page(jobFixture('cancel-audit'), null))
    const pending = deferred<{ data: JobAuditExportPreview }>()
    const preview = vi.spyOn(api, 'previewJobAuditExport').mockReturnValue(pending.promise)
    render(<TasksAuditWorkspace user={administrator()} />)

    await screen.findByText('cancel-audit')
    const prepare = screen.getByRole('button', { name: '生成预演' })
    fireEvent.click(prepare)
    fireEvent.click(prepare)
    expect(preview).toHaveBeenCalledTimes(1)
    expect((screen.getByRole('button', { name: '正在生成预演' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '中止审计导出' }))
    expect(await screen.findByText('已中止本次浏览器等待；没有触发新的附件下载。')).toBeTruthy()
    expect(preview.mock.calls[0]?.[1]?.aborted).toBe(true)
    pending.resolve({ data: previewFixture() })
  })

  it('renders verified empty state and redacts a later read failure', async () => {
    const list = vi.spyOn(api, 'jobPage')
      .mockResolvedValueOnce({ data: [], page: { nextCursor: null } })
      .mockRejectedValueOnce(new ApiError(503, 'C:\\private\\task-log', 'JOB_AUDIT_UNAVAILABLE'))
    render(<TasksAuditWorkspace user={user('viewer', ['jobs.read'])} />)

    await screen.findByText('当前游标范围没有任务')
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await screen.findByText('读取保持 fail-closed')
    expect(screen.getByText('任务历史读取失败。')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/private|task-log/i)
    expect(list).toHaveBeenCalledTimes(2)
  })
})

function user(role: ControlRole, permissions: ControlPermission[]): SessionUser {
  return { name: role === 'administrator' ? 'Administrator' : role === 'operator' ? 'Operator' : 'Viewer', role, permissions }
}

function administrator(): SessionUser {
  return user('administrator', ['jobs.read', 'jobs.export'])
}

function page(job: JobRecord, nextCursor: string | null): JobPage {
  return { data: [job], page: { nextCursor } }
}

function jobFixture(summary: string, sequence = 1): JobRecord {
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    kind: 'status.refresh',
    state: 'succeeded',
    actor: 'Administrator',
    createdAt: `2026-09-01T00:00:0${sequence}.000Z`,
    startedAt: `2026-09-01T00:00:0${sequence}.100Z`,
    finishedAt: `2026-09-01T00:00:0${sequence}.250Z`,
    durationMs: 150,
    summary,
    errorCode: null
  }
}

function previewFixture(): JobAuditExportPreview {
  return {
    mode: 'dry-run',
    format: 'json',
    recordCount: 1,
    byteLength: 512,
    truncated: false,
    nextCursor: null,
    filters: { kind: null, state: null },
    requiredConfirmation: JOB_AUDIT_EXPORT_CONFIRMATION
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PlayerNoticeWorkspace } from './PlayerNoticeWorkspace'
import { api, ApiError, PlayerNoticeApiError } from './api'
import type {
  JobRecord, PlayerCapabilitiesProjection, PlayerNoticePlan, PlayerNoticeReceipt,
  PlayerRoster, SessionUser
} from './model'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('targeted player notice workspace', () => {
  it('keeps the fixed-template mutation unavailable to a read-only role', () => {
    const preview = vi.spyOn(api, 'previewPlayerNotice')
    render(<PlayerNoticeWorkspace roster={roster} capabilities={capabilities}
      user={user('viewer', ['players.read'])} demo={false} onRefresh={vi.fn(async () => true)} />)

    expect(screen.getByText('只读角色')).not.toBeNull()
    const button = screen.getByRole('button', { name: '生成无写入预演' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(preview).not.toHaveBeenCalled()
  })

  it('binds one preview and one execution to the signed roster and fixed template', async () => {
    vi.spyOn(api, 'previewPlayerNotice').mockResolvedValue({ data: { job: previewJob, plan } })
    vi.spyOn(api, 'executePlayerNotice').mockResolvedValue({ data: { job: executeJob, receipt } })
    render(<PlayerNoticeWorkspace roster={roster} capabilities={capabilities}
      user={user('administrator', ['players.read', 'players.moderate'])}
      demo={false} onRefresh={vi.fn(async () => true)} />)

    fireEvent.click(screen.getByRole('button', { name: '生成无写入预演' }))
    await screen.findByText(/DRY RUN · 门禁通过/)
    expect(api.previewPlayerNotice).toHaveBeenCalledTimes(1)
    expect(api.previewPlayerNotice).toHaveBeenCalledWith({
      rosterGeneration: roster.rosterGeneration,
      rosterSequence: 7,
      sessionPlayerId: 'player-000002',
      templateId: 'maintenance-5m'
    })

    fireEvent.click(screen.getByRole('button', { name: '确认发送固定通知' }))
    await screen.findByText('已交给目标连接传输层')
    expect(api.executePlayerNotice).toHaveBeenCalledTimes(1)
    expect(api.executePlayerNotice).toHaveBeenCalledWith(expect.objectContaining({
      rosterGeneration: roster.rosterGeneration,
      rosterSequence: 7,
      sessionPlayerId: 'player-000002',
      templateId: 'maintenance-5m',
      confirmation: 'EXECUTE',
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/)
    }))
    expect((screen.getByRole('button', { name: /刷新签名证据并新建通知/ }) as HTMLButtonElement).disabled)
      .toBe(false)
    expect(screen.getByText(/不等于客户端已显示/)).not.toBeNull()
  })

  it('locks execution after an ambiguous response and never retries automatically', async () => {
    vi.spyOn(api, 'previewPlayerNotice').mockResolvedValue({ data: { job: previewJob, plan } })
    vi.spyOn(api, 'executePlayerNotice').mockRejectedValue(
      new ApiError(503, '通知回执等待超时', 'PLAYER_NOTICE_RECEIPT_TIMEOUT')
    )
    render(<PlayerNoticeWorkspace roster={roster} capabilities={capabilities}
      user={user('administrator', ['players.read', 'players.moderate'])}
      demo={false} onRefresh={vi.fn(async () => true)} />)

    fireEvent.click(screen.getByRole('button', { name: '生成无写入预演' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认发送固定通知' }))

    expect((await screen.findByRole('alert')).textContent).toMatch(/禁止盲目重投/)
    expect(api.executePlayerNotice).toHaveBeenCalledTimes(1)
    expect((screen.getByRole('button', { name: '本次请求已锁定' }) as HTMLButtonElement).disabled).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(api.executePlayerNotice).toHaveBeenCalledTimes(1)
  })

  it('does not allow signed-evidence refresh to bypass an unknown outcome', async () => {
    vi.spyOn(api, 'previewPlayerNotice').mockResolvedValue({ data: { job: previewJob, plan } })
    vi.spyOn(api, 'executePlayerNotice').mockRejectedValue(new TypeError('network unavailable'))
    const onRefresh = vi.fn(async () => false)
    render(<PlayerNoticeWorkspace roster={roster} capabilities={capabilities}
      user={user('administrator', ['players.read', 'players.moderate'])}
      demo={false} onRefresh={onRefresh} />)

    fireEvent.click(screen.getByRole('button', { name: '生成无写入预演' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认发送固定通知' }))
    const reset = await screen.findByRole('button', { name: /刷新签名证据并新建通知/ }) as HTMLButtonElement
    expect(reset.disabled).toBe(true)
    fireEvent.click(reset)
    expect(onRefresh).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: '本次请求已锁定' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/UNKNOWN OUTCOME/)).not.toBeNull()
  })

  it('keeps signed uncertain receipts in the awaiting-receipt phase', async () => {
    const uncertain: PlayerNoticeReceipt = {
      ...receipt,
      state: 'uncertain',
      recoveryRequired: true,
      errorCode: 'PLAYER_NOTICE_OUTCOME_UNKNOWN'
    }
    const failedJob: JobRecord = {
      ...executeJob,
      state: 'failed',
      errorCode: 'PLAYER_NOTICE_OUTCOME_UNKNOWN'
    }
    vi.spyOn(api, 'previewPlayerNotice').mockResolvedValue({ data: { job: previewJob, plan } })
    vi.spyOn(api, 'executePlayerNotice').mockRejectedValue(new PlayerNoticeApiError(
      503,
      '结果未知',
      'PLAYER_NOTICE_OUTCOME_UNKNOWN',
      { job: failedJob, receipt: uncertain }
    ))
    vi.spyOn(api, 'playerNoticeReceipt').mockResolvedValue({ data: { receipt: uncertain } })
    render(<PlayerNoticeWorkspace roster={roster} capabilities={capabilities}
      user={user('administrator', ['players.read', 'players.moderate'])}
      demo={false} onRefresh={vi.fn(async () => true)} />)

    fireEvent.click(screen.getByRole('button', { name: '生成无写入预演' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认发送固定通知' }))
    await screen.findByText('通知终止：uncertain')
    expect(JSON.parse(window.localStorage.getItem('dyson-control.player-notice.pending.v1')!))
      .toMatchObject({ phase: 'awaiting-receipt' })

    fireEvent.click(screen.getByRole('button', { name: /只读查询原请求回执/ }))
    expect((await screen.findByRole('alert')).textContent).toContain('仍为 uncertain')
    expect(JSON.parse(window.localStorage.getItem('dyson-control.player-notice.pending.v1')!))
      .toMatchObject({ phase: 'awaiting-receipt' })
  })

  it('keeps a definitive receipt locked when the following evidence refresh fails', async () => {
    vi.spyOn(api, 'previewPlayerNotice').mockResolvedValue({ data: { job: previewJob, plan } })
    vi.spyOn(api, 'executePlayerNotice').mockResolvedValue({ data: { job: executeJob, receipt } })
    const onRefresh = vi.fn(async () => false)
    render(<PlayerNoticeWorkspace roster={roster} capabilities={capabilities}
      user={user('administrator', ['players.read', 'players.moderate'])}
      demo={false} onRefresh={onRefresh} />)

    fireEvent.click(screen.getByRole('button', { name: '生成无写入预演' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认发送固定通知' }))
    await screen.findByText('已交给目标连接传输层')
    fireEvent.click(screen.getByRole('button', { name: /刷新签名证据并新建通知/ }))

    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1))
    expect((screen.getByRole('button', { name: '本次请求已锁定' }) as HTMLButtonElement).disabled).toBe(true)
    expect((await screen.findByRole('alert')).textContent).toContain('旧证据不可用于解除执行锁')
  })

  it('invalidates a dry-run when the signed roster generation changes before execution', async () => {
    vi.spyOn(api, 'previewPlayerNotice').mockResolvedValue({ data: { job: previewJob, plan } })
    const execute = vi.spyOn(api, 'executePlayerNotice')
    const props = {
      capabilities,
      user: user('administrator', ['players.read', 'players.moderate']),
      demo: false,
      onRefresh: vi.fn(async () => true)
    }
    const view = render(<PlayerNoticeWorkspace roster={roster} {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '生成无写入预演' }))
    await screen.findByText(/DRY RUN · 门禁通过/)

    view.rerender(<PlayerNoticeWorkspace roster={{
      ...roster, rosterGeneration: `roster-v1:${'b'.repeat(64)}`, sequence: 1
    }} {...props} />)

    await waitFor(() => expect(screen.queryByText(/DRY RUN · 门禁通过/)).toBeNull())
    expect(execute).not.toHaveBeenCalled()
  })

  it('persists an unknown outcome across remount and only reads the original receipt on demand', async () => {
    vi.spyOn(api, 'previewPlayerNotice').mockResolvedValue({ data: { job: previewJob, plan } })
    vi.spyOn(api, 'executePlayerNotice').mockRejectedValue(new TypeError('network unavailable'))
    const lookup = vi.spyOn(api, 'playerNoticeReceipt')
      .mockRejectedValueOnce(new ApiError(404, '回执不存在', 'PLAYER_NOTICE_RECEIPT_NOT_FOUND'))
      .mockResolvedValueOnce({ data: { receipt } })
    const onRefresh = vi.fn(async () => true)
    const props = {
      roster, capabilities,
      user: user('administrator', ['players.read', 'players.moderate']),
      demo: false,
      onRefresh
    }
    const first = render(<PlayerNoticeWorkspace {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '生成无写入预演' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认发送固定通知' }))
    await screen.findByText(/UNKNOWN OUTCOME/)
    const persisted = JSON.parse(window.localStorage.getItem('dyson-control.player-notice.pending.v1')!) as {
      requestId: string
    }
    first.unmount()

    render(<PlayerNoticeWorkspace {...props} />)
    expect(screen.getByText(/UNKNOWN OUTCOME/)).not.toBeNull()
    expect(lookup).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: /刷新签名证据并新建通知/ }) as HTMLButtonElement).disabled)
      .toBe(true)

    fireEvent.click(screen.getByRole('button', { name: /只读查询原请求回执/ }))
    expect((await screen.findByRole('alert')).textContent).toContain('暂无终态回执')
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(lookup).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: persisted.requestId }))
    expect(screen.getByText(/UNKNOWN OUTCOME/)).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /只读查询原请求回执/ }))
    await screen.findByText('已交给目标连接传输层')
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(JSON.parse(window.localStorage.getItem('dyson-control.player-notice.pending.v1')!))
      .toMatchObject({ phase: 'awaiting-evidence-refresh', requestId: persisted.requestId })
    expect((screen.getByRole('button', { name: /刷新签名证据并新建通知/ }) as HTMLButtonElement).disabled)
      .toBe(false)

    cleanup()
    render(<PlayerNoticeWorkspace {...props} />)
    expect(screen.getByText(/TERMINAL RECEIPT · 等待证据刷新/)).not.toBeNull()
    expect((screen.getByRole('button', { name: /刷新签名证据并新建通知/ }) as HTMLButtonElement).disabled)
      .toBe(false)
    expect(lookup).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('button', { name: /刷新签名证据并新建通知/ }))
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1))
    expect(window.localStorage.getItem('dyson-control.player-notice.pending.v1')).toBeNull()
    expect(screen.getByRole('button', { name: '生成无写入预演' })).not.toBeNull()
  })

  it('persists the evidence-refresh phase across failed refreshes and page remounts', async () => {
    vi.spyOn(api, 'previewPlayerNotice').mockResolvedValue({ data: { job: previewJob, plan } })
    vi.spyOn(api, 'executePlayerNotice').mockResolvedValue({ data: { job: executeJob, receipt } })
    const onRefresh = vi.fn(async () => false)
    const props = {
      roster, capabilities,
      user: user('administrator', ['players.read', 'players.moderate']),
      demo: false,
      onRefresh
    }
    const first = render(<PlayerNoticeWorkspace {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '生成无写入预演' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认发送固定通知' }))
    await screen.findByText('已交给目标连接传输层')
    expect(JSON.parse(window.localStorage.getItem('dyson-control.player-notice.pending.v1')!))
      .toMatchObject({ phase: 'awaiting-evidence-refresh' })

    fireEvent.click(screen.getByRole('button', { name: /刷新签名证据并新建通知/ }))
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1))
    first.unmount()
    render(<PlayerNoticeWorkspace {...props} />)
    expect(screen.getByText(/TERMINAL RECEIPT · 等待证据刷新/)).not.toBeNull()
    expect((screen.getByRole('button', { name: '生成无写入预演' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('fails closed when a persisted idempotency record is malformed or unreadable', () => {
    const preview = vi.spyOn(api, 'previewPlayerNotice')
    const props = {
      roster, capabilities,
      user: user('administrator', ['players.read', 'players.moderate']),
      demo: false,
      onRefresh: vi.fn(async () => true)
    }
    window.localStorage.setItem('dyson-control.player-notice.pending.v1', '{broken-json')
    const malformed = render(<PlayerNoticeWorkspace {...props} />)
    expect(screen.getByText(/LOCAL RECORD INVALID/)).not.toBeNull()
    expect((screen.getByRole('button', { name: '生成无写入预演' }) as HTMLButtonElement).disabled).toBe(true)
    malformed.unmount()

    window.localStorage.setItem('dyson-control.player-notice.pending.v1', JSON.stringify({ schemaVersion: 1 }))
    const drifted = render(<PlayerNoticeWorkspace {...props} />)
    expect(screen.getByText(/LOCAL RECORD INVALID/)).not.toBeNull()
    drifted.unmount()

    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage denied') })
    render(<PlayerNoticeWorkspace {...props} />)
    expect(screen.getByText(/LOCAL RECORD INVALID/)).not.toBeNull()
    expect(preview).not.toHaveBeenCalled()
    getItem.mockRestore()
  })

  it('invalidates a dry-run on any newer roster sequence in the same generation', async () => {
    vi.spyOn(api, 'previewPlayerNotice').mockResolvedValue({ data: { job: previewJob, plan } })
    const execute = vi.spyOn(api, 'executePlayerNotice')
    const props = {
      capabilities,
      user: user('administrator', ['players.read', 'players.moderate']),
      demo: false,
      onRefresh: vi.fn(async () => true)
    }
    const view = render(<PlayerNoticeWorkspace roster={roster} {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '生成无写入预演' }))
    await screen.findByText(/DRY RUN · 门禁通过/)
    view.rerender(<PlayerNoticeWorkspace roster={{ ...roster, sequence: 8 }} {...props} />)
    await waitFor(() => expect(screen.queryByText(/DRY RUN · 门禁通过/)).toBeNull())
    expect(execute).not.toHaveBeenCalled()
  })

  it('uses an in-memory gate so rapid duplicate clicks create one execution request', async () => {
    vi.spyOn(api, 'previewPlayerNotice').mockResolvedValue({ data: { job: previewJob, plan } })
    let resolveExecution!: (value: { data: { job: JobRecord; receipt: PlayerNoticeReceipt } }) => void
    const execute = vi.spyOn(api, 'executePlayerNotice').mockImplementation(() => new Promise((resolve) => {
      resolveExecution = resolve
    }))
    render(<PlayerNoticeWorkspace roster={roster} capabilities={capabilities}
      user={user('administrator', ['players.read', 'players.moderate'])}
      demo={false} onRefresh={vi.fn(async () => true)} />)

    fireEvent.click(screen.getByRole('button', { name: '生成无写入预演' }))
    const confirm = await screen.findByRole('button', { name: '确认发送固定通知' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(execute).toHaveBeenCalledTimes(1)
    resolveExecution({ data: { job: executeJob, receipt } })
    await screen.findByText('已交给目标连接传输层')
    expect(execute).toHaveBeenCalledTimes(1)
  })
})

function user(role: SessionUser['role'], permissions: SessionUser['permissions']): SessionUser {
  return { name: role === 'administrator' ? 'Administrator' : 'Viewer', role, permissions }
}

const roster: PlayerRoster = {
  schemaVersion: 1,
  state: 'active',
  authoritative: true,
  observedAt: '2026-08-30T10:05:00.000Z',
  rosterGeneration: `roster-v1:${'a'.repeat(64)}`,
  sequence: 7,
  truncated: false,
  playerCount: 1,
  players: [{
    sessionPlayerId: 'player-000002',
    displayName: 'FictionalPilot',
    online: true,
    joinedAt: '2026-08-30T09:46:00.000Z',
    location: 'deep-space'
  }],
  lastKnownPlayers: [],
  recentEvents: []
}

const capabilities: PlayerCapabilitiesProjection = {
  repository: 'NebulaModTeam/nebula',
  tag: 'v0.9.22',
  runtimeFileVersion: '0.9.22.2',
  commit: '3cdf95c594a2f8010b0e87a43be828e6ba2f657f',
  verificationScope: 'runtime-assembly-identity-verified',
  actionsEnabled: true,
  observedAt: '2026-08-30T10:05:00.000Z',
  capabilities: [
    { capability: 'observe-roster', availability: 'available', mode: 'read-only', reasonCode: 'UPSTREAM_ROSTER_API_VERIFIED', reasonSummary: 'Roster available.' },
    { capability: 'notice', availability: 'available', mode: 'mutation', reasonCode: 'UPSTREAM_TARGETED_NOTICE_PRIMITIVES_VERIFIED', reasonSummary: 'Fixed notice available.' }
  ]
}

const plan: PlayerNoticePlan = {
  action: 'player.notice',
  mode: 'dry-run',
  allowed: true,
  executionEnabled: true,
  rosterGeneration: roster.rosterGeneration,
  rosterSequence: 7,
  sessionPlayerId: 'player-000002',
  targetJoinedAtUnixMs: 1_788_083_160_000,
  templateId: 'maintenance-5m',
  checks: [{ id: 'fixed-template', status: 'pass', message: '通知来自固定模板' }],
  blockers: [],
  mutation: false,
  rollback: { strategy: 'not-possible', ready: false, summary: '通知不可撤回；传输回执不等于客户端显示。' }
}

const receipt: PlayerNoticeReceipt = {
  requestId: '44444444-5555-4666-8777-888888888888',
  action: 'player.notice',
  state: 'transport-dispatched',
  startedAt: '2026-08-30T10:05:01.000Z',
  finishedAt: '2026-08-30T10:05:01.010Z',
  rosterGeneration: roster.rosterGeneration,
  rosterSequence: 7,
  sessionPlayerId: 'player-000002',
  targetJoinedAt: '2026-08-30T09:46:00.000Z',
  templateId: 'maintenance-5m',
  mutationMayHaveOccurred: true,
  recoveryRequired: false,
  rollback: { strategy: 'not-possible', summary: '系统通知不可撤回；transport-dispatched 不等于客户端已显示。' },
  errorCode: 'NONE'
}

const previewJob: JobRecord = {
  id: '11111111-2222-4333-8444-555555555555',
  kind: 'player.notice.preview',
  state: 'succeeded',
  actor: 'Administrator',
  createdAt: '2026-08-30T10:05:00.000Z',
  startedAt: '2026-08-30T10:05:00.001Z',
  finishedAt: '2026-08-30T10:05:00.010Z',
  durationMs: 9,
  summary: 'Fictional notice preview complete',
  errorCode: null
}

const executeJob: JobRecord = {
  ...previewJob,
  id: '22222222-3333-4444-8555-666666666666',
  kind: 'player.notice',
  summary: 'Fictional notice dispatched'
}

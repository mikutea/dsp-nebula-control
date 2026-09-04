// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConsoleWorkspace, LoginScreen, PlayerWorkspace, TopBar } from './App'
import { api, ApiError } from './api'
import type {
  ConsoleCommandPreview, LifecycleExecutionResult, PlayerCapabilitiesProjection, PlayerRoster, SessionUser
} from './model'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(URL, 'createObjectURL')
  Reflect.deleteProperty(URL, 'revokeObjectURL')
})

describe('role-aware control surfaces', () => {
  it('submits the explicitly selected login role and renders the returned bounded session', async () => {
    const onLogin = vi.fn()
    const operator = user('operator', ['console.read', 'console.command'])
    vi.spyOn(api, 'login').mockResolvedValue({ user: operator })

    render(<LoginScreen onLogin={onLogin} />)
    expect(screen.getByRole('button', { name: /Viewer/ }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: /Operator/ }))
    fireEvent.change(screen.getByLabelText('Operator 密码'), {
      target: { value: 'fictional-operator-password' }
    })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))

    await waitFor(() => expect(api.login).toHaveBeenCalledWith('operator', 'fictional-operator-password'))
    expect(onLogin).toHaveBeenCalledWith(operator)
  })

  it('shows the authenticated role in the top bar without treating the browser as the security boundary', () => {
    render(<TopBar provider="windows" environment="test" status={{ serverName: 'Fictional Windows Instance' }} user={user('operator', ['status.read'])}
      onLogout={() => undefined} mobileNavOpen={false} onToggleMobileNav={() => undefined} />)
    expect(screen.getByText('Operator · 日常运维')).not.toBeNull()
    expect(screen.getByTitle('退出登录 · Operator · 日常运维')).not.toBeNull()
    expect(screen.getByText('Fictional Windows Instance')).not.toBeNull()
    expect(screen.queryByText('DSP 主服务器')).toBeNull()
  })

  it('keeps every fixed console action disabled for a Viewer and exposes no command textbox', () => {
    vi.spyOn(api, 'consoleLogs').mockResolvedValue({ data: emptyLogPage() })
    render(<ConsoleWorkspace demo={false} user={user('viewer', ['console.read'])} />)

    for (const label of ['启动服务器', '保存服务器', '优雅停服', '受控重启']) {
      expect((screen.getByRole('button', { name: new RegExp(label) }) as HTMLButtonElement).disabled).toBe(true)
    }
    expect(screen.getByText('当前角色为只读模式')).not.toBeNull()
    expect(screen.queryByRole('textbox', { name: /命令/ })).toBeNull()
    expect(screen.getByText(/不接受任意文本命令/)).not.toBeNull()
  })

  it('previews one fixed Operator action, requires the exact confirmation, and renders its durable receipt', async () => {
    vi.spyOn(api, 'consoleLogs').mockResolvedValue({ data: emptyLogPage() })
    vi.spyOn(api, 'previewConsoleCommand').mockResolvedValue({ data: commandPreviewFixture })
    vi.spyOn(api, 'executeConsoleCommand').mockResolvedValue({ data: runningExecutionFixture })
    vi.spyOn(api, 'lifecycle').mockResolvedValue({ data: executionFixture })
    render(<ConsoleWorkspace demo={false} user={user('operator', [
      'console.read', 'console.export', 'console.command'
    ])} />)

    fireEvent.click(screen.getByRole('button', { name: /启动服务器/ }))
    await screen.findByText('启动服务器 · DRY RUN')
    const execute = screen.getByRole('button', { name: '确认并执行固定动作' }) as HTMLButtonElement
    expect(execute.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('控制台动作精确确认'), { target: { value: 'START_SERVER' } })
    expect(execute.disabled).toBe(false)
    fireEvent.click(execute)

    await screen.findByText('生命周期事务')
    expect(await screen.findByText('已完成', {}, { timeout: 2_000 })).not.toBeNull()
    expect(api.executeConsoleCommand).toHaveBeenCalledWith(
      'server.start', expect.stringMatching(/^server\.start:console:[0-9a-f-]{36}$/), 'START_SERVER'
    )
    expect(api.lifecycle).toHaveBeenCalledWith('job-fictional-console-start')
  })

  it('applies source and local time filters to polling and downloads with the same normalized window', async () => {
    vi.spyOn(api, 'consoleLogs').mockResolvedValue({ data: emptyLogPage() })
    vi.spyOn(api, 'downloadConsole').mockResolvedValue({
      blob: new Blob(['fictional']), fileName: 'dyson-console.ndjson', truncated: false
    })
    const createObjectUrl = vi.fn(() => 'blob:fictional-console')
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    render(<ConsoleWorkspace demo={false} user={user('operator', [
      'console.read', 'console.export', 'console.command'
    ])} />)

    await waitFor(() => expect(api.consoleLogs).toHaveBeenCalled())
    vi.mocked(api.consoleLogs).mockClear()
    const fromLocal = '2026-08-30T10:15'
    const toLocal = '2026-08-30T11:45'
    fireEvent.change(screen.getByLabelText('日志来源'), { target: { value: 'Nebula' } })
    fireEvent.change(screen.getByLabelText('日志开始时间'), { target: { value: fromLocal } })
    fireEvent.change(screen.getByLabelText('日志结束时间'), { target: { value: toLocal } })

    const expectedFilters = {
      source: 'Nebula',
      from: new Date(fromLocal).toISOString(),
      to: new Date(toLocal).toISOString()
    }
    await waitFor(() => expect(api.consoleLogs).toHaveBeenLastCalledWith(expect.objectContaining({
      start: 'tail', filters: expectedFilters
    })))
    fireEvent.click(screen.getByRole('button', { name: '导出' }))
    await waitFor(() => expect(api.downloadConsole).toHaveBeenCalledWith(expectedFilters))
    expect(createObjectUrl).toHaveBeenCalled()
  })

  it('applies the visible filters and clear action to the demo console stream', () => {
    render(<ConsoleWorkspace demo user={user('administrator', [
      'console.read', 'console.export', 'console.command'
    ])} />)

    fireEvent.change(screen.getByLabelText('搜索日志'), { target: { value: 'Nebula' } })
    expect(screen.getByText('Nebula websocket started on port 8469')).not.toBeNull()
    expect(screen.queryByText('Server started. Listening on 0.0.0.0:8469')).toBeNull()

    fireEvent.change(screen.getByLabelText('搜索日志'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('日志级别'), { target: { value: 'warning' } })
    expect(screen.getByText('Update preview available; activation is locked')).not.toBeNull()
    expect(screen.queryByText('Nebula websocket started on port 8469')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '清屏' }))
    expect(screen.getByText('当前筛选条件暂无新事件。')).not.toBeNull()
    expect(screen.queryByText('Update preview available; activation is locked')).toBeNull()
  })

  it('rejects an inverted console time window before polling or export', async () => {
    vi.spyOn(api, 'consoleLogs').mockResolvedValue({ data: emptyLogPage() })
    vi.spyOn(api, 'downloadConsole').mockResolvedValue({
      blob: new Blob(['fictional']), fileName: 'dyson-console.ndjson', truncated: false
    })
    render(<ConsoleWorkspace demo={false} user={user('operator', [
      'console.read', 'console.export', 'console.command'
    ])} />)
    await waitFor(() => expect(api.consoleLogs).toHaveBeenCalled())
    vi.mocked(api.consoleLogs).mockClear()
    fireEvent.change(screen.getByLabelText('日志开始时间'), { target: { value: '2026-08-30T12:00' } })
    fireEvent.change(screen.getByLabelText('日志结束时间'), { target: { value: '2026-08-30T11:00' } })

    expect((await screen.findByRole('alert')).textContent).toContain('开始时间不能晚于结束时间')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(api.consoleLogs).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: '导出' }) as HTMLButtonElement).disabled).toBe(true)
    expect(api.downloadConsole).not.toHaveBeenCalled()
  })

  it('renders roster availability and fixed signed capability reasons while every player action stays disabled', async () => {
    vi.spyOn(api, 'players').mockResolvedValue({ data: rosterFixture })
    vi.spyOn(api, 'playerCapabilities').mockResolvedValue({ data: capabilityFixture })
    render(<PlayerWorkspace demo={false} user={user('viewer', ['players.read'])} />)

    await screen.findByText('签名能力合同')
    expect(screen.getByText('ACTIONS LOCKED')).not.toBeNull()
    expect(screen.queryByText('ACTIONS ENABLED')).toBeNull()
    expect(screen.getByText('Roster 观察')).not.toBeNull()
    for (const label of ['Disconnect 断开', 'Kick 踢出', 'Ban 封禁', 'Whitelist 白名单', 'Blacklist 黑名单', 'Notice 通知', 'Permission 权限']) {
      expect(screen.getByText(label)).not.toBeNull()
    }
    expect(screen.getByText('Fictional kick contract is absent.')).not.toBeNull()
    expect((screen.getByRole('button', { name: '只读能力' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getAllByRole('button', { name: '不可用' })).toHaveLength(7)
    expect(screen.getAllByRole('button', { name: '不可用' }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true)
    expect(screen.getByText('FictionalPilot')).not.toBeNull()
    expect(screen.getByText('持久玩家会话事件')).not.toBeNull()
    expect(screen.getByText('SQLite 持久化 · 按服务端保留策略裁剪')).not.toBeNull()
    expect(screen.queryByText(/仅内存保存/)).toBeNull()
  })

  it('keeps the roster visible and all actions fail-closed when the capability projection returns 503', async () => {
    vi.spyOn(api, 'players').mockResolvedValue({ data: rosterFixture })
    vi.spyOn(api, 'playerCapabilities').mockRejectedValue(
      new ApiError(503, '玩家能力快照暂不可用', 'PLAYER_CAPABILITIES_UNAVAILABLE')
    )
    render(<PlayerWorkspace demo={false} user={user('viewer', ['players.read'])} />)

    await screen.findByText('FictionalPilot')
    expect(screen.getByText(/玩家能力快照暂不可用/)).not.toBeNull()
    expect(screen.getByText('能力状态不可用')).not.toBeNull()
    expect(screen.getByText(/disconnect、kick、ban、whitelist、blacklist、notice、permission 全部保持禁用/)).not.toBeNull()
  })
})

function user(role: SessionUser['role'], permissions: SessionUser['permissions']): SessionUser {
  return { name: role === 'administrator' ? 'Administrator' : role === 'operator' ? 'Operator' : 'Viewer', role, permissions }
}

const commandPreviewFixture: ConsoleCommandPreview = {
  mode: 'dry-run',
  command: 'server.start',
  label: '启动服务器',
  requiredConfirmation: 'START_SERVER',
  lifecycle: {
    collectedAt: '2026-08-30T12:00:00.000Z',
    action: 'start',
    mode: 'dry-run',
    allowed: true,
    executionEnabled: true,
    checks: [{ id: 'project-root', status: 'pass', message: 'Fictional project root verified' }],
    blockers: [],
    rollback: { strategy: 'no-op', ready: true, summary: 'Fictional no-op rollback' }
  }
}

const executionFixture: LifecycleExecutionResult = {
  job: {
    id: 'job-fictional-console-start', kind: 'game.start', state: 'succeeded', actor: 'Operator',
    createdAt: '2026-08-30T12:00:00.000Z', startedAt: '2026-08-30T12:00:01.000Z',
    finishedAt: '2026-08-30T12:00:02.000Z', durationMs: 1_000,
    summary: 'Fictional server started', errorCode: null
  },
  run: {
    jobId: 'job-fictional-console-start', action: 'start', idempotencyKey: 'server.start:console:fictional',
    requestId: '00000000-0000-4000-8000-000000000001', state: 'succeeded', currentPhase: null,
    protectionPointId: null, recoveryRequired: false,
    createdAt: '2026-08-30T12:00:00.000Z', updatedAt: '2026-08-30T12:00:02.000Z'
  },
  receipts: [{
    id: 'receipt-fictional-start', jobId: 'job-fictional-console-start', sequence: 1,
    phase: 'start', state: 'succeeded', startedAt: '2026-08-30T12:00:01.000Z',
    finishedAt: '2026-08-30T12:00:02.000Z', summary: 'Fictional fixed task accepted',
    errorCode: null, evidence: { taskVerified: true }
  }],
  reused: false
}

const runningExecutionFixture: LifecycleExecutionResult = {
  ...executionFixture,
  job: { ...executionFixture.job, state: 'running', finishedAt: null, durationMs: null },
  run: { ...executionFixture.run, state: 'running', currentPhase: 'start' },
  receipts: [{
    ...executionFixture.receipts[0]!, state: 'running', finishedAt: null,
    summary: 'Fictional fixed task is running'
  }]
}

const rosterFixture: PlayerRoster = {
  schemaVersion: 1, state: 'active', authoritative: true,
  observedAt: '2026-08-30T12:00:00.000Z', rosterGeneration: `roster-v1:${'a'.repeat(64)}`,
  sequence: 4, truncated: false, playerCount: 1,
  players: [{
    sessionPlayerId: 'player-fictional-0001', displayName: 'FictionalPilot', online: true,
    joinedAt: '2026-08-30T11:55:00.000Z', location: 'deep-space'
  }],
  lastKnownPlayers: [], recentEvents: []
}

const capabilityFixture: PlayerCapabilitiesProjection = {
  repository: 'FictionalOrg/nebula', tag: 'v0.0.0-fictional', runtimeFileVersion: '0.0.0.0',
  commit: 'f'.repeat(40), verificationScope: 'source-contract-only-runtime-unverified',
  actionsEnabled: false, observedAt: '2026-08-30T12:00:00.000Z',
  capabilities: [
    { capability: 'observe-roster', availability: 'available', mode: 'read-only', reasonCode: 'FICTIONAL_ROSTER_VERIFIED', reasonSummary: 'Fictional roster contract is verified.' },
    { capability: 'disconnect', availability: 'unavailable', mode: 'mutation', reasonCode: 'FICTIONAL_DISCONNECT_UNSAFE', reasonSummary: 'Fictional disconnect contract is unsafe.' },
    { capability: 'kick', availability: 'unavailable', mode: 'mutation', reasonCode: 'FICTIONAL_KICK_ABSENT', reasonSummary: 'Fictional kick contract is absent.' },
    { capability: 'ban', availability: 'unavailable', mode: 'mutation', reasonCode: 'FICTIONAL_BAN_ABSENT', reasonSummary: 'Fictional ban contract is absent.' },
    { capability: 'whitelist', availability: 'unavailable', mode: 'mutation', reasonCode: 'FICTIONAL_WHITELIST_ABSENT', reasonSummary: 'Fictional whitelist contract is absent.' },
    { capability: 'blacklist', availability: 'unavailable', mode: 'mutation', reasonCode: 'FICTIONAL_BLACKLIST_ABSENT', reasonSummary: 'Fictional blacklist contract is absent.' },
    { capability: 'notice', availability: 'unavailable', mode: 'mutation', reasonCode: 'FICTIONAL_NOTICE_ABSENT', reasonSummary: 'Fictional notice contract is absent.' },
    { capability: 'permission', availability: 'unavailable', mode: 'mutation', reasonCode: 'FICTIONAL_PERMISSION_ABSENT', reasonSummary: 'Fictional permission contract is absent.' }
  ]
}

function emptyLogPage() {
  return {
    schemaVersion: 1 as const,
    kind: 'bepinex-structured-log-page' as const,
    observedAt: '2026-08-30T12:00:00.000Z',
    cursor: 'console-v1:fictional', generation: 0, entries: [], transition: 'initial-tail' as const,
    hasMore: false, partialLinePending: false, scannedBytes: 0, filteredOut: 0, redactionVersion: 1 as const
  }
}

import {
  FormEvent, Suspense, lazy, useCallback, useEffect, useId, useMemo, useRef, useState,
  type ComponentType
} from 'react'
import {
  Activity, Archive, Boxes, Check, ChevronDown, CircleUserRound, ClipboardList,
  CircleMinus, CircleX, CloudDownload, Code2, Copy, Cpu, Database, Download, FileCog, FolderArchive,
  FileJson, Gamepad2, Gauge, GitBranch, HardDrive, History, Home, Menu, MemoryStick, PackageCheck, Play,
  LockKeyhole, PlugZap, RefreshCw, RotateCw, Save, ScanSearch, Server, Settings2,
  ShieldCheck, Square, TerminalSquare, TriangleAlert, Undo2, Users, Wrench
} from 'lucide-react'
import { api, ApiError } from './api'
import { formatDuration, formatUptime, relativeTime } from './format'
import { createUiRequestId } from './request-id'
import { ObservabilityQualificationPanel } from './ObservabilityQualificationPanel'
import { VersionUpdateWorkspace } from './VersionUpdateWorkspace'
import { ConfigHistoryWorkspace } from './ConfigHistoryWorkspace'
import { ModSupplyWorkspace } from './ModSupplyWorkspace'
import { QualifiedClientIssuePanel } from './QualifiedClientIssuePanel'
import { PlayerNoticeWorkspace } from './PlayerNoticeWorkspace'
import { PersistedSaveRecoveryLookup } from './PersistedSaveRecoveryLookup'
import { SaveRecoveryPanel } from './SaveRecoveryPanel'
import { SAVE_JOB_RECONCILE_CONFIRMATION } from './save-reconcile-contract'
import type {
  BackupCatalogItem, GameConfigEntry, GameConfigFileId, GameConfigPreview, GameConfigSnapshot,
  GameConfigTransactionResult,
  ConsoleCommandName, ConsoleCommandPreview, ControlPermission, ControlRole,
  JobRecord, LifecycleAction, LifecycleCheckId, LifecycleCheckStatus,
  LifecycleExecutionPhase, LifecycleExecutionResult, LifecyclePreview, NavKey,
  ClientProfileArchiveDownload, GeneratedClientProfile,
  ModDeploymentOperation, ModDeploymentPreview, ModDeploymentReceipt, ModDeploymentReceiptHistoryPage,
  ModDeploymentRecoveryDesired, ModDeploymentRecoveryPlan, ModDeploymentRecoveryStatus,
  ModDeploymentRequest, ModDeploymentStateSummary, ModServerLockEntry,
  ManagedModConfigurationInspection, ManagedModConfigurationPreview, ManagedModConfigurationReceipt,
  ManagedModConfigurationRequest, ManagedModConfigurationSchema,
  LateGameQualificationReport, ObservabilityQualificationEnvelope,
  NumericMetricAggregate, ObservabilityDownsamplePoint, ObservabilityDownsampleResult,
  ObservabilityAlertProjection, ObservabilityHealthStatus, ObservabilityHintCode, ObservabilityMetric,
  PlayerCapabilitiesProjection, PlayerCapabilityId, PlayerRoster, PublicPlayer, SavePairCatalogItem,
  ServerObservabilitySnapshot, ServerStatus, SessionUser, StructuredLogEntry,
  SaveJobExecutionResult, SaveTransactionResult, StructuredLogFilters, StructuredLogLevel
} from './model'

const SaveRetentionWorkspace = lazy(async () => {
  const module = await import('./SaveRetentionWorkspace')
  return { default: module.SaveRetentionWorkspace }
})
const SaveTransferWorkspace = lazy(async () => {
  const module = await import('./SaveTransferWorkspace')
  return { default: module.SaveTransferWorkspace }
})
const ObservabilityAlertPanel = lazy(async () => {
  const module = await import('./ObservabilityAlertPanel')
  return { default: module.ObservabilityAlertPanel }
})
const CutoverWorkspace = lazy(async () => {
  const module = await import('./CutoverWorkspace')
  return { default: module.CutoverWorkspace }
})
const TasksAuditWorkspace = lazy(async () => {
  const module = await import('./TasksAuditWorkspace')
  return { default: module.TasksAuditWorkspace }
})

const navGroups: Array<{ label: string; items: Array<{ key: NavKey; label: string; icon: ComponentType<{ size?: number }> }> }> = [
  { label: '运营', items: [
    { key: 'overview', label: '总览', icon: Home },
    { key: 'game', label: '游戏管理', icon: Gamepad2 },
    { key: 'console', label: '实时控制台', icon: TerminalSquare },
    { key: 'players', label: '玩家管理', icon: Users }
  ] },
  { label: '内容', items: [
    { key: 'versions', label: '版本更新', icon: CloudDownload },
    { key: 'mods', label: '模组管理', icon: Boxes },
    { key: 'saves', label: '存档管理', icon: FolderArchive },
    { key: 'client', label: '客户端包', icon: Archive }
  ] },
  { label: '系统', items: [
    { key: 'server', label: '服务器管理', icon: Server },
    { key: 'config', label: '配置管理', icon: FileCog },
    { key: 'cutover', label: '权威切换', icon: GitBranch },
    { key: 'tasks', label: '任务与审计', icon: ClipboardList }
  ] }
]

export function App() {
  const [session, setSession] = useState<SessionUser | null>(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    api.session().then((result) => setSession(result.user)).catch(() => undefined).finally(() => setChecking(false))
  }, [])

  if (checking) return <div className="boot-screen"><span className="spinner" />正在建立安全会话…</div>
  if (!session) return <LoginScreen onLogin={setSession} />
  return <ControlShell user={session} onLogout={() => setSession(null)} />
}

const loginRoles: Array<{ role: ControlRole; label: string; description: string }> = [
  { role: 'viewer', label: 'Viewer', description: '只读观察与审计' },
  { role: 'operator', label: 'Operator', description: '日常运行与备份' },
  { role: 'administrator', label: 'Administrator', description: '高风险变更与恢复' }
]

function hasPermission(user: SessionUser, permission: ControlPermission): boolean {
  return user.permissions.includes(permission)
}

function roleLabel(role: ControlRole): string {
  return role === 'administrator' ? 'Administrator · 高风险管理'
    : role === 'operator' ? 'Operator · 日常运维' : 'Viewer · 只读'
}

export function LoginScreen({ onLogin }: { onLogin: (user: SessionUser) => void }) {
  const [role, setRole] = useState<ControlRole>('viewer')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try { onLogin((await api.login(role, password)).user) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '登录失败') }
    finally { setBusy(false) }
  }

  return (
    <main className="login-screen">
      <section className="login-panel">
        <div className="brand-mark large"><OrbitMark /></div>
        <p className="login-product">Dyson Server Console</p>
        <h1>进入服务器控制台</h1>
        <p className="login-copy">以受控方式管理 DSP、Nebula、模组、存档与服务器生命周期。</p>
        <form onSubmit={submit}>
          <fieldset className="login-role-fieldset">
            <legend>选择访问角色</legend>
            <div className="login-role-grid">{loginRoles.map((item) => <button type="button" key={item.role}
              className={role === item.role ? 'selected' : ''} aria-pressed={role === item.role}
              onClick={() => setRole(item.role)}><strong>{item.label}</strong><small>{item.description}</small></button>)}</div>
          </fieldset>
          <label htmlFor="password">{loginRoles.find((item) => item.role === role)?.label} 密码</label>
          <input id="password" autoFocus autoComplete="current-password" type="password" value={password}
            onChange={(event) => setPassword(event.target.value)} placeholder="输入独立的面板密码" />
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary wide" disabled={busy || !password}>{busy ? '验证中…' : '登录'}</button>
        </form>
        <p className="login-footnote">角色密码彼此独立，也与 Nebula 游戏密码无关；服务器仍会逐请求校验权限。</p>
      </section>
    </main>
  )
}

function ControlShell({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const [active, setActive] = useState<NavKey>('overview')
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [provider, setProvider] = useState<'demo' | 'windows'>('demo')
  const [environment, setEnvironment] = useState<'development' | 'test' | 'production'>('development')
  const [jobs, setJobs] = useState<JobRecord[]>([])
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [lifecycleIntent, setLifecycleIntent] = useState<LifecycleAction | null>(null)

  const load = useCallback(async () => {
    const [statusResult, jobsResult] = await Promise.all([api.status(), api.jobs()])
    setStatus(statusResult.data); setProvider(statusResult.meta.provider)
    setEnvironment(statusResult.meta.environment); setJobs(jobsResult.data)
  }, [])

  useEffect(() => { load().catch((reason) => setError(reason instanceof Error ? reason.message : '状态加载失败')) }, [load])
  useEffect(() => {
    const events = new EventSource('/api/v1/events')
    const update = () => load().catch(() => undefined)
    events.addEventListener('job.updated', update)
    events.addEventListener('status.updated', update)
    return () => events.close()
  }, [load])

  async function refresh() {
    if (!hasPermission(user, 'status.refresh')) return
    setRefreshing(true); setError('')
    try { await api.refresh(); setTimeout(() => load().catch(() => undefined), 450) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '刷新失败') }
    finally { setRefreshing(false) }
  }

  async function logout() {
    try { await api.logout() } finally { onLogout() }
  }

  function selectPage(key: NavKey) {
    setActive(key)
    setMobileNavOpen(false)
    document.documentElement.scrollTop = 0
    document.body.scrollTop = 0
  }

  function openLifecycleWorkflow(action: LifecycleAction) {
    setLifecycleIntent(action)
    setActive('game')
    setMobileNavOpen(false)
    document.documentElement.scrollTop = 0
    document.body.scrollTop = 0
  }

  return (
    <div className="control-app">
      <TopBar provider={provider} environment={environment} user={user} onLogout={logout}
        status={status}
        mobileNavOpen={mobileNavOpen} onToggleMobileNav={() => setMobileNavOpen((open) => !open)} />
      <Sidebar active={active} onSelect={selectPage} mobileOpen={mobileNavOpen} provider={provider} status={status} />
      {mobileNavOpen && <button className="mobile-nav-backdrop" aria-label="关闭导航" onClick={() => setMobileNavOpen(false)} />}
      <main className="workspace">
        {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError('')}>关闭</button></div>}
        <RoleAccessRail user={user} />
        {!status ? <div className="loading-state"><span className="spinner" />正在读取服务器状态…</div> :
          active === 'overview'
            ? <Overview status={status} jobs={jobs} refreshing={refreshing} onRefresh={refresh}
              onLifecycleAction={openLifecycleWorkflow} onOpenTasks={() => selectPage('tasks')}
                onOpenSaves={() => selectPage('saves')}
                provider={provider} user={user} />
            : <FeatureWorkspace active={active} status={status} jobs={jobs} onRefresh={refresh}
                provider={provider} lifecycleIntent={lifecycleIntent} user={user} />}
      </main>
    </div>
  )
}

export function TopBar({ provider, environment, status, user, onLogout, mobileNavOpen, onToggleMobileNav }: {
  provider: 'demo' | 'windows'; environment: 'development' | 'test' | 'production'
  status?: Pick<ServerStatus, 'serverName'> | null
  user: SessionUser; onLogout: () => void; mobileNavOpen: boolean; onToggleMobileNav: () => void
}) {
  const environmentLabel = provider === 'demo'
    ? '演示环境'
    : environment === 'production'
      ? '生产环境'
      : environment === 'test' ? 'Windows 测试环境' : 'Windows 开发环境'
  return (
    <header className="topbar">
      <button className="mobile-nav-button" aria-label={mobileNavOpen ? '关闭导航' : '打开导航'}
        aria-expanded={mobileNavOpen} onClick={onToggleMobileNav}><Menu size={21} /></button>
      <div className="brand"><OrbitMark /><div><strong>Dyson Server Console</strong><span>自托管 DSP 多人服务器控制台</span></div></div>
      <div className="context-item"><span>实例名称</span><strong>{status?.serverName ?? (provider === 'demo' ? '演示实例' : '正在读取实例')} <i className="online-dot" /></strong></div>
      <div className="context-item"><span>环境</span><strong>{environmentLabel} <ChevronDown size={14} /></strong></div>
      <div className="context-item address"><span>连接地址</span><strong>{provider === 'demo' ? 'dsp.example.com:8469' : '由部署配置提供'} <Copy size={14} /></strong></div>
      <button className="user-menu" onClick={onLogout} title={`退出登录 · ${roleLabel(user.role)}`}><CircleUserRound size={20} /><span><strong>{user.name}</strong><small>{roleLabel(user.role)}</small></span><ChevronDown size={14} /></button>
    </header>
  )
}

function RoleAccessRail({ user }: { user: SessionUser }) {
  return <div className={`role-access-rail ${user.role}`}><LockKeyhole size={14} /><span><strong>{roleLabel(user.role)}</strong><small>{user.role === 'viewer'
    ? '所有服务器写入控件在界面中保持只读。'
    : user.role === 'operator' ? '可执行日常运行、保存与备份；恢复、模组发布和配置应用仍由管理员处理。'
      : '已显示管理员级高风险操作；每次请求仍由服务端重新授权。'}</small></span><em>前端提示不是安全边界</em></div>
}

function Sidebar({ active, onSelect, mobileOpen, provider, status }: {
  active: NavKey; onSelect: (key: NavKey) => void; mobileOpen: boolean
  provider: 'demo' | 'windows'; status: Pick<ServerStatus, 'serverName'> | null
}) {
  return (
    <aside className={`sidebar${mobileOpen ? ' mobile-open' : ''}`}>
      <nav aria-label="主要导航">
        {navGroups.map((group) => <div className="nav-group" key={group.label}>
          <p>{group.label}</p>
          {group.items.map(({ key, label, icon: Icon }) =>
            <button key={key} className={active === key ? 'active' : ''} onClick={() => onSelect(key)}>
              <Icon size={19} /><span>{label}</span>
            </button>)}
        </div>)}
      </nav>
      <div className="instance-card">
        <dl><div><dt>实例</dt><dd>{status?.serverName ?? '正在读取'}</dd></div><div><dt>状态来源</dt><dd>{provider === 'demo' ? 'Demo Provider' : 'Windows Provider'}</dd></div><div><dt>版本来源</dt><dd>发布清单</dd></div></dl>
        <span>独立控制平面 · 运行身份由部署状态提供</span>
      </div>
    </aside>
  )
}

function Overview({ status, jobs, refreshing, onRefresh, onLifecycleAction, onOpenTasks, onOpenSaves, provider, user }: {
  status: ServerStatus; jobs: JobRecord[]; refreshing: boolean; onRefresh: () => void
  onLifecycleAction: (action: LifecycleAction) => void; onOpenTasks: () => void; onOpenSaves: () => void
  provider: 'demo' | 'windows'; user: SessionUser
}) {
  return (
    <div className="overview page-enter">
      <div className="page-heading">
        <div><h1>服务器总览</h1><p>{provider === 'demo' ? '演示数据 · 不会操作真实服务器' : `最后采集 ${relativeTime(status.collectedAt)}`}</p></div>
        <OverviewLifecycleActions status={status} provider={provider} refreshing={refreshing}
          canExecute={hasPermission(user, 'lifecycle.execute')} canRefresh={hasPermission(user, 'status.refresh')}
          onRefresh={onRefresh} onLifecycleAction={onLifecycleAction} />
      </div>
      <StatusStrip status={status} />
      <div className="metrics-grid">
        <Metric title="CPU" value={status.runtime.processCoresUsed === null ? '—' : `${status.runtime.processCoresUsed.toFixed(1)} 核`} sub="进程平均占用" color="cyan" points={provider === 'demo' ? '2,40 14,33 27,36 39,25 52,31 65,24 78,28 91,20 104,26 118,18' : undefined} />
        <Metric title="内存" value={status.runtime.privateMemoryGiB === null ? '—' : `${status.runtime.privateMemoryGiB} GB`} sub="DSP 私有内存" color="cyan" kind="bars" points={provider === 'demo' ? '2,38 14,37 27,36 39,36 52,35 65,35 78,34 91,34 104,33 118,33' : undefined} />
        <Metric title="目标 UPS" value={status.runtime.targetUps?.toString() ?? '—'} sub="配置目标 · 非实测值" color="green" points={provider === 'demo' ? '2,24 14,24 27,24 39,24 52,24 65,24 78,24 91,24 104,24 118,24' : undefined} />
        <Metric title="线程" value={status.runtime.threadCount?.toString() ?? '—'} sub="DSP 活跃线程" color="amber" points={provider === 'demo' ? '2,34 14,28 27,32 39,22 52,30 65,25 78,31 91,23 104,29 118,26' : undefined} />
        <Metric title="进程" value={status.runtime.processId ? `PID ${status.runtime.processId}` : '未运行'} sub={status.state === 'running' ? `${status.runtime.priority ?? '默认'} 优先级` : '等待启动'} color="blue" points={provider === 'demo' ? '2,38 14,32 27,34 39,27 52,30 65,23 78,27 91,20 104,25 118,19' : undefined} />
      </div>
      <div className="operations-row">
        <ConsoleLogPanel demo={provider === 'demo'} canExport={hasPermission(user, 'console.export')} />
        <DeploymentPanel status={status} onRefresh={onRefresh} canRefresh={hasPermission(user, 'status.refresh')} />
      </div>
      <div className="bottom-row">
        <TaskTable jobs={jobs} onOpenTasks={onOpenTasks} />
        <SavePanel status={status} onOpenSaves={onOpenSaves} canBackup={hasPermission(user, 'saves.backup')} />
      </div>
    </div>
  )
}

export function OverviewLifecycleActions({
  status, provider, refreshing, onRefresh, onLifecycleAction, canExecute = true, canRefresh = true
}: {
  status: Pick<ServerStatus, 'state' | 'capabilities'>
  provider: 'demo' | 'windows'
  refreshing: boolean
  onRefresh: () => void
  onLifecycleAction: (action: LifecycleAction) => void
  canExecute?: boolean
  canRefresh?: boolean
}) {
  const demo = provider === 'demo'
  const canStart = canExecute && !demo && status.state === 'stopped' && status.capabilities.start
  const canStop = canExecute && !demo && status.state === 'running' && status.capabilities.gracefulStop
  const canRestart = canExecute && !demo && status.state === 'running' && status.capabilities.restart
  const disabledTitle = !canExecute ? '当前角色是只读角色，不能执行生命周期操作'
    : demo ? '演示环境禁止执行生命周期操作' : '当前状态或执行门禁不允许此操作'
  return <div className="heading-actions">
    <button className="success-action" disabled={!canStart} title={canStart ? '进入启动安全预检' : disabledTitle}
      onClick={() => onLifecycleAction('start')}><Play size={18} />启动</button>
    <button className="danger-action" disabled={!canStop} title={canStop ? '进入优雅停服安全预检' : disabledTitle}
      onClick={() => onLifecycleAction('graceful-stop')}><Square size={16} />停止</button>
    <button className="primary-action" disabled={!canRestart} title={canRestart ? '进入重启与回滚安全预检' : disabledTitle}
      onClick={() => onLifecycleAction('restart')}><RotateCw size={18} />重启</button>
    <button className="more-action" onClick={onRefresh} disabled={refreshing || !canRefresh}
      title={canRefresh ? '刷新服务器状态' : '当前角色没有刷新权限'}>
      <RefreshCw className={refreshing ? 'spin' : ''} size={17} />刷新
    </button>
  </div>
}

function StatusStrip({ status }: { status: ServerStatus }) {
  const items = [
    { label: '运行状态', value: stateLabel(status.state), sub: status.runtime.processId ? `PID: ${status.runtime.processId}` : '无活动进程', icon: Activity, tone: status.state === 'running' ? 'good' : 'muted' },
    { label: '游戏版本', value: status.versions.dsp ?? '待采集', sub: 'DSP Stable', icon: PackageCheck },
    { label: 'Nebula 版本', value: status.versions.nebula ?? '待采集', sub: compatibilityLabel(status), icon: PlugZap, tone: status.versions.warnings.length ? 'warn' : undefined },
    { label: '在线玩家', value: `${status.runtime.onlinePlayers ?? '—'} / ${status.runtime.maxPlayers ?? '—'}`, sub: '连接槽位', icon: Users },
    { label: '运行时间', value: status.state === 'running' ? formatUptime(status.runtime.uptimeSeconds) : '—', sub: `采集于 ${new Date(status.collectedAt).toLocaleTimeString('zh-CN')}`, icon: History },
    { label: '游戏链路', value: status.connections.find((item) => item.id === 'game-port')?.status === 'healthy' ? '可达' : '待检查', sub: gamePortDetail(status), icon: PlugZap, tone: status.connections.find((item) => item.id === 'game-port')?.status === 'healthy' ? 'good' : 'warn' },
    { label: '存储状态', value: status.save.consistent ? '正常' : '不完整', sub: status.save.name ?? '未发现存档', icon: HardDrive, tone: status.save.consistent ? 'good' : 'warn' }
  ]
  return <section className="status-strip">{items.map(({ label, value, sub, icon: Icon, tone }) =>
    <div className="status-item" key={label}><Icon size={19} /><span>{label}<strong className={tone}>{value}</strong><small>{sub}</small></span></div>)}</section>
}

export function Metric({ title, value, sub, color, points, kind = 'area' }: { title: string; value: string; sub: string; color: string; points?: string; kind?: 'area' | 'bars' }) {
  const fillId = `metric-fill-${useId().replace(/:/g, '')}`
  const coordinates = points?.split(' ').map((point) => point.split(',').map(Number)) ?? []
  const [lastX, lastY] = coordinates.at(-1) ?? [118, 24]
  const chartColor = ({ cyan: '#11d7ff', green: '#45e47b', amber: '#f1b83a', blue: '#168de8' } as const)[color as 'cyan' | 'green' | 'amber' | 'blue'] ?? '#11d7ff'
  return <section className="metric"><div className="metric-head"><strong>{title}</strong><span>{value}</span></div>
    {points ? <svg className="metric-chart" viewBox="0 0 120 48" preserveAspectRatio="none" aria-hidden="true" style={{ color: chartColor }}>
      <defs><linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".34" /><stop offset="1" stopColor="currentColor" stopOpacity=".035" /></linearGradient></defs>
      <g className="metric-chart-grid"><path d="M0 12H120M0 24H120M0 36H120" /><path d="M30 0V48M60 0V48M90 0V48" /></g>
      {kind === 'bars'
        ? <g className="metric-bars">{coordinates.map(([x, y], index) => {
          const height = Math.min(39, 15 + ((48 - y) * 1.4))
          return <rect key={index} x={x - 3.5} y={48 - height} width="7" height={height} />
        })}</g>
        : <><polygon className="metric-area" points={`${points} 118,48 2,48`} fill={`url(#${fillId})`} />
          <polyline className="metric-line" points={points} />
          <circle className="metric-node" cx={lastX} cy={lastY} r="2.1" /></>}
    </svg> : <div className="metric-chart-unavailable" aria-label="当前仅有单点快照">当前快照 · 暂无历史趋势</div>}<small>{sub}</small></section>
}

const demoLogs = [
  ['16:58:11.421', 'INFO', 'Server', 'Server started. Listening on 0.0.0.0:8469'],
  ['16:59:03.422', 'INFO', 'Nebula', 'Nebula websocket started on port 8469'],
  ['17:00:14.423', 'INFO', 'World', 'Loaded save DSP_Main_Save'],
  ['17:01:26.424', 'INFO', 'Player', "Player 'Orion' connected"],
  ['17:02:31.425', 'INFO', 'Save', 'Autosave completed; paired save verified'],
  ['17:03:41.426', 'WARN', 'Mods', 'Update preview available; activation is locked'],
  ['17:04:11.427', 'INFO', 'Backup', 'Latest paired backup manifest verified']
]

function ConsoleLogPanel({ demo, canExport }: { demo: boolean; canExport: boolean }) {
  const [entries, setEntries] = useState<StructuredLogEntry[]>([])
  const [demoCleared, setDemoCleared] = useState(false)
  const [level, setLevel] = useState<'all' | StructuredLogLevel>('all')
  const [source, setSource] = useState('')
  const [fromLocal, setFromLocal] = useState('')
  const [toLocal, setToLocal] = useState('')
  const [search, setSearch] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [state, setState] = useState<'connecting' | 'live' | 'error'>(demo ? 'live' : 'connecting')
  const [message, setMessage] = useState(demo ? '演示流' : '正在连接脱敏日志流…')
  const [downloading, setDownloading] = useState(false)
  const cursor = useRef<string | null>(null)
  const viewport = useRef<HTMLDivElement | null>(null)
  const normalizedSearch = search.trim()
  const normalizedSource = source.trim()
  const from = localDateTimeToIso(fromLocal)
  const to = localDateTimeToIso(toLocal)
  const invalidTimeRange = Boolean(from && to && from > to)
  const filters = useMemo<StructuredLogFilters>(() => ({
    ...(level === 'all' ? {} : { levels: [level] }),
    ...(normalizedSource ? { source: normalizedSource } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(normalizedSearch ? { text: normalizedSearch } : {})
  }), [from, level, normalizedSearch, normalizedSource, to])

  useEffect(() => {
    if (demo) return
    let cancelled = false
    let timer = 0
    cursor.current = null
    setEntries([])
    if (invalidTimeRange) {
      setState('error')
      setMessage('开始时间不能晚于结束时间')
      return
    }
    setState('connecting')
    setMessage('正在连接脱敏日志流…')

    const poll = async () => {
      try {
        const result = await api.consoleLogs({
          ...(cursor.current ? { cursor: cursor.current } : { start: 'tail' as const }),
          limit: 300, filters
        })
        if (cancelled) return
        cursor.current = result.data.cursor
        setEntries((current) => {
          const merged = [...current, ...result.data.entries]
          return [...new Map(merged.map((entry) => [entry.id, entry])).values()].slice(-800)
        })
        setState('live')
        setMessage(result.data.transition === 'rotated' ? '日志已轮转 · 已自动续接'
          : result.data.transition === 'truncated' ? '日志已截断 · 已从新代际续接'
            : `脱敏规则 v${result.data.redactionVersion} · 第 ${result.data.generation + 1} 代日志`)
        timer = window.setTimeout(poll, result.data.hasMore ? 80 : 1500)
      } catch (reason) {
        if (cancelled) return
        setState('error')
        setMessage(reason instanceof Error ? reason.message : '结构化日志暂不可用')
        timer = window.setTimeout(poll, 5000)
      }
    }
    timer = window.setTimeout(poll, 300)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [demo, filters, invalidTimeRange])

  useEffect(() => {
    if (autoScroll && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight
  }, [autoScroll, entries])

  async function download() {
    if (!canExport || invalidTimeRange) return
    setDownloading(true)
    try {
      const result = await api.downloadConsole(filters)
      const url = URL.createObjectURL(result.blob)
      const anchor = document.createElement('a')
      anchor.href = url; anchor.download = result.fileName; anchor.click()
      URL.revokeObjectURL(url)
      if (result.truncated) setMessage('下载已达到安全上限，文件中已标记为截断')
    } catch (reason) {
      setState('error'); setMessage(reason instanceof Error ? reason.message : '日志下载失败')
    } finally { setDownloading(false) }
  }

  const display = demo ? (demoCleared ? [] : demoLogs.map(([time, demoLevel, entrySource, text], index) => ({
    schemaVersion: 1 as const, id: `demo-${index}`, timestamp: `2026-08-30T${time}Z`,
    level: demoLevel === 'WARN' ? 'warning' as const : 'info' as const,
    source: entrySource, text, lineTruncated: false
  })).filter((entry) => (
    (level === 'all' || entry.level === level)
    && (!normalizedSource || entry.source.toLocaleLowerCase('en-US').includes(normalizedSource.toLocaleLowerCase('en-US')))
    && (!from || entry.timestamp >= from)
    && (!to || entry.timestamp <= to)
    && (!normalizedSearch || entry.text.toLocaleLowerCase('en-US').includes(normalizedSearch.toLocaleLowerCase('en-US')))
  ))) : entries

  return <section className="panel console-panel"><header><h2>实时服务器控制台</h2><div className="console-tools"><select aria-label="日志级别" value={level} onChange={(event) => setLevel(event.target.value as 'all' | StructuredLogLevel)}><option value="all">全部级别</option><option value="info">信息</option><option value="warning">警告</option><option value="error">错误</option><option value="fatal">严重</option><option value="debug">调试</option></select><input aria-label="搜索日志" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索脱敏日志…" /><label><input type="checkbox" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} />自动滚动</label><button onClick={() => demo ? setDemoCleared(true) : setEntries([])}>清屏</button><button onClick={download} disabled={demo || downloading || !canExport || invalidTimeRange} title={demo ? '演示环境不生成下载' : canExport ? '下载结构化脱敏日志' : '当前角色没有日志导出权限'}><Download size={14} />{downloading ? '导出中' : '导出'}</button></div></header>
    <div className="console-filter-row"><label>来源<input aria-label="日志来源" value={source} onChange={(event) => setSource(event.target.value)} placeholder="例如 Nebula" /></label><label>开始时间<input aria-label="日志开始时间" type="datetime-local" value={fromLocal} onChange={(event) => setFromLocal(event.target.value)} /></label><label>结束时间<input aria-label="日志结束时间" type="datetime-local" value={toLocal} onChange={(event) => setToLocal(event.target.value)} /></label><button type="button" onClick={() => { setSource(''); setFromLocal(''); setToLocal('') }}>清除范围</button>{invalidTimeRange && <span role="alert">开始时间不能晚于结束时间</span>}</div>
    <div className={`console-stream-state ${state}`}><span />{message}</div>
    <div ref={viewport} className="console-body" aria-label={demo ? '演示控制台日志' : '结构化脱敏控制台日志'}>{display.length
      ? display.map((entry) => <div className="console-line" key={entry.id}><time>{formatLogTime(entry.timestamp)}</time><b className={consoleLevelClass(entry.level)}>[{entry.level.toUpperCase()}]</b><em>[{entry.source}]</em><span>{entry.text}{entry.lineTruncated ? ' … [行已截断]' : ''}</span></div>)
      : <div className="console-empty"><b className="info">[STREAM]</b><em>[Console]</em>{state === 'live' ? '当前筛选条件暂无新事件。' : message}</div>}</div>
    <div className="console-fixed-boundary"><LockKeyhole size={14} />不接受任意文本命令；服务器动作只能从固定动作控制区发起。</div>
  </section>
}

function localDateTimeToIso(value: string): string | undefined {
  if (!value) return undefined
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined
}

const consoleCommandDefinitions: Array<{
  command: ConsoleCommandName
  label: string
  description: string
  icon: ComponentType<{ size?: number }>
}> = [
  { command: 'server.start', label: '启动服务器', description: '固定计划任务 + 运行复核', icon: Play },
  { command: 'server.save', label: '保存服务器', description: '签名游戏内保存回执', icon: Save },
  { command: 'server.stop', label: '优雅停服', description: '保存、保护点、端口复核', icon: Square },
  { command: 'server.restart', label: '受控重启', description: '停服与同存档恢复链', icon: RotateCw }
]

export function ConsoleWorkspace({ demo, user }: { demo: boolean; user: SessionUser }) {
  const [preview, setPreview] = useState<ConsoleCommandPreview | null>(null)
  const [confirmation, setConfirmation] = useState('')
  const [previewing, setPreviewing] = useState<ConsoleCommandName | null>(null)
  const [execution, setExecution] = useState<LifecycleExecutionResult | null>(null)
  const [executing, setExecuting] = useState(false)
  const [error, setError] = useState('')
  const pollGeneration = useRef(0)
  const canCommand = hasPermission(user, 'console.command')
  const canExport = hasPermission(user, 'console.export')

  useEffect(() => () => { pollGeneration.current += 1 }, [])

  async function previewCommand(command: ConsoleCommandName): Promise<void> {
    if (!canCommand || demo) return
    const generation = pollGeneration.current + 1
    pollGeneration.current = generation
    setPreviewing(command); setError(''); setExecution(null); setConfirmation('')
    try {
      const result = await api.previewConsoleCommand(command)
      if (pollGeneration.current === generation) setPreview(result.data)
    } catch (reason) {
      if (pollGeneration.current === generation) {
        setPreview(null)
        setError(reason instanceof ApiError ? reason.message : '固定控制台动作预演失败')
      }
    } finally {
      if (pollGeneration.current === generation) setPreviewing(null)
    }
  }

  async function executeCommand(): Promise<void> {
    if (!preview || !canCommand || demo || confirmation !== preview.requiredConfirmation || executing) return
    const generation = pollGeneration.current + 1
    pollGeneration.current = generation
    const idempotencyKey = `${preview.command}:console:${createUiRequestId()}`
    setExecuting(true); setError('')
    try {
      let result = (await api.executeConsoleCommand(
        preview.command,
        idempotencyKey,
        preview.requiredConfirmation
      )).data
      if (pollGeneration.current !== generation) return
      setExecution(result)
      for (let attempt = 0; attempt < 800 && ['queued', 'running'].includes(result.job.state); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 750))
        if (pollGeneration.current !== generation) return
        result = (await api.lifecycle(result.job.id)).data
        setExecution(result)
      }
      if (['queued', 'running'].includes(result.job.state)) {
        throw new Error('动作仍在后台运行，请在任务与审计页继续核对')
      }
    } catch (reason) {
      if (pollGeneration.current === generation) {
        setError(reason instanceof ApiError ? reason.message
          : reason instanceof Error ? reason.message : '固定控制台动作执行失败')
      }
    } finally {
      if (pollGeneration.current === generation) setExecuting(false)
    }
  }

  const activeChecks = preview?.lifecycle.checks.filter((check) => check.status !== 'not-applicable') ?? []
  const executable = Boolean(preview?.lifecycle.allowed && preview.lifecycle.executionEnabled)

  return <div className="console-workspace">
    <section className="console-command-deck">
      <header><div><span className="console-command-orbit"><TerminalSquare size={20} /></span><span><strong>固定动作控制</strong><small>仅四个类型化动作 · 不接收 PowerShell、参数或自由文本</small></span></div><em>{canCommand ? 'COMMAND PERMISSION' : 'READ ONLY'}</em></header>
      {!canCommand && <div className="permission-lock-note"><LockKeyhole size={15} /><span><strong>当前角色为只读模式</strong><small>Viewer 可以查看脱敏日志，但不能预演或执行服务器动作；服务端仍会独立校验每个请求。</small></span></div>}
      {demo && <div className="permission-lock-note"><LockKeyhole size={15} /><span><strong>演示环境禁止动作</strong><small>固定按钮只展示合同，不会请求真实服务器。</small></span></div>}
      <div className="console-command-grid">{consoleCommandDefinitions.map((item) => {
        const Icon = item.icon
        return <button type="button" key={item.command} disabled={!canCommand || demo || previewing !== null || executing}
          className={preview?.command === item.command ? 'selected' : ''}
          onClick={() => void previewCommand(item.command)}><Icon size={18} /><span><strong>{item.label}</strong><small>{item.description}</small></span>{previewing === item.command ? <RefreshCw className="spin" size={14} /> : <ScanSearch size={14} />}</button>
      })}</div>
      {error && <div className="console-command-error" role="alert"><TriangleAlert size={16} />{error}</div>}
      {preview && <section className="console-command-preview" aria-live="polite">
        <div className="console-command-preview-head"><div><ShieldCheck size={18} /><span><strong>{preview.label} · DRY RUN</strong><small>{activeChecks.length} 项有效检查 · {preview.lifecycle.blockers.length} 项阻断 · 回滚 {preview.lifecycle.rollback.ready ? '就绪' : '未就绪'}</small></span></div><b className={executable ? 'ready' : 'locked'}>{executable ? '可确认' : '保持锁定'}</b></div>
        <div className="console-confirm-row"><label><span>精确确认短语</span><code>{preview.requiredConfirmation}</code><input aria-label="控制台动作精确确认" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={preview.requiredConfirmation} /></label><button className="confirm-execute" type="button" disabled={!executable || confirmation !== preview.requiredConfirmation || executing} onClick={() => void executeCommand()}>{executing ? '回执轮询中…' : '确认并执行固定动作'}</button></div>
      </section>}
      {execution && <LifecycleExecutionPanel result={execution} busy={executing} />}
    </section>
    <ConsoleLogPanel demo={demo} canExport={canExport} />
  </div>
}

function formatLogTime(timestamp: string | null): string {
  if (!timestamp) return '--:--:--'
  const parsed = new Date(timestamp)
  return Number.isNaN(parsed.getTime()) ? '--:--:--' : parsed.toLocaleTimeString('zh-CN', { hour12: false })
}

function consoleLevelClass(level: StructuredLogLevel): string {
  if (level === 'warning') return 'warn'
  if (level === 'error' || level === 'fatal') return 'error'
  return level === 'info' || level === 'message' ? 'info' : 'muted'
}

function DeploymentPanel({ status, onRefresh, canRefresh }: {
  status: ServerStatus; onRefresh: () => void; canRefresh: boolean
}) {
  const versions = [
    { label: '游戏版本', value: status.versions.dsp, tone: 'good' },
    { label: 'BepInEx', value: status.versions.bepInEx, tone: 'good' },
    { label: 'Nebula', value: status.versions.nebula, tone: status.versions.warnings.length ? 'warn' : 'good' },
    { label: '运行兼容状态', value: compatibilityLabel(status), tone: status.versions.warnings.length ? 'warn' : 'good' }
  ] as const
  return <section className="panel deployment-panel"><header><h2>部署与版本</h2></header>
    <div className="version-list">
      {versions.map(({ label, value, tone }) =>
        <div key={label}><span>{label}</span><strong>{value ?? '待采集'}</strong><Check className={tone} size={15} /></div>)}
    </div>
    <div className="update-box"><div><strong>可用更新</strong><span>尚未执行在线检查</span></div><button onClick={onRefresh} disabled={!canRefresh} title={canRefresh ? '刷新清单' : '当前角色没有刷新权限'}><RefreshCw size={16} />刷新清单</button><p>更新只会进入预览；依赖、哈希、存档备份和回滚验证完成前无法激活。</p></div>
    <a className="panel-link">查看更新日志</a><a className="panel-link">版本锁定设置</a>
  </section>
}

function TaskTable({ jobs, onOpenTasks }: { jobs: JobRecord[]; onOpenTasks: () => void }) {
  return <section className="panel tasks-panel"><header><h2>任务与活动（最近 24 小时）</h2></header>
    <div className="table-wrap"><table><thead><tr><th>时间</th><th>任务</th><th>状态</th><th>耗时</th><th>触发者</th></tr></thead>
      <tbody>{jobs.length ? jobs.slice(0, 6).map((job) => <tr key={job.id}><td>{new Date(job.createdAt).toLocaleTimeString('zh-CN')}</td><td>{job.summary}</td><td><span className={`job-state ${job.state}`}>{job.state === 'succeeded' ? '成功' : job.state === 'failed' ? '失败' : job.state === 'running' ? '运行中' : '排队中'}</span></td><td>{formatDuration(job.durationMs)}</td><td>{job.actor}</td></tr>) : <tr><td colSpan={5} className="empty-cell">点击右上角刷新后，任务会在这里留下审计记录。</td></tr>}</tbody></table></div>
    <button className="text-link" onClick={onOpenTasks}>查看全部任务与审计日志</button>
  </section>
}

export function SavePanel({ status, onOpenSaves, canBackup }: {
  status: Pick<ServerStatus, 'save'>; onOpenSaves: () => void; canBackup: boolean
}) {
  return <section className="panel save-panel"><header><h2>存档与备份状态</h2></header>
    <div className="save-columns"><div><span>当前存档</span><strong>{status.save.name ?? '未发现'}</strong><dl><div><dt>配对状态</dt><dd>{status.save.dsvPresent ? '.dsv' : '缺少 .dsv'} + {status.save.serverPresent ? '.server' : '缺少 .server'}</dd></div><div><dt>最后保存</dt><dd>{relativeTime(status.save.lastSavedAt)} · {status.save.dsvSizeMiB === null ? '大小未知' : `${status.save.dsvSizeMiB} MiB`}</dd></div></dl></div>
      <div><span>完整性</span><strong className={status.save.consistent ? 'green' : 'amber'}>{status.save.consistent ? '已成对验证' : '需要处理'}</strong><dl><div><dt>最近备份</dt><dd>{status.save.backupPairPresent && status.save.backupManifestPresent ? relativeTime(status.save.latestBackupAt) : '尚无完整清单'}</dd></div><div><dt>恢复权限</dt><dd>当前锁定</dd></div></dl></div></div>
    <div className="save-actions"><button onClick={onOpenSaves}><FolderArchive size={17} />管理存档</button><button onClick={onOpenSaves} disabled={!canBackup} title={canBackup ? '进入备份预演与确认' : '当前角色没有备份权限'}><Database size={17} />进入备份预演</button></div>
  </section>
}

interface PendingSaveTransaction {
  kind: 'backup' | 'restore'
  saveName: string
  requestId: string
  backupId?: string
  expectedRevision?: string
  protectionRequestId?: string
  preview: SaveTransactionResult
  executionEnabled: boolean
}

function SaveCatalogWorkspace({ status, canBackup, canRestore, user, demo }: {
  status: ServerStatus; canBackup: boolean; canRestore: boolean; user: SessionUser; demo: boolean
}) {
  const [saves, setSaves] = useState<SavePairCatalogItem[]>([])
  const [backups, setBackups] = useState<BackupCatalogItem[]>([])
  const [saveCursor, setSaveCursor] = useState<string | null>(null)
  const [backupCursor, setBackupCursor] = useState<string | null>(null)
  const [totals, setTotals] = useState({ saves: 0, backups: 0 })
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [verifying, setVerifying] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingSaveTransaction | null>(null)
  const [receipt, setReceipt] = useState<SaveJobExecutionResult | null>(null)
  const [reconcileBlockedJobId, setReconcileBlockedJobId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setBusy(true); setError('')
    try {
      const [saveResult, backupResult] = await Promise.all([api.saves(), api.backups()])
      setSaves(saveResult.data.items); setBackups(backupResult.data.items)
      setSaveCursor(saveResult.data.page.nextCursor); setBackupCursor(backupResult.data.page.nextCursor)
      setTotals({ saves: saveResult.data.page.totalUnits, backups: backupResult.data.page.totalUnits })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '存档目录加载失败')
    } finally { setBusy(false) }
  }, [])

  useEffect(() => { load().catch(() => undefined) }, [load])

  async function loadMore(kind: 'saves' | 'backups') {
    try {
      if (kind === 'saves' && saveCursor) {
        const result = await api.saves(saveCursor)
        setSaves((current) => [...current, ...result.data.items]); setSaveCursor(result.data.page.nextCursor)
      }
      if (kind === 'backups' && backupCursor) {
        const result = await api.backups(backupCursor)
        setBackups((current) => [...current, ...result.data.items]); setBackupCursor(result.data.page.nextCursor)
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : '下一页加载失败') }
  }

  async function verify(backupId: string) {
    setVerifying(backupId); setError('')
    try {
      const result = await api.verifyBackup(backupId)
      setBackups((current) => current.map((item) => item.backupId === backupId ? result.data : item))
    } catch (reason) { setError(reason instanceof Error ? reason.message : '备份校验失败') }
    finally { setVerifying(null) }
  }

  async function previewBackup(saveName: string) {
    if (!canBackup) return
    setActionBusy(`backup:${saveName}`); setError(''); setReceipt(null)
    try {
      const requestId = createUiRequestId()
      const result = await api.previewSaveBackup(requestId, saveName)
      setPending({
        kind: 'backup', saveName, requestId,
        preview: result.data, executionEnabled: result.meta.executionEnabled
      })
    } catch (reason) { setError(reason instanceof Error ? reason.message : '备份预览失败') }
    finally { setActionBusy(null) }
  }

  async function previewRestore(backup: BackupCatalogItem) {
    if (!canRestore) return
    if (!backup.saveName || backup.health !== 'healthy') {
      setError('只有身份明确且完整性校验通过的保护点才能恢复。')
      return
    }
    if (status.state !== 'stopped') {
      setError('恢复预览已锁定：请先通过游戏管理优雅停服，并确认游戏端口停止监听。')
      return
    }
    setActionBusy(`restore:${backup.backupId}`); setError(''); setReceipt(null)
    try {
      const requestId = createUiRequestId()
      const protectionRequestId = createUiRequestId()
      const revision = await api.saveRevision(backup.saveName)
      const result = await api.previewSaveRestore({
        requestId, backupId: backup.backupId,
        expectedRevision: revision.data.revision, protectionRequestId
      })
      setPending({
        kind: 'restore', saveName: backup.saveName, requestId,
        backupId: backup.backupId, expectedRevision: revision.data.revision,
        protectionRequestId, preview: result.data,
        executionEnabled: result.meta.executionEnabled
      })
    } catch (reason) { setError(reason instanceof Error ? reason.message : '恢复预览失败') }
    finally { setActionBusy(null) }
  }

  async function executePending() {
    if (!pending || !pending.executionEnabled || (pending.kind === 'backup' ? !canBackup : !canRestore)) return
    setActionBusy('execute'); setError('')
    let accepted: SaveJobExecutionResult | null = null
    try {
      const result = pending.kind === 'backup'
        ? await api.executeSaveBackup(pending.requestId, pending.saveName)
        : await api.executeSaveRestore({
            requestId: pending.requestId,
            backupId: pending.backupId!,
            expectedRevision: pending.expectedRevision!,
            protectionRequestId: pending.protectionRequestId!
          })
      accepted = result.data
      setReceipt(accepted); setPending(null)
      for (let attempt = 0; attempt < 2400 && ['queued', 'running'].includes(accepted.run.state); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        accepted = (await api.saveJob(accepted.job.id)).data
        setReceipt(accepted)
      }
      if (accepted.run.state === 'succeeded') await load()
      else if (['queued', 'running'].includes(accepted.run.state)) {
        setError('存档任务仍在后台运行；可在任务与审计页继续查看，不要重复提交。')
      } else {
        setError(accepted.run.recoveryRequired
          ? `存档任务进入人工核验状态（${accepted.run.errorCode ?? '未知错误'}）。请勿覆盖当前存档。`
          : `存档任务未完成（${accepted.run.errorCode ?? '未知错误'}）。`)
      }
    } catch (reason) {
      setError(accepted
        ? '存档任务已受理，但浏览器状态查询中断；后台任务不会因此取消，请到任务与审计页核对。'
        : reason instanceof Error ? reason.message : '存档事务提交失败')
    }
    finally { setActionBusy(null) }
  }

  async function refreshRecoveryJob(jobId: string) {
    setActionBusy(`refresh-recovery:${jobId}`); setError('')
    try {
      const current = (await api.saveJob(jobId)).data
      setReceipt(current)
      setReconcileBlockedJobId(null)
      if (current.run.state === 'succeeded') await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法读取该存档作业；请保留存档对与事务证据。')
    } finally {
      setActionBusy(null)
    }
  }

  async function reconcileRecoveryJob(
    jobId: string,
    confirmation: typeof SAVE_JOB_RECONCILE_CONFIRMATION
  ) {
    if (!canRestore || reconcileBlockedJobId === jobId) return
    setActionBusy(`reconcile:${jobId}`); setError('')
    let accepted: SaveJobExecutionResult | null = null
    try {
      accepted = (await api.reconcileSaveJob(jobId, confirmation)).data
      setReceipt(accepted)
      for (let attempt = 0; attempt < 2400 && ['queued', 'running'].includes(accepted.run.state); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        accepted = (await api.saveJob(jobId)).data
        setReceipt(accepted)
      }
      if (accepted.run.state === 'succeeded') {
        setReconcileBlockedJobId(null)
        await load()
      } else if (['queued', 'running'].includes(accepted.run.state)) {
        setError('持久化对账仍在后台执行；这里只会继续查询同一作业，绝不会重新提交授权。')
      } else {
        setReconcileBlockedJobId(jobId)
        setError(accepted.run.recoveryRequired
          ? `对账后仍需要人工核验（${accepted.run.errorCode ?? '未知错误'}）；已禁止再次提交。`
          : `持久化对账未完成（${accepted.run.errorCode ?? '未知错误'}）。`)
      }
    } catch (reason) {
      const ambiguous = !(reason instanceof ApiError) ||
        (reason.status === 502 && reason.code === 'SAVE_JOB_BROWSER_RESPONSE_INVALID')
      const conflict = reason instanceof ApiError && reason.status === 409
      if (ambiguous || conflict) {
        setReconcileBlockedJobId(jobId)
        try {
          const current = (await api.saveJob(jobId)).data
          setReceipt(current)
        } catch {
          // Preserve the last strict receipt and the job ID; never repeat a possibly accepted mutation.
        }
      }
      if (ambiguous) {
        setError('对账请求结果未知；已查询同一作业并禁止再次提交。请先手动刷新，勿盲目重试。')
      } else if (conflict) {
        setError(reason.code === 'SAVE_JOB_RECONCILE_NOT_ALLOWED'
          ? '服务端最新终态不允许自动对账；已锁定操作，请保留现场并人工核验。'
          : '作业状态已并发变化；已刷新同一作业并锁定再次提交。')
      } else {
        setError(reason instanceof Error ? reason.message : '存档对账请求失败。')
      }
    } finally {
      setActionBusy(null)
    }
  }

  if (busy) return <div className="loading-state compact"><span className="spinner" />正在建立存档与备份目录…</div>
  return <div className="catalog-workspace">
    <div className="workspace-toolbar"><div><strong>配对存档目录</strong><span>.dsv 与 .server 始终作为一个单元</span></div><button onClick={load}><RefreshCw size={16} />重新扫描</button></div>
    {!canBackup && <div className="permission-lock-note"><LockKeyhole size={15} /><span><strong>只读存档会话</strong><small>当前角色可以浏览和校验清单，但不能创建备份或恢复保护点。</small></span></div>}
    {canBackup && !canRestore && <div className="permission-lock-note operator"><LockKeyhole size={15} /><span><strong>Operator 日常权限</strong><small>允许创建保护点；恢复会覆盖当前存档，只对 Administrator 开放。</small></span></div>}
    {error && <div className="inline-error"><TriangleAlert size={17} />{error}</div>}
    {receipt && <div className={`save-transaction-success ${receipt.run.state}`}>
      {receipt.run.state === 'succeeded' ? <ShieldCheck size={18} />
        : ['queued', 'running'].includes(receipt.run.state) ? <RefreshCw className="spin" size={18} />
          : <TriangleAlert size={18} />}
      <span><strong>{saveJobTitle(receipt)}</strong><small>{saveJobDetail(receipt)}</small></span>
      <button onClick={() => setReceipt(null)}>关闭</button>
    </div>}
    <PersistedSaveRecoveryLookup
      disabled={demo || !canRestore}
      onLoaded={(execution) => {
        setReceipt(execution)
        setReconcileBlockedJobId(null)
      }}
    />
    <SaveRecoveryPanel
      currentJob={receipt}
      role={user.role}
      busy={actionBusy === `reconcile:${receipt?.job.id}` || actionBusy === `refresh-recovery:${receipt?.job.id}`}
      reconcileDisabled={receipt !== null && reconcileBlockedJobId === receipt.job.id}
      reconcileDisabledReason="该请求可能已被服务端接受或终态已经变化；请先刷新同一作业，确认最新持久状态。"
      onReconcile={reconcileRecoveryJob}
      onRefresh={refreshRecoveryJob}
    />
    <div className="catalog-summary">
      <div><span>存档单元</span><strong>{totals.saves}</strong><small>{saves.filter((item) => item.health === 'healthy').length} 个当前页健康</small></div>
      <div><span>保护点</span><strong>{totals.backups}</strong><small>{backups.filter((item) => item.health === 'healthy').length} 个当前页已验证</small></div>
      <div><span>恢复门禁</span><strong className={status.state === 'stopped' ? 'green' : 'amber'}>{status.state === 'stopped' ? '可预览' : '等待停服'}</strong><small>执行还需独立配置开关与二次确认</small></div>
    </div>
    <Suspense fallback={<div className="loading-state compact"><span className="spinner" />正在装载存档扩展工作区…</div>}>
      <SaveRetentionWorkspace backups={backups} user={user} demo={demo} onCatalogChanged={load} />
      <SaveTransferWorkspace backups={backups} user={user} />
    </Suspense>
    {pending && <section className="save-transaction-confirm" role="alertdialog" aria-labelledby="save-transaction-title">
      <div className="transaction-orbit"><Database size={20} /></div>
      <div><strong id="save-transaction-title">确认{pending.kind === 'backup' ? '创建原子保护点' : '恢复已验证保护点'}</strong>
        <span>{pending.saveName} · {formatBytes(pending.preview.pairBytes)}</span>
        <small>{pending.kind === 'backup'
          ? '预览已完成；.dsv 与 .server 将在同一事务中流式校验并原子发布。'
          : '执行前会再次验证停服状态和存档 revision，并先保护当前存档；部分失败会自动回滚两个文件。'}</small>
        {!pending.executionEnabled && <em>当前实例只允许预览；DYSON_SAVE_MUTATIONS_ENABLED 仍为关闭状态。</em>}
      </div>
      <div className="save-confirm-actions"><button onClick={() => setPending(null)}>取消</button><button className="confirm-execute" disabled={!pending.executionEnabled || actionBusy === 'execute' || (pending.kind === 'backup' ? !canBackup : !canRestore)} onClick={executePending}>{actionBusy === 'execute' ? '执行中…' : '确认执行'}</button></div>
    </section>}
    <section className="catalog-section"><header><div><Save size={17} /><strong>游戏存档</strong></div><span>逻辑名称 · 配对状态 · 最近写入</span></header>
      <div className="catalog-list">{saves.length ? saves.map((item) => <div className="catalog-row" key={item.id}>
        <span className={`catalog-health ${item.health}`}>{healthLabel(item.health)}</span>
        <div className="catalog-identity"><strong>{item.name}</strong><small>{relativeTime(item.lastModifiedAt)} · {formatBytes(item.totalBytes)}</small></div>
        <div className="pair-evidence"><span className={item.dsv ? 'present' : 'missing'}>.dsv {item.dsv ? formatBytes(item.dsv.bytes) : '缺失'}</span><span className={item.server ? 'present' : 'missing'}>.server {item.server ? formatBytes(item.server.bytes) : '缺失'}</span></div>
        <button onClick={() => previewBackup(item.name)} disabled={!canBackup || item.health !== 'healthy' || actionBusy === `backup:${item.name}`} title={!canBackup ? '当前角色没有备份权限' : item.health === 'healthy' ? '先生成无写入预览' : '存档对不完整'}><Database size={15} />{actionBusy === `backup:${item.name}` ? '预览中' : '创建备份'}</button>
      </div>) : <div className="catalog-empty">尚未发现任何配对存档。</div>}</div>
      {saveCursor && <button className="catalog-more" onClick={() => loadMore('saves')}>加载更多存档</button>}
    </section>
    <section className="catalog-section"><header><div><FolderArchive size={17} /><strong>哈希保护点</strong></div><span>逐个流式校验，避免大型后期存档造成磁盘突发</span></header>
      <div className="catalog-list">{backups.length ? backups.map((item) => <div className="catalog-row backup" key={item.backupId}>
        <span className={`catalog-health ${item.health}`}>{healthLabel(item.health)}</span>
        <div className="catalog-identity"><strong>{item.saveName ?? '清单不可读'}</strong><small>{item.createdAt ? relativeTime(item.createdAt) : '时间未知'} · {formatBytes(item.totalBytes)}</small></div>
        <div className="manifest-evidence"><span>{item.manifestValid ? <Check size={14} /> : <TriangleAlert size={14} />}清单</span><span>{item.pairPresent ? <Check size={14} /> : <TriangleAlert size={14} />}存档对</span></div>
        <div className="catalog-row-actions"><button onClick={() => verify(item.backupId)} disabled={verifying === item.backupId}><ScanSearch className={verifying === item.backupId ? 'spin' : ''} size={15} />校验</button><button onClick={() => previewRestore(item)} disabled={!canRestore || item.health !== 'healthy' || status.state !== 'stopped' || actionBusy === `restore:${item.backupId}`} title={!canRestore ? '恢复仅对 Administrator 开放' : status.state === 'stopped' ? '先生成无写入恢复预览' : '必须先优雅停服'}><Undo2 size={15} />{actionBusy === `restore:${item.backupId}` ? '预览中' : '恢复'}</button></div>
      </div>) : <div className="catalog-empty">尚未发现事务保护点。</div>}</div>
      {backupCursor && <button className="catalog-more" onClick={() => loadMore('backups')}>加载更多保护点</button>}
    </section>
  </div>
}

function saveJobTitle(receipt: SaveJobExecutionResult): string {
  const action = receipt.run.operation === 'backup' ? '配对备份' : '受控恢复'
  if (receipt.run.state === 'queued') return `${action}已排队`
  if (receipt.run.state === 'running') return `${action}执行中`
  if (receipt.run.state === 'succeeded') return `${action}已完成`
  if (receipt.run.state === 'interrupted') return `${action}需要人工核验`
  return `${action}未完成`
}

function saveJobDetail(receipt: SaveJobExecutionResult): string {
  const result = receipt.run.result
  const recovery = receipt.run.recoveryRequired ? ' · 需要持久化核验，禁止盲目重试' : ''
  const error = receipt.run.errorCode ? ` · ${receipt.run.errorCode}` : ''
  if (result) {
    const reuse = receipt.reused || result.reused ? ' · 复用幂等结果' : ''
    const cleanup = result.cleanupPending ? ' · 清理待完成' : ''
    const maintenance = result.maintenanceRequired ? ' · 需要维护' : ''
    return `${formatBytes(result.pairBytes)} · 审计${result.auditStored ? '已持久化' : '待核验'} · 尝试 ${receipt.run.attemptCount}${reuse}${cleanup}${maintenance}${error}${recovery}`
  }
  return `任务 ${receipt.job.id.slice(0, 8)} · 尝试 ${receipt.run.attemptCount}${error}${recovery}`
}

export function PlayerWorkspace({ demo, user }: { demo: boolean; user: SessionUser }) {
  const [roster, setRoster] = useState<PlayerRoster | null>(demo ? demoPlayerRoster : null)
  const [capabilities, setCapabilities] = useState<PlayerCapabilitiesProjection | null>(
    demo ? demoPlayerCapabilities : null
  )
  const [busy, setBusy] = useState(!demo)
  const [rosterError, setRosterError] = useState('')
  const [capabilityError, setCapabilityError] = useState('')

  const load = useCallback(async (signal?: AbortSignal) => {
    if (demo) {
      setRoster(demoPlayerRoster); setCapabilities(demoPlayerCapabilities); setBusy(false)
      return true
    }
    const [rosterResult, capabilityResult] = await Promise.allSettled([
      api.players(signal), api.playerCapabilities(signal)
    ])
    if (signal?.aborted) return false
    if (rosterResult.status === 'fulfilled') {
      setRoster(rosterResult.value.data); setRosterError('')
    } else {
      setRosterError(rosterResult.reason instanceof Error
        ? rosterResult.reason.message : '玩家会话快照暂不可用')
    }
    if (capabilityResult.status === 'fulfilled') {
      setCapabilities(capabilityResult.value.data); setCapabilityError('')
    } else {
      setCapabilityError(capabilityResult.reason instanceof Error
        ? capabilityResult.reason.message : '签名玩家能力快照暂不可用')
    }
    setBusy(false)
    return rosterResult.status === 'fulfilled' && capabilityResult.status === 'fulfilled'
  }, [demo])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    if (demo) return () => controller.abort()
    const timer = window.setInterval(() => void load(controller.signal), 5_000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [demo, load])

  if (busy) return <div className="loading-state compact"><span className="spinner" />正在并行验证玩家清单与签名能力快照…</div>
  const players = roster ? roster.players ?? roster.lastKnownPlayers : []
  return <div className="player-workspace">
    <div className="workspace-toolbar"><div><strong>Nebula 玩家与能力</strong><span>{roster?.authoritative ? `清单 #${roster.sequence} · ${relativeTime(roster.observedAt)}` : '不会把不可用推断为 0 人在线'}</span></div><button onClick={() => void load()}><RefreshCw size={16} />刷新两份快照</button></div>
    {rosterError && <div className="inline-warning"><TriangleAlert size={17} />{rosterError}；保留最后一次可信玩家显示，不推断玩家已离线。</div>}
    {capabilityError && <div className="inline-warning"><TriangleAlert size={17} />{capabilityError}；所有玩家管理动作继续 fail-closed。</div>}

    {capabilities ? <section className="player-capability-panel">
      <header><div><ShieldCheck size={17} /><span><strong>签名能力合同</strong><small>{capabilities.repository} · {capabilities.tag} · runtime {capabilities.runtimeFileVersion}</small></span></div><b>{capabilities.actionsEnabled ? 'SIGNED ACTION CONTRACT' : 'ACTIONS LOCKED'}</b></header>
      <div className="player-capability-evidence"><div><span>COMMIT</span><code>{capabilities.commit}</code></div><div><span>验证范围</span><strong>{capabilities.verificationScope}</strong></div><div><span>观测时间</span><strong>{relativeTime(capabilities.observedAt)}</strong></div></div>
      <div className="player-capability-grid">{capabilities.capabilities.map((entry) => <div key={entry.capability} className={entry.availability}>
        <span className="capability-signal">{entry.availability === 'available' ? <Check size={15} /> : <LockKeyhole size={15} />}</span>
        <div><strong>{playerCapabilityLabel(entry.capability)}</strong><small>{entry.reasonSummary}</small><code>{entry.reasonCode}</code></div>
        <button type="button" disabled title={entry.reasonSummary}>{entry.capability === 'observe-roster' ? '只读能力' : entry.capability === 'notice' && entry.availability === 'available' ? '固定模板' : '不可用'}</button>
      </div>)}</div>
    </section> : <section className="player-capability-panel unavailable"><TriangleAlert size={22} /><div><strong>能力状态不可用</strong><small>缺少经过签名验证的 public projection；disconnect、kick、ban、whitelist、blacklist、notice、permission 全部保持禁用。</small></div></section>}

    {roster ? <>
      <div className="player-summary"><div><span>会话状态</span><strong className={roster.authoritative ? 'green' : 'amber'}>{roster.state === 'active' ? '活跃' : roster.state === 'inactive' ? '未运行' : '未知'}</strong></div><div><span>在线玩家</span><strong>{roster.playerCount ?? '—'}</strong></div><div><span>快照完整性</span><strong className={roster.truncated ? 'amber' : 'green'}>{roster.truncated ? '已达到 64 人上限' : '完整'}</strong></div></div>
      <section className="player-table-section"><header><div><Users size={17} /><strong>{roster.authoritative ? '当前在线清单' : '最后已知清单'}</strong></div><span>仅会话身份 · 不返回 IP、Steam ID 或 player.key</span></header>
        <div className="player-table-head"><span>玩家</span><span>会话编号</span><span>位置摘要</span><span>加入时间</span><span>管理动作</span></div>
        <div className="player-list">{players.length ? players.map((player) => <PlayerRow player={player} key={player.sessionPlayerId} authoritative={roster.authoritative} />) : <div className="catalog-empty">{roster.authoritative ? '当前没有在线玩家。' : '没有可验证的最后已知清单。'}</div>}</div>
      </section>
      <PlayerNoticeWorkspace roster={roster} capabilities={capabilities} user={user} demo={demo}
        evidenceCurrent={!rosterError && !capabilityError}
        onRefresh={() => load()} />
      <section className="presence-history"><header><div><History size={17} /><strong>持久玩家会话事件</strong></div><span>SQLite 持久化 · 按服务端保留策略裁剪</span></header><div>{roster.recentEvents.length ? roster.recentEvents.slice(-12).reverse().map((event) => <div key={event.sequence}><span className={event.type}>{event.type === 'join' ? '加入' : '离开'}</span><strong>{event.player.displayName}</strong><small>{relativeTime(event.occurredAt)}</small></div>) : <p>尚无可验证的加入/离开差分。</p>}</div></section>
    </> : <div className="players-empty"><Users size={38} /><strong>玩家状态未知</strong><p>{rosterError || '尚未收到可信玩家快照；不会把不可用误报为 0 人在线。'}</p><button onClick={() => void load()}>重试</button></div>}
  </div>
}

function PlayerRow({ player, authoritative }: { player: PublicPlayer; authoritative: boolean }) {
  return <div className="player-row"><div className="player-name"><span>{player.displayName.slice(0, 1).toUpperCase()}</span><strong>{player.displayName}</strong></div><code>{player.sessionPlayerId}</code><span>{locationLabel(player.location)}</span><span>{relativeTime(player.joinedAt)}</span><div><button disabled title="Nebula 暂无稳定踢出契约">踢出</button><button disabled title="Nebula 暂无稳定封禁契约">封禁</button>{!authoritative && <em>非实时</em>}</div></div>
}

function locationLabel(location: string): string {
  if (location === 'deep-space') return '深空'
  if (location.startsWith('planet:')) return `行星 ${location.slice(7)}`
  if (location.startsWith('star:')) return `恒星 ${location.slice(5)}`
  return '未知'
}

function playerCapabilityLabel(capability: PlayerCapabilityId): string {
  return ({
    'observe-roster': 'Roster 观察',
    disconnect: 'Disconnect 断开',
    kick: 'Kick 踢出',
    ban: 'Ban 封禁',
    whitelist: 'Whitelist 白名单',
    blacklist: 'Blacklist 黑名单',
    notice: 'Notice 通知',
    permission: 'Permission 权限'
  } satisfies Record<PlayerCapabilityId, string>)[capability]
}

const demoPlayerCapabilities: PlayerCapabilitiesProjection = {
  repository: 'FictionalNebula/nebula',
  tag: 'v0.0.0-fictional',
  runtimeFileVersion: '0.0.0.0',
  commit: 'f'.repeat(40),
  verificationScope: 'source-contract-only-runtime-unverified',
  actionsEnabled: false,
  observedAt: '2026-08-30T10:05:00.000+08:00',
  capabilities: [
    { capability: 'observe-roster', availability: 'available', mode: 'read-only', reasonCode: 'FICTIONAL_ROSTER_VERIFIED', reasonSummary: 'Fictional fixture exposes a bounded read-only roster.' },
    { capability: 'disconnect', availability: 'unavailable', mode: 'mutation', reasonCode: 'FICTIONAL_DISCONNECT_UNSAFE', reasonSummary: 'Fictional connected-player disconnect is not verified safe.' },
    { capability: 'kick', availability: 'unavailable', mode: 'mutation', reasonCode: 'FICTIONAL_KICK_ABSENT', reasonSummary: 'Fictional runtime exposes no dedicated kick contract.' },
    { capability: 'ban', availability: 'unavailable', mode: 'mutation', reasonCode: 'FICTIONAL_BAN_ABSENT', reasonSummary: 'Fictional runtime exposes no persistent ban contract.' },
    { capability: 'whitelist', availability: 'unavailable', mode: 'mutation', reasonCode: 'FICTIONAL_WHITELIST_ABSENT', reasonSummary: 'Fictional runtime exposes no whitelist contract.' },
    { capability: 'blacklist', availability: 'unavailable', mode: 'mutation', reasonCode: 'FICTIONAL_BLACKLIST_ABSENT', reasonSummary: 'Fictional runtime exposes no blacklist persistence contract.' },
    { capability: 'notice', availability: 'unavailable', mode: 'mutation', reasonCode: 'FICTIONAL_NOTICE_ABSENT', reasonSummary: 'Fictional runtime exposes no acknowledged player-notice contract.' },
    { capability: 'permission', availability: 'unavailable', mode: 'mutation', reasonCode: 'FICTIONAL_PERMISSION_ABSENT', reasonSummary: 'Fictional runtime exposes no per-player permission contract.' }
  ]
}

const demoPlayerRoster: PlayerRoster = {
  schemaVersion: 1, state: 'active', authoritative: true,
  observedAt: '2026-08-30T10:05:00.000+08:00', rosterGeneration: `roster-v1:${'f'.repeat(64)}`,
  sequence: 7, truncated: false, playerCount: 2,
  players: [
    { sessionPlayerId: 'player-000001', displayName: 'Orion', online: true, joinedAt: '2026-08-30T09:30:00.000+08:00', location: 'planet:1001' },
    { sessionPlayerId: 'player-000002', displayName: 'Lyra', online: true, joinedAt: '2026-08-30T09:46:00.000+08:00', location: 'deep-space' }
  ],
  lastKnownPlayers: [],
  recentEvents: [
    { sequence: 1, type: 'join', occurredAt: '2026-08-30T09:30:00.000+08:00', player: { sessionPlayerId: 'player-000001', displayName: 'Orion', online: true, joinedAt: '2026-08-30T09:30:00.000+08:00', location: 'planet:1001' } },
    { sequence: 2, type: 'join', occurredAt: '2026-08-30T09:46:00.000+08:00', player: { sessionPlayerId: 'player-000002', displayName: 'Lyra', online: true, joinedAt: '2026-08-30T09:46:00.000+08:00', location: 'deep-space' } }
  ]
}

type ConfigDraftValue = boolean | number | string

function ConfigurationWorkspace({ canPreview, canApply, canManageHistory, demo }: {
  canPreview: boolean
  canApply: boolean
  canManageHistory: boolean
  demo: boolean
}) {
  const [snapshot, setSnapshot] = useState<GameConfigSnapshot | null>(null)
  const [drafts, setDrafts] = useState<Record<string, ConfigDraftValue>>({})
  const [preview, setPreview] = useState<GameConfigPreview | null>(null)
  const [busy, setBusy] = useState(true)
  const [previewing, setPreviewing] = useState(false)
  const [applying, setApplying] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [applied, setApplied] = useState<GameConfigTransactionResult | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setBusy(true); setError(''); setPreview(null)
    try {
      const result = await api.configuration()
      setSnapshot(result.data); setDrafts(Object.fromEntries(result.data.entries.map((entry) => [
        entry.id, entry.type === 'secret' ? '' : entry.value as boolean | number
      ])))
    } catch (reason) { setError(reason instanceof Error ? reason.message : '配置加载失败') }
    finally { setBusy(false) }
  }, [])

  useEffect(() => { load().catch(() => undefined) }, [load])
  const changes = useMemo(() => snapshot ? snapshot.entries.flatMap((entry) => {
    const draft = drafts[entry.id]
    if (entry.type === 'secret') return typeof draft === 'string' && draft.length > 0 ? [{ id: entry.id, value: draft }] : []
    return draft !== entry.value ? [{ id: entry.id, value: draft! }] : []
  }) : [], [drafts, snapshot])

  async function previewChanges() {
    if (!snapshot || changes.length === 0 || !canPreview) return
    setPreviewing(true); setError(''); setPreview(null)
    try { setPreview((await api.previewConfiguration(snapshot.revision, changes)).data) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '配置差异预览失败') }
    finally { setPreviewing(false) }
  }

  async function applyChanges() {
    if (!snapshot || !preview || changes.length === 0 || !canApply) return
    setApplying(true); setError(''); setConfirmOpen(false)
    try {
      const result = await api.applyConfiguration(snapshot.revision, changes)
      setApplied(result.data)
      const refreshed = await api.configuration()
      setSnapshot(refreshed.data)
      setDrafts(Object.fromEntries(refreshed.data.entries.map((entry) => [
        entry.id, entry.type === 'secret' ? '' : entry.value as boolean | number
      ])))
      setPreview(null)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '配置事务失败') }
    finally { setApplying(false) }
  }

  if (busy) return <div className="loading-state compact"><span className="spinner" />正在解析固定配置 Schema…</div>
  if (!snapshot) return <div className="configuration-workspace">
    <div className="configuration-empty"><FileCog size={34} /><strong>当前配置目录不可用</strong><p>{error || '请先完成 Windows 受管目录安装。'}</p><button onClick={load}>重试当前配置</button></div>
    <ConfigHistoryWorkspace canManage={canManageHistory} demo={demo} onConfigurationChanged={load} />
  </div>
  const groups = (['nebula', 'galaxy', 'bepinex', 'bridge'] as GameConfigFileId[]).map((file) => ({
    file, entries: snapshot.entries.filter((entry) => entry.file === file)
  })).filter((group) => group.entries.length)

  return <div className="configuration-workspace">
    <div className="workspace-toolbar"><div><strong>Schema 配置编辑器</strong><span>版本 {snapshot.revision.slice(0, 10)} · {changes.length} 项待预览</span></div><button onClick={load}><RefreshCw size={16} />重新读取</button></div>
    {!canPreview && <div className="permission-lock-note"><LockKeyhole size={15} /><span><strong>只读配置会话</strong><small>Viewer 可以查看固定 Schema，但编辑和差异预演保持禁用。</small></span></div>}
    {canPreview && !canApply && <div className="permission-lock-note operator"><LockKeyhole size={15} /><span><strong>Operator 预演模式</strong><small>可以编辑并生成差异；原子应用配置属于 Administrator 高风险操作。</small></span></div>}
    {error && <div className="inline-error"><TriangleAlert size={17} />{error}</div>}
    {snapshot.invalidSettingIds.length > 0 && <div className="inline-warning"><TriangleAlert size={17} />发现 {snapshot.invalidSettingIds.length} 项无效值；界面显示安全默认值，写入前必须修复。</div>}
    <div className="config-groups">{groups.map((group) => <section className="config-group" key={group.file}>
      <header><strong>{configFileLabel(group.file)}</strong><span>{group.entries.length} 个固定字段</span></header>
      <div>{group.entries.map((entry) => <ConfigField key={entry.id} entry={entry} value={drafts[entry.id]} disabled={!canPreview} onChange={(value) => {
        setDrafts((current) => ({ ...current, [entry.id]: value })); setPreview(null)
      }} />)}</div>
    </section>)}</div>
    {applied && <div className="config-applied"><Check size={17} /><div><strong>配置事务已提交</strong><span>事务 {applied.transactionId.slice(0, 8)} · 审计{applied.auditStored ? '已保存' : '未保存'} · {applied.restartRequired ? '需要稍后受控重启服务端' : '无需重启'}</span></div><button onClick={() => setApplied(null)}>关闭</button></div>}
    <div className="config-actions"><div><ShieldCheck size={18} /><span><strong>{preview ? '差异已通过固定字段校验' : '先生成差异预览'}</strong><small>应用会创建四文件字节快照；不会自动重启游戏或改变已创建星系。</small></span></div><button className="primary-action" disabled={!canPreview || !changes.length || previewing || applying} onClick={previewChanges}><ScanSearch className={previewing ? 'spin' : ''} size={16} />{previewing ? '校验中…' : `预览 ${changes.length} 项变更`}</button><button disabled={!canApply || !preview || applying} title={canApply ? '进入管理员确认' : '配置应用仅对 Administrator 开放'} onClick={() => setConfirmOpen(true)}><FileCog size={16} />{applying ? '提交中…' : '应用配置'}</button></div>
    {preview && <section className="config-preview"><header><div><Check size={17} /><strong>差异预览已生成</strong></div><span>{preview.restartRequired ? '需要重启服务端' : '无需重启'}{preview.newGameOnlyChanged ? ' · 包含仅新游戏参数' : ''}</span></header>
      <div>{preview.diff.filter((entry) => entry.changed).map((entry) => <div key={entry.id}><span>{entry.label}<small>{entry.activation === 'new-game-only' ? '仅创建新星系时生效' : '重启服务端后生效'}</small></span><code>{displayConfigValue(entry.before)} → {displayConfigValue(entry.after)}</code></div>)}</div>
      <p><ShieldCheck size={15} />提交将在独占锁内重新校验 revision，并在失败时恢复四个文件的原始字节。</p>
    </section>}
    {confirmOpen && preview && canApply && <div className="config-confirm" role="alertdialog" aria-labelledby="config-confirm-title"><div><TriangleAlert size={20} /><span><strong id="config-confirm-title">确认提交 {preview.diff.filter((entry) => entry.changed).length} 项配置变更</strong><small>将创建可验证快照并原子替换配置；不会自动重启服务器。包含“仅新游戏”参数时，现有星系不会被改写。</small></span></div><div><button onClick={() => setConfirmOpen(false)}>取消</button><button className="confirm-execute" onClick={applyChanges}>确认应用</button></div></div>}
    <ConfigHistoryWorkspace canManage={canManageHistory} demo={demo} onConfigurationChanged={load} />
  </div>
}

function ConfigField({ entry, value, onChange, disabled }: {
  entry: GameConfigEntry; value: ConfigDraftValue | undefined
  onChange: (value: ConfigDraftValue) => void; disabled: boolean
}) {
  const control = entry.type === 'boolean'
    ? <button type="button" role="switch" aria-checked={Boolean(value)} className={`config-switch ${value ? 'on' : ''}`} disabled={disabled} onClick={() => onChange(!value)}><span />{value ? '已启用' : '已关闭'}</button>
    : entry.type === 'secret'
      ? <input type="password" value={typeof value === 'string' ? value : ''} disabled={disabled} autoComplete="new-password" onChange={(event) => onChange(event.target.value)} placeholder={(entry.value as { configured: boolean }).configured ? '已设置 · 留空保持不变' : '尚未设置'} />
      : entry.allowed
        ? <select value={String(value)} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))}>{entry.allowed.map((item) => <option value={item} key={item}>{item === 100 ? '100 · 无限' : item}</option>)}</select>
        : <input type="number" value={typeof value === 'number' ? value : ''} disabled={disabled} min={entry.minimum} max={entry.maximum} step={entry.type === 'integer' ? 1 : 'any'} onChange={(event) => onChange(Number(event.target.value))} />
  return <label className={`config-field ${entry.source === 'invalid' ? 'invalid' : ''}`}><span><strong>{entry.label}</strong><small>{entry.description}</small><em>{entry.activation === 'new-game-only' ? '新游戏参数' : '重启生效'} · {entry.source === 'file' ? '来自文件' : entry.source === 'default' ? '默认值' : '值无效'}</em></span>{control}</label>
}

function FeatureWorkspace({ active, status, jobs, onRefresh, provider, lifecycleIntent, user }: {
  active: Exclude<NavKey, 'overview'>; status: ServerStatus; jobs: JobRecord[]; onRefresh: () => void
  provider: 'demo' | 'windows'; lifecycleIntent: LifecycleAction | null; user: SessionUser
}) {
  const definition = featureDefinitions[active]
  const Icon = definition.icon
  return <div className="feature-page page-enter">
    <div className="feature-heading"><div><span className="feature-icon"><Icon size={24} /></span><div><h1>{definition.title}</h1><p>{definition.description}</p></div></div><button className="more-action" onClick={onRefresh} disabled={!hasPermission(user, 'status.refresh')} title={hasPermission(user, 'status.refresh') ? '刷新状态' : '当前角色没有刷新权限'}><RefreshCw size={16} />刷新状态</button></div>
    <div className="feature-layout"><section className="panel feature-primary"><header><h2>{definition.primaryTitle}</h2><span className="phase-label">{definition.phase}</span></header>{featureBody(active, status, jobs, provider, onRefresh, lifecycleIntent, user)}</section>
      <aside className="panel feature-scope"><header><h2>管理范围</h2></header><ul>{definition.scope.map((item) => <li key={item}><Check size={15} />{item}</li>)}</ul><div className="safety-note"><ShieldCheck size={19} /><div><strong>安全门禁</strong><p>{definition.safety}</p></div></div></aside></div>
  </div>
}

const featureDefinitions: Record<Exclude<NavKey, 'overview'>, { title: string; description: string; primaryTitle: string; phase: string; icon: ComponentType<{ size?: number }>; scope: string[]; safety: string }> = {
  game: { title: '游戏管理', description: '统一管理 DSP 进程、Nebula 会话和安全生命周期。', primaryTitle: '游戏实例', phase: '安全预检已接入', icon: Gamepad2, scope: ['启动前检查', '保存请求', '优雅停服', '受控重启与回滚'], safety: '只读预检会留下审计记录；独立保存确认、持久回执与执行适配器完成验证前，写操作保持禁用。' },
  console: { title: '实时控制台', description: '查看强制脱敏日志，并通过固定动作合同安全控制服务器。', primaryTitle: '服务器输出', phase: '固定动作已接入', icon: TerminalSquare, scope: ['四项固定动作', '预演与精确确认', '持久回执轮询', '脱敏日志续读', '结构化下载'], safety: '不提供任意 PowerShell、参数或文本命令；按钮权限只是 UX 提示，服务端仍逐请求授权。' },
  players: { title: '玩家管理', description: '查看 Nebula 权威在线集合和签名能力边界。', primaryTitle: '当前玩家', phase: '清单与能力快照', icon: Users, scope: ['在线列表', '签名能力合同', '上游版本证据', '固定不可用原因', '进出历史'], safety: '不会返回 IP、Steam ID、player.key、HMAC 或文件路径；未验证的 disconnect/kick/ban/whitelist/blacklist/notice/permission 始终禁用。' },
  versions: { title: '版本更新管理', description: '协调 DSP、Nebula、BepInEx 与受控组件发布。', primaryTitle: '组件更新事务', phase: '预演与激活合同已接入', icon: CloudDownload, scope: ['活动 revision', '结构化兼容性证据', 'dry-run operations', '保护点与停止态', '回执、回滚与只读清理'], safety: 'DSP 始终通过 Steam 手动更新；托管组件仅能引用固定暂存 artifact，执行默认 fail-closed，生产激活仍需真实服务器验收。' },
  mods: { title: '模组更新管理', description: '以固定根目录事务部署服务端模组，并维护客户端 Parity。', primaryTitle: '模组部署矩阵', phase: '预演与原子发布已接入', icon: Boxes, scope: ['托管模组清单', '依赖与 Parity', '固定暂存候选', '五类部署预演', '快照、回滚与恢复'], safety: '浏览器只能提交逻辑 ID、版本和锁清单；不能提交主机路径、命令或 ZIP。执行默认禁用，并在发布前两次验证进程停止和端口关闭。' },
  saves: { title: '存档管理', description: '把 .dsv 与 .server 作为不可分割的一致性单元。', primaryTitle: '存档单元', phase: '事务与跨机传输', icon: FolderArchive, scope: ['成对发现', '原子备份', '停服恢复', '内容寻址导出', '隔离区导入'], safety: '跨机器导出仅接受已验证 backupId；导入固定进入 quarantine/inbox，不等于恢复。恢复仍需停服、保护点与独立确认。' },
  client: { title: '客户端包', description: '签发资格绑定的客户端运行包，或预览公开的确定性配置资料。', primaryTitle: '客户端交付', phase: 'V2 资格门禁已接入', icon: Archive, scope: ['生产资格签发', '客户端运行包', 'Parity 报告', 'Profile 与版本', '运行时绑定清单'], safety: '生产签发只接受受保护资格 ID；三个下载都会绑定持久化回执并由服务端重新验哈希，不包含 Steam 凭据、服务器密码、存档或玩家资料。' },
  server: { title: '服务器管理', description: '查看 Windows 主机、DSP 进程、端口与可信性能轨迹。', primaryTitle: '主机与进程', phase: '实时观测已接入', icon: Server, scope: ['主机总 CPU 与内存', 'DSP 核等值、工作集与线程', '端口状态矛盾', '实际 UPS/TPS 可用性', '短历史与瓶颈提示'], safety: '不提供通用进程终止或主机重启；缺失指标明确标为不可用，目标 UPS 不会伪装成实测值。' },
  config: { title: '配置管理', description: '通过固定 Schema 与内容寻址历史管理四个受控配置文件。', primaryTitle: '配置域', phase: '事务与历史恢复已接入', icon: FileCog, scope: ['Nebula 服务端字段', '星系与黑雾参数', 'BepInEx 控制台开关', '游戏桥配置', '脱敏差异与恢复对账'], safety: 'secret 只显示 configured 状态；恢复必须依次取得最新 revision、只读预演、dry-run 和精确确认，服务端仍独立执行停止态门禁。' },
  cutover: { title: '权威切换', description: '在 GSManager 与 Dyson 控制链之间执行持久、可恢复的唯一权威切换。', primaryTitle: 'Cutover 事务控制面', phase: '状态、回执与恢复已接入', icon: GitBranch, scope: ['持久恢复状态', '准备与激活事务', '两类显式回退', '服务端 request ID 恢复', '不可变回执与审计'], safety: '仅提供固定能力和精确确认；没有主机、路径或命令输入。普通切换与恢复门禁默认关闭，任何不确定状态都会保持 fail-closed。' },
  tasks: { title: '任务与审计', description: '追踪每个读取、修改、更新、备份和回滚动作。', primaryTitle: '任务记录', phase: '分页与审计导出已接入', icon: ClipboardList, scope: ['稳定游标分页', '类型与状态过滤', '操作人与失败代码', 'JSON / NDJSON 预演', '管理员确认导出'], safety: '审计信息不记录密码、令牌、完整路径、玩家密钥或存档内容；导出只接受固定参数和精确确认。' }
}

function featureBody(
  active: Exclude<NavKey, 'overview'>,
  status: ServerStatus,
  jobs: JobRecord[],
  provider: 'demo' | 'windows',
  onRefresh: () => void,
  lifecycleIntent: LifecycleAction | null,
  user: SessionUser
) {
  if (active === 'console') return <ConsoleWorkspace demo={provider === 'demo'} user={user} />
  if (active === 'tasks') return <TasksAuditWorkspace user={user} />
  if (active === 'players') return <PlayerWorkspace demo={provider === 'demo'} user={user} />
  if (active === 'versions') return <VersionUpdateWorkspace status={status} demo={provider === 'demo'} user={user} />
  if (active === 'mods') return <ModWorkspace
    demo={provider === 'demo'}
    canMutate={hasPermission(user, 'mods.mutate')}
    canRecover={user.role === 'administrator' && hasPermission(user, 'mods.mutate')}
    canAcquire={hasPermission(user, 'updates.stage')}
    canImport={hasPermission(user, 'mods.mutate')}
  />
  if (active === 'saves') return <SaveCatalogWorkspace status={status}
    canBackup={hasPermission(user, 'saves.backup')} canRestore={hasPermission(user, 'saves.restore')}
    user={user} demo={provider === 'demo'} />
  if (active === 'client') return <ClientPackageWorkspace demo={provider === 'demo'} canGenerate={hasPermission(user, 'client-profile.generate')} />
  if (active === 'server') return <ServerObservabilityWorkspace
    canAcknowledge={hasPermission(user, 'observability.acknowledge')} />
  if (active === 'cutover') return <CutoverWorkspace user={user} demo={provider === 'demo'} />
  if (active === 'game') return <GameLifecyclePanel status={status} onRefresh={onRefresh}
    provider={provider} initialAction={lifecycleIntent} canOperate={hasPermission(user, 'lifecycle.execute')} />
  if (active === 'config') return <ConfigurationWorkspace
    canPreview={hasPermission(user, 'configuration.preview')}
    canApply={hasPermission(user, 'configuration.apply')}
    canManageHistory={user.role === 'administrator' && hasPermission(user, 'configuration.apply')}
    demo={provider === 'demo'} />
  return null
}

const modDeploymentOperations: Array<{ operation: ModDeploymentOperation; label: string; description: string }> = [
  { operation: 'install', label: '安装', description: '从固定暂存根发布新模组' },
  { operation: 'update', label: '更新', description: '以新版本替换同一来源' },
  { operation: 'enable', label: '启用', description: '重新发布已禁用模组' },
  { operation: 'disable', label: '禁用', description: '保留可恢复载荷' },
  { operation: 'remove', label: '移除', description: '从活动树移除并保留恢复点' }
]

const modDeploymentRequestMaximumBytes = 2 * 1_024 * 1_024
const modDeploymentHistoryPageSize = 8
const modDeploymentRequestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

interface SelectedModDeploymentRequest {
  fileName: string
  sizeBytes: number
  value: ModDeploymentRequest
}

export function ModWorkspace({
  demo,
  canMutate = true,
  canRecover = true,
  canAcquire = true,
  canImport = true
}: {
  demo: boolean
  canMutate?: boolean
  canRecover?: boolean
  canAcquire?: boolean
  canImport?: boolean
}) {
  const [state, setState] = useState<ModDeploymentStateSummary | null>(null)
  const [recovery, setRecovery] = useState<ModDeploymentRecoveryPlan | null>(null)
  const [recoveryStatus, setRecoveryStatus] = useState<ModDeploymentRecoveryStatus | null>(null)
  const [executionEnabled, setExecutionEnabled] = useState(false)
  const [recoveryExecutionEnabled, setRecoveryExecutionEnabled] = useState(false)
  const [recoveryRequestId, setRecoveryRequestId] = useState('')
  const [recoveryDesired, setRecoveryDesired] = useState<ModDeploymentRecoveryDesired>('previous')
  const [recoveryConfirmation, setRecoveryConfirmation] = useState('')
  const [recovering, setRecovering] = useState(false)
  const [selected, setSelected] = useState<SelectedModDeploymentRequest | null>(null)
  const [preview, setPreview] = useState<ModDeploymentPreview | null>(null)
  const [receipt, setReceipt] = useState<ModDeploymentReceipt | null>(null)
  const [receiptHistory, setReceiptHistory] = useState<ModDeploymentReceiptHistoryPage | null>(null)
  const [receiptRequestId, setReceiptRequestId] = useState('')
  const [receiptHistoryError, setReceiptHistoryError] = useState('')
  const [receiptHistoryLoading, setReceiptHistoryLoading] = useState(false)
  const [receiptLookupLoading, setReceiptLookupLoading] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [reading, setReading] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [executing, setExecuting] = useState(false)
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const fileSequenceRef = useRef(0)
  const operationSequenceRef = useRef(0)
  const receiptHistorySequenceRef = useRef(0)
  const receiptLookupSequenceRef = useRef(0)

  const load = useCallback(async (signal?: AbortSignal, showLoading = true) => {
    if (showLoading) setLoading(true)
    const historySequence = ++receiptHistorySequenceRef.current
    try {
      const [stateResult, recoveryResult, recoveryStatusResult, historyResult] = await Promise.all([
        api.modDeploymentState(signal),
        api.modDeploymentRecovery(signal),
        api.modDeploymentRecoveryStatus(signal),
        api.modDeploymentHistory({ pageSize: modDeploymentHistoryPageSize }, signal).then(
          (result) => ({ ok: true as const, result }),
          (reason: unknown) => ({ ok: false as const, reason })
        )
      ])
      if (signal?.aborted) return
      setState(stateResult.data)
      setRecovery(recoveryResult.data)
      setRecoveryStatus(recoveryStatusResult.data)
      setExecutionEnabled(stateResult.meta.executionEnabled)
      setRecoveryExecutionEnabled(recoveryStatusResult.meta.executionEnabled)
      if (recoveryStatusResult.data.phase === 'recovery-required' && recoveryStatusResult.data.requestId) {
        setRecoveryRequestId(recoveryStatusResult.data.requestId)
        setRecoveryDesired((current) => recoveryStatusResult.data.allowedDesired.includes(current)
          ? current
          : recoveryStatusResult.data.allowedDesired[0] ?? 'previous')
      }
      if (historySequence === receiptHistorySequenceRef.current) {
        if (historyResult.ok) {
          setReceiptHistory(historyResult.result.data)
          setReceiptHistoryError('')
        } else {
          setReceiptHistoryError(formatModWorkspaceError(historyResult.reason, '模组部署回执历史暂不可用。'))
        }
      }
      setError('')
    } catch (reason) {
      if (signal?.aborted) return
      setRecoveryStatus(null)
      setRecoveryExecutionEnabled(false)
      setError(formatModWorkspaceError(reason, '模组托管状态暂不可用。'))
    } finally {
      if (!signal?.aborted && showLoading) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => {
      controller.abort()
      fileSequenceRef.current++
      operationSequenceRef.current++
      receiptHistorySequenceRef.current++
      receiptLookupSequenceRef.current++
    }
  }, [load])

  const target = useMemo(() => {
    if (!selected) return null
    return selected.value.manifest.serverLock.mods.find((entry) =>
      entry.dependencyId === selected.value.package.dependencyId) ?? null
  }, [selected])
  const parityCounts = useMemo(() => {
    const mods = selected?.value.manifest.clientParity.mods ?? []
    return {
      required: mods.filter((entry) => entry.clientRequirement === 'required').length,
      optional: mods.filter((entry) => entry.clientRequirement === 'optional').length,
      excluded: mods.filter((entry) => entry.clientRequirement === 'not-required').length
    }
  }, [selected])
  const confirmationPhrase = preview
    ? `EXECUTE ${preview.operation.toUpperCase()} ${preview.package.dependencyId}`
    : ''
  const recoveryConfirmationPhrase = 'RECOVER_MOD_DEPLOYMENT'
  const mutationBlockedByRecovery = recoveryStatus === null || recoveryStatus.phase !== 'ready'
  const exactRecoveryRequest = recoveryStatus?.phase === 'recovery-required' &&
    recoveryStatus.requestId !== null && recoveryRequestId.trim().toLowerCase() === recoveryStatus.requestId
  const recoveryDesiredAllowed = recoveryStatus?.phase === 'recovery-required' &&
    recoveryStatus.allowedDesired.includes(recoveryDesired)
  const operationNeedsStaging = selected
    ? ['install', 'update', 'enable'].includes(selected.value.operation)
    : false

  function acceptRequest(value: ModDeploymentRequest, fileName: string, sizeBytes: number): void {
    operationSequenceRef.current++
    setSelected({ value, fileName, sizeBytes })
    setPreview(null)
    setReceipt(null)
    setConfirmation('')
    setError('')
    setPreviewing(false)
    setExecuting(false)
  }

  async function readFiles(files: FileList | readonly File[]): Promise<void> {
    if (files.length !== 1) {
      setError('一次只能选择一个模组部署 JSON。')
      return
    }
    const file = files[0]
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.json')) {
      setError('只接受逻辑模组部署请求 JSON；不能选择 ZIP 或可执行文件。')
      return
    }
    if (file.size > modDeploymentRequestMaximumBytes) {
      setError('模组部署请求 JSON 不能超过 2 MiB。')
      return
    }
    const sequence = ++fileSequenceRef.current
    setReading(true)
    try {
      const text = await file.text()
      const parsed = parseLogicalModDeploymentRequest(JSON.parse(text) as unknown)
      if (sequence === fileSequenceRef.current) acceptRequest(parsed, file.name, file.size)
    } catch {
      if (sequence === fileSequenceRef.current) {
        setError('JSON 只允许固定逻辑字段；主机路径、命令、URL、ZIP 和二进制内容均被拒绝。')
      }
    } finally {
      if (sequence === fileSequenceRef.current) setReading(false)
    }
  }

  function useFictionalExample(): void {
    fileSequenceRef.current++
    setReading(false)
    const value = fictionalModDeploymentRequest(state?.revision ?? '0'.repeat(64))
    acceptRequest(value, 'fictional-mod-deployment-request.json', JSON.stringify(value).length)
  }

  function selectOperation(operation: ModDeploymentOperation): void {
    fileSequenceRef.current++
    setReading(false)
    setSelected((current) => {
      if (!current) return current
      return {
        ...current,
        value: {
          ...current.value,
          requestId: createUiRequestId(),
          operation,
          expectedRevision: state?.revision ?? current.value.expectedRevision
        }
      }
    })
    operationSequenceRef.current++
    setPreview(null)
    setReceipt(null)
    setConfirmation('')
    setError('')
  }

  function selectTarget(dependencyId: string): void {
    fileSequenceRef.current++
    setReading(false)
    setSelected((current) => {
      if (!current) return current
      const nextTarget = current.value.manifest.serverLock.mods.find((entry) => entry.dependencyId === dependencyId)
      if (!nextTarget) return current
      return {
        ...current,
        value: {
          ...current.value,
          requestId: createUiRequestId(),
          package: { dependencyId: nextTarget.dependencyId, version: nextTarget.version },
          expectedRevision: state?.revision ?? current.value.expectedRevision
        }
      }
    })
    operationSequenceRef.current++
    setPreview(null)
    setReceipt(null)
    setConfirmation('')
    setError('')
  }

  async function previewDeployment(): Promise<void> {
    if (!selected) return
    const sequence = ++operationSequenceRef.current
    setPreviewing(true)
    setError('')
    try {
      const response = await api.previewModDeployment(selected.value)
      if (sequence !== operationSequenceRef.current) return
      setPreview(response.data)
      setExecutionEnabled(response.meta.executionEnabled)
      setReceipt(null)
      setConfirmation('')
    } catch (reason) {
      if (sequence === operationSequenceRef.current) {
        setError(formatModWorkspaceError(reason, '模组部署预演失败；原始请求和上一份预演保持不变。'))
      }
    } finally {
      if (sequence === operationSequenceRef.current) setPreviewing(false)
    }
  }

  async function executeDeployment(): Promise<void> {
    if (!selected || !preview || confirmation !== confirmationPhrase || !executionEnabled || !canMutate ||
        mutationBlockedByRecovery) return
    const sequence = ++operationSequenceRef.current
    setExecuting(true)
    setError('')
    try {
      const response = await api.executeModDeployment(selected.value)
      if (sequence !== operationSequenceRef.current) return
      setReceipt(response.data)
      setPreview(null)
      setConfirmation('')
      await load(undefined, false)
    } catch (reason) {
      if (sequence === operationSequenceRef.current) {
        if (reason instanceof ApiError && [
          'MOD_DEPLOYMENT_RECOVERY_REQUIRED',
          'MOD_DEPLOYMENT_HOST_LEASE_DIRTY',
          'MOD_DEPLOYMENT_HOST_LEASE_RECOVERY_REQUIRED',
          'MOD_DEPLOYMENT_HOST_LEASE_LOST'
        ].includes(reason.code ?? '')) {
          setRecoveryRequestId(selected.value.requestId)
          await load(undefined, false)
        }
        setError(formatModWorkspaceError(reason, '模组部署执行失败；请求与预演证据保持不变。'))
      }
    } finally {
      if (sequence === operationSequenceRef.current) setExecuting(false)
    }
  }

  async function recoverDeployment(): Promise<void> {
    if (!canRecover || !recoveryExecutionEnabled || !exactRecoveryRequest || !recoveryDesiredAllowed ||
        recoveryConfirmation !== recoveryConfirmationPhrase) return
    const sequence = ++operationSequenceRef.current
    const requestId = recoveryRequestId.trim().toLowerCase()
    setRecovering(true)
    setError('')
    try {
      const recovered = await api.recoverModDeployment(requestId, recoveryDesired)
      if (sequence !== operationSequenceRef.current) return
      if (recovered.data.requestId !== requestId || recovered.data.status === 'rollback-failed') {
        setError('显式恢复回执未证明安全终态；模组写入继续保持锁定。')
        return
      }
      const [nextState, nextStatus, nextCleanup] = await Promise.all([
        api.modDeploymentState(),
        api.modDeploymentRecoveryStatus(),
        api.modDeploymentRecovery()
      ])
      if (sequence !== operationSequenceRef.current) return
      const expectedRevision = recovered.data.status === 'succeeded'
        ? recovered.data.newRevision
        : recovered.data.previousRevision
      if (nextStatus.data.phase !== 'ready' || expectedRevision === null ||
          nextState.data.revision !== expectedRevision) {
        setRecoveryStatus(nextStatus.data)
        setRecoveryExecutionEnabled(nextStatus.meta.executionEnabled)
        setError('恢复后状态未与持久回执收敛；模组写入继续保持锁定。')
        return
      }
      setState(nextState.data)
      setExecutionEnabled(nextState.meta.executionEnabled)
      setRecoveryStatus(nextStatus.data)
      setRecoveryExecutionEnabled(nextStatus.meta.executionEnabled)
      setRecovery(nextCleanup.data)
      setReceipt(recovered.data)
      setPreview(null)
      setConfirmation('')
      setRecoveryConfirmation('')
    } catch (reason) {
      if (sequence === operationSequenceRef.current) {
        setError(formatModWorkspaceError(reason, '模组显式恢复失败；所有持久证据保持 fail-closed。'))
      }
    } finally {
      if (sequence === operationSequenceRef.current) setRecovering(false)
    }
  }

  async function loadMoreReceiptHistory(): Promise<void> {
    const cursor = receiptHistory?.page.nextCursor
    if (!cursor || receiptHistoryLoading) return
    const sequence = ++receiptHistorySequenceRef.current
    setReceiptHistoryLoading(true)
    setReceiptHistoryError('')
    try {
      const result = await api.modDeploymentHistory({
        cursor,
        pageSize: modDeploymentHistoryPageSize
      })
      if (sequence !== receiptHistorySequenceRef.current) return
      setReceiptHistory((current) => {
        if (!current) return result.data
        const requestIds = new Set<string>()
        const items = [...current.items, ...result.data.items].filter((item) => {
          if (requestIds.has(item.receipt.requestId)) return false
          requestIds.add(item.receipt.requestId)
          return true
        })
        return {
          ...result.data,
          items,
          page: { ...result.data.page, returned: items.length }
        }
      })
    } catch (reason) {
      if (sequence === receiptHistorySequenceRef.current) {
        setReceiptHistoryError(formatModWorkspaceError(reason, '无法加载更早的模组部署回执。'))
      }
    } finally {
      if (sequence === receiptHistorySequenceRef.current) setReceiptHistoryLoading(false)
    }
  }

  async function lookupReceipt(requestId = receiptRequestId): Promise<void> {
    const normalizedRequestId = requestId.trim().toLowerCase()
    if (!modDeploymentRequestIdPattern.test(normalizedRequestId)) {
      setReceiptHistoryError('请输入完整有效的模组部署 request ID。')
      return
    }
    const sequence = ++receiptLookupSequenceRef.current
    setReceiptLookupLoading(true)
    setReceiptHistoryError('')
    try {
      const result = await api.modDeploymentReceipt(normalizedRequestId)
      if (sequence !== receiptLookupSequenceRef.current) return
      setReceiptRequestId(normalizedRequestId)
      setReceipt(result.data)
    } catch (reason) {
      if (sequence === receiptLookupSequenceRef.current) {
        setReceiptHistoryError(formatModWorkspaceError(reason, '无法核验指定的模组部署回执。'))
      }
    } finally {
      if (sequence === receiptLookupSequenceRef.current) setReceiptLookupLoading(false)
    }
  }

  return <div className="mod-workspace">
    <ModSupplyWorkspace
      demo={demo}
      canAcquire={canAcquire}
      canImport={canImport}
      activeRevision={state?.revision ?? ''}
      onDeploymentRequest={(request, label) => acceptRequest(request, label, JSON.stringify(request).length)}
    />

    <section className="mod-command-deck">
      <div className={`mod-request-drop${dragging ? ' dragging' : ''}`}
        onDragEnter={(event) => { event.preventDefault(); setDragging(true) }}
        onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
        onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false) }}
        onDrop={(event) => { event.preventDefault(); setDragging(false); void readFiles(event.dataTransfer.files) }}>
        <span className="mod-orbit"><Boxes size={24} /></span>
        <div><strong>{selected?.fileName ?? '载入逻辑部署请求'}</strong><small>{selected ? `${formatBytes(selected.sizeBytes)} · 浏览器内存` : '单个 JSON · 最大 2 MiB · 不接收 ZIP/路径/命令'}</small></div>
        <button type="button" disabled={reading} onClick={() => fileInputRef.current?.click()}><FileJson size={15} />{reading ? '读取中…' : '选择 JSON'}</button>
        <input ref={fileInputRef} className="client-file-input" type="file" accept=".json,application/json"
          aria-label="选择模组部署请求 JSON" onChange={(event) => {
            const input = event.currentTarget
            if (input.files) void readFiles(input.files)
            input.value = ''
          }} />
      </div>
      <div className="mod-command-actions">
        <span><LockKeyhole size={15} />固定根目录 · UUID 幂等 · revision CAS · 双 stopped gate</span>
        <button type="button" onClick={useFictionalExample}><ScanSearch size={14} />使用虚构示例</button>
        <button type="button" onClick={() => void load()}><RefreshCw className={loading ? 'spin' : ''} size={14} />刷新清单</button>
      </div>
      <p>{demo ? '演示入口不会自动执行；示例只使用 Fictional 包。' : '生产页面不自动注入请求，所有部署必须由管理员明确载入并预演。'}</p>
    </section>

    {!canMutate && <div className="permission-lock-note"><LockKeyhole size={15} /><span><strong>模组事务只读</strong><small>可以检查托管清单和生成部署预演；原子发布、启停与移除仅对 Administrator 开放。</small></span></div>}

    {error && <div className="mod-workspace-error" role="alert"><TriangleAlert size={16} /><span>{error}</span></div>}

    <section className="mod-state-strip">
      <div><span>ACTIVE REVISION</span><strong>{state ? shortHash(state.revision, 14) : 'UNAVAILABLE'}</strong><small>{state ? `${state.packages.length} 个托管包` : '等待固定根目录状态'}</small></div>
      <div><span>ENABLED</span><strong>{state?.enabledCount ?? '—'}</strong><small>活动载荷</small></div>
      <div><span>DISABLED</span><strong>{state?.disabledCount ?? '—'}</strong><small>可恢复记录</small></div>
      <div className={executionEnabled && !mutationBlockedByRecovery ? 'gate-open' : 'gate-closed'}><span>MUTATION GATE</span><strong>{executionEnabled && !mutationBlockedByRecovery ? 'ENABLED' : 'FAIL-CLOSED'}</strong><small>{mutationBlockedByRecovery ? '必须先完成精确恢复或证明恢复状态正常' : executionEnabled ? '仍需精确确认与双停服证明' : '仅允许读取和预演'}</small></div>
    </section>

    <ManagedModConfigurationWorkspace deployment={state} executionEnabled={executionEnabled && !mutationBlockedByRecovery}
      canMutate={canMutate} />

    <div className="mod-workspace-grid">
      <section className="mod-managed-panel">
        <header><div><Database size={16} /><strong>托管模组清单</strong></div><span>{loading ? '读取中' : `${state?.packages.length ?? 0} 项`}</span></header>
        <div className="mod-managed-list">{state?.packages.length ? state.packages.map((entry) =>
          <div key={entry.sourceId}><span className={entry.enabled ? 'enabled' : 'disabled'}>{entry.enabled ? 'ON' : 'OFF'}</span><div><strong>{entry.sourceId.replace('thunderstore:', '')}</strong><small>{entry.dependencyId}</small></div><code>{entry.version}</code><b>{modRequirementLabel(entry.clientRequirement)}</b></div>)
          : <p>{loading ? '正在核验活动清单…' : '没有可展示的托管模组，或服务尚未配置。'}</p>}</div>
      </section>

      <section className="mod-transaction-panel">
        <header><div><Wrench size={16} /><strong>部署事务编排</strong></div><span>{selected ? selected.value.requestId.slice(0, 8) : '未载入'}</span></header>
        <div className="mod-operation-rail">{modDeploymentOperations.map((item) => <button type="button" key={item.operation}
          className={selected?.value.operation === item.operation ? 'active' : ''} disabled={!selected}
          onClick={() => selectOperation(item.operation)}><strong>{item.label}</strong><small>{item.description}</small></button>)}</div>
        {selected ? <div className="mod-target-editor">
          <label><span>目标包</span><select value={selected.value.package.dependencyId} onChange={(event) => selectTarget(event.target.value)}>
            {selected.value.manifest.serverLock.mods.map((entry) => <option key={entry.dependencyId} value={entry.dependencyId}>{entry.dependencyId}</option>)}
          </select></label>
          <div><span>EXPECTED REVISION</span><code>{selected.value.expectedRevision}</code></div>
          <button type="button" disabled={!state} onClick={() => state && acceptRequest({ ...selected.value, requestId: createUiRequestId(), expectedRevision: state.revision }, selected.fileName, selected.sizeBytes)}><RefreshCw size={13} />绑定当前 revision</button>
        </div> : <div className="mod-transaction-empty"><FileJson size={25} /><strong>等待逻辑请求</strong><small>请求中不能出现主机路径、命令、URL 或 ZIP 内容。</small></div>}
      </section>
    </div>

    {selected && <section className="mod-lock-matrix">
      <header><div><PackageCheck size={17} /><span><strong>锁、依赖与客户端 Parity</strong><small>{selected.value.manifest.serverLock.mods.length} 个锁条目 · {selected.value.manifest.clientParity.mods.length} 个 parity 条目</small></span></div><code>{shortHash(selected.value.manifest.clientParity.serverLockSha256, 18)}</code></header>
      <div className="mod-lock-cells">
        <div><span>{operationNeedsStaging ? '固定暂存候选' : '托管操作目标'}</span><strong>{target?.dependencyId ?? '目标不在锁中'}</strong><small>{preview ? operationNeedsStaging ? '已通过服务端固定暂存根与载荷校验' : '已通过当前托管状态校验；无需新暂存载荷' : '路径不会发送到浏览器；预演时由服务端核验'}</small></div>
        <div><span>依赖闭包</span><strong>{target?.dependencies.length ?? 0} 项直接依赖</strong><small>{target?.dependencies.length ? target.dependencies.join(' · ') : '无直接依赖'}</small></div>
        <div><span>客户端 PARITY</span><strong>{parityCounts.required} 必须 · {parityCounts.optional} 可选</strong><small>{parityCounts.excluded} 项服务端专用</small></div>
        <div><span>PAYLOAD DIGEST</span><strong>{target ? shortHash(target.sha256, 16) : 'UNAVAILABLE'}</strong><small>{target ? `load order ${target.loadOrder} · ${modRequirementLabel(target.clientRequirement)}` : '请修正 target package'}</small></div>
      </div>
      <footer><ShieldCheck size={15} />浏览器只提交此逻辑清单；DLL/JSON 载荷必须已经位于服务端配置的固定暂存根。</footer>
    </section>}

    {selected && <section className="mod-preview-gate">
      <div><ScanSearch size={19} /><span><strong>{preview ? '预演已通过全部一致性门禁' : '执行前必须生成全新预演'}</strong><small>{preview ? `${preview.payloadFileCount} 个文件 · ${formatBytes(preview.payloadSizeBytes)} · next ${shortHash(preview.nextRevision, 12)}` : '验证 operation、revision、锁/parity、依赖闭包、暂存 SHA-256 和快照容量。'}</small></span></div>
      <button type="button" disabled={previewing} onClick={() => void previewDeployment()}><PackageCheck className={previewing ? 'spin' : ''} size={15} />{previewing ? '预演中…' : '生成部署预演'}</button>
    </section>}

    {preview && <section className="mod-preview-result">
      <div><span>状态变化</span><strong>{preview.currentlyInstalled ? (preview.currentlyEnabled ? '已安装 / 已启用' : '已安装 / 已禁用') : '尚未安装'} → {preview.nextEnabled === null ? '移除' : preview.nextEnabled ? '启用' : '禁用'}</strong></div>
      <div><span>快照容量</span><strong className={preview.snapshotsUsed >= preview.snapshotLimit ? 'danger' : ''}>{preview.snapshotsUsed} / {preview.snapshotLimit}</strong></div>
      <div><span>停服证明</span><strong>执行时检查两次</strong><small>进程停止 + 端口关闭</small></div>
      <div><span>恢复策略</span><strong>{preview.recoverablePayloadPreserved ? '保留可恢复载荷' : '创建完整快照'}</strong></div>
    </section>}

    {preview && <section className="mod-execution-confirm">
      <div><TriangleAlert size={22} /><span><strong>精确确认原子发布</strong><small>输入 <code>{confirmationPhrase}</code>。服务端会重新核验 revision，并在发布前后执行两次 stopped gate；失败后自动回滚。</small></span></div>
      <input aria-label="模组部署精确确认" value={confirmation} disabled={!canMutate} onChange={(event) => setConfirmation(event.target.value)} placeholder={confirmationPhrase} />
      <button type="button" className="confirm-execute" disabled={executing || !canMutate || !executionEnabled || mutationBlockedByRecovery || confirmation !== confirmationPhrase}
        onClick={() => void executeDeployment()}>{executing ? '原子发布中…' : !canMutate ? '需要 Administrator' : mutationBlockedByRecovery ? '等待恢复状态收敛' : executionEnabled ? '执行模组事务' : '写操作未启用'}</button>
    </section>}

    {receipt && <section className={`mod-deployment-receipt status-${receipt.status}`} aria-live="polite">
      <span className="receipt-icon">{receipt.status === 'succeeded' ? <Check size={19} /> : <Undo2 size={19} />}</span>
      <div><strong>{receipt.status === 'succeeded' ? '部署事务已提交' : receipt.status === 'rolled-back' ? '发布失败，已自动回滚' : '回滚未完成，需要人工恢复'}</strong><small>{receipt.operation} · {receipt.package.dependencyId} · 请求 {receipt.requestId.slice(0, 8)}{receipt.reused ? ' · 复用既有回执' : ''}</small></div>
      <code>{receipt.newRevision ? shortHash(receipt.newRevision, 16) : 'REVISION UNKNOWN'}</code>
      <b>{formatBytes(receipt.payloadSizeBytes)}</b>
    </section>}

    <section className="mod-receipt-ledger">
      <header><div><History size={17} /><span><strong>部署回执历史</strong><small>持久化时间倒序 · 精确 request ID 可重新核验</small></span></div><b>{receiptHistory ? `${receiptHistory.page.totalReceipts} RECEIPTS` : 'UNAVAILABLE'}</b></header>
      <div className="mod-receipt-lookup">
        <label><span>EXACT REQUEST ID</span><input aria-label="模组部署回执 request ID" value={receiptRequestId}
          onChange={(event) => { setReceiptRequestId(event.target.value); setReceiptHistoryError('') }} placeholder="00000000-0000-4000-8000-000000000000" /></label>
        <button type="button" disabled={receiptLookupLoading || !modDeploymentRequestIdPattern.test(receiptRequestId.trim())}
          onClick={() => void lookupReceipt()}><ScanSearch className={receiptLookupLoading ? 'spin' : ''} size={14} />{receiptLookupLoading ? '核验中…' : '核验完整回执'}</button>
      </div>
      {receiptHistoryError && <p className="mod-receipt-history-error"><TriangleAlert size={14} />{receiptHistoryError}</p>}
      <div className="mod-receipt-history-list">{receiptHistory?.items.length ? receiptHistory.items.map((item) =>
        <article key={`${item.persistedAt}-${item.receipt.requestId}`} className={`status-${item.receipt.status}`}>
          <span>{item.receipt.status === 'succeeded' ? <Check size={14} /> : <Undo2 size={14} />}</span>
          <div><strong>{item.receipt.package.dependencyId}</strong><small>{item.receipt.operation} · {item.receipt.package.version} · {item.receipt.requestId}</small></div>
          <time dateTime={item.persistedAt}>{new Date(item.persistedAt).toLocaleString('zh-CN', { hour12: false })}</time>
          <button type="button" aria-label={`核验回执 ${item.receipt.requestId}`} onClick={() => void lookupReceipt(item.receipt.requestId)}>核验</button>
        </article>) : <p>{loading ? '正在读取持久化回执…' : '尚无可展示的模组部署回执。'}</p>}</div>
      <footer><span>当前展示 {receiptHistory?.items.length ?? 0} / {receiptHistory?.page.totalReceipts ?? 0}</span>
        <button type="button" disabled={receiptHistoryLoading || !receiptHistory?.page.nextCursor}
          onClick={() => void loadMoreReceiptHistory()}><RefreshCw className={receiptHistoryLoading ? 'spin' : ''} size={13} />{receiptHistoryLoading ? '加载中…' : receiptHistory?.page.nextCursor ? '加载更早回执' : '已到历史末端'}</button></footer>
    </section>

    <section className={`mod-explicit-recovery status-${recoveryStatus?.phase ?? 'unavailable'}`}>
      <header><div><Undo2 size={17} /><span><strong>显式事务恢复</strong><small>独立开关 · 精确 request ID · 共享主机恢复租约</small></span></div><b>{recoveryStatus?.phase === 'ready' ? 'READY' : recoveryStatus?.phase === 'recovery-required' ? 'RECOVERY REQUIRED' : 'UNAVAILABLE'}</b></header>
      {recoveryStatus?.phase === 'recovery-required' ? <>
        <div className="mod-explicit-recovery-grid">
          <label><span>中断 REQUEST ID</span><input aria-label="模组恢复 request ID" value={recoveryRequestId} readOnly /></label>
          <label><span>恢复目标</span><select aria-label="模组恢复目标" value={recoveryDesired}
            onChange={(event) => { setRecoveryDesired(event.target.value as ModDeploymentRecoveryDesired); setRecoveryConfirmation('') }}>
            {recoveryStatus.allowedDesired.map((desired) => <option key={desired} value={desired}>{desired === 'candidate' ? '提交候选终态' : '回到上一终态'}</option>)}
          </select></label>
          <label><span>精确确认</span><input aria-label="模组恢复精确确认" value={recoveryConfirmation}
            onChange={(event) => setRecoveryConfirmation(event.target.value)} placeholder={recoveryConfirmationPhrase} /></label>
        </div>
        <p><TriangleAlert size={15} />只允许恢复中断的 {recoveryStatus.operation ?? '未知'} 事务；服务端会在恢复租约内重新读取证据，网页不能指定路径或伪造 transaction。</p>
        <button type="button" className="confirm-execute" disabled={recovering || !canRecover || !recoveryExecutionEnabled ||
          !exactRecoveryRequest || !recoveryDesiredAllowed || recoveryConfirmation !== recoveryConfirmationPhrase}
          onClick={() => void recoverDeployment()}>{recovering ? '正在核验并收敛…' : !canRecover ? '需要 Administrator' : !recoveryExecutionEnabled ? '恢复开关未启用' : '执行精确恢复'}</button>
      </> : <p><ShieldCheck size={15} />{recoveryStatus?.phase === 'ready'
        ? '没有发现未收敛的模组部署事务；普通部署仍需独立写入开关和停服证明。'
        : '恢复状态不可用；普通模组写入保持 fail-closed。'}</p>}
    </section>

    <section className="mod-recovery-panel">
      <header><div><Undo2 size={16} /><strong>恢复与清理要求</strong></div><span>只读计划 · 不提供浏览器删除</span></header>
      <div className="mod-recovery-summary"><div><strong>{recovery?.candidates.filter((item) => item.kind === 'snapshot').length ?? '—'}</strong><span>事务快照</span></div><div><strong>{recovery?.candidates.filter((item) => item.kind === 'failed-publication').length ?? '—'}</strong><span>失败发布载荷</span></div><div><strong>{recovery?.candidates.filter((item) => item.kind === 'abandoned-pending').length ?? '—'}</strong><span>遗留 pending</span></div></div>
      <p><ShieldCheck size={14} />清理是不可逆操作，核心当前明确标记 executeSupported=false；必须先离线核验恢复点，本界面不会提供删除按钮。</p>
    </section>
  </div>
}

function ManagedModConfigurationWorkspace({
  deployment, executionEnabled, canMutate
}: {
  deployment: ModDeploymentStateSummary | null
  executionEnabled: boolean
  canMutate: boolean
}) {
  const [schemas, setSchemas] = useState<ManagedModConfigurationSchema[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [inspection, setInspection] = useState<ManagedModConfigurationInspection | null>(null)
  const [drafts, setDrafts] = useState<Record<string, boolean | number | string>>({})
  const [clearSecrets, setClearSecrets] = useState<Record<string, boolean>>({})
  const [preview, setPreview] = useState<ManagedModConfigurationPreview | null>(null)
  const [previewedRequest, setPreviewedRequest] = useState<ManagedModConfigurationRequest | null>(null)
  const [receipt, setReceipt] = useState<ManagedModConfigurationReceipt | null>(null)
  const [confirmation, setConfirmation] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const selected = useMemo(() => schemas.find((schema) => schema.id === selectedId) ?? null, [schemas, selectedId])
  const request = useMemo<ManagedModConfigurationRequest | null>(() => {
    if (!selected || !inspection || !deployment) return null
    const changes = selected.fields.flatMap((field) => {
      const current = inspection.fields.find((entry) => entry.id === field.id)?.value
      const draft = drafts[field.id]
      if (field.secret) {
        if (clearSecrets[field.id]) return [{ id: field.id, value: '' }]
        return typeof draft === 'string' && draft.length > 0 ? [{ id: field.id, value: draft }] : []
      }
      return draft !== undefined && draft !== current ? [{ id: field.id, value: draft }] : []
    })
    if (changes.length === 0) return null
    return {
      requestId: createUiRequestId(), operation: 'configure', schemaId: selected.id, package: selected.package,
      expectedDeploymentRevision: deployment.revision, expectedConfigurationRevision: inspection.configurationRevision, changes
    }
  }, [clearSecrets, deployment, drafts, inspection, selected])
  const previewMatchesRequest = preview !== null && previewedRequest !== null && request !== null &&
    preview.requestId === previewedRequest.requestId && request.requestId === previewedRequest.requestId
  const confirmationPhrase = 'CONFIGURE_MANAGED_MOD'

  useEffect(() => {
    const controller = new AbortController()
    void api.managedModConfigurationSchemas(controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setSchemas(result.data)
      setSelectedId((current) => current || result.data[0]?.id || '')
      setMessage(result.data.length ? '' : '没有已声明的受管模组配置 schema；未声明插件保持不可用。')
    }).catch((reason) => {
      if (!controller.signal.aborted) setMessage(formatModWorkspaceError(reason, '受管模组配置不可用；未声明插件保持 fail-closed。'))
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!selected || !deployment) return
    const controller = new AbortController()
    setInspection(null); setPreview(null); setPreviewedRequest(null); setReceipt(null); setConfirmation(''); setDrafts({}); setClearSecrets({})
    void api.inspectManagedModConfiguration({
      schemaId: selected.id, package: selected.package, expectedDeploymentRevision: deployment.revision
    }, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setInspection(result.data)
      const next: Record<string, boolean | number | string> = {}
      for (const field of result.data.fields) {
        if (field.type !== 'secret' && typeof field.value !== 'object') next[field.id] = field.value
      }
      setDrafts(next); setMessage('')
    }).catch((reason) => {
      if (!controller.signal.aborted) setMessage(formatModWorkspaceError(reason, '此受管插件当前不可配置；没有 schema 的插件不会开放写入。'))
    })
    return () => controller.abort()
  }, [deployment?.revision, selected])

  useEffect(() => {
    if (!previewedRequest || request?.requestId === previewedRequest.requestId) return
    setPreview(null)
    setPreviewedRequest(null)
    setConfirmation('')
  }, [previewedRequest, request?.requestId])

  async function previewConfiguration(): Promise<void> {
    if (!request) return
    setBusy(true); setMessage('')
    try {
      const result = await api.previewManagedModConfiguration(request)
      setPreview(result.data); setPreviewedRequest(request); setReceipt(null); setConfirmation('')
    } catch (reason) {
      setMessage(formatModWorkspaceError(reason, '配置预演被拒绝；未写入任何配置文件。'))
    } finally { setBusy(false) }
  }

  async function executeConfiguration(): Promise<void> {
    if (!preview || !previewedRequest || !previewMatchesRequest || !canMutate || !executionEnabled || confirmation !== confirmationPhrase) return
    setBusy(true); setMessage('')
    try {
      const result = await api.executeManagedModConfiguration(previewedRequest, preview.requestFingerprint)
      setReceipt(result.data); setPreview(null); setPreviewedRequest(null); setConfirmation('')
      const refreshed = await api.inspectManagedModConfiguration({
        schemaId: selected!.id, package: selected!.package, expectedDeploymentRevision: deployment!.revision
      })
      setInspection(refreshed.data)
    } catch (reason) {
      setMessage(formatModWorkspaceError(reason, '配置提交失败；服务端保留保护点、回执和回滚结果。'))
    } finally { setBusy(false) }
  }

  return <section className="mod-receipt-ledger" aria-label="受管模组配置">
    <header><div><FileCog size={17} /><span><strong>受管模组配置</strong><small>严格 schema · 脱敏差异 · 固定 BepInEx 根目录 · 无任意路径或脚本</small></span></div><b>{loading ? 'LOADING' : selected ? 'SCHEMA-BOUND' : 'UNAVAILABLE'}</b></header>
    {schemas.length > 0 && <label><span>已声明 Schema</span><select aria-label="受管模组配置 schema" value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
      {schemas.map((schema) => <option key={schema.id} value={schema.id}>{schema.package.dependencyId} · {schema.package.version}</option>)}
    </select></label>}
    {inspection && selected && <div className="mod-target-editor">
      {selected.fields.map((field) => <label key={field.id}><span>{field.id}{field.secret ? '（已脱敏）' : ''}</span>{field.type === 'boolean'
        ? <select aria-label={`配置 ${field.id}`} value={String(drafts[field.id] ?? false)} onChange={(event) => setDrafts((current) => ({ ...current, [field.id]: event.target.value === 'true' }))}><option value="true">true</option><option value="false">false</option></select>
        : field.type === 'integer'
          ? <input aria-label={`配置 ${field.id}`} type="number" min={field.minimum} max={field.maximum} step={1} value={String(drafts[field.id] ?? '')} onChange={(event) => setDrafts((current) => ({ ...current, [field.id]: Number(event.target.value) }))} />
          : <span className="mod-secret-editor"><input aria-label={`配置 ${field.id}`} type="password" maxLength={field.maximumLength} autoComplete="new-password" disabled={Boolean(clearSecrets[field.id])} value={String(drafts[field.id] ?? '')} onChange={(event) => { const value = event.target.value; setDrafts((current) => ({ ...current, [field.id]: value })); if (value.length > 0) setClearSecrets((current) => ({ ...current, [field.id]: false })) }} placeholder={(inspection.fields.find((entry) => entry.id === field.id)?.value as { configured?: boolean } | undefined)?.configured ? '已配置；留空保持不变' : '留空保持不变'} /><button type="button" aria-label={`清除 ${field.id}`} aria-pressed={Boolean(clearSecrets[field.id])} onClick={() => { setDrafts((current) => ({ ...current, [field.id]: '' })); setClearSecrets((current) => ({ ...current, [field.id]: !current[field.id] })) }}>{clearSecrets[field.id] ? '取消清除' : '清除当前密钥'}</button></span>}</label>)}
    </div>}
    {message && <p className="mod-receipt-history-error" role="status"><TriangleAlert size={14} />{message}</p>}
    {request && <div className="mod-preview-gate"><div><ScanSearch size={19} /><span><strong>{previewMatchesRequest ? '配置预演已建立' : '仅提交变更字段；未知字段会被拒绝'}</strong><small>{previewMatchesRequest && preview ? `${preview.changes.filter((entry) => entry.changed).length} 项差异 · secret 只显示已配置状态` : '先进行 dry-run，服务器重新绑定部署 revision 与配置 revision。'}</small></span></div><button type="button" disabled={busy} onClick={() => void previewConfiguration()}>{busy ? '预演中…' : '生成配置预演'}</button></div>}
    {previewMatchesRequest && preview && <><div className="mod-preview-result">{preview.changes.map((change) => <div key={change.id}><span>{change.id}</span><strong>{change.changed ? '将变更' : '无变化'}</strong><small>{typeof change.before === 'object' ? `已配置: ${change.before.configured ? '是' : '否'}` : `${String(change.before)} → ${typeof change.after === 'object' ? `已配置: ${change.after.configured ? '是' : '否'}` : String(change.after)}`}</small></div>)}</div><div className="mod-execution-confirm"><div><TriangleAlert size={22} /><span><strong>精确确认配置写入</strong><small>输入 <code>{confirmationPhrase}</code>；执行使用共享主机 mutation lease、停服门禁、原子写入和保护点。</small></span></div><input aria-label="受管模组配置精确确认" value={confirmation} disabled={!canMutate} onChange={(event) => setConfirmation(event.target.value)} placeholder={confirmationPhrase} /><button type="button" className="confirm-execute" disabled={busy || !canMutate || !executionEnabled || confirmation !== confirmationPhrase} onClick={() => void executeConfiguration()}>{busy ? '提交中…' : !canMutate ? '需要 Administrator' : !executionEnabled ? '写操作未启用' : '提交受管配置'}</button></div></>}
    {receipt && <div className={`mod-deployment-receipt status-${receipt.status === 'applied' ? 'succeeded' : receipt.status}`} aria-live="polite"><span className="receipt-icon">{receipt.status === 'applied' ? <Check size={19} /> : <Undo2 size={19} />}</span><div><strong>{receipt.status === 'applied' ? '受管配置已提交' : '受管配置已回滚或需恢复'}</strong><small>{receipt.changedFieldIds.join(', ') || '无字段变化'} · {receipt.requestId}</small></div><code>{receipt.newConfigurationRevision ? shortHash(receipt.newConfigurationRevision, 16) : 'ROLLBACK'}</code></div>}
    {!loading && !selected && <p><ShieldCheck size={15} />没有声明 schema 的插件不可配置；浏览器不能提交路径、节、键或脚本。</p>}
  </section>
}

function parseLogicalModDeploymentRequest(input: unknown): ModDeploymentRequest {
  if (!isPlainRecord(input) || hasUnexpectedKeys(input, ['requestId', 'operation', 'package', 'manifest', 'expectedRevision'])
      || containsForbiddenModTransport(input)) throw new Error('INVALID_LOGICAL_MOD_REQUEST')
  if (typeof input.requestId !== 'string' || !modDeploymentRequestIdPattern.test(input.requestId)
      || !modDeploymentOperations.some((item) => item.operation === input.operation)
      || typeof input.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(input.expectedRevision)
      || !isPlainRecord(input.package) || hasUnexpectedKeys(input.package, ['dependencyId', 'version'])
      || typeof input.package.dependencyId !== 'string' || typeof input.package.version !== 'string'
      || !isPlainRecord(input.manifest) || hasUnexpectedKeys(input.manifest, ['serverLock', 'clientParity', 'platformLock'])
      || !isLogicalModPlatformLock(input.manifest.platformLock)) {
    throw new Error('INVALID_LOGICAL_MOD_REQUEST')
  }
  return input as unknown as ModDeploymentRequest
}

function isLogicalModPlatformLock(value: unknown): boolean {
  if (!isPlainRecord(value) || hasUnexpectedKeys(value, [
    'format', 'schemaVersion', 'serverLockSha256', 'inventoryRevision', 'requirements', 'digest'
  ]) || value.format !== 'dyson-control-mod-platform-lock' || value.schemaVersion !== 1 ||
      typeof value.serverLockSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.serverLockSha256) ||
      typeof value.digest !== 'string' || !/^[0-9a-f]{64}$/.test(value.digest) ||
      (value.inventoryRevision !== null && (typeof value.inventoryRevision !== 'string' ||
        !/^[0-9a-f]{64}$/.test(value.inventoryRevision))) || !Array.isArray(value.requirements) ||
      value.requirements.length > 6 || ((value.requirements.length === 0) !== (value.inventoryRevision === null))) {
    return false
  }
  const sources = new Set<string>()
  return value.requirements.every((requirement) => {
    if (!isPlainRecord(requirement) || hasUnexpectedKeys(requirement, [
      'dependencyId', 'sourceId', 'deploymentOwner', 'requiredVersion'
    ]) || typeof requirement.dependencyId !== 'string' || typeof requirement.sourceId !== 'string' ||
        typeof requirement.requiredVersion !== 'string' ||
        !['nebula', 'bepinex'].includes(String(requirement.deploymentOwner))) return false
    const source = requirement.sourceId.toLowerCase()
    if (sources.has(source)) return false
    sources.add(source)
    return true
  })
}

function containsForbiddenModTransport(value: unknown, depth = 0): boolean {
  if (depth > 12) return true
  if (typeof value === 'string') {
    return /^(?:[A-Za-z]:[\\/]|\\\\|\/|https?:\/\/|file:)/i.test(value) || /\.zip(?:$|[?#])/i.test(value)
  }
  if (Array.isArray(value)) return value.some((entry) => containsForbiddenModTransport(entry, depth + 1))
  if (!isPlainRecord(value)) return value !== null && typeof value === 'object'
  const forbiddenKeys = /^(?:path|paths|command|commands|zip|archive|url|uri|binary|payload|stagingPath|pluginsRoot)$/i
  return Object.entries(value).some(([key, entry]) => forbiddenKeys.test(key)
    || containsForbiddenModTransport(entry, depth + 1))
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasUnexpectedKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed)
  return Object.keys(value).some((key) => !allowedKeys.has(key))
}

function fictionalModDeploymentRequest(expectedRevision: string): ModDeploymentRequest {
  const target: ModServerLockEntry = {
    dependencyId: 'Fictional-ModConsole-1.0.0',
    sourceId: 'thunderstore:Fictional/ModConsole',
    version: '1.0.0',
    sha256: '06048f06ce616d0725ab3452a6e55dc2feab984b3d7c63e017afa715e3a3c568',
    dependencies: [],
    loadOrder: 0,
    root: true,
    serverRequired: true,
    clientRequirement: 'required'
  }
  return {
    requestId: createUiRequestId(),
    operation: 'install',
    package: { dependencyId: target.dependencyId, version: target.version },
    manifest: {
      serverLock: { format: 'dyson-control-server-mod-lock', schemaVersion: 1, mods: [target] },
      clientParity: {
        format: 'dyson-control-client-parity',
        schemaVersion: 1,
        serverLockSha256: '91dcc0cc67bebc00ad3e2d2fd707c11b0fc48e4fae01e47d04972b443f5a05ec',
        mods: [{
          sourceId: target.sourceId,
          version: target.version,
          sha256: target.sha256,
          serverRequired: target.serverRequired,
          clientRequirement: target.clientRequirement
        }]
      },
      platformLock: {
        format: 'dyson-control-mod-platform-lock',
        schemaVersion: 1,
        serverLockSha256: '91dcc0cc67bebc00ad3e2d2fd707c11b0fc48e4fae01e47d04972b443f5a05ec',
        inventoryRevision: null,
        requirements: [],
        digest: '68efc0d4187fb0fc1529cef4ad3f36d8d54d0e34e78ca448b5567e735843bc3f'
      }
    },
    expectedRevision
  }
}

function modRequirementLabel(value: 'required' | 'optional' | 'not-required'): string {
  return value === 'required' ? '客户端必须' : value === 'optional' ? '客户端可选' : '服务端专用'
}

function shortHash(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`
}

function formatModWorkspaceError(reason: unknown, fallback: string): string {
  return reason instanceof ApiError
    ? `${reason.message}${reason.code ? ` · ${reason.code}` : ''}`
    : fallback
}

const maximumClientProfileRequestBytes = 2 * 1_024 * 1_024

const fictionalClientProfileRequest = {
  schemaVersion: 1,
  profile: {
    profileId: 'fictional-profile',
    displayName: 'Fictional Dyson Server',
    connection: { host: 'dsp.example.com', port: 8469 }
  },
  compatibility: {
    inventory: {
      dsp: '0.10.34.28529',
      nebula: '0.9.22.2',
      bepInEx: '5.4.17.0',
      plugins: [{
        sourceId: 'thunderstore:NebulaModTeam/NebulaMultiplayerMod',
        version: '0.9.22.2'
      }]
    },
    matrix: {
      schemaVersion: 1,
      entries: [{
        id: 'supported-example',
        core: {
          dsp: { equals: '0.10.34.28529' },
          nebula: { equals: '0.9.22.2' },
          bepInEx: { equals: '5.4.17.0' }
        },
        plugins: [{
          sourceId: 'thunderstore:NebulaModTeam/NebulaMultiplayerMod',
          range: { equals: '0.9.22.2' },
          required: true
        }]
      }]
    }
  },
  serverLock: {
    format: 'dyson-control-server-mod-lock',
    schemaVersion: 1,
    mods: [
      {
        dependencyId: 'Fictional-CosmeticLights-1.1.0',
        sourceId: 'thunderstore:Fictional/CosmeticLights',
        version: '1.1.0',
        sha256: 'c'.repeat(64),
        dependencies: [],
        loadOrder: 0,
        root: true,
        serverRequired: false,
        clientRequirement: 'optional'
      },
      {
        dependencyId: 'Fictional-ServerHelper-1.0.0',
        sourceId: 'thunderstore:Fictional/ServerHelper',
        version: '1.0.0',
        sha256: 'a'.repeat(64),
        dependencies: [],
        loadOrder: 1,
        root: false,
        serverRequired: true,
        clientRequirement: 'not-required'
      },
      {
        dependencyId: 'Fictional-MultiplayerRoot-2.0.0',
        sourceId: 'thunderstore:Fictional/MultiplayerRoot',
        version: '2.0.0',
        sha256: 'b'.repeat(64),
        dependencies: ['Fictional-ServerHelper-1.0.0'],
        loadOrder: 2,
        root: true,
        serverRequired: true,
        clientRequirement: 'required'
      }
    ]
  },
  clientParity: {
    format: 'dyson-control-client-parity',
    schemaVersion: 1,
    serverLockSha256: 'e6239b3dd4d69a56c48d93b04a8bb8096cae84541384b10c361475d424f5e943',
    mods: [
      {
        sourceId: 'thunderstore:Fictional/CosmeticLights',
        version: '1.1.0',
        sha256: 'c'.repeat(64),
        serverRequired: false,
        clientRequirement: 'optional'
      },
      {
        sourceId: 'thunderstore:Fictional/ServerHelper',
        version: '1.0.0',
        sha256: 'a'.repeat(64),
        serverRequired: true,
        clientRequirement: 'not-required'
      },
      {
        sourceId: 'thunderstore:Fictional/MultiplayerRoot',
        version: '2.0.0',
        sha256: 'b'.repeat(64),
        serverRequired: true,
        clientRequirement: 'required'
      }
    ]
  }
}

interface SelectedClientProfileRequest {
  fileName: string
  sizeBytes: number
  value: Record<string, unknown>
}

export function ClientPackageWorkspace({ demo, canGenerate = true }: { demo: boolean; canGenerate?: boolean }) {
  const [selected, setSelected] = useState<SelectedClientProfileRequest | null>(null)
  const [generated, setGenerated] = useState<GeneratedClientProfile | null>(null)
  const [download, setDownload] = useState<Omit<ClientProfileArchiveDownload, 'blob'> | null>(null)
  const [dragging, setDragging] = useState(false)
  const [reading, setReading] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const fileReadSequenceRef = useRef(0)
  const previewSequenceRef = useRef(0)
  const downloadSequenceRef = useRef(0)
  const downloadUrlRef = useRef<string | null>(null)

  useEffect(() => () => {
    fileReadSequenceRef.current++
    previewSequenceRef.current++
    downloadSequenceRef.current++
    if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current)
  }, [])

  function discardDownload(): void {
    if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current)
    downloadUrlRef.current = null
    setDownload(null)
  }

  function acceptParsedRequest(value: Record<string, unknown>, fileName: string, sizeBytes: number): void {
    previewSequenceRef.current++
    downloadSequenceRef.current++
    discardDownload()
    setSelected({ value, fileName, sizeBytes })
    setGenerated(null)
    setPreviewing(false)
    setDownloading(false)
    setError('')
  }

  async function readFiles(files: FileList | readonly File[]): Promise<void> {
    if (files.length !== 1) {
      setError('一次只能选择一个 JSON 请求文件。')
      return
    }
    const file = files[0]
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.json')) {
      setError('只接受扩展名为 .json 的 profile-generation request。')
      return
    }
    if (file.size > maximumClientProfileRequestBytes) {
      setError('JSON 请求文件不能超过 2 MiB。')
      return
    }

    const sequence = ++fileReadSequenceRef.current
    setReading(true)
    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as unknown
      if (sequence !== fileReadSequenceRef.current) return
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setError('JSON 顶层必须是一个对象。')
        return
      }
      acceptParsedRequest(parsed as Record<string, unknown>, file.name, file.size)
    } catch {
      if (sequence === fileReadSequenceRef.current) setError('无法读取或解析所选 JSON 文件。')
    } finally {
      if (sequence === fileReadSequenceRef.current) setReading(false)
    }
  }

  function useFictionalExample(): void {
    const value = structuredClone(fictionalClientProfileRequest) as unknown as Record<string, unknown>
    acceptParsedRequest(value, 'fictional-client-profile-request.json', JSON.stringify(value).length)
  }

  async function generatePreview(): Promise<void> {
    if (!selected || !canGenerate) return
    const sequence = ++previewSequenceRef.current
    setPreviewing(true)
    setError('')
    try {
      const response = await api.generateClientProfile(selected.value)
      if (sequence !== previewSequenceRef.current) return
      discardDownload()
      setGenerated(response.data)
    } catch (reason) {
      if (sequence !== previewSequenceRef.current) return
      setError(reason instanceof ApiError
        ? `${reason.message}${reason.code ? ` · ${reason.code}` : ''}`
        : '客户端资料生成失败；原始 JSON 仍保留在当前页面。')
    } finally {
      if (sequence === previewSequenceRef.current) setPreviewing(false)
    }
  }

  async function downloadArchive(): Promise<void> {
    if (!selected || !generated || !canGenerate) return
    const sequence = ++downloadSequenceRef.current
    setDownloading(true)
    setError('')
    try {
      const result = await api.downloadClientProfileArchive(selected.value)
      if (sequence !== downloadSequenceRef.current) return
      discardDownload()
      const objectUrl = URL.createObjectURL(result.blob)
      downloadUrlRef.current = objectUrl
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = result.fileName
      link.rel = 'noopener'
      document.body.append(link)
      link.click()
      link.remove()
      setDownload({ fileName: result.fileName, sha256: result.sha256, sizeBytes: result.sizeBytes })
    } catch (reason) {
      if (sequence !== downloadSequenceRef.current) return
      setError(reason instanceof ApiError
        ? `${reason.message}${reason.code ? ` · ${reason.code}` : ''}`
        : 'ZIP 下载失败；已验证的预览与原始 JSON 保持不变。')
    } finally {
      if (sequence === downloadSequenceRef.current) setDownloading(false)
    }
  }

  return <div className="client-package-workspace">
    <QualifiedClientIssuePanel canGenerate={canGenerate} />
    {!canGenerate && <div className="permission-lock-note"><LockKeyhole size={15} /><span><strong>客户端生成只读</strong><small>当前角色可以查看页面边界，但不能向生成 API 提交请求或下载 ZIP。</small></span></div>}
    <section className="client-package-intake">
      <div className={`client-drop-zone${dragging ? ' dragging' : ''}`}
        onDragEnter={(event) => { event.preventDefault(); setDragging(true) }}
        onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
        onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false) }}
        onDrop={(event) => { event.preventDefault(); setDragging(false); void readFiles(event.dataTransfer.files) }}>
        <span className="client-drop-orbit"><FileJson size={25} /></span>
        <div><strong>{selected ? selected.fileName : '选择或拖入客户端生成请求'}</strong><small>{selected ? `${formatBytes(selected.sizeBytes)} · 仅保存在当前浏览器内存` : '单个 JSON · 最大 2 MiB · 不读取其他格式'}</small></div>
        <button type="button" onClick={() => fileInputRef.current?.click()} disabled={reading}><CloudDownload size={15} />{reading ? '读取中…' : '选择 JSON'}</button>
        <input className="client-file-input" ref={fileInputRef} type="file" accept=".json,application/json"
          aria-label="选择客户端 Profile 请求 JSON" onChange={(event) => {
            const input = event.currentTarget
            if (input.files) void readFiles(input.files)
            input.value = ''
          }} />
      </div>
      <div className="client-intake-actions"><span><ShieldCheck size={15} />文件名与内容不会写入磁盘或日志；只有解析后的 JSON 会在点击预览时发送给认证 API。</span><button type="button" onClick={useFictionalExample}><ScanSearch size={14} />使用虚构示例</button></div>
      <p className="client-example-note">{demo ? '演示环境：示例使用 Fictional 模组与 dsp.example.com。' : '生产页面不会自动注入示例；按钮需要管理员明确点击。'}</p>
    </section>

    {error && <div className="client-package-error" role="alert"><TriangleAlert size={16} /><span>{error}</span></div>}

    {selected && <section className="client-request-gate"><div><Code2 size={17} /><span><strong>本地请求已就绪</strong><small>先通过服务器端一致性与公开内容校验，成功后才开放 ZIP。</small></span></div><button type="button" onClick={() => void generatePreview()} disabled={!canGenerate || previewing}><PackageCheck className={previewing ? 'spin' : ''} size={15} />{previewing ? '验证中…' : canGenerate ? '生成资料预览' : '当前角色只读'}</button></section>}

    {!selected && <div className="client-package-empty"><Archive size={28} /><strong>尚未选择生成请求</strong><small>不会从生产环境自动填充配置，也不会扫描本地目录。</small></div>}

    {generated && <>
      <section className="client-profile-identity">
        <div><span>PROFILE ID</span><strong>{generated.profile.profileId}</strong><small>{generated.profile.displayName} · {generated.profile.connection.displayAddress}</small></div>
        <div><span>DSP</span><strong>{generated.profile.runtime.dsp}</strong><small>{generated.profile.runtime.compatibilityEntryId}</small></div>
        <div><span>NEBULA</span><strong>{generated.profile.runtime.nebula}</strong><small>direct / nebula</small></div>
        <div><span>BEPINEX</span><strong>{generated.profile.runtime.bepInEx}</strong><small>客户端运行时</small></div>
      </section>

      <section className="client-parity-grid">
        <ClientRequirementColumn tone="required" title="必须安装" count={generated.parityReport.counts.required} entries={generated.parityReport.required} />
        <ClientRequirementColumn tone="optional" title="可选模组" count={generated.parityReport.counts.optional} entries={generated.parityReport.optional} />
        <ClientRequirementColumn tone="excluded" title="服务端专用" count={generated.parityReport.counts.notRequired} entries={generated.parityReport.notRequired} />
      </section>

      <section className="client-artifact-module">
        <header><div><Archive size={17} /><span><strong>确定性 Artifact Set</strong><small>{generated.artifacts.length} 项固定清单 · 不包含游戏或模组二进制</small></span></div><div><code>{generated.artifactSetSha256}</code><b>{formatBytes(generated.totalSizeBytes)}</b></div></header>
        <div className="client-artifact-list">{generated.artifacts.map((artifact, index) => <div key={artifact.entryName}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{artifact.entryName}</strong><small>{artifact.mediaType}</small></div><code>{artifact.sha256.slice(0, 12)}…</code><b>{formatBytes(artifact.sizeBytes)}</b></div>)}</div>
      </section>

      <section className="client-download-dock">
        <div><Download size={22} /><span><strong>生成并独立校验 ZIP</strong><small>服务端会重新生成同一资料集、构建固定 ZIP，并在返回前重新解析校验。</small></span></div>
        <button type="button" onClick={() => void downloadArchive()} disabled={!canGenerate || downloading}><Download className={downloading ? 'spin' : ''} size={16} />{downloading ? '校验并生成中…' : canGenerate ? '下载客户端 ZIP' : '当前角色只读'}</button>
      </section>
      {download && <section className="client-download-receipt" aria-live="polite"><Check size={17} /><span><strong>{download.fileName} 已交给浏览器下载</strong><small>{formatBytes(download.sizeBytes)} · {download.sizeBytes.toLocaleString()} 字节 · 响应 SHA-256</small></span><code>{download.sha256}</code></section>}
    </>}
  </div>
}

function ClientRequirementColumn({ title, count, entries, tone }: {
  title: string
  count: number
  entries: Array<{ sourceId: string; version: string }>
  tone: 'required' | 'optional' | 'excluded'
}) {
  return <div className={`client-requirement-column ${tone}`}><header><span>{title}</span><b>{count}</b></header><div>{entries.length > 0 ? entries.map((entry) => <div key={`${entry.sourceId}:${entry.version}`}><strong>{entry.sourceId.replace('thunderstore:', '')}</strong><small>{entry.version}</small></div>) : <p>无条目</p>}</div></div>
}

const observabilityHistoryPoints = 36
const observabilityPollIntervalMs = 10_000

const observabilityHealthLabels: Record<ObservabilityHealthStatus, string> = {
  healthy: '已测项健康', unknown: '证据不完整', warning: '存在压力', critical: '需要处理'
}

const observabilityHintLabels: Record<ObservabilityHintCode, string> = {
  HOST_CPU_PRESSURE: '主机 CPU 持续高负载',
  HOST_CPU_SATURATED: '主机 CPU 已接近饱和',
  SINGLE_CORE_SATURATION: '检测到单核饱和',
  MEMORY_PRESSURE: '主机内存压力升高',
  MEMORY_EXHAUSTION: '主机内存接近耗尽',
  PROJECT_VOLUME_PRESSURE: '项目磁盘空间压力升高',
  PROJECT_VOLUME_EXHAUSTION: '项目磁盘空间接近耗尽',
  SAVE_VOLUME_PRESSURE: '存档磁盘空间压力升高',
  SAVE_VOLUME_EXHAUSTION: '存档磁盘空间接近耗尽',
  NETWORK_TELEMETRY_UNAVAILABLE: '网络遥测证据不可用',
  PROCESS_CPU_PRESSURE: 'DSP 进程 CPU 压力升高',
  PROCESS_MEMORY_DOMINANT: 'DSP 工作集占用主机内存过高',
  GAME_PORT_NOT_LISTENING: '进程运行但游戏端口未监听',
  UNEXPECTED_GAME_PORT_LISTENER: '进程停止但游戏端口仍有监听',
  RUNTIME_PROCESS_STATE_MISMATCH: '进程状态与 PID 证据矛盾',
  SIMULATION_BELOW_TARGET: '实际 UPS 低于目标值',
  SIMULATION_TELEMETRY_UNAVAILABLE: '实际 UPS/TPS 尚未由游戏桥上报',
  RUNTIME_STATE_UNKNOWN: '运行状态未知',
  OBSERVABILITY_INCOMPLETE: '关键观测证据不完整'
}

export function ServerObservabilityWorkspace({ canAcknowledge = false }: { canAcknowledge?: boolean }) {
  const [snapshot, setSnapshot] = useState<ServerObservabilitySnapshot | null>(null)
  const [history, setHistory] = useState<ObservabilityDownsampleResult | null>(null)
  const [alertProjection, setAlertProjection] = useState<ObservabilityAlertProjection | null>(null)
  const [alertRecoveryRequired, setAlertRecoveryRequired] = useState(false)
  const [alertError, setAlertError] = useState('')
  const [qualification, setQualification] = useState<LateGameQualificationReport | null>(null)
  const [qualificationMeta, setQualificationMeta] = useState<ObservabilityQualificationEnvelope['meta'] | null>(null)
  const [qualificationStale, setQualificationStale] = useState(false)
  const [qualificationError, setQualificationError] = useState('')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const controllerRef = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setBusy(true)
    try {
      const [telemetryResult, qualificationResult, alertResult] = await Promise.allSettled([
        Promise.all([
          api.observabilitySnapshot(controller.signal),
          api.observabilityHistory(observabilityHistoryPoints, controller.signal)
        ]),
        api.observabilityQualification(controller.signal),
        api.observabilityAlerts(controller.signal)
      ])
      if (controller.signal.aborted) return

      if (telemetryResult.status === 'fulfilled') {
        const [current, shortHistory] = telemetryResult.value
        setSnapshot(current.data)
        setHistory(shortHistory.data)
        setError('')
      } else {
        const telemetryError = telemetryResult.reason
        setError(telemetryError instanceof ApiError
          ? `${telemetryError.message}${telemetryError.code ? ` · ${telemetryError.code}` : ''}`
          : '服务器观测链路暂不可用')
      }

      if (qualificationResult.status === 'fulfilled') {
        setQualification(qualificationResult.value.data)
        setQualificationMeta(qualificationResult.value.meta)
        setQualificationStale(false)
        setQualificationError('')
      } else {
        const qualificationLoadError = qualificationResult.reason
        setQualificationStale(true)
        setQualificationError(qualificationLoadError instanceof ApiError
          ? `${qualificationLoadError.message}${qualificationLoadError.code ? ` · ${qualificationLoadError.code}` : ''}`
          : '六小时资格报告暂不可用')
      }

      if (alertResult.status === 'fulfilled') {
        setAlertProjection(alertResult.value.data)
        setAlertRecoveryRequired(alertResult.value.meta.recoveryRequired)
        setAlertError('')
      } else {
        const alertLoadError = alertResult.reason
        setAlertProjection(null)
        setAlertRecoveryRequired(alertLoadError instanceof ApiError
          && alertLoadError.code === 'OBSERVABILITY_ALERT_PERSISTENCE_RECOVERY_REQUIRED')
        setAlertError(alertLoadError instanceof ApiError
          ? `${alertLoadError.message}${alertLoadError.code ? ` · ${alertLoadError.code}` : ''}`
          : '持久告警投影暂不可用')
      }
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null
        setBusy(false)
      }
    }
  }, [])

  const acknowledgeAlert = useCallback(async (episodeId: string) => {
    const result = await api.acknowledgeObservabilityAlert(episodeId)
    setAlertProjection((current) => current === null ? current : ({
      ...current,
      episodes: current.episodes.map((episode) => episode.id === result.data.id ? result.data : episode)
    }))
  }, [])

  useEffect(() => {
    let disposed = false
    let timer: number | undefined
    const poll = async () => {
      await load()
      if (!disposed) timer = window.setTimeout(poll, observabilityPollIntervalMs)
    }
    void poll()
    return () => {
      disposed = true
      if (timer !== undefined) window.clearTimeout(timer)
      const controller = controllerRef.current
      controllerRef.current = null
      controller?.abort()
    }
  }, [load])

  const health = snapshot?.health.status ?? 'unknown'
  return <div className="observability-workspace">
    <section className={`observability-command-deck health-${health}`}>
      <div className="observability-orbit" aria-hidden="true"><Activity size={21} /><i /><i /><i /></div>
      <div className="observability-title"><strong>SERVER TELEMETRY ARRAY</strong><span>{snapshot ? `${snapshot.source} · ${relativeTime(snapshot.observedAt)}` : '等待首个可信样本'}</span></div>
      <div className="observability-health"><i /><span>{observabilityHealthLabels[health]}<small>{snapshot ? `保留 ${history?.retainedSamples ?? 0} 个样本` : '未建立快照'}</small></span></div>
      <button type="button" onClick={() => void load()} disabled={busy}><RefreshCw className={busy ? 'spin' : ''} size={15} />{busy ? '采集中' : '立即采样'}</button>
    </section>

    {error && <div className="observability-error" role="alert"><TriangleAlert size={16} /><span><strong>观测请求失败</strong><small>{error}；保留上一个成功快照，不填充虚构数值。</small></span></div>}
    {!snapshot && <div className="observability-loading"><span className="spinner" /><strong>正在读取主机与 DSP 进程状态</strong><small>实际 UPS/TPS 只有上游明确上报后才会显示。</small></div>}

    {alertError && <div className="observability-error" role="alert"><TriangleAlert size={16} /><span><strong>持久告警投影请求失败</strong><small>{alertError}；确认入口已 fail-closed 锁定。</small></span></div>}
    <Suspense fallback={<div className="observability-loading"><span className="spinner" /><strong>正在装载持久告警事件面板</strong><small>不会将静态提示冒充为已持久事件。</small></div>}>
      <ObservabilityAlertPanel projection={alertProjection}
        recoveryRequired={alertRecoveryRequired}
        canAcknowledge={canAcknowledge}
        onAcknowledge={acknowledgeAlert} />
    </Suspense>

    <ObservabilityQualificationPanel report={qualification} meta={qualificationMeta}
      stale={qualificationStale} error={qualificationError} busy={busy} />

    {snapshot && <>
      <div className="observability-metrics">
        <ObservabilityMetricCard icon={Cpu} eyebrow="HOST / TOTAL CPU"
          value={formatObserved(snapshot.host.cpu.totalPercent, (value) => `${value.toFixed(1)}%`)}
          detail={`${formatObserved(snapshot.host.cpu.logicalProcessorCount, (value) => `${value} 个逻辑处理器`)} · 按主机总量采样`}
          progress={availableValue(snapshot.host.cpu.totalPercent)} />
        <ObservabilityMetricCard icon={MemoryStick} eyebrow="HOST / MEMORY"
          value={formatObserved(snapshot.host.memory.usedPercent, (value) => `${value.toFixed(1)}%`)}
          detail={`${formatObserved(snapshot.host.memory.usedBytes, formatBytes)} / ${formatObserved(snapshot.host.memory.totalBytes, formatBytes)} 已用`}
          progress={availableValue(snapshot.host.memory.usedPercent)} />
        <ObservabilityMetricCard icon={Activity} eyebrow="DSP / PROCESS"
          value={formatObserved(snapshot.process.cpuCoresUsed, (value) => `${value.toFixed(2)} 核`)}
          detail={`PID ${formatObserved(snapshot.runtime.processId, String)} · 工作集 ${formatObserved(snapshot.process.workingSetBytes, formatBytes)}`} />
        <ObservabilityMetricCard icon={Gauge} eyebrow="DSP / THREADS"
          value={formatObserved(snapshot.process.threadCount, (value) => value.toLocaleString('zh-CN'))}
          detail={`私有内存 ${formatObserved(snapshot.process.privateBytes, formatBytes)} · CPU% ${formatObserved(snapshot.process.cpuPercent, (value) => `${value.toFixed(1)}%`)}`} />
        <ObservabilityMetricCard icon={PlugZap} eyebrow="NETWORK / GAME PORT"
          value={formatObserved(snapshot.runtime.gamePort.port, (value) => `:${value}`)}
          detail={formatObserved(snapshot.runtime.gamePort.listening, (value) => value ? '已确认监听' : '未检测到监听')}
          tone={snapshot.runtime.gamePort.listening.status === 'available'
            ? snapshot.runtime.gamePort.listening.value ? 'good' : 'critical'
            : 'unknown'} />
        <ObservabilityMetricCard icon={Gauge} eyebrow="SIMULATION / ACTUAL"
          value={`UPS ${snapshot.simulation.ups.status === 'available' ? compactNumber(snapshot.simulation.ups.value) : '暂无有效采样'} · TPS ${snapshot.simulation.tps.status === 'available' ? compactNumber(snapshot.simulation.tps.value) : '暂无有效采样'}`}
          detail={`配置目标 ${formatObserved(snapshot.simulation.targetUps, (value) => `${compactNumber(value)} UPS`)} · ${snapshot.simulation.ups.status === 'unavailable' || snapshot.simulation.tps.status === 'unavailable' ? '游戏暂停或尚未形成有效采样时不显示实测值' : '目标值不作为实测值'}`} />
      </div>

      <div className="observability-grid">
        <section className="observability-module core-module">
          <header><div><Cpu size={16} /><span><strong>按核 CPU 阵列</strong><small>只显示采集器提供的独立逻辑核样本</small></span></div><b>{snapshot.host.cpu.perCorePercent.status === 'available' ? `${snapshot.host.cpu.perCorePercent.value.length} 核` : 'UNAVAILABLE'}</b></header>
          {snapshot.host.cpu.perCorePercent.status === 'available'
            ? <div className="core-array">{snapshot.host.cpu.perCorePercent.value.slice(0, 64).map((core) => <div key={core.index} title={`CPU ${core.index}: ${core.percent.toFixed(1)}%`}><span>#{String(core.index).padStart(2, '0')}</span><i><em style={{ height: `${clampPercent(core.percent)}%` }} /></i><b>{core.percent.toFixed(0)}%</b></div>)}</div>
            : <UnavailableTelemetry icon={Cpu} title="按核数据不可用" reason={snapshot.host.cpu.perCorePercent.reason}
                detail="当前 ServerStatus 采集器只提供主机总 CPU；系统不会把总占用平均分配到各核心。" />}
          {snapshot.host.cpu.perCorePercent.status === 'available' && snapshot.host.cpu.perCorePercent.value.length > 64 && <p className="observability-truncation">仅渲染前 64 个逻辑核；完整样本仍保留在 API 快照中。</p>}
        </section>

        <section className="observability-module history-module">
          <header><div><History size={16} /><span><strong>短时资源轨迹</strong><small>最多 {observabilityHistoryPoints} 个降采样区间</small></span></div><b>{history ? `${history.retainedSamples} / +${history.droppedSamples} EVICTED` : 'NO HISTORY'}</b></header>
          <HistoryMetricStrip label="主机 CPU" unit="%" points={history?.points ?? []} select={(point) => point.metrics.hostCpuPercent} />
          <HistoryMetricStrip label="内存占用" unit="%" points={history?.points ?? []} select={(point) => point.metrics.memoryUsedPercent} />
          <HistoryMetricStrip label="DSP 核等值" unit=" cores" points={history?.points ?? []} select={(point) => point.metrics.processCpuCoresUsed} scale={(value) => {
            const logical = snapshot.host.cpu.logicalProcessorCount
            return logical.status === 'available' ? (value / logical.value) * 100 : undefined
          }} />
        </section>

        <section className="observability-module health-module">
          <header><div><ShieldCheck size={16} /><span><strong>健康与瓶颈提示</strong><small>由有限阈值和状态矛盾生成，不推断缺失数据</small></span></div><b className={`health-${health}`}>{observabilityHealthLabels[health]}</b></header>
          <div className="observability-hints">{snapshot.health.hints.length > 0
            ? snapshot.health.hints.map((hint) => <div className={hint.severity} key={hint.code}>{hint.severity === 'critical' ? <CircleX size={16} /> : hint.severity === 'warning' ? <TriangleAlert size={16} /> : <CircleMinus size={16} />}<span><strong>{observabilityHintLabels[hint.code]}</strong><small>{hint.relatedMetrics.length ? hint.relatedMetrics.join(' · ') : '运行状态证据'}</small></span></div>)
            : <div className="healthy"><Check size={16} /><span><strong>当前样本未发现阈值或状态矛盾</strong><small>健康只覆盖已上报的观测项。</small></span></div>}</div>
        </section>
      </div>
    </>}
  </div>
}

function ObservabilityMetricCard({ icon: Icon, eyebrow, value, detail, progress, tone = 'unknown' }: {
  icon: ComponentType<{ size?: number }>
  eyebrow: string
  value: string
  detail: string
  progress?: number
  tone?: 'good' | 'warning' | 'critical' | 'unknown'
}) {
  return <article className={`observability-metric tone-${tone}`}><header><Icon size={15} /><span>{eyebrow}</span><i /></header><strong>{value}</strong><p>{detail}</p>{progress !== undefined && <div className="metric-rail"><i style={{ width: `${clampPercent(progress)}%` }} /></div>}</article>
}

function UnavailableTelemetry({ icon: Icon, title, detail, reason }: {
  icon: ComponentType<{ size?: number }>
  title: string
  detail: string
  reason: 'not-provided' | 'source-reported-unavailable' | 'dependency-unavailable' | 'process-not-running'
}) {
  return <div className="observability-unavailable"><Icon size={24} /><span><strong>{title}</strong><small>{detail}</small></span><code>{unavailableReasonLabel(reason)}</code></div>
}

function HistoryMetricStrip({ label, unit, points, select, scale = (value) => value }: {
  label: string
  unit: string
  points: ObservabilityDownsamplePoint[]
  select: (point: ObservabilityDownsamplePoint) => NumericMetricAggregate
  scale?: (value: number) => number | undefined
}) {
  const latest = points.length > 0 ? select(points[points.length - 1]!) : null
  return <div className="history-strip"><div><span>{label}</span><strong>{latest?.status === 'available' ? `${compactNumber(latest.last)}${unit}` : '不可用'}</strong></div><div className="history-bars" aria-label={`${label}短时历史`}>{points.length === 0 && <span className="history-empty">等待样本</span>}{points.map((point, index) => {
    const metric = select(point)
    const scaledAverage = metric.status === 'available' ? scale(metric.average) : undefined
    const title = metric.status === 'available'
      ? `${point.from} – ${point.to}: avg ${compactNumber(metric.average)}${unit}, min ${compactNumber(metric.minimum)}, max ${compactNumber(metric.maximum)}`
      : `${point.from} – ${point.to}: unavailable`
    return <i className={scaledAverage === undefined ? 'unavailable' : 'available'} key={`${point.from}-${index}`} title={title}>{scaledAverage !== undefined && <em style={{ height: `${clampPercent(scaledAverage)}%` }} />}</i>
  })}</div></div>
}

function formatObserved<T>(metric: ObservabilityMetric<T>, formatter: (value: T) => string): string {
  return metric.status === 'available' ? formatter(metric.value) : unavailableReasonLabel(metric.reason)
}

function availableValue(metric: ObservabilityMetric<number>): number | undefined {
  return metric.status === 'available' ? metric.value : undefined
}

function unavailableReasonLabel(reason: 'not-provided' | 'source-reported-unavailable' | 'dependency-unavailable' | 'process-not-running'): string {
  return ({
    'not-provided': '未上报',
    'source-reported-unavailable': '采集不可用',
    'dependency-unavailable': '依赖数据缺失',
    'process-not-running': '进程未运行'
  })[reason]
}

function compactNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

const lifecycleActions: Array<{
  action: LifecycleAction
  label: string
  description: string
  icon: ComponentType<{ size?: number }>
}> = [
  { action: 'start', label: '启动预检', description: '会话、Steam、生命周期代理与端口复核', icon: Play },
  { action: 'save', label: '保存预检', description: '存档配对、备份与保存回执', icon: Save },
  { action: 'graceful-stop', label: '停服预检', description: '进程身份、会话任务与停服回执', icon: Square },
  { action: 'restart', label: '重启预检', description: '停服链、开服任务与回滚点', icon: RotateCw }
]

const lifecycleCheckLabels: Record<LifecycleCheckId, string> = {
  'project-root': '共享项目目录',
  'managed-executable': '固定游戏可执行文件',
  'managed-process': 'DSP 受管进程',
  'pid-file': 'PID 身份绑定',
  'game-port': '游戏端口所有权',
  'save-pair': '存档配对单元',
  'backup-pair': '成对备份与清单',
  'server-task': '开服计划任务',
  'server-task-principal': '开服任务运行身份',
  'server-task-action': '开服脚本白名单',
  'stop-task': '优雅停服任务',
  'stop-task-principal': '会话与运行身份',
  'stop-task-action': '停服脚本白名单',
  'stop-task-result': '上次停服任务结果',
  'task-history': '计划任务事件历史',
  'receipt-channel': '持久生命周期回执',
  'save-trigger': '独立保存确认',
  'interactive-session': '受管交互会话',
  'steam-session': 'Steam 登录会话',
  'lifecycle-broker': 'SYSTEM 生命周期代理',
  'execution-lock': '执行总锁'
}

const lifecycleStatusLabels: Record<LifecycleCheckStatus, string> = {
  pass: '通过', warning: '需关注', block: '阻断', 'not-applicable': '不适用'
}

function GameLifecyclePanel({ status, onRefresh, provider, initialAction, canOperate }: {
  status: ServerStatus; onRefresh: () => void; provider: 'demo' | 'windows'
  initialAction: LifecycleAction | null; canOperate: boolean
}) {
  const [action, setAction] = useState<LifecycleAction>(initialAction ?? (status.state === 'stopped' ? 'start' : 'graceful-stop'))
  const [preview, setPreview] = useState<LifecyclePreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [execution, setExecution] = useState<LifecycleExecutionResult | null>(null)
  const [executionBusy, setExecutionBusy] = useState(false)
  const [executionError, setExecutionError] = useState('')
  const [pendingIdempotencyKey, setPendingIdempotencyKey] = useState<string | null>(null)
  const pollGeneration = useRef(0)
  const selected = lifecycleActions.find((item) => item.action === action)!

  useEffect(() => () => { pollGeneration.current += 1 }, [])
  useEffect(() => {
    if (initialAction) selectAction(initialAction)
  }, [initialAction])

  async function runPreview() {
    if (!canOperate) return
    setBusy(true); setError(''); setConfirmOpen(false); setExecutionError('')
    try {
      const result = await api.previewLifecycle(action)
      setPreview(result.data.preview)
    } catch (reason) {
      setPreview(null)
      setError(reason instanceof ApiError ? reason.message : '生命周期预检失败')
    } finally { setBusy(false) }
  }

  function selectAction(nextAction: LifecycleAction) {
    pollGeneration.current += 1
    setAction(nextAction)
    setPreview(null)
    setExecution(null)
    setError('')
    setExecutionError('')
    setConfirmOpen(false)
    setPendingIdempotencyKey(null)
  }

  async function executeTransaction() {
    if (!canOperate || !preview?.allowed || !preview.executionEnabled || executionBusy) return
    const generation = pollGeneration.current + 1
    pollGeneration.current = generation
    const idempotencyKey = pendingIdempotencyKey ?? `${action}:ui:${createUiRequestId()}`
    setPendingIdempotencyKey(idempotencyKey)
    setConfirmOpen(false)
    setExecutionBusy(true)
    setExecutionError('')
    try {
      let result = (await api.executeLifecycle(action, idempotencyKey)).data
      if (pollGeneration.current !== generation) return
      setExecution(result)
      for (let attempt = 0; attempt < 800 && ['queued', 'running'].includes(result.job.state); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 750))
        if (pollGeneration.current !== generation) return
        result = (await api.lifecycle(result.job.id)).data
        setExecution(result)
      }
      if (['queued', 'running'].includes(result.job.state)) throw new Error('生命周期事务轮询超时，请在任务与审计中继续检查')
      setPendingIdempotencyKey(null)
      onRefresh()
    } catch (reason) {
      if (pollGeneration.current === generation) {
        setExecutionError(reason instanceof ApiError ? reason.message : reason instanceof Error ? reason.message : '生命周期事务失败')
      }
    } finally {
      if (pollGeneration.current === generation) setExecutionBusy(false)
    }
  }

  return <div className="lifecycle-workspace">
    <div className="lifecycle-instance-strip">
      <div><span>受管实例</span><strong>{status.serverName}</strong></div>
      <div><span>运行状态</span><strong className={status.state === 'running' ? 'green' : 'amber'}>{stateLabel(status.state)}</strong></div>
      <div><span>运行时间</span><strong>{formatUptime(status.runtime.uptimeSeconds)}</strong></div>
      <div><span>目标 UPS</span><strong>{status.runtime.targetUps ?? '—'}</strong></div>
      <div><span>玩家会话</span><strong>{status.runtime.onlinePlayers ?? '—'} / {status.runtime.maxPlayers ?? '—'}</strong></div>
    </div>

    <section className="lifecycle-preflight" aria-labelledby="lifecycle-preflight-title">
      <header>
        <div><span className="preflight-mark"><ScanSearch size={19} /></span><div><h3 id="lifecycle-preflight-title">生命周期安全预检</h3><p>仅采集证据，不修改进程、任务、存档或配置</p></div></div>
        <span className="dry-run-badge"><LockKeyhole size={12} />DRY RUN</span>
      </header>

      {provider === 'demo' && <div className="lifecycle-demo-disabled"><LockKeyhole size={16} /><div><strong>演示环境：执行已禁用</strong><span>可以查看预检界面，但不会排队、启动、停止、保存或重启任何服务器。</span></div></div>}
      {!canOperate && <div className="lifecycle-demo-disabled"><LockKeyhole size={16} /><div><strong>当前角色：只读</strong><span>Viewer 可以查看运行状态，但生命周期预演与执行必须由 Operator 或 Administrator 发起。</span></div></div>}

      <div className="lifecycle-action-grid">
        {lifecycleActions.map((item) => {
          const Icon = item.icon
          return <button key={item.action} className={item.action === action ? 'selected' : ''}
            aria-pressed={item.action === action} onClick={() => selectAction(item.action)}>
            <Icon size={18} /><span><strong>{item.label}</strong><small>{item.description}</small></span>
          </button>
        })}
      </div>

      <div className="preflight-command-row">
        <div><span>当前路径</span><strong>{selected.label} / 只读证据链</strong></div>
        <button className="preflight-run" disabled={busy || !canOperate} onClick={runPreview}>
          {busy ? <RefreshCw className="spin" size={16} /> : <ScanSearch size={16} />}{busy ? '正在采集…' : '运行只读预检'}
        </button>
      </div>

      {error && <div className="preflight-error" role="alert"><CircleX size={16} />{error}</div>}
      {!preview && !error && <div className="preflight-empty">
        <LockKeyhole size={25} /><div><strong>执行能力保持锁定</strong><p>选择路径并运行预检，系统会生成持久审计任务和固定阻断码。</p></div>
      </div>}
      {preview && <LifecyclePreviewResult preview={preview} onExecute={() => setConfirmOpen(true)} executionBusy={executionBusy} />}
      {confirmOpen && <div className="lifecycle-confirm" role="alertdialog" aria-labelledby="lifecycle-confirm-title">
        <TriangleAlert size={22} />
        <div><strong id="lifecycle-confirm-title">确认执行“{selected.label.replace('预检', '')}”事务</strong><p>{action === 'start'
          ? '系统只会调用固定白名单开服任务，并复核受管进程与游戏端口；不会修改安装或存档，启动后验证失败会要求人工对账。'
          : '系统将先创建配对存档保护点，再按已验证顺序执行；浏览器关闭不会取消已排队事务。'}</p></div>
        <div className="lifecycle-confirm-actions"><button onClick={() => setConfirmOpen(false)}>取消</button><button className="confirm-execute" disabled={!canOperate} onClick={executeTransaction}>确认执行</button></div>
      </div>}
      {executionError && <div className="preflight-error" role="alert"><CircleX size={16} />{executionError}</div>}
      {execution && <LifecycleExecutionPanel result={execution} busy={executionBusy} />}
    </section>
  </div>
}

function LifecyclePreviewResult({ preview, onExecute, executionBusy }: {
  preview: LifecyclePreview
  onExecute: () => void
  executionBusy: boolean
}) {
  const activeChecks = preview.checks.filter((check) => check.status !== 'not-applicable')
  const executable = preview.allowed && preview.executionEnabled
  return <div className="preflight-result" aria-live="polite">
    <div className="preflight-result-summary">
      <div className={`gate-state ${executable ? 'ready' : 'locked'}`}>{executable ? <Check size={21} /> : <LockKeyhole size={21} />}<div><span>执行门禁</span><strong>{executable ? '证据就绪 · 可确认执行' : `保持锁定 · ${preview.blockers.length} 项阻断`}</strong></div></div>
      <div className={`rollback-state ${preview.rollback.ready ? 'ready' : 'blocked'}`}><Undo2 size={19} /><div><span>回滚基线</span><strong>{preview.rollback.ready ? '已就绪' : '尚未就绪'}</strong></div></div>
      <div className="audit-state"><ShieldCheck size={19} /><div><span>审计记录</span><strong>已持久化</strong></div></div>
    </div>
    <div className="preflight-check-grid">
      {activeChecks.map((check) => <div key={check.id} className={`preflight-check ${check.status}`}>
        <LifecycleCheckIcon status={check.status} />
        <span><strong>{lifecycleCheckLabels[check.id]}</strong><small>{lifecycleStatusLabels[check.status]}</small></span>
      </div>)}
    </div>
    <div className="preflight-footer"><p className="preflight-footnote">{executable ? <ShieldCheck size={13} /> : <LockKeyhole size={13} />}{executable ? '证据快照已通过；执行仍需二次确认并会生成独立事务回执。' : '本结果只是证据快照；所有阻断解除前不会调用主机变更方法。'}</p>
      {executable && <button className="preflight-execute" onClick={onExecute} disabled={executionBusy}><Play size={15} />{executionBusy ? '事务执行中…' : '进入执行确认'}</button>}
    </div>
  </div>
}

const lifecyclePhaseLabels: Record<LifecycleExecutionPhase, string> = {
  lock: '全局事务锁',
  preflight: '执行前证据复核',
  'protection-point': '配对存档保护点',
  save: '游戏内保存',
  stop: '优雅停服请求',
  'verify-stopped': '停止状态确认',
  start: '启动任务请求',
  'verify-running': '运行健康确认',
  'rollback-start': '回滚启动',
  reconciliation: '中断对账'
}

function LifecycleExecutionPanel({ result, busy }: { result: LifecycleExecutionResult; busy: boolean }) {
  const terminal = result.job.state === 'succeeded' || result.job.state === 'failed'
  return <section className={`lifecycle-execution ${result.job.state}`} aria-live="polite">
    <header><div>{busy && !terminal ? <RefreshCw className="spin" size={17} /> : result.job.state === 'succeeded' ? <Check size={17} /> : <TriangleAlert size={17} />}<span><strong>生命周期事务</strong><small>请求 {result.run.requestId.slice(0, 8)} · {result.reused ? '复用既有结果' : '新事务'}</small></span></div><b>{result.job.state === 'queued' ? '排队中' : result.job.state === 'running' ? '执行中' : result.job.state === 'succeeded' ? '已完成' : '失败'}</b></header>
    <ol>{result.receipts.map((receipt) => <li key={receipt.id} className={receipt.state}>
      <span className="phase-index">{String(receipt.sequence).padStart(2, '0')}</span>
      <div><strong>{lifecyclePhaseLabels[receipt.phase]}</strong><small>{receipt.summary}</small></div>
      <em>{receipt.state === 'running' ? '运行中' : receipt.state === 'succeeded' ? '完成' : receipt.errorCode ?? '失败'}</em>
    </li>)}</ol>
    {result.receipts.length === 0 && <div className="lifecycle-queued"><span className="spinner" />事务已持久化，等待执行器领取…</div>}
    {result.run.recoveryRequired && <div className="lifecycle-recovery"><TriangleAlert size={16} />当前状态需要人工核验；系统不会自动重放不确定阶段。</div>}
  </section>
}

function LifecycleCheckIcon({ status }: { status: LifecycleCheckStatus }) {
  if (status === 'pass') return <Check size={16} />
  if (status === 'warning') return <TriangleAlert size={16} />
  if (status === 'block') return <CircleX size={16} />
  return <CircleMinus size={16} />
}

type DataRow = [label: string, value: string, tone?: 'good' | 'warn' | 'muted']

function DataRows({ rows }: { rows: DataRow[] }) {
  return <div className="data-rows">{rows.map(([label, value, tone = 'good']) => <div key={label}><span>{label}</span><strong>{value}</strong><Check className={tone} size={16} /></div>)}</div>
}

function healthLabel(health: SavePairCatalogItem['health'] | BackupCatalogItem['health']): string {
  return ({ healthy: '健康', incomplete: '不完整', corrupt: '校验失败' })[health]
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
}

function configFileLabel(file: GameConfigFileId): string {
  return ({ nebula: 'Nebula 服务端', galaxy: '星系与黑雾', bepinex: 'BepInEx 运行时', bridge: 'Dyson Control 游戏桥' })[file]
}

function displayConfigValue(value: boolean | number | { configured: boolean }): string {
  if (typeof value === 'boolean') return value ? '启用' : '关闭'
  if (typeof value === 'number') return String(value)
  return value.configured ? '已设置（隐藏）' : '未设置'
}

function compatibilityLabel(status: ServerStatus): string {
  if (status.versions.gameLoaded && status.versions.warnings.length > 0) return '游戏已加载 · 有版本警告'
  if (status.versions.compatible) return '运行兼容性已验证'
  if (status.versions.gameLoaded === false) return '游戏尚未完成加载'
  return '兼容性待检查'
}

function taskStateLabel(state: ServerStatus['automation']['serverTask']['state']): string {
  if (state === null) return '未发现'
  return ({ running: '运行中', ready: '就绪', disabled: '已禁用', queued: '已排队', unknown: '未知' })[state]
}

function storageStateLabel(status: ServerStatus): string {
  if (!status.automation.projectRootAvailable) return '项目根目录不可用'
  if (status.automation.globalMappingAvailable === true) return '全局 SMB 映射正常'
  if (status.automation.globalMappingAvailable === false) return '全局 SMB 映射异常'
  return '项目根目录可用'
}

function gamePortDetail(status: ServerStatus): string {
  const gamePort = status.connections.find((item) => item.id === 'game-port')
  if (!gamePort || gamePort.status === 'unknown') return '尚未采集'
  return gamePort.status === 'healthy' ? '本机 TCP 监听正常' : '未检测到本机 TCP 监听'
}

function stateLabel(state: ServerStatus['state']): string {
  return ({ running: '运行中', stopped: '已停止', starting: '启动中', stopping: '停止中', unknown: '未知' })[state]
}

function OrbitMark() {
  return <svg className="orbit-mark" viewBox="0 0 42 42" aria-hidden="true">
    <path d="M21 2.8 36.8 12v18L21 39.2 5.2 30V12Z" opacity=".56" />
    <circle className="orbit-core" cx="21" cy="21" r="5.2" />
    <ellipse cx="21" cy="21" rx="17.5" ry="7.4" transform="rotate(-25 21 21)" />
    <ellipse cx="21" cy="21" rx="17.5" ry="7.4" transform="rotate(60 21 21)" />
    <path d="M6.5 32.7c8.8-2 18.7-8.8 28-22" />
    <circle className="orbit-node" cx="35.2" cy="10.4" r="1.4" />
    <circle className="orbit-node" cx="7.5" cy="31.9" r="1" />
  </svg>
}

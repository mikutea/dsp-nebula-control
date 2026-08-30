import { FormEvent, useCallback, useEffect, useMemo, useState, type ComponentType } from 'react'
import {
  Activity, Archive, Boxes, Check, ChevronDown, CircleUserRound, ClipboardList,
  CloudDownload, Code2, Copy, Cpu, Database, Download, FileCog, FolderArchive,
  Gamepad2, Gauge, HardDrive, History, Home, Menu, MemoryStick, PackageCheck, Play,
  PlugZap, RefreshCw, RotateCw, Save, Send, Server, Settings2, ShieldCheck,
  Square, TerminalSquare, Users, Wrench
} from 'lucide-react'
import { api, ApiError } from './api'
import { formatDuration, formatUptime, relativeTime } from './format'
import type { JobRecord, NavKey, ServerStatus } from './model'

interface Session { name: string }

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
    { key: 'tasks', label: '任务与审计', icon: ClipboardList }
  ] }
]

export function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    api.session().then((result) => setSession(result.user)).catch(() => undefined).finally(() => setChecking(false))
  }, [])

  if (checking) return <div className="boot-screen"><span className="spinner" />正在建立安全会话…</div>
  if (!session) return <LoginScreen onLogin={setSession} />
  return <ControlShell user={session} onLogout={() => setSession(null)} />
}

function LoginScreen({ onLogin }: { onLogin: (user: Session) => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try { onLogin((await api.login(password)).user) }
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
          <label htmlFor="password">管理员密码</label>
          <input id="password" autoFocus autoComplete="current-password" type="password" value={password}
            onChange={(event) => setPassword(event.target.value)} placeholder="输入独立的面板密码" />
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary wide" disabled={busy || !password}>{busy ? '验证中…' : '登录'}</button>
        </form>
        <p className="login-footnote">面板密码与 Nebula 游戏密码相互独立。</p>
      </section>
    </main>
  )
}

function ControlShell({ user, onLogout }: { user: Session; onLogout: () => void }) {
  const [active, setActive] = useState<NavKey>('overview')
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [provider, setProvider] = useState<'demo' | 'windows'>('demo')
  const [jobs, setJobs] = useState<JobRecord[]>([])
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    const [statusResult, jobsResult] = await Promise.all([api.status(), api.jobs()])
    setStatus(statusResult.data); setProvider(statusResult.meta.provider); setJobs(jobsResult.data)
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
  }

  return (
    <div className="control-app">
      <TopBar provider={provider} user={user.name} onLogout={logout}
        mobileNavOpen={mobileNavOpen} onToggleMobileNav={() => setMobileNavOpen((open) => !open)} />
      <Sidebar active={active} onSelect={selectPage} mobileOpen={mobileNavOpen} />
      {mobileNavOpen && <button className="mobile-nav-backdrop" aria-label="关闭导航" onClick={() => setMobileNavOpen(false)} />}
      <main className="workspace">
        {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError('')}>关闭</button></div>}
        {!status ? <div className="loading-state"><span className="spinner" />正在读取服务器状态…</div> :
          active === 'overview'
            ? <Overview status={status} jobs={jobs} refreshing={refreshing} onRefresh={refresh} provider={provider} />
            : <FeatureWorkspace active={active} status={status} jobs={jobs} onRefresh={refresh} provider={provider} />}
      </main>
    </div>
  )
}

function TopBar({ provider, user, onLogout, mobileNavOpen, onToggleMobileNav }: {
  provider: 'demo' | 'windows'; user: string; onLogout: () => void; mobileNavOpen: boolean; onToggleMobileNav: () => void
}) {
  return (
    <header className="topbar">
      <button className="mobile-nav-button" aria-label={mobileNavOpen ? '关闭导航' : '打开导航'}
        aria-expanded={mobileNavOpen} onClick={onToggleMobileNav}><Menu size={21} /></button>
      <div className="brand"><OrbitMark /><div><strong>Dyson Server Console</strong><span>自托管 DSP 多人服务器控制台</span></div></div>
      <div className="context-item"><span>实例名称</span><strong>DSP 主服务器 <i className="online-dot" /></strong></div>
      <div className="context-item"><span>环境</span><strong>{provider === 'demo' ? '演示环境' : '生产环境'} <ChevronDown size={14} /></strong></div>
      <div className="context-item address"><span>连接地址</span><strong>{provider === 'demo' ? 'dsp.example.com:8469' : '由部署配置提供'} <Copy size={14} /></strong></div>
      <button className="user-menu" onClick={onLogout} title="退出登录"><CircleUserRound size={20} />{user}<ChevronDown size={14} /></button>
    </header>
  )
}

function Sidebar({ active, onSelect, mobileOpen }: { active: NavKey; onSelect: (key: NavKey) => void; mobileOpen: boolean }) {
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
        <dl><div><dt>实例 ID</dt><dd>dsp-demo-01</dd></div><div><dt>运行方式</dt><dd>Windows Agent</dd></div><div><dt>控制面版本</dt><dd>0.1.0</dd></div></dl>
        <span>独立控制平面 · 安全模式</span>
      </div>
    </aside>
  )
}

function Overview({ status, jobs, refreshing, onRefresh, provider }: {
  status: ServerStatus; jobs: JobRecord[]; refreshing: boolean; onRefresh: () => void; provider: 'demo' | 'windows'
}) {
  return (
    <div className="overview page-enter">
      <div className="page-heading">
        <div><h1>服务器总览</h1><p>{provider === 'demo' ? '演示数据 · 不会操作真实服务器' : `最后采集 ${relativeTime(status.collectedAt)}`}</p></div>
        <div className="heading-actions">
          <button className="success-action" disabled={status.state !== 'stopped'} title="服务器运行中"><Play size={18} />启动</button>
          <button className="danger-action" disabled={!status.capabilities.gracefulStop} title="等待优雅停服适配器验证"><Square size={16} />停止</button>
          <button className="primary-action" disabled={!status.capabilities.restart} title="等待重启回滚流程验证"><RotateCw size={18} />重启</button>
          <button className="more-action" onClick={onRefresh} disabled={refreshing}><RefreshCw className={refreshing ? 'spin' : ''} size={17} />刷新</button>
        </div>
      </div>
      <StatusStrip status={status} />
      <div className="metrics-grid">
        <Metric title="CPU" value={status.runtime.processCoresUsed === null ? '—' : `${status.runtime.processCoresUsed.toFixed(1)} 核`} sub="进程平均占用" color="cyan" points="2,40 14,33 27,36 39,25 52,31 65,24 78,28 91,20 104,26 118,18" />
        <Metric title="内存" value={status.runtime.privateMemoryGiB === null ? '—' : `${status.runtime.privateMemoryGiB} GB`} sub="DSP 私有内存" color="cyan" points="2,38 14,37 27,36 39,36 52,35 65,35 78,34 91,34 104,33 118,33" />
        <Metric title="UPS" value={status.runtime.targetUps?.toString() ?? '—'} sub="目标模拟速率" color="green" points="2,26 14,21 27,30 39,17 52,25 65,18 78,23 91,16 104,24 118,20" />
        <Metric title="线程" value={status.runtime.threadCount?.toString() ?? '—'} sub="DSP 活跃线程" color="amber" points="2,34 14,28 27,32 39,22 52,30 65,25 78,31 91,23 104,29 118,26" />
        <Metric title="进程" value={status.runtime.processId ? `PID ${status.runtime.processId}` : '未运行'} sub={status.state === 'running' ? `${status.runtime.priority ?? '默认'} 优先级` : '等待启动'} color="blue" points="2,38 14,32 27,34 39,27 52,30 65,23 78,27 91,20 104,25 118,19" />
      </div>
      <div className="operations-row">
        <ConsolePanel demo={provider === 'demo'} />
        <DeploymentPanel status={status} onRefresh={onRefresh} />
      </div>
      <div className="bottom-row">
        <TaskTable jobs={jobs} />
        <SavePanel status={status} />
      </div>
    </div>
  )
}

function StatusStrip({ status }: { status: ServerStatus }) {
  const items = [
    { label: '运行状态', value: stateLabel(status.state), sub: status.runtime.processId ? `PID: ${status.runtime.processId}` : '无活动进程', icon: Activity, tone: status.state === 'running' ? 'good' : 'muted' },
    { label: '游戏版本', value: status.versions.dsp ?? '待采集', sub: 'DSP Stable', icon: PackageCheck },
    { label: 'Nebula 版本', value: status.versions.nebula ?? '待采集', sub: compatibilityLabel(status), icon: PlugZap, tone: status.versions.warnings.length ? 'warn' : undefined },
    { label: '在线玩家', value: `${status.runtime.onlinePlayers ?? '—'} / ${status.runtime.maxPlayers ?? '—'}`, sub: '连接槽位', icon: Users },
    { label: '运行时间', value: status.state === 'running' ? formatUptime(status.runtime.uptimeSeconds) : '—', sub: `采集于 ${new Date(status.collectedAt).toLocaleTimeString('zh-CN')}`, icon: History },
    { label: '游戏链路', value: status.connections.find((item) => item.id === 'game-port')?.status === 'healthy' ? '可达' : '待检查', sub: status.connections.find((item) => item.id === 'game-port')?.detail ?? '—', icon: PlugZap, tone: status.connections.find((item) => item.id === 'game-port')?.status === 'healthy' ? 'good' : 'warn' },
    { label: '存储状态', value: status.save.consistent ? '正常' : '不完整', sub: status.save.name ?? '未发现存档', icon: HardDrive, tone: status.save.consistent ? 'good' : 'warn' }
  ]
  return <section className="status-strip">{items.map(({ label, value, sub, icon: Icon, tone }) =>
    <div className="status-item" key={label}><Icon size={19} /><span>{label}<strong className={tone}>{value}</strong><small>{sub}</small></span></div>)}</section>
}

function Metric({ title, value, sub, color, points }: { title: string; value: string; sub: string; color: string; points: string }) {
  return <section className="metric"><div className="metric-head"><strong>{title}</strong><span>{value}</span></div>
    <svg viewBox="0 0 120 48" preserveAspectRatio="none" aria-hidden="true"><polyline className={color} points={points} /></svg><small>{sub}</small></section>
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

function ConsolePanel({ demo }: { demo: boolean }) {
  return <section className="panel console-panel"><header><h2>实时服务器控制台</h2><div className="console-tools"><select aria-label="日志级别"><option>全部级别</option></select><input aria-label="搜索日志" placeholder="搜索日志内容…" /><label><input type="checkbox" defaultChecked />自动滚动</label><button>清屏</button></div></header>
    <div className="console-body" aria-label={demo ? '演示控制台日志' : '控制台接入状态'}>{demo
      ? demoLogs.map(([time, level, source, message], index) => <div key={index}><time>{time}</time> <b className={level.toLowerCase()}>[{level}]</b> <em>[{source}]</em> {message}</div>)
      : <div><b className="warn">[SAFE]</b> <em>[Console]</em> 结构化日志与脱敏规则验证完成前，不读取或展示生产原始日志。</div>}</div>
    <div className="command-bar"><Code2 size={17} /><input disabled placeholder="命令入口将在权限与审计模块完成后启用" /><button disabled><Send size={16} />发送</button></div>
  </section>
}

function DeploymentPanel({ status, onRefresh }: { status: ServerStatus; onRefresh: () => void }) {
  return <section className="panel deployment-panel"><header><h2>部署与版本</h2></header>
    <div className="version-list">
      {[['游戏版本', status.versions.dsp], ['BepInEx', status.versions.bepInEx], ['Nebula', status.versions.nebula], ['运行兼容状态', compatibilityLabel(status)]].map(([label, value]) =>
        <div key={label}><span>{label}</span><strong>{value ?? '待采集'}</strong><Check size={15} /></div>)}
    </div>
    <div className="update-box"><div><strong>可用更新</strong><span>尚未执行在线检查</span></div><button onClick={onRefresh}><RefreshCw size={16} />刷新清单</button><p>更新只会进入预览；依赖、哈希、存档备份和回滚验证完成前无法激活。</p></div>
    <a className="panel-link">查看更新日志</a><a className="panel-link">版本锁定设置</a>
  </section>
}

function TaskTable({ jobs }: { jobs: JobRecord[] }) {
  return <section className="panel tasks-panel"><header><h2>任务与活动（最近 24 小时）</h2></header>
    <div className="table-wrap"><table><thead><tr><th>时间</th><th>任务</th><th>状态</th><th>耗时</th><th>触发者</th></tr></thead>
      <tbody>{jobs.length ? jobs.slice(0, 6).map((job) => <tr key={job.id}><td>{new Date(job.createdAt).toLocaleTimeString('zh-CN')}</td><td>{job.summary}</td><td><span className={`job-state ${job.state}`}>{job.state === 'succeeded' ? '成功' : job.state === 'failed' ? '失败' : job.state === 'running' ? '运行中' : '排队中'}</span></td><td>{formatDuration(job.durationMs)}</td><td>{job.actor}</td></tr>) : <tr><td colSpan={5} className="empty-cell">点击右上角刷新后，任务会在这里留下审计记录。</td></tr>}</tbody></table></div>
    <button className="text-link">查看全部任务与审计日志</button>
  </section>
}

function SavePanel({ status }: { status: ServerStatus }) {
  return <section className="panel save-panel"><header><h2>存档与备份状态</h2></header>
    <div className="save-columns"><div><span>当前存档</span><strong>{status.save.name ?? '未发现'}</strong><dl><div><dt>配对状态</dt><dd>{status.save.dsvPresent ? '.dsv' : '缺少 .dsv'} + {status.save.serverPresent ? '.server' : '缺少 .server'}</dd></div><div><dt>最后保存</dt><dd>{relativeTime(status.save.lastSavedAt)} · {status.save.dsvSizeMiB === null ? '大小未知' : `${status.save.dsvSizeMiB} MiB`}</dd></div></dl></div>
      <div><span>完整性</span><strong className={status.save.consistent ? 'green' : 'amber'}>{status.save.consistent ? '已成对验证' : '需要处理'}</strong><dl><div><dt>最近备份</dt><dd>{status.save.backupPairPresent && status.save.backupManifestPresent ? relativeTime(status.save.latestBackupAt) : '尚无完整清单'}</dd></div><div><dt>恢复权限</dt><dd>当前锁定</dd></div></dl></div></div>
    <div className="save-actions"><button><FolderArchive size={17} />管理存档</button><button disabled><Database size={17} />立即备份</button></div>
  </section>
}

function FeatureWorkspace({ active, status, jobs, onRefresh, provider }: { active: Exclude<NavKey, 'overview'>; status: ServerStatus; jobs: JobRecord[]; onRefresh: () => void; provider: 'demo' | 'windows' }) {
  const definition = featureDefinitions[active]
  const Icon = definition.icon
  return <div className="feature-page page-enter">
    <div className="feature-heading"><div><span className="feature-icon"><Icon size={24} /></span><div><h1>{definition.title}</h1><p>{definition.description}</p></div></div><button className="more-action" onClick={onRefresh}><RefreshCw size={16} />刷新状态</button></div>
    <div className="feature-layout"><section className="panel feature-primary"><header><h2>{definition.primaryTitle}</h2><span className="phase-label">{definition.phase}</span></header>{featureBody(active, status, jobs, provider)}</section>
      <aside className="panel feature-scope"><header><h2>管理范围</h2></header><ul>{definition.scope.map((item) => <li key={item}><Check size={15} />{item}</li>)}</ul><div className="safety-note"><ShieldCheck size={19} /><div><strong>安全门禁</strong><p>{definition.safety}</p></div></div></aside></div>
  </div>
}

const featureDefinitions: Record<Exclude<NavKey, 'overview'>, { title: string; description: string; primaryTitle: string; phase: string; icon: ComponentType<{ size?: number }>; scope: string[]; safety: string }> = {
  game: { title: '游戏管理', description: '统一管理 DSP 进程、Nebula 会话和安全生命周期。', primaryTitle: '游戏实例', phase: '只读已接入', icon: Gamepad2, scope: ['启动前检查', '保存请求', '优雅停服', '维护模式', '重启与回滚'], safety: '保存与优雅停服适配器完成集成测试前，写操作保持禁用。' },
  console: { title: '实时控制台', description: '查看结构化日志、筛选事件并在审计保护下执行命令。', primaryTitle: '服务器输出', phase: '日志原型', icon: TerminalSquare, scope: ['日志流', '级别筛选', '全文搜索', '命令白名单', '输出下载'], safety: '不提供任意 PowerShell；控制台命令必须经过独立白名单和角色授权。' },
  players: { title: '玩家管理', description: '查看在线玩家、连接质量、身份与管理操作。', primaryTitle: '当前玩家', phase: '接口待接入', icon: Users, scope: ['在线列表', '延迟与连接', '踢出玩家', '封禁与解封', '维护通知'], safety: '玩家身份映射和操作回执可验证前，不开放踢出或封禁。' },
  versions: { title: '版本更新管理', description: '协调 DSP、Nebula、BepInEx 与兼容性门禁。', primaryTitle: '版本矩阵', phase: '清单已接入', icon: CloudDownload, scope: ['在线版本发现', '兼容性矩阵', '更新预览', '暂存安装', '激活与回滚'], safety: 'DSP 更新不会自动激活；Nebula 兼容性和回滚点必须先通过。' },
  mods: { title: '模组更新管理', description: '解析 Thunderstore 依赖并维护服务端与客户端的同一锁。', primaryTitle: '模组锁', phase: '锁文件设计', icon: Boxes, scope: ['依赖解析', '冲突检测', '哈希校验', '版本锁定', '服务端/客户端一致性'], safety: '下载包必须校验来源与 SHA-256；运行中禁止覆盖 BepInEx。' },
  saves: { title: '存档管理', description: '把 .dsv 与 .server 作为不可分割的一致性单元。', primaryTitle: '存档单元', phase: '只读校验', icon: FolderArchive, scope: ['成对发现', '稳定窗口', '哈希清单', '备份保留', '受控恢复'], safety: '恢复前必须停服并再次备份当前存档；任何缺失配对都会阻止恢复。' },
  client: { title: '客户端包', description: '从服务器锁生成可复现的玩家安装资料。', primaryTitle: '客户端交付', phase: '规划阶段', icon: Archive, scope: ['模组清单', '配置差异', 'Profile 导出', '安装说明', '版本校验'], safety: '客户端包不包含游戏文件、Steam 数据、服务器密码或玩家密钥。' },
  server: { title: '服务器管理', description: '查看 Windows 主机、进程、端口、资源与计划任务。', primaryTitle: '主机与进程', phase: '状态已接入', icon: Server, scope: ['CPU 与内存', '进程线程', '端口监听', '计划任务', '磁盘与共享存储'], safety: '不提供通用进程终止或主机重启；危险系统动作需要独立确认和审计。' },
  config: { title: '配置管理', description: '通过 Schema 管理游戏、Nebula、性能和网络配置。', primaryTitle: '配置域', phase: '只读模型', icon: FileCog, scope: ['Nebula 配置', '开服参数', 'UPS 与线程', '网络入口', '机密字段'], safety: '密码只允许写入、不回显；提交前显示差异并生成可回滚快照。' },
  tasks: { title: '任务与审计', description: '追踪每个读取、修改、更新、备份和回滚动作。', primaryTitle: '任务记录', phase: '基础已接入', icon: ClipboardList, scope: ['持久任务', '事件流', '操作人', '失败代码', '审计导出'], safety: '审计信息不记录密码、令牌、完整路径、玩家密钥或存档内容。' }
}

function featureBody(active: Exclude<NavKey, 'overview'>, status: ServerStatus, jobs: JobRecord[], provider: 'demo' | 'windows') {
  if (active === 'console') return <ConsolePanel demo={provider === 'demo'} />
  if (active === 'tasks') return <TaskTable jobs={jobs} />
  if (active === 'players') return <div className="players-empty"><Users size={38} /><strong>{status.runtime.onlinePlayers ?? 0} 名玩家在线</strong><p>玩家身份接口尚未接入；当前不会显示或修改玩家数据。</p></div>
  if (active === 'versions') return <DataRows rows={[["DSP", status.versions.dsp ?? '待采集'], ["Nebula", status.versions.nebula ?? '待采集'], ["BepInEx", status.versions.bepInEx ?? '待采集'], ["游戏加载", status.versions.gameLoaded === true ? '已完成' : status.versions.gameLoaded === false ? '未完成' : '待检查'], ["兼容性", compatibilityLabel(status)]]} />
  if (active === 'mods') return <DataRows rows={[["模组锁状态", status.versions.compatible ? '依赖已锁定' : '待校验'], ["更新策略", '仅预览，不自动激活'], ["下载校验", 'SHA-256 + 清单'], ["客户端一致性", '等待 Profile 导出器']]} />
  if (active === 'saves') return <SavePanel status={status} />
  if (active === 'server') return <DataRows rows={[["进程状态", stateLabel(status.state)], ["进程 ID", status.runtime.processId?.toString() ?? '—'], ["DSP 私有内存", status.runtime.privateMemoryGiB === null ? '—' : `${status.runtime.privateMemoryGiB} GiB`], ["客户机内存", status.host.memoryTotalGiB === null ? '—' : `${status.host.memoryFreeGiB ?? '—'} / ${status.host.memoryTotalGiB} GiB 可用`], ["逻辑处理器", status.host.logicalProcessors === null ? '—' : `${status.host.logicalProcessors} · ${status.host.processorGroups ?? '—'} 个处理器组`], ["线程与优先级", `${status.runtime.threadCount ?? '—'} · ${status.runtime.priority ?? '—'}`], ["开服任务", taskStateLabel(status.automation.serverTask.state)], ["停止任务上次结果", status.automation.stopTask.lastResult === null ? '未采集 · 写操作保持锁定' : `${status.automation.stopTask.lastResult} · 写操作保持锁定`], ["共享存储", storageStateLabel(status)], ["游戏端口", status.connections[0]?.detail ?? '待检查']]} />
  if (active === 'game') return <DataRows rows={[["实例", status.serverName], ["运行状态", stateLabel(status.state)], ["运行时间", formatUptime(status.runtime.uptimeSeconds)], ["目标 UPS", status.runtime.targetUps?.toString() ?? '—'], ["加载状态", status.versions.gameLoaded ? '游戏存档已加载' : '待确认'], ["在线玩家", `${status.runtime.onlinePlayers ?? '—'} / ${status.runtime.maxPlayers ?? '—'}`], ["写操作", '等待安全适配器验证']]} />
  if (active === 'config') return <DataRows rows={[["游戏配置", '只读 Schema 草案'], ["Nebula 配置", '机密字段不回显'], ["性能配置", `目标 UPS ${status.runtime.targetUps ?? '—'}`], ["网络配置", '端点由部署层提供'], ["变更策略", '差异预览 + 回滚快照']]} />
  return <DataRows rows={[["Profile", '尚未生成'], ["服务端锁", '等待模组解析器'], ["游戏文件", '永不打包'], ["敏感信息", '永不导出'], ["交付格式", 'Thunderstore Profile + 安装说明']]} />
}

function DataRows({ rows }: { rows: string[][] }) {
  return <div className="data-rows">{rows.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong><Check size={16} /></div>)}</div>
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

function stateLabel(state: ServerStatus['state']): string {
  return ({ running: '运行中', stopped: '已停止', starting: '启动中', stopping: '停止中', unknown: '未知' })[state]
}

function OrbitMark() {
  return <svg className="orbit-mark" viewBox="0 0 42 42" aria-hidden="true"><circle cx="21" cy="21" r="5" /><ellipse cx="21" cy="21" rx="18" ry="8" transform="rotate(-25 21 21)" /><ellipse cx="21" cy="21" rx="18" ry="8" transform="rotate(60 21 21)" /><path d="M6 33c9-2 19-9 28-22" /></svg>
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Ban, Check, ChevronLeft, ChevronRight, ClipboardList, Download,
  FileCheck2, Filter, LockKeyhole, RefreshCw, ShieldCheck, TriangleAlert, X
} from 'lucide-react'
import { api, ApiError, JOB_AUDIT_EXPORT_CONFIRMATION } from './api'
import { formatDuration } from './format'
import {
  jobKinds,
  type JobAuditExportDownload,
  type JobAuditExportFormat,
  type JobAuditExportInput,
  type JobAuditExportPreview,
  type JobKind,
  type JobPageQuery,
  type JobRecord,
  type JobState,
  type SessionUser
} from './model'

type ListPhase = 'idle' | 'loading' | 'ready' | 'empty' | 'cancelled' | 'error'
type ExportPhase = 'idle' | 'previewing' | 'prepared' | 'exporting' | 'downloaded' | 'cancelled' | 'error'
type ExportGate = 'server-enforced' | 'accepted' | 'locked'

interface FrozenExportPreview {
  input: JobAuditExportInput
  data: JobAuditExportPreview
}

const jobKindLabels: Readonly<Record<JobKind, string>> = {
  'status.refresh': '状态刷新',
  'game.start.preview': '启动预演',
  'game.save.preview': '保存预演',
  'game.stop.preview': '停止预演',
  'game.restart.preview': '重启预演',
  'game.start': '启动游戏',
  'game.save': '保存游戏',
  'game.stop': '停止游戏',
  'game.restart': '重启游戏',
  'save.backup': '存档备份',
  'save.restore': '存档恢复',
  'player.notice.preview': '玩家通知预演',
  'player.notice': '玩家通知',
  'audit.export': '审计导出'
}

const jobStateLabels: Readonly<Record<JobState, string>> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '成功',
  failed: '失败'
}

export function TasksAuditWorkspace({ user }: { user: SessionUser }) {
  const canRead = user.permissions.includes('jobs.read')
  const canExport = user.role === 'administrator' && user.permissions.includes('jobs.export')
  const [kind, setKind] = useState<JobKind | ''>('')
  const [state, setState] = useState<JobState | ''>('')
  const [pageSize, setPageSize] = useState(20)
  const [cursorStack, setCursorStack] = useState<Array<string | undefined>>([undefined])
  const [jobs, setJobs] = useState<JobRecord[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [listPhase, setListPhase] = useState<ListPhase>('idle')
  const [listError, setListError] = useState('')
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [format, setFormat] = useState<JobAuditExportFormat>('json')
  const [maximumRecordsText, setMaximumRecordsText] = useState('100')
  const [exportGate, setExportGate] = useState<ExportGate>('server-enforced')
  const [exportPhase, setExportPhase] = useState<ExportPhase>('idle')
  const [exportPreview, setExportPreview] = useState<FrozenExportPreview | null>(null)
  const [confirmation, setConfirmation] = useState('')
  const [exportError, setExportError] = useState('')
  const [exportNotice, setExportNotice] = useState('')
  const [download, setDownload] = useState<JobAuditExportDownload | null>(null)
  const listAbortRef = useRef<AbortController | null>(null)
  const exportAbortRef = useRef<AbortController | null>(null)
  const listSequenceRef = useRef(0)
  const exportSequenceRef = useRef(0)
  const exportBusyRef = useRef(false)
  const objectUrlRef = useRef<string | null>(null)
  const currentCursor = cursorStack[cursorStack.length - 1]

  const query = useMemo<JobPageQuery>(() => ({
    pageSize,
    ...(currentCursor ? { cursor: currentCursor } : {}),
    ...(kind ? { kind } : {}),
    ...(state ? { state } : {})
  }), [currentCursor, kind, pageSize, state])

  const loadPage = useCallback(async () => {
    if (!canRead) return
    const sequence = ++listSequenceRef.current
    const controller = new AbortController()
    listAbortRef.current?.abort()
    listAbortRef.current = controller
    setListPhase('loading')
    setListError('')
    try {
      const result = await api.jobPage(query, controller.signal)
      if (sequence !== listSequenceRef.current) return
      setJobs(result.data)
      setNextCursor(result.page.nextCursor)
      setListPhase(result.data.length === 0 ? 'empty' : 'ready')
    } catch (reason) {
      if (sequence !== listSequenceRef.current || isAbortError(reason)) return
      setJobs([])
      setNextCursor(null)
      setListPhase('error')
      setListError(formatJobAuditError(reason, '任务历史读取失败。'))
    } finally {
      if (listAbortRef.current === controller) listAbortRef.current = null
    }
  }, [canRead, query])

  useEffect(() => { void loadPage() }, [loadPage, refreshNonce])

  useEffect(() => {
    exportAbortRef.current?.abort()
    exportSequenceRef.current += 1
    exportBusyRef.current = false
    setExportPreview(null)
    setConfirmation('')
    setExportPhase('idle')
    setExportError('')
    setExportNotice('')
    setDownload(null)
    setExportGate((current) => current === 'locked' ? 'locked' : 'server-enforced')
  }, [currentCursor, format, kind, maximumRecordsText, state])

  useEffect(() => () => {
    listAbortRef.current?.abort()
    exportAbortRef.current?.abort()
    listSequenceRef.current += 1
    exportSequenceRef.current += 1
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
  }, [])

  function resetPagination(): void {
    setCursorStack([undefined])
    setNextCursor(null)
  }

  function changeKind(value: string): void {
    setKind(value as JobKind | '')
    resetPagination()
  }

  function changeState(value: string): void {
    setState(value as JobState | '')
    resetPagination()
  }

  function changePageSize(value: string): void {
    setPageSize(Number(value))
    resetPagination()
  }

  function cancelList(): void {
    listAbortRef.current?.abort()
    listAbortRef.current = null
    listSequenceRef.current += 1
    setListPhase('cancelled')
    setListError('已中止本次浏览器读取；服务器任务和审计记录没有被修改。')
  }

  function refreshList(): void {
    setRefreshNonce((value) => value + 1)
  }

  function nextPage(): void {
    if (!nextCursor || listPhase === 'loading') return
    setCursorStack((stack) => [...stack, nextCursor])
  }

  function previousPage(): void {
    if (cursorStack.length <= 1 || listPhase === 'loading') return
    setCursorStack((stack) => stack.slice(0, -1))
  }

  function exportInput(): JobAuditExportInput | null {
    const maximumRecords = Number(maximumRecordsText)
    if (!Number.isSafeInteger(maximumRecords) || maximumRecords < 1 || maximumRecords > 1_000) return null
    return {
      format,
      maximumRecords,
      ...(currentCursor ? { cursor: currentCursor } : {}),
      ...(kind ? { kind } : {}),
      ...(state ? { state } : {})
    }
  }

  async function prepareExport(): Promise<void> {
    const input = exportInput()
    if (!canExport || exportGate === 'locked' || !input || exportBusyRef.current) return
    exportBusyRef.current = true
    const sequence = ++exportSequenceRef.current
    const controller = new AbortController()
    exportAbortRef.current?.abort()
    exportAbortRef.current = controller
    setExportPhase('previewing')
    setExportPreview(null)
    setConfirmation('')
    setExportError('')
    setExportNotice('')
    setDownload(null)
    try {
      const result = await api.previewJobAuditExport(input, controller.signal)
      if (sequence !== exportSequenceRef.current) return
      setExportPreview({ input, data: result.data })
      setExportPhase('prepared')
      setExportGate('accepted')
    } catch (reason) {
      if (sequence !== exportSequenceRef.current || isAbortError(reason)) return
      setExportPhase('error')
      setExportError(formatJobAuditError(reason, '审计导出预演失败。'))
      if (isExportGateFailure(reason)) setExportGate('locked')
    } finally {
      if (exportAbortRef.current === controller) exportAbortRef.current = null
      exportBusyRef.current = false
    }
  }

  async function executeExport(): Promise<void> {
    const input = exportInput()
    if (!canExport || exportGate === 'locked' || exportBusyRef.current || !input ||
        !exportPreview || !sameExportInput(exportPreview.input, input) ||
        confirmation !== JOB_AUDIT_EXPORT_CONFIRMATION) return
    exportBusyRef.current = true
    const sequence = ++exportSequenceRef.current
    const controller = new AbortController()
    exportAbortRef.current?.abort()
    exportAbortRef.current = controller
    setExportPhase('exporting')
    setExportError('')
    setExportNotice('')
    setDownload(null)
    try {
      const fresh = (await api.previewJobAuditExport(input, controller.signal)).data
      if (sequence !== exportSequenceRef.current) return
      if (!sameExportPreview(exportPreview.data, fresh)) {
        setExportPreview({ input, data: fresh })
        setConfirmation('')
        setExportPhase('prepared')
        setExportNotice('持久任务历史在确认期间发生变化。预演已刷新；请复核并重新输入确认令牌。')
        return
      }
      const result = await api.exportJobAudit(input, JOB_AUDIT_EXPORT_CONFIRMATION, controller.signal)
      if (sequence !== exportSequenceRef.current) return
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
      const objectUrl = URL.createObjectURL(result.blob)
      objectUrlRef.current = objectUrl
      const anchor = document.createElement('a')
      anchor.href = objectUrl
      anchor.download = result.fileName
      anchor.click()
      setDownload(result)
      setExportPhase('downloaded')
      setConfirmation('')
      setExportGate('accepted')
      setRefreshNonce((value) => value + 1)
    } catch (reason) {
      if (sequence !== exportSequenceRef.current || isAbortError(reason)) return
      setExportPhase('error')
      setExportError(formatJobAuditError(reason, '审计附件生成或浏览器校验失败。'))
      setConfirmation('')
      if (isExportGateFailure(reason)) setExportGate('locked')
    } finally {
      if (exportAbortRef.current === controller) exportAbortRef.current = null
      exportBusyRef.current = false
    }
  }

  function cancelExport(): void {
    exportAbortRef.current?.abort()
    exportAbortRef.current = null
    exportSequenceRef.current += 1
    exportBusyRef.current = false
    setExportPhase('cancelled')
    setConfirmation('')
    setExportError('已中止本次浏览器等待；没有触发新的附件下载。')
  }

  if (!canRead) {
    return <div className="task-audit-role-denied" role="status">
      <LockKeyhole size={18} />
      <div><strong>任务审计不可见</strong><small>当前会话缺少 jobs.read；页面不会发出任务历史请求。</small></div>
    </div>
  }

  const previewInputMatches = exportPreview !== null && sameExportInput(exportPreview.input, exportInput())
  const exportBusy = exportPhase === 'previewing' || exportPhase === 'exporting'

  return <div className="task-audit-workspace">
    <section className="task-audit-toolbar" aria-label="任务筛选">
      <div className="task-audit-filter-title"><Filter size={16} /><span><strong>持久任务过滤器</strong><small>过滤器改变时游标链和导出预演都会归零</small></span></div>
      <label>类型<select aria-label="任务类型" value={kind} onChange={(event) => changeKind(event.target.value)} disabled={listPhase === 'loading'}>
        <option value="">全部类型</option>
        {jobKinds.map((value) => <option key={value} value={value}>{jobKindLabels[value]}</option>)}
      </select></label>
      <label>状态<select aria-label="任务状态" value={state} onChange={(event) => changeState(event.target.value)} disabled={listPhase === 'loading'}>
        <option value="">全部状态</option>
        {(Object.keys(jobStateLabels) as JobState[]).map((value) =>
          <option key={value} value={value}>{jobStateLabels[value]}</option>)}
      </select></label>
      <label>每页<select aria-label="每页任务数" value={pageSize} onChange={(event) => changePageSize(event.target.value)} disabled={listPhase === 'loading'}>
        {[10, 20, 50, 100].map((value) => <option key={value} value={value}>{value}</option>)}
      </select></label>
      <div className="task-audit-toolbar-actions">
        {listPhase === 'loading'
          ? <button type="button" onClick={cancelList}><X size={14} />中止读取</button>
          : <button type="button" onClick={refreshList}><RefreshCw size={14} />刷新</button>}
      </div>
    </section>

    <section className="task-audit-ledger" aria-busy={listPhase === 'loading'}>
      <header>
        <div><ClipboardList size={17} /><span><strong>任务审计账本</strong><small>稳定不透明游标 · 第 {cursorStack.length} 页</small></span></div>
        <code>{kind || 'ALL_KINDS'} · {state || 'ALL_STATES'}</code>
      </header>
      {listPhase === 'loading' && <div className="task-audit-state" role="status"><RefreshCw className="spin" size={19} /><span><strong>正在读取持久记录</strong><small>可随时中止本次浏览器等待</small></span></div>}
      {listPhase === 'empty' && <div className="task-audit-state" role="status"><FileCheck2 size={19} /><span><strong>当前游标范围没有任务</strong><small>这是已验证空态；可调整过滤器或刷新。</small></span></div>}
      {listPhase === 'cancelled' && <div className="task-audit-state cancelled" role="status"><Ban size={19} /><span><strong>读取已中止</strong><small>{listError}</small></span></div>}
      {listPhase === 'error' && <div className="task-audit-state failed" role="alert"><TriangleAlert size={19} /><span><strong>读取保持 fail-closed</strong><small>{listError}</small></span></div>}
      {(listPhase === 'ready' || (listPhase === 'loading' && jobs.length > 0)) && <div className="task-audit-table-wrap">
        <table>
          <caption className="sr-only">持久任务与审计记录</caption>
          <thead><tr><th>创建时间</th><th>类型与任务</th><th>状态</th><th>耗时</th><th>操作者</th><th>错误代码</th></tr></thead>
          <tbody>{jobs.map((job) => <tr key={job.id}>
            <td><time dateTime={job.createdAt}>{formatTimestamp(job.createdAt)}</time></td>
            <td><strong>{jobKindLabels[job.kind]}</strong><span>{job.summary}</span><code>{job.id}</code></td>
            <td><span className={`job-state ${job.state}`}>{jobStateLabels[job.state]}</span></td>
            <td>{formatDuration(job.durationMs)}</td>
            <td>{job.actor}</td>
            <td><code className={job.errorCode ? 'failed' : ''}>{job.errorCode ?? 'NONE'}</code></td>
          </tr>)}</tbody>
        </table>
      </div>}
      <footer className="task-audit-pagination">
        <button type="button" onClick={previousPage} disabled={cursorStack.length <= 1 || listPhase === 'loading'} aria-label="上一页任务"><ChevronLeft size={15} />上一页</button>
        <span><strong>第 {cursorStack.length} 页</strong><small>{jobs.length} 条 · {nextCursor ? '存在后续游标' : '已到持久记录末尾'}</small></span>
        <button type="button" onClick={nextPage} disabled={!nextCursor || listPhase === 'loading'} aria-label="下一页任务">下一页<ChevronRight size={15} /></button>
      </footer>
    </section>

    <section className={`task-audit-export ${exportGate === 'locked' ? 'locked' : ''}`}>
      <header>
        <div><ShieldCheck size={17} /><span><strong>审计附件导出</strong><small>固定能力 · 当前过滤器与当前页游标</small></span></div>
        <code>{exportGate === 'locked' ? 'FAIL-CLOSED' : exportGate === 'accepted' ? 'SERVER ACCEPTED' : 'SERVER ENFORCED'}</code>
      </header>
      {!canExport ? <div className="task-audit-readonly" role="status">
        <LockKeyhole size={18} />
        <div><strong>{user.role === 'administrator' ? '导出权限未授予' : '当前角色仅可读取'}</strong><small>只有 Administrator 且会话含 jobs.export 才能预演和下载审计附件。</small></div>
      </div> : <>
        <div className="task-audit-export-config">
          <label>格式<select aria-label="审计导出格式" value={format} onChange={(event) => setFormat(event.target.value as JobAuditExportFormat)} disabled={exportBusy || exportGate === 'locked'}>
            <option value="json">JSON</option><option value="ndjson">NDJSON</option>
          </select></label>
          <label>最大记录数<input aria-label="审计导出最大记录数" type="number" min="1" max="1000" step="1" inputMode="numeric" value={maximumRecordsText} onChange={(event) => setMaximumRecordsText(event.target.value)} disabled={exportBusy || exportGate === 'locked'} /></label>
          <div className="task-audit-export-origin"><span>导出起点</span><strong>{currentCursor ? `当前页游标 · 第 ${cursorStack.length} 页` : '账本起始位置'}</strong><small>不接受 URL、路径或命令输入</small></div>
          <div className="task-audit-export-actions">
            <button type="button" onClick={() => void prepareExport()} disabled={exportBusy || exportGate === 'locked' || exportInput() === null}>
              {exportBusy ? <RefreshCw className="spin" size={15} /> : <FileCheck2 size={15} />}
              {exportPhase === 'exporting' ? '正在生成附件' : exportPhase === 'previewing' ? '正在生成预演' : '生成预演'}
            </button>
            {exportBusy && <button type="button" aria-label="中止审计导出" onClick={cancelExport}><X size={15} />中止</button>}
          </div>
        </div>

        {exportGate === 'locked' && <div className="task-audit-export-alert" role="alert"><LockKeyhole size={17} /><span><strong>导出门禁已锁定</strong><small>服务端返回 403/423；本页不会继续尝试导出。刷新整个会话后才能重新评估权限。</small></span></div>}
        {exportError && <div className="task-audit-export-alert" role="alert"><TriangleAlert size={17} /><span><strong>导出未执行</strong><small>{exportError}</small></span></div>}
        {exportNotice && <div className="task-audit-export-alert notice" role="status"><RefreshCw size={17} /><span><strong>预演已经刷新</strong><small>{exportNotice}</small></span></div>}

        {exportPreview && <div className="task-audit-preview" aria-live="polite">
          <header><div><FileCheck2 size={16} /><span><strong>DRY-RUN 预演</strong><small>以下结果绑定当前过滤器、游标、格式与记录上限</small></span></div><code>{exportPreview.data.format.toUpperCase()}</code></header>
          <dl>
            <div><dt>记录数</dt><dd>{exportPreview.data.recordCount}</dd></div>
            <div><dt>预计字节</dt><dd>{formatBytes(exportPreview.data.byteLength)}</dd></div>
            <div><dt>截断</dt><dd>{exportPreview.data.truncated ? '是' : '否'}</dd></div>
            <div><dt>过滤器</dt><dd>{exportPreview.data.filters.kind ?? '全部类型'} / {exportPreview.data.filters.state ?? '全部状态'}</dd></div>
          </dl>
          <div className="task-audit-next-cursor"><span>nextCursor</span><code>{exportPreview.data.nextCursor ?? 'null'}</code></div>
          <div className="task-audit-confirmation">
            <div><LockKeyhole size={16} /><span><strong>精确确认令牌</strong><small>输入 <code>{JOB_AUDIT_EXPORT_CONFIRMATION}</code>；执行前会再次校验预演是否变化。</small></span></div>
            <label htmlFor="job-audit-confirmation" className="sr-only">审计导出确认令牌</label>
            <input id="job-audit-confirmation" aria-label="审计导出确认令牌" autoComplete="off" spellCheck={false} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={exportBusy || exportGate === 'locked'} />
            <button type="button" onClick={() => void executeExport()} disabled={exportBusy || exportGate === 'locked' || !previewInputMatches || confirmation !== JOB_AUDIT_EXPORT_CONFIRMATION}><Download size={15} />校验并下载</button>
          </div>
        </div>}

        {download && exportPhase === 'downloaded' && <div className="task-audit-download" role="status"><Check size={18} /><span><strong>附件已通过浏览器完整性校验并下载</strong><small>{download.fileName} · {download.recordCount} 条 · {formatBytes(download.byteLength)}{download.truncated ? ' · 存在后续游标' : ''}</small></span></div>}
      </>}
    </section>
  </div>
}

function sameExportInput(left: JobAuditExportInput, right: JobAuditExportInput | null): boolean {
  return right !== null && left.format === right.format && left.maximumRecords === right.maximumRecords &&
    left.cursor === right.cursor && left.kind === right.kind && left.state === right.state
}

function sameExportPreview(left: JobAuditExportPreview, right: JobAuditExportPreview): boolean {
  return left.mode === right.mode && left.format === right.format && left.recordCount === right.recordCount &&
    left.byteLength === right.byteLength && left.truncated === right.truncated &&
    left.nextCursor === right.nextCursor && left.filters.kind === right.filters.kind &&
    left.filters.state === right.filters.state && left.requiredConfirmation === right.requiredConfirmation
}

function isExportGateFailure(reason: unknown): boolean {
  return reason instanceof ApiError && (reason.status === 403 || reason.status === 423)
}

function formatJobAuditError(reason: unknown, fallback: string): string {
  if (!(reason instanceof ApiError)) return fallback
  if (reason.status === 400) return '任务筛选、游标或导出参数无效；请从第一页重新读取。'
  if (reason.status === 401) return '当前会话已失效；请重新登录后再读取。'
  if (reason.status === 403) return '服务端拒绝当前会话的任务审计权限。'
  if (reason.status === 413) return '导出超过固定 2 MiB 上限；请缩小记录数量。'
  if (reason.status === 423) return '服务端审计导出门禁当前关闭。'
  if (reason.status === 502) return '服务端响应未通过浏览器完整性校验。'
  if (reason.status === 0) return reason.code === 'JOB_AUDIT_BROWSER_REQUEST_INVALID'
    ? '浏览器拒绝了无效的筛选或导出参数。'
    : '无法连接任务审计端点；没有执行导出。'
  return fallback
}

function isAbortError(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === 'AbortError'
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`
}

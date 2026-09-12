import {
  Activity, Check, CircleOff, DatabaseZap, GitBranch, KeyRound, LockKeyhole,
  RadioTower, RefreshCw, RotateCcw, ShieldAlert, ShieldCheck, TriangleAlert
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  api,
  ApiError,
  CUTOVER_ACTIVATE_CONFIRMATION,
  CUTOVER_PREPARE_CONFIRMATION,
  CUTOVER_RECOVERY_CONFIRMATION,
  CUTOVER_ROLLBACK_CONFIRMATION
} from './api'
import type {
  CutoverDesiredAuthority,
  CutoverPreviewReceipt,
  CutoverPreviewRequest,
  CutoverReceipt,
  CutoverRecoveryStatus,
  CutoverRollbackMode,
  SessionUser
} from './model'
import { createUiRequestId } from './request-id'

type OrdinaryOperation = 'prepare' | 'activate' | 'rollback-immediate' | 'rollback-later'
type CutoverOperation = OrdinaryOperation | 'recover-previous' | 'recover-candidate'
type GateScope = 'ordinary' | 'recovery'

interface OperationPreview {
  operation: CutoverOperation
  requestId: string
  confirmation: string
  rollbackMode: CutoverRollbackMode | null
  desired: CutoverDesiredAuthority | null
  statusSnapshot: CutoverRecoveryStatus
  serverPreview: CutoverPreviewReceipt | null
}

interface DisplayError {
  code: string
  message: string
}

interface GateLock {
  scope: GateScope
  code: string
  message: string
}

const ordinaryOperations: Array<{
  operation: OrdinaryOperation
  label: string
  eyebrow: string
  description: string
  confirmation: string
  tone: 'cyan' | 'green' | 'amber' | 'red'
}> = [
  {
    operation: 'prepare',
    label: '准备候选权威',
    eyebrow: '01 / PREPARE',
    description: '创建或替换禁用的候选 Windows 计划任务定义；这是一次真实主机写入，但不会切换当前权威。',
    confirmation: CUTOVER_PREPARE_CONFIRMATION,
    tone: 'cyan'
  },
  {
    operation: 'activate',
    label: '激活 Dyson 权威',
    eyebrow: '02 / ACTIVATE',
    description: '按固定事务停用 GSManager、启动候选并证明唯一权威。',
    confirmation: CUTOVER_ACTIVATE_CONFIRMATION,
    tone: 'green'
  },
  {
    operation: 'rollback-immediate',
    label: '立即补偿回退',
    eyebrow: '03A / COMPENSATE',
    description: '在激活链内恢复基线与 GSManager 权威，保留失败安全证据。',
    confirmation: CUTOVER_ROLLBACK_CONFIRMATION,
    tone: 'amber'
  },
  {
    operation: 'rollback-later',
    label: '管理员后续回退',
    eyebrow: '03B / ROLLBACK',
    description: '保护候选当前进度后，显式回到 GSManager 权威。',
    confirmation: CUTOVER_ROLLBACK_CONFIRMATION,
    tone: 'red'
  }
]

const summaryItems: Array<{
  key: keyof CutoverReceipt['summary']
  label: string
}> = [
  { key: 'candidateDefined', label: '候选定义' },
  { key: 'candidateDisabled', label: '候选禁用' },
  { key: 'previousAuthorityEnabled', label: 'GSManager 权威' },
  { key: 'candidateAuthorityEnabled', label: 'Dyson 权威' },
  { key: 'previousRuntimeHealthy', label: '原运行时健康' },
  { key: 'candidateRuntimeHealthy', label: '候选运行时健康' },
  { key: 'processesStopped', label: '进程停止证据' },
  { key: 'portClosed', label: '端口关闭证据' },
  { key: 'uniqueAuthority', label: '唯一权威' },
  { key: 'saveProtected', label: '存档保护' },
  { key: 'baselineRestored', label: '基线恢复' },
  { key: 'currentProgressProtected', label: '当前进度保护' }
]

export function CutoverWorkspace({ user, demo = false }: { user: SessionUser; demo?: boolean }) {
  const canRead = user.permissions.includes('cutover.read')
  const canExecute = user.role === 'administrator' && user.permissions.includes('cutover.execute')
  const [status, setStatus] = useState<CutoverRecoveryStatus | null>(null)
  const [statusError, setStatusError] = useState<DisplayError | null>(null)
  const [operationError, setOperationError] = useState<DisplayError | null>(null)
  const [gateLock, setGateLock] = useState<GateLock | null>(null)
  const [preview, setPreview] = useState<OperationPreview | null>(null)
  const [confirmation, setConfirmation] = useState('')
  const [receipt, setReceipt] = useState<CutoverReceipt | null>(null)
  const [loading, setLoading] = useState(canRead && !demo)
  const [busy, setBusy] = useState<'status' | 'preview' | 'execute' | null>(null)
  const mountedRef = useRef(true)
  const busyRef = useRef(false)
  const statusControllerRef = useRef<AbortController | null>(null)
  const mutationControllerRef = useRef<AbortController | null>(null)

  const readStatus = useCallback(async (): Promise<CutoverRecoveryStatus> => {
    if (!canRead) throw new ApiError(403, '当前角色没有 Cutover 状态读取权限。', 'AUTHORIZATION_DENIED')
    statusControllerRef.current?.abort()
    const controller = new AbortController()
    statusControllerRef.current = controller
    setLoading(true)
    setBusy((current) => current ?? 'status')
    try {
      const result = await api.cutoverStatus(controller.signal)
      if (!controller.signal.aborted && mountedRef.current) {
        setStatus(result.data)
        setStatusError(null)
      }
      return result.data
    } catch (reason) {
      if (!controller.signal.aborted && mountedRef.current) setStatusError(toDisplayError(reason))
      throw reason
    } finally {
      if (!controller.signal.aborted && mountedRef.current) {
        setLoading(false)
        setBusy((current) => current === 'status' ? null : current)
      }
    }
  }, [canRead])

  useEffect(() => {
    mountedRef.current = true
    if (canRead && !demo) void readStatus().catch(() => undefined)
    const reconnect = () => {
      if (canRead && !demo && !busyRef.current) {
        setPreview(null)
        setConfirmation('')
        void readStatus().catch(() => undefined)
      }
    }
    window.addEventListener('online', reconnect)
    return () => {
      mountedRef.current = false
      window.removeEventListener('online', reconnect)
      statusControllerRef.current?.abort()
      mutationControllerRef.current?.abort()
    }
  }, [canRead, demo, readStatus])

  useEffect(() => {
    if (!canExecute) {
      setPreview(null)
      setConfirmation('')
    }
  }, [canExecute])

  async function refresh(): Promise<void> {
    if (busyRef.current) return
    setOperationError(null)
    setPreview(null)
    setConfirmation('')
    await readStatus().catch(() => undefined)
  }

  async function stageOrdinary(operation: OrdinaryOperation): Promise<void> {
    const definition = ordinaryOperations.find((item) => item.operation === operation)
    if (!definition || !canExecute || busyRef.current || gateLock?.scope === 'ordinary') return
    busyRef.current = true
    setBusy('preview')
    setOperationError(null)
    const controller = new AbortController()
    mutationControllerRef.current = controller
    try {
      const fresh = await readStatus()
      if (fresh.phase !== 'ready') {
        throw new ApiError(409, '持久状态不是 ready；普通切换保持锁定。', 'CUTOVER_BROWSER_PREFLIGHT_CHANGED')
      }
      const requestId = createUiRequestId()
      const serverPreview = (await api.previewCutover(
        previewRequestFor(operation, requestId),
        controller.signal
      )).data
      setPreview({
        operation,
        requestId,
        confirmation: definition.confirmation,
        rollbackMode: rollbackModeFor(operation),
        desired: null,
        statusSnapshot: fresh,
        serverPreview
      })
      setConfirmation('')
    } catch (reason) {
      if (!controller.signal.aborted && !isAbort(reason)) setOperationError(toDisplayError(reason))
    } finally {
      busyRef.current = false
      if (mountedRef.current) setBusy(null)
    }
  }

  async function stageRecovery(desired: CutoverDesiredAuthority): Promise<void> {
    if (!canExecute || busyRef.current || gateLock?.scope === 'recovery') return
    busyRef.current = true
    setBusy('preview')
    setOperationError(null)
    try {
      const fresh = await readStatus()
      if (fresh.phase !== 'recovery-required' || fresh.requestId === null ||
          !fresh.allowedDesired.includes(desired)) {
        throw new ApiError(409, '恢复身份或允许目标已经变化；请重新读取持久状态。', 'CUTOVER_BROWSER_PREFLIGHT_CHANGED')
      }
      setPreview({
        operation: desired === 'previous' ? 'recover-previous' : 'recover-candidate',
        requestId: fresh.requestId,
        confirmation: CUTOVER_RECOVERY_CONFIRMATION,
        rollbackMode: null,
        desired,
        statusSnapshot: fresh,
        serverPreview: null
      })
      setConfirmation('')
    } catch (reason) {
      if (!isAbort(reason)) setOperationError(toDisplayError(reason))
    } finally {
      busyRef.current = false
      if (mountedRef.current) setBusy(null)
    }
  }

  async function executePreview(): Promise<void> {
    if (!preview || !canExecute || confirmation !== preview.confirmation || busyRef.current) return
    const current = preview
    busyRef.current = true
    setBusy('execute')
    setOperationError(null)
    const controller = new AbortController()
    mutationControllerRef.current = controller
    try {
      const latest = (await api.cutoverStatus(controller.signal)).data
      if (mountedRef.current) setStatus(latest)
      assertPreviewStillAllowed(current, latest)
      if (isOrdinaryOperation(current.operation)) {
        if (current.serverPreview === null) throw cutoverPreviewChanged()
        const refreshed = (await api.previewCutover(
          previewRequestFor(current.operation, current.requestId),
          controller.signal
        )).data
        if (!sameServerPreview(current.serverPreview, refreshed)) {
          if (!controller.signal.aborted && mountedRef.current) {
            setPreview({ ...current, statusSnapshot: latest, serverPreview: refreshed })
            setConfirmation('')
            setOperationError(toDisplayError(cutoverPreviewChanged()))
          }
          return
        }
      }
      const result = await executeCutoverOperation(current, controller.signal)
      if (!controller.signal.aborted && mountedRef.current) {
        setReceipt(result)
        setPreview(null)
        setConfirmation('')
      }
      try {
        const after = (await api.cutoverStatus(controller.signal)).data
        if (!controller.signal.aborted && mountedRef.current) {
          setStatus(after)
          setStatusError(null)
        }
      } catch (reason) {
        if (!controller.signal.aborted && mountedRef.current) setStatusError(toDisplayError(reason))
      }
    } catch (reason) {
      if (!controller.signal.aborted && mountedRef.current) {
        const display = toDisplayError(reason)
        setOperationError(display)
        if (reason instanceof ApiError && reason.status === 423) {
          setGateLock({
          scope: current.operation.startsWith('recover-') ? 'recovery' : 'ordinary',
            code: display.code,
            message: display.message
          })
          setPreview(null)
          setConfirmation('')
          setOperationError(null)
        } else if (reason instanceof ApiError && reason.status === 409) {
          setPreview(null)
          setConfirmation('')
        } else {
          // Network failure or an invalid terminal receipt can occur after the
          // host mutation. Preserve the exact request/plan for safe replay.
          setConfirmation('')
        }
        await rereadAfterMutationFailure()
      }
    } finally {
      busyRef.current = false
      if (mountedRef.current) setBusy(null)
    }
  }

  async function rereadAfterMutationFailure(): Promise<void> {
    const controller = new AbortController()
    statusControllerRef.current = controller
    try {
      const next = (await api.cutoverStatus(controller.signal)).data
      if (!controller.signal.aborted && mountedRef.current) {
        setStatus(next)
        setStatusError(null)
      }
    } catch (reason) {
      if (!controller.signal.aborted && mountedRef.current) setStatusError(toDisplayError(reason))
    }
  }

  async function executeCutoverOperation(
    current: OperationPreview,
    signal: AbortSignal
  ): Promise<CutoverReceipt> {
    if (current.operation === 'prepare') {
      if (current.serverPreview === null) throw cutoverPreviewChanged()
      return (await api.prepareCutover(
        current.requestId,
        current.serverPreview.planFingerprint,
        CUTOVER_PREPARE_CONFIRMATION,
        signal
      )).data
    }
    if (current.operation === 'activate') {
      if (current.serverPreview === null) throw cutoverPreviewChanged()
      return (await api.activateCutover(
        current.requestId,
        current.serverPreview.planFingerprint,
        CUTOVER_ACTIVATE_CONFIRMATION,
        signal
      )).data
    }
    if (current.operation === 'rollback-immediate' || current.operation === 'rollback-later') {
      if (current.serverPreview === null) throw cutoverPreviewChanged()
      return (await api.rollbackCutover(
        current.requestId,
        current.rollbackMode!,
        current.serverPreview.planFingerprint,
        CUTOVER_ROLLBACK_CONFIRMATION,
        signal
      )).data
    }
    return (await api.recoverCutover(
      current.requestId,
      current.desired!,
      CUTOVER_RECOVERY_CONFIRMATION,
      signal
    )).data
  }

  if (!canRead) {
    return <div className="cutover-workspace cutover-access-denied">
      <LockKeyhole size={24} />
      <div><strong>Cutover 状态不可见</strong><small>当前会话缺少 cutover.read；页面不会尝试任何 API 请求。</small></div>
    </div>
  }

  if (demo) {
    return <div className="cutover-workspace">
      <div className="cutover-toolbar">
        <div><RadioTower size={18} /><span><strong>固定权威切换控制面</strong><small>GSManager ⇄ Dyson · durable status / receipt / audit</small></span></div>
        <b>DEMO READ-ONLY</b>
      </div>
      <div className="cutover-role-boundary viewer">
        <CircleOff size={18} /><span><strong>演示环境未装载持久化 Cutover 控制链</strong><small>不会伪造权威、计划任务、保护点或回执，也不会请求生产专用接口。真实 Windows Provider 会在读取持久状态后独立执行唯一权威和回滚门禁。</small></span>
      </div>
      <CutoverStatusDeck status={null} loading={false} />
    </div>
  }

  const ordinaryLocked = !canExecute || status?.phase !== 'ready' || gateLock?.scope === 'ordinary'
  const recoveryLocked = !canExecute || status?.phase !== 'recovery-required' || gateLock?.scope === 'recovery'
  return <div className="cutover-workspace">
    <div className="cutover-toolbar">
      <div><RadioTower size={18} /><span><strong>固定权威切换控制面</strong><small>GSManager ⇄ Dyson · durable status / receipt / audit</small></span></div>
      <button onClick={() => void refresh()} disabled={busy !== null}>
        <RefreshCw className={loading ? 'spin' : ''} size={15} />{loading ? '读取中…' : '重新读取持久状态'}
      </button>
    </div>

    <RoleBoundary user={user} canExecute={canExecute} />
    <DefaultGateNotice lock={gateLock} />
    {statusError && <ErrorNotice title="状态读取失败" error={statusError} />}
    {operationError && <ErrorNotice title="操作保持锁定" error={operationError} />}

    <CutoverStatusDeck status={status} loading={loading} />
    {status && <EvidenceMatrix summary={status.summary} />}

    <section className="cutover-operation-panel">
      <header><div><GitBranch size={16} /><span><strong>普通切换事务</strong><small>每次先读取 status，再由服务端签发绑定 state/evidence 的执行计划</small></span></div><b>{ordinaryLocked ? 'LOCKED' : 'SERVER PREVIEW'}</b></header>
      <div className="cutover-operation-grid">
        {ordinaryOperations.map((item) => <article className={`tone-${item.tone}`} key={item.operation}>
          <span>{item.eyebrow}</span><strong>{item.label}</strong><p>{item.description}</p>
          <button disabled={ordinaryLocked || busy !== null} onClick={() => void stageOrdinary(item.operation)}
            title={ordinaryDisabledReason(canExecute, status, gateLock)}>
            <ShieldCheck size={14} />{canExecute ? '读取服务端预演' : '需要 Administrator'}
          </button>
        </article>)}
      </div>
    </section>

    <RecoveryPanel
      status={status}
      locked={recoveryLocked || busy !== null}
      canExecute={canExecute}
      onStage={stageRecovery}
    />

    {preview && <PreviewPanel
      preview={preview}
      confirmation={confirmation}
      busy={busy === 'execute'}
      onConfirmation={setConfirmation}
      onCancel={() => { setPreview(null); setConfirmation('') }}
      onExecute={executePreview}
    />}

    <ReceiptPanel receipt={receipt} />
  </div>
}

function RoleBoundary({ user, canExecute }: { user: SessionUser; canExecute: boolean }) {
  const copy = canExecute
    ? 'Administrator 可生成状态预演并提交固定能力；服务端仍逐请求授权和审计。'
    : user.role === 'operator'
      ? 'Operator 只能读取持久状态与回执；权威切换和恢复仅对 Administrator 开放。'
      : 'Viewer 只能读取持久状态与安全证据；页面不生成任何写入请求。'
  return <div className={`cutover-role-boundary ${canExecute ? 'administrator' : user.role}`}>
    <LockKeyhole size={16} /><span><strong>{canExecute ? 'ADMINISTRATOR EXECUTION SURFACE' : 'READ-ONLY CUTOVER SURFACE'}</strong><small>{copy}</small></span>
  </div>
}

function DefaultGateNotice({ lock }: { lock: GateLock | null }) {
  if (lock) return <div className="cutover-gate-notice locked" role="alert">
    <ShieldAlert size={18} /><span><strong>FAIL-CLOSED · 服务端返回 423</strong><small>{lock.message}</small></span><code>{lock.code}</code>
  </div>
  return <div className="cutover-gate-notice">
    <LockKeyhole size={18} /><span><strong>执行门禁默认关闭</strong><small>status=ready 仅证明恢复协调器可读，不代表普通切换或恢复写入已启用；服务端 423 会立即锁住对应界面。</small></span><code>DEFAULT-OFF</code>
  </div>
}

function ErrorNotice({ title, error }: { title: string; error: DisplayError }) {
  return <div className="cutover-error" role="alert"><TriangleAlert size={17} /><span><strong>{title}</strong><small>{error.message}</small></span><code>{error.code}</code></div>
}

function CutoverStatusDeck({ status, loading }: {
  status: CutoverRecoveryStatus | null
  loading: boolean
}) {
  const phase = status ? phaseLabel(status.phase) : loading ? 'READING' : 'UNAVAILABLE'
  return <section className={`cutover-status-deck phase-${status?.phase ?? 'unknown'}`}>
    <article><Activity size={18} /><span>持久阶段<strong>{phase}</strong><small>{status?.status ?? '尚未取得状态'}</small></span></article>
    <article><DatabaseZap size={18} /><span>恢复标记<strong>{status?.recoveryRequired ? 'REQUIRED' : status ? 'CLEAR' : 'UNKNOWN'}</strong><small>{status?.mutationBlocked ? '普通 mutation 已阻断' : '协调器允许继续预检'}</small></span></article>
    <article><KeyRound size={18} /><span>允许恢复目标<strong>{status?.allowedDesired.length ? status.allowedDesired.map(authorityLabel).join(' / ') : 'NONE'}</strong><small>{status?.requestId ? `服务端 request ${shortId(status.requestId)}` : '无待恢复 request ID'}</small></span></article>
    <article><ShieldCheck size={18} /><span>审计边界<strong>SERVER-ENFORCED</strong><small>有效 mutation 必须完成 started / terminal 审计对</small></span></article>
  </section>
}

function EvidenceMatrix({ summary }: { summary: CutoverReceipt['summary'] }) {
  return <section className="cutover-evidence-panel">
    <header><div><RadioTower size={15} /><strong>安全证据投影</strong></div><span>仅布尔摘要 · 无路径 / 进程明细 / 端口号</span></header>
    <div>{summaryItems.map((item) => <article className={summary[item.key] ? 'pass' : 'clear'} key={item.key}>
      {summary[item.key] ? <Check size={13} /> : <CircleOff size={13} />}
      <span>{item.label}<small>{summary[item.key] ? 'TRUE' : 'FALSE'}</small></span>
    </article>)}</div>
  </section>
}

function RecoveryPanel({ status, locked, canExecute, onStage }: {
  status: CutoverRecoveryStatus | null
  locked: boolean
  canExecute: boolean
  onStage: (desired: CutoverDesiredAuthority) => Promise<void>
}) {
  const required = status?.phase === 'recovery-required'
  return <section className={`cutover-recovery-panel ${required ? 'required' : 'ready'}`}>
    <header><div>{required ? <ShieldAlert size={17} /> : <ShieldCheck size={17} />}<span><strong>{required ? '显式恢复工作流' : '当前无需恢复'}</strong><small>{required ? '仅使用服务端 request ID 和 allowedDesired' : '浏览器重连后会重新读取此持久状态'}</small></span></div><b>{required ? 'RECOVERY REQUIRED' : 'RECOVERY CLEAR'}</b></header>
    {required && status ? <div className="cutover-recovery-body">
      <div className="cutover-server-request"><span>SERVER-OWNED REQUEST ID</span><code>{status.requestId}</code><small>只读绑定；不能编辑或替换</small></div>
      <div className="cutover-recovery-targets">
        {status.allowedDesired.map((desired) => <button key={desired} disabled={locked}
          onClick={() => void onStage(desired)}>
          <RotateCcw size={14} />恢复到 {authorityLabel(desired)}
        </button>)}
        {status.allowedDesired.length === 0 && <p><TriangleAlert size={15} />证据无效且没有允许目标；恢复保持 fail-closed。</p>}
      </div>
      {!canExecute && <small className="cutover-recovery-role-note">当前角色仅能观察恢复身份；执行需要 Administrator。</small>}
    </div> : <p><ShieldCheck size={15} />没有待恢复 transaction。普通操作仍需单独的 status preflight 与服务端执行门禁。</p>}
  </section>
}

function PreviewPanel({ preview, confirmation, busy, onConfirmation, onCancel, onExecute }: {
  preview: OperationPreview
  confirmation: string
  busy: boolean
  onConfirmation: (value: string) => void
  onCancel: () => void
  onExecute: () => Promise<void>
}) {
  return <section className="cutover-preview-panel">
      <header><div><ShieldCheck size={17} /><span><strong>{preview.serverPreview ? 'SERVER PLAN 已签发' : 'RECOVERY PREFLIGHT 已生成'}</strong><small>{operationLabel(preview.operation)} · 执行尚未发生</small></span></div><b>PREVIEW / NO WRITE</b></header>
    <div className="cutover-preview-facts">
      <div><span>REQUEST ID</span><code>{preview.requestId}</code><small>{preview.operation.startsWith('recover-') ? '服务端持久身份' : '浏览器生成 UUID v4'}</small></div>
      <div><span>STATUS SNAPSHOT</span><strong>{phaseLabel(preview.statusSnapshot.phase)}</strong><small>{preview.statusSnapshot.status}</small></div>
      <div><span>DESIRED / MODE</span><strong>{preview.desired ? authorityLabel(preview.desired) : preview.rollbackMode ?? 'fixed capability'}</strong><small>无任意主机、路径或命令参数</small></div>
      <div><span>AUDIT CONTRACT</span><strong>STARTED → TERMINAL</strong><small>终态审计失败时响应 fail-closed</small></div>
      {preview.serverPreview && <>
        <div><span>PLAN FINGERPRINT</span><code>{shortDigest(preview.serverPreview.planFingerprint)}</code><small>服务端签发；执行前会在 host lease 内重算</small></div>
        <div><span>STATE REVISION</span><code>{shortDigest(preview.serverPreview.stateRevision)}</code><small>持久状态绑定</small></div>
        <div><span>EVIDENCE DIGEST</span><code>{shortDigest(preview.serverPreview.evidenceDigest)}</code><small>完整有界 host evidence 绑定</small></div>
      </>}
    </div>
    <div className="cutover-confirmation-row">
      <label><span>精确确认：<code>{preview.confirmation}</code></span><input
        aria-label="Cutover 精确确认"
        autoComplete="off"
        spellCheck={false}
        value={confirmation}
        disabled={busy}
        onChange={(event) => onConfirmation(event.target.value)}
        placeholder="逐字输入固定确认串"
      /></label>
      <button onClick={onCancel} disabled={busy}>取消预演</button>
      <button className="confirm" onClick={() => void onExecute()}
        disabled={busy || confirmation !== preview.confirmation}>
        <KeyRound size={14} />{busy ? '重新签发并校验计划中…' : '重新预演并提交'}
      </button>
    </div>
  </section>
}

function ReceiptPanel({ receipt }: { receipt: CutoverReceipt | null }) {
  return <section className={`cutover-receipt-panel ${receipt ? `status-${receipt.status}` : ''}`}>
    <header><div><DatabaseZap size={16} /><span><strong>持久 Cutover 回执</strong><small>服务端仅在终态审计写入后返回</small></span></div><b>{receipt ? receipt.status.toUpperCase() : 'NO RECEIPT IN THIS SESSION'}</b></header>
    {receipt ? <>
      <div className="cutover-receipt-grid">
        <div><span>REQUEST ID</span><code>{receipt.requestId}</code></div>
        <div><span>DURABLE PHASE</span><strong>{receipt.phase}</strong></div>
        <div><span>RESULT</span><strong>{receipt.status}</strong></div>
        <div><span>REUSED</span><strong>{receipt.summary.reused ? 'YES / IDEMPOTENT' : 'NO / NEW RECEIPT'}</strong></div>
        <div><span>ALLOWED DESIRED</span><strong>{receipt.allowedDesired.length ? receipt.allowedDesired.map(authorityLabel).join(' / ') : 'NONE'}</strong></div>
        <div><span>ERROR CODE</span><code>{receipt.errorCode ?? 'NONE'}</code></div>
        <div><span>AUDIT PAIR</span><strong>STARTED → TERMINAL</strong></div>
      </div>
      <footer><ShieldCheck size={14} />回执只包含有界摘要；重新连接后以 GET /cutover/status 恢复当前协调状态。</footer>
    </> : <p><DatabaseZap size={17} />本浏览器会话尚未收到 mutation 回执；status 读取不伪装成执行成功。</p>}
  </section>
}

function assertPreviewStillAllowed(preview: OperationPreview, latest: CutoverRecoveryStatus): void {
  if (preview.operation.startsWith('recover-')) {
    if (latest.phase !== 'recovery-required' || latest.requestId !== preview.requestId ||
        preview.desired === null || !latest.allowedDesired.includes(preview.desired)) {
      throw new ApiError(409, '恢复身份或允许目标在确认期间发生变化；请求未提交。', 'CUTOVER_BROWSER_PREFLIGHT_CHANGED')
    }
    return
  }
  if (latest.phase !== 'ready') {
    throw new ApiError(409, '持久状态在确认期间不再 ready；请求未提交。', 'CUTOVER_BROWSER_PREFLIGHT_CHANGED')
  }
}

function previewRequestFor(
  operation: OrdinaryOperation,
  requestId: string
): CutoverPreviewRequest {
  if (operation === 'prepare' || operation === 'activate') return { requestId, operation }
  return {
    requestId,
    operation: 'rollback',
    mode: operation === 'rollback-immediate'
      ? 'immediate-compensation'
      : 'later-operator-rollback'
  }
}

function isOrdinaryOperation(operation: CutoverOperation): operation is OrdinaryOperation {
  return operation === 'prepare' || operation === 'activate' ||
    operation === 'rollback-immediate' || operation === 'rollback-later'
}

function sameServerPreview(left: CutoverPreviewReceipt, right: CutoverPreviewReceipt): boolean {
  return left.format === right.format && left.schemaVersion === right.schemaVersion &&
    left.operation === right.operation && left.requestId === right.requestId &&
    left.rollbackMode === right.rollbackMode && left.stateRevision === right.stateRevision &&
    left.evidenceDigest === right.evidenceDigest &&
    left.planFingerprint === right.planFingerprint &&
    JSON.stringify(left.summary) === JSON.stringify(right.summary)
}

function cutoverPreviewChanged(): ApiError {
  return new ApiError(
    409,
    '服务器执行计划在确认期间发生变化；已显示新计划，请重新核对并逐字确认。',
    'CUTOVER_BROWSER_PREFLIGHT_CHANGED'
  )
}

function rollbackModeFor(operation: OrdinaryOperation): CutoverRollbackMode | null {
  if (operation === 'rollback-immediate') return 'immediate-compensation'
  if (operation === 'rollback-later') return 'later-operator-rollback'
  return null
}

function operationLabel(operation: CutoverOperation): string {
  return ordinaryOperations.find((item) => item.operation === operation)?.label ??
    (operation === 'recover-previous' ? '恢复 GSManager 权威' : '恢复 Dyson 权威')
}

function authorityLabel(authority: CutoverDesiredAuthority): string {
  return authority === 'previous' ? 'GSManager' : 'Dyson'
}

function phaseLabel(phase: CutoverRecoveryStatus['phase']): string {
  if (phase === 'ready') return 'READY'
  if (phase === 'recovery-required') return 'RECOVERY REQUIRED'
  if (phase === 'pending') return 'PENDING'
  if (phase === 'reconciling') return 'RECONCILING'
  return 'UNAVAILABLE'
}

function ordinaryDisabledReason(
  canExecute: boolean,
  status: CutoverRecoveryStatus | null,
  gateLock: GateLock | null
): string {
  if (!canExecute) return '仅 Administrator 可生成 Cutover 写入预演'
  if (gateLock?.scope === 'ordinary') return '服务端普通切换门禁已返回 423'
  if (!status) return '尚未读取持久状态'
  if (status.phase !== 'ready') return '恢复状态未 ready，普通切换保持锁定'
  return '读取最新状态并生成固定操作预演'
}

function shortId(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-4)}`
}

function shortDigest(value: string): string {
  return `${value.slice(0, 12)}…${value.slice(-8)}`
}

function toDisplayError(reason: unknown): DisplayError {
  if (reason instanceof ApiError) {
    return { code: reason.code ?? `HTTP_${reason.status}`, message: reason.message }
  }
  return {
    code: 'CUTOVER_BROWSER_UNEXPECTED_FAILURE',
    message: 'Cutover 浏览器流程未完成；所有切换操作保持锁定。'
  }
}

function isAbort(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === 'AbortError'
}

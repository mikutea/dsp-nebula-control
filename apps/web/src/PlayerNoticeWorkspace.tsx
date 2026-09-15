import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Megaphone, RefreshCw, ShieldAlert, TriangleAlert } from 'lucide-react'
import { api, ApiError, PlayerNoticeApiError } from './api'
import { createUiRequestId } from './request-id'
import type {
  PlayerCapabilitiesProjection, PlayerNoticePlan, PlayerNoticeReceipt,
  PlayerNoticeTemplateId, PlayerRoster, SessionUser
} from './model'

const noticeTemplates: ReadonlyArray<{
  id: PlayerNoticeTemplateId
  label: string
  message: string
}> = [
  {
    id: 'maintenance-5m',
    label: '维护前 5 分钟',
    message: '[Server] Scheduled maintenance will begin in 5 minutes. Please finish current work.'
  },
  {
    id: 'maintenance-now',
    label: '维护现在开始',
    message: '[Server] Scheduled maintenance is starting now. Please reconnect after service returns.'
  },
  {
    id: 'reconnect-required',
    label: '更新后重新连接',
    message: '[Server] The server was updated. Please reconnect to continue.'
  }
]

const pendingNoticeStorageKey = 'dyson-control.player-notice.pending.v1'

interface PendingPlayerNotice {
  schemaVersion: 1
  phase: 'awaiting-receipt' | 'awaiting-evidence-refresh'
  requestId: string
  rosterGeneration: string
  rosterSequence: number
  sessionPlayerId: string
  templateId: PlayerNoticeTemplateId
  expectedTargetJoinedAtUnixMs: number
}

interface InvalidPendingPlayerNotice {
  schemaVersion: 1
  phase: 'invalid-local-record'
}

type PendingPlayerNoticeLock = PendingPlayerNotice | InvalidPendingPlayerNotice

export function PlayerNoticeWorkspace({
  roster, capabilities, user, demo, evidenceCurrent = true, onRefresh
}: {
  roster: PlayerRoster
  capabilities: PlayerCapabilitiesProjection | null
  user: SessionUser
  demo: boolean
  evidenceCurrent?: boolean
  onRefresh: () => Promise<boolean>
}) {
  const players = roster.players ?? []
  const [sessionPlayerId, setSessionPlayerId] = useState(players[0]?.sessionPlayerId ?? '')
  const [templateId, setTemplateId] = useState<PlayerNoticeTemplateId>('maintenance-5m')
  const [plan, setPlan] = useState<PlayerNoticePlan | null>(null)
  const [receipt, setReceipt] = useState<PlayerNoticeReceipt | null>(null)
  const [pendingRequest, setPendingRequest] = useState<PendingPlayerNoticeLock | null>(() => readPendingNotice())
  const [busy, setBusy] = useState<'preview' | 'execute' | 'receipt' | 'refresh' | null>(null)
  const [error, setError] = useState('')
  const [executionLocked, setExecutionLocked] = useState(() => pendingRequest !== null)
  const executionGate = useRef(pendingRequest !== null)

  useEffect(() => {
    if (!players.some((player) => player.sessionPlayerId === sessionPlayerId)) {
      setSessionPlayerId(players[0]?.sessionPlayerId ?? '')
      setPlan(null)
      setReceipt(null)
      if (!executionGate.current) setExecutionLocked(false)
    }
  }, [players, sessionPlayerId])

  const noticeCapability = useMemo(
    () => capabilities?.capabilities.find((entry) => entry.capability === 'notice') ?? null,
    [capabilities]
  )
  const canModerate = user.role === 'administrator' && user.permissions.includes('players.moderate')
  const evidenceReady = !demo && evidenceCurrent && roster.authoritative && roster.state === 'active' && !roster.truncated &&
    players.length > 0 && /^roster-v1:[0-9a-f]{64}$/.test(roster.rosterGeneration) &&
    capabilities?.verificationScope === 'runtime-assembly-identity-verified' &&
    capabilities.actionsEnabled === true && noticeCapability?.availability === 'available'
  const selectedTemplate = noticeTemplates.find((template) => template.id === templateId)!
  const selectedPlayer = players.find((player) => player.sessionPlayerId === sessionPlayerId) ?? null
  const pendingIdentity = pendingRequest?.phase === 'invalid-local-record' ? null : pendingRequest
  const planCurrent = plan !== null && plan.rosterGeneration === roster.rosterGeneration &&
    roster.sequence === plan.rosterSequence && plan.sessionPlayerId === sessionPlayerId &&
    plan.templateId === templateId && selectedPlayer?.online === true &&
    Date.parse(selectedPlayer.joinedAt) === plan.targetJoinedAtUnixMs

  useEffect(() => {
    if (plan !== null && !planCurrent && !executionLocked) setPlan(null)
  }, [executionLocked, plan, planCurrent])

  function invalidatePreview() {
    setPlan(null)
    setReceipt(null)
    setError('')
  }

  async function preview() {
    if (!canModerate || !evidenceReady || !sessionPlayerId || executionGate.current || busy) return
    setBusy('preview')
    setError('')
    setReceipt(null)
    try {
      const result = await api.previewPlayerNotice({
        rosterGeneration: roster.rosterGeneration,
        rosterSequence: roster.sequence,
        sessionPlayerId,
        templateId
      })
      setPlan(result.data.plan)
    } catch (reason) {
      setPlan(null)
      setError(apiErrorMessage(reason, '玩家通知预演失败；没有发送任何消息。'))
    } finally {
      setBusy(null)
    }
  }

  async function execute() {
    if (!canModerate || !evidenceReady || !planCurrent || !plan?.allowed ||
        !plan.executionEnabled || plan.targetJoinedAtUnixMs === null ||
        executionLocked || executionGate.current || busy) return
    executionGate.current = true
    setExecutionLocked(true)
    setBusy('execute')
    setError('')
    const requestId = createUiRequestId()
    const pending: PendingPlayerNotice = {
      schemaVersion: 1,
      phase: 'awaiting-receipt',
      requestId,
      rosterGeneration: plan.rosterGeneration,
      rosterSequence: plan.rosterSequence,
      sessionPlayerId: plan.sessionPlayerId,
      templateId: plan.templateId,
      expectedTargetJoinedAtUnixMs: plan.targetJoinedAtUnixMs
    }
    if (!persistPendingNotice(pending)) {
      executionGate.current = false
      setExecutionLocked(false)
      setBusy(null)
      setError('浏览器无法持久保存请求身份；为避免重载后盲目重投，本次通知未发送。')
      return
    }
    setPendingRequest(pending)
    try {
      const result = await api.executePlayerNotice({
        rosterGeneration: plan.rosterGeneration,
        rosterSequence: plan.rosterSequence,
        sessionPlayerId: plan.sessionPlayerId,
        templateId: plan.templateId,
        requestId,
        confirmation: 'EXECUTE',
        expectedTargetJoinedAtUnixMs: plan.targetJoinedAtUnixMs
      })
      setReceipt(result.data.receipt)
      if (!result.data.receipt.recoveryRequired && result.data.receipt.state !== 'uncertain') {
        if (persistPendingNotice({ ...pending, phase: 'awaiting-evidence-refresh' })) {
          setPendingRequest({ ...pending, phase: 'awaiting-evidence-refresh' })
        } else {
          setError('已取得终态回执，但无法持久化证据刷新门闩；执行锁保持，只能继续查询原请求。')
        }
      }
    } catch (reason) {
      if (reason instanceof PlayerNoticeApiError && reason.data !== null) {
        setReceipt(reason.data.receipt)
        if (!reason.data.receipt.recoveryRequired && reason.data.receipt.state !== 'uncertain') {
          if (persistPendingNotice({ ...pending, phase: 'awaiting-evidence-refresh' })) {
            setPendingRequest({ ...pending, phase: 'awaiting-evidence-refresh' })
            setError(`${apiErrorMessage(reason, '玩家通知已进入终态')}；请刷新签名证据后新建通知。`)
          } else {
            setError('已取得终态回执，但无法持久化证据刷新门闩；执行锁保持，只能继续查询原请求。')
          }
        } else {
          setError(`${apiErrorMessage(reason, '玩家通知结果仍不确定')}；签名回执要求继续对账，执行锁保持。`)
        }
      } else {
        const detail = apiErrorMessage(reason, '执行响应不可确认')
        setError(`${detail}；请求 ${requestId.slice(0, 8)} 的结果未知并已持久锁定。只能查询原请求回执，禁止盲目重投。`)
      }
    } finally {
      setBusy(null)
    }
  }

  async function readPendingReceipt() {
    if (!canModerate || busy || pendingIdentity === null || pendingIdentity.phase !== 'awaiting-receipt') return
    setBusy('receipt')
    setError('')
    try {
      const result = await api.playerNoticeReceipt(pendingIdentity)
      setReceipt(result.data.receipt)
      if (result.data.receipt.recoveryRequired || result.data.receipt.state === 'uncertain') {
        setError('已找到签名回执，但结果仍为 uncertain；只能继续查询原请求，执行锁保持。')
      } else if (persistPendingNotice({ ...pendingIdentity, phase: 'awaiting-evidence-refresh' })) {
        setPendingRequest({ ...pendingIdentity, phase: 'awaiting-evidence-refresh' })
        setError('已找到原请求的签名终态回执；请刷新签名玩家证据后再创建新通知。')
      } else {
        setError('已找到终态回执，但无法持久化证据刷新门闩；执行锁保持。')
      }
    } catch (reason) {
      const notFound = reason instanceof ApiError && reason.status === 404
      setError(notFound
        ? `请求 ${pendingIdentity.requestId.slice(0, 8)} 暂无终态回执；执行锁保持，稍后只能再次查询此请求。`
        : `${apiErrorMessage(reason, '回执查询失败')}；执行锁保持，未发起任何新通知。`)
    } finally {
      setBusy(null)
    }
  }

  async function refreshAndReset() {
    if (!canModerate || busy) return
    if (pendingRequest?.phase !== 'awaiting-evidence-refresh') {
      setError(pendingRequest?.phase === 'invalid-local-record'
        ? '本地幂等记录损坏；无法证明原请求身份，禁止通过刷新解除锁。'
        : '原请求仍无终态回执；刷新玩家证据不能解除未知结果锁。')
      return
    }
    setBusy('refresh')
    setError('')
    try {
      const refreshed = await onRefresh()
      if (!refreshed) {
        setError('签名玩家证据刷新失败；旧证据不可用于解除执行锁。')
        return
      }
      if (!clearPendingNotice()) {
        setError('签名证据已刷新，但无法清除持久门闩；执行锁保持。')
        return
      }
      setPlan(null)
      setReceipt(null)
      setPendingRequest(null)
      executionGate.current = false
      setExecutionLocked(false)
    } catch (reason) {
      setError(apiErrorMessage(reason, '签名玩家证据刷新失败；执行锁保持。'))
    } finally {
      setBusy(null)
    }
  }

  const readiness = evidenceReady
    ? canModerate ? '可预演' : '只读角色'
    : demo ? '演示锁定' : noticeCapability?.availability !== 'available' ? '能力不可用' : '证据未就绪'

  return <section className={`player-notice-workspace ${evidenceReady && canModerate ? 'ready' : 'locked'}`}>
    <header>
      <div><Megaphone size={18} /><span><strong>定向系统通知</strong><small>固定 Bridge 模板 · 绑定当前签名会话 · 不接受任意文本</small></span></div>
      <b>{readiness}</b>
    </header>
    <div className="player-notice-grid">
      <label>目标玩家
        <select aria-label="通知目标玩家" value={sessionPlayerId}
          disabled={!evidenceReady || executionLocked || busy !== null}
          onChange={(event) => { setSessionPlayerId(event.target.value); invalidatePreview() }}>
          {players.map((player) => <option key={player.sessionPlayerId} value={player.sessionPlayerId}>
            {player.displayName} · {player.sessionPlayerId}
          </option>)}
        </select>
      </label>
      <label>固定模板
        <select aria-label="通知固定模板" value={templateId}
          disabled={!evidenceReady || executionLocked || busy !== null}
          onChange={(event) => { setTemplateId(event.target.value as PlayerNoticeTemplateId); invalidatePreview() }}>
          {noticeTemplates.map((template) => <option key={template.id} value={template.id}>{template.label}</option>)}
        </select>
      </label>
      <div className="player-notice-template"><span>实际发送内容</span><code>{selectedTemplate.message}</code></div>
      <button type="button" onClick={preview}
        disabled={!canModerate || !evidenceReady || executionLocked || busy !== null}>
        {busy === 'preview' ? <RefreshCw className="spin" size={15} /> : <ShieldAlert size={15} />}
        生成无写入预演
      </button>
    </div>

    {!evidenceReady && <div className="player-notice-warning"><TriangleAlert size={16} />
      <span>只有完整、实时且与签名能力合同一致的 Nebula 会话才能发送；当前保持 fail-closed。</span>
    </div>}
    {error && <div className="player-notice-error" role="alert"><TriangleAlert size={16} />{error}</div>}

    {plan && <div className={`player-notice-plan ${plan.allowed ? 'allowed' : 'blocked'}`}>
      <header><span><strong>DRY RUN · {plan.allowed ? '门禁通过' : '已阻断'}</strong><small>{plan.sessionPlayerId} · roster #{plan.rosterSequence}</small></span>
        <b>{plan.executionEnabled ? 'EXECUTION ENABLED' : 'EXECUTION DISABLED'}</b></header>
      <div className="player-notice-checks">{plan.checks.map((check) => <div key={check.id} className={check.status}>
        {check.status === 'pass' ? <Check size={14} /> : <TriangleAlert size={14} />}
        <span><strong>{check.id}</strong><small>{check.message}</small></span>
      </div>)}</div>
      <div className="player-notice-confirm">
        <div><ShieldAlert size={17} /><span><strong>一次性不可撤回操作</strong><small>{plan.rollback.summary}</small></span></div>
        <button type="button" className="confirm-execute" onClick={execute}
          disabled={!canModerate || !evidenceReady || !planCurrent || !plan.allowed ||
            !plan.executionEnabled || executionLocked || busy !== null}>
          {busy === 'execute' ? '正在等待 Bridge 回执…' : executionLocked ? '本次请求已锁定' : '确认发送固定通知'}
        </button>
      </div>
    </div>}

    {receipt && <div className={`player-notice-receipt ${receipt.state}`} role="status">
      <Check size={18} /><div><strong>{receipt.state === 'transport-dispatched' ? '已交给目标连接传输层' : `通知终止：${receipt.state}`}</strong>
        <small>请求 {receipt.requestId.slice(0, 8)} · {receipt.sessionPlayerId} · {receipt.errorCode}</small>
        <p>{receipt.rollback.summary}</p></div>
    </div>}
    {pendingRequest && <div className="player-notice-pending" role="status">
      <TriangleAlert size={17} /><div><strong>{pendingRequest.phase === 'invalid-local-record'
        ? 'LOCAL RECORD INVALID · 恢复锁'
        : pendingRequest.phase === 'awaiting-receipt'
          ? 'UNKNOWN OUTCOME · 原请求只读对账'
          : 'TERMINAL RECEIPT · 等待证据刷新'}</strong>
        {pendingIdentity && <small>{pendingIdentity.requestId.slice(0, 8)} · {pendingIdentity.sessionPlayerId} · {pendingIdentity.templateId}</small>}
        <p>{pendingRequest.phase === 'invalid-local-record'
          ? '本地记录存在但无法验证；为防止盲目重投，通知写操作保持锁定并需人工审计。'
          : pendingRequest.phase === 'awaiting-receipt'
            ? '此记录已保存在本浏览器；页面重载不会创建或重投请求。'
            : '终态已确认；页面重载后仍须成功刷新签名玩家证据才能新建通知。'}</p></div>
      {pendingRequest.phase === 'awaiting-receipt' && <button type="button" onClick={readPendingReceipt}
        disabled={!canModerate || busy !== null}>
        <RefreshCw className={busy === 'receipt' ? 'spin' : ''} size={15} />只读查询原请求回执
      </button>}
    </div>}
    {(executionLocked || receipt) && <button type="button" className="player-notice-reset" onClick={refreshAndReset}
      disabled={!canModerate || busy !== null || pendingRequest?.phase !== 'awaiting-evidence-refresh'}>
      <RefreshCw className={busy === 'refresh' ? 'spin' : ''} size={15} />刷新签名证据并新建通知
    </button>}
  </section>
}

function readPendingNotice(): PendingPlayerNoticeLock | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(pendingNoticeStorageKey)
    if (raw === null) return null
    const value = JSON.parse(raw) as unknown
    if (!isPendingNotice(value)) {
      return { schemaVersion: 1, phase: 'invalid-local-record' }
    }
    return value
  } catch {
    return { schemaVersion: 1, phase: 'invalid-local-record' }
  }
}

function persistPendingNotice(value: PendingPlayerNotice): boolean {
  try {
    window.localStorage.setItem(pendingNoticeStorageKey, JSON.stringify(value))
    return window.localStorage.getItem(pendingNoticeStorageKey) === JSON.stringify(value)
  } catch {
    return false
  }
}

function clearPendingNotice(): boolean {
  try {
    window.localStorage.removeItem(pendingNoticeStorageKey)
    return window.localStorage.getItem(pendingNoticeStorageKey) === null
  } catch {
    return false
  }
}

function isPendingNotice(value: unknown): value is PendingPlayerNotice {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort().join(',')
  return keys === 'expectedTargetJoinedAtUnixMs,phase,requestId,rosterGeneration,rosterSequence,schemaVersion,sessionPlayerId,templateId' &&
    record.schemaVersion === 1 &&
    (record.phase === 'awaiting-receipt' || record.phase === 'awaiting-evidence-refresh') &&
    typeof record.requestId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.requestId) &&
    typeof record.rosterGeneration === 'string' && /^roster-v1:[0-9a-f]{64}$/.test(record.rosterGeneration) &&
    Number.isSafeInteger(record.rosterSequence) && Number(record.rosterSequence) > 0 &&
    typeof record.sessionPlayerId === 'string' && /^player-[0-9]{6,12}$/.test(record.sessionPlayerId) &&
    typeof record.templateId === 'string' && noticeTemplates.some((template) => template.id === record.templateId) &&
    Number.isSafeInteger(record.expectedTargetJoinedAtUnixMs) && Number(record.expectedTargetJoinedAtUnixMs) > 0
}

function apiErrorMessage(reason: unknown, fallback: string): string {
  if (reason instanceof ApiError) return `${reason.message}${reason.code ? ` (${reason.code})` : ''}`
  if (reason instanceof Error && reason.message) return reason.message
  return fallback
}

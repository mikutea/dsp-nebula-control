import { useEffect, useRef, useState } from 'react'
import { parseCleanupRecoveryTarget, type CleanupRecoveryTarget, recoverableCleanupApi as api, type CleanupPlan, type CleanupReceipt } from './recoverable-cleanup-api'
import { createUiRequestId } from './request-id'
import './OperatorRollbackPanel.css'
type State = Awaited<ReturnType<typeof api.state>>
export function RecoverableCleanupPanel({ revision, canExecute }: { revision: string | null; canExecute: boolean }) {
  const [saved, setSaved] = useState<CleanupRecoveryTarget | null>(() => {
    try { return parseCleanupRecoveryTarget(JSON.parse(sessionStorage.getItem('dyson-cleanup-request') ?? 'null')) } catch { return null }
  })
  function remember(value: CleanupRecoveryTarget | null) {
    const parsed = value ? parseCleanupRecoveryTarget(value) : null
    setSaved(parsed)
    try { if (parsed) sessionStorage.setItem('dyson-cleanup-request', JSON.stringify(parsed)); else sessionStorage.removeItem('dyson-cleanup-request') } catch { /* memory copy remains usable */ }
  }
  const [state, setState] = useState<State | null>(null)
  const [plan, setPlan] = useState<CleanupPlan | null>(null)
  const [receipt, setReceipt] = useState<CleanupReceipt | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const active = useRef(false)
  useEffect(() => {
    let disposed = false
    void api.state().then(value => { if (!disposed) setState(value) }).catch(() => { if (!disposed) setError('无法读取清理状态，新操作保持关闭；可提交本页请求由服务端核验恢复。') })
    return () => { disposed = true }
  }, [])
  const pending = state?.transactions.filter(transaction => transaction.state === 'running') ?? []
  async function refresh() { try { setState(await api.state()) } catch { setState(null); throw new Error('无法读取清理状态，新操作保持关闭；可提交本页请求由服务端核验恢复。') } }
  async function run(action: () => Promise<void>) {
    if (active.current) return
    active.current = true; setBusy(true); setError('')
    try { await action() } catch (reason) { setError(reason instanceof Error ? reason.message : '清理请求未完成') }
    finally { active.current = false; setBusy(false) }
  }
  async function mutate(action: () => Promise<CleanupReceipt>, enabled: boolean, target: CleanupRecoveryTarget) {
    if (!canExecute || !confirmed || !enabled) return
    remember(target); setReceipt(null)
    try { setReceipt(await action()); setPlan(null); remember(null) }
    finally { setConfirmed(false); await refresh() }
  }
  const restored = new Set(state?.transactions.filter(t => t.direction === 'restore' && t.state === 'completed').map(t => t.sourceRequestId))
  return <section className="panel operator-rollback-panel" aria-label="可恢复清理">
    <header><h3>更新材料与历史清理</h3><button type="button" disabled={busy} onClick={() => void run(refresh)}>刷新清理状态</button></header>
    <p>将符合条件的旧材料移入隔离区，保留还原能力。隔离释放历史名额，不释放磁盘空间，也不会永久删除文件。</p>
    {error && <p role="alert">{error}</p>}
    <button type="button" disabled={busy || !state || pending.length > 0} onClick={() => void run(async () => {
      setPlan(null); setConfirmed(false); setReceipt(null); setPlan(await api.preview(createUiRequestId()))
    })}>预演可恢复清理</button>
    {plan && <div><p>计划隔离 {plan.candidates.length} 项材料。</p><ul>{plan.candidates.map(item =>
      <li key={item.kind + item.opaqueId}>{item.kind === 'history' ? '历史' : '发布材料'}：<code>{item.opaqueId}</code> · {item.sizeBytes} 字节</li>)}</ul>
      <button type="button" disabled={busy || !canExecute || !confirmed || !state?.executionEnabled || pending.length > 0 || plan.expectedRevision !== revision}
        onClick={() => void run(() => mutate(() => api.execute(plan), state?.executionEnabled === true, { requestId: plan.requestId, sourceRequestId: plan.requestId, expectedRevision: plan.expectedRevision, planSha256: plan.planSha256, direction: 'quarantine' }))}>确认隔离材料</button></div>}
    <label className="rollback-confirm"><input type="checkbox" checked={confirmed} disabled={busy || !canExecute}
      onChange={event => setConfirmed(event.target.checked)} />我已核对目标材料，确认执行所选隔离、还原或恢复操作。</label>
    {saved && !state?.transactions.some(t => t.requestId === saved.requestId) && <div>
      <p>本页保留的请求：<code>{saved.requestId}</code>。恢复将由服务端核验原计划。</p>
      <button type="button" disabled={busy || !canExecute || !confirmed || state?.recoveryEnabled === false || pending.length > 0}
        onClick={() => void run(() => mutate(() => api.recover(saved), state?.recoveryEnabled !== false, saved))}>恢复本页清理请求</button>
      <button type="button" disabled={busy} onClick={() => remember(null)}>清除本页请求引用</button>
      <p>清除引用不会取消或修改服务端事务。</p>
    </div>}
    {pending.map(transaction => <div key={transaction.requestId}><p>未完成事务：<code>{transaction.requestId}</code> · {transaction.completedCount}/{transaction.totalCount}</p>
      <button type="button" disabled={busy || !canExecute || !confirmed || !state?.recoveryEnabled || pending.length !== 1}
        onClick={() => void run(() => mutate(() => api.recover(transaction), state?.recoveryEnabled === true, transaction))}>继续清理事务</button></div>)}
    {state?.transactions.filter(t => t.direction === 'quarantine' && t.state === 'completed').map(transaction => <div key={transaction.requestId}>
      <p>隔离事务：<code>{transaction.requestId}</code>{restored.has(transaction.requestId) ? ' · 已还原' : ''}</p>
      <button type="button" disabled={busy} onClick={() => void run(async () => setReceipt(await api.receipt(transaction.requestId)))}>核对清理回执</button>
      <button type="button" disabled={busy || !canExecute || !confirmed || !state?.executionEnabled || pending.length > 0 || restored.has(transaction.requestId)}
        onClick={() => { const requestId = createUiRequestId(); void run(() => mutate(() => api.restore(requestId, transaction), state?.executionEnabled === true, { ...transaction, requestId, sourceRequestId: transaction.requestId, direction: 'restore' })) }}>还原隔离材料</button>
    </div>)}
    {receipt && <p role="status">事务已完成，持久回执已核对：<code>{receipt.requestId}</code></p>}
    {busy && <p role="status">正在处理；关闭页面不会取消服务端事务。</p>}
    {!canExecute && <p>当前角色仅可预演和核对回执。</p>}
  </section>
}

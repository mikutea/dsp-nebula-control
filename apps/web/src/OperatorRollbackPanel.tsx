import { useEffect, useRef, useState } from 'react'
import { parseRequest, operatorRollbackApi, type RollbackPlan, type RollbackReceipt, type RollbackRequest, type RollbackState } from './operator-rollback-api'
import { createUiRequestId } from './request-id'
import './OperatorRollbackPanel.css'

export function OperatorRollbackPanel({ revision, sourceRequestId, canExecute }: {
  revision: string | null; sourceRequestId?: string; canExecute: boolean
}) {
  const [savedRequest, setSavedRequest] = useState<RollbackRequest | null>(() => {
    try { return parseRequest(JSON.parse(sessionStorage.getItem('dyson-operator-rollback-request') ?? 'null')) }
    catch { return null }
  })
  const [source, setSource] = useState('')
  const [state, setState] = useState<RollbackState | null>(null)
  const [plan, setPlan] = useState<RollbackPlan | null>(null)
  const [receipt, setReceipt] = useState<RollbackReceipt | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const [lookupId, setLookupId] = useState(() => { try { return sessionStorage.getItem('dyson-operator-rollback-id') ?? '' } catch { return '' } })
  useEffect(() => {
    const controller = new AbortController()
    operatorRollbackApi.state(controller.signal).then(setState).catch(() => {
      if (!controller.signal.aborted) { setState(null); setError('无法读取回退状态，新回退保持锁定；已保存请求可提交服务端核验恢复。') }
    })
    return () => controller.abort()
  }, [])
  async function refresh() {
    try { setState(await operatorRollbackApi.state()) }
    catch { setState(null); setError('无法读取回退状态，新回退保持锁定；已保存请求可提交服务端核验恢复。') }
  }
  async function run(action: () => Promise<void>) {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setError('')
    try { await action() } catch (reason) { setError(reason instanceof Error ? reason.message : '回退请求未完成') }
    finally { inFlight.current = false; setBusy(false) }
  }
  function changeSource(value: string) { setSource(value); setPlan(null); setConfirmed(false); setReceipt(null) }
  async function preview() {
    if (!revision) return
    setPlan(null); setConfirmed(false); setReceipt(null)
    setPlan(await operatorRollbackApi.preview({ requestId: createUiRequestId(), sourceRequestId: source.trim().toLowerCase(), expectedRevision: revision }))
  }
  async function submit(request: RollbackRequest, recovery: boolean) {
    if (!canExecute || !confirmed) return
    setReceipt(null)
    setLookupId(request.requestId)
    setSavedRequest(request)
    try { sessionStorage.setItem('dyson-operator-rollback-request', JSON.stringify(request)) } catch { /* memory copy remains available */ }
    try { sessionStorage.setItem('dyson-operator-rollback-id', request.requestId) } catch { /* optional UI convenience */ }
    try {
      setReceipt(await operatorRollbackApi.submit(request, recovery)); setPlan(null); setConfirmed(false)
      setSavedRequest(null)
      try { sessionStorage.removeItem('dyson-operator-rollback-request') } catch { /* stale request is still checked by the server */ }
    } finally { await refresh() }
  }
  const pending = state?.pending ?? []
  const executable = canExecute && state?.executionEnabled === true && pending.length === 0 &&
    plan !== null && plan.expectedRevision === revision && confirmed && !busy
  return <section className="panel operator-rollback-panel" aria-label="组件回退">
    <header><h3>回退已完成的更新</h3><button type="button" disabled={busy} onClick={() => void run(refresh)}>刷新回退状态</button></header>
    <p>恢复该次更新前的组件、配置与存档。执行前会先保护当前状态；需要先完成优雅停服。</p>
    {error && <p role="alert">{error}</p>}
    <label className="config-field"><span>成功更新请求 ID</span><input aria-label="回退源更新请求 ID" value={source} maxLength={36}
      disabled={busy || pending.length > 0} onChange={event => changeSource(event.target.value)} /></label>
    <div className="rollback-actions">
      {sourceRequestId && <button type="button" disabled={busy || pending.length > 0} onClick={() => changeSource(sourceRequestId)}>使用本次成功更新</button>}
      <button type="button" disabled={busy || !revision || !state || pending.length > 0 || !/^[0-9a-f-]{36}$/i.test(source.trim())}
        onClick={() => void run(preview)}>预演回退</button>
    </div>
    {plan && <p>目标：{plan.component} {plan.targetVersion}。恢复 {plan.restoreFileCount} 个文件，移除 {plan.removeFileCount} 个本次新增文件。配置与存档也将恢复到更新前。</p>}
    {plan && plan.expectedRevision !== revision && <p role="alert">组件状态已变化，请重新预演。</p>}
    {(plan || savedRequest || pending.length > 0) && <label className="rollback-confirm"><input type="checkbox" checked={confirmed} disabled={busy || !canExecute}
      onChange={event => setConfirmed(event.target.checked)} />我确认恢复原组件、配置和存档，并已安排停服。</label>}
    {plan && <button type="button" disabled={!executable} onClick={() => void run(() => submit({ requestId: plan.requestId,
      sourceRequestId: plan.sourceRequestId, expectedRevision: plan.expectedRevision, expectedPlanSha256: plan.planSha256 }, false))}>确认回退</button>}
    {savedRequest && !pending.some(entry => entry.request.requestId === savedRequest.requestId) && <div className="rollback-pending">
      <p>本页保留的回退请求：<code>{savedRequest.requestId}</code>。若提交中断，可请求服务端核验并恢复。</p>
      <button type="button" disabled={busy || !canExecute || !confirmed || state?.recoveryEnabled === false || pending.length > 0}
        onClick={() => void run(() => submit(savedRequest, true))}>恢复本页保存的回退请求</button>
    </div>}
    {pending.map(entry => <div key={entry.request.requestId} className="rollback-pending">
      <p>未完成回退：<code>{entry.request.requestId}</code>。继续执行原请求，不会新建另一笔回退。</p>
      <button type="button" disabled={busy || !canExecute || !confirmed || !state?.recoveryEnabled || pending.length !== 1}
        onClick={() => void run(() => submit(entry.request, true))}>继续未完成回退</button>
    </div>)}
    <label className="config-field"><span>回退请求 ID</span><input aria-label="回退回执请求 ID" value={lookupId} maxLength={36}
      disabled={busy} onChange={event => setLookupId(event.target.value)} /></label>
    <button type="button" disabled={busy || !/^[0-9a-f-]{36}$/i.test(lookupId.trim())}
      onClick={() => void run(async () => setReceipt(await operatorRollbackApi.receipt(lookupId.trim().toLowerCase())))}>核对回退回执</button>
    {busy && <p role="status">正在处理；服务端事务不会因关闭页面自动取消。</p>}
    {receipt && <p role="status">回退已完成，持久回执已核对。请求：<code>{receipt.requestId}</code></p>}
    {!canExecute && <p>当前角色仅可预演和查看回执。</p>}
  </section>
}

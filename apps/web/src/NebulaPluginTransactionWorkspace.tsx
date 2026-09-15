import { useRef, useState } from 'react'
import {
  Check, History, LockKeyhole, PackageCheck, RefreshCw, ShieldCheck,
  TriangleAlert, Undo2
} from 'lucide-react'
import type { SessionUser } from './model'
import { createUiRequestId } from './request-id'
import {
  nebulaPluginApplyConfirmation,
  nebulaPluginTransactionApi,
  type NebulaPluginApplyPreviewResult,
  type NebulaPluginApplyResult,
  type NebulaPluginPlanRequest,
  type NebulaPluginPlanResult,
  type NebulaPluginRollbackMutationRequest,
  type NebulaPluginRollbackPreviewResult,
  type NebulaPluginRollbackResult,
  type NebulaPluginVerifyApplyResult,
  type NebulaPluginVerifyRollbackResult
} from './nebula-plugin-transaction-api'

type BusyOperation =
  | 'plan'
  | 'apply'
  | 'recover-apply'
  | 'verify-apply'
  | 'preview-rollback'
  | 'rollback'
  | 'recover-rollback'
  | 'verify-rollback'
  | null

interface PlanDraft {
  requestId: string
  currentPluginsTreeSha256: string
  maintenanceWindowStartUtc: string
  maintenanceWindowEndUtc: string
}

interface RollbackDraft {
  rollbackRequestId: string
  maintenanceWindowStartUtc: string
  maintenanceWindowEndUtc: string
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const sha256Pattern = /^[0-9a-f]{64}$/u
const utcPattern = /(?:Z|\+00:00)$/u

export function NebulaPluginTransactionWorkspace({ demo, user }: {
  demo: boolean
  user: SessionUser
}) {
  const [draft, setDraft] = useState<PlanDraft>(emptyPlanDraft)
  const [plan, setPlan] = useState<NebulaPluginPlanResult | null>(null)
  const [applyPreview, setApplyPreview] = useState<NebulaPluginApplyPreviewResult | null>(null)
  const [applyConfirmation, setApplyConfirmation] = useState('')
  const [applyResult, setApplyResult] = useState<NebulaPluginApplyResult | null>(null)
  const [applyVerification, setApplyVerification] = useState<NebulaPluginVerifyApplyResult | null>(null)
  const [rollbackDraft, setRollbackDraft] = useState<RollbackDraft>(emptyRollbackDraft)
  const [rollbackPreview, setRollbackPreview] = useState<NebulaPluginRollbackPreviewResult | null>(null)
  const [rollbackConfirmation, setRollbackConfirmation] = useState('')
  const [rollbackResult, setRollbackResult] = useState<NebulaPluginRollbackResult | null>(null)
  const [rollbackVerification, setRollbackVerification] =
    useState<NebulaPluginVerifyRollbackResult | null>(null)
  const [busy, setBusy] = useState<BusyOperation>(null)
  const [error, setError] = useState('')
  const [ordinaryGateClosed, setOrdinaryGateClosed] = useState(false)
  const [recoveryGateClosed, setRecoveryGateClosed] = useState(false)
  const sequence = useRef(0)
  const readAbort = useRef<AbortController | null>(null)

  const canRead = user.permissions.includes('updates.read')
  const canActivate = user.permissions.includes('updates.activate')
  const canRecover = canActivate && user.role === 'administrator'
  const normalizedDraft = normalizePlanDraft(draft)
  const planError = validatePlanDraft(normalizedDraft)
  const applyBindingReady = plan !== null && applyPreview !== null &&
    plan.requestId === normalizedDraft.requestId && applyPreview.requestId === plan.requestId &&
    plan.planDigest === applyPreview.planDigest && plan.targetRole === 'Server' &&
    applyPreview.targetRole === 'Server'
  const requiredApplyConfirmation = plan
    ? nebulaPluginApplyConfirmation(plan.requestId, plan.planDigest)
    : ''
  const applyVerified = applyVerification !== null &&
    (applyResult === null || verificationMatchesApply(applyResult, applyVerification))
  const rollbackInput = buildRollbackInput(rollbackDraft, applyVerification)
  const rollbackInputError = validateRollbackInput(rollbackInput)
  const rollbackBindingReady = rollbackInput !== null && rollbackPreview !== null &&
    rollbackPreview.originalRequestId === rollbackInput.originalRequestId &&
    rollbackPreview.rollbackRequestId === rollbackInput.rollbackRequestId &&
    rollbackPreview.exactConfirmationPhrase === rollbackConfirmationPhrase(
      rollbackPreview.rollbackRequestId,
      rollbackPreview.previewDigest
    )
  const rollbackVerified = rollbackVerification !== null &&
    (rollbackResult === null || verificationMatchesRollback(rollbackResult, rollbackVerification))

  function updatePlanDraft(field: keyof PlanDraft, value: string): void {
    setDraft((current) => ({ ...current, [field]: value }))
    invalidatePlanAndAfter()
  }

  function invalidatePlanAndAfter(): void {
    readAbort.current?.abort()
    sequence.current += 1
    setPlan(null)
    setApplyPreview(null)
    setApplyConfirmation('')
    setApplyResult(null)
    setApplyVerification(null)
    resetRollback()
    setError('')
  }

  function resetRollback(): void {
    setRollbackDraft(emptyRollbackDraft())
    setRollbackPreview(null)
    setRollbackConfirmation('')
    setRollbackResult(null)
    setRollbackVerification(null)
  }

  async function preparePlan(): Promise<void> {
    if (!canRead || demo || busy !== null || planError !== null) return
    const controller = replaceReadController()
    const operation = ++sequence.current
    setBusy('plan')
    setError('')
    setPlan(null)
    setApplyPreview(null)
    setApplyConfirmation('')
    setApplyResult(null)
    setApplyVerification(null)
    resetRollback()
    try {
      const planned = await nebulaPluginTransactionApi.plan(normalizedDraft, controller.signal)
      if (!isCurrent(operation, controller)) return
      const previewed = await nebulaPluginTransactionApi.previewApply(
        normalizedDraft.requestId,
        controller.signal
      )
      if (!isCurrent(operation, controller)) return
      if (!planAndPreviewMatch(normalizedDraft, planned.data, previewed.data)) {
        throw new Error('Nebula 计划与 apply dry-run 的身份或摘要不一致；执行保持锁定。')
      }
      setPlan(planned.data)
      setApplyPreview(previewed.data)
    } catch (reason) {
      if (isCurrent(operation, controller)) setError(errorText(reason, 'Nebula dry-run 失败。'))
    } finally {
      if (operation === sequence.current) setBusy(null)
    }
  }

  async function executeApply(recovery: boolean): Promise<void> {
    if (!applyBindingReady || demo || busy !== null || applyConfirmation !== requiredApplyConfirmation ||
        (recovery ? !canRecover || recoveryGateClosed : !canActivate || ordinaryGateClosed)) return
    const operation = ++sequence.current
    setBusy(recovery ? 'recover-apply' : 'apply')
    setError('')
    setApplyResult(null)
    setApplyVerification(null)
    try {
      const input = {
        requestId: plan!.requestId,
        planDigest: plan!.planDigest,
        confirmationPhrase: applyConfirmation
      }
      const result = recovery
        ? await nebulaPluginTransactionApi.recoverApply(input)
        : await nebulaPluginTransactionApi.apply(input)
      if (operation !== sequence.current) return
      if (result.data.requestId !== input.requestId) {
        throw new Error('Nebula apply 回执 request ID 不一致；终态未证明。')
      }
      setApplyResult(result.data)
      await verifyApplyResult(operation, result.data)
    } catch (reason) {
      if (operation === sequence.current) {
        closeGateFromError(reason, recovery)
        setError(errorText(reason, 'Nebula apply 没有得到可验证终态。'))
      }
    } finally {
      if (operation === sequence.current) setBusy(null)
    }
  }

  async function verifyApply(): Promise<void> {
    const requestId = normalizedDraft.requestId
    if (!canRead || demo || busy !== null || !uuidPattern.test(requestId)) return
    const operation = ++sequence.current
    setBusy('verify-apply')
    setError('')
    setApplyVerification(null)
    try {
      const verification = await nebulaPluginTransactionApi.verifyApply(requestId)
      if (operation !== sequence.current) return
      if (verification.data.requestId !== requestId || verification.data.targetRole !== 'Server' ||
          (applyResult !== null && !verificationMatchesApply(applyResult, verification.data))) {
        throw new Error('Nebula apply 持久核验与当前事务不一致。')
      }
      setApplyVerification(verification.data)
    } catch (reason) {
      if (operation === sequence.current) setError(errorText(reason, 'Nebula apply 持久核验失败。'))
    } finally {
      if (operation === sequence.current) setBusy(null)
    }
  }

  async function verifyApplyResult(operation: number, result: NebulaPluginApplyResult): Promise<void> {
    const verification = await nebulaPluginTransactionApi.verifyApply(result.requestId)
    if (operation !== sequence.current) return
    if (!verificationMatchesApply(result, verification.data) || verification.data.targetRole !== 'Server') {
      throw new Error('Nebula apply 已返回结果，但持久内容/ACL/rollback 核验不一致。')
    }
    setApplyVerification(verification.data)
  }

  async function previewRollback(): Promise<void> {
    if (!canRead || demo || busy !== null || rollbackInput === null || rollbackInputError !== null ||
        applyVerification?.transactionStatus !== 'applied') return
    const controller = replaceReadController()
    const operation = ++sequence.current
    setBusy('preview-rollback')
    setError('')
    setRollbackPreview(null)
    setRollbackResult(null)
    setRollbackVerification(null)
    try {
      const result = await nebulaPluginTransactionApi.previewRollback(rollbackInput, controller.signal)
      if (!isCurrent(operation, controller)) return
      if (!rollbackPreviewMatchesInput(result.data, rollbackInput)) {
        throw new Error('Nebula rollback dry-run 与 apply 回执绑定不一致。')
      }
      setRollbackPreview(result.data)
    } catch (reason) {
      if (isCurrent(operation, controller)) setError(errorText(reason, 'Nebula rollback dry-run 失败。'))
    } finally {
      if (operation === sequence.current) setBusy(null)
    }
  }

  async function executeRollback(recovery: boolean): Promise<void> {
    if (!rollbackBindingReady || rollbackInput === null || rollbackPreview === null || demo ||
        busy !== null || rollbackConfirmation !== rollbackPreview.exactConfirmationPhrase ||
        (recovery ? !canRecover || recoveryGateClosed : !canActivate || ordinaryGateClosed)) return
    const operation = ++sequence.current
    setBusy(recovery ? 'recover-rollback' : 'rollback')
    setError('')
    setRollbackResult(null)
    setRollbackVerification(null)
    const input: NebulaPluginRollbackMutationRequest = {
      ...rollbackInput,
      previewDigest: rollbackPreview.previewDigest,
      confirmationPhrase: rollbackConfirmation
    }
    try {
      const result = recovery
        ? await nebulaPluginTransactionApi.recoverRollback(input)
        : await nebulaPluginTransactionApi.rollback(input)
      if (operation !== sequence.current) return
      if (!rollbackResultMatchesInput(result.data, input)) {
        throw new Error('Nebula rollback 回执与预演绑定不一致；终态未证明。')
      }
      setRollbackResult(result.data)
      await verifyRollbackResult(operation, result.data)
    } catch (reason) {
      if (operation === sequence.current) {
        closeGateFromError(reason, recovery)
        setError(errorText(reason, 'Nebula rollback 没有得到可验证终态。'))
      }
    } finally {
      if (operation === sequence.current) setBusy(null)
    }
  }

  async function verifyRollback(): Promise<void> {
    if (!canRead || demo || busy !== null || rollbackInput === null || rollbackInputError !== null) return
    const operation = ++sequence.current
    setBusy('verify-rollback')
    setError('')
    setRollbackVerification(null)
    try {
      const verification = await nebulaPluginTransactionApi.verifyRollback(
        rollbackInput.originalRequestId,
        rollbackInput.rollbackRequestId
      )
      if (operation !== sequence.current) return
      if (rollbackResult !== null && !verificationMatchesRollback(rollbackResult, verification.data)) {
        throw new Error('Nebula rollback 持久核验与当前事务不一致。')
      }
      if (verification.data.originalRequestId !== rollbackInput.originalRequestId ||
          verification.data.rollbackRequestId !== rollbackInput.rollbackRequestId) {
        throw new Error('Nebula rollback 持久核验 request ID 不一致。')
      }
      setRollbackVerification(verification.data)
    } catch (reason) {
      if (operation === sequence.current) setError(errorText(reason, 'Nebula rollback 持久核验失败。'))
    } finally {
      if (operation === sequence.current) setBusy(null)
    }
  }

  async function verifyRollbackResult(operation: number, result: NebulaPluginRollbackResult): Promise<void> {
    const verification = await nebulaPluginTransactionApi.verifyRollback(
      result.originalRequestId,
      result.rollbackRequestId
    )
    if (operation !== sequence.current) return
    if (!verificationMatchesRollback(result, verification.data)) {
      throw new Error('Nebula rollback 已返回结果，但持久内容/ACL/rollback 核验不一致。')
    }
    setRollbackVerification(verification.data)
  }

  function replaceReadController(): AbortController {
    readAbort.current?.abort()
    const controller = new AbortController()
    readAbort.current = controller
    return controller
  }

  function isCurrent(operation: number, controller: AbortController): boolean {
    return operation === sequence.current && !controller.signal.aborted
  }

  function closeGateFromError(reason: unknown, recovery: boolean): void {
    if (!isCode(reason, recovery
      ? 'NEBULA_PLUGIN_TRANSACTION_RECOVERY_DISABLED'
      : 'NEBULA_PLUGIN_TRANSACTION_MUTATION_DISABLED')) return
    if (recovery) setRecoveryGateClosed(true)
    else setOrdinaryGateClosed(true)
  }

  if (!canRead) {
    return <section className="nebula-transaction-workspace unavailable">
      <LockKeyhole size={24} />
      <div><strong>没有 Nebula 事务读取权限</strong><small>该工作区至少需要 updates.read。</small></div>
    </section>
  }

  return <section className="nebula-transaction-workspace" aria-label="Nebula 整树事务">
    <header className="nebula-transaction-header">
      <div><PackageCheck size={18} /><span><strong>Nebula qualified whole-tree transaction</strong><small>只消费已离线资格化 candidate；浏览器不构建二进制、不选择路径、不运行命令</small></span></div>
      <b>{demo ? 'DEMO FAIL-CLOSED' : ordinaryGateClosed ? 'MUTATION CLOSED' : 'SERVER ENFORCED'}</b>
    </header>

    {demo ? <div className="nebula-transaction-notice"><LockKeyhole size={17} /><span><strong>演示环境不调用事务接口</strong><small>这里不生成虚构 plan、回执或成功状态。</small></span></div> : null}
    {error ? <div className="nebula-transaction-error" role="alert"><TriangleAlert size={17} /><span>{error}</span></div> : null}

    <div className="nebula-transaction-form">
      <label><span>QUALIFIED CANDIDATE REQUEST UUID</span><input aria-label="Nebula 资格化候选 request ID" value={draft.requestId}
        disabled={busy !== null} onChange={(event) => updatePlanDraft('requestId', event.target.value.slice(0, 36))}
        placeholder="已有资格化 job UUID" autoComplete="off" spellCheck={false} /></label>
      <label><span>CURRENT PLUGINS TREE SHA-256</span><input aria-label="Nebula 当前插件树 SHA-256" value={draft.currentPluginsTreeSha256}
        disabled={busy !== null} onChange={(event) => updatePlanDraft('currentPluginsTreeSha256', event.target.value.slice(0, 64))}
        placeholder="64 位小写 SHA-256" autoComplete="off" spellCheck={false} /></label>
      <label><span>WINDOW START UTC</span><input aria-label="Nebula 维护窗口开始 UTC" value={draft.maintenanceWindowStartUtc}
        disabled={busy !== null} onChange={(event) => updatePlanDraft('maintenanceWindowStartUtc', event.target.value.slice(0, 64))}
        placeholder="2030-01-01T00:00:00Z" autoComplete="off" spellCheck={false} /></label>
      <label><span>WINDOW END UTC</span><input aria-label="Nebula 维护窗口结束 UTC" value={draft.maintenanceWindowEndUtc}
        disabled={busy !== null} onChange={(event) => updatePlanDraft('maintenanceWindowEndUtc', event.target.value.slice(0, 64))}
        placeholder="2030-01-01T01:00:00Z" autoComplete="off" spellCheck={false} /></label>
      <button type="button" onClick={() => void preparePlan()}
        disabled={demo || busy !== null || planError !== null}>
        <PackageCheck size={14} />{busy === 'plan' ? '计划与预演中…' : '生成 plan + apply dry-run'}
      </button>
    </div>
    <div className="nebula-transaction-prerequisite">
      <ShieldCheck size={15} /><span><strong>{planError ?? '输入合同有效；服务端仍会重新核验候选、目标树、停止态与窗口。'}</strong><small>request UUID 必须对应固定 JobBase 中已经资格化的 candidate manifest。</small></span>
    </div>

    <div className="nebula-transaction-ledger">
      <article><span>PLAN</span><strong>{plan ? 'DRY-RUN VERIFIED' : 'PENDING'}</strong><code>{plan?.planDigest ?? '—'}</code></article>
      <article><span>APPLY</span><strong>{applyVerified ? 'VERIFIED' : applyResult ? 'UNVERIFIED' : 'NOT RUN'}</strong><code>{applyVerification?.receiptDigest ?? applyResult?.receiptDigest ?? '—'}</code></article>
      <article><span>ROLLBACK</span><strong>{rollbackVerified ? 'VERIFIED' : rollbackResult ? 'UNVERIFIED' : 'NOT RUN'}</strong><code>{rollbackVerification?.receiptDigest ?? rollbackResult?.receiptDigest ?? '—'}</code></article>
      <article><span>PROOF</span><strong>{applyVerification || rollbackVerification ? 'CONTENT + ACL EXACT' : 'AWAITING VERIFY'}</strong><small>保留 rollback material</small></article>
    </div>

    {applyBindingReady ? <div className="nebula-transaction-action">
      <div><TriangleAlert size={18} /><span><strong>Apply 必须使用 digest-bound 精确确认</strong><small><code>{requiredApplyConfirmation}</code></small></span></div>
      <input aria-label="Nebula apply 精确确认" value={applyConfirmation} disabled={busy !== null || demo}
        onChange={(event) => setApplyConfirmation(event.target.value)} placeholder={requiredApplyConfirmation} autoComplete="off" />
      <button type="button" onClick={() => void executeApply(false)}
        disabled={!canActivate || demo || busy !== null || ordinaryGateClosed || applyConfirmation !== requiredApplyConfirmation}>
        {busy === 'apply' ? 'Apply + verify 中…' : !canActivate ? '需要 Administrator' : '执行 apply 并核验'}
      </button>
      {canRecover ? <button type="button" className="recovery" onClick={() => void executeApply(true)}
        disabled={demo || busy !== null || recoveryGateClosed || applyConfirmation !== requiredApplyConfirmation}>
        {busy === 'recover-apply' ? '恢复中…' : '显式恢复 apply'}
      </button> : null}
    </div> : null}

    <div className="nebula-transaction-verify">
      <div><History size={16} /><span><strong>持久 apply 核验</strong><small>网络中断后可按 candidate request UUID 重新证明终态。</small></span></div>
      <button type="button" onClick={() => void verifyApply()} disabled={demo || busy !== null || !uuidPattern.test(normalizedDraft.requestId)}>
        <RefreshCw size={13} />{busy === 'verify-apply' ? '核验中…' : '核验 apply'}
      </button>
      {applyVerification ? <code>{applyVerification.transactionStatus} · {applyVerification.receiptDigest}</code> : null}
    </div>

    {applyVerification?.transactionStatus === 'applied' ? <div className="nebula-rollback-panel">
      <header><Undo2 size={17} /><span><strong>事务化手动 rollback</strong><small>只从 verified apply receipt 绑定 original receipt digest。</small></span></header>
      <div className="nebula-rollback-form">
        <label><span>ROLLBACK REQUEST UUID</span><input aria-label="Nebula rollback request ID" value={rollbackDraft.rollbackRequestId}
          disabled={busy !== null} onChange={(event) => {
            setRollbackDraft((current) => ({ ...current, rollbackRequestId: event.target.value.slice(0, 36) }))
            setRollbackPreview(null); setRollbackConfirmation(''); setRollbackResult(null); setRollbackVerification(null)
          }} autoComplete="off" spellCheck={false} /></label>
        <label><span>WINDOW START UTC</span><input aria-label="Nebula rollback 窗口开始 UTC" value={rollbackDraft.maintenanceWindowStartUtc}
          disabled={busy !== null} onChange={(event) => {
            setRollbackDraft((current) => ({ ...current, maintenanceWindowStartUtc: event.target.value.slice(0, 64) }))
            setRollbackPreview(null); setRollbackConfirmation(''); setRollbackResult(null); setRollbackVerification(null)
          }} placeholder="2030-01-01T02:00:00Z" autoComplete="off" /></label>
        <label><span>WINDOW END UTC</span><input aria-label="Nebula rollback 窗口结束 UTC" value={rollbackDraft.maintenanceWindowEndUtc}
          disabled={busy !== null} onChange={(event) => {
            setRollbackDraft((current) => ({ ...current, maintenanceWindowEndUtc: event.target.value.slice(0, 64) }))
            setRollbackPreview(null); setRollbackConfirmation(''); setRollbackResult(null); setRollbackVerification(null)
          }} placeholder="2030-01-01T03:00:00Z" autoComplete="off" /></label>
        <button type="button" onClick={() => {
          setRollbackDraft((current) => ({ ...current, rollbackRequestId: createUiRequestId() }))
          setRollbackPreview(null); setRollbackConfirmation(''); setRollbackResult(null); setRollbackVerification(null)
        }} disabled={busy !== null}><RefreshCw size={13} />新建 rollback UUID</button>
        <button type="button" onClick={() => void previewRollback()}
          disabled={demo || busy !== null || rollbackInputError !== null}><PackageCheck size={13} />{busy === 'preview-rollback' ? '预演中…' : '生成 rollback dry-run'}</button>
      </div>
      {rollbackPreview ? <div className="nebula-transaction-action rollback">
        <div><Undo2 size={18} /><span><strong>Rollback 精确确认</strong><small><code>{rollbackPreview.exactConfirmationPhrase}</code></small></span></div>
        <input aria-label="Nebula rollback 精确确认" value={rollbackConfirmation} disabled={busy !== null || demo}
          onChange={(event) => setRollbackConfirmation(event.target.value)} placeholder={rollbackPreview.exactConfirmationPhrase} autoComplete="off" />
        <button type="button" onClick={() => void executeRollback(false)}
          disabled={!canActivate || demo || busy !== null || ordinaryGateClosed || rollbackConfirmation !== rollbackPreview.exactConfirmationPhrase}>
          {busy === 'rollback' ? 'Rollback + verify 中…' : '执行 rollback 并核验'}
        </button>
        {canRecover ? <button type="button" className="recovery" onClick={() => void executeRollback(true)}
          disabled={demo || busy !== null || recoveryGateClosed || rollbackConfirmation !== rollbackPreview.exactConfirmationPhrase}>
          {busy === 'recover-rollback' ? '恢复中…' : '显式恢复 rollback'}
        </button> : null}
      </div> : <div className="nebula-transaction-prerequisite"><ShieldCheck size={15} /><span><strong>{rollbackInputError ?? 'Rollback 输入已绑定 verified apply receipt。'}</strong><small>预演不会修改生产树。</small></span></div>}
      <div className="nebula-transaction-verify">
        <div>{rollbackVerified ? <Check size={16} /> : <History size={16} />}<span><strong>持久 rollback 核验</strong><small>只有 verify 匹配后才显示完成。</small></span></div>
        <button type="button" onClick={() => void verifyRollback()} disabled={demo || busy !== null || rollbackInputError !== null}>
          <RefreshCw size={13} />{busy === 'verify-rollback' ? '核验中…' : '核验 rollback'}
        </button>
        {rollbackVerification ? <code>{rollbackVerification.transactionStatus} · {rollbackVerification.receiptDigest}</code> : null}
      </div>
    </div> : null}

    <footer className="nebula-transaction-footer"><LockKeyhole size={14} />Recovery 永不自动触发；服务端无 recovery-status 路由，不匹配或无需恢复时必须由后端拒绝。</footer>
  </section>
}

function emptyPlanDraft(): PlanDraft {
  return {
    requestId: '',
    currentPluginsTreeSha256: '',
    maintenanceWindowStartUtc: '',
    maintenanceWindowEndUtc: ''
  }
}

function emptyRollbackDraft(): RollbackDraft {
  return {
    rollbackRequestId: createUiRequestId(),
    maintenanceWindowStartUtc: '',
    maintenanceWindowEndUtc: ''
  }
}

function normalizePlanDraft(draft: PlanDraft): NebulaPluginPlanRequest {
  return {
    requestId: draft.requestId.trim().toLowerCase(),
    currentPluginsTreeSha256: draft.currentPluginsTreeSha256.trim().toLowerCase(),
    maintenanceWindowStartUtc: draft.maintenanceWindowStartUtc.trim(),
    maintenanceWindowEndUtc: draft.maintenanceWindowEndUtc.trim()
  }
}

function validatePlanDraft(draft: NebulaPluginPlanRequest): string | null {
  if (!uuidPattern.test(draft.requestId)) return '请输入已有资格化 candidate 的小写 UUID。'
  if (!sha256Pattern.test(draft.currentPluginsTreeSha256)) return '请输入 64 位小写 plugin-tree SHA-256。'
  return validateWindow(draft.maintenanceWindowStartUtc, draft.maintenanceWindowEndUtc)
}

function validateWindow(startText: string, endText: string): string | null {
  const start = Date.parse(startText)
  const end = Date.parse(endText)
  if (!utcPattern.test(startText) || !utcPattern.test(endText) || !Number.isFinite(start) || !Number.isFinite(end)) {
    return '维护窗口必须使用 UTC ISO 时间。'
  }
  if (start >= end) return '维护窗口结束时间必须晚于开始时间。'
  if (end - start > 8 * 60 * 60 * 1_000) return '维护窗口最长为 8 小时。'
  return null
}

function buildRollbackInput(
  draft: RollbackDraft,
  verification: NebulaPluginVerifyApplyResult | null
) {
  if (verification === null) return null
  return {
    originalRequestId: verification.requestId,
    rollbackRequestId: draft.rollbackRequestId.trim().toLowerCase(),
    originalReceiptSha256: verification.receiptDigest,
    maintenanceWindowStartUtc: draft.maintenanceWindowStartUtc.trim(),
    maintenanceWindowEndUtc: draft.maintenanceWindowEndUtc.trim()
  }
}

function validateRollbackInput(input: ReturnType<typeof buildRollbackInput>): string | null {
  if (input === null) return '必须先完成 apply 持久核验。'
  if (!uuidPattern.test(input.rollbackRequestId) || input.rollbackRequestId === input.originalRequestId) {
    return 'Rollback UUID 必须有效且不同于原 candidate UUID。'
  }
  return validateWindow(input.maintenanceWindowStartUtc, input.maintenanceWindowEndUtc)
}

function planAndPreviewMatch(
  input: NebulaPluginPlanRequest,
  plan: NebulaPluginPlanResult,
  preview: NebulaPluginApplyPreviewResult
): boolean {
  return plan.requestId === input.requestId && preview.requestId === input.requestId &&
    plan.targetRole === 'Server' && preview.targetRole === 'Server' &&
    plan.planDigest === preview.planDigest && plan.mode === 'dry-run' &&
    plan.executionEnabled === false && plan.productionChanged === false &&
    preview.mode === 'dry-run' && preview.status === 'preview' &&
    preview.confirmationRequired === true && preview.productionChanged === false
}

function verificationMatchesApply(
  result: NebulaPluginApplyResult | null,
  verification: NebulaPluginVerifyApplyResult | null
): boolean {
  return result !== null && verification !== null && verification.targetRole === 'Server' &&
    result.requestId === verification.requestId && result.status === verification.transactionStatus &&
    result.receiptDigest === verification.receiptDigest && verification.contentAndAclExact === true &&
    verification.rollbackMaterialRetained === true
}

function rollbackPreviewMatchesInput(
  preview: NebulaPluginRollbackPreviewResult,
  input: NonNullable<ReturnType<typeof buildRollbackInput>>
): boolean {
  return preview.originalRequestId === input.originalRequestId &&
    preview.rollbackRequestId === input.rollbackRequestId && preview.status === 'preview' &&
    preview.mode === 'dry-run' && preview.productionChanged === false &&
    preview.exactConfirmationPhrase === rollbackConfirmationPhrase(
      preview.rollbackRequestId,
      preview.previewDigest
    )
}

function rollbackResultMatchesInput(
  result: NebulaPluginRollbackResult,
  input: NebulaPluginRollbackMutationRequest
): boolean {
  return result.originalRequestId === input.originalRequestId &&
    result.rollbackRequestId === input.rollbackRequestId
}

function verificationMatchesRollback(
  result: NebulaPluginRollbackResult | null,
  verification: NebulaPluginVerifyRollbackResult | null
): boolean {
  return result !== null && verification !== null &&
    result.originalRequestId === verification.originalRequestId &&
    result.rollbackRequestId === verification.rollbackRequestId &&
    result.status === verification.transactionStatus && result.receiptDigest === verification.receiptDigest &&
    verification.contentAndAclExact === true && verification.rollbackMaterialRetained === true
}

function rollbackConfirmationPhrase(requestId: string, previewDigest: string): string {
  return `CONFIRM NEBULA PLUGIN ROLLBACK ${requestId} ${previewDigest}`
}

function isCode(reason: unknown, code: string): boolean {
  return typeof reason === 'object' && reason !== null &&
    (reason as { code?: unknown }).code === code
}

function errorText(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback
}

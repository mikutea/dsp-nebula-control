import { useState } from 'react'
import type { SessionUser } from './model'
import {
  deriveSaveReconcileEligibility,
  SAVE_JOB_RECONCILE_CONFIRMATION,
  type SaveJobExecutionResultWithMaintenance,
  type SaveReconciliationReason
} from './save-reconcile-contract'

export interface SaveRecoveryPanelProps {
  currentJob: SaveJobExecutionResultWithMaintenance | null
  role: SessionUser['role']
  busy: boolean
  reconcileDisabled?: boolean
  reconcileDisabledReason?: string
  onReconcile: (
    jobId: string,
    confirmation: typeof SAVE_JOB_RECONCILE_CONFIRMATION
  ) => void | Promise<void>
  onRefresh: (jobId: string) => void | Promise<void>
}

const reasonCopy: Record<SaveReconciliationReason, { title: string; detail: string }> = {
  'committed-cleanup': {
    title: '已提交存档对等待收尾',
    detail: '服务端已证明恢复提交完成；本操作只授权对既有事务执行持久化清理与审计收尾。'
  },
  'rolled-back-cleanup': {
    title: '已回滚存档对等待收尾',
    detail: '服务端已证明原存档对完成补偿恢复；本操作只授权清理该事务拥有的暂存证据。'
  },
  'audit-repair': {
    title: '已证明终态等待审计修复',
    detail: '服务端已证明恢复或回滚终态；本操作只授权使用原始事务身份补齐持久化审计。'
  }
}

export function SaveRecoveryPanel({
  currentJob,
  role,
  busy,
  reconcileDisabled = false,
  reconcileDisabledReason = '',
  onReconcile,
  onRefresh
}: SaveRecoveryPanelProps) {
  const [confirmation, setConfirmation] = useState('')
  const [submitting, setSubmitting] = useState(false)

  if (currentJob === null || !currentJob.run.recoveryRequired) return null

  const job = currentJob
  const eligibility = deriveSaveReconcileEligibility(job)
  const administrator = role === 'administrator'
  const working = busy || submitting
  const exactConfirmation = confirmation === SAVE_JOB_RECONCILE_CONFIRMATION
  const title = eligibility.state === 'allowed'
    ? reasonCopy[eligibility.reason].title
    : eligibility.state === 'in-progress'
      ? '持久化对账正在执行'
      : '当前终态只允许人工核验'
  const detail = eligibility.state === 'allowed'
    ? reasonCopy[eligibility.reason].detail
    : eligibility.state === 'in-progress'
      ? '已持久化的授权正在由服务端处理；这里只刷新同一作业，不会再次提交 reconcile。'
      : eligibility.code === 'SAVE_JOB_BROWSER_RESPONSE_INVALID'
        ? '浏览器未能严格验证作业响应，恢复控制已 fail-closed 锁定。'
        : '服务端未提供可安全对账的维护终态；请保留当前存档对和事务证据，转入人工恢复。'
  const statusCode = job.run.errorCode ?? (eligibility.state === 'allowed' ? eligibility.reason : eligibility.code)

  async function reconcile() {
    if (!administrator || eligibility.state !== 'allowed' || !exactConfirmation || working || reconcileDisabled) return
    setSubmitting(true)
    try {
      await onReconcile(job.job.id, SAVE_JOB_RECONCILE_CONFIRMATION)
      setConfirmation('')
    } finally {
      setSubmitting(false)
    }
  }

  return <section className={`save-recovery-panel ${eligibility.state}`} role="region" aria-labelledby="save-recovery-title">
    <header>
      <div>
        <strong id="save-recovery-title">{title}</strong>
        <small>作业 {job.job.id.slice(0, 8)} · 尝试 {job.run.attemptCount}</small>
      </div>
      <span>{statusCode}</span>
    </header>
    <p>{detail}</p>
    <p className="save-recovery-pair-warning">
      <strong>.dsv + .server 始终是一个原子存档对。</strong>
      对账不会授权分别覆盖、重新选择或盲目重试任一文件。
    </p>

    {eligibility.state === 'allowed' && administrator ? <div className="save-recovery-confirmation">
      {reconcileDisabled && <div className="permission-lock-note">
        {reconcileDisabledReason || '需要先刷新同一作业，确认服务端最新终态后才能再次授权。'}
      </div>}
      <label htmlFor={`save-reconcile-confirmation-${job.job.id}`}>
        输入 <code>{SAVE_JOB_RECONCILE_CONFIRMATION}</code> 授权服务端核对原始持久化事务
      </label>
      <input
        id={`save-reconcile-confirmation-${job.job.id}`}
        autoComplete="off"
        spellCheck={false}
        value={confirmation}
        disabled={working || reconcileDisabled}
        onChange={(event) => setConfirmation(event.currentTarget.value)}
      />
      <button type="button" className="confirm-execute" disabled={!exactConfirmation || working || reconcileDisabled} onClick={reconcile}>
        {working ? '正在提交明确授权…' : '授权持久化对账'}
      </button>
    </div> : eligibility.state === 'allowed' ? <div className="permission-lock-note">
      当前角色无权授权恢复事务对账；仅 Administrator 可执行。
    </div> : null}

    <button type="button" disabled={working} onClick={() => onRefresh(job.job.id)}>
      刷新同一作业状态
    </button>
  </section>
}

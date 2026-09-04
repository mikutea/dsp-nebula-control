import { useRef, useState } from 'react'
import { api, ApiError } from './api'
import type { SaveJobExecutionResultWithMaintenance } from './save-reconcile-contract'

const jobIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface PersistedSaveRecoveryLookupProps {
  onLoaded: (execution: SaveJobExecutionResultWithMaintenance) => void | Promise<void>
  disabled?: boolean
}

/**
 * Recovers access to a persisted, interrupted restore after the surrounding
 * page has lost its in-memory job reference. Lookup is deliberately manual:
 * rendering or changing the identifier never sends a request.
 */
export function PersistedSaveRecoveryLookup({
  onLoaded,
  disabled = false
}: PersistedSaveRecoveryLookupProps) {
  const [jobId, setJobId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [loadedJobId, setLoadedJobId] = useState<string | null>(null)
  const inFlight = useRef(false)
  const validJobId = jobIdPattern.test(jobId)

  function updateJobId(value: string): void {
    setJobId(value)
    setError('')
    setLoadedJobId(null)
  }

  async function load(): Promise<void> {
    if (disabled || inFlight.current) return
    if (!validJobId) {
      setError('恢复作业 ID 必须是带版本与变体位的标准 UUID；未发送请求。')
      return
    }

    const requestedJobId = jobId
    inFlight.current = true
    setLoading(true)
    setError('')
    setLoadedJobId(null)
    try {
      const response = await api.saveJob(requestedJobId)
      const execution = response.data
      const rejection = recoveryRejection(execution, requestedJobId)
      if (rejection !== null) {
        setError(rejection)
        return
      }
      await onLoaded(execution)
      setLoadedJobId(execution.job.id)
    } catch (reason) {
      setError(reason instanceof ApiError
        ? `恢复查找已 fail-closed：${reason.message}${reason.code ? ` · ${reason.code}` : ''}`
        : '恢复查找已 fail-closed：无法严格确认持久化恢复作业。')
    } finally {
      inFlight.current = false
      setLoading(false)
    }
  }

  return <section className="save-recovery-panel" aria-labelledby="persisted-save-recovery-title">
    <header>
      <div>
        <strong id="persisted-save-recovery-title">查找持久化恢复作业</strong>
        <small>页面刷新或控制台重启后，凭原作业 UUID 重新取得同一恢复事务。</small>
      </div>
      <span>GET ONLY</span>
    </header>

    <p className="save-recovery-pair-warning">
      此处只读取既有作业，不会重试恢复或修改 <strong>.dsv + .server</strong> 原子存档对。
    </p>

    <label htmlFor="persisted-save-recovery-job-id">恢复作业 UUID</label>
    <input
      id="persisted-save-recovery-job-id"
      aria-invalid={jobId.length > 0 && !validJobId}
      autoComplete="off"
      spellCheck={false}
      value={jobId}
      disabled={disabled || loading}
      placeholder="00000000-0000-4000-8000-000000000000"
      onChange={(event) => updateJobId(event.currentTarget.value)}
    />
    {jobId.length > 0 && !validJobId && <small>请输入完整标准 UUID；不会自动修剪或补全。</small>}

    <button type="button" disabled={disabled || loading || !validJobId} onClick={() => void load()}>
      {loading ? '正在读取同一作业…' : '查找恢复作业'}
    </button>

    {disabled && <div className="permission-lock-note">当前状态禁止查找恢复作业。</div>}
    {error && <div role="alert">{error}</div>}
    {loadedJobId && <div aria-live="polite">已载入恢复作业 {loadedJobId}</div>}
  </section>
}

function recoveryRejection(
  execution: SaveJobExecutionResultWithMaintenance,
  requestedJobId: string
): string | null {
  if (execution.job.id !== requestedJobId || execution.run.jobId !== requestedJobId) {
    return '恢复查找已 fail-closed：返回作业身份与请求 UUID 不一致。'
  }
  if (execution.job.kind !== 'save.restore' || execution.run.operation !== 'restore') {
    return '恢复查找已 fail-closed：返回作业不是 save.restore。'
  }
  if (!execution.run.recoveryRequired) {
    return '恢复查找已 fail-closed：返回作业未标记 recoveryRequired。'
  }
  if (execution.run.state !== 'interrupted') {
    return '恢复查找已 fail-closed：返回恢复作业状态不是 interrupted。'
  }
  return null
}

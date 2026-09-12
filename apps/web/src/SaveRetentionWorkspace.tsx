import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArchiveRestore, Ban, Check, Clock3, FileLock2, Pin, RefreshCw,
  ShieldCheck, Trash2, TriangleAlert
} from 'lucide-react'
import { api, ApiError } from './api'
import { createUiRequestId } from './request-id'
import type {
  BackupAnnotation,
  BackupCatalogItem,
  BackupRetentionPolicy,
  BackupRetentionPreview,
  BackupRetirementReceipt,
  BackupRetentionPurgePreview,
  SessionUser
} from './model'

type WorkspaceGate = 'server-enforced' | 'accepted' | 'fail-closed'
type WorkspacePhase =
  | 'idle' | 'loading' | 'annotating' | 'previewing' | 'retiring'
  | 'restoring' | 'purge-previewing' | 'purging'

const defaultPolicy: BackupRetentionPolicy = {
  keepLastHealthy: 3,
  keepDailyDays: 14,
  keepWeeklyWeeks: 8,
  minimumHealthy: 2,
  allowUnhealthyDeletion: false
}

export function SaveRetentionWorkspace({ backups, user, demo = false, onCatalogChanged }: {
  backups: BackupCatalogItem[]
  user: SessionUser
  demo?: boolean
  onCatalogChanged?: () => void | Promise<void>
}) {
  const canManage = user.role === 'administrator' && user.permissions.includes('saves.restore')
  const [gate, setGate] = useState<WorkspaceGate>('server-enforced')
  const [phase, setPhase] = useState<WorkspacePhase>('idle')
  const [error, setError] = useState('')
  const [annotations, setAnnotations] = useState<BackupAnnotation[]>([])
  const [selectedBackupId, setSelectedBackupId] = useState('')
  const [note, setNote] = useState('')
  const [protectedBackup, setProtectedBackup] = useState(false)
  const [policy, setPolicy] = useState(defaultPolicy)
  const [preview, setPreview] = useState<BackupRetentionPreview | null>(null)
  const [executionEnabled, setExecutionEnabled] = useState(false)
  const [retirement, setRetirement] = useState<BackupRetirementReceipt | null>(null)
  const [purgePreview, setPurgePreview] = useState<BackupRetentionPurgePreview | null>(null)
  const [retireConfirmation, setRetireConfirmation] = useState('')
  const [restoreConfirmation, setRestoreConfirmation] = useState('')
  const [purgeConfirmation, setPurgeConfirmation] = useState('')
  const [annotationRequestId, setAnnotationRequestId] = useState(() => createUiRequestId())
  const [retirementRequestId, setRetirementRequestId] = useState(() => createUiRequestId())
  const [restoreRequestId, setRestoreRequestId] = useState(() => createUiRequestId())
  const [purgeRequestId, setPurgeRequestId] = useState(() => createUiRequestId())
  const sequenceRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const selectedAnnotation = useMemo(
    () => annotations.find((annotation) => annotation.backupId === selectedBackupId) ?? null,
    [annotations, selectedBackupId]
  )
  const selectedBackup = backups.find((backup) => backup.backupId === selectedBackupId) ?? null
  const selectedRetirementDecisions = useMemo(() => {
    if (!preview) return []
    const selectedIds = new Set(preview.executionBatch.selectedBackupIds)
    return preview.plan.delete.filter((entry) => selectedIds.has(entry.backupId))
  }, [preview])
  const busy = phase !== 'idle' && phase !== 'loading'

  useEffect(() => {
    if (demo) return
    void loadAnnotations()
    return () => {
      sequenceRef.current += 1
      abortRef.current?.abort()
    }
  }, [demo])

  useEffect(() => {
    if (selectedBackupId && backups.some((backup) => backup.backupId === selectedBackupId)) return
    setSelectedBackupId(backups[0]?.backupId ?? '')
  }, [backups, selectedBackupId])

  useEffect(() => {
    setNote(selectedAnnotation?.note ?? '')
    setProtectedBackup(selectedAnnotation?.protected ?? false)
    setAnnotationRequestId(createUiRequestId())
  }, [selectedAnnotation, selectedBackupId])

  async function loadAnnotations(): Promise<void> {
    const request = begin('loading')
    try {
      const result = await api.backupAnnotations(request.controller.signal)
      if (!isCurrent(request.sequence)) return
      setAnnotations(result.data)
      setGate('accepted')
    } catch (reason) {
      if (!isCurrent(request.sequence) || isAbortError(reason)) return
      setError(formatRetentionError(reason, '备份备注读取失败。'))
      if (isFailClosed(reason)) setGate('fail-closed')
    } finally {
      finish(request)
    }
  }

  async function saveAnnotation(): Promise<void> {
    if (!canManage || gate === 'fail-closed' || !selectedBackup) return
    const request = begin('annotating')
    try {
      const result = await api.setBackupAnnotation({
        requestId: annotationRequestId,
        backupId: selectedBackup.backupId,
        expectedRevision: selectedAnnotation?.revision ?? null,
        note: note.trim() || null,
        protected: protectedBackup
      }, request.controller.signal)
      if (!isCurrent(request.sequence)) return
      setAnnotations((current) => [
        ...current.filter((annotation) => annotation.backupId !== selectedBackup.backupId),
        result.data.receipt.annotation
      ])
      invalidatePreview()
      setAnnotationRequestId(createUiRequestId())
      setGate('accepted')
    } catch (reason) {
      if (!isCurrent(request.sequence) || isAbortError(reason)) return
      setError(formatRetentionError(reason, '备份备注保存失败。'))
      if (isFailClosed(reason)) setGate('fail-closed')
    } finally {
      finish(request)
    }
  }

  async function previewRetention(): Promise<void> {
    if (!canManage || gate === 'fail-closed') return
    const request = begin('previewing')
    const referenceTime = new Date().toISOString()
    try {
      const result = await api.previewBackupRetention(referenceTime, policy, request.controller.signal)
      if (!isCurrent(request.sequence)) return
      setPreview(result.data)
      setExecutionEnabled(result.meta.executionEnabled)
      setRetirement(null)
      setPurgePreview(null)
      setRetireConfirmation('')
      setRetirementRequestId(createUiRequestId())
      setGate('accepted')
    } catch (reason) {
      if (!isCurrent(request.sequence) || isAbortError(reason)) return
      setError(formatRetentionError(reason, '保留策略预演失败。'))
      if (isFailClosed(reason)) setGate('fail-closed')
    } finally {
      finish(request)
    }
  }

  async function executeRetirement(): Promise<void> {
    if (!canManage || !preview || !executionEnabled || gate === 'fail-closed' ||
        retireConfirmation !== 'RETIRE') return
    const request = begin('retiring')
    try {
      const result = await api.executeBackupRetention({
        requestId: retirementRequestId,
        previewDigest: preview.previewDigest,
        referenceTime: preview.referenceTime,
        policy: preview.policy
      }, request.controller.signal)
      if (!isCurrent(request.sequence)) return
      setRetirement(result.data.receipt)
      setPreview(null)
      setRetireConfirmation('')
      setRestoreRequestId(createUiRequestId())
      setPurgeRequestId(createUiRequestId())
      setGate('accepted')
      await onCatalogChanged?.()
    } catch (reason) {
      if (!isCurrent(request.sequence) || isAbortError(reason)) return
      setError(formatRetentionError(reason, '备份退役事务失败。'))
      if (isFailClosed(reason)) setGate('fail-closed')
    } finally {
      finish(request)
    }
  }

  async function restoreRetirement(): Promise<void> {
    if (!canManage || !retirement || gate === 'fail-closed' || restoreConfirmation !== 'RESTORE') return
    const request = begin('restoring')
    try {
      await api.restoreRetiredBackups(
        restoreRequestId,
        retirement.requestId,
        request.controller.signal
      )
      if (!isCurrent(request.sequence)) return
      setRetirement(null)
      setPurgePreview(null)
      setRestoreConfirmation('')
      setGate('accepted')
      await onCatalogChanged?.()
    } catch (reason) {
      if (!isCurrent(request.sequence) || isAbortError(reason)) return
      setError(formatRetentionError(reason, '退役备份恢复失败。'))
      if (isFailClosed(reason)) setGate('fail-closed')
    } finally {
      finish(request)
    }
  }

  async function previewPurge(): Promise<void> {
    if (!canManage || !retirement || gate === 'fail-closed') return
    const request = begin('purge-previewing')
    try {
      const result = await api.previewRetiredBackupPurge(retirement.requestId, request.controller.signal)
      if (!isCurrent(request.sequence)) return
      setPurgePreview(result.data)
      setExecutionEnabled(result.meta.executionEnabled)
      setPurgeConfirmation('')
      setPurgeRequestId(createUiRequestId())
      setGate('accepted')
    } catch (reason) {
      if (!isCurrent(request.sequence) || isAbortError(reason)) return
      setError(formatRetentionError(reason, '永久清理预演失败。'))
      if (isFailClosed(reason)) setGate('fail-closed')
    } finally {
      finish(request)
    }
  }

  async function executePurge(): Promise<void> {
    if (!canManage || !retirement || !purgePreview || !purgePreview.eligible ||
        !executionEnabled || gate === 'fail-closed' || purgeConfirmation !== 'PURGE') return
    const request = begin('purging')
    try {
      await api.purgeRetiredBackups({
        requestId: purgeRequestId,
        retirementRequestId: retirement.requestId,
        purgePreviewDigest: purgePreview.purgePreviewDigest
      }, request.controller.signal)
      if (!isCurrent(request.sequence)) return
      setRetirement(null)
      setPurgePreview(null)
      setPurgeConfirmation('')
      setGate('accepted')
      await onCatalogChanged?.()
    } catch (reason) {
      if (!isCurrent(request.sequence) || isAbortError(reason)) return
      setError(formatRetentionError(reason, '永久清理事务失败。'))
      if (isFailClosed(reason)) setGate('fail-closed')
    } finally {
      finish(request)
    }
  }

  function begin(nextPhase: WorkspacePhase): { sequence: number; controller: AbortController } {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const sequence = ++sequenceRef.current
    setPhase(nextPhase)
    setError('')
    return { sequence, controller }
  }

  function finish(request: { sequence: number; controller: AbortController }): void {
    if (!isCurrent(request.sequence)) return
    if (abortRef.current === request.controller) abortRef.current = null
    setPhase('idle')
  }

  function isCurrent(sequence: number): boolean {
    return sequence === sequenceRef.current
  }

  function invalidatePreview(): void {
    setPreview(null)
    setExecutionEnabled(false)
    setRetireConfirmation('')
  }

  function updatePolicy<K extends keyof BackupRetentionPolicy>(key: K, value: BackupRetentionPolicy[K]): void {
    setPolicy((current) => ({ ...current, [key]: value }))
    invalidatePreview()
  }

  if (!canManage) {
    return <section className="save-retention-workspace readonly">
      <header><div><FileLock2 size={18} /><span><strong>备份保留与清理</strong><small>退役区 · 等待期 · 可恢复事务</small></span></div><b>ADMINISTRATOR ONLY</b></header>
      <div className="retention-readonly"><ShieldCheck size={22} /><span><strong>当前角色仅可浏览保护点</strong><small>保护备注、保留策略、退役、恢复和永久清理均会改变服务器数据，只对拥有 saves.restore 的 Administrator 开放。</small></span></div>
    </section>
  }

  if (demo) {
    return <section className="save-retention-workspace readonly">
      <header><div><FileLock2 size={18} /><span><strong>备份保留与清理</strong><small>退役区 · 等待期 · 可恢复事务</small></span></div><b>DEMO READ-ONLY</b></header>
      <div className="retention-readonly"><ShieldCheck size={22} /><span><strong>演示环境未装载持久化保留控制器</strong><small>这里不会伪造备注、退役或永久清理结果，也不会请求生产专用接口。切换到已配置 Windows Provider 后，服务端会重新执行权限、锁、摘要和恢复状态门禁。</small></span></div>
    </section>
  }

  return <section className="save-retention-workspace">
    <header><div><FileLock2 size={18} /><span><strong>备份保留与清理</strong><small>preview → retire → grace period → purge</small></span></div><b className={gate === 'fail-closed' ? 'closed' : ''}>{gate === 'fail-closed' ? 'FAIL-CLOSED' : 'ADMINISTRATOR'}</b></header>
    {error && <div className="retention-error" role="alert"><TriangleAlert size={15} />{error}</div>}
    {gate === 'fail-closed' && <div className="retention-gate"><Ban size={17} /><span><strong>本地操作控件已锁定</strong><small>403、423 或 503 表示服务端权限、执行开关、恢复状态或并发锁拒绝了请求；重新载入只会再次请求服务端裁决。</small></span><button type="button" onClick={() => { setGate('server-enforced'); void loadAnnotations() }}><RefreshCw size={14} />重新核对</button></div>}

    <div className="retention-grid">
      <section className="retention-card annotation-card">
        <header><div><Pin size={16} /><strong>备注与保护固定</strong></div><b>VERSIONED</b></header>
        <label><span>保护点</span><select aria-label="选择备注保护点" value={selectedBackupId} disabled={busy || gate === 'fail-closed'} onChange={(event) => setSelectedBackupId(event.target.value)}><option value="">选择保护点</option>{backups.map((backup) => <option key={backup.backupId} value={backup.backupId}>{backup.saveName ?? '未知存档'} · {shortId(backup.backupId)}</option>)}</select></label>
        <label><span>备注（最多 256 字符）</span><input aria-label="备份备注" maxLength={256} value={note} disabled={!selectedBackup || busy || gate === 'fail-closed'} onChange={(event) => setNote(event.target.value)} /></label>
        <label className="retention-check"><input aria-label="保护此备份" type="checkbox" checked={protectedBackup} disabled={!selectedBackup || busy || gate === 'fail-closed'} onChange={(event) => setProtectedBackup(event.target.checked)} /><span><strong>保护此备份</strong><small>保护项不会进入退役计划</small></span></label>
        <button type="button" disabled={!selectedBackup || busy || gate === 'fail-closed'} onClick={saveAnnotation}>{phase === 'annotating' ? '保存中…' : `保存版本 ${selectedAnnotation ? selectedAnnotation.revision + 1 : 1}`}</button>
      </section>

      <section className="retention-card policy-card">
        <header><div><Clock3 size={16} /><strong>服务端保留策略</strong></div><b>DRY-RUN FIRST</b></header>
        <div className="retention-policy-fields">
          <PolicyNumber label="最近健康" value={policy.keepLastHealthy} min={1} max={1000} disabled={busy} onChange={(value) => updatePolicy('keepLastHealthy', value)} />
          <PolicyNumber label="每日天数" value={policy.keepDailyDays} min={0} max={3650} disabled={busy} onChange={(value) => updatePolicy('keepDailyDays', value)} />
          <PolicyNumber label="每周周数" value={policy.keepWeeklyWeeks} min={0} max={520} disabled={busy} onChange={(value) => updatePolicy('keepWeeklyWeeks', value)} />
          <PolicyNumber label="最少健康" value={policy.minimumHealthy} min={1} max={1000} disabled={busy} onChange={(value) => updatePolicy('minimumHealthy', value)} />
        </div>
        <label className="retention-check danger"><input aria-label="允许退役不健康备份" type="checkbox" checked={policy.allowUnhealthyDeletion} disabled={busy} onChange={(event) => updatePolicy('allowUnhealthyDeletion', event.target.checked)} /><span><strong>允许不健康备份进入退役</strong><small>默认关闭；启用后仍需摘要绑定和二次确认</small></span></label>
        <button type="button" disabled={busy || gate === 'fail-closed'} onClick={previewRetention}>{phase === 'previewing' ? '正在哈希盘点…' : '生成无写入预演'}</button>
      </section>
    </div>

    {preview && <section className="retention-plan" aria-label="备份保留预演">
      <header><div><Check size={16} /><span><strong>预演已绑定当前清单</strong><small>{shortDigest(preview.previewDigest)} · 清单变化后执行会被拒绝</small></span></div><b>{executionEnabled ? 'EXECUTION GATE OPEN' : 'SERVER READ-ONLY'}</b></header>
      <div className="retention-plan-counts"><span><strong>{preview.plan.keep.length}</strong>保留</span><span><strong>{preview.plan.delete.length}</strong>符合退役</span><span><strong>{preview.executionBatch.selectedBackupIds.length}</strong>本批退役</span><span><strong>{preview.plan.blocked.length}</strong>阻止</span><span><strong>{preview.excluded.length}</strong>排除</span></div>
      {preview.excluded.some((entry) => entry.reason === 'redirected-entry') && <div className="retention-warning"><TriangleAlert size={15} />检测到重定向目录；服务端会拒绝执行整个退役事务。</div>}
      {preview.executionBatch.deferredCandidateCount > 0 && <div className="retention-warning"><Clock3 size={15} />为保证事务日志可恢复，本次只处理最旧的 {preview.executionBatch.selectedBackupIds.length} 个；其余 {preview.executionBatch.deferredCandidateCount} 个会在下一次重新预演后处理。</div>}
      <div className="retention-candidates">{selectedRetirementDecisions.length ? selectedRetirementDecisions.map((entry) => <span key={entry.backupId}><Trash2 size={13} /><code>{shortId(entry.backupId)}</code><small>{entry.reason === 'outside-policy' ? '超出策略' : '不健康删除已显式允许'}</small></span>) : <span className="empty"><ShieldCheck size={14} />当前没有需要退役的保护点</span>}</div>
      <div className="retention-confirm"><label><span>输入 RETIRE</span><input aria-label="确认退役" value={retireConfirmation} onChange={(event) => setRetireConfirmation(event.target.value)} /></label><button type="button" className="danger" disabled={busy || !executionEnabled || retireConfirmation !== 'RETIRE'} onClick={executeRetirement}>{phase === 'retiring' ? '正在事务式退役…' : '退役选中备份'}</button></div>
    </section>}

    {retirement && <section className="retention-retired" aria-label="已退役备份事务">
      <header><div><ArchiveRestore size={16} /><span><strong>备份已进入私有退役区</strong><small>{retirement.retired.length} 个 · {formatBytes(retirement.retired.reduce((sum, item) => sum + item.totalBytes, 0))} · 尚未释放磁盘</small></span></div><b>RECOVERABLE</b></header>
      <div className="retention-stage-actions">
        <div><p>恢复会把整个事务的备份原子移回活动目录。</p><label><span>输入 RESTORE</span><input aria-label="确认恢复退役备份" value={restoreConfirmation} onChange={(event) => setRestoreConfirmation(event.target.value)} /></label><button type="button" disabled={busy || restoreConfirmation !== 'RESTORE'} onClick={restoreRetirement}>{phase === 'restoring' ? '恢复中…' : '恢复整批退役备份'}</button></div>
        <div className="purge-lane"><p>永久清理不可回滚，必须经过等待期和新的清理摘要。</p><button type="button" disabled={busy} onClick={previewPurge}>{phase === 'purge-previewing' ? '核对等待期…' : '生成永久清理预演'}</button>{purgePreview && <><small>{purgePreview.eligible ? `已满足等待期 · ${formatBytes(purgePreview.totalBytes)}` : `最早可清理：${new Date(purgePreview.eligibleAt).toLocaleString('zh-CN')}`}</small><label><span>输入 PURGE</span><input aria-label="确认永久清理" value={purgeConfirmation} disabled={!purgePreview.eligible} onChange={(event) => setPurgeConfirmation(event.target.value)} /></label><button type="button" className="danger" disabled={busy || !executionEnabled || !purgePreview.eligible || purgeConfirmation !== 'PURGE'} onClick={executePurge}>{phase === 'purging' ? '正在永久清理…' : '永久清理退役备份'}</button></>}</div>
      </div>
    </section>}
  </section>
}

function PolicyNumber({ label, value, min, max, disabled, onChange }: {
  label: string
  value: number
  min: number
  max: number
  disabled: boolean
  onChange: (value: number) => void
}) {
  return <label><span>{label}</span><input aria-label={label} type="number" min={min} max={max} value={value} disabled={disabled} onChange={(event) => {
    const next = Number.parseInt(event.target.value, 10)
    if (Number.isInteger(next) && next >= min && next <= max) onChange(next)
  }} /></label>
}

function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value
}

function shortDigest(value: string): string {
  return `${value.slice(0, 12)}…${value.slice(-8)}`
}

function formatBytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${value} B`
}

function isAbortError(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === 'AbortError'
}

function isFailClosed(reason: unknown): boolean {
  return reason instanceof ApiError && [403, 423, 503].includes(reason.status)
}

function formatRetentionError(reason: unknown, fallback: string): string {
  if (!(reason instanceof ApiError)) return reason instanceof Error ? reason.message : fallback
  const messages: Record<string, string> = {
    SAVE_RETENTION_MUTATIONS_DISABLED: '备份保留执行门禁为默认关闭；当前只能读取和预演。',
    SAVE_RETENTION_PLAN_CHANGED: '备份清单、备注或保护状态已变化，请重新生成预演。',
    SAVE_RETENTION_ANNOTATION_CONFLICT: '备注已被其他会话更新，请重新载入后再提交。',
    SAVE_RETENTION_LOCK_BUSY: '另一条存档保留事务正在运行。',
    SAVE_RETENTION_PURGE_TOO_EARLY: '退役等待期尚未结束，永久清理被拒绝。',
    SAVE_RETENTION_RECOVERY_REQUIRED: '检测到需要人工对账的中断状态，所有新变更均已锁定。'
  }
  return reason.code ? messages[reason.code] ?? reason.message : reason.message || fallback
}

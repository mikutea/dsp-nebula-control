import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  Activity, BellRing, Check, CheckCircle2, Clock3, History, LoaderCircle,
  LockKeyhole, Radio, ShieldAlert, ShieldCheck, TriangleAlert
} from 'lucide-react'

export type ObservabilityAlertSeverity = 'info' | 'warning' | 'critical'
export type ObservabilityAlertStatus = 'open' | 'resolved'

export interface ObservabilityAlertSeverityHistoryEntry {
  severity: ObservabilityAlertSeverity
  changedAt: string
}

export interface ObservabilityAlertAcknowledgement {
  actor: string
  acknowledgedAt: string
}

export interface ObservabilityAlertEpisode {
  id: string
  code: string
  status: ObservabilityAlertStatus
  currentSeverity: ObservabilityAlertSeverity
  severityHistory: ObservabilityAlertSeverityHistoryEntry[]
  openedAt: string
  lastSeenAt: string
  observationCount: number
  consecutiveMissingSamples: number
  acknowledgement: ObservabilityAlertAcknowledgement | null
  resolvedAt: string | null
}

export interface ObservabilityAlertProjection {
  schemaVersion: 1
  kind: 'observability-alert-episode-projection'
  observedThrough: string | null
  capacity: number
  resolveAfterMissingSamples: number
  episodes: ObservabilityAlertEpisode[]
}

export interface ObservabilityAlertPanelProps {
  projection: ObservabilityAlertProjection | null
  recoveryRequired: boolean
  canAcknowledge: boolean
  onAcknowledge: (episodeId: string) => Promise<unknown>
}

type SubmissionState = 'pending' | 'submitted' | 'failed'

interface RecurrencePresentation {
  ordinal: number
  total: number
  previous: ObservabilityAlertEpisode | null
}

interface EpisodePresentation {
  open: ObservabilityAlertEpisode[]
  resolved: ObservabilityAlertEpisode[]
  recurrenceById: Map<string, RecurrencePresentation>
}

const severityRank: Record<ObservabilityAlertSeverity, number> = {
  critical: 3,
  warning: 2,
  info: 1
}

const severityLabels: Record<ObservabilityAlertSeverity, string> = {
  critical: '严重',
  warning: '警告',
  info: '提示'
}

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
})

export function ObservabilityAlertPanel({
  projection,
  recoveryRequired,
  canAcknowledge,
  onAcknowledge
}: ObservabilityAlertPanelProps) {
  const titleId = useId()
  const mountedRef = useRef(true)
  const submissionLocksRef = useRef(new Set<string>())
  const [submissions, setSubmissions] = useState<ReadonlyMap<string, SubmissionState>>(
    () => new Map()
  )
  const presentation = useMemo(
    () => buildEpisodePresentation(projection?.episodes ?? []),
    [projection?.episodes]
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      submissionLocksRef.current.clear()
    }
  }, [])

  const projectionUnavailable = projection === null
  const mutationsLocked = recoveryRequired || projectionUnavailable

  const acknowledge = async (episodeId: string) => {
    if (!canAcknowledge || mutationsLocked || submissionLocksRef.current.has(episodeId)) return

    submissionLocksRef.current.add(episodeId)
    if (mountedRef.current) setSubmission(setSubmissions, episodeId, 'pending')

    try {
      await onAcknowledge(episodeId)
      if (mountedRef.current) setSubmission(setSubmissions, episodeId, 'submitted')
    } catch {
      submissionLocksRef.current.delete(episodeId)
      if (mountedRef.current) setSubmission(setSubmissions, episodeId, 'failed')
    }
  }

  return <section
    className={`observability-alert-panel${mutationsLocked ? ' observability-alert-panel-locked' : ''}`}
    aria-labelledby={titleId}
  >
    <header className="observability-alert-header">
      <div className="observability-alert-beacon" aria-hidden="true">
        <BellRing size={20} />
        <i /><i />
      </div>
      <div className="observability-alert-heading">
        <strong id={titleId}>OBSERVABILITY ALERT EPISODES</strong>
        <span>持久事件投影 · 确认与自动恢复相互独立</span>
      </div>
      <div className="observability-alert-header-status">
        <b>{presentation.open.length} OPEN</b>
        <small>{presentation.resolved.length} RESOLVED</small>
      </div>
    </header>

    <div className="observability-alert-telemetry" aria-label="告警投影摘要">
      <span><Radio size={13} /><small>观测截止</small><strong>{formatTime(projection?.observedThrough ?? null)}</strong></span>
      <span><Activity size={13} /><small>事件容量</small><strong>{projection ? `${projection.episodes.length} / ${projection.capacity}` : '不可用'}</strong></span>
      <span><ShieldCheck size={13} /><small>恢复消抖</small><strong>{projection ? `${projection.resolveAfterMissingSamples} 个连续样本` : '不可用'}</strong></span>
      <span><History size={13} /><small>投影版本</small><strong>{projection ? `SCHEMA ${projection.schemaVersion}` : 'UNTRUSTED'}</strong></span>
    </div>

    {projectionUnavailable && <div className="observability-alert-recovery-lock" role="alert">
      <ShieldAlert size={20} />
      <span>
        <strong>告警投影不可用 · FAIL-CLOSED</strong>
        <small>没有可信事件投影；确认操作保持锁定，界面不会推断告警已恢复。</small>
      </span>
      <b>LOCKED</b>
    </div>}

    {recoveryRequired && <div className="observability-alert-recovery-lock" role="alert">
      <LockKeyhole size={20} />
      <span>
        <strong>持久告警状态需要人工恢复 · FAIL-CLOSED</strong>
        <small>恢复对账完成前，Operator / Admin 的确认入口保持禁用，不会绕过不确定状态。</small>
      </span>
      <b>RECOVERY REQUIRED</b>
    </div>}

    {!canAcknowledge && <div className="observability-alert-readonly">
      <LockKeyhole size={16} />
      <span><strong>VIEWER / READ ONLY</strong><small>可查看事件、严重度、消抖和复发历史；只有 Operator / Admin 可以确认开放事件。</small></span>
    </div>}

    <AlertEpisodeGroup
      id="open"
      title="开放事件"
      subtitle="仍在观测或正在等待连续恢复样本"
      episodes={presentation.open}
      recurrenceById={presentation.recurrenceById}
      resolveAfterMissingSamples={projection?.resolveAfterMissingSamples ?? 1}
      canAcknowledge={canAcknowledge}
      mutationsLocked={mutationsLocked}
      submissions={submissions}
      onAcknowledge={acknowledge}
    />
    <AlertEpisodeGroup
      id="resolved"
      title="已恢复事件"
      subtitle="达到恢复消抖门槛的只读历史"
      episodes={presentation.resolved}
      recurrenceById={presentation.recurrenceById}
      resolveAfterMissingSamples={projection?.resolveAfterMissingSamples ?? 1}
      canAcknowledge={false}
      mutationsLocked
      submissions={submissions}
      onAcknowledge={acknowledge}
    />
  </section>
}

function AlertEpisodeGroup({
  id,
  title,
  subtitle,
  episodes,
  recurrenceById,
  resolveAfterMissingSamples,
  canAcknowledge,
  mutationsLocked,
  submissions,
  onAcknowledge
}: {
  id: 'open' | 'resolved'
  title: string
  subtitle: string
  episodes: ObservabilityAlertEpisode[]
  recurrenceById: ReadonlyMap<string, RecurrencePresentation>
  resolveAfterMissingSamples: number
  canAcknowledge: boolean
  mutationsLocked: boolean
  submissions: ReadonlyMap<string, SubmissionState>
  onAcknowledge: (episodeId: string) => Promise<void>
}) {
  const headingId = useId()

  return <section className={`observability-alert-group observability-alert-group-${id}`} aria-labelledby={headingId}>
    <header className="observability-alert-group-header">
      <div>{id === 'open' ? <Radio size={15} /> : <CheckCircle2 size={15} />}
        <span><strong id={headingId}>{title}</strong><small>{subtitle}</small></span>
      </div>
      <b>{episodes.length}</b>
    </header>
    {episodes.length === 0
      ? <div className="observability-alert-empty">
          {id === 'open' ? <ShieldCheck size={18} /> : <History size={18} />}
          <span>{id === 'open' ? '当前投影没有开放事件' : '尚无已恢复事件历史'}</span>
        </div>
      : <div className="observability-alert-grid">
          {episodes.map((episode) => <AlertEpisodeCard
            key={episode.id}
            episode={episode}
            recurrence={recurrenceById.get(episode.id) ?? { ordinal: 1, total: 1, previous: null }}
            resolveAfterMissingSamples={resolveAfterMissingSamples}
            canAcknowledge={canAcknowledge}
            mutationsLocked={mutationsLocked}
            submission={submissions.get(episode.id)}
            onAcknowledge={onAcknowledge}
          />)}
        </div>}
  </section>
}

function AlertEpisodeCard({
  episode,
  recurrence,
  resolveAfterMissingSamples,
  canAcknowledge,
  mutationsLocked,
  submission,
  onAcknowledge
}: {
  episode: ObservabilityAlertEpisode
  recurrence: RecurrencePresentation
  resolveAfterMissingSamples: number
  canAcknowledge: boolean
  mutationsLocked: boolean
  submission: SubmissionState | undefined
  onAcknowledge: (episodeId: string) => Promise<void>
}) {
  const recoveryMaximum = Math.max(1, resolveAfterMissingSamples)
  const recoveryValue = clamp(episode.consecutiveMissingSamples, 0, recoveryMaximum)
  const recoveryPercent = episode.status === 'resolved'
    ? 100
    : recoveryValue / recoveryMaximum * 100
  const isPending = submission === 'pending'
  const isSubmitted = submission === 'submitted'
  const acknowledgement = episode.acknowledgement

  return <article
    className={`observability-alert-card observability-alert-card-${episode.currentSeverity} observability-alert-card-${episode.status}`}
    aria-label={`${episode.code} 告警事件`}
  >
    <header className="observability-alert-card-header">
      <div className="observability-alert-severity-glyph" aria-hidden="true">
        <SeverityGlyph severity={episode.currentSeverity} />
      </div>
      <span className="observability-alert-code">
        <strong>{episode.code}</strong>
        <code>{episode.id}</code>
      </span>
      <div className="observability-alert-badges">
        <b className={`observability-alert-severity observability-alert-severity-${episode.currentSeverity}`}>
          {severityLabels[episode.currentSeverity]}
        </b>
        <b className={`observability-alert-state observability-alert-state-${episode.status}`}>
          {episode.status === 'open' ? '开放' : '已恢复'}
        </b>
      </div>
    </header>

    <dl className="observability-alert-facts">
      <div><dt>首次出现</dt><dd><AlertTime value={episode.openedAt} /></dd></div>
      <div><dt>最近命中</dt><dd><AlertTime value={episode.lastSeenAt} /></dd></div>
      <div><dt>观测次数</dt><dd>{formatCount(episode.observationCount)}</dd></div>
      <div><dt>确认状态</dt><dd className={acknowledgement ? 'observability-alert-acknowledged' : 'observability-alert-unacknowledged'}>{acknowledgement ? '已确认' : '未确认'}</dd></div>
    </dl>

    <div className="observability-alert-recovery">
      <div>
        <span><strong>恢复消抖进度</strong><small>{recoveryLabel(episode, recoveryValue, recoveryMaximum)}</small></span>
        <b>{episode.status === 'resolved' ? 'COMPLETE' : `${recoveryValue} / ${recoveryMaximum}`}</b>
      </div>
      <div
        className="observability-alert-progress"
        role="progressbar"
        aria-label={`${episode.code} 恢复消抖进度`}
        aria-valuemin={0}
        aria-valuemax={recoveryMaximum}
        aria-valuenow={episode.status === 'resolved' ? recoveryMaximum : recoveryValue}
        aria-valuetext={recoveryLabel(episode, recoveryValue, recoveryMaximum)}
      ><i style={{ width: `${recoveryPercent}%` }} /></div>
    </div>

    <div className="observability-alert-history">
      <header><History size={13} /><strong>严重度轨迹</strong><small>{episode.severityHistory.length} 个节点</small></header>
      {episode.severityHistory.length === 0
        ? <span className="observability-alert-history-empty">没有可显示的严重度节点</span>
        : <ol>{episode.severityHistory.map((entry, index) => <li key={`${entry.changedAt}-${index}`}>
            <i className={`observability-alert-history-dot observability-alert-history-dot-${entry.severity}`} />
            <b>{severityLabels[entry.severity]}</b>
            <AlertTime value={entry.changedAt} />
          </li>)}</ol>}
    </div>

    <div className="observability-alert-recurrence">
      <header><Radio size={13} /><strong>复发历史</strong><b>第 {recurrence.ordinal} / {recurrence.total} 次</b></header>
      <small>{recurrence.previous
        ? <>上一次事件于 <AlertTime value={recurrence.previous.openedAt} /> 开放，状态为{recurrence.previous.status === 'resolved' ? '已恢复' : '开放'}。</>
        : recurrence.total > 1 ? `这是该代码的首次事件；投影内共保留 ${recurrence.total} 次。` : '当前投影内没有同代码的更早事件。'}</small>
    </div>

    {acknowledgement && <div className="observability-alert-acknowledgement">
      <Check size={14} />
      <span><strong>{acknowledgement.actor}</strong><small>确认于 <AlertTime value={acknowledgement.acknowledgedAt} /></small></span>
    </div>}

    {episode.status === 'resolved' && <div className="observability-alert-resolution">
      <CheckCircle2 size={14} />
      <span><strong>事件已通过连续样本自动恢复</strong><small>恢复于 <AlertTime value={episode.resolvedAt} />；确认不会被当作恢复证据。</small></span>
    </div>}

    {episode.status === 'open' && !acknowledgement && canAcknowledge && <div className="observability-alert-actions">
      <span>
        <strong>{mutationsLocked ? '确认入口已锁定' : 'Operator / Admin 确认'}</strong>
        <small>{mutationsLocked ? '先完成人工恢复对账' : '确认只记录处置状态，不会关闭事件'}</small>
      </span>
      <button
        type="button"
        disabled={mutationsLocked || isPending || isSubmitted}
        onClick={() => void onAcknowledge(episode.id)}
      >
        {isPending ? <LoaderCircle className="observability-alert-spin" size={14} /> : isSubmitted ? <Check size={14} /> : mutationsLocked ? <LockKeyhole size={14} /> : <ShieldCheck size={14} />}
        {isPending ? '提交中…' : isSubmitted ? '已提交 · 等待刷新' : submission === 'failed' ? '重试确认' : '确认事件'}
      </button>
    </div>}

    {submission === 'failed' && <div className="observability-alert-submit-error" role="alert">
      <TriangleAlert size={14} />
      <span><strong>确认提交失败</strong><small>事件状态未改变；请核对连接后重试。</small></span>
    </div>}
  </article>
}

function SeverityGlyph({ severity }: { severity: ObservabilityAlertSeverity }) {
  if (severity === 'critical') return <ShieldAlert size={18} />
  if (severity === 'warning') return <TriangleAlert size={18} />
  return <Activity size={18} />
}

function AlertTime({ value }: { value: string | null }) {
  const valid = validTimestamp(value)
  return valid === null
    ? <span className="observability-alert-time-unavailable">时间不可用</span>
    : <time dateTime={valid}>{timeFormatter.format(new Date(valid))}</time>
}

function buildEpisodePresentation(episodes: ObservabilityAlertEpisode[]): EpisodePresentation {
  const open: ObservabilityAlertEpisode[] = []
  const resolved: ObservabilityAlertEpisode[] = []
  const episodesByCode = new Map<string, ObservabilityAlertEpisode[]>()

  for (const episode of episodes) {
    if (episode.status === 'open') open.push(episode)
    else resolved.push(episode)

    const related = episodesByCode.get(episode.code)
    if (related) related.push(episode)
    else episodesByCode.set(episode.code, [episode])
  }

  open.sort((left, right) => severityRank[right.currentSeverity] - severityRank[left.currentSeverity]
    || compareTimestampDescending(left.lastSeenAt, right.lastSeenAt)
    || left.id.localeCompare(right.id))
  resolved.sort((left, right) => compareTimestampDescending(left.resolvedAt, right.resolvedAt)
    || left.id.localeCompare(right.id))

  const recurrenceById = new Map<string, RecurrencePresentation>()
  for (const related of episodesByCode.values()) {
    related.sort((left, right) => compareTimestampAscending(left.openedAt, right.openedAt)
      || left.id.localeCompare(right.id))
    related.forEach((episode, index) => {
      recurrenceById.set(episode.id, {
        ordinal: index + 1,
        total: related.length,
        previous: index > 0 ? related[index - 1]! : null
      })
    })
  }

  return { open, resolved, recurrenceById }
}

function setSubmission(
  setSubmissions: React.Dispatch<React.SetStateAction<ReadonlyMap<string, SubmissionState>>>,
  episodeId: string,
  state: SubmissionState
) {
  setSubmissions((current) => {
    const next = new Map(current)
    next.set(episodeId, state)
    return next
  })
}

function recoveryLabel(
  episode: ObservabilityAlertEpisode,
  recoveryValue: number,
  recoveryMaximum: number
): string {
  if (episode.status === 'resolved') return `已满足 ${recoveryMaximum} 个连续恢复样本`
  if (recoveryValue === 0) return '当前样本仍命中；恢复计数尚未开始'
  return `已连续 ${recoveryValue} / ${recoveryMaximum} 个样本不再命中`
}

function formatTime(value: string | null): string {
  const valid = validTimestamp(value)
  return valid === null ? '不可用' : timeFormatter.format(new Date(valid))
}

function validTimestamp(value: string | null): string | null {
  if (value === null || !Number.isFinite(Date.parse(value))) return null
  return value
}

function compareTimestampAscending(left: string | null, right: string | null): number {
  return timestamp(left) - timestamp(right)
}

function compareTimestampDescending(left: string | null, right: string | null): number {
  return timestamp(right) - timestamp(left)
}

function timestamp(value: string | null): number {
  if (value === null) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function formatCount(value: number): string {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value).toLocaleString('zh-CN') : '不可用'
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum
  return Math.min(maximum, Math.max(minimum, value))
}

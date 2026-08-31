import type { ComponentType } from 'react'
import {
  Activity, Check, CircleMinus, CircleX, Clock3, Cpu, Gauge, HardDrive,
  LockKeyhole, MemoryStick, RotateCw, Save, ShieldCheck, TriangleAlert, Users
} from 'lucide-react'
import { relativeTime } from './format'
import type {
  LateGameQualificationReport, ObservabilityQualificationEnvelope, QualificationCheck,
  QualificationCheckId, QualificationRemainingEvidence, QualificationStatus
} from './model'

export function ObservabilityQualificationPanel({ report, meta, stale, error, busy }: {
  report: LateGameQualificationReport | null
  meta: ObservabilityQualificationEnvelope['meta'] | null
  stale: boolean
  error: string
  busy: boolean
}) {
  const result = report?.result ?? 'insufficient'
  const checksById = new Map(report?.checks.map((check) => [check.id, check]) ?? [])
  const evidence = report?.remainingEvidence ?? qualificationEvidenceIds

  return <section className={`qualification-workspace result-${result}${stale ? ' stale' : ''}`} aria-labelledby="qualification-title">
    <header>
      <div className="qualification-header-mark"><Gauge size={19} /><i /><i /></div>
      <div className="qualification-header-copy">
        <strong id="qualification-title">LATE-GAME 6H TELEMETRY QUALIFICATION</strong>
        <small>{report ? `${report.profileId} · ${relativeTime(report.generatedAt)}` : '尚未取得通过合同校验的报告'}</small>
      </div>
      <div className={`qualification-result result-${result}`}>
        {qualificationStatusIcon(result)}
        <span><small>{stale ? 'STALE / FAIL-CLOSED' : busy ? 'SYNCING / LAST TRUSTED' : 'TELEMETRY RESULT'}</small><strong>{report ? qualificationStatusLabel(result) : '证据不足'}</strong></span>
      </div>
      <b>READ ONLY · ALL ROLES</b>
    </header>

    {error ? <div className="qualification-error" role="alert"><TriangleAlert size={16} /><span><strong>资格报告请求失败</strong><small>{error}；{report ? '保留最后一份通过客户端合同校验的报告，并标记为 stale。' : '没有可信缓存，资格状态保持 fail-closed。'}</small></span></div> : null}

    <div className="qualification-window-deck">
      <QualificationWindowCell label="PROFILE" value={report?.profileId ?? 'UNAVAILABLE'} detail={`${meta?.provider ?? 'provider unknown'} · ${meta?.environment ?? 'environment unknown'}`} />
      <QualificationWindowCell label="SAMPLE WINDOW" value={report ? `${report.sampleCount} / 360` : '— / 360'} detail={report ? `${formatDuration(report.spanMs)} / 6 小时` : '样本与跨度均未验证'} progress={report ? Math.min(100, report.sampleCount / 360 * 100) : 0} status={checkStatus(checksById.get('window.samples'))} />
      <QualificationWindowCell label="TIME SPAN" value={report ? formatDuration(report.spanMs) : 'UNAVAILABLE'} detail={report?.from && report.to ? `${formatClock(report.from)} → ${formatClock(report.to)}` : '未形成可信时间窗'} progress={report ? Math.min(100, report.spanMs / 21_600_000 * 100) : 0} status={checkStatus(checksById.get('window.duration'))} />
      <QualificationWindowCell label="RETAINED CAPACITY" value={meta ? meta.capacity.toLocaleString('zh-CN') : '—'} detail={report ? `${report.checks.length} 项固定检查` : '报告合同未建立'} />
    </div>

    {report ? <div className="qualification-groups">
      {qualificationGroups.map((group) => {
        const Icon = group.icon
        return <section className={`qualification-group ${group.className ?? ''}`} key={group.id}>
          <header><div><Icon size={16} /><span><strong>{group.title}</strong><small>{group.description}</small></span></div><b>{group.ids.length} CHECKS</b></header>
          <div className="qualification-check-grid">
            {group.ids.map((id) => <QualificationCheckCell key={id} check={checksById.get(id)!} />)}
          </div>
        </section>
      })}
    </div> : <div className="qualification-empty"><LockKeyhole size={27} /><span><strong>没有可用于资格判断的可信报告</strong><small>不会用当前瞬时值、目标 UPS 或默认阈值填充六小时证据。下一次只读采样成功且合同完整后才会显示检查矩阵。</small></span></div>}

    <section className="qualification-remaining" aria-labelledby="qualification-remaining-title">
      <header><div><TriangleAlert size={17} /><span><strong id="qualification-remaining-title">遥测通过 ≠ 生产验收</strong><small>以下四项不能由 CPU、UPS、内存或磁盘历史替代，始终是 release blocker。</small></span></div><b>4 REMAINING EVIDENCE</b></header>
      <div>{evidence.map((id) => <RemainingEvidenceCell id={id} key={id} />)}</div>
      <footer><ShieldCheck size={14} /><strong>边界声明</strong><span>即使本报告显示“通过”，也只证明 `late-game-6h-v1` 所列遥测阈值；没有真实存档延迟、重启恢复、崩溃恢复和外部玩家入服浸泡证据时，不得提升为生产已验收。</span></footer>
    </section>
  </section>
}

function QualificationWindowCell({ label, value, detail, progress, status = 'insufficient' }: {
  label: string
  value: string
  detail: string
  progress?: number
  status?: QualificationStatus
}) {
  return <div className={`qualification-window-cell status-${status}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small>{progress !== undefined ? <div><i style={{ width: `${clampPercent(progress)}%` }} /></div> : null}</div>
}

function QualificationCheckCell({ check }: { check: QualificationCheck }) {
  const presentation = qualificationCheckPresentation[check.id]
  const Icon = presentation.icon
  return <article className={`qualification-check status-${check.status}`}>
    <div className="qualification-check-signal">{qualificationStatusIcon(check.status)}</div>
    <div className="qualification-check-copy"><span><Icon size={13} />{presentation.label}</span><strong>{formatCheckObserved(check)}</strong><small>{formatCheckRequirement(check)}</small></div>
    <b>{qualificationStatusLabel(check.status)}</b>
    <div className="qualification-check-fill"><i style={{ width: `${qualificationCheckFill(check)}%` }} /></div>
  </article>
}

function RemainingEvidenceCell({ id }: { id: QualificationRemainingEvidence }) {
  const item = remainingEvidencePresentation[id]
  const Icon = item.icon
  return <article><span className="remaining-evidence-mark"><Icon size={17} /></span><div><strong>{item.label}</strong><small>{item.detail}</small><code>{id}</code></div><b>REQUIRED</b></article>
}

function qualificationStatusIcon(status: QualificationStatus) {
  if (status === 'pass') return <Check size={16} />
  if (status === 'fail') return <CircleX size={16} />
  return <CircleMinus size={16} />
}

function checkStatus(check: QualificationCheck | undefined): QualificationStatus {
  return check?.status ?? 'insufficient'
}

function qualificationStatusLabel(status: QualificationStatus): string {
  return ({ pass: '通过', fail: '失败', insufficient: '证据不足' })[status]
}

function formatCheckObserved(check: QualificationCheck): string {
  const value = numeric(check.observed.value)
  if (value === null) return 'UNAVAILABLE · 证据不足'
  if (check.id === 'window.samples') return `${value.toLocaleString('zh-CN')} 个独立样本`
  if (check.id === 'window.duration') return formatDuration(value)
  if (coverageCheckIds.has(check.id)) {
    const observedSamples = numeric(check.observed.observedSamples)
    const totalSamples = numeric(check.observed.totalSamples)
    return `${formatRatio(value)} · ${observedSamples ?? '—'} / ${totalSamples ?? '—'} 样本`
  }
  if (check.id === 'simulation.ups-floor') {
    return `${formatRatio(value)} 合规 · P05 ${formatUps(check.observed.p05)} · 中位 ${formatUps(check.observed.median)}`
  }
  if (ratioCheckIds.has(check.id)) return `${formatRatio(value)} 时间占比`
  if (percentValueCheckIds.has(check.id)) return `${value.toFixed(1)}%`
  if (byteCheckIds.has(check.id)) return formatBytes(value)
  return String(value)
}

function formatCheckRequirement(check: QualificationCheck): string {
  const required = check.required
  if (check.id === 'window.samples') return `要求 ≥ ${required.minimum} 个样本`
  if (check.id === 'window.duration') return `要求 ≥ ${formatDuration(numeric(required.minimum) ?? 0)}`
  if (coverageCheckIds.has(check.id)) return `可用覆盖率要求 ≥ ${formatRatio(numeric(required.minimumRatio))}`
  if (check.id === 'simulation.ups-floor') return `至少 ${formatRatio(numeric(required.minimumRatio))} 的实测样本达到 ${required.minimumUps} UPS`
  if (check.id === 'runtime.running-coverage') return `运行态覆盖率要求 ≥ ${formatRatio(numeric(required.minimumRatio))}`
  if (check.id === 'health.critical-ratio') return `critical 样本占比要求 ≤ ${formatRatio(numeric(required.maximumRatio))}`
  if (check.id === 'host.hottest-core-saturation') return `最热核心 ≥97% 的样本占比要求 ≤ ${formatRatio(numeric(required.maximumRatio))}`
  if (check.id === 'process.single-core-bottleneck') return `单核瓶颈样本占比要求 ≤ ${formatRatio(numeric(required.maximumRatio))}`
  if (check.id === 'host.cpu-p95') return `主机 CPU P95 要求 ≤ ${required.maximum}%`
  if (check.id === 'host.memory-peak') return `主机内存峰值要求 ≤ ${required.maximum}%`
  if (check.id.endsWith('-peak-used')) return `卷使用率峰值要求 ≤ ${required.maximum}%`
  if (check.id.endsWith('-minimum-free')) return `最低可用空间要求 ≥ ${formatBytes(numeric(required.minimum) ?? 0)}`
  return '固定资格阈值'
}

function qualificationCheckFill(check: QualificationCheck): number {
  const value = numeric(check.observed.value)
  if (value === null || check.status === 'insufficient') return 0
  if (check.id === 'window.samples') return clampPercent(value / 360 * 100)
  if (check.id === 'window.duration') return clampPercent(value / 21_600_000 * 100)
  if (coverageCheckIds.has(check.id) || ratioCheckIds.has(check.id)) return clampPercent(value * 100)
  if (percentValueCheckIds.has(check.id)) return clampPercent(value)
  if (byteCheckIds.has(check.id)) {
    const minimum = numeric(check.required.minimum)
    return minimum && minimum > 0 ? clampPercent(value / minimum * 100) : 0
  }
  return 0
}

function numeric(value: number | string | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function formatRatio(value: number | null): string {
  return value === null ? '不可用' : `${(value * 100).toFixed(1)}%`
}

function formatUps(value: number | string | null | undefined): string {
  const number = numeric(value)
  return number === null ? '不可用' : `${number.toFixed(1)} UPS`
}

function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '不可用'
  const totalMinutes = Math.floor(milliseconds / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${hours} 小时 ${minutes} 分`
}

function formatClock(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '不可用'
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 ** 2) return `${(bytes / 1_024).toFixed(1)} KiB`
  if (bytes < 1_024 ** 3) return `${(bytes / 1_024 ** 2).toFixed(1)} MiB`
  return `${(bytes / 1_024 ** 3).toFixed(2)} GiB`
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

const ratioCheckIds = new Set<QualificationCheckId>([
  'runtime.running-coverage', 'health.critical-ratio',
  'host.hottest-core-saturation', 'process.single-core-bottleneck'
])

const coverageCheckIds = new Set<QualificationCheckId>([
  'simulation.ups-coverage', 'host.cpu-coverage', 'host.per-core-coverage',
  'process.multicore-coverage', 'host.memory-coverage',
  'storage.project-coverage', 'storage.save-coverage'
])

const percentValueCheckIds = new Set<QualificationCheckId>([
  'host.cpu-p95', 'host.memory-peak', 'storage.project-peak-used', 'storage.save-peak-used'
])

const byteCheckIds = new Set<QualificationCheckId>([
  'storage.project-minimum-free', 'storage.save-minimum-free'
])

const qualificationEvidenceIds: QualificationRemainingEvidence[] = [
  'SAVE_LATENCY_DRILL_REQUIRED',
  'REBOOT_RECOVERY_DRILL_REQUIRED',
  'CRASH_RECOVERY_DRILL_REQUIRED',
  'EXTERNAL_JOIN_SOAK_REQUIRED'
]

const qualificationGroups: Array<{
  id: string
  title: string
  description: string
  icon: ComponentType<{ size?: number }>
  ids: QualificationCheckId[]
  className?: string
}> = [
  {
    id: 'runtime', title: '窗口、运行态与健康覆盖', icon: Activity,
    description: '固定 6 小时、样本数量、运行率和 critical 占比',
    ids: ['window.samples', 'window.duration', 'runtime.running-coverage', 'health.critical-ratio'],
    className: 'wide'
  },
  {
    id: 'ups', title: '实测 UPS 资格', icon: Gauge,
    description: '只使用上游实际 UPS，不使用 target UPS 代替',
    ids: ['simulation.ups-coverage', 'simulation.ups-floor']
  },
  {
    id: 'cpu', title: '主机 CPU 与最热核心', icon: Cpu,
    description: '主机总量 P95、按核覆盖与持续饱和占比',
    ids: ['host.cpu-coverage', 'host.cpu-p95', 'host.per-core-coverage', 'host.hottest-core-saturation']
  },
  {
    id: 'multicore', title: 'DSP 多核与单核瓶颈', icon: Activity,
    description: '进程核等值覆盖与单核围观模式占比',
    ids: ['process.multicore-coverage', 'process.single-core-bottleneck']
  },
  {
    id: 'memory', title: '主机内存压力', icon: MemoryStick,
    description: '运行样本覆盖与窗口内峰值',
    ids: ['host.memory-coverage', 'host.memory-peak']
  },
  {
    id: 'project-volume', title: '项目卷容量', icon: HardDrive,
    description: '项目所在卷覆盖、峰值使用率与最低可用空间',
    ids: ['storage.project-coverage', 'storage.project-peak-used', 'storage.project-minimum-free']
  },
  {
    id: 'save-volume', title: '存档卷容量', icon: HardDrive,
    description: '存档所在卷覆盖、峰值使用率与最低可用空间',
    ids: ['storage.save-coverage', 'storage.save-peak-used', 'storage.save-minimum-free']
  }
]

const qualificationCheckPresentation: Record<QualificationCheckId, {
  label: string
  icon: ComponentType<{ size?: number }>
}> = {
  'window.samples': { label: '独立样本数量', icon: Activity },
  'window.duration': { label: '采样时间跨度', icon: Clock3 },
  'runtime.running-coverage': { label: '运行态覆盖率', icon: Activity },
  'health.critical-ratio': { label: 'critical 健康占比', icon: ShieldCheck },
  'simulation.ups-coverage': { label: '实际 UPS 覆盖率', icon: Gauge },
  'simulation.ups-floor': { label: 'UPS ≥55 合规率', icon: Gauge },
  'host.cpu-coverage': { label: '主机 CPU 覆盖率', icon: Cpu },
  'host.cpu-p95': { label: '主机 CPU P95', icon: Cpu },
  'host.per-core-coverage': { label: '按核 CPU 覆盖率', icon: Cpu },
  'host.hottest-core-saturation': { label: '最热核心饱和占比', icon: Cpu },
  'process.multicore-coverage': { label: 'DSP 多核样本覆盖', icon: Activity },
  'process.single-core-bottleneck': { label: '单核瓶颈占比', icon: Activity },
  'host.memory-coverage': { label: '内存指标覆盖率', icon: MemoryStick },
  'host.memory-peak': { label: '内存使用峰值', icon: MemoryStick },
  'storage.project-coverage': { label: '项目卷指标覆盖', icon: HardDrive },
  'storage.project-peak-used': { label: '项目卷使用峰值', icon: HardDrive },
  'storage.project-minimum-free': { label: '项目卷最低空闲', icon: HardDrive },
  'storage.save-coverage': { label: '存档卷指标覆盖', icon: HardDrive },
  'storage.save-peak-used': { label: '存档卷使用峰值', icon: HardDrive },
  'storage.save-minimum-free': { label: '存档卷最低空闲', icon: HardDrive }
}

const remainingEvidencePresentation: Record<QualificationRemainingEvidence, {
  label: string
  detail: string
  icon: ComponentType<{ size?: number }>
}> = {
  SAVE_LATENCY_DRILL_REQUIRED: {
    label: '真实存档延迟演练', detail: '在大后期真实存档上记录保存耗时、完成回执与超时边界。', icon: Save
  },
  REBOOT_RECOVERY_DRILL_REQUIRED: {
    label: '重启恢复演练', detail: '验证 VM/Windows 重启后任务、进程、端口和存档身份恢复。', icon: RotateCw
  },
  CRASH_RECOVERY_DRILL_REQUIRED: {
    label: '崩溃恢复演练', detail: '验证异常退出后的事务对账、保护点与人工恢复边界。', icon: TriangleAlert
  },
  EXTERNAL_JOIN_SOAK_REQUIRED: {
    label: '外部玩家入服浸泡', detail: '从真实外部网络持续加入并验证联机、稳定性与版本一致性。', icon: Users
  }
}

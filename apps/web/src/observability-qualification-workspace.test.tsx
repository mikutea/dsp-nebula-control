// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ObservabilityQualificationPanel } from './ObservabilityQualificationPanel'
import {
  makeQualificationInsufficient, qualificationEnvelopeFixture
} from './observability-qualification.fixture'

afterEach(() => cleanup())

describe('observability qualification panel', () => {
  it('renders the fixed six-hour matrix and all four non-telemetry release blockers read-only', () => {
    const fixture = qualificationEnvelopeFixture()
    const view = render(<ObservabilityQualificationPanel
      report={fixture.data}
      meta={fixture.meta}
      stale={false}
      error=""
      busy={false}
    />)

    expect(screen.getAllByText('late-game-6h-v1').length).toBeGreaterThan(0)
    expect(screen.getByText('361 / 360')).toBeTruthy()
    expect(screen.getByText('6 小时 0 分 / 6 小时')).toBeTruthy()
    expect(screen.getByText('实测 UPS 资格')).toBeTruthy()
    expect(screen.getByText('实测 TPS 资格')).toBeTruthy()
    expect(screen.getByText('TPS ≥55 合规率')).toBeTruthy()
    expect(screen.getByText(/P05 57\.9 TPS/)).toBeTruthy()
    expect(screen.getByText('主机 CPU 与最热核心')).toBeTruthy()
    expect(screen.getByText('DSP 多核与单核瓶颈')).toBeTruthy()
    expect(screen.getByText('主机内存压力')).toBeTruthy()
    expect(screen.getByText('项目卷容量')).toBeTruthy()
    expect(screen.getByText('存档卷容量')).toBeTruthy()
    expect(screen.getByText('72H CONTINUITY & TRUSTED LATENCY')).toBeTruthy()
    expect(screen.getByText('17,281 / 17,281')).toBeTruthy()
    expect(screen.getByText('VERIFIED')).toBeTruthy()
    expect(screen.getByText(/P50 4\.0 s · P95 8\.0 s · MAX 8\.0 s/)).toBeTruthy()
    expect(screen.getByText(/成功 4 · 失败 1 · 未完成 0 · NOT QUALIFIED/)).toBeTruthy()
    expect(screen.getByText('项目根与 SMB 自动恢复')).toBeTruthy()
    expect(screen.getByText('24.00 GiB')).toBeTruthy()
    expect(screen.getByText('42.00 GiB')).toBeTruthy()
    expect(screen.getByText('SAVE_LATENCY_DRILL_REQUIRED')).toBeTruthy()
    expect(screen.getByText('REBOOT_RECOVERY_DRILL_REQUIRED')).toBeTruthy()
    expect(screen.getByText('CRASH_RECOVERY_DRILL_REQUIRED')).toBeTruthy()
    expect(screen.getByText('EXTERNAL_JOIN_SOAK_REQUIRED')).toBeTruthy()
    expect(screen.getByText('遥测通过 ≠ 生产验收')).toBeTruthy()
    expect(within(view.container.querySelector('.qualification-workspace')!).queryAllByRole('button')).toHaveLength(0)
  })

  it('renders missing per-core evidence as insufficient and never as pass', () => {
    const fixture = makeQualificationInsufficient(
      qualificationEnvelopeFixture(),
      'host.per-core-coverage'
    )
    render(<ObservabilityQualificationPanel
      report={fixture.data}
      meta={fixture.meta}
      stale={false}
      error=""
      busy={false}
    />)

    const check = screen.getByText('按核 CPU 覆盖率').closest('article')
    expect(check).not.toBeNull()
    expect(check!.classList.contains('status-insufficient')).toBe(true)
    expect(within(check!).getByText('UNAVAILABLE · 证据不足')).toBeTruthy()
    expect(within(check!).queryByText('通过')).toBeNull()
    expect(screen.getAllByText('证据不足').length).toBeGreaterThan(0)
  })

  it('keeps the qualification fail-closed when no trusted report exists', () => {
    render(<ObservabilityQualificationPanel
      report={null}
      meta={null}
      stale
      error="观测资格报告暂不可用"
      busy={false}
    />)

    expect(screen.getByText('STALE / FAIL-CLOSED')).toBeTruthy()
    expect(screen.getByText('没有可用于资格判断的可信报告')).toBeTruthy()
    expect(screen.getByText(/没有可信缓存，资格状态保持 fail-closed/)).toBeTruthy()
    expect(screen.getByText('SAVE_LATENCY_DRILL_REQUIRED')).toBeTruthy()
    expect(screen.getByText('REBOOT_RECOVERY_DRILL_REQUIRED')).toBeTruthy()
    expect(screen.getByText('CRASH_RECOVERY_DRILL_REQUIRED')).toBeTruthy()
    expect(screen.getByText('EXTERNAL_JOIN_SOAK_REQUIRED')).toBeTruthy()
    expect(screen.queryByText('通过')).toBeNull()
  })

  it('shows unknown latency instead of manufacturing zero when no trusted receipt exists', () => {
    const fixture = qualificationEnvelopeFixture()
    for (const summary of [fixture.data.latency.save, fixture.data.latency.backup]) {
      summary.evidenceStatus = 'unknown'
      summary.totalReceipts = 0
      summary.successfulReceipts = 0
      summary.failedReceipts = 0
      summary.incompleteReceipts = 0
      summary.p50Ms = null
      summary.p95Ms = null
      summary.maximumMs = null
    }
    fixture.data.latency.evidenceStatus = 'unknown'
    fixture.data.latency.scannedJobs = 0
    render(<ObservabilityQualificationPanel
      report={fixture.data}
      meta={fixture.meta}
      stale={false}
      error=""
      busy={false}
    />)

    expect(screen.getAllByText('UNKNOWN · NOT QUALIFIED')).toHaveLength(2)
    expect(screen.getAllByText('没有可信服务端回执；不会显示 0 ms')).toHaveLength(2)
    expect(screen.queryByText(/P50 0/)).toBeNull()
  })

  it('surfaces a bounded latency scan and does not present partial percentiles', () => {
    const fixture = qualificationEnvelopeFixture()
    fixture.data.latency.evidenceStatus = 'unknown'
    fixture.data.latency.scannedJobs = 5_000
    fixture.data.latency.truncated = true
    render(<ObservabilityQualificationPanel
      report={fixture.data}
      meta={fixture.meta}
      stale={false}
      error=""
      busy={false}
    />)

    expect(screen.getAllByText('TRUNCATED · NOT QUALIFIED')).toHaveLength(2)
    expect(screen.getAllByText(/仅扫描最新 5,000 个任务/)).toHaveLength(2)
    expect(screen.queryByText(/P50 4\.0 s/)).toBeNull()
  })
})

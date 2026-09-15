// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ObservabilityAlertPanel,
  type ObservabilityAlertEpisode,
  type ObservabilityAlertProjection
} from './ObservabilityAlertPanel'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('observability alert panel', () => {
  it('groups open and resolved episodes while keeping viewers read-only and public-field only', () => {
    const projection = projectionFixture()
    Object.assign(projection.episodes[1]!, {
      relatedMetrics: ['C:\\fictional-private\\host.metric'],
      rawMetric: '99.9%',
      html: '<img src=x onerror=alert(1)>'
    })
    const acknowledge = vi.fn(async () => undefined)
    const view = render(<ObservabilityAlertPanel
      projection={projection}
      recoveryRequired={false}
      canAcknowledge={false}
      onAcknowledge={acknowledge}
    />)

    expect(screen.getByText('开放事件')).toBeTruthy()
    expect(screen.getByText('已恢复事件')).toBeTruthy()
    expect(screen.getByText('VIEWER / READ ONLY')).toBeTruthy()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(acknowledge).not.toHaveBeenCalled()

    const openCard = within(screen.getByRole('region', { name: '开放事件' }))
      .getByLabelText('HOST_CPU_PRESSURE 告警事件')
    expect(within(openCard).getByText('第 2 / 2 次')).toBeTruthy()
    expect(within(openCard).getByText('未确认')).toBeTruthy()
    expect(openCard.querySelector('.observability-alert-severity-warning')?.textContent).toBe('警告')
    const progress = within(openCard).getByRole('progressbar')
    expect(progress.getAttribute('aria-valuenow')).toBe('1')
    expect(progress.getAttribute('aria-valuemax')).toBe('3')
    expect(view.container.textContent).not.toContain('fictional-private')
    expect(view.container.textContent).not.toContain('99.9%')
    expect(view.container.textContent).not.toContain('<img')
    expect(view.container.querySelector('img')).toBeNull()
  })

  it('lets an Operator or Admin acknowledge an open episode and waits for projection refresh', async () => {
    const acknowledge = vi.fn(async (_episodeId: string) => undefined)
    render(<ObservabilityAlertPanel
      projection={openOnlyProjection()}
      recoveryRequired={false}
      canAcknowledge
      onAcknowledge={acknowledge}
    />)

    fireEvent.click(screen.getByRole('button', { name: '确认事件' }))

    await waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(1))
    expect(acknowledge).toHaveBeenCalledWith('alert-host-cpu-002')
    const submitted = await screen.findByRole('button', { name: '已提交 · 等待刷新' }) as HTMLButtonElement
    expect(submitted.disabled).toBe(true)
    expect(screen.getByText('确认只记录处置状态，不会关闭事件')).toBeTruthy()
  })

  it('deduplicates repeated clicks while the acknowledgement request is pending', async () => {
    const request = deferred<void>()
    const acknowledge = vi.fn((_episodeId: string) => request.promise)
    render(<ObservabilityAlertPanel
      projection={openOnlyProjection()}
      recoveryRequired={false}
      canAcknowledge
      onAcknowledge={acknowledge}
    />)

    const button = screen.getByRole('button', { name: '确认事件' })
    fireEvent.click(button)
    fireEvent.click(button)

    expect(acknowledge).toHaveBeenCalledTimes(1)
    expect((screen.getByRole('button', { name: '提交中…' }) as HTMLButtonElement).disabled).toBe(true)

    await act(async () => request.resolve())
    expect(screen.getByRole('button', { name: '已提交 · 等待刷新' })).toBeTruthy()
  })

  it('shows a bounded failure state without leaking rejection details and permits retry', async () => {
    const acknowledge = vi.fn()
      .mockRejectedValueOnce(new Error('C:\\fictional-private\\raw-metric.json'))
      .mockResolvedValueOnce(undefined)
    render(<ObservabilityAlertPanel
      projection={openOnlyProjection()}
      recoveryRequired={false}
      canAcknowledge
      onAcknowledge={acknowledge}
    />)

    fireEvent.click(screen.getByRole('button', { name: '确认事件' }))

    const failure = await screen.findByRole('alert')
    expect(failure.textContent).toContain('确认提交失败')
    expect(failure.textContent).toContain('事件状态未改变')
    expect(failure.textContent).not.toContain('fictional-private')

    fireEvent.click(screen.getByRole('button', { name: '重试确认' }))
    await waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('button', { name: '已提交 · 等待刷新' })).toBeTruthy()
  })

  it('locks acknowledgement fail-closed while durable alert recovery is required', () => {
    const acknowledge = vi.fn(async () => undefined)
    render(<ObservabilityAlertPanel
      projection={openOnlyProjection()}
      recoveryRequired
      canAcknowledge
      onAcknowledge={acknowledge}
    />)

    expect(screen.getByRole('alert').textContent).toContain('持久告警状态需要人工恢复')
    expect(screen.getByText('RECOVERY REQUIRED')).toBeTruthy()
    const button = screen.getByRole('button', { name: '确认事件' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(acknowledge).not.toHaveBeenCalled()
  })

  it('renders resolved episodes as read-only history with acknowledgement and recovery times', () => {
    const projection = projectionFixture()
    projection.episodes = [projection.episodes[0]!]
    const acknowledge = vi.fn(async () => undefined)
    const view = render(<ObservabilityAlertPanel
      projection={projection}
      recoveryRequired={false}
      canAcknowledge
      onAcknowledge={acknowledge}
    />)

    expect(screen.getByText('当前投影没有开放事件')).toBeTruthy()
    expect(screen.getByText('fictional.operator')).toBeTruthy()
    expect(screen.getByText('事件已通过连续样本自动恢复')).toBeTruthy()
    expect(screen.getByText('COMPLETE')).toBeTruthy()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(view.container.querySelector('time[datetime="2026-08-31T10:03:00.000Z"]')).not.toBeNull()
    expect(view.container.querySelector('time[datetime="2026-08-31T10:04:00.000Z"]')).not.toBeNull()
  })

  it('does not update React state when a pending acknowledgement settles after unmount', async () => {
    const request = deferred<void>()
    const acknowledge = vi.fn(() => request.promise)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const view = render(<ObservabilityAlertPanel
      projection={openOnlyProjection()}
      recoveryRequired={false}
      canAcknowledge
      onAcknowledge={acknowledge}
    />)

    fireEvent.click(screen.getByRole('button', { name: '确认事件' }))
    expect(acknowledge).toHaveBeenCalledTimes(1)
    view.unmount()

    await act(async () => request.resolve())
    expect(consoleError).not.toHaveBeenCalled()
  })
})

function projectionFixture(): ObservabilityAlertProjection {
  return {
    schemaVersion: 1,
    kind: 'observability-alert-episode-projection',
    observedThrough: '2026-08-31T10:06:00.000Z',
    capacity: 256,
    resolveAfterMissingSamples: 3,
    episodes: [
      {
        id: 'alert-host-cpu-001',
        code: 'HOST_CPU_PRESSURE',
        status: 'resolved',
        currentSeverity: 'warning',
        severityHistory: [{ severity: 'warning', changedAt: '2026-08-31T10:00:00.000Z' }],
        openedAt: '2026-08-31T10:00:00.000Z',
        lastSeenAt: '2026-08-31T10:01:00.000Z',
        observationCount: 2,
        consecutiveMissingSamples: 3,
        acknowledgement: {
          actor: 'fictional.operator',
          acknowledgedAt: '2026-08-31T10:03:00.000Z'
        },
        resolvedAt: '2026-08-31T10:04:00.000Z'
      },
      openEpisode()
    ]
  }
}

function openOnlyProjection(): ObservabilityAlertProjection {
  return { ...projectionFixture(), episodes: [openEpisode()] }
}

function openEpisode(): ObservabilityAlertEpisode {
  return {
    id: 'alert-host-cpu-002',
    code: 'HOST_CPU_PRESSURE',
    status: 'open',
    currentSeverity: 'warning',
    severityHistory: [
      { severity: 'info', changedAt: '2026-08-31T10:05:00.000Z' },
      { severity: 'warning', changedAt: '2026-08-31T10:05:30.000Z' }
    ],
    openedAt: '2026-08-31T10:05:00.000Z',
    lastSeenAt: '2026-08-31T10:05:30.000Z',
    observationCount: 2,
    consecutiveMissingSamples: 1,
    acknowledgement: null,
    resolvedAt: null
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

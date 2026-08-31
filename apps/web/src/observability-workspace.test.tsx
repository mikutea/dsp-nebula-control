// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServerObservabilityWorkspace } from './App'
import { api, ApiError } from './api'
import { qualificationEnvelopeFixture } from './observability-qualification.fixture'
import type {
  ObservabilityAlertEnvelope, ObservabilityAlertEpisode,
  ObservabilityDownsampleResult, ServerObservabilitySnapshot
} from './model'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('server observability workspace polling', () => {
  it('polls serially on a bounded interval and stops scheduling after unmount', async () => {
    vi.useFakeTimers()
    const snapshot = vi.spyOn(api, 'observabilitySnapshot').mockResolvedValue({
      data: snapshotFixture(),
      meta: { provider: 'windows', environment: 'test', retainedSamples: 1, capacity: 720 }
    })
    const history = vi.spyOn(api, 'observabilityHistory').mockResolvedValue({
      data: historyFixture(),
      meta: { provider: 'windows', environment: 'test', capacity: 720 }
    })
    const qualification = vi.spyOn(api, 'observabilityQualification')
      .mockResolvedValue(qualificationEnvelopeFixture())
    const alerts = vi.spyOn(api, 'observabilityAlerts').mockResolvedValue(alertEnvelopeFixture())

    const view = render(<ServerObservabilityWorkspace />)
    await act(async () => { await Promise.resolve() })
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(history).toHaveBeenCalledTimes(1)
    expect(qualification).toHaveBeenCalledTimes(1)
    expect(alerts).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(snapshot).toHaveBeenCalledTimes(2)
    expect(history).toHaveBeenCalledTimes(2)
    expect(qualification).toHaveBeenCalledTimes(2)
    expect(alerts).toHaveBeenCalledTimes(2)

    view.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(snapshot).toHaveBeenCalledTimes(2)
    expect(history).toHaveBeenCalledTimes(2)
    expect(qualification).toHaveBeenCalledTimes(2)
    expect(alerts).toHaveBeenCalledTimes(2)
  })

  it('aborts active telemetry reads when the workspace unmounts', async () => {
    const signals: AbortSignal[] = []
    vi.spyOn(api, 'observabilitySnapshot').mockImplementation((signal) => {
      if (signal) signals.push(signal)
      return new Promise(() => undefined)
    })
    vi.spyOn(api, 'observabilityHistory').mockImplementation((_points, signal) => {
      if (signal) signals.push(signal)
      return new Promise(() => undefined)
    })
    vi.spyOn(api, 'observabilityQualification').mockImplementation((signal) => {
      if (signal) signals.push(signal)
      return new Promise(() => undefined)
    })
    vi.spyOn(api, 'observabilityAlerts').mockImplementation((signal) => {
      if (signal) signals.push(signal)
      return new Promise(() => undefined)
    })

    const view = render(<ServerObservabilityWorkspace />)
    await act(async () => { await Promise.resolve() })
    expect(signals).toHaveLength(4)
    expect(signals.every((signal) => !signal.aborted)).toBe(true)

    view.unmount()
    expect(signals.every((signal) => signal.aborted)).toBe(true)
  })

  it('preserves the last trusted qualification report and marks it stale after a refresh failure', async () => {
    vi.spyOn(api, 'observabilitySnapshot').mockResolvedValue({
      data: snapshotFixture(),
      meta: { provider: 'windows', environment: 'test', retainedSamples: 1, capacity: 720 }
    })
    vi.spyOn(api, 'observabilityHistory').mockResolvedValue({
      data: historyFixture(),
      meta: { provider: 'windows', environment: 'test', capacity: 720 }
    })
    const qualification = vi.spyOn(api, 'observabilityQualification')
      .mockResolvedValueOnce(qualificationEnvelopeFixture())
      .mockRejectedValueOnce(new ApiError(
        503,
        '观测资格报告暂不可用；最后可信报告保持只读。',
        'OBSERVABILITY_QUALIFICATION_UNAVAILABLE'
      ))
    vi.spyOn(api, 'observabilityAlerts').mockResolvedValue(alertEnvelopeFixture())

    render(<ServerObservabilityWorkspace />)
    expect(await screen.findByText('SAVE_LATENCY_DRILL_REQUIRED')).toBeTruthy()
    await waitFor(() => expect((screen.getByRole('button', { name: '立即采样' }) as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(screen.getByRole('button', { name: '立即采样' }))

    expect(await screen.findByText('STALE / FAIL-CLOSED')).toBeTruthy()
    expect(screen.getAllByText('late-game-6h-v1').length).toBeGreaterThan(0)
    expect(screen.getByText(/OBSERVABILITY_QUALIFICATION_UNAVAILABLE/)).toBeTruthy()
    expect(qualification).toHaveBeenCalledTimes(2)
  })

  it('routes an authorized acknowledgement through the fixed alert API and refreshes the episode projection', async () => {
    vi.spyOn(api, 'observabilitySnapshot').mockResolvedValue({
      data: snapshotFixture(),
      meta: { provider: 'windows', environment: 'test', retainedSamples: 1, capacity: 720 }
    })
    vi.spyOn(api, 'observabilityHistory').mockResolvedValue({
      data: historyFixture(),
      meta: { provider: 'windows', environment: 'test', capacity: 720 }
    })
    vi.spyOn(api, 'observabilityQualification').mockResolvedValue(qualificationEnvelopeFixture())
    const alerts = alertEnvelopeFixture(openAlertFixture())
    vi.spyOn(api, 'observabilityAlerts').mockResolvedValue(alerts)
    const acknowledged = {
      ...alerts.data.episodes[0]!,
      acknowledgement: {
        actor: 'fictional.operator',
        acknowledgedAt: '2026-08-30T12:01:00.000Z'
      }
    }
    const acknowledge = vi.spyOn(api, 'acknowledgeObservabilityAlert')
      .mockResolvedValue({ data: acknowledged })

    render(<ServerObservabilityWorkspace canAcknowledge />)
    fireEvent.click(await screen.findByRole('button', { name: '确认事件' }))

    await waitFor(() => expect(acknowledge).toHaveBeenCalledWith('alert-host-cpu-001'))
    expect(await screen.findByText('fictional.operator')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '已提交 · 等待刷新' })).toBeNull()
  })
})

function snapshotFixture(): ServerObservabilitySnapshot {
  const unavailable = { status: 'unavailable' as const, reason: 'not-provided' as const }
  return {
    schemaVersion: 1,
    kind: 'server-observability-snapshot',
    observedAt: '2026-08-30T12:00:00.000Z',
    source: 'windows.server-status',
    runtime: {
      state: 'running',
      processId: { status: 'available', value: 4242 },
      gamePort: {
        port: { status: 'available', value: 8469 },
        listening: { status: 'available', value: true }
      }
    },
    host: {
      cpu: {
        logicalProcessorCount: { status: 'available', value: 16 },
        totalPercent: { status: 'available', value: 25 },
        perCorePercent: unavailable
      },
      memory: {
        totalBytes: { status: 'available', value: 64 * 1_024 ** 3 },
        availableBytes: { status: 'available', value: 40 * 1_024 ** 3 },
        usedBytes: { status: 'available', value: 24 * 1_024 ** 3 },
        usedPercent: { status: 'available', value: 37.5 }
      }
    },
    process: {
      cpuPercent: unavailable,
      cpuCoresUsed: { status: 'available', value: 2.5 },
      workingSetBytes: { status: 'available', value: 6 * 1_024 ** 3 },
      privateBytes: { status: 'available', value: 7 * 1_024 ** 3 },
      threadCount: { status: 'available', value: 240 }
    },
    simulation: {
      ups: unavailable,
      tps: unavailable,
      targetUps: { status: 'available', value: 60 }
    },
    health: {
      status: 'healthy',
      hints: [{
        code: 'SIMULATION_TELEMETRY_UNAVAILABLE',
        severity: 'info',
        message: 'Actual simulation telemetry is unavailable.',
        relatedMetrics: ['simulation.ups', 'simulation.tps']
      }],
      unavailableMetrics: [
        'host.cpu.perCorePercent', 'process.cpuPercent', 'simulation.ups', 'simulation.tps'
      ]
    }
  }
}

function historyFixture(): ObservabilityDownsampleResult {
  return {
    schemaVersion: 1,
    kind: 'server-observability-downsample',
    retainedSamples: 1,
    droppedSamples: 0,
    points: []
  }
}

function alertEnvelopeFixture(...episodes: ObservabilityAlertEpisode[]): ObservabilityAlertEnvelope {
  return {
    data: {
      schemaVersion: 1 as const,
      kind: 'observability-alert-episode-projection' as const,
      observedThrough: '2026-08-30T12:00:00.000Z',
      capacity: 256,
      resolveAfterMissingSamples: 3,
      episodes
    },
    meta: { recoveryRequired: false }
  }
}

function openAlertFixture(): ObservabilityAlertEpisode {
  return {
    id: 'alert-host-cpu-001',
    code: 'HOST_CPU_PRESSURE',
    status: 'open',
    currentSeverity: 'warning',
    severityHistory: [{ severity: 'warning', changedAt: '2026-08-30T12:00:00.000Z' }],
    openedAt: '2026-08-30T12:00:00.000Z',
    lastSeenAt: '2026-08-30T12:00:00.000Z',
    observationCount: 1,
    consecutiveMissingSamples: 0,
    acknowledgement: null,
    resolvedAt: null
  }
}

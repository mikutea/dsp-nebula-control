// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { api } from './api'
import type { JobRecord, LifecyclePreview, ServerStatus, SessionUser } from './model'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('lifecycle workspace preflight contract', () => {
  it('renders managed session checks and keeps a blocked lifecycle broker fail-closed', async () => {
    vi.stubGlobal('EventSource', class {
      addEventListener() {}
      close() {}
    })
    vi.spyOn(api, 'session').mockResolvedValue({ user: operator() })
    vi.spyOn(api, 'status').mockResolvedValue({
      data: statusFixture(),
      meta: { provider: 'windows', environment: 'test' }
    })
    vi.spyOn(api, 'jobs').mockResolvedValue({ data: [] })
    const previewLifecycle = vi.spyOn(api, 'previewLifecycle').mockResolvedValue({
      data: { job: previewJob(), preview: blockedStartPreview() }
    })
    const executeLifecycle = vi.spyOn(api, 'executeLifecycle')

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: '游戏管理' }))
    fireEvent.click(await screen.findByRole('button', { name: '运行只读预检' }))

    await waitFor(() => expect(previewLifecycle).toHaveBeenCalledWith('start'))
    expect(await screen.findByText('受管交互会话')).not.toBeNull()
    expect(screen.getByText('Steam 登录会话')).not.toBeNull()

    const brokerLabel = screen.getByText('SYSTEM 生命周期代理')
    const brokerCheck = brokerLabel.parentElement
    expect(brokerCheck).not.toBeNull()
    expect(within(brokerCheck!).getByText('阻断')).not.toBeNull()
    expect(within(brokerCheck!).queryByText('通过')).toBeNull()
    expect(brokerLabel.closest('[hidden], [aria-hidden="true"]')).toBeNull()

    expect(screen.getByText('保持锁定 · 1 项阻断')).not.toBeNull()
    expect(screen.queryByText('证据就绪 · 可确认执行')).toBeNull()
    expect(screen.queryByRole('button', { name: '进入执行确认' })).toBeNull()
    expect(executeLifecycle).not.toHaveBeenCalled()
  })
})

function operator(): SessionUser {
  return {
    name: 'Fictional Operator',
    role: 'operator',
    permissions: ['status.read', 'status.refresh', 'jobs.read', 'lifecycle.preview', 'lifecycle.execute']
  }
}

function statusFixture(): ServerStatus {
  return {
    collectedAt: '2026-09-01T08:00:00.000Z',
    serverName: 'Fictional DSP',
    state: 'stopped',
    runtime: {
      targetUps: 60,
      onlinePlayers: 0,
      maxPlayers: 16,
      processId: null,
      processCoresUsed: null,
      workingSetGiB: null,
      privateMemoryGiB: null,
      threadCount: null,
      priority: null,
      startedAt: null,
      uptimeSeconds: null
    },
    host: {
      logicalProcessors: 16,
      processorGroups: 1,
      cpuPercent: 3,
      memoryTotalGiB: 64,
      memoryFreeGiB: 48
    },
    versions: {
      dsp: '0.0.0-fictional',
      nebula: '0.0.0-fictional',
      bepInEx: '0.0.0-fictional',
      compatible: true,
      gameLoaded: false,
      warnings: []
    },
    save: {
      name: 'FictionalSave',
      dsvPresent: true,
      serverPresent: true,
      consistent: true,
      lastSavedAt: '2026-09-01T07:30:00.000Z',
      dsvSizeMiB: 8,
      serverSizeKiB: 64,
      latestBackupAt: '2026-09-01T07:45:00.000Z',
      backupManifestPresent: true,
      backupPairPresent: true
    },
    automation: {
      serverTask: { state: 'ready', lastResult: 0, lastRunAt: null },
      stopTask: { state: 'ready', lastResult: 0, lastRunAt: null },
      storageTask: { state: 'ready', lastResult: 0, lastRunAt: null },
      projectRootAvailable: true,
      globalMappingAvailable: true
    },
    connections: [],
    capabilities: { refresh: true, start: true, save: false, gracefulStop: false, restart: false }
  }
}

function previewJob(): JobRecord {
  return {
    id: 'job-fictional-start-preview',
    kind: 'game.start.preview',
    state: 'succeeded',
    actor: 'Fictional Operator',
    createdAt: '2026-09-01T08:00:01.000Z',
    startedAt: '2026-09-01T08:00:01.000Z',
    finishedAt: '2026-09-01T08:00:02.000Z',
    durationMs: 1_000,
    summary: 'Fictional start preflight collected',
    errorCode: null
  }
}

function blockedStartPreview(): LifecyclePreview {
  return {
    collectedAt: '2026-09-01T08:00:02.000Z',
    action: 'start',
    mode: 'dry-run',
    allowed: false,
    executionEnabled: true,
    checks: [
      { id: 'interactive-session', status: 'pass', message: 'Fictional managed session verified' },
      { id: 'steam-session', status: 'pass', message: 'Fictional Steam session verified' },
      { id: 'lifecycle-broker', status: 'block', message: 'Fictional SYSTEM broker unavailable' }
    ],
    blockers: ['lifecycle-broker-unavailable'],
    rollback: { strategy: 'no-op', ready: true, summary: 'No host mutation has started' }
  }
}

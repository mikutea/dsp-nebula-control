// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Metric, OverviewLifecycleActions, SavePanel } from './App'
import type { ServerStatus } from './model'

afterEach(cleanup)

describe('overview lifecycle actions', () => {
  it('does not render a synthetic trend when only a current Windows snapshot is available', () => {
    render(<Metric title="CPU" value="2.5 核" sub="进程平均占用" color="cyan" />)
    expect(screen.getByLabelText('当前仅有单点快照')).not.toBeNull()
    expect(screen.getByText('当前快照 · 暂无历史趋势')).not.toBeNull()
  })

  it('routes both save overview actions into the real save workspace and respects backup permission', () => {
    const onOpenSaves = vi.fn()
    const { rerender } = render(<SavePanel status={{ save: saveFixture }} onOpenSaves={onOpenSaves} canBackup={false} />)
    fireEvent.click(screen.getByRole('button', { name: '管理存档' }))
    expect(onOpenSaves).toHaveBeenCalledTimes(1)
    expect((screen.getByRole('button', { name: '进入备份预演' }) as HTMLButtonElement).disabled).toBe(true)

    rerender(<SavePanel status={{ save: saveFixture }} onOpenSaves={onOpenSaves} canBackup />)
    fireEvent.click(screen.getByRole('button', { name: '进入备份预演' }))
    expect(onOpenSaves).toHaveBeenCalledTimes(2)
  })

  it('routes a stopped Windows instance to the unified start workflow', () => {
    const onLifecycleAction = vi.fn()
    render(<OverviewLifecycleActions
      status={statusFixture('stopped')}
      provider="windows"
      refreshing={false}
      onRefresh={() => undefined}
      onLifecycleAction={onLifecycleAction}
    />)

    expect(button('启动').disabled).toBe(false)
    expect(button('停止').disabled).toBe(true)
    expect(button('重启').disabled).toBe(true)
    fireEvent.click(button('启动'))
    expect(onLifecycleAction).toHaveBeenCalledWith('start')
  })

  it('routes stop and restart through the same workflow for a running Windows instance', () => {
    const onLifecycleAction = vi.fn()
    render(<OverviewLifecycleActions
      status={statusFixture('running')}
      provider="windows"
      refreshing={false}
      onRefresh={() => undefined}
      onLifecycleAction={onLifecycleAction}
    />)

    expect(button('启动').disabled).toBe(true)
    expect(button('停止').disabled).toBe(false)
    expect(button('重启').disabled).toBe(false)
    fireEvent.click(button('停止'))
    fireEvent.click(button('重启'))
    expect(onLifecycleAction.mock.calls).toEqual([['graceful-stop'], ['restart']])
  })

  it('keeps every lifecycle mutation explicitly disabled in demo mode', () => {
    const onLifecycleAction = vi.fn()
    render(<OverviewLifecycleActions
      status={statusFixture('running')}
      provider="demo"
      refreshing={false}
      onRefresh={() => undefined}
      onLifecycleAction={onLifecycleAction}
    />)

    expect(button('启动').disabled).toBe(true)
    expect(button('停止').disabled).toBe(true)
    expect(button('重启').disabled).toBe(true)
    fireEvent.click(button('停止'))
    expect(onLifecycleAction).not.toHaveBeenCalled()
  })
})

const saveFixture: ServerStatus['save'] = {
  name: 'FictionalSave', dsvPresent: true, serverPresent: true, consistent: true,
  lastSavedAt: '2026-09-01T07:30:00.000Z', dsvSizeMiB: 8, serverSizeKiB: 64,
  latestBackupAt: '2026-09-01T07:45:00.000Z', backupManifestPresent: true, backupPairPresent: true
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement
}

function statusFixture(state: ServerStatus['state']): Pick<ServerStatus, 'state' | 'capabilities'> {
  return {
    state,
    capabilities: {
      refresh: true,
      start: state === 'stopped',
      save: state === 'running',
      gracefulStop: state === 'running',
      restart: state === 'running'
    }
  }
}

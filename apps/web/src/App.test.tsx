// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { OverviewLifecycleActions } from './App'
import type { ServerStatus } from './model'

afterEach(cleanup)

describe('overview lifecycle actions', () => {
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

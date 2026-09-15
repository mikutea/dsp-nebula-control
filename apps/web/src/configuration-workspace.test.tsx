// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigurationWorkspace } from './App'
import { api } from './api'
import type { GameConfigPreview, GameConfigSnapshot } from './model'

vi.mock('./ConfigHistoryWorkspace', () => ({ ConfigHistoryWorkspace: () => null }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const preview: GameConfigPreview = { mode: 'dry-run', baseRevision: 'a'.repeat(64), nextRevision: 'b'.repeat(64),
  restartRequired: true, newGameOnlyChanged: false, diff: [{ id: 'nebula.auto-pause', file: 'nebula',
    label: '自动暂停', activation: 'server-restart', before: true, after: false, changed: true }] }
function setup(enabled?: boolean) {
  const snapshot: GameConfigSnapshot = { revision: 'a'.repeat(64), invalidSettingIds: [], entries: [{
    id: 'nebula.auto-pause', file: 'nebula', label: '自动暂停', description: '无人在线时暂停',
    activation: 'server-restart', type: 'boolean', value: true, source: 'file'
  }], ...(enabled === undefined ? {} : { execution: { enabled, recoveryEnabled: enabled, requiresStopped: true } }) }
  vi.spyOn(api, 'configuration').mockResolvedValue({ data: snapshot })
  vi.spyOn(api, 'previewConfiguration').mockResolvedValue({ data: preview })
  const apply = vi.spyOn(api, 'applyConfiguration').mockRejectedValue(new Error('响应暂不可用'))
  render(<ConfigurationWorkspace canPreview canApply canManageHistory={false} demo={false} />)
  return apply
}
async function editAndPreview() {
  fireEvent.click(await screen.findByRole('switch'))
  fireEvent.click(screen.getByRole('button', { name: '预览 1 项变更' }))
  await screen.findByText('差异预览已生成')
}
describe('configuration apply controls', () => {
  it.each([undefined, false])('fails closed when backend execution is %s', async enabled => {
    const apply = setup(enabled)
    await editAndPreview()
    expect((screen.getByRole('button', { name: '应用配置' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('配置提交尚未启用')).toBeTruthy()
    expect(apply).not.toHaveBeenCalled()
  })

  it('reuses the exact request identity for an unchanged failed submission', async () => {
    const apply = setup(true)
    await editAndPreview()
    for (let attempt = 1; attempt <= 2; attempt++) {
      fireEvent.click(screen.getByRole('button', { name: '应用配置' }))
      fireEvent.click(screen.getByRole('button', { name: '确认应用' }))
      await waitFor(() => expect(apply).toHaveBeenCalledTimes(attempt))
      await screen.findByText('响应暂不可用')
    }
    expect(apply.mock.calls[0]).toEqual(apply.mock.calls[1])
    expect(apply.mock.calls[0]![2]).toMatch(/^[0-9a-f-]{36}$/)
    expect(apply.mock.calls[0]![0]).toBe(preview.baseRevision)
    fireEvent.click(screen.getByRole('switch'))
    fireEvent.click(screen.getByRole('switch'))
    fireEvent.click(screen.getByRole('button', { name: '预览 1 项变更' }))
    await screen.findByText('差异预览已生成')
    fireEvent.click(screen.getByRole('button', { name: '应用配置' }))
    fireEvent.click(screen.getByRole('button', { name: '确认应用' }))
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(3))
    expect(apply.mock.calls[2]![2]).not.toBe(apply.mock.calls[0]![2])
  })

  it('requires confirmation and recovers only the failed submission ID', async () => {
    const apply = setup(true)
    const recover = vi.spyOn(api, 'reconcileConfiguration').mockImplementation(async requestId => ({ data: {
      transactionId: requestId, status: 'rolled-back', dryRun: false,
      baseRevision: preview.baseRevision, nextRevision: preview.nextRevision,
      changedSettingIds: ['nebula.auto-pause'], restartRequired: true, newGameOnlyChanged: false, auditStored: true
    } }))
    await editAndPreview()
    fireEvent.click(screen.getByRole('button', { name: '应用配置' }))
    fireEvent.click(screen.getByRole('button', { name: '确认应用' }))
    await screen.findByText('响应暂不可用')
    fireEvent.click(screen.getByRole('button', { name: '恢复未完成事务' }))
    expect(recover).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认恢复' }))
    await screen.findByText('配置事务已恢复原始配置')
    expect(recover).toHaveBeenCalledExactlyOnceWith(apply.mock.calls[0]![2])
  })

  it('discards a preview that completes after the draft changed', async () => {
    setup(true)
    let resolve!: (value: { data: GameConfigPreview }) => void
    vi.mocked(api.previewConfiguration).mockImplementation(() => new Promise(done => { resolve = done }))
    const field = await screen.findByRole('switch')
    fireEvent.click(field)
    fireEvent.click(screen.getByRole('button', { name: '预览 1 项变更' }))
    fireEvent.click(field)
    await act(async () => { resolve({ data: preview }) })
    expect(screen.queryByText('差异预览已生成')).toBeNull()
    expect((screen.getByRole('button', { name: '应用配置' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

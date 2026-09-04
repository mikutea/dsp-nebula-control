// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigHistoryWorkspace } from './ConfigHistoryWorkspace'
import { api, ApiError } from './api'
import {
  configHistoryCurrentRevision,
  configHistoryDiffFixture,
  configHistoryDryRunReceiptFixture,
  configHistoryRecoveryFixture,
  configHistoryRestoredReceiptFixture,
  configHistorySnapshotFixture,
  configHistorySnapshotId,
  configHistorySummaryFixture
} from './game-config-history.fixture'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('configuration history workspace', () => {
  it('keeps demo history honest without requesting a production-only controller', () => {
    const list = vi.spyOn(api, 'gameConfigHistory')

    render(<ConfigHistoryWorkspace canManage demo onConfigurationChanged={() => undefined} />)

    expect(screen.getByText('DEMO READ-ONLY')).toBeTruthy()
    expect(screen.getByText('演示环境未装载持久化配置历史控制器')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '刷新历史' })).toBeNull()
    expect(list).not.toHaveBeenCalled()
  })

  it('loads the list first and keeps Viewer/Operator on a redacted read-only surface', async () => {
    const mutations = installHistoryReads()
    render(<ConfigHistoryWorkspace canManage={false} onConfigurationChanged={() => undefined} />)

    expect(await screen.findByText('Nebula Multiplayer')).toBeTruthy()
    expect(screen.getByText('Galaxy Generation')).toBeTruthy()
    expect(screen.getByText('BepInEx Runtime')).toBeTruthy()
    expect(screen.getByText('Control Bridge')).toBeTruthy()
    expect(screen.getByText('configured → configured')).toBeTruthy()
    expect(document.body.textContent).not.toContain('fictional-raw-secret')
    expect(screen.getByText('只读历史会话')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '准备创建快照' })).toBeNull()
    expect(screen.queryByRole('button', { name: /读取最新 revision 并预演/ })).toBeNull()
    expect(screen.queryByLabelText('配置恢复对账确认短语')).toBeNull()
    expect(mutations.capture).not.toHaveBeenCalled()
    expect(mutations.restore).not.toHaveBeenCalled()
    expect(mutations.reconcile).not.toHaveBeenCalled()
    expect(mutations.list.mock.invocationCallOrder[0]).toBeLessThan(
      mutations.detail.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
  })

  it('requires the exact capture confirmation and refreshes the selected snapshot', async () => {
    const { capture, list } = installHistoryReads()
    render(<ConfigHistoryWorkspace canManage onConfigurationChanged={() => undefined} />)
    await screen.findByText('Nebula Multiplayer')

    fireEvent.click(screen.getByRole('button', { name: '准备创建快照' }))
    const confirmation = screen.getByLabelText('创建快照确认短语')
    const execute = screen.getByRole('button', { name: '确认创建' }) as HTMLButtonElement
    fireEvent.change(confirmation, { target: { value: 'CREATE_CONFIG_SNAPSHO' } })
    expect(execute.disabled).toBe(true)
    expect(capture).not.toHaveBeenCalled()

    fireEvent.change(confirmation, { target: { value: 'CREATE_CONFIG_SNAPSHOT' } })
    expect(execute.disabled).toBe(false)
    fireEvent.click(execute)

    expect(await screen.findByText('手动配置快照已创建')).toBeTruthy()
    expect(capture).toHaveBeenCalledWith(expect.any(AbortSignal))
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  })

  it('restores only after preview, fresh revision, dry-run receipt, and exact second confirmation', async () => {
    const { configuration, restore } = installHistoryReads()
    const onConfigurationChanged = vi.fn(async () => undefined)
    render(<ConfigHistoryWorkspace canManage onConfigurationChanged={onConfigurationChanged} />)
    await screen.findByText('Nebula Multiplayer')

    fireEvent.click(screen.getByRole('button', { name: /读取最新 revision 并预演/ }))
    await waitFor(() => expect(configuration).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('CURRENT')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /执行 dry-run/ }))

    expect(await screen.findByText('恢复 dry-run 回执已验证')).toBeTruthy()
    expect(configuration).toHaveBeenCalledTimes(2)
    const confirmation = screen.getByLabelText('恢复快照确认短语')
    const execute = screen.getByRole('button', { name: '确认恢复快照' }) as HTMLButtonElement
    fireEvent.change(confirmation, { target: { value: 'RESTORE_CONFIG_SNAPSHO' } })
    expect(execute.disabled).toBe(true)
    fireEvent.change(confirmation, { target: { value: 'RESTORE_CONFIG_SNAPSHOT' } })
    expect(execute.disabled).toBe(false)
    fireEvent.click(execute)

    expect(await screen.findByText('配置快照恢复已提交')).toBeTruthy()
    expect(onConfigurationChanged).toHaveBeenCalledTimes(1)
    expect(configuration).toHaveBeenCalledTimes(3)
    expect(restore).toHaveBeenCalledTimes(2)
    const [dryRunRequest, durableRequest] = restore.mock.calls
    expect(dryRunRequest?.slice(1, 4)).toEqual([
      configHistorySnapshotId,
      configHistoryCurrentRevision,
      true
    ])
    expect(durableRequest?.slice(1, 4)).toEqual([
      configHistorySnapshotId,
      configHistoryCurrentRevision,
      false
    ])
    expect(dryRunRequest?.[0]).toMatch(uuidV4Pattern)
    expect(durableRequest?.[0]).toMatch(uuidV4Pattern)
    expect(durableRequest?.[0]).not.toBe(dryRunRequest?.[0])
  })

  it('clears dry-run authorization when the revision becomes stale before execution', async () => {
    const staleRevision = '9'.repeat(64)
    const { configuration, restore } = installHistoryReads()
    configuration
      .mockResolvedValueOnce(configurationResponse(configHistoryCurrentRevision))
      .mockResolvedValueOnce(configurationResponse(configHistoryCurrentRevision))
      .mockResolvedValueOnce(configurationResponse(staleRevision))
    render(<ConfigHistoryWorkspace canManage onConfigurationChanged={() => undefined} />)
    await screen.findByText('Nebula Multiplayer')

    fireEvent.click(screen.getByRole('button', { name: /读取最新 revision 并预演/ }))
    await screen.findByText('CURRENT')
    fireEvent.click(screen.getByRole('button', { name: /执行 dry-run/ }))
    await screen.findByText('恢复 dry-run 回执已验证')
    fireEvent.change(screen.getByLabelText('恢复快照确认短语'), {
      target: { value: 'RESTORE_CONFIG_SNAPSHOT' }
    })
    fireEvent.click(screen.getByRole('button', { name: '确认恢复快照' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('CONFIG_HISTORY_REVISION_CONFLICT')
    expect(alert.textContent).toContain('必须重新读取、预演并执行 dry-run')
    expect(restore).toHaveBeenCalledTimes(1)
    expect(screen.queryByLabelText('恢复快照确认短语')).toBeNull()
  })

  it.each([
    [423, 'CONFIG_HISTORY_MUTATIONS_DISABLED'],
    [503, 'CONFIG_HISTORY_NOT_CONFIGURED']
  ])('surfaces status %i as a fixed fail-closed transaction error', async (status, code) => {
    const { capture } = installHistoryReads()
    capture.mockRejectedValue(new ApiError(status, '配置历史写入不可用。', code))
    render(<ConfigHistoryWorkspace canManage onConfigurationChanged={() => undefined} />)
    await screen.findByText('Nebula Multiplayer')

    fireEvent.click(screen.getByRole('button', { name: '准备创建快照' }))
    fireEvent.change(screen.getByLabelText('创建快照确认短语'), {
      target: { value: 'CREATE_CONFIG_SNAPSHOT' }
    })
    fireEvent.click(screen.getByRole('button', { name: '确认创建' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(code)
    expect(alert.textContent).toContain('历史事务保持关闭')
    expect(screen.queryByText('手动配置快照已创建')).toBeNull()
  })

  it('keeps current-revision read failures fixed and non-reflective', async () => {
    const { configuration, restore } = installHistoryReads()
    configuration.mockRejectedValue(new ApiError(
      503,
      'untrusted C:\\host\\secret.ini and submitted text',
      'UNTRUSTED_DETAIL'
    ))
    render(<ConfigHistoryWorkspace canManage onConfigurationChanged={() => undefined} />)
    await screen.findByText('Nebula Multiplayer')

    fireEvent.click(screen.getByRole('button', { name: /读取最新 revision 并预演/ }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('当前配置 revision 暂不可用')
    expect(alert.textContent).toContain('CONFIG_HISTORY_HTTP_UNAVAILABLE')
    expect(alert.textContent).not.toContain('C:\\host')
    expect(alert.textContent).not.toContain('submitted text')
    expect(restore).not.toHaveBeenCalled()
  })

  it('runs reconciliation only behind its independent high-risk confirmation', async () => {
    const { reconcile } = installHistoryReads()
    const onConfigurationChanged = vi.fn(async () => undefined)
    render(<ConfigHistoryWorkspace canManage onConfigurationChanged={onConfigurationChanged} />)
    await screen.findByText('Nebula Multiplayer')

    const confirmation = screen.getByLabelText('配置恢复对账确认短语')
    const execute = screen.getByRole('button', { name: '执行独立对账' }) as HTMLButtonElement
    fireEvent.change(confirmation, { target: { value: 'RECONCILE_CONFIG_RESTOR' } })
    expect(execute.disabled).toBe(true)
    fireEvent.change(confirmation, { target: { value: 'RECONCILE_CONFIG_RESTORE' } })
    fireEvent.click(execute)

    expect(await screen.findByText('interrupted-recovered')).toBeTruthy()
    expect(reconcile).toHaveBeenCalledWith(expect.any(AbortSignal))
    await waitFor(() => expect(onConfigurationChanged).toHaveBeenCalledTimes(1))
  })
})

function installHistoryReads() {
  const list = vi.spyOn(api, 'gameConfigHistory').mockResolvedValue({
    data: [configHistorySummaryFixture()]
  })
  const detail = vi.spyOn(api, 'gameConfigHistoryDetail').mockResolvedValue({
    data: configHistorySnapshotFixture()
  })
  vi.spyOn(api, 'gameConfigHistoryDiff').mockResolvedValue({
    data: configHistoryDiffFixture()
  })
  vi.spyOn(api, 'gameConfigHistoryRestorePreview').mockResolvedValue({
    data: configHistoryDiffFixture()
  })
  const configuration = vi.spyOn(api, 'configuration').mockResolvedValue(
    configurationResponse(configHistoryCurrentRevision)
  )
  const capture = vi.spyOn(api, 'captureGameConfigHistory').mockResolvedValue({
    data: configHistorySnapshotFixture()
  })
  const restore = vi.spyOn(api, 'restoreGameConfigHistory').mockImplementation(
    async (requestId, _snapshotId, _revision, dryRun) => ({
      data: dryRun
        ? { ...configHistoryDryRunReceiptFixture(), requestId }
        : configHistoryRestoredReceiptFixture(requestId)
    })
  )
  const reconcile = vi.spyOn(api, 'reconcileGameConfigHistory').mockResolvedValue({
    data: configHistoryRecoveryFixture()
  })
  return { list, detail, configuration, capture, restore, reconcile }
}

function configurationResponse(revision: string) {
  return { data: { revision, entries: [], invalidSettingIds: [] } }
}

const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

vi.mock('./recoverable-cleanup-api', () => ({ recoverableCleanupApi: { state: vi.fn(async () => ({ executionEnabled: false, recoveryEnabled: false, transactions: [] })) } }))
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VersionUpdateWorkspace, steamManualHandoffApi } from './VersionUpdateWorkspace'
vi.mock('./operator-rollback-api', () => ({ operatorRollbackApi: {
  state: vi.fn(async () => ({ executionEnabled: false, recoveryEnabled: false, pending: [] }))
} }))
import { api, ApiError } from './api'
import type {
  ComponentCandidatePreparationReceipt,
  ServerStatus, SessionUser, UpdateActivationPlan, UpdateActivationReceipt,
  UpdateActivationRecoveryStatus, UpdateActivationRequest, UpdateActivationState, UpdateCleanupPlan,
  UpdateCompatibilityReceipt, UpdateCompatibilityStatus
} from './model'

const preparedNebulaArtifactId = `prepared-nebula-${'a'.repeat(40)}`
const preparedNebulaSha256 = 'd'.repeat(64)
const preparationReceiptId = '33333333-3333-4333-8333-333333333333'

beforeEach(() => {
  vi.spyOn(steamManualHandoffApi, 'state').mockResolvedValue({ data: steamStateFixture() })
  vi.spyOn(steamManualHandoffApi, 'receipt').mockRejectedValue(
    new ApiError(404, 'fixture receipt missing', 'DSP_STEAM_HANDOFF_RECEIPT_NOT_FOUND')
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('component update activation workspace', () => {
  it('loads bounded state, previews a fixed request, requires component confirmation, and verifies the receipt', async () => {
    mockStateReads()
    let activationRequest = requestFixture()
    const preview = vi.spyOn(api, 'previewUpdateActivation').mockImplementation(async (request) => {
      activationRequest = request
      return { data: planFixture(request) }
    })
    const execute = vi.spyOn(api, 'executeUpdateActivation').mockImplementation(async (request) => ({ data: receiptFixture(request) }))
    const readReceipt = vi.spyOn(api, 'updateActivationReceipt').mockImplementation(async () => ({ data: receiptFixture(activationRequest) }))

    render(<VersionUpdateWorkspace status={statusFixture()} demo={false} user={administrator()} />)

    expect(await screen.findByText('4 个托管组件')).toBeTruthy()
    expect(screen.getAllByText('READY').length).toBeGreaterThan(0)
    expect(screen.getByText('MANUAL / DURABLE HANDOFF')).toBeTruthy()
    expect(screen.getByText('executeSupported=false')).toBeTruthy()

    await loadPreparedNebulaDraft()
    await prepareCompatibilityEvidence()
    fireEvent.click(screen.getByRole('button', { name: '生成激活预演' }))

    expect(await screen.findByText('DRY-RUN 已生成，执行仍未发生')).toBeTruthy()
    expect(screen.getByText('创建成对存档保护点')).toBeTruthy()
    expect(screen.getByText('停止态证明')).toBeTruthy()
    const submitted = preview.mock.calls[0]?.[0]
    expect(submitted).toMatchObject({
      component: 'nebula',
      artifactId: preparedNebulaArtifactId,
      sha256: preparedNebulaSha256,
      targetVersion: '0.9.22',
      expectedRevision: '1'.repeat(64),
      compatibilityReceiptId: expect.any(String)
    })
    expect(submitted?.compatibilityReceiptId).toBe((api.prepareUpdateCompatibility as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].requestId)
    expect(JSON.stringify(submitted)).not.toMatch(/"(?:path|url|command|executable|credential|archive|zip)"\s*:/i)

    const activationButton = screen.getByRole('button', { name: '提交服务端激活门禁' }) as HTMLButtonElement
    expect(activationButton.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('组件激活精确确认'), {
      target: { value: 'ACTIVATE_NEBULA_UPDATE' }
    })
    expect(activationButton.disabled).toBe(false)
    fireEvent.click(activationButton)

    expect(await screen.findByText('已由 receipts/:requestId 重新读取')).toBeTruthy()
    expect(screen.getByText('GATE ACCEPTED')).toBeTruthy()
    expect(screen.getByText(/ROLLBACK JOURNAL/)).toBeTruthy()
    expect(screen.getByText(/configuration not-required.*exact previous save load not-required/)).toBeTruthy()
    expect(execute).toHaveBeenCalledWith(submitted, 'ACTIVATE_NEBULA_UPDATE', expect.any(AbortSignal))
    expect(readReceipt).toHaveBeenCalledWith(activationRequest.requestId, expect.any(AbortSignal))
  })

  it('lets an Operator generate dry-run evidence while keeping activation unavailable', async () => {
    mockStateReads()
    vi.spyOn(api, 'previewUpdateActivation').mockImplementation(async (request) => ({ data: planFixture(request) }))
    const execute = vi.spyOn(api, 'executeUpdateActivation')
    render(<VersionUpdateWorkspace status={statusFixture()} demo={false} user={operator()} />)

    await screen.findByText('Operator 可获取 / 激活只读')
    await loadPreparedNebulaDraft()
    await prepareCompatibilityEvidence()
    fireEvent.click(screen.getByRole('button', { name: '生成激活预演' }))
    expect(await screen.findByText('DRY-RUN 已生成，执行仍未发生')).toBeTruthy()

    const confirmation = screen.getByLabelText('组件激活精确确认') as HTMLInputElement
    const activationButton = screen.getByRole('button', { name: '需要 Administrator' }) as HTMLButtonElement
    expect(confirmation.disabled).toBe(true)
    expect(activationButton.disabled).toBe(true)
    fireEvent.click(activationButton)
    expect(execute).not.toHaveBeenCalled()
  })

  it('keeps ordinary activation fail-closed when recovery status is unavailable', async () => {
    mockStateReads()
    vi.spyOn(api, 'updateActivationRecoveryStatus').mockRejectedValue(
      new ApiError(503, '恢复状态暂不可用。', 'UPDATE_ACTIVATION_HTTP_RECOVERY_UNAVAILABLE')
    )
    vi.spyOn(api, 'previewUpdateActivation').mockImplementation(async (request) => ({ data: planFixture(request) }))
    const execute = vi.spyOn(api, 'executeUpdateActivation')
    render(<VersionUpdateWorkspace status={statusFixture()} demo={false} user={administrator()} />)

    expect((await screen.findByRole('alert')).textContent).toContain('UPDATE_ACTIVATION_HTTP_RECOVERY_UNAVAILABLE')
    await loadPreparedNebulaDraft()
    await prepareCompatibilityEvidence()
    fireEvent.click(screen.getByRole('button', { name: '生成激活预演' }))
    await screen.findByText('DRY-RUN 已生成，执行仍未发生')

    expect((screen.getByLabelText('组件激活精确确认') as HTMLInputElement).disabled).toBe(true)
    const button = screen.getByRole('button', { name: '恢复状态保持锁定' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(execute).not.toHaveBeenCalled()
  })

  it('keeps ordinary activation fail-closed when the recovery coordinator reports blocked', async () => {
    const requestId = '55555555-5555-4555-8555-555555555555'
    mockStateReads()
    vi.spyOn(api, 'updateActivationRecoveryStatus').mockResolvedValue({
      data: recoveryStatusFixture(requestId, true)
    })
    vi.spyOn(api, 'previewUpdateActivation').mockImplementation(async (request) => ({ data: planFixture(request) }))
    const execute = vi.spyOn(api, 'executeUpdateActivation')
    render(<VersionUpdateWorkspace status={statusFixture()} demo={false} user={administrator()} />)

    expect(await screen.findByText('组件事务需要显式恢复')).toBeTruthy()
    await loadPreparedNebulaDraft()
    await prepareCompatibilityEvidence()
    fireEvent.click(screen.getByRole('button', { name: '生成激活预演' }))
    await screen.findByText('DRY-RUN 已生成，执行仍未发生')

    expect((screen.getByLabelText('组件激活精确确认') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '恢复状态保持锁定' }) as HTMLButtonElement).disabled).toBe(true)
    expect(execute).not.toHaveBeenCalled()
  })

  it('renders DSP as official-client manual handoff, keeps demo mutation-free, and exposes no host transport inputs', async () => {
    const preview = vi.spyOn(api, 'previewUpdateActivation')
    const execute = vi.spyOn(api, 'executeUpdateActivation')
    render(<VersionUpdateWorkspace status={statusFixture()} demo user={administrator()} />)

    expect(await screen.findByText('MANUAL / DURABLE HANDOFF')).toBeTruthy()
    expect(screen.getByText(/不会读取或自动化账号、密码、Steam Guard/)).toBeTruthy()
    expect(screen.getByText(/核心没有清理执行合同/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /删除|清理执行|激活 DSP|启动 Steam/i })).toBeNull()
    expect(screen.queryByRole('textbox', { name: /路径|URL|命令|可执行文件|ZIP/i })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '使用虚构示例' }))
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '生成激活预演' }) as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(screen.getByRole('button', { name: '生成激活预演' }))
    expect(await screen.findByText('DRY-RUN 已生成，执行仍未发生')).toBeTruthy()
    expect((screen.getByRole('button', { name: '演示环境不执行' }) as HTMLButtonElement).disabled).toBe(true)
    expect(preview).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('contains Steam mount unavailability inside its lane without occupying the shared workflow alert', async () => {
    mockStateReads()
    vi.mocked(steamManualHandoffApi.state).mockRejectedValue(
      new ApiError(404, 'Steam handoff route is not assembled.', 'DSP_STEAM_HANDOFF_NOT_CONFIGURED')
    )

    render(<VersionUpdateWorkspace status={statusFixture()} demo={false} user={administrator()} />)

    const steamStatus = await screen.findByRole('status', { name: 'Steam 人工交接状态不可用' })
    expect(steamStatus.textContent).toContain('DSP_STEAM_HANDOFF_NOT_CONFIGURED')
    expect(screen.getByText('DSP HANDOFF').parentElement?.textContent).toContain('UNAVAILABLE')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('previews the Steam handoff with zero mutation and never submits a wrong begin confirmation', async () => {
    mockStateReads()
    const steamPreview = vi.spyOn(steamManualHandoffApi, 'preview').mockImplementation(async (request) => ({
      data: steamPlanFixture(request)
    }))
    const steamBegin = vi.spyOn(steamManualHandoffApi, 'begin')
    const steamConfirm = vi.spyOn(steamManualHandoffApi, 'confirm')
    render(<VersionUpdateWorkspace status={statusFixture()} demo={false} user={administrator()} />)

    await screen.findByText('MANUAL / DURABLE HANDOFF')
    fireEvent.change(screen.getByLabelText('Steam 人工交接目标 DSP 版本'), {
      target: { value: '0.10.35.29485' }
    })
    fireEvent.click(screen.getByRole('button', { name: '生成零变更预演' }))

    expect(await screen.findByText('Steam handoff dry-run operations')).toBeTruthy()
    expect(screen.getByText(/accountAutomation=false/)).toBeTruthy()
    const request = steamPreview.mock.calls[0]?.[0]
    expect(request).toMatchObject({
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      targetVersion: '0.10.35.29485',
      expectedRevision: steamStateFixture().revision
    })
    expect(JSON.stringify(request)).not.toMatch(/account|password|guard|cookie|path|command|executable/i)
    expect(steamBegin).not.toHaveBeenCalled()
    expect(steamConfirm).not.toHaveBeenCalled()

    const beginButton = screen.getByRole('button', { name: '建立持久人工交接' }) as HTMLButtonElement
    fireEvent.change(screen.getByLabelText('Steam 人工交接开始精确确认'), {
      target: { value: 'BEGIN_STEAM_UPDATE' }
    })
    expect(beginButton.disabled).toBe(true)
    fireEvent.click(beginButton)
    expect(steamBegin).not.toHaveBeenCalled()
  })

  it('persists awaiting state, then confirms exact version and current-generation previous-save load', async () => {
    mockStateReads()
    const requestId = '77777777-7777-4777-8777-777777777777'
    const awaiting = steamReceiptFixture(requestId, 'awaiting-steam-client-update')
    const succeeded = steamReceiptFixture(requestId, 'succeeded')
    vi.mocked(steamManualHandoffApi.state).mockReset()
      .mockResolvedValueOnce({ data: steamStateFixture() })
      .mockResolvedValueOnce({ data: steamStateFixture({
        revision: awaiting.resultingRevision, activeRequestId: requestId, current: awaiting
      }) })
      .mockResolvedValueOnce({ data: steamStateFixture({
        revision: succeeded.resultingRevision,
        lastCompletedTargetVersion: succeeded.targetVersion
      }) })
    vi.mocked(steamManualHandoffApi.receipt).mockReset()
      .mockResolvedValueOnce({ data: awaiting })
      .mockResolvedValueOnce({ data: succeeded })
    vi.spyOn(steamManualHandoffApi, 'preview').mockImplementation(async (request) => ({
      data: steamPlanFixture({ ...request, requestId })
    }))
    const begin = vi.spyOn(steamManualHandoffApi, 'begin').mockResolvedValue({ data: awaiting })
    const confirm = vi.spyOn(steamManualHandoffApi, 'confirm').mockResolvedValue({ data: succeeded })

    render(<VersionUpdateWorkspace status={statusFixture()} demo={false} user={administrator()} />)
    await screen.findByText('MANUAL / DURABLE HANDOFF')
    fireEvent.change(screen.getByLabelText('Steam 人工交接目标 DSP 版本'), {
      target: { value: '0.10.35.29485' }
    })
    fireEvent.click(screen.getByRole('button', { name: '生成零变更预演' }))
    await screen.findByText('Steam handoff dry-run operations')
    fireEvent.change(screen.getByLabelText('Steam 人工交接开始精确确认'), {
      target: { value: 'BEGIN_STEAM_CLIENT_UPDATE_HANDOFF' }
    })
    fireEvent.click(screen.getByRole('button', { name: '建立持久人工交接' }))

    expect(await screen.findByText('RECEIPT REREAD VERIFIED')).toBeTruthy()
    expect(screen.getAllByText('AWAITING STEAM CLIENT').length).toBeGreaterThan(0)
    expect(begin).toHaveBeenCalledWith(expect.objectContaining({
      requestId, targetVersion: '0.10.35.29485'
    }), expect.any(AbortSignal))
    fireEvent.change(screen.getByLabelText('Steam 客户端更新完成精确确认'), {
      target: { value: 'CONFIRM_STEAM_CLIENT_UPDATE_COMPLETED' }
    })
    fireEvent.click(screen.getByRole('button', { name: '确认客户端更新已完成' }))

    await waitFor(() => expect(confirm).toHaveBeenCalledWith(requestId, expect.any(AbortSignal)))
    expect(await screen.findByText('SUCCEEDED')).toBeTruthy()
    expect(screen.getAllByText('VERIFIED').length).toBeGreaterThan(0)
    expect(screen.getByText(/Bridge \+ 日志同启动代际/)).toBeTruthy()
  })

  it('keeps the durable handoff awaiting when operator confirmation observes the wrong DSP version', async () => {
    mockStateReads()
    const requestId = '77777777-7777-4777-8777-777777777777'
    const awaiting = steamReceiptFixture(requestId, 'awaiting-steam-client-update', {
      failureCode: 'DSP_STEAM_HANDOFF_VERSION_MISMATCH',
      steps: {
        ...steamReceiptFixture(requestId, 'awaiting-steam-client-update').steps,
        versionResample: 'failed'
      }
    })
    vi.mocked(steamManualHandoffApi.state).mockReset().mockResolvedValue({
      data: steamStateFixture({ revision: awaiting.resultingRevision, activeRequestId: requestId, current: awaiting })
    })
    vi.mocked(steamManualHandoffApi.receipt).mockReset().mockResolvedValue({ data: awaiting })
    const confirm = vi.spyOn(steamManualHandoffApi, 'confirm').mockRejectedValue(
      new ApiError(409, '官方 Steam 客户端尚未达到 exact 目标版本；事务仍等待，可完成更新后重试。', 'DSP_STEAM_HANDOFF_VERSION_MISMATCH')
    )

    render(<VersionUpdateWorkspace status={statusFixture()} demo={false} user={administrator()} />)
    expect(await screen.findByText('RECEIPT REREAD VERIFIED')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Steam 客户端更新完成精确确认'), {
      target: { value: 'CONFIRM_STEAM_CLIENT_UPDATE_COMPLETED' }
    })
    fireEvent.click(screen.getByRole('button', { name: '确认客户端更新已完成' }))

    expect((await screen.findAllByText(/DSP_STEAM_HANDOFF_VERSION_MISMATCH/)).length).toBeGreaterThan(0)
    expect(screen.getAllByText('AWAITING STEAM CLIENT').length).toBeGreaterThan(0)
    expect(screen.getByLabelText('Steam 客户端更新完成精确确认')).toBeTruthy()
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('renders exact-save-load failure as recovery-required and removes completion control', async () => {
    mockStateReads()
    const requestId = '77777777-7777-4777-8777-777777777777'
    const failed = steamReceiptFixture(requestId, 'recovery-required', {
      recoveryRequired: true,
      failureCode: 'DSP_STEAM_HANDOFF_EXACT_SAVE_LOAD_UNPROVEN',
      steps: {
        ...steamReceiptFixture(requestId, 'recovery-required').steps,
        exactSaveLoad: 'failed'
      }
    })
    vi.mocked(steamManualHandoffApi.state).mockReset().mockResolvedValue({
      data: steamStateFixture({
        revision: failed.resultingRevision, recoveryRequired: true,
        activeRequestId: requestId, current: failed
      })
    })
    vi.mocked(steamManualHandoffApi.receipt).mockReset().mockResolvedValue({ data: failed })
    const confirm = vi.spyOn(steamManualHandoffApi, 'confirm')

    render(<VersionUpdateWorkspace status={statusFixture()} demo={false} user={administrator()} />)

    expect((await screen.findAllByText('DSP_STEAM_HANDOFF_EXACT_SAVE_LOAD_UNPROVEN')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('RECOVERY REQUIRED').length).toBeGreaterThan(0)
    expect(screen.queryByLabelText('Steam 客户端更新完成精确确认')).toBeNull()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('turns an HTTP 423 into an explicit fail-closed gate without discarding the dry-run plan', async () => {
    mockStateReads()
    vi.spyOn(api, 'previewUpdateActivation').mockImplementation(async (request) => ({ data: planFixture(request) }))
    vi.spyOn(api, 'executeUpdateActivation').mockRejectedValue(
      new ApiError(423, '组件激活门禁为 fail-closed；当前只允许读取与预演。', 'UPDATE_ACTIVATION_HTTP_MUTATION_DISABLED')
    )
    render(<VersionUpdateWorkspace status={statusFixture()} demo={false} user={administrator()} />)

    await screen.findByText('4 个托管组件')
    await loadPreparedNebulaDraft()
    await prepareCompatibilityEvidence()
    fireEvent.click(screen.getByRole('button', { name: '生成激活预演' }))
    await screen.findByText('DRY-RUN 已生成，执行仍未发生')
    fireEvent.change(screen.getByLabelText('组件激活精确确认'), {
      target: { value: 'ACTIVATE_NEBULA_UPDATE' }
    })
    fireEvent.click(screen.getByRole('button', { name: '提交服务端激活门禁' }))

    expect(await screen.findByText('FAIL-CLOSED')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('UPDATE_ACTIVATION_HTTP_MUTATION_DISABLED')
    expect(screen.getByText('服务端 dry-run operations')).toBeTruthy()
    expect((screen.getByRole('button', { name: '服务端门禁已关闭' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('reloads durable state immediately after ordinary activation enters recovery-required', async () => {
    const requestId = requestFixture().requestId
    vi.spyOn(api, 'updateActivationState')
      .mockResolvedValueOnce({ data: stateFixture() })
      .mockResolvedValue({ data: { ...stateFixture(), recoveryRequired: true } })
    const recoveryStatus = vi.spyOn(api, 'updateActivationRecoveryStatus')
      .mockResolvedValueOnce({ data: recoveryStatusFixture() })
      .mockResolvedValue({ data: recoveryStatusFixture(requestId, true) })
    vi.spyOn(api, 'updateActivationCleanupPreview').mockResolvedValue({ data: cleanupFixture() })
    vi.spyOn(api, 'updateCompatibilityStatus').mockResolvedValue({ data: compatibilityStatusFixture() })
    vi.spyOn(api, 'prepareUpdateCompatibility').mockImplementation(async (request) => ({
      data: compatibilityReceiptFixture(request.requestId)
    }))
    vi.spyOn(api, 'updateCompatibilityReceipt').mockImplementation(async (receiptId) => ({
      data: compatibilityReceiptFixture(receiptId)
    }))
    vi.spyOn(api, 'componentCandidatePreparationReceipt').mockImplementation(async (receiptId) => ({
      data: preparationReceiptFixture(receiptId)
    }))
    vi.spyOn(api, 'previewUpdateActivation').mockImplementation(async (request) => ({ data: planFixture(request) }))
    vi.spyOn(api, 'executeUpdateActivation').mockRejectedValue(
      new ApiError(503, '回滚无法证明安全终态。', 'UPDATE_ROLLBACK_SMOKE_FAILED')
    )
    render(<VersionUpdateWorkspace status={statusFixture()} demo={false} user={administrator()} />)

    await screen.findByText('4 个托管组件')
    await loadPreparedNebulaDraft()
    await prepareCompatibilityEvidence()
    fireEvent.click(screen.getByRole('button', { name: '生成激活预演' }))
    await screen.findByText('DRY-RUN 已生成，执行仍未发生')
    fireEvent.change(screen.getByLabelText('组件激活精确确认'), {
      target: { value: 'ACTIVATE_NEBULA_UPDATE' }
    })
    fireEvent.click(screen.getByRole('button', { name: '提交服务端激活门禁' }))

    expect(await screen.findByText('组件事务需要显式恢复')).toBeTruthy()
    expect(recoveryStatus).toHaveBeenCalledTimes(2)
    expect((screen.getByRole('button', { name: '恢复状态保持锁定' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('aborts both bounded state reads when the workspace unmounts', async () => {
    let stateSignal: AbortSignal | undefined
    let recoverySignal: AbortSignal | undefined
    let cleanupSignal: AbortSignal | undefined
    let compatibilitySignal: AbortSignal | undefined
    vi.spyOn(api, 'updateActivationState').mockImplementation(async (signal) => {
      stateSignal = signal
      return { data: stateFixture() }
    })
    vi.spyOn(api, 'updateActivationRecoveryStatus').mockImplementation(async (signal) => {
      recoverySignal = signal
      return { data: recoveryStatusFixture() }
    })
    vi.spyOn(api, 'updateActivationCleanupPreview').mockImplementation(async (signal) => {
      cleanupSignal = signal
      return { data: cleanupFixture() }
    })
    vi.spyOn(api, 'updateCompatibilityStatus').mockImplementation(async (signal) => {
      compatibilitySignal = signal
      return { data: compatibilityStatusFixture() }
    })
    const view = render(<VersionUpdateWorkspace status={statusFixture()} demo={false} user={administrator()} />)
    await screen.findByText('4 个托管组件')
    view.unmount()
    expect(stateSignal?.aborted).toBe(true)
    expect(recoverySignal?.aborted).toBe(true)
    expect(cleanupSignal?.aborted).toBe(true)
    expect(compatibilitySignal?.aborted).toBe(true)
  })

  it('lets an Administrator perform only the exact broker-bound recovery and then clears the panel', async () => {
    const requestId = '55555555-5555-4555-8555-555555555555'
    vi.spyOn(api, 'updateActivationState')
      .mockResolvedValueOnce({ data: { ...stateFixture(), recoveryRequired: true } })
      .mockResolvedValue({ data: stateFixture() })
    vi.spyOn(api, 'updateActivationRecoveryStatus')
      .mockResolvedValueOnce({ data: recoveryStatusFixture(requestId, true) })
      .mockResolvedValue({ data: recoveryStatusFixture(requestId, false) })
    vi.spyOn(api, 'updateActivationCleanupPreview').mockResolvedValue({ data: cleanupFixture() })
    vi.spyOn(api, 'updateCompatibilityStatus').mockResolvedValue({ data: compatibilityStatusFixture() })
    const recovered = {
      ...receiptFixture({ ...requestFixture(), requestId }),
      status: 'rolled-back' as const,
      resultingRevision: '1'.repeat(64),
      failureCode: 'UPDATE_ROLLBACK_SMOKE_FAILED',
      rollbackSteps: {
        component: 'verified' as const, configuration: 'verified' as const,
        serverModLock: 'verified' as const, pairedSave: 'verified' as const,
        previousSaveLoad: 'verified' as const
      },
      rollbackVerified: true,
      recoveryRequired: false
    }
    const recover = vi.spyOn(api, 'recoverUpdateActivation').mockResolvedValue({ data: recovered })
    vi.spyOn(api, 'updateActivationReceipt').mockResolvedValue({ data: recovered })

    render(<VersionUpdateWorkspace status={statusFixture()} demo={false} user={administrator()} />)
    expect(await screen.findByText('组件事务需要显式恢复')).toBeTruthy()
    expect((screen.getByLabelText('待恢复组件事务 UUID') as HTMLInputElement).value).toBe(requestId)
    const button = screen.getByRole('button', { name: '执行精确显式恢复' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('组件恢复精确确认'), {
      target: { value: 'RECOVER_COMPONENT_UPDATE' }
    })
    expect(button.disabled).toBe(false)
    fireEvent.click(button)

    await waitFor(() => expect(recover).toHaveBeenCalledWith(
      requestId,
      'RECOVER_COMPONENT_UPDATE',
      expect.any(AbortSignal)
    ))
    await waitFor(() => expect(screen.queryByText('组件事务需要显式恢复')).toBeNull())
    expect(await screen.findByText('已由 receipts/:requestId 重新读取')).toBeTruthy()
  })
})

function mockStateReads(): void {
  vi.spyOn(api, 'updateActivationState').mockResolvedValue({ data: stateFixture() })
  vi.spyOn(api, 'updateActivationRecoveryStatus').mockResolvedValue({ data: recoveryStatusFixture() })
  vi.spyOn(api, 'updateActivationCleanupPreview').mockResolvedValue({ data: cleanupFixture() })
  vi.spyOn(api, 'updateCompatibilityStatus').mockResolvedValue({ data: compatibilityStatusFixture() })
  vi.spyOn(api, 'prepareUpdateCompatibility').mockImplementation(async (request) => ({
    data: compatibilityReceiptFixture(request.requestId)
  }))
  vi.spyOn(api, 'updateCompatibilityReceipt').mockImplementation(async (receiptId) => ({
    data: compatibilityReceiptFixture(receiptId)
  }))
  vi.spyOn(api, 'componentCandidatePreparationReceipt').mockImplementation(async (requestId) => ({
    data: preparationReceiptFixture(requestId)
  }))
}

function recoveryStatusFixture(
  requestId: string | null = null,
  required = false
): UpdateActivationRecoveryStatus {
  return {
    schemaVersion: 1,
    phase: required ? 'recovery-required' : 'ready',
    mutationBlocked: required,
    recoveryRequired: required,
    failureCode: required ? 'UPDATE_RECOVERY_REQUIRED' : null,
    reconciledRequestId: requestId
  }
}

type SteamHandoffStateFixture = Awaited<ReturnType<typeof steamManualHandoffApi.state>>['data']
type SteamHandoffPlanFixture = Awaited<ReturnType<typeof steamManualHandoffApi.preview>>['data']
type SteamHandoffReceiptFixture = Awaited<ReturnType<typeof steamManualHandoffApi.receipt>>['data']

function steamStateFixture(
  overrides: Partial<SteamHandoffStateFixture> = {}
): SteamHandoffStateFixture {
  return {
    format: 'dyson-control-steam-manual-handoff-state',
    schemaVersion: 1,
    revision: '6'.repeat(64),
    recoveryRequired: false,
    activeRequestId: null,
    lastCompletedTargetVersion: null,
    current: null,
    ...overrides
  }
}

function steamPlanFixture(request: {
  requestId: string
  targetVersion: string
  expectedRevision: string
}): SteamHandoffPlanFixture {
  return {
    format: 'dyson-control-steam-manual-handoff-plan',
    schemaVersion: 1,
    dryRun: true,
    ...request,
    timeoutSeconds: 1_800,
    accountAutomation: false,
    operations: [
      'capture-runtime-and-save-baseline',
      'create-paired-save-protection-point',
      'request-graceful-stop',
      'prove-process-stopped-and-port-closed',
      'await-official-steam-client-update',
      'require-fixed-operator-confirmation',
      'resample-exact-dsp-version-and-compatibility',
      'start-and-prove-current-generation-exact-save-load',
      'persist-audit-receipt'
    ]
  }
}

function steamReceiptFixture(
  requestId: string,
  phase: SteamHandoffReceiptFixture['phase'],
  overrides: Partial<SteamHandoffReceiptFixture> = {}
): SteamHandoffReceiptFixture {
  const succeeded = phase === 'succeeded'
  const failed = phase === 'recovery-required'
  return {
    format: 'dyson-control-steam-manual-handoff-receipt',
    schemaVersion: 1,
    requestId,
    targetVersion: '0.10.35.29485',
    phase,
    previousRevision: '6'.repeat(64),
    resultingRevision: succeeded ? '8'.repeat(64) : '7'.repeat(64),
    transactionBindingSha256: '9'.repeat(64),
    protectionBackupId: `save:${requestId}`,
    protectionManifestSha256: 'a'.repeat(64),
    previousDspVersion: '0.10.34.28529',
    compatibilityRevision: 'b'.repeat(64),
    startedAt: '2026-09-01T10:00:00.000Z',
    expiresAt: '2026-09-01T10:30:00.000Z',
    completedAt: succeeded || failed ? '2026-09-01T10:05:00.000Z' : null,
    failureCode: failed ? 'DSP_STEAM_HANDOFF_RECOVERY_REQUIRED' : null,
    recoveryRequired: failed,
    steps: {
      protectionPoint: 'verified',
      gracefulStop: 'verified',
      stoppedProof: 'verified',
      operatorConfirmation: succeeded ? 'verified' : 'pending',
      versionResample: succeeded ? 'verified' : 'pending',
      compatibilityResample: succeeded ? 'verified' : 'pending',
      exactSaveLoad: succeeded ? 'verified' : 'pending'
    },
    auditEvents: ['baseline-captured', 'protection-verified'],
    reused: false,
    ...overrides
  }
}

async function loadPreparedNebulaDraft(): Promise<void> {
  fireEvent.change(screen.getByLabelText('准备回执 request ID'), {
    target: { value: preparationReceiptId }
  })
  fireEvent.click(screen.getByRole('button', { name: '恢复准备回执' }))
  expect(await screen.findByText('PREPARED RECEIPT VERIFIED')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '装入 Nebula 激活请求' }))
  await waitFor(() => {
    expect((screen.getByLabelText('组件 artifact ID') as HTMLInputElement).value)
      .toBe(preparedNebulaArtifactId)
  })
}

async function prepareCompatibilityEvidence(): Promise<void> {
  fireEvent.change(screen.getByLabelText('兼容性准备精确确认'), {
    target: { value: 'PREPARE_COMPATIBILITY_EVIDENCE' }
  })
  fireEvent.click(screen.getByRole('button', { name: '签发兼容性回执' }))
  expect(await screen.findAllByText('COMPATIBLE / VERIFIED')).not.toHaveLength(0)
}

function administrator(): SessionUser {
  return {
    name: 'Administrator', role: 'administrator',
    permissions: ['updates.read', 'updates.stage', 'updates.activate']
  }
}

function operator(): SessionUser {
  return { name: 'Operator', role: 'operator', permissions: ['updates.read', 'updates.stage'] }
}

function statusFixture(): ServerStatus {
  return {
    collectedAt: '2026-08-30T12:00:00.000Z', serverName: 'Fictional DSP', state: 'stopped',
    runtime: {
      targetUps: 60, onlinePlayers: 0, maxPlayers: 16, processId: null, processCoresUsed: null,
      workingSetGiB: null, privateMemoryGiB: null, threadCount: null, priority: null,
      startedAt: null, uptimeSeconds: null
    },
    host: {
      logicalProcessors: 16, processorGroups: 1, cpuPercent: 5, memoryTotalGiB: 64,
      memoryFreeGiB: 50
    },
    versions: {
      dsp: '0.10.33.26727', nebula: '0.9.22.2', bepInEx: '5.4.23', compatible: true,
      gameLoaded: false, warnings: []
    },
    save: {
      name: 'FictionalSave', dsvPresent: true, serverPresent: true, consistent: true,
      lastSavedAt: '2026-08-30T11:00:00.000Z', dsvSizeMiB: 8, serverSizeKiB: 64,
      latestBackupAt: '2026-08-30T11:30:00.000Z', backupManifestPresent: true, backupPairPresent: true
    },
    automation: {
      serverTask: { state: 'ready', lastResult: 0, lastRunAt: null },
      stopTask: { state: 'ready', lastResult: 0, lastRunAt: null },
      storageTask: { state: 'ready', lastResult: 0, lastRunAt: null },
      projectRootAvailable: true, globalMappingAvailable: true
    },
    connections: [],
    capabilities: { refresh: true, start: true, save: true, gracefulStop: true, restart: true }
  }
}

function stateFixture(): UpdateActivationState {
  return {
    revision: '1'.repeat(64), recoveryRequired: false, historyEntries: 5,
    components: [
      { component: 'nebula', version: '0.9.22.2', artifactId: 'fictional-nebula-active-0001', releaseId: `nebula-${'a'.repeat(32)}` },
      { component: 'bepinex', version: '5.4.23', artifactId: 'fictional-bepinex-active-0001', releaseId: `bepinex-${'b'.repeat(32)}` },
      { component: 'bridge', version: '1.2.0', artifactId: 'fictional-bridge-active-0001', releaseId: `bridge-${'c'.repeat(32)}` },
      { component: 'control', version: '1.2.0', artifactId: 'fictional-control-active-0001', releaseId: `control-${'d'.repeat(32)}` }
    ]
  }
}

function compatibilityStatusFixture(): UpdateCompatibilityStatus {
  return {
    format: 'dyson-control-trusted-compatibility-status', schemaVersion: 1,
    available: true, policyId: 'fictional-policy-0001', policyRevision: '3'.repeat(64),
    policyReviewedAt: '2026-08-30T10:00:00.000Z', inventoryRevision: '2'.repeat(64),
    inventory: {
      dsp: '0.10.33.26727', nebula: '0.9.22.2', bepInEx: '5.4.23', plugins: []
    }
  }
}

function compatibilityReceiptFixture(receiptId = '22222222-2222-4222-8222-222222222222'): UpdateCompatibilityReceipt {
  return {
    format: 'dyson-control-trusted-compatibility-receipt', schemaVersion: 1,
    receiptId, component: 'nebula',
    artifactId: preparedNebulaArtifactId, artifactSha256: preparedNebulaSha256,
    targetVersion: '0.9.22', inventoryRevision: '2'.repeat(64),
    policyId: 'fictional-policy-0001', policyRevision: '3'.repeat(64),
    matchedEntryId: 'ui-nebula-candidate', compatible: true,
    issuedAt: '2026-08-30T12:00:00.000Z', expiresAt: '2099-08-31T08:00:00.000Z',
    reused: false
  }
}

function cleanupFixture(): UpdateCleanupPlan {
  return {
    format: 'dyson-control-component-update-cleanup-plan', schemaVersion: 1,
    dryRun: true, executeSupported: false,
    candidates: [
      { kind: 'history', opaqueId: 'fictional-history-0001', recoverable: true, reason: 'history-retention-exceeded' },
      { kind: 'release', opaqueId: 'fictional-release-0001', recoverable: true, reason: 'unreferenced-release' }
    ]
  }
}

function requestFixture(): UpdateActivationRequest {
  return {
    requestId: '11111111-1111-4111-8111-111111111111', component: 'nebula',
    artifactId: preparedNebulaArtifactId, sha256: preparedNebulaSha256,
    targetVersion: '0.9.22', expectedRevision: '1'.repeat(64),
    compatibilityReceiptId: '22222222-2222-4222-8222-222222222222'
  }
}

function planFixture(input: UpdateActivationRequest = requestFixture()): UpdateActivationPlan {
  const request = { ...input, compatibilityReceiptId: input.compatibilityReceiptId ?? requestFixture().compatibilityReceiptId }
  return {
    format: 'dyson-control-component-update-plan', schemaVersion: 1, dryRun: true,
    requestId: request.requestId, component: 'nebula', artifactId: request.artifactId!,
    targetVersion: request.targetVersion, expectedRevision: request.expectedRevision,
    compatibilityReceiptId: request.compatibilityReceiptId!,
    releaseId: `nebula-${'e'.repeat(32)}`, fileCount: 7, expandedBytes: 262_144,
    compatibility: {
      compatible: true, matchedEntryId: 'ui-nebula-candidate',
      inventory: {
        dsp: '0.10.33.26727', nebula: '0.9.22', bepInEx: '5.4.23',
        plugins: []
      },
      evaluations: [{ entryId: 'ui-nebula-candidate', compatible: true, reasons: [] }]
    },
    operations: [
      'acquire-global-update-lock', 'verify-staged-artifact-and-archive',
      'assemble-immutable-release', 'prove-process-stopped-and-port-closed',
      'capture-config-mod-lock-and-loaded-save-baseline', 'create-paired-save-protection-point',
      'bind-rollback-context-journal', 'revalidate-stop-revision-and-compatibility',
      'publish-and-verify-fixed-live-component', 'run-fixed-health-check',
      'restore-component-config-mod-lock-and-paired-save-on-failure',
      'prove-current-generation-exact-save-load', 'persist-audit-safe-receipt',
      'release-global-update-lock'
    ],
    rollback: { automatic: true, previousReleaseRequired: true, recoveryRequiredIfUnproven: true }
  }
}

function preparationReceiptFixture(
  requestId = preparationReceiptId
): ComponentCandidatePreparationReceipt {
  const sourceArtifactId = `artifact-${'b'.repeat(40)}`
  return {
    format: 'dyson-control-component-preparation-receipt',
    schemaVersion: 1,
    requestId,
    component: 'nebula',
    acquisitionReceiptId: '11111111-1111-4111-8111-111111111111',
    source: {
      provider: 'github',
      sourceId: 'github:NebulaModTeam/nebula',
      version: '0.9.22',
      artifactId: sourceArtifactId,
      sizeBytes: 4096,
      sha256: 'c'.repeat(64),
      integrity: 'provider-verified'
    },
    prepared: {
      mode: 'normalized-nebula-windows',
      artifactId: preparedNebulaArtifactId,
      layoutPolicy: 'nebula-official-windows-v0.9.22',
      sizeBytes: 8192,
      sha256: preparedNebulaSha256,
      integrity: 'normalized-locally-computed'
    },
    staging: {
      created: true,
      manifest: {
        format: 'dyson-control-staged-artifact',
        schemaVersion: 1,
        artifactId: preparedNebulaArtifactId,
        artifactFile: 'artifact.bin',
        release: {
          kind: 'nebula',
          sourceId: 'github:NebulaModTeam/nebula',
          version: '0.9.22'
        },
        sizeBytes: 8192,
        sha256: preparedNebulaSha256,
        integrity: 'locally-computed',
        stagedAt: '2026-08-30T12:05:00.000Z'
      }
    },
    state: 'staged',
    reused: false,
    preparedAt: '2026-08-30T12:05:00.000Z'
  }
}

function receiptFixture(input: UpdateActivationRequest = requestFixture()): UpdateActivationReceipt {
  const request = { ...input, compatibilityReceiptId: input.compatibilityReceiptId ?? requestFixture().compatibilityReceiptId }
  return {
    format: 'dyson-control-component-update-receipt', schemaVersion: 1,
    requestId: request.requestId, component: 'nebula', artifactId: request.artifactId!,
    compatibilityReceiptId: request.compatibilityReceiptId!,
    targetVersion: request.targetVersion, releaseId: `nebula-${'e'.repeat(32)}`,
    status: 'succeeded', previousRevision: request.expectedRevision, resultingRevision: '2'.repeat(64),
    protectionBackupId: 'fictional-backup-0001',
    rollbackBindingSha256: 'f'.repeat(64),
    rollbackSteps: {
      component: 'not-required', configuration: 'not-required', serverModLock: 'not-required',
      pairedSave: 'not-required', previousSaveLoad: 'not-required'
    },
    failureCode: null, rollbackVerified: false, recoveryRequired: false,
    fileCount: 7, expandedBytes: 262_144,
    completedAt: '2026-08-30T12:30:00.000Z', reused: false
  }
}

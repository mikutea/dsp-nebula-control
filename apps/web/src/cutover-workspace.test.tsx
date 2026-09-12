// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CutoverWorkspace } from './CutoverWorkspace'
import {
  api,
  ApiError,
  CUTOVER_PREPARE_CONFIRMATION,
  CUTOVER_RECOVERY_CONFIRMATION
} from './api'
import type {
  CutoverPreviewReceipt,
  CutoverReceipt,
  CutoverRecoveryStatus,
  SessionUser
} from './model'

beforeEach(() => {
  vi.spyOn(api, 'previewCutover').mockImplementation(async (input) => ({
    data: previewReceipt(input.requestId, input.operation, input.operation === 'rollback' ? input.mode : null)
  }))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Cutover workspace', () => {
  it('keeps demo cutover honest without requesting a production-only controller', () => {
    const status = vi.spyOn(api, 'cutoverStatus')

    render(<CutoverWorkspace user={administrator()} demo />)

    expect(screen.getByText('DEMO READ-ONLY')).toBeTruthy()
    expect(screen.getByText('演示环境未装载持久化 Cutover 控制链')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '读取服务端预演' })).toBeNull()
    expect(status).not.toHaveBeenCalled()
  })

  it.each([
    ['viewer', ['cutover.read']],
    ['operator', ['cutover.read', 'cutover.execute']]
  ] as const)('keeps the %s role on the durable read-only surface', async (role, permissions) => {
    const read = vi.spyOn(api, 'cutoverStatus').mockResolvedValue({ data: readyStatus() })
    render(<CutoverWorkspace user={user(role, [...permissions])} />)

    expect(await screen.findByText('READY')).toBeTruthy()
    expect(screen.getByText('READ-ONLY CUTOVER SURFACE')).toBeTruthy()
    const actionButtons = screen.getAllByRole('button', { name: '需要 Administrator' })
    expect(actionButtons).toHaveLength(4)
    expect(actionButtons.every((button) => (button as HTMLButtonElement).disabled)).toBe(true)
    expect(screen.queryByLabelText('Cutover 精确确认')).toBeNull()
    expect(screen.queryByRole('textbox', { name: /主机|路径|命令|端口/i })).toBeNull()
    expect(read).toHaveBeenCalledTimes(1)
    expect(api.previewCutover).not.toHaveBeenCalled()
  })

  it('requires a stable server preview plus the exact confirmation before an Administrator prepare', async () => {
    vi.spyOn(api, 'cutoverStatus').mockResolvedValue({ data: readyStatus() })
    const prepare = vi.spyOn(api, 'prepareCutover').mockImplementation(async (requestId) => ({
      data: receipt('prepared', requestId)
    }))
    render(<CutoverWorkspace user={administrator()} />)
    await screen.findByText('READY')

    fireEvent.click(screen.getAllByRole('button', { name: '读取服务端预演' })[0]!)
    expect(await screen.findByText('SERVER PLAN 已签发')).toBeTruthy()
    const execute = screen.getByRole('button', { name: '重新预演并提交' }) as HTMLButtonElement
    expect(execute.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Cutover 精确确认'), { target: { value: 'PREPARE' } })
    expect(execute.disabled).toBe(true)
    expect(api.previewCutover).toHaveBeenCalledTimes(1)
    expect(prepare).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Cutover 精确确认'), {
      target: { value: CUTOVER_PREPARE_CONFIRMATION }
    })
    expect(execute.disabled).toBe(false)
    fireEvent.click(execute)

    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1))
    const preview = vi.mocked(api.previewCutover)
    expect(preview).toHaveBeenCalledTimes(2)
    expect(preview.mock.calls[0]?.[0]).toEqual(preview.mock.calls[1]?.[0])
    expect(prepare).toHaveBeenCalledWith(
      expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      planFingerprint,
      CUTOVER_PREPARE_CONFIRMATION,
      expect.any(AbortSignal)
    )
    expect(await screen.findByText('prepared')).toBeTruthy()
    expect(screen.getByText('STARTED → TERMINAL')).toBeTruthy()
  })

  it('replaces a changed re-preview, clears confirmation, and performs zero execute calls', async () => {
    const changedFingerprint = 'f'.repeat(64)
    vi.spyOn(api, 'cutoverStatus').mockResolvedValue({ data: readyStatus() })
    vi.mocked(api.previewCutover)
      .mockImplementationOnce(async (input) => ({
        data: previewReceipt(input.requestId, 'prepare', null)
      }))
      .mockImplementationOnce(async (input) => ({
        data: {
          ...previewReceipt(input.requestId, 'prepare', null),
          evidenceDigest: 'e'.repeat(64),
          planFingerprint: changedFingerprint
        }
      }))
    const prepare = vi.spyOn(api, 'prepareCutover')
    render(<CutoverWorkspace user={administrator()} />)
    await screen.findByText('READY')

    fireEvent.click(screen.getAllByRole('button', { name: '读取服务端预演' })[0]!)
    await screen.findByText('SERVER PLAN 已签发')
    fireEvent.change(screen.getByLabelText('Cutover 精确确认'), {
      target: { value: CUTOVER_PREPARE_CONFIRMATION }
    })
    fireEvent.click(screen.getByRole('button', { name: '重新预演并提交' }))

    expect(await screen.findByText('操作保持锁定')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('CUTOVER_BROWSER_PREFLIGHT_CHANGED')
    expect((screen.getByLabelText('Cutover 精确确认') as HTMLInputElement).value).toBe('')
    expect(screen.getByText(shortDigest(changedFingerprint))).toBeTruthy()
    expect(prepare).not.toHaveBeenCalled()
  })

  it('turns a default-off 423 into an explicit locked surface', async () => {
    vi.spyOn(api, 'cutoverStatus').mockResolvedValue({ data: readyStatus() })
    const prepare = vi.spyOn(api, 'prepareCutover').mockRejectedValue(
      new ApiError(
        423,
        'Cutover 普通切换门禁默认关闭；当前只允许读取与预演。',
        'CUTOVER_HTTP_MUTATION_DISABLED'
      )
    )
    render(<CutoverWorkspace user={administrator()} />)
    await screen.findByText('READY')
    fireEvent.click(screen.getAllByRole('button', { name: '读取服务端预演' })[0]!)
    await screen.findByText('SERVER PLAN 已签发')
    fireEvent.change(screen.getByLabelText('Cutover 精确确认'), {
      target: { value: CUTOVER_PREPARE_CONFIRMATION }
    })
    fireEvent.click(screen.getByRole('button', { name: '重新预演并提交' }))

    expect(await screen.findByText('FAIL-CLOSED · 服务端返回 423')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('CUTOVER_HTTP_MUTATION_DISABLED')
    expect(screen.getAllByRole('button', { name: '读取服务端预演' })
      .every((button) => (button as HTMLButtonElement).disabled)).toBe(true)
    expect(screen.queryByLabelText('Cutover 精确确认')).toBeNull()
    expect(prepare).toHaveBeenCalledTimes(1)
  })

  it('uses only the server-owned recovery request ID and an allowed desired target', async () => {
    const recovery = recoveryStatus()
    const status = vi.spyOn(api, 'cutoverStatus')
      .mockResolvedValueOnce({ data: recovery })
      .mockResolvedValueOnce({ data: recovery })
      .mockResolvedValueOnce({ data: recovery })
      .mockResolvedValue({ data: readyStatus() })
    const recover = vi.spyOn(api, 'recoverCutover').mockResolvedValue({
      data: receipt('recovered-previous', recoveryRequestId)
    })
    render(<CutoverWorkspace user={administrator()} />)

    expect(await screen.findByText('显式恢复工作流')).toBeTruthy()
    expect(screen.getByText(recoveryRequestId)).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: /request id/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '恢复到 GSManager' }))
    await screen.findByText('RECOVERY PREFLIGHT 已生成')
    expect(screen.getByText('服务端持久身份')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Cutover 精确确认'), {
      target: { value: CUTOVER_RECOVERY_CONFIRMATION }
    })
    fireEvent.click(screen.getByRole('button', { name: '重新预演并提交' }))

    await waitFor(() => expect(recover).toHaveBeenCalledWith(
      recoveryRequestId,
      'previous',
      CUTOVER_RECOVERY_CONFIRMATION,
      expect.any(AbortSignal)
    ))
    expect(await screen.findByText('recovered-previous')).toBeTruthy()
    await waitFor(() => expect(status).toHaveBeenCalledTimes(4))
  })

  it('prevents duplicate mutation clicks while one exact request is pending', async () => {
    vi.spyOn(api, 'cutoverStatus').mockResolvedValue({ data: readyStatus() })
    const pending = deferred<{ data: CutoverReceipt }>()
    const prepare = vi.spyOn(api, 'prepareCutover').mockImplementation(async () => pending.promise)
    render(<CutoverWorkspace user={administrator()} />)
    await screen.findByText('READY')
    fireEvent.click(screen.getAllByRole('button', { name: '读取服务端预演' })[0]!)
    await screen.findByText('SERVER PLAN 已签发')
    fireEvent.change(screen.getByLabelText('Cutover 精确确认'), {
      target: { value: CUTOVER_PREPARE_CONFIRMATION }
    })
    const execute = screen.getByRole('button', { name: '重新预演并提交' })
    fireEvent.click(execute)
    fireEvent.click(execute)

    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1))
    expect(prepare.mock.calls[0]?.[1]).toBe(planFingerprint)
    expect(prepare.mock.calls[0]?.[2]).toBe(CUTOVER_PREPARE_CONFIRMATION)
    expect((screen.getByRole('button', { name: '重新签发并校验计划中…' }) as HTMLButtonElement).disabled).toBe(true)
    const id = prepare.mock.calls[0]![0]
    pending.resolve({ data: receipt('prepared', id) })
    expect(await screen.findByText('prepared')).toBeTruthy()
    expect(prepare).toHaveBeenCalledTimes(1)
  })

  it('re-reads durable status when the browser reconnects', async () => {
    const status = vi.spyOn(api, 'cutoverStatus').mockResolvedValue({ data: readyStatus() })
    render(<CutoverWorkspace user={user('viewer', ['cutover.read'])} />)
    await screen.findByText('READY')
    window.dispatchEvent(new Event('online'))
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2))
  })
})

const recoveryRequestId = '44444444-4444-4444-8444-444444444444'
const planFingerprint = 'a'.repeat(64)

function previewReceipt(
  requestId: string,
  operation: CutoverPreviewReceipt['operation'],
  rollbackMode: CutoverPreviewReceipt['rollbackMode']
): CutoverPreviewReceipt {
  return {
    format: 'dyson-control-cutover-preview',
    schemaVersion: 1,
    operation,
    requestId,
    rollbackMode,
    stateRevision: 'b'.repeat(64),
    evidenceDigest: 'c'.repeat(64),
    planFingerprint,
    summary: summary()
  }
}

function shortDigest(value: string): string {
  return `${value.slice(0, 12)}…${value.slice(-8)}`
}

function user(role: SessionUser['role'], permissions: SessionUser['permissions']): SessionUser {
  return {
    name: role === 'administrator' ? 'Administrator' : role === 'operator' ? 'Operator' : 'Viewer',
    role,
    permissions
  }
}

function administrator(): SessionUser {
  return user('administrator', ['cutover.read', 'cutover.execute'])
}

function readyStatus(): CutoverRecoveryStatus {
  return {
    schemaVersion: 1,
    phase: 'ready',
    status: 'ready',
    mutationBlocked: false,
    recoveryRequired: false,
    requestId: null,
    allowedDesired: [],
    summary: summary(),
    errorCode: null
  }
}

function recoveryStatus(): CutoverRecoveryStatus {
  return {
    schemaVersion: 1,
    phase: 'recovery-required',
    status: 'interrupted',
    mutationBlocked: true,
    recoveryRequired: true,
    requestId: recoveryRequestId,
    allowedDesired: ['previous'],
    summary: summary(),
    errorCode: 'CUTOVER_RECOVERY_REQUIRED'
  }
}

function receipt(phase: CutoverReceipt['phase'], requestId: string): CutoverReceipt {
  return {
    requestId,
    phase,
    status: 'succeeded',
    allowedDesired: [],
    summary: summary(),
    errorCode: null
  }
}

function summary(): CutoverReceipt['summary'] {
  return {
    candidateDefined: true,
    candidateDisabled: true,
    previousAuthorityEnabled: true,
    candidateAuthorityEnabled: false,
    previousRuntimeHealthy: true,
    candidateRuntimeHealthy: false,
    processesStopped: false,
    portClosed: false,
    uniqueAuthority: true,
    saveProtected: true,
    baselineRestored: false,
    currentProgressProtected: false,
    reused: false
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

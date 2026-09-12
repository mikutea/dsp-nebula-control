// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OperatorRollbackPanel } from './OperatorRollbackPanel'
import { operatorRollbackApi, type RollbackRequest } from './operator-rollback-api'
vi.mock('./operator-rollback-api', async importOriginal => ({ ...await importOriginal<typeof import('./operator-rollback-api')>(), operatorRollbackApi: { state: vi.fn(), preview: vi.fn(), submit: vi.fn(), receipt: vi.fn() } }))
const source = '22222222-2222-4222-8222-222222222222'
const revision = 'a'.repeat(64)
const request: RollbackRequest = { requestId: '11111111-1111-4111-8111-111111111111', sourceRequestId: source,
  expectedRevision: revision, expectedPlanSha256: 'b'.repeat(64) }
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear()
  vi.mocked(operatorRollbackApi.state).mockResolvedValue({ executionEnabled: false, recoveryEnabled: true, pending: [] })
  vi.mocked(operatorRollbackApi.preview).mockImplementation(async input => ({ ...input,
    format: 'dyson-control-component-rollback-plan', schemaVersion: 1, dryRun: true, component: 'nebula', targetVersion: '0.9.1',
    materialSha256: revision, rollbackBindingSha256: revision, sourceProtectionBackupId: 'source-backup',
    restoreFileCount: 1, removeFileCount: 0, planSha256: request.expectedPlanSha256, currentConfigurationRevision: revision }))
  vi.mocked(operatorRollbackApi.submit).mockImplementation(async input => ({ format: 'dyson-control-operator-rollback-receipt', schemaVersion: 1,
    requestId: input.requestId, sourceRequestId: input.sourceRequestId, planSha256: input.expectedPlanSha256,
    resultingRevision: revision, protectionBackupId: 'forward-backup', status: 'succeeded', recoveryRequired: false }))
})
afterEach(cleanup)
it('keeps confirmation disabled when the server execution gate is closed', async () => {
  render(<OperatorRollbackPanel revision={revision} canExecute={true} />)
  fireEvent.change(screen.getByLabelText('回退源更新请求 ID'), { target: { value: source } })
  await waitFor(() => expect((screen.getByText('预演回退') as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByText('预演回退'))
  await screen.findByText(/目标：nebula/)
  fireEvent.click(screen.getByRole('checkbox'))
  expect((screen.getByText('确认回退') as HTMLButtonElement).disabled).toBe(true)
  expect(operatorRollbackApi.submit).not.toHaveBeenCalled()
})
it('recovers the original persisted request instead of making a new plan', async () => {
  vi.mocked(operatorRollbackApi.state).mockResolvedValueOnce({ executionEnabled: false, recoveryEnabled: true,
    pending: [{ request, phase: 'files-restored' }] })
  render(<OperatorRollbackPanel revision={revision} canExecute={true} />)
  await screen.findByText(/未完成回退：/)
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByText('继续未完成回退'))
  await waitFor(() => expect(operatorRollbackApi.submit).toHaveBeenCalledWith(request, true))
  expect(operatorRollbackApi.preview).not.toHaveBeenCalled()
  await screen.findByText(/持久回执已核对/)
  expect(sessionStorage.getItem('dyson-operator-rollback-id')).toBe(request.requestId)
})

it('restores the exact saved request after state enumeration fails', async () => {
  sessionStorage.setItem('dyson-operator-rollback-request', JSON.stringify(request))
  vi.mocked(operatorRollbackApi.state).mockRejectedValue(new Error('incomplete intent'))
  render(<OperatorRollbackPanel revision={revision} canExecute={true} />)
  await screen.findByText(/无法读取回退状态/)
  expect(operatorRollbackApi.submit).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByText('恢复本页保存的回退请求'))
  await waitFor(() => expect(operatorRollbackApi.submit).toHaveBeenCalledWith(request, true))
  await screen.findByText(/持久回执已核对/)
  expect(sessionStorage.getItem('dyson-operator-rollback-request')).toBeNull()
})
it.each([
  ['invalid saved request', false, true, '{"requestId":"invalid"}'],
  ['read-only role', false, false, JSON.stringify(request)],
  ['closed recovery gate', true, true, JSON.stringify(request)]
] as const)('never submits automatically or bypasses %s', async (_name, closed, canExecute, saved) => {
  sessionStorage.setItem('dyson-operator-rollback-request', saved)
  vi.mocked(operatorRollbackApi.state).mockResolvedValue({ executionEnabled: false, recoveryEnabled: !closed, pending: [] })
  render(<OperatorRollbackPanel revision={revision} canExecute={canExecute} />)
  await waitFor(() => expect(operatorRollbackApi.state).toHaveBeenCalled())
  expect(operatorRollbackApi.submit).not.toHaveBeenCalled()
  const recover = screen.queryByText('恢复本页保存的回退请求') as HTMLButtonElement | null
  if (_name === 'invalid saved request') expect(recover).toBeNull()
  else {
    const confirm = screen.getByRole('checkbox') as HTMLInputElement
    if (!confirm.disabled) fireEvent.click(confirm)
    expect(recover?.disabled).toBe(true)
    fireEvent.click(recover!)
    expect(operatorRollbackApi.submit).not.toHaveBeenCalled()
  }
})

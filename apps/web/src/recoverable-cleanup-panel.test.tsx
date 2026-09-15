// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RecoverableCleanupPanel } from './RecoverableCleanupPanel'
import { recoverableCleanupApi as api } from './recoverable-cleanup-api'
vi.mock('./recoverable-cleanup-api', async importOriginal => ({ ...await importOriginal<typeof import('./recoverable-cleanup-api')>(), recoverableCleanupApi: { state: vi.fn(), preview: vi.fn(), execute: vi.fn(), recover: vi.fn(), restore: vi.fn(), receipt: vi.fn() } }))
const revision = 'a'.repeat(64), requestId = '11111111-1111-4111-8111-111111111111'
beforeEach(() => { sessionStorage.clear(); vi.clearAllMocks(); vi.mocked(api.state).mockResolvedValue({ executionEnabled: false, recoveryEnabled: false, transactions: [] }) })
afterEach(cleanup)
it('keeps execution closed after a valid preview when the server gate is off', async () => {
  vi.mocked(api.preview).mockResolvedValue({ format: 'dyson-recoverable-component-cleanup-plan', schemaVersion: 1,
    requestId, expectedRevision: revision, planSha256: 'b'.repeat(64), candidates: [{ kind: 'history', opaqueId: requestId, sha256: revision, sizeBytes: 1 }] })
  render(<RecoverableCleanupPanel revision={revision} canExecute={true} />)
  await waitFor(() => expect((screen.getByText('预演可恢复清理') as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByText('预演可恢复清理'))
  await screen.findByText('计划隔离 1 项材料。')
  fireEvent.click(screen.getByRole('checkbox'))
  expect((screen.getByText('确认隔离材料') as HTMLButtonElement).disabled).toBe(true)
  expect(api.execute).not.toHaveBeenCalled()
})
it('offers recovery of the server-recorded transaction without creating a new request', async () => {
  const transaction = { requestId, sourceRequestId: requestId, expectedRevision: revision, direction: 'quarantine' as const,
    state: 'running' as const, completedCount: 0, totalCount: 1, actor: 'Administrator', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: null, planSha256: 'b'.repeat(64) }
  vi.mocked(api.state).mockResolvedValue({ executionEnabled: true, recoveryEnabled: true, transactions: [transaction] })
  vi.mocked(api.recover).mockRejectedValue(new Error('fixture interruption'))
  render(<RecoverableCleanupPanel revision={revision} canExecute={true} />)
  await screen.findByText('继续清理事务')
  expect((screen.getByText('预演可恢复清理') as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByText('继续清理事务'))
  await waitFor(() => expect(api.recover).toHaveBeenCalledWith(transaction))
  expect(api.preview).not.toHaveBeenCalled()
})
it('recovers a saved restore request after reload without changing its identity', async () => {
  const saved = { requestId, sourceRequestId: '22222222-2222-4222-8222-222222222222', expectedRevision: revision,
    planSha256: 'b'.repeat(64), direction: 'restore' as const }
  sessionStorage.setItem('dyson-cleanup-request', JSON.stringify(saved))
  vi.mocked(api.state).mockRejectedValue(new Error('state unavailable'))
  vi.mocked(api.recover).mockRejectedValue(new Error('recovery remains pending'))
  render(<RecoverableCleanupPanel revision={revision} canExecute={true} />)
  await screen.findByText('恢复本页清理请求')
  expect(api.recover).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByText('恢复本页清理请求'))
  await waitFor(() => expect(api.recover).toHaveBeenCalledWith(saved))
  expect(JSON.parse(sessionStorage.getItem('dyson-cleanup-request')!)).toEqual(saved)
})

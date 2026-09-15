// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { PersistedSaveRecoveryLookup } from './PersistedSaveRecoveryLookup'
import type { SaveJobExecutionResultWithMaintenance } from './save-reconcile-contract'

const jobId = '11111111-1111-4111-8111-111111111111'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('persisted save recovery lookup', () => {
  it('restores reachability after a page remount and waits for an explicit click before GET', async () => {
    const saveJob = vi.spyOn(api, 'saveJob').mockResolvedValue({ data: fixture() })
    const firstView = render(<PersistedSaveRecoveryLookup onLoaded={() => undefined} />)

    fireEvent.change(screen.getByLabelText('恢复作业 UUID'), { target: { value: jobId } })
    expect(saveJob).not.toHaveBeenCalled()
    firstView.unmount()

    const onLoaded = vi.fn()
    render(<PersistedSaveRecoveryLookup onLoaded={onLoaded} />)
    expect(saveJob).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('恢复作业 UUID'), { target: { value: jobId } })
    expect(saveJob).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '查找恢复作业' }))

    await waitFor(() => expect(onLoaded).toHaveBeenCalledTimes(1))
    expect(saveJob).toHaveBeenCalledTimes(1)
    expect(saveJob).toHaveBeenCalledWith(jobId)
    expect(screen.getByText(`已载入恢复作业 ${jobId}`)).toBeTruthy()
  })

  it('rejects a malformed or padded UUID without issuing any request', () => {
    const saveJob = vi.spyOn(api, 'saveJob')
    render(<PersistedSaveRecoveryLookup onLoaded={() => undefined} />)

    const input = screen.getByLabelText('恢复作业 UUID')
    const button = screen.getByRole('button', { name: '查找恢复作业' }) as HTMLButtonElement
    for (const invalid of ['not-a-uuid', ` ${jobId}`, `${jobId} `]) {
      fireEvent.change(input, { target: { value: invalid } })
      expect(button.disabled).toBe(true)
      fireEvent.click(button)
    }

    expect(screen.getByText(/不会自动修剪或补全/)).toBeTruthy()
    expect(saveJob).not.toHaveBeenCalled()
  })

  it.each([
    ['a backup job', { kind: 'save.backup', operation: 'backup' }, '不是 save.restore'],
    ['a non-recovery restore', { recoveryRequired: false }, '未标记 recoveryRequired'],
    ['a running recovery restore', { runState: 'running', jobState: 'running' }, '状态不是 interrupted']
  ] as const)('fails closed and does not publish %s', async (_name, patch, expectedError) => {
    const saveJob = vi.spyOn(api, 'saveJob').mockResolvedValue({ data: fixture(patch) })
    const onLoaded = vi.fn()
    render(<PersistedSaveRecoveryLookup onLoaded={onLoaded} />)

    fireEvent.change(screen.getByLabelText('恢复作业 UUID'), { target: { value: jobId } })
    fireEvent.click(screen.getByRole('button', { name: '查找恢复作业' }))

    expect((await screen.findByRole('alert')).textContent).toContain(expectedError)
    expect(saveJob).toHaveBeenCalledTimes(1)
    expect(onLoaded).not.toHaveBeenCalled()
  })

  it('publishes one strictly matching interrupted restore with recovery required', async () => {
    const execution = fixture()
    vi.spyOn(api, 'saveJob').mockResolvedValue({ data: execution })
    const onLoaded = vi.fn(async () => undefined)
    render(<PersistedSaveRecoveryLookup onLoaded={onLoaded} />)

    fireEvent.change(screen.getByLabelText('恢复作业 UUID'), { target: { value: jobId } })
    fireEvent.click(screen.getByRole('button', { name: '查找恢复作业' }))

    await waitFor(() => expect(onLoaded).toHaveBeenCalledTimes(1))
    expect(onLoaded).toHaveBeenCalledWith(execution)
  })
})

type FixturePatch = Readonly<{
  kind?: 'save.backup' | 'save.restore'
  operation?: 'backup' | 'restore'
  recoveryRequired?: boolean
  runState?: SaveJobExecutionResultWithMaintenance['run']['state']
  jobState?: SaveJobExecutionResultWithMaintenance['job']['state']
}>

function fixture(patch: FixturePatch = {}): SaveJobExecutionResultWithMaintenance {
  const kind = patch.kind ?? 'save.restore'
  const operation = patch.operation ?? 'restore'
  const runState = patch.runState ?? 'interrupted'
  const jobState = patch.jobState ?? 'failed'
  const createdAt = '2026-09-05T01:00:00.000Z'
  return {
    job: {
      id: jobId,
      kind,
      state: jobState,
      actor: 'Administrator',
      createdAt,
      startedAt: '2026-09-05T01:00:01.000Z',
      finishedAt: jobState === 'running' ? null : '2026-09-05T01:00:02.000Z',
      durationMs: jobState === 'running' ? null : 1_000,
      summary: 'Fictional persisted recovery fixture',
      errorCode: jobState === 'running' ? null : 'SAVE_COMMIT_CLEANUP_PENDING'
    },
    run: {
      jobId,
      operation,
      state: runState,
      attemptCount: 1,
      result: {
        status: 'succeeded',
        backupId: operation === 'restore' ? 'fictional-backup' : 'tx-33333333-3333-4333-8333-333333333333',
        protectionBackupId: operation === 'restore' ? 'tx-44444444-4444-4444-8444-444444444444' : null,
        pairBytes: 2_048,
        rollback: 'not-required',
        reused: false,
        auditStored: true,
        cleanupPending: true,
        maintenanceRequired: true
      },
      errorCode: runState === 'running' ? null : 'SAVE_COMMIT_CLEANUP_PENDING',
      recoveryRequired: patch.recoveryRequired ?? true,
      createdAt,
      updatedAt: '2026-09-05T01:00:02.000Z'
    },
    reused: false
  }
}

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SaveRecoveryPanel } from './SaveRecoveryPanel'
import {
  SAVE_JOB_RECONCILE_CONFIRMATION,
  type SaveJobExecutionResultWithMaintenance
} from './save-reconcile-contract'

afterEach(cleanup)

describe('save recovery panel', () => {
  it('requires the exact confirmation and invokes one explicit reconcile callback', async () => {
    const onReconcile = vi.fn(async () => undefined)
    render(<SaveRecoveryPanel currentJob={fixture()} role="administrator" busy={false}
      onReconcile={onReconcile} onRefresh={() => undefined} />)

    expect(screen.getByText(/\.dsv \+ \.server 始终是一个原子存档对/)).toBeTruthy()
    const execute = screen.getByRole('button', { name: '授权持久化对账' }) as HTMLButtonElement
    expect(execute.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/输入 RECONCILE_SAVE_JOB/), { target: { value: 'RECONCILE_SAVE_JOB ' } })
    expect(execute.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/输入 RECONCILE_SAVE_JOB/), {
      target: { value: SAVE_JOB_RECONCILE_CONFIRMATION }
    })
    fireEvent.click(execute)

    await waitFor(() => expect(onReconcile).toHaveBeenCalledTimes(1))
    expect(onReconcile).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      SAVE_JOB_RECONCILE_CONFIRMATION
    )
  })

  it.each([
    ['SAVE_COMMIT_CLEANUP_PENDING', 'succeeded', 'not-required', true, true, true, '已提交存档对等待收尾'],
    ['SAVE_ROLLBACK_CLEANUP_PENDING', 'rolled-back', 'succeeded', true, true, true, '已回滚存档对等待收尾'],
    ['SAVE_JOB_AUDIT_MISSING', 'succeeded', 'not-required', false, false, false, '已证明终态等待审计修复']
  ] as const)('renders the proven %s authorization reason', (
    errorCode, status, rollback, auditStored, cleanupPending, maintenanceRequired, title
  ) => {
    render(<SaveRecoveryPanel currentJob={fixture({
      errorCode, status, rollback, auditStored, cleanupPending, maintenanceRequired
    })} role="administrator" busy={false} onReconcile={() => undefined} onRefresh={() => undefined} />)
    expect(screen.getByText(title)).toBeTruthy()
    expect(screen.getByRole('button', { name: '授权持久化对账' })).toBeTruthy()
  })

  it('never offers an unsafe recovery as a blind retry', () => {
    const onReconcile = vi.fn()
    render(<SaveRecoveryPanel currentJob={fixture({
      errorCode: 'SAVE_ROLLBACK_FAILED', status: 'rollback-failed', rollback: 'failed',
      cleanupPending: false, maintenanceRequired: true
    })} role="administrator" busy={false} onReconcile={onReconcile} onRefresh={() => undefined} />)

    expect(screen.getByText('当前终态只允许人工核验')).toBeTruthy()
    expect(screen.getByText(/保留当前存档对和事务证据/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '授权持久化对账' })).toBeNull()
    expect(onReconcile).not.toHaveBeenCalled()
  })

  it('keeps a proven terminal read-only for non-administrators', () => {
    const onReconcile = vi.fn()
    render(<SaveRecoveryPanel currentJob={fixture()} role="operator" busy={false}
      onReconcile={onReconcile} onRefresh={() => undefined} />)
    expect(screen.getByText(/仅 Administrator 可执行/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '授权持久化对账' })).toBeNull()
  })

  it('does not auto-submit an in-progress reconciliation and only refreshes the same job', () => {
    const onReconcile = vi.fn()
    const onRefresh = vi.fn()
    render(<SaveRecoveryPanel currentJob={fixture({
      jobState: 'queued', runState: 'queued', jobErrorCode: null, errorCode: null,
      startedAt: null, finishedAt: null, durationMs: null
    })} role="administrator" busy={false} onReconcile={onReconcile} onRefresh={onRefresh} />)

    expect(screen.getByText('持久化对账正在执行')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '授权持久化对账' })).toBeNull()
    expect(onReconcile).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '刷新同一作业状态' }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(onRefresh).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111')
  })

  it('locks a possibly accepted mutation until an explicit refresh without disabling refresh itself', () => {
    const onReconcile = vi.fn()
    const onRefresh = vi.fn()
    render(<SaveRecoveryPanel currentJob={fixture()} role="administrator" busy={false}
      reconcileDisabled reconcileDisabledReason="先刷新同一作业"
      onReconcile={onReconcile} onRefresh={onRefresh} />)

    expect(screen.getByText('先刷新同一作业')).toBeTruthy()
    const input = screen.getByLabelText(/输入 RECONCILE_SAVE_JOB/) as HTMLInputElement
    expect(input.disabled).toBe(true)
    expect((screen.getByRole('button', { name: '授权持久化对账' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '刷新同一作业状态' }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(onReconcile).not.toHaveBeenCalled()
  })

  it('renders nothing when no recovery is required', () => {
    const currentJob = fixture()
    currentJob.run.recoveryRequired = false
    const { container } = render(<SaveRecoveryPanel currentJob={currentJob} role="administrator" busy={false}
      onReconcile={() => undefined} onRefresh={() => undefined} />)
    expect(container.childElementCount).toBe(0)
  })
})

type FixturePatch = {
  jobState?: 'queued' | 'running' | 'succeeded' | 'failed'
  runState?: 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted'
  jobErrorCode?: string | null
  errorCode?: string | null
  status?: 'succeeded' | 'failed' | 'rolled-back' | 'rollback-failed'
  rollback?: 'not-required' | 'succeeded' | 'failed'
  auditStored?: boolean
  cleanupPending?: boolean
  maintenanceRequired?: boolean
  startedAt?: string | null
  finishedAt?: string | null
  durationMs?: number | null
}

function fixture(patch: FixturePatch = {}): SaveJobExecutionResultWithMaintenance {
  const createdAt = '2026-09-05T01:00:00.000Z'
  return {
    job: {
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'save.restore',
      state: patch.jobState ?? 'failed',
      actor: 'Administrator',
      createdAt,
      startedAt: patch.startedAt === undefined ? '2026-09-05T01:00:01.000Z' : patch.startedAt,
      finishedAt: patch.finishedAt === undefined ? '2026-09-05T01:00:02.000Z' : patch.finishedAt,
      durationMs: patch.durationMs === undefined ? 1_000 : patch.durationMs,
      summary: 'Fictional save recovery fixture',
      errorCode: patch.jobErrorCode === undefined
        ? (patch.errorCode ?? 'SAVE_COMMIT_CLEANUP_PENDING')
        : patch.jobErrorCode
    },
    run: {
      jobId: '11111111-1111-4111-8111-111111111111',
      operation: 'restore',
      state: patch.runState ?? 'interrupted',
      attemptCount: 1,
      result: {
        status: patch.status ?? 'succeeded',
        backupId: 'tx-33333333-3333-4333-8333-333333333333',
        protectionBackupId: 'tx-44444444-4444-4444-8444-444444444444',
        pairBytes: 2048,
        rollback: patch.rollback ?? 'not-required',
        reused: false,
        auditStored: patch.auditStored ?? true,
        cleanupPending: patch.cleanupPending ?? true,
        maintenanceRequired: patch.maintenanceRequired ?? true
      },
      errorCode: patch.errorCode === undefined ? 'SAVE_COMMIT_CLEANUP_PENDING' : patch.errorCode,
      recoveryRequired: true,
      createdAt,
      updatedAt: '2026-09-05T01:00:02.000Z'
    },
    reused: false
  }
}

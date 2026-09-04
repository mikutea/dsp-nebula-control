import { describe, expect, it } from 'vitest'
import {
  normalizePlayerNoticeExecutionEnvelope,
  normalizePlayerNoticePreviewEnvelope,
  normalizePlayerNoticeReceiptEnvelope
} from './player-notice-contract'
import type { PlayerNoticePreviewInput } from './model'

const input: PlayerNoticePreviewInput = {
  rosterGeneration: `roster-v1:${'a'.repeat(64)}`,
  rosterSequence: 7,
  sessionPlayerId: 'player-000002',
  templateId: 'maintenance-5m'
}
const requestId = '44444444-5555-4666-8777-888888888888'

describe('player notice browser contract', () => {
  it('accepts only a dry-run plan bound to the exact signed evidence input', () => {
    expect(normalizePlayerNoticePreviewEnvelope({ data: { job: job('player.notice.preview'), plan: plan() } }, input))
      .not.toBeNull()
    expect(normalizePlayerNoticePreviewEnvelope({
      data: { job: job('player.notice.preview'), plan: plan({ rosterSequence: 8 }) }
    }, input)).toBeNull()
    expect(normalizePlayerNoticePreviewEnvelope({
      data: { job: job('player.notice.preview'), plan: { ...plan(), extra: 'drift' } }
    }, input)).toBeNull()
  })

  it('binds execution and read-only receipts to the same request and evidence identity', () => {
    const uncertain = receipt()
    const execution = {
      data: { job: job('player.notice', { state: 'failed', errorCode: uncertain.errorCode }), receipt: uncertain }
    }
    expect(normalizePlayerNoticeExecutionEnvelope(execution, { ...input, requestId, confirmation: 'EXECUTE' }))
      .not.toBeNull()
    expect(normalizePlayerNoticeExecutionEnvelope(execution, {
      ...input, requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', confirmation: 'EXECUTE'
    })).toBeNull()
    expect(normalizePlayerNoticeReceiptEnvelope({ data: { receipt: uncertain } }, { ...input, requestId }))
      .not.toBeNull()
    expect(normalizePlayerNoticeReceiptEnvelope({
      data: { receipt: { ...uncertain, sessionPlayerId: 'player-000003' } }
    }, { ...input, requestId })).toBeNull()
  })

  it('rejects contradictory mutation and recovery semantics', () => {
    expect(normalizePlayerNoticeReceiptEnvelope({
      data: { receipt: { ...receipt(), recoveryRequired: false } }
    }, { ...input, requestId })).toBeNull()
    expect(normalizePlayerNoticeExecutionEnvelope({ data: {
      job: job('player.notice'),
      receipt: { ...receipt(), state: 'transport-dispatched', errorCode: 'NONE', recoveryRequired: false }
    } }, { ...input, requestId, confirmation: 'EXECUTE' })).not.toBeNull()
    expect(normalizePlayerNoticePreviewEnvelope({ data: {
      job: job('player.notice.preview'),
      plan: {
        ...plan(),
        checks: plan().checks.map((check) => check.id === 'capability'
          ? { ...check, status: 'block' }
          : check)
      }
    } }, input)).toBeNull()
  })
})

function plan(patch: Record<string, unknown> = {}) {
  return {
    action: 'player.notice', mode: 'dry-run', allowed: true, executionEnabled: true,
    ...input, targetJoinedAtUnixMs: 1_788_081_002_000,
    checks: [
      { id: 'execution-gate', status: 'pass', message: '执行门禁已启用' },
      { id: 'capability', status: 'pass', message: '运行时能力已验证' },
      { id: 'session-generation', status: 'pass', message: '会话代次一致' },
      { id: 'roster-sequence', status: 'pass', message: '名单序号一致' },
      { id: 'target-session', status: 'pass', message: '目标会话在线' },
      { id: 'fixed-template', status: 'pass', message: '固定模板已验证' }
    ],
    blockers: [], mutation: false,
    rollback: { strategy: 'not-possible', ready: false, summary: '通知不可撤回。' },
    ...patch
  }
}

function receipt() {
  return {
    requestId, action: 'player.notice', state: 'uncertain',
    startedAt: '2026-08-30T10:05:01.000Z', finishedAt: '2026-08-30T10:05:21.000Z',
    ...input, targetJoinedAt: '2026-08-30T09:46:00.000Z',
    mutationMayHaveOccurred: true, recoveryRequired: true,
    rollback: { strategy: 'not-possible', summary: '请求可能已进入传输层。' },
    errorCode: 'PLAYER_NOTICE_OUTCOME_UNKNOWN'
  }
}

function job(kind: 'player.notice.preview' | 'player.notice', patch: Record<string, unknown> = {}) {
  return {
    id: kind === 'player.notice.preview'
      ? '11111111-2222-4333-8444-555555555555'
      : '22222222-3333-4444-8555-666666666666',
    kind, state: 'succeeded', actor: 'administrator',
    createdAt: '2026-08-30T10:05:00.000Z', startedAt: '2026-08-30T10:05:00.001Z',
    finishedAt: '2026-08-30T10:05:00.010Z', durationMs: 9,
    summary: 'Fictional player notice result', errorCode: null,
    ...patch
  }
}

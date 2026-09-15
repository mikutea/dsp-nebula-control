import { afterEach, expect, it, vi } from 'vitest'
import { operatorRollbackApi } from './operator-rollback-api'
afterEach(() => vi.unstubAllGlobals())
it('explains a rejected rollback source without exposing raw server messages', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false,
    error: { code: 'UPDATE_ROLLBACK_SOURCE_NOT_CURRENT', message: 'private diagnostic' } }), { status: 409 })))
  await expect(operatorRollbackApi.preview({ requestId: '11111111-1111-4111-8111-111111111111',
    sourceRequestId: '22222222-2222-4222-8222-222222222222', expectedRevision: 'a'.repeat(64) }))
    .rejects.toThrow('不是当前可回退的成功更新')
})
it('rejects malformed pending state rather than enabling recovery', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, data: {
    executionEnabled: true, recoveryEnabled: true, pending: [{ request: { command: 'anything' }, phase: 'prepared' }]
  } }), { status: 200 })))
  await expect(operatorRollbackApi.state()).rejects.toThrow('未通过校验')
})
it('requires the persisted receipt to match the submitted source and plan', async () => {
  const request = { requestId: '11111111-1111-4111-8111-111111111111', sourceRequestId: '22222222-2222-4222-8222-222222222222',
    expectedRevision: 'a'.repeat(64), expectedPlanSha256: 'b'.repeat(64) }
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: {
      format: 'dyson-control-operator-rollback-receipt', schemaVersion: 1, requestId: request.requestId,
      sourceRequestId: request.sourceRequestId, planSha256: 'c'.repeat(64), resultingRevision: 'd'.repeat(64),
      protectionBackupId: 'forward-backup', status: 'succeeded', recoveryRequired: false
    } }), { status: 200 }))
  vi.stubGlobal('fetch', fetch)
  await expect(operatorRollbackApi.submit(request, false)).rejects.toThrow('未通过校验')
  expect(fetch).toHaveBeenCalledTimes(2)
})

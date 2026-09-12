import { expect, it, vi } from 'vitest'
import { OperatorRollbackHttpController } from './operator-rollback-http.js'
const request = { requestId: '11111111-1111-4111-8111-111111111111', sourceRequestId: '22222222-2222-4222-8222-222222222222',
  expectedRevision: 'a'.repeat(64), expectedPlanSha256: 'b'.repeat(64) }
const receipt = { format: 'dyson-control-operator-rollback-receipt' as const, schemaVersion: 1 as const,
  requestId: request.requestId, sourceRequestId: request.sourceRequestId, planSha256: request.expectedPlanSha256,
  resultingRevision: 'c'.repeat(64), protectionBackupId: 'forward-backup', status: 'succeeded' as const, recoveryRequired: false as const }
function fixture() { return { executeRollback: vi.fn(async () => receipt), recoverRollback: vi.fn(async () => receipt),
  getRollbackReceipt: vi.fn(async () => receipt) } }
it('keeps gates separate and rejects invalid input before dispatch', async () => {
  const service = fixture()
  const controller = new OperatorRollbackHttpController({ service, recoveryEnabled: () => true })
  expect((await controller.execute({ request, confirmation: 'ROLLBACK_COMPONENT_UPDATE' })).statusCode).toBe(423)
  expect(service.executeRollback).not.toHaveBeenCalled()
  expect((await controller.recover({ request, confirmation: 'RECOVER_COMPONENT_ROLLBACK' })).statusCode).toBe(200)
  expect(service.recoverRollback).toHaveBeenCalledOnce()
  expect((await controller.recover({ request: { ...request, path: 'C:\\arbitrary' }, confirmation: 'RECOVER_COMPONENT_ROLLBACK' })).statusCode).toBe(400)
  expect(service.recoverRollback).toHaveBeenCalledOnce()
})
it('returns success only after an exact durable receipt readback', async () => {
  const service = fixture()
  const controller = new OperatorRollbackHttpController({ service, mutationEnabled: () => true })
  expect((await controller.execute({ request, confirmation: 'ROLLBACK_COMPONENT_UPDATE' })).statusCode).toBe(200)
  service.getRollbackReceipt.mockResolvedValue({ ...receipt, resultingRevision: 'd'.repeat(64) })
  expect((await controller.execute({ request, confirmation: 'ROLLBACK_COMPONENT_UPDATE' })).statusCode).toBe(503)
})

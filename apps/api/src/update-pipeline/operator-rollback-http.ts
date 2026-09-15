import { z } from 'zod'
import { operatorRollbackRequestSchema, type OperatorRollbackRequest, type OperatorRollbackReceipt } from './operator-rollback.js'
import { operatorRollbackReceiptSchema, operatorRollbackCanonicalJson } from './operator-rollback-records.js'

export interface OperatorRollbackHttpOptions {
  service: {
    executeRollback(input: OperatorRollbackRequest): Promise<OperatorRollbackReceipt>
    recoverRollback(input: OperatorRollbackRequest): Promise<OperatorRollbackReceipt>
    getRollbackReceipt(requestId: string): Promise<OperatorRollbackReceipt | null>
  }
  mutationEnabled?: () => boolean | Promise<boolean>
  recoveryEnabled?: () => boolean | Promise<boolean>
}
export class OperatorRollbackHttpController {
  constructor(private readonly options: OperatorRollbackHttpOptions) {}
  execute(input: unknown) { return this.submit(input, false) }
  recover(input: unknown) { return this.submit(input, true) }
  private async submit(input: unknown, recovery: boolean) {
    const envelope = z.strictObject({ request: operatorRollbackRequestSchema,
      confirmation: z.literal(recovery ? 'RECOVER_COMPONENT_ROLLBACK' : 'ROLLBACK_COMPONENT_UPDATE') }).safeParse(input)
    if (!envelope.success) return { statusCode: 400, body: { ok: false as const, error: { code: 'UPDATE_ROLLBACK_REQUEST_INVALID' } } }
    try {
      const enabled = recovery ? this.options.recoveryEnabled : this.options.mutationEnabled
      if (!enabled || await enabled() !== true) return { statusCode: 423,
        body: { ok: false as const, error: { code: 'UPDATE_ROLLBACK_DISABLED' } } }
      const request = envelope.data.request
      const result = operatorRollbackReceiptSchema.parse(await (recovery
        ? this.options.service.recoverRollback(request) : this.options.service.executeRollback(request)))
      const persisted = operatorRollbackReceiptSchema.parse(await this.options.service.getRollbackReceipt(request.requestId))
      if (persisted.requestId !== request.requestId || persisted.sourceRequestId !== request.sourceRequestId ||
          persisted.planSha256 !== request.expectedPlanSha256 ||
          operatorRollbackCanonicalJson(result) !== operatorRollbackCanonicalJson(persisted)) throw new Error('receipt mismatch')
      return { statusCode: 200, body: { ok: true as const, data: persisted } }
    } catch {
      return { statusCode: 503, body: { ok: false as const, error: { code: 'UPDATE_ROLLBACK_UNAVAILABLE' } } }
    }
  }
}

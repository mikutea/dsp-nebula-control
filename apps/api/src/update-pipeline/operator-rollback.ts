import { z } from 'zod'
import { HostMutationLeaseError } from '../host-mutation/lease.js'
import { hostMutationReturn, hostMutationThrow,
  type HostMutationOperationCoordinator, type HostMutationRecoveryOperationCoordinator,
  type HostMutationOperationScope } from '../host-mutation/operation-coordinator.js'
import type { ComponentUpdateActivationService } from './activation.js'
import type { ComponentUpdateRollbackBinding } from './activation-types.js'

export const operatorRollbackRequestSchema = z.strictObject({
  requestId: z.string().uuid().transform(value => value.toLowerCase()),
  sourceRequestId: z.string().uuid().transform(value => value.toLowerCase()),
  expectedRevision: z.string().regex(/^[0-9a-f]{64}$/),
  expectedPlanSha256: z.string().regex(/^[0-9a-f]{64}$/)
}).refine(value => value.requestId !== value.sourceRequestId)
export type OperatorRollbackRequest = z.infer<typeof operatorRollbackRequestSchema>
export type OperatorRollbackPlan = Awaited<ReturnType<ComponentUpdateActivationService['previewRollback']>>
export const operatorRollbackPhases = ['prepared', 'protected', 'files-restored', 'environment-restored',
  'verified', 'state-committed'] as const
export type OperatorRollbackPhase = typeof operatorRollbackPhases[number]
export interface OperatorRollbackJournal {
  request: OperatorRollbackRequest
  plan: OperatorRollbackPlan
  phase: OperatorRollbackPhase
  protection: ComponentUpdateRollbackBinding | null
  resultingRevision: string | null
}
export interface OperatorRollbackReceipt {
  format: 'dyson-control-operator-rollback-receipt'
  schemaVersion: 1
  requestId: string
  sourceRequestId: string
  planSha256: string
  resultingRevision: string
  protectionBackupId: string
  status: 'succeeded'
  recoveryRequired: false
}
/** Store implementations must validate durable input, create atomically, and
 * compare the expected phase before writing an immutable checkpoint. */
export interface OperatorRollbackStore {
  rebuildIncompleteIntent?(journal: OperatorRollbackJournal, scope: HostMutationOperationScope): Promise<void>
  recoverIncompleteIntent?(requestId: string, scope: HostMutationOperationScope): Promise<boolean>
  load(requestId: string): Promise<{ journal: OperatorRollbackJournal; receipt: OperatorRollbackReceipt | null } | null>
  begin(journal: OperatorRollbackJournal, scope: HostMutationOperationScope): Promise<void>
  checkpoint(previous: OperatorRollbackPhase, journal: OperatorRollbackJournal, scope: HostMutationOperationScope): Promise<void>
  complete(receipt: OperatorRollbackReceipt, scope: HostMutationOperationScope): Promise<void>
}
/** Every action must be idempotent for the journal request ID: interruption may
 * occur after its side effect but before the following checkpoint is durable. */
export interface OperatorRollbackPorts {
  preview(request: Omit<OperatorRollbackRequest, 'expectedPlanSha256'>): Promise<OperatorRollbackPlan>
  validateResume(journal: OperatorRollbackJournal, scope: HostMutationOperationScope): Promise<void>
  protectCurrent(journal: OperatorRollbackJournal, scope: HostMutationOperationScope): Promise<ComponentUpdateRollbackBinding>
  restoreFiles(journal: OperatorRollbackJournal, scope: HostMutationOperationScope): Promise<void>
  restoreEnvironment(journal: OperatorRollbackJournal, scope: HostMutationOperationScope): Promise<void>
  verify(journal: OperatorRollbackJournal, scope: HostMutationOperationScope): Promise<void>
  commitState(journal: OperatorRollbackJournal, scope: HostMutationOperationScope): Promise<string>
}
export class OperatorRollbackCoordinator {
  constructor(private readonly options: { store: OperatorRollbackStore; ports: OperatorRollbackPorts;
    coordinator: HostMutationOperationCoordinator; recovery: HostMutationRecoveryOperationCoordinator }) {}

  execute(input: unknown): Promise<OperatorRollbackReceipt> { return this.run(input, false) }
  recover(input: unknown): Promise<OperatorRollbackReceipt> { return this.run(input, true) }

  private async run(input: unknown, recovery: boolean): Promise<OperatorRollbackReceipt> {
    const request = operatorRollbackRequestSchema.parse(input)
    const operation = 'component-update-rollback'
    const work = async (scope: HostMutationOperationScope) => {
      let intentMayExist = recovery
      try {
        scope.assertActive()
        if (recovery) await this.options.store.recoverIncompleteIntent?.(request.requestId, scope)
        const existing = await this.options.store.load(request.requestId)
        scope.assertActive()
        intentMayExist = recovery || (existing !== null && existing.receipt === null)
        if (existing && (Object.keys(request) as Array<keyof OperatorRollbackRequest>)
          .some(key => existing.journal.request[key] !== request[key])) throw new Error('UPDATE_ROLLBACK_REQUEST_CONFLICT')
        if (existing?.receipt) {
          if (existing.receipt.requestId !== request.requestId || existing.receipt.sourceRequestId !== request.sourceRequestId ||
              existing.receipt.planSha256 !== request.expectedPlanSha256) throw new Error('UPDATE_ROLLBACK_RECEIPT_CONFLICT')
          return hostMutationReturn(existing.receipt, 'release')
        }
        if (recovery && !existing && !this.options.store.rebuildIncompleteIntent) throw new Error('UPDATE_ROLLBACK_RECOVERY_NOT_FOUND')
        let journal: OperatorRollbackJournal
        if (existing) journal = existing.journal
        else {
          const { expectedPlanSha256, ...previewRequest } = request
          const plan = await this.options.ports.preview(previewRequest)
          if (plan.planSha256 !== expectedPlanSha256 || plan.requestId !== request.requestId ||
              plan.sourceRequestId !== request.sourceRequestId || plan.expectedRevision !== request.expectedRevision) {
            throw new Error('UPDATE_ROLLBACK_PLAN_CHANGED')
          }
          journal = { request, plan, phase: 'prepared', protection: null, resultingRevision: null }
          scope.assertActive()
          intentMayExist = true
          if (recovery) await this.options.store.rebuildIncompleteIntent!(journal, scope)
          else await this.options.store.begin(journal, scope)
        }
        scope.assertActive()
        await this.options.ports.validateResume(journal, scope)
        scope.assertActive()
        const checkpoint = async (phase: OperatorRollbackPhase) => {
          scope.assertActive()
          const next = { ...journal, phase }
          await this.options.store.checkpoint(journal.phase, next, scope)
          scope.assertActive()
          journal = next
        }
        if (journal.phase === 'prepared') {
          journal = { ...journal, protection: await this.options.ports.protectCurrent(journal, scope) }
          await checkpoint('protected')
        }
        if (!journal.protection) throw new Error('UPDATE_ROLLBACK_PROTECTION_MISSING')
        if (journal.phase === 'protected') {
          await this.options.ports.restoreFiles(journal, scope)
          await checkpoint('files-restored')
        }
        if (journal.phase === 'files-restored') {
          await this.options.ports.restoreEnvironment(journal, scope)
          await checkpoint('environment-restored')
        }
        if (journal.phase === 'environment-restored') {
          await this.options.ports.verify(journal, scope)
          await checkpoint('verified')
        }
        if (journal.phase === 'verified') {
          journal = { ...journal, resultingRevision: await this.options.ports.commitState(journal, scope) }
          await checkpoint('state-committed')
        }
        if (journal.phase !== 'state-committed' || !journal.resultingRevision || !journal.protection) throw new Error('UPDATE_ROLLBACK_CHECKPOINT_INVALID')
        const receipt: OperatorRollbackReceipt = { format: 'dyson-control-operator-rollback-receipt', schemaVersion: 1,
          requestId: request.requestId, sourceRequestId: request.sourceRequestId, planSha256: request.expectedPlanSha256,
          resultingRevision: journal.resultingRevision, protectionBackupId: journal.protection.protectionBackupId,
          status: 'succeeded', recoveryRequired: false }
        scope.assertActive()
        await this.options.store.complete(receipt, scope)
        scope.assertActive()
        return hostMutationReturn(receipt, 'release')
      } catch (error) {
        if (error instanceof HostMutationLeaseError) throw error
        return hostMutationThrow<OperatorRollbackReceipt>(error, intentMayExist ? 'abandon' : 'release')
      }
    }
    return recovery ? this.options.recovery.runRecoveryExclusive({ expectedOperation: operation, expectedRequestId: request.requestId }, work)
      : this.options.coordinator.runExclusive({ operation, requestId: request.requestId }, work)
  }
}

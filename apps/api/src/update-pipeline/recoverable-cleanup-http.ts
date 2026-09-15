import { z } from 'zod'
import { recoverableCleanupRequestSchema, assertRecoverableCleanupPlan } from './recoverable-cleanup-plan.js'
import { parseCleanupJournal, type CleanupJournal } from './recoverable-cleanup-records.js'
import type { CleanupJournalStore } from './recoverable-cleanup-execution.js'
import type { ComponentUpdateActivationService } from './activation.js'
type Store = CleanupJournalStore & { listCleanupJournals(): CleanupJournal[] }
const uuid = z.string().uuid().transform(value => value.toLowerCase())
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const requestFields = { requestId: uuid, expectedRevision: hash, expectedPlanSha256: hash }
const restoreSchema = z.strictObject({ requestId: uuid, sourceRequestId: uuid, expectedPlanSha256: hash,
  confirmation: z.literal('RESTORE_COMPONENT_MATERIAL') })
const recoverySchema = z.discriminatedUnion('direction', [
  z.strictObject({ ...requestFields, direction: z.literal('quarantine'), confirmation: z.literal('RECOVER_COMPONENT_CLEANUP') }),
  z.strictObject({ requestId: uuid, sourceRequestId: uuid, expectedPlanSha256: hash, direction: z.literal('restore'), confirmation: z.literal('RECOVER_COMPONENT_CLEANUP') })
])
const errorResult = (statusCode: number, code: string) => ({ statusCode, body: { ok: false as const, error: { code } } })
export class RecoverableCleanupHttpController {
  constructor(private readonly options: { store: Store;
    service: Pick<ComponentUpdateActivationService, 'previewRecoverableCleanup' | 'runRecoverableCleanup'>;
    mutationEnabled?: () => boolean; recoveryEnabled?: () => boolean; now?: () => Date }) {}
  async preview(input: unknown) {
    const parsed = z.strictObject({ requestId: uuid }).safeParse(input)
    if (!parsed.success) return errorResult(400, 'UPDATE_CLEANUP_REQUEST_INVALID')
    try { return { statusCode: 200, body: { ok: true as const, data: await this.options.service.previewRecoverableCleanup(parsed.data.requestId) } } }
    catch { return errorResult(503, 'UPDATE_CLEANUP_UNAVAILABLE') }
  }
  execute(input: unknown, actor: string) { return this.submit(input, actor, 'quarantine') }
  recover(input: unknown, actor: string) { return this.submit(input, actor, 'recovery') }
  restore(input: unknown, actor: string) { return this.submit(input, actor, 'restore') }
  private async submit(input: unknown, actor: string, action: 'quarantine' | 'recovery' | 'restore') {
    const schema = action === 'restore' ? restoreSchema : action === 'recovery' ? recoverySchema : recoverableCleanupRequestSchema
    const parsed = schema.safeParse(input)
    if (!parsed.success) return errorResult(400, 'UPDATE_CLEANUP_REQUEST_INVALID')
    try {
      const enabled = action === 'recovery' ? this.options.recoveryEnabled : this.options.mutationEnabled
      if (enabled?.() !== true) return errorResult(423, 'UPDATE_CLEANUP_DISABLED')
      const request = parsed.data
      const stored = await this.options.store.loadCleanupJournal(request.requestId)
      let journal: CleanupJournal
      if (stored) {
        journal = parseCleanupJournal(stored)
        if (journal.requestId !== request.requestId || journal.plan.planSha256 !== request.expectedPlanSha256 ||
          (action === 'quarantine' && journal.direction !== 'quarantine') ||
          ('direction' in request && journal.direction !== request.direction) ||
          ('expectedRevision' in request && journal.plan.expectedRevision !== request.expectedRevision) ||
          ('sourceRequestId' in request && (journal.direction !== 'restore' || journal.plan.requestId !== request.sourceRequestId))) {
          return errorResult(409, 'UPDATE_CLEANUP_REQUEST_CONFLICT')
        }
      } else {
        if ('sourceRequestId' in request) {
          const source = await this.options.store.loadCleanupJournal(request.sourceRequestId)
          if (!source || source.state !== 'completed' || source.direction !== 'quarantine' || source.plan.planSha256 !== request.expectedPlanSha256) return errorResult(409, 'UPDATE_CLEANUP_RESTORE_UNPROVEN')
          journal = parseCleanupJournal({ format: 'dyson-recoverable-cleanup-journal', schemaVersion: 1,
            requestId: request.requestId, direction: 'restore', actor,
            startedAt: (this.options.now ?? (() => new Date()))().toISOString(), finishedAt: null,
            state: 'running', completedCount: 0, plan: source.plan })
        } else {
          if (!('expectedRevision' in request)) return errorResult(400, 'UPDATE_CLEANUP_REQUEST_INVALID')
          const plan = await this.options.service.previewRecoverableCleanup(request.requestId)
          assertRecoverableCleanupPlan({ requestId: request.requestId, expectedRevision: request.expectedRevision,
            expectedPlanSha256: request.expectedPlanSha256, confirmation: 'QUARANTINE_COMPONENT_MATERIAL' }, plan)
          journal = parseCleanupJournal({ format: 'dyson-recoverable-cleanup-journal', schemaVersion: 1,
            requestId: request.requestId, direction: 'quarantine', actor,
            startedAt: (this.options.now ?? (() => new Date()))().toISOString(), finishedAt: null,
            state: 'running', completedCount: 0, plan })
        }
      }
      const result = parseCleanupJournal(await this.options.service.runRecoverableCleanup(journal, this.options.store, action === 'recovery'))
      const persisted = parseCleanupJournal(await this.options.store.loadCleanupJournal(request.requestId))
      const expectedDirection = action === 'restore' ? 'restore' : action === 'quarantine' ? 'quarantine' : ('direction' in request ? request.direction : null)
      if (result.state !== 'completed' || persisted.requestId !== request.requestId || persisted.direction !== expectedDirection ||
        persisted.plan.planSha256 !== request.expectedPlanSha256 || JSON.stringify(result) !== JSON.stringify(persisted)) return errorResult(503, 'UPDATE_CLEANUP_TERMINAL_UNPROVEN')
      return { statusCode: 200, body: { ok: true as const, data: persisted } }
    } catch { return errorResult(503, 'UPDATE_CLEANUP_UNAVAILABLE') }
  }
}

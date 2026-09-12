import { z } from 'zod'
import { createRecoverableCleanupPlan, type RecoverableCleanupPlan } from './recoverable-cleanup-plan.js'
const fields = z.strictObject({ format: z.literal('dyson-recoverable-cleanup-journal'), schemaVersion: z.literal(1),
  requestId: z.string().uuid(), direction: z.enum(['quarantine', 'restore']),
  actor: z.string().min(1).max(128).regex(/^[A-Za-z0-9@._ -]+$/),
  startedAt: z.string().datetime(), finishedAt: z.string().datetime().nullable(),
  completedCount: z.number().int().min(0).max(64), state: z.enum(['running', 'completed']), plan: z.unknown() })
export type CleanupJournal = Omit<z.infer<typeof fields>, 'plan'> & { plan: RecoverableCleanupPlan }
/** Actor and times originate from the server. This validates durable records,
 * not an HTTP body, and does not confer authorization to move any object. */
export function parseCleanupJournal(input: unknown): CleanupJournal {
  const value = fields.parse(input)
  const { planSha256, ...body } = z.object({ planSha256: z.string().regex(/^[0-9a-f]{64}$/) }).passthrough().parse(value.plan)
  const plan = createRecoverableCleanupPlan(body)
  if (plan.planSha256 !== planSha256 || value.completedCount > plan.candidates.length ||
    (value.direction === 'quarantine' ? value.requestId !== plan.requestId : value.requestId === plan.requestId) ||
    (value.state === 'completed' ? value.completedCount !== plan.candidates.length || value.finishedAt === null : value.finishedAt !== null) ||
    (value.finishedAt !== null && Date.parse(value.finishedAt) < Date.parse(value.startedAt))) {
    throw new Error('UPDATE_CLEANUP_JOURNAL_INVALID')
  }
  return { ...value, plan }
}
export function assertCleanupTransition(previousInput: unknown, nextInput: unknown): void {
  const previous = parseCleanupJournal(previousInput), next = parseCleanupJournal(nextInput)
  if (JSON.stringify(previous) === JSON.stringify(next)) return
  if (previous.state === 'completed' || previous.requestId !== next.requestId || previous.direction !== next.direction ||
      previous.actor !== next.actor || previous.startedAt !== next.startedAt || previous.plan.planSha256 !== next.plan.planSha256) {
    throw new Error('UPDATE_CLEANUP_JOURNAL_CONFLICT')
  }
  if (next.state === 'completed' ? next.completedCount !== previous.completedCount
    : next.completedCount !== previous.completedCount + 1) throw new Error('UPDATE_CLEANUP_CHECKPOINT_GAP')
}

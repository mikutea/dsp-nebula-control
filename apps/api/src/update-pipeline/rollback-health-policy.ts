import { z } from 'zod'
import { evaluateCompatibility, type NormalizedRuntimeInventory } from '../updates/compatibility.js'

export const rollbackWarningApprovalsSchema = z.array(z.strictObject({
  entryId: z.string().min(1).max(96),
  warnings: z.array(z.literal('mod-bepinex-target-mismatch')).length(1)
})).max(32).superRefine((entries, context) => {
  if (new Set(entries.map(entry => entry.entryId)).size !== entries.length) {
    context.addIssue({ code: 'custom', message: 'Duplicate rollback warning approval' })
  }
})

/** Approval only addresses the listed warning; it never proves process, port,
 * save identity, generation, or successful restoration of component files. */
export function rollbackWarningsApproved(input: {
  phase: 'candidate' | 'rollback' | 'reconcile-candidate'
  approvals: unknown
  matrix: unknown
  inventory: NormalizedRuntimeInventory
  warnings: readonly string[]
}): boolean {
  if (input.phase !== 'rollback' || input.warnings.length !== 1) return false
  const approvals = rollbackWarningApprovalsSchema.safeParse(input.approvals)
  if (!approvals.success) return false
  try {
    const decision = evaluateCompatibility(input.inventory, input.matrix)
    if (!decision.compatible || decision.matchedEntryId === null) return false
    const approval = approvals.data.find(entry => entry.entryId === decision.matchedEntryId)
    return approval !== undefined && input.warnings.every(warning => approval.warnings.some(allowed => allowed === warning))
  } catch { return false }
}

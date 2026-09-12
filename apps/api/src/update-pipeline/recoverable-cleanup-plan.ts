import { createHash } from 'node:crypto'
import { z } from 'zod'

const digest = z.string().regex(/^[0-9a-f]{64}$/)
const uuid = z.string().uuid().transform(value => value.toLowerCase())
const item = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('history'), opaqueId: uuid, sha256: digest,
    sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }),
  z.strictObject({ kind: z.literal('release'), opaqueId: z.string().regex(/^(?:nebula|bepinex|bridge|control)-[0-9a-f]{32}$/),
    sha256: digest, sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
])
const core = z.strictObject({ format: z.literal('dyson-recoverable-component-cleanup-plan'),
  schemaVersion: z.literal(1), requestId: uuid, expectedRevision: digest,
  candidates: z.array(item).min(1).max(64) })
export type RecoverableCleanupPlan = z.infer<typeof core> & { planSha256: string }
export const recoverableCleanupRequestSchema = z.strictObject({ requestId: uuid,
  expectedRevision: digest, expectedPlanSha256: digest,
  confirmation: z.literal('QUARANTINE_COMPONENT_MATERIAL') })

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, entry]) => JSON.stringify(key) + ':' + canonical(entry)).join(',') + '}'
  return JSON.stringify(value)
}
/** Caller must obtain source digests and eligibility from protected live state. */
export function createRecoverableCleanupPlan(input: unknown): RecoverableCleanupPlan {
  const parsed = core.parse(input)
  parsed.candidates.sort((a, b) => {
    const left = a.kind + ':' + a.opaqueId, right = b.kind + ':' + b.opaqueId
    return left < right ? -1 : left > right ? 1 : 0
  })
  const identities = parsed.candidates.map(candidate => candidate.kind + ':' + candidate.opaqueId)
  if (new Set(identities).size !== identities.length) throw new Error('UPDATE_CLEANUP_DUPLICATE_SOURCE')
  const total = parsed.candidates.reduce((sum, candidate) => sum + candidate.sizeBytes, 0)
  if (!Number.isSafeInteger(total)) throw new Error('UPDATE_CLEANUP_SIZE_INVALID')
  return { ...parsed, planSha256: createHash('sha256').update(canonical(parsed)).digest('hex') }
}
export function assertRecoverableCleanupPlan(input: unknown, plan: RecoverableCleanupPlan): void {
  const request = recoverableCleanupRequestSchema.parse(input)
  const { planSha256, ...body } = plan
  const rebuilt = createRecoverableCleanupPlan(body)
  if (rebuilt.planSha256 !== planSha256 || request.requestId !== plan.requestId ||
      request.expectedRevision !== plan.expectedRevision || request.expectedPlanSha256 !== planSha256) {
    throw new Error('UPDATE_CLEANUP_PLAN_CHANGED')
  }
}

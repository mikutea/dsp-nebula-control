import { createHash } from 'node:crypto'
import { z } from 'zod'
import { operatorRollbackPhases, operatorRollbackRequestSchema,
  type OperatorRollbackJournal, type OperatorRollbackReceipt } from './operator-rollback.js'

const digest = z.string().regex(/^[0-9a-f]{64}$/)
const opaque = z.string().min(8).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const planSchema = z.strictObject({
  format: z.literal('dyson-control-component-rollback-plan'), schemaVersion: z.literal(1), dryRun: z.literal(true),
  requestId: z.string().uuid(), sourceRequestId: z.string().uuid(), expectedRevision: digest,
  component: z.enum(['nebula', 'bepinex', 'bridge', 'control']), targetVersion: z.string().min(1).max(64),
  materialSha256: digest, rollbackBindingSha256: digest, sourceProtectionBackupId: opaque,
  restoreFileCount: z.number().int().min(0).max(1024), removeFileCount: z.number().int().min(0).max(1024),
  planSha256: digest, currentConfigurationRevision: digest
})
const protectionSchema = z.strictObject({
  previousComponentVersion: z.string().min(1).max(64).nullable().optional(),
  configurationSnapshotId: opaque, configurationRevision: digest,
  serverModLockSha256: digest, serverModLockRevision: digest, previousLoadedSaveIdentity: digest,
  protectionBackupId: opaque, protectionManifestSha256: digest, bindingSha256: digest
})
const journalSchema = z.strictObject({ request: operatorRollbackRequestSchema, plan: planSchema,
  phase: z.enum(operatorRollbackPhases), protection: protectionSchema.nullable(), resultingRevision: digest.nullable() })
const receiptSchema = z.strictObject({
  format: z.literal('dyson-control-operator-rollback-receipt'), schemaVersion: z.literal(1),
  requestId: z.string().uuid(), sourceRequestId: z.string().uuid(), planSha256: digest,
  resultingRevision: digest, protectionBackupId: opaque, status: z.literal('succeeded'), recoveryRequired: z.literal(false)
})
export const operatorRollbackReceiptSchema = receiptSchema

export function operatorRollbackCanonicalJson(value: unknown): string {
  const sort = (input: unknown): unknown => Array.isArray(input) ? input.map(sort)
    : input !== null && typeof input === 'object' ? Object.fromEntries(Object.entries(input as Record<string, unknown>)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, sort(child)])) : input
  return JSON.stringify(sort(value))
}
export function operatorRollbackDigest(value: unknown): string {
  return createHash('sha256').update(operatorRollbackCanonicalJson(value)).digest('hex')
}

export function parseOperatorRollbackJournal(input: unknown): OperatorRollbackJournal {
  const journal = journalSchema.parse(input)
  const { planSha256, ...plan } = journal.plan
  if (operatorRollbackDigest(plan) !== planSha256 || planSha256 !== journal.request.expectedPlanSha256 ||
      plan.requestId !== journal.request.requestId || plan.sourceRequestId !== journal.request.sourceRequestId ||
      plan.expectedRevision !== journal.request.expectedRevision ||
      (journal.phase === 'prepared') !== (journal.protection === null) ||
      (journal.phase === 'state-committed') !== (journal.resultingRevision !== null)) {
    throw new Error('UPDATE_ROLLBACK_JOURNAL_BINDING_INVALID')
  }
  if (journal.protection) {
    const { bindingSha256, ...protection } = journal.protection
    if (operatorRollbackDigest(protection) !== bindingSha256) throw new Error('UPDATE_ROLLBACK_PROTECTION_BINDING_INVALID')
  }
  return journal
}

export function parseOperatorRollbackReceipt(input: unknown, journalInput: unknown): OperatorRollbackReceipt {
  const journal = parseOperatorRollbackJournal(journalInput)
  const receipt = receiptSchema.parse(input)
  if (journal.phase !== 'state-committed' || receipt.requestId !== journal.request.requestId ||
      receipt.sourceRequestId !== journal.request.sourceRequestId || receipt.planSha256 !== journal.request.expectedPlanSha256 ||
      receipt.resultingRevision !== journal.resultingRevision || receipt.protectionBackupId !== journal.protection?.protectionBackupId) {
    throw new Error('UPDATE_ROLLBACK_RECEIPT_BINDING_INVALID')
  }
  return receipt
}

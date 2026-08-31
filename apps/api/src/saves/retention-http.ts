import { z } from 'zod'
import {
  BackupRetentionError,
  type BackupRetentionErrorCode
} from './retention-execution.js'
import {
  MAX_DIRECTORY_ENTRIES,
  backupIdSchema,
  retentionPolicySchema,
  saveNameSchema
} from './schemas.js'

const requestIdSchema = z.string().uuid().transform((value) => value.toLocaleLowerCase('en-US'))
const digestSchema = z.string().length(64).regex(/^[a-f0-9]{64}$/)
const isoDateSchema = z.string().datetime({ offset: true })
const confirmationSchema = z.string().min(1).max(64).regex(/^[A-Z_]+$/)
const emptyObjectSchema = z.strictObject({})

const previewRequestSchema = z.strictObject({
  referenceTime: isoDateSchema,
  policy: retentionPolicySchema
})
const executeRequestSchema = previewRequestSchema.extend({
  requestId: requestIdSchema,
  previewDigest: digestSchema,
  confirmation: confirmationSchema
}).strict()
const annotationRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  backupId: backupIdSchema,
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  note: z.string().trim().min(1).max(256).nullable(),
  protected: z.boolean(),
  confirmation: confirmationSchema
})
const restoreRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  retirementRequestId: requestIdSchema,
  confirmation: confirmationSchema
})
const purgePreviewRequestSchema = z.strictObject({ retirementRequestId: requestIdSchema })
const purgeRequestSchema = purgePreviewRequestSchema.extend({
  requestId: requestIdSchema,
  purgePreviewDigest: digestSchema,
  confirmation: confirmationSchema
}).strict()

const annotationSchema = z.strictObject({
  backupId: backupIdSchema,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  note: z.string().min(1).max(256).nullable(),
  protected: z.boolean(),
  updatedAt: isoDateSchema
})
const annotationReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operation: z.literal('annotate'),
  requestId: requestIdSchema,
  committedAt: isoDateSchema,
  annotation: annotationSchema
})
const annotationMutationResultSchema = z.strictObject({
  receipt: annotationReceiptSchema,
  reused: z.boolean()
})
const retentionPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mode: z.literal('dry-run'),
  referenceTime: isoDateSchema,
  policy: retentionPolicySchema,
  keep: z.array(z.strictObject({
    backupId: backupIdSchema,
    reasons: z.array(z.enum([
      'protected', 'latest-healthy', 'minimum-healthy', 'daily', 'weekly'
    ])).min(1).max(5)
  })).max(MAX_DIRECTORY_ENTRIES),
  delete: z.array(z.strictObject({
    backupId: backupIdSchema,
    reason: z.enum(['outside-policy', 'unhealthy-deletion-enabled'])
  })).max(MAX_DIRECTORY_ENTRIES),
  blocked: z.array(z.strictObject({
    backupId: backupIdSchema,
    reason: z.literal('unhealthy-backup')
  })).max(MAX_DIRECTORY_ENTRIES)
})
const retentionPreviewSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mode: z.literal('dry-run'),
  referenceTime: isoDateSchema,
  policy: retentionPolicySchema,
  plan: retentionPlanSchema,
  excluded: z.array(z.strictObject({
    backupId: backupIdSchema,
    reason: z.enum(['created-at-unavailable', 'redirected-entry'])
  })).max(MAX_DIRECTORY_ENTRIES),
  inventoryDigest: digestSchema,
  previewDigest: digestSchema
})
const retirementCandidateSchema = z.strictObject({
  backupId: backupIdSchema,
  saveName: saveNameSchema,
  createdAt: isoDateSchema,
  health: z.enum(['healthy', 'incomplete', 'corrupt']),
  totalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  evidenceDigest: digestSchema
})
const retirementReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operation: z.literal('retire'),
  requestId: requestIdSchema,
  previewDigest: digestSchema,
  committedAt: isoDateSchema,
  retired: z.array(retirementCandidateSchema).max(MAX_DIRECTORY_ENTRIES),
  recoveryRequired: z.literal(false)
})
const restoreReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operation: z.literal('restore-retired'),
  requestId: requestIdSchema,
  retirementRequestId: requestIdSchema,
  committedAt: isoDateSchema,
  restoredBackupIds: z.array(backupIdSchema).max(MAX_DIRECTORY_ENTRIES),
  recoveryRequired: z.literal(false)
})
const purgePreviewSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mode: z.literal('dry-run'),
  retirementRequestId: requestIdSchema,
  eligibleAt: isoDateSchema,
  eligible: z.boolean(),
  retiredBackupIds: z.array(backupIdSchema).max(MAX_DIRECTORY_ENTRIES),
  totalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  retirementReceiptDigest: digestSchema,
  purgePreviewDigest: digestSchema
})
const purgeReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operation: z.literal('purge-retired'),
  requestId: requestIdSchema,
  retirementRequestId: requestIdSchema,
  committedAt: isoDateSchema,
  purgedBackupIds: z.array(backupIdSchema).max(MAX_DIRECTORY_ENTRIES),
  bytesFreed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  recoveryRequired: z.literal(false)
})
const retirementMutationResultSchema = z.strictObject({
  receipt: retirementReceiptSchema,
  reused: z.boolean()
})
const restoreMutationResultSchema = z.strictObject({
  receipt: restoreReceiptSchema,
  reused: z.boolean()
})
const purgeMutationResultSchema = z.strictObject({
  receipt: purgeReceiptSchema,
  reused: z.boolean()
})

export const backupRetentionHttpConfirmations = Object.freeze({
  annotate: 'UPDATE_BACKUP_ANNOTATION',
  retire: 'RETIRE_BACKUPS',
  restore: 'RESTORE_RETIRED_BACKUPS',
  purge: 'PURGE_RETIRED_BACKUPS'
} as const)

export interface BackupRetentionHttpService {
  listAnnotations(): Promise<unknown>
  setAnnotation(input: unknown): Promise<unknown>
  preview(input: unknown): Promise<unknown>
  execute(input: unknown): Promise<unknown>
  restore(input: unknown): Promise<unknown>
  previewPurge(input: unknown): Promise<unknown>
  purge(input: unknown): Promise<unknown>
}

export type BackupRetentionMutationContext = Readonly<{
  operation: 'annotate' | 'retire' | 'restore' | 'purge'
}>

export type BackupRetentionMutationGate = (
  context: BackupRetentionMutationContext
) => boolean | Promise<boolean>

export interface BackupRetentionHttpOptions {
  service: BackupRetentionHttpService
  /** All writes remain locked unless the embedding application explicitly opts in. */
  mutationGate?: BackupRetentionMutationGate
}

export interface BackupRetentionHttpResult<T> {
  statusCode: number
  body: { data: T; meta?: { executionEnabled: boolean } } | { error: { code: string; message: string } }
}

/**
 * Fastify-independent, path-free HTTP contract for backup retention. Browser
 * input contains only bounded logical identifiers, policy fields, digests, and
 * fixed confirmations. Core output is parsed again before it can cross HTTP.
 */
export class BackupRetentionHttpController {
  readonly #service: BackupRetentionHttpService
  readonly #mutationGate: BackupRetentionMutationGate

  constructor(options: BackupRetentionHttpOptions) {
    this.#service = options.service
    this.#mutationGate = options.mutationGate ?? (() => false)
  }

  async annotations(input: unknown): Promise<BackupRetentionHttpResult<z.output<typeof annotationSchema>[]>> {
    try {
      emptyObjectSchema.parse(input)
      const annotations = parseCoreOutput(z.array(annotationSchema).max(MAX_DIRECTORY_ENTRIES),
        await this.#service.listAnnotations())
      assertUnique(annotations.map((annotation) => annotation.backupId))
      return success(200, annotations)
    } catch (error) {
      return failureFrom(error)
    }
  }

  async annotate(input: unknown): Promise<BackupRetentionHttpResult<z.output<typeof annotationMutationResultSchema>>> {
    try {
      const request = annotationRequestSchema.parse(input)
      assertConfirmation(request.confirmation, backupRetentionHttpConfirmations.annotate)
      await this.#assertMutationAllowed({ operation: 'annotate' })
      const result = parseCoreOutput(annotationMutationResultSchema,
        await this.#service.setAnnotation(request))
      if (result.receipt.requestId !== request.requestId ||
          result.receipt.annotation.backupId !== request.backupId) throw responseInvalid()
      return success(result.reused ? 200 : 201, result)
    } catch (error) {
      return failureFrom(error)
    }
  }

  async preview(input: unknown): Promise<BackupRetentionHttpResult<z.output<typeof retentionPreviewSchema>>> {
    try {
      const request = previewRequestSchema.parse(input)
      const preview = parseCoreOutput(retentionPreviewSchema, await this.#service.preview(request))
      assertPreviewMatchesRequest(preview, request)
      assertPreviewIdentifiersUnique(preview)
      return success(200, preview, { executionEnabled: await this.#mutationEnabled({ operation: 'retire' }) })
    } catch (error) {
      return failureFrom(error)
    }
  }

  async execute(input: unknown): Promise<BackupRetentionHttpResult<z.output<typeof retirementMutationResultSchema>>> {
    try {
      const request = executeRequestSchema.parse(input)
      assertConfirmation(request.confirmation, backupRetentionHttpConfirmations.retire)
      await this.#assertMutationAllowed({ operation: 'retire' })
      const result = parseCoreOutput(retirementMutationResultSchema,
        await this.#service.execute(request))
      if (result.receipt.requestId !== request.requestId ||
          result.receipt.previewDigest !== request.previewDigest) throw responseInvalid()
      assertUnique(result.receipt.retired.map((entry) => entry.backupId))
      return success(result.reused ? 200 : 201, result)
    } catch (error) {
      return failureFrom(error)
    }
  }

  async restore(input: unknown): Promise<BackupRetentionHttpResult<z.output<typeof restoreMutationResultSchema>>> {
    try {
      const request = restoreRequestSchema.parse(input)
      assertConfirmation(request.confirmation, backupRetentionHttpConfirmations.restore)
      await this.#assertMutationAllowed({ operation: 'restore' })
      const result = parseCoreOutput(restoreMutationResultSchema,
        await this.#service.restore(request))
      if (result.receipt.requestId !== request.requestId ||
          result.receipt.retirementRequestId !== request.retirementRequestId) throw responseInvalid()
      assertUnique(result.receipt.restoredBackupIds)
      return success(result.reused ? 200 : 201, result)
    } catch (error) {
      return failureFrom(error)
    }
  }

  async previewPurge(input: unknown): Promise<BackupRetentionHttpResult<z.output<typeof purgePreviewSchema>>> {
    try {
      const request = purgePreviewRequestSchema.parse(input)
      const preview = parseCoreOutput(purgePreviewSchema, await this.#service.previewPurge(request))
      if (preview.retirementRequestId !== request.retirementRequestId) throw responseInvalid()
      assertUnique(preview.retiredBackupIds)
      return success(200, preview, { executionEnabled: await this.#mutationEnabled({ operation: 'purge' }) })
    } catch (error) {
      return failureFrom(error)
    }
  }

  async purge(input: unknown): Promise<BackupRetentionHttpResult<z.output<typeof purgeMutationResultSchema>>> {
    try {
      const request = purgeRequestSchema.parse(input)
      assertConfirmation(request.confirmation, backupRetentionHttpConfirmations.purge)
      await this.#assertMutationAllowed({ operation: 'purge' })
      const result = parseCoreOutput(purgeMutationResultSchema,
        await this.#service.purge(request))
      if (result.receipt.requestId !== request.requestId ||
          result.receipt.retirementRequestId !== request.retirementRequestId) throw responseInvalid()
      assertUnique(result.receipt.purgedBackupIds)
      return success(result.reused ? 200 : 201, result)
    } catch (error) {
      return failureFrom(error)
    }
  }

  async #mutationEnabled(context: BackupRetentionMutationContext): Promise<boolean> {
    try {
      return await this.#mutationGate(context) === true
    } catch {
      throw new BackupRetentionHttpFault(503, 'SAVE_RETENTION_GATE_UNAVAILABLE')
    }
  }

  async #assertMutationAllowed(context: BackupRetentionMutationContext): Promise<void> {
    if (!await this.#mutationEnabled(context)) {
      throw new BackupRetentionHttpFault(423, 'SAVE_RETENTION_MUTATIONS_DISABLED')
    }
  }
}

function assertPreviewMatchesRequest(
  preview: z.output<typeof retentionPreviewSchema>,
  request: z.output<typeof previewRequestSchema>
): void {
  if (preview.referenceTime !== request.referenceTime ||
      preview.plan.referenceTime !== request.referenceTime ||
      JSON.stringify(preview.policy) !== JSON.stringify(request.policy) ||
      JSON.stringify(preview.plan.policy) !== JSON.stringify(request.policy)) throw responseInvalid()
}

function assertPreviewIdentifiersUnique(preview: z.output<typeof retentionPreviewSchema>): void {
  const ids = [
    ...preview.plan.keep.map((entry) => entry.backupId),
    ...preview.plan.delete.map((entry) => entry.backupId),
    ...preview.plan.blocked.map((entry) => entry.backupId),
    ...preview.excluded.map((entry) => entry.backupId)
  ]
  assertUnique(ids)
}

function assertUnique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) throw responseInvalid()
}

function assertConfirmation(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new BackupRetentionHttpFault(422, 'SAVE_RETENTION_CONFIRMATION_INVALID')
  }
}

function parseCoreOutput<TSchema extends z.ZodType>(schema: TSchema, value: unknown): z.output<TSchema> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw responseInvalid()
  return parsed.data
}

function success<T>(
  statusCode: number,
  data: T,
  meta?: { executionEnabled: boolean }
): BackupRetentionHttpResult<T> {
  return meta === undefined ? { statusCode, body: { data } } : { statusCode, body: { data, meta } }
}

function failure<T = never>(statusCode: number, code: string): BackupRetentionHttpResult<T> {
  return { statusCode, body: { error: { code, message: publicMessage(code) } } }
}

function failureFrom(error: unknown): BackupRetentionHttpResult<never> {
  if (error instanceof BackupRetentionHttpFault) return failure(error.statusCode, error.code)
  if (error instanceof z.ZodError) return failure(400, 'SAVE_RETENTION_REQUEST_INVALID')
  if (error instanceof BackupRetentionError) return failure(statusForCoreCode(error.code), error.code)
  return failure(503, 'SAVE_RETENTION_UNAVAILABLE')
}

function statusForCoreCode(code: BackupRetentionErrorCode): number {
  if (code === 'SAVE_RETENTION_REQUEST_INVALID') return 400
  if (code === 'SAVE_RETENTION_OPERATION_NOT_FOUND') return 404
  if (code === 'SAVE_RETENTION_LOCK_BUSY') return 423
  if ([
    'SAVE_RETENTION_IDEMPOTENCY_CONFLICT',
    'SAVE_RETENTION_PLAN_CHANGED',
    'SAVE_RETENTION_BACKUP_CHANGED',
    'SAVE_RETENTION_OPERATION_NOT_RESTORABLE',
    'SAVE_RETENTION_ANNOTATION_CONFLICT',
    'SAVE_RETENTION_PURGE_TOO_EARLY'
  ].includes(code)) return 409
  return 503
}

function publicMessage(code: string): string {
  const messages: Readonly<Record<string, string>> = {
    SAVE_RETENTION_REQUEST_INVALID: '备份保留请求无效',
    SAVE_RETENTION_CONFIRMATION_INVALID: '备份保留固定确认短语不匹配',
    SAVE_RETENTION_MUTATIONS_DISABLED: '备份保留变更门禁未开启',
    SAVE_RETENTION_GATE_UNAVAILABLE: '备份保留变更门禁暂不可用',
    SAVE_RETENTION_LOCK_BUSY: '另一条备份保留事务正在执行',
    SAVE_RETENTION_IDEMPOTENCY_CONFLICT: '该请求标识已用于不同的备份保留事务',
    SAVE_RETENTION_PLAN_CHANGED: '备份清单或保留计划已经变化',
    SAVE_RETENTION_BACKUP_CHANGED: '目标备份已经变化',
    SAVE_RETENTION_OPERATION_NOT_FOUND: '备份保留事务不存在',
    SAVE_RETENTION_OPERATION_NOT_RESTORABLE: '备份保留事务当前不可恢复',
    SAVE_RETENTION_ANNOTATION_CONFLICT: '备份备注版本已经变化',
    SAVE_RETENTION_PURGE_TOO_EARLY: '退役等待期尚未结束',
    SAVE_RETENTION_RECOVERY_REQUIRED: '备份保留事务需要人工核验',
    SAVE_RETENTION_STORAGE_UNAVAILABLE: '备份保留存储暂不可用',
    SAVE_RETENTION_FAILED: '备份保留事务未完成',
    SAVE_RETENTION_RESPONSE_INVALID: '备份保留服务返回了无效结果',
    SAVE_RETENTION_UNAVAILABLE: '备份保留服务暂不可用'
  }
  return messages[code] ?? '备份保留服务拒绝了请求'
}

function responseInvalid(): BackupRetentionHttpFault {
  return new BackupRetentionHttpFault(503, 'SAVE_RETENTION_RESPONSE_INVALID')
}

class BackupRetentionHttpFault extends Error {
  constructor(readonly statusCode: number, readonly code: string) {
    super(code)
    this.name = 'BackupRetentionHttpFault'
  }
}

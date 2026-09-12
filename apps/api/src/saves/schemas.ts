import { z } from 'zod'

export const SAVE_CATALOG_SCHEMA_VERSION = 1 as const
export const BACKUP_MANIFEST_PROTOCOL = 'DYSON_CONTROL_PROTECTION_V1' as const
export const MAX_CATALOG_PAGE_SIZE = 100
export const MAX_BACKUP_PAGE_SIZE = 25
export const MAX_DIRECTORY_ENTRIES = 10_000
export const MAX_MANIFEST_BYTES = 16_384

export const saveNameSchema = z.string()
  .min(1)
  .max(120)
  .regex(/^[^\\/:*?"<>|\u0000-\u001f]+$/)
  .refine((value) => value !== '.' && value !== '..')

export const backupIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)

const catalogCursorSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/)
const isoDateSchema = z.string().datetime({ offset: true })

export const saveCatalogQuerySchema = z.strictObject({
  cursor: catalogCursorSchema.nullable().default(null),
  pageSize: z.number().int().min(1).max(MAX_CATALOG_PAGE_SIZE).default(25)
})

export const backupCatalogQuerySchema = z.strictObject({
  cursor: catalogCursorSchema.nullable().default(null),
  pageSize: z.number().int().min(1).max(MAX_BACKUP_PAGE_SIZE).default(10)
})

const fileSummarySchema = z.strictObject({
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  modifiedAt: isoDateSchema
})

export const savePairIssueSchema = z.enum([
  'missing-dsv', 'missing-server',
  'empty-dsv', 'empty-server',
  'redirected-dsv', 'redirected-server',
  'unreadable-dsv', 'unreadable-server'
])

export const savePairCatalogItemSchema = z.strictObject({
  id: z.string().length(64).regex(/^[a-f0-9]{64}$/),
  name: saveNameSchema,
  health: z.enum(['healthy', 'incomplete', 'corrupt']),
  issues: z.array(savePairIssueSchema).max(8),
  dsv: fileSummarySchema.nullable(),
  server: fileSummarySchema.nullable(),
  lastModifiedAt: isoDateSchema.nullable(),
  totalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
})

const catalogPageSchema = z.strictObject({
  limit: z.number().int().positive(),
  returned: z.number().int().nonnegative(),
  totalUnits: z.number().int().nonnegative(),
  nextCursor: catalogCursorSchema.nullable()
})

export const saveCatalogPageSchema = z.strictObject({
  schemaVersion: z.literal(SAVE_CATALOG_SCHEMA_VERSION),
  kind: z.literal('saves'),
  generatedAt: isoDateSchema,
  items: z.array(savePairCatalogItemSchema).max(MAX_CATALOG_PAGE_SIZE),
  page: catalogPageSchema,
  rejectedEntryCount: z.number().int().nonnegative().max(MAX_DIRECTORY_ENTRIES)
})

export const backupManifestFileSchema = z.strictObject({
  name: z.string().min(5).max(127),
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().length(64).regex(/^[a-fA-F0-9]{64}$/)
})

export const backupManifestV1Schema = z.strictObject({
  protocol: z.literal(BACKUP_MANIFEST_PROTOCOL),
  schemaVersion: z.literal(1),
  requestId: z.string().uuid(),
  createdAt: isoDateSchema,
  saveName: saveNameSchema,
  files: z.array(backupManifestFileSchema).length(2)
})

export const backupIssueSchema = z.enum([
  'manifest-missing', 'manifest-too-large', 'manifest-invalid', 'manifest-redirected',
  'manifest-identity-mismatch', 'pair-incomplete',
  'redirected-dsv', 'redirected-server',
  'empty-dsv', 'empty-server',
  'size-mismatch-dsv', 'size-mismatch-server',
  'hash-mismatch-dsv', 'hash-mismatch-server',
  'read-failed-dsv', 'read-failed-server',
  'changed-during-verification-dsv', 'changed-during-verification-server'
])

export const backupVerificationSchema = z.strictObject({
  schemaVersion: z.literal(SAVE_CATALOG_SCHEMA_VERSION),
  backupId: backupIdSchema,
  saveName: saveNameSchema.nullable(),
  createdAt: isoDateSchema.nullable(),
  health: z.enum(['healthy', 'incomplete', 'corrupt']),
  issues: z.array(backupIssueSchema).max(16),
  manifestPresent: z.boolean(),
  manifestValid: z.boolean(),
  pairPresent: z.boolean(),
  dsvBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  serverBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  totalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
})

export const backupCatalogPageSchema = z.strictObject({
  schemaVersion: z.literal(SAVE_CATALOG_SCHEMA_VERSION),
  kind: z.literal('backups'),
  generatedAt: isoDateSchema,
  items: z.array(backupVerificationSchema).max(MAX_BACKUP_PAGE_SIZE),
  page: catalogPageSchema,
  rejectedEntryCount: z.number().int().nonnegative().max(MAX_DIRECTORY_ENTRIES)
})

export const retentionCandidateSchema = z.strictObject({
  backupId: backupIdSchema,
  createdAt: isoDateSchema,
  health: z.enum(['healthy', 'incomplete', 'corrupt']),
  protected: z.boolean().default(false)
})

export const retentionPolicySchema = z.strictObject({
  keepLastHealthy: z.number().int().min(1).max(1_000),
  keepDailyDays: z.number().int().min(0).max(3_650),
  keepWeeklyWeeks: z.number().int().min(0).max(520),
  minimumHealthy: z.number().int().min(1).max(1_000),
  allowUnhealthyDeletion: z.boolean().default(false)
})

export const retentionPlanRequestSchema = z.strictObject({
  referenceTime: isoDateSchema,
  policy: retentionPolicySchema,
  candidates: z.array(retentionCandidateSchema).max(MAX_DIRECTORY_ENTRIES)
})

export const retentionKeepReasonSchema = z.enum([
  'protected', 'latest-healthy', 'minimum-healthy', 'daily', 'weekly'
])
export const retentionDeleteReasonSchema = z.enum(['outside-policy', 'unhealthy-deletion-enabled'])
export const retentionBlockReasonSchema = z.enum(['unhealthy-backup'])

const keepDecisionSchema = z.strictObject({
  backupId: backupIdSchema,
  reasons: z.array(retentionKeepReasonSchema).min(1).max(5)
})
const deleteDecisionSchema = z.strictObject({
  backupId: backupIdSchema,
  reason: retentionDeleteReasonSchema
})
const blockedDecisionSchema = z.strictObject({
  backupId: backupIdSchema,
  reason: retentionBlockReasonSchema
})

export const retentionPlanSchema = z.strictObject({
  schemaVersion: z.literal(SAVE_CATALOG_SCHEMA_VERSION),
  mode: z.literal('dry-run'),
  referenceTime: isoDateSchema,
  policy: retentionPolicySchema,
  keep: z.array(keepDecisionSchema).max(MAX_DIRECTORY_ENTRIES),
  delete: z.array(deleteDecisionSchema).max(MAX_DIRECTORY_ENTRIES),
  blocked: z.array(blockedDecisionSchema).max(MAX_DIRECTORY_ENTRIES)
})

export type SaveCatalogQuery = z.infer<typeof saveCatalogQuerySchema>
export type BackupCatalogQuery = z.infer<typeof backupCatalogQuerySchema>
export type SavePairIssue = z.infer<typeof savePairIssueSchema>
export type SavePairCatalogItem = z.infer<typeof savePairCatalogItemSchema>
export type SaveCatalogPage = z.infer<typeof saveCatalogPageSchema>
export type BackupManifestV1 = z.infer<typeof backupManifestV1Schema>
export type BackupIssue = z.infer<typeof backupIssueSchema>
export type BackupVerification = z.infer<typeof backupVerificationSchema>
export type BackupCatalogPage = z.infer<typeof backupCatalogPageSchema>
export type RetentionCandidate = z.infer<typeof retentionCandidateSchema>
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>
export type RetentionPlanRequest = z.infer<typeof retentionPlanRequestSchema>
export type RetentionPlan = z.infer<typeof retentionPlanSchema>

import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { LifecycleRunState } from '../domain.js'
import { normalizeVersion } from '../updates/version.js'
import type { SaveJobRunState } from './job-types.js'
import { readBoundedDirectory, resolveNormalDirectory, safeImmediateChild } from './boundary.js'
import type { BackupRetentionProtectionSource } from './retention-execution.js'
import { MAX_DIRECTORY_ENTRIES } from './schemas.js'

const MAX_PROTECTION_RECORDS = 20_000
const MAX_UPDATE_RECORD_BYTES = 4 * 1_024 * 1_024
const UPDATE_CONTROL_DIRECTORY = '.dyson-control-updates'

const requestIdSchema = z.string().uuid().transform((value) => value.toLocaleLowerCase('en-US'))
// Component-update records are hashed and named by the producer with the
// exact UUID spelling it accepted. Preserve those bytes while validating the
// stored record; normalize only when translating a logical reference to the
// physical tx-<uuid> backup identity.
const storedRequestIdSchema = z.string().uuid()
const lifecycleStateSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'interrupted'])
const saveStateSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'interrupted'])
const managedComponentSchema = z.enum(['nebula', 'bepinex', 'bridge', 'control'])
const revisionSchema = z.string().regex(/^[0-9a-f]{64}$/)
const artifactIdSchema = z.string().min(16).max(96).regex(/^[a-z0-9][a-z0-9-]+$/)
const releaseIdSchema = z.string().regex(/^(?:nebula|bepinex|bridge|control)-[0-9a-f]{32}$/)
const isoDateSchema = z.string().datetime({ offset: true })
const protectionReferenceSchema = z.string().min(1).max(128)

export interface LifecycleBackupProtectionRecord {
  requestId: string
  action: 'start' | 'save' | 'graceful-stop' | 'restart'
  state: LifecycleRunState
  protectionPointId: string | null
  recoveryRequired: boolean
  terminalReceiptComplete: boolean
}

export interface SaveRestoreBackupProtectionRecord {
  state: SaveJobRunState
  protectionRequestId: string | null
  resultProtectionBackupId: string | null
  recoveryRequired: boolean
  terminalReceiptComplete: boolean
}

export interface BackupRetentionWorkflowProtectionStore {
  listLifecycleBackupProtectionRecords():
    | readonly LifecycleBackupProtectionRecord[]
    | Promise<readonly LifecycleBackupProtectionRecord[]>
  listSaveRestoreBackupProtectionRecords():
    | readonly SaveRestoreBackupProtectionRecord[]
    | Promise<readonly SaveRestoreBackupProtectionRecord[]>
}

export type ProductionBackupRetentionProtectionErrorCode =
  | 'SAVE_RETENTION_PROTECTION_SOURCE_INVALID'
  | 'SAVE_RETENTION_PROTECTION_SOURCE_UNAVAILABLE'

export class ProductionBackupRetentionProtectionError extends Error {
  constructor(
    readonly code: ProductionBackupRetentionProtectionErrorCode,
    options?: ErrorOptions
  ) {
    super(code, options)
    this.name = 'ProductionBackupRetentionProtectionError'
  }
}

export interface ProductionBackupRetentionProtectionSourceOptions {
  projectRoot: string
  workflowStore: BackupRetentionWorkflowProtectionStore
}

const lifecycleRecordSchema: z.ZodType<LifecycleBackupProtectionRecord> = z.strictObject({
  requestId: requestIdSchema,
  action: z.enum(['start', 'save', 'graceful-stop', 'restart']),
  state: lifecycleStateSchema,
  protectionPointId: z.string().nullable(),
  recoveryRequired: z.boolean(),
  terminalReceiptComplete: z.boolean()
})

const saveRestoreRecordSchema: z.ZodType<SaveRestoreBackupProtectionRecord> = z.strictObject({
  state: saveStateSchema,
  protectionRequestId: z.string().nullable(),
  resultProtectionBackupId: z.string().nullable(),
  recoveryRequired: z.boolean(),
  terminalReceiptComplete: z.boolean()
})

interface StoredActiveComponent {
  component: z.infer<typeof managedComponentSchema>
  version: string
  artifactId: string
  sha256: string
  releaseId: string
}

interface StoredUpdateTransaction {
  requestId: string
  requestFingerprint: string
  component: z.infer<typeof managedComponentSchema>
  artifactId: string
  targetVersion: string
  compatibilityReceiptId: string
  releaseId: string
  previousRevision: string
  protectionBackupId: string
  fileCount: number
  expandedBytes: number
  activatedAt: string
}

interface StoredUpdateState {
  format: 'dyson-control-component-active-state'
  schemaVersion: 1
  revision: string
  recoveryRequired: boolean
  components: StoredActiveComponent[]
  lastTransaction: StoredUpdateTransaction | null
}

interface StoredUpdateReceipt {
  format: 'dyson-control-component-update-receipt'
  schemaVersion: 1
  requestId: string
  component: z.infer<typeof managedComponentSchema>
  artifactId: string
  compatibilityReceiptId: string
  targetVersion: string
  releaseId: string
  status: 'succeeded' | 'failed' | 'rolled-back' | 'rollback-failed'
  previousRevision: string
  resultingRevision: string
  protectionBackupId: string | null
  failureCode: string | null
  rollbackVerified: boolean
  recoveryRequired: boolean
  fileCount: number
  expandedBytes: number
  completedAt: string
  reused: boolean
}

interface StoredUpdateReceiptEnvelope {
  format: 'dyson-control-component-update-receipt-envelope'
  schemaVersion: 1
  requestFingerprint: string
  receipt: StoredUpdateReceipt
}

const storedActiveComponentSchema: z.ZodType<StoredActiveComponent> = z.strictObject({
  component: managedComponentSchema,
  version: z.string().min(1).max(64),
  artifactId: artifactIdSchema,
  sha256: revisionSchema,
  releaseId: releaseIdSchema
})

const storedUpdateTransactionSchema: z.ZodType<StoredUpdateTransaction> = z.strictObject({
  requestId: storedRequestIdSchema,
  requestFingerprint: revisionSchema,
  component: managedComponentSchema,
  artifactId: artifactIdSchema,
  targetVersion: z.string().min(1).max(64),
  compatibilityReceiptId: storedRequestIdSchema,
  releaseId: releaseIdSchema,
  previousRevision: revisionSchema,
  protectionBackupId: protectionReferenceSchema,
  fileCount: z.number().int().min(1).max(512),
  expandedBytes: z.number().int().min(0).max(2 * 1_024 * 1_024 * 1_024),
  activatedAt: isoDateSchema
})

const storedUpdateStateSchema: z.ZodType<StoredUpdateState> = z.strictObject({
  format: z.literal('dyson-control-component-active-state'),
  schemaVersion: z.literal(1),
  revision: revisionSchema,
  recoveryRequired: z.boolean(),
  components: z.array(storedActiveComponentSchema).max(4),
  lastTransaction: storedUpdateTransactionSchema.nullable()
})

const storedUpdateReceiptSchema: z.ZodType<StoredUpdateReceipt> = z.strictObject({
  format: z.literal('dyson-control-component-update-receipt'),
  schemaVersion: z.literal(1),
  requestId: storedRequestIdSchema,
  component: managedComponentSchema,
  artifactId: artifactIdSchema,
  compatibilityReceiptId: storedRequestIdSchema,
  targetVersion: z.string().min(1).max(64),
  releaseId: releaseIdSchema,
  status: z.enum(['succeeded', 'failed', 'rolled-back', 'rollback-failed']),
  previousRevision: revisionSchema,
  resultingRevision: revisionSchema,
  protectionBackupId: protectionReferenceSchema.nullable(),
  failureCode: z.string().min(1).max(96).regex(/^[A-Z][A-Z0-9_]*$/).nullable(),
  rollbackVerified: z.boolean(),
  recoveryRequired: z.boolean(),
  fileCount: z.number().int().min(0).max(512),
  expandedBytes: z.number().int().min(0).max(2 * 1_024 * 1_024 * 1_024),
  completedAt: isoDateSchema,
  reused: z.boolean()
})

const storedUpdateReceiptEnvelopeSchema: z.ZodType<StoredUpdateReceiptEnvelope> = z.strictObject({
  format: z.literal('dyson-control-component-update-receipt-envelope'),
  schemaVersion: z.literal(1),
  requestFingerprint: revisionSchema,
  receipt: storedUpdateReceiptSchema
})

const storedUpdateJournalSchema = z.strictObject({
  format: z.literal('dyson-control-component-update-journal'),
  schemaVersion: z.literal(1),
  transaction: storedUpdateTransactionSchema
})

/**
 * Production protection source for retention. It only returns physical backup
 * directory identities (`tx-<uuid>`). Logical workflow identities such as
 * `save:<uuid>` are parsed and translated; they are never passed through as a
 * filesystem name.
 */
export class ProductionBackupRetentionProtectionSource implements BackupRetentionProtectionSource {
  readonly #projectRoot: string
  readonly #workflowStore: BackupRetentionWorkflowProtectionStore

  constructor(options: ProductionBackupRetentionProtectionSourceOptions) {
    if (!options || !path.isAbsolute(options.projectRoot) ||
        typeof options.workflowStore?.listLifecycleBackupProtectionRecords !== 'function' ||
        typeof options.workflowStore?.listSaveRestoreBackupProtectionRecords !== 'function') {
      throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
    }
    this.#projectRoot = path.resolve(options.projectRoot)
    this.#workflowStore = options.workflowStore
  }

  async listProtectedBackupIds(): Promise<ReadonlySet<string>> {
    try {
      const [lifecycleInput, saveRestoreInput, componentUpdateIds] = await Promise.all([
        this.#workflowStore.listLifecycleBackupProtectionRecords(),
        this.#workflowStore.listSaveRestoreBackupProtectionRecords(),
        listComponentUpdateProtectionIds(this.#projectRoot)
      ])
      const lifecycle = z.array(lifecycleRecordSchema).max(MAX_PROTECTION_RECORDS).parse(lifecycleInput)
      const saveRestores = z.array(saveRestoreRecordSchema).max(MAX_PROTECTION_RECORDS).parse(saveRestoreInput)
      const protectedIds = new Set(componentUpdateIds)

      for (const record of lifecycle) {
        const expectedBackupId = requestIdToBackupId(record.requestId)
        if (record.protectionPointId === null) {
          // start never creates a protection point. Every other lifecycle
          // action can create tx-<requestId> before the DB projection is
          // updated, so an incomplete/null projection must conservatively
          // retain that deterministic physical identity.
          // Absence is not proof that the script never published the physical
          // protection point: the process can stop between publication and
          // the DB update. Keeping a deterministic non-existent identity is
          // harmless, while releasing a real unprojected backup is not.
          if (record.action !== 'start') protectedIds.add(expectedBackupId)
          continue
        }
        const backupId = protectionReferenceToBackupId(record.protectionPointId)
        if (backupId !== expectedBackupId) {
          throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
        }
        if (record.recoveryRequired || !record.terminalReceiptComplete ||
            ['queued', 'running', 'interrupted'].includes(record.state)) {
          protectedIds.add(backupId)
        }
      }

      for (const record of saveRestores) {
        if (record.protectionRequestId === null) {
          throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
        }
        const backupId = requestIdToBackupId(record.protectionRequestId)
        if (record.resultProtectionBackupId !== null &&
            protectionReferenceToBackupId(record.resultProtectionBackupId) !== backupId) {
          throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
        }
        if (record.recoveryRequired || !record.terminalReceiptComplete ||
            ['queued', 'running', 'interrupted'].includes(record.state)) {
          protectedIds.add(backupId)
        }
      }
      return protectedIds
    } catch (error) {
      if (error instanceof ProductionBackupRetentionProtectionError) throw error
      if (error instanceof z.ZodError) {
        throw new ProductionBackupRetentionProtectionError(
          'SAVE_RETENTION_PROTECTION_SOURCE_INVALID',
          { cause: error }
        )
      }
      throw new ProductionBackupRetentionProtectionError(
        'SAVE_RETENTION_PROTECTION_SOURCE_UNAVAILABLE',
        { cause: error }
      )
    }
  }
}

export function protectionReferenceToBackupId(reference: unknown): string {
  if (typeof reference !== 'string') {
    throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
  }
  const prefix = reference.startsWith('save:')
    ? 'save:'
    : reference.startsWith('tx-')
      ? 'tx-'
      : null
  if (prefix === null) {
    throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
  }
  return requestIdToBackupId(reference.slice(prefix.length))
}

function requestIdToBackupId(requestId: unknown): string {
  const parsed = requestIdSchema.safeParse(requestId)
  if (!parsed.success) {
    throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
  }
  return `tx-${parsed.data}`
}

async function listComponentUpdateProtectionIds(projectRoot: string): Promise<ReadonlySet<string>> {
  const controlRoot = safeImmediateChild(projectRoot, UPDATE_CONTROL_DIRECTORY)
  const controlInfo = await lstat(controlRoot).catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  })
  if (controlInfo === null) return new Set()
  if (!controlInfo.isDirectory() || controlInfo.isSymbolicLink() ||
      !samePath(await realpath(controlRoot), controlRoot)) {
    throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
  }

  const transactionsRoot = await resolveNormalDirectory(safeImmediateChild(controlRoot, 'transactions'))
  const receiptsRoot = await resolveNormalDirectory(safeImmediateChild(controlRoot, 'receipts'))
  const recoveryReceiptsRoot = safeImmediateChild(controlRoot, 'recovery-receipts')
  const [stateValue, journalEntries, receiptEntries, recoveryReceiptEntries] = await Promise.all([
    readTrustedJsonIfPresent(safeImmediateChild(controlRoot, 'active.json'), MAX_UPDATE_RECORD_BYTES),
    readBoundedDirectory(transactionsRoot, MAX_DIRECTORY_ENTRIES),
    readBoundedDirectory(receiptsRoot, MAX_DIRECTORY_ENTRIES),
    readOptionalUpdateRecordDirectory(recoveryReceiptsRoot)
  ])
  const state = stateValue === null ? null : storedUpdateStateSchema.parse(stateValue)
  if (state !== null) assertStoredUpdateStateSemantics(state)
  const journals = new Map<string, z.infer<typeof storedUpdateJournalSchema>>()
  const originalReceipts = new Map<string, StoredUpdateReceiptEnvelope>()
  const recoveryReceipts = new Map<string, StoredUpdateReceiptEnvelope>()

  for (const entry of journalEntries) {
    const requestId = parseUpdateRecordEntry(entry, 'journal')
    const journal = storedUpdateJournalSchema.parse(
      await readTrustedJson(safeImmediateChild(transactionsRoot, entry.name), MAX_UPDATE_RECORD_BYTES)
    )
    if (journal.transaction.requestId !== requestId || journals.has(requestId)) {
      throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
    }
    assertStoredUpdateTransactionSemantics(journal.transaction)
    journals.set(requestId, journal)
  }
  for (const entry of receiptEntries) {
    const requestId = parseUpdateRecordEntry(entry, 'receipt')
    const envelope = storedUpdateReceiptEnvelopeSchema.parse(
      await readTrustedJson(safeImmediateChild(receiptsRoot, entry.name), MAX_UPDATE_RECORD_BYTES)
    )
    if (envelope.receipt.requestId !== requestId || originalReceipts.has(requestId)) {
      throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
    }
    assertUpdateReceiptSemantics(envelope.receipt)
    originalReceipts.set(requestId, envelope)
  }
  for (const entry of recoveryReceiptEntries) {
    const requestId = parseUpdateRecordEntry(entry, 'receipt')
    const envelope = storedUpdateReceiptEnvelopeSchema.parse(
      await readTrustedJson(safeImmediateChild(recoveryReceiptsRoot, entry.name), MAX_UPDATE_RECORD_BYTES)
    )
    if (envelope.receipt.requestId !== requestId || recoveryReceipts.has(requestId)) {
      throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
    }
    assertUpdateReceiptSemantics(envelope.receipt)
    recoveryReceipts.set(requestId, envelope)
  }
  const receipts = new Map(originalReceipts)
  for (const [requestId, recovered] of recoveryReceipts) {
    const original = originalReceipts.get(requestId)
    const isOrphanTerminal = original === undefined &&
      (recovered.receipt.status === 'succeeded' || recovered.receipt.status === 'rolled-back') &&
      isSafelyCompletedUpdateReceipt(recovered.receipt)
    if (!isOrphanTerminal &&
        (original === undefined || !isValidUpdateRecoveryReceiptTransition(original, recovered))) {
      throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
    }
    // Recovery can legitimately complete a journal after a crash that happened
    // before the original receipt was durable. This only admits the terminal
    // envelope into the effective set: journal identity binding and the active
    // revision DAG are still proven below before its protection can be released.
    receipts.set(requestId, recovered)
  }

  const protectedIds = new Set<string>()
  for (const [requestId, journal] of journals) {
    const transactionBackupId = protectionReferenceToBackupId(journal.transaction.protectionBackupId)
    if (transactionBackupId !== requestIdToBackupId(journal.transaction.requestId)) {
      throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
    }
    const envelope = receipts.get(requestId)
    if (envelope !== undefined) {
      assertUpdateReceiptMatchesTransaction(envelope, journal.transaction)
    }
    if (envelope === undefined || !isSafelyCompletedUpdateReceipt(envelope.receipt)) {
      protectedIds.add(transactionBackupId)
    }
  }

  for (const envelope of receipts.values()) {
    if (envelope.receipt.status !== 'failed' && !journals.has(envelope.receipt.requestId)) {
      throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
    }
    if (envelope.receipt.protectionBackupId !== null &&
        protectionReferenceToBackupId(envelope.receipt.protectionBackupId) !==
          requestIdToBackupId(envelope.receipt.requestId)) {
      throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
    }
    if (isSafelyCompletedUpdateReceipt(envelope.receipt)) continue
    if (envelope.receipt.protectionBackupId === null) {
      if (envelope.receipt.recoveryRequired) {
        throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
      }
      continue
    }
    protectedIds.add(protectionReferenceToBackupId(envelope.receipt.protectionBackupId))
  }

  const allJournalTerminalsProven = [...journals.entries()].every(([requestId]) => {
    const envelope = receipts.get(requestId)
    return envelope !== undefined && isSafelyCompletedUpdateReceipt(envelope.receipt)
  })
  if (state === null && journals.size > 0) {
    // The producer always durably switches active.json before publishing a
    // non-failed terminal receipt. Missing state therefore cannot authorize
    // release, even when each isolated journal/receipt pair looks terminal.
    for (const journal of journals.values()) {
      protectedIds.add(protectionReferenceToBackupId(journal.transaction.protectionBackupId))
    }
    return protectedIds
  }

  if (state?.recoveryRequired === true && state.lastTransaction === null) {
    throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
  }
  if (state?.lastTransaction !== null && state?.lastTransaction !== undefined) {
    const journal = journals.get(state.lastTransaction.requestId)
    if (journal === undefined ||
        canonicalJson(journal.transaction) !== canonicalJson(state.lastTransaction)) {
      throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
    }
    const stateBackupId = protectionReferenceToBackupId(state.lastTransaction.protectionBackupId)
    if (stateBackupId !== requestIdToBackupId(state.lastTransaction.requestId)) {
      throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
    }
    const envelope = receipts.get(state.lastTransaction.requestId)
    if (envelope !== undefined) {
      assertUpdateReceiptMatchesTransaction(envelope, state.lastTransaction)
      if (isSafelyCompletedUpdateReceipt(envelope.receipt) && (
        envelope.receipt.status !== 'succeeded' ||
        envelope.receipt.resultingRevision !== state.revision ||
        state.recoveryRequired
      )) {
        throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
      }
    }
    if (!state.recoveryRequired) {
      const activeComponent = state.components.find((component) =>
        component.component === state.lastTransaction!.component)
      if (activeComponent === undefined ||
          activeComponent.version !== state.lastTransaction.targetVersion ||
          activeComponent.artifactId !== state.lastTransaction.artifactId ||
          activeComponent.releaseId !== state.lastTransaction.releaseId) {
        throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
      }
    }
    if (state.recoveryRequired || envelope === undefined || !isSafelyCompletedUpdateReceipt(envelope.receipt)) {
      protectedIds.add(stateBackupId)
    }
  }
  if (state !== null) {
    if (state.recoveryRequired || !allJournalTerminalsProven) {
      // Until every transaction has a coherent terminal and the active state
      // is non-recovery, retain the complete update protection chain. This is
      // intentionally conservative across candidate/recovery crash windows.
      for (const journal of journals.values()) {
        protectedIds.add(protectionReferenceToBackupId(journal.transaction.protectionBackupId))
      }
    } else {
      assertStoredUpdateStateMatchesTerminalHistory(state, journals, receipts)
    }
  }
  return protectedIds
}

async function readOptionalUpdateRecordDirectory(
  directory: string
): Promise<Awaited<ReturnType<typeof readBoundedDirectory>>> {
  const metadata = await lstat(directory).catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  })
  if (metadata === null) return []
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !samePath(await realpath(directory), directory)) {
    throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
  }
  return await readBoundedDirectory(directory, MAX_DIRECTORY_ENTRIES)
}

function parseUpdateRecordEntry(
  entry: { name: string, kind: string },
  _kind: 'journal' | 'receipt'
): string {
  if (entry.kind !== 'file' || !entry.name.endsWith('.json')) {
    throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
  }
  const requestId = storedRequestIdSchema.safeParse(entry.name.slice(0, -5))
  if (!requestId.success || entry.name !== `${requestId.data}.json`) {
    throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
  }
  return requestId.data
}

function assertUpdateReceiptSemantics(receipt: StoredUpdateReceipt): void {
  const hasProtection = receipt.protectionBackupId !== null
  const invalid = receipt.reused ||
    (receipt.status === 'succeeded' && (
      receipt.recoveryRequired || receipt.failureCode !== null || receipt.rollbackVerified || !hasProtection
    )) ||
    (receipt.status === 'rolled-back' && (
      receipt.recoveryRequired || receipt.failureCode === null || !receipt.rollbackVerified || !hasProtection
    )) ||
    (receipt.status === 'rollback-failed' && (
      !receipt.recoveryRequired || receipt.failureCode === null || receipt.rollbackVerified || !hasProtection
    )) ||
    (receipt.status === 'failed' && (
      receipt.failureCode === null || receipt.rollbackVerified || (receipt.recoveryRequired && !hasProtection)
    ))
  if (invalid) {
    throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
  }
  try {
    if (normalizeStoredComponentVersion(receipt.targetVersion, receipt.component) !== receipt.targetVersion ||
        !receipt.releaseId.startsWith(`${receipt.component}-`)) {
      throw new Error('receipt identity is not canonical')
    }
  } catch (error) {
    throw new ProductionBackupRetentionProtectionError(
      'SAVE_RETENTION_PROTECTION_SOURCE_INVALID',
      { cause: error }
    )
  }
}

function assertUpdateReceiptMatchesTransaction(
  envelope: StoredUpdateReceiptEnvelope,
  transaction: StoredUpdateTransaction
): void {
  const receipt = envelope.receipt
  if (receipt.status === 'failed' ||
      envelope.requestFingerprint !== transaction.requestFingerprint ||
      receipt.requestId !== transaction.requestId ||
      receipt.component !== transaction.component ||
      receipt.artifactId !== transaction.artifactId ||
      receipt.compatibilityReceiptId !== transaction.compatibilityReceiptId ||
      receipt.targetVersion !== transaction.targetVersion ||
      receipt.releaseId !== transaction.releaseId ||
      receipt.previousRevision !== transaction.previousRevision ||
      receipt.protectionBackupId === null ||
      protectionReferenceToBackupId(receipt.protectionBackupId) !==
        protectionReferenceToBackupId(transaction.protectionBackupId) ||
      receipt.fileCount !== transaction.fileCount ||
      receipt.expandedBytes !== transaction.expandedBytes ||
      (receipt.status === 'rolled-back' && receipt.resultingRevision !== transaction.previousRevision)) {
    throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
  }
}

function assertStoredUpdateTransactionSemantics(transaction: StoredUpdateTransaction): void {
  try {
    if (normalizeStoredComponentVersion(transaction.targetVersion, transaction.component) !== transaction.targetVersion ||
        !transaction.releaseId.startsWith(`${transaction.component}-`) ||
        protectionReferenceToBackupId(transaction.protectionBackupId) !== requestIdToBackupId(transaction.requestId)) {
      throw new Error('transaction identity is not canonical')
    }
  } catch (error) {
    if (error instanceof ProductionBackupRetentionProtectionError) throw error
    throw new ProductionBackupRetentionProtectionError(
      'SAVE_RETENTION_PROTECTION_SOURCE_INVALID',
      { cause: error }
    )
  }
}

function assertStoredUpdateStateSemantics(state: StoredUpdateState): void {
  const sorted = [...state.components].sort((left, right) => compareText(left.component, right.component))
  if (canonicalJson(sorted) !== canonicalJson(state.components) ||
      new Set(state.components.map((component) => component.component)).size !== state.components.length) {
    throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
  }
  try {
    for (const component of state.components) {
      if (normalizeStoredComponentVersion(component.version, component.component) !== component.version ||
          component.sha256 !== component.sha256.toLocaleLowerCase('en-US') ||
          !component.releaseId.startsWith(`${component.component}-`)) {
        throw new Error('active component is not canonical')
      }
    }
    const { revision, ...base } = state
    const expectedRevision = createHash('sha256').update(canonicalJson(base)).digest('hex')
    if (revision !== expectedRevision) throw new Error('active state revision mismatch')
  } catch (error) {
    throw new ProductionBackupRetentionProtectionError(
      'SAVE_RETENTION_PROTECTION_SOURCE_INVALID',
      { cause: error }
    )
  }
}

function normalizeStoredComponentVersion(
  version: string,
  component: z.infer<typeof managedComponentSchema>
): string {
  return normalizeVersion(
    version,
    component === 'nebula' ? 'nebula' : component === 'bepinex' ? 'bepinex' : 'plugin'
  )
}

function isSafelyCompletedUpdateReceipt(receipt: StoredUpdateReceipt): boolean {
  if (receipt.recoveryRequired || receipt.status === 'rollback-failed') return false
  return receipt.status !== 'rolled-back' || receipt.rollbackVerified
}

function assertStoredUpdateStateMatchesTerminalHistory(
  state: StoredUpdateState,
  journals: ReadonlyMap<string, z.infer<typeof storedUpdateJournalSchema>>,
  receipts: ReadonlyMap<string, StoredUpdateReceiptEnvelope>
): void {
  const succeeded: Array<{
    transaction: StoredUpdateTransaction
    receipt: StoredUpdateReceipt
  }> = []
  const rolledBackPreviousRevisions: string[] = []
  for (const [requestId, journal] of journals) {
    const envelope = receipts.get(requestId)
    if (envelope === undefined || !isSafelyCompletedUpdateReceipt(envelope.receipt)) {
      throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
    }
    if (envelope.receipt.status === 'succeeded') {
      succeeded.push({ transaction: journal.transaction, receipt: envelope.receipt })
    } else if (envelope.receipt.status === 'rolled-back') {
      rolledBackPreviousRevisions.push(journal.transaction.previousRevision)
    } else {
      // A failed receipt is never valid for a persisted activation journal.
      throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
    }
  }

  const byResultingRevision = new Map<string, (typeof succeeded)[number]>()
  const byPreviousRevision = new Map<string, (typeof succeeded)[number]>()
  for (const entry of succeeded) {
    if (byResultingRevision.has(entry.receipt.resultingRevision) ||
        byPreviousRevision.has(entry.transaction.previousRevision) ||
        entry.receipt.resultingRevision === entry.transaction.previousRevision) {
      throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
    }
    byResultingRevision.set(entry.receipt.resultingRevision, entry)
    byPreviousRevision.set(entry.transaction.previousRevision, entry)
  }

  const newestToOldest: Array<(typeof succeeded)[number]> = []
  const reachableRevisions = new Set<string>([state.revision])
  const consumedRequests = new Set<string>()
  let cursor = state.revision
  while (byResultingRevision.has(cursor)) {
    const entry = byResultingRevision.get(cursor)!
    if (consumedRequests.has(entry.transaction.requestId)) {
      throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
    }
    consumedRequests.add(entry.transaction.requestId)
    newestToOldest.push(entry)
    cursor = entry.transaction.previousRevision
    reachableRevisions.add(cursor)
  }
  const initialBase = {
    format: 'dyson-control-component-active-state' as const,
    schemaVersion: 1 as const,
    recoveryRequired: false,
    components: [] as StoredActiveComponent[],
    lastTransaction: null
  }
  const initialRevision = createHash('sha256').update(canonicalJson(initialBase)).digest('hex')
  if (consumedRequests.size !== succeeded.length || cursor !== initialRevision ||
      rolledBackPreviousRevisions.some((revision) => !reachableRevisions.has(revision))) {
    throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
  }

  const newest = newestToOldest[0]
  if ((newest === undefined) !== (state.lastTransaction === null) ||
      (newest !== undefined && canonicalJson(newest.transaction) !== canonicalJson(state.lastTransaction))) {
    throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
  }
  const latestByComponent = new Map<StoredActiveComponent['component'], StoredUpdateTransaction>()
  for (const entry of [...newestToOldest].reverse()) {
    latestByComponent.set(entry.transaction.component, entry.transaction)
  }
  if (latestByComponent.size !== state.components.length) {
    throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
  }
  for (const component of state.components) {
    const transaction = latestByComponent.get(component.component)
    if (transaction === undefined || component.version !== transaction.targetVersion ||
        component.artifactId !== transaction.artifactId || component.releaseId !== transaction.releaseId) {
      throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
    }
  }
}

function isValidUpdateRecoveryReceiptTransition(
  original: StoredUpdateReceiptEnvelope,
  recovered: StoredUpdateReceiptEnvelope
): boolean {
  if (original.requestFingerprint !== recovered.requestFingerprint ||
      original.receipt.status !== 'rollback-failed' || !original.receipt.recoveryRequired ||
      original.receipt.rollbackVerified || original.receipt.failureCode === null ||
      recovered.receipt.recoveryRequired) {
    return false
  }
  const immutableKeys = [
    'requestId', 'component', 'artifactId', 'compatibilityReceiptId', 'targetVersion',
    'releaseId', 'previousRevision', 'protectionBackupId', 'fileCount', 'expandedBytes'
  ] as const
  if (immutableKeys.some((key) => original.receipt[key] !== recovered.receipt[key])) return false
  if (recovered.receipt.status === 'succeeded') {
    return recovered.receipt.failureCode === null && !recovered.receipt.rollbackVerified
  }
  return recovered.receipt.status === 'rolled-back' && recovered.receipt.failureCode !== null &&
    recovered.receipt.rollbackVerified &&
    recovered.receipt.resultingRevision === recovered.receipt.previousRevision
}

async function readTrustedJsonIfPresent(filePath: string, maximumBytes: number): Promise<unknown | null> {
  try {
    return await readTrustedJson(filePath, maximumBytes)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  }
}

async function readTrustedJson(filePath: string, maximumBytes: number): Promise<unknown> {
  const metadata = await lstat(filePath)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 ||
      metadata.size > maximumBytes || !samePath(await realpath(filePath), filePath)) {
    throw new ProductionBackupRetentionProtectionError('SAVE_RETENTION_PROTECTION_SOURCE_INVALID')
  }
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown
  } catch (error) {
    throw new ProductionBackupRetentionProtectionError(
      'SAVE_RETENTION_PROTECTION_SOURCE_INVALID',
      { cause: error }
    )
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => path.resolve(value)
    .replace(/[\\/]+$/, '')
    .toLocaleLowerCase('en-US')
  return normalize(left) === normalize(right)
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonical(value))
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => [key, sortCanonical(entry)]))
  }
  return value
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
}

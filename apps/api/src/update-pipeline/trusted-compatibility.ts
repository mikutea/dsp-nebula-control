import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { TrustedModArtifactPolicy, trustedModArtifactPolicySchema } from './trusted-mod-artifacts.js'
import {
  compatibilityMatrixInputSchema,
  evaluateCompatibility,
  normalizeInventory,
  type CompatibilityDecision,
  type NormalizedRuntimeInventory
} from '../updates/compatibility.js'
import {
  normalizeVersion,
  normalizeVersionRange,
  sha256Schema,
  type VersionComponent,
  type VersionRange
} from '../updates/version.js'
import { UpdatePipelineError } from './errors.js'

const requestIdSchema = z.string().uuid()
const revisionSchema = z.string().regex(/^[0-9a-f]{64}$/)
const artifactIdSchema = z.string().min(16).max(96).regex(/^[a-z0-9][a-z0-9-]+$/)
const componentSchema = z.enum(['nebula', 'bepinex', 'bridge', 'control'])
const timestampSchema = z.string().datetime({ offset: true })

export type TrustedCompatibilityComponent = z.infer<typeof componentSchema>

export const trustedCompatibilityPolicyInputSchema = z.strictObject({
  format: z.literal('dyson-control-trusted-compatibility-policy'),
  schemaVersion: z.literal(1),
  policyId: z.string().min(3).max(96).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  reviewedAt: timestampSchema,
  matrix: compatibilityMatrixInputSchema,
  trustedModArtifacts: trustedModArtifactPolicySchema.optional()
})

export const trustedCompatibilityPreparationRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  component: componentSchema,
  artifactId: artifactIdSchema,
  sha256: sha256Schema,
  targetVersion: z.string().trim().min(1).max(64),
  expectedInventoryRevision: revisionSchema,
  expectedPolicyRevision: revisionSchema
})

interface NormalizedPolicy {
  trustedModArtifactsRevision?: string
  format: 'dyson-control-trusted-compatibility-policy'
  schemaVersion: 1
  policyId: string
  reviewedAt: string
  matrix: {
    schemaVersion: 1
    entries: Array<{
      id: string
      core: { dsp: VersionRange; nebula: VersionRange; bepInEx: VersionRange }
      plugins: Array<{ sourceId: string; range: VersionRange; required: boolean }>
    }>
  }
}

interface NormalizedPreparationRequest {
  requestId: string
  component: TrustedCompatibilityComponent
  artifactId: string
  sha256: string
  targetVersion: string
  expectedInventoryRevision: string
  expectedPolicyRevision: string
}

export interface TrustedCompatibilityStatus {
  format: 'dyson-control-trusted-compatibility-status'
  schemaVersion: 1
  available: boolean
  policyId: string | null
  policyRevision: string | null
  policyReviewedAt: string | null
  inventoryRevision: string
  inventory: NormalizedRuntimeInventory
}

export interface TrustedCompatibilityReceipt {
  format: 'dyson-control-trusted-compatibility-receipt'
  schemaVersion: 1
  receiptId: string
  component: TrustedCompatibilityComponent
  artifactId: string
  artifactSha256: string
  targetVersion: string
  inventoryRevision: string
  policyId: string
  policyRevision: string
  matchedEntryId: string | null
  compatible: boolean
  issuedAt: string
  expiresAt: string
  reused: boolean
}

interface StoredReceiptEnvelope {
  format: 'dyson-control-trusted-compatibility-receipt-envelope'
  schemaVersion: 1
  requestFingerprint: string
  decision: CompatibilityDecision
  receipt: TrustedCompatibilityReceipt
}

export interface TrustedCompatibilityServiceOptions {
  stateRoot: string
  /**
   * The policy is supplied only by trusted server configuration. A null policy
   * is a deliberate fail-closed production state, not an empty allow-list.
   */
  policy: unknown | null
  readRuntimeInventory(): Promise<unknown>
  now?: () => Date
  receiptLifetimeMs?: number
  maximumReceipts?: number
}

export interface TrustedCompatibilityAssertion {
  receipt: TrustedCompatibilityReceipt
  decision: CompatibilityDecision
  runtimeInventory: NormalizedRuntimeInventory
}

export class TrustedCompatibilityError extends UpdatePipelineError {
  constructor(code: string, options?: ErrorOptions) {
    super(code, options)
    this.name = 'TrustedCompatibilityError'
  }
}

/**
 * Produces and validates server-owned compatibility evidence. HTTP callers can
 * select only a staged candidate identity; they cannot submit policy entries,
 * runtime inventory, source URLs, paths, commands, or credentials.
 */
export class TrustedCompatibilityService {
  readonly #stateRoot: string
  readonly #receiptsRoot: string
  readonly #policy: NormalizedPolicy | null
  readonly #policyRevision: string | null
  readonly #readRuntimeInventory: () => Promise<unknown>
  readonly #now: () => Date
  readonly #receiptLifetimeMs: number
  readonly #maximumReceipts: number
  #tail: Promise<void> = Promise.resolve()

  constructor(options: TrustedCompatibilityServiceOptions) {
    if (!path.isAbsolute(options.stateRoot)) throw new TrustedCompatibilityError('UPDATE_COMPATIBILITY_ROOT_NOT_ABSOLUTE')
    this.#stateRoot = path.resolve(options.stateRoot)
    this.#receiptsRoot = path.join(this.#stateRoot, 'receipts')
    this.#policy = options.policy === null ? null : normalizePolicy(options.policy)
    this.#policyRevision = this.#policy === null ? null : sha256(canonicalJson(this.#policy))
    this.#readRuntimeInventory = options.readRuntimeInventory
    this.#now = options.now ?? (() => new Date())
    this.#receiptLifetimeMs = options.receiptLifetimeMs ?? 10 * 60 * 1_000
    this.#maximumReceipts = options.maximumReceipts ?? 10_000
    if (!Number.isSafeInteger(this.#receiptLifetimeMs) || this.#receiptLifetimeMs < 30_000 ||
        this.#receiptLifetimeMs > 24 * 60 * 60 * 1_000) {
      throw new TrustedCompatibilityError('UPDATE_COMPATIBILITY_LIFETIME_INVALID')
    }
    if (!Number.isSafeInteger(this.#maximumReceipts) || this.#maximumReceipts < 1 || this.#maximumReceipts > 100_000) {
      throw new TrustedCompatibilityError('UPDATE_COMPATIBILITY_RECEIPT_LIMIT_INVALID')
    }
  }

  async status(): Promise<TrustedCompatibilityStatus> {
    const inventory = await this.#inventory()
    return {
      format: 'dyson-control-trusted-compatibility-status',
      schemaVersion: 1,
      available: this.#policy !== null,
      policyId: this.#policy?.policyId ?? null,
      policyRevision: this.#policyRevision,
      policyReviewedAt: this.#policy?.reviewedAt ?? null,
      inventoryRevision: inventoryRevision(inventory),
      inventory
    }
  }

  async prepare(input: unknown): Promise<TrustedCompatibilityReceipt> {
    const request = normalizePreparationRequest(input)
    return await this.#serialize(async () => {
      await this.#assertRoot(true)
      const fingerprint = requestFingerprint(request)
      const existing = await this.#readReceipt(request.requestId)
      if (existing !== null) {
        if (existing.requestFingerprint !== fingerprint) {
          throw new TrustedCompatibilityError('UPDATE_COMPATIBILITY_IDEMPOTENCY_CONFLICT')
        }
        if (this.#isExpired(existing.receipt)) throw new TrustedCompatibilityError('UPDATE_COMPATIBILITY_RECEIPT_EXPIRED')
        return { ...existing.receipt, reused: true }
      }
      if ((await this.#receiptNames()).length >= this.#maximumReceipts) {
        throw new TrustedCompatibilityError('UPDATE_COMPATIBILITY_RECEIPT_LIMIT_REACHED')
      }
      if (this.#policy === null || this.#policyRevision === null) {
        throw new TrustedCompatibilityError('UPDATE_COMPATIBILITY_POLICY_UNAVAILABLE')
      }
      if (request.expectedPolicyRevision !== this.#policyRevision) {
        throw new TrustedCompatibilityError('UPDATE_COMPATIBILITY_POLICY_DRIFT')
      }
      const inventory = await this.#inventory()
      const currentInventoryRevision = inventoryRevision(inventory)
      if (request.expectedInventoryRevision !== currentInventoryRevision) {
        throw new TrustedCompatibilityError('UPDATE_COMPATIBILITY_INVENTORY_DRIFT')
      }
      const decision = evaluateCompatibility(candidateInventory(inventory, request), this.#policy.matrix)
      const issuedAt = this.#timestamp()
      const expiresAt = new Date(Date.parse(issuedAt) + this.#receiptLifetimeMs).toISOString()
      const receipt: TrustedCompatibilityReceipt = {
        format: 'dyson-control-trusted-compatibility-receipt',
        schemaVersion: 1,
        receiptId: request.requestId,
        component: request.component,
        artifactId: request.artifactId,
        artifactSha256: request.sha256,
        targetVersion: request.targetVersion,
        inventoryRevision: currentInventoryRevision,
        policyId: this.#policy.policyId,
        policyRevision: this.#policyRevision,
        matchedEntryId: decision.matchedEntryId,
        compatible: decision.compatible,
        issuedAt,
        expiresAt,
        reused: false
      }
      await this.#persistReceipt({
        format: 'dyson-control-trusted-compatibility-receipt-envelope',
        schemaVersion: 1,
        requestFingerprint: fingerprint,
        decision,
        receipt
      })
      return receipt
    })
  }

  async getReceipt(receiptIdInput: unknown): Promise<TrustedCompatibilityReceipt | null> {
    const receiptId = requestIdSchema.parse(receiptIdInput)
    await this.#assertRoot(false)
    const envelope = await this.#readReceipt(receiptId)
    return envelope === null ? null : { ...envelope.receipt, reused: false }
  }

  async assertCurrent(receiptIdInput: unknown, candidateInput: unknown): Promise<TrustedCompatibilityAssertion> {
    const receiptId = requestIdSchema.parse(receiptIdInput)
    const candidate = normalizeAssertionCandidate(candidateInput)
    if (this.#policy === null || this.#policyRevision === null) {
      throw new TrustedCompatibilityError('UPDATE_COMPATIBILITY_POLICY_UNAVAILABLE')
    }
    await this.#assertRoot(false)
    const envelope = await this.#readReceipt(receiptId)
    if (envelope === null) throw new TrustedCompatibilityError('UPDATE_COMPATIBILITY_RECEIPT_NOT_FOUND')
    const { receipt } = envelope
    if (this.#isExpired(receipt)) throw new TrustedCompatibilityError('UPDATE_COMPATIBILITY_RECEIPT_EXPIRED')
    if (!candidateMatchesReceipt(candidate, receipt)) {
      throw new TrustedCompatibilityError('UPDATE_COMPATIBILITY_CANDIDATE_MISMATCH')
    }
    if (receipt.policyRevision !== this.#policyRevision || receipt.policyId !== this.#policy.policyId) {
      throw new TrustedCompatibilityError('UPDATE_COMPATIBILITY_POLICY_DRIFT')
    }
    const inventory = await this.#inventory()
    if (inventoryRevision(inventory) !== receipt.inventoryRevision) {
      throw new TrustedCompatibilityError('UPDATE_COMPATIBILITY_INVENTORY_DRIFT')
    }
    const decision = evaluateCompatibility(candidateInventory(inventory, candidate), this.#policy.matrix)
    if (canonicalJson(decision) !== canonicalJson(envelope.decision) ||
        decision.compatible !== receipt.compatible || decision.matchedEntryId !== receipt.matchedEntryId) {
      throw new TrustedCompatibilityError('UPDATE_COMPATIBILITY_RECEIPT_INVALID')
    }
    if (!decision.compatible) throw new TrustedCompatibilityError('UPDATE_COMPATIBILITY_CONFLICT')
    return { receipt: { ...receipt, reused: false }, decision, runtimeInventory: inventory }
  }

  async #inventory(): Promise<NormalizedRuntimeInventory> {
    let input: unknown
    try {
      input = await this.#readRuntimeInventory()
      return normalizeInventory(input)
    } catch (error) {
      throw new TrustedCompatibilityError('UPDATE_COMPATIBILITY_INVENTORY_UNAVAILABLE', { cause: error })
    }
  }

  async #assertRoot(create: boolean): Promise<void> {
    try {
      if (create) await mkdir(this.#receiptsRoot, { recursive: true })
      for (const candidate of [this.#stateRoot, this.#receiptsRoot]) {
        const info = await lstat(candidate)
        if (!info.isDirectory() || info.isSymbolicLink()) {
          throw new TrustedCompatibilityError('UPDATE_COMPATIBILITY_ROOT_INVALID')
        }
      }
    } catch (error) {
      if (error instanceof TrustedCompatibilityError) throw error
      throw new TrustedCompatibilityError('UPDATE_COMPATIBILITY_ROOT_UNAVAILABLE', { cause: error })
    }
  }

  async #receiptNames(): Promise<string[]> {
    try {
      const entries = await readdir(this.#receiptsRoot, { withFileTypes: true })
      const names: string[] = []
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink() || !/^[0-9a-f-]{36}\.json$/.test(entry.name)) {
          throw new TrustedCompatibilityError('UPDATE_COMPATIBILITY_RECEIPT_DIRECTORY_INVALID')
        }
        names.push(entry.name)
      }
      return names.sort(compareText)
    } catch (error) {
      if (error instanceof TrustedCompatibilityError) throw error
      throw new TrustedCompatibilityError('UPDATE_COMPATIBILITY_ROOT_UNAVAILABLE', { cause: error })
    }
  }

  async #readReceipt(receiptId: string): Promise<StoredReceiptEnvelope | null> {
    const receiptPath = path.join(this.#receiptsRoot, `${receiptId}.json`)
    try {
      const info = await lstat(receiptPath)
      if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 64 * 1_024) {
        throw new TrustedCompatibilityError('UPDATE_COMPATIBILITY_RECEIPT_INVALID')
      }
      const raw = await readFile(receiptPath, 'utf8')
      return storedReceiptEnvelopeSchema.parse(JSON.parse(raw))
    } catch (error) {
      if (isMissing(error)) return null
      if (error instanceof TrustedCompatibilityError) throw error
      throw new TrustedCompatibilityError('UPDATE_COMPATIBILITY_RECEIPT_INVALID', { cause: error })
    }
  }

  async #persistReceipt(envelope: StoredReceiptEnvelope): Promise<void> {
    const destination = path.join(this.#receiptsRoot, `${envelope.receipt.receiptId}.json`)
    const temporary = path.join(this.#receiptsRoot, `.${envelope.receipt.receiptId}.${process.pid}.tmp`)
    const body = `${canonicalJson(envelope)}\n`
    if (Buffer.byteLength(body) > 64 * 1_024) throw new TrustedCompatibilityError('UPDATE_COMPATIBILITY_RECEIPT_INVALID')
    try {
      await writeFile(temporary, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      const handle = await open(temporary, constants.O_RDWR)
      try { await handle.sync() } finally { await handle.close() }
      await rename(temporary, destination)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw new TrustedCompatibilityError('UPDATE_COMPATIBILITY_PERSISTENCE_FAILED', { cause: error })
    }
  }

  #isExpired(receipt: TrustedCompatibilityReceipt): boolean {
    return this.#now().getTime() >= Date.parse(receipt.expiresAt)
  }

  #timestamp(): string {
    const date = this.#now()
    if (!Number.isFinite(date.getTime())) throw new TrustedCompatibilityError('UPDATE_COMPATIBILITY_CLOCK_INVALID')
    return date.toISOString()
  }

  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail
    let release!: () => void
    this.#tail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try { return await operation() } finally { release() }
  }
}

const trustedCompatibilityReceiptSchema: z.ZodType<TrustedCompatibilityReceipt> = z.strictObject({
  format: z.literal('dyson-control-trusted-compatibility-receipt'),
  schemaVersion: z.literal(1),
  receiptId: requestIdSchema,
  component: componentSchema,
  artifactId: artifactIdSchema,
  artifactSha256: sha256Schema,
  targetVersion: z.string().min(1).max(64),
  inventoryRevision: revisionSchema,
  policyId: z.string().min(3).max(96).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  policyRevision: revisionSchema,
  matchedEntryId: z.string().min(1).max(96).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/).nullable(),
  compatible: z.boolean(),
  issuedAt: timestampSchema,
  expiresAt: timestampSchema,
  reused: z.boolean()
})

const compatibilityReasonSchema = z.strictObject({
  code: z.enum([
    'dsp-version-mismatch', 'nebula-version-mismatch', 'bepinex-version-mismatch',
    'plugin-missing', 'plugin-version-mismatch'
  ]),
  component: z.enum(['dsp', 'nebula', 'bepinex', 'plugin']),
  sourceId: z.string().nullable(),
  expected: z.string(),
  actual: z.string().nullable()
})

const normalizedInventorySchema = z.strictObject({
  dsp: z.string(),
  nebula: z.string(),
  bepInEx: z.string(),
  plugins: z.array(z.strictObject({ sourceId: z.string(), version: z.string() })).max(256)
})

const compatibilityDecisionSchema: z.ZodType<CompatibilityDecision> = z.strictObject({
  compatible: z.boolean(),
  matchedEntryId: z.string().nullable(),
  inventory: normalizedInventorySchema,
  evaluations: z.array(z.strictObject({
    entryId: z.string(),
    compatible: z.boolean(),
    reasons: z.array(compatibilityReasonSchema).max(1024)
  })).max(128)
})

const storedReceiptEnvelopeSchema: z.ZodType<StoredReceiptEnvelope> = z.strictObject({
  format: z.literal('dyson-control-trusted-compatibility-receipt-envelope'),
  schemaVersion: z.literal(1),
  requestFingerprint: revisionSchema,
  decision: compatibilityDecisionSchema,
  receipt: trustedCompatibilityReceiptSchema
})

function normalizePreparationRequest(input: unknown): NormalizedPreparationRequest {
  try {
    const parsed = trustedCompatibilityPreparationRequestSchema.parse(input)
    return normalizeCandidateFields(parsed)
  } catch (error) {
    throw new TrustedCompatibilityError('UPDATE_COMPATIBILITY_REQUEST_INVALID', { cause: error })
  }
}

function normalizeAssertionCandidate(input: unknown): Omit<NormalizedPreparationRequest, 'requestId' | 'expectedInventoryRevision' | 'expectedPolicyRevision'> {
  const schema = trustedCompatibilityPreparationRequestSchema.omit({
    requestId: true,
    expectedInventoryRevision: true,
    expectedPolicyRevision: true
  })
  try {
    return normalizeCandidateFields(schema.parse(input))
  } catch (error) {
    throw new TrustedCompatibilityError('UPDATE_COMPATIBILITY_CANDIDATE_INVALID', { cause: error })
  }
}

function normalizeCandidateFields<T extends {
  component: TrustedCompatibilityComponent
  targetVersion: string
  sha256: string
}>(input: T): T & { targetVersion: string; sha256: string } {
  return {
    ...input,
    targetVersion: normalizeVersion(input.targetVersion, versionComponent(input.component)),
    sha256: input.sha256.toLowerCase()
  }
}

function normalizePolicy(input: unknown): NormalizedPolicy {
  try {
    const parsed = trustedCompatibilityPolicyInputSchema.parse(input)
    const entries = parsed.matrix.entries.map((entry) => ({
      id: entry.id,
      core: {
        dsp: normalizeVersionRange(entry.core.dsp, 'dsp'),
        nebula: normalizeVersionRange(entry.core.nebula, 'nebula'),
        bepInEx: normalizeVersionRange(entry.core.bepInEx, 'bepinex')
      },
      plugins: entry.plugins.map((plugin) => ({
        sourceId: plugin.sourceId,
        range: normalizeVersionRange(plugin.range, 'plugin'),
        required: plugin.required
      })).sort((left, right) => compareText(left.sourceId.toLowerCase(), right.sourceId.toLowerCase()))
    })).sort((left, right) => compareText(left.id, right.id))
    // evaluateCompatibility owns duplicate and semantic validation. Use a
    // valid normalized sentinel inventory to make construction fail early.
    const matrix = { schemaVersion: 1 as const, entries }
    evaluateCompatibility({ dsp: '0.0.0.0', nebula: '0.0.0', bepInEx: '0.0.0', plugins: [] }, matrix)
    return {
      format: 'dyson-control-trusted-compatibility-policy',
      schemaVersion: 1,
      policyId: parsed.policyId,
      reviewedAt: new Date(parsed.reviewedAt).toISOString(),
      matrix,
      ...(parsed.trustedModArtifacts === undefined ? {} : {
        trustedModArtifactsRevision: new TrustedModArtifactPolicy(parsed.trustedModArtifacts).revision
      })
    }
  } catch (error) {
    throw new TrustedCompatibilityError('UPDATE_COMPATIBILITY_POLICY_INVALID', { cause: error })
  }
}

function candidateInventory(
  inventory: NormalizedRuntimeInventory,
  candidate: Pick<NormalizedPreparationRequest, 'component' | 'targetVersion'>
): NormalizedRuntimeInventory {
  const next: NormalizedRuntimeInventory = {
    ...inventory,
    plugins: inventory.plugins.map((plugin) => ({ ...plugin }))
  }
  if (candidate.component === 'nebula') next.nebula = candidate.targetVersion
  else if (candidate.component === 'bepinex') next.bepInEx = candidate.targetVersion
  else {
    const sourceId = candidate.component === 'bridge'
      ? 'thunderstore:DysonControl/Bridge'
      : 'thunderstore:DysonControl/Control'
    next.plugins = next.plugins.filter((plugin) => plugin.sourceId.toLowerCase() !== sourceId.toLowerCase())
    next.plugins.push({ sourceId, version: candidate.targetVersion })
  }
  return normalizeInventory(next)
}

function candidateMatchesReceipt(
  candidate: Omit<NormalizedPreparationRequest, 'requestId' | 'expectedInventoryRevision' | 'expectedPolicyRevision'>,
  receipt: TrustedCompatibilityReceipt
): boolean {
  return candidate.component === receipt.component && candidate.artifactId === receipt.artifactId &&
    candidate.sha256 === receipt.artifactSha256 && candidate.targetVersion === receipt.targetVersion
}

function versionComponent(component: TrustedCompatibilityComponent): VersionComponent {
  if (component === 'nebula') return 'nebula'
  if (component === 'bepinex') return 'bepinex'
  return 'plugin'
}

function requestFingerprint(request: NormalizedPreparationRequest): string {
  return sha256(canonicalJson(request))
}

function inventoryRevision(inventory: NormalizedRuntimeInventory): string {
  return sha256(canonicalJson(inventory))
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, child]) => [key, sortJson(child)]))
  }
  return value
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

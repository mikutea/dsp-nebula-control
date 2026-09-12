import { createHash } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'
import {
  TrustedCompatibilityService,
  trustedCompatibilityPolicyInputSchema,
  type TrustedCompatibilityStatus
} from '../update-pipeline/trusted-compatibility.js'
import { evaluateCompatibility } from '../updates/compatibility.js'
import { normalizeVersion } from '../updates/version.js'
import { rollbackWarningsApproved } from '../update-pipeline/rollback-health-policy.js'

export interface RollbackWarningCheck {
  component: 'nebula' | 'bepinex' | 'bridge' | 'control'
  expectedVersion: string
  warnings: readonly string[]
}

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
const versionSchema = z.string().trim().min(1).max(64)
const statusSchema: z.ZodType<TrustedCompatibilityStatus> = z.strictObject({
  format: z.literal('dyson-control-trusted-compatibility-status'),
  schemaVersion: z.literal(1),
  available: z.boolean(),
  policyId: z.string().min(1).max(96).nullable(),
  policyRevision: sha256Schema.nullable(),
  policyReviewedAt: z.string().datetime({ offset: true }).nullable(),
  inventoryRevision: sha256Schema,
  inventory: z.strictObject({
    dsp: versionSchema,
    nebula: versionSchema,
    bepInEx: versionSchema,
    plugins: z.array(z.strictObject({
      sourceId: z.string().min(1).max(256),
      version: versionSchema
    })).max(256)
  })
})

export interface WindowsRuntimeCompatibilityEvidence {
  dspVersion: string
  compatibilityRevision: string
  compatible: boolean
}

export interface WindowsRuntimeCompatibilitySource {
  inspect(signal?: AbortSignal): Promise<WindowsRuntimeCompatibilityEvidence>
  approveRollbackWarnings?(input: RollbackWarningCheck, signal?: AbortSignal): Promise<boolean>
}

export interface WindowsTrustedRuntimeCompatibilityInspectorOptions {
  projectRoot: string
  trustedCompatibilityService: Pick<TrustedCompatibilityService, 'status'>
  /** The same trusted policy object used to construct trustedCompatibilityService. */
  policy: unknown
}

export class WindowsRuntimeCompatibilityError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'WindowsRuntimeCompatibilityError'
    this.code = code
  }
}

/**
 * Re-evaluates the freshly sampled fixed runtime inventory against the exact
 * trusted policy. A shadow TrustedCompatibilityService independently derives
 * the normalized policy revision, preventing accidental policy mis-wiring.
 */
export class WindowsTrustedRuntimeCompatibilityInspector implements
  WindowsRuntimeCompatibilitySource {
  readonly #service: WindowsTrustedRuntimeCompatibilityInspectorOptions['trustedCompatibilityService']
  readonly #policy: z.output<typeof trustedCompatibilityPolicyInputSchema>
  readonly #policyVerifier: TrustedCompatibilityService

  constructor(options: WindowsTrustedRuntimeCompatibilityInspectorOptions) {
    if (!options || !isSafeAbsoluteRoot(options.projectRoot) ||
        typeof options.trustedCompatibilityService?.status !== 'function') {
      throw new WindowsRuntimeCompatibilityError('WINDOWS_RUNTIME_COMPATIBILITY_OPTIONS_INVALID')
    }
    const policy = trustedCompatibilityPolicyInputSchema.safeParse(options.policy)
    if (!policy.success) {
      throw new WindowsRuntimeCompatibilityError('WINDOWS_RUNTIME_COMPATIBILITY_POLICY_INVALID')
    }
    this.#service = options.trustedCompatibilityService
    this.#policy = policy.data
    this.#policyVerifier = new TrustedCompatibilityService({
      stateRoot: path.join(path.resolve(options.projectRoot), '.dyson-control', 'policy-verifier'),
      policy: policy.data,
      readRuntimeInventory: async () => (await this.#service.status()).inventory
    })
  }

  async inspect(signal?: AbortSignal): Promise<WindowsRuntimeCompatibilityEvidence> {
    signal?.throwIfAborted()
    try {
      const current = statusSchema.parse(await this.#service.status())
      signal?.throwIfAborted()
      const independentlyNormalized = statusSchema.parse(await this.#policyVerifier.status())
      signal?.throwIfAborted()
      if (!current.available || current.policyRevision === null || current.policyId === null ||
          independentlyNormalized.policyRevision !== current.policyRevision ||
          independentlyNormalized.policyId !== current.policyId ||
          independentlyNormalized.inventoryRevision !== current.inventoryRevision) {
        throw new WindowsRuntimeCompatibilityError('WINDOWS_RUNTIME_COMPATIBILITY_AUTHORITY_DRIFT')
      }
      const decision = evaluateCompatibility(current.inventory, this.#policy.matrix)
      const compatibilityRevision = sha256(canonicalJson({
        policyId: current.policyId,
        policyRevision: current.policyRevision,
        inventoryRevision: current.inventoryRevision,
        decision
      }))
      return {
        dspVersion: current.inventory.dsp,
        compatibilityRevision,
        compatible: decision.compatible
      }
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof WindowsRuntimeCompatibilityError) throw error
      throw new WindowsRuntimeCompatibilityError('WINDOWS_RUNTIME_COMPATIBILITY_UNAVAILABLE')
    }
  }

  async approveRollbackWarnings(input: RollbackWarningCheck, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted()
    try {
      const current = statusSchema.parse(await this.#service.status())
      const normalized = statusSchema.parse(await this.#policyVerifier.status())
      signal?.throwIfAborted()
      if (!current.available || current.policyRevision === null ||
          current.policyRevision !== normalized.policyRevision || current.policyId !== normalized.policyId ||
          current.inventoryRevision !== normalized.inventoryRevision) return false
      const observed = input.component === 'nebula' ? current.inventory.nebula
        : input.component === 'bepinex' ? current.inventory.bepInEx
          : current.inventory.plugins.find(plugin => plugin.sourceId.toLowerCase() ===
            `thunderstore:dysoncontrol/${input.component}`)?.version
      const kind = input.component === 'bepinex' ? 'bepinex' : input.component === 'nebula' ? 'nebula' : 'plugin'
      if (!observed || normalizeVersion(observed, kind) !== normalizeVersion(input.expectedVersion, kind)) return false
      return rollbackWarningsApproved({ phase: 'rollback', approvals: this.#policy.rollbackWarningApprovals,
        matrix: this.#policy.matrix, inventory: current.inventory, warnings: input.warnings })
    } catch {
      signal?.throwIfAborted()
      return false
    }
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonical(value))
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, sortCanonical(child)]))
  }
  return value
}

function isSafeAbsoluteRoot(value: unknown): value is string {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return false
  const resolved = path.resolve(value)
  return resolved !== path.parse(resolved).root
}

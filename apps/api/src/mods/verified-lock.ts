import { z } from 'zod'
import {
  generateModManifests,
  type GeneratedModManifests
} from './manifest.js'
import { thunderstoreDependencyIdSchema } from './dependency.js'
import {
  ThunderstoreModImportError,
  thunderstoreModImportReceiptSchema,
  type ThunderstoreModImportReceipt
} from './thunderstore-import.js'
import {
  partitionThunderstorePluginDependencies,
  type ThunderstoreManagedPlatformRequirement
} from '../update-pipeline/thunderstore-dependency-routing.js'
import { createModPlatformLock, type ModPlatformLock } from './platform-lock.js'

const uuidSchema = z.string().uuid()
const sourceIdSchema = z.string().regex(/^thunderstore:[A-Za-z0-9_]{1,64}\/[A-Za-z0-9_]{1,64}$/)

export const verifiedModLockReceiptRequestSchema = z.strictObject({
  roots: z.array(thunderstoreDependencyIdSchema).min(1).max(128),
  importReceiptIds: z.array(uuidSchema).min(1).max(128),
  policies: z.array(z.strictObject({
    sourceId: sourceIdSchema,
    serverRequired: z.boolean(),
    clientRequirement: z.enum(['required', 'optional', 'not-required'])
  }).superRefine((value, context) => {
    if (!value.serverRequired && value.clientRequirement === 'not-required') {
      context.addIssue({ code: 'custom', message: 'a mod must be required by the server or relevant to a client' })
    }
  })).min(1).max(128)
})

export interface VerifiedModLockReceiptSource {
  getVerifiedReceipt(
    requestId: unknown,
    signal?: AbortSignal
  ): Promise<ThunderstoreModImportReceipt | null>
}

export interface VerifiedModLockPreview {
  mode: 'dry-run'
  serverLock: GeneratedModManifests['serverLock']
  serverLockSha256: string
  clientParity: GeneratedModManifests['clientParity']
  platformLock: ModPlatformLock
  platformRequirements: Array<{
    dependencyId: string
    sourceId: string
    deploymentOwner: 'nebula' | 'bepinex'
    requiredVersion: string
    actualVersion: string
    satisfied: true
  }>
}

export class VerifiedModLockError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) {
    super(code, options)
    this.name = 'VerifiedModLockError'
  }
}

/**
 * Builds a lock only from server-persisted import receipts. The browser may
 * choose logical roots and parity policy, but cannot submit release metadata,
 * archive/payload digests, dependency lists, host paths, URLs, ZIPs, or bytes.
 */
export class VerifiedModLockService {
  readonly #receipts: VerifiedModLockReceiptSource
  readonly #readPlatformInventory: (() => Promise<{
    inventoryRevision: string
    inventory: { nebula: string; bepInEx: string }
  }>) | null

  constructor(options: {
    receipts: VerifiedModLockReceiptSource
    readPlatformInventory?: () => Promise<{
      inventoryRevision: string
      inventory: { nebula: string; bepInEx: string }
    }>
  }) {
    this.#receipts = options.receipts
    this.#readPlatformInventory = options.readPlatformInventory ?? null
  }

  async preview(input: unknown, signal?: AbortSignal): Promise<VerifiedModLockPreview> {
    const request = verifiedModLockReceiptRequestSchema.parse(input)
    assertNotAborted(signal)
    assertUnique(request.roots.map((value) => value.toLowerCase()), 'VERIFIED_MOD_ROOT_DUPLICATE')
    assertUnique(request.importReceiptIds.map((value) => value.toLowerCase()), 'VERIFIED_MOD_IMPORT_RECEIPT_DUPLICATE')
    assertUnique(request.policies.map((value) => value.sourceId.toLowerCase()), 'VERIFIED_MOD_POLICY_DUPLICATE')

    let receipts: ThunderstoreModImportReceipt[]
    try {
      receipts = await Promise.all(request.importReceiptIds.map(async (receiptId) => {
        assertNotAborted(signal)
        const receipt = await this.#receipts.getVerifiedReceipt(receiptId, signal)
        assertNotAborted(signal)
        if (receipt === null) throw new VerifiedModLockError('VERIFIED_MOD_IMPORT_RECEIPT_NOT_FOUND')
        try {
          const parsed = thunderstoreModImportReceiptSchema.parse(receipt)
          if (parsed.requestId !== receiptId) {
            throw new VerifiedModLockError('VERIFIED_MOD_IMPORT_RECEIPT_IDENTITY_MISMATCH')
          }
          return parsed
        } catch (error) {
          if (error instanceof VerifiedModLockError) throw error
          throw new VerifiedModLockError('VERIFIED_MOD_IMPORT_RECEIPT_INVALID', { cause: error })
        }
      }))
    } catch (error) {
      if (error instanceof VerifiedModLockError) throw error
      if (error instanceof ThunderstoreModImportError) {
        if (error.code === 'THUNDERSTORE_MOD_IMPORT_ABORTED') {
          throw new VerifiedModLockError('VERIFIED_MOD_LOCK_ABORTED', { cause: error })
        }
        if (error.code === 'THUNDERSTORE_MOD_IMPORT_ACQUISITION_UNAVAILABLE') {
          throw new VerifiedModLockError('VERIFIED_MOD_IMPORT_RECEIPT_UNAVAILABLE', { cause: error })
        }
        throw new VerifiedModLockError('VERIFIED_MOD_IMPORT_RECEIPT_INVALID', { cause: error })
      }
      throw new VerifiedModLockError('VERIFIED_MOD_IMPORT_RECEIPT_UNAVAILABLE', { cause: error })
    }

    assertUnique(receipts.map((value) => value.package.dependencyId.toLowerCase()), 'VERIFIED_MOD_PACKAGE_DUPLICATE')
    assertUnique(receipts.map((value) => value.package.sourceId.toLowerCase()), 'VERIFIED_MOD_SOURCE_DUPLICATE')
    const policies = new Map(request.policies.map((policy) => [policy.sourceId.toLowerCase(), policy]))
    const receiptSources = new Set(receipts.map((receipt) => receipt.package.sourceId.toLowerCase()))
    if (request.policies.some((policy) => !receiptSources.has(policy.sourceId.toLowerCase()))) {
      throw new VerifiedModLockError('VERIFIED_MOD_POLICY_UNUSED')
    }

    const platformRequirements = new Map<string, ThunderstoreManagedPlatformRequirement>()
    const packages = receipts.map((receipt) => {
      const policy = policies.get(receipt.package.sourceId.toLowerCase())
      if (policy === undefined) throw new VerifiedModLockError('VERIFIED_MOD_POLICY_MISSING')
      const partition = partitionThunderstorePluginDependencies(receipt.package.dependencies)
      if (partition.unsupportedRequirements.length > 0) {
        throw new VerifiedModLockError('VERIFIED_MOD_PLATFORM_REQUIREMENT_UNSUPPORTED')
      }
      for (const requirement of partition.platformRequirements) {
        const key = requirement.sourceId.toLowerCase()
        const existing = platformRequirements.get(key)
        if (existing && existing.requiredVersion !== requirement.requiredVersion) {
          throw new VerifiedModLockError('VERIFIED_MOD_PLATFORM_VERSION_CONFLICT')
        }
        platformRequirements.set(key, requirement)
      }
      return {
        dependencyId: receipt.package.dependencyId,
        sha256: receipt.payload.sha256,
        dependencies: [...partition.pluginDependencyIds],
        serverRequired: policy.serverRequired,
        clientRequirement: policy.clientRequirement
      }
    })
    assertNotAborted(signal)
    const manifests = generateModManifests({ roots: request.roots, packages })
    assertNotAborted(signal)
    const receiptPackageIds = receipts.map((receipt) => receipt.package.dependencyId.toLowerCase())
    const lockPackageIds = manifests.serverLock.mods.map((entry) => entry.dependencyId.toLowerCase())
    assertExactSet(
      receiptPackageIds,
      lockPackageIds,
      'VERIFIED_MOD_IMPORT_RECEIPT_UNUSED',
      'VERIFIED_MOD_LOCK_PACKAGE_MISMATCH'
    )
    const policySourceIds = request.policies.map((policy) => policy.sourceId.toLowerCase())
    const lockSourceIds = manifests.serverLock.mods.map((entry) => entry.sourceId.toLowerCase())
    assertExactSet(
      policySourceIds,
      lockSourceIds,
      'VERIFIED_MOD_POLICY_UNUSED',
      'VERIFIED_MOD_POLICY_MISSING'
    )
    const verifiedPlatform = await this.#verifyPlatformRequirements(
      [...platformRequirements.values()],
      manifests.serverLockSha256,
      signal
    )
    return {
      mode: 'dry-run',
      ...manifests,
      platformRequirements: verifiedPlatform.platformRequirements,
      platformLock: verifiedPlatform.platformLock
    }
  }

  async #verifyPlatformRequirements(
    requirements: ThunderstoreManagedPlatformRequirement[],
    serverLockSha256: string,
    signal?: AbortSignal
  ): Promise<Pick<VerifiedModLockPreview, 'platformRequirements' | 'platformLock'>> {
    if (requirements.length === 0) {
      return {
        platformRequirements: [],
        platformLock: createModPlatformLock({ serverLockSha256, inventoryRevision: null, requirements: [] })
      }
    }
    if (this.#readPlatformInventory === null) {
      throw new VerifiedModLockError('VERIFIED_MOD_PLATFORM_INVENTORY_UNAVAILABLE')
    }
    let current: {
      inventoryRevision: string
      inventory: { nebula: string; bepInEx: string }
    }
    try {
      current = await this.#readPlatformInventory()
    } catch (error) {
      throw new VerifiedModLockError('VERIFIED_MOD_PLATFORM_INVENTORY_UNAVAILABLE', { cause: error })
    }
    assertNotAborted(signal)
    if (!/^[0-9a-f]{64}$/.test(current.inventoryRevision) || typeof current.inventory.nebula !== 'string' ||
        typeof current.inventory.bepInEx !== 'string') {
      throw new VerifiedModLockError('VERIFIED_MOD_PLATFORM_INVENTORY_INVALID')
    }
    const sorted = requirements.sort((left, right) => compareText(left.dependencyId, right.dependencyId))
    const platformRequirements = sorted.map((requirement) => {
      const actualVersion = requirement.deploymentOwner === 'nebula'
        ? current.inventory.nebula
        : current.inventory.bepInEx
      if (actualVersion !== requirement.requiredVersion) {
        throw new VerifiedModLockError('VERIFIED_MOD_PLATFORM_VERSION_MISMATCH')
      }
      return {
        dependencyId: requirement.dependencyId,
        sourceId: requirement.sourceId,
        deploymentOwner: requirement.deploymentOwner,
        requiredVersion: requirement.requiredVersion,
        actualVersion,
        satisfied: true as const
      }
    })
    return {
      platformRequirements,
      platformLock: createModPlatformLock({
        serverLockSha256,
        inventoryRevision: current.inventoryRevision,
        requirements: sorted
      })
    }
  }
}

function assertUnique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) throw new VerifiedModLockError(code)
}

function assertExactSet(
  expected: readonly string[],
  actual: readonly string[],
  expectedOnlyCode: string,
  actualOnlyCode: string
): void {
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)
  if (expected.some((value) => !actualSet.has(value))) {
    throw new VerifiedModLockError(expectedOnlyCode)
  }
  if (actual.some((value) => !expectedSet.has(value))) {
    throw new VerifiedModLockError(actualOnlyCode)
  }
  if (expectedSet.size !== actualSet.size) {
    throw new VerifiedModLockError('VERIFIED_MOD_LOCK_SET_MISMATCH')
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new VerifiedModLockError('VERIFIED_MOD_LOCK_ABORTED')
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

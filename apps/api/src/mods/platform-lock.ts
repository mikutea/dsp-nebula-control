import { createHash } from 'node:crypto'
import { z } from 'zod'
import { sha256Schema } from '../updates/version.js'
import {
  partitionThunderstorePluginDependencies,
  type ThunderstoreManagedPlatformRequirement
} from '../update-pipeline/thunderstore-dependency-routing.js'
import { thunderstoreDependencyIdSchema } from './dependency.js'

const sourceIdSchema = z.string().regex(/^thunderstore:[A-Za-z0-9_]{1,64}\/[A-Za-z0-9_]{1,64}$/)

export interface ModPlatformLockRequirement {
  dependencyId: string
  sourceId: string
  deploymentOwner: 'nebula' | 'bepinex'
  requiredVersion: string
}

export interface ModPlatformLock {
  format: 'dyson-control-mod-platform-lock'
  schemaVersion: 1
  serverLockSha256: string
  inventoryRevision: string | null
  requirements: ModPlatformLockRequirement[]
  digest: string
}

const requirementSchema: z.ZodType<ModPlatformLockRequirement> = z.strictObject({
  dependencyId: thunderstoreDependencyIdSchema,
  sourceId: sourceIdSchema,
  deploymentOwner: z.enum(['nebula', 'bepinex']),
  requiredVersion: z.string().min(1).max(64)
})

export const modPlatformLockSchema: z.ZodType<ModPlatformLock> = z.strictObject({
  format: z.literal('dyson-control-mod-platform-lock'),
  schemaVersion: z.literal(1),
  serverLockSha256: sha256Schema,
  inventoryRevision: sha256Schema.nullable(),
  requirements: z.array(requirementSchema).max(6),
  digest: sha256Schema
})

export class ModPlatformLockError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'ModPlatformLockError'
  }
}

export function createModPlatformLock(input: {
  serverLockSha256: string
  inventoryRevision: string | null
  requirements: readonly ThunderstoreManagedPlatformRequirement[]
}): ModPlatformLock {
  const requirements = input.requirements.map((requirement) => ({
    dependencyId: requirement.dependencyId,
    sourceId: requirement.sourceId,
    deploymentOwner: requirement.deploymentOwner,
    requiredVersion: requirement.requiredVersion
  })).sort(compareRequirements)
  const lockWithoutDigest = {
    format: 'dyson-control-mod-platform-lock' as const,
    schemaVersion: 1 as const,
    serverLockSha256: input.serverLockSha256,
    inventoryRevision: input.inventoryRevision,
    requirements
  }
  return validateModPlatformLock({
    ...lockWithoutDigest,
    digest: digestLock(lockWithoutDigest)
  }, input.serverLockSha256)
}

export function validateModPlatformLock(input: unknown, expectedServerLockSha256: string): ModPlatformLock {
  const parsed = modPlatformLockSchema.safeParse(input)
  if (!parsed.success) throw new ModPlatformLockError('MOD_PLATFORM_LOCK_INVALID')
  const lock = parsed.data
  if (lock.serverLockSha256 !== expectedServerLockSha256 || lock.serverLockSha256 !== lock.serverLockSha256.toLowerCase() ||
      lock.digest !== lock.digest.toLowerCase()) {
    throw new ModPlatformLockError('MOD_PLATFORM_LOCK_INVALID')
  }
  if ((lock.requirements.length === 0) !== (lock.inventoryRevision === null)) {
    throw new ModPlatformLockError('MOD_PLATFORM_LOCK_INVENTORY_SEMANTICS_INVALID')
  }
  if (lock.inventoryRevision !== null && lock.inventoryRevision !== lock.inventoryRevision.toLowerCase()) {
    throw new ModPlatformLockError('MOD_PLATFORM_LOCK_INVALID')
  }
  const keys = new Set<string>()
  for (let index = 0; index < lock.requirements.length; index++) {
    const requirement = lock.requirements[index]!
    const key = requirement.sourceId.toLowerCase()
    if (keys.has(key) || (index > 0 && compareRequirements(lock.requirements[index - 1]!, requirement) >= 0)) {
      throw new ModPlatformLockError('MOD_PLATFORM_LOCK_REQUIREMENTS_INVALID')
    }
    const partition = partitionThunderstorePluginDependencies([requirement.dependencyId])
    const routed = partition.platformRequirements[0]
    if (partition.pluginDependencyIds.length !== 0 || partition.unsupportedRequirements.length !== 0 ||
        partition.platformRequirements.length !== 1 || routed === undefined ||
        routed.sourceId !== requirement.sourceId || routed.deploymentOwner !== requirement.deploymentOwner ||
        routed.requiredVersion !== requirement.requiredVersion) {
      throw new ModPlatformLockError('MOD_PLATFORM_LOCK_REQUIREMENTS_INVALID')
    }
    keys.add(key)
  }
  if (digestLock({
    format: lock.format,
    schemaVersion: lock.schemaVersion,
    serverLockSha256: lock.serverLockSha256,
    inventoryRevision: lock.inventoryRevision,
    requirements: lock.requirements
  }) !== lock.digest) {
    throw new ModPlatformLockError('MOD_PLATFORM_LOCK_DIGEST_MISMATCH')
  }
  return lock
}

function digestLock(lock: Omit<ModPlatformLock, 'digest'>): string {
  return createHash('sha256').update(`${JSON.stringify(lock)}\n`, 'utf8').digest('hex')
}

function compareRequirements(left: ModPlatformLockRequirement, right: ModPlatformLockRequirement): number {
  const leftKey = `${left.deploymentOwner}:${left.dependencyId}`
  const rightKey = `${right.deploymentOwner}:${right.dependencyId}`
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
}

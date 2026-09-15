import { z } from 'zod'
import {
  parseThunderstoreDependency,
  thunderstoreDependencyIdSchema,
  type ThunderstoreDependency
} from '../mods/dependency.js'
import { UpdatePipelineError } from './errors.js'

/**
 * Server-owned routing for an exact Thunderstore dependency.
 *
 * A Thunderstore dependency declaration is not proof that its archive belongs
 * in BepInEx/plugins. Known framework and component packages are therefore
 * diverted before artifact candidate registration. The archive-layout and
 * ownership gates remain a second line of defence during staging/import.
 */
export type ThunderstoreDependencyRoute =
  | {
      dependencyId: string
      sourceId: string
      requiredVersion: string
      disposition: 'plugin'
      deploymentOwner: 'mods'
      resolution: 'mod-import-pipeline'
      directPluginAcquisitionAllowed: true
    }
  | {
      dependencyId: string
      sourceId: string
      requiredVersion: string
      disposition: 'managed-component'
      deploymentOwner: 'nebula'
      resolution: 'nebula-component-pipeline'
      directPluginAcquisitionAllowed: false
    }
  | {
      dependencyId: string
      sourceId: string
      requiredVersion: string
      disposition: 'external-prerequisite'
      deploymentOwner: 'bepinex'
      resolution: 'bepinex-component-inventory'
      directPluginAcquisitionAllowed: false
    }
  | {
      dependencyId: string
      sourceId: string
      requiredVersion: string
      disposition: 'unsupported-platform-package'
      deploymentOwner: null
      resolution: 'manual-policy-required'
      directPluginAcquisitionAllowed: false
    }

export interface ThunderstoreDependencyRouteInput {
  dependencyId: string
  sourceId: string
  namespace: string
  name: string
  version: string
}

export type ThunderstoreManagedPlatformRequirement = Extract<
  ThunderstoreDependencyRoute,
  { disposition: 'managed-component' | 'external-prerequisite' }
>

export type ThunderstoreUnsupportedPlatformRequirement = Extract<
  ThunderstoreDependencyRoute,
  { disposition: 'unsupported-platform-package' }
>

export interface PartitionedThunderstorePluginDependencies {
  pluginDependencyIds: readonly string[]
  platformRequirements: readonly ThunderstoreManagedPlatformRequirement[]
  unsupportedRequirements: readonly ThunderstoreUnsupportedPlatformRequirement[]
}

const thunderstoreDependencyListSchema = z.array(thunderstoreDependencyIdSchema).max(64)

const managedNebulaSources = new Set([
  'thunderstore:nebula/nebulamultiplayermod',
  'thunderstore:nebula/nebulamultiplayermodapi'
])

// xiaoye97-BepInEx is the package currently published for DSP. The Pack
// spellings are retained as fail-closed aliases so a provider-side rename does
// not silently turn a framework archive into an ordinary plugin candidate.
const managedBepInExPrerequisiteSources = new Set([
  'thunderstore:xiaoye97/bepinex',
  'thunderstore:xiaoye97/bepinexpack',
  'thunderstore:xiaoye97/bepinexpackdsp',
  'thunderstore:xiaoye97/bepinexpack_dsp'
])

const reservedNebulaPackageNames = new Set([
  'nebulamultiplayermod',
  'nebulamultiplayermodapi'
])

const reservedBepInExPackageNames = new Set([
  'bepinex',
  'bepinexpack',
  'bepinexpackdsp',
  'bepinexpack_dsp'
])

export function routeThunderstoreDependency(
  input: ThunderstoreDependencyRouteInput
): ThunderstoreDependencyRoute {
  const identity = parseThunderstoreDependency(input.dependencyId)
  if (identity.sourceId !== input.sourceId || identity.namespace !== input.namespace ||
      identity.name !== input.name || identity.version !== input.version) {
    throw new UpdatePipelineError('THUNDERSTORE_IDENTITY_MISMATCH')
  }
  return routeExactIdentity(identity)
}

/**
 * Routes a single exact dependency using only its canonical dependency ID.
 * This is intended for trusted import receipts and other server-side manifests;
 * callers never need to accept a browser-provided route or filtered list.
 */
export function routeThunderstoreDependencyId(input: unknown): ThunderstoreDependencyRoute {
  return routeExactIdentity(parseThunderstoreDependency(input))
}

/**
 * Separates ordinary plugin edges from platform requirements without losing
 * their exact required versions. The returned plugin list is safe to pass to
 * the ordinary mod graph only after every platform/unsupported requirement has
 * been checked by its server-owned component policy.
 */
export function partitionThunderstorePluginDependencies(
  input: unknown
): PartitionedThunderstorePluginDependencies {
  const identities = thunderstoreDependencyListSchema.parse(input)
    .map((dependencyId) => parseThunderstoreDependency(dependencyId))
    .sort((left, right) => compareText(left.dependencyId, right.dependencyId))
  const dependencyKeys = new Set<string>()
  const sourceVersions = new Map<string, string>()
  const pluginDependencyIds: string[] = []
  const platformRequirements: ThunderstoreManagedPlatformRequirement[] = []
  const unsupportedRequirements: ThunderstoreUnsupportedPlatformRequirement[] = []

  for (const identity of identities) {
    const dependencyKey = identity.dependencyId.toLowerCase()
    if (dependencyKeys.has(dependencyKey)) {
      throw new UpdatePipelineError('THUNDERSTORE_DEPENDENCY_DUPLICATE')
    }
    dependencyKeys.add(dependencyKey)

    const sourceKey = identity.sourceId.toLowerCase()
    const existingVersion = sourceVersions.get(sourceKey)
    if (existingVersion !== undefined && existingVersion !== identity.version) {
      throw new UpdatePipelineError('THUNDERSTORE_DEPENDENCY_VERSION_CONFLICT')
    }
    sourceVersions.set(sourceKey, identity.version)

    const route = routeExactIdentity(identity)
    if (route.disposition === 'plugin') pluginDependencyIds.push(route.dependencyId)
    else if (route.disposition === 'unsupported-platform-package') unsupportedRequirements.push(route)
    else platformRequirements.push(route)
  }

  return Object.freeze({
    pluginDependencyIds: Object.freeze(pluginDependencyIds),
    platformRequirements: Object.freeze(platformRequirements),
    unsupportedRequirements: Object.freeze(unsupportedRequirements)
  })
}

function routeExactIdentity(identity: ThunderstoreDependency): ThunderstoreDependencyRoute {

  const sourceKey = identity.sourceId.toLowerCase()
  const nameKey = identity.name.toLowerCase()
  const common = {
    dependencyId: identity.dependencyId,
    sourceId: identity.sourceId,
    requiredVersion: identity.version
  }

  if (managedNebulaSources.has(sourceKey)) {
    return Object.freeze({
      ...common,
      disposition: 'managed-component' as const,
      deploymentOwner: 'nebula' as const,
      resolution: 'nebula-component-pipeline' as const,
      directPluginAcquisitionAllowed: false as const
    })
  }
  if (managedBepInExPrerequisiteSources.has(sourceKey)) {
    return Object.freeze({
      ...common,
      disposition: 'external-prerequisite' as const,
      deploymentOwner: 'bepinex' as const,
      resolution: 'bepinex-component-inventory' as const,
      directPluginAcquisitionAllowed: false as const
    })
  }

  // A package using a reserved platform identity under an unexpected owner is
  // never downgraded to a normal plugin. It needs an explicit reviewed policy.
  if (reservedNebulaPackageNames.has(nameKey) || reservedBepInExPackageNames.has(nameKey)) {
    return Object.freeze({
      ...common,
      disposition: 'unsupported-platform-package' as const,
      deploymentOwner: null,
      resolution: 'manual-policy-required' as const,
      directPluginAcquisitionAllowed: false as const
    })
  }

  return Object.freeze({
    ...common,
    disposition: 'plugin' as const,
    deploymentOwner: 'mods' as const,
    resolution: 'mod-import-pipeline' as const,
    directPluginAcquisitionAllowed: true as const
  })
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function thunderstoreNonPluginAcquisitionErrorCode(
  route: Exclude<ThunderstoreDependencyRoute, { disposition: 'plugin' }>
): string {
  if (route.disposition === 'managed-component') {
    return 'ACQUISITION_MANAGED_COMPONENT_ROUTE_REQUIRED'
  }
  if (route.disposition === 'external-prerequisite') {
    return 'ACQUISITION_EXTERNAL_PREREQUISITE_VERIFICATION_REQUIRED'
  }
  return 'ACQUISITION_PLATFORM_PACKAGE_POLICY_REQUIRED'
}

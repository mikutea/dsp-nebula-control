import { z } from 'zod'
import { generateModManifests, type GeneratedModManifests } from '../mods/manifest.js'
import { thunderstoreDependencyIdSchema } from '../mods/dependency.js'
import type { ClientModRequirement } from '../mods/resolver.js'
import {
  computeStagedModPayloadDigest,
  stagedModPackageManifestSchema
} from '../mods/deployment.js'
import {
  compatibilityMatrixInputSchema,
  evaluateCompatibility,
  normalizeInventory,
  runtimeInventoryInputSchema,
  type CompatibilityDecision
} from '../updates/compatibility.js'
import { normalizeVersion, sourceIdSchema } from '../updates/version.js'
import {
  discoveredModReleaseSchema,
  discoveredNebulaReleaseSchema,
  type DiscoveredModRelease,
  type DiscoveredNebulaRelease
} from './discovery.js'
import { UpdatePipelineError } from './errors.js'
import { stagedArtifactManifestSchema, type StagedArtifactManifest } from './staging.js'

export interface CandidateCompatibilityResult {
  candidateInventory: ReturnType<typeof normalizeInventory>
  decision: CompatibilityDecision
}

export interface UpdatePreparationPlan {
  format: 'dyson-control-update-preparation-plan'
  schemaVersion: 1
  planId: string
  dryRun: true
  canStageAll: boolean
  activationEnabled: false
  targets: Array<{
    targetId: string
    kind: 'dsp' | 'nebula' | 'bepinex' | 'plugin'
    artifactId: string | null
    staging: 'offline-fixed-inbox' | 'blocked'
    blockers: Array<'manual/steam-client-required' | 'artifact-reference-required'>
  }>
  rollback: {
    automatic: false
    boundary: 'staging-only'
    steps: [
      'leave-current-installation-unchanged',
      'discard-temporary-directory-on-failure',
      'remove-only-unreferenced-staged-release-after-explicit-approval'
    ]
  }
}

const candidateCompatibilityInputSchema = z.strictObject({
  runtime: runtimeInventoryInputSchema,
  matrix: compatibilityMatrixInputSchema,
  nebula: discoveredNebulaReleaseSchema.optional(),
  mods: z.array(discoveredModReleaseSchema).max(256)
})

export function evaluateDiscoveredCompatibility(input: unknown): CandidateCompatibilityResult {
  const parsed = candidateCompatibilityInputSchema.parse(input)
  const current = normalizeInventory(parsed.runtime)
  assertUnique(parsed.mods.map((release) => release.sourceId.toLowerCase()), 'CANDIDATE_MOD_DUPLICATE')
  const plugins = new Map(current.plugins.map((plugin) => [plugin.sourceId.toLowerCase(), plugin]))
  for (const release of parsed.mods) {
    if (!release.eligible) throw new UpdatePipelineError('CANDIDATE_MOD_INELIGIBLE')
    plugins.set(release.sourceId.toLowerCase(), { sourceId: release.sourceId, version: release.version })
  }
  const candidateInventory = normalizeInventory({
    dsp: current.dsp,
    nebula: parsed.nebula?.version ?? current.nebula,
    bepInEx: current.bepInEx,
    plugins: [...plugins.values()]
  })
  return {
    candidateInventory,
    decision: evaluateCompatibility(candidateInventory, parsed.matrix)
  }
}

const modPolicySchema = z.strictObject({
  sourceId: sourceIdSchema,
  serverRequired: z.boolean(),
  clientRequirement: z.enum(['required', 'optional', 'not-required'])
}).superRefine((value, context) => {
  if (!value.serverRequired && value.clientRequirement === 'not-required') {
    context.addIssue({ code: 'custom', message: 'a policy must apply to the server or client' })
  }
})

const verifiedManifestInputSchema = z.strictObject({
  roots: z.array(thunderstoreDependencyIdSchema).min(1).max(128),
  releases: z.array(discoveredModReleaseSchema).min(1).max(512),
  stagedArtifacts: z.array(stagedArtifactManifestSchema).min(1).max(512),
  stagedPackages: z.array(stagedModPackageManifestSchema).min(1).max(512),
  policies: z.array(modPolicySchema).min(1).max(512)
})

export function buildVerifiedModManifests(input: unknown): GeneratedModManifests {
  const parsed = verifiedManifestInputSchema.parse(input)
  assertUnique(parsed.releases.map((release) => release.sourceId.toLowerCase()), 'VERIFIED_MOD_RELEASE_DUPLICATE')
  assertUnique(parsed.stagedArtifacts.map((artifact) => artifact.artifactId), 'VERIFIED_STAGE_DUPLICATE')
  assertUnique(parsed.stagedPackages.map((pkg) => pkg.dependencyId.toLowerCase()), 'VERIFIED_MOD_PACKAGE_DUPLICATE')
  assertUnique(parsed.policies.map((policy) => policy.sourceId.toLowerCase()), 'VERIFIED_MOD_POLICY_DUPLICATE')
  const stages = new Map(parsed.stagedArtifacts.map((artifact) => [artifact.artifactId, artifact]))
  const stagedPackages = new Map(parsed.stagedPackages.map((pkg) => [pkg.dependencyId.toLowerCase(), pkg]))
  const policies = new Map(parsed.policies.map((policy) => [policy.sourceId.toLowerCase(), policy]))
  const releaseArtifactIds = new Set(parsed.releases.map((release) => release.artifact.artifactId))
  const releaseSourceIds = new Set(parsed.releases.map((release) => release.sourceId.toLowerCase()))
  const releaseDependencyIds = new Set(parsed.releases.map((release) => release.dependencyId.toLowerCase()))
  if (parsed.stagedArtifacts.some((artifact) => !releaseArtifactIds.has(artifact.artifactId))) {
    throw new UpdatePipelineError('VERIFIED_STAGE_UNUSED')
  }
  if (parsed.policies.some((policy) => !releaseSourceIds.has(policy.sourceId.toLowerCase()))) {
    throw new UpdatePipelineError('VERIFIED_MOD_POLICY_UNUSED')
  }
  if (parsed.stagedPackages.some((pkg) => !releaseDependencyIds.has(pkg.dependencyId.toLowerCase()))) {
    throw new UpdatePipelineError('VERIFIED_MOD_PACKAGE_UNUSED')
  }
  const packages = parsed.releases.map((release) => {
    if (!release.eligible) throw new UpdatePipelineError('VERIFIED_MOD_RELEASE_INELIGIBLE')
    const stage = stages.get(release.artifact.artifactId)
    if (stage === undefined) throw new UpdatePipelineError('VERIFIED_MOD_STAGE_MISSING')
    assertReleaseMatchesStage(release, stage)
    const policy = policies.get(release.sourceId.toLowerCase())
    if (policy === undefined) throw new UpdatePipelineError('VERIFIED_MOD_POLICY_MISSING')
    const stagedPackage = stagedPackages.get(release.dependencyId.toLowerCase())
    if (stagedPackage === undefined) throw new UpdatePipelineError('VERIFIED_MOD_PACKAGE_MISSING')
    if (stagedPackage.dependencyId !== release.dependencyId ||
        stagedPackage.sourceId.toLowerCase() !== release.sourceId.toLowerCase() ||
        stagedPackage.version !== release.version ||
        !sameStringArray(stagedPackage.dependencies, release.dependencies)) {
      throw new UpdatePipelineError('VERIFIED_MOD_PACKAGE_IDENTITY_MISMATCH')
    }
    return {
      dependencyId: release.dependencyId,
      sha256: computeStagedModPayloadDigest(stagedPackage),
      dependencies: release.dependencies,
      serverRequired: policy.serverRequired,
      clientRequirement: policy.clientRequirement as ClientModRequirement
    }
  })
  return generateModManifests({ roots: parsed.roots, packages })
}

const preparationTargetSchema = z.strictObject({
  targetId: z.string().min(3).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/),
  kind: z.enum(['dsp', 'nebula', 'bepinex', 'plugin']),
  artifactId: z.string().min(16).max(96).regex(/^[a-z0-9][a-z0-9-]+$/).nullable()
})

const preparationInputSchema = z.strictObject({
  planId: z.string().min(8).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  targets: z.array(preparationTargetSchema).min(1).max(128)
})

export function createUpdatePreparationPlan(input: unknown): UpdatePreparationPlan {
  const parsed = preparationInputSchema.parse(input)
  assertUnique(parsed.targets.map((target) => target.targetId.toLowerCase()), 'PREPARATION_TARGET_DUPLICATE')
  const targets = parsed.targets.map((target): UpdatePreparationPlan['targets'][number] => {
    const blockers: UpdatePreparationPlan['targets'][number]['blockers'] = []
    if (target.kind === 'dsp') blockers.push('manual/steam-client-required')
    if (target.kind !== 'dsp' && target.artifactId === null) blockers.push('artifact-reference-required')
    return {
      targetId: target.targetId,
      kind: target.kind,
      artifactId: target.artifactId,
      staging: blockers.length === 0 ? 'offline-fixed-inbox' : 'blocked',
      blockers
    }
  }).sort(comparePreparationTargets)
  return {
    format: 'dyson-control-update-preparation-plan',
    schemaVersion: 1,
    planId: parsed.planId,
    dryRun: true,
    canStageAll: targets.every((target) => target.blockers.length === 0),
    activationEnabled: false,
    targets,
    rollback: {
      automatic: false,
      boundary: 'staging-only',
      steps: [
        'leave-current-installation-unchanged',
        'discard-temporary-directory-on-failure',
        'remove-only-unreferenced-staged-release-after-explicit-approval'
      ]
    }
  }
}

function assertReleaseMatchesStage(release: DiscoveredModRelease, stage: StagedArtifactManifest): void {
  if (stage.release.kind !== 'plugin' || stage.artifactId !== release.artifact.artifactId ||
      stage.release.sourceId.toLowerCase() !== release.sourceId.toLowerCase() ||
      stage.release.version !== normalizeVersion(release.version, 'plugin')) {
    throw new UpdatePipelineError('VERIFIED_MOD_STAGE_IDENTITY_MISMATCH')
  }
  if (release.artifact.sizeBytes !== null && release.artifact.sizeBytes !== stage.sizeBytes) {
    throw new UpdatePipelineError('VERIFIED_MOD_STAGE_SIZE_MISMATCH')
  }
  if (release.artifact.sha256 !== null && release.artifact.sha256.toLowerCase() !== stage.sha256) {
    throw new UpdatePipelineError('VERIFIED_MOD_STAGE_SHA256_MISMATCH')
  }
}

function comparePreparationTargets(
  left: UpdatePreparationPlan['targets'][number],
  right: UpdatePreparationPlan['targets'][number]
): number {
  const order = { dsp: 0, bepinex: 1, nebula: 2, plugin: 3 }
  return order[left.kind] - order[right.kind] || compareText(left.targetId.toLowerCase(), right.targetId.toLowerCase())
}

function assertUnique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) throw new UpdatePipelineError(code)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

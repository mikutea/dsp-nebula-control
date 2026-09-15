import { createHash } from 'node:crypto'
import { z } from 'zod'
import { thunderstoreDependencyIdSchema } from '../mods/dependency.js'
import type { ArtifactCandidateDescriptor } from './acquisition.js'

const pinSchema = z.strictObject({
  dependencyId: thunderstoreDependencyIdSchema,
  dependencies: z.array(thunderstoreDependencyIdSchema).max(64),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().positive().max(2 * 1024 * 1024 * 1024)
})

export const trustedModArtifactPolicySchema = z.strictObject({
  format: z.literal('dyson-control-trusted-mod-artifacts'),
  schemaVersion: z.literal(1),
  policyId: z.string().min(3).max(96).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  reviewedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  packages: z.array(pinSchema).max(128)
}).superRefine((policy, context) => {
  if (Date.parse(policy.expiresAt) <= Date.parse(policy.reviewedAt)) {
    context.addIssue({ code: 'custom', message: 'Policy expiry must follow review' })
  }
  const identities = policy.packages.map(pin => pin.dependencyId.toLowerCase())
  if (new Set(identities).size !== identities.length) {
    context.addIssue({ code: 'custom', message: 'Duplicate package identity' })
  }
  for (const pin of policy.packages) {
    const dependencies = pin.dependencies.map(id => id.toLowerCase())
    if (new Set(dependencies).size !== dependencies.length) {
      context.addIssue({ code: 'custom', message: 'Duplicate dependency identity' })
    }
  }
})

export type TrustedModArtifactPin = Readonly<z.infer<typeof pinSchema>>

/** Server-side reviewed input only. This policy never approves an entire author or community. */
export class TrustedModArtifactPolicy {
  readonly revision: string
  readonly #policy: z.infer<typeof trustedModArtifactPolicySchema>

  constructor(input: unknown) {
    this.#policy = trustedModArtifactPolicySchema.parse(input)
    this.#policy.packages.sort((a, b) => a.dependencyId < b.dependencyId ? -1 : a.dependencyId > b.dependencyId ? 1 : 0)
    for (const pin of this.#policy.packages) pin.dependencies.sort()
    this.revision = createHash('sha256').update(JSON.stringify(this.#policy)).digest('hex')
  }

  resolve(input: {
    dependencyId: string
    dependencies: readonly string[]
    community: string
    reviewStatus: string
    deprecated: boolean
    active: boolean
  }, now = Date.now()): TrustedModArtifactPin | null {
    if (!Number.isFinite(now) || now < Date.parse(this.#policy.reviewedAt) ||
        now >= Date.parse(this.#policy.expiresAt) || input.community !== 'dyson-sphere-program' ||
        input.deprecated || !input.active ||
        !['unreviewed', 'approved'].includes(input.reviewStatus)) return null
    const pin = this.#policy.packages.find(item => item.dependencyId === input.dependencyId)
    if (!pin || JSON.stringify([...input.dependencies].sort()) !== JSON.stringify(pin.dependencies)) return null
    return Object.freeze({ ...pin, dependencies: [...pin.dependencies] })
  }
}

/** Adapter for the acquisition gate. Reloading on every call makes removal fail closed. */
export function trustedModAcquisitionAuthority(
  loadPolicy: () => Promise<TrustedModArtifactPolicy | null>,
  now: () => number = Date.now
): (candidate: ArtifactCandidateDescriptor) => Promise<boolean> {
  return async candidate => {
    if (candidate.artifact.trustedPolicyRevision === undefined) return true
    if (candidate.provider !== 'thunderstore' || candidate.release.kind !== 'plugin' ||
        candidate.artifact.integrity !== 'locally-computed-required') return false
    const match = /^thunderstore:([A-Za-z0-9_]+)\/([A-Za-z0-9_]+)$/.exec(candidate.release.sourceId)
    if (!match || !candidate.release.dependencies) return false
    const policy = await loadPolicy()
    if (!policy || policy.revision !== candidate.artifact.trustedPolicyRevision) return false
    const pin = policy.resolve({
      dependencyId: `${match[1]}-${match[2]}-${candidate.release.version}`,
      dependencies: candidate.release.dependencies,
      community: 'dyson-sphere-program', reviewStatus: 'unreviewed', deprecated: false, active: true
    }, now())
    return pin !== null && pin.sha256 === candidate.artifact.sha256 && pin.sizeBytes === candidate.artifact.sizeBytes
  }
}

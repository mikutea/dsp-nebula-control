import { z } from 'zod'
import { normalizeVersion } from '../updates/version.js'

export interface ThunderstoreDependency {
  namespace: string
  name: string
  version: string
  sourceId: string
  dependencyId: string
}

export class ThunderstoreDependencyError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'ThunderstoreDependencyError'
    this.code = code
  }
}

const identifierPartPattern = /^[A-Za-z0-9_]{1,64}$/
const dependencyPattern = /^([A-Za-z0-9_]{1,64})-([A-Za-z0-9_]{1,64})-(\d{1,10}\.\d{1,10}\.\d{1,10})$/

export const thunderstoreDependencyIdSchema = z.string().min(7).max(160).regex(dependencyPattern)

export const thunderstoreIdentityInputSchema = z.strictObject({
  namespace: z.string().min(1).max(64).regex(identifierPartPattern),
  name: z.string().min(1).max(64).regex(identifierPartPattern),
  version: z.string().min(5).max(32).regex(/^\d{1,10}\.\d{1,10}\.\d{1,10}$/)
})

export function parseThunderstoreDependency(input: unknown): ThunderstoreDependency {
  const value = thunderstoreDependencyIdSchema.parse(input)
  const match = dependencyPattern.exec(value)
  if (match === null) throw new ThunderstoreDependencyError('THUNDERSTORE_DEPENDENCY_INVALID')
  return buildDependency({ namespace: match[1]!, name: match[2]!, version: match[3]! })
}

export function formatThunderstoreDependency(input: unknown): ThunderstoreDependency {
  return buildDependency(thunderstoreIdentityInputSchema.parse(input))
}

export function canonicalThunderstoreSourceId(sourceId: string): string {
  return sourceId.toLowerCase()
}

export function canonicalThunderstoreDependencyId(dependency: ThunderstoreDependency): string {
  return `${canonicalThunderstoreSourceId(dependency.sourceId)}@${dependency.version}`
}

function buildDependency(input: z.infer<typeof thunderstoreIdentityInputSchema>): ThunderstoreDependency {
  const version = normalizeVersion(input.version, 'plugin')
  if (version.split(/[+-]/, 1)[0]!.split('.').length !== 3) {
    throw new ThunderstoreDependencyError('THUNDERSTORE_VERSION_INVALID')
  }
  return Object.freeze({
    namespace: input.namespace,
    name: input.name,
    version,
    sourceId: `thunderstore:${input.namespace}/${input.name}`,
    dependencyId: `${input.namespace}-${input.name}-${version}`
  })
}

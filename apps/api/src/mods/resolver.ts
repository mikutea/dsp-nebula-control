import { z } from 'zod'
import { compareVersions, sha256Schema } from '../updates/version.js'
import {
  canonicalThunderstoreDependencyId,
  canonicalThunderstoreSourceId,
  parseThunderstoreDependency,
  thunderstoreDependencyIdSchema,
  type ThunderstoreDependency
} from './dependency.js'

export type ClientModRequirement = 'required' | 'optional' | 'not-required'

export interface ResolvedMod {
  dependencyId: string
  sourceId: string
  namespace: string
  name: string
  version: string
  sha256: string
  dependencies: string[]
  serverRequired: boolean
  clientRequirement: ClientModRequirement
  root: boolean
  loadOrder: number | null
}

export type ModResolutionIssue =
  | { type: 'missing'; dependencyId: string; requestedBy: string[] }
  | { type: 'conflict'; sourceId: string; versions: Array<{ version: string; requestedBy: string[] }> }
  | { type: 'cycle'; dependencyIds: string[] }

export interface ModResolutionResult {
  ok: boolean
  mods: ResolvedMod[]
  issues: ModResolutionIssue[]
}

export class ModResolutionInputError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'ModResolutionInputError'
    this.code = code
  }
}

const packageSchema = z.strictObject({
  dependencyId: thunderstoreDependencyIdSchema,
  sha256: sha256Schema,
  dependencies: z.array(thunderstoreDependencyIdSchema).max(64),
  serverRequired: z.boolean(),
  clientRequirement: z.enum(['required', 'optional', 'not-required'])
}).superRefine((value, context) => {
  if (!value.serverRequired && value.clientRequirement === 'not-required') {
    context.addIssue({ code: 'custom', message: 'a mod must be required by the server or relevant to a client' })
  }
})

export const modResolutionInputSchema = z.strictObject({
  roots: z.array(thunderstoreDependencyIdSchema).min(1).max(128),
  packages: z.array(packageSchema).min(1).max(512)
})

interface CatalogPackage {
  identity: ThunderstoreDependency
  sha256: string
  dependencies: ThunderstoreDependency[]
  serverRequired: boolean
  clientRequirement: ClientModRequirement
}

interface RequestRecord {
  identity: ThunderstoreDependency
  requestedBy: Set<string>
}

export function resolveModGraph(input: unknown): ModResolutionResult {
  const parsed = modResolutionInputSchema.parse(input)
  const catalog = buildCatalog(parsed.packages)
  const roots = parsed.roots.map(parseThunderstoreDependency)
  assertUnique(roots.map(canonicalThunderstoreDependencyId), 'MOD_ROOT_DUPLICATE')
  const rootKeys = new Set(roots.map(canonicalThunderstoreDependencyId))

  const requests = new Map<string, RequestRecord>()
  const selected = new Map<string, CatalogPackage>()
  const missing = new Map<string, RequestRecord>()
  const queue = roots.map((identity) => ({ identity, requestedBy: 'root' }))
    .sort((left, right) => compareDependency(left.identity, right.identity))

  for (let index = 0; index < queue.length; index++) {
    const request = queue[index]!
    const key = canonicalThunderstoreDependencyId(request.identity)
    const existingRequest = requests.get(key)
    if (existingRequest === undefined) {
      requests.set(key, { identity: request.identity, requestedBy: new Set([request.requestedBy]) })
    } else {
      existingRequest.requestedBy.add(request.requestedBy)
    }
    if (selected.has(key) || missing.has(key)) {
      missing.get(key)?.requestedBy.add(request.requestedBy)
      continue
    }

    const catalogPackage = catalog.get(key)
    if (catalogPackage === undefined) {
      missing.set(key, { identity: request.identity, requestedBy: new Set([request.requestedBy]) })
      continue
    }
    selected.set(key, catalogPackage)
    for (const dependency of [...catalogPackage.dependencies].sort(compareDependency)) {
      queue.push({ identity: dependency, requestedBy: catalogPackage.identity.dependencyId })
    }
  }

  const missingIssues = [...missing.values()].map((record): ModResolutionIssue => ({
    type: 'missing',
    dependencyId: record.identity.dependencyId,
    requestedBy: sortText([...record.requestedBy])
  })).sort(compareIssues)
  const conflictIssues = findConflicts(requests)
  const cycleIssues = findCycles(selected)
  const issues = [...missingIssues, ...conflictIssues, ...cycleIssues].sort(compareIssues)
  const loadOrder = issues.length === 0 ? topologicalOrder(selected) : []
  const orderByKey = new Map(loadOrder.map((key, index) => [key, index]))
  const mods = [...selected.entries()].map(([key, catalogPackage]): ResolvedMod => ({
    dependencyId: catalogPackage.identity.dependencyId,
    sourceId: catalogPackage.identity.sourceId,
    namespace: catalogPackage.identity.namespace,
    name: catalogPackage.identity.name,
    version: catalogPackage.identity.version,
    sha256: catalogPackage.sha256,
    dependencies: catalogPackage.dependencies.map((dependency) => dependency.dependencyId).sort(compareText),
    serverRequired: catalogPackage.serverRequired,
    clientRequirement: catalogPackage.clientRequirement,
    root: rootKeys.has(key),
    loadOrder: orderByKey.get(key) ?? null
  })).sort((left, right) => {
    if (left.loadOrder !== null && right.loadOrder !== null) return left.loadOrder - right.loadOrder
    return compareText(canonicalThunderstoreSourceId(left.sourceId), canonicalThunderstoreSourceId(right.sourceId)) ||
      compareVersions(left.version, right.version, 'plugin')
  })

  return { ok: issues.length === 0, mods, issues }
}

function buildCatalog(packages: Array<z.infer<typeof packageSchema>>): Map<string, CatalogPackage> {
  const catalog = new Map<string, CatalogPackage>()
  for (const candidate of packages) {
    const identity = parseThunderstoreDependency(candidate.dependencyId)
    const dependencies = candidate.dependencies.map(parseThunderstoreDependency).sort(compareDependency)
    assertUnique(dependencies.map(canonicalThunderstoreDependencyId), 'MOD_DEPENDENCY_DUPLICATE')
    const key = canonicalThunderstoreDependencyId(identity)
    if (catalog.has(key)) throw new ModResolutionInputError('MOD_PACKAGE_DUPLICATE')
    catalog.set(key, {
      identity,
      sha256: candidate.sha256.toLowerCase(),
      dependencies,
      serverRequired: candidate.serverRequired,
      clientRequirement: candidate.clientRequirement
    })
  }
  return catalog
}

function findConflicts(requests: ReadonlyMap<string, RequestRecord>): ModResolutionIssue[] {
  const bySource = new Map<string, { sourceId: string; versions: Map<string, Set<string>> }>()
  for (const record of requests.values()) {
    const sourceKey = canonicalThunderstoreSourceId(record.identity.sourceId)
    let source = bySource.get(sourceKey)
    if (source === undefined) {
      source = { sourceId: record.identity.sourceId, versions: new Map() }
      bySource.set(sourceKey, source)
    }
    const requesters = source.versions.get(record.identity.version) ?? new Set<string>()
    for (const requester of record.requestedBy) requesters.add(requester)
    source.versions.set(record.identity.version, requesters)
  }
  const issues: ModResolutionIssue[] = []
  for (const source of bySource.values()) {
    if (source.versions.size < 2) continue
    issues.push({
      type: 'conflict',
      sourceId: source.sourceId,
      versions: [...source.versions.entries()].sort((left, right) => compareVersions(left[0], right[0], 'plugin'))
        .map(([version, requestedBy]) => ({ version, requestedBy: sortText([...requestedBy]) }))
    })
  }
  return issues.sort(compareIssues)
}

function findCycles(selected: ReadonlyMap<string, CatalogPackage>): ModResolutionIssue[] {
  const state = new Map<string, 'visiting' | 'visited'>()
  const stack: string[] = []
  const cycleKeys = new Set<string>()
  const cycles: string[][] = []

  const visit = (key: string): void => {
    state.set(key, 'visiting')
    stack.push(key)
    const candidate = selected.get(key)!
    const dependencies = candidate.dependencies.map(canonicalThunderstoreDependencyId)
      .filter((dependencyKey) => selected.has(dependencyKey)).sort(compareText)
    for (const dependencyKey of dependencies) {
      const dependencyState = state.get(dependencyKey)
      if (dependencyState === undefined) {
        visit(dependencyKey)
      } else if (dependencyState === 'visiting') {
        const start = stack.indexOf(dependencyKey)
        const normalized = normalizeCycle(stack.slice(start))
        const signature = normalized.join('>')
        if (!cycleKeys.has(signature)) {
          cycleKeys.add(signature)
          cycles.push(normalized)
        }
      }
    }
    stack.pop()
    state.set(key, 'visited')
  }

  for (const key of sortText([...selected.keys()])) {
    if (state.get(key) === undefined) visit(key)
  }
  return cycles.map((cycle): ModResolutionIssue => ({
    type: 'cycle',
    dependencyIds: [...cycle, cycle[0]!].map((key) => selected.get(key)!.identity.dependencyId)
  })).sort(compareIssues)
}

function normalizeCycle(cycle: string[]): string[] {
  if (cycle.length < 2) return cycle
  const rotations = cycle.map((_, index) => [...cycle.slice(index), ...cycle.slice(0, index)])
  rotations.sort((left, right) => compareText(left.join('>'), right.join('>')))
  return rotations[0]!
}

function topologicalOrder(selected: ReadonlyMap<string, CatalogPackage>): string[] {
  const dependencyCount = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const [key, candidate] of selected) {
    const dependencies = candidate.dependencies.map(canonicalThunderstoreDependencyId)
      .filter((dependencyKey) => selected.has(dependencyKey))
    dependencyCount.set(key, dependencies.length)
    for (const dependencyKey of dependencies) {
      const list = dependents.get(dependencyKey) ?? []
      list.push(key)
      dependents.set(dependencyKey, list)
    }
  }
  const ready = sortText([...dependencyCount.entries()].filter(([, count]) => count === 0).map(([key]) => key))
  const ordered: string[] = []
  while (ready.length > 0) {
    const key = ready.shift()!
    ordered.push(key)
    for (const dependent of sortText(dependents.get(key) ?? [])) {
      const remaining = dependencyCount.get(dependent)! - 1
      dependencyCount.set(dependent, remaining)
      if (remaining === 0) insertSorted(ready, dependent)
    }
  }
  if (ordered.length !== selected.size) throw new ModResolutionInputError('MOD_TOPOLOGY_INCONSISTENT')
  return ordered
}

function insertSorted(values: string[], value: string): void {
  let index = 0
  while (index < values.length && values[index]! < value) index += 1
  values.splice(index, 0, value)
}

function compareDependency(left: ThunderstoreDependency, right: ThunderstoreDependency): number {
  return compareText(canonicalThunderstoreDependencyId(left), canonicalThunderstoreDependencyId(right))
}

function issueKey(issue: ModResolutionIssue): string {
  if (issue.type === 'missing') return `0:${issue.dependencyId.toLowerCase()}`
  if (issue.type === 'conflict') return `1:${issue.sourceId.toLowerCase()}`
  return `2:${issue.dependencyIds.map((value) => value.toLowerCase()).join('>')}`
}

function compareIssues(left: ModResolutionIssue, right: ModResolutionIssue): number {
  return compareText(issueKey(left), issueKey(right))
}

function assertUnique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) throw new ModResolutionInputError(code)
}

function sortText(values: string[]): string[] {
  return values.sort(compareText)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

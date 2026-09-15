import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { TrustedModArtifactPolicy } from './trusted-mod-artifacts.js'
import {
  formatThunderstoreDependency,
  parseThunderstoreDependency,
  thunderstoreDependencyIdSchema
} from '../mods/dependency.js'
import { compareVersions, normalizeVersion, sha256Schema, sourceIdSchema } from '../updates/version.js'
import { UpdatePipelineError } from './errors.js'
import { BoundedJsonClient, assertTrustedHttpsUrl, type FetchLike } from './http.js'
import {
  routeThunderstoreDependency,
  type ThunderstoreDependencyRoute
} from './thunderstore-dependency-routing.js'

export type ArtifactIntegrity = 'provider-sha256' | 'locally-computed-required'

export interface DiscoveredArtifact {
  artifactId: string
  downloadUrl: string
  fileName: string
  sizeBytes: number | null
  sha256: string | null
  integrity: ArtifactIntegrity
  trustedPolicyRevision?: string
}

export interface DiscoveredModRelease {
  provider: 'thunderstore'
  sourceId: string
  dependencyId: string
  namespace: string
  name: string
  version: string
  dependencies: string[]
  publishedAt: string
  deprecated: boolean
  eligible: boolean
  blockers: Array<'package-deprecated' | 'version-inactive' | 'community-not-approved' | 'artifact-integrity-pending'>
  artifact: DiscoveredArtifact
}

export interface DiscoveredModDependencyClosure {
  roots: string[]
  order: 'dependencies-first'
  items: DiscoveredModRelease[]
  routes: ThunderstoreDependencyRoute[]
  nodeCount: number
  maximumDepth: number
  canAcquireAll: boolean
  blocked: Array<{
    dependencyId: string
    blockers: DiscoveredModRelease['blockers']
  }>
}

export interface DiscoveredNebulaRelease {
  provider: 'github'
  sourceId: 'github:NebulaModTeam/nebula'
  releaseId: number
  version: string
  publishedAt: string
  prerelease: boolean
  artifact: DiscoveredArtifact
}

export interface PagedDiscoveryResult<T> {
  items: T[]
  pagesFetched: number
  truncated: boolean
}

const safeIdentifierSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_]+$/)
const safeArtifactIdSchema = z.string().min(16).max(96).regex(/^[a-z0-9][a-z0-9-]+$/)
const safeFileNameSchema = z.string().min(5).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/i)
const isoDateSchema = z.string().datetime({ offset: true })
const positiveSizeSchema = z.number().int().positive().max(2 * 1_024 * 1_024 * 1_024)

export const discoveredArtifactSchema: z.ZodType<DiscoveredArtifact> = z.strictObject({
  artifactId: safeArtifactIdSchema,
  downloadUrl: z.url().max(2_048),
  fileName: safeFileNameSchema,
  sizeBytes: positiveSizeSchema.nullable(),
  sha256: sha256Schema.nullable(),
  integrity: z.enum(['provider-sha256', 'locally-computed-required']),
  trustedPolicyRevision: sha256Schema.optional()
}).superRefine((value, context) => {
  if (value.trustedPolicyRevision !== undefined && (value.integrity !== 'locally-computed-required' ||
      value.sha256 === null || value.sizeBytes === null)) {
    context.addIssue({ code: 'custom', message: 'Reviewed artifact requires a local digest and size' })
  }
  if (value.integrity === 'provider-sha256' && (value.sha256 === null || value.sizeBytes === null)) {
    context.addIssue({ code: 'custom', message: 'provider integrity requires a digest and size' })
  }
})

export const discoveredModReleaseSchema: z.ZodType<DiscoveredModRelease> = z.strictObject({
  provider: z.literal('thunderstore'),
  sourceId: sourceIdSchema,
  dependencyId: thunderstoreDependencyIdSchema,
  namespace: safeIdentifierSchema,
  name: safeIdentifierSchema,
  version: z.string().min(5).max(32),
  dependencies: z.array(thunderstoreDependencyIdSchema).max(64),
  publishedAt: isoDateSchema,
  deprecated: z.boolean(),
  eligible: z.boolean(),
  blockers: z.array(z.enum([
    'package-deprecated', 'version-inactive', 'community-not-approved', 'artifact-integrity-pending'
  ])).max(4),
  artifact: discoveredArtifactSchema
}).superRefine((value, context) => {
  const identity = parseThunderstoreDependency(value.dependencyId)
  if (identity.sourceId !== value.sourceId || identity.namespace !== value.namespace ||
      identity.name !== value.name || identity.version !== value.version) {
    context.addIssue({ code: 'custom', message: 'Thunderstore release identity is inconsistent' })
  }
  const dependencyKeys = value.dependencies.map((dependency) => dependency.toLowerCase())
  if (new Set(dependencyKeys).size !== dependencyKeys.length ||
      value.dependencies.some((dependency, index) => index > 0 && dependency <= value.dependencies[index - 1]!)) {
    context.addIssue({ code: 'custom', message: 'Thunderstore dependencies must be unique and sorted' })
  }
  if (value.artifact.fileName !== `${value.namespace}-${value.name}-${value.version}.zip`) {
    context.addIssue({ code: 'custom', message: 'Thunderstore artifact filename is inconsistent' })
  }
  try {
    validateThunderstoreDownloadUrl(value.artifact.downloadUrl, value.namespace, value.name, value.version)
  } catch {
    context.addIssue({ code: 'custom', message: 'Thunderstore artifact URL is invalid' })
  }
})

export const discoveredNebulaReleaseSchema: z.ZodType<DiscoveredNebulaRelease> = z.strictObject({
  provider: z.literal('github'),
  sourceId: z.literal('github:NebulaModTeam/nebula'),
  releaseId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  version: z.string().min(1).max(64),
  publishedAt: isoDateSchema,
  prerelease: z.boolean(),
  artifact: discoveredArtifactSchema
}).superRefine((value, context) => {
  try {
    if (normalizeVersion(value.version, 'nebula') !== value.version) {
      context.addIssue({ code: 'custom', message: 'Nebula release version is not normalized' })
    }
    validateGithubDownloadUrl(value.artifact.downloadUrl)
  } catch {
    context.addIssue({ code: 'custom', message: 'Nebula release artifact URL is invalid' })
  }
})

const thunderstoreRequestSchema = z.strictObject({
  namespace: safeIdentifierSchema,
  name: safeIdentifierSchema,
  community: z.literal('dyson-sphere-program').default('dyson-sphere-program')
})

const thunderstoreExactRequestSchema = z.strictObject({
  dependencyId: thunderstoreDependencyIdSchema,
  community: z.literal('dyson-sphere-program').default('dyson-sphere-program')
})

const thunderstoreClosureRequestSchema = z.strictObject({
  roots: z.array(thunderstoreDependencyIdSchema).min(1).max(32),
  community: z.literal('dyson-sphere-program').default('dyson-sphere-program')
})

const thunderstoreVersionSchema = z.strictObject({
  namespace: safeIdentifierSchema,
  name: safeIdentifierSchema,
  version_number: z.string().min(5).max(32),
  full_name: z.string().min(7).max(170),
  dependencies: z.array(thunderstoreDependencyIdSchema).max(64),
  download_url: z.url().max(2_048),
  date_created: isoDateSchema,
  is_active: z.boolean()
})

const thunderstorePackageSchema = z.strictObject({
  namespace: safeIdentifierSchema,
  name: safeIdentifierSchema,
  full_name: z.string().min(3).max(140),
  is_deprecated: z.boolean(),
  latest: thunderstoreVersionSchema,
  community_listings: z.array(z.strictObject({
    community: z.string().min(1).max(96),
    review_status: z.string().min(1).max(32)
  })).max(128)
})

export interface DiscoveryClientOptions {
  fetch: FetchLike
  timeoutMs?: number
  maxResponseBytes?: number
}

export interface ThunderstoreDiscoveryClientOptions extends DiscoveryClientOptions {
  trustedModPolicy?: () => Promise<TrustedModArtifactPolicy | null>
  now?: () => number
  maxDependencyNodes?: number
  maxDependencyDepth?: number
}

const thunderstoreClientConfigSchema = z.strictObject({
  maxDependencyNodes: z.number().int().min(1).max(256),
  maxDependencyDepth: z.number().int().min(0).max(32)
})

export class ThunderstoreReleaseClient {
  readonly #http: BoundedJsonClient
  readonly #maxDependencyNodes: number
  readonly #maxDependencyDepth: number
  readonly #trustedModPolicy: ThunderstoreDiscoveryClientOptions['trustedModPolicy']
  readonly #now: () => number

  constructor(options: ThunderstoreDiscoveryClientOptions) {
    const config = thunderstoreClientConfigSchema.parse({
      maxDependencyNodes: options.maxDependencyNodes ?? 128,
      maxDependencyDepth: options.maxDependencyDepth ?? 16
    })
    this.#http = new BoundedJsonClient({
      ...options,
      allowedHosts: ['thunderstore.io'],
      maxResponseBytes: options.maxResponseBytes ?? 256 * 1_024
    })
    this.#maxDependencyNodes = config.maxDependencyNodes
    this.#maxDependencyDepth = config.maxDependencyDepth
    this.#trustedModPolicy = options.trustedModPolicy
    this.#now = options.now ?? Date.now
  }

  async discoverLatest(input: unknown, signal?: AbortSignal): Promise<DiscoveredModRelease> {
    const request = thunderstoreRequestSchema.parse(input)
    const parsed = await this.#getPackage(request.namespace, request.name, signal)
    return createThunderstoreRelease(parsed, parsed.latest, request.community, await this.#trustedModPolicy?.(), this.#now())
  }

  async discoverExact(input: unknown, signal?: AbortSignal): Promise<DiscoveredModRelease> {
    const request = thunderstoreExactRequestSchema.parse(input)
    const identity = parseThunderstoreDependency(request.dependencyId)
    return await this.#discoverExactIdentity(identity, request.community, signal)
  }

  async discoverDependencyClosure(
    input: unknown,
    signal?: AbortSignal
  ): Promise<DiscoveredModDependencyClosure> {
    const request = thunderstoreClosureRequestSchema.parse(input)
    const roots = request.roots.map((dependencyId) => parseThunderstoreDependency(dependencyId).dependencyId)
      .sort(compareText)
    if (new Set(roots.map((root) => root.toLowerCase())).size !== roots.length) {
      throw new UpdatePipelineError('THUNDERSTORE_DEPENDENCY_ROOT_DUPLICATE')
    }

    const queue = roots.map((dependencyId) => ({ dependencyId, depth: 0 }))
    const queued = new Set(queue.map((entry) => entry.dependencyId.toLowerCase()))
    const releases = new Map<string, DiscoveredModRelease>()
    const dependencies = new Map<string, string[]>()
    const sourceVersions = new Map<string, string>()
    let maximumDepth = 0

    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const pending = queue[cursor]!
      assertThunderstoreSourceVersion(pending.dependencyId, sourceVersions)
      if (pending.depth > this.#maxDependencyDepth) {
        throw new UpdatePipelineError('THUNDERSTORE_DEPENDENCY_DEPTH_LIMIT')
      }
      if (releases.size >= this.#maxDependencyNodes) {
        throw new UpdatePipelineError('THUNDERSTORE_DEPENDENCY_NODE_LIMIT')
      }
      const identity = parseThunderstoreDependency(pending.dependencyId)
      const release = await this.#discoverExactIdentity(identity, request.community, signal)
      const key = release.dependencyId.toLowerCase()
      if (key !== pending.dependencyId.toLowerCase()) {
        throw new UpdatePipelineError('THUNDERSTORE_IDENTITY_MISMATCH')
      }
      releases.set(key, release)
      dependencies.set(key, release.dependencies)
      maximumDepth = Math.max(maximumDepth, pending.depth)
      for (const dependencyId of release.dependencies) {
        assertThunderstoreSourceVersion(dependencyId, sourceVersions)
        const dependencyKey = dependencyId.toLowerCase()
        if (queued.has(dependencyKey)) continue
        queued.add(dependencyKey)
        queue.push({ dependencyId, depth: pending.depth + 1 })
      }
    }

    const orderedDependencyIds = dependencyFirstOrder(roots, dependencies)
    const items = orderedDependencyIds.map((dependencyId) => {
      const release = releases.get(dependencyId.toLowerCase())
      if (release === undefined) throw new UpdatePipelineError('THUNDERSTORE_DEPENDENCY_GRAPH_INCOMPLETE')
      return release
    })
    const blocked = items.filter((release) => !release.eligible).map((release) => ({
      dependencyId: release.dependencyId,
      blockers: [...release.blockers]
    }))
    const routes = items.map((release) => routeThunderstoreDependency(release))
    return {
      roots,
      order: 'dependencies-first',
      items,
      routes,
      nodeCount: items.length,
      maximumDepth,
      canAcquireAll: blocked.length === 0 && routes.every((route) => route.directPluginAcquisitionAllowed),
      blocked
    }
  }

  async #discoverExactIdentity(
    identity: ReturnType<typeof parseThunderstoreDependency>,
    community: 'dyson-sphere-program',
    signal?: AbortSignal
  ): Promise<DiscoveredModRelease> {
    const [pkg, version] = await Promise.all([
      this.#getPackage(identity.namespace, identity.name, signal),
      this.#getVersion(identity.namespace, identity.name, identity.version, signal)
    ])
    return createThunderstoreRelease(pkg, version, community, await this.#trustedModPolicy?.(), this.#now())
  }

  async #getPackage(namespace: string, name: string, signal?: AbortSignal) {
    const url = new URL(
      `/api/experimental/package/${namespace}/${name}/`,
      'https://thunderstore.io'
    )
    const raw = await this.#http.get(url, { signal })
    const parsed = thunderstorePackageSchema.parse(projectThunderstorePackage(raw))
    if (parsed.namespace !== namespace || parsed.name !== name ||
        parsed.latest.namespace !== namespace || parsed.latest.name !== name ||
        parsed.full_name !== `${namespace}-${name}` ||
        parsed.latest.full_name !== `${namespace}-${name}-${parsed.latest.version_number}`) {
      throw new UpdatePipelineError('THUNDERSTORE_IDENTITY_MISMATCH')
    }
    return parsed
  }

  async #getVersion(namespace: string, name: string, version: string, signal?: AbortSignal) {
    const url = new URL(
      `/api/experimental/package/${namespace}/${name}/${version}/`,
      'https://thunderstore.io'
    )
    const raw = await this.#http.get(url, { signal })
    const parsed = thunderstoreVersionSchema.parse(projectThunderstoreVersion(raw))
    if (parsed.namespace !== namespace || parsed.name !== name || parsed.version_number !== version ||
        parsed.full_name !== `${namespace}-${name}-${version}`) {
      throw new UpdatePipelineError('THUNDERSTORE_IDENTITY_MISMATCH')
    }
    return parsed
  }
}

function createThunderstoreRelease(
  pkg: z.infer<typeof thunderstorePackageSchema>,
  version: z.infer<typeof thunderstoreVersionSchema>,
  community: 'dyson-sphere-program',
  policy?: TrustedModArtifactPolicy | null,
  now = Date.now()
): DiscoveredModRelease {
  if (version.namespace !== pkg.namespace || version.name !== pkg.name) {
    throw new UpdatePipelineError('THUNDERSTORE_IDENTITY_MISMATCH')
  }
  const identity = formatThunderstoreDependency({
    namespace: version.namespace,
    name: version.name,
    version: version.version_number
  })
  if (version.full_name !== identity.dependencyId || pkg.full_name !== `${identity.namespace}-${identity.name}`) {
    throw new UpdatePipelineError('THUNDERSTORE_IDENTITY_MISMATCH')
  }
  const dependencies = version.dependencies.map(parseThunderstoreDependency)
    .map((dependency) => dependency.dependencyId)
    .sort(compareText)
  if (new Set(dependencies.map((dependency) => dependency.toLowerCase())).size !== dependencies.length) {
    throw new UpdatePipelineError('THUNDERSTORE_DEPENDENCY_DUPLICATE')
  }
  const downloadUrl = validateThunderstoreDownloadUrl(
    version.download_url,
    identity.namespace,
    identity.name,
    identity.version
  )
  const communityApproved = pkg.community_listings.some((listing) =>
    listing.community === community && listing.review_status === 'approved'
  )
  const listings = pkg.community_listings.filter(listing => listing.community === community)
  const pin = listings.length === 1 ? policy?.resolve({
    dependencyId: identity.dependencyId, dependencies, community,
    reviewStatus: listings[0]!.review_status, deprecated: pkg.is_deprecated, active: version.is_active
  }, now) : null
  const blockers: DiscoveredModRelease['blockers'] = []
  if (pkg.is_deprecated) blockers.push('package-deprecated')
  if (!version.is_active) blockers.push('version-inactive')
  if (!communityApproved && !pin) blockers.push('community-not-approved')
  blockers.push('artifact-integrity-pending')
  const artifact: DiscoveredArtifact = {
    artifactId: artifactIdFor(identity.sourceId, identity.version, 'package.zip'),
    downloadUrl,
    fileName: `${identity.namespace}-${identity.name}-${identity.version}.zip`,
    sizeBytes: pin?.sizeBytes ?? null,
    sha256: pin?.sha256 ?? null,
    integrity: 'locally-computed-required',
    ...(pin ? { trustedPolicyRevision: policy!.revision } : {})
  }
  return discoveredModReleaseSchema.parse({
    provider: 'thunderstore',
    sourceId: identity.sourceId,
    dependencyId: identity.dependencyId,
    namespace: identity.namespace,
    name: identity.name,
    version: identity.version,
    dependencies,
    publishedAt: version.date_created,
    deprecated: pkg.is_deprecated,
    eligible: blockers.every((blocker) => blocker === 'artifact-integrity-pending'),
    blockers,
    artifact
  })
}

function assertThunderstoreSourceVersion(dependencyId: string, versions: Map<string, string>): void {
  const identity = parseThunderstoreDependency(dependencyId)
  const key = identity.sourceId.toLowerCase()
  const existing = versions.get(key)
  if (existing !== undefined && existing !== identity.version) {
    throw new UpdatePipelineError('THUNDERSTORE_DEPENDENCY_VERSION_CONFLICT')
  }
  versions.set(key, identity.version)
}

function dependencyFirstOrder(roots: readonly string[], graph: ReadonlyMap<string, readonly string[]>): string[] {
  const states = new Map<string, 'visiting' | 'visited'>()
  const ordered: string[] = []
  const visit = (dependencyId: string): void => {
    const key = dependencyId.toLowerCase()
    const state = states.get(key)
    if (state === 'visiting') throw new UpdatePipelineError('THUNDERSTORE_DEPENDENCY_CYCLE')
    if (state === 'visited') return
    const children = graph.get(key)
    if (children === undefined) throw new UpdatePipelineError('THUNDERSTORE_DEPENDENCY_GRAPH_INCOMPLETE')
    states.set(key, 'visiting')
    for (const child of children) visit(child)
    states.set(key, 'visited')
    ordered.push(dependencyId)
  }
  for (const root of roots) visit(root)
  if (ordered.length !== graph.size) throw new UpdatePipelineError('THUNDERSTORE_DEPENDENCY_GRAPH_INCOMPLETE')
  return ordered
}

const githubClientConfigSchema = z.strictObject({
  pageSize: z.number().int().min(1).max(100),
  maxPages: z.number().int().min(1).max(5),
  includePrereleases: z.boolean()
})

const githubAssetSchema = z.strictObject({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  name: safeFileNameSchema,
  size: positiveSizeSchema,
  state: z.literal('uploaded'),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/i).nullable(),
  browser_download_url: z.url().max(2_048)
})

const githubReleaseSchema = z.strictObject({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  tag_name: z.string().trim().min(1).max(64),
  draft: z.boolean(),
  prerelease: z.boolean(),
  published_at: isoDateSchema.nullable(),
  assets: z.array(githubAssetSchema).max(64)
})

export interface GithubDiscoveryClientOptions extends DiscoveryClientOptions {
  pageSize?: number
  maxPages?: number
  includePrereleases?: boolean
}

export class NebulaGithubReleaseClient {
  readonly #http: BoundedJsonClient
  readonly #pageSize: number
  readonly #maxPages: number
  readonly #includePrereleases: boolean

  constructor(options: GithubDiscoveryClientOptions) {
    const config = githubClientConfigSchema.parse({
      pageSize: options.pageSize ?? 25,
      maxPages: options.maxPages ?? 3,
      includePrereleases: options.includePrereleases ?? false
    })
    this.#http = new BoundedJsonClient({
      ...options,
      allowedHosts: ['api.github.com'],
      maxResponseBytes: options.maxResponseBytes ?? 768 * 1_024
    })
    this.#pageSize = config.pageSize
    this.#maxPages = config.maxPages
    this.#includePrereleases = config.includePrereleases
  }

  async discover(signal?: AbortSignal): Promise<PagedDiscoveryResult<DiscoveredNebulaRelease>> {
    const discovered: DiscoveredNebulaRelease[] = []
    let pagesFetched = 0
    let lastPageWasFull = false
    for (let page = 1; page <= this.#maxPages; page++) {
      const url = new URL('/repos/NebulaModTeam/nebula/releases', 'https://api.github.com')
      url.searchParams.set('per_page', String(this.#pageSize))
      url.searchParams.set('page', String(page))
      const raw = await this.#http.get(url, {
        signal,
        headers: { 'x-github-api-version': '2022-11-28' }
      })
      const releases = z.array(githubReleaseSchema).max(this.#pageSize)
        .parse(projectGithubReleasePage(raw))
      pagesFetched += 1
      for (const release of releases) {
        if (release.draft || release.published_at === null ||
            (release.prerelease && !this.#includePrereleases)) continue
        const version = normalizeVersion(release.tag_name, 'nebula')
        for (const asset of release.assets) {
          const downloadUrl = validateGithubDownloadUrl(asset.browser_download_url)
          const digest = asset.digest?.slice('sha256:'.length).toLowerCase() ?? null
          discovered.push(discoveredNebulaReleaseSchema.parse({
            provider: 'github',
            sourceId: 'github:NebulaModTeam/nebula',
            releaseId: release.id,
            version,
            publishedAt: release.published_at,
            prerelease: release.prerelease,
            artifact: {
              artifactId: artifactIdFor('github:NebulaModTeam/nebula', version, asset.name),
              downloadUrl,
              fileName: asset.name,
              sizeBytes: asset.size,
              sha256: digest,
              integrity: digest === null ? 'locally-computed-required' : 'provider-sha256'
            }
          }))
        }
      }
      lastPageWasFull = releases.length === this.#pageSize
      if (!lastPageWasFull) break
    }
    assertNoDuplicateArtifacts(discovered)
    discovered.sort((left, right) =>
      compareVersions(right.version, left.version, 'nebula') ||
      compareText(left.artifact.fileName.toLowerCase(), right.artifact.fileName.toLowerCase())
    )
    return {
      items: discovered,
      pagesFetched,
      truncated: pagesFetched === this.#maxPages && lastPageWasFull
    }
  }
}

function projectThunderstorePackage(input: unknown): unknown {
  const value = asRecord(input, 'THUNDERSTORE_RESPONSE_INVALID')
  const latest = asRecord(value.latest, 'THUNDERSTORE_RESPONSE_INVALID')
  const listings = Array.isArray(value.community_listings) ? value.community_listings : value.community_listings
  return {
    namespace: value.namespace,
    name: value.name,
    full_name: value.full_name,
    is_deprecated: value.is_deprecated,
    latest: {
      namespace: latest.namespace,
      name: latest.name,
      version_number: latest.version_number,
      full_name: latest.full_name,
      dependencies: latest.dependencies,
      download_url: latest.download_url,
      date_created: latest.date_created,
      is_active: latest.is_active
    },
    community_listings: Array.isArray(listings) ? listings.map((listing) => {
      const record = asRecord(listing, 'THUNDERSTORE_RESPONSE_INVALID')
      return { community: record.community, review_status: record.review_status }
    }) : listings
  }
}

function projectThunderstoreVersion(input: unknown): unknown {
  const value = asRecord(input, 'THUNDERSTORE_RESPONSE_INVALID')
  return {
    namespace: value.namespace,
    name: value.name,
    version_number: value.version_number,
    full_name: value.full_name,
    dependencies: value.dependencies,
    download_url: value.download_url,
    date_created: value.date_created,
    is_active: value.is_active
  }
}

function projectGithubReleasePage(input: unknown): unknown {
  if (!Array.isArray(input)) return input
  return input.map((release) => {
    const value = asRecord(release, 'GITHUB_RELEASE_RESPONSE_INVALID')
    const assets = value.assets
    return {
      id: value.id,
      tag_name: value.tag_name,
      draft: value.draft,
      prerelease: value.prerelease,
      published_at: value.published_at,
      assets: Array.isArray(assets) ? assets.map((asset) => {
        const record = asRecord(asset, 'GITHUB_RELEASE_RESPONSE_INVALID')
        return {
          id: record.id,
          name: record.name,
          size: record.size,
          state: record.state,
          digest: record.digest ?? null,
          browser_download_url: record.browser_download_url
        }
      }) : assets
    }
  })
}

function validateThunderstoreDownloadUrl(value: string, namespace: string, name: string, version: string): string {
  const url = new URL(value)
  assertTrustedHttpsUrl(url, new Set(['thunderstore.io']))
  const expectedPath = `/package/download/${namespace}/${name}/${version}/`
  if (url.pathname !== expectedPath || url.search !== '') {
    throw new UpdatePipelineError('THUNDERSTORE_DOWNLOAD_URL_INVALID')
  }
  return url.toString()
}

function validateGithubDownloadUrl(value: string): string {
  const url = new URL(value)
  assertTrustedHttpsUrl(url, new Set(['github.com']))
  if (!url.pathname.toLowerCase().startsWith('/nebulamodteam/nebula/releases/download/') || url.search !== '') {
    throw new UpdatePipelineError('GITHUB_ASSET_URL_INVALID')
  }
  return url.toString()
}

function artifactIdFor(sourceId: string, version: string, fileName: string): string {
  const digest = createHash('sha256').update(`${sourceId.toLowerCase()}\n${version}\n${fileName}`, 'utf8')
    .digest('hex').slice(0, 40)
  return `artifact-${digest}`
}

function assertNoDuplicateArtifacts(releases: readonly DiscoveredNebulaRelease[]): void {
  const keys = releases.map((release) => release.artifact.artifactId)
  if (new Set(keys).size !== keys.length) throw new UpdatePipelineError('GITHUB_ARTIFACT_DUPLICATE')
}

function asRecord(input: unknown, code: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new UpdatePipelineError(code)
  }
  return input as Record<string, unknown>
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

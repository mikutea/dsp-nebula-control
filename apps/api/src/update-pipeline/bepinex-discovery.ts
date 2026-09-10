import { createHash } from 'node:crypto'
import { z } from 'zod'
import { compareVersions, normalizeVersion, sha256Schema } from '../updates/version.js'
import {
  bepInExWindowsX64LayoutPolicyIds,
  resolveBepInExWindowsX64LayoutPolicy,
  type BepInExWindowsX64LayoutPolicyId
} from './bepinex-layout.js'
import {
  discoveredArtifactSchema,
  type DiscoveredArtifact,
  type DiscoveryClientOptions,
  type PagedDiscoveryResult
} from './discovery.js'
import { UpdatePipelineError } from './errors.js'
import { assertTrustedHttpsUrl, BoundedJsonClient } from './http.js'

export const bepInExGithubSourceId = 'github:BepInEx/BepInEx' as const

const supportedVersions = [
  '5.4.22',
  '5.4.22.0',
  '5.4.23.2',
  '5.4.23.3',
  '5.4.23.4',
  '5.4.23.5'
] as const

export type SupportedBepInExGithubVersion = typeof supportedVersions[number]

const officialAssetNames: Readonly<Record<SupportedBepInExGithubVersion, string>> = Object.freeze({
  '5.4.22': 'BepInEx_x64_5.4.22.0.zip',
  '5.4.22.0': 'BepInEx_x64_5.4.22.0.zip',
  '5.4.23.2': 'BepInEx_win_x64_5.4.23.2.zip',
  '5.4.23.3': 'BepInEx_win_x64_5.4.23.3.zip',
  '5.4.23.4': 'BepInEx_win_x64_5.4.23.4.zip',
  '5.4.23.5': 'BepInEx_win_x64_5.4.23.5.zip'
})

const supportedVersionSchema = z.enum(supportedVersions)
const layoutPolicySchema = z.enum([
  bepInExWindowsX64LayoutPolicyIds.v5_4_22,
  bepInExWindowsX64LayoutPolicyIds.v5_4_23_2_through_5
])
const isoDateSchema = z.string().datetime({ offset: true })
// Historical releases also contain non-ZIP assets. Validate their bounded
// metadata here; only the exact reviewed Windows ZIP can become a candidate.
const githubAssetNameSchema = z.string().min(1).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
const positiveSizeSchema = z.number().int().positive().max(2 * 1_024 * 1_024 * 1_024)

export interface DiscoveredBepInExRelease {
  provider: 'github'
  sourceId: typeof bepInExGithubSourceId
  releaseId: number
  version: SupportedBepInExGithubVersion
  publishedAt: string
  layoutPolicy: BepInExWindowsX64LayoutPolicyId
  artifact: DiscoveredArtifact
}

export const discoveredBepInExReleaseSchema: z.ZodType<DiscoveredBepInExRelease> = z.strictObject({
  provider: z.literal('github'),
  sourceId: z.literal(bepInExGithubSourceId),
  releaseId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  version: supportedVersionSchema,
  publishedAt: isoDateSchema,
  layoutPolicy: layoutPolicySchema,
  artifact: discoveredArtifactSchema
}).superRefine((value, context) => {
  try {
    const policy = officialPolicyForVersion(value.version)
    if (value.layoutPolicy !== policy.layoutPolicy || value.artifact.fileName !== policy.fileName) {
      context.addIssue({ code: 'custom', message: 'BepInEx release policy is inconsistent' })
      return
    }
    const expectedIntegrity = value.artifact.sha256 === null
      ? 'locally-computed-required'
      : 'provider-sha256'
    if (value.artifact.sizeBytes === null || value.artifact.integrity !== expectedIntegrity) {
      context.addIssue({ code: 'custom', message: 'BepInEx provider integrity is inconsistent' })
      return
    }
    validateBepInExGithubDownloadUrl(
      value.artifact.downloadUrl,
      value.version,
      value.artifact.fileName
    )
  } catch {
    context.addIssue({ code: 'custom', message: 'BepInEx release artifact is invalid' })
  }
})

const clientConfigSchema = z.strictObject({
  pageSize: z.number().int().min(1).max(100),
  maxPages: z.number().int().min(1).max(5)
})

const githubAssetSchema = z.strictObject({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  name: githubAssetNameSchema,
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

export interface BepInExGithubDiscoveryClientOptions extends DiscoveryClientOptions {
  pageSize?: number
  maxPages?: number
}

/**
 * Bounded discovery of reviewed official BepInEx 5 Windows x64 release assets.
 * It cannot discover another repository, architecture, platform, or future
 * version: those values have no constructor or request input.
 */
export class BepInExGithubReleaseClient {
  readonly #http: BoundedJsonClient
  readonly #pageSize: number
  readonly #maxPages: number

  constructor(options: BepInExGithubDiscoveryClientOptions) {
    const config = clientConfigSchema.parse({
      pageSize: options.pageSize ?? 25,
      maxPages: options.maxPages ?? 3
    })
    this.#http = new BoundedJsonClient({
      ...options,
      allowedHosts: ['api.github.com'],
      maxResponseBytes: options.maxResponseBytes ?? 768 * 1_024
    })
    this.#pageSize = config.pageSize
    this.#maxPages = config.maxPages
  }

  async discover(signal?: AbortSignal): Promise<PagedDiscoveryResult<DiscoveredBepInExRelease>> {
    const discovered: DiscoveredBepInExRelease[] = []
    let pagesFetched = 0
    let lastPageWasFull = false

    for (let page = 1; page <= this.#maxPages; page += 1) {
      const url = new URL('/repos/BepInEx/BepInEx/releases', 'https://api.github.com')
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
        if (release.draft || release.prerelease || release.published_at === null) continue
        const version = supportedVersionFromOfficialTag(release.tag_name)
        if (version === null) continue
        const policy = officialPolicyForVersion(version)

        for (const asset of release.assets) {
          if (asset.name !== policy.fileName) continue
          const downloadUrl = validateBepInExGithubDownloadUrl(
            asset.browser_download_url,
            version,
            policy.fileName
          )
          const digest = asset.digest?.slice('sha256:'.length).toLowerCase() ?? null
          discovered.push(discoveredBepInExReleaseSchema.parse({
            provider: 'github',
            sourceId: bepInExGithubSourceId,
            releaseId: release.id,
            version,
            publishedAt: release.published_at,
            layoutPolicy: policy.layoutPolicy,
            artifact: {
              artifactId: artifactIdFor(version, policy.fileName),
              downloadUrl,
              fileName: policy.fileName,
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

    assertNoDuplicateReleases(discovered)
    discovered.sort((left, right) =>
      compareVersions(right.version, left.version, 'bepinex') ||
      compareText(left.artifact.fileName, right.artifact.fileName)
    )
    return {
      items: discovered,
      pagesFetched,
      truncated: pagesFetched === this.#maxPages && lastPageWasFull
    }
  }
}

function supportedVersionFromOfficialTag(tag: string): SupportedBepInExGithubVersion | null {
  let version: string
  try {
    version = normalizeVersion(tag, 'bepinex')
  } catch {
    return null
  }
  if (tag !== `v${version}` || !isSupportedVersion(version)) return null
  // Keep discovery and archive activation on the same reviewed version policy.
  resolveBepInExWindowsX64LayoutPolicy(version)
  return version
}

function officialPolicyForVersion(version: SupportedBepInExGithubVersion): {
  fileName: string
  layoutPolicy: BepInExWindowsX64LayoutPolicyId
} {
  const policy = resolveBepInExWindowsX64LayoutPolicy(version)
  return { fileName: officialAssetNames[version], layoutPolicy: policy.id }
}

function validateBepInExGithubDownloadUrl(
  value: string,
  version: SupportedBepInExGithubVersion,
  fileName: string
): string {
  const url = new URL(value)
  assertTrustedHttpsUrl(url, new Set(['github.com']))
  const expectedPath = `/BepInEx/BepInEx/releases/download/v${version}/${fileName}`
  if (url.pathname !== expectedPath || url.search !== '') {
    throw new UpdatePipelineError('BEPINEX_GITHUB_ASSET_URL_INVALID')
  }
  return url.toString()
}

function projectGithubReleasePage(input: unknown): unknown {
  if (!Array.isArray(input)) return input
  return input.map((release) => {
    const value = asRecord(release)
    return {
      id: value.id,
      tag_name: value.tag_name,
      draft: value.draft,
      prerelease: value.prerelease,
      published_at: value.published_at,
      assets: Array.isArray(value.assets) ? value.assets.map((asset) => {
        const record = asRecord(asset)
        return {
          id: record.id,
          name: record.name,
          size: record.size,
          state: record.state,
          digest: record.digest ?? null,
          browser_download_url: record.browser_download_url
        }
      }) : value.assets
    }
  })
}

function isSupportedVersion(value: string): value is SupportedBepInExGithubVersion {
  return (supportedVersions as readonly string[]).includes(value)
}

function artifactIdFor(version: SupportedBepInExGithubVersion, fileName: string): string {
  const digest = createHash('sha256')
    .update(`${bepInExGithubSourceId.toLowerCase()}\n${version}\n${fileName}`, 'utf8')
    .digest('hex')
    .slice(0, 40)
  return `artifact-${digest}`
}

function assertNoDuplicateReleases(releases: readonly DiscoveredBepInExRelease[]): void {
  const releaseIds = releases.map((release) => release.releaseId)
  const artifactIds = releases.map((release) => release.artifact.artifactId)
  if (new Set(releaseIds).size !== releaseIds.length ||
      new Set(artifactIds).size !== artifactIds.length) {
    throw new UpdatePipelineError('GITHUB_ARTIFACT_DUPLICATE')
  }
}

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new UpdatePipelineError('GITHUB_RELEASE_RESPONSE_INVALID')
  }
  return input as Record<string, unknown>
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

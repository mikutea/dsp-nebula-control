import { describe, expect, it, vi } from 'vitest'
import { NebulaGithubReleaseClient, ThunderstoreReleaseClient } from './discovery.js'
import type { FetchLike } from './http.js'

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
}

function thunderstoreFixture(downloadUrl = 'https://thunderstore.io/package/download/Fictional/ServerHelper/1.2.3/') {
  return {
    namespace: 'Fictional',
    name: 'ServerHelper',
    full_name: 'Fictional-ServerHelper',
    is_deprecated: false,
    ignored_upstream_field: 'not consumed',
    latest: {
      namespace: 'Fictional',
      name: 'ServerHelper',
      version_number: '1.2.3',
      full_name: 'Fictional-ServerHelper-1.2.3',
      dependencies: ['Fictional-CoreLib-1.0.0'],
      download_url: downloadUrl,
      date_created: '2026-08-30T01:00:00Z',
      is_active: true,
      description: 'fixture only'
    },
    community_listings: [{
      community: 'dyson-sphere-program', review_status: 'approved', categories: []
    }]
  }
}

function githubRelease(
  id: number,
  version: string,
  assetName: string,
  options: { draft?: boolean; prerelease?: boolean; digest?: string | null } = {}
) {
  return {
    id,
    tag_name: `v${version}`,
    draft: options.draft ?? false,
    prerelease: options.prerelease ?? false,
    published_at: '2026-08-30T02:00:00Z',
    body: 'fixture only',
    assets: [{
      id: id * 10,
      name: assetName,
      size: 4_096,
      state: 'uploaded',
      digest: 'digest' in options ? options.digest : `sha256:${String(id % 10).repeat(64)}`,
      browser_download_url: `https://github.com/NebulaModTeam/nebula/releases/download/v${version}/${assetName}`,
      content_type: 'application/zip'
    }]
  }
}

describe('release metadata discovery', () => {
  it('normalizes Thunderstore metadata while keeping the artifact untrusted until local staging', async () => {
    const fetch = vi.fn<FetchLike>(async () => response(thunderstoreFixture()))
    const client = new ThunderstoreReleaseClient({ fetch })
    const release = await client.discoverLatest({ namespace: 'Fictional', name: 'ServerHelper' })
    expect(release).toMatchObject({
      sourceId: 'thunderstore:Fictional/ServerHelper',
      dependencyId: 'Fictional-ServerHelper-1.2.3',
      version: '1.2.3',
      dependencies: ['Fictional-CoreLib-1.0.0'],
      eligible: true,
      blockers: ['artifact-integrity-pending'],
      artifact: {
        sizeBytes: null,
        sha256: null,
        integrity: 'locally-computed-required',
        fileName: 'Fictional-ServerHelper-1.2.3.zip'
      }
    })
    expect(String(fetch.mock.calls[0]![0]))
      .toBe('https://thunderstore.io/api/experimental/package/Fictional/ServerHelper/')
  })

  it('rejects a provider response that points at a non-allowlisted artifact host', async () => {
    const client = new ThunderstoreReleaseClient({
      fetch: async () => response(thunderstoreFixture('https://attacker.example/package.zip'))
    })
    await expect(client.discoverLatest({ namespace: 'Fictional', name: 'ServerHelper' }))
      .rejects.toThrow('DISCOVERY_URL_NOT_ALLOWED')
  })

  it('fetches an exact Thunderstore version instead of substituting the package latest release', async () => {
    const fetch = dependencyGraphFetch({
      'Fictional-ServerHelper-1.2.3': { dependencies: [] }
    }, { latestVersions: { 'Fictional-ServerHelper': '9.9.9' } })
    const client = new ThunderstoreReleaseClient({ fetch })

    const release = await client.discoverExact({ dependencyId: 'Fictional-ServerHelper-1.2.3' })
    expect(release).toMatchObject({
      dependencyId: 'Fictional-ServerHelper-1.2.3',
      version: '1.2.3',
      artifact: { fileName: 'Fictional-ServerHelper-1.2.3.zip' }
    })
    expect(fetch.mock.calls.map(([input]) => String(input)).sort()).toEqual([
      'https://thunderstore.io/api/experimental/package/Fictional/ServerHelper/',
      'https://thunderstore.io/api/experimental/package/Fictional/ServerHelper/1.2.3/'
    ])
  })

  it('resolves a bounded exact dependency closure in dependencies-first order', async () => {
    const fetch = dependencyGraphFetch({
      'Fictional-Root-1.0.0': {
        dependencies: ['Fictional-Feature-1.0.0', 'Fictional-Core-1.0.0']
      },
      'Fictional-Core-1.0.0': { dependencies: ['Fictional-Shared-1.0.0'] },
      'Fictional-Feature-1.0.0': { dependencies: ['Fictional-Shared-1.0.0'] },
      'Fictional-Shared-1.0.0': { dependencies: [] }
    })
    const client = new ThunderstoreReleaseClient({ fetch, maxDependencyNodes: 8, maxDependencyDepth: 4 })

    const closure = await client.discoverDependencyClosure({ roots: ['Fictional-Root-1.0.0'] })
    expect(closure).toMatchObject({
      roots: ['Fictional-Root-1.0.0'],
      order: 'dependencies-first',
      nodeCount: 4,
      maximumDepth: 2,
      canAcquireAll: true,
      blocked: []
    })
    expect(closure.items.map((release) => release.dependencyId)).toEqual([
      'Fictional-Shared-1.0.0',
      'Fictional-Core-1.0.0',
      'Fictional-Feature-1.0.0',
      'Fictional-Root-1.0.0'
    ])
    expect(closure.routes).toEqual(closure.items.map((release) => ({
      dependencyId: release.dependencyId,
      sourceId: release.sourceId,
      requiredVersion: release.version,
      disposition: 'plugin',
      deploymentOwner: 'mods',
      resolution: 'mod-import-pipeline',
      directPluginAcquisitionAllowed: true
    })))
    expect(fetch).toHaveBeenCalledTimes(8)
  })

  it('diverts exact Nebula and BepInEx platform dependencies away from the ordinary mod pipeline', async () => {
    const client = new ThunderstoreReleaseClient({
      fetch: dependencyGraphFetch({
        'Fictional-ServerHelper-1.0.0': {
          dependencies: [
            'nebula-NebulaMultiplayerModApi-2.1.0',
            'xiaoye97-BepInEx-5.4.17',
            'Fictional-Utility-1.0.0'
          ]
        },
        'Fictional-Utility-1.0.0': { dependencies: [] },
        'nebula-NebulaMultiplayerModApi-2.1.0': { dependencies: ['xiaoye97-BepInEx-5.4.17'] },
        'xiaoye97-BepInEx-5.4.17': { dependencies: [] }
      })
    })

    const closure = await client.discoverDependencyClosure({ roots: ['Fictional-ServerHelper-1.0.0'] })

    expect(closure.canAcquireAll).toBe(false)
    expect(closure.blocked).toEqual([])
    expect(closure.routes).toEqual([
      expect.objectContaining({
        dependencyId: 'Fictional-Utility-1.0.0',
        disposition: 'plugin',
        deploymentOwner: 'mods',
        directPluginAcquisitionAllowed: true
      }),
      expect.objectContaining({
        dependencyId: 'xiaoye97-BepInEx-5.4.17',
        requiredVersion: '5.4.17',
        disposition: 'external-prerequisite',
        deploymentOwner: 'bepinex',
        resolution: 'bepinex-component-inventory',
        directPluginAcquisitionAllowed: false
      }),
      expect.objectContaining({
        dependencyId: 'nebula-NebulaMultiplayerModApi-2.1.0',
        requiredVersion: '2.1.0',
        disposition: 'managed-component',
        deploymentOwner: 'nebula',
        resolution: 'nebula-component-pipeline',
        directPluginAcquisitionAllowed: false
      }),
      expect.objectContaining({
        dependencyId: 'Fictional-ServerHelper-1.0.0',
        disposition: 'plugin',
        directPluginAcquisitionAllowed: true
      })
    ])
  })

  it('reports exact inactive dependencies without registering the closure as fully acquirable', async () => {
    const client = new ThunderstoreReleaseClient({
      fetch: dependencyGraphFetch({
        'Fictional-Root-1.0.0': { dependencies: ['Fictional-OldCore-1.0.0'] },
        'Fictional-OldCore-1.0.0': { dependencies: [], active: false }
      })
    })
    const closure = await client.discoverDependencyClosure({ roots: ['Fictional-Root-1.0.0'] })
    expect(closure.canAcquireAll).toBe(false)
    expect(closure.blocked).toEqual([{
      dependencyId: 'Fictional-OldCore-1.0.0',
      blockers: ['version-inactive', 'artifact-integrity-pending']
    }])
  })

  it('fails closed on exact dependency version conflicts and cycles', async () => {
    const conflictClient = new ThunderstoreReleaseClient({
      fetch: dependencyGraphFetch({
        'Fictional-Root-1.0.0': {
          dependencies: ['Fictional-Core-1.0.0', 'Fictional-Core-2.0.0']
        }
      })
    })
    await expect(conflictClient.discoverDependencyClosure({ roots: ['Fictional-Root-1.0.0'] }))
      .rejects.toThrow('THUNDERSTORE_DEPENDENCY_VERSION_CONFLICT')

    const cycleClient = new ThunderstoreReleaseClient({
      fetch: dependencyGraphFetch({
        'Fictional-Root-1.0.0': { dependencies: ['Fictional-Core-1.0.0'] },
        'Fictional-Core-1.0.0': { dependencies: ['Fictional-Root-1.0.0'] }
      })
    })
    await expect(cycleClient.discoverDependencyClosure({ roots: ['Fictional-Root-1.0.0'] }))
      .rejects.toThrow('THUNDERSTORE_DEPENDENCY_CYCLE')
  })

  it('enforces dependency node/depth limits and never treats a missing exact release as latest', async () => {
    const graph = {
      'Fictional-Root-1.0.0': { dependencies: ['Fictional-Core-1.0.0'] },
      'Fictional-Core-1.0.0': { dependencies: ['Fictional-Shared-1.0.0'] },
      'Fictional-Shared-1.0.0': { dependencies: [] }
    }
    await expect(new ThunderstoreReleaseClient({
      fetch: dependencyGraphFetch(graph), maxDependencyNodes: 2
    }).discoverDependencyClosure({ roots: ['Fictional-Root-1.0.0'] }))
      .rejects.toThrow('THUNDERSTORE_DEPENDENCY_NODE_LIMIT')
    await expect(new ThunderstoreReleaseClient({
      fetch: dependencyGraphFetch(graph), maxDependencyDepth: 0
    }).discoverDependencyClosure({ roots: ['Fictional-Root-1.0.0'] }))
      .rejects.toThrow('THUNDERSTORE_DEPENDENCY_DEPTH_LIMIT')

    const missing = new ThunderstoreReleaseClient({
      fetch: dependencyGraphFetch({
        'Fictional-Root-1.0.0': { dependencies: ['Fictional-Missing-1.0.0'] }
      })
    })
    await expect(missing.discoverDependencyClosure({ roots: ['Fictional-Root-1.0.0'] }))
      .rejects.toThrow('DISCOVERY_HTTP_STATUS_INVALID')
  })

  it('bounds GitHub pagination, filters draft releases, and validates provider digests', async () => {
    const pages = new Map([
      ['1', [githubRelease(1, '0.9.22', 'Nebula-0.9.22.zip'), githubRelease(2, '0.9.23', 'draft.zip', { draft: true })]],
      ['2', [githubRelease(3, '0.9.21', 'Nebula-0.9.21.zip', { digest: null })]]
    ])
    const fetch = vi.fn<FetchLike>(async (input) => {
      const page = new URL(String(input)).searchParams.get('page') ?? ''
      return response(pages.get(page) ?? [])
    })
    const client = new NebulaGithubReleaseClient({ fetch, pageSize: 2, maxPages: 3 })
    const result = await client.discover()
    expect(result).toMatchObject({ pagesFetched: 2, truncated: false })
    expect(result.items.map((release) => release.version)).toEqual(['0.9.22', '0.9.21'])
    expect(result.items[0]?.artifact).toMatchObject({
      sha256: '1'.repeat(64), integrity: 'provider-sha256', sizeBytes: 4_096
    })
    expect(result.items[1]?.artifact).toMatchObject({
      sha256: null, integrity: 'locally-computed-required'
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('marks a full final page as truncated instead of silently exceeding its page budget', async () => {
    const client = new NebulaGithubReleaseClient({
      fetch: async (input) => {
        const page = Number(new URL(String(input)).searchParams.get('page'))
        return response([githubRelease(page, `0.9.${20 + page}`, `Nebula-${page}.zip`)])
      },
      pageSize: 1,
      maxPages: 2
    })
    const result = await client.discover()
    expect(result.pagesFetched).toBe(2)
    expect(result.truncated).toBe(true)
    expect(result.items).toHaveLength(2)
  })
})

interface DependencyVersionFixture {
  dependencies: string[]
  active?: boolean
  deprecated?: boolean
  approved?: boolean
}

function dependencyGraphFetch(
  versions: Readonly<Record<string, DependencyVersionFixture>>,
  options: { latestVersions?: Readonly<Record<string, string>> } = {}
) {
  return vi.fn<FetchLike>(async (input) => {
    const url = new URL(String(input))
    const match = /^\/api\/experimental\/package\/([A-Za-z0-9_]+)\/([A-Za-z0-9_]+)(?:\/([0-9.]+))?\/$/
      .exec(url.pathname)
    if (match === null) return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
    const [, namespace, name, requestedVersion] = match
    const sourceId = `${namespace}-${name}`
    const matching = Object.entries(versions).filter(([dependencyId]) => dependencyId.startsWith(`${sourceId}-`))
    if (requestedVersion === undefined) {
      const latestVersion = options.latestVersions?.[sourceId!] ?? matching[0]?.[0].slice(`${sourceId}-`.length)
      if (latestVersion === undefined) {
        return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
      }
      const latestFixture = versions[`${sourceId}-${latestVersion}`] ?? matching[0]?.[1] ?? { dependencies: [] }
      return response(thunderstorePackageFixture(
        namespace!, name!, latestVersion, latestFixture,
        matching.some(([, fixture]) => fixture.deprecated === true),
        matching.every(([, fixture]) => fixture.approved !== false)
      ))
    }
    const dependencyId = `${sourceId}-${requestedVersion}`
    const fixture = versions[dependencyId]
    if (fixture === undefined) {
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
    }
    return response(thunderstoreVersionFixture(namespace!, name!, requestedVersion, fixture))
  })
}

function thunderstorePackageFixture(
  namespace: string,
  name: string,
  latestVersion: string,
  latest: DependencyVersionFixture,
  deprecated: boolean,
  approved: boolean
) {
  return {
    namespace,
    name,
    full_name: `${namespace}-${name}`,
    is_deprecated: deprecated,
    latest: thunderstoreVersionFixture(namespace, name, latestVersion, latest),
    community_listings: [{
      community: 'dyson-sphere-program',
      review_status: approved ? 'approved' : 'rejected'
    }]
  }
}

function thunderstoreVersionFixture(
  namespace: string,
  name: string,
  version: string,
  fixture: DependencyVersionFixture
) {
  return {
    namespace,
    name,
    version_number: version,
    full_name: `${namespace}-${name}-${version}`,
    dependencies: fixture.dependencies,
    download_url: `https://thunderstore.io/package/download/${namespace}/${name}/${version}/`,
    date_created: '2026-08-30T01:00:00Z',
    is_active: fixture.active ?? true
  }
}

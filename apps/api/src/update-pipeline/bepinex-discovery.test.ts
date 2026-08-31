import { describe, expect, it, vi } from 'vitest'
import { bepInExWindowsX64LayoutPolicyIds } from './bepinex-layout.js'
import {
  BepInExGithubReleaseClient,
  bepInExGithubSourceId
} from './bepinex-discovery.js'
import { BepInExGithubReleaseClient as IndexedBepInExGithubReleaseClient } from './index.js'
import {
  bepInExGithubAssetFixture,
  bepInExGithubReleaseFixture,
  officialFixtureAssetName
} from './bepinex-discovery.fixtures.js'
import type { FetchLike } from './http.js'

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/vnd.github+json; charset=utf-8' }
  })
}

describe('official BepInEx GitHub release discovery', () => {
  it('is exported from the update-pipeline public index', () => {
    expect(IndexedBepInExGithubReleaseClient).toBe(BepInExGithubReleaseClient)
  })

  it('returns only reviewed Windows x64 candidates with provider size and digest evidence', async () => {
    const releases = [
      bepInExGithubReleaseFixture(1, '5.4.23.5'),
      bepInExGithubReleaseFixture(2, '5.4.22', { asset: { digest: null, size: 622_553 } }),
      bepInExGithubReleaseFixture(3, '5.4.23.4', { draft: true }),
      bepInExGithubReleaseFixture(4, '5.4.23.3', { prerelease: true }),
      bepInExGithubReleaseFixture(5, '5.4.23.6'),
      bepInExGithubReleaseFixture(6, 'nightly-build'),
      bepInExGithubReleaseFixture(7, '5.4.23.2', {
        assets: [
          bepInExGithubAssetFixture(71, '5.4.23.2', 'v5.4.23.2', {
            name: 'BepInEx_win_x86_5.4.23.2.zip'
          }),
          bepInExGithubAssetFixture(72, '5.4.23.2', 'v5.4.23.2', {
            name: 'BepInEx_unix_5.4.23.2.zip'
          })
        ]
      })
    ]
    const fetch = vi.fn<FetchLike>(async () => response(releases))
    const client = new BepInExGithubReleaseClient({ fetch, pageSize: 10, maxPages: 2 })

    const result = await client.discover()

    expect(result).toMatchObject({ pagesFetched: 1, truncated: false })
    expect(result.items.map(({ version }) => version)).toEqual(['5.4.23.5', '5.4.22'])
    expect(result.items[0]).toMatchObject({
      provider: 'github',
      sourceId: bepInExGithubSourceId,
      layoutPolicy: bepInExWindowsX64LayoutPolicyIds.v5_4_23_2_through_5,
      artifact: {
        fileName: 'BepInEx_win_x64_5.4.23.5.zip',
        sizeBytes: 640_000,
        sha256: '0'.repeat(64),
        integrity: 'provider-sha256'
      }
    })
    expect(result.items[1]).toMatchObject({
      layoutPolicy: bepInExWindowsX64LayoutPolicyIds.v5_4_22,
      artifact: {
        fileName: 'BepInEx_x64_5.4.22.0.zip',
        sizeBytes: 622_553,
        sha256: null,
        integrity: 'locally-computed-required'
      }
    })
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe(
      'https://api.github.com/repos/BepInEx/BepInEx/releases?per_page=10&page=1'
    )
    expect(init).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: expect.objectContaining({ 'x-github-api-version': '2022-11-28' })
    })
  })

  it.each([
    ['5.4.22', 'BepInEx_x64_5.4.22.0.zip'],
    ['5.4.22.0', 'BepInEx_x64_5.4.22.0.zip'],
    ['5.4.23.2', 'BepInEx_win_x64_5.4.23.2.zip'],
    ['5.4.23.3', 'BepInEx_win_x64_5.4.23.3.zip'],
    ['5.4.23.4', 'BepInEx_win_x64_5.4.23.4.zip'],
    ['5.4.23.5', 'BepInEx_win_x64_5.4.23.5.zip']
  ] as const)('accepts reviewed policy version %s and only its exact asset name', async (version, fileName) => {
    const client = new BepInExGithubReleaseClient({
      fetch: async () => response([bepInExGithubReleaseFixture(11, version)])
    })

    const result = await client.discover()

    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ version, artifact: { fileName } })
    expect(result.items[0]?.artifact.downloadUrl).toBe(
      `https://github.com/BepInEx/BepInEx/releases/download/v${version}/${fileName}`
    )
  })

  it('rejects a matching asset on a wrong host or non-canonical official path', async () => {
    const fileName = officialFixtureAssetName('5.4.23.5')
    const wrongHost = new BepInExGithubReleaseClient({
      fetch: async () => response([bepInExGithubReleaseFixture(12, '5.4.23.5', {
        asset: {
          downloadUrl: `https://downloads.example.com/BepInEx/BepInEx/releases/download/v5.4.23.5/${fileName}`
        }
      })])
    })
    await expect(wrongHost.discover()).rejects.toMatchObject({ code: 'DISCOVERY_URL_NOT_ALLOWED' })

    const wrongPath = new BepInExGithubReleaseClient({
      fetch: async () => response([bepInExGithubReleaseFixture(13, '5.4.23.5', {
        asset: {
          downloadUrl: `https://github.com/BepInEx/ThirdParty/releases/download/v5.4.23.5/${fileName}`
        }
      })])
    })
    await expect(wrongPath.discover()).rejects.toMatchObject({
      code: 'BEPINEX_GITHUB_ASSET_URL_INVALID'
    })
  })

  it('rejects duplicate official candidates instead of silently choosing one', async () => {
    const release = bepInExGithubReleaseFixture(14, '5.4.23.4', {
      assets: [
        bepInExGithubAssetFixture(141, '5.4.23.4'),
        bepInExGithubAssetFixture(142, '5.4.23.4')
      ]
    })
    const client = new BepInExGithubReleaseClient({ fetch: async () => response([release]) })

    await expect(client.discover()).rejects.toMatchObject({ code: 'GITHUB_ARTIFACT_DUPLICATE' })
  })

  it('keeps pagination bounded and reports a full final page as truncated', async () => {
    const fetch = vi.fn<FetchLike>(async (input) => {
      const page = Number(new URL(String(input)).searchParams.get('page'))
      return response([bepInExGithubReleaseFixture(page + 20, page === 1 ? '5.4.23.5' : '5.4.23.4')])
    })
    const client = new BepInExGithubReleaseClient({ fetch, pageSize: 1, maxPages: 2 })

    const result = await client.discover()

    expect(result.pagesFetched).toBe(2)
    expect(result.truncated).toBe(true)
    expect(result.items).toHaveLength(2)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls.map(([input]) => new URL(String(input)).searchParams.get('page')))
      .toEqual(['1', '2'])
  })

  it('inherits strict timeout and response-size limits from the bounded GitHub client', async () => {
    const stalledFetch: FetchLike = async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('fixture aborted')), { once: true })
    })
    const timed = new BepInExGithubReleaseClient({ fetch: stalledFetch, timeoutMs: 100 })
    await expect(timed.discover()).rejects.toMatchObject({ code: 'DISCOVERY_REQUEST_TIMEOUT' })

    const oversized = new BepInExGithubReleaseClient({
      fetch: async () => response([{
        ...bepInExGithubReleaseFixture(15, '5.4.23.5'),
        ignored_padding: 'x'.repeat(2_000)
      }]),
      maxResponseBytes: 1_024
    })
    await expect(oversized.discover()).rejects.toMatchObject({
      code: 'DISCOVERY_RESPONSE_TOO_LARGE'
    })
  })

  it('rejects malformed provider digest metadata before creating a candidate', async () => {
    const client = new BepInExGithubReleaseClient({
      fetch: async () => response([bepInExGithubReleaseFixture(16, '5.4.23.5', {
        asset: { digest: `sha512:${'a'.repeat(128)}` }
      })])
    })

    await expect(client.discover()).rejects.toBeTruthy()
  })
})

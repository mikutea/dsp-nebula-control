export interface BepInExGithubAssetFixtureOptions {
  name?: string
  size?: number
  digest?: string | null
  state?: string
  downloadUrl?: string
}

export interface BepInExGithubReleaseFixtureOptions {
  draft?: boolean
  prerelease?: boolean
  publishedAt?: string | null
  tagName?: string
  assets?: unknown[]
  asset?: BepInExGithubAssetFixtureOptions
}

export function bepInExGithubReleaseFixture(
  id: number,
  version: string,
  options: BepInExGithubReleaseFixtureOptions = {}
): Record<string, unknown> {
  const tagName = options.tagName ?? `v${version}`
  return {
    id,
    tag_name: tagName,
    draft: options.draft ?? false,
    prerelease: options.prerelease ?? false,
    published_at: options.publishedAt === undefined
      ? '2026-08-30T03:00:00.000Z'
      : options.publishedAt,
    body: 'fictional GitHub release fixture',
    assets: options.assets ?? [bepInExGithubAssetFixture(id * 10, version, tagName, options.asset)]
  }
}

export function bepInExGithubAssetFixture(
  id: number,
  version: string,
  tagName = `v${version}`,
  options: BepInExGithubAssetFixtureOptions = {}
): Record<string, unknown> {
  const name = options.name ?? officialFixtureAssetName(version)
  return {
    id,
    name,
    size: options.size ?? 640_000,
    state: options.state ?? 'uploaded',
    digest: Object.hasOwn(options, 'digest')
      ? options.digest
      : `sha256:${String(id % 10).repeat(64)}`,
    browser_download_url: options.downloadUrl ??
      `https://github.com/BepInEx/BepInEx/releases/download/${tagName}/${name}`,
    content_type: 'application/zip'
  }
}

export function officialFixtureAssetName(version: string): string {
  if (version === '5.4.22' || version === '5.4.22.0') return 'BepInEx_x64_5.4.22.0.zip'
  return `BepInEx_win_x64_${version}.zip`
}

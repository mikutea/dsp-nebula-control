import { normalizeVersion } from '../updates/version.js'
import { ComponentUpdateActivationError } from './activation-types.js'

export const bepInExWindowsX64LayoutPolicyIds = Object.freeze({
  v5_4_22: 'bepinex5-win-x64-5.4.22-v1',
  v5_4_23_2_through_5: 'bepinex5-win-x64-5.4.23.2-5-v1'
} as const)

export type BepInExWindowsX64LayoutPolicyId =
  typeof bepInExWindowsX64LayoutPolicyIds[keyof typeof bepInExWindowsX64LayoutPolicyIds]

const commonFiles = Object.freeze([
  'BepInEx/core/0Harmony.dll',
  'BepInEx/core/0Harmony.xml',
  'BepInEx/core/0Harmony20.dll',
  'BepInEx/core/BepInEx.dll',
  'BepInEx/core/BepInEx.Harmony.dll',
  'BepInEx/core/BepInEx.Harmony.xml',
  'BepInEx/core/BepInEx.Preloader.dll',
  'BepInEx/core/BepInEx.Preloader.xml',
  'BepInEx/core/BepInEx.xml',
  'BepInEx/core/HarmonyXInterop.dll',
  'BepInEx/core/Mono.Cecil.dll',
  'BepInEx/core/Mono.Cecil.Mdb.dll',
  'BepInEx/core/Mono.Cecil.Pdb.dll',
  'BepInEx/core/Mono.Cecil.Rocks.dll',
  'BepInEx/core/MonoMod.RuntimeDetour.dll',
  'BepInEx/core/MonoMod.RuntimeDetour.xml',
  'BepInEx/core/MonoMod.Utils.dll',
  'BepInEx/core/MonoMod.Utils.xml',
  'changelog.txt',
  'doorstop_config.ini',
  'winhttp.dll'
] as const)

/**
 * Versioned from the official Windows x64 release assets, not a broad BepInEx/** glob.
 * Provenance reviewed 2026-08-30 from the official BepInEx/BepInEx GitHub release pages:
 * - https://github.com/BepInEx/BepInEx/releases/tag/v5.4.22
 * - https://github.com/BepInEx/BepInEx/releases/tag/v5.4.23.5
 * The reviewed Windows x64 asset SHA-256 values were:
 * - v5.4.22.0: 4c149960673f0a387ba7c016c837096ab3a41309d9140f88590bb507c59eda3f
 * - v5.4.23.2: f752ce4e838f4c305b9da1404b6745f2cff23b8bfd494f79f0c84d0a01f59b46
 * - v5.4.23.3: 41a089e5b1b1f0713b331346baf6677b1184c69eabebf51101097954e854c749
 * - v5.4.23.4: f881201b79da03e513bf97cdf39607ffa7f9e0d31a519b1aeeca8eb60f8309e7
 * - v5.4.23.5: 82f9878551030f54657792c0740d9d51a09500eeae1fba21106b0c441e6732c4
 * The latter four assets share one exact path set and add only .doorstop_version. Runtime
 * payload hashes are still recorded in full in every staged and immutable release manifest.
 */
const policyFiles: Readonly<Record<BepInExWindowsX64LayoutPolicyId, readonly string[]>> = Object.freeze({
  [bepInExWindowsX64LayoutPolicyIds.v5_4_22]: commonFiles,
  [bepInExWindowsX64LayoutPolicyIds.v5_4_23_2_through_5]: Object.freeze([
    '.doorstop_version',
    ...commonFiles
  ])
})

const policyVersions: Readonly<Record<string, BepInExWindowsX64LayoutPolicyId>> = Object.freeze({
  '5.4.22': bepInExWindowsX64LayoutPolicyIds.v5_4_22,
  '5.4.22.0': bepInExWindowsX64LayoutPolicyIds.v5_4_22,
  '5.4.23.2': bepInExWindowsX64LayoutPolicyIds.v5_4_23_2_through_5,
  '5.4.23.3': bepInExWindowsX64LayoutPolicyIds.v5_4_23_2_through_5,
  '5.4.23.4': bepInExWindowsX64LayoutPolicyIds.v5_4_23_2_through_5,
  '5.4.23.5': bepInExWindowsX64LayoutPolicyIds.v5_4_23_2_through_5
})

const allOwnedPaths = new Set(Object.values(policyFiles).flat().map(canonicalPath))

export interface BepInExLayoutManifestLike {
  component: string
  version: string
  layoutPolicy?: string
  files: ReadonlyArray<{ relativePath: string }>
}

export function resolveBepInExWindowsX64LayoutPolicy(versionInput: unknown): {
  id: BepInExWindowsX64LayoutPolicyId
  files: readonly string[]
} {
  const version = normalizeVersion(versionInput, 'bepinex')
  const id = policyVersions[version]
  if (id === undefined) throw new ComponentUpdateActivationError('UPDATE_BEPINEX_VERSION_LAYOUT_UNSUPPORTED')
  return { id, files: policyFiles[id] }
}

export function assertBepInExWindowsX64ManifestLayout(manifest: BepInExLayoutManifestLike): void {
  if (manifest.component !== 'bepinex') throw new ComponentUpdateActivationError('UPDATE_BEPINEX_LAYOUT_INVALID')
  const policy = resolveBepInExWindowsX64LayoutPolicy(manifest.version)
  if (manifest.layoutPolicy !== policy.id || manifest.files.length !== policy.files.length) {
    throw new ComponentUpdateActivationError('UPDATE_BEPINEX_LAYOUT_INVALID')
  }
  const expected = new Map(policy.files.map((relativePath) => [canonicalPath(relativePath), relativePath]))
  const seen = new Set<string>()
  for (const file of manifest.files) {
    const key = canonicalPath(file.relativePath)
    if (seen.has(key) || expected.get(key) !== file.relativePath) {
      throw new ComponentUpdateActivationError('UPDATE_BEPINEX_LAYOUT_INVALID')
    }
    seen.add(key)
  }
  if (seen.size !== expected.size) throw new ComponentUpdateActivationError('UPDATE_BEPINEX_LAYOUT_INVALID')
}

export function isKnownBepInExWindowsX64OwnedPath(relativePath: string): boolean {
  return allOwnedPaths.has(canonicalPath(relativePath)) &&
    [...Object.values(policyFiles)].some((files) => files.includes(relativePath))
}

function canonicalPath(value: string): string {
  return value.toLocaleLowerCase('en-US')
}

export type ManagedPluginOwner = 'nebula' | 'bridge' | 'control'

export const managedPluginOwnership = Object.freeze({
  nebula: Object.freeze([
    'plugins/nebula-NebulaMultiplayerMod/',
    'plugins/nebula-NebulaMultiplayerModApi/'
  ]),
  bridge: Object.freeze(['plugins/dyson-control-bridge/']),
  control: Object.freeze(['plugins/dyson-control/'])
} satisfies Record<ManagedPluginOwner, readonly string[]>)

export const managedPluginOwnedDirectories = Object.freeze({
  nebula: Object.freeze([
    'plugins/nebula-NebulaMultiplayerMod',
    'plugins/nebula-NebulaMultiplayerModApi'
  ]),
  bridge: Object.freeze(['plugins/dyson-control-bridge']),
  control: Object.freeze(['plugins/dyson-control'])
} satisfies Record<ManagedPluginOwner, readonly string[]>)

export const managedOrdinaryModsDirectoryName = 'dyson-managed-mods'
export const managedOrdinaryModsRelativeRoot = `plugins/${managedOrdinaryModsDirectoryName}`

/**
 * Central ownership boundary for BepInEx/plugins. Components never own the
 * ordinary-mod subtree, and ordinary mods are published under that subtree by
 * ModDeploymentService rather than by component activation.
 */
export function isManagedComponentOwnedPath(owner: ManagedPluginOwner, relativePath: string): boolean {
  if (!isCanonicalRelativePath(relativePath)) return false
  if (!managedPluginOwnership[owner].some((prefix) => relativePath.startsWith(prefix))) return false
  if (owner === 'nebula' && relativePath === 'plugins/nebula-NebulaMultiplayerMod/nebulabundle') return true
  return /\.(?:dll|json)$/i.test(relativePath)
}

function isCanonicalRelativePath(value: string): boolean {
  return value.startsWith('plugins/') && !value.includes('\\') && !value.includes('//') &&
    !value.endsWith('/') && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

import { describe, expect, it } from 'vitest'
import {
  isManagedComponentOwnedPath,
  managedOrdinaryModsRelativeRoot,
  managedPluginOwnedDirectories,
  managedPluginOwnership
} from './plugin-ownership.js'

describe('managed BepInEx plugin ownership', () => {
  it.each([
    ['nebula', 'plugins/nebula-NebulaMultiplayerMod/Nebula.dll'],
    ['nebula', 'plugins/nebula-NebulaMultiplayerMod/config.json'],
    ['nebula', 'plugins/nebula-NebulaMultiplayerMod/nebulabundle'],
    ['nebula', 'plugins/nebula-NebulaMultiplayerModApi/NebulaAPI.dll'],
    ['bridge', 'plugins/dyson-control-bridge/DysonControlBridge.dll'],
    ['control', 'plugins/dyson-control/DysonControl.dll']
  ] as const)('accepts the fixed %s-owned path %s', (owner, relativePath) => {
    expect(isManagedComponentOwnedPath(owner, relativePath)).toBe(true)
  })

  it.each([
    ['nebula', 'plugins/Nebula.dll'],
    ['bridge', 'plugins/nebula-NebulaMultiplayerMod/Nebula.dll'],
    ['control', 'plugins/dyson-control-bridge/DysonControlBridge.dll'],
    ['nebula', `${managedOrdinaryModsRelativeRoot}/Example/Example.dll`],
    ['bridge', `${managedOrdinaryModsRelativeRoot}/Example/Example.dll`],
    ['control', `${managedOrdinaryModsRelativeRoot}/Example/Example.dll`],
    ['nebula', 'plugins/nebula-NebulaMultiplayerMod/readme.txt'],
    ['nebula', 'plugins/nebula-NebulaMultiplayerMod/../dyson-control/DysonControl.dll'],
    ['control', 'plugins\\dyson-control\\DysonControl.dll']
  ] as const)('rejects %s access to %s', (owner, relativePath) => {
    expect(isManagedComponentOwnedPath(owner, relativePath)).toBe(false)
  })

  it('keeps directory creation and path-prefix policy aligned', () => {
    for (const owner of ['nebula', 'bridge', 'control'] as const) {
      expect(managedPluginOwnedDirectories[owner].map((directory) => `${directory}/`))
        .toEqual(managedPluginOwnership[owner])
    }
  })
})

import { describe, expect, it } from 'vitest'
import {
  partitionThunderstorePluginDependencies,
  routeThunderstoreDependency,
  routeThunderstoreDependencyId
} from './thunderstore-dependency-routing.js'

describe('Thunderstore dependency routing policy', () => {
  it.each([
    ['nebula', 'NebulaMultiplayerMod', '0.9.22'],
    ['nebula', 'NebulaMultiplayerModApi', '2.1.0']
  ])('routes %s/%s through the managed Nebula component pipeline', (namespace, name, version) => {
    expect(route(namespace, name, version)).toMatchObject({
      disposition: 'managed-component',
      deploymentOwner: 'nebula',
      resolution: 'nebula-component-pipeline',
      requiredVersion: version,
      directPluginAcquisitionAllowed: false
    })
  })

  it.each(['BepInEx', 'BepInExPack', 'BepInExPackDSP', 'BepInExPack_DSP'])(
    'treats xiaoye97/%s as an external BepInEx prerequisite',
    (name) => {
      expect(route('xiaoye97', name, '5.4.17')).toMatchObject({
        disposition: 'external-prerequisite',
        deploymentOwner: 'bepinex',
        resolution: 'bepinex-component-inventory',
        requiredVersion: '5.4.17',
        directPluginAcquisitionAllowed: false
      })
    }
  )

  it('fails closed for a reserved platform package identity under an unreviewed owner', () => {
    expect(route('FictionalFork', 'NebulaMultiplayerMod', '0.9.22')).toMatchObject({
      disposition: 'unsupported-platform-package',
      deploymentOwner: null,
      resolution: 'manual-policy-required',
      directPluginAcquisitionAllowed: false
    })
    expect(route('FictionalFork', 'BepInExPack', '5.4.17')).toMatchObject({
      disposition: 'unsupported-platform-package',
      deploymentOwner: null,
      resolution: 'manual-policy-required',
      directPluginAcquisitionAllowed: false
    })
  })

  it('allows a normal exact dependency only through the mod import pipeline', () => {
    expect(route('Fictional', 'ServerHelper', '1.2.3')).toEqual({
      dependencyId: 'Fictional-ServerHelper-1.2.3',
      sourceId: 'thunderstore:Fictional/ServerHelper',
      requiredVersion: '1.2.3',
      disposition: 'plugin',
      deploymentOwner: 'mods',
      resolution: 'mod-import-pipeline',
      directPluginAcquisitionAllowed: true
    })
    expect(routeThunderstoreDependencyId('Fictional-ServerHelper-1.2.3'))
      .toEqual(route('Fictional', 'ServerHelper', '1.2.3'))
  })

  it('normalizes trusted manifest dependencies into plugin edges and exact platform requirements', () => {
    expect(partitionThunderstorePluginDependencies([
      'xiaoye97-BepInEx-5.4.17',
      'Fictional-Utility-1.0.0',
      'nebula-NebulaMultiplayerModApi-2.1.0',
      'FictionalFork-NebulaMultiplayerMod-0.9.22'
    ])).toEqual({
      pluginDependencyIds: ['Fictional-Utility-1.0.0'],
      platformRequirements: [
        expect.objectContaining({
          dependencyId: 'nebula-NebulaMultiplayerModApi-2.1.0',
          disposition: 'managed-component',
          requiredVersion: '2.1.0'
        }),
        expect.objectContaining({
          dependencyId: 'xiaoye97-BepInEx-5.4.17',
          disposition: 'external-prerequisite',
          requiredVersion: '5.4.17'
        })
      ],
      unsupportedRequirements: [
        expect.objectContaining({
          dependencyId: 'FictionalFork-NebulaMultiplayerMod-0.9.22',
          disposition: 'unsupported-platform-package'
        })
      ]
    })
  })

  it('fails closed on duplicate or conflicting exact manifest dependencies', () => {
    expect(() => partitionThunderstorePluginDependencies([
      'Fictional-Utility-1.0.0',
      'Fictional-Utility-1.0.0'
    ])).toThrow('THUNDERSTORE_DEPENDENCY_DUPLICATE')
    expect(() => partitionThunderstorePluginDependencies([
      'Fictional-Utility-1.0.0',
      'Fictional-Utility-2.0.0'
    ])).toThrow('THUNDERSTORE_DEPENDENCY_VERSION_CONFLICT')
  })

  it.each([
    'https://thunderstore.io/package/download/Fictional/Utility/1.0.0/',
    'C:\\fictional\\Utility-1.0.0.zip',
    '../Utility-1.0.0.zip',
    'Fictional-Utility-1.0.0.zip'
  ])('rejects URL, path, and archive-shaped dependency input: %s', (input) => {
    expect(() => routeThunderstoreDependencyId(input)).toThrow()
    expect(() => partitionThunderstorePluginDependencies([input])).toThrow()
  })

  it('rejects inconsistent identity fields instead of routing on a display name', () => {
    expect(() => routeThunderstoreDependency({
      dependencyId: 'nebula-NebulaMultiplayerMod-0.9.22',
      sourceId: 'thunderstore:Fictional/ServerHelper',
      namespace: 'Fictional',
      name: 'ServerHelper',
      version: '0.9.22'
    })).toThrow('THUNDERSTORE_IDENTITY_MISMATCH')
  })
})

function route(namespace: string, name: string, version: string) {
  return routeThunderstoreDependency({
    dependencyId: `${namespace}-${name}-${version}`,
    sourceId: `thunderstore:${namespace}/${name}`,
    namespace,
    name,
    version
  })
}

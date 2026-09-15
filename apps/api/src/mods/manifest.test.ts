import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  generateModManifests,
  serializeClientParityManifest,
  serializeServerModLock,
  validateClientParity,
  validateModManifestPair,
  validateServerLock
} from './manifest.js'

const hash = (character: string): string => character.repeat(64)
const input = {
  roots: ['Fictional-MultiplayerRoot-2.0.0'],
  packages: [
    {
      dependencyId: 'Fictional-MultiplayerRoot-2.0.0', sha256: hash('b'),
      dependencies: ['Fictional-ServerHelper-1.0.0'],
      serverRequired: true, clientRequirement: 'required' as const
    },
    {
      dependencyId: 'Fictional-ServerHelper-1.0.0', sha256: hash('a'), dependencies: [],
      serverRequired: true, clientRequirement: 'not-required' as const
    }
  ]
}

describe('server mod lock and client parity manifests', () => {
  it('generates reproducible path-free manifests with exact source, version, hash, and requirements', () => {
    const generated = generateModManifests(input)
    const repeated = generateModManifests({ roots: input.roots, packages: [...input.packages].reverse() })
    expect(repeated).toEqual(generated)
    expect(generated.serverLockSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(createHash('sha256').update(serializeServerModLock(generated.serverLock), 'utf8').digest('hex'))
      .toBe(generated.serverLockSha256)
    expect(generated.clientParity.serverLockSha256).toBe(generated.serverLockSha256)
    expect(validateModManifestPair(generated.serverLock, generated.clientParity)).toEqual(generated)
    expect(generated.serverLock.mods[0]).toEqual({
      dependencyId: 'Fictional-ServerHelper-1.0.0',
      sourceId: 'thunderstore:Fictional/ServerHelper',
      version: '1.0.0',
      sha256: hash('a'),
      dependencies: [],
      loadOrder: 0,
      root: false,
      serverRequired: true,
      clientRequirement: 'not-required'
    })
    expect(generated.clientParity.mods[1]).toMatchObject({
      sourceId: 'thunderstore:Fictional/MultiplayerRoot',
      version: '2.0.0', sha256: hash('b'), serverRequired: true, clientRequirement: 'required'
    })
    const serialized = `${serializeServerModLock(generated.serverLock)}${serializeClientParityManifest(generated.clientParity)}`
    expect(serialized).not.toMatch(/(?:[A-Za-z]:\\|\\\\|https?:\/\/|token|credential|password)/i)
  })

  it('rejects unresolved graphs and externally supplied malformed manifests', () => {
    expect(() => generateModManifests({
      roots: ['Fictional-Missing-1.0.0'], packages: input.packages
    })).toThrow('MOD_GRAPH_UNRESOLVED')

    const generated = generateModManifests(input)
    expect(() => validateServerLock({ ...generated.serverLock, hostPath: 'C:\\Fictional' })).toThrow()
    expect(() => validateServerLock({
      ...generated.serverLock,
      mods: generated.serverLock.mods.map((mod) => ({ ...mod, loadOrder: 1 }))
    })).toThrow('MOD_LOCK_ORDER_INVALID')
    expect(() => validateServerLock({
      ...generated.serverLock,
      mods: generated.serverLock.mods.map((mod) => mod.loadOrder === 0
        ? { ...mod, dependencies: ['Fictional-MultiplayerRoot-2.0.0'] }
        : mod)
    })).toThrow('MOD_LOCK_TOPOLOGY_INVALID')
    expect(() => validateClientParity({
      ...generated.clientParity,
      mods: [...generated.clientParity.mods, generated.clientParity.mods[0]]
    })).toThrow('CLIENT_PARITY_SOURCE_DUPLICATE')
    expect(() => validateModManifestPair(generated.serverLock, {
      ...generated.clientParity, serverLockSha256: hash('f')
    })).toThrow('CLIENT_PARITY_LOCK_DIGEST_MISMATCH')
  })
})

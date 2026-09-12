import { describe, expect, it } from 'vitest'
import { resolveModGraph } from './resolver.js'

const hash = (character: string): string => character.repeat(64)

const packages = [
  {
    dependencyId: 'Fictional-CoreLib-1.0.0', sha256: hash('1'), dependencies: [],
    serverRequired: true, clientRequirement: 'required' as const
  },
  {
    dependencyId: 'Fictional-NetworkLib-2.0.0', sha256: hash('2'),
    dependencies: ['Fictional-CoreLib-1.0.0'],
    serverRequired: true, clientRequirement: 'required' as const
  },
  {
    dependencyId: 'Fictional-ServerHelper-3.0.0', sha256: hash('3'),
    dependencies: ['Fictional-CoreLib-1.0.0'],
    serverRequired: true, clientRequirement: 'not-required' as const
  },
  {
    dependencyId: 'Fictional-MultiplayerRoot-4.0.0', sha256: hash('4'),
    dependencies: ['Fictional-NetworkLib-2.0.0', 'Fictional-ServerHelper-3.0.0'],
    serverRequired: true, clientRequirement: 'required' as const
  }
]

describe('deterministic mod dependency resolution', () => {
  it('resolves the complete dependency closure with dependencies before dependents', () => {
    const result = resolveModGraph({ roots: ['Fictional-MultiplayerRoot-4.0.0'], packages })
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.mods.map((mod) => mod.dependencyId)).toEqual([
      'Fictional-CoreLib-1.0.0',
      'Fictional-NetworkLib-2.0.0',
      'Fictional-ServerHelper-3.0.0',
      'Fictional-MultiplayerRoot-4.0.0'
    ])
    expect(result.mods.map((mod) => mod.loadOrder)).toEqual([0, 1, 2, 3])
    expect(result.mods.filter((mod) => mod.root).map((mod) => mod.name)).toEqual(['MultiplayerRoot'])
  })

  it('is independent of catalog and root input ordering', () => {
    const forward = resolveModGraph({
      roots: ['Fictional-MultiplayerRoot-4.0.0', 'Fictional-ServerHelper-3.0.0'], packages
    })
    const reversed = resolveModGraph({
      roots: ['Fictional-ServerHelper-3.0.0', 'Fictional-MultiplayerRoot-4.0.0'],
      packages: [...packages].reverse()
    })
    expect(reversed).toEqual(forward)
  })

  it('reports exact missing and conflicting versions with every requester', () => {
    const result = resolveModGraph({
      roots: ['Fictional-RootA-1.0.0', 'Fictional-RootB-1.0.0'],
      packages: [
        {
          dependencyId: 'Fictional-RootA-1.0.0', sha256: hash('a'),
          dependencies: ['Fictional-Shared-1.0.0'], serverRequired: true, clientRequirement: 'required'
        },
        {
          dependencyId: 'Fictional-RootB-1.0.0', sha256: hash('b'),
          dependencies: ['Fictional-Shared-2.0.0'], serverRequired: true, clientRequirement: 'required'
        },
        {
          dependencyId: 'Fictional-Shared-1.0.0', sha256: hash('c'), dependencies: [],
          serverRequired: true, clientRequirement: 'required'
        }
      ]
    })
    expect(result.ok).toBe(false)
    expect(result.mods.every((mod) => mod.loadOrder === null)).toBe(true)
    expect(result.issues).toEqual([
      {
        type: 'missing', dependencyId: 'Fictional-Shared-2.0.0',
        requestedBy: ['Fictional-RootB-1.0.0']
      },
      {
        type: 'conflict', sourceId: 'thunderstore:Fictional/Shared', versions: [
          { version: '1.0.0', requestedBy: ['Fictional-RootA-1.0.0'] },
          { version: '2.0.0', requestedBy: ['Fictional-RootB-1.0.0'] }
        ]
      }
    ])
  })

  it('detects cycles and emits the same canonical cycle regardless of root choice', () => {
    const cyclePackages = [
      {
        dependencyId: 'Fictional-Alpha-1.0.0', sha256: hash('a'),
        dependencies: ['Fictional-Beta-1.0.0'], serverRequired: true, clientRequirement: 'required'
      },
      {
        dependencyId: 'Fictional-Beta-1.0.0', sha256: hash('b'),
        dependencies: ['Fictional-Alpha-1.0.0'], serverRequired: true, clientRequirement: 'required'
      }
    ]
    const result = resolveModGraph({ roots: ['Fictional-Beta-1.0.0'], packages: cyclePackages })
    expect(result.ok).toBe(false)
    expect(result.issues).toEqual([{
      type: 'cycle',
      dependencyIds: ['Fictional-Alpha-1.0.0', 'Fictional-Beta-1.0.0', 'Fictional-Alpha-1.0.0']
    }])
  })

  it('rejects duplicate, unknown, irrelevant, and oversized input before traversal', () => {
    expect(() => resolveModGraph({ roots: ['Fictional-CoreLib-1.0.0'], packages: [packages[0], packages[0]] }))
      .toThrow('MOD_PACKAGE_DUPLICATE')
    expect(() => resolveModGraph({
      roots: ['Fictional-CoreLib-1.0.0'], packages: [{ ...packages[0], hostPath: 'C:\\Fictional' }]
    })).toThrow()
    expect(() => resolveModGraph({
      roots: ['Fictional-ClientInvisible-1.0.0'],
      packages: [{
        dependencyId: 'Fictional-ClientInvisible-1.0.0', sha256: hash('f'), dependencies: [],
        serverRequired: false, clientRequirement: 'not-required'
      }]
    })).toThrow()
    expect(() => resolveModGraph({
      roots: Array.from({ length: 129 }, (_, index) => `Fictional_Root${index}-Package-1.0.0`),
      packages: [packages[0]]
    })).toThrow()
  })
})

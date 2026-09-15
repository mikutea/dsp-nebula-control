import { describe, expect, it } from 'vitest'
import { formatThunderstoreDependency, parseThunderstoreDependency } from './dependency.js'

describe('Thunderstore dependency identifiers', () => {
  it('parses and normalizes an exact Thunderstore dependency identity', () => {
    expect(parseThunderstoreDependency('NebulaModTeam-NebulaMultiplayerMod-0.09.022')).toEqual({
      namespace: 'NebulaModTeam',
      name: 'NebulaMultiplayerMod',
      version: '0.9.22',
      sourceId: 'thunderstore:NebulaModTeam/NebulaMultiplayerMod',
      dependencyId: 'NebulaModTeam-NebulaMultiplayerMod-0.9.22'
    })
  })

  it('formats only a strict, bounded identity object', () => {
    expect(formatThunderstoreDependency({ namespace: 'Fictional', name: 'ServerHelper', version: '1.2.3' }))
      .toMatchObject({ dependencyId: 'Fictional-ServerHelper-1.2.3' })
    expect(() => formatThunderstoreDependency({
      namespace: 'Fictional', name: 'ServerHelper', version: '1.2.3', downloadUrl: 'https://example.com'
    })).toThrow()
    expect(() => parseThunderstoreDependency('Fictional-Package-1.2.3-extra')).toThrow()
    expect(() => parseThunderstoreDependency(`Fictional-${'x'.repeat(65)}-1.2.3`)).toThrow()
  })
})

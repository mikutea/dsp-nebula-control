import { describe, expect, it } from 'vitest'
import { evaluateCompatibility } from './compatibility.js'

const inventory = {
  dsp: '0.10.34.28529',
  nebula: '0.9.22.2',
  bepInEx: '5.4.17.0',
  plugins: [
    { sourceId: 'thunderstore:NebulaModTeam/NebulaMultiplayerMod', version: '0.9.22.2' }
  ]
}

const matchingEntry = {
  id: 'dsp-0.10.34-nebula-0.9.22',
  core: {
    dsp: { minInclusive: '0.10.34.0', maxExclusive: '0.10.35.0' },
    nebula: { minInclusive: '0.9.22', maxExclusive: '0.9.23' },
    bepInEx: { minInclusive: '5.4.17', maxExclusive: '6.0.0' }
  },
  plugins: [{
    sourceId: 'thunderstore:NebulaModTeam/NebulaMultiplayerMod',
    range: { equals: '0.9.22.2' },
    required: true
  }]
}

describe('compatibility matrix evaluation', () => {
  it('normalizes inventory versions and selects the first compatible entry by stable ID', () => {
    const decision = evaluateCompatibility(inventory, {
      schemaVersion: 1,
      entries: [{ ...matchingEntry, id: 'z-match' }, { ...matchingEntry, id: 'a-match' }]
    })
    expect(decision.compatible).toBe(true)
    expect(decision.matchedEntryId).toBe('a-match')
    expect(decision.inventory).toEqual(inventory)
    expect(decision.evaluations.map((entry) => entry.entryId)).toEqual(['a-match', 'z-match'])
  })

  it('reports core, missing-plugin, and installed-plugin mismatches without guessing compatibility', () => {
    const decision = evaluateCompatibility({
      ...inventory,
      nebula: '0.9.21.0',
      plugins: [{ sourceId: 'thunderstore:Fictional/OptionalMod', version: '2.0.0' }]
    }, {
      schemaVersion: 1,
      entries: [{
        ...matchingEntry,
        plugins: [
          ...matchingEntry.plugins,
          {
            sourceId: 'thunderstore:Fictional/OptionalMod',
            range: { maxExclusive: '2.0.0' },
            required: false
          }
        ]
      }]
    })
    expect(decision.compatible).toBe(false)
    expect(decision.matchedEntryId).toBeNull()
    expect(decision.evaluations[0]?.reasons.map((reason) => reason.code)).toEqual([
      'nebula-version-mismatch', 'plugin-version-mismatch', 'plugin-missing'
    ])
  })

  it('rejects duplicate identities, oversized collections, and unknown fields', () => {
    expect(() => evaluateCompatibility({
      ...inventory,
      plugins: [inventory.plugins[0], inventory.plugins[0]]
    }, { schemaVersion: 1, entries: [matchingEntry] })).toThrow('RUNTIME_PLUGIN_DUPLICATE')

    expect(() => evaluateCompatibility(inventory, {
      schemaVersion: 1, entries: [matchingEntry, matchingEntry]
    })).toThrow('COMPATIBILITY_ENTRY_DUPLICATE')

    expect(() => evaluateCompatibility({ ...inventory, hostPath: 'C:\\Fictional' }, {
      schemaVersion: 1, entries: [matchingEntry]
    })).toThrow()

    expect(() => evaluateCompatibility(inventory, {
      schemaVersion: 1, entries: Array.from({ length: 129 }, (_, index) => ({
        ...matchingEntry, id: `entry-${index}`
      }))
    })).toThrow()
  })
})

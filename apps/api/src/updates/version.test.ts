import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  formatVersionRange,
  normalizeVersion,
  normalizeVersionRange,
  versionSatisfies
} from './version.js'

describe('version normalization and comparison', () => {
  it('normalizes the four-part DSP, Nebula, and BepInEx versions used by the server', () => {
    expect(normalizeVersion(' v0.10.034.028529 ', 'dsp')).toBe('0.10.34.28529')
    expect(normalizeVersion('V0.9.22.2', 'nebula')).toBe('0.9.22.2')
    expect(normalizeVersion('5.4.017.0', 'bepinex')).toBe('5.4.17.0')
  })

  it('uses SemVer prerelease ordering and ignores build metadata for precedence', () => {
    expect(compareVersions('1.2.3-rc.2', '1.2.3-rc.10', 'plugin')).toBe(-1)
    expect(compareVersions('1.2.3-999999999999999999', '1.2.3-1000000000000000000', 'plugin')).toBe(-1)
    expect(compareVersions('1.2.3-rc.10', '1.2.3', 'plugin')).toBe(-1)
    expect(compareVersions('1.2.3+build.1', '1.2.3+build.2', 'plugin')).toBe(0)
  })

  it('evaluates normalized structured ranges deterministically', () => {
    const range = { minInclusive: '0.9.22', maxExclusive: '0.10.0' }
    expect(normalizeVersionRange(range, 'nebula')).toEqual({
      minInclusive: '0.9.22', maxExclusive: '0.10.0'
    })
    expect(versionSatisfies('0.9.22.2', range, 'nebula')).toBe(true)
    expect(versionSatisfies('0.10.0', range, 'nebula')).toBe(false)
    expect(formatVersionRange(range, 'nebula')).toBe('>=0.9.22 <0.10.0')
  })

  it('rejects malformed, unbounded, contradictory, and unknown-field input', () => {
    expect(() => normalizeVersion('0.10.34', 'dsp')).toThrow('VERSION_COMPONENT_COUNT_INVALID')
    expect(() => normalizeVersion('1.2.3-01', 'plugin')).toThrow('VERSION_PRERELEASE_INVALID')
    expect(() => normalizeVersion('99999999999.2.3', 'plugin')).toThrow('VERSION_SEGMENT_INVALID')
    expect(() => normalizeVersionRange({}, 'plugin')).toThrow()
    expect(() => normalizeVersionRange({ minInclusive: '2.0.0', maxExclusive: '1.0.0' }, 'plugin'))
      .toThrow('VERSION_RANGE_EMPTY')
    expect(() => normalizeVersionRange({ equals: '1.0.0', typo: 'accepted' }, 'plugin')).toThrow()
  })
})

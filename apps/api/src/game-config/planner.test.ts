import { describe, expect, it } from 'vitest'
import { applyBepInExPatches, findBepInExValue, parseBepInExAssignments } from './bepinex.js'
import { inspectGameConfiguration, planGameConfiguration, type GameConfigFiles } from './planner.js'

const files: GameConfigFiles = {
  nebula: '[Nebula - Settings]\r\n# Keep this comment\r\nAutoPauseEnabled = true\r\nServerPassword = fictional-existing-password\r\n',
  galaxy: '[Basic]\nstarCount = 64\nresourceMultiplier = 1\n\n[General]\nisPeaceMode = false\n',
  bepinex: '[Logging.Console]\nEnabled = false\n',
  bridge: '[Bridge]\nEnabled = false\n'
}

describe('BepInEx configuration parser', () => {
  it('reads the last matching assignment and preserves unrelated lines while patching', () => {
    const source = '[General]\r\n# note\r\nValue = old\r\nValue = current\r\n\r\n[Other]\r\nKeep = yes\r\n'
    expect(findBepInExValue(source, 'general', 'value')).toBe('current')
    expect(parseBepInExAssignments(source)).toHaveLength(3)
    const patched = applyBepInExPatches(source, [
      { section: 'General', key: 'Value', value: 'next' },
      { section: 'Other', key: 'Added', value: '42' },
      { section: 'New', key: 'Enabled', value: 'true' }
    ])
    expect(patched).toContain('# note\r\nValue = old\r\nValue = next')
    expect(patched).toContain('[Other]\r\nKeep = yes\r\nAdded = 42')
    expect(patched).toContain('[New]\r\nEnabled = true\r\n')
  })
})

describe('game configuration planner', () => {
  it('returns typed values but only a configured bit for secrets', () => {
    const snapshot = inspectGameConfiguration(files)
    expect(snapshot.entries.find((entry) => entry.id === 'nebula.auto-pause')).toMatchObject({
      value: true, source: 'file'
    })
    expect(snapshot.entries.find((entry) => entry.id === 'nebula.server-password')).toMatchObject({
      value: { configured: true }, source: 'file'
    })
    expect(JSON.stringify(snapshot)).not.toContain('fictional-existing-password')
  })

  it('creates a redacted deterministic diff and revised file set', () => {
    const snapshot = inspectGameConfiguration(files)
    const plan = planGameConfiguration(files, snapshot.revision, [
      { id: 'nebula.server-password', value: 'fictional-new-password' },
      { id: 'bepinex.console-enabled', value: true },
      { id: 'galaxy.resource-multiplier', value: 8 }
    ])
    expect(plan).toMatchObject({ restartRequired: true, newGameOnlyChanged: true })
    expect(plan.nextRevision).not.toBe(plan.baseRevision)
    expect(plan.diff[0]).toMatchObject({
      id: 'nebula.server-password', before: { configured: true }, after: { configured: true }, changed: true
    })
    expect(JSON.stringify(plan.diff)).not.toContain('fictional-new-password')
    expect(plan.files.nebula).toContain('ServerPassword = fictional-new-password')
    expect(plan.files.bepinex).toContain('Enabled = true')
    expect(plan.files.galaxy).toContain('resourceMultiplier = 8')
  })

  it('rejects stale revisions, unknown fields, duplicates, and out-of-range values', () => {
    const revision = inspectGameConfiguration(files).revision
    expect(() => planGameConfiguration(files, '0'.repeat(64), [{ id: 'galaxy.star-count', value: 64 }]))
      .toThrowError('CONFIG_REVISION_CONFLICT')
    expect(() => planGameConfiguration(files, revision, [{ id: 'unknown', value: true }]))
      .toThrowError('CONFIG_SETTING_UNKNOWN')
    expect(() => planGameConfiguration(files, revision, [
      { id: 'galaxy.star-count', value: 64 }, { id: 'galaxy.star-count', value: 63 }
    ])).toThrowError('CONFIG_CHANGE_DUPLICATE')
    expect(() => planGameConfiguration(files, revision, [{ id: 'galaxy.star-count', value: 128 }]))
      .toThrowError('CONFIG_VALUE_OUT_OF_RANGE')
  })

  it('marks malformed stored values without echoing their content', () => {
    const snapshot = inspectGameConfiguration({ ...files, galaxy: '[Basic]\nstarCount = definitely-not-a-number\n' })
    expect(snapshot.invalidSettingIds).toContain('galaxy.star-count')
    expect(snapshot.entries.find((entry) => entry.id === 'galaxy.star-count')).toMatchObject({
      value: 64, source: 'invalid'
    })
  })
})

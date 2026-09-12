import { describe, expect, it } from 'vitest'
import { rollbackWarningsApproved } from './rollback-health-policy.js'

const inventory = { dsp: '0.10.34.28529', nebula: '0.9.22.2', bepInEx: '5.4.17.0', plugins: [] }
const matrix = { schemaVersion: 1, entries: [{ id: 'reviewed-predecessor',
  core: { dsp: { equals: inventory.dsp }, nebula: { equals: inventory.nebula },
    bepInEx: { equals: inventory.bepInEx } }, plugins: [] }] }
const warnings = ['mod-bepinex-target-mismatch']
const approvals = [{ entryId: 'reviewed-predecessor', warnings }]
const input = { phase: 'rollback' as const, approvals, matrix, inventory, warnings }

describe('explicit predecessor warning approval', () => {
  it('accepts only the matched reviewed predecessor and exact warning', () => {
    expect(rollbackWarningsApproved(input)).toBe(true)
    expect(rollbackWarningsApproved({ ...input, inventory: { ...inventory, bepInEx: '5.4.23.5' } })).toBe(false)
    expect(rollbackWarningsApproved({ ...input, approvals: [{ entryId: 'other', warnings }] })).toBe(false)
  })
  it('never relaxes candidate health or accepts missing authority and extra warnings', () => {
    for (const change of [{ phase: 'candidate' as const }, { phase: 'reconcile-candidate' as const },
      { approvals: undefined }, { warnings: ['game-load-incomplete'] },
      { warnings: [...warnings, 'game-load-incomplete'] }, { approvals: [...approvals, ...approvals] }]) {
      expect(rollbackWarningsApproved({ ...input, ...change })).toBe(false)
    }
  })
})

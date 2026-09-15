import { describe, expect, it } from 'vitest'
import { createUpdatePlan, transitionUpdatePlan, type UpdatePlan } from './plan.js'

const oldHash = '1'.repeat(64)
const newHash = '2'.repeat(64)

function fixturePlan(): UpdatePlan {
  return createUpdatePlan({
    planId: 'plan-fixture-0001',
    createdAt: '2026-08-30T10:00:00.000+08:00',
    targets: [
      {
        targetId: 'thunderstore:Fictional/ServerHelper', kind: 'plugin',
        current: { sourceId: 'thunderstore:Fictional/ServerHelper', version: '1.0.0', sha256: oldHash },
        candidate: { sourceId: 'thunderstore:Fictional/ServerHelper', version: '1.1.0', sha256: newHash }
      },
      {
        targetId: 'nebula', kind: 'nebula',
        current: { sourceId: 'github:NebulaModTeam/Nebula', version: '0.9.22.1', sha256: oldHash },
        candidate: { sourceId: 'github:NebulaModTeam/Nebula', version: '0.9.22.2', sha256: newHash }
      }
    ]
  })
}

function event(type: string, seconds: number, extra: Record<string, string> = {}): Record<string, string> {
  return { type, at: `2026-08-30T02:00:${String(seconds).padStart(2, '0')}.000Z`, ...extra }
}

describe('update plan state machine', () => {
  it('tracks a complete stage and activation transaction in a fixed target order', () => {
    let plan = fixturePlan()
    expect(plan.targets.map((target) => target.targetId)).toEqual([
      'nebula', 'thunderstore:Fictional/ServerHelper'
    ])
    plan = transitionUpdatePlan(plan, event('begin-staging', 1))
    for (const target of plan.targets) plan = transitionUpdatePlan(plan, event('mark-staged', 2, { targetId: target.targetId }))
    plan = transitionUpdatePlan(plan, event('complete-staging', 3))
    plan = transitionUpdatePlan(plan, event('begin-activation', 4))
    for (const target of plan.targets) plan = transitionUpdatePlan(plan, event('mark-activated', 5, { targetId: target.targetId }))
    plan = transitionUpdatePlan(plan, event('complete-activation', 6))
    expect(plan).toMatchObject({ state: 'active', revision: 8, rollbackRequired: false, failure: null })
    expect(plan.targets.every((target) => target.state === 'active')).toBe(true)
  })

  it('requires rollback after a partial activation failure and records restoration target by target', () => {
    let plan = fixturePlan()
    plan = transitionUpdatePlan(plan, event('begin-staging', 1))
    for (const target of plan.targets) plan = transitionUpdatePlan(plan, event('mark-staged', 2, { targetId: target.targetId }))
    plan = transitionUpdatePlan(plan, event('complete-staging', 3))
    plan = transitionUpdatePlan(plan, event('begin-activation', 4))
    plan = transitionUpdatePlan(plan, event('mark-activated', 5, { targetId: 'nebula' }))
    plan = transitionUpdatePlan(plan, event('fail', 6, { errorCode: 'HEALTH_CHECK_FAILED', summary: 'Fictional health gate failed.' }))
    expect(plan).toMatchObject({ state: 'failed', rollbackRequired: true, failure: { phase: 'activation' } })
    plan = transitionUpdatePlan(plan, event('begin-rollback', 7))
    for (const target of plan.targets) {
      plan = transitionUpdatePlan(plan, event('mark-rolled-back', 8, { targetId: target.targetId }))
    }
    plan = transitionUpdatePlan(plan, event('complete-rollback', 9))
    expect(plan.state).toBe('rolled-back')
    expect(plan.rollbackRequired).toBe(false)
    expect(plan.targets.every((target) => target.state === 'rolled-back')).toBe(true)
  })

  it('rejects incomplete phases, invalid identities, time reversal, and unknown fields', () => {
    const plan = transitionUpdatePlan(fixturePlan(), event('begin-staging', 1))
    expect(() => transitionUpdatePlan(plan, event('complete-staging', 2))).toThrow('UPDATE_STAGING_INCOMPLETE')
    expect(() => transitionUpdatePlan(plan, event('mark-staged', 2, { targetId: 'missing' })))
      .toThrow('UPDATE_TARGET_UNKNOWN')
    expect(() => transitionUpdatePlan(plan, {
      ...event('mark-staged', 0, { targetId: 'nebula' }), command: 'unbounded'
    })).toThrow()
    expect(() => transitionUpdatePlan(plan, event('mark-staged', 0, { targetId: 'nebula' })))
      .toThrow('UPDATE_EVENT_TIME_REVERSED')
    expect(() => createUpdatePlan({
      planId: 'plan-invalid-0001', createdAt: '2026-08-30T02:00:00.000Z',
      targets: [{
        targetId: 'wrong', kind: 'nebula',
        current: { sourceId: 'github:Fictional/Nebula', version: '0.9.0', sha256: oldHash },
        candidate: { sourceId: 'github:Fictional/Nebula', version: '0.9.1', sha256: newHash }
      }]
    })).toThrow('UPDATE_CORE_IDENTITY_MISMATCH')
  })
})

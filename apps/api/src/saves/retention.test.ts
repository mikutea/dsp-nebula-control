import { describe, expect, it } from 'vitest'
import { planBackupRetention } from './retention.js'

describe('backup retention planning', () => {
  it('produces a deterministic dry-run plan without deleting or mutating candidates', () => {
    const candidates = [
      candidate('backup-01', '2026-08-30T12:00:00.000Z'),
      candidate('backup-02', '2026-08-30T08:00:00.000Z'),
      candidate('backup-03', '2026-08-29T12:00:00.000Z'),
      candidate('backup-04', '2026-08-22T12:00:00.000Z'),
      candidate('backup-05', '2026-08-10T12:00:00.000Z', 'healthy', true),
      candidate('backup-bad', '2026-08-28T12:00:00.000Z', 'corrupt')
    ]
    const snapshot = structuredClone(candidates)
    const plan = planBackupRetention({
      referenceTime: '2026-08-30T18:00:00.000Z',
      policy: {
        keepLastHealthy: 1,
        keepDailyDays: 2,
        keepWeeklyWeeks: 2,
        minimumHealthy: 2,
        allowUnhealthyDeletion: false
      },
      candidates
    })

    expect(plan.mode).toBe('dry-run')
    expect(candidates).toEqual(snapshot)
    expect(plan.keep).toEqual([
      { backupId: 'backup-01', reasons: ['latest-healthy', 'minimum-healthy', 'daily', 'weekly'] },
      { backupId: 'backup-02', reasons: ['minimum-healthy'] },
      { backupId: 'backup-03', reasons: ['daily'] },
      { backupId: 'backup-04', reasons: ['weekly'] },
      { backupId: 'backup-05', reasons: ['protected'] }
    ])
    expect(plan.delete).toEqual([])
    expect(plan.blocked).toEqual([
      { backupId: 'backup-bad', reason: 'unhealthy-backup' }
    ])
  })

  it('plans out-of-policy and explicitly enabled unhealthy deletion but never executes it', () => {
    const plan = planBackupRetention({
      referenceTime: '2026-08-30T18:00:00.000Z',
      policy: {
        keepLastHealthy: 1,
        keepDailyDays: 0,
        keepWeeklyWeeks: 0,
        minimumHealthy: 1,
        allowUnhealthyDeletion: true
      },
      candidates: [
        candidate('backup-new', '2026-08-30T12:00:00.000Z'),
        candidate('backup-old', '2026-07-01T12:00:00.000Z'),
        candidate('backup-bad', '2026-06-01T12:00:00.000Z', 'incomplete')
      ]
    })
    expect(plan.keep.map((entry) => entry.backupId)).toEqual(['backup-new'])
    expect(plan.delete).toEqual([
      { backupId: 'backup-old', reason: 'outside-policy' },
      { backupId: 'backup-bad', reason: 'unhealthy-deletion-enabled' }
    ])
    expect(plan.blocked).toEqual([])
  })

  it('strictly rejects unknown policy fields and duplicate backup identities', () => {
    const request = {
      referenceTime: '2026-08-30T18:00:00.000Z',
      policy: {
        keepLastHealthy: 1,
        keepDailyDays: 0,
        keepWeeklyWeeks: 0,
        minimumHealthy: 1,
        allowUnhealthyDeletion: false
      },
      candidates: [candidate('backup-one', '2026-08-30T12:00:00.000Z')]
    }
    expect(() => planBackupRetention({
      ...request,
      policy: { ...request.policy, deleteRoot: 'C:\\not-accepted' }
    })).toThrow()
    expect(() => planBackupRetention({
      ...request,
      candidates: [...request.candidates, ...request.candidates]
    })).toThrow('DUPLICATE_BACKUP_ID')
  })
})

function candidate(
  backupId: string,
  createdAt: string,
  health: 'healthy' | 'incomplete' | 'corrupt' = 'healthy',
  protectedBackup = false
): { backupId: string, createdAt: string, health: 'healthy' | 'incomplete' | 'corrupt', protected: boolean } {
  return { backupId, createdAt, health, protected: protectedBackup }
}

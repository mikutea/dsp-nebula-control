import {
  retentionPlanRequestSchema,
  retentionPlanSchema,
  type RetentionPlan,
  type RetentionPlanRequest
} from './schemas.js'

type KeepReason = RetentionPlan['keep'][number]['reasons'][number]

const KEEP_REASON_ORDER: KeepReason[] = [
  'protected', 'latest-healthy', 'minimum-healthy', 'daily', 'weekly'
]

export function planBackupRetention(input: unknown): RetentionPlan {
  const request = retentionPlanRequestSchema.parse(input) as RetentionPlanRequest
  assertUniqueBackupIds(request)
  const referenceTime = new Date(request.referenceTime)
  const ordered = [...request.candidates].sort((left, right) => {
    const timeDifference = Date.parse(right.createdAt) - Date.parse(left.createdAt)
    if (timeDifference !== 0) return timeDifference
    return left.backupId < right.backupId ? -1 : left.backupId > right.backupId ? 1 : 0
  })
  const healthy = ordered.filter((candidate) => candidate.health === 'healthy')
  const reasons = new Map<string, Set<KeepReason>>()
  const keep = (backupId: string, reason: KeepReason): void => {
    const values = reasons.get(backupId) ?? new Set<KeepReason>()
    values.add(reason)
    reasons.set(backupId, values)
  }

  for (const candidate of ordered) {
    if (candidate.protected) keep(candidate.backupId, 'protected')
  }
  for (const candidate of healthy.slice(0, request.policy.keepLastHealthy)) {
    keep(candidate.backupId, 'latest-healthy')
  }
  for (const candidate of healthy.slice(0, request.policy.minimumHealthy)) {
    keep(candidate.backupId, 'minimum-healthy')
  }

  selectDaily(healthy, referenceTime, request.policy.keepDailyDays, keep)
  selectWeekly(healthy, referenceTime, request.policy.keepWeeklyWeeks, keep)

  const keepDecisions: RetentionPlan['keep'] = []
  const deleteDecisions: RetentionPlan['delete'] = []
  const blockedDecisions: RetentionPlan['blocked'] = []
  for (const candidate of ordered) {
    const candidateReasons = reasons.get(candidate.backupId)
    if (candidateReasons !== undefined) {
      keepDecisions.push({
        backupId: candidate.backupId,
        reasons: KEEP_REASON_ORDER.filter((reason) => candidateReasons.has(reason))
      })
    } else if (candidate.health !== 'healthy' && !request.policy.allowUnhealthyDeletion) {
      blockedDecisions.push({ backupId: candidate.backupId, reason: 'unhealthy-backup' })
    } else {
      deleteDecisions.push({
        backupId: candidate.backupId,
        reason: candidate.health === 'healthy' ? 'outside-policy' : 'unhealthy-deletion-enabled'
      })
    }
  }

  return retentionPlanSchema.parse({
    schemaVersion: 1,
    mode: 'dry-run',
    referenceTime: request.referenceTime,
    policy: request.policy,
    keep: keepDecisions,
    delete: deleteDecisions,
    blocked: blockedDecisions
  })
}

function selectDaily(
  healthy: RetentionPlanRequest['candidates'],
  referenceTime: Date,
  days: number,
  keep: (backupId: string, reason: KeepReason) => void
): void {
  if (days === 0) return
  const selectedDays = new Set<string>()
  const referenceDay = utcDayNumber(referenceTime)
  for (const candidate of healthy) {
    const createdAt = new Date(candidate.createdAt)
    const ageDays = referenceDay - utcDayNumber(createdAt)
    if (ageDays < 0 || ageDays >= days) continue
    const dayKey = createdAt.toISOString().slice(0, 10)
    if (selectedDays.has(dayKey)) continue
    selectedDays.add(dayKey)
    keep(candidate.backupId, 'daily')
  }
}

function selectWeekly(
  healthy: RetentionPlanRequest['candidates'],
  referenceTime: Date,
  weeks: number,
  keep: (backupId: string, reason: KeepReason) => void
): void {
  if (weeks === 0) return
  const selectedWeeks = new Set<number>()
  const referenceWeek = utcMondayNumber(referenceTime)
  for (const candidate of healthy) {
    const candidateWeek = utcMondayNumber(new Date(candidate.createdAt))
    const ageWeeks = Math.floor((referenceWeek - candidateWeek) / 7)
    if (ageWeeks < 0 || ageWeeks >= weeks || selectedWeeks.has(candidateWeek)) continue
    selectedWeeks.add(candidateWeek)
    keep(candidate.backupId, 'weekly')
  }
}

function utcDayNumber(value: Date): number {
  return Math.floor(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()) / 86_400_000)
}

function utcMondayNumber(value: Date): number {
  const day = utcDayNumber(value)
  const weekday = value.getUTCDay() === 0 ? 7 : value.getUTCDay()
  return day - (weekday - 1)
}

function assertUniqueBackupIds(request: RetentionPlanRequest): void {
  const ids = new Set<string>()
  for (const candidate of request.candidates) {
    if (ids.has(candidate.backupId)) throw new Error('DUPLICATE_BACKUP_ID')
    ids.add(candidate.backupId)
  }
}

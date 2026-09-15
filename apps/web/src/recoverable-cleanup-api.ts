export interface CleanupItem { kind: 'history' | 'release'; opaqueId: string; sha256: string; sizeBytes: number }
export interface CleanupPlan { format: 'dyson-recoverable-component-cleanup-plan'; schemaVersion: 1;
  requestId: string; expectedRevision: string; candidates: CleanupItem[]; planSha256: string }
export interface CleanupTransaction { requestId: string; sourceRequestId: string; expectedRevision: string;
  direction: 'quarantine' | 'restore'; state: 'running' | 'completed'; completedCount: number; totalCount: number;
  actor: string; startedAt: string; finishedAt: string | null; planSha256: string }
export interface CleanupReceipt { format: 'dyson-recoverable-cleanup-journal'; schemaVersion: 1; requestId: string;
  direction: 'quarantine' | 'restore'; state: 'completed'; completedCount: number; actor: string;
  startedAt: string; finishedAt: string; plan: CleanupPlan }
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const hash = /^[0-9a-f]{64}$/
function valid(condition: unknown): asserts condition { if (!condition) throw new Error('清理响应未通过校验') }
function object(value: unknown): Record<string, unknown> { valid(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown> }
function text(value: unknown, pattern: RegExp) { valid(typeof value === 'string' && pattern.test(value)); return value }
function count(value: unknown, max: number) { valid(Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max); return Number(value) }
function plan(value: unknown): CleanupPlan {
  const p = object(value)
  valid(p.format === 'dyson-recoverable-component-cleanup-plan' && p.schemaVersion === 1)
  text(p.requestId, guid); text(p.expectedRevision, hash); text(p.planSha256, hash)
  valid(Array.isArray(p.candidates) && p.candidates.length > 0 && p.candidates.length <= 64)
  const seen = new Set<string>()
  for (const value of p.candidates) {
    const item = object(value)
    valid(item.kind === 'history' || item.kind === 'release')
    const id = text(item.opaqueId, item.kind === 'history' ? guid : /^(nebula|bepinex|bridge|control)-[0-9a-f]{32}$/)
    text(item.sha256, hash); count(item.sizeBytes, Number.MAX_SAFE_INTEGER)
    const key = item.kind + ':' + id; valid(!seen.has(key)); seen.add(key)
  }
  return p as unknown as CleanupPlan
}
function receipt(value: unknown): CleanupReceipt {
  const r = object(value), p = plan(r.plan)
  valid(r.format === 'dyson-recoverable-cleanup-journal' && r.schemaVersion === 1 && r.state === 'completed')
  text(r.requestId, guid); valid(r.direction === 'quarantine' || r.direction === 'restore')
  valid(r.direction === 'quarantine' ? r.requestId === p.requestId : r.requestId !== p.requestId)
  valid(r.completedCount === p.candidates.length && typeof r.actor === 'string' && r.actor.length > 0 && r.actor.length <= 128)
  valid(typeof r.startedAt === 'string' && typeof r.finishedAt === 'string' && Number.isFinite(Date.parse(r.startedAt)) && Date.parse(r.finishedAt) >= Date.parse(r.startedAt))
  return r as unknown as CleanupReceipt
}
async function call(suffix: string, body?: unknown): Promise<unknown> {
  const response = await fetch('/api/v1/updates/cleanup/recoverable/' + suffix, { method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) })
  const value = object(await response.json())
  if (!response.ok || value.ok !== true) throw new Error('清理请求未完成，请刷新事务状态并核对回执')
  return value.data
}
async function submit(endpoint: string, body: Record<string, unknown>, direction: 'quarantine' | 'restore') {
  const first = receipt(await call(endpoint, body))
  valid(first.requestId === body.requestId && first.direction === direction && first.plan.planSha256 === body.expectedPlanSha256)
  const stored = receipt(await call('receipts/' + text(body.requestId, guid)))
  valid(JSON.stringify(first) === JSON.stringify(stored))
  return stored
}
export type CleanupRecoveryTarget = Pick<CleanupTransaction, 'requestId' | 'sourceRequestId' | 'expectedRevision' | 'planSha256' | 'direction'>
export function parseCleanupRecoveryTarget(value: unknown): CleanupRecoveryTarget {
  const r = object(value)
  const requestId = text(r.requestId, guid), sourceRequestId = text(r.sourceRequestId, guid)
  valid(r.direction === 'quarantine' || r.direction === 'restore')
  valid(r.direction === 'quarantine' ? requestId === sourceRequestId : requestId !== sourceRequestId)
  return { requestId, sourceRequestId, expectedRevision: text(r.expectedRevision, hash), planSha256: text(r.planSha256, hash), direction: r.direction }
}
export const recoverableCleanupApi = {
  async preview(requestId: string) { text(requestId, guid); const p = plan(await call('preview', { requestId })); valid(p.requestId === requestId); return p },
  async receipt(requestId: string) { text(requestId, guid); const r = receipt(await call('receipts/' + requestId)); valid(r.requestId === requestId); return r },
  async state(): Promise<{ executionEnabled: boolean; recoveryEnabled: boolean; transactions: CleanupTransaction[] }> {
    const s = object(await call('state'))
    valid(typeof s.executionEnabled === 'boolean' && typeof s.recoveryEnabled === 'boolean' && Array.isArray(s.transactions) && s.transactions.length <= 1024)
    for (const entry of s.transactions) {
      const r = object(entry)
      text(r.requestId, guid); text(r.sourceRequestId, guid); text(r.expectedRevision, hash); text(r.planSha256, hash)
      valid(r.direction === 'quarantine' || r.direction === 'restore'); valid(r.state === 'running' || r.state === 'completed')
      valid(count(r.totalCount, 64) > 0 && count(r.completedCount, 64) <= Number(r.totalCount))
      valid(typeof r.actor === 'string' && r.actor.length <= 128 && typeof r.startedAt === 'string')
      valid(Number.isFinite(Date.parse(r.startedAt)))
      valid(r.direction === 'quarantine' ? r.requestId === r.sourceRequestId : r.requestId !== r.sourceRequestId)
      valid(r.state === 'completed' ? r.completedCount === r.totalCount && typeof r.finishedAt === 'string' && Date.parse(r.finishedAt) >= Date.parse(r.startedAt) : r.finishedAt === null)
    }
    return s as unknown as { executionEnabled: boolean; recoveryEnabled: boolean; transactions: CleanupTransaction[] }
  },
  execute(p: CleanupPlan) { plan(p); return submit('execute', { requestId: p.requestId, expectedRevision: p.expectedRevision, expectedPlanSha256: p.planSha256, confirmation: 'QUARANTINE_COMPONENT_MATERIAL' }, 'quarantine') },
  restore(requestId: string, source: CleanupTransaction) { text(requestId, guid); text(source.requestId, guid); text(source.planSha256, hash); valid(source.direction === 'quarantine' && source.state === 'completed'); return submit('restore', { requestId, sourceRequestId: source.requestId, expectedPlanSha256: source.planSha256, confirmation: 'RESTORE_COMPONENT_MATERIAL' }, 'restore') },
  recover(source: CleanupRecoveryTarget) { text(source.requestId, guid); text(source.planSha256, hash); return submit('recovery', { requestId: source.requestId, expectedPlanSha256: source.planSha256, direction: source.direction,
    ...(source.direction === 'quarantine' ? { expectedRevision: text(source.expectedRevision, hash) } : { sourceRequestId: text(source.sourceRequestId, guid) }), confirmation: 'RECOVER_COMPONENT_CLEANUP' }, source.direction) }
}

export interface RollbackRequest { requestId: string; sourceRequestId: string; expectedRevision: string; expectedPlanSha256: string }
export interface RollbackPlan extends Omit<RollbackRequest, 'expectedPlanSha256'> {
  format: 'dyson-control-component-rollback-plan'; schemaVersion: 1; dryRun: true;
  component: string; targetVersion: string; materialSha256: string; rollbackBindingSha256: string;
  sourceProtectionBackupId: string; restoreFileCount: number; removeFileCount: number;
  planSha256: string; currentConfigurationRevision: string
}
export interface RollbackReceipt { format: 'dyson-control-operator-rollback-receipt'; schemaVersion: 1;
  requestId: string; sourceRequestId: string; planSha256: string; resultingRevision: string;
  protectionBackupId: string; status: 'succeeded'; recoveryRequired: false }
export interface RollbackState { executionEnabled: boolean; recoveryEnabled: boolean;
  pending: Array<{ request: RollbackRequest; phase: string }> }
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const hash = /^[0-9a-f]{64}$/
const phases = ['prepared', 'protected', 'files-restored', 'environment-restored', 'verified', 'state-committed']
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
function requireValue(valid: boolean): asserts valid { if (!valid) throw new Error('回退响应未通过校验') }
function keys(value: Record<string, unknown>, expected: string[]) { requireValue(Object.keys(value).length === expected.length && expected.every(key => key in value)) }
const textMatches = (value: unknown, pattern: RegExp) => typeof value === 'string' && pattern.test(value)
export function parseRequest(value: unknown): RollbackRequest {
  requireValue(record(value)); keys(value, ['requestId', 'sourceRequestId', 'expectedRevision', 'expectedPlanSha256'])
  requireValue(textMatches(value.requestId, guid) && textMatches(value.sourceRequestId, guid) && value.requestId !== value.sourceRequestId &&
    textMatches(value.expectedRevision, hash) && textMatches(value.expectedPlanSha256, hash))
  return value as unknown as RollbackRequest
}
async function call(suffix: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`/api/v1/updates/rollback/${suffix}`, { method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin', signal, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) })
  const value: unknown = await response.json()
  if (!response.ok || !record(value) || value.ok !== true) {
    const code = record(value) && record(value.error) ? value.error.code : null
    const messages: Record<string, string> = {
      UPDATE_ROLLBACK_SOURCE_NOT_CURRENT: '该请求不是当前可回退的成功更新，请选择最近一次成功更新。',
      UPDATE_REVISION_CONFLICT: '组件状态已变化，请刷新后重新预演。',
      UPDATE_ROLLBACK_RECEIPT_NOT_FOUND: '尚未找到这笔回退的完成回执，请刷新状态确认是否仍在执行。',
      UPDATE_ROLLBACK_DISABLED: '服务端尚未启用这项回退操作。'
    }
    throw new Error(typeof code === 'string' && Object.hasOwn(messages, code) ? messages[code] : '回退请求未完成，请刷新状态或核对回执')
  }
  return value.data
}
export const operatorRollbackApi = {
  async state(signal?: AbortSignal): Promise<RollbackState> {
    const value = await call('state', undefined, signal)
    requireValue(record(value)); keys(value, ['executionEnabled', 'recoveryEnabled', 'pending'])
    requireValue(typeof value.executionEnabled === 'boolean' && typeof value.recoveryEnabled === 'boolean' && Array.isArray(value.pending) && value.pending.length <= 1024)
    for (const pending of value.pending) {
      requireValue(record(pending)); keys(pending, ['request', 'phase']); parseRequest(pending.request)
      requireValue(typeof pending.phase === 'string' && phases.includes(pending.phase))
    }
    return value as unknown as RollbackState
  },
  async preview(request: Omit<RollbackRequest, 'expectedPlanSha256'>): Promise<RollbackPlan> {
    requireValue(guid.test(request.requestId) && guid.test(request.sourceRequestId) && request.requestId !== request.sourceRequestId && hash.test(request.expectedRevision))
    const value = await call('preview', request)
    requireValue(record(value)); keys(value, ['format', 'schemaVersion', 'dryRun', 'requestId', 'sourceRequestId', 'expectedRevision',
      'component', 'targetVersion', 'materialSha256', 'rollbackBindingSha256', 'sourceProtectionBackupId', 'restoreFileCount',
      'removeFileCount', 'planSha256', 'currentConfigurationRevision'])
    requireValue(value.format === 'dyson-control-component-rollback-plan' && value.schemaVersion === 1 && value.dryRun === true &&
      value.requestId === request.requestId && value.sourceRequestId === request.sourceRequestId && value.expectedRevision === request.expectedRevision &&
      ['nebula', 'bepinex', 'bridge', 'control'].includes(String(value.component)) && typeof value.targetVersion === 'string' && value.targetVersion.length > 0 && value.targetVersion.length <= 64 &&
      typeof value.sourceProtectionBackupId === 'string' && value.sourceProtectionBackupId.length <= 128)
    for (const key of ['materialSha256', 'rollbackBindingSha256', 'planSha256', 'currentConfigurationRevision']) requireValue(textMatches(value[key], hash))
    for (const key of ['restoreFileCount', 'removeFileCount']) requireValue(Number.isSafeInteger(value[key]) && Number(value[key]) >= 0 && Number(value[key]) <= 1024)
    return value as unknown as RollbackPlan
  },
  async receipt(requestId: string): Promise<RollbackReceipt> {
    requireValue(guid.test(requestId))
    const value = await call(`receipts/${requestId}`)
    requireValue(record(value)); keys(value, ['format', 'schemaVersion', 'requestId', 'sourceRequestId', 'planSha256', 'resultingRevision', 'protectionBackupId', 'status', 'recoveryRequired'])
    requireValue(value.format === 'dyson-control-operator-rollback-receipt' && value.schemaVersion === 1 && value.requestId === requestId &&
      textMatches(value.sourceRequestId, guid) && textMatches(value.planSha256, hash) && textMatches(value.resultingRevision, hash) &&
      typeof value.protectionBackupId === 'string' && value.protectionBackupId.length <= 128 && value.status === 'succeeded' && value.recoveryRequired === false)
    return value as unknown as RollbackReceipt
  },
  async submit(request: RollbackRequest, recovery: boolean): Promise<RollbackReceipt> {
    parseRequest(request)
    await call(recovery ? 'recovery' : 'execute', { request,
      confirmation: recovery ? 'RECOVER_COMPONENT_ROLLBACK' : 'ROLLBACK_COMPONENT_UPDATE' })
    const receipt = await operatorRollbackApi.receipt(request.requestId)
    requireValue(receipt.sourceRequestId === request.sourceRequestId && receipt.planSha256 === request.expectedPlanSha256)
    return receipt
  }
}

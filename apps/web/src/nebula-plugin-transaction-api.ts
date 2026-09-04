import { ApiError } from './api'

export type NebulaPluginTargetRole = 'Client' | 'Server'
export type NebulaPluginApplyStatus =
  | 'applied'
  | 'rolled-back-automatic'
  | 'rolled-back-recovery'
export type NebulaPluginRollbackStatus =
  | 'rolled-back-manual'
  | 'rollback-failed-restored-candidate'
  | 'rollback-recovery-restored-candidate'

export interface NebulaPluginPlanRequest {
  requestId: string
  currentPluginsTreeSha256: string
  maintenanceWindowStartUtc: string
  maintenanceWindowEndUtc: string
}

export interface NebulaPluginPlanResult {
  requestId: string
  targetRole: NebulaPluginTargetRole
  mode: 'dry-run'
  executionEnabled: false
  planDigest: string
  productionChanged: false
}

export interface NebulaPluginApplyPreviewResult {
  requestId: string
  targetRole: NebulaPluginTargetRole
  status: 'preview'
  mode: 'dry-run'
  planDigest: string
  confirmationRequired: true
  productionChanged: false
}

export interface NebulaPluginApplyMutationRequest {
  requestId: string
  planDigest: string
  confirmationPhrase: string
}

export interface NebulaPluginApplyResult {
  requestId: string
  status: NebulaPluginApplyStatus
  receiptDigest: string
  reused: boolean
  quarantineRetained: boolean
  candidateStageRetained: boolean
}

export interface NebulaPluginVerifyApplyResult {
  requestId: string
  targetRole: NebulaPluginTargetRole
  transactionStatus: NebulaPluginApplyStatus
  receiptDigest: string
  contentAndAclExact: true
  rollbackMaterialRetained: true
}

export interface NebulaPluginRollbackPreviewRequest {
  originalRequestId: string
  rollbackRequestId: string
  originalReceiptSha256: string
  maintenanceWindowStartUtc: string
  maintenanceWindowEndUtc: string
}

export interface NebulaPluginRollbackPreviewResult {
  originalRequestId: string
  rollbackRequestId: string
  status: 'preview'
  mode: 'dry-run'
  previewDigest: string
  exactConfirmationPhrase: string
  productionChanged: false
}

export interface NebulaPluginRollbackMutationRequest extends NebulaPluginRollbackPreviewRequest {
  previewDigest: string
  confirmationPhrase: string
}

export interface NebulaPluginRollbackResult {
  originalRequestId: string
  rollbackRequestId: string
  status: NebulaPluginRollbackStatus
  receiptDigest: string
  reused: boolean
  quarantineRetained: boolean
  candidateStageRetained: boolean
}

export interface NebulaPluginVerifyRollbackResult {
  originalRequestId: string
  rollbackRequestId: string
  transactionStatus: NebulaPluginRollbackStatus
  receiptDigest: string
  contentAndAclExact: true
  rollbackMaterialRetained: true
}

export type NebulaPluginTransactionErrorCode =
  | 'NEBULA_PLUGIN_TRANSACTION_REQUEST_INVALID'
  | 'NEBULA_PLUGIN_TRANSACTION_NOT_CONFIGURED'
  | 'NEBULA_PLUGIN_TRANSACTION_MUTATION_DISABLED'
  | 'NEBULA_PLUGIN_TRANSACTION_RECOVERY_DISABLED'
  | 'NEBULA_PLUGIN_TRANSACTION_RECOVERY_FORBIDDEN'
  | 'NEBULA_PLUGIN_TRANSACTION_HOST_MUTATION_BLOCKED'
  | 'NEBULA_PLUGIN_TRANSACTION_HOST_MUTATION_UNAVAILABLE'
  | 'NEBULA_PLUGIN_TRANSACTION_UNAVAILABLE'
  | 'WINDOWS_NEBULA_PLUGIN_TRANSACTION_REQUEST_INVALID'
  | 'WINDOWS_NEBULA_PLUGIN_TRANSACTION_RESULT_INVALID'
  | 'WINDOWS_NEBULA_PLUGIN_TRANSACTION_SCRIPT_FAILED'
  | 'WINDOWS_NEBULA_PLUGIN_TRANSACTION_TIMEOUT'
  | 'WINDOWS_NEBULA_PLUGIN_TRANSACTION_CANCELLED'
  | 'NEBULA_PLUGIN_TRANSACTION_BROWSER_RESPONSE_INVALID'

type Parser<T> = (value: unknown) => T | null

const basePath = '/api/v1/updates/nebula-plugin-transaction'

export const nebulaPluginTransactionApi = {
  plan: (input: NebulaPluginPlanRequest, signal?: AbortSignal) =>
    bound(post(`${basePath}/plan`, {
      requestId: input.requestId,
      currentPluginsTreeSha256: input.currentPluginsTreeSha256,
      maintenanceWindowStartUtc: input.maintenanceWindowStartUtc,
      maintenanceWindowEndUtc: input.maintenanceWindowEndUtc
    }, parsePlan, signal), (data) => data.requestId === input.requestId && data.targetRole === 'Server'),
  previewApply: (requestId: string, signal?: AbortSignal) =>
    bound(post(`${basePath}/apply/preview`, { requestId }, parseApplyPreview, signal),
      (data) => data.requestId === requestId && data.targetRole === 'Server'),
  apply: (input: NebulaPluginApplyMutationRequest) =>
    bound(post(`${basePath}/apply`, {
      requestId: input.requestId,
      planDigest: input.planDigest,
      confirmationPhrase: input.confirmationPhrase
    }, parseApplyResult), (data) => data.requestId === input.requestId &&
      applyResultMatchesRoute(data, 'ordinary')),
  recoverApply: (input: NebulaPluginApplyMutationRequest) =>
    bound(post(`${basePath}/apply/recover`, {
      requestId: input.requestId,
      planDigest: input.planDigest,
      confirmationPhrase: input.confirmationPhrase
    }, parseApplyResult), (data) => data.requestId === input.requestId &&
      applyResultMatchesRoute(data, 'recovery')),
  verifyApply: (requestId: string, signal?: AbortSignal) =>
    bound(post(`${basePath}/apply/verify`, { requestId }, parseVerifyApply, signal),
      (data) => data.requestId === requestId && data.targetRole === 'Server'),
  previewRollback: (input: NebulaPluginRollbackPreviewRequest, signal?: AbortSignal) =>
    bound(post(`${basePath}/rollback/preview`, rollbackPreviewBody(input), parseRollbackPreview, signal),
      (data) => data.originalRequestId === input.originalRequestId &&
        data.rollbackRequestId === input.rollbackRequestId),
  rollback: (input: NebulaPluginRollbackMutationRequest) =>
    bound(post(`${basePath}/rollback`, rollbackMutationBody(input), parseRollbackResult),
      (data) => data.originalRequestId === input.originalRequestId &&
        data.rollbackRequestId === input.rollbackRequestId &&
        rollbackResultMatchesRoute(data, 'ordinary')),
  recoverRollback: (input: NebulaPluginRollbackMutationRequest) =>
    bound(post(`${basePath}/rollback/recover`, rollbackMutationBody(input), parseRollbackResult),
      (data) => data.originalRequestId === input.originalRequestId &&
        data.rollbackRequestId === input.rollbackRequestId &&
        rollbackResultMatchesRoute(data, 'recovery')),
  verifyRollback: (originalRequestId: string, rollbackRequestId: string, signal?: AbortSignal) =>
    bound(post(`${basePath}/rollback/verify`, {
      originalRequestId,
      rollbackRequestId
    }, parseVerifyRollback, signal), (data) => data.originalRequestId === originalRequestId &&
      data.rollbackRequestId === rollbackRequestId)
}

export function nebulaPluginApplyConfirmation(requestId: string, planDigest: string): string {
  return `CONFIRM NEBULA PLUGIN CUTOVER ${requestId} ${planDigest}`
}

function rollbackPreviewBody(input: NebulaPluginRollbackPreviewRequest): Record<string, string> {
  return {
    originalRequestId: input.originalRequestId,
    rollbackRequestId: input.rollbackRequestId,
    originalReceiptSha256: input.originalReceiptSha256,
    maintenanceWindowStartUtc: input.maintenanceWindowStartUtc,
    maintenanceWindowEndUtc: input.maintenanceWindowEndUtc
  }
}

function rollbackMutationBody(input: NebulaPluginRollbackMutationRequest): Record<string, string> {
  return {
    ...rollbackPreviewBody(input),
    previewDigest: input.previewDigest,
    confirmationPhrase: input.confirmationPhrase
  }
}

async function post<T>(
  endpoint: string,
  body: Record<string, unknown>,
  parser: Parser<T>,
  signal?: AbortSignal
): Promise<{ data: T }> {
  const response = await fetch(endpoint, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {})
  })
  const envelope = await response.json().catch(() => null) as unknown
  if (!response.ok) {
    const code = errorCode(envelope)
    throw new ApiError(response.status, errorMessage(response.status, code), code)
  }
  if (!isRecord(envelope) || !hasExactKeys(envelope, ['ok', 'data']) || envelope.ok !== true) {
    throw browserResponseInvalid()
  }
  const parsed = parser(envelope.data)
  if (parsed === null) throw browserResponseInvalid()
  return { data: parsed }
}

async function bound<T>(
  result: Promise<{ data: T }>,
  matches: (data: T) => boolean
): Promise<{ data: T }> {
  const resolved = await result
  if (!matches(resolved.data)) throw browserResponseInvalid()
  return resolved
}

function parsePlan(value: unknown): NebulaPluginPlanResult | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'requestId', 'targetRole', 'mode', 'executionEnabled', 'planDigest', 'productionChanged'
  ]) || !isUuid(value.requestId) || !isTargetRole(value.targetRole) || value.mode !== 'dry-run' ||
      value.executionEnabled !== false || !isSha256(value.planDigest) || value.productionChanged !== false) return null
  return value as unknown as NebulaPluginPlanResult
}

function parseApplyPreview(value: unknown): NebulaPluginApplyPreviewResult | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'requestId', 'targetRole', 'status', 'mode', 'planDigest', 'confirmationRequired',
    'productionChanged'
  ]) || !isUuid(value.requestId) || !isTargetRole(value.targetRole) || value.status !== 'preview' ||
      value.mode !== 'dry-run' || !isSha256(value.planDigest) || value.confirmationRequired !== true ||
      value.productionChanged !== false) return null
  return value as unknown as NebulaPluginApplyPreviewResult
}

function parseApplyResult(value: unknown): NebulaPluginApplyResult | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'requestId', 'status', 'receiptDigest', 'reused', 'quarantineRetained', 'candidateStageRetained'
  ]) || !isUuid(value.requestId) || !isApplyStatus(value.status) || !isSha256(value.receiptDigest) ||
      !isBoolean(value.reused) || !isBoolean(value.quarantineRetained) ||
      !isBoolean(value.candidateStageRetained) ||
      value.quarantineRetained !== (value.status === 'applied') ||
      value.candidateStageRetained !== (value.status !== 'applied')) return null
  return value as unknown as NebulaPluginApplyResult
}

function parseVerifyApply(value: unknown): NebulaPluginVerifyApplyResult | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'requestId', 'targetRole', 'transactionStatus', 'receiptDigest', 'contentAndAclExact',
    'rollbackMaterialRetained'
  ]) || !isUuid(value.requestId) || !isTargetRole(value.targetRole) ||
      !isApplyStatus(value.transactionStatus) || !isSha256(value.receiptDigest) ||
      value.contentAndAclExact !== true || value.rollbackMaterialRetained !== true) return null
  return value as unknown as NebulaPluginVerifyApplyResult
}

function parseRollbackPreview(value: unknown): NebulaPluginRollbackPreviewResult | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'originalRequestId', 'rollbackRequestId', 'status', 'mode', 'previewDigest',
    'exactConfirmationPhrase', 'productionChanged'
  ]) || !isUuid(value.originalRequestId) || !isUuid(value.rollbackRequestId) ||
      value.originalRequestId === value.rollbackRequestId || value.status !== 'preview' ||
      value.mode !== 'dry-run' || !isSha256(value.previewDigest) ||
      typeof value.exactConfirmationPhrase !== 'string' || value.exactConfirmationPhrase.length < 1 ||
      value.exactConfirmationPhrase.length > 256 || value.productionChanged !== false) return null
  return value as unknown as NebulaPluginRollbackPreviewResult
}

function parseRollbackResult(value: unknown): NebulaPluginRollbackResult | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'originalRequestId', 'rollbackRequestId', 'status', 'receiptDigest', 'reused',
    'quarantineRetained', 'candidateStageRetained'
  ]) || !isUuid(value.originalRequestId) || !isUuid(value.rollbackRequestId) ||
      value.originalRequestId === value.rollbackRequestId || !isRollbackStatus(value.status) ||
      !isSha256(value.receiptDigest) || !isBoolean(value.reused) ||
      !isBoolean(value.quarantineRetained) || !isBoolean(value.candidateStageRetained) ||
      value.quarantineRetained !== (value.status !== 'rolled-back-manual') ||
      value.candidateStageRetained !== (value.status === 'rolled-back-manual')) return null
  return value as unknown as NebulaPluginRollbackResult
}

function parseVerifyRollback(value: unknown): NebulaPluginVerifyRollbackResult | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'originalRequestId', 'rollbackRequestId', 'transactionStatus', 'receiptDigest',
    'contentAndAclExact', 'rollbackMaterialRetained'
  ]) || !isUuid(value.originalRequestId) || !isUuid(value.rollbackRequestId) ||
      value.originalRequestId === value.rollbackRequestId || !isRollbackStatus(value.transactionStatus) ||
      !isSha256(value.receiptDigest) || value.contentAndAclExact !== true ||
      value.rollbackMaterialRetained !== true) return null
  return value as unknown as NebulaPluginVerifyRollbackResult
}

function browserResponseInvalid(): ApiError {
  return new ApiError(
    502,
    'Nebula 事务响应未通过浏览器端严格合同核验；不会继续执行后续步骤。',
    'NEBULA_PLUGIN_TRANSACTION_BROWSER_RESPONSE_INVALID'
  )
}

function errorCode(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.code !== 'string' ||
      value.error.code.length < 1 || value.error.code.length > 128) return null
  return value.error.code
}

function errorMessage(status: number, code: string | null): string {
  if (code === 'NEBULA_PLUGIN_TRANSACTION_NOT_CONFIGURED') {
    return 'Nebula 整树事务尚未配置；当前不会访问候选或游戏目录。'
  }
  if (code === 'NEBULA_PLUGIN_TRANSACTION_MUTATION_DISABLED') {
    return 'Nebula 整树 ordinary mutation 门禁关闭；仍可执行只读预演与核验。'
  }
  if (code === 'NEBULA_PLUGIN_TRANSACTION_RECOVERY_DISABLED') {
    return 'Nebula 整树 recovery 门禁关闭；未执行恢复写入。'
  }
  if (code === 'NEBULA_PLUGIN_TRANSACTION_HOST_MUTATION_BLOCKED') {
    return '全局主机变更租约阻止了本次操作；不会自动尝试恢复。'
  }
  if (status === 403) return '当前角色没有执行该 Nebula 整树事务操作的权限。'
  if (status === 408 || code === 'WINDOWS_NEBULA_PLUGIN_TRANSACTION_CANCELLED') {
    return 'Nebula 整树事务读取已取消；没有据此推断任何终态。'
  }
  if (status === 504 || code === 'WINDOWS_NEBULA_PLUGIN_TRANSACTION_TIMEOUT') {
    return 'Nebula 整树事务超时；必须重新核验持久终态。'
  }
  if (status === 400) return 'Nebula 整树事务请求或绑定无效。'
  if (status === 502) return 'Nebula 整树 provider 返回了无效的有界结果。'
  return 'Nebula 整树事务暂不可用；不会绕过服务端门禁。'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function isBoolean(value: unknown): value is boolean {
  return value === true || value === false
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
}

function isTargetRole(value: unknown): value is NebulaPluginTargetRole {
  return value === 'Client' || value === 'Server'
}

function isApplyStatus(value: unknown): value is NebulaPluginApplyStatus {
  return value === 'applied' || value === 'rolled-back-automatic' ||
    value === 'rolled-back-recovery'
}

function isRollbackStatus(value: unknown): value is NebulaPluginRollbackStatus {
  return value === 'rolled-back-manual' || value === 'rollback-failed-restored-candidate' ||
    value === 'rollback-recovery-restored-candidate'
}

function applyResultMatchesRoute(
  result: NebulaPluginApplyResult,
  route: 'ordinary' | 'recovery'
): boolean {
  return result.reused || result.status === (route === 'ordinary' ? 'applied' : 'rolled-back-recovery')
}

function rollbackResultMatchesRoute(
  result: NebulaPluginRollbackResult,
  route: 'ordinary' | 'recovery'
): boolean {
  return result.reused || result.status === (route === 'ordinary'
    ? 'rolled-back-manual'
    : 'rollback-recovery-restored-candidate')
}

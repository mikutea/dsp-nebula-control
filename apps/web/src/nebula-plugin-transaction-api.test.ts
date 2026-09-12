import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import {
  nebulaPluginTransactionApi,
  type NebulaPluginApplyMutationRequest,
  type NebulaPluginPlanRequest,
  type NebulaPluginRollbackMutationRequest,
  type NebulaPluginRollbackPreviewRequest
} from './nebula-plugin-transaction-api'

const requestId = '11111111-1111-4111-8111-111111111111'
const rollbackRequestId = '22222222-2222-4222-8222-222222222222'
const treeDigest = '1'.repeat(64)
const planDigest = '2'.repeat(64)
const receiptDigest = '3'.repeat(64)
const previewDigest = '4'.repeat(64)
const startUtc = '2030-01-01T00:00:00Z'
const endUtc = '2030-01-01T01:00:00Z'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Nebula whole-tree transaction web client', () => {
  it('uses only the nine fixed POST routes and explicitly selected path-free fields', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        path: String(path),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>
      })
      expect(init).toMatchObject({
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }
      })
      return response(responseData(String(path)))
    }))

    const planInput = {
      requestId,
      currentPluginsTreeSha256: treeDigest,
      maintenanceWindowStartUtc: startUtc,
      maintenanceWindowEndUtc: endUtc,
      path: 'C:\\Private\\must-not-cross',
      scriptName: 'Arbitrary.ps1',
      command: 'powershell private'
    } as NebulaPluginPlanRequest
    const applyInput = {
      requestId,
      planDigest,
      confirmationPhrase: `CONFIRM NEBULA PLUGIN CUTOVER ${requestId} ${planDigest}`,
      path: 'C:\\Private\\must-not-cross'
    } as NebulaPluginApplyMutationRequest
    const rollbackInput = {
      originalRequestId: requestId,
      rollbackRequestId,
      originalReceiptSha256: receiptDigest,
      maintenanceWindowStartUtc: startUtc,
      maintenanceWindowEndUtc: endUtc,
      previewDigest,
      confirmationPhrase: rollbackPhrase,
      command: 'private-command'
    } as NebulaPluginRollbackMutationRequest

    await nebulaPluginTransactionApi.plan(planInput)
    await nebulaPluginTransactionApi.previewApply(requestId)
    await nebulaPluginTransactionApi.apply(applyInput)
    await nebulaPluginTransactionApi.recoverApply(applyInput)
    await nebulaPluginTransactionApi.verifyApply(requestId)
    await nebulaPluginTransactionApi.previewRollback(rollbackInput)
    await nebulaPluginTransactionApi.rollback(rollbackInput)
    await nebulaPluginTransactionApi.recoverRollback(rollbackInput)
    await nebulaPluginTransactionApi.verifyRollback(requestId, rollbackRequestId)

    expect(calls.map((call) => call.path)).toEqual([
      '/api/v1/updates/nebula-plugin-transaction/plan',
      '/api/v1/updates/nebula-plugin-transaction/apply/preview',
      '/api/v1/updates/nebula-plugin-transaction/apply',
      '/api/v1/updates/nebula-plugin-transaction/apply/recover',
      '/api/v1/updates/nebula-plugin-transaction/apply/verify',
      '/api/v1/updates/nebula-plugin-transaction/rollback/preview',
      '/api/v1/updates/nebula-plugin-transaction/rollback',
      '/api/v1/updates/nebula-plugin-transaction/rollback/recover',
      '/api/v1/updates/nebula-plugin-transaction/rollback/verify'
    ])
    expect(calls.map((call) => call.body)).toEqual([
      {
        requestId,
        currentPluginsTreeSha256: treeDigest,
        maintenanceWindowStartUtc: startUtc,
        maintenanceWindowEndUtc: endUtc
      },
      { requestId },
      { requestId, planDigest, confirmationPhrase: applyInput.confirmationPhrase },
      { requestId, planDigest, confirmationPhrase: applyInput.confirmationPhrase },
      { requestId },
      rollbackPreviewInput(),
      rollbackInputExpected(),
      rollbackInputExpected(),
      { originalRequestId: requestId, rollbackRequestId }
    ])
    expect(JSON.stringify(calls.map((call) => call.body)))
      .not.toMatch(/"(?:path|script|scriptName|command|url|executable|credential)"\s*:/iu)
  })

  it('rejects overbroad or identity-invalid success envelopes before returning data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      ...responseData('/api/v1/updates/nebula-plugin-transaction/plan'),
      internalPath: 'C:\\Private\\candidate'
    })))

    const error = await nebulaPluginTransactionApi.plan(planInput())
      .then(() => null, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      status: 502,
      code: 'NEBULA_PLUGIN_TRANSACTION_BROWSER_RESPONSE_INVALID'
    })

    vi.stubGlobal('fetch', vi.fn(async () => response({
      ...responseData('/api/v1/updates/nebula-plugin-transaction/apply/verify'),
      requestId: rollbackRequestId
    })))
    await expect(nebulaPluginTransactionApi.verifyApply(requestId)).rejects.toMatchObject({
      status: 502,
      code: 'NEBULA_PLUGIN_TRANSACTION_BROWSER_RESPONSE_INVALID'
    })
  })

  it('maps code-only fail-closed errors and ignores an untrusted server message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      ok: false,
      error: {
        code: 'NEBULA_PLUGIN_TRANSACTION_MUTATION_DISABLED',
        message: 'C:\\Private\\secret-token'
      }
    }, 423)))

    const error = await nebulaPluginTransactionApi.apply(applyInput())
      .then(() => null, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      status: 423,
      code: 'NEBULA_PLUGIN_TRANSACTION_MUTATION_DISABLED',
      message: 'Nebula 整树 ordinary mutation 门禁关闭；仍可执行只读预演与核验。'
    })
    expect((error as Error).message).not.toContain('Private')
    expect((error as Error).message).not.toContain('secret-token')
  })

  it.each([
    {
      label: 'ordinary apply with a fresh recovery status',
      invoke: () => nebulaPluginTransactionApi.apply(applyInput()),
      data: {
        requestId, status: 'rolled-back-recovery', receiptDigest, reused: false,
        quarantineRetained: false, candidateStageRetained: true
      }
    },
    {
      label: 'recovery apply with a fresh ordinary status',
      invoke: () => nebulaPluginTransactionApi.recoverApply(applyInput()),
      data: {
        requestId, status: 'applied', receiptDigest, reused: false,
        quarantineRetained: true, candidateStageRetained: false
      }
    },
    {
      label: 'ordinary rollback with a fresh recovery status',
      invoke: () => nebulaPluginTransactionApi.rollback(rollbackInputExpected()),
      data: {
        originalRequestId: requestId, rollbackRequestId,
        status: 'rollback-recovery-restored-candidate', receiptDigest, reused: false,
        quarantineRetained: true, candidateStageRetained: false
      }
    },
    {
      label: 'recovery rollback with a fresh ordinary status',
      invoke: () => nebulaPluginTransactionApi.recoverRollback(rollbackInputExpected()),
      data: {
        originalRequestId: requestId, rollbackRequestId,
        status: 'rolled-back-manual', receiptDigest, reused: false,
        quarantineRetained: false, candidateStageRetained: true
      }
    },
    {
      label: 'apply with retention flags that contradict its status',
      invoke: () => nebulaPluginTransactionApi.apply(applyInput()),
      data: {
        requestId, status: 'applied', receiptDigest, reused: false,
        quarantineRetained: false, candidateStageRetained: true
      }
    },
    {
      label: 'rollback with retention flags that contradict its status',
      invoke: () => nebulaPluginTransactionApi.rollback(rollbackInputExpected()),
      data: {
        originalRequestId: requestId, rollbackRequestId,
        status: 'rolled-back-manual', receiptDigest, reused: false,
        quarantineRetained: true, candidateStageRetained: false
      }
    }
  ])('rejects $label as an impossible mutation response', async ({ invoke, data }) => {
    vi.stubGlobal('fetch', vi.fn(async () => response(data)))

    await expect(invoke()).rejects.toMatchObject({
      status: 502,
      code: 'NEBULA_PLUGIN_TRANSACTION_BROWSER_RESPONSE_INVALID'
    })
  })

  it.each([
    {
      label: 'ordinary apply replaying an automatic rollback terminal',
      invoke: () => nebulaPluginTransactionApi.apply(applyInput()),
      data: {
        requestId, status: 'rolled-back-automatic', receiptDigest, reused: true,
        quarantineRetained: false, candidateStageRetained: true
      }
    },
    {
      label: 'recovery apply replaying an applied terminal',
      invoke: () => nebulaPluginTransactionApi.recoverApply(applyInput()),
      data: {
        requestId, status: 'applied', receiptDigest, reused: true,
        quarantineRetained: true, candidateStageRetained: false
      }
    },
    {
      label: 'ordinary rollback replaying a restored-candidate terminal',
      invoke: () => nebulaPluginTransactionApi.rollback(rollbackInputExpected()),
      data: {
        originalRequestId: requestId, rollbackRequestId,
        status: 'rollback-failed-restored-candidate', receiptDigest, reused: true,
        quarantineRetained: true, candidateStageRetained: false
      }
    },
    {
      label: 'recovery rollback replaying a manual terminal',
      invoke: () => nebulaPluginTransactionApi.recoverRollback(rollbackInputExpected()),
      data: {
        originalRequestId: requestId, rollbackRequestId,
        status: 'rolled-back-manual', receiptDigest, reused: true,
        quarantineRetained: false, candidateStageRetained: true
      }
    }
  ])('accepts $label only because it is an idempotent replay', async ({ invoke, data }) => {
    vi.stubGlobal('fetch', vi.fn(async () => response(data)))

    await expect(invoke()).resolves.toEqual({ data })
  })
})

function responseData(path: string): Record<string, unknown> {
  if (path.endsWith('/plan')) return {
    requestId, targetRole: 'Server', mode: 'dry-run', executionEnabled: false,
    planDigest, productionChanged: false
  }
  if (path.endsWith('/apply/preview')) return {
    requestId, targetRole: 'Server', status: 'preview', mode: 'dry-run', planDigest,
    confirmationRequired: true, productionChanged: false
  }
  if (path.endsWith('/apply/verify')) return {
    requestId, targetRole: 'Server', transactionStatus: 'applied', receiptDigest,
    contentAndAclExact: true, rollbackMaterialRetained: true
  }
  if (path.endsWith('/apply/recover')) return {
    requestId, status: 'rolled-back-recovery', receiptDigest, reused: false,
    quarantineRetained: false, candidateStageRetained: true
  }
  if (path.endsWith('/apply')) return {
    requestId, status: 'applied', receiptDigest, reused: false,
    quarantineRetained: true, candidateStageRetained: false
  }
  if (path.endsWith('/rollback/preview')) return {
    originalRequestId: requestId, rollbackRequestId, status: 'preview', mode: 'dry-run',
    previewDigest, exactConfirmationPhrase: rollbackPhrase, productionChanged: false
  }
  if (path.endsWith('/rollback/verify')) return {
    originalRequestId: requestId, rollbackRequestId, transactionStatus: 'rolled-back-manual',
    receiptDigest, contentAndAclExact: true, rollbackMaterialRetained: true
  }
  if (path.endsWith('/rollback/recover')) return {
    originalRequestId: requestId, rollbackRequestId,
    status: 'rollback-recovery-restored-candidate', receiptDigest, reused: false,
    quarantineRetained: true, candidateStageRetained: false
  }
  return {
    originalRequestId: requestId, rollbackRequestId, status: 'rolled-back-manual',
    receiptDigest, reused: false, quarantineRetained: false, candidateStageRetained: true
  }
}

function response(data: unknown, status = 200): Response {
  const body = isEnvelope(data) ? data : { ok: true, data }
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function isEnvelope(value: unknown): value is { ok: boolean } {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, 'ok')
}

function planInput(): NebulaPluginPlanRequest {
  return {
    requestId,
    currentPluginsTreeSha256: treeDigest,
    maintenanceWindowStartUtc: startUtc,
    maintenanceWindowEndUtc: endUtc
  }
}

function applyInput(): NebulaPluginApplyMutationRequest {
  return {
    requestId,
    planDigest,
    confirmationPhrase: `CONFIRM NEBULA PLUGIN CUTOVER ${requestId} ${planDigest}`
  }
}

function rollbackPreviewInput(): NebulaPluginRollbackPreviewRequest {
  return {
    originalRequestId: requestId,
    rollbackRequestId,
    originalReceiptSha256: receiptDigest,
    maintenanceWindowStartUtc: startUtc,
    maintenanceWindowEndUtc: endUtc
  }
}

function rollbackInputExpected(): NebulaPluginRollbackMutationRequest {
  return {
    ...rollbackPreviewInput(),
    previewDigest,
    confirmationPhrase: rollbackPhrase
  }
}

const rollbackPhrase = `CONFIRM NEBULA PLUGIN ROLLBACK ${rollbackRequestId} ${previewDigest}`

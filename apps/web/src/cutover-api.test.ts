import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  api,
  ApiError,
  CUTOVER_ACTIVATE_CONFIRMATION,
  CUTOVER_PREPARE_CONFIRMATION,
  CUTOVER_RECOVERY_CONFIRMATION,
  CUTOVER_ROLLBACK_CONFIRMATION
} from './api'
import type {
  ControlPermission,
  CutoverPreviewReceipt,
  CutoverReceipt,
  CutoverRecoveryStatus,
  SessionUser
} from './model'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('cutover strict web client', () => {
  it('reads only the bounded durable status projection with no cache', async () => {
    const status = readyStatus()
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, data: status }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.cutoverStatus()).resolves.toEqual({ data: status })
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/cutover/status', expect.objectContaining({
      credentials: 'same-origin',
      cache: 'no-store'
    }))
  })

  it('submits only exact UUIDs, fixed operations, and server confirmation literals', async () => {
    const bodies: Array<{ path: string; value: Record<string, unknown> }> = []
    const fetchMock = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      bodies.push({ path: String(path), value: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return jsonResponse({ ok: true, data: receiptForPath(String(path)) }, 202)
    })
    vi.stubGlobal('fetch', fetchMock)

    await api.prepareCutover(requestId, planFingerprint, CUTOVER_PREPARE_CONFIRMATION)
    await api.activateCutover(otherRequestId, planFingerprint, CUTOVER_ACTIVATE_CONFIRMATION)
    await api.rollbackCutover(
      thirdRequestId,
      'later-operator-rollback',
      planFingerprint,
      CUTOVER_ROLLBACK_CONFIRMATION
    )
    await api.recoverCutover(requestId, 'previous', CUTOVER_RECOVERY_CONFIRMATION)

    expect(bodies).toEqual([
      {
        path: '/api/v1/cutover/prepare',
        value: { requestId, planFingerprint, confirmation: 'PREPARE_GSMANAGER_TO_DYSON' }
      },
      {
        path: '/api/v1/cutover/activate',
        value: { requestId: otherRequestId, planFingerprint, confirmation: 'ACTIVATE_GSMANAGER_TO_DYSON' }
      },
      {
        path: '/api/v1/cutover/rollback',
        value: {
          requestId: thirdRequestId,
          mode: 'later-operator-rollback',
          planFingerprint,
          confirmation: 'ROLLBACK_DYSON_TO_GSMANAGER'
        }
      },
      {
        path: '/api/v1/cutover/recover',
        value: { requestId, desired: 'previous', confirmation: 'RECOVER_GSMANAGER_CUTOVER' }
      }
    ])
    expect(JSON.stringify(bodies.map((entry) => entry.value)))
      .not.toMatch(/"(?:host|path|command|executable|task|port)"\s*:/i)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('rejects malformed or overbroad status and receipt envelopes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      ok: true,
      data: { ...readyStatus(), path: 'C:\\Private\\must-not-cross-browser-boundary' }
    })))

    const statusError = await api.cutoverStatus().then(() => null, (reason: unknown) => reason)
    expect(statusError).toBeInstanceOf(ApiError)
    expect(statusError).toMatchObject({
      status: 502,
      code: 'CUTOVER_BROWSER_RESPONSE_INVALID'
    })

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      ok: true,
      data: { ...receipt(), internalCommand: 'powershell -private' }
    }, 202)))
    const receiptError = await api.prepareCutover(
      requestId,
      planFingerprint,
      CUTOVER_PREPARE_CONFIRMATION
    )
      .then(() => null, (reason: unknown) => reason)
    expect(receiptError).toMatchObject({ status: 502, code: 'CUTOVER_BROWSER_RESPONSE_INVALID' })
  })

  it('maps code-only 423 gates without exposing an untrusted server message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      ok: false,
      error: {
        code: 'CUTOVER_HTTP_MUTATION_DISABLED',
        message: 'C:\\Private\\task.xml secret-token'
      }
    }, 423)))

    const error = await api.prepareCutover(requestId, planFingerprint, CUTOVER_PREPARE_CONFIRMATION)
      .then(() => null, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      status: 423,
      code: 'CUTOVER_HTTP_MUTATION_DISABLED',
      message: 'Cutover 普通切换门禁默认关闭；当前只允许读取与预演。'
    })
    expect(JSON.stringify(error)).not.toContain('Private')
  })

  it('rejects the old signature, missing fingerprint, or non-exact confirmation locally before fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const unsafePrepare = api.prepareCutover as unknown as (
      requestId: string,
      planFingerprint?: string,
      confirmation?: string
    ) => Promise<unknown>

    const invalidArguments: Array<[string | undefined, string | undefined]> = [
      [CUTOVER_PREPARE_CONFIRMATION, undefined],
      [undefined, CUTOVER_PREPARE_CONFIRMATION],
      ['A'.repeat(64), CUTOVER_PREPARE_CONFIRMATION],
      [` ${planFingerprint}`, CUTOVER_PREPARE_CONFIRMATION],
      [planFingerprint, undefined],
      [planFingerprint, 'PREPARE']
    ]
    for (const [fingerprint, confirmation] of invalidArguments) {
      const error = await unsafePrepare(requestId, fingerprint, confirmation)
        .then(() => null, (reason: unknown) => reason)
      expect(error).toMatchObject({ status: 400, code: 'CUTOVER_BROWSER_REQUEST_INVALID' })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends and strictly binds a server preview to its normalized request context', async () => {
    const fetchMock = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ requestId, operation: 'prepare' })
      return jsonResponse({ ok: true, data: preview() })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.previewCutover({
      requestId: requestId.toUpperCase(),
      operation: 'prepare'
    })).resolves.toEqual({ data: preview() })
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/cutover/preview', expect.objectContaining({
      method: 'POST'
    }))

    for (const patch of [
      { requestId: otherRequestId },
      { operation: 'activate' },
      { planFingerprint: 'A'.repeat(64) },
      { evidenceDigest: 'short' },
      { internalPath: 'C:\\private' }
    ]) {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
        ok: true,
        data: { ...preview(), ...patch }
      })))
      await expect(api.previewCutover({ requestId, operation: 'prepare' }))
        .rejects.toMatchObject({ status: 502, code: 'CUTOVER_BROWSER_RESPONSE_INVALID' })
    }
  })

  it.each([
    ['wrong request id', { requestId: otherRequestId }],
    ['wrong phase', { phase: 'activated' as const }],
    ['failed-safe', { status: 'failed-safe' as const }],
    ['non-null error', { errorCode: 'CUTOVER_RUNTIME_DRIFT' as const }],
    ['non-empty allowedDesired', { allowedDesired: ['previous'] as const }]
  ])('rejects a %s execute receipt against the captured request context', async (_name, patch) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      ok: true,
      data: { ...receipt(), ...patch }
    }, 202)))

    await expect(api.prepareCutover(requestId, planFingerprint, CUTOVER_PREPARE_CONFIRMATION))
      .rejects.toMatchObject({ status: 502, code: 'CUTOVER_BROWSER_RESPONSE_INVALID' })
  })

  it('keeps lifecycle.read in the typed session permission contract', async () => {
    const lifecycleRead = 'lifecycle.read' satisfies ControlPermission
    const user: SessionUser = {
      name: 'Viewer',
      role: 'viewer',
      permissions: ['status.read', lifecycleRead]
    }
    const fetchMock = vi.fn(async () => jsonResponse({ user }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.session()).resolves.toEqual({ user })
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/session', expect.objectContaining({
      credentials: 'same-origin'
    }))
  })
})

const requestId = '11111111-1111-4111-8111-111111111111'
const otherRequestId = '22222222-2222-4222-8222-222222222222'
const thirdRequestId = '33333333-3333-4333-8333-333333333333'
const planFingerprint = 'a'.repeat(64)

function preview(): CutoverPreviewReceipt {
  return {
    format: 'dyson-control-cutover-preview',
    schemaVersion: 1,
    operation: 'prepare',
    requestId,
    rollbackMode: null,
    stateRevision: 'b'.repeat(64),
    evidenceDigest: 'c'.repeat(64),
    planFingerprint,
    summary: summary()
  }
}

function readyStatus(): CutoverRecoveryStatus {
  return {
    schemaVersion: 1,
    phase: 'ready',
    status: 'ready',
    mutationBlocked: false,
    recoveryRequired: false,
    requestId: null,
    allowedDesired: [],
    summary: summary(),
    errorCode: null
  }
}

function receipt(
  phase: CutoverReceipt['phase'] = 'prepared',
  id = requestId,
  status: CutoverReceipt['status'] = 'succeeded'
): CutoverReceipt {
  return {
    requestId: id,
    phase,
    status,
    allowedDesired: [],
    summary: summary(),
    errorCode: null
  }
}

function receiptForPath(path: string): CutoverReceipt {
  if (path.endsWith('/activate')) return receipt('activated', otherRequestId)
  if (path.endsWith('/rollback')) return receipt('rolled-back-later', thirdRequestId, 'rolled-back')
  if (path.endsWith('/recover')) return receipt('recovered-previous')
  return receipt()
}

function summary(): CutoverReceipt['summary'] {
  return {
    candidateDefined: true,
    candidateDisabled: true,
    previousAuthorityEnabled: true,
    candidateAuthorityEnabled: false,
    previousRuntimeHealthy: true,
    candidateRuntimeHealthy: false,
    processesStopped: false,
    portClosed: false,
    uniqueAuthority: true,
    saveProtected: true,
    baselineRestored: false,
    currentProgressProtected: false,
    reused: false
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

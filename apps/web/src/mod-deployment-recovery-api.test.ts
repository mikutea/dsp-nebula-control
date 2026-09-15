import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('mod deployment recovery web client', () => {
  it('reads only the bounded recovery projection and submits the fixed recovery contract', async () => {
    const requestId = '11111111-1111-4111-8111-111111111111'
    const status = {
      phase: 'recovery-required' as const,
      requestId,
      operation: 'install' as const,
      allowedDesired: ['candidate', 'previous'] as Array<'candidate' | 'previous'>
    }
    const receipt = {
      format: 'dyson-control-mod-deployment-receipt' as const,
      schemaVersion: 1 as const,
      requestId,
      operation: 'install' as const,
      package: { dependencyId: 'Fictional-ModConsole-1.0.0', version: '1.0.0' },
      status: 'rolled-back' as const,
      previousRevision: '0'.repeat(64),
      newRevision: null,
      rollback: 'succeeded' as const,
      recoveryPointCreated: true,
      recoverablePayloadPreserved: false,
      payloadFileCount: 2,
      payloadSizeBytes: 4096,
      errorCode: 'MOD_DEPLOYMENT_EXECUTION_FAILED' as const,
      reused: false
    }
    const fetchMock = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        expect(path).toBe('/api/v1/mods/deployment/recovery/execute')
        expect(JSON.parse(String(init.body))).toEqual({
          requestId,
          desired: 'previous',
          confirmation: 'RECOVER_MOD_DEPLOYMENT'
        })
        expect(String(init.body)).not.toMatch(/(?:path|fingerprint|manifest|command|plugins|staging)/i)
        return new Response(JSON.stringify({ data: receipt }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      expect(path).toBe('/api/v1/mods/deployment/recovery/status')
      return new Response(JSON.stringify({ data: status, meta: { executionEnabled: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.modDeploymentRecoveryStatus()).resolves.toEqual({
      data: status,
      meta: { executionEnabled: true }
    })
    await expect(api.recoverModDeployment(requestId, 'previous')).resolves.toEqual({ data: receipt })
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v1/mods/deployment/recovery/execute',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' })
    )
  })

  it('rejects malformed or overbroad recovery status instead of opening the ordinary mutation UI', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: {
        phase: 'ready', requestId: null, operation: null, allowedDesired: [],
        path: 'C:\\Fictional\\Must-Not-Be-Accepted'
      },
      meta: { executionEnabled: true }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })))

    const error = await api.modDeploymentRecoveryStatus().then(() => null, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      status: 502,
      code: 'MOD_DEPLOYMENT_RECOVERY_BROWSER_RESPONSE_INVALID'
    })
  })
})

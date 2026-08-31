import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'
import type { UpdateActivationRequest, UpdateActivationState } from './model'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('component update activation web client', () => {
  it('unwraps the flat success envelope for the bounded state endpoint', async () => {
    const state = stateFixture()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: state }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.updateActivationState()).resolves.toEqual({ data: state })
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/updates/activation/state', expect.objectContaining({
      credentials: 'same-origin'
    }))
  })

  it('submits only the fixed logical execute contract and component confirmation', async () => {
    const request = requestFixture()
    const fetchMock = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(body).toMatchObject({
        requestId: request.requestId,
        component: 'nebula',
        artifactId: request.artifactId,
        confirmation: 'ACTIVATE_NEBULA_UPDATE'
      })
      expect(JSON.stringify(body)).not.toMatch(/"(?:path|url|command|executable|credential|archive|zip)"\s*:/i)
      return new Response(JSON.stringify({ ok: true, data: receiptFixture }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' }
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.executeUpdateActivation(request, 'ACTIVATE_NEBULA_UPDATE')).resolves.toEqual({
      data: receiptFixture
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/updates/activation/execute', expect.objectContaining({
      method: 'POST', credentials: 'same-origin'
    }))
  })

  it('maps a code-only 423 envelope to an explicit fail-closed error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: { code: 'UPDATE_ACTIVATION_HTTP_MUTATION_DISABLED' }
    }), {
      status: 423,
      headers: { 'Content-Type': 'application/json' }
    })))

    const error = await api.executeUpdateActivation(requestFixture(), 'ACTIVATE_NEBULA_UPDATE')
      .then(() => null, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      status: 423,
      code: 'UPDATE_ACTIVATION_HTTP_MUTATION_DISABLED',
      message: '组件激活门禁为 fail-closed；当前只允许读取与预演。'
    })
  })
})

function stateFixture(): UpdateActivationState {
  return {
    revision: '1'.repeat(64), recoveryRequired: false, components: [], historyEntries: 0
  }
}

function requestFixture(): UpdateActivationRequest {
  return {
    requestId: '11111111-1111-4111-8111-111111111111', component: 'nebula',
    artifactId: 'fictional-nebula-artifact-0001', sha256: 'a'.repeat(64),
    targetVersion: '0.9.23.0', expectedRevision: '1'.repeat(64),
    compatibilityReceiptId: '22222222-2222-4222-8222-222222222222'
  }
}

const receiptFixture = {
  format: 'dyson-control-component-update-receipt' as const,
  schemaVersion: 1 as const,
  requestId: '11111111-1111-4111-8111-111111111111', component: 'nebula' as const,
  artifactId: 'fictional-nebula-artifact-0001', targetVersion: '0.9.23.0',
  compatibilityReceiptId: '22222222-2222-4222-8222-222222222222',
  releaseId: `nebula-${'e'.repeat(32)}`, status: 'succeeded' as const,
  previousRevision: '1'.repeat(64), resultingRevision: '2'.repeat(64),
  protectionBackupId: 'fictional-backup-0001', failureCode: null, rollbackVerified: false,
  recoveryRequired: false, fileCount: 7, expandedBytes: 262_144,
  completedAt: '2026-08-30T12:30:00.000Z', reused: false
}

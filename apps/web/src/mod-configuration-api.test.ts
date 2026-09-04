import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import type { ManagedModConfigurationRequest } from './model'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('managed mod configuration web client', () => {
  it('sends only the fixed logical configuration request and server-owned confirmation', async () => {
    const input = requestFixture()
    const requestFingerprint = 'c'.repeat(64)
    const fetchMock = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { request: ManagedModConfigurationRequest; confirmation: Record<string, unknown> }
      expect(body).toEqual({
        request: input,
        confirmation: {
          action: 'EXECUTE_MOD_CONFIGURATION', requestId: input.requestId, schemaId: input.schemaId,
          dependencyId: input.package.dependencyId, version: input.package.version,
          expectedDeploymentRevision: input.expectedDeploymentRevision, expectedConfigurationRevision: input.expectedConfigurationRevision,
          requestFingerprint,
          confirmation: 'CONFIGURE_MANAGED_MOD'
        }
      })
      expect(JSON.stringify(body)).not.toMatch(/"(?:path|fileName|section|key|command|script|archive|zip)"\s*:/i)
      return jsonResponse({ data: { requestId: input.requestId, status: 'applied' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.executeManagedModConfiguration(input, requestFingerprint)).resolves.toEqual({ data: { requestId: input.requestId, status: 'applied' } })
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/mods/configuration/execute', expect.objectContaining({ method: 'POST', credentials: 'same-origin' }))
  })

  it('encodes bounded opaque history parameters without exposing a host path', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: { format: 'dyson-control-managed-mod-configuration-history', schemaVersion: 1, items: [], page: { limit: 8, returned: 0, totalReceipts: 0, nextCursor: null } } }))
    vi.stubGlobal('fetch', fetchMock)
    await api.managedModConfigurationHistory({ cursor: 'MA', pageSize: 8 })
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/mods/configuration/history?cursor=MA&pageSize=8', expect.objectContaining({ credentials: 'same-origin' }))
  })
})

function requestFixture(): ManagedModConfigurationRequest {
  return {
    requestId: '11111111-1111-4111-8111-111111111111', operation: 'configure', schemaId: 'nebula-server-v0-9-22',
    package: { dependencyId: 'nebula-NebulaMultiplayerMod-0.9.22', version: '0.9.22' },
    expectedDeploymentRevision: 'a'.repeat(64), expectedConfigurationRevision: 'b'.repeat(64), changes: [{ id: 'host-port', value: 9443 }]
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

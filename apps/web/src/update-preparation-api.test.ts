import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'
import type {
  BepInExDiscoveryEnvelope,
  ComponentCandidatePreparationPlan,
  ComponentCandidatePreparationReceipt
} from './model'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('component candidate preparation web client', () => {
  it('discovers the fixed official BepInEx source with an abortable empty request', async () => {
    const envelope = bepInExDiscoveryEnvelope()
    const controller = new AbortController()
    const fetchMock = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({})
      expect(init?.signal).toBe(controller.signal)
      return jsonResponse(envelope, 200)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.discoverBepInEx(controller.signal)).resolves.toEqual(envelope)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/updates/discovery/bepinex',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' })
    )
  })

  it('submits only UUID/component references and the fixed preparation confirmation', async () => {
    const acquisitionReceiptId = '11111111-1111-4111-8111-111111111111'
    const requestId = '22222222-2222-4222-8222-222222222222'
    const fetchMock = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      const value = String(path)
      if (value.endsWith('/preview')) {
        expect(JSON.parse(String(init?.body))).toEqual({
          component: 'nebula', acquisitionReceiptId
        })
        return jsonResponse({ ok: true, data: planFixture(acquisitionReceiptId) }, 200)
      }
      if (value.endsWith('/execute')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        expect(body).toEqual({
          requestId,
          component: 'nebula',
          acquisitionReceiptId,
          confirmation: 'PREPARE_COMPONENT_CANDIDATE'
        })
        expect(JSON.stringify(body)).not.toMatch(
          /"(?:path|url|command|executable|credential|archive|zip|sha256)"\s*:/i
        )
        return jsonResponse({ ok: true, data: receiptFixture(requestId, acquisitionReceiptId) }, 201)
      }
      return jsonResponse({ ok: true, data: receiptFixture(requestId, acquisitionReceiptId) }, 200)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.previewComponentCandidatePreparation('nebula', acquisitionReceiptId))
      .resolves.toEqual({ data: planFixture(acquisitionReceiptId) })
    await expect(api.executeComponentCandidatePreparation(requestId, 'nebula', acquisitionReceiptId))
      .resolves.toEqual({ data: receiptFixture(requestId, acquisitionReceiptId) })
    await expect(api.componentCandidatePreparationReceipt(requestId))
      .resolves.toEqual({ data: receiptFixture(requestId, acquisitionReceiptId) })
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      `/api/v1/updates/preparation/component/receipts/${requestId}`,
      expect.objectContaining({ credentials: 'same-origin' })
    )
  })

  it.each([
    [404, 'CANDIDATE_PREPARATION_RECEIPT_NOT_FOUND', '没有找到该 UUID 对应的组件候选准备回执。'],
    [422, 'UPDATE_NEBULA_LAYOUT_INVALID', '组件候选准备请求或官方制品布局未通过严格核验。'],
    [423, 'CANDIDATE_PREPARATION_MUTATION_DISABLED', '组件候选准备门禁为 fail-closed；当前只允许读取与预演。'],
    [503, 'CANDIDATE_PREPARATION_UNAVAILABLE', '组件候选准备服务暂不可用；激活保持锁定。']
  ] as const)('maps HTTP %s to a stable fail-closed preparation message', async (status, code, message) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: false, error: { code } }, status)))

    const error = await api.componentCandidatePreparationReceipt(
      '22222222-2222-4222-8222-222222222222'
    ).then(() => null, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status, code, message })
  })
})

function bepInExDiscoveryEnvelope(): BepInExDiscoveryEnvelope {
  return {
    data: {
      items: [{
        provider: 'github',
        sourceId: 'github:BepInEx/BepInEx',
        releaseId: 540235,
        version: '5.4.23.5',
        publishedAt: '2026-08-30T01:00:00.000Z',
        layoutPolicy: 'bepinex5-win-x64-5.4.23.2-5-v1',
        artifact: {
          artifactId: `bepinex-${'a'.repeat(40)}`,
          downloadUrl: 'https://github.com/BepInEx/BepInEx/releases/download/v5.4.23.5/BepInEx_win_x64_5.4.23.5.zip',
          fileName: 'BepInEx_win_x64_5.4.23.5.zip',
          sizeBytes: 638_940,
          sha256: 'b'.repeat(64),
          integrity: 'provider-sha256'
        }
      }],
      pagesFetched: 1,
      truncated: false
    },
    meta: { acquisition: { configured: false, executionEnabled: false, candidates: [] } }
  }
}

function planFixture(acquisitionReceiptId: string): ComponentCandidatePreparationPlan {
  return {
    format: 'dyson-control-component-preparation-plan',
    schemaVersion: 1,
    available: true,
    dryRun: true,
    component: 'nebula',
    acquisitionReceiptId,
    source: {
      provider: 'github', sourceId: 'github:NebulaModTeam/nebula', version: '0.9.22',
      artifactId: `source-nebula-${'a'.repeat(32)}`, sizeBytes: 4_096,
      sha256: 'b'.repeat(64), integrity: 'provider-verified'
    },
    prepared: {
      mode: 'normalized-nebula-windows',
      artifactId: `prepared-nebula-${'c'.repeat(40)}`,
      layoutPolicy: 'nebula-official-windows-v0.9.22'
    },
    operations: ['load-validated-acquisition-receipt', 'stage-verified-artifact'],
    activation: { automatic: false, nextAction: 'component-update-activation-preview' }
  }
}

function receiptFixture(requestId: string, acquisitionReceiptId: string): ComponentCandidatePreparationReceipt {
  const plan = planFixture(acquisitionReceiptId)
  if (!plan.available) throw new Error('expected available plan')
  const sha256 = 'd'.repeat(64)
  return {
    format: 'dyson-control-component-preparation-receipt',
    schemaVersion: 1,
    requestId,
    component: 'nebula',
    acquisitionReceiptId,
    source: plan.source,
    prepared: {
      ...plan.prepared,
      sizeBytes: 2_048,
      sha256,
      integrity: 'normalized-locally-computed'
    },
    staging: {
      created: true,
      manifest: {
        format: 'dyson-control-staged-artifact', schemaVersion: 1,
        artifactId: plan.prepared.artifactId, artifactFile: 'artifact.bin',
        release: { kind: 'nebula', sourceId: plan.source.sourceId, version: plan.source.version },
        sizeBytes: 2_048, sha256, integrity: 'locally-computed',
        stagedAt: '2026-08-30T08:00:00.000Z'
      }
    },
    state: 'staged',
    reused: false,
    preparedAt: '2026-08-30T08:00:00.000Z'
  }
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

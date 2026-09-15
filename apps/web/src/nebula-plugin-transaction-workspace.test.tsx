// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NebulaPluginTransactionWorkspace } from './NebulaPluginTransactionWorkspace'
import { VersionUpdateWorkspace } from './VersionUpdateWorkspace'
import type { ServerStatus, SessionUser } from './model'

const requestId = '11111111-1111-4111-8111-111111111111'
const treeDigest = '1'.repeat(64)
const planDigest = '2'.repeat(64)
const applyReceiptDigest = '3'.repeat(64)
const rollbackPreviewDigest = '4'.repeat(64)
const rollbackReceiptDigest = '5'.repeat(64)
const startUtc = '2030-01-01T00:00:00Z'
const endUtc = '2030-01-01T01:00:00Z'
const applyPhrase = `CONFIRM NEBULA PLUGIN CUTOVER ${requestId} ${planDigest}`

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Nebula whole-tree transaction workspace', () => {
  it('requires matched dry-runs and persistent verification after apply and rollback', async () => {
    const calls: Array<{ path: string; body: Record<string, string> }> = []
    vi.stubGlobal('fetch', vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, string>
      calls.push({ path: String(path), body })
      return transactionResponse(String(path), body)
    }))

    render(<NebulaPluginTransactionWorkspace demo={false} user={administrator()} />)
    fillPlan()
    fireEvent.click(screen.getByRole('button', { name: '生成 plan + apply dry-run' }))

    const applyButton = await screen.findByRole('button', { name: '执行 apply 并核验' }) as HTMLButtonElement
    expect(applyButton.disabled).toBe(true)
    expect(screen.getByRole('button', { name: '显式恢复 apply' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Nebula apply 精确确认'), {
      target: { value: applyPhrase }
    })
    expect(applyButton.disabled).toBe(false)
    fireEvent.click(applyButton)

    expect(await screen.findByText(`${'applied'} · ${applyReceiptDigest}`)).toBeTruthy()
    expect(calls.map((call) => call.path).slice(0, 4)).toEqual([
      '/api/v1/updates/nebula-plugin-transaction/plan',
      '/api/v1/updates/nebula-plugin-transaction/apply/preview',
      '/api/v1/updates/nebula-plugin-transaction/apply',
      '/api/v1/updates/nebula-plugin-transaction/apply/verify'
    ])

    fireEvent.change(screen.getByLabelText('Nebula rollback 窗口开始 UTC'), {
      target: { value: '2030-01-01T02:00:00Z' }
    })
    fireEvent.change(screen.getByLabelText('Nebula rollback 窗口结束 UTC'), {
      target: { value: '2030-01-01T03:00:00Z' }
    })
    fireEvent.click(screen.getByRole('button', { name: '生成 rollback dry-run' }))

    const rollbackInput = await screen.findByLabelText('Nebula rollback 精确确认')
    const rollbackPreviewCall = calls.find((call) => call.path.endsWith('/rollback/preview'))!
    const rollbackPhrase = `CONFIRM NEBULA PLUGIN ROLLBACK ${rollbackPreviewCall.body.rollbackRequestId} ${rollbackPreviewDigest}`
    fireEvent.change(rollbackInput, { target: { value: rollbackPhrase } })
    fireEvent.click(screen.getByRole('button', { name: '执行 rollback 并核验' }))

    expect(await screen.findByText(`rolled-back-manual · ${rollbackReceiptDigest}`)).toBeTruthy()
    expect(calls.map((call) => call.path).slice(-2)).toEqual([
      '/api/v1/updates/nebula-plugin-transaction/rollback',
      '/api/v1/updates/nebula-plugin-transaction/rollback/verify'
    ])
    expect(calls.some((call) => call.path.includes('/recover'))).toBe(false)
    expect(screen.getAllByText('VERIFIED').length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(calls.map((call) => call.body)))
      .not.toMatch(/"(?:path|script|command|url|executable|credential)"\s*:/iu)
  })

  it('keeps mutation and recovery unavailable to a Viewer', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path: RequestInfo | URL, init?: RequestInit) =>
      transactionResponse(String(path), JSON.parse(String(init?.body)) as Record<string, string>)))
    render(<NebulaPluginTransactionWorkspace demo={false} user={viewer()} />)
    fillPlan()
    fireEvent.click(screen.getByRole('button', { name: '生成 plan + apply dry-run' }))

    const applyButton = await screen.findByRole('button', { name: '需要 Administrator' }) as HTMLButtonElement
    fireEvent.change(screen.getByLabelText('Nebula apply 精确确认'), {
      target: { value: applyPhrase }
    })
    expect(applyButton.disabled).toBe(true)
    expect(screen.queryByRole('button', { name: '显式恢复 apply' })).toBeNull()
  })

  it('rejects a mismatched preview and never exposes apply execution', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, string>
      if (String(path).endsWith('/apply/preview')) {
        return jsonResponse({
          requestId,
          targetRole: 'Server',
          status: 'preview',
          mode: 'dry-run',
          planDigest: '9'.repeat(64),
          confirmationRequired: true,
          productionChanged: false
        })
      }
      return transactionResponse(String(path), body)
    }))
    render(<NebulaPluginTransactionWorkspace demo={false} user={administrator()} />)
    fillPlan()
    fireEvent.click(screen.getByRole('button', { name: '生成 plan + apply dry-run' }))

    expect((await screen.findByRole('alert')).textContent).toMatch(/身份或摘要不一致/)
    expect(screen.queryByRole('button', { name: '执行 apply 并核验' })).toBeNull()
  })

  it('latches only the ordinary gate closed after a 423 and never auto-recovers', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      const endpoint = String(path)
      calls.push(endpoint)
      if (endpoint.endsWith('/apply')) {
        return new Response(JSON.stringify({
          ok: false,
          error: { code: 'NEBULA_PLUGIN_TRANSACTION_MUTATION_DISABLED' }
        }), {
          status: 423,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      return transactionResponse(
        endpoint,
        JSON.parse(String(init?.body)) as Record<string, string>
      )
    }))
    render(<NebulaPluginTransactionWorkspace demo={false} user={administrator()} />)
    fillPlan()
    fireEvent.click(screen.getByRole('button', { name: '生成 plan + apply dry-run' }))
    const applyButton = await screen.findByRole('button', { name: '执行 apply 并核验' }) as HTMLButtonElement
    fireEvent.change(screen.getByLabelText('Nebula apply 精确确认'), {
      target: { value: applyPhrase }
    })
    fireEvent.click(applyButton)

    expect(await screen.findByText('MUTATION CLOSED')).toBeTruthy()
    expect(applyButton.disabled).toBe(true)
    expect((screen.getByRole('button', { name: '显式恢复 apply' }) as HTMLButtonElement).disabled).toBe(false)
    expect(calls.filter((path) => path.endsWith('/apply'))).toHaveLength(1)
    expect(calls.some((path) => path.includes('/recover'))).toBe(false)
  })

  it('renders Bridge and Control as read-only unavailable inventory without fictional sources', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<VersionUpdateWorkspace status={statusFixture()} demo={true} user={administrator()} />)

    await waitFor(() => expect(screen.getByLabelText('Bridge 自更新不可用')).toBeTruthy())
    expect(screen.getByLabelText('Control 自更新不可用')).toBeTruthy()
    expect(screen.queryByText('thunderstore:DysonControl/Bridge')).toBeNull()
    expect(screen.queryByText('thunderstore:DysonControl/Control')).toBeNull()
    expect(screen.getAllByText('自更新 provider 未装配 · READ ONLY')).toHaveLength(2)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

function fillPlan(): void {
  fireEvent.change(screen.getByLabelText('Nebula 资格化候选 request ID'), {
    target: { value: requestId }
  })
  fireEvent.change(screen.getByLabelText('Nebula 当前插件树 SHA-256'), {
    target: { value: treeDigest }
  })
  fireEvent.change(screen.getByLabelText('Nebula 维护窗口开始 UTC'), {
    target: { value: startUtc }
  })
  fireEvent.change(screen.getByLabelText('Nebula 维护窗口结束 UTC'), {
    target: { value: endUtc }
  })
}

function transactionResponse(path: string, body: Record<string, string>): Response {
  if (path.endsWith('/plan')) return jsonResponse({
    requestId, targetRole: 'Server', mode: 'dry-run', executionEnabled: false,
    planDigest, productionChanged: false
  })
  if (path.endsWith('/apply/preview')) return jsonResponse({
    requestId, targetRole: 'Server', status: 'preview', mode: 'dry-run', planDigest,
    confirmationRequired: true, productionChanged: false
  })
  if (path.endsWith('/apply/verify')) return jsonResponse({
    requestId, targetRole: 'Server', transactionStatus: 'applied',
    receiptDigest: applyReceiptDigest, contentAndAclExact: true, rollbackMaterialRetained: true
  })
  if (path.endsWith('/apply') || path.endsWith('/apply/recover')) return jsonResponse({
    requestId, status: 'applied', receiptDigest: applyReceiptDigest, reused: false,
    quarantineRetained: true, candidateStageRetained: false
  })
  if (path.endsWith('/rollback/preview')) return jsonResponse({
    originalRequestId: requestId,
    rollbackRequestId: body.rollbackRequestId,
    status: 'preview',
    mode: 'dry-run',
    previewDigest: rollbackPreviewDigest,
    exactConfirmationPhrase:
      `CONFIRM NEBULA PLUGIN ROLLBACK ${body.rollbackRequestId} ${rollbackPreviewDigest}`,
    productionChanged: false
  })
  if (path.endsWith('/rollback/verify')) return jsonResponse({
    originalRequestId: requestId,
    rollbackRequestId: body.rollbackRequestId,
    transactionStatus: 'rolled-back-manual',
    receiptDigest: rollbackReceiptDigest,
    contentAndAclExact: true,
    rollbackMaterialRetained: true
  })
  return jsonResponse({
    originalRequestId: requestId,
    rollbackRequestId: body.rollbackRequestId,
    status: 'rolled-back-manual',
    receiptDigest: rollbackReceiptDigest,
    reused: false,
    quarantineRetained: false,
    candidateStageRetained: true
  })
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

function administrator(): SessionUser {
  return {
    name: 'Administrator',
    role: 'administrator',
    permissions: ['updates.read', 'updates.stage', 'updates.activate']
  }
}

function viewer(): SessionUser {
  return { name: 'Viewer', role: 'viewer', permissions: ['updates.read'] }
}

function statusFixture(): ServerStatus {
  return {
    collectedAt: '2026-08-30T12:00:00.000Z', serverName: 'Fictional DSP', state: 'stopped',
    runtime: {
      targetUps: 60, onlinePlayers: 0, maxPlayers: 16, processId: null, processCoresUsed: null,
      workingSetGiB: null, privateMemoryGiB: null, threadCount: null, priority: null,
      startedAt: null, uptimeSeconds: null
    },
    host: {
      logicalProcessors: 16, processorGroups: 1, cpuPercent: 5, memoryTotalGiB: 64,
      memoryFreeGiB: 50
    },
    versions: {
      dsp: '0.10.33.26727', nebula: '0.9.22.2', bepInEx: '5.4.23', compatible: true,
      gameLoaded: false, warnings: []
    },
    save: {
      name: 'FictionalSave', dsvPresent: true, serverPresent: true, consistent: true,
      lastSavedAt: '2026-08-30T11:00:00.000Z', dsvSizeMiB: 8, serverSizeKiB: 64,
      latestBackupAt: '2026-08-30T11:30:00.000Z', backupManifestPresent: true,
      backupPairPresent: true
    },
    automation: {
      serverTask: { state: 'ready', lastResult: 0, lastRunAt: null },
      stopTask: { state: 'ready', lastResult: 0, lastRunAt: null },
      storageTask: { state: 'ready', lastResult: 0, lastRunAt: null },
      projectRootAvailable: true, globalMappingAvailable: true
    },
    connections: [],
    capabilities: { refresh: true, start: true, save: true, gracefulStop: true, restart: true }
  }
}

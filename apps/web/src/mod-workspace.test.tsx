// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModWorkspace } from './App'
import { api, ApiError } from './api'
import type {
  ModDeploymentPreview,
  ModDeploymentReceipt,
  ModDeploymentReceiptHistoryPage,
  ModDeploymentRequest,
  ModDeploymentStateSummary
} from './model'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

beforeEach(() => {
  vi.spyOn(api, 'modDeploymentHistory').mockResolvedValue({ data: historyPageFixture() })
  vi.spyOn(api, 'modDeploymentReceipt').mockResolvedValue({ data: receiptFixture() })
})

describe('mod deployment workspace', () => {
  it('loads inventory, previews a local logical request, requires exact confirmation, and renders its receipt', async () => {
    const state = stateFixture()
    vi.spyOn(api, 'modDeploymentState').mockResolvedValue({ data: state, meta: { executionEnabled: true } })
    vi.spyOn(api, 'modDeploymentRecovery').mockResolvedValue({
      data: {
        dryRun: true,
        irreversible: true,
        executeSupported: false,
        candidates: [{ id: 'snapshot-fictional-0001', kind: 'snapshot' }]
      }
    })
    mockRecoveryReady(true)
    const preview = previewFixture()
    vi.spyOn(api, 'previewModDeployment').mockResolvedValue({ data: preview, meta: { executionEnabled: true } })
    vi.spyOn(api, 'executeModDeployment').mockResolvedValue({ data: receiptFixture() })
    render(<ModWorkspace demo={false} />)

    expect(await screen.findByText('Fictional/InstalledCore')).toBeTruthy()
    expect(screen.getByText('1 个托管包')).toBeTruthy()
    expect(screen.queryByText('FAIL-CLOSED')).toBeNull()

    const request = requestFixture()
    const file = jsonFile('fictional-mod-request.json', request)
    fireEvent.change(screen.getByLabelText('选择模组部署请求 JSON'), { target: { files: [file] } })
    expect(await screen.findByText('fictional-mod-request.json')).toBeTruthy()
    expect(screen.getAllByText(request.package.dependencyId).length).toBeGreaterThan(0)
    expect(screen.getByText(/路径不会发送到浏览器/)).toBeTruthy()
    for (const label of ['安装', '更新', '启用', '禁用', '移除']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${label}`) })).toBeTruthy()
    }

    fireEvent.click(screen.getByRole('button', { name: '生成部署预演' }))
    expect(await screen.findByText('预演已通过全部一致性门禁')).toBeTruthy()
    expect(screen.getByText(/已通过服务端固定暂存根与载荷校验/)).toBeTruthy()
    expect(screen.getByText('执行时检查两次')).toBeTruthy()

    const execute = screen.getByRole('button', { name: '执行模组事务' }) as HTMLButtonElement
    expect(execute.disabled).toBe(true)
    const phrase = `EXECUTE INSTALL ${request.package.dependencyId}`
    fireEvent.change(screen.getByLabelText('模组部署精确确认'), { target: { value: phrase } })
    expect(execute.disabled).toBe(false)
    fireEvent.click(execute)

    expect(await screen.findByText('部署事务已提交')).toBeTruthy()
    expect(api.executeModDeployment).toHaveBeenCalledWith(request)
    expect(JSON.stringify(vi.mocked(api.executeModDeployment).mock.calls[0]?.[0])).not.toMatch(
      /(?:[A-Za-z]:\\|\\\\|\/tmp\/|https?:\/\/|\.zip|command|stagingPath|pluginsRoot)/i
    )
    expect(screen.getByText('事务快照')).toBeTruthy()
  })

  it('rejects oversized and non-JSON files before parsing or submitting anything', async () => {
    vi.spyOn(api, 'modDeploymentState').mockResolvedValue({
      data: stateFixture(), meta: { executionEnabled: false }
    })
    vi.spyOn(api, 'modDeploymentRecovery').mockResolvedValue({
      data: { dryRun: true, irreversible: true, executeSupported: false, candidates: [] }
    })
    mockRecoveryReady(false)
    const preview = vi.spyOn(api, 'previewModDeployment')
    render(<ModWorkspace demo={true} />)
    const input = screen.getByLabelText('选择模组部署请求 JSON')

    const oversized = {
      name: 'oversized.json',
      size: 2 * 1_024 * 1_024 + 1,
      text: vi.fn(async () => '{}')
    } as unknown as File
    fireEvent.change(input, { target: { files: [oversized] } })
    expect(await screen.findByText('模组部署请求 JSON 不能超过 2 MiB。')).toBeTruthy()
    expect(oversized.text).not.toHaveBeenCalled()

    const zip = {
      name: 'untrusted-mod.zip',
      size: 128,
      text: vi.fn(async () => '{}')
    } as unknown as File
    fireEvent.change(input, { target: { files: [zip] } })
    expect(await screen.findByText(/不能选择 ZIP 或可执行文件/)).toBeTruthy()
    expect(zip.text).not.toHaveBeenCalled()
    expect(preview).not.toHaveBeenCalled()
  })

  it('does not prefill production, preserves verified evidence after failure, and aborts state reads on unmount', async () => {
    let stateSignal: AbortSignal | undefined
    vi.spyOn(api, 'modDeploymentState').mockImplementation(async (signal) => {
      stateSignal = signal
      return { data: stateFixture(), meta: { executionEnabled: false } }
    })
    vi.spyOn(api, 'modDeploymentRecovery').mockResolvedValue({
      data: { dryRun: true, irreversible: true, executeSupported: false, candidates: [] }
    })
    mockRecoveryReady(false)
    const preview = vi.spyOn(api, 'previewModDeployment')
      .mockResolvedValueOnce({ data: previewFixture(), meta: { executionEnabled: false } })
    const view = render(<ModWorkspace demo={false} />)

    await screen.findByText('Fictional/InstalledCore')
    expect(screen.getByText('等待逻辑请求')).toBeTruthy()
    expect(screen.queryByText('fictional-mod-deployment-request.json')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '使用虚构示例' }))
    expect(await screen.findByText('fictional-mod-deployment-request.json')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '生成部署预演' }))
    expect(await screen.findByText('预演已通过全部一致性门禁')).toBeTruthy()

    preview.mockRejectedValueOnce(new ApiError(409, '模组部署预演或执行被一致性门禁拒绝', 'MOD_DEPLOYMENT_REVISION_CONFLICT'))
    fireEvent.click(screen.getByRole('button', { name: '生成部署预演' }))
    expect((await screen.findByRole('alert')).textContent).toContain('MOD_DEPLOYMENT_REVISION_CONFLICT')
    expect(screen.getByText('预演已通过全部一致性门禁')).toBeTruthy()
    expect(screen.getByText('fictional-mod-deployment-request.json')).toBeTruthy()

    view.unmount()
    expect(stateSignal?.aborted).toBe(true)
  })

  it('recovers only the exact server-projected interrupted transaction and proves the terminal revision', async () => {
    const requestId = requestFixture().requestId
    vi.spyOn(api, 'modDeploymentState').mockResolvedValue({
      data: stateFixture(), meta: { executionEnabled: true }
    })
    vi.spyOn(api, 'modDeploymentRecovery').mockResolvedValue({
      data: { dryRun: true, irreversible: true, executeSupported: false, candidates: [] }
    })
    vi.spyOn(api, 'modDeploymentRecoveryStatus')
      .mockResolvedValueOnce({
        data: {
          phase: 'recovery-required', requestId, operation: 'install',
          allowedDesired: ['candidate', 'previous']
        },
        meta: { executionEnabled: true }
      })
      .mockResolvedValue({
        data: { phase: 'ready', requestId: null, operation: null, allowedDesired: [] },
        meta: { executionEnabled: true }
      })
    const recovered: ModDeploymentReceipt = {
      ...receiptFixture(),
      status: 'rolled-back',
      newRevision: null,
      rollback: 'succeeded',
      errorCode: 'MOD_DEPLOYMENT_EXECUTION_FAILED'
    }
    const recover = vi.spyOn(api, 'recoverModDeployment').mockResolvedValue({ data: recovered })
    render(<ModWorkspace demo={false} canRecover />)

    expect(await screen.findByText('RECOVERY REQUIRED')).toBeTruthy()
    expect((screen.getByLabelText('模组恢复 request ID') as HTMLInputElement).value).toBe(requestId)
    fireEvent.change(screen.getByLabelText('模组恢复目标'), { target: { value: 'previous' } })
    const button = screen.getByRole('button', { name: '执行精确恢复' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('模组恢复精确确认'), {
      target: { value: 'RECOVER_MOD_DEPLOYMENT' }
    })
    expect(button.disabled).toBe(false)
    fireEvent.click(button)

    expect(await screen.findByText('发布失败，已自动回滚')).toBeTruthy()
    expect(recover).toHaveBeenCalledWith(requestId, 'previous')
    await waitFor(() => expect(screen.getByText('READY')).toBeTruthy())
  })

  it('loads bounded durable history, appends the opaque next page, and revalidates an exact receipt', async () => {
    vi.spyOn(api, 'modDeploymentState').mockResolvedValue({
      data: stateFixture(), meta: { executionEnabled: false }
    })
    vi.spyOn(api, 'modDeploymentRecovery').mockResolvedValue({
      data: { dryRun: true, irreversible: true, executeSupported: false, candidates: [] }
    })
    mockRecoveryReady(false)
    const newest = receiptFixture()
    const older: ModDeploymentReceipt = {
      ...receiptFixture(),
      requestId: '22222222-2222-4222-8222-222222222222',
      operation: 'disable',
      status: 'rolled-back',
      newRevision: null,
      rollback: 'succeeded',
      errorCode: 'MOD_DEPLOYMENT_EXECUTION_FAILED'
    }
    const opaqueCursor = 'MjAyNi0wOC0zMFQxMDowMDowMC4wMDBaCjExMTExMTExLTExMTEtNDExMS04MTExLTExMTExMTExMTExMQ'
    vi.mocked(api.modDeploymentHistory).mockReset()
      .mockResolvedValueOnce({ data: historyPageFixture([newest], opaqueCursor, 2) })
      .mockResolvedValueOnce({ data: historyPageFixture([older], null, 2) })
    const exactReceipt = vi.mocked(api.modDeploymentReceipt).mockResolvedValue({ data: newest })
    render(<ModWorkspace demo={false} />)

    expect(await screen.findByText('2 RECEIPTS')).toBeTruthy()
    expect(screen.getByText(new RegExp(newest.requestId))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: `核验回执 ${newest.requestId}` }))
    await waitFor(() => expect(exactReceipt).toHaveBeenCalledWith(newest.requestId))
    expect(await screen.findByText('部署事务已提交')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '加载更早回执' }))
    await waitFor(() => expect(api.modDeploymentHistory).toHaveBeenLastCalledWith({
      cursor: opaqueCursor,
      pageSize: 8
    }))
    expect(await screen.findByText(new RegExp(older.requestId))).toBeTruthy()
    expect(screen.getByRole('button', { name: '已到历史末端' })).toBeTruthy()
  })

  it('uses a declared managed schema only, renders a redacted diff, and requires exact configuration confirmation', async () => {
    const managedState = {
      ...stateFixture(),
      packages: [{
        dependencyId: 'nebula-NebulaMultiplayerMod-0.9.22', sourceId: 'thunderstore:nebula/NebulaMultiplayerMod', version: '0.9.22',
        enabled: true, clientRequirement: 'required' as const
      }]
    }
    vi.spyOn(api, 'modDeploymentState').mockResolvedValue({ data: managedState, meta: { executionEnabled: true } })
    vi.spyOn(api, 'modDeploymentRecovery').mockResolvedValue({ data: { dryRun: true, irreversible: true, executeSupported: false, candidates: [] } })
    mockRecoveryReady(true)
    vi.spyOn(api, 'managedModConfigurationSchemas').mockResolvedValue({
      data: [{ id: 'nebula-server-v0-9-22', package: { dependencyId: 'nebula-NebulaMultiplayerMod-0.9.22', version: '0.9.22' }, fields: [
        { id: 'sync-ups', type: 'boolean', secret: false },
        { id: 'host-port', type: 'integer', secret: false, minimum: 1, maximum: 65_535 },
        { id: 'server-password', type: 'secret', secret: true, maximumLength: 128 }
      ] }], meta: { executionEnabled: true }
    })
    vi.spyOn(api, 'inspectManagedModConfiguration').mockResolvedValue({ data: {
      schemaId: 'nebula-server-v0-9-22', package: { dependencyId: 'nebula-NebulaMultiplayerMod-0.9.22', version: '0.9.22' },
      deploymentRevision: managedState.revision, configurationRevision: 'a'.repeat(64), fields: [
        { id: 'sync-ups', type: 'boolean', value: true }, { id: 'host-port', type: 'integer', value: 8469 },
        { id: 'server-password', type: 'secret', value: { configured: true } }
      ]
    } })
    vi.spyOn(api, 'previewManagedModConfiguration').mockImplementation(async (input) => ({ data: {
      dryRun: true, operation: 'configure', requestId: input.requestId, schemaId: input.schemaId, package: input.package,
      deploymentRevision: input.expectedDeploymentRevision, configurationRevision: input.expectedConfigurationRevision,
      nextConfigurationRevision: 'b'.repeat(64), requestFingerprint: 'c'.repeat(64),
      changes: [{ id: 'host-port', before: 8469, after: 9443, changed: true }],
      stoppedStateRequiredForExecute: true, executionSupported: true
    }, meta: { executionEnabled: true } }))
    const execute = vi.spyOn(api, 'executeManagedModConfiguration').mockResolvedValue({ data: {
      format: 'dyson-control-managed-mod-configuration-receipt', schemaVersion: 1,
      requestId: '11111111-1111-4111-8111-111111111111', operation: 'configure', schemaId: 'nebula-server-v0-9-22',
      package: { dependencyId: 'nebula-NebulaMultiplayerMod-0.9.22', version: '0.9.22' }, deploymentRevision: managedState.revision,
      previousConfigurationRevision: 'a'.repeat(64), newConfigurationRevision: 'b'.repeat(64), status: 'applied', rollback: 'not-needed',
      protectionPointCreated: true, changedFieldIds: ['host-port'], errorCode: null, completedAt: '2026-09-02T00:00:00.000Z', reused: false
    } })
    render(<ModWorkspace demo={false} />)

    expect(await screen.findByText('受管模组配置')).toBeTruthy()
    const password = await screen.findByLabelText('配置 server-password') as HTMLInputElement
    expect(password.getAttribute('placeholder')).toContain('已配置')
    expect(password.maxLength).toBe(128)
    expect(screen.queryByText(/test-server-secret/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '清除 server-password' }))
    expect(password.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('配置 host-port'), { target: { value: '9443' } })
    fireEvent.click(screen.getByRole('button', { name: '生成配置预演' }))
    expect(await screen.findByText('配置预演已建立')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('配置 host-port'), { target: { value: '9444' } })
    await waitFor(() => expect(screen.queryByText('配置预演已建立')).toBeNull())
    expect(screen.queryByLabelText('受管模组配置精确确认')).toBeNull()
    fireEvent.change(screen.getByLabelText('配置 host-port'), { target: { value: '9443' } })
    fireEvent.click(screen.getByRole('button', { name: '生成配置预演' }))
    expect(await screen.findByText('配置预演已建立')).toBeTruthy()
    const submit = screen.getByRole('button', { name: '提交受管配置' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('受管模组配置精确确认'), { target: { value: 'CONFIGURE_MANAGED_MOD' } })
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    expect(await screen.findByText('受管配置已提交')).toBeTruthy()
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'configure', changes: [
        { id: 'host-port', value: 9443 },
        { id: 'server-password', value: '' }
      ] }),
      'c'.repeat(64)
    )
    expect(JSON.stringify(execute.mock.calls[0]?.[0])).not.toMatch(/(?:[A-Za-z]:\\|\\\\|\/tmp\/|command|script|path)/i)
  })
})

function mockRecoveryReady(executionEnabled: boolean) {
  return vi.spyOn(api, 'modDeploymentRecoveryStatus').mockResolvedValue({
    data: { phase: 'ready', requestId: null, operation: null, allowedDesired: [] },
    meta: { executionEnabled }
  })
}

function stateFixture(): ModDeploymentStateSummary {
  return {
    revision: '0'.repeat(64),
    packages: [{
      dependencyId: 'Fictional-InstalledCore-1.0.0',
      sourceId: 'thunderstore:Fictional/InstalledCore',
      version: '1.0.0',
      enabled: true,
      clientRequirement: 'required'
    }],
    enabledCount: 1,
    disabledCount: 0
  }
}

function requestFixture(): ModDeploymentRequest {
  const dependencyId = 'Fictional-ModConsole-1.0.0'
  return {
    requestId: '11111111-1111-4111-8111-111111111111',
    operation: 'install',
    package: { dependencyId, version: '1.0.0' },
    manifest: {
      serverLock: {
        format: 'dyson-control-server-mod-lock',
        schemaVersion: 1,
        mods: [{
          dependencyId,
          sourceId: 'thunderstore:Fictional/ModConsole',
          version: '1.0.0',
          sha256: 'a'.repeat(64),
          dependencies: [],
          loadOrder: 0,
          root: true,
          serverRequired: true,
          clientRequirement: 'required'
        }]
      },
      clientParity: {
        format: 'dyson-control-client-parity',
        schemaVersion: 1,
        serverLockSha256: '8a519f91b49e05d912777f786ea231599a9d656d14520aeb8aadeffbbe8a0298',
        mods: [{
          sourceId: 'thunderstore:Fictional/ModConsole',
          version: '1.0.0',
          sha256: 'a'.repeat(64),
          serverRequired: true,
          clientRequirement: 'required'
        }]
      },
      platformLock: {
        format: 'dyson-control-mod-platform-lock',
        schemaVersion: 1,
        serverLockSha256: '8a519f91b49e05d912777f786ea231599a9d656d14520aeb8aadeffbbe8a0298',
        inventoryRevision: null,
        requirements: [],
        digest: '1668d55e7815069ca2f710d6614cee74fb23aeb7771e59d22ddc208dd864d08f'
      }
    },
    expectedRevision: '0'.repeat(64)
  }
}

function previewFixture(): ModDeploymentPreview {
  const request = requestFixture()
  return {
    dryRun: true,
    operation: request.operation,
    package: request.package,
    currentRevision: '0'.repeat(64),
    nextRevision: '1'.repeat(64),
    currentlyInstalled: false,
    currentlyEnabled: false,
    nextEnabled: true,
    payloadFileCount: 2,
    payloadSizeBytes: 4096,
    dependencyCount: 0,
    snapshotsUsed: 1,
    snapshotLimit: 8,
    stoppedStateRequiredForExecute: true,
    recoverablePayloadPreserved: false
  }
}

function receiptFixture(): ModDeploymentReceipt {
  const request = requestFixture()
  return {
    format: 'dyson-control-mod-deployment-receipt',
    schemaVersion: 1,
    requestId: request.requestId,
    operation: request.operation,
    package: request.package,
    status: 'succeeded',
    previousRevision: '0'.repeat(64),
    newRevision: '1'.repeat(64),
    rollback: 'not-needed',
    recoveryPointCreated: true,
    recoverablePayloadPreserved: false,
    payloadFileCount: 2,
    payloadSizeBytes: 4096,
    errorCode: null,
    reused: false
  }
}

function historyPageFixture(
  receipts: ModDeploymentReceipt[] = [receiptFixture()],
  nextCursor: string | null = null,
  totalReceipts = receipts.length
): ModDeploymentReceiptHistoryPage {
  return {
    format: 'dyson-control-mod-deployment-receipt-history',
    schemaVersion: 1,
    order: 'persisted-at-descending',
    items: receipts.map((receipt, index) => ({
      persistedAt: `2026-08-30T10:0${index}:00.000Z`,
      receipt
    })),
    page: {
      limit: 8,
      returned: receipts.length,
      totalReceipts,
      nextCursor
    }
  }
}

function jsonFile(name: string, value: unknown): File {
  const text = JSON.stringify(value)
  const file = new File([text], name, { type: 'application/json' })
  Object.defineProperty(file, 'text', { configurable: true, value: vi.fn(async () => text) })
  return file
}

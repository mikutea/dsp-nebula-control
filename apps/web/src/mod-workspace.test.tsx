// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModWorkspace } from './App'
import { api, ApiError } from './api'
import type {
  ModDeploymentPreview,
  ModDeploymentReceipt,
  ModDeploymentRequest,
  ModDeploymentStateSummary
} from './model'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
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

function jsonFile(name: string, value: unknown): File {
  const text = JSON.stringify(value)
  const file = new File([text], name, { type: 'application/json' })
  Object.defineProperty(file, 'text', { configurable: true, value: vi.fn(async () => text) })
  return file
}

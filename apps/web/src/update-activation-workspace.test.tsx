// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VersionUpdateWorkspace } from './VersionUpdateWorkspace'
import { api, ApiError } from './api'
import type {
  ComponentCandidatePreparationReceipt,
  ServerStatus, SessionUser, UpdateActivationPlan, UpdateActivationReceipt,
  UpdateActivationRequest, UpdateActivationState, UpdateCleanupPlan,
  UpdateCompatibilityReceipt, UpdateCompatibilityStatus
} from './model'

const preparedNebulaArtifactId = `prepared-nebula-${'a'.repeat(40)}`
const preparedNebulaSha256 = 'd'.repeat(64)
const preparationReceiptId = '33333333-3333-4333-8333-333333333333'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('component update activation workspace', () => {
  it('loads bounded state, previews a fixed request, requires component confirmation, and verifies the receipt', async () => {
    mockStateReads()
    let activationRequest = requestFixture()
    const preview = vi.spyOn(api, 'previewUpdateActivation').mockImplementation(async (request) => {
      activationRequest = request
      return { data: planFixture(request) }
    })
    const execute = vi.spyOn(api, 'executeUpdateActivation').mockImplementation(async (request) => ({ data: receiptFixture(request) }))
    const readReceipt = vi.spyOn(api, 'updateActivationReceipt').mockImplementation(async () => ({ data: receiptFixture(activationRequest) }))

    render(<VersionUpdateWorkspace status={statusFixture()} demo={false} user={administrator()} />)

    expect(await screen.findByText('4 个托管组件')).toBeTruthy()
    expect(screen.getByText('STEAM MANUAL')).toBeTruthy()
    expect(screen.getByText('executeSupported=false')).toBeTruthy()

    await loadPreparedNebulaDraft()
    await prepareCompatibilityEvidence()
    fireEvent.click(screen.getByRole('button', { name: '生成激活预演' }))

    expect(await screen.findByText('DRY-RUN 已生成，执行仍未发生')).toBeTruthy()
    expect(screen.getByText('创建成对存档保护点')).toBeTruthy()
    expect(screen.getByText('停止态证明')).toBeTruthy()
    const submitted = preview.mock.calls[0]?.[0]
    expect(submitted).toMatchObject({
      component: 'nebula',
      artifactId: preparedNebulaArtifactId,
      sha256: preparedNebulaSha256,
      targetVersion: '0.9.22',
      expectedRevision: '1'.repeat(64),
      compatibilityReceiptId: expect.any(String)
    })
    expect(submitted?.compatibilityReceiptId).toBe((api.prepareUpdateCompatibility as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].requestId)
    expect(JSON.stringify(submitted)).not.toMatch(/"(?:path|url|command|executable|credential|archive|zip)"\s*:/i)

    const activationButton = screen.getByRole('button', { name: '提交服务端激活门禁' }) as HTMLButtonElement
    expect(activationButton.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('组件激活精确确认'), {
      target: { value: 'ACTIVATE_NEBULA_UPDATE' }
    })
    expect(activationButton.disabled).toBe(false)
    fireEvent.click(activationButton)

    expect(await screen.findByText('已由 receipts/:requestId 重新读取')).toBeTruthy()
    expect(screen.getByText('GATE ACCEPTED')).toBeTruthy()
    expect(execute).toHaveBeenCalledWith(submitted, 'ACTIVATE_NEBULA_UPDATE', expect.any(AbortSignal))
    expect(readReceipt).toHaveBeenCalledWith(activationRequest.requestId, expect.any(AbortSignal))
  })

  it('lets an Operator generate dry-run evidence while keeping activation unavailable', async () => {
    mockStateReads()
    vi.spyOn(api, 'previewUpdateActivation').mockImplementation(async (request) => ({ data: planFixture(request) }))
    const execute = vi.spyOn(api, 'executeUpdateActivation')
    render(<VersionUpdateWorkspace status={statusFixture()} demo={false} user={operator()} />)

    await screen.findByText('Operator 可获取 / 激活只读')
    await loadPreparedNebulaDraft()
    await prepareCompatibilityEvidence()
    fireEvent.click(screen.getByRole('button', { name: '生成激活预演' }))
    expect(await screen.findByText('DRY-RUN 已生成，执行仍未发生')).toBeTruthy()

    const confirmation = screen.getByLabelText('组件激活精确确认') as HTMLInputElement
    const activationButton = screen.getByRole('button', { name: '需要 Administrator' }) as HTMLButtonElement
    expect(confirmation.disabled).toBe(true)
    expect(activationButton.disabled).toBe(true)
    fireEvent.click(activationButton)
    expect(execute).not.toHaveBeenCalled()
  })

  it('renders DSP and cleanup as non-activatable surfaces and exposes no host transport inputs', async () => {
    const preview = vi.spyOn(api, 'previewUpdateActivation')
    const execute = vi.spyOn(api, 'executeUpdateActivation')
    render(<VersionUpdateWorkspace status={statusFixture()} demo user={administrator()} />)

    expect(await screen.findByText('MANUAL / NON-ACTIVATABLE')).toBeTruthy()
    expect(screen.getByText(/不提供 DSP artifact、匿名 SteamCMD/)).toBeTruthy()
    expect(screen.getByText(/核心没有清理执行合同/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /删除|清理执行|激活 DSP/i })).toBeNull()
    expect(screen.queryByRole('textbox', { name: /路径|URL|命令|可执行文件|ZIP/i })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '使用虚构示例' }))
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '生成激活预演' }) as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(screen.getByRole('button', { name: '生成激活预演' }))
    expect(await screen.findByText('DRY-RUN 已生成，执行仍未发生')).toBeTruthy()
    expect((screen.getByRole('button', { name: '演示环境不执行' }) as HTMLButtonElement).disabled).toBe(true)
    expect(preview).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('turns an HTTP 423 into an explicit fail-closed gate without discarding the dry-run plan', async () => {
    mockStateReads()
    vi.spyOn(api, 'previewUpdateActivation').mockImplementation(async (request) => ({ data: planFixture(request) }))
    vi.spyOn(api, 'executeUpdateActivation').mockRejectedValue(
      new ApiError(423, '组件激活门禁为 fail-closed；当前只允许读取与预演。', 'UPDATE_ACTIVATION_HTTP_MUTATION_DISABLED')
    )
    render(<VersionUpdateWorkspace status={statusFixture()} demo={false} user={administrator()} />)

    await screen.findByText('4 个托管组件')
    await loadPreparedNebulaDraft()
    await prepareCompatibilityEvidence()
    fireEvent.click(screen.getByRole('button', { name: '生成激活预演' }))
    await screen.findByText('DRY-RUN 已生成，执行仍未发生')
    fireEvent.change(screen.getByLabelText('组件激活精确确认'), {
      target: { value: 'ACTIVATE_NEBULA_UPDATE' }
    })
    fireEvent.click(screen.getByRole('button', { name: '提交服务端激活门禁' }))

    expect(await screen.findByText('FAIL-CLOSED')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('UPDATE_ACTIVATION_HTTP_MUTATION_DISABLED')
    expect(screen.getByText('服务端 dry-run operations')).toBeTruthy()
    expect((screen.getByRole('button', { name: '服务端门禁已关闭' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('aborts both bounded state reads when the workspace unmounts', async () => {
    let stateSignal: AbortSignal | undefined
    let cleanupSignal: AbortSignal | undefined
    let compatibilitySignal: AbortSignal | undefined
    vi.spyOn(api, 'updateActivationState').mockImplementation(async (signal) => {
      stateSignal = signal
      return { data: stateFixture() }
    })
    vi.spyOn(api, 'updateActivationCleanupPreview').mockImplementation(async (signal) => {
      cleanupSignal = signal
      return { data: cleanupFixture() }
    })
    vi.spyOn(api, 'updateCompatibilityStatus').mockImplementation(async (signal) => {
      compatibilitySignal = signal
      return { data: compatibilityStatusFixture() }
    })
    const view = render(<VersionUpdateWorkspace status={statusFixture()} demo={false} user={administrator()} />)
    await screen.findByText('4 个托管组件')
    view.unmount()
    expect(stateSignal?.aborted).toBe(true)
    expect(cleanupSignal?.aborted).toBe(true)
    expect(compatibilitySignal?.aborted).toBe(true)
  })
})

function mockStateReads(): void {
  vi.spyOn(api, 'updateActivationState').mockResolvedValue({ data: stateFixture() })
  vi.spyOn(api, 'updateActivationCleanupPreview').mockResolvedValue({ data: cleanupFixture() })
  vi.spyOn(api, 'updateCompatibilityStatus').mockResolvedValue({ data: compatibilityStatusFixture() })
  vi.spyOn(api, 'prepareUpdateCompatibility').mockImplementation(async (request) => ({
    data: compatibilityReceiptFixture(request.requestId)
  }))
  vi.spyOn(api, 'updateCompatibilityReceipt').mockImplementation(async (receiptId) => ({
    data: compatibilityReceiptFixture(receiptId)
  }))
  vi.spyOn(api, 'componentCandidatePreparationReceipt').mockImplementation(async (requestId) => ({
    data: preparationReceiptFixture(requestId)
  }))
}

async function loadPreparedNebulaDraft(): Promise<void> {
  fireEvent.change(screen.getByLabelText('准备回执 request ID'), {
    target: { value: preparationReceiptId }
  })
  fireEvent.click(screen.getByRole('button', { name: '恢复准备回执' }))
  expect(await screen.findByText('PREPARED RECEIPT VERIFIED')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '装入 Nebula 激活请求' }))
  await waitFor(() => {
    expect((screen.getByLabelText('组件 artifact ID') as HTMLInputElement).value)
      .toBe(preparedNebulaArtifactId)
  })
}

async function prepareCompatibilityEvidence(): Promise<void> {
  fireEvent.change(screen.getByLabelText('兼容性准备精确确认'), {
    target: { value: 'PREPARE_COMPATIBILITY_EVIDENCE' }
  })
  fireEvent.click(screen.getByRole('button', { name: '签发兼容性回执' }))
  expect(await screen.findAllByText('COMPATIBLE / VERIFIED')).not.toHaveLength(0)
}

function administrator(): SessionUser {
  return {
    name: 'Administrator', role: 'administrator',
    permissions: ['updates.read', 'updates.stage', 'updates.activate']
  }
}

function operator(): SessionUser {
  return { name: 'Operator', role: 'operator', permissions: ['updates.read', 'updates.stage'] }
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
      latestBackupAt: '2026-08-30T11:30:00.000Z', backupManifestPresent: true, backupPairPresent: true
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

function stateFixture(): UpdateActivationState {
  return {
    revision: '1'.repeat(64), recoveryRequired: false, historyEntries: 5,
    components: [
      { component: 'nebula', version: '0.9.22.2', artifactId: 'fictional-nebula-active-0001', releaseId: `nebula-${'a'.repeat(32)}` },
      { component: 'bepinex', version: '5.4.23', artifactId: 'fictional-bepinex-active-0001', releaseId: `bepinex-${'b'.repeat(32)}` },
      { component: 'bridge', version: '1.2.0', artifactId: 'fictional-bridge-active-0001', releaseId: `bridge-${'c'.repeat(32)}` },
      { component: 'control', version: '1.2.0', artifactId: 'fictional-control-active-0001', releaseId: `control-${'d'.repeat(32)}` }
    ]
  }
}

function compatibilityStatusFixture(): UpdateCompatibilityStatus {
  return {
    format: 'dyson-control-trusted-compatibility-status', schemaVersion: 1,
    available: true, policyId: 'fictional-policy-0001', policyRevision: '3'.repeat(64),
    policyReviewedAt: '2026-08-30T10:00:00.000Z', inventoryRevision: '2'.repeat(64),
    inventory: {
      dsp: '0.10.33.26727', nebula: '0.9.22.2', bepInEx: '5.4.23', plugins: []
    }
  }
}

function compatibilityReceiptFixture(receiptId = '22222222-2222-4222-8222-222222222222'): UpdateCompatibilityReceipt {
  return {
    format: 'dyson-control-trusted-compatibility-receipt', schemaVersion: 1,
    receiptId, component: 'nebula',
    artifactId: preparedNebulaArtifactId, artifactSha256: preparedNebulaSha256,
    targetVersion: '0.9.22', inventoryRevision: '2'.repeat(64),
    policyId: 'fictional-policy-0001', policyRevision: '3'.repeat(64),
    matchedEntryId: 'ui-nebula-candidate', compatible: true,
    issuedAt: '2026-08-30T12:00:00.000Z', expiresAt: '2099-08-31T08:00:00.000Z',
    reused: false
  }
}

function cleanupFixture(): UpdateCleanupPlan {
  return {
    format: 'dyson-control-component-update-cleanup-plan', schemaVersion: 1,
    dryRun: true, executeSupported: false,
    candidates: [
      { kind: 'history', opaqueId: 'fictional-history-0001', recoverable: true, reason: 'history-retention-exceeded' },
      { kind: 'release', opaqueId: 'fictional-release-0001', recoverable: true, reason: 'unreferenced-release' }
    ]
  }
}

function requestFixture(): UpdateActivationRequest {
  return {
    requestId: '11111111-1111-4111-8111-111111111111', component: 'nebula',
    artifactId: preparedNebulaArtifactId, sha256: preparedNebulaSha256,
    targetVersion: '0.9.22', expectedRevision: '1'.repeat(64),
    compatibilityReceiptId: '22222222-2222-4222-8222-222222222222'
  }
}

function planFixture(input: UpdateActivationRequest = requestFixture()): UpdateActivationPlan {
  const request = { ...input, compatibilityReceiptId: input.compatibilityReceiptId ?? requestFixture().compatibilityReceiptId }
  return {
    format: 'dyson-control-component-update-plan', schemaVersion: 1, dryRun: true,
    requestId: request.requestId, component: 'nebula', artifactId: request.artifactId!,
    targetVersion: request.targetVersion, expectedRevision: request.expectedRevision,
    compatibilityReceiptId: request.compatibilityReceiptId!,
    releaseId: `nebula-${'e'.repeat(32)}`, fileCount: 7, expandedBytes: 262_144,
    compatibility: {
      compatible: true, matchedEntryId: 'ui-nebula-candidate',
      inventory: {
        dsp: '0.10.33.26727', nebula: '0.9.22', bepInEx: '5.4.23',
        plugins: []
      },
      evaluations: [{ entryId: 'ui-nebula-candidate', compatible: true, reasons: [] }]
    },
    operations: [
      'acquire-global-update-lock', 'verify-staged-artifact-and-archive',
      'assemble-immutable-release', 'prove-process-stopped-and-port-closed',
      'create-paired-save-protection-point', 'revalidate-stop-revision-and-compatibility',
      'atomically-switch-active-manifest', 'run-fixed-health-check',
      'rollback-and-verify-on-failure', 'persist-audit-safe-receipt',
      'release-global-update-lock'
    ],
    rollback: { automatic: true, previousReleaseRequired: true, recoveryRequiredIfUnproven: true }
  }
}

function preparationReceiptFixture(
  requestId = preparationReceiptId
): ComponentCandidatePreparationReceipt {
  const sourceArtifactId = `artifact-${'b'.repeat(40)}`
  return {
    format: 'dyson-control-component-preparation-receipt',
    schemaVersion: 1,
    requestId,
    component: 'nebula',
    acquisitionReceiptId: '11111111-1111-4111-8111-111111111111',
    source: {
      provider: 'github',
      sourceId: 'github:NebulaModTeam/nebula',
      version: '0.9.22',
      artifactId: sourceArtifactId,
      sizeBytes: 4096,
      sha256: 'c'.repeat(64),
      integrity: 'provider-verified'
    },
    prepared: {
      mode: 'normalized-nebula-windows',
      artifactId: preparedNebulaArtifactId,
      layoutPolicy: 'nebula-official-windows-v0.9.22',
      sizeBytes: 8192,
      sha256: preparedNebulaSha256,
      integrity: 'normalized-locally-computed'
    },
    staging: {
      created: true,
      manifest: {
        format: 'dyson-control-staged-artifact',
        schemaVersion: 1,
        artifactId: preparedNebulaArtifactId,
        artifactFile: 'artifact.bin',
        release: {
          kind: 'nebula',
          sourceId: 'github:NebulaModTeam/nebula',
          version: '0.9.22'
        },
        sizeBytes: 8192,
        sha256: preparedNebulaSha256,
        integrity: 'locally-computed',
        stagedAt: '2026-08-30T12:05:00.000Z'
      }
    },
    state: 'staged',
    reused: false,
    preparedAt: '2026-08-30T12:05:00.000Z'
  }
}

function receiptFixture(input: UpdateActivationRequest = requestFixture()): UpdateActivationReceipt {
  const request = { ...input, compatibilityReceiptId: input.compatibilityReceiptId ?? requestFixture().compatibilityReceiptId }
  return {
    format: 'dyson-control-component-update-receipt', schemaVersion: 1,
    requestId: request.requestId, component: 'nebula', artifactId: request.artifactId!,
    compatibilityReceiptId: request.compatibilityReceiptId!,
    targetVersion: request.targetVersion, releaseId: `nebula-${'e'.repeat(32)}`,
    status: 'succeeded', previousRevision: request.expectedRevision, resultingRevision: '2'.repeat(64),
    protectionBackupId: 'fictional-backup-0001', failureCode: null, rollbackVerified: false,
    recoveryRequired: false, fileCount: 7, expandedBytes: 262_144,
    completedAt: '2026-08-30T12:30:00.000Z', reused: false
  }
}

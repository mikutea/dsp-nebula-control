// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VersionUpdateWorkspace } from './VersionUpdateWorkspace'
import { api, ApiError } from './api'
import type {
  ArtifactAcquisitionCandidate,
  ArtifactAcquisitionDiscoveryMeta,
  ArtifactAcquisitionPlan,
  ArtifactAcquisitionReceipt,
  AvailableComponentCandidatePreparationPlan,
  BepInExDiscoveryEnvelope,
  ComponentCandidatePreparationReceipt,
  NebulaDiscoveryEnvelope,
  ServerStatus,
  SessionUser,
  UpdateActivationState,
  UpdateCleanupPlan,
  UpdateCompatibilityStatus
} from './model'

const preparedNebulaArtifactId = `prepared-nebula-${'d'.repeat(40)}`
const preparedNebulaSha256 = 'e'.repeat(64)

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('managed artifact acquisition workspace', () => {
  it('lets an Operator preview, confirm, acquire, verify the durable receipt, and safely bridge into activation', async () => {
    mockActivationReads()
    vi.spyOn(api, 'discoverNebula').mockResolvedValue(discoveryEnvelope())
    const preview = vi.spyOn(api, 'previewArtifactAcquisition').mockResolvedValue({ data: planFixture() })
    const execute = vi.spyOn(api, 'executeArtifactAcquisition').mockImplementation(async (requestId) => ({
      data: receiptFixture(false, requestId)
    }))
    const receiptRead = vi.spyOn(api, 'artifactAcquisitionReceipt').mockImplementation(async (requestId) => ({
      data: receiptFixture(false, requestId)
    }))
    const preparationPreview = vi.spyOn(api, 'previewComponentCandidatePreparation')
      .mockImplementation(async (_component, acquisitionReceiptId) => ({
        data: preparationPlanFixture(acquisitionReceiptId)
      }))
    let persistedAcquisitionReceiptId = '11111111-1111-4111-8111-111111111111'
    const preparationExecute = vi.spyOn(api, 'executeComponentCandidatePreparation')
      .mockImplementation(async (requestId, _component, acquisitionReceiptId) => {
        persistedAcquisitionReceiptId = acquisitionReceiptId
        return { data: preparationReceiptFixture(requestId, acquisitionReceiptId) }
      })
    const preparationRead = vi.spyOn(api, 'componentCandidatePreparationReceipt')
      .mockImplementation(async (requestId) => ({
        data: preparationReceiptFixture(requestId, persistedAcquisitionReceiptId)
      }))
    render(<VersionUpdateWorkspace status={statusFixture()} demo={false} user={operator()} />)

    expect(await screen.findByText('Operator 可获取 / 激活只读')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '发现 Nebula' }))
    expect(await screen.findByText('服务端已绑定')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '获取 Nebula 0.9.22 预演' }))
    expect(await screen.findByText('获取 dry-run 已生成')).toBeTruthy()
    expect(preview).toHaveBeenCalledWith(candidateFixture().candidateId, expect.any(AbortSignal))
    const executeButton = screen.getByRole('button', { name: '获取到固定 inbox' }) as HTMLButtonElement
    expect(executeButton.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('制品获取精确确认'), {
      target: { value: 'ACQUIRE_UPDATE_ARTIFACT' }
    })
    expect(executeButton.disabled).toBe(false)
    fireEvent.click(executeButton)

    expect(await screen.findByText('RECEIPT VERIFIED')).toBeTruthy()
    expect(screen.getByText('固定 inbox 与持久回执均已确认')).toBeTruthy()
    expect(screen.getByText('首次获取已创建回执（201）')).toBeTruthy()
    expect(execute).toHaveBeenCalledOnce()
    const [submittedRequestId, submittedCandidateId] = execute.mock.calls[0]!
    expect(submittedRequestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(submittedCandidateId).toBe(candidateFixture().candidateId)
    expect(receiptRead).toHaveBeenCalledWith(submittedRequestId, expect.any(AbortSignal))

    const renderedSummary = screen.getByText('固定 inbox 与持久回执均已确认')
      .closest('.update-acquisition-panel')?.textContent ?? ''
    expect(renderedSummary).not.toContain('c'.repeat(64))
    expect(renderedSummary).not.toMatch(/https?:\/\/|[A-Za-z]:\\|fictional-secret/i)

    expect((screen.getByLabelText('组件 artifact ID') as HTMLInputElement).value).toBe('')
    expect((screen.getByRole('button', { name: '生成激活预演' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '生成候选准备预演' }))
    expect(await screen.findByText('准备 dry-run 已生成')).toBeTruthy()
    expect(preparationPreview).toHaveBeenCalledWith(
      'nebula', submittedRequestId, expect.any(AbortSignal)
    )
    fireEvent.change(screen.getByLabelText('候选准备精确确认'), {
      target: { value: 'PREPARE_COMPONENT_CANDIDATE' }
    })
    fireEvent.click(screen.getByRole('button', { name: '准备并固定暂存' }))
    expect(await screen.findByText('PREPARED RECEIPT VERIFIED')).toBeTruthy()
    expect(preparationExecute).toHaveBeenCalledWith(
      expect.stringMatching(/^[0-9a-f-]{36}$/), 'nebula', submittedRequestId, expect.any(AbortSignal)
    )
    expect(preparationRead).toHaveBeenCalledWith(expect.any(String), expect.any(AbortSignal))

    fireEvent.click(screen.getByRole('button', { name: '装入 Nebula 激活请求' }))
    expect((screen.getByLabelText('组件 artifact ID') as HTMLInputElement).value)
      .toBe(preparedNebulaArtifactId)
    expect((screen.getByLabelText('组件 SHA-256') as HTMLInputElement).value).toBe(preparedNebulaSha256)
    expect((screen.getByLabelText('组件目标版本') as HTMLInputElement).value).toBe('0.9.22')
  })

  it('discovers the official BepInEx Windows x64 candidate and preserves its identity through direct preparation', async () => {
    mockActivationReads()
    vi.spyOn(api, 'discoverBepInEx').mockResolvedValue(bepInExDiscoveryEnvelope())
    vi.spyOn(api, 'previewArtifactAcquisition').mockResolvedValue({ data: bepInExAcquisitionPlanFixture() })
    vi.spyOn(api, 'executeArtifactAcquisition').mockImplementation(async (requestId) => ({
      data: bepInExAcquisitionReceiptFixture(requestId)
    }))
    vi.spyOn(api, 'artifactAcquisitionReceipt').mockImplementation(async (requestId) => ({
      data: bepInExAcquisitionReceiptFixture(requestId)
    }))
    vi.spyOn(api, 'previewComponentCandidatePreparation')
      .mockImplementation(async (_component, acquisitionReceiptId) => ({
        data: bepInExPreparationPlanFixture(acquisitionReceiptId)
      }))
    let acquisitionReceiptId = '44444444-4444-4444-8444-444444444444'
    vi.spyOn(api, 'executeComponentCandidatePreparation')
      .mockImplementation(async (requestId, _component, acquiredId) => {
        acquisitionReceiptId = acquiredId
        return { data: bepInExPreparationReceiptFixture(requestId, acquiredId) }
      })
    vi.spyOn(api, 'componentCandidatePreparationReceipt').mockImplementation(async (requestId) => ({
      data: bepInExPreparationReceiptFixture(requestId, acquisitionReceiptId)
    }))
    render(<VersionUpdateWorkspace status={statusFixture()} demo={false} user={operator()} />)

    await screen.findByText('Operator 可获取 / 激活只读')
    fireEvent.click(screen.getByRole('button', { name: '发现 BepInEx' }))
    expect(await screen.findByText('BepInEx / BepInEx · Windows x64')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '获取 BepInEx 5.4.23.5 预演' }))
    await screen.findByText('获取 dry-run 已生成')
    fireEvent.change(screen.getByLabelText('制品获取精确确认'), {
      target: { value: 'ACQUIRE_UPDATE_ARTIFACT' }
    })
    fireEvent.click(screen.getByRole('button', { name: '获取到固定 inbox' }))
    await screen.findByText('RECEIPT VERIFIED')
    fireEvent.click(screen.getByRole('button', { name: '生成候选准备预演' }))
    expect(await screen.findByText('准备 dry-run 已生成')).toBeTruthy()
    expect(screen.getByText('DIRECT')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('候选准备精确确认'), {
      target: { value: 'PREPARE_COMPONENT_CANDIDATE' }
    })
    fireEvent.click(screen.getByRole('button', { name: '准备并固定暂存' }))
    await screen.findByText('PREPARED RECEIPT VERIFIED')
    fireEvent.click(screen.getByRole('button', { name: '装入 BepInEx 激活请求' }))

    expect((screen.getByLabelText('组件 artifact ID') as HTMLInputElement).value)
      .toBe(bepInExCandidateFixture().artifact.artifactId)
    expect((screen.getByLabelText('组件 SHA-256') as HTMLInputElement).value)
      .toBe(bepInExCandidateFixture().artifact.sha256)
    expect((screen.getByLabelText('组件目标版本') as HTMLInputElement).value).toBe('5.4.23.5')
  })

  it('keeps Viewer read-only while allowing an exact durable receipt lookup and replay summary', async () => {
    mockActivationReads()
    vi.spyOn(api, 'discoverNebula').mockResolvedValue(discoveryEnvelope())
    const preview = vi.spyOn(api, 'previewArtifactAcquisition').mockResolvedValue({ data: planFixture() })
    const execute = vi.spyOn(api, 'executeArtifactAcquisition')
    const requestId = '11111111-1111-4111-8111-111111111111'
    const receiptRead = vi.spyOn(api, 'artifactAcquisitionReceipt').mockResolvedValue({
      data: receiptFixture(true, requestId)
    })
    render(<VersionUpdateWorkspace status={statusFixture()} demo={false} user={viewer()} />)

    expect(await screen.findByText('Viewer 全局只读')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '发现 Nebula' }))
    const previewButton = await screen.findByRole('button', { name: '获取 Nebula 0.9.22 预演' }) as HTMLButtonElement
    expect(previewButton.disabled).toBe(false)
    fireEvent.click(previewButton)
    expect(await screen.findByText('获取 dry-run 已生成')).toBeTruthy()
    expect(preview).toHaveBeenCalledOnce()
    expect(execute).not.toHaveBeenCalled()
    expect((screen.getByLabelText('制品获取精确确认') as HTMLInputElement).disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('获取回执 request ID'), { target: { value: requestId } })
    fireEvent.click(screen.getByRole('button', { name: '恢复持久回执' }))
    expect(await screen.findByText('幂等复用既有回执（200）')).toBeTruthy()
    expect(screen.getByText('RECEIPT VERIFIED')).toBeTruthy()
    expect(receiptRead).toHaveBeenCalledWith(requestId, expect.any(AbortSignal))
    expect((screen.getByRole('button', { name: '生成候选准备预演' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it.each([
    ['获取未配置', { configured: false, executionEnabled: false, status: 'not-configured', eligible: true, candidate: null }],
    ['候选不合格', { configured: true, executionEnabled: false, status: 'release-ineligible', eligible: false, candidate: null }],
    ['注册校验失败', { configured: true, executionEnabled: false, status: 'registration-failed', eligible: true, candidate: null }],
    ['候选已过期', { configured: true, executionEnabled: true, status: 'registered', eligible: true,
      candidate: candidateFixture({ expiresAt: '2020-08-31T08:00:00.000Z' }) }]
  ] as const)('fails closed for discovery state %s', async (label, state) => {
    mockActivationReads()
    const envelope = discoveryEnvelope({
      configured: state.configured,
      executionEnabled: state.executionEnabled,
      candidates: [{
        artifactId: candidateFixture().artifact.artifactId,
        eligible: state.eligible,
        status: state.status,
        candidate: state.candidate
      }]
    })
    vi.spyOn(api, 'discoverNebula').mockResolvedValue(envelope)
    const preview = vi.spyOn(api, 'previewArtifactAcquisition')
    render(<VersionUpdateWorkspace status={statusFixture()} demo={false} user={operator()} />)

    await screen.findByText('Operator 可获取 / 激活只读')
    fireEvent.click(screen.getByRole('button', { name: '发现 Nebula' }))
    expect(await screen.findByText(label)).toBeTruthy()
    const button = screen.getByRole('button', { name: '获取 Nebula 0.9.22 预演' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(preview).not.toHaveBeenCalled()
  })

  it('rejects discovery metadata carrying an extra transport field before any acquisition call', async () => {
    mockActivationReads()
    const malformed = discoveryEnvelope() as unknown as {
      data: NebulaDiscoveryEnvelope['data']
      meta: { acquisition: { candidates: Array<Record<string, unknown>> } & Record<string, unknown> }
    }
    malformed.meta.acquisition.candidates[0]!.candidate = {
      ...(malformed.meta.acquisition.candidates[0]!.candidate as Record<string, unknown>),
      downloadUrl: 'https://attacker.example/should-not-enter-web-contract.zip'
    }
    vi.spyOn(api, 'discoverNebula').mockResolvedValue(malformed as unknown as NebulaDiscoveryEnvelope)
    const preview = vi.spyOn(api, 'previewArtifactAcquisition')
    render(<VersionUpdateWorkspace status={statusFixture()} demo={false} user={operator()} />)

    await screen.findByText('Operator 可获取 / 激活只读')
    fireEvent.click(screen.getByRole('button', { name: '发现 Nebula' }))
    expect((await screen.findByRole('alert')).textContent).toContain('未通过严格合同')
    expect((screen.getByRole('button', { name: '获取 Nebula 0.9.22 预演' }) as HTMLButtonElement).disabled).toBe(true)
    expect(preview).not.toHaveBeenCalled()
  })

  it('turns an execute-time 423 into a persistent default-off gate while retaining the dry-run', async () => {
    mockActivationReads()
    vi.spyOn(api, 'discoverNebula').mockResolvedValue(discoveryEnvelope())
    vi.spyOn(api, 'previewArtifactAcquisition').mockResolvedValue({ data: planFixture() })
    vi.spyOn(api, 'executeArtifactAcquisition').mockRejectedValue(new ApiError(
      423,
      '制品获取门禁为 fail-closed；当前只允许发现、查看与预演。',
      'UPDATE_ACQUISITION_MUTATION_DISABLED'
    ))
    render(<VersionUpdateWorkspace status={statusFixture()} demo={false} user={operator()} />)

    await screen.findByText('Operator 可获取 / 激活只读')
    fireEvent.click(screen.getByRole('button', { name: '发现 Nebula' }))
    await screen.findByText('服务端已绑定')
    fireEvent.click(screen.getByRole('button', { name: '获取 Nebula 0.9.22 预演' }))
    await screen.findByText('获取 dry-run 已生成')
    fireEvent.change(screen.getByLabelText('制品获取精确确认'), {
      target: { value: 'ACQUIRE_UPDATE_ARTIFACT' }
    })
    fireEvent.click(screen.getByRole('button', { name: '获取到固定 inbox' }))

    expect((await screen.findByRole('alert')).textContent).toContain('UPDATE_ACQUISITION_MUTATION_DISABLED')
    expect(screen.getByText('获取 dry-run 已生成')).toBeTruthy()
    expect((screen.getByRole('button', { name: '服务端获取门禁关闭' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('aborts an in-flight prepared receipt reread when the workspace unmounts', async () => {
    mockActivationReads()
    let signal: AbortSignal | undefined
    vi.spyOn(api, 'componentCandidatePreparationReceipt').mockImplementation((_requestId, requestSignal) => {
      signal = requestSignal
      return new Promise(() => undefined)
    })
    const view = render(<VersionUpdateWorkspace status={statusFixture()} demo={false} user={viewer()} />)

    await screen.findByText('Viewer 全局只读')
    fireEvent.change(screen.getByLabelText('准备回执 request ID'), {
      target: { value: '55555555-5555-4555-8555-555555555555' }
    })
    fireEvent.click(screen.getByRole('button', { name: '恢复准备回执' }))
    await waitFor(() => expect(signal).toBeDefined())
    expect(signal?.aborted).toBe(false)
    view.unmount()
    expect(signal?.aborted).toBe(true)
  })

  it('keeps the preparation dry-run visible and latches the UI closed after a 423 mutation refusal', async () => {
    mockActivationReads()
    const acquisitionReceiptId = '11111111-1111-4111-8111-111111111111'
    vi.spyOn(api, 'artifactAcquisitionReceipt').mockResolvedValue({
      data: receiptFixture(false, acquisitionReceiptId)
    })
    vi.spyOn(api, 'previewComponentCandidatePreparation').mockResolvedValue({
      data: preparationPlanFixture(acquisitionReceiptId)
    })
    vi.spyOn(api, 'executeComponentCandidatePreparation').mockRejectedValue(new ApiError(
      423,
      '组件候选准备门禁为 fail-closed；当前只允许读取与预演。',
      'CANDIDATE_PREPARATION_MUTATION_DISABLED'
    ))
    render(<VersionUpdateWorkspace status={statusFixture()} demo={false} user={operator()} />)

    await screen.findByText('Operator 可获取 / 激活只读')
    fireEvent.change(screen.getByLabelText('获取回执 request ID'), {
      target: { value: acquisitionReceiptId }
    })
    fireEvent.click(screen.getByRole('button', { name: '恢复持久回执' }))
    await screen.findByText('RECEIPT VERIFIED')
    fireEvent.click(screen.getByRole('button', { name: '生成候选准备预演' }))
    await screen.findByText('准备 dry-run 已生成')
    fireEvent.change(screen.getByLabelText('候选准备精确确认'), {
      target: { value: 'PREPARE_COMPONENT_CANDIDATE' }
    })
    fireEvent.click(screen.getByRole('button', { name: '准备并固定暂存' }))

    expect((await screen.findByRole('alert')).textContent)
      .toContain('CANDIDATE_PREPARATION_MUTATION_DISABLED')
    expect(screen.getByText('准备 dry-run 已生成')).toBeTruthy()
    expect((screen.getByRole('button', { name: '服务端准备门禁关闭' }) as HTMLButtonElement).disabled)
      .toBe(true)
  })
})

function mockActivationReads(): void {
  vi.spyOn(api, 'updateActivationState').mockResolvedValue({ data: activationStateFixture() })
  vi.spyOn(api, 'updateActivationCleanupPreview').mockResolvedValue({ data: cleanupFixture() })
  vi.spyOn(api, 'updateCompatibilityStatus').mockResolvedValue({ data: compatibilityStatusFixture() })
}

function compatibilityStatusFixture(): UpdateCompatibilityStatus {
  return {
    format: 'dyson-control-trusted-compatibility-status', schemaVersion: 1,
    available: true, policyId: 'fictional-policy-0001', policyRevision: 'p'.repeat(64),
    policyReviewedAt: '2026-08-30T10:00:00.000Z', inventoryRevision: 'i'.repeat(64),
    inventory: {
      dsp: '0.10.33.26727', nebula: '0.9.22.2', bepInEx: '5.4.23', plugins: []
    }
  }
}

function discoveryEnvelope(meta: ArtifactAcquisitionDiscoveryMeta = acquisitionMetaFixture()): NebulaDiscoveryEnvelope {
  const candidate = candidateFixture()
  return {
    data: {
      items: [{
        provider: 'github', sourceId: 'github:NebulaModTeam/nebula', releaseId: 1001,
        version: candidate.release.version, publishedAt: '2026-08-30T01:00:00.000Z', prerelease: false,
        artifact: {
          ...candidate.artifact,
          downloadUrl: 'https://github.com/NebulaModTeam/nebula/releases/download/v0.9.22/Nebula.zip'
        }
      }],
      pagesFetched: 1,
      truncated: false
    },
    meta: { acquisition: meta }
  }
}

function acquisitionMetaFixture(): ArtifactAcquisitionDiscoveryMeta {
  const candidate = candidateFixture()
  return {
    configured: true,
    executionEnabled: true,
    candidates: [{
      artifactId: candidate.artifact.artifactId,
      eligible: true,
      status: 'registered',
      candidate
    }]
  }
}

function candidateFixture(overrides: Partial<ArtifactAcquisitionCandidate> = {}): ArtifactAcquisitionCandidate {
  return {
    candidateId: `candidate-${'a'.repeat(48)}`,
    provider: 'github',
    release: { kind: 'nebula', sourceId: 'github:NebulaModTeam/nebula', version: '0.9.22' },
    artifact: {
      artifactId: `artifact-${'b'.repeat(40)}`,
      fileName: 'Nebula.zip',
      sizeBytes: 4096,
      sha256: 'c'.repeat(64),
      integrity: 'provider-sha256'
    },
    expiresAt: '2099-08-31T08:00:00.000Z',
    ...overrides
  }
}

function planFixture(): ArtifactAcquisitionPlan {
  return {
    format: 'dyson-control-artifact-acquisition-plan', schemaVersion: 1, dryRun: true,
    candidate: candidateFixture(),
    operations: [
      'load-server-registered-candidate', 'acquire-exclusive-request-and-artifact-locks',
      'download-from-bound-provider', 'stream-size-and-sha256-verification',
      'atomically-publish-fixed-inbox-artifact', 'persist-acquisition-receipt',
      'release-exclusive-locks'
    ],
    staging: { automatic: false, nextAction: 'offline-artifact-staging' }
  }
}

function receiptFixture(reused: boolean, requestId = '11111111-1111-4111-8111-111111111111'): ArtifactAcquisitionReceipt {
  const candidate = candidateFixture()
  return {
    format: 'dyson-control-artifact-acquisition-receipt', schemaVersion: 1,
    requestId, candidateId: candidate.candidateId, provider: candidate.provider,
    release: candidate.release,
    artifact: {
      artifactId: candidate.artifact.artifactId,
      fileName: candidate.artifact.fileName,
      sizeBytes: candidate.artifact.sizeBytes!,
      sha256: candidate.artifact.sha256!,
      integrity: 'provider-verified'
    },
    state: 'acquired', reused, acquiredAt: '2026-08-30T08:00:00.000Z'
  }
}

function preparationPlanFixture(
  acquisitionReceiptId = '11111111-1111-4111-8111-111111111111'
): AvailableComponentCandidatePreparationPlan {
  const acquired = receiptFixture(false, acquisitionReceiptId)
  return {
    format: 'dyson-control-component-preparation-plan',
    schemaVersion: 1,
    available: true,
    dryRun: true,
    component: 'nebula',
    acquisitionReceiptId,
    source: {
      provider: 'github',
      sourceId: acquired.release.sourceId,
      version: acquired.release.version,
      artifactId: acquired.artifact.artifactId,
      sizeBytes: acquired.artifact.sizeBytes,
      sha256: acquired.artifact.sha256,
      integrity: acquired.artifact.integrity
    },
    prepared: {
      mode: 'normalized-nebula-windows',
      artifactId: preparedNebulaArtifactId,
      layoutPolicy: 'nebula-official-windows-v0.9.22'
    },
    operations: [
      'load-validated-acquisition-receipt',
      'verify-fixed-inbox-artifact',
      'acquire-exclusive-request-and-artifact-locks',
      'validate-official-nebula-windows-layout-and-identity',
      'build-deterministic-server-managed-component-archive',
      'atomically-publish-fixed-inbox-artifact',
      'stage-verified-artifact',
      'persist-preparation-receipt',
      'release-exclusive-locks'
    ],
    activation: { automatic: false, nextAction: 'component-update-activation-preview' }
  }
}

function preparationReceiptFixture(
  requestId = '33333333-3333-4333-8333-333333333333',
  acquisitionReceiptId = '11111111-1111-4111-8111-111111111111'
): ComponentCandidatePreparationReceipt {
  const plan = preparationPlanFixture(acquisitionReceiptId)
  return {
    format: 'dyson-control-component-preparation-receipt',
    schemaVersion: 1,
    requestId,
    component: 'nebula',
    acquisitionReceiptId,
    source: plan.source,
    prepared: {
      ...plan.prepared,
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
          sourceId: plan.source.sourceId,
          version: plan.source.version
        },
        sizeBytes: 8192,
        sha256: preparedNebulaSha256,
        integrity: 'locally-computed',
        stagedAt: '2026-08-30T08:05:00.000Z'
      }
    },
    state: 'staged',
    reused: false,
    preparedAt: '2026-08-30T08:05:00.000Z'
  }
}

function bepInExCandidateFixture(): ArtifactAcquisitionCandidate {
  return {
    candidateId: `candidate-${'f'.repeat(48)}`,
    provider: 'github',
    release: {
      kind: 'bepinex',
      sourceId: 'github:BepInEx/BepInEx',
      version: '5.4.23.5'
    },
    artifact: {
      artifactId: `artifact-${'9'.repeat(40)}`,
      fileName: 'BepInEx_win_x64_5.4.23.5.zip',
      sizeBytes: 638_940,
      sha256: '8'.repeat(64),
      integrity: 'provider-sha256'
    },
    expiresAt: '2099-08-31T08:00:00.000Z'
  }
}

function bepInExDiscoveryEnvelope(): BepInExDiscoveryEnvelope {
  const candidate = bepInExCandidateFixture()
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
          ...candidate.artifact,
          downloadUrl: 'https://github.com/BepInEx/BepInEx/releases/download/v5.4.23.5/BepInEx_win_x64_5.4.23.5.zip'
        }
      }],
      pagesFetched: 1,
      truncated: false
    },
    meta: {
      acquisition: {
        configured: true,
        executionEnabled: true,
        candidates: [{
          artifactId: candidate.artifact.artifactId,
          eligible: true,
          status: 'registered',
          candidate
        }]
      }
    }
  }
}

function bepInExAcquisitionPlanFixture(): ArtifactAcquisitionPlan {
  return { ...planFixture(), candidate: bepInExCandidateFixture() }
}

function bepInExAcquisitionReceiptFixture(
  requestId = '44444444-4444-4444-8444-444444444444'
): ArtifactAcquisitionReceipt {
  const candidate = bepInExCandidateFixture()
  return {
    format: 'dyson-control-artifact-acquisition-receipt',
    schemaVersion: 1,
    requestId,
    candidateId: candidate.candidateId,
    provider: 'github',
    release: candidate.release,
    artifact: {
      artifactId: candidate.artifact.artifactId,
      fileName: candidate.artifact.fileName,
      sizeBytes: candidate.artifact.sizeBytes!,
      sha256: candidate.artifact.sha256!,
      integrity: 'provider-verified'
    },
    state: 'acquired',
    reused: false,
    acquiredAt: '2026-08-30T08:00:00.000Z'
  }
}

function bepInExPreparationPlanFixture(
  acquisitionReceiptId = '44444444-4444-4444-8444-444444444444'
): AvailableComponentCandidatePreparationPlan {
  const acquired = bepInExAcquisitionReceiptFixture(acquisitionReceiptId)
  return {
    format: 'dyson-control-component-preparation-plan',
    schemaVersion: 1,
    available: true,
    dryRun: true,
    component: 'bepinex',
    acquisitionReceiptId,
    source: {
      provider: 'github',
      sourceId: acquired.release.sourceId,
      version: acquired.release.version,
      artifactId: acquired.artifact.artifactId,
      sizeBytes: acquired.artifact.sizeBytes,
      sha256: acquired.artifact.sha256,
      integrity: acquired.artifact.integrity
    },
    prepared: {
      mode: 'official-bepinex-windows-x64-direct',
      artifactId: acquired.artifact.artifactId,
      layoutPolicy: 'bepinex5-win-x64-5.4.23.2-5-v1'
    },
    operations: [
      'load-validated-acquisition-receipt',
      'verify-fixed-inbox-artifact',
      'acquire-exclusive-request-and-artifact-locks',
      'validate-reviewed-bepinex-windows-x64-layout',
      'stage-official-artifact-directly',
      'stage-verified-artifact',
      'persist-preparation-receipt',
      'release-exclusive-locks'
    ],
    activation: { automatic: false, nextAction: 'component-update-activation-preview' }
  }
}

function bepInExPreparationReceiptFixture(
  requestId = '55555555-5555-4555-8555-555555555555',
  acquisitionReceiptId = '44444444-4444-4444-8444-444444444444'
): ComponentCandidatePreparationReceipt {
  const plan = bepInExPreparationPlanFixture(acquisitionReceiptId)
  return {
    format: 'dyson-control-component-preparation-receipt',
    schemaVersion: 1,
    requestId,
    component: 'bepinex',
    acquisitionReceiptId,
    source: plan.source,
    prepared: {
      ...plan.prepared,
      sizeBytes: plan.source.sizeBytes,
      sha256: plan.source.sha256,
      integrity: plan.source.integrity
    },
    staging: {
      created: true,
      manifest: {
        format: 'dyson-control-staged-artifact',
        schemaVersion: 1,
        artifactId: plan.prepared.artifactId,
        artifactFile: 'artifact.bin',
        release: {
          kind: 'bepinex',
          sourceId: plan.source.sourceId,
          version: plan.source.version
        },
        sizeBytes: plan.source.sizeBytes,
        sha256: plan.source.sha256,
        integrity: plan.source.integrity,
        stagedAt: '2026-08-30T08:05:00.000Z'
      }
    },
    state: 'staged',
    reused: false,
    preparedAt: '2026-08-30T08:05:00.000Z'
  }
}

function operator(): SessionUser {
  return { name: 'Operator', role: 'operator', permissions: ['updates.read', 'updates.stage'] }
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
      lastSavedAt: null, dsvSizeMiB: null, serverSizeKiB: null,
      latestBackupAt: null, backupManifestPresent: false, backupPairPresent: false
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

function activationStateFixture(): UpdateActivationState {
  return {
    revision: '1'.repeat(64), recoveryRequired: false, historyEntries: 0,
    components: [
      { component: 'nebula', version: '0.9.22.2', artifactId: 'fictional-nebula-active-0001', releaseId: `nebula-${'a'.repeat(32)}` },
      { component: 'bepinex', version: '5.4.23', artifactId: 'fictional-bepinex-active-0001', releaseId: `bepinex-${'b'.repeat(32)}` }
    ]
  }
}

function cleanupFixture(): UpdateCleanupPlan {
  return {
    format: 'dyson-control-component-update-cleanup-plan', schemaVersion: 1,
    dryRun: true, executeSupported: false, candidates: []
  }
}

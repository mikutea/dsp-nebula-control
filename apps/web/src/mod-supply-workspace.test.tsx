// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModSupplyWorkspace } from './ModSupplyWorkspace'
import { api } from './api'
import type {
  ArtifactAcquisitionCandidate,
  ArtifactAcquisitionPlan,
  ArtifactAcquisitionReceipt,
  DiscoveredModRelease,
  ModDeploymentRequest,
  StagedModPackageManifest,
  ThunderstoreDependencyClosureEnvelope,
  ThunderstoreDiscoveryEnvelope,
  ThunderstoreModImportPlan,
  ThunderstoreModImportReceipt,
  VerifiedModManifestPreview
} from './model'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Thunderstore mod supply workspace', () => {
  it.each([false, true])('shows reviewed hash provenance and blocks mismatched policy bindings: %s', async mismatch => {
    const release = releaseFixture('Fictional', 'ReviewedPlugin', '1.0.0', [])
    release.artifact = { ...release.artifact, sha256: 'a'.repeat(64), sizeBytes: 2048,
      trustedPolicyRevision: 'b'.repeat(64) }
    const candidate = candidateFixture(release, 'plugin', 'c')
    candidate.artifact.trustedPolicyRevision = (mismatch ? 'd' : 'b').repeat(64)
    vi.spyOn(api, 'discoverThunderstore').mockResolvedValue(discoveryEnvelope(release, candidate))
    vi.spyOn(api, 'discoverThunderstoreDependencies').mockResolvedValue(
      closureEnvelope([release], { root: candidate, library: candidate, platform: candidate }))
    render(<ModSupplyWorkspace demo={false} canAcquire canImport activeRevision={'9'.repeat(64)} onDeploymentRequest={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Thunderstore namespace'), { target: { value: release.namespace } })
    fireEvent.change(screen.getByLabelText('Thunderstore package name'), { target: { value: release.name } })
    fireEvent.click(screen.getByRole('button', { name: '发现精确依赖闭包' }))
    expect(await screen.findByText(/管理员固定哈希 · 策略 bbbbbbbbbbbb · 待下载校验/)).toBeTruthy()
    const button = screen.getByRole('button', { name: `预演获取 ${release.dependencyId}` }) as HTMLButtonElement
    expect(button.disabled).toBe(mismatch)
  })

  it('discovers an exact dependencies-first closure and turns persisted plugin receipts into a logical install request', async () => {
    const onDeploymentRequest = vi.fn<(request: ModDeploymentRequest, label: string) => void>()
    const { root, library, platform } = releases()
    const candidates = candidateFixtures()
    const importReceipts = new Map<string, ThunderstoreModImportReceipt>()

    const discoverLatest = vi.spyOn(api, 'discoverThunderstore').mockResolvedValue(
      discoveryEnvelope(root, candidates.root)
    )
    const discoverClosure = vi.spyOn(api, 'discoverThunderstoreDependencies').mockResolvedValue(
      closureEnvelope([platform, library, root], candidates)
    )
    const previewAcquisition = vi.spyOn(api, 'previewArtifactAcquisition').mockImplementation(async (candidateId) => ({
      data: acquisitionPlan(candidateById(candidateId, candidates))
    }))
    const executeAcquisition = vi.spyOn(api, 'executeArtifactAcquisition').mockImplementation(
      async (requestId, candidateId) => ({ data: acquisitionReceipt(requestId, candidateById(candidateId, candidates)) })
    )
    const readAcquisitionReceipt = vi.spyOn(api, 'artifactAcquisitionReceipt').mockImplementation(
      async (requestId) => ({ data: acquisitionReceiptByRequestId(requestId, executeAcquisition.mock.calls, candidates) })
    )
    const previewImport = vi.spyOn(api, 'previewThunderstoreModImport').mockImplementation(
      async (acquisitionReceiptId) => ({
        data: importPlan(acquisitionReceiptByRequestId(
          acquisitionReceiptId,
          executeAcquisition.mock.calls,
          candidates
        ))
      })
    )
    const executeImport = vi.spyOn(api, 'executeThunderstoreModImport').mockImplementation(
      async (requestId, acquisitionReceiptId) => {
        const receipt = importReceipt(
          requestId,
          acquisitionReceiptByRequestId(acquisitionReceiptId, executeAcquisition.mock.calls, candidates)
        )
        importReceipts.set(requestId, receipt)
        return { data: receipt }
      }
    )
    const readImportReceipt = vi.spyOn(api, 'thunderstoreModImportReceipt').mockImplementation(async (requestId) => {
      const receipt = importReceipts.get(requestId)
      if (!receipt) throw new Error(`Missing test receipt ${requestId}`)
      return { data: receipt }
    })
    const verifiedPreview = verifiedLockPreview()
    const previewVerifiedLock = vi.spyOn(api, 'previewVerifiedModLock').mockResolvedValue({ data: verifiedPreview })

    render(<ModSupplyWorkspace
      demo={false}
      canAcquire
      canImport
      activeRevision={'9'.repeat(64)}
      onDeploymentRequest={onDeploymentRequest}
    />)

    fireEvent.change(screen.getByLabelText('Thunderstore namespace'), { target: { value: 'Fictional' } })
    fireEvent.change(screen.getByLabelText('Thunderstore package name'), { target: { value: 'ServerHelper' } })
    fireEvent.click(screen.getByRole('button', { name: '发现精确依赖闭包' }))

    expect(await screen.findByText(root.dependencyId)).toBeTruthy()
    expect(screen.getByText(library.dependencyId)).toBeTruthy()
    expect(screen.getByText(platform.dependencyId)).toBeTruthy()
    expect(discoverLatest).toHaveBeenCalledWith('Fictional', 'ServerHelper', expect.any(AbortSignal))
    expect(discoverClosure).toHaveBeenCalledWith([root.dependencyId], expect.any(AbortSignal))

    const platformRow = screen.getByText(platform.dependencyId).closest('[data-mod-supply-row]')
    expect(platformRow).not.toBeNull()
    expect(within(platformRow as HTMLElement).getAllByText('BEPINEX PREREQUISITE')).toHaveLength(2)
    expect(within(platformRow as HTMLElement).queryByRole('button', {
      name: new RegExp(`(?:预演|执行)(?:获取|导入) ${escapeRegExp(platform.dependencyId)}`)
    })).toBeNull()

    for (const release of [library, root]) {
      const candidate = release === library ? candidates.library : candidates.root
      fireEvent.click(screen.getByRole('button', { name: `预演获取 ${release.dependencyId}` }))
      await waitFor(() => expect(previewAcquisition).toHaveBeenLastCalledWith(
        candidate.candidateId
      ))

      const acquireButton = screen.getByRole('button', { name: `执行获取 ${release.dependencyId}` }) as HTMLButtonElement
      expect(acquireButton.disabled).toBe(true)
      fireEvent.change(screen.getByLabelText(`获取确认 ${release.dependencyId}`), {
        target: { value: 'ACQUIRE_UPDATE_ARTIFACT' }
      })
      expect(acquireButton.disabled).toBe(false)
      fireEvent.click(acquireButton)

      await waitFor(() => expect(readAcquisitionReceipt).toHaveBeenCalledTimes(
        release === library ? 1 : 2
      ))
      const acquisitionRequestId = executeAcquisition.mock.calls.at(-1)?.[0]
      expect(acquisitionRequestId).toMatch(/^[0-9a-f-]{36}$/)
      expect(executeAcquisition).toHaveBeenLastCalledWith(
        acquisitionRequestId,
        candidate.candidateId
      )
      expect(readAcquisitionReceipt).toHaveBeenLastCalledWith(acquisitionRequestId)

      fireEvent.click(screen.getByRole('button', { name: `预演导入 ${release.dependencyId}` }))
      await waitFor(() => expect(previewImport).toHaveBeenLastCalledWith(
        acquisitionRequestId
      ))

      const importButton = screen.getByRole('button', { name: `执行导入 ${release.dependencyId}` }) as HTMLButtonElement
      expect(importButton.disabled).toBe(true)
      fireEvent.change(screen.getByLabelText(`导入确认 ${release.dependencyId}`), {
        target: { value: 'IMPORT_THUNDERSTORE_MOD' }
      })
      expect(importButton.disabled).toBe(false)
      fireEvent.click(importButton)

      await waitFor(() => expect(readImportReceipt).toHaveBeenCalledTimes(release === library ? 1 : 2))
      const importRequestId = executeImport.mock.calls.at(-1)?.[0]
      expect(importRequestId).toMatch(/^[0-9a-f-]{36}$/)
      expect(executeImport).toHaveBeenLastCalledWith(
        importRequestId,
        acquisitionRequestId
      )
      expect(readImportReceipt).toHaveBeenLastCalledWith(importRequestId)
    }

    const generate = screen.getByRole('button', { name: '生成模组部署请求' }) as HTMLButtonElement
    expect(generate.disabled).toBe(false)
    fireEvent.click(generate)

    await waitFor(() => expect(onDeploymentRequest).toHaveBeenCalledOnce())
    const importReceiptIds = executeImport.mock.calls.map(([requestId]) => requestId)
    expect(previewVerifiedLock).toHaveBeenCalledWith({
      roots: [root.dependencyId],
      importReceiptIds,
      policies: [library, root].map((release) => ({
        sourceId: release.sourceId,
        serverRequired: true,
        clientRequirement: 'required'
      }))
    })

    const [deploymentRequest, label] = onDeploymentRequest.mock.calls[0]!
    expect(deploymentRequest).toMatchObject({
      operation: 'install',
      package: { dependencyId: root.dependencyId, version: root.version },
      manifest: {
        serverLock: verifiedPreview.serverLock,
        clientParity: verifiedPreview.clientParity
      },
      expectedRevision: '9'.repeat(64)
    })
    expect(deploymentRequest.requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(label).toContain(root.dependencyId)

    for (const calls of [
      previewAcquisition.mock.calls,
      executeAcquisition.mock.calls,
      previewImport.mock.calls,
      executeImport.mock.calls,
      previewVerifiedLock.mock.calls
    ]) {
      expect(JSON.stringify(calls)).not.toMatch(/(?:https?:\/\/|[A-Za-z]:\\|\\\\|\/tmp\/|\.zip|stagingPath|pluginsRoot|command)/i)
    }
    expect(document.querySelector('input[type="file"]')).toBeNull()
    expect(screen.queryByLabelText(/(?:path|url|zip|路径|网址|压缩包)/i)).toBeNull()
  })

  it.each([
    ['a missing BepInEx platform-lock requirement', (preview: VerifiedModManifestPreview) => {
      preview.platformLock.requirements = []
    }],
    ['a mismatched platform-lock server digest', (preview: VerifiedModManifestPreview) => {
      preview.platformLock.serverLockSha256 = '7'.repeat(64)
    }],
    ['a null inventory revision despite required platform inventory', (preview: VerifiedModManifestPreview) => {
      preview.platformLock.inventoryRevision = null
    }],
    ['a missing platform-requirements evidence set', (preview: VerifiedModManifestPreview) => {
      preview.platformRequirements = []
    }]
  ])('rejects verified-lock responses with %s and never emits a deployment request', async (_caseName, corrupt) => {
    const preview = verifiedLockPreview()
    corrupt(preview)

    const { onDeploymentRequest, previewVerifiedLock } = await completePluginImportFlow(preview)

    expect(previewVerifiedLock).toHaveBeenCalledOnce()
    expect(await screen.findByText(/已验证模组锁生成失败。 · VERIFIED_MOD_LOCK_RESPONSE_INVALID/)).toBeTruthy()
    expect(onDeploymentRequest).not.toHaveBeenCalled()
  })

  it('keeps concurrent acquisition operations isolated when plugin rows complete in reverse order', async () => {
    const { root, library, platform } = releases()
    const candidates = candidateFixtures()
    vi.spyOn(api, 'discoverThunderstore').mockResolvedValue(discoveryEnvelope(root, candidates.root))
    vi.spyOn(api, 'discoverThunderstoreDependencies').mockResolvedValue(
      closureEnvelope([platform, library, root], candidates)
    )
    vi.spyOn(api, 'previewArtifactAcquisition').mockImplementation(async (candidateId) => ({
      data: acquisitionPlan(candidateById(candidateId, candidates))
    }))

    const pending = new Map<string, {
      requestId: string
      candidate: ArtifactAcquisitionCandidate
      response: Deferred<{ data: ArtifactAcquisitionReceipt }>
    }>()
    const executeAcquisition = vi.spyOn(api, 'executeArtifactAcquisition').mockImplementation(
      (requestId, candidateId) => {
        const candidate = candidateById(candidateId, candidates)
        const response = deferred<{ data: ArtifactAcquisitionReceipt }>()
        pending.set(candidate.release.sourceId, { requestId, candidate, response })
        return response.promise
      }
    )
    const readAcquisitionReceipt = vi.spyOn(api, 'artifactAcquisitionReceipt').mockImplementation(
      async (requestId) => ({
        data: acquisitionReceiptByRequestId(requestId, executeAcquisition.mock.calls, candidates)
      })
    )

    render(<ModSupplyWorkspace
      demo={false}
      canAcquire
      canImport
      activeRevision={'9'.repeat(64)}
      onDeploymentRequest={vi.fn()}
    />)

    fireEvent.change(screen.getByLabelText('Thunderstore namespace'), { target: { value: 'Fictional' } })
    fireEvent.change(screen.getByLabelText('Thunderstore package name'), { target: { value: 'ServerHelper' } })
    fireEvent.click(screen.getByRole('button', { name: '发现精确依赖闭包' }))
    expect(await screen.findByText(root.dependencyId)).toBeTruthy()

    for (const release of [library, root]) {
      fireEvent.click(screen.getByRole('button', { name: `预演获取 ${release.dependencyId}` }))
    }
    await waitFor(() => {
      expect(screen.getByLabelText(`获取确认 ${library.dependencyId}`)).toBeTruthy()
      expect(screen.getByLabelText(`获取确认 ${root.dependencyId}`)).toBeTruthy()
    })

    for (const release of [library, root]) {
      fireEvent.change(screen.getByLabelText(`获取确认 ${release.dependencyId}`), {
        target: { value: 'ACQUIRE_UPDATE_ARTIFACT' }
      })
      fireEvent.click(screen.getByRole('button', { name: `执行获取 ${release.dependencyId}` }))
    }
    await waitFor(() => expect(executeAcquisition).toHaveBeenCalledTimes(2))

    const libraryOperation = pending.get(library.sourceId)
    const rootOperation = pending.get(root.sourceId)
    expect(libraryOperation).toBeDefined()
    expect(rootOperation).toBeDefined()

    await act(async () => {
      rootOperation!.response.resolve({
        data: acquisitionReceipt(rootOperation!.requestId, rootOperation!.candidate)
      })
    })
    expect(await screen.findByRole('button', { name: `预演导入 ${root.dependencyId}` })).toBeTruthy()
    expect(screen.queryByRole('button', { name: `预演导入 ${library.dependencyId}` })).toBeNull()
    expect(readAcquisitionReceipt).toHaveBeenCalledWith(rootOperation!.requestId)

    await act(async () => {
      libraryOperation!.response.resolve({
        data: acquisitionReceipt(libraryOperation!.requestId, libraryOperation!.candidate)
      })
    })
    expect(await screen.findByRole('button', { name: `预演导入 ${library.dependencyId}` })).toBeTruthy()
    expect(screen.getByRole('button', { name: `预演导入 ${root.dependencyId}` })).toBeTruthy()
    expect(readAcquisitionReceipt.mock.calls.map(([requestId]) => requestId)).toEqual([
      rootOperation!.requestId,
      libraryOperation!.requestId
    ])
  })

  it('locks discovery inputs in flight and renders the submitted query identity after inputs change', async () => {
    const { root, library, platform } = releases()
    const candidates = candidateFixtures()
    const latest = deferred<ThunderstoreDiscoveryEnvelope>()
    const discoverLatest = vi.spyOn(api, 'discoverThunderstore').mockImplementation(() => latest.promise)
    const discoverClosure = vi.spyOn(api, 'discoverThunderstoreDependencies').mockResolvedValue(
      closureEnvelope([platform, library, root], candidates)
    )

    render(<ModSupplyWorkspace
      demo={false}
      canAcquire
      canImport
      activeRevision={'9'.repeat(64)}
      onDeploymentRequest={vi.fn()}
    />)

    const namespaceInput = screen.getByLabelText('Thunderstore namespace') as HTMLInputElement
    const packageInput = screen.getByLabelText('Thunderstore package name') as HTMLInputElement
    const discoverButton = screen.getByRole('button', { name: '发现精确依赖闭包' }) as HTMLButtonElement
    fireEvent.change(namespaceInput, { target: { value: 'Fictional' } })
    fireEvent.change(packageInput, { target: { value: 'ServerHelper' } })
    fireEvent.click(discoverButton)

    expect(namespaceInput.disabled).toBe(true)
    expect(packageInput.disabled).toBe(true)
    expect(discoverButton.disabled).toBe(true)
    expect(discoverLatest).toHaveBeenCalledWith('Fictional', 'ServerHelper', expect.any(AbortSignal))

    await act(async () => {
      latest.resolve(discoveryEnvelope(root, candidates.root))
    })
    expect(await screen.findByText(root.dependencyId)).toBeTruthy()
    expect(discoverClosure).toHaveBeenCalledWith([root.dependencyId], expect.any(AbortSignal))

    fireEvent.change(namespaceInput, { target: { value: 'EditedLater' } })
    fireEvent.change(packageInput, { target: { value: 'DifferentPackage' } })
    expect(screen.getByText(/Fictional\/ServerHelper · 3 NODES \/ DEPENDENCIES-FIRST/)).toBeTruthy()
    expect(screen.queryByText(/EditedLater\/DifferentPackage · 3 NODES/)).toBeNull()
  })

  it('keeps Viewer and server-side acquisition/import gates fail-closed', async () => {
    const { root } = releases()
    const candidates = candidateFixtures()
    vi.spyOn(api, 'discoverThunderstore').mockResolvedValue(discoveryEnvelope(root, candidates.root, false))
    vi.spyOn(api, 'discoverThunderstoreDependencies').mockResolvedValue(
      closureEnvelope([releases().platform, releases().library, root], candidates, false)
    )
    const previewAcquisition = vi.spyOn(api, 'previewArtifactAcquisition')
    const previewImport = vi.spyOn(api, 'previewThunderstoreModImport')

    render(<ModSupplyWorkspace
      demo={false}
      canAcquire={false}
      canImport={false}
      activeRevision={'9'.repeat(64)}
      onDeploymentRequest={vi.fn()}
    />)
    fireEvent.change(screen.getByLabelText('Thunderstore namespace'), { target: { value: 'Fictional' } })
    fireEvent.change(screen.getByLabelText('Thunderstore package name'), { target: { value: 'ServerHelper' } })
    fireEvent.click(screen.getByRole('button', { name: '发现精确依赖闭包' }))

    expect(await screen.findByText(root.dependencyId)).toBeTruthy()
    expect(screen.getByText('发现与依赖路由只读')).toBeTruthy()
    expect((screen.getByRole('button', { name: `预演获取 ${root.dependencyId}` }) as HTMLButtonElement).disabled)
      .toBe(true)
    expect(screen.queryByRole('button', { name: `预演导入 ${root.dependencyId}` })).toBeNull()
    expect((screen.getByRole('button', { name: '生成模组部署请求' }) as HTMLButtonElement).disabled).toBe(true)
    expect(previewAcquisition).not.toHaveBeenCalled()
    expect(previewImport).not.toHaveBeenCalled()
  })

  it.each([
    ['MANAGED NEBULA', 'nebula' as const],
    ['BEPINEX PREREQUISITE', 'bepinex' as const]
  ])('routes a non-plugin candidate to %s without exposing ordinary plugin controls', async (routeLabel, kind) => {
    const release = platformRelease(kind)
    const candidate = candidateFixture(release, kind, 'f')
    vi.spyOn(api, 'discoverThunderstore').mockResolvedValue(discoveryEnvelope(release, candidate))
    vi.spyOn(api, 'discoverThunderstoreDependencies').mockResolvedValue(
      closureEnvelope([release], { root: candidate, library: candidate, platform: candidate })
    )
    const previewAcquisition = vi.spyOn(api, 'previewArtifactAcquisition')
    const previewImport = vi.spyOn(api, 'previewThunderstoreModImport')

    render(<ModSupplyWorkspace
      demo={false}
      canAcquire
      canImport
      activeRevision={'9'.repeat(64)}
      onDeploymentRequest={vi.fn()}
    />)
    fireEvent.change(screen.getByLabelText('Thunderstore namespace'), { target: { value: release.namespace } })
    fireEvent.change(screen.getByLabelText('Thunderstore package name'), { target: { value: release.name } })
    fireEvent.click(screen.getByRole('button', { name: '发现精确依赖闭包' }))

    const row = (await screen.findByText(release.dependencyId)).closest('[data-mod-supply-row]')
    expect(row).not.toBeNull()
    expect(within(row as HTMLElement).getAllByText(routeLabel)).toHaveLength(2)
    expect(within(row as HTMLElement).queryByRole('button', { name: /(?:预演|执行)(?:获取|导入)/ })).toBeNull()
    expect(previewAcquisition).not.toHaveBeenCalled()
    expect(previewImport).not.toHaveBeenCalled()
  })

  it('keeps an unclassified non-plugin route on manual policy and never guesses a plugin workflow', async () => {
    const release = releaseFixture('Fictional', 'UnclassifiedCore', '1.0.0', [])
    const candidate = candidateFixture(release, 'plugin', 'e')
    const latest = discoveryEnvelope(release, candidate)
    latest.meta.acquisition.candidates[0]!.candidate = null
    const closure = closureEnvelope([release], { root: candidate, library: candidate, platform: candidate })
    closure.meta.acquisition.candidates[0]!.candidate = null
    closure.data.routes[0] = {
      dependencyId: release.dependencyId,
      sourceId: release.sourceId,
      requiredVersion: release.version,
      disposition: 'unsupported-platform-package',
      deploymentOwner: null,
      resolution: 'manual-policy-required',
      directPluginAcquisitionAllowed: false
    }
    vi.spyOn(api, 'discoverThunderstore').mockResolvedValue(latest)
    vi.spyOn(api, 'discoverThunderstoreDependencies').mockResolvedValue(closure)
    const previewAcquisition = vi.spyOn(api, 'previewArtifactAcquisition')

    render(<ModSupplyWorkspace
      demo={false}
      canAcquire
      canImport
      activeRevision={'9'.repeat(64)}
      onDeploymentRequest={vi.fn()}
    />)
    fireEvent.change(screen.getByLabelText('Thunderstore namespace'), { target: { value: release.namespace } })
    fireEvent.change(screen.getByLabelText('Thunderstore package name'), { target: { value: release.name } })
    fireEvent.click(screen.getByRole('button', { name: '发现精确依赖闭包' }))

    const row = (await screen.findByText(release.dependencyId)).closest('[data-mod-supply-row]')
    expect(row).not.toBeNull()
    expect(within(row as HTMLElement).getAllByText('MANUAL POLICY')).toHaveLength(2)
    expect(within(row as HTMLElement).queryByRole('button', { name: /(?:预演|执行)(?:获取|导入)/ })).toBeNull()
    expect(previewAcquisition).not.toHaveBeenCalled()
  })
})

type CandidateSet = {
  root: ArtifactAcquisitionCandidate
  library: ArtifactAcquisitionCandidate
  platform: ArtifactAcquisitionCandidate
}

function releases() {
  const platform = releaseFixture('xiaoye97', 'BepInEx', '5.4.23', [])
  const library = releaseFixture('Fictional', 'SharedLibrary', '1.1.0', [platform.dependencyId])
  const root = releaseFixture('Fictional', 'ServerHelper', '2.0.0', [library.dependencyId])
  return { root, library, platform }
}

function candidateFixtures(): CandidateSet {
  const { root, library, platform } = releases()
  return {
    root: candidateFixture(root, 'plugin', 'a'),
    library: candidateFixture(library, 'plugin', 'b'),
    platform: candidateFixture(platform, 'bepinex', 'c')
  }
}

function releaseFixture(
  namespace: string,
  name: string,
  version: string,
  dependencies: string[]
): DiscoveredModRelease {
  const sourceId = `thunderstore:${namespace}/${name}`
  return {
    provider: 'thunderstore',
    sourceId,
    dependencyId: `${namespace}-${name}-${version}`,
    namespace,
    name,
    version,
    dependencies,
    publishedAt: '2026-08-31T00:00:00.000Z',
    deprecated: false,
    eligible: true,
    blockers: [],
    artifact: {
      artifactId: `artifact-${name.toLowerCase()}-fixture`,
      downloadUrl: `https://thunderstore.example.invalid/${namespace}/${name}/${version}.zip`,
      fileName: `${namespace}-${name}-${version}.zip`,
      sizeBytes: 4096,
      sha256: name.charCodeAt(0).toString(16).padStart(2, '0').repeat(32),
      integrity: 'provider-sha256'
    }
  }
}

function platformRelease(kind: 'nebula' | 'bepinex'): DiscoveredModRelease {
  return kind === 'nebula'
    ? releaseFixture('nebula', 'NebulaMultiplayerMod', '0.9.23', [])
    : releaseFixture('xiaoye97', 'BepInEx', '5.4.23', [])
}

function candidateFixture(
  release: DiscoveredModRelease,
  kind: ArtifactAcquisitionCandidate['release']['kind'],
  marker: string
): ArtifactAcquisitionCandidate {
  return {
    candidateId: `candidate-${marker.repeat(48)}`,
    provider: 'thunderstore',
    release: kind === 'plugin'
      ? {
          kind,
          sourceId: release.sourceId,
          version: release.version,
          dependencies: [...release.dependencies].sort(),
          dependencyFingerprint: marker.repeat(64)
        }
      : { kind, sourceId: release.sourceId, version: release.version },
    artifact: {
      artifactId: release.artifact.artifactId,
      fileName: release.artifact.fileName,
      sizeBytes: release.artifact.sizeBytes,
      sha256: release.artifact.sha256,
      integrity: release.artifact.integrity
    },
    expiresAt: '2099-08-31T00:00:00.000Z'
  }
}

function discoveryEnvelope(
  release: DiscoveredModRelease,
  candidate: ArtifactAcquisitionCandidate,
  executionEnabled = true
): ThunderstoreDiscoveryEnvelope {
  return {
    data: release,
    meta: {
      acquisition: {
        configured: true,
        executionEnabled,
        candidates: [{ artifactId: release.artifact.artifactId, eligible: true, status: 'registered', candidate }]
      }
    }
  }
}

function closureEnvelope(
  items: DiscoveredModRelease[],
  candidates: CandidateSet,
  executionEnabled = true
): ThunderstoreDependencyClosureEnvelope {
  return {
    data: {
      roots: [items.at(-1)!.dependencyId],
      order: 'dependencies-first',
      items,
      routes: items.map((release) => {
        const candidate = [candidates.root, candidates.library, candidates.platform]
          .find((entry) => entry.release.sourceId === release.sourceId)
        if (candidate?.release.kind === 'nebula') return {
          dependencyId: release.dependencyId,
          sourceId: release.sourceId,
          requiredVersion: release.version,
          disposition: 'managed-component' as const,
          deploymentOwner: 'nebula' as const,
          resolution: 'nebula-component-pipeline' as const,
          directPluginAcquisitionAllowed: false as const
        }
        if (candidate?.release.kind === 'bepinex') return {
          dependencyId: release.dependencyId,
          sourceId: release.sourceId,
          requiredVersion: release.version,
          disposition: 'external-prerequisite' as const,
          deploymentOwner: 'bepinex' as const,
          resolution: 'bepinex-component-inventory' as const,
          directPluginAcquisitionAllowed: false as const
        }
        return {
          dependencyId: release.dependencyId,
          sourceId: release.sourceId,
          requiredVersion: release.version,
          disposition: 'plugin' as const,
          deploymentOwner: 'mods' as const,
          resolution: 'mod-import-pipeline' as const,
          directPluginAcquisitionAllowed: true as const
        }
      }),
      nodeCount: items.length,
      maximumDepth: Math.max(0, items.length - 1),
      canAcquireAll: true,
      blocked: []
    },
    meta: {
      acquisition: {
        configured: true,
        executionEnabled,
        candidates: items.map((release) => {
          const candidate = [candidates.root, candidates.library, candidates.platform]
            .find((entry) => entry.release.sourceId === release.sourceId)
          const isPlugin = candidate?.release.kind === 'plugin'
          return {
            artifactId: release.artifact.artifactId,
            eligible: true,
            status: 'registered' as const,
            candidate: isPlugin ? candidate ?? null : null
          }
        })
      }
    }
  }
}

function candidateById(candidateId: string, candidates: CandidateSet): ArtifactAcquisitionCandidate {
  const candidate = Object.values(candidates).find((entry) => entry.candidateId === candidateId)
  if (!candidate) throw new Error(`Unknown test candidate ${candidateId}`)
  return candidate
}

function acquisitionPlan(candidate: ArtifactAcquisitionCandidate): ArtifactAcquisitionPlan {
  return {
    format: 'dyson-control-artifact-acquisition-plan',
    schemaVersion: 1,
    dryRun: true,
    candidate,
    operations: [
      'load-server-registered-candidate',
      'acquire-exclusive-request-and-artifact-locks',
      'download-from-bound-provider',
      'stream-size-and-sha256-verification',
      'atomically-publish-fixed-inbox-artifact',
      'persist-acquisition-receipt',
      'release-exclusive-locks'
    ],
    staging: { automatic: false, nextAction: 'offline-artifact-staging' }
  }
}

function acquisitionReceipt(
  requestId: string,
  candidate: ArtifactAcquisitionCandidate
): ArtifactAcquisitionReceipt {
  return {
    format: 'dyson-control-artifact-acquisition-receipt',
    schemaVersion: 1,
    requestId,
    candidateId: candidate.candidateId,
    provider: candidate.provider,
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
    acquiredAt: '2026-08-31T00:01:00.000Z'
  }
}

function acquisitionReceiptByRequestId(
  requestId: string,
  calls: Array<[string, string, (AbortSignal | undefined)?]>,
  candidates: CandidateSet
): ArtifactAcquisitionReceipt {
  const call = calls.find(([candidateRequestId]) => candidateRequestId === requestId)
  if (!call) throw new Error(`Unknown acquisition request ${requestId}`)
  return acquisitionReceipt(requestId, candidateById(call[1], candidates))
}

function importPlan(receipt: ArtifactAcquisitionReceipt): ThunderstoreModImportPlan {
  const release = Object.values(releases()).find((entry) => entry.sourceId === receipt.release.sourceId)!
  return {
    format: 'dyson-control-thunderstore-mod-import-plan',
    schemaVersion: 1,
    dryRun: true,
    acquisitionReceiptId: receipt.requestId,
    artifact: {
      artifactId: receipt.artifact.artifactId,
      sizeBytes: receipt.artifact.sizeBytes,
      sha256: receipt.artifact.sha256
    },
    package: {
      dependencyId: release.dependencyId,
      sourceId: release.sourceId,
      version: release.version,
      dependencies: release.dependencies
    },
    payload: { sha256: 'd'.repeat(64), fileCount: 1, sizeBytes: 2048 },
    operations: [
      'load-validated-acquisition-receipt',
      'verify-fixed-inbox-artifact',
      'validate-thunderstore-root-manifest-and-exact-dependencies',
      'apply-bepinex-plugin-only-install-rules',
      'compute-canonical-payload-digest',
      'atomically-publish-mod-staging-package'
    ],
    deployment: { automatic: false, nextAction: 'mod-deployment-preview' }
  }
}

function importReceipt(
  requestId: string,
  acquisition: ArtifactAcquisitionReceipt
): ThunderstoreModImportReceipt {
  const plan = importPlan(acquisition)
  const manifest: StagedModPackageManifest = {
    format: 'dyson-control-staged-mod-package',
    schemaVersion: 1,
    dependencyId: plan.package.dependencyId,
    sourceId: plan.package.sourceId,
    version: plan.package.version,
    dependencies: plan.package.dependencies,
    files: [{ relativePath: 'plugins/Fictional.dll', sizeBytes: 2048, sha256: 'e'.repeat(64) }]
  }
  return {
    format: 'dyson-control-thunderstore-mod-import-receipt',
    schemaVersion: 1,
    requestId,
    acquisitionReceiptId: acquisition.requestId,
    artifact: plan.artifact,
    package: plan.package,
    payload: { ...plan.payload, manifest },
    staging: { created: true },
    state: 'staged',
    reused: false,
    importedAt: '2026-08-31T00:02:00.000Z'
  }
}

function verifiedLockPreview(): VerifiedModManifestPreview {
  const { library, root } = releases()
  const mods = [library, root].map((release, loadOrder) => ({
    dependencyId: release.dependencyId,
    sourceId: release.sourceId,
    version: release.version,
    sha256: String(loadOrder + 1).repeat(64),
    dependencies: release.dependencies.filter((dependency) => !dependency.includes('BepInEx')),
    loadOrder,
    root: release === root,
    serverRequired: true,
    clientRequirement: 'required' as const
  }))
  return {
    mode: 'dry-run',
    serverLock: { format: 'dyson-control-server-mod-lock', schemaVersion: 1, mods },
    serverLockSha256: '8'.repeat(64),
    clientParity: {
      format: 'dyson-control-client-parity',
      schemaVersion: 1,
      serverLockSha256: '8'.repeat(64),
      mods: mods.map(({ sourceId, version, sha256, serverRequired, clientRequirement }) => ({
        sourceId, version, sha256, serverRequired, clientRequirement
      }))
    },
    platformLock: {
      format: 'dyson-control-mod-platform-lock',
      schemaVersion: 1,
      serverLockSha256: '8'.repeat(64),
      inventoryRevision: '9'.repeat(64),
      requirements: [{
        dependencyId: 'xiaoye97-BepInEx-5.4.23',
        sourceId: 'thunderstore:xiaoye97/BepInEx',
        deploymentOwner: 'bepinex',
        requiredVersion: '5.4.23'
      }],
      digest: 'f'.repeat(64)
    },
    platformRequirements: [{
      dependencyId: 'xiaoye97-BepInEx-5.4.23',
      sourceId: 'thunderstore:xiaoye97/BepInEx',
      deploymentOwner: 'bepinex',
      requiredVersion: '5.4.23',
      actualVersion: '5.4.23',
      satisfied: true
    }]
  }
}

async function completePluginImportFlow(verifiedPreview: VerifiedModManifestPreview) {
  const onDeploymentRequest = vi.fn<(request: ModDeploymentRequest, label: string) => void>()
  const { root, library, platform } = releases()
  const candidates = candidateFixtures()
  const importReceipts = new Map<string, ThunderstoreModImportReceipt>()

  vi.spyOn(api, 'discoverThunderstore').mockResolvedValue(discoveryEnvelope(root, candidates.root))
  vi.spyOn(api, 'discoverThunderstoreDependencies').mockResolvedValue(
    closureEnvelope([platform, library, root], candidates)
  )
  vi.spyOn(api, 'previewArtifactAcquisition').mockImplementation(async (candidateId) => ({
    data: acquisitionPlan(candidateById(candidateId, candidates))
  }))
  const executeAcquisition = vi.spyOn(api, 'executeArtifactAcquisition').mockImplementation(
    async (requestId, candidateId) => ({
      data: acquisitionReceipt(requestId, candidateById(candidateId, candidates))
    })
  )
  vi.spyOn(api, 'artifactAcquisitionReceipt').mockImplementation(async (requestId) => ({
    data: acquisitionReceiptByRequestId(requestId, executeAcquisition.mock.calls, candidates)
  }))
  vi.spyOn(api, 'previewThunderstoreModImport').mockImplementation(async (acquisitionReceiptId) => ({
    data: importPlan(acquisitionReceiptByRequestId(
      acquisitionReceiptId,
      executeAcquisition.mock.calls,
      candidates
    ))
  }))
  vi.spyOn(api, 'executeThunderstoreModImport').mockImplementation(async (requestId, acquisitionReceiptId) => {
    const receipt = importReceipt(
      requestId,
      acquisitionReceiptByRequestId(acquisitionReceiptId, executeAcquisition.mock.calls, candidates)
    )
    importReceipts.set(requestId, receipt)
    return { data: receipt }
  })
  vi.spyOn(api, 'thunderstoreModImportReceipt').mockImplementation(async (requestId) => {
    const receipt = importReceipts.get(requestId)
    if (!receipt) throw new Error(`Missing test receipt ${requestId}`)
    return { data: receipt }
  })
  const previewVerifiedLock = vi.spyOn(api, 'previewVerifiedModLock').mockResolvedValue({ data: verifiedPreview })

  render(<ModSupplyWorkspace
    demo={false}
    canAcquire
    canImport
    activeRevision={'9'.repeat(64)}
    onDeploymentRequest={onDeploymentRequest}
  />)

  fireEvent.change(screen.getByLabelText('Thunderstore namespace'), { target: { value: 'Fictional' } })
  fireEvent.change(screen.getByLabelText('Thunderstore package name'), { target: { value: 'ServerHelper' } })
  fireEvent.click(screen.getByRole('button', { name: '发现精确依赖闭包' }))
  expect(await screen.findByText(root.dependencyId)).toBeTruthy()

  for (const release of [library, root]) {
    fireEvent.click(screen.getByRole('button', { name: `预演获取 ${release.dependencyId}` }))
    const acquireConfirmation = await screen.findByLabelText(`获取确认 ${release.dependencyId}`)
    fireEvent.change(acquireConfirmation, { target: { value: 'ACQUIRE_UPDATE_ARTIFACT' } })
    fireEvent.click(screen.getByRole('button', { name: `执行获取 ${release.dependencyId}` }))

    const previewImportButton = await screen.findByRole('button', { name: `预演导入 ${release.dependencyId}` })
    fireEvent.click(previewImportButton)
    const importConfirmation = await screen.findByLabelText(`导入确认 ${release.dependencyId}`)
    fireEvent.change(importConfirmation, { target: { value: 'IMPORT_THUNDERSTORE_MOD' } })
    fireEvent.click(screen.getByRole('button', { name: `执行导入 ${release.dependencyId}` }))

    const row = screen.getByText(release.dependencyId).closest('[data-mod-supply-row]')
    expect(row).not.toBeNull()
    await waitFor(() => expect(within(row as HTMLElement).getByText('PAYLOAD VERIFIED')).toBeTruthy())
  }

  const generate = screen.getByRole('button', { name: '生成模组部署请求' }) as HTMLButtonElement
  await waitFor(() => expect(generate.disabled).toBe(false))
  fireEvent.click(generate)

  return { onDeploymentRequest, previewVerifiedLock }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

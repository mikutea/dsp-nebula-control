import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApplication, type ApplicationDependencies, type BuiltApplication } from './app.js'
import { loadConfig } from './config.js'
import { hashPassword } from './security/password.js'
import {
  UpdatePipelineError,
  bepInExWindowsX64LayoutPolicyIds,
  thunderstoreDependencyFingerprint,
  type ArtifactAcquisitionPlan,
  type ArtifactAcquisitionReceipt,
  type ArtifactCandidateDescriptor,
  type DiscoveredBepInExRelease,
  type DiscoveredModRelease,
  type DiscoveredNebulaRelease
} from './update-pipeline/index.js'

const origin = 'http://127.0.0.1:13010'
const administratorPassword = 'fictional-administrator-password'
const viewerPassword = 'fictional-viewer-password'
const operatorPassword = 'fictional-operator-password'
const requestId = 'a8ff3705-8660-47dc-8a1e-3cca1865530e'
let viewerPasswordHash = ''
let operatorPasswordHash = ''
let application: BuiltApplication | null = null
const temporaryRoots: string[] = []

beforeAll(async () => {
  [viewerPasswordHash, operatorPasswordHash] = await Promise.all([
    hashPassword(viewerPassword),
    hashPassword(operatorPassword)
  ])
})

afterEach(async () => {
  if (application) await application.close()
  application = null
  vi.unstubAllGlobals()
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('managed artifact acquisition application routes', () => {
  it('loads exact mod trust from the server file, rejects browser trust and observes revocation', async () => {
    const roots = await stagingRoots()
    const policyFile = path.join(await realpath(roots.root), 'trusted-policy.json')
    const now = Date.now()
    const policy = {
      format: 'dyson-control-trusted-compatibility-policy', schemaVersion: 1,
      policyId: 'fictional-compatibility', reviewedAt: new Date(now - 60000).toISOString(),
      matrix: { schemaVersion: 1, entries: [{ id: 'fictional', core: {
        dsp: { equals: '0.10.33.26727' }, nebula: { equals: '0.9.22' }, bepInEx: { equals: '5.4.22' }
      }, plugins: [] }] },
      trustedModArtifacts: { format: 'dyson-control-trusted-mod-artifacts', schemaVersion: 1,
        policyId: 'fictional-reviewed-mod', reviewedAt: new Date(now - 60000).toISOString(),
        expiresAt: new Date(now + 3600000).toISOString(), packages: [{
          dependencyId: 'Fictional-ServerHelper-1.2.3', dependencies: [], sha256: 'a'.repeat(64), sizeBytes: 2048
        }] }
    }
    await writeFile(policyFile, JSON.stringify(policy))
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      namespace: 'Fictional', name: 'ServerHelper', full_name: 'Fictional-ServerHelper', is_deprecated: false,
      latest: { namespace: 'Fictional', name: 'ServerHelper', full_name: 'Fictional-ServerHelper-1.2.3',
        version_number: '1.2.3', dependencies: [], is_active: true, date_created: new Date(now - 60000).toISOString(),
        download_url: 'https://thunderstore.io/package/download/Fictional/ServerHelper/1.2.3/' },
      community_listings: [{ community: 'dyson-sphere-program', review_status: 'unreviewed' }]
    }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    application = await buildApplication({ ...enabledConfig(roots), updateCompatibilityPolicyFile: policyFile })
    const cookie = await login('administrator', administratorPassword)
    const request = { namespace: 'Fictional', name: 'ServerHelper' }
    const forged = await post(cookie, '/api/v1/updates/discovery/thunderstore', {
      ...request, trustedModArtifacts: policy.trustedModArtifacts
    })
    expect(forged.statusCode).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
    const discovered = await post(cookie, '/api/v1/updates/discovery/thunderstore', request)
    expect(discovered.statusCode, discovered.body).toBe(200)
    const candidate = discovered.json().meta.acquisition.candidates[0].candidate
    expect(candidate?.artifact, discovered.body).toMatchObject({ sha256: 'a'.repeat(64), sizeBytes: 2048,
      trustedPolicyRevision: expect.stringMatching(/^[0-9a-f]{64}$/) })
    policy.trustedModArtifacts.packages = []
    await writeFile(policyFile, JSON.stringify(policy))
    const preview = await post(cookie, '/api/v1/updates/acquisition/preview', { candidateId: candidate.candidateId })
    expect(preview.json()).toMatchObject({ ok: false, error: { code: 'ACQUISITION_AUTHORITY_REJECTED' } })
    expect(preview.statusCode).not.toBe(200)
    const revoked = await post(cookie, '/api/v1/updates/discovery/thunderstore', request)
    expect(revoked.json().meta.acquisition.candidates[0]).toMatchObject({ eligible: false, candidate: null })
  })

  it('keeps acquisition mutation at 423 by default and never calls the downloader service', async () => {
    const service = acquisitionServiceFixture()
    application = await buildApplication(baseConfig(), { artifactAcquisitionService: service })
    const cookie = await login('administrator', administratorPassword)

    const response = await post(cookie, '/api/v1/updates/acquisition/execute', acquisitionRequest())
    expect(response.statusCode).toBe(423)
    expect(response.json()).toEqual({
      ok: false,
      error: { code: 'UPDATE_ACQUISITION_MUTATION_DISABLED' }
    })
    expect(service.acquire).not.toHaveBeenCalled()
  })

  it('allows Viewer reads and Operator execution, enforces same-origin, and propagates an AbortSignal', async () => {
    const roots = await stagingRoots()
    const service = acquisitionServiceFixture()
    application = await buildApplication(enabledConfig(roots), { artifactAcquisitionService: service })
    const viewer = await login('viewer', viewerPassword)
    const operator = await login('operator', operatorPassword)
    const candidate = candidateFor(nebulaRelease())

    const preview = await post(viewer, '/api/v1/updates/acquisition/preview', {
      candidateId: candidate.candidateId
    })
    expect(preview.statusCode).toBe(200)
    expect(preview.json()).toMatchObject({ ok: true, data: { dryRun: true } })

    const receipt = await application.app.inject({
      method: 'GET',
      url: `/api/v1/updates/acquisition/receipts/${requestId}`,
      cookies: { dyson_session: viewer }
    })
    expect(receipt.statusCode).toBe(200)
    expect(receipt.json()).toMatchObject({ ok: true, data: { requestId } })

    const viewerExecution = await post(viewer, '/api/v1/updates/acquisition/execute', acquisitionRequest())
    expect(viewerExecution.statusCode).toBe(403)
    expect(service.acquire).not.toHaveBeenCalled()

    const missingOrigin = await application.app.inject({
      method: 'POST',
      url: '/api/v1/updates/acquisition/execute',
      cookies: { dyson_session: operator },
      payload: acquisitionRequest()
    })
    expect(missingOrigin.statusCode).toBe(403)
    expect(service.acquire).not.toHaveBeenCalled()

    const executed = await post(operator, '/api/v1/updates/acquisition/execute', acquisitionRequest())
    expect(executed.statusCode).toBe(201)
    expect(executed.json()).toMatchObject({ ok: true, data: { state: 'acquired', reused: false } })
    expect(service.acquire).toHaveBeenCalledOnce()
    const signal = service.acquire.mock.calls[0]![1]
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal?.aborted).toBe(false)
  })

  it('rejects unknown fields, returns a stable 404, and never reflects adapter failures', async () => {
    const roots = await stagingRoots()
    const service = acquisitionServiceFixture()
    application = await buildApplication(enabledConfig(roots), { artifactAcquisitionService: service })
    const cookie = await login('administrator', administratorPassword)
    const marker = 'C:\\Fictional\\Private\\DO-NOT-REFLECT'

    const invalidPreview = await post(cookie, '/api/v1/updates/acquisition/preview', {
      candidateId: candidateFor(nebulaRelease()).candidateId,
      url: marker
    })
    expect(invalidPreview.statusCode).toBe(422)
    expect(invalidPreview.body).not.toContain(marker)

    const invalidExecute = await post(cookie, '/api/v1/updates/acquisition/execute', {
      ...acquisitionRequest(), path: marker
    })
    expect(invalidExecute.statusCode).toBe(422)
    expect(service.acquire).not.toHaveBeenCalled()

    const invalidReceipt = await application.app.inject({
      method: 'GET',
      url: `/api/v1/updates/acquisition/receipts/${requestId}?path=DO-NOT-REFLECT`,
      cookies: { dyson_session: cookie }
    })
    expect(invalidReceipt.statusCode).toBe(422)
    expect(invalidReceipt.json().error.code).toBe('UPDATE_ACQUISITION_REQUEST_INVALID')

    service.getReceipt.mockResolvedValueOnce(null)
    const missing = await application.app.inject({
      method: 'GET',
      url: `/api/v1/updates/acquisition/receipts/${randomUUID()}`,
      cookies: { dyson_session: cookie }
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toEqual({
      ok: false,
      error: { code: 'UPDATE_ACQUISITION_RECEIPT_NOT_FOUND' }
    })

    service.acquire.mockRejectedValueOnce(new UpdatePipelineError(
      'ACQUISITION_REQUEST_FAILED',
      { cause: new Error(`${marker} token=fictional-secret`) }
    ))
    const failed = await post(cookie, '/api/v1/updates/acquisition/execute', acquisitionRequest())
    expect(failed.statusCode).toBe(503)
    expect(failed.json()).toEqual({ ok: false, error: { code: 'ACQUISITION_REQUEST_FAILED' } })
    expect(failed.body).not.toContain(marker)
    expect(failed.body).not.toContain('fictional-secret')
  })

  it('registers every eligible discovery result and reports null candidates explicitly when unavailable', async () => {
    const service = acquisitionServiceFixture()
    const secondNebula = nebulaRelease({
      version: '0.9.23',
      artifactId: `artifact-${'d'.repeat(40)}`,
      fileName: 'Nebula-0.9.23.zip'
    })
    const modClient = vi.fn(async (): Promise<DiscoveredModRelease> => modRelease())
    const dependencyRelease: DiscoveredModRelease = {
      ...modRelease(),
      sourceId: 'thunderstore:Fictional/CoreLib',
      dependencyId: 'Fictional-CoreLib-1.0.0',
      name: 'CoreLib',
      artifact: {
        ...modRelease().artifact,
        artifactId: `artifact-${'9'.repeat(40)}`,
        downloadUrl: 'https://thunderstore.io/package/download/Fictional/CoreLib/1.0.0/',
        fileName: 'Fictional-CoreLib-1.0.0.zip'
      }
    }
    const bepInExPrerequisite = thunderstoreRelease('xiaoye97', 'BepInEx', '5.4.17', '8')
    const nebulaApiComponent = thunderstoreRelease('nebula', 'NebulaMultiplayerModApi', '2.1.0', '7')
    const rootRelease = {
      ...modRelease(),
      dependencies: [
        dependencyRelease.dependencyId,
        bepInExPrerequisite.dependencyId,
        nebulaApiComponent.dependencyId
      ]
    }
    const dependencyClosureClient = vi.fn(async () => ({
      roots: [rootRelease.dependencyId],
      order: 'dependencies-first' as const,
      items: [dependencyRelease, bepInExPrerequisite, nebulaApiComponent, rootRelease],
      routes: [
        pluginRoute(dependencyRelease),
        {
          dependencyId: bepInExPrerequisite.dependencyId,
          sourceId: bepInExPrerequisite.sourceId,
          requiredVersion: bepInExPrerequisite.version,
          disposition: 'external-prerequisite' as const,
          deploymentOwner: 'bepinex' as const,
          resolution: 'bepinex-component-inventory' as const,
          directPluginAcquisitionAllowed: false as const
        },
        {
          dependencyId: nebulaApiComponent.dependencyId,
          sourceId: nebulaApiComponent.sourceId,
          requiredVersion: nebulaApiComponent.version,
          disposition: 'managed-component' as const,
          deploymentOwner: 'nebula' as const,
          resolution: 'nebula-component-pipeline' as const,
          directPluginAcquisitionAllowed: false as const
        },
        pluginRoute(rootRelease)
      ],
      nodeCount: 4,
      maximumDepth: 1,
      canAcquireAll: false,
      blocked: []
    }))
    application = await buildApplication(baseConfig(), {
      artifactAcquisitionService: service,
      nebulaReleaseClient: {
        async discover() { return { items: [nebulaRelease(), secondNebula], pagesFetched: 1, truncated: false } }
      },
      thunderstoreReleaseClient: {
        discoverLatest: modClient,
        discoverDependencyClosure: dependencyClosureClient
      }
    })
    const cookie = await login('administrator', administratorPassword)

    const nebula = await post(cookie, '/api/v1/updates/discovery/nebula', {})
    expect(nebula.statusCode).toBe(200)
    expect(nebula.json().meta.acquisition).toMatchObject({ configured: true, executionEnabled: false })
    expect(nebula.json().meta.acquisition.candidates).toEqual([
      expect.objectContaining({ eligible: true, status: 'registered', candidate: expect.any(Object) }),
      expect.objectContaining({ eligible: true, status: 'registered', candidate: expect.any(Object) })
    ])
    expect(service.registerNebulaRelease).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(nebula.json().meta)).not.toMatch(/downloadUrl|https:\/\/|[A-Za-z]:\\|\\\\/i)

    const thunderstore = await post(cookie, '/api/v1/updates/discovery/thunderstore', {
      namespace: 'Fictional', name: 'ServerHelper'
    })
    expect(thunderstore.statusCode).toBe(200)
    expect(thunderstore.json().meta.acquisition.candidates[0]).toMatchObject({
      eligible: true, status: 'registered', candidate: { provider: 'thunderstore' }
    })
    expect(service.registerModRelease).toHaveBeenCalledOnce()

    const closure = await post(cookie, '/api/v1/updates/discovery/thunderstore/dependencies', {
      roots: [rootRelease.dependencyId]
    })
    expect(closure.statusCode).toBe(200)
    expect(closure.json()).toMatchObject({
      data: {
        roots: [rootRelease.dependencyId],
        order: 'dependencies-first',
        items: [
          { dependencyId: dependencyRelease.dependencyId },
          { dependencyId: bepInExPrerequisite.dependencyId },
          { dependencyId: nebulaApiComponent.dependencyId },
          { dependencyId: rootRelease.dependencyId }
        ],
        routes: [
          { dependencyId: dependencyRelease.dependencyId, disposition: 'plugin' },
          { dependencyId: bepInExPrerequisite.dependencyId, disposition: 'external-prerequisite' },
          { dependencyId: nebulaApiComponent.dependencyId, disposition: 'managed-component' },
          { dependencyId: rootRelease.dependencyId, disposition: 'plugin' }
        ]
      },
      meta: {
        acquisition: {
          candidates: [
            { eligible: true, status: 'registered', candidate: { provider: 'thunderstore' } },
            { eligible: false, status: 'release-ineligible', candidate: null },
            { eligible: false, status: 'release-ineligible', candidate: null },
            { eligible: true, status: 'registered', candidate: { provider: 'thunderstore' } }
          ]
        }
      }
    })
    expect(closure.json().meta.acquisition.candidates[3].candidate.release).toEqual({
      kind: 'plugin',
      sourceId: rootRelease.sourceId,
      version: rootRelease.version,
      dependencies: rootRelease.dependencies,
      dependencyFingerprint: thunderstoreDependencyFingerprint(rootRelease.dependencies)
    })
    expect(dependencyClosureClient).toHaveBeenCalledWith(
      { roots: [rootRelease.dependencyId] },
      expect.any(AbortSignal)
    )
    expect(service.registerModRelease).toHaveBeenCalledTimes(3)

    modClient.mockResolvedValueOnce(nebulaApiComponent)
    const managedComponent = await post(cookie, '/api/v1/updates/discovery/thunderstore', {
      namespace: 'nebula', name: 'NebulaMultiplayerModApi'
    })
    expect(managedComponent.statusCode).toBe(200)
    expect(managedComponent.json()).toMatchObject({
      meta: {
        routing: {
          dependencyId: nebulaApiComponent.dependencyId,
          disposition: 'managed-component',
          deploymentOwner: 'nebula',
          directPluginAcquisitionAllowed: false
        },
        acquisition: {
          candidates: [{ eligible: false, status: 'release-ineligible', candidate: null }]
        }
      }
    })
    expect(service.registerModRelease).toHaveBeenCalledTimes(3)

    modClient.mockResolvedValueOnce({ ...modRelease(), eligible: false, deprecated: true,
      blockers: ['package-deprecated', 'artifact-integrity-pending'] })
    const ineligible = await post(cookie, '/api/v1/updates/discovery/thunderstore', {
      namespace: 'Fictional', name: 'ServerHelper'
    })
    expect(ineligible.json().meta.acquisition.candidates[0]).toEqual({
      artifactId: modRelease().artifact.artifactId,
      eligible: false,
      status: 'release-ineligible',
      candidate: null
    })
    expect(service.registerModRelease).toHaveBeenCalledTimes(3)

    await application.close()
    application = await buildApplication(baseConfig(), {
      nebulaReleaseClient: {
        async discover() { return { items: [nebulaRelease()], pagesFetched: 1, truncated: false } }
      }
    })
    const noServiceCookie = await login('administrator', administratorPassword)
    const unavailable = await post(noServiceCookie, '/api/v1/updates/discovery/nebula', {})
    expect(unavailable.json().meta.acquisition).toEqual({
      configured: false,
      executionEnabled: false,
      candidates: [{
        artifactId: nebulaRelease().artifact.artifactId,
        eligible: true,
        status: 'not-configured',
        candidate: null
      }]
    })
  })

  it('discovers only reviewed official BepInEx Windows x64 releases and registers their acquisition candidates', async () => {
    const service = acquisitionServiceFixture()
    const release = bepInExRelease()
    application = await buildApplication(baseConfig(), {
      artifactAcquisitionService: service,
      bepInExReleaseClient: {
        async discover() { return { items: [release], pagesFetched: 1, truncated: false } }
      }
    })
    const cookie = await login('administrator', administratorPassword)

    const response = await post(cookie, '/api/v1/updates/discovery/bepinex', {})
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      data: { items: [{ sourceId: 'github:BepInEx/BepInEx', version: '5.4.22' }] },
      meta: {
        acquisition: {
          candidates: [{
            eligible: true,
            status: 'registered',
            candidate: { provider: 'github', release: { kind: 'bepinex' } }
          }]
        }
      }
    })
    expect(service.registerBepInExRelease).toHaveBeenCalledOnce()
  })

  it('runs discovery registration through acquisition into fixed inbox and offline staging', async () => {
    const roots = await stagingRoots()
    const bytes = zipBytes('fictional-nebula-acquisition-e2e')
    const release = nebulaRelease({
      artifactId: `artifact-${'e'.repeat(40)}`,
      sizeBytes: bytes.length,
      sha256: sha256(bytes)
    })
    const fetch = vi.fn(async () => zipResponse(bytes))
    vi.stubGlobal('fetch', fetch)
    application = await buildApplication(enabledConfig(roots), {
      nebulaReleaseClient: {
        async discover() { return { items: [release], pagesFetched: 1, truncated: false } }
      },
      thunderstoreReleaseClient: { async discoverLatest() { return modRelease() } }
    })
    const cookie = await login('administrator', administratorPassword)

    const discovery = await post(cookie, '/api/v1/updates/discovery/nebula', {})
    const candidate = discovery.json().meta.acquisition.candidates[0].candidate as ArtifactCandidateDescriptor
    expect(candidate).toMatchObject({ provider: 'github', artifact: { artifactId: release.artifact.artifactId } })
    expect(JSON.stringify(candidate)).not.toContain('https://')

    const preview = await post(cookie, '/api/v1/updates/acquisition/preview', {
      candidateId: candidate.candidateId
    })
    expect(preview.statusCode).toBe(200)
    expect(preview.json()).toMatchObject({ ok: true, data: { dryRun: true, staging: { automatic: false } } })

    const acquisition = await post(cookie, '/api/v1/updates/acquisition/execute', {
      requestId,
      candidateId: candidate.candidateId,
      confirmation: 'ACQUIRE_UPDATE_ARTIFACT'
    })
    expect(acquisition.statusCode).toBe(201)
    const receipt = acquisition.json().data as ArtifactAcquisitionReceipt
    expect(receipt).toMatchObject({ state: 'acquired', artifact: { sha256: sha256(bytes) } })
    await expect(readFile(path.join(roots.inboxRoot, `${release.artifact.artifactId}.artifact`))).resolves.toEqual(bytes)

    const receiptResponse = await application.app.inject({
      method: 'GET',
      url: `/api/v1/updates/acquisition/receipts/${requestId}`,
      cookies: { dyson_session: cookie }
    })
    expect(receiptResponse.statusCode).toBe(200)
    expect(receiptResponse.json().data).toEqual(receipt)

    const staged = await post(cookie, '/api/v1/updates/staging/execute', {
      confirmation: 'STAGE_ARTIFACT',
      request: {
        artifactId: receipt.artifact.artifactId,
        release: receipt.release,
        expected: { sizeBytes: receipt.artifact.sizeBytes, sha256: receipt.artifact.sha256 }
      }
    })
    expect(staged.statusCode).toBe(201)
    expect(staged.json().data.manifest).toMatchObject({
      artifactId: release.artifact.artifactId,
      release: { kind: 'nebula', version: release.version },
      sha256: sha256(bytes)
    })
    expect(await readdir(path.join(roots.stagingRoot, 'acquisitions', 'receipts'))).toEqual([`${requestId}.json`])
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

function baseConfig() {
  return loadConfig({
    NODE_ENV: 'test',
    DYSON_PROVIDER: 'demo',
    DYSON_PUBLIC_ORIGIN: origin,
    DYSON_DEV_ADMIN_PASSWORD: administratorPassword,
    DYSON_VIEWER_PASSWORD_HASH: viewerPasswordHash,
    DYSON_OPERATOR_PASSWORD_HASH: operatorPasswordHash
  })
}

function enabledConfig(roots: { inboxRoot: string; stagingRoot: string }) {
  return loadConfig({
    NODE_ENV: 'test',
    DYSON_PROVIDER: 'demo',
    DYSON_PUBLIC_ORIGIN: origin,
    DYSON_DEV_ADMIN_PASSWORD: administratorPassword,
    DYSON_VIEWER_PASSWORD_HASH: viewerPasswordHash,
    DYSON_OPERATOR_PASSWORD_HASH: operatorPasswordHash,
    DYSON_UPDATE_STAGING_ENABLED: 'true',
    DYSON_UPDATE_ACQUISITION_ENABLED: 'true',
    DYSON_UPDATE_INBOX_ROOT: roots.inboxRoot,
    DYSON_UPDATE_STAGING_ROOT: roots.stagingRoot
  })
}

async function stagingRoots() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'dyson-acquisition-routes-')))
  temporaryRoots.push(root)
  const inboxRoot = path.join(root, 'inbox')
  const stagingRoot = path.join(root, 'staging')
  await Promise.all([mkdir(inboxRoot), mkdir(stagingRoot)])
  return { root, inboxRoot, stagingRoot }
}

async function login(role: 'viewer' | 'operator' | 'administrator', password: string): Promise<string> {
  const response = await application!.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin },
    payload: { role, password }
  })
  expect(response.statusCode).toBe(200)
  return response.cookies[0]!.value
}

async function post(cookie: string, url: string, payload: Record<string, unknown>) {
  return application!.app.inject({
    method: 'POST',
    url,
    headers: { origin },
    cookies: { dyson_session: cookie },
    payload
  })
}

function acquisitionRequest() {
  return {
    requestId,
    candidateId: candidateFor(nebulaRelease()).candidateId,
    confirmation: 'ACQUIRE_UPDATE_ARTIFACT'
  }
}

function acquisitionServiceFixture() {
  const candidate = candidateFor(nebulaRelease())
  const receipt = receiptFor(candidate)
  return {
    registerNebulaRelease: vi.fn(async (input: unknown) => candidateFor(input as DiscoveredNebulaRelease)),
    registerBepInExRelease: vi.fn(async (input: unknown) => candidateFor(input as DiscoveredBepInExRelease)),
    registerModRelease: vi.fn(async (input: unknown) => candidateFor(input as DiscoveredModRelease)),
    preview: vi.fn(async () => planFor(candidate)),
    acquire: vi.fn(async (_input: unknown, _signal?: AbortSignal) => receipt),
    getReceipt: vi.fn(async (_input: unknown): Promise<ArtifactAcquisitionReceipt | null> => receipt)
  } satisfies NonNullable<ApplicationDependencies['artifactAcquisitionService']>
}

function candidateFor(
  release: DiscoveredNebulaRelease | DiscoveredBepInExRelease | DiscoveredModRelease
): ArtifactCandidateDescriptor {
  const dependencyBinding = release.provider === 'thunderstore'
    ? {
        dependencies: [...release.dependencies],
        dependencyFingerprint: thunderstoreDependencyFingerprint(release.dependencies)
      }
    : {}
  return {
    candidateId: `candidate-${sha256(Buffer.from(release.artifact.artifactId)).slice(0, 48)}`,
    provider: release.provider === 'github' ? 'github' : 'thunderstore',
    release: {
      kind: release.provider === 'thunderstore'
        ? 'plugin'
        : release.sourceId.toLowerCase() === 'github:bepinex/bepinex'
          ? 'bepinex'
          : 'nebula',
      sourceId: release.sourceId,
      version: release.version,
      ...dependencyBinding
    },
    artifact: {
      artifactId: release.artifact.artifactId,
      fileName: release.artifact.fileName,
      sizeBytes: release.artifact.sizeBytes,
      sha256: release.artifact.sha256,
      integrity: release.artifact.integrity
    },
    expiresAt: '2026-08-31T08:00:00.000Z'
  }
}

function planFor(candidate: ArtifactCandidateDescriptor): ArtifactAcquisitionPlan {
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

function receiptFor(candidate: ArtifactCandidateDescriptor): ArtifactAcquisitionReceipt {
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
      sizeBytes: candidate.artifact.sizeBytes ?? 1024,
      sha256: candidate.artifact.sha256 ?? 'c'.repeat(64),
      integrity: candidate.artifact.sha256 === null ? 'locally-computed' : 'provider-verified'
    },
    state: 'acquired',
    reused: false,
    acquiredAt: '2026-08-30T08:00:00.000Z'
  }
}

function nebulaRelease(overrides: {
  version?: string
  artifactId?: string
  fileName?: string
  sizeBytes?: number
  sha256?: string
} = {}): DiscoveredNebulaRelease {
  return {
    provider: 'github',
    sourceId: 'github:NebulaModTeam/nebula',
    releaseId: 1001,
    version: overrides.version ?? '0.9.22',
    publishedAt: '2026-08-30T01:00:00.000Z',
    prerelease: false,
    artifact: {
      artifactId: overrides.artifactId ?? `artifact-${'b'.repeat(40)}`,
      downloadUrl: `https://github.com/NebulaModTeam/nebula/releases/download/v${overrides.version ?? '0.9.22'}/${overrides.fileName ?? 'Nebula.zip'}`,
      fileName: overrides.fileName ?? 'Nebula.zip',
      sizeBytes: overrides.sizeBytes ?? 1024,
      sha256: overrides.sha256 ?? 'c'.repeat(64),
      integrity: 'provider-sha256'
    }
  }
}

function modRelease(): DiscoveredModRelease {
  return {
    provider: 'thunderstore',
    sourceId: 'thunderstore:Fictional/ServerHelper',
    dependencyId: 'Fictional-ServerHelper-1.0.0',
    namespace: 'Fictional',
    name: 'ServerHelper',
    version: '1.0.0',
    dependencies: [],
    publishedAt: '2026-08-30T01:00:00.000Z',
    deprecated: false,
    eligible: true,
    blockers: ['artifact-integrity-pending'],
    artifact: {
      artifactId: `artifact-${'f'.repeat(40)}`,
      downloadUrl: 'https://thunderstore.io/package/download/Fictional/ServerHelper/1.0.0/',
      fileName: 'Fictional-ServerHelper-1.0.0.zip',
      sizeBytes: null,
      sha256: null,
      integrity: 'locally-computed-required'
    }
  }
}

function thunderstoreRelease(
  namespace: string,
  name: string,
  version: string,
  artifactCharacter: string
): DiscoveredModRelease {
  return {
    ...modRelease(),
    sourceId: `thunderstore:${namespace}/${name}`,
    dependencyId: `${namespace}-${name}-${version}`,
    namespace,
    name,
    version,
    artifact: {
      ...modRelease().artifact,
      artifactId: `artifact-${artifactCharacter.repeat(40)}`,
      downloadUrl: `https://thunderstore.io/package/download/${namespace}/${name}/${version}/`,
      fileName: `${namespace}-${name}-${version}.zip`
    }
  }
}

function pluginRoute(release: DiscoveredModRelease) {
  return {
    dependencyId: release.dependencyId,
    sourceId: release.sourceId,
    requiredVersion: release.version,
    disposition: 'plugin' as const,
    deploymentOwner: 'mods' as const,
    resolution: 'mod-import-pipeline' as const,
    directPluginAcquisitionAllowed: true as const
  }
}

function bepInExRelease(): DiscoveredBepInExRelease {
  return {
    provider: 'github',
    sourceId: 'github:BepInEx/BepInEx',
    releaseId: 54022,
    version: '5.4.22',
    publishedAt: '2026-08-30T03:00:00.000Z',
    layoutPolicy: bepInExWindowsX64LayoutPolicyIds.v5_4_22,
    artifact: {
      artifactId: `artifact-${'f'.repeat(40)}`,
      downloadUrl: 'https://github.com/BepInEx/BepInEx/releases/download/v5.4.22/BepInEx_x64_5.4.22.0.zip',
      fileName: 'BepInEx_x64_5.4.22.0.zip',
      sizeBytes: 640_000,
      sha256: 'f'.repeat(64),
      integrity: 'provider-sha256'
    }
  }
}

function zipBytes(label: string): Buffer {
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(label, 'utf8')])
}

function zipResponse(bytes: Buffer): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': 'application/zip', 'content-length': String(bytes.length) }
  })
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

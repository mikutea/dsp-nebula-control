import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ManagedArtifactAcquisitionService,
  thunderstoreDependencyFingerprint,
  type ManagedArtifactAcquisitionOptions,
  type ArtifactCandidateDescriptor
} from './acquisition.js'
import type { DiscoveredModRelease, DiscoveredNebulaRelease } from './discovery.js'
import type { DiscoveredBepInExRelease } from './bepinex-discovery.js'
import { bepInExWindowsX64LayoutPolicyIds } from './bepinex-layout.js'
import { OfflineArtifactStager } from './staging.js'
import { TrustedModArtifactPolicy, trustedModAcquisitionAuthority } from './trusted-mod-artifacts.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('managed artifact acquisition', () => {
  it('binds reviewed mod downloads to an exact policy and fails closed when the policy is removed', async () => {
    const value = await fixture()
    const release = modRelease(value)
    let policy: TrustedModArtifactPolicy | null = new TrustedModArtifactPolicy({
      format: 'dyson-control-trusted-mod-artifacts', schemaVersion: 1, policyId: 'fictional-review',
      reviewedAt: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z',
      packages: [{ dependencyId: release.dependencyId, dependencies: release.dependencies,
        sha256: value.sha256, sizeBytes: value.bytes.length }]
    })
    release.artifact = { ...release.artifact, sha256: value.sha256, sizeBytes: value.bytes.length,
      trustedPolicyRevision: policy.revision }
    const fetch = vi.fn(async () => zipResponse(value.bytes))
    await expect(acquisition(value, fetch).registerModRelease(release)).rejects.toThrow('ACQUISITION_AUTHORITY_REQUIRED')
    const service = acquisition(value, fetch, { authorizeCandidate: trustedModAcquisitionAuthority(
      async () => policy, () => Date.parse('2026-09-01T00:00:00Z')) })
    for (const artifact of [
      { ...release.artifact, sha256: 'f'.repeat(64) },
      { ...release.artifact, sizeBytes: value.bytes.length + 1 },
      { ...release.artifact, trustedPolicyRevision: 'f'.repeat(64) }
    ]) {
      await expect(service.registerModRelease({ ...release, artifact })).rejects.toThrow('ACQUISITION_AUTHORITY_REJECTED')
    }
    const candidate = await service.registerModRelease(release)
    const acquired = await service.acquire(requestFor(candidate))
    expect(acquired.artifact).toMatchObject({ sha256: value.sha256, integrity: 'locally-computed',
      trustedPolicyRevision: policy.revision })
    await expect(service.verifyReceiptAuthority(acquired.requestId)).resolves.toBeUndefined()
    policy = null
    await expect(service.verifyReceiptAuthority(acquired.requestId)).rejects.toThrow('ACQUISITION_AUTHORITY_REJECTED')
    await expect(service.acquire(requestFor(candidate))).rejects.toThrow('ACQUISITION_AUTHORITY_REJECTED')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects revoked authority at registration, preview, acquisition and receipt replay', async () => {
    const value = await fixture()
    let allowed = false
    const fetch = vi.fn(async () => zipResponse(value.bytes))
    const service = acquisition(value, fetch, { authorizeCandidate: async () => allowed })
    await expect(service.registerModRelease(modRelease(value))).rejects.toThrow('ACQUISITION_AUTHORITY_REJECTED')
    allowed = true
    const candidate = await service.registerModRelease(modRelease(value))
    allowed = false
    await expect(service.registerModRelease(modRelease(value))).rejects.toThrow('ACQUISITION_AUTHORITY_REJECTED')
    await expect(service.preview(candidate.candidateId)).rejects.toThrow('ACQUISITION_AUTHORITY_REJECTED')
    const request = requestFor(candidate)
    await expect(service.acquire(request)).rejects.toThrow('ACQUISITION_AUTHORITY_REJECTED')
    expect(fetch).not.toHaveBeenCalled()
    allowed = true
    const receipt = await service.acquire(request)
    allowed = false
    await expect(service.acquire(request)).rejects.toThrow('ACQUISITION_AUTHORITY_REJECTED')
    // Historical evidence remains readable; replay cannot grant fresh authorization.
    expect(await service.getReceipt(request.requestId)).toEqual(receipt)
  })

  it('does not publish a download when authority is revoked while fetching', async () => {
    const value = await fixture()
    let allowed = true
    const service = acquisition(value, async () => {
      allowed = false
      return zipResponse(value.bytes)
    }, { authorizeCandidate: async () => allowed })
    const candidate = await service.registerModRelease(modRelease(value))
    const request = requestFor(candidate)
    await expect(service.acquire(request)).rejects.toThrow('ACQUISITION_AUTHORITY_REJECTED')
    expect(await readdir(value.inboxRoot)).toEqual([])
    expect(await service.getReceipt(request.requestId)).toBeNull()
  })

  it('does not attribute a non-provider expected digest to the provider', async () => {
    const value = await fixture()
    const service = acquisition(value, async () => zipResponse(value.bytes))
    const release = modRelease(value)
    release.artifact.sha256 = value.sha256
    release.artifact.sizeBytes = value.bytes.length
    const candidate = await service.registerModRelease(release)
    const receipt = await service.acquire(requestFor(candidate))
    expect(receipt.artifact).toMatchObject({ sha256: value.sha256, integrity: 'locally-computed' })
    expect((await service.getReceipt(receipt.requestId))?.artifact.integrity).toBe('locally-computed')
  })

  it('still enforces non-provider expected digests before publishing an artifact', async () => {
    const value = await fixture()
    const service = acquisition(value, async () => zipResponse(value.bytes))
    const release = modRelease(value)
    release.artifact.sha256 = 'f'.repeat(64)
    release.artifact.sizeBytes = value.bytes.length
    const candidate = await service.registerModRelease(release)
    const request = requestFor(candidate)
    await expect(service.acquire(request)).rejects.toThrow('ACQUISITION_SHA256_MISMATCH')
    await expect(readFile(path.join(value.inboxRoot, `${value.artifactId}.artifact`))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await service.getReceipt(request.requestId)).toBeNull()
  })

  it('retries both request and artifact locks after the downloader process exits', async () => {
    const value = await fixture()
    const fetch = vi.fn(async () => zipResponse(value.bytes))
    const service = acquisition(value, fetch)
    const candidate = await service.registerNebulaRelease(nebulaRelease(value))
    const request = requestFor(candidate)
    const source = new URL('./acquisition.ts', import.meta.url).href
    const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href
    const program = `import { ManagedArtifactAcquisitionService } from ${JSON.stringify(source)};
      const input = JSON.parse(process.argv[1]);
      const service = new ManagedArtifactAcquisitionService({ inboxRoot: input.inboxRoot, stateRoot: input.stateRoot,
        now: () => new Date('2026-08-30T08:00:00.000Z'), fetch: async () => { process.exit(75); } });
      await service.acquire(input.request); process.exit(76);`
    const child = spawnSync(process.execPath, ['--import', loader, '--input-type=module', '--eval', program,
      JSON.stringify({ inboxRoot: value.inboxRoot, stateRoot: value.stateRoot, request })],
    { windowsHide: true, timeout: 15_000, encoding: 'utf8', maxBuffer: 64 * 1024 })
    expect(child.status, child.stderr).toBe(75)
    const first = await service.acquire(request)
    expect(first).toMatchObject({ state: 'acquired', artifact: { sha256: value.sha256 } })
    expect(await readFile(path.join(value.inboxRoot, `${value.artifactId}.artifact`))).toEqual(value.bytes)
    expect(await service.acquire(request)).toEqual(first)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('binds discovery server-side, downloads into the fixed inbox, persists a redacted receipt, and replays idempotently', async () => {
    const value = await fixture()
    const fetch = vi.fn(async () => zipResponse(value.bytes))
    const service = acquisition(value, fetch)
    const candidate = await service.registerNebulaRelease(nebulaRelease(value))

    expect(JSON.stringify(candidate)).not.toContain('https://')
    const plan = await service.preview(candidate.candidateId)
    expect(plan).toMatchObject({
      dryRun: true,
      candidate: { candidateId: candidate.candidateId, artifact: { artifactId: value.artifactId } },
      staging: { automatic: false }
    })
    expect(JSON.stringify(plan)).not.toContain(value.root)
    expect(JSON.stringify(plan)).not.toContain('https://')

    const request = requestFor(candidate)
    const first = await service.acquire(request)
    expect(first).toMatchObject({
      requestId: request.requestId,
      candidateId: candidate.candidateId,
      state: 'acquired',
      reused: false,
      artifact: {
        artifactId: value.artifactId,
        sizeBytes: value.bytes.length,
        sha256: value.sha256,
        integrity: 'provider-verified'
      }
    })
    await expect(readFile(path.join(value.inboxRoot, `${value.artifactId}.artifact`))).resolves.toEqual(value.bytes)
    await expect(service.getReceipt(request.requestId)).resolves.toEqual(first)

    const replay = await service.acquire(request)
    expect(replay).toEqual(first)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(first)).not.toContain(value.root)
    expect(JSON.stringify(first)).not.toContain('https://')
  })

  it('feeds its measured receipt directly into offline staging without paths or copied digests', async () => {
    const value = await fixture()
    const service = acquisition(value, async () => zipResponse(value.bytes))
    const candidate = await service.registerNebulaRelease(nebulaRelease(value))
    const acquired = await service.acquire(requestFor(candidate))
    const stager = new OfflineArtifactStager({ inboxRoot: value.inboxRoot, stagingRoot: value.stagingRoot })

    const staged = await stager.stage({
      artifactId: acquired.artifact.artifactId,
      release: acquired.release,
      expected: { sizeBytes: acquired.artifact.sizeBytes, sha256: acquired.artifact.sha256 }
    })
    expect(staged.manifest).toMatchObject({
      artifactId: acquired.artifact.artifactId,
      sizeBytes: acquired.artifact.sizeBytes,
      sha256: acquired.artifact.sha256,
      integrity: 'provider-verified'
    })
  })

  it('supports a bounded trusted redirect but rejects a redirect outside the provider boundary', async () => {
    const value = await fixture()
    const goodFetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.hostname === 'github.com') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://release-assets.githubusercontent.com/fictional/signed.zip' }
        })
      }
      return zipResponse(value.bytes)
    })
    const service = acquisition(value, goodFetch)
    const candidate = await service.registerNebulaRelease(nebulaRelease(value))
    await expect(service.acquire(requestFor(candidate))).resolves.toMatchObject({ state: 'acquired' })
    expect(goodFetch).toHaveBeenCalledTimes(2)

    const other = await fixture()
    const blocked = acquisition(other, async () => new Response(null, {
      status: 302,
      headers: { location: 'https://attacker.example.com/archive.zip' }
    }))
    const blockedCandidate = await blocked.registerNebulaRelease(nebulaRelease(other))
    await expect(blocked.acquire(requestFor(blockedCandidate))).rejects.toThrow('ACQUISITION_URL_NOT_ALLOWED')
    await expect(readdir(other.inboxRoot)).resolves.toEqual([])
  })

  it('removes temporary bytes after digest, size, archive-signature, and stream-limit failures', async () => {
    for (const failure of ['digest', 'size', 'signature', 'limit'] as const) {
      const value = await fixture()
      const bytes = failure === 'signature'
        ? Buffer.from('not a zip fixture')
        : failure === 'limit'
          ? Buffer.concat([zipBytes('too-large'), Buffer.alloc(2_048)])
          : value.bytes
      const release = nebulaRelease(value)
      if (failure === 'digest') release.artifact.sha256 = 'f'.repeat(64)
      if (failure === 'size') release.artifact.sizeBytes = value.bytes.length + 1
      if (failure === 'signature') {
        release.artifact.sizeBytes = bytes.length
        release.artifact.sha256 = sha256(bytes)
      }
      if (failure === 'limit') {
        release.artifact.sizeBytes = bytes.length
        release.artifact.sha256 = sha256(bytes)
      }
      const service = acquisition(value, async () => zipResponse(bytes), {
        maximumBytes: failure === 'limit' ? 1_024 : undefined
      })
      const candidate = await service.registerNebulaRelease(release)
      await expect(service.acquire(requestFor(candidate))).rejects.toThrow()
      const entries = await readdir(value.inboxRoot)
      expect(entries.filter((entry) => entry.endsWith('.artifact') || entry.startsWith('.acquire-'))).toEqual([])
    }
  })

  it('reuses an independently matching inbox artifact and refuses a conflicting one', async () => {
    const value = await fixture()
    await writeFile(path.join(value.inboxRoot, `${value.artifactId}.artifact`), value.bytes)
    const fetch = vi.fn(async () => zipResponse(value.bytes))
    const service = acquisition(value, fetch)
    const candidate = await service.registerNebulaRelease(nebulaRelease(value))
    await expect(service.acquire(requestFor(candidate))).resolves.toMatchObject({ reused: true })
    expect(fetch).not.toHaveBeenCalled()

    const conflict = await fixture()
    await writeFile(path.join(conflict.inboxRoot, `${conflict.artifactId}.artifact`), zipBytes('different'))
    const conflictService = acquisition(conflict, async () => zipResponse(conflict.bytes))
    const conflictCandidate = await conflictService.registerNebulaRelease(nebulaRelease(conflict))
    await expect(conflictService.acquire(requestFor(conflictCandidate))).rejects.toThrow('ACQUISITION_INBOX_CONFLICT')
  })

  it('enforces UUID idempotency and rejects paths, URLs, commands, unknown candidates, and expired candidates', async () => {
    const value = await fixture()
    let now = new Date('2026-08-30T08:00:00.000Z')
    const service = acquisition(value, async () => zipResponse(value.bytes), {
      now: () => now,
      candidateTtlMs: 60_000
    })
    const first = await service.registerNebulaRelease(nebulaRelease(value))
    const otherRelease = nebulaRelease(value)
    otherRelease.version = '0.9.23'
    otherRelease.artifact.artifactId = `artifact-${'b'.repeat(40)}`
    otherRelease.artifact.downloadUrl = 'https://github.com/NebulaModTeam/nebula/releases/download/v0.9.23/Nebula.zip'
    const second = await service.registerNebulaRelease(otherRelease)
    const request = requestFor(first)
    await service.acquire(request)
    await expect(service.acquire({ ...request, candidateId: second.candidateId }))
      .rejects.toThrow('ACQUISITION_IDEMPOTENCY_CONFLICT')
    await expect(service.acquire({ ...requestFor(first), url: 'https://attacker.example.com/a.zip' }))
      .rejects.toThrow()
    await expect(service.acquire({ ...requestFor(first), path: 'C:\\secret', command: 'powershell' }))
      .rejects.toThrow()
    await expect(service.preview(`candidate-${'f'.repeat(48)}`)).rejects.toThrow('ACQUISITION_CANDIDATE_NOT_FOUND')

    now = new Date('2026-08-30T08:01:00.001Z')
    await expect(service.preview(second.candidateId)).rejects.toThrow('ACQUISITION_CANDIDATE_EXPIRED')
  })

  it('registers only eligible strict Thunderstore identities and computes local integrity', async () => {
    const value = await fixture()
    const service = acquisition(value, async () => zipResponse(value.bytes))
    const release = modRelease(value)
    release.dependencies = ['Fictional-Core-1.0.0', 'Fictional-Zeta-2.0.0']
    const candidate = await service.registerModRelease(release)
    const receipt = await service.acquire(requestFor(candidate))
    expect(receipt).toMatchObject({
      provider: 'thunderstore',
      release: {
        kind: 'plugin',
        sourceId: 'thunderstore:Fictional/ServerHelper',
        version: '1.2.3',
        dependencies: release.dependencies,
        dependencyFingerprint: thunderstoreDependencyFingerprint(release.dependencies)
      },
      artifact: { integrity: 'locally-computed', sha256: value.sha256 }
    })

    const changedGraph = modRelease(value)
    changedGraph.dependencies = ['Fictional-OtherCore-1.0.0']
    const changedCandidate = await service.registerModRelease(changedGraph)
    expect(changedCandidate.candidateId).not.toBe(candidate.candidateId)

    const ineligible = modRelease(value)
    ineligible.eligible = false
    ineligible.deprecated = true
    ineligible.blockers = ['package-deprecated', 'artifact-integrity-pending']
    await expect(service.registerModRelease(ineligible)).rejects.toThrow('ACQUISITION_CANDIDATE_INELIGIBLE')
  })

  it('never registers Thunderstore platform packages as ordinary plugin candidates', async () => {
    const value = await fixture()
    const service = acquisition(value, async () => zipResponse(value.bytes))

    await expect(service.registerModRelease(thunderstoreRelease(
      value, 'nebula', 'NebulaMultiplayerModApi', '2.1.0'
    ))).rejects.toThrow('ACQUISITION_MANAGED_COMPONENT_ROUTE_REQUIRED')
    await expect(service.registerModRelease(thunderstoreRelease(
      value, 'xiaoye97', 'BepInEx', '5.4.17'
    ))).rejects.toThrow('ACQUISITION_EXTERNAL_PREREQUISITE_VERIFICATION_REQUIRED')
    await expect(service.registerModRelease(thunderstoreRelease(
      value, 'FictionalFork', 'NebulaMultiplayerMod', '0.9.22'
    ))).rejects.toThrow('ACQUISITION_PLATFORM_PACKAGE_POLICY_REQUIRED')

    await expect(readdir(value.stateRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('registers and acquires only a strict official BepInEx discovery candidate', async () => {
    const value = await fixture()
    const service = acquisition(value, async () => zipResponse(value.bytes))
    const release = bepInExRelease(value)
    const candidate = await service.registerBepInExRelease(release)
    expect(candidate).toMatchObject({
      provider: 'github',
      release: {
        kind: 'bepinex',
        sourceId: 'github:BepInEx/BepInEx',
        version: '5.4.23.2'
      },
      artifact: { fileName: 'BepInEx_win_x64_5.4.23.2.zip' }
    })
    await expect(service.acquire(requestFor(candidate))).resolves.toMatchObject({
      release: { kind: 'bepinex', sourceId: 'github:BepInEx/BepInEx', version: '5.4.23.2' },
      artifact: { integrity: 'provider-verified', sha256: value.sha256 }
    })

    await expect(service.registerBepInExRelease({
      ...release,
      downloadUrl: 'https://attacker.example.com/package.zip'
    })).rejects.toThrow()
    await expect(service.registerBepInExRelease({
      ...release,
      sourceId: 'github:Fictional/Fork'
    })).rejects.toThrow()
  })

  it('fails closed on a corrupt durable receipt instead of redownloading or inventing success', async () => {
    const value = await fixture()
    const fetch = vi.fn(async () => zipResponse(value.bytes))
    const service = acquisition(value, fetch)
    const candidate = await service.registerNebulaRelease(nebulaRelease(value))
    const request = requestFor(candidate)
    const receiptRoot = path.join(value.stateRoot, 'receipts')
    await mkdir(receiptRoot, { recursive: true })
    await writeFile(path.join(receiptRoot, `${request.requestId}.json`), '{"state":"acquired"}\n')

    await expect(service.acquire(request)).rejects.toThrow('ACQUISITION_RECEIPT_INVALID')
    expect(fetch).not.toHaveBeenCalled()
  })
})

interface Fixture {
  root: string
  inboxRoot: string
  stateRoot: string
  stagingRoot: string
  artifactId: string
  bytes: Buffer
  sha256: string
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'dyson-acquisition-'))
  temporaryRoots.push(root)
  const inboxRoot = path.join(root, 'inbox')
  const stateRoot = path.join(root, 'state')
  const stagingRoot = path.join(root, 'staging')
  await mkdir(inboxRoot)
  const bytes = zipBytes(`fictional-${root}`)
  return {
    root,
    inboxRoot,
    stateRoot,
    stagingRoot,
    artifactId: `artifact-${sha256(Buffer.from(root)).slice(0, 40)}`,
    bytes,
    sha256: sha256(bytes)
  }
}

function acquisition(
  value: Fixture,
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  overrides: Partial<{
    maximumBytes: number
    now: () => Date
    candidateTtlMs: number
    authorizeCandidate: ManagedArtifactAcquisitionOptions['authorizeCandidate']
  }> = {}
): ManagedArtifactAcquisitionService {
  return new ManagedArtifactAcquisitionService({
    inboxRoot: value.inboxRoot,
    stateRoot: value.stateRoot,
    fetch,
    maximumBytes: overrides.maximumBytes,
    now: overrides.now ?? (() => new Date('2026-08-30T08:00:00.000Z')),
    candidateTtlMs: overrides.candidateTtlMs,
    authorizeCandidate: overrides.authorizeCandidate
  })
}

function nebulaRelease(value: Fixture): DiscoveredNebulaRelease {
  return {
    provider: 'github',
    sourceId: 'github:NebulaModTeam/nebula',
    releaseId: 123,
    version: '0.9.22',
    publishedAt: '2026-08-30T01:00:00.000Z',
    prerelease: false,
    artifact: {
      artifactId: value.artifactId,
      downloadUrl: 'https://github.com/NebulaModTeam/nebula/releases/download/v0.9.22/Nebula.zip',
      fileName: 'Nebula.zip',
      sizeBytes: value.bytes.length,
      sha256: value.sha256,
      integrity: 'provider-sha256'
    }
  }
}

function modRelease(value: Fixture): DiscoveredModRelease {
  return {
    provider: 'thunderstore',
    sourceId: 'thunderstore:Fictional/ServerHelper',
    dependencyId: 'Fictional-ServerHelper-1.2.3',
    namespace: 'Fictional',
    name: 'ServerHelper',
    version: '1.2.3',
    dependencies: [],
    publishedAt: '2026-08-30T01:00:00.000Z',
    deprecated: false,
    eligible: true,
    blockers: ['artifact-integrity-pending'],
    artifact: {
      artifactId: value.artifactId,
      downloadUrl: 'https://thunderstore.io/package/download/Fictional/ServerHelper/1.2.3/',
      fileName: 'Fictional-ServerHelper-1.2.3.zip',
      sizeBytes: null,
      sha256: null,
      integrity: 'locally-computed-required'
    }
  }
}

function thunderstoreRelease(
  value: Fixture,
  namespace: string,
  name: string,
  version: string
): DiscoveredModRelease {
  return {
    ...modRelease(value),
    sourceId: `thunderstore:${namespace}/${name}`,
    dependencyId: `${namespace}-${name}-${version}`,
    namespace,
    name,
    version,
    artifact: {
      ...modRelease(value).artifact,
      downloadUrl: `https://thunderstore.io/package/download/${namespace}/${name}/${version}/`,
      fileName: `${namespace}-${name}-${version}.zip`
    }
  }
}

function bepInExRelease(value: Fixture): DiscoveredBepInExRelease {
  return {
    provider: 'github',
    sourceId: 'github:BepInEx/BepInEx',
    releaseId: 456,
    version: '5.4.23.2',
    publishedAt: '2026-08-30T01:00:00.000Z',
    layoutPolicy: bepInExWindowsX64LayoutPolicyIds.v5_4_23_2_through_5,
    artifact: {
      artifactId: value.artifactId,
      downloadUrl: 'https://github.com/BepInEx/BepInEx/releases/download/v5.4.23.2/BepInEx_win_x64_5.4.23.2.zip',
      fileName: 'BepInEx_win_x64_5.4.23.2.zip',
      sizeBytes: value.bytes.length,
      sha256: value.sha256,
      integrity: 'provider-sha256'
    }
  }
}

function requestFor(candidate: ArtifactCandidateDescriptor) {
  return {
    requestId: randomUUID(),
    candidateId: candidate.candidateId,
    confirmation: 'ACQUIRE_UPDATE_ARTIFACT' as const
  }
}

function zipBytes(label: string): Buffer {
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(label, 'utf8')])
}

function zipResponse(bytes: Buffer): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-length': String(bytes.length)
    }
  })
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

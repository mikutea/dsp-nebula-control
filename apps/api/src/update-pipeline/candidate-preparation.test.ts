import { createHash, randomUUID } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BepInExGithubReleaseClient,
  ComponentCandidatePreparationService,
  ComponentUpdateActivationService,
  ManagedArtifactAcquisitionService,
  NebulaGithubReleaseClient,
  bepInExWindowsX64LayoutPolicyIds,
  initialComponentUpdateRevision,
  resolveBepInExWindowsX64LayoutPolicy,
  resolveNebulaWindowsLayoutPolicy,
  type ArtifactCandidateDescriptor,
  type ComponentCandidatePreparationReceipt,
  type DiscoveredBepInExRelease,
  type DiscoveredNebulaRelease
} from './index.js'

const temporaryRoots: string[] = []
const fixedNow = () => new Date('2026-08-30T12:00:00.000Z')

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

describe('component candidate preparation transaction', () => {
  it('discovers, registers, acquires, normalizes, stages, and activates-preview an official Nebula candidate', async () => {
    const fixture = await createFixture()
    const archive = nebulaArchive()
    const release = await discoverNebula(archive)
    const acquisition = acquisitionService(fixture, archive)
    const candidate = await acquisition.registerNebulaRelease(release)
    const acquired = await acquisition.acquire(acquisitionRequest(candidate))
    const preparation = preparationService(fixture, acquisition)

    const plan = await preparation.preview({
      component: 'nebula',
      acquisitionReceiptId: acquired.requestId
    })
    expect(plan).toMatchObject({
      available: true,
      dryRun: true,
      component: 'nebula',
      source: {
        sourceId: 'github:NebulaModTeam/nebula',
        version: '0.9.22',
        artifactId: acquired.artifact.artifactId
      },
      prepared: {
        mode: 'normalized-nebula-windows',
        layoutPolicy: 'nebula-official-windows-v0.9.22'
      },
      activation: { automatic: false }
    })
    expect(JSON.stringify(plan)).not.toContain(fixture.root)
    expect(JSON.stringify(plan)).not.toContain('https://')

    const request = preparationRequest('nebula', acquired.requestId)
    const prepared = await preparation.execute(request)
    expect(prepared.format).toBe('dyson-control-component-preparation-receipt')
    if (prepared.format !== 'dyson-control-component-preparation-receipt') throw new Error('unexpected unavailable')
    expect(prepared).toMatchObject({
      state: 'staged',
      reused: false,
      component: 'nebula',
      prepared: {
        mode: 'normalized-nebula-windows',
        integrity: 'normalized-locally-computed'
      },
      staging: {
        created: true,
        manifest: { integrity: 'locally-computed' }
      }
    })
    expect(prepared.prepared.artifactId).not.toBe(acquired.artifact.artifactId)
    await expect(readFile(path.join(
      fixture.acquisitionInboxRoot,
      `${prepared.prepared.artifactId}.artifact`
    ))).resolves.toHaveLength(prepared.prepared.sizeBytes)
    await expect(preparation.getReceipt(request.requestId)).resolves.toEqual(prepared)

    const activation = activationService(fixture)
    const activationPlan = await activation.preview(activationRequest(prepared))
    expect(activationPlan).toMatchObject({
      dryRun: true,
      component: 'nebula',
      artifactId: prepared.prepared.artifactId,
      targetVersion: '0.9.22'
    })
    expect(activationPlan.fileCount).toBeGreaterThan(10)
  })

  it('discovers and stages the verified official BepInEx Windows x64 ZIP directly', async () => {
    const fixture = await createFixture()
    const archive = bepInExArchive('5.4.23.2')
    const release = await discoverBepInEx(archive, '5.4.23.2')
    const acquisition = acquisitionService(fixture, archive)
    const candidate = await acquisition.registerBepInExRelease(release)
    const acquired = await acquisition.acquire(acquisitionRequest(candidate))
    const preparation = preparationService(fixture, acquisition)

    const plan = await preparation.preview({
      component: 'bepinex',
      acquisitionReceiptId: acquired.requestId
    })
    expect(plan).toMatchObject({
      available: true,
      component: 'bepinex',
      prepared: {
        mode: 'official-bepinex-windows-x64-direct',
        artifactId: acquired.artifact.artifactId,
        layoutPolicy: bepInExWindowsX64LayoutPolicyIds.v5_4_23_2_through_5
      }
    })

    const result = await preparation.execute(preparationRequest('bepinex', acquired.requestId))
    expect(result.format).toBe('dyson-control-component-preparation-receipt')
    if (result.format !== 'dyson-control-component-preparation-receipt') throw new Error('unexpected unavailable')
    expect(result.prepared).toMatchObject({
      mode: 'official-bepinex-windows-x64-direct',
      artifactId: acquired.artifact.artifactId,
      sizeBytes: acquired.artifact.sizeBytes,
      sha256: acquired.artifact.sha256,
      integrity: 'provider-verified'
    })
    expect(result.staging.manifest.componentManifest).toMatchObject({
      component: 'bepinex',
      version: '5.4.23.2',
      layoutPolicy: bepInExWindowsX64LayoutPolicyIds.v5_4_23_2_through_5
    })
    expect((await readdir(fixture.acquisitionInboxRoot)).filter((entry) => entry.endsWith('.artifact')))
      .toEqual([`${acquired.artifact.artifactId}.artifact`])

    await expect(activationService(fixture).preview(activationRequest(result)))
      .resolves.toMatchObject({ component: 'bepinex', fileCount: 22 })
  })

  it.each(['layout', 'identity'] as const)(
    'cleans temporary output after a Nebula %s failure',
    async (failure) => {
      const fixture = await createFixture()
      const archive = failure === 'layout'
        ? nebulaArchive({ omitFirst: true })
        : nebulaArchive({ invalidMainIdentity: true })
      const release = await discoverNebula(archive)
      const acquisition = acquisitionService(fixture, archive)
      const candidate = await acquisition.registerNebulaRelease(release)
      const acquired = await acquisition.acquire(acquisitionRequest(candidate))
      const preparation = preparationService(fixture, acquisition)

      await expect(preparation.execute(preparationRequest('nebula', acquired.requestId)))
        .rejects.toMatchObject({
          code: failure === 'layout' ? 'UPDATE_NEBULA_LAYOUT_INVALID' : 'UPDATE_NEBULA_IDENTITY_INVALID'
        })
      const inboxEntries = await readdir(fixture.acquisitionInboxRoot)
      expect(inboxEntries).toEqual([`${acquired.artifact.artifactId}.artifact`])
      expect(inboxEntries.some((entry) => entry.startsWith('.prepare-'))).toBe(false)
      expect(await exists(path.join(fixture.preparationStateRoot, 'receipts'))
        ? await readdir(path.join(fixture.preparationStateRoot, 'receipts'))
        : []).toEqual([])
      expect(await exists(path.join(fixture.stagingRoot, 'releases'))
        ? await readdir(path.join(fixture.stagingRoot, 'releases'))
        : []).toEqual([])
    }
  )

  it('rejects cross-component references and projects bridge/control as unavailable', async () => {
    const fixture = await createFixture()
    const archive = nebulaArchive()
    const acquisition = acquisitionService(fixture, archive)
    const candidate = await acquisition.registerNebulaRelease(await discoverNebula(archive))
    const acquired = await acquisition.acquire(acquisitionRequest(candidate))
    const preparation = preparationService(fixture, acquisition)

    await expect(preparation.preview({
      component: 'bepinex',
      acquisitionReceiptId: acquired.requestId
    })).rejects.toMatchObject({ code: 'CANDIDATE_PREPARATION_COMPONENT_MISMATCH' })

    await expect(preparation.preview({
      component: 'bridge',
      acquisitionReceiptId: randomUUID()
    })).resolves.toEqual(expect.objectContaining({
      available: false,
      component: 'bridge',
      reasonCode: 'CANDIDATE_PREPARATION_COMPONENT_UNAVAILABLE'
    }))
    await expect(preparation.execute({
      ...preparationRequest('control', randomUUID())
    })).resolves.toEqual(expect.objectContaining({
      available: false,
      component: 'control',
      reasonCode: 'CANDIDATE_PREPARATION_COMPONENT_UNAVAILABLE'
    }))
  })

  it('fails closed when a durable acquisition receipt is tampered', async () => {
    const fixture = await createFixture()
    const archive = nebulaArchive()
    const acquisition = acquisitionService(fixture, archive)
    const candidate = await acquisition.registerNebulaRelease(await discoverNebula(archive))
    const acquired = await acquisition.acquire(acquisitionRequest(candidate))
    const receiptFile = path.join(fixture.acquisitionStateRoot, 'receipts', `${acquired.requestId}.json`)
    const receipt = JSON.parse(await readFile(receiptFile, 'utf8')) as Record<string, unknown>
    const artifact = receipt.artifact as Record<string, unknown>
    artifact.sha256 = 'f'.repeat(64)
    await writeFile(receiptFile, `${JSON.stringify(receipt)}\n`)

    const preparation = preparationService(fixture, acquisition)
    await expect(preparation.preview({
      component: 'nebula',
      acquisitionReceiptId: acquired.requestId
    })).rejects.toMatchObject({ code: 'CANDIDATE_PREPARATION_ACQUIRED_ARTIFACT_CHANGED' })
    expect(await exists(path.join(fixture.preparationStateRoot, 'receipts'))).toBe(false)
  })

  it('persists an idempotent receipt, rejects UUID replay conflicts, and honors artifact locks', async () => {
    const fixture = await createFixture()
    const archive = nebulaArchive()
    const acquisition = acquisitionService(fixture, archive)
    const candidate = await acquisition.registerNebulaRelease(await discoverNebula(archive))
    const firstAcquired = await acquisition.acquire(acquisitionRequest(candidate))
    const secondAcquired = await acquisition.acquire(acquisitionRequest(candidate))
    const preparation = preparationService(fixture, acquisition)
    const request = preparationRequest('nebula', firstAcquired.requestId)

    const first = await preparation.execute(request)
    expect(first.format).toBe('dyson-control-component-preparation-receipt')
    if (first.format !== 'dyson-control-component-preparation-receipt') throw new Error('unexpected unavailable')
    await expect(preparation.execute(request)).resolves.toMatchObject({
      requestId: request.requestId,
      reused: true
    })
    await expect(preparation.getReceipt(request.requestId)).resolves.toMatchObject({ reused: false })
    await expect(preparation.execute({
      ...request,
      acquisitionReceiptId: secondAcquired.requestId
    })).rejects.toMatchObject({ code: 'CANDIDATE_PREPARATION_IDEMPOTENCY_CONFLICT' })

    const otherFixture = await createFixture()
    const otherAcquisition = acquisitionService(otherFixture, archive)
    const otherCandidate = await otherAcquisition.registerNebulaRelease(await discoverNebula(archive))
    const otherAcquired = await otherAcquisition.acquire(acquisitionRequest(otherCandidate))
    const otherPreparation = preparationService(otherFixture, otherAcquisition)
    const preview = await otherPreparation.preview({
      component: 'nebula',
      acquisitionReceiptId: otherAcquired.requestId
    })
    if (!('prepared' in preview)) throw new Error('expected available plan')
    const locks = path.join(otherFixture.preparationStateRoot, 'locks')
    await mkdir(locks, { recursive: true })
    await writeFile(path.join(locks, `artifact-${preview.prepared.artifactId}.lock`), 'held\n')
    await expect(otherPreparation.execute(preparationRequest('nebula', otherAcquired.requestId)))
      .rejects.toMatchObject({ code: 'CANDIDATE_PREPARATION_ARTIFACT_LOCK_BUSY' })
  })
})

interface Fixture {
  root: string
  acquisitionInboxRoot: string
  acquisitionStateRoot: string
  preparationStateRoot: string
  stagingRoot: string
  projectRoot: string
  liveRoot: string
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'dyson-candidate-preparation-'))
  temporaryRoots.push(root)
  const fixture = {
    root,
    acquisitionInboxRoot: path.join(root, 'acquisition-inbox'),
    acquisitionStateRoot: path.join(root, 'acquisition-state'),
    preparationStateRoot: path.join(root, 'preparation-state'),
    stagingRoot: path.join(root, 'staging'),
    projectRoot: path.join(root, 'project'),
    liveRoot: path.join(root, 'live')
  }
  await Promise.all([
    mkdir(fixture.acquisitionInboxRoot),
    mkdir(fixture.stagingRoot),
    mkdir(fixture.projectRoot),
    mkdir(fixture.liveRoot)
  ])
  return fixture
}

function acquisitionService(
  fixture: Fixture,
  archive: Buffer
): ManagedArtifactAcquisitionService {
  return new ManagedArtifactAcquisitionService({
    inboxRoot: fixture.acquisitionInboxRoot,
    stateRoot: fixture.acquisitionStateRoot,
    fetch: async () => binaryResponse(archive),
    now: fixedNow,
    maximumBytes: 64 * 1_024 * 1_024
  })
}

function preparationService(
  fixture: Fixture,
  acquisition: ManagedArtifactAcquisitionService
): ComponentCandidatePreparationService {
  return new ComponentCandidatePreparationService({
    acquisition,
    acquisitionInboxRoot: fixture.acquisitionInboxRoot,
    stateRoot: fixture.preparationStateRoot,
    stagingRoot: fixture.stagingRoot,
    maximumArchiveBytes: 64 * 1_024 * 1_024,
    maximumFileBytes: 16 * 1_024 * 1_024,
    maximumExpandedBytes: 128 * 1_024 * 1_024,
    maximumFiles: 128,
    now: fixedNow
  })
}

function activationService(fixture: Fixture): ComponentUpdateActivationService {
  return new ComponentUpdateActivationService({
    projectRoot: fixture.projectRoot,
    stagingRoot: fixture.stagingRoot,
    liveComponentRoots: {
      nebula: fixture.liveRoot,
      bepinex: fixture.liveRoot,
      bridge: fixture.liveRoot,
      control: fixture.liveRoot
    },
    verifyStoppedState: async () => ({ processStopped: true, portClosed: true }),
    createSaveProtectionPoint: async (request) => ({
      requestId: request.requestId,
      status: 'succeeded',
      backupId: `backup-${request.requestId}`,
      pairProtected: true,
      durable: true
    }),
    smoke: async (request) => ({
      component: request.component,
      observedVersion: request.expectedVersion,
      versionMatches: true,
      bepInExLoaded: true,
      nebulaLoaded: true,
      processHealthy: true,
      portHealthy: true
    }),
    compatibilityVerifier: {
      assertCurrent: async (receiptId, candidateInput) => {
        const candidate = candidateInput as {
          component: 'nebula' | 'bepinex'
          artifactId: string
          sha256: string
          targetVersion: string
        }
        const runtimeInventory = {
          dsp: '0.10.33.26727',
          nebula: '0.9.0',
          bepInEx: '5.4.22',
          plugins: []
        }
        const candidateInventory = { ...runtimeInventory }
        if (candidate.component === 'nebula') candidateInventory.nebula = candidate.targetVersion
        else candidateInventory.bepInEx = candidate.targetVersion
        return {
          receipt: {
            format: 'dyson-control-trusted-compatibility-receipt',
            schemaVersion: 1,
            receiptId: String(receiptId),
            component: candidate.component,
            artifactId: candidate.artifactId,
            artifactSha256: candidate.sha256,
            targetVersion: candidate.targetVersion,
            inventoryRevision: 'a'.repeat(64),
            policyId: 'fictional-policy',
            policyRevision: 'b'.repeat(64),
            matchedEntryId: 'candidate',
            compatible: true,
            issuedAt: '2026-08-30T11:59:00.000Z',
            expiresAt: '2026-08-30T12:10:00.000Z',
            reused: false
          },
          decision: {
            compatible: true,
            matchedEntryId: 'candidate',
            inventory: candidateInventory,
            evaluations: [{ entryId: 'candidate', compatible: true, reasons: [] }]
          },
          runtimeInventory
        }
      }
    },
    now: fixedNow,
    maximumArchiveBytes: 64 * 1_024 * 1_024,
    maximumFileBytes: 16 * 1_024 * 1_024,
    maximumExpandedBytes: 128 * 1_024 * 1_024,
    maximumFiles: 128
  })
}

function acquisitionRequest(candidate: ArtifactCandidateDescriptor) {
  return {
    requestId: randomUUID(),
    candidateId: candidate.candidateId,
    confirmation: 'ACQUIRE_UPDATE_ARTIFACT' as const
  }
}

function preparationRequest(
  component: 'nebula' | 'bepinex' | 'bridge' | 'control',
  acquisitionReceiptId: string
) {
  return {
    requestId: randomUUID(),
    component,
    acquisitionReceiptId,
    confirmation: 'PREPARE_COMPONENT_CANDIDATE' as const
  }
}

function activationRequest(prepared: ComponentCandidatePreparationReceipt) {
  return {
    requestId: randomUUID(),
    component: prepared.component,
    artifactId: prepared.prepared.artifactId,
    sha256: prepared.prepared.sha256,
    targetVersion: prepared.source.version,
    expectedRevision: initialComponentUpdateRevision,
    compatibilityReceiptId: randomUUID()
  }
}

async function discoverNebula(archive: Buffer): Promise<DiscoveredNebulaRelease> {
  const digest = sha256(archive)
  const client = new NebulaGithubReleaseClient({
    fetch: async () => jsonResponse([{
      id: 101,
      tag_name: 'v0.9.22',
      draft: false,
      prerelease: false,
      published_at: '2026-08-30T03:00:00.000Z',
      assets: [{
        id: 102,
        name: 'Nebula.zip',
        size: archive.length,
        state: 'uploaded',
        digest: `sha256:${digest}`,
        browser_download_url: 'https://github.com/NebulaModTeam/nebula/releases/download/v0.9.22/Nebula.zip'
      }]
    }]),
    pageSize: 25,
    maxPages: 1
  })
  const result = await client.discover()
  return result.items[0]!
}

async function discoverBepInEx(
  archive: Buffer,
  version: '5.4.23.2'
): Promise<DiscoveredBepInExRelease> {
  const fileName = `BepInEx_win_x64_${version}.zip`
  const client = new BepInExGithubReleaseClient({
    fetch: async () => jsonResponse([{
      id: 201,
      tag_name: `v${version}`,
      draft: false,
      prerelease: false,
      published_at: '2026-08-30T03:00:00.000Z',
      assets: [{
        id: 202,
        name: fileName,
        size: archive.length,
        state: 'uploaded',
        digest: `sha256:${sha256(archive)}`,
        browser_download_url: `https://github.com/BepInEx/BepInEx/releases/download/v${version}/${fileName}`
      }]
    }]),
    pageSize: 25,
    maxPages: 1
  })
  const result = await client.discover()
  return result.items[0]!
}

function nebulaArchive(options: {
  omitFirst?: boolean
  invalidMainIdentity?: boolean
} = {}): Buffer {
  const policy = resolveNebulaWindowsLayoutPolicy('0.9.22')
  const mainManifest = {
    name: options.invalidMainIdentity ? 'FictionalFork' : 'NebulaMultiplayerMod',
    description: 'Fictional Nebula preparation fixture',
    version_number: '0.9.22',
    dependencies: ['xiaoye97-BepInEx-5.4.17', 'nebula-NebulaMultiplayerModApi-2.1.0'],
    website_url: 'https://github.com/NebulaModTeam/nebula'
  }
  const apiManifest = {
    name: 'NebulaMultiplayerModApi',
    description: 'Fictional Nebula API preparation fixture',
    version_number: '2.1.0',
    dependencies: ['xiaoye97-BepInEx-5.4.17'],
    website_url: 'https://github.com/NebulaModTeam/nebula'
  }
  let payloads = policy.sourceFiles.map((name) => ({
    name,
    bytes: name.endsWith('/manifest.json')
      ? Buffer.from(JSON.stringify(name.includes('MultiplayerModApi') ? apiManifest : mainManifest), 'utf8')
      : Buffer.from(`fixture:${name}`, 'utf8')
  }))
  if (options.omitFirst === true) payloads = payloads.slice(1)
  return buildStoredZip(payloads)
}

function bepInExArchive(version: '5.4.23.2'): Buffer {
  const policy = resolveBepInExWindowsX64LayoutPolicy(version)
  return buildStoredZip(policy.files.map((name) => ({
    name,
    bytes: Buffer.from(`${version}:${name}`, 'utf8')
  })))
}

function buildStoredZip(files: Array<{ name: string; bytes: Buffer }>): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const checksum = crc32(file.bytes)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(file.bytes.length, 18)
    local.writeUInt32LE(file.bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, file.bytes)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(file.bytes.length, 20)
    central.writeUInt32LE(file.bytes.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + file.bytes.length
  }
  const central = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, central, eocd])
}

function jsonResponse(value: unknown): Response {
  const body = JSON.stringify(value)
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body))
    }
  })
}

function binaryResponse(bytes: Buffer): Response {
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

async function exists(file: string): Promise<boolean> {
  return await readFile(file).then(() => true, async () =>
    await readdir(file).then(() => true, () => false))
}

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0
  return (crc ^ 0xffffffff) >>> 0
}

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  thunderstoreDependencyFingerprint,
  type ArtifactAcquisitionReceipt
} from '../update-pipeline/acquisition.js'
import type { DiscoveredModRelease } from '../update-pipeline/discovery.js'
import { buildVerifiedModManifests } from '../update-pipeline/pipeline.js'
import type {
  HostMutationOperationCoordinator,
  HostMutationOperationOutcome,
  HostMutationOperationRequest,
  HostMutationOperationScope
} from '../host-mutation/operation-coordinator.js'
import { computeStagedModPayloadDigest, ModDeploymentService } from './deployment.js'
import { createModPlatformLock } from './platform-lock.js'
import {
  ThunderstoreModImportError,
  ThunderstoreModImporter,
  type ThunderstoreModImportAcquisition
} from './thunderstore-import.js'
import { ThunderstoreModImportHttpController } from './thunderstore-import-http.js'

const temporaryRoots: string[] = []
const acquisitionReceiptId = 'a1dc143d-c529-4e56-9f16-4f498945c31a'
const artifactId = `artifact-${'a'.repeat(40)}`

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Thunderstore mod importer', () => {
  it('requires current authority for reviewed archives, including verified receipts and replay', async () => {
    const fixture = await createFixture()
    const receipt = await installAcquiredArchive(fixture, packageArchive())
    receipt.artifact.trustedPolicyRevision = 'a'.repeat(64)
    const unavailable = createImporter(fixture, acquisitionFixture(receipt))
    await expect(unavailable.preview({ acquisitionReceiptId })).rejects.toMatchObject({
      code: 'THUNDERSTORE_MOD_IMPORT_ACQUISITION_UNAVAILABLE'
    })
    let authorized = true
    const importer = createImporter(fixture, { ...acquisitionFixture(receipt),
      verifyReceiptAuthority: async () => { if (!authorized) throw new Error('revoked') }
    })
    const request = executeRequest()
    const imported = await importer.execute(request)
    expect(await importer.getVerifiedReceipt(request.requestId)).toEqual(imported)
    authorized = false
    for (const attempt of [
      () => importer.preview({ acquisitionReceiptId }),
      () => importer.execute(request),
      () => importer.getVerifiedReceipt(request.requestId)
    ]) await expect(attempt()).rejects.toMatchObject({ code: 'THUNDERSTORE_MOD_IMPORT_ACQUISITION_UNAVAILABLE' })
    expect(await importer.getReceipt(request.requestId)).toEqual(imported)
  })

  it('maps a discovery-bound dependency mismatch to a stable 422 HTTP error', async () => {
    const controller = new ThunderstoreModImportHttpController({
      service: {
        preview: vi.fn(async () => {
          throw new ThunderstoreModImportError('THUNDERSTORE_MOD_IMPORT_DEPENDENCY_GRAPH_MISMATCH')
        }),
        execute: vi.fn(),
        getReceipt: vi.fn()
      }
    })

    await expect(controller.preview({ acquisitionReceiptId })).resolves.toEqual({
      statusCode: 422,
      body: {
        ok: false,
        error: { code: 'THUNDERSTORE_MOD_IMPORT_DEPENDENCY_GRAPH_MISMATCH' }
      }
    })
  })

  it('normalizes exact dependencies and BepInEx plugin rules into a deterministic deployable payload', async () => {
    const fixture = await createFixture()
    const archive = packageArchive({
      dependencies: ['Fictional-Zeta-2.0.0', 'Fictional-Core-1.0.0'],
      runtime: {
        'random-folder/ServerHelper.dll': Buffer.from('server-helper-binary'),
        'BepInEx/plugins/Support/config.json': Buffer.from('{"enabled":true}')
      }
    })
    const receipt = await installAcquiredArchive(fixture, archive, [
      'Fictional-Core-1.0.0',
      'Fictional-Zeta-2.0.0'
    ])
    const acquisition = acquisitionFixture(receipt)
    const importer = createImporter(fixture, acquisition)

    const plan = await importer.preview({ acquisitionReceiptId })
    expect(plan).toMatchObject({
      dryRun: true,
      package: {
        dependencyId: 'Fictional-ServerHelper-1.0.0',
        dependencies: ['Fictional-Core-1.0.0', 'Fictional-Zeta-2.0.0']
      },
      payload: { fileCount: 2, sizeBytes: 36 }
    })
    expect(plan.payload.sha256).not.toBe(receipt.artifact.sha256)

    const request = {
      requestId: randomUUID(),
      acquisitionReceiptId,
      confirmation: 'IMPORT_THUNDERSTORE_MOD' as const
    }
    const imported = await importer.execute(request)
    expect(imported).toMatchObject({ state: 'staged', staging: { created: true }, reused: false })
    expect(imported.payload.sha256).toBe(computeStagedModPayloadDigest(imported.payload.manifest))
    expect(imported.payload.sha256).toBe(plan.payload.sha256)
    expect(imported.payload.manifest.files.map((file) => file.relativePath)).toEqual([
      'ServerHelper.dll',
      'Support/config.json'
    ])
    await expect(readFile(path.join(
      fixture.stagingRoot,
      imported.package.dependencyId,
      'payload',
      'ServerHelper.dll'
    ), 'utf8')).resolves.toBe('server-helper-binary')

    await expect(importer.execute(request)).resolves.toMatchObject({ reused: true, staging: { created: true } })
    await expect(importer.getReceipt(request.requestId)).resolves.toMatchObject({ reused: false })
    expect(acquisition.getReceipt).toHaveBeenCalled()
  })

  it('reuses an identical package staged by another request but detects staged payload tampering', async () => {
    const fixture = await createFixture()
    const receipt = await installAcquiredArchive(fixture, packageArchive())
    const importer = createImporter(fixture, acquisitionFixture(receipt))

    const first = await importer.execute(executeRequest())
    const second = await importer.execute(executeRequest())
    expect(first.staging.created).toBe(true)
    expect(second.staging.created).toBe(false)

    await writeFile(path.join(
      fixture.stagingRoot,
      first.package.dependencyId,
      'payload',
      'ServerHelper.dll'
    ), 'changed')
    await expect(importer.execute(executeRequest())).rejects.toMatchObject({
      code: 'THUNDERSTORE_MOD_IMPORT_STAGING_CONFLICT'
    })
  })

  it('fails closed in preview and execution when ZIP dependencies differ from the discovery-bound graph', async () => {
    const fixture = await createFixture()
    const archive = packageArchive({ dependencies: ['Fictional-Zeta-2.0.0'] })
    const receipt = await installAcquiredArchive(fixture, archive, ['Fictional-Core-1.0.0'])
    const importer = createImporter(fixture, acquisitionFixture(receipt))

    await expect(importer.preview({ acquisitionReceiptId })).rejects.toMatchObject({
      code: 'THUNDERSTORE_MOD_IMPORT_DEPENDENCY_GRAPH_MISMATCH'
    })
    await expect(importer.execute(executeRequest())).rejects.toMatchObject({
      code: 'THUNDERSTORE_MOD_IMPORT_DEPENDENCY_GRAPH_MISMATCH'
    })
    await expect(readdir(fixture.stagingRoot)).resolves.toEqual([])
  })

  it.each([
    ['config', { 'BepInEx/config/server.cfg': Buffer.from('unsupported') }, 'THUNDERSTORE_MOD_IMPORT_NON_PLUGIN_DESTINATION_UNSUPPORTED'],
    ['patcher', { 'patchers/Patcher.dll': Buffer.from('unsupported') }, 'THUNDERSTORE_MOD_IMPORT_NON_PLUGIN_DESTINATION_UNSUPPORTED'],
    ['monomod', { 'ServerHelper.mm.dll': Buffer.from('unsupported') }, 'THUNDERSTORE_MOD_IMPORT_NON_PLUGIN_DESTINATION_UNSUPPORTED'],
    ['asset', { 'plugins/runtime.bundle': Buffer.from('unsupported') }, 'THUNDERSTORE_MOD_IMPORT_RUNTIME_LAYOUT_UNSUPPORTED']
  ])('fails explicitly for the unsupported %s ownership domain', async (_name, runtime, code) => {
    const fixture = await createFixture()
    const receipt = await installAcquiredArchive(fixture, packageArchive({ runtime }))
    const importer = createImporter(fixture, acquisitionFixture(receipt))
    await expect(importer.preview({ acquisitionReceiptId })).rejects.toMatchObject({ code })
  })

  it('rejects package identity drift, duplicate exact dependencies, and flattened output collisions', async () => {
    const identityFixture = await createFixture()
    const identityReceipt = await installAcquiredArchive(identityFixture, packageArchive({ name: 'OtherPackage' }))
    await expect(createImporter(identityFixture, acquisitionFixture(identityReceipt)).preview({ acquisitionReceiptId }))
      .rejects.toMatchObject({ code: 'THUNDERSTORE_MOD_IMPORT_IDENTITY_MISMATCH' })

    const dependencyFixture = await createFixture()
    const dependencyReceipt = await installAcquiredArchive(dependencyFixture, packageArchive({
      dependencies: ['Fictional-Core-1.0.0', 'Fictional-Core-1.0.0']
    }))
    await expect(createImporter(dependencyFixture, acquisitionFixture(dependencyReceipt)).preview({ acquisitionReceiptId }))
      .rejects.toMatchObject({ code: 'THUNDERSTORE_MOD_IMPORT_DEPENDENCY_DUPLICATE' })

    const collisionFixture = await createFixture()
    const collisionReceipt = await installAcquiredArchive(collisionFixture, packageArchive({
      runtime: {
        'first/Shared.dll': Buffer.from('first'),
        'second/Shared.dll': Buffer.from('second')
      }
    }))
    await expect(createImporter(collisionFixture, acquisitionFixture(collisionReceipt)).preview({ acquisitionReceiptId }))
      .rejects.toMatchObject({ code: 'THUNDERSTORE_MOD_IMPORT_OUTPUT_CONFLICT' })
  })

  it('binds import to the persisted acquisition receipt and fixed inbox bytes', async () => {
    const fixture = await createFixture()
    const archive = packageArchive()
    const receipt = await installAcquiredArchive(fixture, archive)
    const importer = createImporter(fixture, acquisitionFixture(receipt))
    await writeFile(path.join(fixture.inboxRoot, `${artifactId}.artifact`), Buffer.concat([archive, Buffer.from('changed')]))

    await expect(importer.preview({ acquisitionReceiptId })).rejects.toMatchObject({
      code: 'THUNDERSTORE_MOD_IMPORT_ACQUIRED_ARTIFACT_CHANGED'
    })
  })

  it('strictly revalidates a durable receipt against acquisition, ZIP, and published staging evidence', async () => {
    const fixture = await createFixture()
    const receipt = await installAcquiredArchive(fixture, packageArchive())
    const acquisition = acquisitionFixture(receipt)
    const importer = createImporter(fixture, acquisition)
    const request = executeRequest()
    const imported = await importer.execute(request)
    const controller = new AbortController()

    await expect(importer.getVerifiedReceipt(request.requestId, controller.signal)).resolves.toEqual(imported)
    expect(acquisition.getReceipt).toHaveBeenLastCalledWith(acquisitionReceiptId)
  })

  it('rejects a durable receipt when published staging was deleted or its payload was tampered', async () => {
    const deletedFixture = await createFixture()
    const deletedReceipt = await installAcquiredArchive(deletedFixture, packageArchive())
    const deletedImporter = createImporter(deletedFixture, acquisitionFixture(deletedReceipt))
    const deletedRequest = executeRequest()
    const deletedImport = await deletedImporter.execute(deletedRequest)
    await rm(path.join(deletedFixture.stagingRoot, deletedImport.package.dependencyId), {
      recursive: true,
      force: true
    })
    await expect(deletedImporter.getVerifiedReceipt(deletedRequest.requestId)).rejects.toMatchObject({
      code: 'THUNDERSTORE_MOD_IMPORT_RECEIPT_VERIFICATION_FAILED'
    })

    const tamperedFixture = await createFixture()
    const tamperedReceipt = await installAcquiredArchive(tamperedFixture, packageArchive())
    const tamperedImporter = createImporter(tamperedFixture, acquisitionFixture(tamperedReceipt))
    const tamperedRequest = executeRequest()
    const tamperedImport = await tamperedImporter.execute(tamperedRequest)
    await writeFile(path.join(
      tamperedFixture.stagingRoot,
      tamperedImport.package.dependencyId,
      'payload',
      'ServerHelper.dll'
    ), 'tampered-after-import')
    await expect(tamperedImporter.getVerifiedReceipt(tamperedRequest.requestId)).rejects.toMatchObject({
      code: 'THUNDERSTORE_MOD_IMPORT_RECEIPT_VERIFICATION_FAILED'
    })
  })

  it('rejects a durable receipt when its acquisition dependency identity no longer matches the fixed ZIP', async () => {
    const fixture = await createFixture()
    const original = await installAcquiredArchive(fixture, packageArchive())
    let current = original
    const acquisition: ThunderstoreModImportAcquisition = {
      getReceipt: vi.fn(async () => current)
    }
    const importer = createImporter(fixture, acquisition)
    const request = executeRequest()
    await importer.execute(request)
    const changedDependencies = ['Fictional-OtherDependency-1.0.0']
    current = {
      ...original,
      release: {
        ...original.release,
        dependencies: changedDependencies,
        dependencyFingerprint: thunderstoreDependencyFingerprint(changedDependencies)
      }
    }

    await expect(importer.getVerifiedReceipt(request.requestId)).rejects.toMatchObject({
      code: 'THUNDERSTORE_MOD_IMPORT_RECEIPT_VERIFICATION_FAILED'
    })
  })

  it('carries acquired bytes through import, verified lock generation, and a real deployment transaction', async () => {
    const fixture = await createFixture()
    const archive = packageArchive()
    const acquisitionReceipt = await installAcquiredArchive(fixture, archive)
    const importer = createImporter(fixture, acquisitionFixture(acquisitionReceipt))
    const imported = await importer.execute(executeRequest())
    const release: DiscoveredModRelease = {
      provider: 'thunderstore',
      sourceId: imported.package.sourceId,
      dependencyId: imported.package.dependencyId,
      namespace: 'Fictional',
      name: 'ServerHelper',
      version: imported.package.version,
      dependencies: imported.package.dependencies,
      publishedAt: '2026-08-31T02:00:00.000Z',
      deprecated: false,
      eligible: true,
      blockers: ['artifact-integrity-pending'],
      artifact: {
        artifactId: imported.artifact.artifactId,
        downloadUrl: 'https://thunderstore.io/package/download/Fictional/ServerHelper/1.0.0/',
        fileName: acquisitionReceipt.artifact.fileName,
        sizeBytes: imported.artifact.sizeBytes,
        sha256: imported.artifact.sha256,
        integrity: 'locally-computed-required'
      }
    }
    const manifests = buildVerifiedModManifests({
      roots: [release.dependencyId],
      releases: [release],
      stagedArtifacts: [{
        format: 'dyson-control-staged-artifact',
        schemaVersion: 1,
        artifactId: release.artifact.artifactId,
        artifactFile: 'artifact.bin',
        release: { kind: 'plugin', sourceId: release.sourceId, version: release.version },
        sizeBytes: release.artifact.sizeBytes,
        sha256: release.artifact.sha256,
        integrity: 'locally-computed',
        stagedAt: '2026-08-31T03:00:00.000Z'
      }],
      stagedPackages: [imported.payload.manifest],
      policies: [{
        sourceId: release.sourceId,
        serverRequired: true,
        clientRequirement: 'required'
      }]
    })
    const locked = manifests.serverLock.mods[0]!
    expect(locked.sha256).toBe(imported.payload.sha256)
    expect(locked.sha256).not.toBe(acquisitionReceipt.artifact.sha256)
    expect(locked.dependencies).toEqual(imported.package.dependencies)

    const hostMutationCoordinator = new RecordingPassThroughHostMutationCoordinator()
    const deployment = new ModDeploymentService({
      stagingRoot: fixture.stagingRoot,
      pluginsRoot: fixture.pluginsRoot,
      hostMutationCoordinator,
      verifyStoppedState: async () => ({ processStopped: true, portClosed: true })
    })
    const initial = await deployment.inspect()
    const deploymentRequest = {
      requestId: randomUUID(),
      operation: 'install' as const,
      package: { dependencyId: release.dependencyId, version: release.version },
      manifest: {
        serverLock: manifests.serverLock,
        clientParity: manifests.clientParity,
        platformLock: createModPlatformLock({
          serverLockSha256: manifests.serverLockSha256,
          inventoryRevision: null,
          requirements: []
        })
      },
      expectedRevision: initial.revision
    }
    await expect(deployment.preview(deploymentRequest)).resolves.toMatchObject({
      dryRun: true,
      operation: 'install',
      payloadFileCount: 1,
      payloadSizeBytes: Buffer.byteLength('server-helper-binary')
    })
    await expect(deployment.execute(deploymentRequest)).resolves.toMatchObject({
      status: 'succeeded',
      rollback: 'not-needed',
      payloadFileCount: 1
    })
    expect(hostMutationCoordinator.requests).toEqual([{
      operation: 'mod-deployment-install',
      requestId: deploymentRequest.requestId
    }])
    expect(hostMutationCoordinator.outcomes).toEqual([{
      kind: 'return',
      disposition: 'release'
    }])
    await expect(deployment.inspect()).resolves.toMatchObject({
      enabledCount: 1,
      packages: [{ dependencyId: release.dependencyId, enabled: true }]
    })
    const deployedDirectories = (await readdir(fixture.pluginsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('mod-'))
    expect(deployedDirectories).toHaveLength(1)
    await expect(readFile(path.join(
      fixture.pluginsRoot,
      deployedDirectories[0]!.name,
      'ServerHelper.dll'
    ), 'utf8')).resolves.toBe('server-helper-binary')
  })
})

interface Fixture {
  root: string
  inboxRoot: string
  stagingRoot: string
  stateRoot: string
  pluginsRoot: string
}

async function createFixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'dyson-thunderstore-import-')))
  temporaryRoots.push(root)
  const inboxRoot = path.join(root, 'inbox')
  const stagingRoot = path.join(root, 'staging')
  const stateRoot = path.join(root, 'state')
  const pluginsRoot = path.join(root, 'plugins')
  await Promise.all([mkdir(inboxRoot), mkdir(stagingRoot), mkdir(stateRoot), mkdir(pluginsRoot)])
  return { root, inboxRoot, stagingRoot, stateRoot, pluginsRoot }
}

function createImporter(fixture: Fixture, acquisition: ThunderstoreModImportAcquisition): ThunderstoreModImporter {
  return new ThunderstoreModImporter({
    acquisition,
    acquisitionInboxRoot: fixture.inboxRoot,
    stagingRoot: fixture.stagingRoot,
    stateRoot: fixture.stateRoot,
    now: () => new Date('2026-08-31T04:00:00.000Z')
  })
}

function acquisitionFixture(receipt: ArtifactAcquisitionReceipt) {
  return {
    getReceipt: vi.fn(async (requestId: unknown) => requestId === acquisitionReceiptId ? receipt : null)
  } satisfies ThunderstoreModImportAcquisition
}

async function installAcquiredArchive(
  fixture: Fixture,
  archive: Buffer,
  expectedDependencies: string[] = []
): Promise<ArtifactAcquisitionReceipt> {
  await writeFile(path.join(fixture.inboxRoot, `${artifactId}.artifact`), archive)
  return {
    format: 'dyson-control-artifact-acquisition-receipt',
    schemaVersion: 1,
    requestId: acquisitionReceiptId,
    candidateId: `candidate-${'b'.repeat(48)}`,
    provider: 'thunderstore',
    release: {
      kind: 'plugin',
      sourceId: 'thunderstore:Fictional/ServerHelper',
      version: '1.0.0',
      dependencies: expectedDependencies,
      dependencyFingerprint: thunderstoreDependencyFingerprint(expectedDependencies)
    },
    artifact: {
      artifactId,
      fileName: 'Fictional-ServerHelper-1.0.0.zip',
      sizeBytes: archive.length,
      sha256: createHash('sha256').update(archive).digest('hex'),
      integrity: 'locally-computed'
    },
    state: 'acquired',
    reused: false,
    acquiredAt: '2026-08-31T03:00:00.000Z'
  }
}

function executeRequest() {
  return {
    requestId: randomUUID(),
    acquisitionReceiptId,
    confirmation: 'IMPORT_THUNDERSTORE_MOD' as const
  }
}

class RecordingPassThroughHostMutationCoordinator implements HostMutationOperationCoordinator {
  readonly requests: HostMutationOperationRequest[] = []
  readonly outcomes: Array<Pick<HostMutationOperationOutcome<unknown>, 'kind' | 'disposition'>> = []

  async runExclusive<T>(
    request: HostMutationOperationRequest,
    operation: (scope: HostMutationOperationScope) =>
      Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>
  ): Promise<T> {
    this.requests.push({ ...request })
    const outcome = await operation({
      signal: new AbortController().signal,
      assertActive: () => {},
      toPowerShellBorrowArguments: () => []
    })
    this.outcomes.push({ kind: outcome.kind, disposition: outcome.disposition })
    if (outcome.kind === 'throw') throw outcome.error
    return outcome.value
  }
}

function packageArchive(options: {
  name?: string
  version?: string
  dependencies?: string[]
  runtime?: Record<string, Buffer>
} = {}): Buffer {
  const manifest = Buffer.from(JSON.stringify({
    name: options.name ?? 'ServerHelper',
    description: 'Fictional server helper fixture',
    version_number: options.version ?? '1.0.0',
    dependencies: options.dependencies ?? [],
    website_url: ''
  }), 'utf8')
  return buildStoredZip([
    { name: 'manifest.json', bytes: manifest },
    { name: 'README.md', bytes: Buffer.from('# Fixture') },
    { name: 'icon.png', bytes: Buffer.from('fixture-icon') },
    ...Object.entries(options.runtime ?? {
      'plugins/ServerHelper.dll': Buffer.from('server-helper-binary')
    }).map(([name, bytes]) => ({ name, bytes }))
  ])
}

function buildStoredZip(entries: Array<{ name: string; bytes: Buffer }>): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const checksum = crc32(entry.bytes)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(entry.bytes.length, 18)
    local.writeUInt32LE(entry.bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, entry.bytes)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(entry.bytes.length, 20)
    central.writeUInt32LE(entry.bytes.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + entry.bytes.length
  }
  const central = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, central, eocd])
}

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0
  return (crc ^ 0xffffffff) >>> 0
}

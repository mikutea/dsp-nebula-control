import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { computeStagedModPayloadDigest } from './deployment.js'
import type { StagedModPackageManifest } from './deployment-types.js'
import {
  ThunderstoreModImportError,
  type ThunderstoreModImportReceipt
} from './thunderstore-import.js'
import { VerifiedModLockError, VerifiedModLockService } from './verified-lock.js'

const dependencyReceiptId = '11111111-1111-4111-8111-111111111111'
const rootReceiptId = '22222222-2222-4222-8222-222222222222'

describe('VerifiedModLockService', () => {
  it('derives dependencies-first manifests exclusively from persisted import receipts', async () => {
    const dependency = receiptFixture({
      requestId: dependencyReceiptId,
      namespace: 'Fictional',
      name: 'Library',
      version: '1.0.0',
      dependencies: [],
      archiveSha256: 'a'.repeat(64),
      payloadBytes: 'library-payload'
    })
    const root = receiptFixture({
      requestId: rootReceiptId,
      namespace: 'Fictional',
      name: 'ServerHelper',
      version: '2.0.0',
      dependencies: [dependency.package.dependencyId],
      archiveSha256: 'b'.repeat(64),
      payloadBytes: 'root-payload'
    })
    const getVerifiedReceipt = vi.fn(async (id: unknown) =>
      id === dependencyReceiptId ? dependency : id === rootReceiptId ? root : null)
    const service = new VerifiedModLockService({ receipts: { getVerifiedReceipt } })

    const controller = new AbortController()
    const preview = await service.preview({
      roots: [root.package.dependencyId],
      importReceiptIds: [rootReceiptId, dependencyReceiptId],
      policies: [dependency, root].map((receipt) => ({
        sourceId: receipt.package.sourceId,
        serverRequired: true,
        clientRequirement: 'required' as const
      }))
    }, controller.signal)

    expect(preview.mode).toBe('dry-run')
    expect(preview.serverLock.mods.map((entry) => entry.dependencyId)).toEqual([
      dependency.package.dependencyId,
      root.package.dependencyId
    ])
    expect(preview.serverLock.mods[0]?.sha256).toBe(dependency.payload.sha256)
    expect(preview.serverLock.mods[0]?.sha256).not.toBe(dependency.artifact.sha256)
    expect(preview.clientParity.serverLockSha256).toBe(preview.serverLockSha256)
    expect(preview.platformLock).toMatchObject({
      format: 'dyson-control-mod-platform-lock',
      schemaVersion: 1,
      serverLockSha256: preview.serverLockSha256,
      inventoryRevision: null,
      requirements: []
    })
    expect(preview.platformLock.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(getVerifiedReceipt).toHaveBeenCalledTimes(2)
    expect(getVerifiedReceipt).toHaveBeenCalledWith(rootReceiptId, controller.signal)
    expect(getVerifiedReceipt).toHaveBeenCalledWith(dependencyReceiptId, controller.signal)
  })

  it('rejects a supplied import receipt that is not reachable from the requested roots', async () => {
    const root = receiptFixture({
      requestId: rootReceiptId,
      namespace: 'Fictional',
      name: 'ServerHelper',
      version: '2.0.0',
      dependencies: [],
      archiveSha256: 'b'.repeat(64),
      payloadBytes: 'root-payload'
    })
    const unreachable = receiptFixture({
      requestId: dependencyReceiptId,
      namespace: 'Fictional',
      name: 'UnreachableHelper',
      version: '1.0.0',
      dependencies: [],
      archiveSha256: 'a'.repeat(64),
      payloadBytes: 'unreachable-payload'
    })
    const service = new VerifiedModLockService({
      receipts: {
        getVerifiedReceipt: async (id) => id === rootReceiptId ? root : unreachable
      }
    })

    await expect(service.preview({
      roots: [root.package.dependencyId],
      importReceiptIds: [rootReceiptId, dependencyReceiptId],
      policies: [root, unreachable].map((receipt) => ({
        sourceId: receipt.package.sourceId,
        serverRequired: true,
        clientRequirement: 'required' as const
      }))
    })).rejects.toMatchObject({ code: 'VERIFIED_MOD_IMPORT_RECEIPT_UNUSED' })
  })

  it('rejects browser-supplied release or staged-manifest evidence', async () => {
    const service = new VerifiedModLockService({ receipts: { getVerifiedReceipt: async () => null } })
    await expect(service.preview({
      roots: ['Fictional-ServerHelper-2.0.0'],
      importReceiptIds: [rootReceiptId],
      policies: [{
        sourceId: 'thunderstore:Fictional/ServerHelper',
        serverRequired: true,
        clientRequirement: 'required'
      }],
      releases: [],
      stagedArtifacts: []
    })).rejects.toMatchObject({ name: 'ZodError' })
  })

  it('filters platform edges only after exact managed inventory verification', async () => {
    const platformDependencies = [
      'nebula-NebulaMultiplayerModApi-0.9.22',
      'xiaoye97-BepInEx-5.4.17'
    ].sort()
    const root = receiptFixture({
      requestId: rootReceiptId,
      namespace: 'Fictional',
      name: 'ServerHelper',
      version: '2.0.0',
      dependencies: platformDependencies,
      archiveSha256: 'b'.repeat(64),
      payloadBytes: 'root-payload'
    })
    const service = new VerifiedModLockService({
      receipts: { getVerifiedReceipt: async () => root },
      readPlatformInventory: async () => ({
        inventoryRevision: 'c'.repeat(64),
        inventory: { nebula: '0.9.22', bepInEx: '5.4.17' }
      })
    })
    const preview = await service.preview({
      roots: [root.package.dependencyId],
      importReceiptIds: [rootReceiptId],
      policies: [{ sourceId: root.package.sourceId, serverRequired: true, clientRequirement: 'required' }]
    })

    expect(preview.serverLock.mods[0]?.dependencies).toEqual([])
    expect(preview.platformRequirements).toEqual([
      expect.objectContaining({ deploymentOwner: 'nebula', requiredVersion: '0.9.22', actualVersion: '0.9.22', satisfied: true }),
      expect.objectContaining({ deploymentOwner: 'bepinex', requiredVersion: '5.4.17', actualVersion: '5.4.17', satisfied: true })
    ])
    expect(preview.platformLock).toMatchObject({
      serverLockSha256: preview.serverLockSha256,
      inventoryRevision: 'c'.repeat(64),
      requirements: [
        expect.objectContaining({ deploymentOwner: 'bepinex', requiredVersion: '5.4.17' }),
        expect.objectContaining({ deploymentOwner: 'nebula', requiredVersion: '0.9.22' })
      ]
    })
  })

  it('fails closed for missing, mismatched, or unsupported platform ownership', async () => {
    const platformRoot = receiptFixture({
      requestId: rootReceiptId,
      namespace: 'Fictional', name: 'ServerHelper', version: '2.0.0',
      dependencies: ['xiaoye97-BepInEx-5.4.17'],
      archiveSha256: 'b'.repeat(64), payloadBytes: 'root-payload'
    })
    const request = {
      roots: [platformRoot.package.dependencyId], importReceiptIds: [rootReceiptId],
      policies: [{ sourceId: platformRoot.package.sourceId, serverRequired: true, clientRequirement: 'required' as const }]
    }
    await expect(new VerifiedModLockService({ receipts: { getVerifiedReceipt: async () => platformRoot } }).preview(request))
      .rejects.toMatchObject({ code: 'VERIFIED_MOD_PLATFORM_INVENTORY_UNAVAILABLE' })
    await expect(new VerifiedModLockService({
      receipts: { getVerifiedReceipt: async () => platformRoot },
      readPlatformInventory: async () => ({
        inventoryRevision: 'c'.repeat(64),
        inventory: { nebula: '0.9.22', bepInEx: '5.4.23' }
      })
    }).preview(request)).rejects.toMatchObject({ code: 'VERIFIED_MOD_PLATFORM_VERSION_MISMATCH' })

    const unsupported = receiptFixture({
      requestId: rootReceiptId,
      namespace: 'Fictional', name: 'ServerHelper', version: '2.0.0',
      dependencies: ['Fictional-BepInEx-5.4.17'],
      archiveSha256: 'b'.repeat(64), payloadBytes: 'root-payload'
    })
    await expect(new VerifiedModLockService({ receipts: { getVerifiedReceipt: async () => unsupported } }).preview(request))
      .rejects.toMatchObject({ code: 'VERIFIED_MOD_PLATFORM_REQUIREMENT_UNSUPPORTED' })
  })

  it('fails closed when a durable import receipt is missing or bound to a different id', async () => {
    const missing = new VerifiedModLockService({ receipts: { getVerifiedReceipt: async () => null } })
    await expect(missing.preview(validSingleRequest())).rejects.toMatchObject({
      code: 'VERIFIED_MOD_IMPORT_RECEIPT_NOT_FOUND'
    })

    const mismatched = receiptFixture({
      requestId: dependencyReceiptId,
      namespace: 'Fictional',
      name: 'ServerHelper',
      version: '2.0.0',
      dependencies: [],
      archiveSha256: 'a'.repeat(64),
      payloadBytes: 'payload'
    })
    const service = new VerifiedModLockService({ receipts: { getVerifiedReceipt: async () => mismatched } })
    await expect(service.preview(validSingleRequest())).rejects.toMatchObject({
      code: 'VERIFIED_MOD_IMPORT_RECEIPT_IDENTITY_MISMATCH'
    })
  })

  it.each([
    ['THUNDERSTORE_MOD_IMPORT_RECEIPT_VERIFICATION_FAILED', 'VERIFIED_MOD_IMPORT_RECEIPT_INVALID'],
    ['THUNDERSTORE_MOD_IMPORT_ACQUISITION_UNAVAILABLE', 'VERIFIED_MOD_IMPORT_RECEIPT_UNAVAILABLE'],
    ['THUNDERSTORE_MOD_IMPORT_ABORTED', 'VERIFIED_MOD_LOCK_ABORTED']
  ])('maps strict receipt failure %s to stable lock error %s', async (sourceCode, expectedCode) => {
    const service = new VerifiedModLockService({
      receipts: {
        getVerifiedReceipt: async () => {
          throw new ThunderstoreModImportError(sourceCode)
        }
      }
    })
    await expect(service.preview(validSingleRequest())).rejects.toMatchObject({ code: expectedCode })
  })

  it('honors cancellation before reading any receipt', async () => {
    const getVerifiedReceipt = vi.fn(async () => null)
    const controller = new AbortController()
    controller.abort()
    const service = new VerifiedModLockService({ receipts: { getVerifiedReceipt } })
    await expect(service.preview(validSingleRequest(), controller.signal)).rejects.toBeInstanceOf(VerifiedModLockError)
    expect(getVerifiedReceipt).not.toHaveBeenCalled()
  })
})

function validSingleRequest() {
  return {
    roots: ['Fictional-ServerHelper-2.0.0'],
    importReceiptIds: [rootReceiptId],
    policies: [{
      sourceId: 'thunderstore:Fictional/ServerHelper',
      serverRequired: true,
      clientRequirement: 'required' as const
    }]
  }
}

function receiptFixture(input: {
  requestId: string
  namespace: string
  name: string
  version: string
  dependencies: string[]
  archiveSha256: string
  payloadBytes: string
}): ThunderstoreModImportReceipt {
  const sourceId = `thunderstore:${input.namespace}/${input.name}`
  const dependencyId = `${input.namespace}-${input.name}-${input.version}`
  const bytes = Buffer.from(input.payloadBytes)
  const manifest: StagedModPackageManifest = {
    format: 'dyson-control-staged-mod-package',
    schemaVersion: 1,
    dependencyId,
    sourceId,
    version: input.version,
    dependencies: input.dependencies,
    files: [{
      relativePath: `${input.name}.dll`,
      sizeBytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex')
    }]
  }
  return {
    format: 'dyson-control-thunderstore-mod-import-receipt',
    schemaVersion: 1,
    requestId: input.requestId,
    acquisitionReceiptId: input.requestId,
    artifact: {
      artifactId: `artifact-${input.archiveSha256.slice(0, 40)}`,
      sizeBytes: 1024,
      sha256: input.archiveSha256
    },
    package: { dependencyId, sourceId, version: input.version, dependencies: input.dependencies },
    payload: {
      sha256: computeStagedModPayloadDigest(manifest),
      fileCount: manifest.files.length,
      sizeBytes: bytes.byteLength,
      manifest
    },
    staging: { created: true },
    state: 'staged',
    reused: false,
    importedAt: '2026-08-31T00:00:00.000Z'
  }
}

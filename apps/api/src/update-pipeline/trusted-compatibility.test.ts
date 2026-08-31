import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TrustedCompatibilityService,
  type TrustedCompatibilityServiceOptions
} from './trusted-compatibility.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

describe('server-owned compatibility evidence', () => {
  it('reports normalized runtime inventory but fails closed when no reviewed policy is installed', async () => {
    const { service } = await createService({ policy: null })

    const status = await service.status()
    expect(status).toMatchObject({
      format: 'dyson-control-trusted-compatibility-status',
      schemaVersion: 1,
      available: false,
      policyId: null,
      policyRevision: null,
      policyReviewedAt: null,
      inventory: baseInventory()
    })
    expect(status.inventoryRevision).toMatch(/^[0-9a-f]{64}$/)
    await expect(service.prepare({ ...makeRequest(status), expectedPolicyRevision: '0'.repeat(64) })).rejects.toMatchObject({
      code: 'UPDATE_COMPATIBILITY_POLICY_UNAVAILABLE'
    })
  })

  it('persists a compatible receipt, replays the same UUID idempotently, and revalidates it from trusted state', async () => {
    const readRuntimeInventory = vi.fn(async () => baseInventory())
    const { service, stateRoot } = await createService({ readRuntimeInventory })
    const status = await service.status()
    const request = makeRequest(status)

    const first = await service.prepare(request)
    expect(first).toMatchObject({
      receiptId: request.requestId,
      component: 'nebula',
      artifactId: request.artifactId,
      artifactSha256: request.sha256,
      targetVersion: '0.9.1',
      inventoryRevision: status.inventoryRevision,
      policyRevision: status.policyRevision,
      policyId: 'fictional-reviewed-policy',
      matchedEntryId: 'fictional-nebula-091',
      compatible: true,
      reused: false
    })
    expect(await service.prepare(request)).toMatchObject({ receiptId: request.requestId, reused: true })
    await expect(service.assertCurrent(first.receiptId, candidateFrom(request))).resolves.toMatchObject({
      receipt: { receiptId: first.receiptId, compatible: true },
      decision: { compatible: true, matchedEntryId: 'fictional-nebula-091' }
    })
    const stored = JSON.parse(await readFile(path.join(stateRoot, 'receipts', `${request.requestId}.json`), 'utf8'))
    expect(stored).toMatchObject({
      format: 'dyson-control-trusted-compatibility-receipt-envelope',
      requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      receipt: { artifactId: request.artifactId }
    })
    expect(readRuntimeInventory).toHaveBeenCalledTimes(3)
  })

  it('rejects request identity changes and every browser-supplied policy, inventory, path, URL, or command field', async () => {
    const { service } = await createService()
    const status = await service.status()
    const request = makeRequest(status)
    await service.prepare(request)

    await expect(service.prepare({ ...request, targetVersion: '0.9.2' })).rejects.toMatchObject({
      code: 'UPDATE_COMPATIBILITY_IDEMPOTENCY_CONFLICT'
    })
    for (const extra of [
      { policy: fictionalPolicy() },
      { inventory: baseInventory() },
      { matrix: fictionalPolicy().matrix },
      { url: 'https://untrusted.invalid/archive.zip' },
      { path: 'C:\\private\\archive.zip' },
      { command: 'whoami' }
    ]) {
      await expect(service.prepare({ ...makeRequest(status), requestId: randomUUID(), ...extra }))
        .rejects.toMatchObject({ code: 'UPDATE_COMPATIBILITY_REQUEST_INVALID' })
    }
  })

  it('records an incompatible decision for audit but refuses to authorize activation', async () => {
    const { service } = await createService({ policy: fictionalPolicy('0.9.9') })
    const status = await service.status()
    const request = makeRequest(status)
    const receipt = await service.prepare(request)

    expect(receipt).toMatchObject({ compatible: false, matchedEntryId: null })
    await expect(service.assertCurrent(receipt.receiptId, candidateFrom(request))).rejects.toMatchObject({
      code: 'UPDATE_COMPATIBILITY_CONFLICT'
    })
  })

  it('detects inventory drift, policy drift, candidate tampering, and expiry independently', async () => {
    let inventory = baseInventory()
    let now = new Date('2026-08-30T12:00:00.000Z')
    const fixture = await createService({
      readRuntimeInventory: async () => inventory,
      now: () => now,
      receiptLifetimeMs: 30_000
    })
    const status = await fixture.service.status()
    const request = makeRequest(status)
    const receipt = await fixture.service.prepare(request)

    await expect(fixture.service.assertCurrent(receipt.receiptId, {
      ...candidateFrom(request), sha256: 'b'.repeat(64)
    })).rejects.toMatchObject({ code: 'UPDATE_COMPATIBILITY_CANDIDATE_MISMATCH' })

    inventory = baseInventory({ dsp: '0.10.33.26728' })
    await expect(fixture.service.assertCurrent(receipt.receiptId, candidateFrom(request)))
      .rejects.toMatchObject({ code: 'UPDATE_COMPATIBILITY_INVENTORY_DRIFT' })
    inventory = baseInventory()

    const changedPolicy = new TrustedCompatibilityService({
      stateRoot: fixture.stateRoot,
      policy: { ...fictionalPolicy(), policyId: 'fictional-reviewed-policy-v2' },
      readRuntimeInventory: async () => inventory,
      now: () => now
    })
    await expect(changedPolicy.assertCurrent(receipt.receiptId, candidateFrom(request)))
      .rejects.toMatchObject({ code: 'UPDATE_COMPATIBILITY_POLICY_DRIFT' })

    now = new Date('2026-08-30T12:00:30.000Z')
    await expect(fixture.service.assertCurrent(receipt.receiptId, candidateFrom(request)))
      .rejects.toMatchObject({ code: 'UPDATE_COMPATIBILITY_RECEIPT_EXPIRED' })
  })

  it('fails stale client revisions before evaluation and treats runtime adapter failures as code-only unavailability', async () => {
    const { service } = await createService()
    const status = await service.status()
    await expect(service.prepare({ ...makeRequest(status), expectedPolicyRevision: 'f'.repeat(64) }))
      .rejects.toMatchObject({ code: 'UPDATE_COMPATIBILITY_POLICY_DRIFT' })
    await expect(service.prepare({ ...makeRequest(status), expectedInventoryRevision: 'e'.repeat(64) }))
      .rejects.toMatchObject({ code: 'UPDATE_COMPATIBILITY_INVENTORY_DRIFT' })

    const unavailable = await createService({
      readRuntimeInventory: async () => { throw new Error('C:\\private sensitive-marker') }
    })
    const failure = await unavailable.service.status().catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'UPDATE_COMPATIBILITY_INVENTORY_UNAVAILABLE' })
    expect(String(failure)).not.toContain('private')
    expect(String(failure)).not.toContain('secret')
  })

  it('normalizes policy ordering into one revision and rejects malformed or duplicate reviewed catalogs', async () => {
    const first = await createService({ policy: fictionalPolicy() })
    const reordered = fictionalPolicy()
    reordered.matrix.entries[0]!.plugins.reverse()
    const second = await createService({ policy: reordered })
    expect((await first.service.status()).policyRevision).toBe((await second.service.status()).policyRevision)

    const duplicate = fictionalPolicy()
    duplicate.matrix.entries.push(structuredClone(duplicate.matrix.entries[0]!))
    await expect(async () => await createService({ policy: duplicate })).rejects.toMatchObject({
      code: 'UPDATE_COMPATIBILITY_POLICY_INVALID'
    })
    await expect(async () => await createService({ policy: {
      ...fictionalPolicy(), matrix: { schemaVersion: 1, entries: [] }
    } })).rejects.toMatchObject({ code: 'UPDATE_COMPATIBILITY_POLICY_INVALID' })
  })

  it('keeps the durable receipt set bounded while allowing an existing UUID replay at the limit', async () => {
    const { service } = await createService({ maximumReceipts: 1 })
    const status = await service.status()
    const request = makeRequest(status)
    await service.prepare(request)
    await expect(service.prepare(request)).resolves.toMatchObject({ reused: true })
    await expect(service.prepare({ ...request, requestId: randomUUID() })).rejects.toMatchObject({
      code: 'UPDATE_COMPATIBILITY_RECEIPT_LIMIT_REACHED'
    })
  })

  it('rejects a corrupted or unexpected receipt directory entry instead of skipping it', async () => {
    const { service, stateRoot } = await createService()
    const status = await service.status()
    await mkdir(path.join(stateRoot, 'receipts'), { recursive: true })
    await writeFile(path.join(stateRoot, 'receipts', 'unexpected.txt'), '{}')
    await expect(service.prepare(makeRequest(status))).rejects.toMatchObject({
      code: 'UPDATE_COMPATIBILITY_RECEIPT_DIRECTORY_INVALID'
    })
  })
})

async function createService(overrides: Partial<TrustedCompatibilityServiceOptions> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'dyson-trusted-compatibility-'))
  temporaryRoots.push(root)
  const stateRoot = path.join(root, 'state')
  const service = new TrustedCompatibilityService({
    stateRoot,
    policy: fictionalPolicy(),
    readRuntimeInventory: async () => baseInventory(),
    now: () => new Date('2026-08-30T12:00:00.000Z'),
    ...overrides
  })
  return { service, stateRoot }
}

function makeRequest(status: Awaited<ReturnType<TrustedCompatibilityService['status']>>) {
  return {
    requestId: randomUUID(),
    component: 'nebula' as const,
    artifactId: 'nebula-artifact-0001',
    sha256: 'a'.repeat(64),
    targetVersion: '0.9.1',
    expectedInventoryRevision: status.inventoryRevision,
    expectedPolicyRevision: status.policyRevision!
  }
}

function candidateFrom(request: ReturnType<typeof makeRequest>) {
  const { requestId: _requestId, expectedInventoryRevision: _inventory, expectedPolicyRevision: _policy, ...candidate } = request
  return candidate
}

function baseInventory(overrides: Partial<{
  dsp: string
  nebula: string
  bepInEx: string
  plugins: Array<{ sourceId: string; version: string }>
}> = {}) {
  return {
    dsp: '0.10.33.26727',
    nebula: '0.9.0',
    bepInEx: '5.4.22',
    plugins: [] as Array<{ sourceId: string; version: string }>,
    ...overrides
  }
}

function fictionalPolicy(candidateNebula = '0.9.1') {
  return {
    format: 'dyson-control-trusted-compatibility-policy' as const,
    schemaVersion: 1 as const,
    policyId: 'fictional-reviewed-policy',
    reviewedAt: '2026-08-30T10:00:00.000Z',
    matrix: {
      schemaVersion: 1 as const,
      entries: [{
        id: 'fictional-nebula-091',
        core: {
          dsp: { equals: '0.10.33.26727' },
          nebula: { equals: candidateNebula },
          bepInEx: { equals: '5.4.22' }
        },
        plugins: [
          { sourceId: 'thunderstore:Example/Optional', range: { equals: '1.0.0' }, required: false },
          { sourceId: 'thunderstore:Example/Absent', range: { equals: '2.0.0' }, required: false }
        ]
      }]
    }
  }
}

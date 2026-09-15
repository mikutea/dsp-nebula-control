import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  TrustedCompatibilityError,
  TrustedCompatibilityHttpController,
  trustedCompatibilityConfirmation,
  type TrustedCompatibilityHttpService,
  type TrustedCompatibilityReceipt,
  type TrustedCompatibilityStatus
} from './index.js'

describe('trusted compatibility HTTP contract', () => {
  it('serves status and creates or replays a receipt without accepting policy or inventory', async () => {
    const service = createService()
    const controller = new TrustedCompatibilityHttpController(service)
    expect(await controller.status({})).toEqual({ statusCode: 200, body: { ok: true, data: statusFixture } })

    const input = { ...prepareFixture, confirmation: trustedCompatibilityConfirmation }
    expect(await controller.prepare(input)).toEqual({ statusCode: 201, body: { ok: true, data: receiptFixture } })
    expect(service.prepare).toHaveBeenCalledWith(prepareFixture)

    const replay = createService({ prepare: vi.fn(async () => ({ ...receiptFixture, reused: true })) })
    expect(await new TrustedCompatibilityHttpController(replay).prepare(input)).toEqual({
      statusCode: 200,
      body: { ok: true, data: { ...receiptFixture, reused: true } }
    })
  })

  it.each(['policy', 'matrix', 'inventory', 'url', 'path', 'command', 'token']) (
    'rejects the unknown browser-controlled field %s before the service',
    async (field) => {
      const service = createService()
      const controller = new TrustedCompatibilityHttpController(service)
      expect(await controller.prepare({
        ...prepareFixture,
        confirmation: trustedCompatibilityConfirmation,
        [field]: field === 'inventory' ? statusFixture.inventory : 'C:\\private\\sensitive-marker'
      })).toEqual({
        statusCode: 422,
        body: { ok: false, error: { code: 'UPDATE_COMPATIBILITY_HTTP_REQUEST_INVALID' } }
      })
      expect(service.prepare).not.toHaveBeenCalled()
    }
  )

  it('requires the exact confirmation and rejects extra status or receipt query fields', async () => {
    const service = createService()
    const controller = new TrustedCompatibilityHttpController(service)
    for (const confirmation of [undefined, 'prepare', 'PREPARE_COMPATIBILITY']) {
      expect(await controller.prepare({ ...prepareFixture, confirmation })).toMatchObject({
        statusCode: 422,
        body: { error: { code: 'UPDATE_COMPATIBILITY_HTTP_REQUEST_INVALID' } }
      })
    }
    expect(await controller.status({ path: 'C:\\private' })).toMatchObject({ statusCode: 422 })
    const rejectedTokenValue = ['non', 'sensitive', 'test', 'value'].join('-')
    expect(await controller.getReceipt({ receiptId: receiptFixture.receiptId, token: rejectedTokenValue }))
      .toMatchObject({ statusCode: 422 })
    expect(service.prepare).not.toHaveBeenCalled()
  })

  it('gets receipts, returns stable 404, and maps core failures without reflecting causes', async () => {
    const service = createService()
    const controller = new TrustedCompatibilityHttpController(service)
    expect(await controller.getReceipt({ receiptId: receiptFixture.receiptId })).toEqual({
      statusCode: 200, body: { ok: true, data: receiptFixture }
    })

    const missing = createService({ getReceipt: vi.fn(async () => null) })
    expect(await new TrustedCompatibilityHttpController(missing).getReceipt({ receiptId: randomUUID() })).toEqual({
      statusCode: 404,
      body: { ok: false, error: { code: 'UPDATE_COMPATIBILITY_RECEIPT_NOT_FOUND' } }
    })

    for (const [code, statusCode] of [
      ['UPDATE_COMPATIBILITY_POLICY_DRIFT', 409],
      ['UPDATE_COMPATIBILITY_RECEIPT_LIMIT_REACHED', 423],
      ['UPDATE_COMPATIBILITY_REQUEST_INVALID', 422],
      ['UPDATE_COMPATIBILITY_POLICY_UNAVAILABLE', 503]
    ] as const) {
      const failed = createService({
        prepare: vi.fn(async () => {
          throw new TrustedCompatibilityError(code, { cause: new Error('C:\\private sensitive-marker') })
        })
      })
      const result = await new TrustedCompatibilityHttpController(failed).prepare({
        ...prepareFixture, confirmation: trustedCompatibilityConfirmation
      })
      expect(result).toEqual({ statusCode, body: { ok: false, error: { code } } })
      expect(JSON.stringify(result)).not.toContain('private')
      expect(JSON.stringify(result)).not.toContain('secret')
    }
  })

  it('collapses unexpected exceptions to one code-only 503 response', async () => {
    const service = createService({
      status: vi.fn(async () => { throw new Error('C:\\private sensitive-marker') })
    })
    const result = await new TrustedCompatibilityHttpController(service).status({})
    expect(result).toEqual({
      statusCode: 503,
      body: { ok: false, error: { code: 'UPDATE_COMPATIBILITY_HTTP_UNAVAILABLE' } }
    })
    expect(JSON.stringify(result)).not.toContain('private')
  })
})

function createService(overrides: Partial<TrustedCompatibilityHttpService> = {}) {
  return {
    status: vi.fn(async () => statusFixture),
    prepare: vi.fn(async () => receiptFixture),
    getReceipt: vi.fn(async () => receiptFixture),
    ...overrides
  } satisfies TrustedCompatibilityHttpService
}

const statusFixture: TrustedCompatibilityStatus = {
  format: 'dyson-control-trusted-compatibility-status',
  schemaVersion: 1,
  available: true,
  policyId: 'fictional-reviewed-policy',
  policyRevision: '1'.repeat(64),
  policyReviewedAt: '2026-08-30T10:00:00.000Z',
  inventoryRevision: '2'.repeat(64),
  inventory: {
    dsp: '0.10.33.26727',
    nebula: '0.9.0',
    bepInEx: '5.4.22',
    plugins: []
  }
}

const prepareFixture = {
  requestId: '018f47a0-7d5b-7abc-8def-0123456789ab',
  component: 'nebula' as const,
  artifactId: 'nebula-artifact-0001',
  sha256: 'a'.repeat(64),
  targetVersion: '0.9.1',
  expectedInventoryRevision: statusFixture.inventoryRevision,
  expectedPolicyRevision: statusFixture.policyRevision!
}

const receiptFixture: TrustedCompatibilityReceipt = {
  format: 'dyson-control-trusted-compatibility-receipt',
  schemaVersion: 1,
  receiptId: prepareFixture.requestId,
  component: prepareFixture.component,
  artifactId: prepareFixture.artifactId,
  artifactSha256: prepareFixture.sha256,
  targetVersion: prepareFixture.targetVersion,
  inventoryRevision: statusFixture.inventoryRevision,
  policyId: statusFixture.policyId!,
  policyRevision: statusFixture.policyRevision!,
  matchedEntryId: 'fictional-nebula-091',
  compatible: true,
  issuedAt: '2026-08-30T12:00:00.000Z',
  expiresAt: '2026-08-30T12:10:00.000Z',
  reused: false
}

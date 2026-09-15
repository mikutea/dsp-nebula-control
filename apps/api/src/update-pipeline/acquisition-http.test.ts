import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  ArtifactAcquisitionHttpController,
  type ArtifactAcquisitionHttpService,
  type ArtifactAcquisitionPlan,
  type ArtifactAcquisitionReceipt
} from './index.js'
import { UpdatePipelineError } from './errors.js'

describe('artifact acquisition HTTP contract', () => {
  it('previews only an opaque server-registered candidate ID', async () => {
    const service = mockService()
    const controller = new ArtifactAcquisitionHttpController({ service })
    expect(await controller.preview({ candidateId })).toEqual({
      statusCode: 200,
      body: { ok: true, data: plan }
    })
    expect(service.preview).toHaveBeenCalledWith(candidateId)
  })

  it.each(['url', 'path', 'command', 'args', 'token', 'manifest'])(
    'rejects the unknown %s field before invoking acquisition',
    async (field) => {
      const service = mockService()
      const controller = new ArtifactAcquisitionHttpController({ service, mutationGate: () => true })
      const input = { ...executeInput(), [field]: 'C:\\private\\not-reflected' }
      expect(await controller.execute(input)).toEqual(invalid)
      expect(service.acquire).not.toHaveBeenCalled()
    }
  )

  it('keeps mutation disabled by default and checks the gate before core execution', async () => {
    const service = mockService()
    const controller = new ArtifactAcquisitionHttpController({ service })
    expect(await controller.execute(executeInput())).toEqual({
      statusCode: 423,
      body: { ok: false, error: { code: 'UPDATE_ACQUISITION_MUTATION_DISABLED' } }
    })
    expect(service.acquire).not.toHaveBeenCalled()
  })

  it('returns 201 for a new inbox artifact and 200 for a durable idempotent replay', async () => {
    const firstService = mockService()
    const first = new ArtifactAcquisitionHttpController({ service: firstService, mutationGate: () => true })
    expect(await first.execute(executeInput())).toEqual({
      statusCode: 201,
      body: { ok: true, data: receipt }
    })

    const reused = { ...receipt, reused: true }
    const replayService = mockService({ acquire: vi.fn(async () => reused) })
    const replay = new ArtifactAcquisitionHttpController({ service: replayService, mutationGate: () => true })
    expect(await replay.execute(executeInput())).toEqual({
      statusCode: 200,
      body: { ok: true, data: reused }
    })
  })

  it('passes cancellation to the bounded downloader without exposing it in the JSON contract', async () => {
    const service = mockService()
    const signal = new AbortController().signal
    const controller = new ArtifactAcquisitionHttpController({ service, mutationGate: () => true })
    await controller.execute(executeInput(), signal)
    expect(service.acquire).toHaveBeenCalledWith(executeInput(), signal)
  })

  it('reads a durable receipt by UUID and returns a stable 404', async () => {
    const service = mockService()
    const controller = new ArtifactAcquisitionHttpController({ service })
    expect(await controller.getReceipt({ requestId: receipt.requestId })).toEqual({
      statusCode: 200,
      body: { ok: true, data: receipt }
    })

    const missingService = mockService({ getReceipt: vi.fn(async () => null) })
    expect(await new ArtifactAcquisitionHttpController({ service: missingService }).getReceipt({
      requestId: randomUUID()
    })).toEqual({
      statusCode: 404,
      body: { ok: false, error: { code: 'UPDATE_ACQUISITION_RECEIPT_NOT_FOUND' } }
    })
  })

  it.each([
    ['ACQUISITION_CANDIDATE_NOT_FOUND', 404],
    ['ACQUISITION_REQUEST_LOCK_BUSY', 423],
    ['ACQUISITION_IDEMPOTENCY_CONFLICT', 409],
    ['ACQUISITION_SHA256_MISMATCH', 422],
    ['ACQUISITION_REQUEST_TIMEOUT', 503],
    ['ACQUISITION_RECEIPT_INVALID', 503]
  ] as const)('maps core code %s to %i without reflecting causes', async (code, statusCode) => {
    const service = mockService({
      acquire: vi.fn(async () => {
        throw new UpdatePipelineError(code, { cause: new Error('C:\\secret token=do-not-reflect') })
      })
    })
    const result = await new ArtifactAcquisitionHttpController({
      service,
      mutationGate: () => true
    }).execute(executeInput())
    expect(result).toEqual({ statusCode, body: { ok: false, error: { code } } })
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('uses a stable unavailable code for unexpected adapter failures and gate failures', async () => {
    const adapter = mockService({ acquire: vi.fn(async () => { throw new Error('private adapter detail') }) })
    expect(await new ArtifactAcquisitionHttpController({
      service: adapter,
      mutationGate: () => true
    }).execute(executeInput())).toEqual({
      statusCode: 503,
      body: { ok: false, error: { code: 'UPDATE_ACQUISITION_UNAVAILABLE' } }
    })

    const gated = mockService()
    expect(await new ArtifactAcquisitionHttpController({
      service: gated,
      mutationGate: () => { throw new Error('private gate detail') }
    }).execute(executeInput())).toEqual({
      statusCode: 503,
      body: { ok: false, error: { code: 'UPDATE_ACQUISITION_GATE_UNAVAILABLE' } }
    })
    expect(gated.acquire).not.toHaveBeenCalled()
  })
})

const candidateId = `candidate-${'a'.repeat(48)}`
const artifactId = `artifact-${'b'.repeat(40)}`

const plan: ArtifactAcquisitionPlan = {
  format: 'dyson-control-artifact-acquisition-plan',
  schemaVersion: 1,
  dryRun: true,
  candidate: {
    candidateId,
    provider: 'github',
    release: { kind: 'nebula', sourceId: 'github:NebulaModTeam/nebula', version: '0.9.22' },
    artifact: {
      artifactId,
      fileName: 'Nebula.zip',
      sizeBytes: 4,
      sha256: 'c'.repeat(64),
      integrity: 'provider-sha256'
    },
    expiresAt: '2026-08-31T08:00:00.000Z'
  },
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

const receipt: ArtifactAcquisitionReceipt = {
  format: 'dyson-control-artifact-acquisition-receipt',
  schemaVersion: 1,
  requestId: 'a8ff3705-8660-47dc-8a1e-3cca1865530e',
  candidateId,
  provider: 'github',
  release: plan.candidate.release,
  artifact: {
    artifactId,
    fileName: 'Nebula.zip',
    sizeBytes: 4,
    sha256: 'c'.repeat(64),
    integrity: 'provider-verified'
  },
  state: 'acquired',
  reused: false,
  acquiredAt: '2026-08-30T08:00:00.000Z'
}

function executeInput() {
  return {
    requestId: receipt.requestId,
    candidateId,
    confirmation: 'ACQUIRE_UPDATE_ARTIFACT' as const
  }
}

function mockService(overrides: Partial<ArtifactAcquisitionHttpService> = {}): ArtifactAcquisitionHttpService & {
  preview: ReturnType<typeof vi.fn<ArtifactAcquisitionHttpService['preview']>>
  acquire: ReturnType<typeof vi.fn<ArtifactAcquisitionHttpService['acquire']>>
  getReceipt: ReturnType<typeof vi.fn<ArtifactAcquisitionHttpService['getReceipt']>>
} {
  return {
    preview: vi.fn(async () => plan),
    acquire: vi.fn(async () => receipt),
    getReceipt: vi.fn(async () => receipt),
    ...overrides
  } as ReturnType<typeof mockService>
}

const invalid = {
  statusCode: 422,
  body: { ok: false, error: { code: 'UPDATE_ACQUISITION_REQUEST_INVALID' } }
}

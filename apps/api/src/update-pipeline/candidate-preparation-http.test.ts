import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  ComponentCandidatePreparationHttpController,
  nebulaWindowsLayoutPolicyIds,
  type AvailableComponentCandidatePreparationPlan,
  type ComponentCandidatePreparationHttpService,
  type ComponentCandidatePreparationReceipt,
  type ComponentCandidatePreparationUnavailable
} from './index.js'
import { UpdatePipelineError } from './errors.js'

describe('component candidate preparation HTTP contract', () => {
  it('previews from only component and acquisition receipt UUID', async () => {
    const service = mockService()
    const controller = new ComponentCandidatePreparationHttpController({ service })
    const result = await controller.preview({ component: 'nebula', acquisitionReceiptId })
    expect(result).toEqual({ statusCode: 200, body: { ok: true, data: plan } })
    expect(service.preview).toHaveBeenCalledWith(
      { component: 'nebula', acquisitionReceiptId },
      undefined
    )
    expect(JSON.stringify(result)).not.toContain('C:\\')
    expect(JSON.stringify(result)).not.toContain('https://')
  })

  it.each(['url', 'path', 'command', 'args', 'artifactId', 'sha256', 'sourceId'])(
    'rejects the unknown %s field before invoking the service',
    async (field) => {
      const service = mockService()
      const controller = new ComponentCandidatePreparationHttpController({
        service,
        mutationGate: () => true
      })
      const result = await controller.execute({
        ...executeInput(),
        [field]: 'C:\\private\\must-not-reflect'
      })
      expect(result).toEqual(invalid)
      expect(service.execute).not.toHaveBeenCalled()
      expect(JSON.stringify(result)).not.toContain('private')
    }
  )

  it('keeps supported mutation disabled by default', async () => {
    const service = mockService()
    const result = await new ComponentCandidatePreparationHttpController({ service })
      .execute(executeInput())
    expect(result).toEqual({
      statusCode: 423,
      body: { ok: false, error: { code: 'CANDIDATE_PREPARATION_MUTATION_DISABLED' } }
    })
    expect(service.execute).not.toHaveBeenCalled()
  })

  it('returns an explicit bridge/control unavailable projection without entering the mutation gate', async () => {
    const gate = vi.fn(() => { throw new Error('gate must not run for unsupported components') })
    const unavailable: ComponentCandidatePreparationUnavailable = {
      format: 'dyson-control-component-preparation-unavailable',
      schemaVersion: 1,
      available: false,
      component: 'bridge',
      acquisitionReceiptId,
      reasonCode: 'CANDIDATE_PREPARATION_COMPONENT_UNAVAILABLE'
    }
    const service = mockService({ execute: vi.fn(async () => unavailable) })
    const result = await new ComponentCandidatePreparationHttpController({ service, mutationGate: gate })
      .execute({ ...executeInput(), component: 'bridge' })
    expect(result).toEqual({ statusCode: 200, body: { ok: true, data: unavailable } })
    expect(gate).not.toHaveBeenCalled()
  })

  it('returns 201 for a new durable receipt and 200 for an idempotent replay', async () => {
    const service = mockService()
    const controller = new ComponentCandidatePreparationHttpController({
      service,
      mutationGate: () => true
    })
    expect(await controller.execute(executeInput())).toEqual({
      statusCode: 201,
      body: { ok: true, data: receipt }
    })

    const replayReceipt = { ...receipt, reused: true }
    const replay = new ComponentCandidatePreparationHttpController({
      service: mockService({ execute: vi.fn(async () => replayReceipt) }),
      mutationGate: () => true
    })
    expect(await replay.execute(executeInput())).toEqual({
      statusCode: 200,
      body: { ok: true, data: replayReceipt }
    })
  })

  it('passes cancellation without exposing it in the JSON contract', async () => {
    const service = mockService()
    const signal = new AbortController().signal
    const controller = new ComponentCandidatePreparationHttpController({
      service,
      mutationGate: () => true
    })
    await controller.execute(executeInput(), signal)
    expect(service.execute).toHaveBeenCalledWith(executeInput(), signal)
  })

  it('gets a durable receipt by UUID and returns a stable 404', async () => {
    const service = mockService()
    const controller = new ComponentCandidatePreparationHttpController({ service })
    expect(await controller.getReceipt({ requestId })).toEqual({
      statusCode: 200,
      body: { ok: true, data: receipt }
    })

    const missing = new ComponentCandidatePreparationHttpController({
      service: mockService({ getReceipt: vi.fn(async () => null) })
    })
    expect(await missing.getReceipt({ requestId: randomUUID() })).toEqual({
      statusCode: 404,
      body: { ok: false, error: { code: 'CANDIDATE_PREPARATION_RECEIPT_NOT_FOUND' } }
    })
  })

  it.each([
    ['CANDIDATE_PREPARATION_ACQUISITION_RECEIPT_NOT_FOUND', 404],
    ['CANDIDATE_PREPARATION_REQUEST_LOCK_BUSY', 423],
    ['CANDIDATE_PREPARATION_IDEMPOTENCY_CONFLICT', 409],
    ['UPDATE_NEBULA_LAYOUT_INVALID', 422],
    ['CANDIDATE_PREPARATION_STATE_WRITE_FAILED', 503]
  ] as const)('maps core code %s to %i without reflecting causes', async (code, statusCode) => {
    const service = mockService({
      execute: vi.fn(async () => {
        throw new UpdatePipelineError(code, {
          cause: new Error('C:\\private token=must-not-reflect')
        })
      })
    })
    const result = await new ComponentCandidatePreparationHttpController({
      service,
      mutationGate: () => true
    }).execute(executeInput())
    expect(result).toEqual({ statusCode, body: { ok: false, error: { code } } })
    expect(JSON.stringify(result)).not.toContain('private')
  })

  it('fails closed on gate and unexpected adapter failures', async () => {
    const gateFailure = new ComponentCandidatePreparationHttpController({
      service: mockService(),
      mutationGate: () => { throw new Error('private') }
    })
    expect(await gateFailure.execute(executeInput())).toEqual({
      statusCode: 503,
      body: { ok: false, error: { code: 'CANDIDATE_PREPARATION_GATE_UNAVAILABLE' } }
    })

    const serviceFailure = new ComponentCandidatePreparationHttpController({
      service: mockService({ execute: vi.fn(async () => { throw new Error('private') }) }),
      mutationGate: () => true
    })
    expect(await serviceFailure.execute(executeInput())).toEqual({
      statusCode: 503,
      body: { ok: false, error: { code: 'CANDIDATE_PREPARATION_UNAVAILABLE' } }
    })
  })
})

const requestId = 'a8ff3705-8660-47dc-8a1e-3cca1865530e'
const acquisitionReceiptId = 'a1dc143d-c529-4e56-9f16-4f498945c31a'
const sourceArtifactId = `artifact-${'a'.repeat(40)}`
const preparedArtifactId = `prepared-nebula-${'b'.repeat(40)}`

const source = {
  provider: 'github' as const,
  sourceId: 'github:NebulaModTeam/nebula',
  version: '0.9.22',
  artifactId: sourceArtifactId,
  sizeBytes: 10_000,
  sha256: 'c'.repeat(64),
  integrity: 'provider-verified' as const
}

const plan: AvailableComponentCandidatePreparationPlan = {
  format: 'dyson-control-component-preparation-plan',
  schemaVersion: 1,
  available: true,
  dryRun: true,
  component: 'nebula',
  acquisitionReceiptId,
  source,
  prepared: {
    mode: 'normalized-nebula-windows',
    artifactId: preparedArtifactId,
    layoutPolicy: nebulaWindowsLayoutPolicyIds.v0_9_22
  },
  operations: ['load-validated-acquisition-receipt', 'stage-verified-artifact'],
  activation: { automatic: false, nextAction: 'component-update-activation-preview' }
}

const receipt: ComponentCandidatePreparationReceipt = {
  format: 'dyson-control-component-preparation-receipt',
  schemaVersion: 1,
  requestId,
  component: 'nebula',
  acquisitionReceiptId,
  source,
  prepared: {
    ...plan.prepared,
    sizeBytes: 8_000,
    sha256: 'd'.repeat(64),
    integrity: 'normalized-locally-computed'
  },
  staging: {
    created: true,
    manifest: {
      format: 'dyson-control-staged-artifact',
      schemaVersion: 1,
      artifactId: preparedArtifactId,
      artifactFile: 'artifact.bin',
      release: {
        kind: 'nebula',
        sourceId: 'github:NebulaModTeam/nebula',
        version: '0.9.22'
      },
      sizeBytes: 8_000,
      sha256: 'd'.repeat(64),
      integrity: 'locally-computed',
      stagedAt: '2026-08-30T08:00:00.000Z'
    }
  },
  state: 'staged',
  reused: false,
  preparedAt: '2026-08-30T08:00:00.000Z'
}

function executeInput() {
  return {
    requestId,
    component: 'nebula' as const,
    acquisitionReceiptId,
    confirmation: 'PREPARE_COMPONENT_CANDIDATE' as const
  }
}

function mockService(
  overrides: Partial<ComponentCandidatePreparationHttpService> = {}
): ComponentCandidatePreparationHttpService & {
  preview: ReturnType<typeof vi.fn<ComponentCandidatePreparationHttpService['preview']>>
  execute: ReturnType<typeof vi.fn<ComponentCandidatePreparationHttpService['execute']>>
  getReceipt: ReturnType<typeof vi.fn<ComponentCandidatePreparationHttpService['getReceipt']>>
} {
  return {
    preview: vi.fn(async () => plan),
    execute: vi.fn(async () => receipt),
    getReceipt: vi.fn(async () => receipt),
    ...overrides
  } as ReturnType<typeof mockService>
}

const invalid = {
  statusCode: 422,
  body: { ok: false, error: { code: 'CANDIDATE_PREPARATION_REQUEST_INVALID' } }
}

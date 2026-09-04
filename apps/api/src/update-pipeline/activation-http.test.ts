import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  ComponentUpdateActivationError,
  ComponentUpdateActivationHttpController,
  componentUpdateActivationConfirmations,
  componentUpdateActivationRecoveryConfirmation,
  type ComponentUpdateActivationHttpService,
  type ComponentUpdateActivationPlan,
  type ComponentUpdateActivationReceipt,
  type ComponentUpdateCleanupPlan,
  type ComponentUpdateStateSummary,
  type UpdateActivationRequest
} from './index.js'
import { UpdatePipelineError } from './errors.js'

describe('component update activation HTTP contract', () => {
  it('previews a deeply validated request and returns the core plan as 200', async () => {
    const service = createService()
    const controller = new ComponentUpdateActivationHttpController({ service })
    const request = makeRequest()

    await expect(controller.preview(request)).resolves.toEqual({
      statusCode: 200,
      body: { ok: true, data: planFixture }
    })
    expect(service.preview).toHaveBeenCalledWith(request)
  })

  it.each(['path', 'url', 'command', 'executable', 'args', 'password', 'credential', 'token'])(
    'rejects the unknown top-level field %s before any core call',
    async (field) => {
      const service = createService()
      const controller = new ComponentUpdateActivationHttpController({ service, mutationGate: () => true })
      const request = { ...makeRequest(), [field]: 'C:\\private\\do-not-reflect' }

      expect(await controller.preview(request)).toEqual(invalidRequest)
      expect(await controller.execute({
        ...request,
        confirmation: componentUpdateActivationConfirmations.nebula
      })).toEqual(invalidRequest)
      expect(service.preview).not.toHaveBeenCalled()
      expect(service.execute).not.toHaveBeenCalled()
    }
  )

  it('rejects browser-supplied compatibility policy/inventory and prototype-pollution-shaped input', async () => {
    const service = createService()
    const controller = new ComponentUpdateActivationHttpController({ service })
    const compatibilityExtra = { ...makeRequest(), compatibility: { url: 'https://untrusted.invalid' } }
    const inventoryExtra = { ...makeRequest(), inventory: { dsp: '0.10.33.26727', command: 'whoami' } }
    const matrixExtra = { ...makeRequest(), matrix: { schemaVersion: 1, password: 'do-not-reflect' } }
    const polluted = JSON.parse(
      `${JSON.stringify(makeRequest()).slice(0, -1)},"__proto__":{"path":"C:\\\\private"}}`
    ) as unknown

    for (const input of [compatibilityExtra, inventoryExtra, matrixExtra, polluted]) {
      expect(await controller.preview(input)).toEqual(invalidRequest)
    }
    expect(service.preview).not.toHaveBeenCalled()
  })

  it.each([
    ['targetVersion', 'https://untrusted.invalid/payload'],
    ['artifactId', '../../outside-root'],
    ['sha256', 'C:\\private\\artifact'],
    ['expectedRevision', 'run-command'],
    ['compatibilityReceiptId', 'not-a-uuid']
  ])('rejects path-, URL-, or command-shaped content in %s', async (field, value) => {
    const service = createService()
    const request = { ...makeRequest(), [field]: value }
    expect(await new ComponentUpdateActivationHttpController({ service }).preview(request)).toEqual(invalidRequest)
    expect(service.preview).not.toHaveBeenCalled()
  })

  it('keeps mutation disabled by default and does not invoke the core', async () => {
    const service = createService()
    const controller = new ComponentUpdateActivationHttpController({ service })

    expect(await controller.execute(makeExecuteRequest())).toEqual({
      statusCode: 423,
      body: { ok: false, error: { code: 'UPDATE_ACTIVATION_HTTP_MUTATION_DISABLED' } }
    })
    expect(service.execute).not.toHaveBeenCalled()
  })

  it('reconciles exactly once before mutation and exposes the bounded ready status', async () => {
    const service = createService()
    const controller = new ComponentUpdateActivationHttpController({ service, mutationGate: () => true })

    await Promise.all([controller.initialize(), controller.initialize()])
    expect(service.reconcile).toHaveBeenCalledOnce()
    expect(service.getState).toHaveBeenCalledOnce()
    expect(await controller.recoveryStatus({})).toEqual({
      statusCode: 200,
      body: { ok: true, data: {
        schemaVersion: 1,
        phase: 'ready',
        mutationBlocked: false,
        recoveryRequired: false,
        failureCode: null,
        reconciledRequestId: null
      } }
    })

    expect((await controller.execute(makeExecuteRequest())).statusCode).toBe(202)
    expect(service.reconcile).toHaveBeenCalledOnce()
  })

  it('waits for startup reconciliation before entering either mutation gate or core execution', async () => {
    let finishReconciliation!: () => void
    const reconciliation = new Promise<void>((resolve) => { finishReconciliation = resolve })
    const gate = vi.fn(() => true)
    const service = createService({
      reconcile: vi.fn(async () => {
        await reconciliation
        return null
      })
    })
    const controller = new ComponentUpdateActivationHttpController({ service, mutationGate: gate })

    const pending = controller.execute(makeExecuteRequest())
    await vi.waitFor(() => expect(service.reconcile).toHaveBeenCalledOnce())
    expect((await controller.recoveryStatus({})).body).toEqual({ ok: true, data: {
      schemaVersion: 1,
      phase: 'reconciling',
      mutationBlocked: true,
      recoveryRequired: false,
      failureCode: null,
      reconciledRequestId: null
    } })
    expect(gate).not.toHaveBeenCalled()
    expect(service.execute).not.toHaveBeenCalled()

    finishReconciliation()
    expect((await pending).statusCode).toBe(202)
  })

  it('fails mutation closed when durable state requires recovery', async () => {
    const gate = vi.fn(() => true)
    const service = createService({
      getState: vi.fn(async () => ({ ...stateFixture, recoveryRequired: true }))
    })
    const controller = new ComponentUpdateActivationHttpController({ service, mutationGate: gate })

    expect(await controller.execute(makeExecuteRequest())).toEqual({
      statusCode: 503,
      body: { ok: false, error: { code: 'UPDATE_ACTIVATION_HTTP_RECOVERY_REQUIRED' } }
    })
    expect((await controller.recoveryStatus({})).body).toEqual({ ok: true, data: expect.objectContaining({
      phase: 'recovery-required',
      mutationBlocked: true,
      recoveryRequired: true,
      failureCode: 'UPDATE_RECOVERY_REQUIRED'
    }) })
    expect(gate).not.toHaveBeenCalled()
    expect(service.execute).not.toHaveBeenCalled()
  })

  it('refreshes durable recovery state after startup before allowing a later mutation', async () => {
    const gate = vi.fn(() => true)
    const getState = vi.fn()
      .mockResolvedValueOnce(stateFixture)
      .mockResolvedValueOnce({ ...stateFixture, recoveryRequired: true })
    const service = createService({ getState })
    const controller = new ComponentUpdateActivationHttpController({ service, mutationGate: gate })
    await controller.initialize()

    expect(await controller.execute(makeExecuteRequest())).toEqual({
      statusCode: 503,
      body: { ok: false, error: { code: 'UPDATE_ACTIVATION_HTTP_RECOVERY_REQUIRED' } }
    })
    expect(getState).toHaveBeenCalledTimes(2)
    expect(gate).not.toHaveBeenCalled()
    expect(service.execute).not.toHaveBeenCalled()
    expect((await controller.recoveryStatus({})).body).toEqual({ ok: true, data: expect.objectContaining({
      phase: 'recovery-required',
      mutationBlocked: true
    }) })
  })

  it('enters recovery-required immediately when ordinary execution returns rollback-failed', async () => {
    const rollbackFailed = {
      ...receiptFixture,
      status: 'rollback-failed' as const,
      failureCode: 'UPDATE_ROLLBACK_SMOKE_FAILED',
      recoveryRequired: true
    }
    const service = createService({ execute: vi.fn(async () => rollbackFailed) })
    const controller = new ComponentUpdateActivationHttpController({ service, mutationGate: () => true })

    expect(await controller.execute(makeExecuteRequest())).toEqual({
      statusCode: 503,
      body: { ok: false, error: { code: 'UPDATE_ROLLBACK_SMOKE_FAILED' } }
    })
    expect((await controller.recoveryStatus({})).body).toEqual({
      ok: true,
      data: expect.objectContaining({
        phase: 'recovery-required',
        mutationBlocked: true,
        reconciledRequestId: receiptFixture.requestId
      })
    })
  })

  it('retains a stable code-only startup recovery failure and never retries it implicitly', async () => {
    const gate = vi.fn(() => true)
    const service = createService({
      reconcile: vi.fn(async () => {
        throw new ComponentUpdateActivationError('UPDATE_RECONCILIATION_UNCERTAIN', {
          cause: new Error('C:\\private\\activation-journal')
        })
      })
    })
    const controller = new ComponentUpdateActivationHttpController({ service, mutationGate: gate })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await controller.execute(makeExecuteRequest())).toEqual({
        statusCode: 503,
        body: { ok: false, error: { code: 'UPDATE_ACTIVATION_HTTP_RECOVERY_REQUIRED' } }
      })
    }
    const status = await controller.recoveryStatus({})
    expect(status.body).toEqual({ ok: true, data: expect.objectContaining({
      phase: 'recovery-required',
      failureCode: 'UPDATE_RECONCILIATION_UNCERTAIN'
    }) })
    expect(JSON.stringify(status)).not.toContain('private')
    expect(service.reconcile).toHaveBeenCalledOnce()
    expect(gate).not.toHaveBeenCalled()
    expect(service.execute).not.toHaveBeenCalled()
  })

  it('requires a fixed confirmation and an independent gate for explicit recovery', async () => {
    const requestId = receiptFixture.requestId
    const recoveryRequired = {
      ...receiptFixture,
      status: 'rollback-failed' as const,
      failureCode: 'UPDATE_ROLLBACK_SMOKE_FAILED',
      rollbackVerified: false,
      recoveryRequired: true
    }
    const service = createService({
      reconcile: vi.fn(async () => recoveryRequired),
      getState: vi.fn(async () => ({ ...stateFixture, recoveryRequired: true }))
    })
    const gate = vi.fn(() => true)
    const controller = new ComponentUpdateActivationHttpController({
      service,
      recoveryMutationGate: gate
    })

    expect(await controller.recover({
      requestId,
      confirmation: 'ACTIVATE_NEBULA_UPDATE'
    })).toEqual(invalidRequest)
    expect(gate).not.toHaveBeenCalled()
    expect(service.recoverInterrupted).not.toHaveBeenCalled()

    const disabled = new ComponentUpdateActivationHttpController({ service })
    expect(await disabled.recover({
      requestId,
      confirmation: componentUpdateActivationRecoveryConfirmation
    })).toEqual({
      statusCode: 423,
      body: { ok: false, error: { code: 'UPDATE_ACTIVATION_HTTP_MUTATION_DISABLED' } }
    })
    expect(service.recoverInterrupted).not.toHaveBeenCalled()
  })

  it('runs one exact explicit recovery and reopens activation only after terminal state proof', async () => {
    const requestId = receiptFixture.requestId
    const recoveryRequired = {
      ...receiptFixture,
      status: 'rollback-failed' as const,
      failureCode: 'UPDATE_ROLLBACK_SMOKE_FAILED',
      rollbackVerified: false,
      recoveryRequired: true
    }
    const rolledBack = {
      ...receiptFixture,
      status: 'rolled-back' as const,
      resultingRevision: receiptFixture.previousRevision,
      failureCode: 'UPDATE_ROLLBACK_SMOKE_FAILED',
      rollbackVerified: true,
      rollbackSteps: {
        component: 'verified', configuration: 'verified', serverModLock: 'verified',
        pairedSave: 'verified', previousSaveLoad: 'verified'
      } as const,
      recoveryRequired: false
    }
    const getState = vi.fn()
      .mockResolvedValueOnce({ ...stateFixture, recoveryRequired: true })
      .mockResolvedValueOnce({ ...stateFixture, revision: rolledBack.resultingRevision, recoveryRequired: false })
      .mockResolvedValueOnce({ ...stateFixture, revision: rolledBack.resultingRevision, recoveryRequired: false })
    const service = createService({
      reconcile: vi.fn(async () => recoveryRequired),
      recoverInterrupted: vi.fn(async () => rolledBack),
      getReceipt: vi.fn(async () => ({ ...rolledBack, reused: false })),
      getState
    })
    const gate = vi.fn(() => true)
    const controller = new ComponentUpdateActivationHttpController({
      service,
      recoveryMutationGate: gate
    })

    expect(await controller.recover({
      requestId,
      confirmation: componentUpdateActivationRecoveryConfirmation
    })).toEqual({ statusCode: 202, body: { ok: true, data: rolledBack } })
    expect(gate).toHaveBeenCalledWith(requestId)
    expect(service.recoverInterrupted).toHaveBeenCalledWith(requestId)
    expect(await controller.recoveryStatus({})).toEqual({
      statusCode: 200,
      body: { ok: true, data: expect.objectContaining({
        phase: 'ready',
        mutationBlocked: false,
        recoveryRequired: false,
        reconciledRequestId: requestId
      }) }
    })
  })

  it('rejects a known recovery request mismatch before either gate or core', async () => {
    const pendingRequestId = receiptFixture.requestId
    const otherRequestId = randomUUID()
    const recoveryRequired = {
      ...receiptFixture,
      status: 'rollback-failed' as const,
      failureCode: 'UPDATE_ROLLBACK_SMOKE_FAILED',
      rollbackVerified: false,
      recoveryRequired: true
    }
    const gate = vi.fn(() => true)
    const service = createService({
      reconcile: vi.fn(async () => recoveryRequired),
      getState: vi.fn(async () => ({ ...stateFixture, recoveryRequired: true }))
    })
    const controller = new ComponentUpdateActivationHttpController({
      service,
      recoveryMutationGate: gate
    })

    expect(await controller.recover({
      requestId: otherRequestId,
      confirmation: componentUpdateActivationRecoveryConfirmation
    })).toEqual({
      statusCode: 409,
      body: { ok: false, error: { code: 'UPDATE_RECOVERY_REQUEST_MISMATCH' } }
    })
    expect(gate).not.toHaveBeenCalled()
    expect(service.recoverInterrupted).not.toHaveBeenCalled()
    expect((await controller.recoveryStatus({})).body).toEqual({
      ok: true,
      data: expect.objectContaining({
        phase: 'recovery-required',
        reconciledRequestId: pendingRequestId
      })
    })
  })

  it('keeps recovery blocked unless the returned terminal receipt was durably reread exactly', async () => {
    const recoveryRequired = {
      ...receiptFixture,
      status: 'rollback-failed' as const,
      failureCode: 'UPDATE_ROLLBACK_SMOKE_FAILED',
      rollbackVerified: false,
      recoveryRequired: true
    }
    const rolledBack = {
      ...receiptFixture,
      status: 'rolled-back' as const,
      resultingRevision: receiptFixture.previousRevision,
      failureCode: 'UPDATE_ROLLBACK_SMOKE_FAILED',
      rollbackVerified: true,
      rollbackSteps: {
        component: 'verified', configuration: 'verified', serverModLock: 'verified',
        pairedSave: 'verified', previousSaveLoad: 'verified'
      } as const,
      recoveryRequired: false
    }
    const service = createService({
      reconcile: vi.fn(async () => recoveryRequired),
      recoverInterrupted: vi.fn(async () => rolledBack),
      getReceipt: vi.fn(async () => ({ ...rolledBack, completedAt: '2026-08-30T10:00:01.000Z' })),
      getState: vi.fn()
        .mockResolvedValueOnce({ ...stateFixture, recoveryRequired: true })
        .mockResolvedValueOnce({ ...stateFixture, revision: rolledBack.resultingRevision })
    })
    const controller = new ComponentUpdateActivationHttpController({
      service,
      recoveryMutationGate: () => true
    })

    expect(await controller.recover({
      requestId: receiptFixture.requestId,
      confirmation: componentUpdateActivationRecoveryConfirmation
    })).toEqual({
      statusCode: 503,
      body: { ok: false, error: { code: 'UPDATE_RECOVERY_TERMINAL_UNPROVEN' } }
    })
    expect(service.getReceipt).toHaveBeenCalledWith(receiptFixture.requestId)
    expect((await controller.recoveryStatus({})).body).toEqual({
      ok: true,
      data: expect.objectContaining({
        phase: 'recovery-required',
        failureCode: 'UPDATE_RECOVERY_TERMINAL_UNPROVEN'
      })
    })
  })

  it.each([
    ['wrong revision', { ...stateFixture, revision: 'f'.repeat(64) }],
    ['wrong active component identity', {
      ...stateFixture,
      components: [{ ...stateFixture.components[0]!, releaseId: `nebula-${'f'.repeat(32)}` }]
    }]
  ])('keeps recovery blocked when durable state has %s', async (_label, terminalState) => {
    const recoveryRequired = {
      ...receiptFixture,
      status: 'rollback-failed' as const,
      failureCode: 'UPDATE_ROLLBACK_SMOKE_FAILED',
      rollbackVerified: false,
      recoveryRequired: true
    }
    const service = createService({
      reconcile: vi.fn(async () => recoveryRequired),
      recoverInterrupted: vi.fn(async () => receiptFixture),
      getReceipt: vi.fn(async () => receiptFixture),
      getState: vi.fn()
        .mockResolvedValueOnce({ ...stateFixture, recoveryRequired: true })
        .mockResolvedValueOnce(terminalState)
    })
    const controller = new ComponentUpdateActivationHttpController({
      service,
      recoveryMutationGate: () => true
    })

    expect(await controller.recover({
      requestId: receiptFixture.requestId,
      confirmation: componentUpdateActivationRecoveryConfirmation
    })).toEqual({
      statusCode: 503,
      body: { ok: false, error: { code: 'UPDATE_RECOVERY_TERMINAL_UNPROVEN' } }
    })
  })

  it('keeps recovery blocked when the core cannot prove a safe terminal result', async () => {
    const requestId = receiptFixture.requestId
    const recoveryRequired = {
      ...receiptFixture,
      status: 'rollback-failed' as const,
      failureCode: 'UPDATE_ROLLBACK_SMOKE_FAILED',
      rollbackVerified: false,
      recoveryRequired: true
    }
    const service = createService({
      reconcile: vi.fn(async () => recoveryRequired),
      recoverInterrupted: vi.fn(async () => recoveryRequired),
      getState: vi.fn(async () => ({ ...stateFixture, recoveryRequired: true }))
    })
    const controller = new ComponentUpdateActivationHttpController({
      service,
      recoveryMutationGate: () => true
    })

    expect((await controller.recover({
      requestId,
      confirmation: componentUpdateActivationRecoveryConfirmation
    })).statusCode).toBe(503)
    expect((await controller.recoveryStatus({})).body).toEqual({
      ok: true,
      data: expect.objectContaining({ phase: 'recovery-required', mutationBlocked: true })
    })
  })

  it.each([
    ['UPDATE_HOST_LEASE_DIRTY', 'recovery-required'],
    ['UPDATE_HOST_LEASE_LOST', 'recovery-required'],
    ['UPDATE_HOST_LEASE_RECOVERY_REQUIRED', 'recovery-required'],
    ['UPDATE_HOST_LEASE_BUSY', 'unavailable'],
    ['UPDATE_HOST_LEASE_UNAVAILABLE', 'unavailable']
  ] as const)('classifies startup host lease failure %s as %s without retrying', async (code, phase) => {
    const service = createService({
      reconcile: vi.fn(async () => { throw new ComponentUpdateActivationError(code) })
    })
    const controller = new ComponentUpdateActivationHttpController({ service, mutationGate: () => true })

    await controller.initialize()
    expect((await controller.recoveryStatus({})).body).toEqual({ ok: true, data: expect.objectContaining({
      phase,
      failureCode: code,
      mutationBlocked: true
    }) })
    expect(service.reconcile).toHaveBeenCalledOnce()
  })

  it('maps an unknown startup failure to one stable unavailable code without reflecting details', async () => {
    const service = createService({
      reconcile: vi.fn(async () => { throw new Error('C:\\private\\token=do-not-reflect') })
    })
    const controller = new ComponentUpdateActivationHttpController({ service, mutationGate: () => true })

    expect(await controller.execute(makeExecuteRequest())).toEqual({
      statusCode: 503,
      body: { ok: false, error: { code: 'UPDATE_ACTIVATION_HTTP_RECOVERY_UNAVAILABLE' } }
    })
    const status = await controller.recoveryStatus({})
    expect(status.body).toEqual({ ok: true, data: expect.objectContaining({
      phase: 'unavailable',
      failureCode: 'UPDATE_ACTIVATION_HTTP_RECOVERY_UNAVAILABLE'
    }) })
    expect(JSON.stringify(status)).not.toContain('do-not-reflect')
    expect(service.execute).not.toHaveBeenCalled()
  })

  it.each([
    ['UPDATE_RECOVERY_NOT_PENDING', 409],
    ['UPDATE_RECOVERY_REQUEST_MISMATCH', 409],
    ['UPDATE_HOST_LEASE_RECOVERY_NOT_REQUIRED', 409],
    ['UPDATE_HOST_LEASE_RECOVERY_MISMATCH', 409],
    ['UPDATE_RECOVERY_EVIDENCE_CHANGED', 503],
    ['UPDATE_RECOVERY_EVIDENCE_INVALID', 503],
    ['UPDATE_RECOVERY_TERMINAL_UNPROVEN', 503]
  ] as const)('preserves recovery core error %s as HTTP %i', async (code, statusCode) => {
    const service = createService({
      preview: vi.fn(async () => { throw new ComponentUpdateActivationError(code) })
    })

    expect(await new ComponentUpdateActivationHttpController({ service }).preview(makeRequest())).toEqual({
      statusCode,
      body: { ok: false, error: { code } }
    })
  })

  it('requires an exact component-specific confirmation before checking the gate', async () => {
    const service = createService()
    const gate = vi.fn(() => true)
    const controller = new ComponentUpdateActivationHttpController({ service, mutationGate: gate })

    expect(await controller.execute({
      ...makeRequest(),
      confirmation: componentUpdateActivationConfirmations.bridge
    })).toEqual({
      statusCode: 422,
      body: { ok: false, error: { code: 'UPDATE_ACTIVATION_HTTP_CONFIRMATION_INVALID' } }
    })
    expect(gate).not.toHaveBeenCalled()
    expect(service.execute).not.toHaveBeenCalled()
  })

  it('returns 202 for a first execution and 200 for a core-proven idempotent replay', async () => {
    const firstService = createService()
    const first = new ComponentUpdateActivationHttpController({
      service: firstService,
      mutationGate: () => true
    })
    expect(await first.execute(makeExecuteRequest())).toEqual({
      statusCode: 202,
      body: { ok: true, data: receiptFixture }
    })

    const reusedReceipt = { ...receiptFixture, reused: true }
    const replayService = createService({ execute: vi.fn(async () => reusedReceipt) })
    const replay = new ComponentUpdateActivationHttpController({
      service: replayService,
      mutationGate: () => true
    })
    expect(await replay.execute(makeExecuteRequest())).toEqual({
      statusCode: 200,
      body: { ok: true, data: reusedReceipt }
    })
  })

  it('preserves conflicts, local/host lock contention, and host lease failures as stable HTTP codes', async () => {
    for (const [code, statusCode] of [
      ['UPDATE_IDEMPOTENCY_CONFLICT', 409],
      ['UPDATE_ACTIVATION_LOCK_BUSY', 423],
      ['UPDATE_HOST_LEASE_BUSY', 423],
      ['UPDATE_HOST_LEASE_DIRTY', 503],
      ['UPDATE_HOST_LEASE_LOST', 503],
      ['UPDATE_HOST_LEASE_RECOVERY_REQUIRED', 503],
      ['UPDATE_HOST_LEASE_UNAVAILABLE', 503]
    ] as const) {
      const service = createService({
        execute: vi.fn(async () => { throw new ComponentUpdateActivationError(code) })
      })
      const controller = new ComponentUpdateActivationHttpController({ service, mutationGate: () => true })
      expect(await controller.execute(makeExecuteRequest())).toEqual({
        statusCode,
        body: { ok: false, error: { code } }
      })
    }
  })

  it('fails DSP closed as an explicit manual Steam-client operation without checking the gate', async () => {
    const service = createService()
    const gate = vi.fn(() => true)
    const controller = new ComponentUpdateActivationHttpController({ service, mutationGate: gate })
    const request = {
      requestId: randomUUID(),
      component: 'dsp',
      targetVersion: '0.10.33.26727',
      expectedRevision: '0'.repeat(64),
      confirmation: componentUpdateActivationConfirmations.dsp
    }

    const expected = {
      statusCode: 422,
      body: { ok: false, error: { code: 'UPDATE_DSP_MANUAL_STEAM_REQUIRED' } }
    }
    const { confirmation: _confirmation, ...previewRequest } = request
    expect(await controller.preview(previewRequest)).toEqual(expected)
    expect(await controller.execute(request)).toEqual(expected)
    expect(gate).not.toHaveBeenCalled()
    expect(service.execute).not.toHaveBeenCalled()
  })

  it('returns only stable codes and never reflects filesystem, input, or adapter errors', async () => {
    const sensitive = 'C:\\Users\\example\\Steam token=top-secret'
    const cases: Array<{ error: Error; expectedCode: string }> = [
      {
        error: new ComponentUpdateActivationError('UPDATE_ROOT_UNAVAILABLE', { cause: new Error(sensitive) }),
        expectedCode: 'UPDATE_ROOT_UNAVAILABLE'
      },
      { error: new Error(sensitive), expectedCode: 'UPDATE_ACTIVATION_HTTP_UNAVAILABLE' },
      {
        error: new UpdatePipelineError('UNTRUSTED_DYNAMIC_CODE', { cause: new Error(sensitive) }),
        expectedCode: 'UPDATE_ACTIVATION_HTTP_UNAVAILABLE'
      },
      {
        error: new UpdatePipelineError('UPDATE_ARCHIVE_C_USERS_ADMIN_TOKEN', { cause: new Error(sensitive) }),
        expectedCode: 'UPDATE_ACTIVATION_HTTP_UNAVAILABLE'
      }
    ]
    for (const testCase of cases) {
      const service = createService({
        preview: vi.fn(async () => { throw testCase.error })
      })
      const result = await new ComponentUpdateActivationHttpController({ service }).preview(makeRequest())
      expect(result).toEqual({
        statusCode: 503,
        body: { ok: false, error: { code: testCase.expectedCode } }
      })
      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain('example')
      expect(serialized).not.toContain('top-secret')
      expect(serialized).not.toContain('UNTRUSTED_DYNAMIC_CODE')
    }
  })

  it('maps validation, conflict, lock, and infrastructure core errors predictably', async () => {
    const cases = [
      ['UPDATE_STAGED_ARTIFACT_TAMPERED', 422],
      ['UPDATE_REVISION_CONFLICT', 409],
      ['UPDATE_SERVICE_STILL_RUNNING', 423],
      ['UPDATE_SAVE_PROTECTION_FAILED', 503]
    ] as const
    for (const [code, statusCode] of cases) {
      const service = createService({
        preview: vi.fn(async () => { throw new ComponentUpdateActivationError(code) })
      })
      expect(await new ComponentUpdateActivationHttpController({ service }).preview(makeRequest())).toEqual({
        statusCode,
        body: { ok: false, error: { code } }
      })
    }
  })

  it('gets receipts and exposes only the bounded state/history and cleanup previews', async () => {
    const service = createService()
    const controller = new ComponentUpdateActivationHttpController({ service })

    expect(await controller.getReceipt({ requestId: receiptFixture.requestId })).toEqual({
      statusCode: 200,
      body: { ok: true, data: receiptFixture }
    })
    expect(await controller.history({})).toEqual({
      statusCode: 200,
      body: { ok: true, data: stateFixture }
    })
    expect(await controller.previewCleanup({})).toEqual({
      statusCode: 200,
      body: { ok: true, data: cleanupFixture }
    })

    const missing = createService({ getReceipt: vi.fn(async () => null) })
    expect(await new ComponentUpdateActivationHttpController({ service: missing }).getReceipt({
      requestId: randomUUID()
    })).toEqual({
      statusCode: 404,
      body: { ok: false, error: { code: 'UPDATE_ACTIVATION_RECEIPT_NOT_FOUND' } }
    })

    expect(await controller.history({ path: 'C:\\private' })).toEqual(invalidRequest)
    expect(await controller.recoveryStatus({ path: 'C:\\private' })).toEqual(invalidRequest)
    expect(await controller.previewCleanup({ command: 'remove' })).toEqual(invalidRequest)
    expect(await controller.getReceipt({ requestId: 'not-a-uuid' })).toEqual(invalidRequest)
    expect(await controller.getReceipt({ requestId: receiptFixture.requestId, path: 'C:\\private' })).toEqual(invalidRequest)
  })

  it('turns a gate exception into a code-only 503 without invoking the core', async () => {
    const service = createService()
    const controller = new ComponentUpdateActivationHttpController({
      service,
      mutationGate: () => { throw new Error('C:\\private\\gate-config') }
    })
    const result = await controller.execute(makeExecuteRequest())
    expect(result).toEqual({
      statusCode: 503,
      body: { ok: false, error: { code: 'UPDATE_ACTIVATION_HTTP_GATE_UNAVAILABLE' } }
    })
    expect(JSON.stringify(result)).not.toContain('gate-config')
    expect(service.execute).not.toHaveBeenCalled()
  })
})

const invalidRequest = {
  statusCode: 422,
  body: { ok: false, error: { code: 'UPDATE_ACTIVATION_HTTP_REQUEST_INVALID' } }
} as const

function makeRequest(): UpdateActivationRequest {
  return {
    requestId: receiptFixture.requestId,
    component: 'nebula',
    artifactId: 'nebula-artifact-0001',
    sha256: 'a'.repeat(64),
    targetVersion: '0.9.1',
    expectedRevision: '0'.repeat(64),
    compatibilityReceiptId: '118f47a0-7d5b-7abc-8def-0123456789ab'
  }
}

function makeExecuteRequest(): UpdateActivationRequest & { confirmation: string } {
  return { ...makeRequest(), confirmation: componentUpdateActivationConfirmations.nebula }
}

function createService(overrides: Partial<ComponentUpdateActivationHttpService> = {}) {
  return {
    preview: vi.fn(async () => planFixture),
    execute: vi.fn(async () => receiptFixture),
    reconcile: vi.fn(async () => null),
    recoverInterrupted: vi.fn(async () => receiptFixture),
    getReceipt: vi.fn(async () => receiptFixture),
    getState: vi.fn(async () => stateFixture),
    previewCleanup: vi.fn(async () => cleanupFixture),
    ...overrides
  } satisfies ComponentUpdateActivationHttpService
}

const planFixture: ComponentUpdateActivationPlan = {
  format: 'dyson-control-component-update-plan',
  schemaVersion: 1,
  dryRun: true,
  requestId: '018f47a0-7d5b-7abc-8def-0123456789ab',
  component: 'nebula',
  artifactId: 'nebula-artifact-0001',
  targetVersion: '0.9.1',
  expectedRevision: '0'.repeat(64),
  compatibilityReceiptId: '118f47a0-7d5b-7abc-8def-0123456789ab',
  releaseId: `nebula-${'1'.repeat(32)}`,
  fileCount: 1,
  expandedBytes: 32_768,
  compatibility: {
    compatible: true,
    matchedEntryId: 'candidate',
    inventory: { dsp: '0.10.33.26727', nebula: '0.9.1', bepInEx: '5.4.22', plugins: [] },
    evaluations: [{ entryId: 'candidate', compatible: true, reasons: [] }]
  },
  operations: [
    'acquire-global-update-lock',
    'verify-staged-artifact-and-archive',
    'assemble-immutable-release',
    'prove-process-stopped-and-port-closed',
    'capture-config-mod-lock-and-loaded-save-baseline',
    'create-paired-save-protection-point',
    'bind-rollback-context-journal',
    'revalidate-stop-revision-and-compatibility',
    'publish-and-verify-fixed-live-component',
    'run-fixed-health-check',
    'restore-component-config-mod-lock-and-paired-save-on-failure',
    'prove-current-generation-exact-save-load',
    'persist-audit-safe-receipt',
    'release-global-update-lock'
  ],
  rollback: { automatic: true, previousReleaseRequired: false, recoveryRequiredIfUnproven: true }
}

const receiptFixture: ComponentUpdateActivationReceipt = {
  format: 'dyson-control-component-update-receipt',
  schemaVersion: 1,
  requestId: '018f47a0-7d5b-7abc-8def-0123456789ab',
  component: 'nebula',
  artifactId: 'nebula-artifact-0001',
  compatibilityReceiptId: '118f47a0-7d5b-7abc-8def-0123456789ab',
  targetVersion: '0.9.1',
  releaseId: `nebula-${'1'.repeat(32)}`,
  status: 'succeeded',
  previousRevision: '0'.repeat(64),
  resultingRevision: '1'.repeat(64),
  protectionBackupId: 'backup-0001',
  rollbackBindingSha256: '2'.repeat(64),
  rollbackSteps: {
    component: 'not-required', configuration: 'not-required', serverModLock: 'not-required',
    pairedSave: 'not-required', previousSaveLoad: 'not-required'
  },
  failureCode: null,
  rollbackVerified: false,
  recoveryRequired: false,
  fileCount: 1,
  expandedBytes: 32_768,
  completedAt: '2026-08-30T10:00:00.000Z',
  reused: false
}

const stateFixture: ComponentUpdateStateSummary = {
  revision: '1'.repeat(64),
  recoveryRequired: false,
  components: [{
    component: 'nebula',
    version: '0.9.1',
    artifactId: 'nebula-artifact-0001',
    releaseId: `nebula-${'1'.repeat(32)}`
  }],
  historyEntries: 1
}

const cleanupFixture: ComponentUpdateCleanupPlan = {
  format: 'dyson-control-component-update-cleanup-plan',
  schemaVersion: 1,
  dryRun: true,
  executeSupported: false,
  candidates: []
}

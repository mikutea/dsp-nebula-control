import { describe, expect, it, vi } from 'vitest'
import type { CutoverAuditEventStore, CutoverAuditStartedEvent } from './audit.js'
import {
  CutoverHttpController,
  RECOVER_GSMANAGER_CUTOVER,
  type CutoverHttpService
} from './http.js'
import {
  ACTIVATE_GSMANAGER_TO_DYSON,
  PREPARE_GSMANAGER_TO_DYSON,
  ROLLBACK_DYSON_TO_GSMANAGER,
  CutoverError,
  type CutoverReceipt,
  type CutoverRecoveryStatus
} from './types.js'

const requestId = '5f855c08-7504-4da4-93f2-5bc512014747'
const otherRequestId = '8a2701a7-c4d5-4f4b-92bf-1dfe05452a63'
const planFingerprint = 'b'.repeat(64)

describe('cutover HTTP controller', () => {
  it('prepares through the ordinary gate and returns 202 for a first receipt', async () => {
    const service = createService()
    const ordinaryMutationGate = vi.fn(async () => true)
    const recoveryMutationGate = vi.fn(async () => false)
    const controller = new CutoverHttpController({
      service,
      ordinaryMutationGate,
      recoveryMutationGate
    })

    const result = await controller.prepare({ planFingerprint, confirmation: PREPARE_GSMANAGER_TO_DYSON, requestId: requestId.toUpperCase() })

    expect(result).toEqual(ok(202, receipt()))
    expect(ordinaryMutationGate).toHaveBeenCalledWith({ operation: 'prepare', requestId })
    expect(service.prepare).toHaveBeenCalledWith({
      requestId,
      planFingerprint, confirmation: PREPARE_GSMANAGER_TO_DYSON
    })
    expect(recoveryMutationGate).not.toHaveBeenCalled()
  })

  it('returns a strict read-only server preview without opening either mutation gate or audit pair', async () => {
    const service = createService()
    const audit = createAudit()
    const ordinaryMutationGate = vi.fn(async () => true)
    const controller = new CutoverHttpController({ service, audit, ordinaryMutationGate })

    const result = await controller.preview({
      requestId: requestId.toUpperCase(),
      operation: 'prepare'
    })

    expect(result).toEqual(ok(200, {
      format: 'dyson-control-cutover-preview',
      schemaVersion: 1,
      operation: 'prepare',
      requestId,
      rollbackMode: null,
      stateRevision: 'c'.repeat(64),
      evidenceDigest: 'd'.repeat(64),
      planFingerprint,
      summary: summary()
    }))
    expect(service.preview).toHaveBeenCalledWith({ requestId, operation: 'prepare' })
    expect(ordinaryMutationGate).not.toHaveBeenCalled()
    expect(audit.begin).not.toHaveBeenCalled()
    expect(audit.complete).not.toHaveBeenCalled()
  })

  it('rejects a missing execute preview before recovery, audit, gate, or service access', async () => {
    const service = createService()
    const audit = createAudit()
    const ordinaryMutationGate = vi.fn(async () => true)
    const controller = new CutoverHttpController({ service, audit, ordinaryMutationGate })

    expect(await controller.prepare({
      requestId,
      confirmation: PREPARE_GSMANAGER_TO_DYSON
    }, { actorRole: 'administrator' })).toEqual(failure(409, 'CUTOVER_PREVIEW_REQUIRED'))
    expect(service.recoveryStatus).not.toHaveBeenCalled()
    expect(service.prepare).not.toHaveBeenCalled()
    expect(ordinaryMutationGate).not.toHaveBeenCalled()
    expect(audit.begin).not.toHaveBeenCalled()
    expect(audit.complete).not.toHaveBeenCalled()
  })

  it.each([
    ['wrong request id', { requestId: otherRequestId }],
    ['wrong phase', { phase: 'activated' as const }],
    ['failed-safe status', { status: 'failed-safe' as const }],
    ['non-null error', { errorCode: 'CUTOVER_RUNTIME_DRIFT' as const }],
    ['non-empty allowed desired', { allowedDesired: ['previous'] as const }]
  ])('fails closed for a structurally valid but %s prepare receipt without success audit', async (
    _name,
    patch
  ) => {
    const service = createService()
    service.prepare.mockResolvedValue({ ...receipt(), ...patch } as CutoverReceipt)
    const audit = createAudit()
    const controller = new CutoverHttpController({
      service,
      audit,
      ordinaryMutationGate: () => true
    })

    expect(await controller.prepare({
      requestId,
      planFingerprint,
      confirmation: PREPARE_GSMANAGER_TO_DYSON
    }, { actorRole: 'administrator' })).toEqual(
      failure(503, 'CUTOVER_HTTP_RECEIPT_INVALID')
    )
    expect(audit.complete).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failed',
      httpStatus: 503,
      errorCode: 'CUTOVER_HTTP_RECEIPT_INVALID'
    }))
    expect(vi.mocked(audit.complete).mock.calls.some(([entry]) => entry.outcome === 'succeeded')).toBe(false)
  })

  it('returns 200 only when the bounded receipt proves an idempotent replay', async () => {
    const service = createService()
    service.prepare.mockResolvedValue(receipt({ reused: true }))
    const controller = makeController(service)

    expect(await controller.prepare({ requestId, planFingerprint, confirmation: PREPARE_GSMANAGER_TO_DYSON })).toEqual(ok(200, receipt({ reused: true })))
  })

  it.each([
    ['missing confirmation', { requestId }, 'CUTOVER_CONFIRMATION_REQUIRED'],
    ['wrong confirmation', { requestId, confirmation: 'PREPARE' }, 'CUTOVER_CONFIRMATION_REQUIRED'],
    ['unknown field', {
      requestId,
      planFingerprint, confirmation: PREPARE_GSMANAGER_TO_DYSON,
      task: 'private-host-task'
    }, 'CUTOVER_REQUEST_INVALID']
  ] as const)('rejects prepare with %s before audit, gate, or service', async (_name, input, code) => {
    const service = createService()
    const audit = createAudit()
    const ordinaryMutationGate = vi.fn(async () => true)
    const controller = new CutoverHttpController({ service, audit, ordinaryMutationGate })

    expect(await controller.prepare(input, { actorRole: 'administrator' }))
      .toEqual(failure(422, code))
    expect(service.recoveryStatus).not.toHaveBeenCalled()
    expect(service.prepare).not.toHaveBeenCalled()
    expect(ordinaryMutationGate).not.toHaveBeenCalled()
    expect(audit.begin).not.toHaveBeenCalled()
    expect(audit.complete).not.toHaveBeenCalled()
  })

  it('strictly validates activation and rollback before either gate or service', async () => {
    const service = createService()
    const ordinaryMutationGate = vi.fn(async () => true)
    const controller = makeController(service, { ordinaryMutationGate })

    expect(await controller.activate({ requestId, confirmation: 'ACTIVATE' })).toEqual(
      failure(422, 'CUTOVER_CONFIRMATION_REQUIRED')
    )
    expect(await controller.activate({
      requestId,
      planFingerprint, confirmation: ACTIVATE_GSMANAGER_TO_DYSON,
      path: 'C:\\private\\never-reflect'
    })).toEqual(failure(422, 'CUTOVER_REQUEST_INVALID'))
    expect(await controller.rollback({
      requestId,
      mode: 'immediate-compensation',
      confirmation: 'ROLLBACK'
    })).toEqual(failure(422, 'CUTOVER_ROLLBACK_CONFIRMATION_REQUIRED'))
    expect(await controller.rollback({
      requestId: 'not-a-uuid',
      mode: 'immediate-compensation',
      planFingerprint, confirmation: ROLLBACK_DYSON_TO_GSMANAGER
    })).toEqual(failure(422, 'CUTOVER_REQUEST_INVALID'))

    expect(ordinaryMutationGate).not.toHaveBeenCalled()
    expect(service.activate).not.toHaveBeenCalled()
    expect(service.rollback).not.toHaveBeenCalled()
  })

  it('passes only fixed activation and rollback DTOs to the service', async () => {
    const service = createService()
    const controller = makeController(service)

    expect(await controller.activate({
      requestId,
      planFingerprint, confirmation: ACTIVATE_GSMANAGER_TO_DYSON
    })).toEqual(ok(202, operationReceipt('activated', 'succeeded')))
    expect(service.activate).toHaveBeenCalledWith({
      requestId,
      planFingerprint, confirmation: ACTIVATE_GSMANAGER_TO_DYSON
    })

    expect(await controller.rollback({
      requestId,
      mode: 'later-operator-rollback',
      planFingerprint, confirmation: ROLLBACK_DYSON_TO_GSMANAGER
    })).toEqual(ok(202, operationReceipt('rolled-back-later', 'rolled-back')))
    expect(service.rollback).toHaveBeenCalledWith({
      requestId,
      mode: 'later-operator-rollback',
      planFingerprint, confirmation: ROLLBACK_DYSON_TO_GSMANAGER
    })
  })

  it('fails closed when the ordinary mutation gate is disabled or unavailable', async () => {
    const disabledService = createService()
    const disabled = new CutoverHttpController({
      service: disabledService,
      ordinaryMutationGate: () => false,
      recoveryMutationGate: () => true
    })
    expect(await disabled.prepare({ requestId, planFingerprint, confirmation: PREPARE_GSMANAGER_TO_DYSON })).toEqual(
      failure(423, 'CUTOVER_HTTP_MUTATION_DISABLED')
    )
    expect(disabledService.prepare).not.toHaveBeenCalled()

    const unavailableService = createService()
    const unavailable = new CutoverHttpController({
      service: unavailableService,
      ordinaryMutationGate: () => { throw new Error('private gate detail') },
      recoveryMutationGate: () => true
    })
    expect(await unavailable.prepare({ requestId, planFingerprint, confirmation: PREPARE_GSMANAGER_TO_DYSON })).toEqual(
      failure(503, 'CUTOVER_HTTP_GATE_UNAVAILABLE')
    )
    expect(unavailableService.prepare).not.toHaveBeenCalled()
  })

  it('initializes into recovery-required and blocks ordinary mutations before their gate', async () => {
    const service = createService()
    service.recoveryStatus.mockResolvedValue(requiredStatus())
    const ordinaryMutationGate = vi.fn(async () => true)
    const controller = makeController(service, { ordinaryMutationGate })

    await controller.initialize()
    expect(await controller.recoveryStatus({})).toEqual(ok(200, {
      schemaVersion: 1,
      phase: 'recovery-required',
      status: 'interrupted',
      mutationBlocked: true,
      recoveryRequired: true,
      requestId,
      allowedDesired: ['previous'],
      summary: summary(),
      errorCode: 'CUTOVER_RECOVERY_REQUIRED'
    }))
    expect(await controller.activate({
      requestId,
      planFingerprint, confirmation: ACTIVATE_GSMANAGER_TO_DYSON
    })).toEqual(failure(503, 'CUTOVER_RECOVERY_REQUIRED'))
    expect(ordinaryMutationGate).not.toHaveBeenCalled()
    expect(service.activate).not.toHaveBeenCalled()
  })

  it('keeps read-only recovery status available when reconciliation is unavailable', async () => {
    const service = createService()
    service.recoveryStatus.mockRejectedValue(new Error('C:\\private\\scheduler.xml'))
    const controller = makeController(service)

    const status = await controller.recoveryStatus({})
    expect(status).toEqual(ok(200, {
      schemaVersion: 1,
      phase: 'unavailable',
      status: 'unavailable',
      mutationBlocked: true,
      recoveryRequired: false,
      requestId: null,
      allowedDesired: [],
      summary: summary(),
      errorCode: 'CUTOVER_HTTP_RECOVERY_UNAVAILABLE'
    }))
    expect(JSON.stringify(status)).not.toContain('scheduler.xml')
    expect(await controller.prepare({ requestId, planFingerprint, confirmation: PREPARE_GSMANAGER_TO_DYSON })).toEqual(
      failure(503, 'CUTOVER_HTTP_RECOVERY_UNAVAILABLE')
    )
    expect(service.prepare).not.toHaveBeenCalled()
  })

  it('treats an incoherent ready recovery envelope as unavailable and never opens the gate', async () => {
    const service = createService()
    service.recoveryStatus.mockResolvedValue({
      ...readyStatus(),
      status: 'evidence-invalid',
      errorCode: 'CUTOVER_RECOVERY_EVIDENCE_INVALID'
    })
    const ordinaryMutationGate = vi.fn(async () => true)
    const controller = makeController(service, { ordinaryMutationGate })

    const status = await controller.recoveryStatus({})
    expect(status.body).toMatchObject({
      ok: true,
      data: {
        phase: 'unavailable',
        mutationBlocked: true,
        errorCode: 'CUTOVER_HTTP_RECOVERY_UNAVAILABLE'
      }
    })
    expect(await controller.prepare({ requestId, planFingerprint, confirmation: PREPARE_GSMANAGER_TO_DYSON })).toEqual(
      failure(503, 'CUTOVER_HTTP_RECOVERY_UNAVAILABLE')
    )
    expect(ordinaryMutationGate).not.toHaveBeenCalled()
    expect(service.prepare).not.toHaveBeenCalled()
  })

  it('strictly validates recovery confirmation and request identity before its gate', async () => {
    const service = createService()
    service.recoveryStatus.mockResolvedValue(requiredStatus())
    const recoveryMutationGate = vi.fn(async () => true)
    const controller = makeController(service, { recoveryMutationGate })

    expect(await controller.recover({ requestId, desired: 'previous', confirmation: 'RECOVER' })).toEqual(
      failure(422, 'CUTOVER_HTTP_RECOVERY_CONFIRMATION_REQUIRED')
    )
    expect(await controller.recover({
      requestId: 'not-a-uuid',
      desired: 'previous',
      confirmation: RECOVER_GSMANAGER_CUTOVER
    })).toEqual(failure(422, 'CUTOVER_REQUEST_INVALID'))
    expect(await controller.recover({
      requestId,
      desired: 'previous',
      confirmation: RECOVER_GSMANAGER_CUTOVER,
      command: 'private-command'
    })).toEqual(failure(422, 'CUTOVER_REQUEST_INVALID'))
    expect(await controller.recover({
      requestId: otherRequestId,
      desired: 'previous',
      confirmation: RECOVER_GSMANAGER_CUTOVER
    })).toEqual(failure(409, 'CUTOVER_HTTP_RECOVERY_REQUEST_MISMATCH'))
    expect(await controller.recover({
      requestId,
      desired: 'candidate',
      confirmation: RECOVER_GSMANAGER_CUTOVER
    })).toEqual(failure(409, 'CUTOVER_RECOVERY_TARGET_NOT_ALLOWED'))

    expect(recoveryMutationGate).not.toHaveBeenCalled()
    expect(service.recoverInterrupted).not.toHaveBeenCalled()
  })

  it('uses a separate recovery gate and never lets the ordinary gate authorize recovery', async () => {
    const service = createService()
    service.recoveryStatus.mockResolvedValue(requiredStatus())
    const ordinaryMutationGate = vi.fn(async () => true)
    const recoveryMutationGate = vi.fn(async () => false)
    const controller = new CutoverHttpController({
      service,
      ordinaryMutationGate,
      recoveryMutationGate
    })

    expect(await controller.recover({
      requestId,
      desired: 'previous',
      confirmation: RECOVER_GSMANAGER_CUTOVER
    })).toEqual(failure(423, 'CUTOVER_HTTP_RECOVERY_MUTATION_DISABLED'))
    expect(ordinaryMutationGate).not.toHaveBeenCalled()
    expect(recoveryMutationGate).toHaveBeenCalledWith({ requestId, desired: 'previous' })
    expect(service.recoverInterrupted).not.toHaveBeenCalled()
  })

  it('recovers with only requestId and desired, re-proves ready state, and returns 202', async () => {
    const service = createService()
    let recovered = false
    service.recoveryStatus.mockImplementation(async () =>
      recovered ? readyStatus() : requiredStatus()
    )
    service.recoverInterrupted.mockImplementation(async () => {
      recovered = true
      return operationReceipt('recovered-previous', 'rolled-back')
    })
    const recoveryMutationGate = vi.fn(async () => true)
    const controller = makeController(service, { recoveryMutationGate })

    const result = await controller.recover({
      requestId,
      desired: 'previous',
      confirmation: RECOVER_GSMANAGER_CUTOVER
    })

    expect(result).toEqual(ok(202, operationReceipt('recovered-previous', 'rolled-back')))
    expect(service.recoverInterrupted).toHaveBeenCalledWith({ requestId, desired: 'previous' })
    expect(service.recoverInterrupted.mock.calls[0]?.[0]).not.toHaveProperty('confirmation')
    expect(service.recoveryStatus.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('returns 200 for a recovered replay only after ready state is re-proved', async () => {
    const service = createService()
    let recovered = false
    service.recoveryStatus.mockImplementation(async () =>
      recovered ? readyStatus() : requiredStatus()
    )
    service.recoverInterrupted.mockImplementation(async () => {
      recovered = true
      return operationReceipt('recovered-previous', 'rolled-back', { reused: true })
    })
    const controller = makeController(service, { recoveryMutationGate: () => true })

    expect(await controller.recover({
      requestId,
      desired: 'previous',
      confirmation: RECOVER_GSMANAGER_CUTOVER
    })).toEqual(ok(200, operationReceipt('recovered-previous', 'rolled-back', { reused: true })))
  })

  it('rejects an unproven recovery terminal even when the service returned a receipt', async () => {
    const service = createService()
    service.recoveryStatus.mockResolvedValue(requiredStatus())
    const controller = makeController(service, { recoveryMutationGate: () => true })

    expect(await controller.recover({
      requestId,
      desired: 'previous',
      confirmation: RECOVER_GSMANAGER_CUTOVER
    })).toEqual(failure(503, 'CUTOVER_HTTP_RECOVERY_TERMINAL_UNPROVEN'))
  })

  it.each([
    ['CUTOVER_REQUEST_INVALID', 422],
    ['CUTOVER_IDEMPOTENCY_CONFLICT', 409],
    ['CUTOVER_HOST_LEASE_BUSY', 423],
    ['CUTOVER_HOST_LEASE_LOST', 503]
  ] as const)('maps service error %s to %i with a code-only envelope', async (code, statusCode) => {
    const service = createService()
    service.prepare.mockRejectedValue(new CutoverError(code, {
      receipt: { ...receipt(), internalPath: 'C:\\private\\journal.json' } as CutoverReceipt
    }))
    const controller = makeController(service)

    const result = await controller.prepare({ requestId, planFingerprint, confirmation: PREPARE_GSMANAGER_TO_DYSON })
    expect(result).toEqual(failure(statusCode, code))
    expect(JSON.stringify(result)).not.toContain('journal.json')
    expect(Object.keys(result.body)).toEqual(['ok', 'error'])
  })

  it('maps unknown exceptions and malformed service envelopes to one non-leaking code', async () => {
    const throwingService = createService()
    throwingService.prepare.mockRejectedValue(new Error('C:\\private\\task.xml secret-token'))
    const unknown = await makeController(throwingService).prepare({ requestId, planFingerprint, confirmation: PREPARE_GSMANAGER_TO_DYSON })
    expect(unknown).toEqual(failure(503, 'CUTOVER_HTTP_UNAVAILABLE'))
    expect(JSON.stringify(unknown)).not.toContain('private')

    const malformedService = createService()
    malformedService.prepare.mockResolvedValue({
      ...receipt(),
      internalPath: 'C:\\private\\receipt.json'
    } as CutoverReceipt)
    const malformed = await makeController(malformedService).prepare({ requestId, planFingerprint, confirmation: PREPARE_GSMANAGER_TO_DYSON })
    expect(malformed).toEqual(failure(503, 'CUTOVER_HTTP_UNAVAILABLE'))
    expect(JSON.stringify(malformed)).not.toContain('receipt.json')
  })

  it('strictly validates the otherwise always-available status request', async () => {
    const service = createService()
    const controller = makeController(service)

    expect(await controller.recoveryStatus({ path: 'C:\\private' })).toEqual(
      failure(422, 'CUTOVER_REQUEST_INVALID')
    )
    expect(service.recoveryStatus).not.toHaveBeenCalled()
  })

  it('persists the audit start before a mutation and its immutable terminal result afterwards', async () => {
    const order: string[] = []
    const audit = createAudit(order)
    const service = createService()
    service.prepare.mockImplementation(async () => {
      expect(order).toEqual(['begin'])
      order.push('service')
      return receipt()
    })
    const controller = new CutoverHttpController({
      service,
      audit,
      ordinaryMutationGate: () => true
    })

    expect(await controller.prepare({ requestId, planFingerprint, confirmation: PREPARE_GSMANAGER_TO_DYSON }, { actorRole: 'administrator' }))
      .toEqual(ok(202, receipt()))
    expect(order).toEqual(['begin', 'service', 'complete'])
    expect(audit.begin).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'prepare', requestId, actorRole: 'administrator'
    }))
    const started = vi.mocked(audit.begin).mock.calls[0]![0]
    expect(started.attemptId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    expect(audit.complete).toHaveBeenCalledWith({
      attemptId: started.attemptId,
      outcome: 'succeeded',
      httpStatus: 202,
      receiptPhase: 'prepared',
      receiptReused: false
    })
  })

  it('blocks service execution when audit begin or the authenticated mutation context is unavailable', async () => {
    const service = createService()
    const audit = createAudit()
    vi.mocked(audit.begin).mockRejectedValueOnce(new Error('private audit path'))
    const controller = new CutoverHttpController({
      service,
      audit,
      ordinaryMutationGate: () => true
    })

    expect(await controller.prepare({ requestId, planFingerprint, confirmation: PREPARE_GSMANAGER_TO_DYSON }, { actorRole: 'administrator' }))
      .toEqual(failure(503, 'CUTOVER_HTTP_AUDIT_UNAVAILABLE'))
    expect(await controller.prepare({ requestId, planFingerprint, confirmation: PREPARE_GSMANAGER_TO_DYSON }))
      .toEqual(failure(503, 'CUTOVER_HTTP_AUDIT_UNAVAILABLE'))
    expect(service.prepare).not.toHaveBeenCalled()
  })

  it('returns an incomplete-audit failure after a completed idempotent service mutation', async () => {
    const service = createService()
    const audit = createAudit()
    vi.mocked(audit.complete).mockRejectedValueOnce(new Error('private sqlite detail'))
    const controller = new CutoverHttpController({
      service,
      audit,
      ordinaryMutationGate: () => true
    })

    expect(await controller.prepare({ requestId, planFingerprint, confirmation: PREPARE_GSMANAGER_TO_DYSON }, { actorRole: 'administrator' }))
      .toEqual(failure(503, 'CUTOVER_HTTP_AUDIT_INCOMPLETE'))
    expect(service.prepare).toHaveBeenCalledTimes(1)
    expect(audit.begin).toHaveBeenCalledTimes(1)
    expect(audit.complete).toHaveBeenCalledTimes(1)
  })

  it('preserves the exact core recovery target in status after an audit terminal failure', async () => {
    const service = createService()
    service.recoveryStatus.mockResolvedValue(requiredStatus())
    const audit = createAudit()
    vi.mocked(audit.complete).mockRejectedValueOnce(new Error('private sqlite terminal detail'))
    const controller = new CutoverHttpController({
      service,
      audit,
      ordinaryMutationGate: () => true,
      recoveryMutationGate: () => true
    })

    expect(await controller.prepare({ requestId, planFingerprint, confirmation: PREPARE_GSMANAGER_TO_DYSON }, { actorRole: 'administrator' }))
      .toEqual(failure(503, 'CUTOVER_HTTP_AUDIT_INCOMPLETE'))
    expect(await controller.recoveryStatus({})).toEqual(ok(200, {
      schemaVersion: 1,
      phase: 'recovery-required',
      status: 'interrupted',
      mutationBlocked: true,
      recoveryRequired: true,
      requestId,
      allowedDesired: ['previous'],
      summary: summary(),
      errorCode: 'CUTOVER_RECOVERY_REQUIRED'
    }))
    expect(service.prepare).not.toHaveBeenCalled()
  })

  it('keeps recovery status visible but executes no recovery while audit reconciliation stays unavailable', async () => {
    const service = createService()
    service.recoveryStatus.mockResolvedValue(requiredStatus())
    const audit = createAudit()
    vi.mocked(audit.complete).mockRejectedValueOnce(new Error('private sqlite terminal detail'))
    const controller = new CutoverHttpController({
      service,
      audit,
      ordinaryMutationGate: () => true,
      recoveryMutationGate: () => true
    })

    expect(await controller.prepare({ requestId, planFingerprint, confirmation: PREPARE_GSMANAGER_TO_DYSON }, { actorRole: 'administrator' }))
      .toEqual(failure(503, 'CUTOVER_HTTP_AUDIT_INCOMPLETE'))
    vi.mocked(audit.listIncomplete).mockRejectedValue(new Error('private sqlite read detail'))
    expect((await controller.recoveryStatus({})).body).toMatchObject({
      ok: true,
      data: { phase: 'recovery-required', requestId, allowedDesired: ['previous'] }
    })
    expect(await controller.recover({
      requestId,
      desired: 'previous',
      confirmation: RECOVER_GSMANAGER_CUTOVER
    }, { actorRole: 'administrator' })).toEqual(
      failure(503, 'CUTOVER_HTTP_AUDIT_UNAVAILABLE')
    )
    expect(audit.begin).toHaveBeenCalledTimes(1)
    expect(service.recoverInterrupted).not.toHaveBeenCalled()
  })

  it('latches a failed terminal append and blocks a different mutation until exact receipt reconciliation', async () => {
    const service = createService()
    service.prepare.mockImplementation(async (input) => ({
      ...receipt(),
      requestId: input.requestId
    }))
    const starts: ReturnType<typeof incompleteAuditStart>[] = []
    const completed = new Set<string>()
    let failFirstTerminal = true
    const audit: CutoverAuditEventStore = {
      begin: vi.fn(async (input) => {
        const started = incompleteAuditStart({ ...input })
        starts.push(started)
        return started
      }),
      complete: vi.fn(async (input) => {
        if (failFirstTerminal) {
          failFirstTerminal = false
          throw new Error('private sqlite terminal detail')
        }
        completed.add(input.attemptId)
        return { ...input } as never
      }),
      listIncomplete: vi.fn(async () => starts.filter((entry) => !completed.has(entry.attemptId))),
      listRecent: vi.fn(async () => [])
    }
    const controller = new CutoverHttpController({
      service,
      audit,
      ordinaryMutationGate: () => true
    })

    expect(await controller.prepare({ requestId, planFingerprint, confirmation: PREPARE_GSMANAGER_TO_DYSON }, { actorRole: 'administrator' }))
      .toEqual(failure(503, 'CUTOVER_HTTP_AUDIT_INCOMPLETE'))
    service.getReceiptForAudit.mockRejectedValueOnce(new Error('private durable store detail'))

    expect(await controller.prepare({ planFingerprint, confirmation: PREPARE_GSMANAGER_TO_DYSON, requestId: otherRequestId }, { actorRole: 'administrator' }))
      .toEqual(failure(503, 'CUTOVER_HTTP_AUDIT_UNAVAILABLE'))
    expect(service.prepare).toHaveBeenCalledTimes(1)
    expect(audit.begin).toHaveBeenCalledTimes(1)

    service.getReceiptForAudit.mockResolvedValue({
      match: 'matched',
      storedOperation: 'prepare',
      receipt: receipt()
    })
    expect(await controller.prepare({ planFingerprint, confirmation: PREPARE_GSMANAGER_TO_DYSON, requestId: otherRequestId }, { actorRole: 'administrator' }))
      .toEqual(ok(202, { ...receipt(), requestId: otherRequestId }))
    expect(service.prepare).toHaveBeenCalledTimes(2)
    expect(audit.begin).toHaveBeenCalledTimes(2)
    expect(service.getReceiptForAudit).toHaveBeenCalledWith({
      requestId,
      operation: 'prepare',
      planFingerprint,
      rollbackMode: null,
      desired: null
    })
  })

  it('does not let status polling reconcile an active audit attempt and serializes mutations', async () => {
    const service = createService()
    const entered = deferred<void>()
    const release = deferred<void>()
    service.prepare.mockImplementation(async () => {
      entered.resolve()
      await release.promise
      return receipt()
    })
    let active: ReturnType<typeof incompleteAuditStart> | null = null
    let terminal = false
    const audit: CutoverAuditEventStore = {
      begin: vi.fn(async (input) => {
        active = incompleteAuditStart({ ...input })
        return active
      }),
      complete: vi.fn(async (input) => {
        terminal = true
        return { ...input } as never
      }),
      listIncomplete: vi.fn(async () => active !== null && !terminal ? [active] : []),
      listRecent: vi.fn(async () => [])
    }
    const controller = new CutoverHttpController({
      service,
      audit,
      ordinaryMutationGate: () => true
    })

    const mutation = controller.prepare({ requestId, planFingerprint, confirmation: PREPARE_GSMANAGER_TO_DYSON }, { actorRole: 'administrator' })
    await entered.promise
    const scansBeforeStatus = vi.mocked(audit.listIncomplete).mock.calls.length
    expect((await controller.recoveryStatus({})).statusCode).toBe(200)
    expect(vi.mocked(audit.listIncomplete).mock.calls.length).toBe(scansBeforeStatus)
    expect(audit.complete).not.toHaveBeenCalled()
    expect(service.getReceiptForAudit).not.toHaveBeenCalled()
    expect(await controller.activate({
      requestId: otherRequestId,
      planFingerprint, confirmation: ACTIVATE_GSMANAGER_TO_DYSON
    }, { actorRole: 'administrator' })).toEqual(
      failure(423, 'CUTOVER_HTTP_MUTATION_BUSY')
    )
    expect(audit.begin).toHaveBeenCalledTimes(1)

    release.resolve()
    expect(await mutation).toEqual(ok(202, receipt()))
    expect(audit.complete).toHaveBeenCalledTimes(1)
  })

  it('audits a valid but gate-rejected attempt and never audits an invalid confirmation', async () => {
    const service = createService()
    const audit = createAudit()
    const controller = new CutoverHttpController({
      service,
      audit,
      ordinaryMutationGate: () => false
    })

    expect(await controller.prepare({ requestId, planFingerprint, confirmation: PREPARE_GSMANAGER_TO_DYSON }, { actorRole: 'administrator' }))
      .toEqual(failure(423, 'CUTOVER_HTTP_MUTATION_DISABLED'))
    expect(audit.complete).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'rejected', httpStatus: 423, errorCode: 'CUTOVER_HTTP_MUTATION_DISABLED'
    }))

    vi.clearAllMocks()
    expect(await controller.activate({
      requestId,
      confirmation: 'wrong'
    }, { actorRole: 'administrator' })).toEqual(
      failure(422, 'CUTOVER_CONFIRMATION_REQUIRED')
    )
    expect(audit.begin).not.toHaveBeenCalled()
    expect(service.activate).not.toHaveBeenCalled()
  })

  it('reconciles a crash-left audit start from the durable terminal receipt before serving status', async () => {
    const service = createService()
    service.getReceiptForAudit.mockResolvedValue({
      match: 'matched',
      storedOperation: 'prepare',
      receipt: receipt()
    })
    const audit = createAudit()
    const started = incompleteAuditStart()
    vi.mocked(audit.listIncomplete)
      .mockResolvedValueOnce([started])
      .mockResolvedValueOnce([])
      .mockResolvedValue([])
    const controller = new CutoverHttpController({ service, audit })

    expect((await controller.recoveryStatus({})).statusCode).toBe(200)
    expect(service.getReceiptForAudit).toHaveBeenCalledWith({
      requestId,
      operation: 'prepare',
      planFingerprint: null,
      rollbackMode: null,
      desired: null
    })
    expect(audit.complete).toHaveBeenCalledWith({
      attemptId: started.attemptId,
      outcome: 'succeeded',
      httpStatus: 202,
      receiptPhase: 'prepared',
      receiptReused: false
    })
  })

  it('records a cross-operation receipt as an idempotency conflict instead of a false success', async () => {
    const service = createService()
    service.getReceiptForAudit.mockResolvedValue({ match: 'conflict' })
    const audit = createAudit()
    const started = incompleteAuditStart({
      operation: 'rollback',
      rollbackMode: 'immediate-compensation'
    })
    vi.mocked(audit.listIncomplete)
      .mockResolvedValueOnce([started])
      .mockResolvedValueOnce([])
      .mockResolvedValue([])
    const controller = new CutoverHttpController({ service, audit })

    await controller.initialize()
    expect(service.getReceiptForAudit).toHaveBeenCalledWith({
      requestId,
      operation: 'rollback',
      planFingerprint: null,
      rollbackMode: 'immediate-compensation',
      desired: null
    })
    expect(audit.complete).toHaveBeenCalledWith({
      attemptId: started.attemptId,
      outcome: 'rejected',
      httpStatus: 409,
      errorCode: 'CUTOVER_IDEMPOTENCY_CONFLICT'
    })
  })

  it('keeps concurrent recovery reads request-local when an older read completes last', async () => {
    const service = createService()
    const controller = makeController(service)
    await controller.initialize()
    const slow = deferred<CutoverRecoveryStatus>()
    service.recoveryStatus
      .mockImplementationOnce(async () => await slow.promise)
      .mockResolvedValueOnce(readyStatus())

    const older = controller.recoveryStatus({})
    const newer = controller.recoveryStatus({})
    expect(await newer).toEqual(ok(200, {
      schemaVersion: 1,
      phase: 'ready',
      status: 'ready',
      mutationBlocked: false,
      recoveryRequired: false,
      requestId: null,
      allowedDesired: [],
      summary: summary(),
      errorCode: null
    }))
    slow.resolve(requiredStatus())
    expect((await older).body).toMatchObject({
      ok: true,
      data: { phase: 'recovery-required', requestId }
    })
  })

  it('closes a pre-mutation audit interruption only when core recovery is already ready', async () => {
    const readyService = createService()
    const readyAudit = createAudit()
    const started = incompleteAuditStart()
    vi.mocked(readyAudit.listIncomplete)
      .mockResolvedValueOnce([started])
      .mockResolvedValueOnce([])
      .mockResolvedValue([])
    const ready = new CutoverHttpController({ service: readyService, audit: readyAudit })
    await ready.initialize()
    expect(readyAudit.complete).toHaveBeenCalledWith({
      attemptId: started.attemptId,
      outcome: 'failed',
      httpStatus: 503,
      errorCode: 'CUTOVER_HTTP_INTERRUPTED_BEFORE_MUTATION'
    })

    const recoveringService = createService()
    recoveringService.recoveryStatus.mockResolvedValue(requiredStatus())
    const recoveringAudit = createAudit()
    vi.mocked(recoveringAudit.listIncomplete).mockResolvedValue([started])
    const recovering = new CutoverHttpController({ service: recoveringService, audit: recoveringAudit })
    const status = await recovering.recoveryStatus({})
    expect(status.body).toMatchObject({ ok: true, data: { phase: 'recovery-required' } })
    expect(recoveringAudit.complete).not.toHaveBeenCalled()
  })
})

function makeController(
  service = createService(),
  options: {
    ordinaryMutationGate?: () => boolean | Promise<boolean>
    recoveryMutationGate?: () => boolean | Promise<boolean>
  } = {}
): CutoverHttpController {
  return new CutoverHttpController({
    service,
    ordinaryMutationGate: options.ordinaryMutationGate ?? (() => true),
    recoveryMutationGate: options.recoveryMutationGate ?? (() => false)
  })
}

function createService() {
  return {
    getReceiptForAudit: vi.fn(
      async (
        _input: Parameters<CutoverHttpService['getReceiptForAudit']>[0]
      ): Promise<Awaited<ReturnType<CutoverHttpService['getReceiptForAudit']>>> => null
    ),
    preview: vi.fn(async (input: Parameters<CutoverHttpService['preview']>[0]) => ({
      format: 'dyson-control-cutover-preview' as const,
      schemaVersion: 1 as const,
      operation: input.operation,
      requestId: input.requestId,
      rollbackMode: input.operation === 'rollback' ? input.mode : null,
      stateRevision: 'c'.repeat(64),
      evidenceDigest: 'd'.repeat(64),
      planFingerprint,
      summary: summary()
    })),
    prepare: vi.fn(async (_input: Parameters<CutoverHttpService['prepare']>[0]) => receipt()),
    activate: vi.fn(async (_input: Parameters<CutoverHttpService['activate']>[0]) => ({
      ...receipt(), phase: 'activated' as const
    })),
    rollback: vi.fn(async (input: Parameters<CutoverHttpService['rollback']>[0]) => ({
      ...receipt(),
      phase: input.mode === 'immediate-compensation'
        ? 'rolled-back-immediate' as const
        : 'rolled-back-later' as const,
      status: 'rolled-back' as const
    })),
    recoveryStatus: vi.fn(async () => readyStatus()),
    recoverInterrupted: vi.fn(
      async (input: Parameters<CutoverHttpService['recoverInterrupted']>[0]): Promise<CutoverReceipt> => ({
        ...receipt(),
        phase: `recovered-${input.desired}` as const,
        status: input.desired === 'candidate' ? 'succeeded' as const : 'rolled-back' as const
      })
    )
  } satisfies CutoverHttpService
}

function receipt(overrides: Partial<CutoverReceipt['summary']> = {}): CutoverReceipt {
  return {
    requestId,
    phase: 'prepared',
    status: 'succeeded',
    allowedDesired: [],
    summary: summary(overrides),
    errorCode: null
  }
}

function operationReceipt(
  phase: CutoverReceipt['phase'],
  status: CutoverReceipt['status'],
  overrides: Partial<CutoverReceipt['summary']> = {}
): CutoverReceipt {
  return { ...receipt(overrides), phase, status }
}

function readyStatus(): CutoverRecoveryStatus {
  return {
    requestId: null,
    phase: 'ready',
    status: 'ready',
    allowedDesired: [],
    summary: summary(),
    errorCode: null
  }
}

function requiredStatus(): CutoverRecoveryStatus {
  return {
    requestId,
    phase: 'recovery-required',
    status: 'interrupted',
    allowedDesired: ['previous'],
    summary: summary(),
    errorCode: 'CUTOVER_RECOVERY_REQUIRED'
  }
}

function summary(overrides: Partial<CutoverReceipt['summary']> = {}): CutoverReceipt['summary'] {
  return {
    candidateDefined: false,
    candidateDisabled: false,
    previousAuthorityEnabled: false,
    candidateAuthorityEnabled: false,
    previousRuntimeHealthy: false,
    candidateRuntimeHealthy: false,
    processesStopped: false,
    portClosed: false,
    uniqueAuthority: false,
    saveProtected: false,
    baselineRestored: false,
    currentProgressProtected: false,
    reused: false,
    ...overrides
  }
}

function ok<T>(statusCode: number, data: T) {
  return { statusCode, body: { ok: true, data } } as const
}

function failure(statusCode: number, code: string) {
  return { statusCode, body: { ok: false, error: { code } } } as const
}

function createAudit(order: string[] = []): CutoverAuditEventStore {
  return {
    begin: vi.fn(async (input) => {
      order.push('begin')
      return { ...input } as never
    }),
    complete: vi.fn(async (input) => {
      order.push('complete')
      return { ...input } as never
    }),
    listIncomplete: vi.fn(async () => []),
    listRecent: vi.fn(async () => [])
  }
}

function incompleteAuditStart(
  overrides: Partial<CutoverAuditStartedEvent> = {}
): CutoverAuditStartedEvent {
  return { ...baseIncompleteAuditStart(), ...overrides }
}

function baseIncompleteAuditStart(): CutoverAuditStartedEvent {
  return {
    format: 'dyson-control-cutover-audit-event' as const,
    schemaVersion: 1 as const,
    attemptId: '20000000-0000-4000-8000-000000000001',
    operation: 'prepare' as const,
    requestId,
    actorRole: 'administrator' as const,
    rollbackMode: null,
    desired: null,
    sequence: 1 as const,
    event: 'started' as const,
    recordedAt: '2026-09-01T00:00:00.000Z'
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

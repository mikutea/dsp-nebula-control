import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  SteamManualHandoffHttpController,
  steamManualHandoffConfirmations,
  type SteamManualHandoffHttpService
} from './steam-manual-handoff-http.js'
import {
  initialSteamManualHandoffRevision,
  SteamManualHandoffError,
  type SteamManualHandoffPlan,
  type SteamManualHandoffReceipt,
  type SteamManualHandoffState
} from './steam-manual-handoff.js'

const targetVersion = '0.10.35.29485'

describe('Steam manual handoff HTTP boundary', () => {
  it('keeps preview read-only and exposes the official-client/no-account boundary', async () => {
    const request = makeRequest()
    const fixture = makeFixture()
    fixture.service.preview.mockResolvedValue(plan(request))

    await expect(fixture.controller.preview(request)).resolves.toMatchObject({
      statusCode: 200,
      body: { ok: true, data: { dryRun: true, accountAutomation: false } }
    })
    expect(fixture.gate).not.toHaveBeenCalled()
    expect(fixture.service.begin).not.toHaveBeenCalled()
    expect(fixture.service.confirm).not.toHaveBeenCalled()
  })

  it('rejects wrong begin and completion phrases before reconciliation, gate, or mutation', async () => {
    const request = makeRequest()
    const fixture = makeFixture()

    await expect(fixture.controller.begin({ ...request, confirmation: 'BEGIN_STEAM_UPDATE' }))
      .resolves.toMatchObject({
        statusCode: 422,
        body: { ok: false, error: { code: 'DSP_STEAM_HANDOFF_HTTP_CONFIRMATION_INVALID' } }
      })
    await expect(fixture.controller.confirm({ requestId: request.requestId, confirmation: 'DONE' }))
      .resolves.toMatchObject({
        statusCode: 422,
        body: { ok: false, error: { code: 'DSP_STEAM_HANDOFF_HTTP_CONFIRMATION_INVALID' } }
      })
    expect(fixture.service.reconcile).not.toHaveBeenCalled()
    expect(fixture.gate).not.toHaveBeenCalled()
    expect(fixture.service.begin).not.toHaveBeenCalled()
    expect(fixture.service.confirm).not.toHaveBeenCalled()
  })

  it('fails closed at a default-disabled mutation gate', async () => {
    const request = makeRequest()
    const fixture = makeFixture({ gate: undefined })

    await expect(fixture.controller.begin(beginInput(request))).resolves.toMatchObject({
      statusCode: 423,
      body: { ok: false, error: { code: 'DSP_STEAM_HANDOFF_HTTP_MUTATION_DISABLED' } }
    })
    expect(fixture.service.begin).not.toHaveBeenCalled()
  })

  it('returns accepted for a durable begin and normal success for an idempotent replay', async () => {
    const request = makeRequest()
    const fixture = makeFixture()
    fixture.service.begin
      .mockResolvedValueOnce(receipt(request.requestId, 'awaiting-steam-client-update'))
      .mockResolvedValueOnce(receipt(request.requestId, 'awaiting-steam-client-update', { reused: true }))
    fixture.service.getState.mockResolvedValue(state())

    await expect(fixture.controller.begin(beginInput(request))).resolves.toMatchObject({
      statusCode: 202,
      body: { ok: true, data: { phase: 'awaiting-steam-client-update', reused: false } }
    })
    // A replay is deliberately allowed through even though the controller has
    // adopted an awaiting status; the durable service owns UUID idempotency.
    fixture.service.getState.mockResolvedValue(state())
    await expect(new SteamManualHandoffHttpController({
      service: fixture.service,
      mutationGate: fixture.gate
    }).begin(beginInput(request))).resolves.toMatchObject({
      statusCode: 200,
      body: { ok: true, data: { reused: true } }
    })
    expect(fixture.gate).toHaveBeenCalledWith('begin', request)
  })

  it('recovers an awaiting transaction on controller restart and confirms the same request only', async () => {
    const request = makeRequest()
    const awaiting = receipt(request.requestId, 'awaiting-steam-client-update')
    const fixture = makeFixture({
      reconciled: awaiting,
      initialState: state({ activeRequestId: request.requestId, current: awaiting })
    })
    fixture.service.confirm.mockResolvedValue(receipt(request.requestId, 'succeeded'))

    await fixture.controller.initialize()
    await expect(fixture.controller.confirm(confirmInput(randomUUID()))).resolves.toMatchObject({
      statusCode: 409,
      body: { ok: false, error: { code: 'DSP_STEAM_HANDOFF_REQUEST_MISMATCH' } }
    })
    await expect(fixture.controller.confirm(confirmInput(request.requestId))).resolves.toMatchObject({
      statusCode: 202,
      body: { ok: true, data: { phase: 'succeeded' } }
    })
    expect(fixture.gate).toHaveBeenCalledWith('confirm', { requestId: request.requestId })
    expect(fixture.service.confirm).toHaveBeenCalledTimes(1)
  })

  it('leaves a wrong observed Steam version retryable instead of claiming completion', async () => {
    const request = makeRequest()
    const awaiting = receipt(request.requestId, 'awaiting-steam-client-update')
    const fixture = makeFixture({
      reconciled: awaiting,
      initialState: state({ activeRequestId: request.requestId, current: awaiting })
    })
    fixture.service.confirm.mockRejectedValue(
      new SteamManualHandoffError('DSP_STEAM_HANDOFF_VERSION_MISMATCH')
    )

    await expect(fixture.controller.confirm(confirmInput(request.requestId))).resolves.toMatchObject({
      statusCode: 409,
      body: { ok: false, error: { code: 'DSP_STEAM_HANDOFF_VERSION_MISMATCH' } }
    })
  })

  it('projects a durable recovery-required receipt as unavailable, never as success', async () => {
    const request = makeRequest()
    const awaiting = receipt(request.requestId, 'awaiting-steam-client-update')
    const fixture = makeFixture({
      reconciled: awaiting,
      initialState: state({ activeRequestId: request.requestId, current: awaiting })
    })
    const failed = receipt(request.requestId, 'recovery-required', {
      recoveryRequired: true,
      failureCode: 'DSP_STEAM_HANDOFF_EXACT_SAVE_LOAD_UNPROVEN'
    })
    fixture.service.confirm.mockResolvedValue(failed)

    await expect(fixture.controller.confirm(confirmInput(request.requestId))).resolves.toMatchObject({
      statusCode: 503,
      body: { ok: false, error: { code: 'DSP_STEAM_HANDOFF_EXACT_SAVE_LOAD_UNPROVEN' } }
    })
    fixture.service.getState.mockResolvedValue(state({
      recoveryRequired: true, activeRequestId: request.requestId, current: failed
    }))
    await expect(fixture.controller.recoveryStatus({})).resolves.toMatchObject({
      statusCode: 200,
      body: { ok: true, data: { phase: 'recovery-required', recoveryRequired: true } }
    })
  })

  it('blocks begin when startup reconciliation finds an expired/interrupted recovery state', async () => {
    const request = makeRequest()
    const failed = receipt(request.requestId, 'recovery-required', {
      recoveryRequired: true,
      failureCode: 'DSP_STEAM_HANDOFF_TIMEOUT'
    })
    const fixture = makeFixture({
      reconciled: failed,
      initialState: state({ recoveryRequired: true, activeRequestId: request.requestId, current: failed })
    })

    await expect(fixture.controller.begin(beginInput(request))).resolves.toMatchObject({
      statusCode: 503,
      body: { ok: false, error: { code: 'DSP_STEAM_HANDOFF_RECOVERY_REQUIRED' } }
    })
    expect(fixture.gate).not.toHaveBeenCalled()
    expect(fixture.service.begin).not.toHaveBeenCalled()
  })
})

function makeFixture(options: {
  gate?: ((...args: unknown[]) => boolean) | undefined
  reconciled?: SteamManualHandoffReceipt | null
  initialState?: SteamManualHandoffState
} = {}) {
  const initial = options.initialState ?? state()
  const service = {
    preview: vi.fn<SteamManualHandoffHttpService['preview']>(),
    begin: vi.fn<SteamManualHandoffHttpService['begin']>(),
    confirm: vi.fn<SteamManualHandoffHttpService['confirm']>(),
    reconcile: vi.fn<SteamManualHandoffHttpService['reconcile']>()
      .mockResolvedValue(options.reconciled ?? null),
    getReceipt: vi.fn<SteamManualHandoffHttpService['getReceipt']>(),
    getState: vi.fn<SteamManualHandoffHttpService['getState']>().mockResolvedValue(initial)
  }
  const gate = options.gate === undefined && Object.hasOwn(options, 'gate')
    ? undefined
    : vi.fn(options.gate ?? (() => true))
  const controller = new SteamManualHandoffHttpController({ service, mutationGate: gate })
  return { controller, service, gate: gate ?? vi.fn() }
}

function makeRequest() {
  return {
    requestId: randomUUID(),
    targetVersion,
    expectedRevision: initialSteamManualHandoffRevision
  }
}

function beginInput(request: ReturnType<typeof makeRequest>) {
  return { ...request, confirmation: steamManualHandoffConfirmations.begin }
}

function confirmInput(requestId: string) {
  return { requestId, confirmation: steamManualHandoffConfirmations.complete }
}

function plan(request: ReturnType<typeof makeRequest>): SteamManualHandoffPlan {
  return {
    format: 'dyson-control-steam-manual-handoff-plan', schemaVersion: 1, dryRun: true,
    ...request, timeoutSeconds: 1_800, accountAutomation: false,
    operations: [
      'capture-runtime-and-save-baseline', 'create-paired-save-protection-point',
      'request-graceful-stop', 'prove-process-stopped-and-port-closed',
      'await-official-steam-client-update', 'require-fixed-operator-confirmation',
      'resample-exact-dsp-version-and-compatibility',
      'start-and-prove-current-generation-exact-save-load', 'persist-audit-receipt'
    ]
  }
}

function receipt(
  requestId: string,
  phase: SteamManualHandoffReceipt['phase'],
  overrides: Partial<SteamManualHandoffReceipt> = {}
): SteamManualHandoffReceipt {
  const succeeded = phase === 'succeeded'
  const failed = phase === 'recovery-required'
  return {
    format: 'dyson-control-steam-manual-handoff-receipt', schemaVersion: 1,
    requestId, targetVersion, phase,
    previousRevision: initialSteamManualHandoffRevision,
    resultingRevision: succeeded ? '1'.repeat(64) : '2'.repeat(64),
    transactionBindingSha256: '3'.repeat(64), protectionBackupId: `save:${requestId}`,
    protectionManifestSha256: '4'.repeat(64), previousDspVersion: '0.10.34.28529',
    compatibilityRevision: '5'.repeat(64), startedAt: '2026-09-01T10:00:00.000Z',
    expiresAt: '2026-09-01T10:30:00.000Z',
    completedAt: succeeded || failed ? '2026-09-01T10:01:00.000Z' : null,
    failureCode: failed ? 'DSP_STEAM_HANDOFF_RECOVERY_REQUIRED' : null,
    recoveryRequired: failed,
    steps: {
      protectionPoint: 'verified', gracefulStop: 'verified', stoppedProof: 'verified',
      operatorConfirmation: succeeded ? 'verified' : 'pending',
      versionResample: succeeded ? 'verified' : 'pending',
      compatibilityResample: succeeded ? 'verified' : 'pending',
      exactSaveLoad: succeeded ? 'verified' : 'pending'
    },
    auditEvents: ['baseline-captured'], reused: false,
    ...overrides
  }
}

function state(overrides: Partial<SteamManualHandoffState> = {}): SteamManualHandoffState {
  return {
    format: 'dyson-control-steam-manual-handoff-state', schemaVersion: 1,
    revision: initialSteamManualHandoffRevision, recoveryRequired: false,
    activeRequestId: null, lastCompletedTargetVersion: null, current: null,
    ...overrides
  }
}

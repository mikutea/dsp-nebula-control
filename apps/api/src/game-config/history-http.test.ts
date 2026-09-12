import { describe, expect, it, vi } from 'vitest'
import {
  GameConfigHistoryHttpController,
  gameConfigHistoryHttpConfirmations,
  type GameConfigHistoryHttpService
} from './history-http.js'
import {
  GameConfigHistoryError,
  type GameConfigHistoryErrorCode,
  type GameConfigRecoveryResult,
  type GameConfigRestoreReceipt,
  type GameConfigSnapshotDetail
} from './history.js'

describe('game configuration history HTTP contract', () => {
  it('keeps list, detail, diff, and preview read-only with strict bounded responses', async () => {
    const service = createService()
    const gate = vi.fn(() => { throw new Error('must not run') })
    const provider = vi.fn(() => { throw new Error('must not run') })
    const controller = new GameConfigHistoryHttpController({
      service,
      mutationGate: gate,
      stopProofTokenProvider: provider
    })

    await expect(controller.list({})).resolves.toEqual(ok(200, [snapshotSummaryFixture]))
    await expect(controller.detail({ snapshotId })).resolves.toEqual(ok(200, snapshotFixture))
    await expect(controller.diff({ snapshotId })).resolves.toEqual(ok(200, diffFixture))
    await expect(controller.preview({ snapshotId })).resolves.toEqual(ok(200, diffFixture))

    expect(service.detail).toHaveBeenCalledWith(snapshotId)
    expect(service.diff).toHaveBeenCalledTimes(2)
    expect(gate).not.toHaveBeenCalled()
    expect(provider).not.toHaveBeenCalled()
  })

  it.each(['stopProofToken', 'path', 'url', 'command', 'fileName', 'role'])(
    'rejects browser-controlled %s fields before gate, provider, or core',
    async (field) => {
      const service = createService()
      const gate = vi.fn(() => true)
      const provider = vi.fn(() => internalStopProof)
      const controller = new GameConfigHistoryHttpController({
        service,
        mutationGate: gate,
        stopProofTokenProvider: provider
      })
      const injected = { [field]: 'C:\\fictional-private\\do-not-reflect' }

      expect(await controller.list(injected)).toEqual(invalidRequest)
      expect(await controller.detail({ snapshotId, ...injected })).toEqual(invalidRequest)
      expect(await controller.diff({ snapshotId, ...injected })).toEqual(invalidRequest)
      expect(await controller.capture({
        confirmation: gameConfigHistoryHttpConfirmations.capture,
        ...injected
      })).toEqual(invalidRequest)
      expect(await controller.restore({ ...restoreInput, ...injected })).toEqual(invalidRequest)
      expect(await controller.reconcile({
        confirmation: gameConfigHistoryHttpConfirmations.reconcile,
        ...injected
      })).toEqual(invalidRequest)

      expect(gate).not.toHaveBeenCalled()
      expect(provider).not.toHaveBeenCalled()
      expect(service.capture).not.toHaveBeenCalled()
      expect(service.restore).not.toHaveBeenCalled()
      expect(service.reconcileInterrupted).not.toHaveBeenCalled()
    }
  )

  it('requires UUIDs and the current revision obtained from diff', async () => {
    const service = createService()
    const controller = makeController(service, { mutationGate: () => true })
    const { expectedCurrentRevision: _revision, ...withoutRevision } = restoreInput

    for (const input of [
      withoutRevision,
      { ...restoreInput, requestId: 'not-a-uuid' },
      { ...restoreInput, snapshotId: '../snapshot' },
      { ...restoreInput, expectedCurrentRevision: 'not-a-sha256' }
    ]) {
      expect(await controller.restore(input)).toEqual(invalidRequest)
    }
    expect(service.restore).not.toHaveBeenCalled()
  })

  it('requires the exact operation-specific confirmation before the mutation gate', async () => {
    const service = createService()
    const gate = vi.fn(() => true)
    const provider = vi.fn(() => internalStopProof)
    const controller = new GameConfigHistoryHttpController({
      service,
      mutationGate: gate,
      stopProofTokenProvider: provider
    })
    const expected = failure(422, 'CONFIG_HISTORY_HTTP_CONFIRMATION_INVALID')

    expect(await controller.capture({ confirmation: 'RESTORE_CONFIG_SNAPSHOT' })).toEqual(expected)
    expect(await controller.restore({ ...restoreInput, confirmation: 'CREATE_CONFIG_SNAPSHOT' })).toEqual(expected)
    expect(await controller.reconcile({ confirmation: 'RESTORE_CONFIG_SNAPSHOT' })).toEqual(expected)
    expect(gate).not.toHaveBeenCalled()
    expect(provider).not.toHaveBeenCalled()
  })

  it('keeps every mutation locked by default', async () => {
    const service = createService()
    const provider = vi.fn(() => internalStopProof)
    const controller = new GameConfigHistoryHttpController({
      service,
      stopProofTokenProvider: provider
    })
    const expected = failure(423, 'CONFIG_HISTORY_HTTP_MUTATION_DISABLED')

    expect(await controller.capture({
      confirmation: gameConfigHistoryHttpConfirmations.capture
    })).toEqual(expected)
    expect(await controller.restore(restoreInput)).toEqual(expected)
    expect(await controller.reconcile({
      confirmation: gameConfigHistoryHttpConfirmations.reconcile
    })).toEqual(expected)
    expect(provider).not.toHaveBeenCalled()
    expect(service.capture).not.toHaveBeenCalled()
    expect(service.restore).not.toHaveBeenCalled()
    expect(service.reconcileInterrupted).not.toHaveBeenCalled()
  })

  it('captures only after confirmation and an enabled gate without requesting a stop proof', async () => {
    const service = createService()
    const gate = vi.fn(() => true)
    const provider = vi.fn(() => internalStopProof)
    const controller = new GameConfigHistoryHttpController({
      service,
      mutationGate: gate,
      stopProofTokenProvider: provider
    })

    expect(await controller.capture({
      confirmation: gameConfigHistoryHttpConfirmations.capture
    })).toEqual(ok(201, snapshotFixture))
    expect(gate).toHaveBeenCalledWith({ operation: 'capture' })
    expect(provider).not.toHaveBeenCalled()
    expect(service.capture).toHaveBeenCalledOnce()
  })

  it('injects a server-side stop proof for restore and never returns it', async () => {
    const service = createService()
    const gate = vi.fn(() => true)
    const provider = vi.fn(() => internalStopProof)
    const controller = new GameConfigHistoryHttpController({
      service,
      mutationGate: gate,
      stopProofTokenProvider: provider
    })

    const result = await controller.restore(restoreInput)
    const expectedContext = {
      operation: 'restore',
      requestId,
      snapshotId,
      expectedCurrentRevision: currentRevision,
      dryRun: false
    }
    expect(result).toEqual(ok(200, restoredReceipt))
    expect(gate).toHaveBeenCalledWith(expectedContext)
    expect(provider).toHaveBeenCalledWith(expectedContext)
    expect(service.restore).toHaveBeenCalledWith({
      requestId,
      snapshotId,
      expectedCurrentRevision: currentRevision,
      dryRun: false,
      stopProofToken: internalStopProof
    })
    expect(JSON.stringify(result)).not.toContain(internalStopProof)
    expect(expectedContext).not.toHaveProperty('role')
  })

  it('injects a server-side stop proof for reconciliation and returns bounded recovery results', async () => {
    const recovery: GameConfigRecoveryResult[] = [{
      requestId,
      status: 'interrupted-recovered',
      finalRevision: currentRevision,
      errorCode: 'CONFIG_HISTORY_INTERRUPTED_RECOVERED'
    }]
    const service = createService({ reconcileInterrupted: vi.fn(async () => recovery) })
    const gate = vi.fn(() => true)
    const provider = vi.fn(() => internalStopProof)
    const controller = new GameConfigHistoryHttpController({
      service,
      mutationGate: gate,
      stopProofTokenProvider: provider
    })

    const result = await controller.reconcile({
      confirmation: gameConfigHistoryHttpConfirmations.reconcile
    })
    expect(result).toEqual(ok(200, recovery))
    expect(gate).toHaveBeenCalledWith({ operation: 'reconcile' })
    expect(provider).toHaveBeenCalledWith({ operation: 'reconcile' })
    expect(service.reconcileInterrupted).toHaveBeenCalledWith(internalStopProof)
    expect(JSON.stringify(result)).not.toContain(internalStopProof)
  })

  it.each([
    ['provider exception', () => { throw new Error('fictional-proof-secret') }],
    ['empty token', () => ''],
    ['token with newline', () => 'fictional-proof\nsecret'],
    ['oversized token', () => 'x'.repeat(2_049)]
  ])('fails closed on %s without invoking the restore core', async (_label, provider) => {
    const service = createService()
    const controller = makeController(service, {
      mutationGate: () => true,
      stopProofTokenProvider: provider
    })

    const result = await controller.restore(restoreInput)
    expect(result).toEqual(failure(503, 'CONFIG_HISTORY_HTTP_STOP_PROOF_UNAVAILABLE'))
    expect(service.restore).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('fictional-proof-secret')
  })

  it('turns a mutation gate exception into a code-only 503', async () => {
    const service = createService()
    const controller = makeController(service, {
      mutationGate: () => { throw new Error('C:\\fictional-private\\gate-secret') }
    })

    const result = await controller.restore(restoreInput)
    expect(result).toEqual(failure(503, 'CONFIG_HISTORY_HTTP_GATE_UNAVAILABLE'))
    expect(Object.keys(result.body.ok ? {} : result.body.error)).toEqual(['code'])
    expect(JSON.stringify(result)).not.toContain('gate-secret')
    expect(service.restore).not.toHaveBeenCalled()
  })

  it.each([
    ['CONFIG_HISTORY_REQUEST_INVALID', 422],
    ['CONFIG_HISTORY_REQUEST_CONFLICT', 409],
    ['CONFIG_HISTORY_ROOT_UNAVAILABLE', 503],
    ['CONFIG_HISTORY_STORAGE_UNAVAILABLE', 503],
    ['CONFIG_HISTORY_BUSY', 423],
    ['CONFIG_HISTORY_CAPACITY_EXCEEDED', 503],
    ['CONFIG_HISTORY_SNAPSHOT_INVALID', 422],
    ['CONFIG_HISTORY_REVISION_CONFLICT', 409],
    ['CONFIG_HISTORY_STOP_PROOF_REJECTED', 423],
    ['CONFIG_HISTORY_RECONCILIATION_REQUIRED', 503],
    ['CONFIG_HISTORY_COMMIT_FAILED', 503],
    ['CONFIG_HISTORY_ROLLBACK_FAILED', 503],
    ['CONFIG_HISTORY_INTERRUPTED_RECOVERED', 503],
    ['CONFIG_HISTORY_HOST_LEASE_BUSY', 423],
    ['CONFIG_HISTORY_HOST_LEASE_DIRTY', 503],
    ['CONFIG_HISTORY_HOST_LEASE_RECOVERY_REQUIRED', 503],
    ['CONFIG_HISTORY_HOST_LEASE_LOST', 503],
    ['CONFIG_HISTORY_HOST_LEASE_UNAVAILABLE', 503]
  ] satisfies Array<[GameConfigHistoryErrorCode, number]>) (
    'maps core error %s to fixed status %i',
    async (code, statusCode) => {
      const service = createService({
        list: vi.fn(async () => { throw new GameConfigHistoryError(code) })
      })
      const result = await makeController(service).list({})
      expect(result).toEqual(failure(statusCode, code))
      expect(Object.keys(result.body.ok ? {} : result.body.error)).toEqual(['code'])
    }
  )

  it('maps a missing snapshot to 404 for detail, diff, and preview lookups', async () => {
    const missing = vi.fn(async () => {
      throw new GameConfigHistoryError('CONFIG_HISTORY_SNAPSHOT_INVALID')
    })
    const service = createService({ detail: missing, diff: missing })
    const controller = makeController(service)
    const expected = failure(404, 'CONFIG_HISTORY_HTTP_SNAPSHOT_NOT_FOUND')

    expect(await controller.detail({ snapshotId })).toEqual(expected)
    expect(await controller.diff({ snapshotId })).toEqual(expected)
    expect(await controller.preview({ snapshotId })).toEqual(expected)
  })

  it.each([
    ['busy', 'CONFIG_HISTORY_BUSY', 423],
    ['rejected', 'CONFIG_HISTORY_REVISION_CONFLICT', 409],
    ['rejected', 'CONFIG_HISTORY_SNAPSHOT_INVALID', 422],
    ['rejected', 'CONFIG_HISTORY_STOP_PROOF_REJECTED', 423],
    ['rolled-back', 'CONFIG_HISTORY_COMMIT_FAILED', 503],
    ['recovery-required', 'CONFIG_HISTORY_ROLLBACK_FAILED', 503]
  ] as const)(
    'returns a bounded failed receipt for %s/%s',
    async (status, errorCode, statusCode) => {
      const receipt: GameConfigRestoreReceipt = {
        ...restoredReceipt,
        status,
        errorCode,
        targetRevision: status === 'busy' ? null : targetRevision,
        finalRevision: status === 'busy' ? null : currentRevision,
        persisted: status !== 'busy'
      }
      const service = createService({ restore: vi.fn(async () => receipt) })
      const result = await makeController(service, { mutationGate: () => true }).restore(restoreInput)

      expect(result).toEqual({
        statusCode,
        body: { ok: false, error: { code: errorCode }, data: receipt }
      })
      expect(Object.keys(result.body.ok ? {} : result.body.error)).toEqual(['code'])
      expect(JSON.stringify(result)).not.toContain(internalStopProof)
    }
  )

  it('fails a recovery-required reconciliation with bounded data and the mapped code', async () => {
    const results: GameConfigRecoveryResult[] = [{
      requestId,
      status: 'recovery-required',
      finalRevision: null,
      errorCode: 'CONFIG_HISTORY_STOP_PROOF_REJECTED'
    }]
    const service = createService({ reconcileInterrupted: vi.fn(async () => results) })
    const result = await makeController(service, { mutationGate: () => true }).reconcile({
      confirmation: gameConfigHistoryHttpConfirmations.reconcile
    })

    expect(result).toEqual({
      statusCode: 423,
      body: {
        ok: false,
        error: { code: 'CONFIG_HISTORY_STOP_PROOF_REJECTED' },
        data: results
      }
    })
  })

  it('preserves core-proven request idempotency without changing the logical request', async () => {
    const replayReceipt = { ...restoredReceipt, reused: true }
    const restore = vi.fn()
      .mockResolvedValueOnce(restoredReceipt)
      .mockResolvedValueOnce(replayReceipt)
    const service = createService({ restore })
    const controller = makeController(service, { mutationGate: () => true })

    expect(await controller.restore(restoreInput)).toEqual(ok(200, restoredReceipt))
    expect(await controller.restore(restoreInput)).toEqual(ok(200, replayReceipt))
    expect(restore).toHaveBeenCalledTimes(2)
    expect(restore.mock.calls[0]?.[0]).toMatchObject({ requestId, snapshotId })
    expect(restore.mock.calls[1]?.[0]).toMatchObject({ requestId, snapshotId })
  })

  it('rejects unsafe or unbounded core output instead of reflecting it', async () => {
    const sensitive = 'C:\\fictional-private\\token=fake-secret'
    const maliciousReceipt = { ...restoredReceipt, path: sensitive }
    const maliciousDiff = {
      ...diffFixture,
      settings: [{ ...diffFixture.settings[0], before: sensitive }]
    }
    const receiptService = createService({
      restore: vi.fn(async () => maliciousReceipt as GameConfigRestoreReceipt)
    })
    const diffService = createService({
      diff: vi.fn(async () => maliciousDiff as never)
    })

    const receiptResult = await makeController(receiptService, {
      mutationGate: () => true
    }).restore(restoreInput)
    const diffResult = await makeController(diffService).diff({ snapshotId })
    expect(receiptResult).toEqual(failure(503, 'CONFIG_HISTORY_HTTP_RESPONSE_INVALID'))
    expect(diffResult).toEqual(failure(503, 'CONFIG_HISTORY_HTTP_RESPONSE_INVALID'))
    expect(JSON.stringify([receiptResult, diffResult])).not.toContain('fake-secret')
  })

  it('never reflects unexpected service errors', async () => {
    const sensitive = 'C:\\fictional-private\\password=fake-secret'
    const service = createService({ list: vi.fn(async () => { throw new Error(sensitive) }) })
    const result = await makeController(service).list({})

    expect(result).toEqual(failure(503, 'CONFIG_HISTORY_HTTP_UNAVAILABLE'))
    expect(JSON.stringify(result)).not.toContain('fictional-private')
    expect(JSON.stringify(result)).not.toContain('fake-secret')
  })
})

const snapshotId = '018f47a0-7d5b-4abc-8def-0123456789ab'
const requestId = '028f47a0-7d5b-4abc-8def-0123456789ab'
const protectionSnapshotId = '038f47a0-7d5b-4abc-8def-0123456789ab'
const currentRevision = '1'.repeat(64)
const targetRevision = '2'.repeat(64)
const internalStopProof = 'fictional-internal-stop-proof'

const snapshotFixture: GameConfigSnapshotDetail = {
  format: 'dyson-control-game-config-snapshot',
  snapshotId,
  kind: 'manual',
  createdAt: '2026-08-30T10:00:00.000Z',
  revision: targetRevision,
  manifestSha256: '3'.repeat(64),
  fileCount: 4,
  totalBytes: 2_048,
  files: [
    { id: 'nebula', present: true, bytes: 512 },
    { id: 'galaxy', present: true, bytes: 512 },
    { id: 'bepinex', present: true, bytes: 512 },
    { id: 'bridge', present: true, bytes: 512 }
  ]
}

const snapshotSummaryFixture = {
  format: snapshotFixture.format,
  snapshotId: snapshotFixture.snapshotId,
  kind: snapshotFixture.kind,
  createdAt: snapshotFixture.createdAt,
  revision: snapshotFixture.revision,
  manifestSha256: snapshotFixture.manifestSha256,
  fileCount: snapshotFixture.fileCount,
  totalBytes: snapshotFixture.totalBytes
}

const diffFixture = {
  snapshotId,
  currentRevision,
  targetRevision,
  files: [
    { id: 'nebula' as const, beforePresent: true, afterPresent: true, changed: true }
  ],
  settings: [{
    id: 'nebula.server-password',
    file: 'nebula' as const,
    before: { configured: true },
    after: { configured: true },
    changed: true
  }]
}

const restoredReceipt: GameConfigRestoreReceipt = {
  format: 'dyson-control-game-config-restore-receipt',
  version: 1,
  requestId,
  snapshotId,
  protectionSnapshotId,
  status: 'restored',
  dryRun: false,
  expectedCurrentRevision: currentRevision,
  targetRevision,
  finalRevision: targetRevision,
  errorCode: 'NONE',
  startedAt: '2026-08-30T10:00:00.000Z',
  finishedAt: '2026-08-30T10:00:01.000Z',
  persisted: true,
  reused: false
}

const restoreInput = {
  requestId,
  snapshotId,
  expectedCurrentRevision: currentRevision,
  dryRun: false,
  confirmation: gameConfigHistoryHttpConfirmations.restore
}

const invalidRequest = failure(400, 'CONFIG_HISTORY_HTTP_REQUEST_INVALID')

function createService(overrides: Partial<GameConfigHistoryHttpService> = {}) {
  return {
    list: vi.fn(async () => [snapshotSummaryFixture]),
    detail: vi.fn(async () => snapshotFixture),
    diff: vi.fn(async () => diffFixture),
    capture: vi.fn(async () => snapshotFixture),
    restore: vi.fn(async () => restoredReceipt),
    reconcileInterrupted: vi.fn(async () => []),
    ...overrides
  } satisfies GameConfigHistoryHttpService
}

function makeController(
  service: GameConfigHistoryHttpService,
  overrides: {
    mutationGate?: () => boolean
    stopProofTokenProvider?: () => string
  } = {}
): GameConfigHistoryHttpController {
  return new GameConfigHistoryHttpController({
    service,
    mutationGate: overrides.mutationGate,
    stopProofTokenProvider: overrides.stopProofTokenProvider ?? (() => internalStopProof)
  })
}

function ok<T>(statusCode: number, data: T) {
  return { statusCode, body: { ok: true, data } } as const
}

function failure(statusCode: number, code: string) {
  return { statusCode, body: { ok: false, error: { code } } } as const
}

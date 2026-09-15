import { createRecoverableCleanupPlan } from './update-pipeline/recoverable-cleanup-plan.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApplication, type ApplicationDependencies, type BuiltApplication } from './app.js'
import { loadConfig } from './config.js'
import { hashPassword } from './security/password.js'
import { ComponentUpdateActivationError } from './update-pipeline/index.js'

const origin = 'http://127.0.0.1:13010'
let application: BuiltApplication | null = null

afterEach(async () => {
  if (application) await application.close()
  application = null
})

function fixtureController() {
  return {
    initialize: vi.fn(async () => undefined),
    recoveryStatus: vi.fn(async (input: unknown) => ({
      statusCode: 200,
      body: {
        ok: true,
        data: {
          schemaVersion: 1,
          phase: 'ready',
          mutationBlocked: false,
          recoveryRequired: false,
          failureCode: null,
          reconciledRequestId: null,
          input
        }
      }
    })),
    preview: vi.fn(async (input: unknown) => ({ statusCode: 200, body: { ok: true, data: { kind: 'preview', input } } })),
    previewRollback: vi.fn(async (input: unknown) => ({ statusCode: 200, body: { ok: true, data: { kind: 'rollback-preview', input } } })),
    execute: vi.fn(async (input: unknown) => ({ statusCode: 202, body: { ok: true, data: { kind: 'receipt', input } } })),
    recover: vi.fn(async (input: unknown) => ({ statusCode: 202, body: { ok: true, data: { kind: 'recovery-receipt', input } } })),
    getReceipt: vi.fn(async (input: unknown) => ({ statusCode: 200, body: { ok: true, data: { kind: 'receipt', input } } })),
    history: vi.fn(async (input: unknown) => ({ statusCode: 200, body: { ok: true, data: { kind: 'state', input } } })),
    previewCleanup: vi.fn(async (input: unknown) => ({ statusCode: 200, body: { ok: true, data: { kind: 'cleanup', input } } }))
  } as unknown as NonNullable<ApplicationDependencies['componentUpdateActivationController']>
}

async function login(role: 'viewer' | 'administrator', password: string) {
  const response = await application!.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin },
    payload: { role, password }
  })
  expect(response.statusCode).toBe(200)
  return response.cookies[0]!.value
}

describe('component update activation routes', () => {
  it('authorizes operator rollback routes and keeps execution and recovery gates separate', async () => {
    const request = { requestId: '11111111-1111-4111-8111-111111111111', sourceRequestId: '22222222-2222-4222-8222-222222222222',
      expectedRevision: 'a'.repeat(64), expectedPlanSha256: 'b'.repeat(64) }
    const receipt = { format: 'dyson-control-operator-rollback-receipt' as const, schemaVersion: 1 as const,
      requestId: request.requestId, sourceRequestId: request.sourceRequestId, planSha256: request.expectedPlanSha256,
      resultingRevision: 'c'.repeat(64), protectionBackupId: 'forward-backup', status: 'succeeded' as const, recoveryRequired: false as const }
    const unused = async (): Promise<never> => { throw new Error('unexpected call') }
    const service = { preview: unused, execute: unused, reconcile: async () => null, recoverInterrupted: unused,
      getReceipt: async () => null, getState: async () => ({ revision: 'a'.repeat(64), recoveryRequired: false, components: [], historyEntries: 0 }),
      previewRecoverableCleanup: async (id: unknown) => createRecoverableCleanupPlan({ format: 'dyson-recoverable-component-cleanup-plan', schemaVersion: 1,
        requestId: id, expectedRevision: 'a'.repeat(64), candidates: [{ kind: 'history', opaqueId: request.sourceRequestId, sha256: 'b'.repeat(64), sizeBytes: 1 }] }),
      runRecoverableCleanup: vi.fn(unused), previewCleanup: unused, executeRollback: vi.fn(async () => receipt), recoverRollback: vi.fn(async () => receipt),
      getRollbackReceipt: vi.fn(async () => receipt), getRollbackPending: vi.fn(async () => [{ request, phase: 'files-restored' as const }]) }
    const config = loadConfig({ NODE_ENV: 'test', DYSON_PROVIDER: 'demo', DYSON_PUBLIC_ORIGIN: origin,
      DYSON_DEV_ADMIN_PASSWORD: 'fictional-administrator-password', DYSON_VIEWER_PASSWORD_HASH: await hashPassword('fictional-viewer-password') })
    application = await buildApplication({ ...config, updateActivationEnabled: false, updateActivationRecoveryEnabled: true },
      { componentUpdateActivationService: service })
    const url = '/api/v1/updates/rollback/execute'
    const payload = { request, confirmation: 'ROLLBACK_COMPONENT_UPDATE' }
    expect((await application.app.inject({ method: 'POST', url, headers: { origin }, payload })).statusCode).toBe(401)
    const viewer = await login('viewer', 'fictional-viewer-password')
    expect((await application.app.inject({ method: 'POST', url, headers: { origin }, payload,
      cookies: { dyson_session: viewer } })).statusCode).toBe(403)
    const admin = await login('administrator', 'fictional-administrator-password')
    expect((await application.app.inject({ method: 'POST', url, headers: { origin }, payload,
      cookies: { dyson_session: admin } })).statusCode).toBe(423)
    expect(service.executeRollback).not.toHaveBeenCalled()
    expect((await application.app.inject({ method: 'POST', url: '/api/v1/updates/rollback/recovery', headers: { origin },
      cookies: { dyson_session: admin }, payload: { request, confirmation: 'RECOVER_COMPONENT_ROLLBACK' } })).statusCode).toBe(200)
    expect(service.recoverRollback).toHaveBeenCalledOnce()
    const cleanupUrl = '/api/v1/updates/cleanup/recoverable/execute'
    const cleanupPayload = { requestId: request.requestId, expectedRevision: request.expectedRevision,
      expectedPlanSha256: request.expectedPlanSha256, confirmation: 'QUARANTINE_COMPONENT_MATERIAL' }
    expect((await application.app.inject({ method: 'POST', url: cleanupUrl, headers: { origin }, payload: cleanupPayload })).statusCode).toBe(401)
    expect((await application.app.inject({ method: 'POST', url: cleanupUrl, headers: { origin }, payload: cleanupPayload, cookies: { dyson_session: viewer } })).statusCode).toBe(403)
    expect((await application.app.inject({ method: 'POST', url: cleanupUrl, headers: { origin }, payload: cleanupPayload, cookies: { dyson_session: admin } })).statusCode).toBe(423)
    expect(service.runRecoverableCleanup).not.toHaveBeenCalled()
    expect((await application.app.inject({ method: 'POST', url: '/api/v1/updates/cleanup/recoverable/preview', headers: { origin },
      payload: { requestId: request.requestId }, cookies: { dyson_session: viewer } })).statusCode).toBe(200)
    const cleanupState = await application.app.inject({ method: 'GET', url: '/api/v1/updates/cleanup/recoverable/state', cookies: { dyson_session: viewer } })
    expect(cleanupState.json()).toMatchObject({ ok: true, data: { executionEnabled: false, recoveryEnabled: false, transactions: [] } })

    const audit = await application.app.inject({ method: 'GET', url: '/api/v1/jobs', cookies: { dyson_session: admin } })
    expect(audit.statusCode).toBe(200)
    const rollbackJobs = audit.json().data.filter((job: { kind: string }) => job.kind.startsWith('component.rollback'))
    expect(rollbackJobs).toHaveLength(2)
    expect(rollbackJobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'component.rollback', actor: 'Administrator', state: 'failed', errorCode: 'UPDATE_ROLLBACK_NOT_COMPLETED' }),
      expect.objectContaining({ kind: 'component.rollback.recovery', actor: 'Administrator', state: 'succeeded', errorCode: null })
    ]))
    for (const job of rollbackJobs) {
      expect(job.summary).toContain(request.requestId)
      expect(Number.isFinite(Date.parse(job.startedAt))).toBe(true)
      expect(Date.parse(job.finishedAt)).toBeGreaterThanOrEqual(Date.parse(job.startedAt))
      expect(job.durationMs).toBeGreaterThanOrEqual(0)
    }
    expect((await application.app.inject({ method: 'POST', url: '/api/v1/updates/rollback/recovery', headers: { origin },
      cookies: { dyson_session: admin }, payload: { request, confirmation: 'RECOVER_COMPONENT_ROLLBACK', actor: 'forged-actor' } })).statusCode).toBe(400)
    expect(service.recoverRollback).toHaveBeenCalledOnce()
    const afterSpoof = await application.app.inject({ method: 'GET', url: '/api/v1/jobs?kind=component.rollback.recovery',
      cookies: { dyson_session: admin } })
    expect(afterSpoof.statusCode).toBe(200)
    expect(afterSpoof.json().data).toHaveLength(2)
    expect(afterSpoof.json().data.every((job: { actor: string }) => job.actor === 'Administrator')).toBe(true)

    const state = await application.app.inject({ method: 'GET', url: '/api/v1/updates/rollback/state',
      cookies: { dyson_session: viewer } })
    expect(state.statusCode).toBe(200)
    expect(state.json()).toMatchObject({ ok: true, data: { executionEnabled: false, recoveryEnabled: true,
      pending: [{ request, phase: 'files-restored' }] } })
    expect((await application.app.inject({ method: 'GET', url: `/api/v1/updates/rollback/receipts/${request.requestId}`,
      cookies: { dyson_session: viewer } })).statusCode).toBe(200)
  })

  it('projects the controller contract through bounded authenticated routes', async () => {
    const controller = fixtureController()
    application = await buildApplication(loadConfig({
      NODE_ENV: 'test',
      DYSON_PROVIDER: 'demo',
      DYSON_PUBLIC_ORIGIN: origin,
      DYSON_DEV_ADMIN_PASSWORD: 'fictional-administrator-password'
    }), { componentUpdateActivationController: controller })
    const cookie = await login('administrator', 'fictional-administrator-password')
    expect(controller.initialize).toHaveBeenCalledOnce()
    const request = { requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', component: 'nebula' }

    const preview = await application.app.inject({
      method: 'POST', url: '/api/v1/updates/activation/preview', headers: { origin },
      cookies: { dyson_session: cookie }, payload: request
    })
    expect(preview.statusCode).toBe(200)
    expect(controller.preview).toHaveBeenCalledWith(request)
    const rollbackUrl = '/api/v1/updates/rollback/preview'
    const anonymous = await application.app.inject({ method: 'POST', url: rollbackUrl, headers: { origin }, payload: request })
    expect(anonymous.statusCode).toBe(401)
    const rollback = await application.app.inject({ method: 'POST', url: rollbackUrl, headers: { origin },
      cookies: { dyson_session: cookie }, payload: request })
    expect(rollback.statusCode).toBe(200)
    expect(controller.previewRollback).toHaveBeenCalledWith(request)

    const execute = await application.app.inject({
      method: 'POST', url: '/api/v1/updates/activation/execute', headers: { origin },
      cookies: { dyson_session: cookie }, payload: { ...request, confirmation: 'ACTIVATE_NEBULA_UPDATE' }
    })
    expect(execute.statusCode).toBe(202)
    expect(controller.execute).toHaveBeenCalledOnce()

    const recover = await application.app.inject({
      method: 'POST', url: '/api/v1/updates/activation/recovery', headers: { origin },
      cookies: { dyson_session: cookie },
      payload: { requestId: request.requestId, confirmation: 'RECOVER_COMPONENT_UPDATE' }
    })
    expect(recover.statusCode).toBe(202)
    expect(controller.recover).toHaveBeenCalledWith({
      requestId: request.requestId,
      confirmation: 'RECOVER_COMPONENT_UPDATE'
    })

    const receipt = await application.app.inject({
      method: 'GET', url: `/api/v1/updates/activation/receipts/${request.requestId}`,
      cookies: { dyson_session: cookie }
    })
    expect(receipt.statusCode).toBe(200)
    expect(controller.getReceipt).toHaveBeenCalledWith({ requestId: request.requestId })

    for (const url of [
      '/api/v1/updates/activation/state',
      '/api/v1/updates/activation/recovery',
      '/api/v1/updates/activation/cleanup/preview'
    ]) {
      const response = await application.app.inject({ method: 'GET', url, cookies: { dyson_session: cookie } })
      expect(response.statusCode).toBe(200)
    }
    expect(controller.history).toHaveBeenCalledWith({})
    expect(controller.recoveryStatus).toHaveBeenCalledWith({})
    expect(controller.previewCleanup).toHaveBeenCalledWith({})

    const readiness = await application.app.inject({ method: 'GET', url: '/readyz' })
    expect(readiness.statusCode).toBe(200)
    expect(readiness.json()).toMatchObject({
      status: 'ready',
      checks: { statusProvider: 'pass', activationRecovery: 'pass' }
    })
  })

  it('keeps execution behind the Administrator update-activation permission', async () => {
    const viewerPassword = 'fictional-viewer-password'
    const controller = fixtureController()
    application = await buildApplication(loadConfig({
      NODE_ENV: 'test',
      DYSON_PROVIDER: 'demo',
      DYSON_PUBLIC_ORIGIN: origin,
      DYSON_DEV_ADMIN_PASSWORD: 'fictional-administrator-password',
      DYSON_VIEWER_PASSWORD_HASH: await hashPassword(viewerPassword)
    }), { componentUpdateActivationController: controller })
    const cookie = await login('viewer', viewerPassword)

    const preview = await application.app.inject({
      method: 'POST', url: '/api/v1/updates/activation/preview', headers: { origin },
      cookies: { dyson_session: cookie }, payload: {}
    })
    expect(preview.statusCode).toBe(200)

    const execute = await application.app.inject({
      method: 'POST', url: '/api/v1/updates/activation/execute', headers: { origin },
      cookies: { dyson_session: cookie }, payload: {}
    })
    expect(execute.statusCode).toBe(403)
    expect(execute.json().error.code).toBe('AUTHORIZATION_DENIED')
    expect(controller.execute).not.toHaveBeenCalled()

    const recover = await application.app.inject({
      method: 'POST', url: '/api/v1/updates/activation/recovery', headers: { origin },
      cookies: { dyson_session: cookie }, payload: {}
    })
    expect(recover.statusCode).toBe(403)
    expect(recover.json().error.code).toBe('AUTHORIZATION_DENIED')
    expect(controller.recover).not.toHaveBeenCalled()
  })

  it('keeps explicit recovery independently gated from ordinary activation in default controller wiring', async () => {
    const requestId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const revision = '0'.repeat(64)
    const interrupted = {
      format: 'dyson-control-component-update-receipt' as const,
      schemaVersion: 1 as const,
      requestId,
      component: 'nebula' as const,
      artifactId: 'nebula-artifact-0001',
      compatibilityReceiptId: '118f47a0-7d5b-7abc-8def-0123456789ab',
      targetVersion: '0.9.1',
      releaseId: `nebula-${'e'.repeat(32)}`,
      status: 'rollback-failed' as const,
      previousRevision: revision,
      resultingRevision: revision,
      protectionBackupId: 'fictional-backup-0001',
      rollbackBindingSha256: 'b'.repeat(64),
      rollbackSteps: {
        component: 'verified' as const,
        configuration: 'verified' as const,
        serverModLock: 'verified' as const,
        pairedSave: 'verified' as const,
        previousSaveLoad: 'failed' as const
      },
      failureCode: 'UPDATE_ROLLBACK_SMOKE_FAILED',
      rollbackVerified: false,
      recoveryRequired: true,
      fileCount: 7,
      expandedBytes: 262_144,
      completedAt: '2026-08-30T12:30:00.000Z',
      reused: false
    }
    const terminal = {
      ...interrupted,
      status: 'rolled-back' as const,
      rollbackSteps: {
        component: 'verified' as const,
        configuration: 'verified' as const,
        serverModLock: 'verified' as const,
        pairedSave: 'verified' as const,
        previousSaveLoad: 'verified' as const
      },
      rollbackVerified: true,
      recoveryRequired: false,
      completedAt: '2026-08-30T12:31:00.000Z'
    }
    let recovered = false
    const service = {
      preview: vi.fn(async () => ({ kind: 'unused-preview' })),
      execute: vi.fn(async () => ({ kind: 'must-not-execute' })),
      reconcile: vi.fn(async () => interrupted),
      recoverInterrupted: vi.fn(async () => { recovered = true; return terminal }),
      getReceipt: vi.fn(async () => recovered ? terminal : interrupted),
      getState: vi.fn(async () => ({
        revision,
        recoveryRequired: !recovered,
        components: [],
        historyEntries: 1
      })),
      previewCleanup: vi.fn(async () => ({
        format: 'dyson-control-component-update-cleanup-plan' as const,
        schemaVersion: 1 as const,
        dryRun: true as const,
        executeSupported: false as const,
        candidates: []
      }))
    } as unknown as NonNullable<ApplicationDependencies['componentUpdateActivationService']>
    const config = loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'demo', DYSON_PUBLIC_ORIGIN: origin,
      DYSON_DEV_ADMIN_PASSWORD: 'fictional-administrator-password'
    })
    config.updateActivationEnabled = true
    config.updateActivationRecoveryEnabled = false
    application = await buildApplication(config, { componentUpdateActivationService: service })
    let cookie = await login('administrator', 'fictional-administrator-password')
    const payload = { requestId, confirmation: 'RECOVER_COMPONENT_UPDATE' }

    const disabled = await application.app.inject({
      method: 'POST', url: '/api/v1/updates/activation/recovery', headers: { origin },
      cookies: { dyson_session: cookie }, payload
    })
    expect(disabled.statusCode).toBe(423)
    expect(service.recoverInterrupted).not.toHaveBeenCalled()

    await application.close()
    application = null
    recovered = false
    config.updateActivationEnabled = false
    config.updateActivationRecoveryEnabled = true
    application = await buildApplication(config, { componentUpdateActivationService: service })
    cookie = await login('administrator', 'fictional-administrator-password')
    const enabled = await application.app.inject({
      method: 'POST', url: '/api/v1/updates/activation/recovery', headers: { origin },
      cookies: { dyson_session: cookie }, payload
    })
    expect(enabled.statusCode).toBe(202)
    expect(service.recoverInterrupted).toHaveBeenCalledWith(requestId)
    expect(service.execute).not.toHaveBeenCalled()
  })

  it('returns an explicit unavailable state when no activation adapter is configured', async () => {
    application = await buildApplication(loadConfig({
      NODE_ENV: 'test',
      DYSON_PROVIDER: 'demo',
      DYSON_PUBLIC_ORIGIN: origin,
      DYSON_DEV_ADMIN_PASSWORD: 'fictional-administrator-password'
    }))
    const cookie = await login('administrator', 'fictional-administrator-password')
    for (const url of ['/api/v1/updates/activation/state', '/api/v1/updates/activation/recovery']) {
      const response = await application.app.inject({
        method: 'GET', url, cookies: { dyson_session: cookie }
      })
      expect(response.statusCode).toBe(503)
      expect(response.json().error.code).toBe('UPDATE_ACTIVATION_NOT_CONFIGURED')
    }
  })

  it('runs real controller reconciliation before ready and keeps mutations closed on an uncertain journal', async () => {
    const state = {
      revision: '0'.repeat(64),
      recoveryRequired: false,
      components: [],
      historyEntries: 0
    }
    const service = {
      preview: vi.fn(async () => ({ kind: 'unused-preview' })),
      execute: vi.fn(async () => ({ kind: 'must-not-execute' })),
      reconcile: vi.fn(async () => {
        throw new ComponentUpdateActivationError('UPDATE_RECONCILIATION_UNCERTAIN', {
          cause: new Error('C:\\private\\journal-location')
        })
      }),
      getReceipt: vi.fn(async () => null),
      getState: vi.fn(async () => state),
      previewCleanup: vi.fn(async () => ({
        format: 'dyson-control-component-update-cleanup-plan',
        schemaVersion: 1,
        dryRun: true,
        executeSupported: false,
        candidates: []
      }))
    } as unknown as NonNullable<ApplicationDependencies['componentUpdateActivationService']>
    application = await buildApplication(loadConfig({
      NODE_ENV: 'test',
      DYSON_PROVIDER: 'demo',
      DYSON_PUBLIC_ORIGIN: origin,
      DYSON_DEV_ADMIN_PASSWORD: 'fictional-administrator-password'
    }), { componentUpdateActivationService: service })
    const cookie = await login('administrator', 'fictional-administrator-password')

    expect(service.reconcile).toHaveBeenCalledOnce()
    const recovery = await application.app.inject({
      method: 'GET',
      url: '/api/v1/updates/activation/recovery',
      cookies: { dyson_session: cookie }
    })
    expect(recovery.statusCode).toBe(200)
    expect(recovery.json()).toEqual({
      ok: true,
      data: {
        schemaVersion: 1,
        phase: 'recovery-required',
        mutationBlocked: true,
        recoveryRequired: true,
        failureCode: 'UPDATE_RECONCILIATION_UNCERTAIN',
        reconciledRequestId: null
      }
    })
    expect(JSON.stringify(recovery.json())).not.toContain('journal-location')

    const readOnlyState = await application.app.inject({
      method: 'GET',
      url: '/api/v1/updates/activation/state',
      cookies: { dyson_session: cookie }
    })
    expect(readOnlyState.statusCode).toBe(200)

    const execute = await application.app.inject({
      method: 'POST',
      url: '/api/v1/updates/activation/execute',
      headers: { origin },
      cookies: { dyson_session: cookie },
      payload: {
        requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        component: 'nebula',
        artifactId: 'nebula-artifact-0001',
        sha256: 'a'.repeat(64),
        targetVersion: '0.9.1',
        expectedRevision: state.revision,
        compatibilityReceiptId: '118f47a0-7d5b-7abc-8def-0123456789ab',
        confirmation: 'ACTIVATE_NEBULA_UPDATE'
      }
    })
    expect(execute.statusCode).toBe(503)
    expect(execute.json()).toEqual({
      ok: false,
      error: { code: 'UPDATE_ACTIVATION_HTTP_RECOVERY_REQUIRED' }
    })
    expect(service.reconcile).toHaveBeenCalledOnce()
    expect(service.execute).not.toHaveBeenCalled()

    const readiness = await application.app.inject({ method: 'GET', url: '/readyz' })
    expect(readiness.statusCode).toBe(503)
    expect(readiness.json()).toMatchObject({
      status: 'not-ready',
      checks: { statusProvider: 'pass', activationRecovery: 'fail' }
    })
    expect(readiness.body).not.toContain('journal-location')
  })
})
it('enables cleanup only explicitly and persists the authenticated request audit', async () => {
  const requestId = '44444444-4444-4444-8444-444444444444'
  const plan = createRecoverableCleanupPlan({ format: 'dyson-recoverable-component-cleanup-plan', schemaVersion: 1,
    requestId, expectedRevision: 'a'.repeat(64), candidates: [{ kind: 'history', opaqueId: '55555555-5555-4555-8555-555555555555', sha256: 'b'.repeat(64), sizeBytes: 1 }] })
  const unused = async (): Promise<never> => { throw new Error('unexpected call') }
  const service = { preview: unused, execute: unused, reconcile: async () => null, recoverInterrupted: unused,
    getReceipt: async () => null, getState: async () => ({ revision: plan.expectedRevision, recoveryRequired: false, components: [], historyEntries: 0 }),
    previewCleanup: unused, previewRecoverableCleanup: async () => plan,
    runRecoverableCleanup: async (input: unknown, store: import('./update-pipeline/recoverable-cleanup-execution.js').CleanupJournalStore) => {
      const initial = await store.appendCleanupJournal(input)
      const moved = await store.appendCleanupJournal({ ...initial, completedCount: 1 })
      return await store.appendCleanupJournal({ ...moved, state: 'completed', finishedAt: new Date().toISOString() })
    } }
  application = await buildApplication({ ...loadConfig({ NODE_ENV: 'test', DYSON_PROVIDER: 'demo', DYSON_PUBLIC_ORIGIN: origin,
    DYSON_DEV_ADMIN_PASSWORD: 'fictional-administrator-password' }), updateCleanupEnabled: true }, { componentUpdateActivationService: service })
  const cookie = await login('administrator', 'fictional-administrator-password')
  const response = await application.app.inject({ method: 'POST', url: '/api/v1/updates/cleanup/recoverable/execute', headers: { origin },
    cookies: { dyson_session: cookie }, payload: { requestId, expectedRevision: plan.expectedRevision, expectedPlanSha256: plan.planSha256, confirmation: 'QUARANTINE_COMPONENT_MATERIAL' } })
  expect(response.statusCode).toBe(200)
  expect(response.json()).toMatchObject({ ok: true, data: { actor: 'Administrator', state: 'completed', requestId } })
  const receiptUrl = '/api/v1/updates/cleanup/recoverable/receipts/' + requestId
  expect((await application.app.inject({ method: 'GET', url: receiptUrl })).statusCode).toBe(401)
  const readback = await application.app.inject({ method: 'GET', url: receiptUrl, cookies: { dyson_session: cookie } })
  expect(readback.statusCode).toBe(200)
  expect(readback.json()).toEqual(response.json())
  const state = await application.app.inject({ method: 'GET', url: '/api/v1/updates/cleanup/recoverable/state', cookies: { dyson_session: cookie } })
  expect(state.json()).toMatchObject({ data: { transactions: [expect.objectContaining({ requestId, expectedRevision: plan.expectedRevision, planSha256: plan.planSha256 })] } })
  expect((await application.app.inject({ method: 'GET', url: '/api/v1/updates/cleanup/recoverable/receipts/66666666-6666-4666-8666-666666666666', cookies: { dyson_session: cookie } })).statusCode).toBe(404)

  const audit = await application.app.inject({ method: 'GET', url: '/api/v1/jobs?kind=component.cleanup', cookies: { dyson_session: cookie } })
  expect(audit.statusCode).toBe(200)
  expect(audit.json().data).toEqual([expect.objectContaining({ actor: 'Administrator', state: 'succeeded', summary: expect.stringContaining(requestId), finishedAt: expect.any(String) })])
})

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApplication, type ApplicationDependencies, type BuiltApplication } from './app.js'
import { loadConfig } from './config.js'
import {
  createModPlatformLock,
  generateModManifests,
  ModDeploymentError,
  type ModDeploymentRequest
} from './mods/index.js'
import { DemoProvider } from './providers/demo.js'
import { hashPassword } from './security/password.js'

const origin = 'http://127.0.0.1:13010'
const revision = '0'.repeat(64)
const nextRevision = '1'.repeat(64)
let application: BuiltApplication | null = null
let viewerPasswordHash = ''
let operatorPasswordHash = ''

beforeAll(async () => {
  [viewerPasswordHash, operatorPasswordHash] = await Promise.all([
    hashPassword('fictional-viewer-password'),
    hashPassword('fictional-operator-password')
  ])
})

afterEach(async () => {
  if (application) await application.close()
  application = null
})

describe('authenticated mod deployment routes', () => {
  it('requires authentication and exposes bounded state plus recovery inventory', async () => {
    const service = deploymentService()
    application = await buildApplication(testConfig(), { modDeploymentService: service })

    const unauthenticated = await application.app.inject({
      method: 'GET', url: '/api/v1/mods/deployment/state'
    })
    expect(unauthenticated.statusCode).toBe(401)
    for (const url of [
      `/api/v1/mods/deployment/receipts/${deploymentRequest().requestId}`,
      '/api/v1/mods/deployment/history'
    ]) {
      const protectedResponse = await application.app.inject({ method: 'GET', url })
      expect(protectedResponse.statusCode).toBe(401)
    }

    const cookie = await login(application)
    const state = await application.app.inject({
      method: 'GET', url: '/api/v1/mods/deployment/state', cookies: { dyson_session: cookie }
    })
    expect(state.statusCode).toBe(200)
    expect(state.json()).toEqual({
      data: { revision, packages: [], enabledCount: 0, disabledCount: 0 },
      meta: { executionEnabled: false }
    })

    const recovery = await application.app.inject({
      method: 'GET', url: '/api/v1/mods/deployment/recovery', cookies: { dyson_session: cookie }
    })
    expect(recovery.statusCode).toBe(200)
    expect(recovery.json()).toEqual({
      data: {
        dryRun: true,
        irreversible: true,
        executeSupported: false,
        candidates: [{ id: 'snapshot-fictional-0001', kind: 'snapshot' }]
      }
    })
    const history = await application.app.inject({
      method: 'GET', url: '/api/v1/mods/deployment/history', cookies: { dyson_session: cookie }
    })
    expect(history.statusCode).toBe(200)
    expect(history.json().data.page).toMatchObject({ limit: 20, returned: 1, totalReceipts: 1 })
    expect(service.history).toHaveBeenCalledWith({ cursor: null, pageSize: 20 })
    expect(JSON.stringify({ state: state.json(), recovery: recovery.json(), history: history.json() })).not.toMatch(
      /(?:[A-Za-z]:\\|\\\\|\/tmp\/|stagingRoot|pluginsRoot)/i
    )
  })

  it('allows Viewer and Operator to read exact receipts and bounded history', async () => {
    const service = deploymentService()
    application = await buildApplication(roleConfig(), { modDeploymentService: service })
    const viewerCookie = await login(application, 'viewer', 'fictional-viewer-password')
    const operatorCookie = await login(application, 'operator', 'fictional-operator-password')
    const requestId = deploymentRequest().requestId

    for (const cookie of [viewerCookie, operatorCookie]) {
      const receipt = await application.app.inject({
        method: 'GET', url: `/api/v1/mods/deployment/receipts/${requestId}`,
        cookies: { dyson_session: cookie }
      })
      expect(receipt.statusCode).toBe(200)
      expect(receipt.json()).toMatchObject({ data: { requestId, reused: false } })

      const history = await application.app.inject({
        method: 'GET', url: '/api/v1/mods/deployment/history?pageSize=1',
        cookies: { dyson_session: cookie }
      })
      expect(history.statusCode).toBe(200)
      expect(history.json()).toMatchObject({
        data: { order: 'persisted-at-descending', page: { limit: 1, returned: 1, totalReceipts: 1 } }
      })
    }
    expect(service.getReceipt).toHaveBeenCalledTimes(2)
    expect(service.history).toHaveBeenNthCalledWith(1, { cursor: null, pageSize: 1 })
  })

  it('keeps dry-run preview available while the independent mutation gate is disabled', async () => {
    const service = deploymentService()
    application = await buildApplication(testConfig(), { modDeploymentService: service })
    const cookie = await login(application)
    const request = deploymentRequest()

    const preview = await post(application, cookie, '/api/v1/mods/deployment/preview', request)
    expect(preview.statusCode).toBe(200)
    expect(preview.json()).toMatchObject({
      data: { dryRun: true, operation: 'install', package: request.package, currentRevision: revision },
      meta: { executionEnabled: false }
    })
    expect(service.preview).toHaveBeenCalledWith(request)

    const execution = await post(application, cookie, '/api/v1/mods/deployment/execute', {
      request,
      confirmation: confirmationFor(request)
    })
    expect(execution.statusCode).toBe(503)
    expect(execution.json()).toEqual({
      error: {
        code: 'MOD_DEPLOYMENT_MUTATIONS_DISABLED',
        message: '模组部署写操作尚未显式启用'
      }
    })
    expect(service.execute).not.toHaveBeenCalled()
  })

  it('binds execution confirmation to the exact logical request and returns the durable receipt', async () => {
    const service = deploymentService()
    application = await buildApplication(enabledConfig(), {
      statusProvider: new DemoProvider(),
      modDeploymentService: service
    })
    const cookie = await login(application)
    const request = deploymentRequest()

    const mismatch = await post(application, cookie, '/api/v1/mods/deployment/execute', {
      request,
      confirmation: { ...confirmationFor(request), version: '9.9.9' }
    })
    expect(mismatch.statusCode).toBe(400)
    expect(service.execute).not.toHaveBeenCalled()

    const response = await post(application, cookie, '/api/v1/mods/deployment/execute', {
      request,
      confirmation: confirmationFor(request)
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      data: {
        requestId: request.requestId,
        status: 'succeeded',
        previousRevision: revision,
        newRevision: nextRevision,
        rollback: 'not-needed',
        recoveryPointCreated: true
      }
    })
    expect(service.execute).toHaveBeenCalledWith(request)
  })

  it('rejects path or command injection without reflecting input and maps stopped-gate failure', async () => {
    const service = deploymentService()
    service.preview.mockRejectedValueOnce(new ModDeploymentError('MOD_DEPLOYMENT_STOP_GATE_REJECTED'))
    application = await buildApplication(enabledConfig(), {
      statusProvider: new DemoProvider(),
      modDeploymentService: service
    })
    const cookie = await login(application)
    const request = deploymentRequest()
    const marker = 'DO-NOT-REFLECT-FICTIONAL-HOST-PATH'

    const invalid = await post(application, cookie, '/api/v1/mods/deployment/execute', {
      request: { ...request, stagingPath: `C:\\Fictional\\${marker}`, command: `${marker}.exe` },
      confirmation: confirmationFor(request)
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json()).toEqual({
      error: {
        code: 'INVALID_MOD_DEPLOYMENT_REQUEST',
        message: '模组部署请求不符合固定逻辑字段约束'
      }
    })
    expect(invalid.body).not.toContain(marker)

    const stoppedGate = await post(application, cookie, '/api/v1/mods/deployment/preview', request)
    expect(stoppedGate.statusCode).toBe(409)
    expect(stoppedGate.json()).toEqual({
      error: {
        code: 'MOD_DEPLOYMENT_STOP_GATE_REJECTED',
        message: '执行要求游戏进程已停止且游戏端口未监听'
      }
    })
  })

  it('strictly validates receipt queries and maps missing or recovery-required receipts without leakage', async () => {
    const service = deploymentService()
    application = await buildApplication(testConfig(), { modDeploymentService: service })
    const cookie = await login(application)
    const marker = 'DO-NOT-REFLECT-FICTIONAL-RECEIPT-PATH'

    const invalidId = await application.app.inject({
      method: 'GET', url: `/api/v1/mods/deployment/receipts/${marker}`,
      cookies: { dyson_session: cookie }
    })
    expect(invalidId.statusCode).toBe(400)
    expect(invalidId.json().error.code).toBe('INVALID_MOD_DEPLOYMENT_RECEIPT_REQUEST')
    expect(invalidId.body).not.toContain(marker)

    const unexpectedReceiptQuery = await application.app.inject({
      method: 'GET',
      url: `/api/v1/mods/deployment/receipts/${deploymentRequest().requestId}?path=${marker}`,
      cookies: { dyson_session: cookie }
    })
    expect(unexpectedReceiptQuery.statusCode).toBe(400)
    expect(unexpectedReceiptQuery.json().error.code).toBe('INVALID_MOD_DEPLOYMENT_RECEIPT_REQUEST')
    expect(unexpectedReceiptQuery.body).not.toContain(marker)

    const invalidHistory = await application.app.inject({
      method: 'GET',
      url: `/api/v1/mods/deployment/history?pageSize=101&path=${marker}`,
      cookies: { dyson_session: cookie }
    })
    expect(invalidHistory.statusCode).toBe(400)
    expect(invalidHistory.json().error.code).toBe('INVALID_MOD_DEPLOYMENT_HISTORY_REQUEST')
    expect(invalidHistory.body).not.toContain(marker)
    expect(service.history).not.toHaveBeenCalled()

    service.getReceipt.mockResolvedValueOnce(null)
    const missingId = '99999999-9999-4999-8999-999999999999'
    const missing = await application.app.inject({
      method: 'GET', url: `/api/v1/mods/deployment/receipts/${missingId}`,
      cookies: { dyson_session: cookie }
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toEqual({
      error: { code: 'MOD_DEPLOYMENT_RECEIPT_NOT_FOUND', message: '模组部署回执不存在' }
    })

    service.getReceipt.mockRejectedValueOnce(new ModDeploymentError('MOD_DEPLOYMENT_RECOVERY_REQUIRED'))
    const corrupt = await application.app.inject({
      method: 'GET', url: `/api/v1/mods/deployment/receipts/${deploymentRequest().requestId}`,
      cookies: { dyson_session: cookie }
    })
    expect(corrupt.statusCode).toBe(503)
    expect(corrupt.json()).toEqual({
      error: {
        code: 'MOD_DEPLOYMENT_RECOVERY_REQUIRED',
        message: '模组部署回执或托管状态需要恢复核验'
      }
    })
    expect(corrupt.body).not.toMatch(/(?:[A-Za-z]:\\|\\\\|\/tmp\/|fingerprint|stagingRoot|pluginsRoot)/i)

    service.history.mockRejectedValueOnce(new ModDeploymentError('MOD_DEPLOYMENT_HISTORY_CURSOR_INVALID'))
    const staleCursor = await application.app.inject({
      method: 'GET', url: '/api/v1/mods/deployment/history?cursor=ZmFrZQ',
      cookies: { dyson_session: cookie }
    })
    expect(staleCursor.statusCode).toBe(400)
    expect(staleCursor.json().error.code).toBe('INVALID_MOD_DEPLOYMENT_HISTORY_REQUEST')
  })
})

function testConfig() {
  return loadConfig({
    NODE_ENV: 'test',
    DYSON_PROVIDER: 'demo',
    DYSON_DEV_ADMIN_PASSWORD: 'test-password-long-enough',
    DYSON_PUBLIC_ORIGIN: origin
  })
}

function enabledConfig() {
  return loadConfig({
    NODE_ENV: 'test',
    DYSON_PROVIDER: 'windows',
    DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
    DYSON_MOD_DEPLOYMENT_ENABLED: 'true',
    DYSON_MOD_STAGING_ROOT: 'C:\\Fictional\\Dyson\\staged-mods',
    DYSON_MOD_PLUGINS_ROOT: 'C:\\Fictional\\Dyson\\server\\BepInEx\\plugins\\dyson-managed-mods',
    DYSON_DEV_ADMIN_PASSWORD: 'test-password-long-enough',
    DYSON_PUBLIC_ORIGIN: origin
  })
}

function roleConfig() {
  return loadConfig({
    NODE_ENV: 'test',
    DYSON_PROVIDER: 'demo',
    DYSON_DEV_ADMIN_PASSWORD: 'test-password-long-enough',
    DYSON_VIEWER_PASSWORD_HASH: viewerPasswordHash,
    DYSON_OPERATOR_PASSWORD_HASH: operatorPasswordHash,
    DYSON_PUBLIC_ORIGIN: origin
  })
}

function deploymentRequest(): ModDeploymentRequest {
  const dependencyId = 'Fictional-ExampleMod-1.0.0'
  const manifests = generateModManifests({
    roots: [dependencyId],
    packages: [{
      dependencyId,
      sha256: 'a'.repeat(64),
      dependencies: [],
      serverRequired: true,
      clientRequirement: 'required'
    }]
  })
  return {
    requestId: '11111111-1111-4111-8111-111111111111',
    operation: 'install',
    package: { dependencyId, version: '1.0.0' },
    manifest: {
      serverLock: manifests.serverLock,
      clientParity: manifests.clientParity,
      platformLock: createModPlatformLock({
        serverLockSha256: manifests.serverLockSha256,
        inventoryRevision: null,
        requirements: []
      })
    },
    expectedRevision: revision
  }
}

function confirmationFor(request: ModDeploymentRequest) {
  return {
    action: 'EXECUTE_MOD_DEPLOYMENT',
    requestId: request.requestId,
    operation: request.operation,
    dependencyId: request.package.dependencyId,
    version: request.package.version,
    expectedRevision: request.expectedRevision
  }
}

function deploymentService() {
  const request = deploymentRequest()
  const receipt = deploymentReceipt()
  return {
    inspect: vi.fn(async () => ({ revision, packages: [], enabledCount: 0, disabledCount: 0 })),
    previewCleanup: vi.fn(async () => ({
      dryRun: true as const,
      irreversible: true as const,
      executeSupported: false as const,
      candidates: [{ id: 'snapshot-fictional-0001', kind: 'snapshot' as const }]
    })),
    preview: vi.fn(async () => ({
      dryRun: true as const,
      operation: request.operation,
      package: request.package,
      currentRevision: revision,
      nextRevision,
      currentlyInstalled: false,
      currentlyEnabled: false,
      nextEnabled: true,
      payloadFileCount: 2,
      payloadSizeBytes: 4096,
      dependencyCount: 0,
      snapshotsUsed: 1,
      snapshotLimit: 8,
      stoppedStateRequiredForExecute: true as const,
      recoverablePayloadPreserved: false
    })),
    execute: vi.fn(async () => receipt),
    getReceipt: vi.fn(async (_input?: unknown): Promise<typeof receipt | null> => receipt),
    history: vi.fn(async (input?: unknown) => {
      const query = input as { cursor: string | null; pageSize: number }
      return {
        format: 'dyson-control-mod-deployment-receipt-history' as const,
        schemaVersion: 1 as const,
        order: 'persisted-at-descending' as const,
        items: [{ persistedAt: '2026-08-30T10:00:00.000Z', receipt }],
        page: { limit: query.pageSize, returned: 1, totalReceipts: 1, nextCursor: null }
      }
    })
  } satisfies NonNullable<ApplicationDependencies['modDeploymentService']>
}

function deploymentReceipt() {
  const request = deploymentRequest()
  return {
    format: 'dyson-control-mod-deployment-receipt' as const,
    schemaVersion: 1 as const,
    requestId: request.requestId,
    operation: request.operation,
    package: request.package,
    status: 'succeeded' as const,
    previousRevision: revision,
    newRevision: nextRevision,
    rollback: 'not-needed' as const,
    recoveryPointCreated: true,
    recoverablePayloadPreserved: false,
    payloadFileCount: 2,
    payloadSizeBytes: 4096,
    errorCode: null,
    reused: false
  }
}

async function login(
  target: BuiltApplication,
  role: 'viewer' | 'operator' | 'administrator' = 'administrator',
  password = 'test-password-long-enough'
): Promise<string> {
  const response = await target.app.inject({
    method: 'POST', url: '/api/v1/auth/login', headers: { origin },
    payload: { role, password }
  })
  expect(response.statusCode).toBe(200)
  return response.cookies[0]!.value
}

async function post(target: BuiltApplication, cookie: string, url: string, payload: object) {
  return await target.app.inject({
    method: 'POST', url, headers: { origin }, cookies: { dyson_session: cookie }, payload
  })
}

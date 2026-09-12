import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApplication, type BuiltApplication } from './app.js'
import { loadConfig } from './config.js'
import type {
  HostMutationOperationCoordinator,
  HostMutationOperationOutcome,
  HostMutationOperationRequest,
  HostMutationOperationScope,
  HostMutationRecoveryOperationCoordinator,
  HostMutationRecoveryOperationRequest
} from './host-mutation/operation-coordinator.js'
import type { WindowsNebulaPluginTransactionRouteService } from './nebula-plugin-transaction-routes.js'
import { DemoProvider } from './providers/demo.js'
import {
  nebulaPluginApplyConfirmationPhrase,
  windowsNebulaPluginApplyOperation,
  type WindowsNebulaPluginTransactionPowerShellRunner,
  type WindowsNebulaPluginTransactionScriptName
} from './providers/windows-nebula-plugin-transaction.js'
import { hashPassword } from './security/password.js'

const origin = 'http://127.0.0.1:13010'
const passwords = {
  viewer: 'fictional-nebula-viewer-password',
  operator: 'fictional-nebula-operator-password',
  administrator: 'fictional-nebula-administrator-password'
} as const
const requestId = '00000000-0000-4000-8000-000000000101'
const rollbackRequestId = '00000000-0000-4000-8000-000000000102'
const leaseInstanceId = '00000000-0000-4000-8000-000000000103'
const currentTreeDigest = '1'.repeat(64)
const planDigest = '2'.repeat(64)
const receiptDigest = '3'.repeat(64)
const previewDigest = '4'.repeat(64)
const originalReceiptDigest = '5'.repeat(64)
const leaseToken = 'fictional-nebula-lease-token'.padEnd(43, 'x')
const windowStart = '2030-01-01T00:00:00Z'
const windowEnd = '2030-01-01T01:00:00Z'

let viewerPasswordHash = ''
let operatorPasswordHash = ''
let application: BuiltApplication | null = null
const temporaryRoots: string[] = []

beforeAll(async () => {
  [viewerPasswordHash, operatorPasswordHash] = await Promise.all([
    hashPassword(passwords.viewer),
    hashPassword(passwords.operator)
  ])
})

afterEach(async () => {
  await application?.close()
  application = null
  for (const root of temporaryRoots.splice(0).reverse()) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('Nebula plugin transaction application wiring', () => {
  it('registers only strict path-free DTO operations behind authentication and role permissions', async () => {
    const service = fixtureRouteService()
    const config = loadConfig({
      NODE_ENV: 'test',
      DYSON_PUBLIC_ORIGIN: origin,
      DYSON_DEV_ADMIN_PASSWORD: passwords.administrator,
      DYSON_VIEWER_PASSWORD_HASH: viewerPasswordHash,
      DYSON_OPERATOR_PASSWORD_HASH: operatorPasswordHash
    })
    application = await buildApplication({
      ...config,
      nebulaPluginTransactionEnabled: true,
      nebulaPluginTransactionRecoveryEnabled: true
    }, { nebulaPluginTransactionService: service })

    const unauthenticated = await post(null, '/plan', planBody())
    expect(unauthenticated.statusCode).toBe(401)
    expect(service.plan).not.toHaveBeenCalled()

    const viewer = await login('viewer')
    const operator = await login('operator')
    const administrator = await login('administrator')
    const read = await post(viewer, '/plan', planBody())
    expect(read.statusCode).toBe(200)
    expect(service.plan).toHaveBeenCalledWith(expect.objectContaining({
      requestId,
      currentPluginsTreeSha256: currentTreeDigest,
      signal: expect.any(AbortSignal)
    }))

    const operatorDenied = await post(operator, '/apply', applyBody())
    expect(operatorDenied.statusCode).toBe(403)
    expect(service.apply).not.toHaveBeenCalled()

    for (const [endpoint, payload] of [
      ['/apply/preview', { requestId }],
      ['/apply', applyBody()],
      ['/apply/recover', applyBody()],
      ['/apply/verify', { requestId }],
      ['/rollback/preview', rollbackPreviewBody()],
      ['/rollback', rollbackBody()],
      ['/rollback/recover', rollbackBody()],
      ['/rollback/verify', { originalRequestId: requestId, rollbackRequestId }]
    ] as const) {
      const response = await post(administrator, endpoint, payload)
      expect(response.statusCode, `${endpoint}: ${response.body}`).toBe(200)
      expect(response.json()).toMatchObject({ ok: true })
    }

    expect(service.previewApply).toHaveBeenCalledTimes(1)
    expect(service.apply).toHaveBeenCalledTimes(1)
    expect(service.recoverApply).toHaveBeenCalledTimes(1)
    expect(service.verifyApply).toHaveBeenCalledTimes(1)
    expect(service.previewRollback).toHaveBeenCalledTimes(1)
    expect(service.rollback).toHaveBeenCalledTimes(1)
    expect(service.recoverRollback).toHaveBeenCalledTimes(1)
    expect(service.verifyRollback).toHaveBeenCalledTimes(1)

    const callCount = service.plan.mock.calls.length
    const pathInjection = await post(administrator, '/plan', {
      ...planBody(),
      scriptName: 'Arbitrary.ps1',
      gameRoot: 'C:\\Private\\OtherGame'
    })
    expect(pathInjection.statusCode).toBe(400)
    expect(pathInjection.json()).toEqual({
      ok: false,
      error: { code: 'NEBULA_PLUGIN_TRANSACTION_REQUEST_INVALID' }
    })
    expect(service.plan).toHaveBeenCalledTimes(callCount)

    const queryInjection = await post(administrator, '/plan?path=C%3A%5CPrivate', planBody())
    expect(queryInjection.statusCode).toBe(400)
    expect(service.plan).toHaveBeenCalledTimes(callCount)

    const oversized = await post(administrator, '/apply/preview', {
      requestId,
      padding: 'x'.repeat(5 * 1024)
    })
    expect(oversized.statusCode).toBe(400)
    expect(oversized.json()).toEqual({
      ok: false,
      error: { code: 'NEBULA_PLUGIN_TRANSACTION_REQUEST_INVALID' }
    })
    expect(service.previewApply).toHaveBeenCalledTimes(1)
  })

  it('constructs the production service with fixed roots, fixed Server role and the exact runner', async () => {
    const fixture = createProductionFixture({ ordinary: true, recovery: false })
    application = await buildApplication(fixture.config, fixture.dependencies)
    const administrator = await login('administrator')

    const planned = await post(administrator, '/plan', planBody())
    expect(planned.statusCode, planned.body).toBe(200)
    expect(fixture.runner.calls).toHaveLength(1)
    expect(fixture.runner.calls[0]).toMatchObject({
      scriptName: 'New-NebulaPluginCutoverPlan.ps1'
    })
    expect(argument(fixture.runner.calls[0]!.arguments_, '-JobBase')).toBe(fixture.jobBase)
    expect(argument(fixture.runner.calls[0]!.arguments_, '-GameRoot')).toBe(fixture.gameRoot)
    expect(argument(fixture.runner.calls[0]!.arguments_, '-TargetRole')).toBe('Server')
    expect(argument(fixture.runner.calls[0]!.arguments_, '-Backend')).toBe('Windows')

    const applied = await post(administrator, '/apply', applyBody())
    expect(applied.statusCode, applied.body).toBe(200)
    expect(fixture.coordinator.ordinaryRequests).toEqual([{
      operation: windowsNebulaPluginApplyOperation,
      requestId
    }])
    expect(fixture.coordinator.recoveryRequests).toEqual([])
    const applyCall = fixture.runner.calls.at(-1)!
    expect(applyCall.scriptName).toBe('Invoke-NebulaPluginCutover.ps1')
    expect(argument(applyCall.arguments_, '-HostMutationDataRoot')).toBe(fixture.dataRoot)
    expect(applyCall.arguments_).not.toContain('-Recover')

    const blockedRecovery = await post(administrator, '/apply/recover', applyBody())
    expect(blockedRecovery.statusCode).toBe(423)
    expect(blockedRecovery.json()).toEqual({
      ok: false,
      error: { code: 'NEBULA_PLUGIN_TRANSACTION_RECOVERY_DISABLED' }
    })
    expect(fixture.coordinator.recoveryRequests).toEqual([])
  })

  it('keeps ordinary mutation closed while independently allowing Administrator recovery', async () => {
    const fixture = createProductionFixture({ ordinary: false, recovery: true })
    application = await buildApplication(fixture.config, fixture.dependencies)
    const operator = await login('operator')
    const administrator = await login('administrator')

    const denied = await post(operator, '/apply/recover', applyBody())
    expect(denied.statusCode).toBe(403)
    expect(fixture.coordinator.recoveryRequests).toEqual([])

    const blockedOrdinary = await post(administrator, '/apply', applyBody())
    expect(blockedOrdinary.statusCode).toBe(423)
    expect(blockedOrdinary.json()).toEqual({
      ok: false,
      error: { code: 'NEBULA_PLUGIN_TRANSACTION_MUTATION_DISABLED' }
    })
    expect(fixture.coordinator.ordinaryRequests).toEqual([])

    const recovered = await post(administrator, '/apply/recover', applyBody())
    expect(recovered.statusCode, recovered.body).toBe(200)
    expect(fixture.coordinator.ordinaryRequests).toEqual([])
    expect(fixture.coordinator.recoveryRequests).toEqual([{
      expectedOperation: windowsNebulaPluginApplyOperation,
      expectedRequestId: requestId
    }])
    expect(fixture.runner.calls).toHaveLength(1)
    expect(fixture.runner.calls[0]!.arguments_).toContain('-Recover')
  })

  it('returns only a bounded public code when a service throws private runner detail', async () => {
    const privateDetail = 'C:\\Private\\candidate\\Nebula.dll command stderr secret-token'
    const service = fixtureRouteService()
    service.plan.mockRejectedValueOnce(new Error(privateDetail))
    application = await buildApplication(loadConfig({
      NODE_ENV: 'test',
      DYSON_PUBLIC_ORIGIN: origin,
      DYSON_DEV_ADMIN_PASSWORD: passwords.administrator
    }), { nebulaPluginTransactionService: service })
    const administrator = await login('administrator')

    const response = await post(administrator, '/plan', planBody())
    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({
      ok: false,
      error: { code: 'NEBULA_PLUGIN_TRANSACTION_UNAVAILABLE' }
    })
    expect(response.body).not.toContain(privateDetail)
    expect(response.body).not.toContain('stderr')
  })
})

function fixtureRouteService() {
  return {
    plan: vi.fn(async () => ({
      requestId, targetRole: 'Server' as const, mode: 'dry-run' as const,
      executionEnabled: false as const, planDigest, productionChanged: false as const
    })),
    previewApply: vi.fn(async () => ({
      requestId, targetRole: 'Server' as const, status: 'preview' as const,
      mode: 'dry-run' as const, planDigest, confirmationRequired: true as const,
      productionChanged: false as const
    })),
    apply: vi.fn(async () => applyResult('applied')),
    recoverApply: vi.fn(async () => applyResult('rolled-back-recovery')),
    verifyApply: vi.fn(async () => ({
      requestId, targetRole: 'Server' as const, transactionStatus: 'applied' as const,
      receiptDigest, contentAndAclExact: true as const, rollbackMaterialRetained: true as const
    })),
    previewRollback: vi.fn(async () => ({
      originalRequestId: requestId, rollbackRequestId, status: 'preview' as const,
      mode: 'dry-run' as const, previewDigest,
      exactConfirmationPhrase: rollbackConfirmationPhrase(), productionChanged: false as const
    })),
    rollback: vi.fn(async () => rollbackResult('rolled-back-manual')),
    recoverRollback: vi.fn(async () => rollbackResult('rollback-recovery-restored-candidate')),
    verifyRollback: vi.fn(async () => ({
      originalRequestId: requestId, rollbackRequestId,
      transactionStatus: 'rolled-back-manual' as const, receiptDigest,
      contentAndAclExact: true as const, rollbackMaterialRetained: true as const
    }))
  } satisfies WindowsNebulaPluginTransactionRouteService &
    Record<string, ReturnType<typeof vi.fn>>
}

function applyResult(status: 'applied' | 'rolled-back-recovery') {
  return {
    requestId,
    status,
    receiptDigest,
    reused: false,
    quarantineRetained: status === 'applied',
    candidateStageRetained: status !== 'applied'
  }
}

function rollbackResult(status: 'rolled-back-manual' | 'rollback-recovery-restored-candidate') {
  return {
    originalRequestId: requestId,
    rollbackRequestId,
    status,
    receiptDigest,
    reused: false,
    quarantineRetained: status !== 'rolled-back-manual',
    candidateStageRetained: status === 'rolled-back-manual'
  }
}

function createProductionFixture(gates: { ordinary: boolean; recovery: boolean }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dyson-nebula-api-wiring-'))
  temporaryRoots.push(root)
  const projectRoot = path.join(root, 'project')
  const gameRoot = path.join(projectRoot, 'server')
  const dataRoot = path.join(root, 'data')
  const scriptRoot = path.join(root, 'release', 'scripts', 'windows')
  const jobBase = path.join(root, 'private-jobs')
  for (const directory of [gameRoot, dataRoot, scriptRoot, jobBase]) {
    fs.mkdirSync(directory, { recursive: true })
  }
  const runner = new RecordingRunner()
  const coordinator = new RecordingCoordinator(dataRoot)
  const config = loadConfig({
    NODE_ENV: 'test',
    DYSON_PROVIDER: 'windows',
    DYSON_PUBLIC_ORIGIN: origin,
    DYSON_DEV_ADMIN_PASSWORD: passwords.administrator,
    DYSON_OPERATOR_PASSWORD_HASH: operatorPasswordHash,
    DYSON_PROJECT_ROOT: projectRoot,
    DYSON_DATA_DIR: dataRoot,
    DYSON_SCRIPT_ROOT: scriptRoot,
    DYSON_NEBULA_PLUGIN_JOB_BASE: jobBase,
    DYSON_NEBULA_PLUGIN_TRANSACTION_ENABLED: gates.ordinary ? 'true' : 'false',
    DYSON_NEBULA_PLUGIN_TRANSACTION_RECOVERY_ENABLED: gates.recovery ? 'true' : 'false'
  })
  return {
    config,
    runner,
    coordinator,
    jobBase: path.resolve(jobBase),
    gameRoot: path.resolve(gameRoot),
    dataRoot: path.resolve(dataRoot),
    dependencies: {
      statusProvider: new DemoProvider(),
      nebulaPluginTransactionRunner: runner,
      hostMutationCoordinator: coordinator,
      hostMutationRecoveryCoordinator: coordinator
    }
  }
}

class RecordingRunner implements WindowsNebulaPluginTransactionPowerShellRunner {
  readonly calls: Array<{
    scriptName: WindowsNebulaPluginTransactionScriptName
    arguments_: string[]
    signal: AbortSignal
  }> = []

  async run(
    scriptName: WindowsNebulaPluginTransactionScriptName,
    arguments_: string[],
    signal: AbortSignal
  ): Promise<string> {
    this.calls.push({ scriptName, arguments_: [...arguments_], signal })
    const requestedId = argument(arguments_, '-RequestId') ?? requestId
    if (scriptName === 'New-NebulaPluginCutoverPlan.ps1') {
      return JSON.stringify({
        protocol: 'DYSON_NEBULA_PLUGIN_TRANSACTION_PLAN_V3', requestId: requestedId,
        targetRole: 'Server', mode: 'dry-run', executionEnabled: false,
        planDigest, productionChanged: false
      })
    }
    if (scriptName === 'Invoke-NebulaPluginCutover.ps1') {
      if (!arguments_.includes('-Apply')) {
        return JSON.stringify({
          protocol: 'DYSON_NEBULA_PLUGIN_TRANSACTION_PLAN_V3', status: 'preview',
          mode: 'dry-run', requestId: requestedId, targetRole: 'Server', planDigest,
          confirmationRequired: true, productionChanged: false
        })
      }
      if (arguments_.includes('-Recover')) {
        return JSON.stringify({
          protocol: 'DYSON_NEBULA_PLUGIN_TRANSACTION_RECEIPT_V3',
          status: 'rolled-back-recovery', requestId: requestedId, receiptDigest, reused: false
        })
      }
      return JSON.stringify({
        protocol: 'DYSON_NEBULA_PLUGIN_TRANSACTION_RECEIPT_V3', status: 'applied',
        requestId: requestedId, targetRole: 'Server', receiptDigest,
        quarantineRetained: true, reused: false
      })
    }
    throw new Error('UNEXPECTED_NEBULA_TRANSACTION_SCRIPT')
  }
}

class RecordingCoordinator implements
  HostMutationOperationCoordinator,
  HostMutationRecoveryOperationCoordinator {
  readonly ordinaryRequests: HostMutationOperationRequest[] = []
  readonly recoveryRequests: HostMutationRecoveryOperationRequest[] = []
  readonly #scope: HostMutationOperationScope

  constructor(dataRoot: string) {
    this.#scope = {
      signal: new AbortController().signal,
      assertActive: () => undefined,
      toPowerShellBorrowArguments: () => [
        '-DataRoot', dataRoot,
        '-LeaseInstanceId', leaseInstanceId,
        '-LeaseToken', leaseToken
      ]
    }
  }

  async runExclusive<T>(
    request: HostMutationOperationRequest,
    operation: (scope: HostMutationOperationScope) =>
      Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>
  ): Promise<T> {
    this.ordinaryRequests.push({ ...request })
    return this.#unwrap(await operation(this.#scope))
  }

  async runRecoveryExclusive<T>(
    request: HostMutationRecoveryOperationRequest,
    operation: (scope: HostMutationOperationScope) =>
      Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>
  ): Promise<T> {
    this.recoveryRequests.push({ ...request })
    return this.#unwrap(await operation(this.#scope))
  }

  #unwrap<T>(outcome: HostMutationOperationOutcome<T>): T {
    if (outcome.kind === 'throw') throw outcome.error
    return outcome.value
  }
}

function planBody() {
  return {
    requestId,
    currentPluginsTreeSha256: currentTreeDigest,
    maintenanceWindowStartUtc: windowStart,
    maintenanceWindowEndUtc: windowEnd
  }
}

function applyBody() {
  return {
    requestId,
    planDigest,
    confirmationPhrase: nebulaPluginApplyConfirmationPhrase(requestId, planDigest)
  }
}

function rollbackPreviewBody() {
  return {
    originalRequestId: requestId,
    rollbackRequestId,
    originalReceiptSha256: originalReceiptDigest,
    maintenanceWindowStartUtc: windowStart,
    maintenanceWindowEndUtc: windowEnd
  }
}

function rollbackBody() {
  return {
    ...rollbackPreviewBody(),
    previewDigest,
    confirmationPhrase: rollbackConfirmationPhrase()
  }
}

function rollbackConfirmationPhrase() {
  return `CONFIRM NEBULA PLUGIN ROLLBACK ${rollbackRequestId} ${previewDigest}`
}

function argument(arguments_: readonly string[], name: string): string | null {
  const index = arguments_.indexOf(name)
  return index >= 0 ? arguments_[index + 1] ?? null : null
}

async function login(role: keyof typeof passwords): Promise<string> {
  const response = await application!.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin },
    payload: { role, password: passwords[role] }
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.cookies[0]!.value
}

async function post(cookie: string | null, endpoint: string, payload: object) {
  return application!.app.inject({
    method: 'POST',
    url: `/api/v1/updates/nebula-plugin-transaction${endpoint}`,
    headers: { origin },
    ...(cookie === null ? {} : { cookies: { dyson_session: cookie } }),
    payload
  })
}

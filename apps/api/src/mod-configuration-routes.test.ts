import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApplication, type ApplicationDependencies, type BuiltApplication } from './app.js'
import { loadConfig } from './config.js'
import { DemoProvider } from './providers/demo.js'
import type { WindowsLifecycleBrokerClient } from './providers/windows-lifecycle-broker.js'

const origin = 'http://127.0.0.1:13011'
const deploymentRevision = 'a'.repeat(64)
const configurationRevision = 'b'.repeat(64)
let application: BuiltApplication | null = null

afterEach(async () => { if (application) await application.close(); application = null })

describe('managed mod configuration routes', () => {
  it('keeps schemas/inspection/preview authenticated and refuses unconfigured services', async () => {
    application = await buildApplication(disabledConfig())
    const unauthenticated = await application.app.inject({ method: 'GET', url: '/api/v1/mods/configuration/schemas' })
    expect(unauthenticated.statusCode).toBe(401)
    const cookie = await login(application)
    const configured = await application.app.inject({ method: 'GET', url: '/api/v1/mods/configuration/schemas', cookies: { dyson_session: cookie } })
    expect(configured.statusCode).toBe(503)
    expect(configured.json().error.code).toBe('MOD_CONFIGURATION_NOT_CONFIGURED')
  })

  it('binds execution confirmation to the full logical configuration request and never accepts an extra route field', async () => {
    const service = configurationService()
    application = await buildApplication(enabledConfig(), {
      statusProvider: new DemoProvider(), lifecycleBrokerClient: unusedLifecycleBrokerClient, modConfigurationService: service
    })
    const cookie = await login(application)
    const request = configurationRequest()

    const schemas = await application.app.inject({ method: 'GET', url: '/api/v1/mods/configuration/schemas', cookies: { dyson_session: cookie } })
    expect(schemas.statusCode).toBe(200)
    expect(schemas.json()).toMatchObject({ data: [{ id: request.schemaId }], meta: { executionEnabled: true } })

    const preview = await post(application, cookie, '/api/v1/mods/configuration/preview', request)
    expect(preview.statusCode).toBe(200)
    expect(service.preview).toHaveBeenCalledWith(request)

    const mismatch = await post(application, cookie, '/api/v1/mods/configuration/execute', {
      request, confirmation: { ...confirmationFor(request), expectedConfigurationRevision: 'c'.repeat(64) }
    })
    expect(mismatch.statusCode).toBe(422)
    expect(service.execute).not.toHaveBeenCalled()

    const changedAfterPreview = await post(application, cookie, '/api/v1/mods/configuration/execute', {
      request: { ...request, changes: [{ id: 'host-port', value: 9444 }] },
      confirmation: confirmationFor(request)
    })
    expect(changedAfterPreview.statusCode).toBe(422)
    expect(service.execute).not.toHaveBeenCalled()

    const extra = await post(application, cookie, '/api/v1/mods/configuration/execute', {
      request, confirmation: confirmationFor(request), path: 'C:\\fictional-do-not-accept'
    })
    expect(extra.statusCode).toBe(422)
    expect(extra.body).not.toContain('fictional-do-not-accept')
    expect(service.execute).not.toHaveBeenCalled()

    const execution = await post(application, cookie, '/api/v1/mods/configuration/execute', { request, confirmation: confirmationFor(request) })
    expect(execution.statusCode).toBe(200)
    expect(execution.json()).toMatchObject({ data: { requestId: request.requestId, status: 'applied', protectionPointCreated: true } })
    expect(service.execute).toHaveBeenCalledWith(request)
  })
})

function disabledConfig() {
  return loadConfig({ NODE_ENV: 'test', DYSON_PROVIDER: 'demo', DYSON_DEV_ADMIN_PASSWORD: 'test-password-long-enough', DYSON_PUBLIC_ORIGIN: origin })
}

function enabledConfig() {
  return loadConfig({
    NODE_ENV: 'test', DYSON_PROVIDER: 'windows', DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson', DYSON_LIFECYCLE_ENABLED: 'true',
    DYSON_LIFECYCLE_BROKER_PROFILE_FILE: 'C:\\ProgramData\\DysonControl\\data\\lifecycle-broker\\broker-profile.json',
    DYSON_RUNTIME_SERVICE_USER: '.\\FictionalDyson', DYSON_RUNTIME_BOOTSTRAP_ROOT: 'C:\\Program Files\\DysonControl\\bootstrap',
    DYSON_BRIDGE_CONTROL_ROOT: 'C:\\Fictional\\Dyson\\run\\control-bridge', DYSON_BRIDGE_SECRET_FILE: 'C:\\ProgramData\\DysonControl\\bridge.secret',
    DYSON_MOD_DEPLOYMENT_ENABLED: 'true', DYSON_MOD_STAGING_ROOT: 'C:\\Fictional\\Dyson\\staged-mods',
    DYSON_MOD_PLUGINS_ROOT: 'C:\\Fictional\\Dyson\\server\\BepInEx\\plugins\\dyson-managed-mods',
    DYSON_DEV_ADMIN_PASSWORD: 'test-password-long-enough', DYSON_PUBLIC_ORIGIN: origin
  })
}

function configurationRequest() {
  return {
    requestId: '11111111-1111-4111-8111-111111111111', operation: 'configure' as const,
    schemaId: 'nebula-server-v0-9-22', package: { dependencyId: 'nebula-NebulaMultiplayerMod-0.9.22', version: '0.9.22' },
    expectedDeploymentRevision: deploymentRevision, expectedConfigurationRevision: configurationRevision,
    changes: [{ id: 'host-port', value: 9443 }]
  }
}

function confirmationFor(request: ReturnType<typeof configurationRequest>) {
  return {
    action: 'EXECUTE_MOD_CONFIGURATION', requestId: request.requestId, schemaId: request.schemaId,
    dependencyId: request.package.dependencyId, version: request.package.version,
    expectedDeploymentRevision: request.expectedDeploymentRevision, expectedConfigurationRevision: request.expectedConfigurationRevision,
    requestFingerprint: fingerprintFor(request),
    confirmation: 'CONFIGURE_MANAGED_MOD'
  }
}

function fingerprintFor(request: ReturnType<typeof configurationRequest>): string {
  return createHash('sha256').update(JSON.stringify(request), 'utf8').digest('hex')
}

function configurationService() {
  const request = configurationRequest()
  const receipt = {
    format: 'dyson-control-managed-mod-configuration-receipt' as const, schemaVersion: 1 as const,
    requestId: request.requestId, operation: 'configure' as const, schemaId: request.schemaId, package: request.package,
    deploymentRevision, previousConfigurationRevision: configurationRevision, newConfigurationRevision: 'd'.repeat(64),
    status: 'applied' as const, rollback: 'not-needed' as const, protectionPointCreated: true,
    changedFieldIds: ['host-port'], errorCode: null, completedAt: '2026-09-02T00:00:00.000Z', reused: false
  }
  return {
    schemas: vi.fn(() => [{ id: request.schemaId, package: request.package, fields: [{ id: 'host-port', type: 'integer', secret: false, minimum: 1, maximum: 65_535 }] }]),
    inspect: vi.fn(async () => ({ schemaId: request.schemaId, package: request.package, deploymentRevision, configurationRevision, fields: [{ id: 'host-port', type: 'integer', value: 8469 }] })),
    preview: vi.fn(async (input: typeof request) => ({ dryRun: true as const, operation: 'configure' as const, requestId: input.requestId, schemaId: input.schemaId, package: input.package, deploymentRevision, configurationRevision, nextConfigurationRevision: 'd'.repeat(64), requestFingerprint: fingerprintFor(input), changes: [{ id: 'host-port', before: 8469, after: 9443, changed: true }], stoppedStateRequiredForExecute: true as const, executionSupported: true as const })),
    execute: vi.fn(async () => receipt),
    receipt: vi.fn(async () => receipt),
    history: vi.fn(async () => ({ format: 'dyson-control-managed-mod-configuration-history' as const, schemaVersion: 1 as const, items: [], page: { limit: 20, returned: 0, totalReceipts: 0, nextCursor: null } }))
  } satisfies NonNullable<ApplicationDependencies['modConfigurationService']>
}

async function login(target: BuiltApplication): Promise<string> {
  const response = await target.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { role: 'administrator', password: 'test-password-long-enough' } })
  expect(response.statusCode).toBe(200)
  return response.cookies[0]!.value
}

async function post(target: BuiltApplication, cookie: string, url: string, payload: object) {
  return await target.app.inject({ method: 'POST', url, headers: { origin }, cookies: { dyson_session: cookie }, payload })
}

const unusedLifecycleBrokerClient = {
  preflight: async () => { throw new Error('unused lifecycle broker preflight') }, dispatch: async () => { throw new Error('unused lifecycle broker dispatch') },
  verify: async () => { throw new Error('unused lifecycle broker verify') }, status: async () => { throw new Error('unused lifecycle broker status') }
} satisfies WindowsLifecycleBrokerClient

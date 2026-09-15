import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildApplication,
  type ApplicationDependencies,
  type BuiltApplication
} from './app.js'
import { loadConfig } from './config.js'
import type {
  LifecycleAction,
  LifecycleMutationAdapter,
  LifecycleOperationContext,
  LifecyclePhaseResult,
  LifecyclePreview,
  LifecyclePreviewContext,
  ServerStatus,
  StatusProvider
} from './domain.js'
import type {
  HostMutationOperationCoordinator,
  HostMutationOperationOutcome
} from './host-mutation/operation-coordinator.js'
import { DemoProvider } from './providers/demo.js'
import type {
  LifecycleBrokerStatusEvidence,
  WindowsLifecycleBrokerClient
} from './providers/windows-lifecycle-broker.js'

const publicOrigin = 'http://127.0.0.1:13010'
let application: BuiltApplication | null = null
const temporaryRoots: string[] = []

afterEach(async () => {
  if (application !== null) await application.close()
  application = null
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('update provider readiness assembly', () => {
  it('fails readiness when Steam handoff is enabled without a constructed controller/provider', async () => {
    const fixture = await createWindowsFixture({ steamManualHandoffEnabled: true })
    application = await buildApplication(fixture.config, fixture.dependencies)

    const readiness = await application.app.inject({ method: 'GET', url: '/readyz' })

    expect.soft(readiness.statusCode).toBe(503)
    expect.soft(readiness.json()).toMatchObject({
      status: 'not-ready',
      checks: { steamHandoffRecovery: 'fail' }
    })
  })

  it('fails readiness when Steam handoff has an injected ready controller but no transaction provider', async () => {
    const fixture = await createWindowsFixture({ steamManualHandoffEnabled: true })
    const controller = readySteamManualHandoffController()
    application = await buildApplication(fixture.config, {
      ...fixture.dependencies,
      steamManualHandoffController: controller
    })

    const readiness = await application.app.inject({ method: 'GET', url: '/readyz' })

    expect.soft(readiness.statusCode).toBe(503)
    expect.soft(readiness.json()).toMatchObject({
      status: 'not-ready',
      checks: { steamHandoffRecovery: 'fail' }
    })
    expect(controller.initialize).toHaveBeenCalledOnce()
    expect(controller.recoveryStatus).not.toHaveBeenCalled()
  })

  for (const flag of ['updateActivationEnabled', 'updateActivationRecoveryEnabled'] as const) {
    it(`fails readiness when ${flag} is enabled without a real transaction provider`, async () => {
      const fixture = await createWindowsFixture({ [flag]: true })
      application = await buildApplication(fixture.config, {
        ...fixture.dependencies,
        hostMutationCoordinator: new PassThroughHostMutationCoordinator()
      })

      const readiness = await application.app.inject({ method: 'GET', url: '/readyz' })

      expect.soft(readiness.statusCode).toBe(503)
      expect.soft(readiness.json()).toMatchObject({
        status: 'not-ready',
        checks: { activationRecovery: 'fail' }
      })
    })
  }

  it('keeps explicitly disabled update capabilities not applicable', async () => {
    application = await buildApplication(loadConfig({
      NODE_ENV: 'test',
      DYSON_PROVIDER: 'demo',
      DYSON_PUBLIC_ORIGIN: publicOrigin,
      DYSON_DEV_ADMIN_PASSWORD: 'fictional-administrator-password'
    }))

    const readiness = await application.app.inject({ method: 'GET', url: '/readyz' })

    expect(readiness.statusCode).toBe(200)
    expect(readiness.json()).toMatchObject({
      status: 'ready',
      checks: {
        activationRecovery: 'not-applicable',
        steamHandoffRecovery: 'not-applicable'
      }
    })
  })

  it('does not read a missing compatibility policy when the demo provider has no compatibility consumer', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dyson-unused-demo-policy-'))
    temporaryRoots.push(root)
    application = await buildApplication(loadConfig({
      NODE_ENV: 'test',
      DYSON_PROVIDER: 'demo',
      DYSON_PUBLIC_ORIGIN: publicOrigin,
      DYSON_DEV_ADMIN_PASSWORD: 'fictional-administrator-password',
      DYSON_DATA_DIR: path.join(root, 'fictional-data'),
      DYSON_UPDATE_COMPATIBILITY_POLICY_FILE: path.join(root, 'missing-policy.json')
    }))

    const readiness = await application.app.inject({ method: 'GET', url: '/readyz' })

    expect(readiness.statusCode).toBe(200)
    expect(readiness.json()).toMatchObject({
      status: 'ready',
      checks: {
        activationRecovery: 'not-applicable',
        steamHandoffRecovery: 'not-applicable'
      }
    })
  })

  it('does not read a malformed compatibility policy when disabled Windows capabilities have no staging consumer', async () => {
    const fixture = await createWindowsFixture({ compatibilityPolicy: 'malformed' })
    application = await buildApplication(fixture.config, fixture.dependencies)

    const readiness = await application.app.inject({ method: 'GET', url: '/readyz' })

    expect(readiness.statusCode).toBe(200)
    expect(readiness.json()).toMatchObject({
      status: 'ready',
      checks: {
        activationRecovery: 'not-applicable',
        steamHandoffRecovery: 'not-applicable'
      }
    })
  })
})

interface FixtureOptions {
  compatibilityPolicy?: 'valid' | 'malformed' | 'missing'
  steamManualHandoffEnabled?: boolean
  updateActivationEnabled?: boolean
  updateActivationRecoveryEnabled?: boolean
}

async function createWindowsFixture(options: FixtureOptions) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dyson-update-provider-readiness-'))
  temporaryRoots.push(root)
  const dataDir = path.join(root, 'fictional-data')
  const projectRoot = path.join(root, 'fictional-project')
  const stagingRoot = path.join(root, 'fictional-staging')
  const inboxRoot = path.join(root, 'fictional-inbox')
  const compatibilityPolicyFile = path.join(root, 'fictional-compatibility-policy.json')
  fs.mkdirSync(path.join(projectRoot, 'server', 'BepInEx', 'plugins'), { recursive: true })
  fs.mkdirSync(stagingRoot, { recursive: true })
  fs.mkdirSync(inboxRoot, { recursive: true })
  if (options.compatibilityPolicy !== 'missing') {
    fs.writeFileSync(
      compatibilityPolicyFile,
      options.compatibilityPolicy === 'malformed'
        ? '{not-json'
        : JSON.stringify({
            format: 'dyson-control-trusted-compatibility-policy',
            schemaVersion: 1,
            policyId: 'fictional-update-provider-readiness',
            reviewedAt: '2026-09-01T00:00:00.000Z',
            matrix: {
              schemaVersion: 1,
              entries: [{
                id: 'fictional-nebula-091',
                core: {
                  dsp: { equals: '0.10.33.26727' },
                  nebula: { equals: '0.9.1' },
                  bepInEx: { equals: '5.4.22' }
                },
                plugins: []
              }]
            }
          })
    )
  }

  const status = await createWindowsStatus()
  const config = loadConfig({
    NODE_ENV: 'test',
    DYSON_PROVIDER: 'windows',
    DYSON_PUBLIC_ORIGIN: publicOrigin,
    DYSON_DEV_ADMIN_PASSWORD: 'fictional-administrator-password',
    DYSON_DATA_DIR: dataDir,
    DYSON_PROJECT_ROOT: projectRoot,
    DYSON_SCRIPT_ROOT: path.join(root, 'fictional-fixed-scripts'),
    DYSON_RUNTIME_BOOTSTRAP_ROOT: path.join(root, 'fictional-runtime-bootstrap'),
    DYSON_LIFECYCLE_ENABLED: 'true',
    DYSON_LIFECYCLE_BROKER_PROFILE_FILE: path.join(dataDir, 'lifecycle-broker', 'broker-profile.json'),
    DYSON_RUNTIME_SERVICE_USER: '.\\FictionalDyson',
    DYSON_BRIDGE_CONTROL_ROOT: path.join(root, 'fictional-bridge-control'),
    DYSON_BRIDGE_SECRET_FILE: path.join(root, 'fictional-private', 'bridge.secret'),
    DYSON_UPDATE_COMPATIBILITY_POLICY_FILE: compatibilityPolicyFile,
    DYSON_UPDATE_STAGING_ENABLED:
      options.updateActivationEnabled || options.updateActivationRecoveryEnabled ? 'true' : 'false',
    DYSON_UPDATE_INBOX_ROOT:
      options.updateActivationEnabled || options.updateActivationRecoveryEnabled ? inboxRoot : undefined,
    DYSON_UPDATE_STAGING_ROOT:
      options.updateActivationEnabled || options.updateActivationRecoveryEnabled ? stagingRoot : undefined,
    DYSON_UPDATE_ACTIVATION_ENABLED: options.updateActivationEnabled ? 'true' : 'false',
    DYSON_UPDATE_ACTIVATION_RECOVERY_ENABLED: options.updateActivationRecoveryEnabled ? 'true' : 'false',
    DYSON_STEAM_MANUAL_HANDOFF_ENABLED: options.steamManualHandoffEnabled ? 'true' : 'false',
    DYSON_OBSERVABILITY_INTERVAL_MS: '0'
  })

  return {
    config,
    dependencies: {
      statusProvider: createWindowsStatusProvider(status),
      lifecycleAdapter: new ReadinessLifecycleAdapter(),
      lifecycleBrokerClient: createLifecycleBrokerClient(config.gamePort)
    }
  }
}

type FixtureSteamController = NonNullable<ApplicationDependencies['steamManualHandoffController']> & {
  initialize: ReturnType<typeof vi.fn>
  recoveryStatus: ReturnType<typeof vi.fn>
}

function readySteamManualHandoffController(): FixtureSteamController {
  const unused = vi.fn(async () => {
    throw new Error('UNEXPECTED_STEAM_CONTROLLER_RUNTIME_CALL')
  })
  return {
    initialize: vi.fn(async () => undefined),
    state: unused,
    recoveryStatus: vi.fn(async () => ({
      statusCode: 200,
      body: {
        ok: true,
        data: {
          phase: 'ready',
          reconciledRequestId: null,
          failureCode: null,
          updatedAt: '2026-09-01T00:00:00.000Z'
        }
      }
    })),
    getReceipt: unused,
    preview: unused,
    begin: unused,
    confirm: unused
  } as unknown as FixtureSteamController
}

async function createWindowsStatus(): Promise<ServerStatus> {
  const status = await new DemoProvider().collectStatus()
  return {
    ...status,
    state: 'stopped',
    automation: { ...status.automation, projectRootAvailable: true }
  }
}

function createWindowsStatusProvider(status: ServerStatus): StatusProvider {
  return {
    name: 'windows',
    collectStatus: vi.fn(async () => status),
    previewLifecycle: vi.fn(async () => { throw new Error('UNEXPECTED_STATUS_PROVIDER_PREVIEW') })
  }
}

function createLifecycleBrokerClient(gamePort: number): WindowsLifecycleBrokerClient {
  const evidence: LifecycleBrokerStatusEvidence = {
    lifecycleState: 'stopped_verified',
    task: {
      valid: true,
      server: { name: 'Dyson-Nebula-Server', path: '\\', state: 'Ready' },
      stop: { name: 'Dyson-Nebula-Stop', path: '\\', state: 'Ready' }
    },
    runtime: {
      lifecycleState: 'stopped_verified',
      session: { status: 'verified', id: 7, count: 1 },
      steam: { status: 'verified', pid: 1101, sessionId: 7 },
      process: { status: 'absent', pid: null, owner: null, sessionId: null },
      port: { port: gamePort, listenerCount: 0 },
      pidFile: { present: false, valid: false }
    }
  }
  return {
    preflight: vi.fn(async () => { throw new Error('UNEXPECTED_BROKER_PREFLIGHT') }),
    dispatch: vi.fn(async () => { throw new Error('UNEXPECTED_BROKER_DISPATCH') }),
    verify: vi.fn(async () => { throw new Error('UNEXPECTED_BROKER_VERIFY') }),
    status: vi.fn(async () => evidence)
  }
}

class PassThroughHostMutationCoordinator implements HostMutationOperationCoordinator {
  async runExclusive<T>(
    _request: Readonly<{ operation: string; requestId: string }>,
    operation: Parameters<HostMutationOperationCoordinator['runExclusive']>[1]
  ): Promise<T> {
    const outcome = await operation({
      signal: new AbortController().signal,
      assertActive: () => undefined,
      toPowerShellBorrowArguments: () => []
    }) as HostMutationOperationOutcome<T>
    if (outcome.kind === 'throw') throw outcome.error
    return outcome.value
  }
}

class ReadinessLifecycleAdapter implements LifecycleMutationAdapter {
  readonly mutationEnabled = true

  async previewLifecycle(action: LifecycleAction, _context?: LifecyclePreviewContext): Promise<LifecyclePreview> {
    return {
      collectedAt: new Date().toISOString(),
      action,
      mode: 'dry-run',
      allowed: true,
      executionEnabled: true,
      checks: [{ id: 'execution-lock', status: 'pass', message: 'Fixture is ready.' }],
      blockers: [],
      rollback: action === 'start'
        ? { strategy: 'no-op', ready: true, summary: 'No rollback required.' }
        : { strategy: 'paired-save-backup', ready: true, summary: 'Rollback is ready.' }
    }
  }

  async createProtectionPoint(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    return { summary: 'Fixture protection point.', protectionPointId: 'backup:fixture' }
  }

  async requestSave(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    return { summary: 'Fixture save.', evidence: { pairStable: true } }
  }

  async requestGracefulStop(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    return { summary: 'Fixture stop.' }
  }

  async verifyStopped(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    return { summary: 'Fixture stopped.' }
  }

  async requestStart(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    return { summary: 'Fixture start.' }
  }

  async verifyRunning(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    return { summary: 'Fixture running.' }
  }

  async requestRollbackStart(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    return { summary: 'Fixture rollback start.' }
  }
}

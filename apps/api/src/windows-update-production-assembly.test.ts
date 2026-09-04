import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
  HostMutationOperationOutcome,
  HostMutationOperationRequest,
  HostMutationOperationScope,
  HostMutationRecoveryOperationRequest,
  HostMutationRecoveryOperationCoordinator
} from './host-mutation/operation-coordinator.js'
import { DemoProvider } from './providers/demo.js'
import type {
  LifecycleBrokerStatusEvidence,
  WindowsLifecycleBrokerClient
} from './providers/windows-lifecycle-broker.js'

const publicOrigin = 'http://127.0.0.1:13010'
const administratorPassword = 'fictional-administrator-password'
const bridgeSecret = 'fictional-bridge-secret-for-production-assembly-tests-0001'
const steamRequestId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
let application: BuiltApplication | null = null
const temporaryRoots: string[] = []

afterEach(async () => {
  if (application !== null) await application.close()
  application = null
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Windows update production assembly', () => {
  for (const enabledFlag of [
    'updateActivationEnabled',
    'updateActivationRecoveryEnabled',
    'steamManualHandoffEnabled'
  ] as const) {
    it(`constructs the real default provider/controller when ${enabledFlag} is enabled`, async () => {
      const fixture = await createFixture({ [enabledFlag]: true })
      application = await buildApplication(fixture.config, fixture.dependencies)

      const readiness = await application.app.inject({ method: 'GET', url: '/readyz' })
      expect(readiness.statusCode, JSON.stringify(readiness.json())).toBe(200)
      expect(readiness.json()).toMatchObject({
        status: 'ready',
        checks: enabledFlag === 'steamManualHandoffEnabled'
          ? { steamHandoffRecovery: 'pass' }
          : { activationRecovery: 'pass' }
      })

      const cookie = await loginAdministrator()
      if (enabledFlag === 'steamManualHandoffEnabled') {
        const state = await application.app.inject({
          method: 'GET',
          url: '/api/v1/updates/steam-handoff/state',
          cookies: { dyson_session: cookie }
        })
        expect(state.statusCode).toBe(200)
        expect(state.json().error?.code).not.toBe('DSP_STEAM_HANDOFF_NOT_CONFIGURED')

        const preview = await application.app.inject({
          method: 'POST',
          url: '/api/v1/updates/steam-handoff/preview',
          headers: { origin: publicOrigin },
          cookies: { dyson_session: cookie },
          payload: {
            requestId: steamRequestId,
            targetVersion: '0.10.35.29485',
            expectedRevision: state.json().data.revision
          }
        })
        expect(preview.statusCode).toBe(200)
        expect(preview.json()).toMatchObject({
          ok: true,
          data: { dryRun: true, accountAutomation: false }
        })
        expect(preview.json().error?.code).not.toBe('DSP_STEAM_HANDOFF_NOT_CONFIGURED')
      } else {
        const state = await application.app.inject({
          method: 'GET',
          url: '/api/v1/updates/activation/state',
          cookies: { dyson_session: cookie }
        })
        expect(state.statusCode).toBe(200)
        expect(state.json().error?.code).not.toBe('UPDATE_ACTIVATION_NOT_CONFIGURED')
      }

      expect(fixture.runtimeCalls).toEqual([])
      expect(fixture.hostMutationCoordinator.operations).toEqual(
        enabledFlag === 'steamManualHandoffEnabled'
          ? []
          : [{
              mode: 'ordinary',
              operation: 'component-update-reconciliation',
              requestId: expect.stringMatching(/^[0-9a-f-]{36}$/)
            }]
      )
    })
  }

  for (const missingAuthority of [
    'bridge-secret',
    'bridge-control-root',
    'mod-staging-root',
    'mod-plugins-root',
    'compatibility-policy',
    'runtime-receipt-root'
  ] as const) {
    it(`fails closed when the fixed ${missingAuthority} authority is missing`, async () => {
      const fixture = await createFixture({
        updateActivationEnabled: true,
        updateActivationRecoveryEnabled: true,
        steamManualHandoffEnabled: true,
        missingAuthority
      })

      try {
        application = await buildApplication(fixture.config, fixture.dependencies)
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
        expect(fixture.runtimeCalls).toEqual([])
        return
      }

      const readiness = await application.app.inject({ method: 'GET', url: '/readyz' })
      expect(readiness.statusCode).toBe(503)
      expect(readiness.json()).toMatchObject({ status: 'not-ready' })
      expect([
        readiness.json().checks.activationRecovery,
        readiness.json().checks.steamHandoffRecovery
      ]).toContain('fail')
      expect(fixture.runtimeCalls).toEqual([])
    })
  }

  for (const invalidSecret of [
    { label: 'empty', value: '' },
    { label: 'shorter than 32 characters', value: 'too-short' },
    { label: 'longer than 512 characters', value: 'x'.repeat(513) },
    {
      label: 'containing CR/LF',
      value: 'fictional-bridge-secret-with-newline-0001\r\nsecond-line'
    },
    {
      label: 'containing NUL',
      value: 'fictional-bridge-secret-with-nul-0000001\0suffix'
    }
  ]) {
    it(`fails closed when the Bridge secret is ${invalidSecret.label}`, async () => {
      const fixture = await createFixture({
        updateActivationEnabled: true,
        updateActivationRecoveryEnabled: true,
        steamManualHandoffEnabled: true,
        bridgeSecretContents: invalidSecret.value
      })

      await expectBuildRejectedOrNotReady(fixture)
    })
  }

  it('fails closed when the Bridge secret endpoint is a symbolic link', async (context) => {
    const fixture = await createFixture({
      updateActivationEnabled: true,
      updateActivationRecoveryEnabled: true,
      steamManualHandoffEnabled: true
    })
    const externalSecret = path.join(
      path.dirname(path.dirname(fixture.authorities.bridgeSecretFile)),
      'fictional-external-secret'
    )
    await writeFile(externalSecret, bridgeSecret)
    await rm(fixture.authorities.bridgeSecretFile)
    try {
      await symlink(externalSecret, fixture.authorities.bridgeSecretFile, 'file')
    } catch (error) {
      if (isUnsupportedLinkError(error)) {
        context.skip(`Node could not create a file symlink on this Windows host: ${linkErrorCode(error)}`)
        return
      }
      throw error
    }

    await expectBuildRejectedOrNotReady(fixture)
  })

  it('fails closed when an ancestor of the Bridge secret is a junction redirect', async (context) => {
    const fixture = await createFixture({
      updateActivationEnabled: true,
      updateActivationRecoveryEnabled: true,
      steamManualHandoffEnabled: true
    })
    const configuredParent = path.dirname(fixture.authorities.bridgeSecretFile)
    const redirectedParent = path.join(path.dirname(configuredParent), 'fictional-redirected-private')
    await mkdir(redirectedParent)
    await writeFile(path.join(redirectedParent, path.basename(fixture.authorities.bridgeSecretFile)), bridgeSecret)
    await rm(configuredParent, { recursive: true })
    try {
      await symlink(redirectedParent, configuredParent, 'junction')
    } catch (error) {
      if (isUnsupportedLinkError(error)) {
        context.skip(`Node could not create a directory junction on this Windows host: ${linkErrorCode(error)}`)
        return
      }
      throw error
    }

    await expectBuildRejectedOrNotReady(fixture)
  })

  it('fails readiness when a required authority is deleted after successful construction', async () => {
    const fixture = await createFixture({
      updateActivationEnabled: true,
      updateActivationRecoveryEnabled: true,
      steamManualHandoffEnabled: true
    })
    application = await buildApplication(fixture.config, fixture.dependencies)
    await expectApplicationReady()

    await rm(fixture.authorities.bridgeSecretFile)

    await expectApplicationNotReady()
    expect(fixture.runtimeCalls).toEqual([])
  })

  it('fails readiness when a required authority is replaced after successful construction', async () => {
    const fixture = await createFixture({
      updateActivationEnabled: true,
      updateActivationRecoveryEnabled: true,
      steamManualHandoffEnabled: true
    })
    application = await buildApplication(fixture.config, fixture.dependencies)
    await expectApplicationReady()

    await writeFile(
      fixture.authorities.bridgeSecretFile,
      'replacement-bridge-secret-for-drift-detection-tests-0001'
    )

    await expectApplicationNotReady()
    expect(fixture.runtimeCalls).toEqual([])
  })

  it('remains ready after the managed mod live root is atomically published', async () => {
    const fixture = await createFixture({
      updateActivationEnabled: true,
      updateActivationRecoveryEnabled: true,
      steamManualHandoffEnabled: true
    })
    application = await buildApplication(fixture.config, fixture.dependencies)
    await expectApplicationReady()

    const liveRoot = fixture.authorities.modPluginsRoot
    const parentRoot = path.dirname(liveRoot)
    const snapshotRoot = path.join(parentRoot, 'fictional-managed-snapshot')
    const pendingRoot = path.join(parentRoot, 'fictional-managed-pending')
    await mkdir(pendingRoot)
    await rename(liveRoot, snapshotRoot)
    await rename(pendingRoot, liveRoot)

    await expectApplicationReady()
    expect(fixture.runtimeCalls).toEqual([])
  })

  it('fails readiness when the managed mod live root becomes a junction redirect', async (context) => {
    const fixture = await createFixture({
      updateActivationEnabled: true,
      updateActivationRecoveryEnabled: true,
      steamManualHandoffEnabled: true
    })
    application = await buildApplication(fixture.config, fixture.dependencies)
    await expectApplicationReady()

    const liveRoot = fixture.authorities.modPluginsRoot
    const redirectedRoot = path.join(path.dirname(path.dirname(liveRoot)), 'fictional-external-mod-root')
    await mkdir(redirectedRoot)
    await rm(liveRoot, { recursive: true })
    try {
      await symlink(redirectedRoot, liveRoot, 'junction')
    } catch (error) {
      if (isUnsupportedLinkError(error)) {
        context.skip(`Node could not create a directory junction on this Windows host: ${linkErrorCode(error)}`)
        return
      }
      throw error
    }

    await expectApplicationNotReady()
    expect(fixture.runtimeCalls).toEqual([])
  })
})

type EnabledFlag =
  | 'updateActivationEnabled'
  | 'updateActivationRecoveryEnabled'
  | 'steamManualHandoffEnabled'

type MissingAuthority =
  | 'bridge-secret'
  | 'bridge-control-root'
  | 'mod-staging-root'
  | 'mod-plugins-root'
  | 'compatibility-policy'
  | 'runtime-receipt-root'

type FixtureOptions = Partial<Record<EnabledFlag, boolean>> & {
  bridgeSecretContents?: string
  missingAuthority?: MissingAuthority
}

async function createFixture(options: FixtureOptions) {
  const root = await mkdtemp(path.join(tmpdir(), 'dyson-windows-update-production-assembly-'))
  temporaryRoots.push(root)
  const projectRoot = path.join(root, 'fictional-project')
  const dataRoot = path.join(root, 'fictional-data')
  const scriptRoot = path.join(root, 'fictional-fixed-scripts')
  const runtimeBootstrapRoot = path.join(root, 'fictional-runtime-bootstrap')
  const updateInboxRoot = path.join(root, 'fictional-update-inbox')
  const updateStagingRoot = path.join(root, 'fictional-update-staging')
  const modStagingRoot = path.join(root, 'fictional-mod-staging')
  const modPluginsRoot = path.join(
    projectRoot,
    'server',
    'BepInEx',
    'plugins',
    'dyson-managed-mods'
  )
  const bridgeControlRoot = path.join(root, 'fictional-bridge-control')
  const bridgeSecretFile = path.join(root, 'fictional-private', 'bridge.secret')
  const compatibilityPolicyFile = path.join(root, 'fictional-compatibility-policy.json')
  const runtimeReceiptRoot = path.join(dataRoot, 'state', 'game-runtime-receipts')
  const lifecycleBrokerProfileFile = path.join(
    dataRoot,
    'lifecycle-broker',
    'broker-profile.json'
  )

  await Promise.all([
    mkdir(path.join(projectRoot, 'server', 'BepInEx', 'config'), { recursive: true }),
    mkdir(path.join(projectRoot, 'userdata', 'Save'), { recursive: true }),
    mkdir(path.join(projectRoot, 'backups', 'saves'), { recursive: true }),
    mkdir(scriptRoot, { recursive: true }),
    mkdir(runtimeBootstrapRoot, { recursive: true }),
    mkdir(updateInboxRoot, { recursive: true }),
    mkdir(updateStagingRoot, { recursive: true }),
    mkdir(path.dirname(bridgeSecretFile), { recursive: true }),
    mkdir(path.dirname(lifecycleBrokerProfileFile), { recursive: true }),
    ...(options.missingAuthority === 'mod-staging-root'
      ? []
      : [mkdir(modStagingRoot, { recursive: true })]),
    ...(options.missingAuthority === 'mod-plugins-root'
      ? [mkdir(path.dirname(modPluginsRoot), { recursive: true })]
      : [mkdir(modPluginsRoot, { recursive: true })]),
    ...(options.missingAuthority === 'bridge-control-root'
      ? []
      : [
          mkdir(path.join(bridgeControlRoot, 'requests'), { recursive: true }),
          mkdir(path.join(bridgeControlRoot, 'receipts'), { recursive: true })
        ]),
    ...(options.missingAuthority === 'runtime-receipt-root'
      ? [mkdir(path.dirname(runtimeReceiptRoot), { recursive: true })]
      : [mkdir(runtimeReceiptRoot, { recursive: true })])
  ])

  await Promise.all([
    writeFile(path.join(projectRoot, 'userdata', 'Save', '_lastexit_.dsv'), 'fictional-dsv'),
    writeFile(path.join(projectRoot, 'userdata', 'Save', '_lastexit_.server'), 'fictional-server'),
    writeFile(lifecycleBrokerProfileFile, '{}'),
    ...(options.missingAuthority === 'bridge-secret'
      ? []
      : [writeFile(bridgeSecretFile, options.bridgeSecretContents ?? bridgeSecret, { mode: 0o600 })]),
    ...(options.missingAuthority === 'compatibility-policy'
      ? []
      : [writeFile(compatibilityPolicyFile, JSON.stringify(compatibilityPolicy))])
  ])

  const status = await stoppedWindowsStatus()
  const runtimeCalls: string[] = []
  const activationEnabled = options.updateActivationEnabled === true ||
    options.updateActivationRecoveryEnabled === true
  const config = loadConfig({
    NODE_ENV: 'test',
    DYSON_PROVIDER: 'windows',
    DYSON_PUBLIC_ORIGIN: publicOrigin,
    DYSON_DEV_ADMIN_PASSWORD: administratorPassword,
    DYSON_DATA_DIR: dataRoot,
    DYSON_PROJECT_ROOT: projectRoot,
    DYSON_SCRIPT_ROOT: scriptRoot,
    DYSON_RUNTIME_BOOTSTRAP_ROOT: runtimeBootstrapRoot,
    DYSON_LIFECYCLE_ENABLED: 'true',
    DYSON_LIFECYCLE_BROKER_PROFILE_FILE: lifecycleBrokerProfileFile,
    DYSON_RUNTIME_SERVICE_USER: '.\\FictionalDyson',
    DYSON_BRIDGE_CONTROL_ROOT: bridgeControlRoot,
    DYSON_BRIDGE_SECRET_FILE: bridgeSecretFile,
    DYSON_UPDATE_STAGING_ENABLED: activationEnabled ? 'true' : 'false',
    DYSON_UPDATE_INBOX_ROOT: updateInboxRoot,
    DYSON_UPDATE_STAGING_ROOT: updateStagingRoot,
    DYSON_UPDATE_COMPATIBILITY_POLICY_FILE: compatibilityPolicyFile,
    DYSON_MOD_STAGING_ROOT: modStagingRoot,
    DYSON_MOD_PLUGINS_ROOT: modPluginsRoot,
    DYSON_UPDATE_ACTIVATION_ENABLED: options.updateActivationEnabled ? 'true' : 'false',
    DYSON_UPDATE_ACTIVATION_RECOVERY_ENABLED:
      options.updateActivationRecoveryEnabled ? 'true' : 'false',
    DYSON_STEAM_MANUAL_HANDOFF_ENABLED: options.steamManualHandoffEnabled ? 'true' : 'false',
    DYSON_OBSERVABILITY_INTERVAL_MS: '0'
  })
  const hostMutationCoordinator = new FixtureHostMutationCoordinator()

  return {
    config,
    dependencies: {
      statusProvider: windowsStatusProvider(status, runtimeCalls),
      lifecycleAdapter: new NoProductionLifecycleAdapter(runtimeCalls),
      lifecycleBrokerClient: lifecycleBrokerClient(config.gamePort, runtimeCalls),
      hostMutationCoordinator,
      hostMutationRecoveryCoordinator: hostMutationCoordinator
    } satisfies ApplicationDependencies,
    hostMutationCoordinator,
    runtimeCalls,
    authorities: {
      bridgeSecretFile,
      compatibilityPolicyFile,
      modPluginsRoot
    }
  }
}

type Fixture = Awaited<ReturnType<typeof createFixture>>

async function expectBuildRejectedOrNotReady(fixture: Fixture): Promise<void> {
  try {
    application = await buildApplication(fixture.config, fixture.dependencies)
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect(fixture.runtimeCalls).toEqual([])
    return
  }
  await expectApplicationNotReady()
  expect(fixture.runtimeCalls).toEqual([])
}

async function expectApplicationReady(): Promise<void> {
  const readiness = await application!.app.inject({ method: 'GET', url: '/readyz' })
  expect(readiness.statusCode, JSON.stringify(readiness.json())).toBe(200)
  expect(readiness.json()).toMatchObject({ status: 'ready' })
}

async function expectApplicationNotReady(): Promise<void> {
  const readiness = await application!.app.inject({ method: 'GET', url: '/readyz' })
  expect(readiness.statusCode).toBe(503)
  expect(readiness.json()).toMatchObject({
    status: 'not-ready',
    checks: {
      activationRecovery: 'fail',
      steamHandoffRecovery: 'fail'
    }
  })
}

function isUnsupportedLinkError(error: unknown): boolean {
  return error instanceof Error && 'code' in error &&
    ['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL'].includes(String(error.code))
}

function linkErrorCode(error: unknown): string {
  return error instanceof Error && 'code' in error ? String(error.code) : 'unknown'
}

const compatibilityPolicy = {
  format: 'dyson-control-trusted-compatibility-policy',
  schemaVersion: 1,
  policyId: 'fictional-windows-production-assembly',
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
} as const

async function stoppedWindowsStatus(): Promise<ServerStatus> {
  const status = await new DemoProvider().collectStatus()
  return {
    ...status,
    state: 'stopped',
    automation: { ...status.automation, projectRootAvailable: true }
  }
}

function windowsStatusProvider(status: ServerStatus, runtimeCalls: string[]): StatusProvider {
  return {
    name: 'windows',
    collectStatus: async () => status,
    previewLifecycle: async () => unexpectedRuntimeCall(runtimeCalls, 'status.previewLifecycle')
  }
}

function lifecycleBrokerClient(
  gamePort: number,
  runtimeCalls: string[]
): WindowsLifecycleBrokerClient {
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
    preflight: async () => unexpectedRuntimeCall(runtimeCalls, 'broker.preflight'),
    dispatch: async () => unexpectedRuntimeCall(runtimeCalls, 'broker.dispatch'),
    verify: async () => unexpectedRuntimeCall(runtimeCalls, 'broker.verify'),
    status: async () => evidence
  }
}

interface FixtureHostMutationOperation {
  mode: 'ordinary' | 'recovery'
  operation: string
  requestId: string
}

class FixtureHostMutationCoordinator implements
  HostMutationOperationCoordinator,
  HostMutationRecoveryOperationCoordinator {
  readonly operations: FixtureHostMutationOperation[] = []

  async runExclusive<T>(
    request: HostMutationOperationRequest,
    operation: (
      scope: HostMutationOperationScope
    ) => Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>
  ): Promise<T> {
    this.operations.push({
      mode: 'ordinary',
      operation: request.operation,
      requestId: request.requestId
    })
    return await this.#run(operation)
  }

  async runRecoveryExclusive<T>(
    request: HostMutationRecoveryOperationRequest,
    operation: (
      scope: HostMutationOperationScope
    ) => Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>
  ): Promise<T> {
    this.operations.push({
      mode: 'recovery',
      operation: request.expectedOperation,
      requestId: request.expectedRequestId
    })
    return await this.#run(operation)
  }

  async #run<T>(
    operation: (
      scope: HostMutationOperationScope
    ) => Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>
  ): Promise<T> {
    const outcome = await operation({
      signal: new AbortController().signal,
      assertActive: () => undefined,
      toPowerShellBorrowArguments: () => []
    })
    if (outcome.kind === 'throw') throw outcome.error
    return outcome.value
  }
}

class NoProductionLifecycleAdapter implements LifecycleMutationAdapter {
  readonly mutationEnabled = true

  constructor(private readonly runtimeCalls: string[]) {}

  async previewLifecycle(
    _action: LifecycleAction,
    _context?: LifecyclePreviewContext
  ): Promise<LifecyclePreview> {
    return unexpectedRuntimeCall(this.runtimeCalls, 'lifecycle.previewLifecycle')
  }

  async createProtectionPoint(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    return unexpectedRuntimeCall(this.runtimeCalls, 'lifecycle.createProtectionPoint')
  }

  async requestSave(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    return unexpectedRuntimeCall(this.runtimeCalls, 'lifecycle.requestSave')
  }

  async requestGracefulStop(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    return unexpectedRuntimeCall(this.runtimeCalls, 'lifecycle.requestGracefulStop')
  }

  async verifyStopped(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    return unexpectedRuntimeCall(this.runtimeCalls, 'lifecycle.verifyStopped')
  }

  async requestStart(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    return unexpectedRuntimeCall(this.runtimeCalls, 'lifecycle.requestStart')
  }

  async verifyRunning(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    return unexpectedRuntimeCall(this.runtimeCalls, 'lifecycle.verifyRunning')
  }

  async requestRollbackStart(_context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    return unexpectedRuntimeCall(this.runtimeCalls, 'lifecycle.requestRollbackStart')
  }
}

async function loginAdministrator(): Promise<string> {
  const response = await application!.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: publicOrigin },
    payload: { role: 'administrator', password: administratorPassword }
  })
  expect(response.statusCode).toBe(200)
  const cookie = response.cookies[0]?.value
  expect(cookie).toBeTruthy()
  return cookie!
}

function unexpectedRuntimeCall(runtimeCalls: string[], label: string): never {
  runtimeCalls.push(label)
  throw new Error('UNEXPECTED_PRODUCTION_RUNTIME_CALL')
}

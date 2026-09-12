import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApplication, type BuiltApplication } from './app.js'
import { loadConfig } from './config.js'
import type { LifecycleAction, LifecyclePreview, ServerStatus, StatusProvider } from './domain.js'
import type {
  HostMutationOperationCoordinator,
  HostMutationOperationOutcome,
  HostMutationOperationScope,
  HostMutationRecoveryOperationCoordinator
} from './host-mutation/operation-coordinator.js'
import { PREPARE_GSMANAGER_TO_DYSON } from './cutover/types.js'
import type {
  WindowsCutoverCandidateTaskRequest,
  WindowsCutoverFixedMutationRequest,
  WindowsCutoverHostClient,
  WindowsCutoverInspectionRequest
} from './providers/windows-cutover.js'
import type { WindowsLifecycleBrokerClient } from './providers/windows-lifecycle-broker.js'

const publicOrigin = 'http://127.0.0.1:13010'
const administratorPassword = 'fictional-cutover-administrator-password'
const requestId = '00000000-0000-4000-8000-000000000101'
const serviceUser = '.\\FictionalDyson'
const gamePort = 8469
let application: BuiltApplication | null = null
const temporaryRoots: string[] = []

afterEach(async () => {
  await application?.close()
  application = null
  for (const root of temporaryRoots.splice(0).reverse()) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('production cutover application construction', () => {
  it('requires an explicit absolute durable data root whenever either cutover gate is open', () => {
    const environment = fixedCutoverEnvironment()
    expect(() => loadConfig(environment)).toThrow(/absolute DYSON_DATA_DIR/)
    expect(() => loadConfig({ ...environment, DYSON_DATA_DIR: 'relative-data' }))
      .toThrow(/absolute DYSON_DATA_DIR/)

    expect(loadConfig({
      ...environment,
      DYSON_CUTOVER_ENABLED: 'false',
      DYSON_CUTOVER_RECOVERY_ENABLED: 'true',
      DYSON_DATA_DIR: path.join(os.tmpdir(), 'fictional-dyson-data')
    })).toMatchObject({
      cutoverEnabled: false,
      cutoverRecoveryEnabled: true,
      cutoverDataDirectory: path.join(os.tmpdir(), 'fictional-dyson-data', 'cutover')
    })
  })

  it('constructs the real profile, SQLite stores, Windows adapter, service and controller', async () => {
    const fixture = createFixture({ includeHostScripts: false })
    const hostClient = new FixtureWindowsCutoverHostClient(fixture.inventoryRevision)
    const coordinator = new PassThroughHostMutationCoordinator(fixture.dataRoot)
    const saveTransactions = fixtureSaveTransactions()

    application = await buildApplication(fixture.config, {
      statusProvider: fixture.statusProvider,
      lifecycleBrokerClient: unusedLifecycleBrokerClient,
      cutoverHostClient: hostClient,
      hostMutationCoordinator: coordinator,
      hostMutationRecoveryCoordinator: coordinator,
      saveTransactionService: saveTransactions
    })

    const readiness = await application.app.inject({ method: 'GET', url: '/readyz' })
    expect(readiness.statusCode).toBe(200)
    expect(readiness.json()).toMatchObject({
      status: 'ready',
      provider: 'windows',
      checks: {
        statusProvider: 'pass',
        projectRoot: 'pass',
        cutoverRecovery: 'pass'
      }
    })

    const cookie = await loginAdministrator()
    for (const payload of [
      { requestId },
      { requestId, confirmation: 'PREPARE' },
      { requestId, confirmation: PREPARE_GSMANAGER_TO_DYSON, task: 'fictional-private-task' }
    ]) {
      const rejected = await application.app.inject({
        method: 'POST',
        url: '/api/v1/cutover/prepare',
        headers: { origin: publicOrigin },
        cookies: { dyson_session: cookie },
        payload
      })
      expect(rejected.statusCode).toBe(422)
    }
    expect(hostClient.inspectionRequests).toHaveLength(0)
    expect(hostClient.candidateRequests).toHaveLength(0)

    const previewed = await application.app.inject({
      method: 'POST',
      url: '/api/v1/cutover/preview',
      headers: { origin: publicOrigin },
      cookies: { dyson_session: cookie },
      payload: { requestId, operation: 'prepare' }
    })
    expect(previewed.statusCode).toBe(200)
    const planFingerprint = previewed.json().data.planFingerprint as string
    expect(planFingerprint).toMatch(/^[0-9a-f]{64}$/)
    const prepared = await application.app.inject({
      method: 'POST',
      url: '/api/v1/cutover/prepare',
      headers: { origin: publicOrigin },
      cookies: { dyson_session: cookie },
      payload: { requestId, planFingerprint, confirmation: PREPARE_GSMANAGER_TO_DYSON }
    })
    expect(prepared.statusCode).toBe(202)
    expect(prepared.json()).toMatchObject({
      ok: true,
      data: { requestId, phase: 'prepared', status: 'succeeded' }
    })
    expect(hostClient.inspectionRequests).toHaveLength(3)
    expect(hostClient.candidateRequests).toHaveLength(1)
    expect(hostClient.candidateRequests[0]?.authorityMutation).toMatchObject({
      mode: 'PrepareDisabled',
      recovery: false,
      attempt: 1
    })
    expect(saveTransactions.inspect).not.toHaveBeenCalled()
    expect(saveTransactions.backup).not.toHaveBeenCalled()
    expect(saveTransactions.restore).not.toHaveBeenCalled()

    const replayed = await application.app.inject({
      method: 'POST',
      url: '/api/v1/cutover/prepare',
      headers: { origin: publicOrigin },
      cookies: { dyson_session: cookie },
      payload: { requestId, planFingerprint, confirmation: PREPARE_GSMANAGER_TO_DYSON }
    })
    expect(replayed.statusCode).toBe(200)
    expect(replayed.json()).toMatchObject({
      ok: true,
      data: { requestId, phase: 'prepared', summary: { reused: true } }
    })
    expect(hostClient.inspectionRequests).toHaveLength(3)
    expect(hostClient.candidateRequests).toHaveLength(1)

    const cutoverDirectory = fixture.config.cutoverDataDirectory
    expect(fs.existsSync(path.join(cutoverDirectory, 'cutover.db'))).toBe(true)
    expect(fs.existsSync(path.join(cutoverDirectory, 'cutover-audit.db'))).toBe(true)

    await application.close()
    application = null
    const releasedDirectory = path.join(fixture.root, 'released-cutover-data')
    fs.renameSync(cutoverDirectory, releasedDirectory)
    expect(sqliteCount(path.join(releasedDirectory, 'cutover.db'), 'cutover_receipts')).toBe(1)
    expect(sqliteCount(
      path.join(releasedDirectory, 'cutover-audit.db'),
      'cutover_audit_attempts',
      'terminal_event_id IS NOT NULL'
    )).toBe(2)
    fs.renameSync(releasedDirectory, cutoverDirectory)
  })

  it('allows read-only preview but keeps default-off ordinary execution at zero host mutation', async () => {
    const fixture = createFixture({ includeHostScripts: false })
    const hostClient = new FixtureWindowsCutoverHostClient(fixture.inventoryRevision)
    const coordinator = new PassThroughHostMutationCoordinator(fixture.dataRoot)
    application = await buildApplication({
      ...fixture.config,
      cutoverEnabled: false,
      cutoverRecoveryEnabled: true
    }, {
      statusProvider: fixture.statusProvider,
      lifecycleBrokerClient: unusedLifecycleBrokerClient,
      cutoverHostClient: hostClient,
      hostMutationCoordinator: coordinator,
      hostMutationRecoveryCoordinator: coordinator,
      saveTransactionService: fixtureSaveTransactions()
    })
    const cookie = await loginAdministrator()
    const previewed = await application.app.inject({
      method: 'POST',
      url: '/api/v1/cutover/preview',
      headers: { origin: publicOrigin },
      cookies: { dyson_session: cookie },
      payload: { requestId, operation: 'prepare' }
    })
    expect(previewed.statusCode).toBe(200)
    const planFingerprint = previewed.json().data.planFingerprint as string
    expect(hostClient.inspectionRequests).toHaveLength(1)

    const blocked = await application.app.inject({
      method: 'POST',
      url: '/api/v1/cutover/prepare',
      headers: { origin: publicOrigin },
      cookies: { dyson_session: cookie },
      payload: { requestId, planFingerprint, confirmation: PREPARE_GSMANAGER_TO_DYSON }
    })
    expect(blocked.statusCode).toBe(423)
    expect(blocked.json()).toEqual({
      ok: false,
      error: { code: 'CUTOVER_HTTP_MUTATION_DISABLED' }
    })
    expect(hostClient.inspectionRequests).toHaveLength(1)
    expect(hostClient.candidateRequests).toHaveLength(0)
    expect(sqliteCount(
      path.join(fixture.config.cutoverDataDirectory, 'cutover.db'),
      'cutover_receipts'
    )).toBe(0)
  })

  it('fails closed and releases construction resources when the fixed profile is missing', async () => {
    const fixture = createFixture({ includeHostScripts: true })
    fs.rmSync(fixture.profileFile)

    await expect(buildApplication(fixture.config, {
      statusProvider: fixture.statusProvider,
      lifecycleBrokerClient: unusedLifecycleBrokerClient
    }))
      .rejects.toMatchObject({ code: 'CUTOVER_PROFILE_UNAVAILABLE' })

    assertDirectoryReleased(fixture.dataRoot, path.join(fixture.root, 'released-data-root'))
  })

  it('fails closed before opening cutover stores when a fixed host script is missing', async () => {
    const fixture = createFixture({ includeHostScripts: false })

    await expect(buildApplication(fixture.config, {
      statusProvider: fixture.statusProvider,
      lifecycleBrokerClient: unusedLifecycleBrokerClient
    }))
      .rejects.toThrow('CUTOVER_HOST_SCRIPTS_UNAVAILABLE')

    expect(fs.existsSync(path.join(fixture.config.cutoverDataDirectory, 'cutover.db'))).toBe(false)
    expect(fs.existsSync(path.join(fixture.config.cutoverDataDirectory, 'cutover-audit.db'))).toBe(false)
    assertDirectoryReleased(fixture.dataRoot, path.join(fixture.root, 'released-data-root'))
  })

  it('fails closed before opening cutover stores when the privileged broker profile is missing', async () => {
    const fixture = createFixture({ includeHostScripts: true })
    fs.rmSync(path.join(fixture.dataRoot, 'cutover-broker', 'broker-profile.json'))

    await expect(buildApplication(fixture.config, {
      statusProvider: fixture.statusProvider,
      lifecycleBrokerClient: unusedLifecycleBrokerClient
    }))
      .rejects.toMatchObject({ code: 'CUTOVER_BROKER_PROFILE_UNAVAILABLE' })

    expect(fs.existsSync(path.join(fixture.config.cutoverDataDirectory, 'cutover.db'))).toBe(false)
    expect(fs.existsSync(path.join(fixture.config.cutoverDataDirectory, 'cutover-audit.db'))).toBe(false)
    assertDirectoryReleased(fixture.dataRoot, path.join(fixture.root, 'released-data-root'))
  })

  it('releases already-constructed application resources when a cutover prerequisite is unavailable', async () => {
    const fixture = createFixture({ includeHostScripts: true })

    await expect(buildApplication({
      ...fixture.config,
      runtimeBootstrapRoot: null
    }, {
      statusProvider: fixture.statusProvider,
      lifecycleBrokerClient: unusedLifecycleBrokerClient
    })).rejects.toThrow('CUTOVER_RUNTIME_UNAVAILABLE')

    expect(fs.existsSync(path.join(fixture.config.cutoverDataDirectory, 'cutover.db'))).toBe(false)
    expect(fs.existsSync(path.join(fixture.config.cutoverDataDirectory, 'cutover-audit.db'))).toBe(false)
    assertDirectoryReleased(fixture.dataRoot, path.join(fixture.root, 'released-data-root'))
  })
})

interface Fixture {
  root: string
  dataRoot: string
  profileFile: string
  inventoryRevision: string
  config: ReturnType<typeof loadConfig>
  statusProvider: StatusProvider
}

function createFixture(options: { includeHostScripts: boolean }): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dyson-cutover-app-wiring-'))
  temporaryRoots.push(root)
  const projectRoot = path.join(root, 'fictional-project')
  const dataRoot = path.join(root, 'fictional-data')
  const scriptRoot = path.join(root, 'fictional-fixed-scripts')
  const runtimeBootstrapRoot = path.join(root, 'fictional-bootstrap')
  const runtimeTaskTransactionRoot = path.join(root, 'fictional-runtime-task-transactions')
  const bridgeControlRoot = path.join(root, 'fictional-bridge-control')
  const authorityRoot = path.join(dataRoot, 'authority-inventory')
  const previousScriptRoot = path.join(dataRoot, 'private', 'gsmanager-authority')
  for (const directory of [
    projectRoot,
    path.join(projectRoot, 'userdata', 'Save'),
    path.join(projectRoot, 'backups', 'saves'),
    path.join(projectRoot, 'server', 'BepInEx', 'config'),
    dataRoot,
    path.join(dataRoot, 'cutover'),
    path.join(dataRoot, 'cutover-broker'),
    scriptRoot,
    path.join(scriptRoot, 'cutover'),
    path.join(scriptRoot, 'cutover-broker'),
    runtimeBootstrapRoot,
    runtimeTaskTransactionRoot,
    bridgeControlRoot,
    authorityRoot,
    previousScriptRoot
  ]) fs.mkdirSync(directory, { recursive: true })

  const bootstrapStart = path.join(runtimeBootstrapRoot, 'Start-DysonServer.ps1')
  const bootstrapStop = path.join(runtimeBootstrapRoot, 'Stop-DysonServer.ps1')
  const previousStart = path.join(previousScriptRoot, 'start-dyson-server.ps1')
  const previousStop = path.join(previousScriptRoot, 'stop-dyson-server.ps1')
  fs.writeFileSync(bootstrapStart, '# fictional bootstrap start\n')
  fs.writeFileSync(bootstrapStop, '# fictional bootstrap stop\n')
  fs.writeFileSync(previousStart, '# fictional previous start\n')
  fs.writeFileSync(previousStop, '# fictional previous stop\n')

  if (options.includeHostScripts) {
    fs.writeFileSync(path.join(scriptRoot, 'DysonHostMutationLease.Common.ps1'), '# fictional lease common\n')
    fs.writeFileSync(path.join(scriptRoot, 'Install-DysonRuntimeTasks.ps1'), '# fictional runtime tasks\n')
    fs.writeFileSync(path.join(scriptRoot, 'cutover', 'DysonCutoverHost.Common.ps1'), '# fictional host common\n')
    fs.writeFileSync(path.join(scriptRoot, 'cutover', 'Get-DysonCutoverEvidence.ps1'), '# fictional evidence\n')
    fs.writeFileSync(path.join(scriptRoot, 'cutover', 'Invoke-DysonCutoverAction.ps1'), '# fictional action\n')
    fs.writeFileSync(path.join(scriptRoot, 'cutover-broker', 'DysonCutoverBroker.Common.ps1'), '# fictional broker common\n')
    fs.writeFileSync(path.join(scriptRoot, 'cutover-broker', 'DysonCutoverBroker.TaskAcl.ps1'), '# fictional task acl\n')
    fs.writeFileSync(path.join(scriptRoot, 'cutover-broker', 'Install-DysonCutoverBrokerTask.ps1'), '# fictional broker installer\n')
    fs.writeFileSync(path.join(scriptRoot, 'cutover-broker', 'Invoke-DysonCutoverBrokerWorker.ps1'), '# fictional broker worker\n')
    fs.writeFileSync(
      path.join(scriptRoot, 'cutover-broker', 'Submit-DysonCutoverBrokerRequest.ps1'),
      '# fictional broker submit\n'
    )
  }

  const profileFile = path.join(authorityRoot, 'authority-profile.json')
  const profile = buildProfile({
    profileFile,
    projectRoot,
    dataRoot,
    runtimeBootstrapRoot,
    runtimeTaskTransactionRoot,
    bootstrapStart,
    bootstrapStop,
    previousStart,
    previousStop
  })
  fs.writeFileSync(profileFile, `${JSON.stringify(profile)}\n`)
  if (options.includeHostScripts) {
    const brokerProfileFile = path.join(dataRoot, 'cutover-broker', 'broker-profile.json')
    fs.writeFileSync(brokerProfileFile, `${JSON.stringify(buildBrokerProfile({
      brokerRoot: path.dirname(brokerProfileFile),
      scriptRoot,
      projectRoot,
      dataRoot,
      authorityProfileFile: profileFile,
      runtimeBootstrapRoot,
      runtimeTaskTransactionRoot
    }))}\n`)
  }

  return {
    root,
    dataRoot,
    profileFile,
    inventoryRevision: profile.inventoryRevision,
    statusProvider: fixtureStatusProvider(),
    config: loadConfig({
      NODE_ENV: 'test',
      DYSON_PROVIDER: 'windows',
      DYSON_PUBLIC_ORIGIN: publicOrigin,
      DYSON_DEV_ADMIN_PASSWORD: administratorPassword,
      DYSON_DATA_DIR: dataRoot,
      DYSON_PROJECT_ROOT: projectRoot,
      DYSON_SCRIPT_ROOT: scriptRoot,
      DYSON_RUNTIME_BOOTSTRAP_ROOT: runtimeBootstrapRoot,
      DYSON_LIFECYCLE_ENABLED: 'true',
      DYSON_LIFECYCLE_BROKER_PROFILE_FILE:
        path.join(dataRoot, 'lifecycle-broker', 'broker-profile.json'),
      DYSON_RUNTIME_SERVICE_USER: serviceUser,
      DYSON_BRIDGE_CONTROL_ROOT: bridgeControlRoot,
      DYSON_BRIDGE_SECRET_FILE: path.join(root, 'fictional-private', 'bridge.secret'),
      DYSON_CUTOVER_ENABLED: 'true',
      DYSON_CUTOVER_RECOVERY_ENABLED: 'true',
      DYSON_CUTOVER_PROFILE_FILE: profileFile,
      DYSON_CUTOVER_SERVICE_USER: serviceUser,
      DYSON_CUTOVER_TASK_TRANSACTION_ROOT: runtimeTaskTransactionRoot,
      DYSON_GAME_PORT: String(gamePort)
    })
  }
}

function fixedCutoverEnvironment(): NodeJS.ProcessEnv {
  const root = path.join(os.tmpdir(), 'fictional-cutover-config')
  return {
    NODE_ENV: 'test',
    DYSON_PROVIDER: 'windows',
    DYSON_PROJECT_ROOT: path.join(root, 'project'),
    DYSON_RUNTIME_BOOTSTRAP_ROOT: path.join(root, 'bootstrap'),
    DYSON_LIFECYCLE_ENABLED: 'true',
    DYSON_LIFECYCLE_BROKER_PROFILE_FILE:
      path.join(root, 'data', 'lifecycle-broker', 'broker-profile.json'),
    DYSON_RUNTIME_SERVICE_USER: serviceUser,
    DYSON_BRIDGE_CONTROL_ROOT: path.join(root, 'bridge'),
    DYSON_BRIDGE_SECRET_FILE: path.join(root, 'bridge.secret'),
    DYSON_CUTOVER_ENABLED: 'true',
    DYSON_CUTOVER_PROFILE_FILE: path.join(root, 'data', 'authority-inventory', 'authority-profile.json'),
    DYSON_CUTOVER_SERVICE_USER: serviceUser,
    DYSON_CUTOVER_TASK_TRANSACTION_ROOT: path.join(root, 'runtime-task-transactions')
  }
}

const unusedLifecycleBrokerClient = {
  preflight: async () => { throw new Error('unused lifecycle broker preflight') },
  dispatch: async () => { throw new Error('unused lifecycle broker dispatch') },
  verify: async () => { throw new Error('unused lifecycle broker verify') },
  status: async () => ({
    lifecycleState: 'running_verified' as const,
    task: {
      valid: true,
      server: { name: 'Dyson-Nebula-Server' as const, path: '\\' as const, state: 'Running' },
      stop: { name: 'Dyson-Nebula-Stop' as const, path: '\\' as const, state: 'Ready' }
    },
    runtime: {
      lifecycleState: 'running_verified' as const,
      session: { status: 'verified' as const, id: 7, count: 1 },
      steam: { status: 'verified' as const, pid: 1101, sessionId: 7 },
      process: { status: 'verified' as const, pid: 2202, owner: serviceUser, sessionId: 7 },
      port: { port: gamePort, listenerCount: 1 },
      pidFile: { present: true, valid: true }
    }
  })
} satisfies WindowsLifecycleBrokerClient

class FixtureWindowsCutoverHostClient implements WindowsCutoverHostClient {
  readonly inspectionRequests: WindowsCutoverInspectionRequest[] = []
  readonly candidateRequests: WindowsCutoverCandidateTaskRequest[] = []
  #candidateDefined = false

  constructor(private readonly inventoryRevision: string) {}

  async inspect(request: Readonly<WindowsCutoverInspectionRequest>): Promise<unknown> {
    this.inspectionRequests.push(request)
    return {
      authorityInventoryRevision: this.inventoryRevision,
      evidence: {
        previousDefined: true,
        previousEnabled: true,
        candidateDefined: this.#candidateDefined,
        candidateEnabled: false,
        unexpectedAuthorityPresent: false,
        processState: 'previous-only',
        portState: 'previous',
        previousHealthy: true,
        candidateHealthy: false
      }
    }
  }

  async runCandidateTaskTransaction(
    request: Readonly<WindowsCutoverCandidateTaskRequest>
  ): Promise<unknown> {
    this.candidateRequests.push(request)
    this.#candidateDefined = true
    return {
      outerRequestId: request.outerRequestId,
      childRequestId: request.authorityMutation.childRequestId,
      attempt: request.authorityMutation.attempt,
      mode: request.authorityMutation.mode,
      recovery: request.authorityMutation.recovery,
      status: 'succeeded',
      receiptDigest: sha256Text(`fixture:${request.authorityMutation.childRequestId}`)
    }
  }

  disablePreviousAuthority(request: Readonly<WindowsCutoverFixedMutationRequest>): Promise<unknown> {
    return fixedMutationReceipt(request)
  }

  stopPreviousRuntime(request: Readonly<WindowsCutoverFixedMutationRequest>): Promise<unknown> {
    return fixedMutationReceipt(request)
  }

  enablePreviousAuthority(request: Readonly<WindowsCutoverFixedMutationRequest>): Promise<unknown> {
    return fixedMutationReceipt(request)
  }

  startPreviousRuntime(request: Readonly<WindowsCutoverFixedMutationRequest>): Promise<unknown> {
    return fixedMutationReceipt(request)
  }

  startCandidateRuntime(request: Readonly<WindowsCutoverFixedMutationRequest>): Promise<unknown> {
    return fixedMutationReceipt(request)
  }

  stopCandidateRuntime(request: Readonly<WindowsCutoverFixedMutationRequest>): Promise<unknown> {
    return fixedMutationReceipt(request)
  }
}

class PassThroughHostMutationCoordinator implements
  HostMutationOperationCoordinator,
  HostMutationRecoveryOperationCoordinator {
  readonly #scope: HostMutationOperationScope

  constructor(dataRoot: string) {
    this.#scope = {
      signal: new AbortController().signal,
      assertActive: () => undefined,
      toPowerShellBorrowArguments: () => [
        '-DataRoot', dataRoot,
        '-LeaseInstanceId', '00000000-0000-4000-8000-000000000201',
        '-LeaseToken', 'A'.repeat(43)
      ]
    }
  }

  async runExclusive<T>(
    _request: Readonly<{ operation: string; requestId: string }>,
    operation: (scope: HostMutationOperationScope) =>
      Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>
  ): Promise<T> {
    return await unwrapOutcome(await operation(this.#scope))
  }

  async runRecoveryExclusive<T>(
    _request: Readonly<{ expectedOperation: string; expectedRequestId: string }>,
    operation: (scope: HostMutationOperationScope) =>
      Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>
  ): Promise<T> {
    return await unwrapOutcome(await operation(this.#scope))
  }
}

function fixtureSaveTransactions() {
  return {
    inspect: vi.fn(async () => await unexpectedCall()),
    backup: vi.fn(async () => await unexpectedCall()),
    restore: vi.fn(async () => await unexpectedCall())
  }
}

function fixtureStatusProvider(): StatusProvider {
  return {
    name: 'windows',
    collectStatus: async () => healthyStatus(),
    previewLifecycle: async (_action: LifecycleAction): Promise<LifecyclePreview> => await unexpectedCall()
  }
}

function healthyStatus(): ServerStatus {
  return {
    collectedAt: '2026-09-01T00:00:00.000Z',
    serverName: 'Fictional DSP server',
    state: 'running',
    runtime: {
      targetUps: 60,
      onlinePlayers: 0,
      maxPlayers: 20,
      processId: 4242,
      processCoresUsed: 4,
      workingSetGiB: 4,
      privateMemoryGiB: 5,
      threadCount: 100,
      priority: 'High',
      startedAt: '2026-08-31T23:59:00.000Z',
      uptimeSeconds: 60
    },
    host: {
      logicalProcessors: 8,
      processorGroups: 1,
      cpuPercent: 10,
      memoryTotalGiB: 32,
      memoryFreeGiB: 24
    },
    versions: {
      dsp: '0.10.33.26727',
      nebula: '0.9.22',
      bepInEx: '5.4.22',
      compatible: true,
      gameLoaded: true,
      warnings: []
    },
    save: {
      name: 'Fictional_Save',
      dsvPresent: true,
      serverPresent: true,
      consistent: true,
      lastSavedAt: '2026-08-31T23:58:00.000Z',
      dsvSizeMiB: 100,
      serverSizeKiB: 100,
      latestBackupAt: '2026-08-31T23:55:00.000Z',
      backupManifestPresent: true,
      backupPairPresent: true
    },
    automation: {
      serverTask: { state: 'running', lastResult: 0, lastRunAt: '2026-08-31T23:59:00.000Z' },
      stopTask: { state: 'ready', lastResult: 0, lastRunAt: '2026-08-31T23:55:00.000Z' },
      storageTask: { state: 'ready', lastResult: 0, lastRunAt: '2026-08-31T23:50:00.000Z' },
      projectRootAvailable: true,
      globalMappingAvailable: true
    },
    connections: [],
    capabilities: { refresh: true, start: true, save: true, gracefulStop: true, restart: true }
  }
}

function buildProfile(paths: Record<string, string>) {
  const task = (taskName: string) => ({
    taskName,
    taskPath: '\\',
    definitionSha256: sha256Text(`task:${taskName}`),
    enabled: true
  })
  const core = {
    protocol: 'DYSON_GSMANAGER_AUTHORITY_PROFILE_V1',
    schemaVersion: 1,
    requestId: randomUUID(),
    requestFingerprint: sha256Text('fictional-request'),
    projectRootIdentity: identity(paths.projectRoot!),
    dataRootIdentity: identity(paths.dataRoot!),
    authorityRootIdentity: identity(path.dirname(paths.profileFile!)),
    runtimeBootstrapIdentity: identity(paths.runtimeBootstrapRoot!),
    runtimeBootstrapStartSha256: sha256File(paths.bootstrapStart!),
    runtimeBootstrapStopSha256: sha256File(paths.bootstrapStop!),
    runtimeTaskTransactionRootIdentity: identity(paths.runtimeTaskTransactionRoot!),
    serviceUser,
    gamePort,
    previousAuthority: {
      main: task('Dyson-GSManager'),
      start: task('Dyson-GSManager-Server'),
      stop: task('Dyson-GSManager-Stop')
    },
    candidateAuthority: {
      startTaskName: 'Dyson-Nebula-Server',
      stopTaskName: 'Dyson-Nebula-Stop',
      taskPath: '\\',
      legacyPreimage: {
        startDefinitionSha256: sha256Text('legacy-start'),
        stopDefinitionSha256: sha256Text('legacy-stop'),
        expectedEnabledBeforeIsolation: true,
        expectedEnabledAfterIsolation: false
      },
      expectedPreparedDisabled: {
        startDescriptorSha256: sha256Text('prepared-start'),
        stopDescriptorSha256: sha256Text('prepared-stop')
      },
      expectedActive: {
        startDescriptorSha256: sha256Text('active-start'),
        stopDescriptorSha256: sha256Text('active-stop')
      },
      allowedTransitions: ['legacy-preimage-disabled', 'prepared-disabled', 'active']
    },
    previousScriptBundleRevision: sha256Text(
      `${sha256File(paths.previousStart!)}:${sha256File(paths.previousStop!)}`
    )
  }
  return { ...core, inventoryRevision: sha256Text(JSON.stringify(core)) }
}

function buildBrokerProfile(paths: Record<string, string>) {
  const brokerScriptRoot = path.join(paths.scriptRoot!, 'cutover-broker')
  const core = {
    protocol: 'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_V1',
    schemaVersion: 1,
    brokerRoot: paths.brokerRoot!,
    brokerScriptRoot,
    projectRoot: paths.projectRoot!,
    dataRoot: paths.dataRoot!,
    authorityProfileFile: paths.authorityProfileFile!,
    authorityProfileSha256: sha256File(paths.authorityProfileFile!),
    cutoverScriptRoot: paths.scriptRoot!,
    leaseCommonSha256: sha256File(path.join(paths.scriptRoot!, 'DysonHostMutationLease.Common.ps1')),
    cutoverHostCommonSha256: sha256File(path.join(paths.scriptRoot!, 'cutover', 'DysonCutoverHost.Common.ps1')),
    cutoverActionScriptSha256: sha256File(path.join(paths.scriptRoot!, 'cutover', 'Invoke-DysonCutoverAction.ps1')),
    runtimeTaskInstallerSha256: sha256File(path.join(paths.scriptRoot!, 'Install-DysonRuntimeTasks.ps1')),
    runtimeBootstrapRoot: paths.runtimeBootstrapRoot!,
    runtimeTaskTransactionRoot: paths.runtimeTaskTransactionRoot!,
    serviceUser,
    gamePort,
    taskName: 'Dyson-Control-Cutover-Broker',
    taskPath: '\\',
    localServiceSid: 'S-1-5-19',
    commonScriptSha256: sha256File(path.join(brokerScriptRoot, 'DysonCutoverBroker.Common.ps1')),
    taskAclScriptSha256: sha256File(path.join(brokerScriptRoot, 'DysonCutoverBroker.TaskAcl.ps1')),
    installerScriptSha256: sha256File(path.join(brokerScriptRoot, 'Install-DysonCutoverBrokerTask.ps1')),
    workerScriptSha256: sha256File(path.join(brokerScriptRoot, 'Invoke-DysonCutoverBrokerWorker.ps1')),
    submitScriptSha256: sha256File(path.join(brokerScriptRoot, 'Submit-DysonCutoverBrokerRequest.ps1'))
  }
  return { ...core, profileFingerprint: sha256Text(JSON.stringify(core)) }
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

function sqliteCount(databasePath: string, table: string, condition = '1 = 1'): number {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${condition}`).get() as {
      count: number
    }
    return row.count
  } finally {
    database.close()
  }
}

function assertDirectoryReleased(directory: string, releasedDirectory: string): void {
  fs.renameSync(directory, releasedDirectory)
  fs.renameSync(releasedDirectory, directory)
}

function fixedMutationReceipt(request: Readonly<WindowsCutoverFixedMutationRequest>): Promise<unknown> {
  return Promise.resolve({ requestId: request.requestId, status: 'succeeded' })
}

function unwrapOutcome<T>(outcome: HostMutationOperationOutcome<T>): T {
  if (outcome.kind === 'throw') throw outcome.error
  return outcome.value
}

function identity(candidate: string): string {
  const canonical = fs.realpathSync.native(candidate).replace(/[\\/]+$/, '').toUpperCase()
  return `sha256:${sha256Text(canonical)}`
}

function sha256File(candidate: string): string {
  return createHash('sha256').update(fs.readFileSync(candidate)).digest('hex')
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

async function unexpectedCall(): Promise<never> {
  throw new Error('UNEXPECTED_FIXTURE_CALL')
}

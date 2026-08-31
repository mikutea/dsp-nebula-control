import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApplication, type BuiltApplication } from './app.js'
import { loadConfig } from './config.js'
import type {
  LifecycleAction,
  LifecycleMutationAdapter,
  LifecycleOperationContext,
  LifecyclePhaseResult,
  LifecyclePreviewContext,
  StatusProvider
} from './domain.js'
import { initialComponentUpdateRevision } from './update-pipeline/index.js'

const publicOrigin = 'http://127.0.0.1:13010'
const administratorPassword = 'fictional-administrator-password'
const artifactId = 'nebula-artifact-0001'
let application: BuiltApplication | null = null
const temporaryRoots: string[] = []

afterEach(async () => {
  if (application !== null) await application.close()
  application = null
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('application component update activation default wiring', () => {
  it('constructs the real Windows activation service while the mutation gate defaults closed', async () => {
    const fixture = await createFixture(false)
    application = await buildApplication(fixture.config, {
      statusProvider: fixture.statusProvider,
      lifecycleAdapter: fixture.lifecycleAdapter
    })
    const cookie = await loginAdministrator()

    const state = await application.app.inject({
      method: 'GET',
      url: '/api/v1/updates/activation/state',
      cookies: { dyson_session: cookie }
    })
    expect(state.statusCode).toBe(200)
    expect(state.json()).toEqual({
      ok: true,
      data: {
        revision: initialComponentUpdateRevision,
        recoveryRequired: false,
        components: [],
        historyEntries: 0
      }
    })

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
        phase: 'ready',
        mutationBlocked: false,
        recoveryRequired: false,
        failureCode: null,
        reconciledRequestId: null
      }
    })

    const noOrigin = await application.app.inject({
      method: 'POST',
      url: '/api/v1/updates/activation/execute',
      cookies: { dyson_session: cookie },
      payload: activationExecuteRequest()
    })
    expect(noOrigin.statusCode).toBe(403)
    expect(noOrigin.json().error.code).toBe('ORIGIN_REJECTED')

    const blocked = await application.app.inject({
      method: 'POST',
      url: '/api/v1/updates/activation/execute',
      headers: { origin: publicOrigin },
      cookies: { dyson_session: cookie },
      payload: activationExecuteRequest()
    })
    expect(blocked.statusCode).toBe(423)
    expect(blocked.json()).toEqual({
      ok: false,
      error: { code: 'UPDATE_ACTIVATION_HTTP_MUTATION_DISABLED' }
    })

    // Startup reconciliation creates only the bounded control-state directories;
    // the disabled mutation gate still leaves releases and runtime untouched.
    expect(await exists(path.join(fixture.projectRoot, '.dyson-control-updates'))).toBe(true)
    expect(await readdir(fixture.scriptRoot)).toEqual([])
    expect(await readdir(fixture.stagedArtifactRoot)).toEqual([])
    assertNoRuntimeCalls(fixture)
  })

  it('opens only the activation gate when explicitly enabled and fails safely on a missing staged artifact', async () => {
    const fixture = await createFixture(true)
    application = await buildApplication(fixture.config, {
      statusProvider: fixture.statusProvider,
      lifecycleAdapter: fixture.lifecycleAdapter
    })
    const cookie = await loginAdministrator()

    const execute = await application.app.inject({
      method: 'POST',
      url: '/api/v1/updates/activation/execute',
      headers: { origin: publicOrigin },
      cookies: { dyson_session: cookie },
      payload: activationExecuteRequest()
    })

    expect(execute.statusCode).toBe(422)
    expect(execute.statusCode).not.toBe(423)
    expect(execute.json()).toEqual({
      ok: false,
      error: { code: 'UPDATE_STAGED_MANIFEST_MISSING' }
    })
    expect(await exists(path.join(fixture.projectRoot, '.dyson-control-updates'))).toBe(true)
    expect(await readdir(fixture.scriptRoot)).toEqual([])
    assertNoRuntimeCalls(fixture)
  })
})

interface Fixture {
  config: ReturnType<typeof loadConfig>
  projectRoot: string
  scriptRoot: string
  stagedArtifactRoot: string
  statusProvider: StatusProvider & {
    collectStatus: ReturnType<typeof vi.fn>
    previewLifecycle: ReturnType<typeof vi.fn>
  }
  lifecycleAdapter: LifecycleMutationAdapter & {
    previewLifecycle: ReturnType<typeof vi.fn>
    createProtectionPoint: ReturnType<typeof vi.fn>
    requestSave: ReturnType<typeof vi.fn>
    requestGracefulStop: ReturnType<typeof vi.fn>
    verifyStopped: ReturnType<typeof vi.fn>
    requestStart: ReturnType<typeof vi.fn>
    verifyRunning: ReturnType<typeof vi.fn>
    requestRollbackStart: ReturnType<typeof vi.fn>
  }
}

async function createFixture(updateActivationEnabled: boolean): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'dyson-activation-app-wiring-'))
  temporaryRoots.push(root)
  const projectRoot = path.join(root, 'fictional-project')
  const stagingRoot = path.join(root, 'fictional-update-staging')
  const inboxRoot = path.join(root, 'fictional-update-inbox')
  const bridgeRoot = path.join(root, 'fictional-bridge-control')
  const scriptRoot = path.join(root, 'fictional-fixed-scripts')
  const compatibilityPolicyFile = path.join(root, 'fictional-compatibility-policy.json')
  const stagedArtifactRoot = path.join(stagingRoot, 'releases', artifactId)
  await Promise.all([
    mkdir(path.join(projectRoot, 'server', 'BepInEx', 'plugins'), { recursive: true }),
    mkdir(stagedArtifactRoot, { recursive: true }),
    mkdir(inboxRoot, { recursive: true }),
    mkdir(bridgeRoot, { recursive: true }),
    mkdir(scriptRoot, { recursive: true })
  ])
  await writeFile(compatibilityPolicyFile, JSON.stringify({
    format: 'dyson-control-trusted-compatibility-policy', schemaVersion: 1,
    policyId: 'fictional-app-wiring-policy', reviewedAt: '2026-08-30T10:00:00.000Z',
    matrix: { schemaVersion: 1, entries: [{
      id: 'fictional-nebula-091',
      core: {
        dsp: { equals: '0.10.33.26727' }, nebula: { equals: '0.9.1' }, bepInEx: { equals: '5.4.22' }
      },
      plugins: []
    }] }
  }))

  const statusProvider = {
    name: 'windows' as const,
    collectStatus: vi.fn(async () => await unexpectedRuntimeCall('status.collect')),
    previewLifecycle: vi.fn(async (_action: LifecycleAction) => await unexpectedRuntimeCall('status.preview'))
  } satisfies StatusProvider
  const lifecycleAdapter = {
    mutationEnabled: true,
    previewLifecycle: vi.fn(async (_action: LifecycleAction, _context: LifecyclePreviewContext) =>
      await unexpectedRuntimeCall('lifecycle.preview')),
    createProtectionPoint: vi.fn(async (context: LifecycleOperationContext) =>
      await unexpectedLifecycleCall('create-protection', context)),
    requestSave: vi.fn(async (context: LifecycleOperationContext) =>
      await unexpectedLifecycleCall('save', context)),
    requestGracefulStop: vi.fn(async (context: LifecycleOperationContext) =>
      await unexpectedLifecycleCall('stop', context)),
    verifyStopped: vi.fn(async (context: LifecycleOperationContext) =>
      await unexpectedLifecycleCall('verify-stopped', context)),
    requestStart: vi.fn(async (context: LifecycleOperationContext) =>
      await unexpectedLifecycleCall('start', context)),
    verifyRunning: vi.fn(async (context: LifecycleOperationContext) =>
      await unexpectedLifecycleCall('verify-running', context)),
    requestRollbackStart: vi.fn(async (context: LifecycleOperationContext) =>
      await unexpectedLifecycleCall('rollback-start', context))
  } satisfies LifecycleMutationAdapter

  return {
    projectRoot,
    scriptRoot,
    stagedArtifactRoot,
    statusProvider,
    lifecycleAdapter,
    config: loadConfig({
      NODE_ENV: 'test',
      DYSON_PROVIDER: 'windows',
      DYSON_PUBLIC_ORIGIN: publicOrigin,
      DYSON_DEV_ADMIN_PASSWORD: administratorPassword,
      DYSON_DATA_DIR: path.join(root, 'fictional-data'),
      DYSON_PROJECT_ROOT: projectRoot,
      DYSON_SCRIPT_ROOT: scriptRoot,
      DYSON_LIFECYCLE_ENABLED: 'true',
      DYSON_BRIDGE_CONTROL_ROOT: bridgeRoot,
      DYSON_BRIDGE_SECRET_FILE: path.join(root, 'fictional-private', 'bridge.key'),
      DYSON_UPDATE_STAGING_ENABLED: 'true',
      DYSON_UPDATE_INBOX_ROOT: inboxRoot,
      DYSON_UPDATE_STAGING_ROOT: stagingRoot,
      DYSON_UPDATE_COMPATIBILITY_POLICY_FILE: compatibilityPolicyFile,
      DYSON_UPDATE_ACTIVATION_ENABLED: updateActivationEnabled ? 'true' : 'false'
    })
  }
}

function activationExecuteRequest() {
  return {
    requestId: '018f47a0-7d5b-7abc-8def-0123456789ab',
    component: 'nebula',
    artifactId,
    sha256: 'a'.repeat(64),
    targetVersion: '0.9.1',
    expectedRevision: initialComponentUpdateRevision,
    compatibilityReceiptId: '118f47a0-7d5b-7abc-8def-0123456789ab',
    confirmation: 'ACTIVATE_NEBULA_UPDATE'
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

function assertNoRuntimeCalls(fixture: Fixture): void {
  expect(fixture.statusProvider.collectStatus).not.toHaveBeenCalled()
  expect(fixture.statusProvider.previewLifecycle).not.toHaveBeenCalled()
  expect(fixture.lifecycleAdapter.previewLifecycle).not.toHaveBeenCalled()
  expect(fixture.lifecycleAdapter.createProtectionPoint).not.toHaveBeenCalled()
  expect(fixture.lifecycleAdapter.requestSave).not.toHaveBeenCalled()
  expect(fixture.lifecycleAdapter.requestGracefulStop).not.toHaveBeenCalled()
  expect(fixture.lifecycleAdapter.verifyStopped).not.toHaveBeenCalled()
  expect(fixture.lifecycleAdapter.requestStart).not.toHaveBeenCalled()
  expect(fixture.lifecycleAdapter.verifyRunning).not.toHaveBeenCalled()
  expect(fixture.lifecycleAdapter.requestRollbackStart).not.toHaveBeenCalled()
}

async function exists(filePath: string): Promise<boolean> {
  return await lstat(filePath).then(() => true, () => false)
}

async function unexpectedRuntimeCall(_label: string): Promise<never> {
  throw new Error('UNEXPECTED_FIXTURE_RUNTIME_CALL')
}

async function unexpectedLifecycleCall(
  _label: string,
  _context: LifecycleOperationContext
): Promise<LifecyclePhaseResult> {
  throw new Error('UNEXPECTED_FIXTURE_LIFECYCLE_CALL')
}

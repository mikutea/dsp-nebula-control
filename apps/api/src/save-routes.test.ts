import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApplication, type BuiltApplication } from './app.js'
import { loadConfig } from './config.js'
import {
  SaveTransactionService,
  type BackupSavePairRequest,
  type RestoreSavePairRequest,
  type SavePairRevision,
  type SaveTransactionResult
} from './saves/transactions.js'

let application: BuiltApplication | null = null
const temporaryRoots: string[] = []

afterEach(async () => {
  if (application) await application.close()
  application = null
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('authenticated save transaction routes', () => {
  it('offers a no-write preview while the independent mutation gate stays closed', async () => {
    const fixture = await createFixture()
    const service = makeService(fixture)
    application = await buildApplication(config(false), {
      saveTransactionService: service,
      workspacePaths: { ...fixture, configRoot: fixture.saveRoot }
    })
    const cookie = await login(application)
    const requestId = randomUUID()

    const preview = await injectMutation('/api/v1/saves/backup/preview', cookie, {
      requestId, saveName: fixture.saveName
    })
    expect(preview.statusCode).toBe(200)
    expect(preview.json()).toMatchObject({
      data: { operation: 'backup', status: 'dry-run', dryRun: true },
      meta: { executionEnabled: false }
    })

    const execute = await injectMutation('/api/v1/saves/backup/execute', cookie, {
      requestId, saveName: fixture.saveName, confirmation: 'CREATE_BACKUP'
    })
    expect(execute.statusCode).toBe(503)
    expect(execute.json().error.code).toBe('SAVE_MUTATIONS_DISABLED')
  })

  it('backs up and restores the .dsv and .server pair through preview and explicit confirmation', async () => {
    const fixture = await createFixture()
    const service = makeService(fixture)
    application = await buildApplication(config(true), {
      saveTransactionService: service,
      workspacePaths: { ...fixture, configRoot: fixture.saveRoot }
    })
    const cookie = await login(application)
    const backupRequestId = randomUUID()

    expect((await injectMutation('/api/v1/saves/backup/preview', cookie, {
      requestId: backupRequestId, saveName: fixture.saveName
    })).json().data.status).toBe('dry-run')
    const backup = await injectMutation('/api/v1/saves/backup/execute', cookie, {
      requestId: backupRequestId, saveName: fixture.saveName, confirmation: 'CREATE_BACKUP'
    })
    expect(backup.statusCode).toBe(202)
    expect(backup.json().data).toMatchObject({
      job: { kind: 'save.backup', state: 'queued' },
      run: { operation: 'backup', state: 'queued' },
      reused: false
    })
    const backupJobId = backup.json().data.job.id as string
    const backupCompletion = await waitForSaveJob(backupJobId, cookie)
    expect(backupCompletion.data).toMatchObject({
      job: { kind: 'save.backup', state: 'succeeded' },
      run: { operation: 'backup', state: 'succeeded', recoveryRequired: false }
    })
    const backupId = backupCompletion.data.run.result.backupId as string
    const duplicate = await injectMutation('/api/v1/saves/backup/execute', cookie, {
      requestId: backupRequestId, saveName: fixture.saveName, confirmation: 'CREATE_BACKUP'
    })
    expect(duplicate.statusCode).toBe(200)
    expect(duplicate.json().data).toMatchObject({
      job: { id: backupJobId, state: 'succeeded' }, reused: true
    })
    const conflict = await injectMutation('/api/v1/saves/backup/execute', cookie, {
      requestId: backupRequestId, saveName: '_lastexit_', confirmation: 'CREATE_BACKUP'
    })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json().error.code).toBe('SAVE_JOB_IDEMPOTENCY_CONFLICT')

    await Promise.all([
      writeFile(path.join(fixture.saveRoot, `${fixture.saveName}.dsv`), 'new-live-dsv', 'utf8'),
      writeFile(path.join(fixture.saveRoot, `${fixture.saveName}.server`), 'new-live-server', 'utf8')
    ])
    const revisionResponse = await application.app.inject({
      method: 'GET', url: `/api/v1/saves/${encodeURIComponent(fixture.saveName)}/revision`,
      cookies: { dyson_session: cookie }
    })
    expect(revisionResponse.statusCode).toBe(200)
    const restoreInput = {
      requestId: randomUUID(),
      backupId,
      expectedRevision: revisionResponse.json().data.revision as string,
      protectionRequestId: randomUUID()
    }

    const restorePreview = await injectMutation('/api/v1/saves/restore/preview', cookie, restoreInput)
    expect(restorePreview.statusCode).toBe(200)
    expect(restorePreview.json()).toMatchObject({
      data: { operation: 'restore', status: 'dry-run', dryRun: true },
      meta: { executionEnabled: true }
    })
    const restore = await injectMutation('/api/v1/saves/restore/execute', cookie, {
      ...restoreInput, confirmation: 'RESTORE_SAVE_PAIR'
    })
    expect(restore.statusCode).toBe(202)
    expect(restore.json().data).toMatchObject({
      job: { kind: 'save.restore', state: 'queued' },
      run: { operation: 'restore', state: 'queued' }
    })
    const restoreCompletion = await waitForSaveJob(restore.json().data.job.id as string, cookie)
    expect(restoreCompletion.data).toMatchObject({
      job: { kind: 'save.restore', state: 'succeeded' },
      run: {
        operation: 'restore', state: 'succeeded', recoveryRequired: false,
        result: { status: 'succeeded', rollback: 'not-required' }
      }
    })
    expect(await readFile(path.join(fixture.saveRoot, `${fixture.saveName}.dsv`), 'utf8')).toBe('original-dsv')
    expect(await readFile(path.join(fixture.saveRoot, `${fixture.saveName}.server`), 'utf8')).toBe('original-server')
  })

  it('refuses restore preview unless both stopped-process and closed-port evidence match', async () => {
    const fixture = await createFixture()
    const healthy = makeService(fixture)
    const source = await healthy.backup({ requestId: randomUUID(), saveName: fixture.saveName })
    const revision = await healthy.inspect(fixture.saveName)
    const running = new SaveTransactionService({
      saveRoot: fixture.saveRoot,
      backupRoot: fixture.backupRoot,
      stableWindowMs: 0,
      verifyServiceStopped: async () => ({
        protocol: 'DYSON_CONTROL_RUNTIME_V1', expected: 'running', state: 'matched',
        processVerified: true, gamePortListening: true
      })
    })
    application = await buildApplication(config(true), {
      saveTransactionService: running,
      workspacePaths: { ...fixture, configRoot: fixture.saveRoot }
    })
    const cookie = await login(application)
    const response = await injectMutation('/api/v1/saves/restore/preview', cookie, {
      requestId: randomUUID(), backupId: source.backupId,
      expectedRevision: revision.revision, protectionRequestId: randomUUID()
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('SAVE_SERVICE_NOT_STOPPED')
  })

  it('exposes an explicit, gated reconcile route without making duplicate execute retry a mutation', async () => {
    const fixture = await createFixture()
    const service = new ScriptedRouteSaveService()
    application = await buildApplication(config(true), {
      saveTransactionService: service,
      workspacePaths: { ...fixture, configRoot: fixture.saveRoot }
    })
    const cookie = await login(application)
    const input = {
      requestId: randomUUID(),
      backupId: 'tx-55555555-5555-4555-8555-555555555555',
      expectedRevision: `pair-v1:${'a'.repeat(64)}`,
      protectionRequestId: randomUUID()
    }
    const execute = await injectMutation('/api/v1/saves/restore/execute', cookie, {
      ...input, confirmation: 'RESTORE_SAVE_PAIR'
    })
    expect(execute.statusCode).toBe(202)
    const jobId = execute.json().data.job.id as string
    const interrupted = await waitForSaveJob(jobId, cookie)
    expect(interrupted.data).toMatchObject({
      job: { state: 'failed', errorCode: 'SAVE_COMMIT_CLEANUP_PENDING' },
      run: {
        state: 'interrupted', attemptCount: 1, recoveryRequired: true,
        result: { cleanupPending: true, maintenanceRequired: true }
      }
    })

    const duplicate = await injectMutation('/api/v1/saves/restore/execute', cookie, {
      ...input, confirmation: 'RESTORE_SAVE_PAIR'
    })
    expect(duplicate.statusCode).toBe(200)
    expect(duplicate.json().data).toMatchObject({ reused: true, run: { state: 'interrupted' } })
    expect(service.restoreCalls).toHaveLength(1)

    const invalid = await injectMutation(`/api/v1/saves/jobs/${jobId}/reconcile`, cookie, {
      confirmation: 'RECONCILE_SAVE_JOB', backupId: input.backupId
    })
    expect(invalid.statusCode).toBe(400)
    const reconcile = await injectMutation(`/api/v1/saves/jobs/${jobId}/reconcile`, cookie, {
      confirmation: 'RECONCILE_SAVE_JOB'
    })
    expect(reconcile.statusCode).toBe(202)
    expect(reconcile.json().data).toMatchObject({
      reused: false, job: { id: jobId }, run: { state: 'queued', recoveryRequired: true }
    })
    const completed = await waitForSaveJob(jobId, cookie)
    expect(completed.data).toMatchObject({
      job: { state: 'succeeded', errorCode: null },
      run: { state: 'succeeded', attemptCount: 2, recoveryRequired: false }
    })
    expect(service.restoreCalls).toHaveLength(2)
    expect(service.restoreCalls[1]).toEqual(service.restoreCalls[0])
  })

  it('keeps the explicit reconcile route closed when save mutations are disabled', async () => {
    const fixture = await createFixture()
    application = await buildApplication(config(false), {
      saveTransactionService: new ScriptedRouteSaveService(),
      workspacePaths: { ...fixture, configRoot: fixture.saveRoot }
    })
    const cookie = await login(application)
    const response = await injectMutation(
      `/api/v1/saves/jobs/${randomUUID()}/reconcile`,
      cookie,
      { confirmation: 'RECONCILE_SAVE_JOB' }
    )
    expect(response.statusCode).toBe(503)
    expect(response.json().error.code).toBe('SAVE_MUTATIONS_DISABLED')
  })
})

class ScriptedRouteSaveService {
  readonly restoreCalls: RestoreSavePairRequest[] = []

  async inspect(saveName: string): Promise<SavePairRevision> {
    return {
      schemaVersion: 1,
      saveName,
      revision: `pair-v1:${'b'.repeat(64)}`,
      dsvBytes: 1024,
      serverBytes: 256,
      totalBytes: 1280
    }
  }

  async backup(input: BackupSavePairRequest): Promise<SaveTransactionResult> {
    return scriptedResult('backup', input.requestId, `tx-${input.requestId}`)
  }

  async restore(input: RestoreSavePairRequest): Promise<SaveTransactionResult> {
    this.restoreCalls.push({ ...input })
    return scriptedResult(
      'restore',
      input.requestId,
      input.backupId,
      input.protectionRequestId,
      this.restoreCalls.length === 1
    )
  }
}

function scriptedResult(
  operation: 'backup' | 'restore',
  requestId: string,
  backupId: string,
  protectionRequestId?: string,
  cleanupPending = false
): SaveTransactionResult {
  const protectionBackupId = protectionRequestId ? `tx-${protectionRequestId}` : undefined
  const errorCode = cleanupPending ? 'SAVE_COMMIT_CLEANUP_PENDING' as const : undefined
  return {
    schemaVersion: 1,
    requestId,
    operation,
    status: 'succeeded',
    dryRun: false,
    backupId,
    ...(protectionBackupId ? { protectionBackupId } : {}),
    reused: !cleanupPending,
    rollback: 'not-required',
    pairBytes: 2048,
    cleanupPending,
    maintenanceRequired: cleanupPending,
    ...(errorCode ? { errorCode } : {}),
    auditStored: true,
    audit: {
      schemaVersion: 1,
      requestId,
      action: operation === 'backup' ? 'save.backup' : 'save.restore',
      status: 'succeeded',
      dryRun: false,
      backupId,
      ...(protectionBackupId ? { protectionBackupId } : {}),
      reused: !cleanupPending,
      rollback: 'not-required',
      cleanupPending,
      maintenanceRequired: cleanupPending,
      startedAt: '2026-08-30T00:00:00.000Z',
      finishedAt: '2026-08-30T00:00:01.000Z',
      ...(errorCode ? { errorCode } : {})
    }
  }
}

interface Fixture {
  root: string
  saveRoot: string
  backupRoot: string
  saveName: string
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'dyson-save-routes-'))
  temporaryRoots.push(root)
  const saveRoot = path.join(root, 'Save')
  const backupRoot = path.join(root, 'backups')
  const saveName = 'Fictional_Cooperative_Save'
  await Promise.all([mkdir(saveRoot), mkdir(backupRoot)])
  await Promise.all([
    writeFile(path.join(saveRoot, `${saveName}.dsv`), 'original-dsv', 'utf8'),
    writeFile(path.join(saveRoot, `${saveName}.server`), 'original-server', 'utf8')
  ])
  return { root, saveRoot, backupRoot, saveName }
}

function makeService(fixture: Fixture): SaveTransactionService {
  return new SaveTransactionService({
    saveRoot: fixture.saveRoot,
    backupRoot: fixture.backupRoot,
    stableWindowMs: 0,
    verifyServiceStopped: async () => ({
      protocol: 'DYSON_CONTROL_RUNTIME_V1', expected: 'stopped', state: 'matched',
      processVerified: true, gamePortListening: false
    })
  })
}

function config(enableMutations: boolean) {
  return loadConfig({
    NODE_ENV: 'test', DYSON_PROVIDER: 'windows',
    DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
    DYSON_SAVE_MUTATIONS_ENABLED: enableMutations ? 'true' : 'false',
    DYSON_DEV_ADMIN_PASSWORD: 'test-password-long-enough',
    DYSON_PUBLIC_ORIGIN: 'http://127.0.0.1:13010'
  })
}

async function login(target: BuiltApplication): Promise<string> {
  const response = await target.app.inject({
    method: 'POST', url: '/api/v1/auth/login',
    headers: { origin: 'http://127.0.0.1:13010' },
    payload: { password: 'test-password-long-enough' }
  })
  expect(response.statusCode).toBe(200)
  return response.cookies[0]!.value
}

function injectMutation(url: string, cookie: string, payload: object) {
  if (!application) throw new Error('test application unavailable')
  return application.app.inject({
    method: 'POST', url,
    headers: { origin: 'http://127.0.0.1:13010' },
    cookies: { dyson_session: cookie }, payload
  })
}

async function waitForSaveJob(jobId: string, cookie: string) {
  if (!application) throw new Error('test application unavailable')
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await application.app.inject({
      method: 'GET', url: `/api/v1/saves/jobs/${encodeURIComponent(jobId)}`,
      cookies: { dyson_session: cookie }
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    if (!['queued', 'running'].includes(body.data.run.state as string)) return body
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`save job did not reach a terminal state: ${jobId}`)
}

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const runnerHarness = vi.hoisted(() => ({
  output: '{}',
  calls: [] as Array<{ scriptName: string; arguments: string[]; aborted: boolean }>,
  constructions: [] as Array<{ scriptRoot: string; timeoutMs: number; maximumOutputBytes?: number }>
}))

vi.mock('./providers/powershell-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./providers/powershell-runner.js')>()
  return {
    ...actual,
    PowerShellLifecycleRunner: class {
      constructor(scriptRoot: string, timeoutMs: number, maximumOutputBytes?: number) {
        runnerHarness.constructions.push({ scriptRoot, timeoutMs, maximumOutputBytes })
      }

      async run(scriptName: string, scriptArguments: string[], signal: AbortSignal): Promise<string> {
        runnerHarness.calls.push({
          scriptName,
          arguments: [...scriptArguments],
          aborted: signal.aborted
        })
        if (signal.aborted) throw new Error('fixture runner was unexpectedly aborted')
        return runnerHarness.output
      }
    }
  }
})

import { buildApplication, type BuiltApplication } from './app.js'
import {
  QUALIFIED_CLIENT_PROFILE_ZIP_FILE_NAME,
  QUALIFIED_NEBULA_CLIENT_ZIP_FILE_NAME,
  type ClientQualificationDocumentName
} from './client-profile/index.js'
import { createQualificationFixture } from './client-profile/qualification-v2.fixture.test-helper.js'
import { loadConfig } from './config.js'
import { DemoProvider } from './providers/demo.js'
import {
  hostnameWssQualificationConsumeConfirmation,
  hostnameWssQualificationScriptName
} from './providers/windows-hostname-wss-qualification.js'

const origin = 'http://127.0.0.1:13010'
const administratorPassword = 'fictional-qualified-client-administrator-password'
const testTempBase = path.resolve(process.env.DYSON_TEST_TEMP_ROOT ?? tmpdir())
const temporaryRoots: string[] = []
let application: BuiltApplication | null = null

afterEach(async () => {
  if (application !== null) await application.close()
  application = null
  vi.useRealTimers()
  runnerHarness.output = '{}'
  runnerHarness.calls.splice(0)
  runnerHarness.constructions.splice(0)
  for (const root of temporaryRoots.splice(0)) {
    assertDisposableTestRoot(root)
    await rm(root, { recursive: true, force: true })
  }
})

describe('qualified client profile production assembly', () => {
  it('keeps every V2 route disabled from Windows configuration even if no protected roots exist', async () => {
    const root = await createDisposableTestRoot()
    const projectRoot = path.join(root, 'fictional-project')
    const dataRoot = path.join(root, 'fictional-data')
    const scriptRoot = path.join(root, 'fictional-scripts')
    await Promise.all([
      mkdir(path.join(projectRoot, 'userdata', 'Save'), { recursive: true }),
      mkdir(path.join(projectRoot, 'backups', 'saves'), { recursive: true }),
      mkdir(path.join(projectRoot, 'server', 'BepInEx', 'config'), { recursive: true }),
      mkdir(dataRoot, { recursive: true }),
      mkdir(scriptRoot, { recursive: true })
    ])
    const config = loadConfig({
      NODE_ENV: 'test',
      DYSON_PROVIDER: 'windows',
      DYSON_PROJECT_ROOT: projectRoot,
      DYSON_DATA_DIR: dataRoot,
      DYSON_SCRIPT_ROOT: scriptRoot,
      DYSON_PUBLIC_ORIGIN: origin,
      DYSON_DEV_ADMIN_PASSWORD: administratorPassword,
      DYSON_OBSERVABILITY_INTERVAL_MS: '0'
    })
    application = await buildApplication(config, { statusProvider: new DemoProvider() })
    const cookie = await login()

    for (const request of [
      {
        method: 'POST' as const,
        url: '/api/v2/client-profile/issue',
        headers: { origin },
        payload: { schemaVersion: 2, qualificationId: '10000000-0000-0000-0000-000000000001' }
      },
      { method: 'GET' as const, url: '/api/v2/client-profile/archive/90000000-0000-0000-0000-000000000001' },
      { method: 'GET' as const, url: '/api/v2/client-profile/client/90000000-0000-0000-0000-000000000001' },
      { method: 'GET' as const, url: '/api/v2/client-profile/runtime/90000000-0000-0000-0000-000000000001' }
    ]) {
      const response = await application.app.inject({
        ...request,
        cookies: { dyson_session: cookie }
      })
      expect(response.statusCode).toBe(423)
      expect(response.json()).toEqual({
        error: {
          code: 'QUALIFIED_CLIENT_PROFILE_DISABLED',
          message: '受保护客户端签发门禁尚未启用'
        }
      })
    }
    expect(runnerHarness.calls).toEqual([])
  })

  it('assembles the fixed store, Windows consumer and service from configuration for one issue', async () => {
    const fixture = await createProductionFixture()
    useFixtureClock(fixture.qualification.now)
    runnerHarness.output = JSON.stringify(fixture.projection)
    application = await buildApplication(fixture.config, { statusProvider: new DemoProvider() })
    const cookie = await login()

    const response = await application.app.inject({
      method: 'POST',
      url: '/api/v2/client-profile/issue',
      headers: { origin },
      cookies: { dyson_session: cookie },
      payload: fixture.qualification.request
    })
    expect(response.statusCode, response.body).toBe(200)
    const body = response.json() as {
      data: {
        downloadId: string
        qualificationId: string
        bindingSha256: string
        metadata: { qualification: Record<string, unknown> }
      }
    }
    expect(body.data).toMatchObject({
      qualificationId: fixture.projection.qualificationId,
      bindingSha256: fixture.qualification.document.documentSha256
    })
    expect(body.data.metadata.qualification).toEqual(fixture.projection)
    expect(Object.keys(body.data.metadata.qualification).sort()).toEqual([
      'bindingSha256', 'blockerCodes', 'decision', 'expiresAtUtc', 'qualificationId', 'runId'
    ])
    expect(response.body).not.toContain('"bytes"')
    assertNoSensitiveLeak(response.body, fixture.sensitiveMarkers)

    expect(runnerHarness.constructions).toContainEqual({
      scriptRoot: fixture.locations.scriptRoot,
      timeoutMs: fixture.config.lifecycleTimeoutMs,
      maximumOutputBytes: undefined
    })
    expect(runnerHarness.calls).toEqual([{
      scriptName: hostnameWssQualificationScriptName,
      arguments: [
        '-EvidenceRoot', path.join(fixture.locations.evidenceRoot, fixture.projection.qualificationId),
        '-BuildHarvestRootA', fixture.locations.buildHarvestRootA,
        '-BuildHarvestRootB', fixture.locations.buildHarvestRootB,
        '-KeyRingRoot', fixture.locations.keyRingRoot,
        '-ReplayRoot', fixture.locations.replayRoot,
        '-ExpectedQualificationId', fixture.projection.qualificationId,
        '-ExpectedAuthority', 'example.com',
        '-ExpectedPort', '443',
        '-Consume',
        '-Confirmation', hostnameWssQualificationConsumeConfirmation
      ],
      aborted: false
    }])
    expect(await readdir(path.join(fixture.locations.issueRoot, 'objects'))).toEqual([
      body.data.downloadId
    ])
    expect(await readdir(path.join(fixture.locations.issueRoot, 'by-qualification'))).toEqual([
      `${fixture.projection.qualificationId}.json`
    ])

    await verifyThreeDownloadsAndTamperRejection(
      body.data.downloadId,
      fixture.locations.issueRoot,
      cookie,
      fixture.sensitiveMarkers
    )
    expect(runnerHarness.calls).toHaveLength(1)
  })

  it('rejects an otherwise valid verifier result containing a seventh field before publication', async () => {
    const fixture = await createProductionFixture()
    useFixtureClock(fixture.qualification.now)
    runnerHarness.output = JSON.stringify({
      ...fixture.projection,
      privateRoot: fixture.locations.evidenceRoot
    })
    application = await buildApplication(fixture.config, { statusProvider: new DemoProvider() })
    const cookie = await login()

    const response = await application.app.inject({
      method: 'POST',
      url: '/api/v2/client-profile/issue',
      headers: { origin },
      cookies: { dyson_session: cookie },
      payload: fixture.qualification.request
    })
    expect(response.statusCode).toBe(422)
    expect(response.json()).toEqual({
      error: {
        code: 'QUALIFIED_CLIENT_PROFILE_NOT_ISSUED',
        message: '受保护资格、客户端制品或签发回执未通过完整验证'
      }
    })
    assertNoSensitiveLeak(response.body, fixture.sensitiveMarkers)
    expect(runnerHarness.calls).toHaveLength(1)
    expect(await readdir(path.join(fixture.locations.issueRoot, 'objects'))).toEqual([])
    expect(await readdir(path.join(fixture.locations.issueRoot, 'by-qualification'))).toEqual([])
  })
})

async function verifyThreeDownloadsAndTamperRejection(
  downloadId: string,
  issueRoot: string,
  cookie: string,
  sensitiveMarkers: readonly string[]
): Promise<void> {
  const objectRoot = path.join(issueRoot, 'objects', downloadId)
  for (const target of [
    {
      url: `/api/v2/client-profile/archive/${downloadId}`,
      fileName: QUALIFIED_CLIENT_PROFILE_ZIP_FILE_NAME,
      mediaType: 'application/zip'
    },
    {
      url: `/api/v2/client-profile/client/${downloadId}`,
      fileName: QUALIFIED_NEBULA_CLIENT_ZIP_FILE_NAME,
      mediaType: 'application/zip'
    },
    {
      url: `/api/v2/client-profile/runtime/${downloadId}`,
      fileName: 'qualified-client-runtime.json',
      mediaType: 'application/json'
    }
  ] as const) {
    const storedFile = path.join(objectRoot, target.fileName)
    const original = await readFile(storedFile)
    const response = await application!.app.inject({
      method: 'GET', url: target.url, cookies: { dyson_session: cookie }
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.rawPayload.equals(original)).toBe(true)
    expect(response.headers['content-type']).toContain(target.mediaType)
    expect(response.headers['content-disposition']).toBe(`attachment; filename="${target.fileName}"`)
    expect(response.headers['content-length']).toBe(String(original.byteLength))
    expect(response.headers['x-dyson-content-sha256']).toBe(bareSha256(original))
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    assertNoSensitiveLeak(response.rawPayload.toString('utf8'), sensitiveMarkers)

    try {
      await writeFile(storedFile, Buffer.concat([original, Buffer.from('private-tamper-marker')]))
      const tampered = await application!.app.inject({
        method: 'GET', url: target.url, cookies: { dyson_session: cookie }
      })
      expect(tampered.statusCode).toBe(404)
      expect(tampered.json()).toEqual({
        error: {
          code: 'QUALIFIED_CLIENT_ARTIFACT_UNAVAILABLE',
          message: '客户端制品不存在或未通过下载时完整性校验'
        }
      })
      assertNoSensitiveLeak(tampered.body, [...sensitiveMarkers, 'private-tamper-marker'])
    } finally {
      await writeFile(storedFile, original)
    }
  }
}

async function createProductionFixture() {
  const qualification = createQualificationFixture()
  const root = await createDisposableTestRoot()
  const locations = {
    projectRoot: path.join(root, 'fictional-project'),
    dataRoot: path.join(root, 'fictional-data'),
    scriptRoot: path.join(root, 'fictional-scripts'),
    evidenceRoot: path.join(root, 'sensitive-qualification-evidence'),
    buildHarvestRootA: path.join(root, 'fictional-build-harvest-a'),
    buildHarvestRootB: path.join(root, 'fictional-build-harvest-b'),
    keyRingRoot: path.join(root, 'sensitive-key-ring'),
    replayRoot: path.join(root, 'sensitive-replay-ledger'),
    issueRoot: path.join(root, 'sensitive-issued-profiles')
  }
  const qualificationRoot = path.join(locations.evidenceRoot, qualification.request.qualificationId)
  await Promise.all([
    mkdir(path.join(locations.projectRoot, 'userdata', 'Save'), { recursive: true }),
    mkdir(path.join(locations.projectRoot, 'backups', 'saves'), { recursive: true }),
    mkdir(path.join(locations.projectRoot, 'server', 'BepInEx', 'config'), { recursive: true }),
    mkdir(locations.dataRoot, { recursive: true }),
    mkdir(locations.scriptRoot, { recursive: true }),
    mkdir(path.join(qualificationRoot, 'candidate'), { recursive: true }),
    mkdir(path.join(qualificationRoot, 'client'), { recursive: true }),
    mkdir(locations.buildHarvestRootA, { recursive: true }),
    mkdir(locations.buildHarvestRootB, { recursive: true }),
    mkdir(locations.keyRingRoot, { recursive: true }),
    mkdir(locations.replayRoot, { recursive: true }),
    mkdir(locations.issueRoot, { recursive: true })
  ])
  await materializeQualification(qualificationRoot, locations.keyRingRoot, qualification.store)

  const config = loadConfig({
    NODE_ENV: 'test',
    DYSON_PROVIDER: 'windows',
    DYSON_PROJECT_ROOT: locations.projectRoot,
    DYSON_DATA_DIR: locations.dataRoot,
    DYSON_SCRIPT_ROOT: locations.scriptRoot,
    DYSON_PUBLIC_ORIGIN: origin,
    DYSON_DEV_ADMIN_PASSWORD: administratorPassword,
    DYSON_OBSERVABILITY_INTERVAL_MS: '0',
    DYSON_QUALIFIED_CLIENT_PROFILE_ENABLED: 'true',
    DYSON_CLIENT_QUALIFICATION_EVIDENCE_ROOT: locations.evidenceRoot,
    DYSON_CLIENT_QUALIFICATION_BUILD_HARVEST_ROOT_A: locations.buildHarvestRootA,
    DYSON_CLIENT_QUALIFICATION_BUILD_HARVEST_ROOT_B: locations.buildHarvestRootB,
    DYSON_CLIENT_QUALIFICATION_KEY_RING_ROOT: locations.keyRingRoot,
    DYSON_CLIENT_QUALIFICATION_REPLAY_ROOT: locations.replayRoot,
    DYSON_QUALIFIED_CLIENT_ISSUE_ROOT: locations.issueRoot,
    DYSON_CLIENT_QUALIFICATION_AUTHORITY: 'example.com'
  })
  const projection = {
    qualificationId: qualification.document.qualificationId as string,
    runId: qualification.document.runId as string,
    bindingSha256: qualification.document.documentSha256 as string,
    expiresAtUtc: qualification.document.expiresAtUtc as string,
    decision: 'qualified' as const,
    blockerCodes: [] as []
  }
  return {
    qualification,
    config,
    locations,
    projection,
    sensitiveMarkers: [
      path.basename(locations.evidenceRoot),
      path.basename(locations.keyRingRoot),
      path.basename(locations.replayRoot),
      path.basename(locations.issueRoot),
      'document-key-0005'
    ]
  }
}

async function materializeQualification(
  qualificationRoot: string,
  keyRingRoot: string,
  store: ReturnType<typeof createQualificationFixture>['store']
): Promise<void> {
  const documentFiles: Record<ClientQualificationDocumentName, string> = {
    qualification: 'qualification.json',
    'source-patch-contract': 'source-patch-contract.json',
    'private-build-contract': 'private-build-contract.json',
    'binary-metadata-a': 'binary-metadata-a.json',
    'binary-metadata-b': 'binary-metadata-b.json',
    'candidate-manifest': 'candidate-manifest.json',
    'client-manifest': 'client-manifest.json',
    'external-client-receipts': 'external-client-receipts.json',
    'profile-input': 'profile-input.json'
  }
  for (const [name, bytes] of store.documents) {
    await writeFile(path.join(qualificationRoot, documentFiles[name]), bytes)
  }
  for (const [relative, bytes] of store.candidateFiles) {
    const target = path.join(qualificationRoot, 'candidate', ...relative.split('/'))
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, bytes)
  }
  for (const [relative, bytes] of store.clientFiles) {
    const target = path.join(qualificationRoot, 'client', ...relative.split('/'))
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, bytes)
  }
  for (const [keyId, bytes] of store.keys) {
    await writeFile(path.join(keyRingRoot, `${keyId}.key`), bytes)
  }
  await writeFile(path.join(qualificationRoot, 'client-package.zip'), store.clientPackage)
}

function useFixtureClock(now: Date): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
}

async function login(): Promise<string> {
  const response = await application!.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin },
    payload: { role: 'administrator', password: administratorPassword }
  })
  expect(response.statusCode, response.body).toBe(200)
  expect(response.cookies[0]?.value).toBeTruthy()
  return response.cookies[0]!.value
}

async function createDisposableTestRoot(): Promise<string> {
  await mkdir(testTempBase, { recursive: true })
  const root = await mkdtemp(path.join(testTempBase, 'dyson-qualified-client-production-assembly-'))
  assertDisposableTestRoot(root)
  temporaryRoots.push(root)
  return root
}

function assertDisposableTestRoot(root: string): void {
  const resolved = path.resolve(root)
  const relative = path.relative(testTempBase, resolved)
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) || !path.basename(resolved).startsWith('dyson-qualified-client-production-assembly-')) {
    throw new Error('QUALIFIED_CLIENT_TEST_ROOT_INVALID')
  }
}

function assertNoSensitiveLeak(value: string, markers: readonly string[]): void {
  for (const marker of markers) expect(value).not.toContain(marker)
}

function bareSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

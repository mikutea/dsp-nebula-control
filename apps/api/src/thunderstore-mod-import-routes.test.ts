import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApplication, type BuiltApplication } from './app.js'
import { loadConfig } from './config.js'
import {
  type ThunderstoreModImportHttpService,
  type ThunderstoreModImportPlan,
  type ThunderstoreModImportReceipt
} from './mods/index.js'
import { hashPassword } from './security/password.js'

const origin = 'http://127.0.0.1:13010'
const administratorPassword = 'fictional-mod-import-administrator'
const viewerPassword = 'fictional-mod-import-viewer'
const acquisitionReceiptId = 'a1dc143d-c529-4e56-9f16-4f498945c31a'
const requestId = 'a8ff3705-8660-47dc-8a1e-3cca1865530e'
const dependencyId = 'TestAuthor-ExampleMod-1.2.3'
let application: BuiltApplication | null = null
let viewerPasswordHash = ''
const temporaryRoots: string[] = []

beforeAll(async () => {
  viewerPasswordHash = await hashPassword(viewerPassword)
})

afterEach(async () => {
  await application?.close()
  application = null
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Thunderstore mod import application routes', () => {
  it('allows read-only preview and receipt lookup while keeping import independently disabled', async () => {
    const service = serviceFixture()
    application = await buildApplication(baseConfig(), { thunderstoreModImportService: service })
    const [viewer, administrator] = await Promise.all([
      login('viewer', viewerPassword),
      login('administrator', administratorPassword)
    ])

    const preview = await post(viewer, '/api/v1/mods/import/preview', { acquisitionReceiptId })
    expect(preview.statusCode).toBe(200)
    expect(preview.json()).toMatchObject({ ok: true, data: { dryRun: true, acquisitionReceiptId } })
    expect(service.preview).toHaveBeenCalledWith({ acquisitionReceiptId }, expect.any(AbortSignal))

    const forbidden = await post(viewer, '/api/v1/mods/import/execute', executeRequest())
    expect(forbidden.statusCode).toBe(403)

    const disabled = await post(administrator, '/api/v1/mods/import/execute', executeRequest())
    expect(disabled.statusCode).toBe(423)
    expect(disabled.json()).toEqual({
      ok: false,
      error: { code: 'THUNDERSTORE_MOD_IMPORT_MUTATION_DISABLED' }
    })
    expect(service.execute).not.toHaveBeenCalled()

    const receipt = await application.app.inject({
      method: 'GET',
      url: `/api/v1/mods/import/receipts/${requestId}`,
      cookies: { dyson_session: viewer }
    })
    expect(receipt.statusCode).toBe(200)
    expect(receipt.json()).toMatchObject({ ok: true, data: { requestId, state: 'staged' } })
  })

  it('executes only for an administrator when the dedicated import gate is enabled', async () => {
    const roots = await configuredRoots()
    const service = serviceFixture()
    application = await buildApplication(enabledConfig(roots), { thunderstoreModImportService: service })
    const administrator = await login('administrator', administratorPassword)

    const response = await post(administrator, '/api/v1/mods/import/execute', executeRequest())
    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ ok: true, data: { requestId, reused: false } })
    expect(service.execute).toHaveBeenCalledWith(executeRequest(), expect.any(AbortSignal))
  })

  it('rejects path-like extra input and has a stable unconfigured response', async () => {
    const roots = await configuredRoots()
    const service = serviceFixture()
    application = await buildApplication(enabledConfig(roots), { thunderstoreModImportService: service })
    const administrator = await login('administrator', administratorPassword)

    const invalid = await post(administrator, '/api/v1/mods/import/execute', {
      ...executeRequest(),
      path: 'C:\\private\\must-not-reflect'
    })
    expect(invalid.statusCode).toBe(422)
    expect(JSON.stringify(invalid.json())).not.toContain('private')
    expect(service.execute).not.toHaveBeenCalled()

    const invalidReceipt = await application.app.inject({
      method: 'GET',
      url: `/api/v1/mods/import/receipts/${requestId}?path=private`,
      cookies: { dyson_session: administrator }
    })
    expect(invalidReceipt.statusCode).toBe(422)
    expect(service.getReceipt).not.toHaveBeenCalled()

    await application.close()
    application = await buildApplication(baseConfig())
    const noServiceAdministrator = await login('administrator', administratorPassword)
    const unavailable = await post(
      noServiceAdministrator,
      '/api/v1/mods/import/preview',
      { acquisitionReceiptId }
    )
    expect(unavailable.statusCode).toBe(503)
    expect(unavailable.json()).toEqual({
      ok: false,
      error: { code: 'THUNDERSTORE_MOD_IMPORT_NOT_CONFIGURED' }
    })
  })
})

function baseConfig() {
  return loadConfig({
    NODE_ENV: 'test',
    DYSON_PROVIDER: 'demo',
    DYSON_PUBLIC_ORIGIN: origin,
    DYSON_DEV_ADMIN_PASSWORD: administratorPassword,
    DYSON_VIEWER_PASSWORD_HASH: viewerPasswordHash
  })
}

function enabledConfig(roots: Awaited<ReturnType<typeof configuredRoots>>) {
  return loadConfig({
    NODE_ENV: 'test',
    DYSON_PROVIDER: 'demo',
    DYSON_PUBLIC_ORIGIN: origin,
    DYSON_DEV_ADMIN_PASSWORD: administratorPassword,
    DYSON_VIEWER_PASSWORD_HASH: viewerPasswordHash,
    DYSON_PROJECT_ROOT: roots.projectRoot,
    DYSON_UPDATE_STAGING_ENABLED: 'true',
    DYSON_UPDATE_INBOX_ROOT: roots.inboxRoot,
    DYSON_UPDATE_STAGING_ROOT: roots.updateStagingRoot,
    DYSON_MOD_IMPORT_ENABLED: 'true',
    DYSON_MOD_STAGING_ROOT: roots.modStagingRoot,
    DYSON_MOD_PLUGINS_ROOT: roots.modPluginsRoot
  })
}

async function configuredRoots() {
  const root = await mkdtemp(path.join(tmpdir(), 'dyson-mod-import-routes-'))
  temporaryRoots.push(root)
  const projectRoot = path.join(root, 'project')
  return {
    projectRoot,
    inboxRoot: path.join(root, 'inbox'),
    updateStagingRoot: path.join(root, 'update-staging'),
    modStagingRoot: path.join(root, 'mod-staging'),
    modPluginsRoot: path.join(projectRoot, 'server', 'BepInEx', 'plugins', 'dyson-managed-mods')
  }
}

async function login(role: 'viewer' | 'administrator', password: string): Promise<string> {
  const response = await application!.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin },
    payload: { role, password }
  })
  expect(response.statusCode).toBe(200)
  return response.cookies[0]!.value
}

async function post(cookie: string, url: string, payload: Record<string, unknown>) {
  return await application!.app.inject({
    method: 'POST',
    url,
    headers: { origin },
    cookies: { dyson_session: cookie },
    payload
  })
}

function executeRequest() {
  return {
    requestId,
    acquisitionReceiptId,
    confirmation: 'IMPORT_THUNDERSTORE_MOD' as const
  }
}

function serviceFixture(): ThunderstoreModImportHttpService & {
  preview: ReturnType<typeof vi.fn<ThunderstoreModImportHttpService['preview']>>
  execute: ReturnType<typeof vi.fn<ThunderstoreModImportHttpService['execute']>>
  getReceipt: ReturnType<typeof vi.fn<ThunderstoreModImportHttpService['getReceipt']>>
  getVerifiedReceipt: ReturnType<typeof vi.fn<ThunderstoreModImportHttpService['getReceipt']>>
} {
  return {
    preview: vi.fn<ThunderstoreModImportHttpService['preview']>(async () => importPlan),
    execute: vi.fn<ThunderstoreModImportHttpService['execute']>(async () => importReceipt),
    getReceipt: vi.fn<ThunderstoreModImportHttpService['getReceipt']>(async () => importReceipt),
    getVerifiedReceipt: vi.fn<ThunderstoreModImportHttpService['getReceipt']>(async () => importReceipt)
  }
}

const stagedManifest = {
  format: 'dyson-control-staged-mod-package' as const,
  schemaVersion: 1 as const,
  dependencyId,
  sourceId: 'thunderstore:TestAuthor/ExampleMod',
  version: '1.2.3',
  dependencies: [],
  files: [{ relativePath: 'ExampleMod.dll', sizeBytes: 128, sha256: 'd'.repeat(64) }]
}

const importPlan: ThunderstoreModImportPlan = {
  format: 'dyson-control-thunderstore-mod-import-plan',
  schemaVersion: 1,
  dryRun: true,
  acquisitionReceiptId,
  artifact: { artifactId: `artifact-${'a'.repeat(40)}`, sizeBytes: 1_024, sha256: 'b'.repeat(64) },
  package: {
    dependencyId,
    sourceId: 'thunderstore:TestAuthor/ExampleMod',
    version: '1.2.3',
    dependencies: []
  },
  payload: { sha256: 'c'.repeat(64), fileCount: 1, sizeBytes: 128 },
  operations: [
    'load-validated-acquisition-receipt',
    'verify-fixed-inbox-artifact',
    'validate-thunderstore-root-manifest-and-exact-dependencies',
    'apply-bepinex-plugin-only-install-rules',
    'compute-canonical-payload-digest',
    'atomically-publish-mod-staging-package'
  ],
  deployment: { automatic: false, nextAction: 'mod-deployment-preview' }
}

const importReceipt: ThunderstoreModImportReceipt = {
  format: 'dyson-control-thunderstore-mod-import-receipt',
  schemaVersion: 1,
  requestId,
  acquisitionReceiptId,
  artifact: importPlan.artifact,
  package: importPlan.package,
  payload: { ...importPlan.payload, manifest: stagedManifest },
  staging: { created: true },
  state: 'staged',
  reused: false,
  importedAt: '2026-08-31T04:00:00.000Z'
}

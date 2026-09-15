import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApplication, type BuiltApplication } from './app.js'
import { loadConfig } from './config.js'
import { hashPassword } from './security/password.js'
import {
  nebulaWindowsLayoutPolicyIds,
  type AvailableComponentCandidatePreparationPlan,
  type ComponentCandidatePreparationHttpService,
  type ComponentCandidatePreparationReceipt
} from './update-pipeline/index.js'

const origin = 'http://127.0.0.1:13010'
const administratorPassword = 'fictional-preparation-administrator'
const operatorPassword = 'fictional-preparation-operator'
const viewerPassword = 'fictional-preparation-viewer'
const acquisitionReceiptId = 'a1dc143d-c529-4e56-9f16-4f498945c31a'
const requestId = 'a8ff3705-8660-47dc-8a1e-3cca1865530e'
let application: BuiltApplication | null = null
let operatorPasswordHash = ''
let viewerPasswordHash = ''
const temporaryRoots: string[] = []

beforeAll(async () => {
  [operatorPasswordHash, viewerPasswordHash] = await Promise.all([
    hashPassword(operatorPassword),
    hashPassword(viewerPassword)
  ])
})

afterEach(async () => {
  await application?.close()
  application = null
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('component candidate preparation application routes', () => {
  it('keeps execution disabled independently while permitting authenticated preview and receipt reads', async () => {
    const service = serviceFixture()
    application = await buildApplication(baseConfig(), { componentCandidatePreparationService: service })
    const [viewer, operator] = await Promise.all([
      login('viewer', viewerPassword),
      login('operator', operatorPassword)
    ])

    const preview = await post(viewer, '/api/v1/updates/preparation/component/preview', {
      component: 'nebula', acquisitionReceiptId
    })
    expect(preview.statusCode).toBe(200)
    expect(preview.json()).toMatchObject({ ok: true, data: { dryRun: true, component: 'nebula' } })

    const forbidden = await post(viewer, '/api/v1/updates/preparation/component/execute', executeRequest())
    expect(forbidden.statusCode).toBe(403)

    const disabled = await post(operator, '/api/v1/updates/preparation/component/execute', executeRequest())
    expect(disabled.statusCode).toBe(423)
    expect(disabled.json()).toEqual({
      ok: false,
      error: { code: 'CANDIDATE_PREPARATION_MUTATION_DISABLED' }
    })
    expect(service.execute).not.toHaveBeenCalled()

    const receiptResponse = await application.app.inject({
      method: 'GET',
      url: `/api/v1/updates/preparation/component/receipts/${requestId}`,
      cookies: { dyson_session: viewer }
    })
    expect(receiptResponse.statusCode).toBe(200)
    expect(receiptResponse.json()).toMatchObject({ ok: true, data: { requestId, state: 'staged' } })
  })

  it('executes only for an updates.stage role when the dedicated gate is enabled', async () => {
    const roots = await stagingRoots()
    const service = serviceFixture()
    application = await buildApplication(enabledConfig(roots), { componentCandidatePreparationService: service })
    const operator = await login('operator', operatorPassword)

    const response = await post(operator, '/api/v1/updates/preparation/component/execute', executeRequest())
    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ ok: true, data: { requestId, reused: false } })
    expect(service.execute).toHaveBeenCalledWith(
      executeRequest(),
      expect.any(AbortSignal)
    )
  })

  it('rejects extra query/body fields and reports a stable unavailable response', async () => {
    const roots = await stagingRoots()
    const service = serviceFixture()
    application = await buildApplication(enabledConfig(roots), { componentCandidatePreparationService: service })
    const administrator = await login('administrator', administratorPassword)

    const invalidBody = await post(administrator, '/api/v1/updates/preparation/component/execute', {
      ...executeRequest(), path: 'C:\\private\\must-not-reflect'
    })
    expect(invalidBody.statusCode).toBe(422)
    expect(JSON.stringify(invalidBody.json())).not.toContain('private')

    const invalidReceipt = await application.app.inject({
      method: 'GET',
      url: `/api/v1/updates/preparation/component/receipts/${requestId}?path=private`,
      cookies: { dyson_session: administrator }
    })
    expect(invalidReceipt.statusCode).toBe(422)
    expect(service.getReceipt).not.toHaveBeenCalled()

    await application.close()
    application = await buildApplication(baseConfig())
    const noServiceAdministrator = await login('administrator', administratorPassword)
    const unavailable = await post(
      noServiceAdministrator,
      '/api/v1/updates/preparation/component/preview',
      { component: 'nebula', acquisitionReceiptId }
    )
    expect(unavailable.statusCode).toBe(503)
    expect(unavailable.json()).toEqual({
      ok: false,
      error: { code: 'CANDIDATE_PREPARATION_NOT_CONFIGURED' }
    })
  })
})

function baseConfig() {
  return loadConfig({
    NODE_ENV: 'test',
    DYSON_PROVIDER: 'demo',
    DYSON_PUBLIC_ORIGIN: origin,
    DYSON_DEV_ADMIN_PASSWORD: administratorPassword,
    DYSON_OPERATOR_PASSWORD_HASH: operatorPasswordHash,
    DYSON_VIEWER_PASSWORD_HASH: viewerPasswordHash
  })
}

function enabledConfig(roots: { inboxRoot: string; stagingRoot: string }) {
  return loadConfig({
    NODE_ENV: 'test',
    DYSON_PROVIDER: 'demo',
    DYSON_PUBLIC_ORIGIN: origin,
    DYSON_DEV_ADMIN_PASSWORD: administratorPassword,
    DYSON_OPERATOR_PASSWORD_HASH: operatorPasswordHash,
    DYSON_VIEWER_PASSWORD_HASH: viewerPasswordHash,
    DYSON_UPDATE_STAGING_ENABLED: 'true',
    DYSON_UPDATE_PREPARATION_ENABLED: 'true',
    DYSON_UPDATE_INBOX_ROOT: roots.inboxRoot,
    DYSON_UPDATE_STAGING_ROOT: roots.stagingRoot
  })
}

async function stagingRoots() {
  const root = await mkdtemp(path.join(tmpdir(), 'dyson-candidate-preparation-routes-'))
  temporaryRoots.push(root)
  const inboxRoot = path.join(root, 'inbox')
  const stagingRoot = path.join(root, 'staging')
  await Promise.all([mkdir(inboxRoot), mkdir(stagingRoot)])
  return { inboxRoot, stagingRoot }
}

async function login(role: 'viewer' | 'operator' | 'administrator', password: string): Promise<string> {
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
    component: 'nebula' as const,
    acquisitionReceiptId,
    confirmation: 'PREPARE_COMPONENT_CANDIDATE' as const
  }
}

function serviceFixture(): ComponentCandidatePreparationHttpService & {
  preview: ReturnType<typeof vi.fn<ComponentCandidatePreparationHttpService['preview']>>
  execute: ReturnType<typeof vi.fn<ComponentCandidatePreparationHttpService['execute']>>
  getReceipt: ReturnType<typeof vi.fn<ComponentCandidatePreparationHttpService['getReceipt']>>
} {
  return {
    preview: vi.fn<ComponentCandidatePreparationHttpService['preview']>(
      async (_input, _signal) => preparationPlan
    ),
    execute: vi.fn<ComponentCandidatePreparationHttpService['execute']>(
      async (_input, _signal) => preparationReceipt
    ),
    getReceipt: vi.fn<ComponentCandidatePreparationHttpService['getReceipt']>(
      async (_requestId) => preparationReceipt
    )
  }
}

const sourceArtifactId = `artifact-${'a'.repeat(40)}`
const preparedArtifactId = `prepared-nebula-${'b'.repeat(40)}`
const source = {
  provider: 'github' as const,
  sourceId: 'github:NebulaModTeam/nebula',
  version: '0.9.22',
  artifactId: sourceArtifactId,
  sizeBytes: 10_000,
  sha256: 'c'.repeat(64),
  integrity: 'provider-verified' as const
}

const preparationPlan: AvailableComponentCandidatePreparationPlan = {
  format: 'dyson-control-component-preparation-plan',
  schemaVersion: 1,
  available: true,
  dryRun: true,
  component: 'nebula',
  acquisitionReceiptId,
  source,
  prepared: {
    mode: 'normalized-nebula-windows',
    artifactId: preparedArtifactId,
    layoutPolicy: nebulaWindowsLayoutPolicyIds.v0_9_22
  },
  operations: ['load-validated-acquisition-receipt', 'stage-verified-artifact'],
  activation: { automatic: false, nextAction: 'component-update-activation-preview' }
}

const preparationReceipt: ComponentCandidatePreparationReceipt = {
  format: 'dyson-control-component-preparation-receipt',
  schemaVersion: 1,
  requestId,
  component: 'nebula',
  acquisitionReceiptId,
  source,
  prepared: {
    ...preparationPlan.prepared,
    sizeBytes: 8_000,
    sha256: 'd'.repeat(64),
    integrity: 'normalized-locally-computed'
  },
  staging: {
    created: true,
    manifest: {
      format: 'dyson-control-staged-artifact',
      schemaVersion: 1,
      artifactId: preparedArtifactId,
      artifactFile: 'artifact.bin',
      release: { kind: 'nebula', sourceId: source.sourceId, version: source.version },
      sizeBytes: 8_000,
      sha256: 'd'.repeat(64),
      integrity: 'locally-computed',
      stagedAt: '2026-08-30T08:00:00.000Z'
    }
  },
  state: 'staged',
  reused: false,
  preparedAt: '2026-08-30T08:00:00.000Z'
}

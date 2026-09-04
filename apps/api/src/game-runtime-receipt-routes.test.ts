import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApplication, type BuiltApplication } from './app.js'
import { loadConfig } from './config.js'
import {
  GAME_RUNTIME_PUBLIC_RECEIPT_DIGEST_DOMAIN,
  GAME_RUNTIME_RECEIPT_PROTOCOL,
  type GameRuntimeReceiptSource,
  type PublicGameRuntimeReceipt
} from './lifecycle/game-runtime-receipts.js'
import { hashPassword } from './security/password.js'

const origin = 'http://127.0.0.1:13010'
const viewerPassword = 'fictional-runtime-receipt-viewer-password'
const publicReceiptPropertyNames = [
  'protocol',
  'schemaVersion',
  'attemptId',
  'bindingId',
  'version',
  'outcome',
  'errorCode',
  'restartExpected',
  'startedAt',
  'publishedAt',
  'completedAt',
  'projectRootIdentityVerified',
  'dataRootIdentityVerified',
  'receiptSha256'
] as const
let viewerPasswordHash = ''
let fixtureRoot = ''
let application: BuiltApplication | null = null

beforeAll(async () => {
  viewerPasswordHash = await hashPassword(viewerPassword)
})

afterEach(async () => {
  await application?.close()
  application = null
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = ''
})

describe('game runtime receipt route', () => {
  it('uses lifecycle.read and the injected read-only source without exposing paths', async () => {
    const list = vi.fn<GameRuntimeReceiptSource['list']>().mockResolvedValue({
      items: [publicReceipt()],
      nextCursor: 'eyJmaWN0aW9uYWwiOiJjdXJzb3IifQ'
    })
    await buildFixture({ list })
    const viewer = await loginViewer()

    const response = await application!.app.inject({
      method: 'GET',
      url: '/api/v1/lifecycle/runtime-receipts?limit=2&cursor=YWJjZA',
      cookies: { dyson_session: viewer }
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(list).toHaveBeenCalledWith({ limit: 2, cursor: 'YWJjZA' })
    const payload = response.json()
    expect(payload).toEqual({
      data: [publicReceipt()],
      page: { nextCursor: 'eyJmaWN0aW9uYWwiOiJjdXJzb3IifQ' }
    })
    expect(Object.keys(payload.data[0])).toEqual(publicReceiptPropertyNames)
    expect(payload.data[0]).not.toHaveProperty('projectRootSha256')
    expect(payload.data[0]).not.toHaveProperty('dataRootIdentity')
    expect(response.body).not.toContain('"projectRootSha256":')
    expect(response.body).not.toContain('"dataRootIdentity":')
    expect(response.body).not.toMatch(/(?:[A-Z]:\\|\\\\|fixture|rawError|logText)/i)
  })

  it('rejects unauthenticated and invalid queries before invoking the source', async () => {
    const list = vi.fn<GameRuntimeReceiptSource['list']>().mockResolvedValue({ items: [], nextCursor: null })
    await buildFixture({ list })

    const unauthenticated = await application!.app.inject({
      method: 'GET', url: '/api/v1/lifecycle/runtime-receipts'
    })
    expect(unauthenticated.statusCode).toBe(401)

    const viewer = await loginViewer()
    for (const url of [
      '/api/v1/lifecycle/runtime-receipts?limit=0',
      '/api/v1/lifecycle/runtime-receipts?limit=51',
      '/api/v1/lifecycle/runtime-receipts?unknown=true'
    ]) {
      const response = await application!.app.inject({
        method: 'GET', url, cookies: { dyson_session: viewer }
      })
      expect(response.statusCode).toBe(400)
      expect(response.json().error.code).toBe('INVALID_GAME_RUNTIME_RECEIPT_QUERY')
    }
    expect(list).not.toHaveBeenCalled()
  })

  it('maps a private data-root identity mismatch to the fixed 503 response', async () => {
    const { dataRoot, projectRoot } = await buildFixture()
    const attemptId = '00000000-0000-0000-0000-000000000001'
    const receiptRoot = path.join(dataRoot, 'state', 'game-runtime-receipts')
    await mkdir(receiptRoot, { recursive: true })
    const wrongDataRootIdentity = 'f'.repeat(64)
    const persistedReceipt = {
      protocol: GAME_RUNTIME_RECEIPT_PROTOCOL,
      schemaVersion: 1,
      attemptId,
      bindingId: '10000000-0000-0000-0000-000000000001',
      version: '1.2.3',
      outcome: 'clean-exit',
      errorCode: null,
      restartExpected: false,
      startedAt: '2026-09-01T00:00:00.0000000+00:00',
      publishedAt: '2026-09-01T00:00:01.0000000+00:00',
      completedAt: '2026-09-01T00:00:02.0000000+00:00',
      projectRootSha256: pathIdentity(projectRoot),
      dataRootIdentity: wrongDataRootIdentity
    }
    await writeFile(
      path.join(receiptRoot, `${attemptId}.json`),
      JSON.stringify(persistedReceipt),
      'utf8'
    )
    const viewer = await loginViewer()

    const response = await application!.app.inject({
      method: 'GET',
      url: '/api/v1/lifecycle/runtime-receipts',
      cookies: { dyson_session: viewer }
    })

    expect(response.statusCode).toBe(503)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toEqual({
      error: { code: 'GAME_RUNTIME_RECEIPTS_UNAVAILABLE', message: '游戏运行回执暂不可用' }
    })
    expect(response.body).not.toContain(wrongDataRootIdentity)
    expect(response.body).not.toContain(pathIdentity(projectRoot))
  })

  it('maps every source failure to one fixed response without reflecting details', async () => {
    const list = vi.fn<GameRuntimeReceiptSource['list']>()
      .mockRejectedValue(new Error('C:\\private\\server.log: raw failure text'))
    await buildFixture({ list })
    const viewer = await loginViewer()

    const response = await application!.app.inject({
      method: 'GET',
      url: '/api/v1/lifecycle/runtime-receipts',
      cookies: { dyson_session: viewer }
    })

    expect(response.statusCode).toBe(503)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toEqual({
      error: { code: 'GAME_RUNTIME_RECEIPTS_UNAVAILABLE', message: '游戏运行回执暂不可用' }
    })
    expect(response.body).not.toMatch(/private|server\.log|raw failure/i)
  })
})

async function buildFixture(source?: GameRuntimeReceiptSource): Promise<{ dataRoot: string, projectRoot: string }> {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'dyson-runtime-route-'))
  const dataRoot = path.join(fixtureRoot, 'data')
  const projectRoot = path.join(fixtureRoot, 'project')
  await Promise.all([mkdir(dataRoot), mkdir(projectRoot)])
  application = await buildApplication(loadConfig({
    NODE_ENV: 'test',
    DYSON_PROVIDER: 'demo',
    DYSON_DATA_DIR: dataRoot,
    DYSON_PROJECT_ROOT: projectRoot,
    DYSON_PUBLIC_ORIGIN: origin,
    DYSON_DEV_ADMIN_PASSWORD: 'fictional-runtime-admin-password',
    DYSON_VIEWER_PASSWORD_HASH: viewerPasswordHash
  }), source === undefined ? {} : { gameRuntimeReceiptSource: source })
  return { dataRoot, projectRoot }
}

async function loginViewer(): Promise<string> {
  const response = await application!.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin },
    payload: { role: 'viewer', password: viewerPassword }
  })
  expect(response.statusCode).toBe(200)
  expect(response.json().user.permissions).toContain('lifecycle.read')
  return response.cookies[0]!.value
}

function publicReceipt(): PublicGameRuntimeReceipt {
  const publicCore: Omit<PublicGameRuntimeReceipt, 'receiptSha256'> = {
    protocol: GAME_RUNTIME_RECEIPT_PROTOCOL,
    schemaVersion: 1,
    attemptId: '00000000-0000-0000-0000-000000000001',
    bindingId: '10000000-0000-0000-0000-000000000001',
    version: '1.2.3',
    outcome: 'clean-exit',
    errorCode: null,
    restartExpected: false,
    startedAt: '2026-09-01T00:00:00.0000000+00:00',
    publishedAt: '2026-09-01T00:00:01.0000000+00:00',
    completedAt: '2026-09-01T00:00:02.0000000+00:00',
    projectRootIdentityVerified: true,
    dataRootIdentityVerified: true
  }
  return {
    ...publicCore,
    receiptSha256: sha256(Buffer.from(
      GAME_RUNTIME_PUBLIC_RECEIPT_DIGEST_DOMAIN + JSON.stringify(publicCore),
      'utf8'
    ))
  }
}

function pathIdentity(root: string): string {
  return sha256(Buffer.from(path.resolve(root).toUpperCase(), 'utf8'))
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

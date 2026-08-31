import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApplication, type BuiltApplication } from './app.js'
import { loadConfig } from './config.js'
import type { BackupRetentionRoutesController } from './saves/retention-routes.js'

let application: BuiltApplication | null = null
const temporaryRoots: string[] = []

afterEach(async () => {
  await application?.close()
  application = null
  await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })))
})

describe('application backup-retention wiring', () => {
  it('registers an injected controller behind session and same-origin boundaries', async () => {
    const controller = createController()
    application = await buildApplication(testConfig(), { backupRetentionController: controller })

    const unauthenticated = await application.app.inject({
      method: 'GET', url: '/api/v1/backups/retention/annotations'
    })
    expect(unauthenticated.statusCode).toBe(401)
    expect(controller.annotations).not.toHaveBeenCalled()

    const cookie = await login()
    const read = await application.app.inject({
      method: 'GET', url: '/api/v1/backups/retention/annotations',
      cookies: { dyson_session: cookie }
    })
    expect(read.statusCode).toBe(200)
    expect(read.json()).toEqual({ data: [] })

    const rejectedOrigin = await application.app.inject({
      method: 'POST', url: '/api/v1/backups/retention/execute',
      cookies: { dyson_session: cookie }, payload: { requestId: 'opaque' }
    })
    expect(rejectedOrigin.statusCode).toBe(403)
    expect(controller.execute).not.toHaveBeenCalled()

    const acceptedOrigin = await application.app.inject({
      method: 'POST', url: '/api/v1/backups/retention/execute',
      headers: { origin: publicOrigin }, cookies: { dyson_session: cookie },
      payload: { requestId: 'opaque' }
    })
    expect(acceptedOrigin.statusCode).toBe(423)
    expect(controller.execute).toHaveBeenCalledWith({ requestId: 'opaque' })
  })

  it('constructs the fixed-root Windows controller with mutations default-closed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dyson-retention-app-'))
    temporaryRoots.push(root)
    const projectRoot = path.join(root, 'project')
    await mkdir(path.join(projectRoot, 'backups', 'saves'), { recursive: true })

    application = await buildApplication(loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'windows', DYSON_PROJECT_ROOT: projectRoot,
      DYSON_DATA_DIR: path.join(root, 'data'), DYSON_PUBLIC_ORIGIN: publicOrigin,
      DYSON_DEV_ADMIN_PASSWORD: developmentPassword
    }))
    const cookie = await login()

    const annotations = await application.app.inject({
      method: 'GET', url: '/api/v1/backups/retention/annotations',
      cookies: { dyson_session: cookie }
    })
    expect(annotations.statusCode).toBe(200)
    expect(annotations.json()).toEqual({ data: [] })

    const preview = await application.app.inject({
      method: 'POST', url: '/api/v1/backups/retention/preview',
      headers: { origin: publicOrigin }, cookies: { dyson_session: cookie },
      payload: {
        referenceTime: '2026-08-31T08:00:00.000Z',
        policy: {
          keepLastHealthy: 3, keepDailyDays: 14, keepWeeklyWeeks: 8,
          minimumHealthy: 2, allowUnhealthyDeletion: false
        }
      }
    })
    expect(preview.statusCode).toBe(200)
    expect(preview.json()).toMatchObject({
      data: { schemaVersion: 1, mode: 'dry-run', plan: { delete: [] } },
      meta: { executionEnabled: false }
    })

    const execute = await application.app.inject({
      method: 'POST', url: '/api/v1/backups/retention/execute',
      headers: { origin: publicOrigin }, cookies: { dyson_session: cookie },
      payload: {
        requestId: '11111111-1111-4111-8111-111111111111',
        referenceTime: '2026-08-31T08:00:00.000Z',
        policy: {
          keepLastHealthy: 3, keepDailyDays: 14, keepWeeklyWeeks: 8,
          minimumHealthy: 2, allowUnhealthyDeletion: false
        },
        previewDigest: 'a'.repeat(64),
        confirmation: 'RETIRE_BACKUPS'
      }
    })
    expect(execute.statusCode).toBe(423)
    expect(execute.json()).toEqual({
      error: {
        code: 'SAVE_RETENTION_MUTATIONS_DISABLED',
        message: '备份保留变更门禁未开启'
      }
    })
  })
})

function createController(): BackupRetentionRoutesController {
  return {
    annotations: vi.fn(async () => ({ statusCode: 200, body: { data: [] } })),
    annotate: vi.fn(async () => ({ statusCode: 423, body: { error: { code: 'DISABLED', message: 'disabled' } } })),
    preview: vi.fn(async () => ({ statusCode: 200, body: { data: {} } })),
    execute: vi.fn(async () => ({ statusCode: 423, body: { error: { code: 'DISABLED', message: 'disabled' } } })),
    restore: vi.fn(async () => ({ statusCode: 423, body: { error: { code: 'DISABLED', message: 'disabled' } } })),
    previewPurge: vi.fn(async () => ({ statusCode: 200, body: { data: {} } })),
    purge: vi.fn(async () => ({ statusCode: 423, body: { error: { code: 'DISABLED', message: 'disabled' } } }))
  }
}

async function login(): Promise<string> {
  const response = await application!.app.inject({
    method: 'POST', url: '/api/v1/auth/login', headers: { origin: publicOrigin },
    payload: { role: 'administrator', password: developmentPassword }
  })
  expect(response.statusCode).toBe(200)
  const cookie = response.cookies[0]?.value
  expect(cookie).toBeTruthy()
  return cookie!
}

function testConfig() {
  return loadConfig({
    NODE_ENV: 'test', DYSON_PROVIDER: 'demo', DYSON_PUBLIC_ORIGIN: publicOrigin,
    DYSON_DEV_ADMIN_PASSWORD: developmentPassword
  })
}

const publicOrigin = 'http://127.0.0.1:13010'
const developmentPassword = 'fictional-development-password'

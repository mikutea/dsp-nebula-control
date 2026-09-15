import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApplication, type ApplicationDependencies, type BuiltApplication } from './app.js'
import { loadConfig } from './config.js'
import { DemoProvider } from './providers/demo.js'
import { hashPassword } from './security/password.js'

const origin = 'http://127.0.0.1:13010'
const administratorPassword = 'fictional-administrator-password'
let application: BuiltApplication | null = null

afterEach(async () => {
  if (application) await application.close()
  application = null
})

function transferServiceFixture() {
  const archive = Buffer.from('DYSONPAIRARCHV1\nfictional-pair\nDYSONPAIREND1\n')
  const archiveSha256 = createHash('sha256').update(archive).digest('hex')
  return {
    archive,
    archiveSha256,
    service: {
      exportBackup: vi.fn(async (input: unknown) => ({
        format: 'dyson-control-save-transfer-receipt' as const,
        schemaVersion: 1 as const,
        operation: 'export' as const,
        requestId: (input as { requestId: string }).requestId,
        backupId: (input as { backupId: string }).backupId,
        archiveId: `export-${(input as { requestId: string }).requestId}`,
        saveName: 'Fictional_Save',
        archiveBytes: archive.length,
        archiveSha256,
        completedAt: '2026-08-30T00:00:00.000Z',
        restoreExecuted: false as const,
        reused: false
      })),
      openExport: vi.fn(async (input: unknown) => ({
        receipt: {
          format: 'dyson-control-save-transfer-receipt' as const,
          schemaVersion: 1 as const,
          operation: 'export' as const,
          requestId: (input as { requestId: string }).requestId,
          backupId: 'tx-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          archiveId: `export-${(input as { requestId: string }).requestId}`,
          saveName: 'Fictional_Save',
          archiveBytes: archive.length,
          archiveSha256,
          completedAt: '2026-08-30T00:00:00.000Z',
          restoreExecuted: false as const,
          reused: true
        },
        source: (async function* () { yield archive })()
      })),
      importArchive: vi.fn(async (input: unknown, source: AsyncIterable<Uint8Array>) => {
        const chunks: Buffer[] = []
        for await (const chunk of source) chunks.push(Buffer.from(chunk))
        const bytes = Buffer.concat(chunks)
        return {
          format: 'dyson-control-save-transfer-receipt' as const,
          schemaVersion: 1 as const,
          operation: 'import' as const,
          requestId: (input as { requestId: string }).requestId,
          inboxId: `import-${(input as { requestId: string }).requestId}`,
          saveName: 'Fictional_Save',
          archiveBytes: bytes.length,
          archiveSha256: createHash('sha256').update(bytes).digest('hex'),
          dsvBytes: 10,
          serverBytes: 12,
          completedAt: '2026-08-30T00:00:00.000Z',
          restoreExecuted: false as const,
          reused: false
        }
      })
    } as NonNullable<ApplicationDependencies['savePairTransferService']>
  }
}

async function buildFixture(
  service: NonNullable<ApplicationDependencies['savePairTransferService']>,
  viewerPasswordHash?: string
) {
  application = await buildApplication(loadConfig({
    NODE_ENV: 'test',
    DYSON_PROVIDER: 'windows',
    DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
    DYSON_PUBLIC_ORIGIN: origin,
    DYSON_DEV_ADMIN_PASSWORD: administratorPassword,
    DYSON_SAVE_TRANSFER_ENABLED: 'true',
    DYSON_SAVE_TRANSFER_ROOT: 'C:\\Fictional\\Dyson\\transfers',
    ...(viewerPasswordHash ? { DYSON_VIEWER_PASSWORD_HASH: viewerPasswordHash } : {})
  }), { statusProvider: new DemoProvider(), savePairTransferService: service })
}

async function login(role: 'viewer' | 'administrator', password: string): Promise<string> {
  const response = await application!.app.inject({
    method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { role, password }
  })
  expect(response.statusCode).toBe(200)
  return response.cookies[0]!.value
}

describe('save-pair transfer routes', () => {
  it('prepares and streams an administrator-only verified export with fixed headers', async () => {
    const fixture = transferServiceFixture()
    await buildFixture(fixture.service)
    const cookie = await login('administrator', administratorPassword)
    const requestId = '11111111-2222-4333-8444-555555555555'
    const backupId = 'tx-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const prepared = await application!.app.inject({
      method: 'POST', url: '/api/v1/saves/transfers/exports', headers: { origin },
      cookies: { dyson_session: cookie }, payload: { requestId, backupId }
    })
    expect(prepared.statusCode).toBe(201)
    expect(prepared.json().data).toMatchObject({ requestId, backupId, restoreExecuted: false })

    const downloaded = await application!.app.inject({
      method: 'GET', url: `/api/v1/saves/transfers/exports/${requestId}`,
      cookies: { dyson_session: cookie }
    })
    expect(downloaded.statusCode).toBe(200)
    expect(downloaded.headers['content-type']).toContain('application/vnd.dyson-control.save-pair')
    expect(downloaded.headers['content-disposition']).toBe(
      `attachment; filename="dyson-save-${requestId}.dspair"`
    )
    expect(downloaded.headers['x-dyson-content-sha256']).toBe(fixture.archiveSha256)
    expect(downloaded.rawPayload).toEqual(fixture.archive)
  })

  it('streams an upload into quarantine metadata and rejects incomplete headers before the service call', async () => {
    const fixture = transferServiceFixture()
    await buildFixture(fixture.service)
    const cookie = await login('administrator', administratorPassword)
    const requestId = '11111111-2222-4333-8444-666666666666'
    const sha256 = createHash('sha256').update(fixture.archive).digest('hex')
    const imported = await application!.app.inject({
      method: 'POST', url: `/api/v1/saves/transfers/imports/${requestId}`,
      headers: {
        origin,
        'content-type': 'application/vnd.dyson-control.save-pair',
        'content-length': String(fixture.archive.length),
        'x-dyson-content-sha256': sha256
      },
      cookies: { dyson_session: cookie },
      payload: fixture.archive
    })
    expect(imported.statusCode).toBe(201)
    expect(imported.json().data).toMatchObject({
      requestId, archiveBytes: fixture.archive.length, archiveSha256: sha256, restoreExecuted: false
    })

    const invalid = await application!.app.inject({
      method: 'POST', url: `/api/v1/saves/transfers/imports/${requestId}`,
      headers: {
        origin,
        'content-type': 'application/vnd.dyson-control.save-pair',
        'content-length': String(fixture.archive.length)
      },
      cookies: { dyson_session: cookie },
      payload: fixture.archive
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().error.code).toBe('SAVE_TRANSFER_REQUEST_INVALID')
    expect(fixture.service.importArchive).toHaveBeenCalledTimes(1)
  })

  it('denies raw save export and import to Viewer before invoking the transfer service', async () => {
    const viewerPassword = 'fictional-viewer-password'
    const fixture = transferServiceFixture()
    await buildFixture(fixture.service, await hashPassword(viewerPassword))
    const cookie = await login('viewer', viewerPassword)
    const response = await application!.app.inject({
      method: 'POST', url: '/api/v1/saves/transfers/exports', headers: { origin },
      cookies: { dyson_session: cookie }, payload: {
        requestId: '11111111-2222-4333-8444-777777777777',
        backupId: 'tx-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
      }
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('AUTHORIZATION_DENIED')
    expect(fixture.service.exportBackup).not.toHaveBeenCalled()
  })
})

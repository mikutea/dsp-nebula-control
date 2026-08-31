import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApplication, type BuiltApplication } from './app.js'
import { loadConfig } from './config.js'

let application: BuiltApplication | null = null
const temporaryRoots: string[] = []

afterEach(async () => {
  if (application) await application.close()
  application = null
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('managed workspace read APIs', () => {
  it('catalogs paired saves and verified backups without returning filesystem locations', async () => {
    const fixture = await createWorkspaceFixture()
    application = await buildApplication(testConfig(), { workspacePaths: fixture })
    const cookie = await login(application)

    const saves = await application.app.inject({
      method: 'GET', url: '/api/v1/saves?pageSize=10', cookies: { dyson_session: cookie }
    })
    expect(saves.statusCode).toBe(200)
    expect(saves.json().data).toMatchObject({
      kind: 'saves', items: [{ name: '_lastexit_', health: 'healthy', issues: [] }]
    })
    expect(saves.body).not.toContain(fixture.saveRoot)

    const backups = await application.app.inject({
      method: 'GET', url: '/api/v1/backups?pageSize=10', cookies: { dyson_session: cookie }
    })
    expect(backups.statusCode).toBe(200)
    expect(backups.json().data.items[0]).toMatchObject({
      backupId: fixture.backupId, saveName: '_lastexit_', health: 'healthy', manifestValid: true
    })
    expect(backups.body).not.toContain(fixture.backupRoot)
    expect(backups.body).not.toMatch(/[a-f0-9]{64}/)

    const verified = await application.app.inject({
      method: 'GET', url: `/api/v1/backups/${fixture.backupId}/verify`,
      cookies: { dyson_session: cookie }
    })
    expect(verified.statusCode).toBe(200)
    expect(verified.json().data).toMatchObject({ health: 'healthy', pairPresent: true })

    const invalid = await application.app.inject({
      method: 'GET', url: '/api/v1/backups/..%2Foutside/verify', cookies: { dyson_session: cookie }
    })
    expect(invalid.statusCode).toBe(400)
    expect((await application.app.inject({
      method: 'GET', url: '/api/v1/saves?pageSize=999', cookies: { dyson_session: cookie }
    })).statusCode).toBe(400)
  })

  it('returns typed configuration and a redacted no-write preview', async () => {
    const fixture = await createWorkspaceFixture()
    application = await buildApplication(testConfig(), { workspacePaths: fixture })
    const cookie = await login(application)

    const configuration = await application.app.inject({
      method: 'GET', url: '/api/v1/configuration', cookies: { dyson_session: cookie }
    })
    expect(configuration.statusCode).toBe(200)
    const snapshot = configuration.json().data
    expect(snapshot.entries.find((entry: { id: string }) => entry.id === 'nebula.server-password')).toMatchObject({
      value: { configured: true }, source: 'file'
    })
    expect(configuration.body).not.toContain('fictional-existing-game-password')

    const preview = await application.app.inject({
      method: 'POST', url: '/api/v1/configuration/preview',
      headers: { origin: 'http://127.0.0.1:13010' }, cookies: { dyson_session: cookie },
      payload: {
        expectedRevision: snapshot.revision,
        changes: [
          { id: 'nebula.server-password', value: 'fictional-replacement-password' },
          { id: 'galaxy.resource-multiplier', value: 8 }
        ]
      }
    })
    expect(preview.statusCode).toBe(200)
    expect(preview.json().data).toMatchObject({
      mode: 'dry-run', restartRequired: true, newGameOnlyChanged: true,
      diff: [
        { id: 'nebula.server-password', changed: true, before: { configured: true }, after: { configured: true } },
        { id: 'galaxy.resource-multiplier', before: 1, after: 8, changed: true }
      ]
    })
    expect(preview.body).not.toContain('fictional-replacement-password')
    expect(preview.body).not.toContain('files')
    expect(await readFile(path.join(fixture.configRoot, 'nebula.cfg'), 'utf8'))
      .toContain('ServerPassword = fictional-existing-game-password')

    const stale = await application.app.inject({
      method: 'POST', url: '/api/v1/configuration/preview',
      headers: { origin: 'http://127.0.0.1:13010' }, cookies: { dyson_session: cookie },
      payload: {
        expectedRevision: '0'.repeat(64),
        changes: [{ id: 'galaxy.star-count', value: 64 }]
      }
    })
    expect(stale.statusCode).toBe(409)

    const unknown = await application.app.inject({
      method: 'POST', url: '/api/v1/configuration/preview',
      headers: { origin: 'http://127.0.0.1:13010' }, cookies: { dyson_session: cookie },
      payload: {
        expectedRevision: snapshot.revision,
        changes: [{ id: 'galaxy.star-count', value: 64 }],
        command: 'untrusted-input'
      }
    })
    expect(unknown.statusCode).toBe(400)

    const missingConfirmation = await application.app.inject({
      method: 'POST', url: '/api/v1/configuration/apply',
      headers: { origin: 'http://127.0.0.1:13010' }, cookies: { dyson_session: cookie },
      payload: {
        expectedRevision: snapshot.revision,
        changes: [{ id: 'galaxy.resource-multiplier', value: 8 }]
      }
    })
    expect(missingConfirmation.statusCode).toBe(400)

    const applied = await application.app.inject({
      method: 'POST', url: '/api/v1/configuration/apply',
      headers: { origin: 'http://127.0.0.1:13010' }, cookies: { dyson_session: cookie },
      payload: {
        expectedRevision: snapshot.revision, confirmation: 'APPLY_CONFIG',
        changes: [
          { id: 'nebula.server-password', value: 'fictional-replacement-password' },
          { id: 'galaxy.resource-multiplier', value: 8 }
        ]
      }
    })
    expect(applied.statusCode).toBe(200)
    expect(applied.json().data).toMatchObject({
      status: 'applied', restartRequired: true, newGameOnlyChanged: true,
      changedSettingIds: ['nebula.server-password', 'galaxy.resource-multiplier']
    })
    expect(applied.body).not.toContain('fictional-replacement-password')
    expect(applied.body).not.toContain(fixture.configRoot)
    expect(await readFile(path.join(fixture.configRoot, 'nebula.cfg'), 'utf8'))
      .toContain('ServerPassword = fictional-replacement-password')
    expect(await readFile(path.join(fixture.configRoot, 'nebulaGameDescSettings.cfg'), 'utf8'))
      .toContain('resourceMultiplier = 8')

    const staleApply = await application.app.inject({
      method: 'POST', url: '/api/v1/configuration/apply',
      headers: { origin: 'http://127.0.0.1:13010' }, cookies: { dyson_session: cookie },
      payload: {
        expectedRevision: snapshot.revision, confirmation: 'APPLY_CONFIG',
        changes: [{ id: 'galaxy.star-count', value: 64 }]
      }
    })
    expect(staleApply.statusCode).toBe(409)
  })

  it('streams and downloads only redacted structured console records', async () => {
    const fixture = await createWorkspaceFixture()
    application = await buildApplication(testConfig(), { workspacePaths: fixture })
    const cookie = await login(application)
    const headers = { origin: 'http://127.0.0.1:13010' }

    const page = await application.app.inject({
      method: 'POST', url: '/api/v1/console/logs/query', headers,
      cookies: { dyson_session: cookie },
      payload: { start: 'beginning', filters: { levels: ['error'] }, limit: 20 }
    })
    expect(page.statusCode).toBe(200)
    expect(page.json().data).toMatchObject({
      kind: 'bepinex-structured-log-page', redactionVersion: 1,
      entries: [{ level: 'error', source: 'NebulaNetwork' }]
    })
    expect(page.body).not.toContain('FictionalPlayer')
    expect(page.body).not.toContain('203.0.113.42')
    expect(page.body).not.toContain('fictional-console-token')
    expect(page.body).toContain('[player]')
    expect(page.body).toContain('[endpoint]')
    expect(page.body).toContain('[credential]')

    const preview = await application.app.inject({
      method: 'POST', url: '/api/v1/console/logs/download/preview', headers,
      cookies: { dyson_session: cookie }, payload: { format: 'json', start: 'beginning' }
    })
    expect(preview.statusCode).toBe(200)
    expect(preview.json().data).toMatchObject({
      mode: 'dry-run', kind: 'bepinex-structured-log-download-plan', rawHostOutputIncluded: false
    })

    const download = await application.app.inject({
      method: 'POST', url: '/api/v1/console/logs/download', headers,
      cookies: { dyson_session: cookie }, payload: { format: 'json', start: 'beginning' }
    })
    expect(download.statusCode).toBe(200)
    expect(download.headers['content-disposition']).toMatch(/^attachment; filename="dyson-console-/)
    expect(download.headers['x-dyson-console-entries']).toBe('2')
    expect(download.body).not.toContain('FictionalPlayer')
    expect(download.body).not.toContain('203.0.113.42')

    const arbitraryPath = await application.app.inject({
      method: 'POST', url: '/api/v1/console/logs/query', headers,
      cookies: { dyson_session: cookie }, payload: { path: 'C:\\untrusted.log' }
    })
    expect(arbitraryPath.statusCode).toBe(400)
    expect(arbitraryPath.body).not.toContain('untrusted.log')
  })
})

interface WorkspaceFixture {
  saveRoot: string
  backupRoot: string
  configRoot: string
  serverRoot: string
  backupId: string
}

async function createWorkspaceFixture(): Promise<WorkspaceFixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'dyson-workspace-routes-'))
  temporaryRoots.push(root)
  const saveRoot = path.join(root, 'userdata', 'Save')
  const backupRoot = path.join(root, 'backups', 'saves')
  const serverRoot = path.join(root, 'server')
  const configRoot = path.join(serverRoot, 'BepInEx', 'config')
  const requestId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const backupId = `tx-${requestId}`
  const backupDirectory = path.join(backupRoot, backupId)
  await Promise.all([
    mkdir(saveRoot, { recursive: true }), mkdir(backupDirectory, { recursive: true }),
    mkdir(configRoot, { recursive: true })
  ])
  const dsv = Buffer.from('fictional-save-data')
  const server = Buffer.from('fictional-nebula-sidecar')
  await Promise.all([
    writeFile(path.join(saveRoot, '_lastexit_.dsv'), dsv),
    writeFile(path.join(saveRoot, '_lastexit_.server'), server),
    writeFile(path.join(backupDirectory, '_lastexit_.dsv'), dsv),
    writeFile(path.join(backupDirectory, '_lastexit_.server'), server),
    writeFile(path.join(configRoot, 'nebula.cfg'), [
      '[Nebula - Settings]', 'AutoPauseEnabled = true',
      'ServerPassword = fictional-existing-game-password', 'HostPort = 8469', ''
    ].join('\r\n')),
    writeFile(path.join(configRoot, 'nebulaGameDescSettings.cfg'), [
      '[Basic]', 'galaxySeed = 12345678', 'starCount = 64', 'resourceMultiplier = 1', ''
    ].join('\r\n')),
    writeFile(path.join(configRoot, 'BepInEx.cfg'), '[Logging.Console]\r\nEnabled = true\r\n'),
    writeFile(path.join(configRoot, 'io.github.mikutea.dyson-control-bridge.cfg'), '[Bridge]\r\nEnabled = false\r\n'),
    writeFile(path.join(serverRoot, 'BepInEx', 'LogOutput.log'), [
      '[Info : BepInEx] Fictional runtime started',
      '[2026-08-30T04:05:06Z] [Error: NebulaNetwork] Player FictionalPlayer connected from 203.0.113.42 token=fictional-console-token',
      ''
    ].join('\r\n'))
  ])
  await writeFile(path.join(backupDirectory, 'manifest.json'), JSON.stringify({
    protocol: 'DYSON_CONTROL_PROTECTION_V1', schemaVersion: 1, requestId,
    createdAt: '2026-08-30T09:00:00.000Z', saveName: '_lastexit_',
    files: [
      { name: '_lastexit_.dsv', bytes: dsv.byteLength, sha256: sha256(dsv) },
      { name: '_lastexit_.server', bytes: server.byteLength, sha256: sha256(server) }
    ]
  }), 'utf8')
  return { saveRoot, backupRoot, configRoot, serverRoot, backupId }
}

function testConfig() {
  return loadConfig({
    NODE_ENV: 'test', DYSON_PROVIDER: 'demo',
    DYSON_DEV_ADMIN_PASSWORD: 'test-password-long-enough',
    DYSON_PUBLIC_ORIGIN: 'http://127.0.0.1:13010',
    DYSON_CONSOLE_CURSOR_SECRET: 'console-fixture-secret-at-least-32-bytes'
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

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

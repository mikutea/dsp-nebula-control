import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApplication, type ApplicationDependencies, type BuiltApplication } from './app.js'
import { loadConfig } from './config.js'
import type {
  HostMutationOperationCoordinator,
  HostMutationOperationRequest,
  HostMutationOperationOutcome,
  HostMutationOperationScope
} from './host-mutation/operation-coordinator.js'
import { DemoProvider } from './providers/demo.js'
import { hashPassword } from './security/password.js'

const origin = 'http://127.0.0.1:13010'
const administratorPassword = 'fictional-promotion-administrator-password'
const requestId = '11111111-2222-4333-8444-555555555555'
const importRequestId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
let application: BuiltApplication | null = null

afterEach(async () => {
  await application?.close()
  application = null
})

describe('quarantine save promotion routes', () => {
  it('keeps preview read-only and executes only after exact administrator confirmation', async () => {
    const fixture = promotionFixture()
    await buildFixture(fixture.service, true)
    const cookie = await login('administrator', administratorPassword)

    const preview = await inject(cookie, '/api/v1/saves/transfers/promotions/preview', {
      requestId, importRequestId
    })
    expect(preview.statusCode).toBe(200)
    expect(preview.json().data).toMatchObject({
      mode: 'dry-run', requestId, importRequestId, allowed: true,
      requiredConfirmation: 'PROMOTE_IMPORTED_SAVE_PAIR', executionEnabled: true,
      effects: { quarantinePreserved: true, liveSaveChanged: false, restoreExecuted: false }
    })
    expect(fixture.service.promoteImport).not.toHaveBeenCalled()

    const invalid = await inject(cookie, '/api/v1/saves/transfers/promotions/execute', {
      requestId, importRequestId, confirmation: 'PROMOTE'
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().error.code).toBe('SAVE_TRANSFER_REQUEST_INVALID')
    expect(fixture.service.promoteImport).not.toHaveBeenCalled()

    const executed = await inject(cookie, '/api/v1/saves/transfers/promotions/execute', {
      requestId, importRequestId, confirmation: 'PROMOTE_IMPORTED_SAVE_PAIR'
    })
    expect(executed.statusCode).toBe(201)
    expect(executed.json().data).toMatchObject({
      operation: 'promote-import', requestId, importRequestId,
      backupId: `tx-${requestId}`, restoreExecuted: false, reused: false
    })
    expect(fixture.service.promoteImport).toHaveBeenCalledTimes(1)
  })

  it('allows a disabled-gate preview but returns 423 before executing', async () => {
    const fixture = promotionFixture()
    await buildFixture(fixture.service, false)
    const cookie = await login('administrator', administratorPassword)
    const preview = await inject(cookie, '/api/v1/saves/transfers/promotions/preview', {
      requestId, importRequestId
    })
    expect(preview.statusCode).toBe(200)
    expect(preview.json().data.executionEnabled).toBe(false)

    const executed = await inject(cookie, '/api/v1/saves/transfers/promotions/execute', {
      requestId, importRequestId, confirmation: 'PROMOTE_IMPORTED_SAVE_PAIR'
    })
    expect(executed.statusCode).toBe(423)
    expect(executed.json().error.code).toBe('SAVE_TRANSFER_DISABLED')
    expect(fixture.service.promoteImport).not.toHaveBeenCalled()
  })

  it('denies Viewer before either promotion capability is invoked', async () => {
    const viewerPassword = 'fictional-promotion-viewer-password'
    const fixture = promotionFixture()
    await buildFixture(fixture.service, true, await hashPassword(viewerPassword))
    const cookie = await login('viewer', viewerPassword)
    for (const endpoint of [
      '/api/v1/saves/transfers/promotions/preview',
      '/api/v1/saves/transfers/promotions/execute'
    ]) {
      const response = await inject(cookie, endpoint, {
        requestId, importRequestId, confirmation: 'PROMOTE_IMPORTED_SAVE_PAIR'
      })
      expect(response.statusCode).toBe(403)
      expect(response.json().error.code).toBe('AUTHORIZATION_DENIED')
    }
    expect(fixture.service.previewImportPromotion).not.toHaveBeenCalled()
    expect(fixture.service.promoteImport).not.toHaveBeenCalled()
  })
})

function promotionFixture() {
  const service = {
    previewImportPromotion: vi.fn(async (input: unknown) => ({
      format: 'dyson-control-save-promotion-plan' as const,
      schemaVersion: 1 as const,
      mode: 'dry-run' as const,
      requestId: (input as { requestId: string }).requestId,
      importRequestId: (input as { importRequestId: string }).importRequestId,
      inboxId: `import-${(input as { importRequestId: string }).importRequestId}`,
      backupId: `tx-${(input as { requestId: string }).requestId}`,
      saveName: 'Fictional_Save',
      sourceArchiveSha256: 'a'.repeat(64),
      dsvBytes: 11,
      serverBytes: 13,
      requiredBytes: 16_408,
      availableBytes: 1_000_000,
      allowed: true,
      blockers: [],
      reused: false,
      requiredConfirmation: 'PROMOTE_IMPORTED_SAVE_PAIR' as const,
      effects: {
        quarantinePreserved: true as const,
        verifiedBackupCreated: true,
        liveSaveChanged: false as const,
        restoreExecuted: false as const
      }
    })),
    promoteImport: vi.fn(async (input: unknown) => ({
      format: 'dyson-control-save-promotion-receipt' as const,
      schemaVersion: 1 as const,
      operation: 'promote-import' as const,
      requestId: (input as { requestId: string }).requestId,
      importRequestId: (input as { importRequestId: string }).importRequestId,
      inboxId: `import-${(input as { importRequestId: string }).importRequestId}`,
      backupId: `tx-${(input as { requestId: string }).requestId}`,
      saveName: 'Fictional_Save',
      sourceArchiveSha256: 'a'.repeat(64),
      manifestSha256: 'b'.repeat(64),
      dsvBytes: 11,
      serverBytes: 13,
      completedAt: '2026-09-01T00:00:00.000Z',
      restoreExecuted: false as const,
      reused: false
    }))
  } as NonNullable<ApplicationDependencies['savePairPromotionService']>
  return { service }
}

async function buildFixture(
  service: NonNullable<ApplicationDependencies['savePairPromotionService']>,
  enabled: boolean,
  viewerPasswordHash?: string
) {
  application = await buildApplication(loadConfig({
    NODE_ENV: 'test',
    DYSON_PROVIDER: 'windows',
    DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
    DYSON_PUBLIC_ORIGIN: origin,
    DYSON_DEV_ADMIN_PASSWORD: administratorPassword,
    DYSON_SAVE_TRANSFER_ENABLED: enabled ? 'true' : 'false',
    DYSON_SAVE_TRANSFER_ROOT: 'C:\\Fictional\\Dyson\\transfers',
    ...(viewerPasswordHash ? { DYSON_VIEWER_PASSWORD_HASH: viewerPasswordHash } : {})
  }), {
    statusProvider: new DemoProvider(),
    savePairPromotionService: service,
    hostMutationCoordinator: passthroughCoordinator()
  })
}

function passthroughCoordinator(): HostMutationOperationCoordinator {
  return {
    async runExclusive<T>(
      _request: HostMutationOperationRequest,
      operation: (
        scope: HostMutationOperationScope
      ) => Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>
    ): Promise<T> {
      const outcome = await operation({
        signal: new AbortController().signal,
        assertActive: () => undefined,
        toPowerShellBorrowArguments: () => []
      }) as HostMutationOperationOutcome<T>
      if (outcome.kind === 'throw') throw outcome.error
      return outcome.value
    }
  }
}

async function login(role: 'viewer' | 'administrator', password: string): Promise<string> {
  const response = await application!.app.inject({
    method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { role, password }
  })
  expect(response.statusCode).toBe(200)
  return response.cookies[0]!.value
}

async function inject(cookie: string, url: string, payload: object) {
  return await application!.app.inject({
    method: 'POST', url, headers: { origin }, cookies: { dyson_session: cookie }, payload
  })
}

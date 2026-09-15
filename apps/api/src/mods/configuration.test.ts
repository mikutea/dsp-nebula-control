import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ManagedModConfigurationError,
  ManagedModConfigurationService
} from './configuration.js'
import type { HostMutationOperationCoordinator, HostMutationOperationOutcome, HostMutationOperationRequest, HostMutationOperationScope } from '../host-mutation/operation-coordinator.js'

const roots: string[] = []
const deploymentRevision = 'a'.repeat(64)
const requestId = '11111111-1111-4111-8111-111111111111'

afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))) })

describe('managed mod configuration service', () => {
  it('uses reviewed real package schemas, redacts secrets, previews a diff, and commits with a durable receipt', async () => {
    const fixture = await createFixture()
    expect(fixture.service.schemas().map((schema) => schema.id)).toEqual([
      'nebula-server-v0-9-22',
      'bepinex-core-v5-4-17',
      'nebula-compatibility-assist-v0-5-0',
      'bullet-time-v1-5-13',
      'error-analyzer-v1-3-3'
    ])
    expect(fixture.service.schemas()[0]?.fields).toEqual(expect.arrayContaining([
      { id: 'server-password', type: 'secret', secret: true, maximumLength: 128 },
      { id: 'host-port', type: 'integer', secret: false, minimum: 1, maximum: 65_535 },
      { id: 'sync-ups', type: 'boolean', secret: false }
    ]))
    const inspection = await fixture.service.inspect(inspectionRequest())
    expect(inspection.fields).toEqual(expect.arrayContaining([
      { id: 'host-port', type: 'integer', value: 8469 },
      { id: 'sync-ups', type: 'boolean', value: true },
      { id: 'server-password', type: 'secret', value: { configured: true } }
    ]))
    expect(JSON.stringify(inspection)).not.toContain('test-server-secret')

    const request = configurationRequest(inspection.configurationRevision)
    const preview = await fixture.service.preview(request)
    expect(preview).toMatchObject({ dryRun: true, operation: 'configure', stoppedStateRequiredForExecute: true })
    expect(preview.changes).toEqual(expect.arrayContaining([
      { id: 'host-port', before: 8469, after: 9443, changed: true },
      { id: 'server-password', before: { configured: true }, after: { configured: true }, changed: false }
    ]))
    expect(JSON.stringify(preview)).not.toContain('replacement-server-secret')

    const receipt = await fixture.service.execute(request)
    expect(receipt).toMatchObject({ status: 'applied', rollback: 'not-needed', protectionPointCreated: true })
    expect(fixture.coordinator.requests).toEqual([{ operation: 'mod-deployment-configure', requestId }])
    await expect(readFile(fixture.file, 'utf8')).resolves.toContain('HostPort = 9443')
    await expect(fixture.service.receipt(requestId)).resolves.toMatchObject({ requestId, reused: true })
    await expect(fixture.service.history({ pageSize: 1 })).resolves.toMatchObject({ page: { returned: 1, totalReceipts: 1 } })
  })

  it('fails closed for an undeclared schema, unknown fields, duplicate fields, revision drift, and a failed stop gate', async () => {
    const fixture = await createFixture()
    const inspection = await fixture.service.inspect(inspectionRequest())
    await expect(fixture.service.inspect({ ...inspectionRequest(), schemaId: 'unmanaged-plugin-v1' })).rejects.toMatchObject({ code: 'MOD_CONFIGURATION_SCHEMA_UNAVAILABLE' })
    await expect(fixture.service.preview({ ...configurationRequest(inspection.configurationRevision), changes: [{ id: 'unknown-field', value: true }] })).rejects.toMatchObject({ code: 'MOD_CONFIGURATION_FIELD_UNAVAILABLE' })
    await expect(fixture.service.preview({ ...configurationRequest(inspection.configurationRevision), changes: [{ id: 'sync-ups', value: false }, { id: 'sync-ups', value: true }] })).rejects.toMatchObject({ code: 'MOD_CONFIGURATION_DUPLICATE_FIELD' })
    await expect(fixture.service.preview(configurationRequest('b'.repeat(64)))).rejects.toMatchObject({ code: 'MOD_CONFIGURATION_REVISION_CONFLICT' })
    fixture.platform.nebula = '0.9.23.0'
    await expect(fixture.service.inspect(inspectionRequest())).rejects.toMatchObject({ code: 'MOD_CONFIGURATION_PACKAGE_UNAVAILABLE' })
    fixture.platform.nebula = '0.9.22.2'
    fixture.stopped.processStopped = false
    await expect(fixture.service.execute(configurationRequest(inspection.configurationRevision))).rejects.toBeInstanceOf(ManagedModConfigurationError)
    await expect(readFile(fixture.file, 'utf8')).resolves.toContain('HostPort = 8469')
  })

  it('requires an enabled exact ordinary-mod package for an ordinary-mod schema', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.configRoot, 'com.starfi5h.plugin.BulletTime.cfg'), '[Speed]\nRemoveGC = true\n', 'utf8')
    const input = {
      schemaId: 'bullet-time-v1-5-13',
      package: { dependencyId: 'starfi5h-BulletTime-1.5.13', version: '1.5.13' },
      expectedDeploymentRevision: deploymentRevision
    }
    await expect(fixture.service.inspect(input)).rejects.toMatchObject({ code: 'MOD_CONFIGURATION_PACKAGE_UNAVAILABLE' })
    fixture.deployment.packages.push({
      dependencyId: 'starfi5h-BulletTime-1.5.13',
      sourceId: 'thunderstore:starfi5h/BulletTime',
      version: '1.5.13',
      enabled: true,
      clientRequirement: 'required'
    })
    await expect(fixture.service.inspect(input)).resolves.toMatchObject({
      fields: expect.arrayContaining([{ id: 'remove-gc', type: 'boolean', value: true }])
    })
    fixture.deployment.packages[0]!.enabled = false
    await expect(fixture.service.inspect(input)).rejects.toMatchObject({ code: 'MOD_CONFIGURATION_PACKAGE_UNAVAILABLE' })
  })

  it('rejects malformed stored values and oversized secret replacements', async () => {
    const fixture = await createFixture()
    await writeFile(fixture.file, '[Nebula - Settings]\nHostPort = not-a-number\n', 'utf8')
    await expect(fixture.service.inspect(inspectionRequest())).rejects.toMatchObject({
      code: 'MOD_CONFIGURATION_FILE_INVALID'
    })

    await writeFile(fixture.file, '[Nebula - Settings]\nHostPort = 70000\n', 'utf8')
    await expect(fixture.service.inspect(inspectionRequest())).rejects.toMatchObject({
      code: 'MOD_CONFIGURATION_FILE_INVALID'
    })

    await writeFile(fixture.file, '[Nebula - Settings]\nHostPort = 8469\n', 'utf8')
    const inspection = await fixture.service.inspect(inspectionRequest())
    await expect(fixture.service.preview({
      ...configurationRequest(inspection.configurationRevision),
      changes: [{ id: 'server-password', value: 'x'.repeat(129) }]
    })).rejects.toMatchObject({ code: 'MOD_CONFIGURATION_VALUE_INVALID' })
  })

  it('revalidates deployment state inside the host lease before changing configuration', async () => {
    const fixture = await createFixture()
    const inspection = await fixture.service.inspect(inspectionRequest())
    fixture.hooks.beforeStopGate = () => {
      fixture.deployment.revision = 'b'.repeat(64)
    }

    await expect(fixture.service.execute(configurationRequest(inspection.configurationRevision))).rejects.toMatchObject({
      code: 'MOD_CONFIGURATION_DEPLOYMENT_REVISION_CONFLICT'
    })
    await expect(readFile(fixture.file, 'utf8')).resolves.toContain('HostPort = 8469')
  })

  it('revalidates platform-owned package identity inside the host lease', async () => {
    const fixture = await createFixture()
    const inspection = await fixture.service.inspect(inspectionRequest())
    fixture.hooks.beforeStopGate = () => {
      fixture.platform.nebula = '0.9.23.0'
    }

    await expect(fixture.service.execute(configurationRequest(inspection.configurationRevision))).rejects.toMatchObject({
      code: 'MOD_CONFIGURATION_PACKAGE_UNAVAILABLE'
    })
    await expect(readFile(fixture.file, 'utf8')).resolves.toContain('HostPort = 8469')
  })

  it('rolls the configuration back when the durable receipt cannot be persisted', async () => {
    const fixture = await createFixture()
    const inspection = await fixture.service.inspect(inspectionRequest())
    fixture.hooks.beforeStopGate = async () => {
      const control = join(fixture.configRoot, '.dyson-control-managed-mod-config')
      await mkdir(control, { recursive: true })
      await writeFile(join(control, 'receipts'), 'blocks-receipt-directory', 'utf8')
    }

    await expect(fixture.service.execute(configurationRequest(inspection.configurationRevision))).rejects.toMatchObject({
      code: 'MOD_CONFIGURATION_RECEIPT_PERSIST_FAILED'
    })
    await expect(readFile(fixture.file, 'utf8')).resolves.toContain('HostPort = 8469')
    await expect(readFile(fixture.file, 'utf8')).resolves.not.toContain('replacement-server-secret')
  })
})

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dyson-managed-mod-configuration-'))
  roots.push(root)
  const configRoot = join(root, 'BepInEx', 'config')
  await mkdir(configRoot, { recursive: true })
  const file = join(configRoot, 'nebula.cfg')
  await writeFile(file, '[Nebula - Settings]\nServerPassword = test-server-secret\nHostPort = 8469\nSyncUps = true\n', 'utf8')
  const coordinator = new RecordingCoordinator()
  const stopped = { processStopped: true, portClosed: true }
  const deployment = {
    revision: deploymentRevision,
    packages: [] as Array<{ dependencyId: string; sourceId: string; version: string; enabled: boolean; clientRequirement: 'required' | 'optional' | 'not-required' }>,
    enabledCount: 0,
    disabledCount: 0
  }
  const platform = { nebula: '0.9.22.2', bepInEx: '5.4.17.0' }
  const hooks: { beforeStopGate?: () => void | Promise<void> } = {}
  const service = new ManagedModConfigurationService({
    configRoot,
    readDeploymentState: async () => deployment,
    readPlatformState: async () => platform,
    verifyStoppedState: async () => {
      await hooks.beforeStopGate?.()
      return stopped
    },
    hostMutationCoordinator: coordinator
  })
  return { service, file, configRoot, coordinator, stopped, deployment, platform, hooks }
}

function inspectionRequest() {
  return { schemaId: 'nebula-server-v0-9-22', package: { dependencyId: 'nebula-NebulaMultiplayerMod-0.9.22', version: '0.9.22' }, expectedDeploymentRevision: deploymentRevision }
}

function configurationRequest(expectedConfigurationRevision: string) {
  return {
    requestId, operation: 'configure' as const, ...inspectionRequest(), expectedConfigurationRevision,
    changes: [{ id: 'host-port', value: 9443 }, { id: 'server-password', value: 'replacement-server-secret' }]
  }
}

class RecordingCoordinator implements HostMutationOperationCoordinator {
  readonly requests: HostMutationOperationRequest[] = []
  async runExclusive<T>(request: HostMutationOperationRequest, operation: (scope: HostMutationOperationScope) => Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>): Promise<T> {
    this.requests.push(request)
    const outcome = await operation({ signal: new AbortController().signal, assertActive: () => undefined, toPowerShellBorrowArguments: () => [] })
    if (outcome.kind === 'return') return outcome.value
    throw outcome.error
  }
}

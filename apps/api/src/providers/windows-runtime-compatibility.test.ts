import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TrustedCompatibilityService } from '../update-pipeline/trusted-compatibility.js'
import {
  WindowsTrustedRuntimeCompatibilityInspector
} from './windows-runtime-compatibility.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    await rm(temporaryRoots.pop()!, { recursive: true, force: true })
  }
})

describe('WindowsTrustedRuntimeCompatibilityInspector', () => {
  it('approves only explicit rollback warnings for the independently verified target version', async () => {
    const fixture = await createFixture()
    const policy = { ...fixture.policy, rollbackWarningApprovals: [{
      entryId: 'windows-runtime-exact-stack', warnings: ['mod-bepinex-target-mismatch']
    }] }
    const service = new TrustedCompatibilityService({ stateRoot: path.join(fixture.root, 'approved'),
      policy, readRuntimeInventory: async () => runtimeInventory() })
    const inspector = new WindowsTrustedRuntimeCompatibilityInspector({ projectRoot: fixture.root,
      trustedCompatibilityService: service, policy })
    const input = { component: 'bepinex' as const, expectedVersion: '5.4.23.3', warnings: ['mod-bepinex-target-mismatch'] }
    await expect(inspector.approveRollbackWarnings(input)).resolves.toBe(true)
    await expect(inspector.approveRollbackWarnings({ ...input, expectedVersion: '5.4.17.0' })).resolves.toBe(false)
    await expect(inspector.approveRollbackWarnings({ ...input, warnings: [...input.warnings, 'game-load-incomplete'] })).resolves.toBe(false)
    const mismatched = new WindowsTrustedRuntimeCompatibilityInspector({ projectRoot: fixture.root,
      trustedCompatibilityService: fixture.service, policy })
    await expect(mismatched.approveRollbackWarnings(input)).resolves.toBe(false)
  })

  it('independently binds the reviewed policy, fixed inventory revision, and decision', async () => {
    const fixture = await createFixture()
    const inspector = new WindowsTrustedRuntimeCompatibilityInspector({
      projectRoot: fixture.root,
      trustedCompatibilityService: fixture.service,
      policy: fixture.policy
    })

    const first = await inspector.inspect()
    const second = await inspector.inspect()
    expect(first).toEqual({
      dspVersion: '0.10.34.28529',
      compatibilityRevision: expect.stringMatching(/^[0-9a-f]{64}$/),
      compatible: true
    })
    expect(second).toEqual(first)
  })

  it('fails closed when construction-time policy differs from the service authority', async () => {
    const fixture = await createFixture()
    const inspector = new WindowsTrustedRuntimeCompatibilityInspector({
      projectRoot: fixture.root,
      trustedCompatibilityService: fixture.service,
      policy: { ...fixture.policy, policyId: 'different-reviewed-policy' }
    })
    await expect(inspector.inspect()).rejects.toMatchObject({
      code: 'WINDOWS_RUNTIME_COMPATIBILITY_AUTHORITY_DRIFT'
    })
  })

  it('fails closed when inventory changes between the authoritative and independent reads', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dyson-runtime-compatibility-drift-'))
    temporaryRoots.push(root)
    const policy = trustedPolicy()
    let reads = 0
    const service = new TrustedCompatibilityService({
      stateRoot: path.join(root, 'trusted-state'),
      policy,
      readRuntimeInventory: async () => ({
        ...runtimeInventory(),
        dsp: reads++ === 0 ? '0.10.34.28529' : '0.10.34.28530'
      })
    })
    const inspector = new WindowsTrustedRuntimeCompatibilityInspector({
      projectRoot: root,
      trustedCompatibilityService: service,
      policy
    })
    await expect(inspector.inspect()).rejects.toMatchObject({
      code: 'WINDOWS_RUNTIME_COMPATIBILITY_AUTHORITY_DRIFT'
    })
  })
})

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'dyson-runtime-compatibility-'))
  temporaryRoots.push(root)
  const policy = trustedPolicy()
  const service = new TrustedCompatibilityService({
    stateRoot: path.join(root, 'trusted-state'),
    policy,
    readRuntimeInventory: async () => runtimeInventory()
  })
  return { root, policy, service }
}

function runtimeInventory() {
  return {
    dsp: '0.10.34.28529',
    nebula: '0.9.22',
    bepInEx: '5.4.23.3',
    plugins: [
      { sourceId: 'thunderstore:Example/Bridge', version: '0.1.0' }
    ]
  }
}

function trustedPolicy() {
  return {
    format: 'dyson-control-trusted-compatibility-policy' as const,
    schemaVersion: 1 as const,
    policyId: 'windows-runtime-reviewed-policy',
    reviewedAt: '2026-08-30T10:00:00.000Z',
    matrix: {
      schemaVersion: 1 as const,
      entries: [{
        id: 'windows-runtime-exact-stack',
        core: {
          dsp: { equals: '0.10.34.28529' },
          nebula: { equals: '0.9.22' },
          bepInEx: { equals: '5.4.23.3' }
        },
        plugins: [{
          sourceId: 'thunderstore:Example/Bridge',
          range: { equals: '0.1.0' },
          required: true
        }]
      }]
    }
  }
}

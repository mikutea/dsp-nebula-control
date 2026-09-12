import { afterEach, describe, expect, it } from 'vitest'
import { buildApplication, type BuiltApplication } from './app.js'
import { loadConfig } from './config.js'
import type {
  ArtifactStagePlan, DiscoveredModRelease, DiscoveredNebulaRelease, StageArtifactResult,
  TrustedCompatibilityReceipt, TrustedCompatibilityStatus
} from './update-pipeline/index.js'
import { TrustedCompatibilityHttpController } from './update-pipeline/index.js'
import { generateModManifests } from './mods/index.js'

let application: BuiltApplication | null = null
afterEach(async () => { if (application) await application.close(); application = null })

const inventory = {
  dsp: '0.10.34.28529', nebula: '0.9.22.2', bepInEx: '5.4.17.0',
  plugins: [{ sourceId: 'thunderstore:NebulaModTeam/NebulaMultiplayerMod', version: '0.9.22.2' }]
}
const matrix = {
  schemaVersion: 1,
  entries: [{
    id: 'fixture-compatible',
    core: {
      dsp: { minInclusive: '0.10.34.0', maxExclusive: '0.10.35.0' },
      nebula: { equals: '0.9.22.2' }, bepInEx: { minInclusive: '5.4.17', maxExclusive: '6.0.0' }
    },
    plugins: [{
      sourceId: 'thunderstore:NebulaModTeam/NebulaMultiplayerMod',
      range: { equals: '0.9.22.2' }, required: true
    }]
  }]
}
const modInput = {
  roots: ['Fictional-MultiplayerRoot-2.0.0'],
  packages: [
    {
      dependencyId: 'Fictional-MultiplayerRoot-2.0.0', sha256: 'b'.repeat(64),
      dependencies: ['Fictional-ServerHelper-1.0.0'], serverRequired: true, clientRequirement: 'required'
    },
    {
      dependencyId: 'Fictional-ServerHelper-1.0.0', sha256: 'a'.repeat(64),
      dependencies: [], serverRequired: true, clientRequirement: 'not-required'
    }
  ]
}
const stagePlan: ArtifactStagePlan = {
  format: 'dyson-control-artifact-stage-plan', schemaVersion: 1, dryRun: true,
  artifactId: 'artifact-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  source: { location: 'fixed-inbox', file: 'artifact-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.artifact' },
  destination: { location: 'fixed-staging-store', releaseId: 'artifact-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  operations: [
    'acquire-exclusive-lock', 'read-fixed-inbox-artifact', 'compute-size-and-sha256',
    'verify-provider-integrity-if-present', 'copy-to-temporary-directory',
    'write-verification-manifest', 'atomically-publish-immutable-stage', 'release-exclusive-lock'
  ],
  activation: { enabled: false, reason: 'staging-only' },
  rollback: {
    automatic: false, strategy: 'remove-unreferenced-staged-release',
    preconditions: ['stage-not-activated', 'stage-not-referenced-by-another-plan']
  }
}
const nebulaRelease: DiscoveredNebulaRelease = {
  provider: 'github', sourceId: 'github:NebulaModTeam/nebula', releaseId: 1001,
  version: '0.9.22.2', publishedAt: '2026-08-30T01:00:00.000Z', prerelease: false,
  artifact: {
    artifactId: stagePlan.artifactId, downloadUrl: 'https://github.com/NebulaModTeam/nebula/releases/download/v0.9.22.2/Nebula.zip',
    fileName: 'Nebula.zip', sizeBytes: 1024, sha256: 'c'.repeat(64), integrity: 'provider-sha256'
  }
}
const modRelease: DiscoveredModRelease = {
  provider: 'thunderstore', sourceId: 'thunderstore:Fictional/ServerHelper',
  dependencyId: 'Fictional-ServerHelper-1.0.0', namespace: 'Fictional', name: 'ServerHelper',
  version: '1.0.0', dependencies: [], publishedAt: '2026-08-30T01:00:00.000Z',
  deprecated: false, eligible: true, blockers: ['artifact-integrity-pending'],
  artifact: {
    artifactId: 'artifact-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    downloadUrl: 'https://thunderstore.io/package/download/Fictional/ServerHelper/1.0.0/',
    fileName: 'Fictional-ServerHelper-1.0.0.zip', sizeBytes: null, sha256: null,
    integrity: 'locally-computed-required'
  }
}

describe('version and mod dry-run routes', () => {
  it('uses server-owned compatibility evidence and previews update plans, dependency resolution, and reproducible locks', async () => {
    const compatibilityStatus: TrustedCompatibilityStatus = {
      format: 'dyson-control-trusted-compatibility-status', schemaVersion: 1, available: true,
      policyId: 'fixture-policy', policyRevision: '1'.repeat(64),
      policyReviewedAt: '2026-08-30T01:00:00.000Z', inventoryRevision: '2'.repeat(64), inventory
    }
    const compatibilityReceipt: TrustedCompatibilityReceipt = {
      format: 'dyson-control-trusted-compatibility-receipt', schemaVersion: 1,
      receiptId: '018f47a0-7d5b-7abc-8def-0123456789ab', component: 'nebula',
      artifactId: stagePlan.artifactId, artifactSha256: 'c'.repeat(64), targetVersion: '0.9.22.2',
      inventoryRevision: compatibilityStatus.inventoryRevision, policyId: compatibilityStatus.policyId!,
      policyRevision: compatibilityStatus.policyRevision!, matchedEntryId: 'fixture-compatible', compatible: true,
      issuedAt: '2026-08-30T02:00:00.000Z', expiresAt: '2026-08-30T02:10:00.000Z', reused: false
    }
    application = await buildApplication(loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'demo', DYSON_DEV_ADMIN_PASSWORD: 'test-password-long-enough',
      DYSON_PUBLIC_ORIGIN: 'http://127.0.0.1:13010'
    }), {
      trustedCompatibilityController: new TrustedCompatibilityHttpController({
        async status() { return compatibilityStatus },
        async prepare() { return compatibilityReceipt },
        async getReceipt() { return compatibilityReceipt }
      }),
      nebulaReleaseClient: { async discover() { return { items: [nebulaRelease], pagesFetched: 1, truncated: false } } },
      thunderstoreReleaseClient: { async discoverLatest() { return modRelease } },
      updateStager: {
        preview() { return stagePlan },
        async stage(): Promise<StageArtifactResult> {
          return {
            created: true, plan: stagePlan,
            manifest: {
              format: 'dyson-control-staged-artifact', schemaVersion: 1,
              artifactId: stagePlan.artifactId, artifactFile: 'artifact.bin',
              release: { kind: 'nebula', sourceId: 'github:NebulaModTeam/nebula', version: '0.9.22.2' },
              sizeBytes: 1024, sha256: 'c'.repeat(64), integrity: 'provider-verified',
              stagedAt: '2026-08-30T02:00:00.000Z'
            }
          }
        }
      }
    })
    const login = await application.app.inject({
      method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://127.0.0.1:13010' },
      payload: { password: 'test-password-long-enough' }
    })
    const request = (url: string, payload: Record<string, unknown>) => application!.app.inject({
      method: 'POST', url, headers: { origin: 'http://127.0.0.1:13010' },
      cookies: { dyson_session: login.cookies[0]!.value }, payload
    })
    const get = (url: string) => application!.app.inject({
      method: 'GET', url, headers: { origin: 'http://127.0.0.1:13010' },
      cookies: { dyson_session: login.cookies[0]!.value }
    })

    const status = await get('/api/v1/updates/compatibility/status')
    expect(status.statusCode).toBe(200)
    expect(status.json().data).toMatchObject({ available: true, policyId: 'fixture-policy' })
    const compatibility = await request('/api/v1/updates/compatibility/prepare', {
      requestId: compatibilityReceipt.receiptId,
      component: 'nebula', artifactId: stagePlan.artifactId, sha256: 'c'.repeat(64), targetVersion: '0.9.22.2',
      expectedInventoryRevision: compatibilityStatus.inventoryRevision,
      expectedPolicyRevision: compatibilityStatus.policyRevision,
      confirmation: 'PREPARE_COMPATIBILITY_EVIDENCE'
    })
    expect(compatibility.statusCode).toBe(201)
    expect(compatibility.json().data).toMatchObject({ compatible: true, matchedEntryId: 'fixture-compatible' })

    const plan = await request('/api/v1/updates/plan/preview', {
      planId: 'plan-fixture-0001', createdAt: '2026-08-30T02:00:00.000Z',
      targets: [{
        targetId: 'nebula', kind: 'nebula',
        current: { sourceId: 'github:NebulaModTeam/Nebula', version: '0.9.22.1', sha256: '1'.repeat(64) },
        candidate: { sourceId: 'github:NebulaModTeam/Nebula', version: '0.9.22.2', sha256: '2'.repeat(64) }
      }]
    })
    expect(plan.statusCode).toBe(200)
    expect(plan.json().data).toMatchObject({ mode: 'dry-run', plan: { state: 'planned' } })

    const resolution = await request('/api/v1/mods/resolve/preview', modInput)
    expect(resolution.statusCode).toBe(200)
    expect(resolution.json().data).toMatchObject({ mode: 'dry-run', resolution: { ok: true } })

    const lock = await request('/api/v1/mods/lock/preview', modInput)
    expect(lock.statusCode).toBe(200)
    expect(lock.json().data.serverLock.mods).toHaveLength(2)
    expect(lock.json().data.clientParity.serverLockSha256).toBe(lock.json().data.serverLockSha256)

    const nebula = await request('/api/v1/updates/discovery/nebula', {})
    expect(nebula.statusCode).toBe(200)
    expect(nebula.json().data).toMatchObject({ pagesFetched: 1, items: [{ version: '0.9.22.2' }] })

    const thunderstore = await request('/api/v1/updates/discovery/thunderstore', {
      namespace: 'Fictional', name: 'ServerHelper'
    })
    expect(thunderstore.statusCode).toBe(200)
    expect(thunderstore.json().data).toMatchObject({ dependencyId: 'Fictional-ServerHelper-1.0.0' })

    const preparation = await request('/api/v1/updates/preparation/preview', {
      planId: 'plan-fixture-preparation',
      targets: [
        { targetId: 'dsp', kind: 'dsp', artifactId: null },
        { targetId: 'nebula', kind: 'nebula', artifactId: stagePlan.artifactId }
      ]
    })
    expect(preparation.statusCode).toBe(200)
    expect(preparation.json().data).toMatchObject({
      dryRun: true, activationEnabled: false, canStageAll: false,
      targets: expect.arrayContaining([
        expect.objectContaining({ targetId: 'dsp', blockers: ['manual/steam-client-required'] })
      ])
    })

    const stagePreview = await request('/api/v1/updates/staging/preview', {
      artifactId: stagePlan.artifactId,
      release: { kind: 'nebula', sourceId: 'github:NebulaModTeam/nebula', version: '0.9.22.2' },
      expected: { sizeBytes: 1024, sha256: 'c'.repeat(64) }
    })
    expect(stagePreview.statusCode).toBe(200)
    expect(stagePreview.json().data).toMatchObject({ dryRun: true, activation: { enabled: false } })

    const staged = await request('/api/v1/updates/staging/execute', {
      confirmation: 'STAGE_ARTIFACT', request: {
        artifactId: stagePlan.artifactId,
        release: { kind: 'nebula', sourceId: 'github:NebulaModTeam/nebula', version: '0.9.22.2' },
        expected: { sizeBytes: 1024, sha256: 'c'.repeat(64) }
      }
    })
    expect(staged.statusCode).toBe(201)
    expect(staged.json().data).toMatchObject({ created: true, plan: { activation: { enabled: false } } })

    const manifests = generateModManifests(modInput)
    const profile = await request('/api/v1/client-profile/generate', {
      schemaVersion: 1,
      profile: {
        profileId: 'fixture-profile', displayName: 'Fictional Dyson Server',
        connection: { host: 'dsp.example.com', port: 8469 }
      },
      compatibility: { inventory, matrix },
      serverLock: manifests.serverLock,
      clientParity: manifests.clientParity
    })
    expect(profile.statusCode).toBe(200)
    expect(profile.json().data).toMatchObject({
      format: 'dyson-control-client-profile-artifact-set',
      profile: { connection: { displayAddress: 'dsp.example.com:8469' } },
      parityReport: { canGenerate: true }
    })
    expect(profile.json().data.artifacts.map((artifact: { entryName: string }) => artifact.entryName))
      .toEqual(['CHECKSUMS.sha256', 'INSTALL.md', 'client-mod-lock.json', 'client-profile.json',
        'parity-report.json', 'verification-checklist.json'])
    expect(profile.body).not.toMatch(/(?:[A-Za-z]:\\|\\\\|serverpassword|player\.key|steamtoken)/i)

    const rejected = await request('/api/v1/updates/compatibility/prepare', {
      requestId: randomUuidFixture(), component: 'nebula', artifactId: stagePlan.artifactId,
      sha256: 'c'.repeat(64), targetVersion: '0.9.22.2',
      expectedInventoryRevision: compatibilityStatus.inventoryRevision,
      expectedPolicyRevision: compatibilityStatus.policyRevision,
      confirmation: 'PREPARE_COMPATIBILITY_EVIDENCE', matrix
    })
    expect(rejected.statusCode).toBe(422)
    expect(rejected.body).not.toContain('fixture-compatible')

    const removed = await request('/api/v1/updates/compatibility/preview', { inventory, matrix })
    expect(removed.statusCode).toBe(410)
    expect(removed.json().error.code).toBe('UPDATE_COMPATIBILITY_BROWSER_POLICY_REMOVED')
  })
})

function randomUuidFixture(): string {
  return '218f47a0-7d5b-7abc-8def-0123456789ab'
}

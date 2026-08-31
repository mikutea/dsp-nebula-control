import { describe, expect, it } from 'vitest'
import type { DiscoveredModRelease, DiscoveredNebulaRelease } from './discovery.js'
import { buildVerifiedModManifests, createUpdatePreparationPlan, evaluateDiscoveredCompatibility } from './pipeline.js'
import type { StagedArtifactManifest } from './staging.js'
import {
  computeStagedModPayloadDigest,
  type StagedModPackageManifest
} from '../mods/index.js'

const hash = (character: string): string => character.repeat(64)

function modRelease(
  namespace: string,
  name: string,
  version: string,
  artifactId: string,
  dependencies: string[] = []
): DiscoveredModRelease {
  return {
    provider: 'thunderstore',
    sourceId: `thunderstore:${namespace}/${name}`,
    dependencyId: `${namespace}-${name}-${version}`,
    namespace,
    name,
    version,
    dependencies,
    publishedAt: '2026-08-30T01:00:00Z',
    deprecated: false,
    eligible: true,
    blockers: ['artifact-integrity-pending'],
    artifact: {
      artifactId,
      downloadUrl: `https://thunderstore.io/package/download/${namespace}/${name}/${version}/`,
      fileName: `${namespace}-${name}-${version}.zip`,
      sizeBytes: null,
      sha256: null,
      integrity: 'locally-computed-required'
    }
  }
}

function staged(release: DiscoveredModRelease, character: string): StagedArtifactManifest {
  return {
    format: 'dyson-control-staged-artifact',
    schemaVersion: 1,
    artifactId: release.artifact.artifactId,
    artifactFile: 'artifact.bin',
    release: { kind: 'plugin', sourceId: release.sourceId, version: release.version },
    sizeBytes: 100,
    sha256: hash(character),
    integrity: 'locally-computed',
    stagedAt: '2026-08-30T02:00:00Z'
  }
}

function stagedPackage(release: DiscoveredModRelease, character: string): StagedModPackageManifest {
  return {
    format: 'dyson-control-staged-mod-package',
    schemaVersion: 1,
    dependencyId: release.dependencyId,
    sourceId: release.sourceId,
    version: release.version,
    dependencies: [...release.dependencies],
    files: [{
      relativePath: `${release.name}.dll`,
      sizeBytes: 100,
      sha256: hash(character)
    }]
  }
}

describe('update discovery composition', () => {
  it('feeds normalized release candidates into the existing compatibility evaluator', () => {
    const candidateMod = modRelease('Fictional', 'ServerHelper', '1.1.0', `artifact-${'a'.repeat(40)}`)
    const nebula: DiscoveredNebulaRelease = {
      provider: 'github',
      sourceId: 'github:NebulaModTeam/nebula',
      releaseId: 10,
      version: '0.9.22',
      publishedAt: '2026-08-30T02:00:00Z',
      prerelease: false,
      artifact: {
        artifactId: `artifact-${'b'.repeat(40)}`,
        downloadUrl: 'https://github.com/NebulaModTeam/nebula/releases/download/v0.9.22/Nebula.zip',
        fileName: 'Nebula.zip', sizeBytes: 100, sha256: hash('b'), integrity: 'provider-sha256'
      }
    }
    const result = evaluateDiscoveredCompatibility({
      runtime: {
        dsp: '0.10.34.28529', nebula: '0.9.21', bepInEx: '5.4.17',
        plugins: [{ sourceId: candidateMod.sourceId, version: '1.0.0' }]
      },
      nebula,
      mods: [candidateMod],
      matrix: {
        schemaVersion: 1,
        entries: [{
          id: 'fixture-compatible',
          core: {
            dsp: { equals: '0.10.34.28529' },
            nebula: { equals: '0.9.22' },
            bepInEx: { equals: '5.4.17' }
          },
          plugins: [{ sourceId: candidateMod.sourceId, range: { equals: '1.1.0' }, required: true }]
        }]
      }
    })
    expect(result.candidateInventory).toMatchObject({ nebula: '0.9.22' })
    expect(result.candidateInventory.plugins).toEqual([{ sourceId: candidateMod.sourceId, version: '1.1.0' }])
    expect(result.decision).toMatchObject({ compatible: true, matchedEntryId: 'fixture-compatible' })
  })

  it('requires verified staged bytes and explicit policies before generating existing lock formats', () => {
    const core = modRelease('Fictional', 'CoreLib', '1.0.0', `artifact-${'c'.repeat(40)}`)
    const root = modRelease(
      'Fictional', 'ServerHelper', '2.0.0', `artifact-${'d'.repeat(40)}`, [core.dependencyId]
    )
    const manifests = buildVerifiedModManifests({
      roots: [root.dependencyId],
      releases: [root, core],
      stagedArtifacts: [staged(root, 'd'), staged(core, 'c')],
      stagedPackages: [stagedPackage(root, '2'), stagedPackage(core, '1')],
      policies: [
        { sourceId: root.sourceId, serverRequired: true, clientRequirement: 'required' },
        { sourceId: core.sourceId, serverRequired: true, clientRequirement: 'required' }
      ]
    })
    expect(manifests.serverLock.mods.map((mod) => mod.dependencyId)).toEqual([
      core.dependencyId, root.dependencyId
    ])
    expect(manifests.serverLock.mods.map((mod) => mod.sha256)).toEqual([
      computeStagedModPayloadDigest(stagedPackage(core, '1')),
      computeStagedModPayloadDigest(stagedPackage(root, '2'))
    ])
    expect(manifests.serverLock.mods.map((mod) => mod.sha256)).not.toContain(hash('c'))
    expect(manifests.serverLock.mods.map((mod) => mod.sha256)).not.toContain(hash('d'))
    expect(manifests.clientParity.serverLockSha256).toBe(manifests.serverLockSha256)

    expect(() => buildVerifiedModManifests({
      roots: [root.dependencyId], releases: [root, core], stagedArtifacts: [staged(root, 'd')],
      stagedPackages: [stagedPackage(root, '2'), stagedPackage(core, '1')],
      policies: [
        { sourceId: root.sourceId, serverRequired: true, clientRequirement: 'required' },
        { sourceId: core.sourceId, serverRequired: true, clientRequirement: 'required' }
      ]
    })).toThrow('VERIFIED_MOD_STAGE_MISSING')
  })

  it('models DSP updates as a Steam-client/manual blocker and never promises activation', () => {
    const plan = createUpdatePreparationPlan({
      planId: 'fixture-plan-0001',
      targets: [
        { targetId: 'dsp', kind: 'dsp', artifactId: null },
        { targetId: 'nebula', kind: 'nebula', artifactId: `artifact-${'e'.repeat(40)}` }
      ]
    })
    expect(plan).toMatchObject({ dryRun: true, canStageAll: false, activationEnabled: false })
    expect(plan.targets[0]).toMatchObject({
      targetId: 'dsp', staging: 'blocked', blockers: ['manual/steam-client-required']
    })
    expect(plan.rollback).toMatchObject({ automatic: false, boundary: 'staging-only' })
  })
})

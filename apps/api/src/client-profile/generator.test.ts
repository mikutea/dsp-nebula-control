import { describe, expect, it } from 'vitest'
import { generateModManifests } from '../mods/manifest.js'
import {
  MAX_CLIENT_PROFILE_ARTIFACT_BYTES,
  MAX_CLIENT_PROFILE_ARTIFACTS,
  MAX_CLIENT_PROFILE_TOTAL_BYTES,
  assessClientProfile,
  assertPublicArtifactContent,
  assertSafeArtifactEntryName,
  buildClientProfileArtifacts,
  generateClientProfile
} from './index.js'

const digest = (character: string): string => character.repeat(64)

const manifests = generateModManifests({
  roots: [
    'Fictional-MultiplayerRoot-2.0.0',
    'Fictional-CosmeticLights-1.1.0'
  ],
  packages: [
    {
      dependencyId: 'Fictional-CosmeticLights-1.1.0',
      sha256: digest('c'),
      dependencies: [],
      serverRequired: false,
      clientRequirement: 'optional'
    },
    {
      dependencyId: 'Fictional-MultiplayerRoot-2.0.0',
      sha256: digest('b'),
      dependencies: ['Fictional-ServerHelper-1.0.0'],
      serverRequired: true,
      clientRequirement: 'required'
    },
    {
      dependencyId: 'Fictional-ServerHelper-1.0.0',
      sha256: digest('a'),
      dependencies: [],
      serverRequired: true,
      clientRequirement: 'not-required'
    }
  ]
})

const matchingCompatibility = {
  inventory: {
    dsp: '0.10.34.28529',
    nebula: '0.9.22.2',
    bepInEx: '5.4.17.0',
    plugins: [
      { sourceId: 'thunderstore:NebulaModTeam/NebulaMultiplayerMod', version: '0.9.22.2' }
    ]
  },
  matrix: {
    schemaVersion: 1 as const,
    entries: [{
      id: 'supported-example',
      core: {
        dsp: { equals: '0.10.34.28529' },
        nebula: { equals: '0.9.22.2' },
        bepInEx: { equals: '5.4.17.0' }
      },
      plugins: [{
        sourceId: 'thunderstore:NebulaModTeam/NebulaMultiplayerMod',
        range: { equals: '0.9.22.2' },
        required: true
      }]
    }]
  }
}

const validInput = {
  schemaVersion: 1 as const,
  compatibility: matchingCompatibility,
  serverLock: manifests.serverLock,
  clientParity: manifests.clientParity
}

describe('client profile generator', () => {
  it('generates a byte-for-byte reproducible metadata artifact set with stable checksums', () => {
    const first = generateClientProfile(validInput)
    const second = generateClientProfile(structuredClone(validInput))

    expect(second).toEqual(first)
    expect(first.profile.connection).toMatchObject({
      host: 'example.com',
      port: 8469,
      displayAddress: 'example.com:8469',
      protocol: 'nebula',
      transport: 'direct'
    })
    expect(first.artifacts.map((artifact) => artifact.entryName)).toEqual([
      'CHECKSUMS.sha256',
      'INSTALL.md',
      'client-mod-lock.json',
      'client-profile.json',
      'parity-report.json',
      'verification-checklist.json'
    ])
    expect(first.artifactSetSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(first.totalSizeBytes).toBe(first.artifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0))

    const checksums = first.artifacts.find((artifact) => artifact.entryName === 'CHECKSUMS.sha256')!.content
    for (const artifact of first.artifacts.filter((artifact) => artifact.entryName !== 'CHECKSUMS.sha256')) {
      expect(checksums).toContain(`${artifact.sha256}  ${artifact.entryName}\n`)
    }
  })

  it('separates required, optional, and server-only entries without putting server-only mods in the client lock', () => {
    const generated = generateClientProfile(validInput)
    expect(generated.parityReport.counts).toEqual({ server: 3, required: 1, optional: 1, notRequired: 1 })
    expect(generated.profile.mods.required.map((entry) => entry.sourceId)).toEqual([
      'thunderstore:Fictional/MultiplayerRoot'
    ])
    expect(generated.profile.mods.optional.map((entry) => entry.sourceId)).toEqual([
      'thunderstore:Fictional/CosmeticLights'
    ])
    expect(generated.parityReport.notRequired).toEqual([{
      sourceId: 'thunderstore:Fictional/ServerHelper',
      version: '1.0.0',
      reason: 'server-only'
    }])
    expect(generated.clientModLock.mods.map((entry) => entry.sourceId)).not.toContain(
      'thunderstore:Fictional/ServerHelper'
    )
    expect(generated.verificationChecklist.excluded[0]).toMatchObject({
      sourceId: 'thunderstore:Fictional/ServerHelper',
      requirement: 'not-required',
      reason: 'server-only'
    })

    const installableArtifacts = generated.artifacts
      .filter((artifact) => ['client-mod-lock.json', 'client-profile.json'].includes(artifact.entryName))
      .map((artifact) => artifact.content).join('\n')
    expect(installableArtifacts).not.toContain('ServerHelper')
  })

  it('produces a parity report and blocks generation when runtime compatibility is unsatisfied', () => {
    const incompatible = {
      ...validInput,
      compatibility: {
        ...matchingCompatibility,
        inventory: { ...matchingCompatibility.inventory, nebula: '0.9.21.0' }
      }
    }
    const assessment = assessClientProfile(incompatible)
    expect(assessment.report).toMatchObject({
      validManifestPair: true,
      runtimeCompatible: false,
      canGenerate: false,
      matchedCompatibilityEntryId: null
    })
    expect(assessment.report.blockers.map((blocker) => blocker.code)).toContain('nebula-version-mismatch')

    try {
      generateClientProfile(incompatible)
      throw new Error('expected incompatible profile generation to fail')
    } catch (error) {
      expect(error).toMatchObject({
        code: 'CLIENT_PROFILE_RUNTIME_INCOMPATIBLE',
        report: { canGenerate: false, runtimeCompatible: false }
      })
    }
  })

  it('rejects a server lock whose content no longer matches the signed parity digest', () => {
    const tampered = structuredClone(validInput)
    tampered.serverLock.mods[0]!.sha256 = digest('f')
    expect(() => generateClientProfile(tampered)).toThrow('CLIENT_PARITY_LOCK_DIGEST_MISMATCH')

    const parityTampered = structuredClone(validInput)
    parityTampered.clientParity.mods[0]!.sha256 = digest('e')
    expect(() => generateClientProfile(parityTampered)).toThrow('CLIENT_PARITY_ENTRY_MISMATCH')
  })

  it('rejects path-like profile metadata, network URLs, literal IPs, and unsafe archive entry names', () => {
    expect(() => generateClientProfile({
      ...validInput,
      profile: { profileId: '../escape', displayName: 'Example', connection: { host: 'example.com', port: 8469 } }
    })).toThrow()
    expect(() => generateClientProfile({
      ...validInput,
      profile: {
        profileId: 'safe-example', displayName: 'Example',
        connection: { host: 'https://example.com/join', port: 8469 }
      }
    })).toThrow()
    expect(() => generateClientProfile({
      ...validInput,
      profile: {
        profileId: 'safe-example', displayName: 'Example', connection: { host: '192.0.2.20', port: 8469 }
      }
    })).toThrow()

    for (const entryName of ['../profile.json', 'folder/../../profile.json', 'C:/profile.json',
      '\\server\\share', '/absolute.json', 'folder//profile.json', 'folder/./profile.json']) {
      expect(() => assertSafeArtifactEntryName(entryName)).toThrow('CLIENT_PROFILE_ARTIFACT_NAME_INVALID')
    }
    expect(assertSafeArtifactEntryName('profile/client-profile.json')).toBe('profile/client-profile.json')
  })

  it('enforces per-artifact, aggregate, and artifact-count size bounds', () => {
    expect(() => buildClientProfileArtifacts([{
      entryName: 'oversized.txt',
      mediaType: 'text/plain',
      content: 'x'.repeat(MAX_CLIENT_PROFILE_ARTIFACT_BYTES + 1)
    }])).toThrow('CLIENT_PROFILE_ARTIFACT_TOO_LARGE')

    expect(() => buildClientProfileArtifacts(Array.from({ length: MAX_CLIENT_PROFILE_ARTIFACTS + 1 }, (_, index) => ({
      entryName: `file-${index}.txt`,
      mediaType: 'text/plain' as const,
      content: 'safe'
    })))).toThrow('CLIENT_PROFILE_ARTIFACT_COUNT_INVALID')

    expect(() => buildClientProfileArtifacts([
      { entryName: 'Profile.json', mediaType: 'application/json', content: '{}\n' },
      { entryName: 'profile.json', mediaType: 'application/json', content: '{}\n' }
    ])).toThrow('CLIENT_PROFILE_ARTIFACT_DUPLICATE')

    const aggregateCount = Math.floor(MAX_CLIENT_PROFILE_TOTAL_BYTES / MAX_CLIENT_PROFILE_ARTIFACT_BYTES) + 1
    expect(() => buildClientProfileArtifacts(Array.from({ length: aggregateCount }, (_, index) => ({
      entryName: `large-${index}.txt`,
      mediaType: 'text/plain' as const,
      content: 'x'.repeat(MAX_CLIENT_PROFILE_ARTIFACT_BYTES)
    })))).toThrow('CLIENT_PROFILE_ARTIFACT_SET_TOO_LARGE')
  })

  it('keeps private fields and private host material out of accepted inputs and generated artifacts', () => {
    expect(() => generateClientProfile({
      ...validInput,
      steamToken: 'fictional-value-that-must-not-be-accepted'
    })).toThrow()
    expect(() => generateClientProfile({
      ...validInput,
      profile: {
        profileId: 'safe-example',
        displayName: 'Example',
        connection: { host: 'example.com', port: 8469 },
        serverPassword: 'fictional-value-that-must-not-be-accepted'
      }
    })).toThrow()
    expect(() => assertPublicArtifactContent('ServerPassword=fictional')).toThrow(
      'CLIENT_PROFILE_ARTIFACT_PRIVATE_MATERIAL'
    )
    expect(() => assertPublicArtifactContent('installPath=C:\\Fictional\\DSP')).toThrow(
      'CLIENT_PROFILE_ARTIFACT_PRIVATE_MATERIAL'
    )

    const generated = generateClientProfile(validInput)
    const publicOutput = JSON.stringify(generated)
    expect(publicOutput).not.toMatch(
      /(?:serverpassword|remoteaccesspassword|steam(?:cookie|token|account)|sessionsecret|bridgesecret|player\.key|[A-Za-z]:\\|\\\\)/i
    )
    expect(publicOutput).not.toContain('fictional-value-that-must-not-be-accepted')
  })
})

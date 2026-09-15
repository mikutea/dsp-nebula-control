import type { ClientParityEntry } from '../mods/manifest.js'
import { normalizeVersion } from '../updates/version.js'
import { buildClientProfileArtifacts, sha256, type ClientProfileArtifactInput } from './artifact.js'
import { assessClientProfile, type AssessedClientProfileInput } from './parity.js'
import type {
  ClientModLockDocument,
  ClientProfileDocument,
  ClientProfileModEntry,
  ClientVerificationChecklist,
  GeneratedClientProfile
} from './types.js'
import { generatedClientProfileSchema } from './types.js'

export class ClientProfileGenerationError extends Error {
  readonly code: string
  readonly report: ReturnType<typeof assessClientProfile>['report']

  constructor(code: string, report: ReturnType<typeof assessClientProfile>['report']) {
    super(code)
    this.name = 'ClientProfileGenerationError'
    this.code = code
    this.report = report
  }
}

export function generateClientProfile(input: unknown): GeneratedClientProfile {
  const assessed = assessClientProfile(input)
  if (!assessed.report.canGenerate || assessed.compatibility.matchedEntryId === null) {
    throw new ClientProfileGenerationError('CLIENT_PROFILE_RUNTIME_INCOMPATIBLE', assessed.report)
  }

  const required = assessed.report.required.map((entry): ClientProfileModEntry => ({
    ...entry,
    requirement: 'required'
  }))
  const optional = assessed.report.optional.map((entry): ClientProfileModEntry => ({
    ...entry,
    requirement: 'optional'
  }))
  const profile = buildProfile(assessed, required, optional)
  const clientModLock: ClientModLockDocument = {
    format: 'dyson-control-client-mod-lock',
    schemaVersion: 1,
    serverLockSha256: assessed.manifests.serverLockSha256,
    clientParitySha256: assessed.report.clientParitySha256,
    mods: [...required, ...optional].sort(compareClientMods)
  }
  const verificationChecklist = buildVerificationChecklist(assessed, required, optional)
  const baseArtifacts = buildBaseArtifacts(profile, clientModLock, assessed, verificationChecklist)
  const baseBuilt = buildClientProfileArtifacts(baseArtifacts)
  const checksums = baseBuilt.artifacts.map((artifact) => `${artifact.sha256}  ${artifact.entryName}\n`).join('')
  const built = buildClientProfileArtifacts([
    ...baseArtifacts,
    { entryName: 'CHECKSUMS.sha256', mediaType: 'text/plain', content: checksums }
  ])

  return generatedClientProfileSchema.parse({
    format: 'dyson-control-client-profile-artifact-set',
    schemaVersion: 1,
    profile,
    clientModLock,
    parityReport: assessed.report,
    verificationChecklist,
    artifacts: built.artifacts,
    artifactSetSha256: built.artifactSetSha256,
    totalSizeBytes: built.totalSizeBytes
  })
}

function buildProfile(
  assessed: AssessedClientProfileInput,
  required: ClientProfileModEntry[],
  optional: ClientProfileModEntry[]
): ClientProfileDocument {
  const inventory = assessed.compatibility.inventory
  const connection = assessed.input.profile.connection
  return {
    format: 'dyson-control-client-profile',
    schemaVersion: 1,
    profileId: assessed.input.profile.profileId,
    displayName: assessed.input.profile.displayName,
    connection: {
      protocol: 'nebula',
      transport: 'direct',
      host: connection.host,
      port: connection.port,
      displayAddress: `${connection.host}:${connection.port}`
    },
    runtime: {
      dsp: inventory.dsp,
      nebula: inventory.nebula,
      bepInEx: inventory.bepInEx,
      compatibilityEntryId: assessed.compatibility.matchedEntryId!
    },
    provenance: {
      serverLockSha256: assessed.manifests.serverLockSha256,
      clientParitySha256: assessed.report.clientParitySha256
    },
    mods: { required, optional }
  }
}

function buildVerificationChecklist(
  assessed: AssessedClientProfileInput,
  required: ClientProfileModEntry[],
  optional: ClientProfileModEntry[]
): ClientVerificationChecklist {
  const inventory = assessed.compatibility.inventory
  return {
    format: 'dyson-control-client-verification-checklist',
    schemaVersion: 1,
    serverLockSha256: assessed.manifests.serverLockSha256,
    checks: [
      {
        id: 'runtime:bepinex', category: 'runtime', requirement: 'required', sourceId: null,
        expectedVersion: normalizeVersion(inventory.bepInEx, 'bepinex'), sha256: null
      },
      {
        id: 'runtime:dsp', category: 'runtime', requirement: 'required', sourceId: null,
        expectedVersion: normalizeVersion(inventory.dsp, 'dsp'), sha256: null
      },
      {
        id: 'runtime:nebula', category: 'runtime', requirement: 'required', sourceId: null,
        expectedVersion: normalizeVersion(inventory.nebula, 'nebula'), sha256: null
      },
      ...[...required, ...optional].sort(compareClientMods).map((mod) => ({
        id: `mod:${mod.sourceId.toLowerCase()}`,
        category: 'mod' as const,
        requirement: mod.requirement,
        sourceId: mod.sourceId,
        expectedVersion: mod.version,
        sha256: mod.sha256
      }))
    ],
    excluded: assessed.report.notRequired.map((entry) => ({
      sourceId: entry.sourceId,
      version: entry.version,
      requirement: 'not-required',
      reason: 'server-only'
    }))
  }
}

function buildBaseArtifacts(
  profile: ClientProfileDocument,
  clientModLock: ClientModLockDocument,
  assessed: AssessedClientProfileInput,
  verificationChecklist: ClientVerificationChecklist
): ClientProfileArtifactInput[] {
  return [
    {
      entryName: 'INSTALL.md',
      mediaType: 'text/markdown',
      content: renderClientProfileInstallInstructions(profile, assessed.report.counts.notRequired)
    },
    {
      entryName: 'client-mod-lock.json',
      mediaType: 'application/json',
      content: serializeJson(clientModLock)
    },
    {
      entryName: 'client-profile.json',
      mediaType: 'application/json',
      content: serializeJson(profile)
    },
    {
      entryName: 'parity-report.json',
      mediaType: 'application/json',
      content: serializeJson(assessed.report)
    },
    {
      entryName: 'verification-checklist.json',
      mediaType: 'application/json',
      content: serializeJson(verificationChecklist)
    }
  ]
}

export function renderClientProfileInstallInstructions(
  profile: ClientProfileDocument,
  excludedCount: number
): string {
  return `# ${profile.displayName} client profile\n\n` +
    `This deterministic profile contains metadata and checks only. It contains no game or mod binaries.\n\n` +
    `## Required runtime\n\n` +
    `- Dyson Sphere Program ${profile.runtime.dsp}\n` +
    `- BepInEx ${profile.runtime.bepInEx}\n` +
    `- Nebula ${profile.runtime.nebula}\n\n` +
    `## Install and verify\n\n` +
    `1. Install the licensed game through its official client.\n` +
    `2. Install the required runtime versions listed above.\n` +
    `3. Install every mod marked required in client-mod-lock.json.\n` +
    `4. Install optional entries only when desired.\n` +
    `5. Do not install the ${excludedCount} server-only entr${excludedCount === 1 ? 'y' : 'ies'} listed as not-required.\n` +
    `6. Compare every installed mod version and SHA-256 with verification-checklist.json.\n` +
    `7. Verify the generated text files with CHECKSUMS.sha256.\n` +
    `8. Join ${profile.connection.displayAddress} through Nebula.\n\n` +
    `Complete any private join prompt inside the game; private join material is intentionally absent.\n`
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function compareClientMods(left: ClientProfileModEntry, right: ClientProfileModEntry): number {
  const requirementOrder = { required: 0, optional: 1 }
  return requirementOrder[left.requirement] - requirementOrder[right.requirement] ||
    compareText(left.sourceId.toLowerCase(), right.sourceId.toLowerCase()) ||
    compareText(left.version, right.version)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function clientProfileArtifactDigest(content: string): string {
  return sha256(content)
}

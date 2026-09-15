import { isIP } from 'node:net'
import { z } from 'zod'
import { clientParityManifestSchema, serverModLockSchema } from '../mods/manifest.js'
import {
  compatibilityMatrixInputSchema,
  runtimeInventoryInputSchema
} from '../updates/compatibility.js'
import { sha256Schema, sourceIdSchema } from '../updates/version.js'

export const MAX_CLIENT_PROFILE_ARTIFACTS = 8
export const MAX_CLIENT_PROFILE_ARTIFACT_BYTES = 512 * 1024
export const MAX_CLIENT_PROFILE_TOTAL_BYTES = 2 * 1024 * 1024
export const MAX_CLIENT_PROFILE_BLOCKERS = 128

export type ClientProfileRequirement = 'required' | 'optional' | 'not-required'

export interface ClientProfileModEntry {
  sourceId: string
  version: string
  sha256: string
  requirement: Exclude<ClientProfileRequirement, 'not-required'>
}

export interface ClientProfileDocument {
  format: 'dyson-control-client-profile'
  schemaVersion: 1
  profileId: string
  displayName: string
  connection: {
    protocol: 'nebula'
    transport: 'direct'
    host: string
    port: number
    displayAddress: string
  }
  runtime: {
    dsp: string
    nebula: string
    bepInEx: string
    compatibilityEntryId: string
  }
  provenance: {
    serverLockSha256: string
    clientParitySha256: string
  }
  mods: {
    required: ClientProfileModEntry[]
    optional: ClientProfileModEntry[]
  }
}

export interface ClientModLockDocument {
  format: 'dyson-control-client-mod-lock'
  schemaVersion: 1
  serverLockSha256: string
  clientParitySha256: string
  mods: ClientProfileModEntry[]
}

export interface ClientProfileBlocker {
  code:
    | 'runtime-incompatible'
    | 'dsp-version-mismatch'
    | 'nebula-version-mismatch'
    | 'bepinex-version-mismatch'
    | 'plugin-missing'
    | 'plugin-version-mismatch'
  compatibilityEntryId: string | null
  sourceId: string | null
  expected: string | null
  actual: string | null
}

export interface ClientParityValidationReport {
  format: 'dyson-control-client-parity-report'
  schemaVersion: 1
  validManifestPair: true
  runtimeCompatible: boolean
  canGenerate: boolean
  matchedCompatibilityEntryId: string | null
  serverLockSha256: string
  clientParitySha256: string
  counts: {
    server: number
    required: number
    optional: number
    notRequired: number
  }
  required: Array<{ sourceId: string; version: string; sha256: string }>
  optional: Array<{ sourceId: string; version: string; sha256: string }>
  notRequired: Array<{ sourceId: string; version: string; reason: 'server-only' }>
  blockers: ClientProfileBlocker[]
  omittedBlockerCount: number
}

export interface ClientVerificationCheck {
  id: string
  category: 'runtime' | 'mod'
  requirement: Exclude<ClientProfileRequirement, 'not-required'>
  sourceId: string | null
  expectedVersion: string
  sha256: string | null
}

export interface ClientVerificationChecklist {
  format: 'dyson-control-client-verification-checklist'
  schemaVersion: 1
  serverLockSha256: string
  checks: ClientVerificationCheck[]
  excluded: Array<{
    sourceId: string
    version: string
    requirement: 'not-required'
    reason: 'server-only'
  }>
}

export interface ClientProfileArtifact {
  entryName: string
  mediaType: 'application/json' | 'text/markdown' | 'text/plain'
  encoding: 'utf8'
  sizeBytes: number
  sha256: string
  content: string
}

export interface GeneratedClientProfile {
  format: 'dyson-control-client-profile-artifact-set'
  schemaVersion: 1
  profile: ClientProfileDocument
  clientModLock: ClientModLockDocument
  parityReport: ClientParityValidationReport
  verificationChecklist: ClientVerificationChecklist
  artifacts: ClientProfileArtifact[]
  artifactSetSha256: string
  totalSizeBytes: number
}

const profileIdSchema = z.string().min(3).max(64).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
const displayNameSchema = z.string().trim().min(1).max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/, 'display name must contain public label characters only')

export const publicServerHostnameSchema = z.string().trim().min(4).max(253)
  .transform((value) => value.toLowerCase())
  .refine(isPublicHostname, 'connection host must be a DNS hostname, not a URL, path, or IP address')

export const publicServerConnectionSchema = z.strictObject({
  host: publicServerHostnameSchema.default('example.com'),
  port: z.number().int().min(1).max(65_535).default(8469)
})

const profileMetadataSchema = z.strictObject({
  profileId: profileIdSchema.default('dyson-example'),
  displayName: displayNameSchema.default('Dyson Control Server'),
  connection: publicServerConnectionSchema.default({ host: 'example.com', port: 8469 })
})

export const clientProfileGenerationInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: profileMetadataSchema.default({
    profileId: 'dyson-example',
    displayName: 'Dyson Control Server',
    connection: { host: 'example.com', port: 8469 }
  }),
  compatibility: z.strictObject({
    inventory: runtimeInventoryInputSchema,
    matrix: compatibilityMatrixInputSchema
  }),
  serverLock: serverModLockSchema,
  clientParity: clientParityManifestSchema
})

export const clientProfileModEntrySchema: z.ZodType<ClientProfileModEntry> = z.strictObject({
  sourceId: sourceIdSchema,
  version: z.string().min(1).max(64),
  sha256: sha256Schema,
  requirement: z.enum(['required', 'optional'])
})

export const clientProfileDocumentSchema: z.ZodType<ClientProfileDocument> = z.strictObject({
  format: z.literal('dyson-control-client-profile'),
  schemaVersion: z.literal(1),
  profileId: profileIdSchema,
  displayName: displayNameSchema,
  connection: z.strictObject({
    protocol: z.literal('nebula'),
    transport: z.literal('direct'),
    host: z.string().min(4).max(253).refine(isPublicHostname),
    port: z.number().int().min(1).max(65_535),
    displayAddress: z.string().min(6).max(260)
  }),
  runtime: z.strictObject({
    dsp: z.string().min(1).max(64),
    nebula: z.string().min(1).max(64),
    bepInEx: z.string().min(1).max(64),
    compatibilityEntryId: z.string().min(1).max(96)
  }),
  provenance: z.strictObject({
    serverLockSha256: sha256Schema,
    clientParitySha256: sha256Schema
  }),
  mods: z.strictObject({
    required: z.array(clientProfileModEntrySchema).max(512),
    optional: z.array(clientProfileModEntrySchema).max(512)
  })
}).superRefine((value, context) => {
  if (value.connection.displayAddress !== `${value.connection.host}:${value.connection.port}`) {
    context.addIssue({ code: 'custom', path: ['connection', 'displayAddress'], message: 'display address mismatch' })
  }
  if (value.mods.required.some((mod) => mod.requirement !== 'required') ||
      value.mods.optional.some((mod) => mod.requirement !== 'optional')) {
    context.addIssue({ code: 'custom', path: ['mods'], message: 'client requirement bucket mismatch' })
  }
})

export const clientModLockDocumentSchema: z.ZodType<ClientModLockDocument> = z.strictObject({
  format: z.literal('dyson-control-client-mod-lock'),
  schemaVersion: z.literal(1),
  serverLockSha256: sha256Schema,
  clientParitySha256: sha256Schema,
  mods: z.array(clientProfileModEntrySchema).max(512)
})

const parityEntrySchema = z.strictObject({
  sourceId: sourceIdSchema,
  version: z.string().min(1).max(64),
  sha256: sha256Schema
})

const clientProfileBlockerSchema: z.ZodType<ClientProfileBlocker> = z.strictObject({
  code: z.enum([
    'runtime-incompatible',
    'dsp-version-mismatch',
    'nebula-version-mismatch',
    'bepinex-version-mismatch',
    'plugin-missing',
    'plugin-version-mismatch'
  ]),
  compatibilityEntryId: z.string().min(1).max(96).nullable(),
  sourceId: sourceIdSchema.nullable(),
  expected: z.string().min(1).max(160).nullable(),
  actual: z.string().min(1).max(64).nullable()
})

export const clientParityValidationReportSchema: z.ZodType<ClientParityValidationReport> = z.strictObject({
  format: z.literal('dyson-control-client-parity-report'),
  schemaVersion: z.literal(1),
  validManifestPair: z.literal(true),
  runtimeCompatible: z.boolean(),
  canGenerate: z.boolean(),
  matchedCompatibilityEntryId: z.string().min(1).max(96).nullable(),
  serverLockSha256: sha256Schema,
  clientParitySha256: sha256Schema,
  counts: z.strictObject({
    server: z.number().int().nonnegative().max(512),
    required: z.number().int().nonnegative().max(512),
    optional: z.number().int().nonnegative().max(512),
    notRequired: z.number().int().nonnegative().max(512)
  }),
  required: z.array(parityEntrySchema).max(512),
  optional: z.array(parityEntrySchema).max(512),
  notRequired: z.array(parityEntrySchema.omit({ sha256: true }).extend({ reason: z.literal('server-only') })).max(512),
  blockers: z.array(clientProfileBlockerSchema).max(MAX_CLIENT_PROFILE_BLOCKERS),
  omittedBlockerCount: z.number().int().nonnegative().max(65_536)
}).superRefine((value, context) => {
  if (value.runtimeCompatible !== value.canGenerate ||
      value.runtimeCompatible !== (value.matchedCompatibilityEntryId !== null) ||
      value.counts.server !== value.counts.required + value.counts.optional + value.counts.notRequired ||
      value.counts.required !== value.required.length || value.counts.optional !== value.optional.length ||
      value.counts.notRequired !== value.notRequired.length) {
    context.addIssue({ code: 'custom', message: 'parity report invariant mismatch' })
  }
})

const verificationCheckSchema: z.ZodType<ClientVerificationCheck> = z.strictObject({
  id: z.string().min(1).max(192),
  category: z.enum(['runtime', 'mod']),
  requirement: z.enum(['required', 'optional']),
  sourceId: sourceIdSchema.nullable(),
  expectedVersion: z.string().min(1).max(64),
  sha256: sha256Schema.nullable()
})

export const clientVerificationChecklistSchema: z.ZodType<ClientVerificationChecklist> = z.strictObject({
  format: z.literal('dyson-control-client-verification-checklist'),
  schemaVersion: z.literal(1),
  serverLockSha256: sha256Schema,
  checks: z.array(verificationCheckSchema).max(515),
  excluded: z.array(z.strictObject({
    sourceId: sourceIdSchema,
    version: z.string().min(1).max(64),
    requirement: z.literal('not-required'),
    reason: z.literal('server-only')
  })).max(512)
})

export const clientProfileArtifactSchema: z.ZodType<ClientProfileArtifact> = z.strictObject({
  entryName: z.string().min(1).max(128),
  mediaType: z.enum(['application/json', 'text/markdown', 'text/plain']),
  encoding: z.literal('utf8'),
  sizeBytes: z.number().int().nonnegative().max(MAX_CLIENT_PROFILE_ARTIFACT_BYTES),
  sha256: sha256Schema,
  content: z.string().max(MAX_CLIENT_PROFILE_ARTIFACT_BYTES)
})

export const generatedClientProfileSchema: z.ZodType<GeneratedClientProfile> = z.strictObject({
  format: z.literal('dyson-control-client-profile-artifact-set'),
  schemaVersion: z.literal(1),
  profile: clientProfileDocumentSchema,
  clientModLock: clientModLockDocumentSchema,
  parityReport: clientParityValidationReportSchema,
  verificationChecklist: clientVerificationChecklistSchema,
  artifacts: z.array(clientProfileArtifactSchema).min(1).max(MAX_CLIENT_PROFILE_ARTIFACTS),
  artifactSetSha256: sha256Schema,
  totalSizeBytes: z.number().int().nonnegative().max(MAX_CLIENT_PROFILE_TOTAL_BYTES)
})

export type ClientProfileGenerationInput = z.input<typeof clientProfileGenerationInputSchema>
export type ParsedClientProfileGenerationInput = z.output<typeof clientProfileGenerationInputSchema>

function isPublicHostname(value: string): boolean {
  if (isIP(value) !== 0 || value.includes('://') || value.includes('/') || value.includes('\\')) return false
  if (value.endsWith('.') || value.toLowerCase() === 'localhost') return false
  const labels = value.split('.')
  if (labels.length < 2) return false
  return labels.every((label) => label.length >= 1 && label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))
}

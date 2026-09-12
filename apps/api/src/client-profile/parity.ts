import {
  serializeClientParityManifest,
  validateModManifestPair,
  type ClientParityEntry,
  type GeneratedModManifests
} from '../mods/manifest.js'
import { evaluateCompatibility, type CompatibilityDecision } from '../updates/compatibility.js'
import { sha256 } from './artifact.js'
import {
  MAX_CLIENT_PROFILE_BLOCKERS,
  clientProfileGenerationInputSchema,
  type ClientParityValidationReport,
  type ClientProfileBlocker,
  type ParsedClientProfileGenerationInput
} from './types.js'

export interface AssessedClientProfileInput {
  input: ParsedClientProfileGenerationInput
  manifests: GeneratedModManifests
  compatibility: CompatibilityDecision
  report: ClientParityValidationReport
}

export function assessClientProfile(input: unknown): AssessedClientProfileInput {
  const parsed = clientProfileGenerationInputSchema.parse(input)
  const manifests = validateModManifestPair(parsed.serverLock, parsed.clientParity)
  const compatibility = evaluateCompatibility(
    parsed.compatibility.inventory,
    parsed.compatibility.matrix
  )
  const clientParitySha256 = sha256(serializeClientParityManifest(manifests.clientParity))
  const classified = classifyEntries(manifests.clientParity.mods)
  const allBlockers = compatibility.compatible ? [] : buildCompatibilityBlockers(compatibility)
  const blockers = allBlockers.slice(0, MAX_CLIENT_PROFILE_BLOCKERS)
  const report: ClientParityValidationReport = {
    format: 'dyson-control-client-parity-report',
    schemaVersion: 1,
    validManifestPair: true,
    runtimeCompatible: compatibility.compatible,
    canGenerate: compatibility.compatible,
    matchedCompatibilityEntryId: compatibility.matchedEntryId,
    serverLockSha256: manifests.serverLockSha256,
    clientParitySha256,
    counts: {
      server: manifests.serverLock.mods.length,
      required: classified.required.length,
      optional: classified.optional.length,
      notRequired: classified.notRequired.length
    },
    required: classified.required.map(toReportEntry),
    optional: classified.optional.map(toReportEntry),
    notRequired: classified.notRequired.map((entry) => ({
      sourceId: entry.sourceId,
      version: entry.version,
      reason: 'server-only'
    })),
    blockers,
    omittedBlockerCount: allBlockers.length - blockers.length
  }
  return { input: parsed, manifests, compatibility, report }
}

function classifyEntries(entries: readonly ClientParityEntry[]): {
  required: ClientParityEntry[]
  optional: ClientParityEntry[]
  notRequired: ClientParityEntry[]
} {
  const sorted = [...entries].sort(compareEntries)
  return {
    required: sorted.filter((entry) => entry.clientRequirement === 'required'),
    optional: sorted.filter((entry) => entry.clientRequirement === 'optional'),
    notRequired: sorted.filter((entry) => entry.clientRequirement === 'not-required')
  }
}

function buildCompatibilityBlockers(decision: CompatibilityDecision): ClientProfileBlocker[] {
  const details = decision.evaluations.flatMap((evaluation) => evaluation.reasons.map((reason) => ({
    code: reason.code,
    compatibilityEntryId: evaluation.entryId,
    sourceId: reason.sourceId,
    expected: reason.expected,
    actual: reason.actual
  } satisfies ClientProfileBlocker)))
  details.sort(compareBlockers)
  if (details.length > 0) return details
  return [{
    code: 'runtime-incompatible',
    compatibilityEntryId: null,
    sourceId: null,
    expected: null,
    actual: null
  }]
}

function toReportEntry(entry: ClientParityEntry): { sourceId: string; version: string; sha256: string } {
  return { sourceId: entry.sourceId, version: entry.version, sha256: entry.sha256 }
}

function compareEntries(left: ClientParityEntry, right: ClientParityEntry): number {
  return compareText(left.sourceId.toLowerCase(), right.sourceId.toLowerCase()) ||
    compareText(left.version, right.version)
}

function compareBlockers(left: ClientProfileBlocker, right: ClientProfileBlocker): number {
  return compareText(left.compatibilityEntryId ?? '', right.compatibilityEntryId ?? '') ||
    compareText(left.code, right.code) || compareText(left.sourceId ?? '', right.sourceId ?? '') ||
    compareText(left.expected ?? '', right.expected ?? '') || compareText(left.actual ?? '', right.actual ?? '')
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

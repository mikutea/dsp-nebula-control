import { z } from 'zod'
import {
  formatVersionRange,
  normalizeVersion,
  normalizeVersionRange,
  sourceIdSchema,
  versionRangeInputSchema,
  versionSatisfies,
  type VersionComponent,
  type VersionRange
} from './version.js'

export interface NormalizedRuntimeInventory {
  dsp: string
  nebula: string
  bepInEx: string
  plugins: Array<{ sourceId: string; version: string }>
}

export type CompatibilityReasonCode =
  | 'dsp-version-mismatch'
  | 'nebula-version-mismatch'
  | 'bepinex-version-mismatch'
  | 'plugin-missing'
  | 'plugin-version-mismatch'

export interface CompatibilityReason {
  code: CompatibilityReasonCode
  component: VersionComponent
  sourceId: string | null
  expected: string
  actual: string | null
}

export interface CompatibilityEntryEvaluation {
  entryId: string
  compatible: boolean
  reasons: CompatibilityReason[]
}

export interface CompatibilityDecision {
  compatible: boolean
  matchedEntryId: string | null
  inventory: NormalizedRuntimeInventory
  evaluations: CompatibilityEntryEvaluation[]
}

export class CompatibilityValidationError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'CompatibilityValidationError'
    this.code = code
  }
}

const runtimePluginSchema = z.strictObject({
  sourceId: sourceIdSchema,
  version: z.string().trim().min(1).max(64)
})

export const runtimeInventoryInputSchema = z.strictObject({
  dsp: z.string().trim().min(1).max(64),
  nebula: z.string().trim().min(1).max(64),
  bepInEx: z.string().trim().min(1).max(64),
  plugins: z.array(runtimePluginSchema).max(256)
})

const compatibilityPluginConstraintSchema = z.strictObject({
  sourceId: sourceIdSchema,
  range: versionRangeInputSchema,
  required: z.boolean()
})

const compatibilityEntrySchema = z.strictObject({
  id: z.string().min(1).max(96).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  core: z.strictObject({
    dsp: versionRangeInputSchema,
    nebula: versionRangeInputSchema,
    bepInEx: versionRangeInputSchema
  }),
  plugins: z.array(compatibilityPluginConstraintSchema).max(256)
})

export const compatibilityMatrixInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  entries: z.array(compatibilityEntrySchema).min(1).max(128)
})

interface NormalizedCompatibilityEntry {
  id: string
  core: { dsp: VersionRange; nebula: VersionRange; bepInEx: VersionRange }
  plugins: Array<{ sourceId: string; range: VersionRange; required: boolean }>
}

export function evaluateCompatibility(inventoryInput: unknown, matrixInput: unknown): CompatibilityDecision {
  const inventory = normalizeInventory(inventoryInput)
  const entries = normalizeMatrix(matrixInput)
  const installedPlugins = new Map(inventory.plugins.map((plugin) => [canonicalSourceId(plugin.sourceId), plugin]))
  const evaluations = entries.map((entry) => evaluateEntry(entry, inventory, installedPlugins))
  const matchedEntry = evaluations.find((evaluation) => evaluation.compatible)
  return {
    compatible: matchedEntry !== undefined,
    matchedEntryId: matchedEntry?.entryId ?? null,
    inventory,
    evaluations
  }
}

export function normalizeInventory(input: unknown): NormalizedRuntimeInventory {
  const parsed = runtimeInventoryInputSchema.parse(input)
  const plugins = parsed.plugins.map((plugin) => ({
    sourceId: plugin.sourceId,
    version: normalizeVersion(plugin.version, 'plugin')
  })).sort((left, right) => compareText(canonicalSourceId(left.sourceId), canonicalSourceId(right.sourceId)))
  assertUnique(plugins.map((plugin) => canonicalSourceId(plugin.sourceId)), 'RUNTIME_PLUGIN_DUPLICATE')
  return {
    dsp: normalizeVersion(parsed.dsp, 'dsp'),
    nebula: normalizeVersion(parsed.nebula, 'nebula'),
    bepInEx: normalizeVersion(parsed.bepInEx, 'bepinex'),
    plugins
  }
}

function normalizeMatrix(input: unknown): NormalizedCompatibilityEntry[] {
  const parsed = compatibilityMatrixInputSchema.parse(input)
  assertUnique(parsed.entries.map((entry) => entry.id), 'COMPATIBILITY_ENTRY_DUPLICATE')
  return parsed.entries.map((entry) => {
    const plugins = entry.plugins.map((plugin) => ({
      sourceId: plugin.sourceId,
      range: normalizeVersionRange(plugin.range, 'plugin'),
      required: plugin.required
    })).sort((left, right) => compareText(canonicalSourceId(left.sourceId), canonicalSourceId(right.sourceId)))
    assertUnique(plugins.map((plugin) => canonicalSourceId(plugin.sourceId)), 'COMPATIBILITY_PLUGIN_DUPLICATE')
    return {
      id: entry.id,
      core: {
        dsp: normalizeVersionRange(entry.core.dsp, 'dsp'),
        nebula: normalizeVersionRange(entry.core.nebula, 'nebula'),
        bepInEx: normalizeVersionRange(entry.core.bepInEx, 'bepinex')
      },
      plugins
    }
  }).sort((left, right) => compareText(left.id, right.id))
}

function evaluateEntry(
  entry: NormalizedCompatibilityEntry,
  inventory: NormalizedRuntimeInventory,
  installedPlugins: ReadonlyMap<string, { sourceId: string; version: string }>
): CompatibilityEntryEvaluation {
  const reasons: CompatibilityReason[] = []
  checkCore('dsp', entry.core.dsp, inventory.dsp, reasons)
  checkCore('nebula', entry.core.nebula, inventory.nebula, reasons)
  checkCore('bepinex', entry.core.bepInEx, inventory.bepInEx, reasons)
  for (const constraint of entry.plugins) {
    const installed = installedPlugins.get(canonicalSourceId(constraint.sourceId))
    if (installed === undefined) {
      if (constraint.required) {
        reasons.push({
          code: 'plugin-missing', component: 'plugin', sourceId: constraint.sourceId,
          expected: formatVersionRange(constraint.range, 'plugin'), actual: null
        })
      }
      continue
    }
    if (!versionSatisfies(installed.version, constraint.range, 'plugin')) {
      reasons.push({
        code: 'plugin-version-mismatch', component: 'plugin', sourceId: constraint.sourceId,
        expected: formatVersionRange(constraint.range, 'plugin'), actual: installed.version
      })
    }
  }
  return { entryId: entry.id, compatible: reasons.length === 0, reasons }
}

function checkCore(
  component: Exclude<VersionComponent, 'plugin'>,
  range: VersionRange,
  actual: string,
  reasons: CompatibilityReason[]
): void {
  if (versionSatisfies(actual, range, component)) return
  reasons.push({
    code: `${component === 'bepinex' ? 'bepinex' : component}-version-mismatch`,
    component,
    sourceId: null,
    expected: formatVersionRange(range, component),
    actual
  })
}

function assertUnique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) throw new CompatibilityValidationError(code)
}

function canonicalSourceId(value: string): string {
  return value.toLowerCase()
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

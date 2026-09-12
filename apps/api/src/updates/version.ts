import { z } from 'zod'

export type VersionComponent = 'dsp' | 'nebula' | 'bepinex' | 'plugin'

export interface ParsedVersion {
  normalized: string
  core: readonly number[]
  prerelease: readonly string[]
  build: readonly string[]
}

export interface VersionRange {
  equals?: string
  minInclusive?: string
  maxExclusive?: string
}

export class VersionValidationError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'VersionValidationError'
    this.code = code
  }
}

const versionPattern = /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/i
const maximumVersionSegment = 2_147_483_647
const versionTextSchema = z.string().trim().min(1).max(64)

export const sourceIdSchema = z.string().min(3).max(160).regex(
  /^[a-z][a-z0-9+.-]{1,31}:[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,63})?$/,
  'source ID must use a bounded provider:name or provider:namespace/name form'
)

export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/i, 'SHA-256 must contain 64 hexadecimal characters')

export const versionRangeInputSchema = z.strictObject({
  equals: versionTextSchema.optional(),
  minInclusive: versionTextSchema.optional(),
  maxExclusive: versionTextSchema.optional()
}).superRefine((value, context) => {
  const hasEquals = value.equals !== undefined
  const hasBounds = value.minInclusive !== undefined || value.maxExclusive !== undefined
  if (!hasEquals && !hasBounds) {
    context.addIssue({ code: 'custom', message: 'a version range must define equals or a bound' })
  }
  if (hasEquals && hasBounds) {
    context.addIssue({ code: 'custom', message: 'equals cannot be combined with range bounds' })
  }
})

export function parseVersion(input: unknown, component: VersionComponent): ParsedVersion {
  const value = versionTextSchema.parse(input)
  const match = versionPattern.exec(value)
  if (!match) throw new VersionValidationError('VERSION_FORMAT_INVALID')

  const core = match.slice(1, 5).filter((segment): segment is string => segment !== undefined).map(parseSegment)
  const requiredCoreLength = component === 'dsp' ? 4 : undefined
  if (requiredCoreLength !== undefined && core.length !== requiredCoreLength) {
    throw new VersionValidationError('VERSION_COMPONENT_COUNT_INVALID')
  }

  const prerelease = splitIdentifiers(match[5])
  const build = splitIdentifiers(match[6])
  validatePrerelease(prerelease)

  const normalizedCore = core.join('.')
  const normalizedPrerelease = prerelease.length > 0 ? `-${prerelease.join('.')}` : ''
  const normalizedBuild = build.length > 0 ? `+${build.join('.')}` : ''
  return Object.freeze({
    normalized: `${normalizedCore}${normalizedPrerelease}${normalizedBuild}`,
    core: Object.freeze(core),
    prerelease: Object.freeze(prerelease),
    build: Object.freeze(build)
  })
}

export function normalizeVersion(input: unknown, component: VersionComponent): string {
  return parseVersion(input, component).normalized
}

export function compareVersions(
  left: unknown,
  right: unknown,
  component: VersionComponent
): -1 | 0 | 1 {
  const parsedLeft = parseVersion(left, component)
  const parsedRight = parseVersion(right, component)
  const coreLength = Math.max(parsedLeft.core.length, parsedRight.core.length)
  for (let index = 0; index < coreLength; index++) {
    const difference = (parsedLeft.core[index] ?? 0) - (parsedRight.core[index] ?? 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease)
}

export function normalizeVersionRange(input: unknown, component: VersionComponent): VersionRange {
  const parsed = versionRangeInputSchema.parse(input)
  const normalized: VersionRange = {}
  if (parsed.equals !== undefined) normalized.equals = normalizeVersion(parsed.equals, component)
  if (parsed.minInclusive !== undefined) normalized.minInclusive = normalizeVersion(parsed.minInclusive, component)
  if (parsed.maxExclusive !== undefined) normalized.maxExclusive = normalizeVersion(parsed.maxExclusive, component)
  if (normalized.minInclusive !== undefined && normalized.maxExclusive !== undefined &&
      compareVersions(normalized.minInclusive, normalized.maxExclusive, component) >= 0) {
    throw new VersionValidationError('VERSION_RANGE_EMPTY')
  }
  return Object.freeze(normalized)
}

export function versionSatisfies(
  version: unknown,
  rangeInput: unknown,
  component: VersionComponent
): boolean {
  const normalizedVersion = normalizeVersion(version, component)
  const range = normalizeVersionRange(rangeInput, component)
  if (range.equals !== undefined) return compareVersions(normalizedVersion, range.equals, component) === 0
  if (range.minInclusive !== undefined && compareVersions(normalizedVersion, range.minInclusive, component) < 0) {
    return false
  }
  if (range.maxExclusive !== undefined && compareVersions(normalizedVersion, range.maxExclusive, component) >= 0) {
    return false
  }
  return true
}

export function formatVersionRange(rangeInput: unknown, component: VersionComponent): string {
  const range = normalizeVersionRange(rangeInput, component)
  if (range.equals !== undefined) return `=${range.equals}`
  return [
    range.minInclusive === undefined ? undefined : `>=${range.minInclusive}`,
    range.maxExclusive === undefined ? undefined : `<${range.maxExclusive}`
  ].filter((value): value is string => value !== undefined).join(' ')
}

function parseSegment(segment: string): number {
  if (segment.length > 10) throw new VersionValidationError('VERSION_SEGMENT_INVALID')
  const parsed = Number(segment)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumVersionSegment) {
    throw new VersionValidationError('VERSION_SEGMENT_INVALID')
  }
  return parsed
}

function splitIdentifiers(value: string | undefined): string[] {
  return value === undefined ? [] : value.split('.')
}

function validatePrerelease(identifiers: readonly string[]): void {
  for (const identifier of identifiers) {
    if (/^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0')) {
      throw new VersionValidationError('VERSION_PRERELEASE_INVALID')
    }
  }
}

function comparePrerelease(left: readonly string[], right: readonly string[]): -1 | 0 | 1 {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index++) {
    const leftPart = left[index]
    const rightPart = right[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) {
      if (leftPart.length !== rightPart.length) return leftPart.length < rightPart.length ? -1 : 1
      return leftPart < rightPart ? -1 : 1
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

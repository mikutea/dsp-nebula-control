import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const evidenceScopes = [
  'repository-unit',
  'repository-integration',
  'local-windows',
  'release',
  'dyson-side-by-side',
  'production',
  'external-client',
  'cutover'
]

const allowedPriorities = new Set(['P0', 'P1', 'P2'])
const allowedStates = new Set(['not-started', 'implemented', 'verified'])
const allowedEvidenceKinds = new Set([
  'implementation', 'contract', 'automated-test', 'api-test', 'integration-test',
  'host-script-test', 'cross-runtime-test', 'self-test', 'browser-test',
  'release-scan', 'clean-host-run', 'operator-run', 'external-client-run',
  'soak-report', 'backup-manifest', 'rollback-drill', 'private-proof'
])
const proofKinds = new Set([
  'automated-test', 'api-test', 'integration-test', 'host-script-test',
  'cross-runtime-test', 'self-test', 'browser-test', 'release-scan',
  'clean-host-run', 'operator-run', 'external-client-run', 'soak-report',
  'backup-manifest', 'rollback-drill', 'private-proof'
])
const privateScopes = new Set(['dyson-side-by-side', 'production', 'external-client', 'cutover'])
const requiredAreas = new Set([
  'security', 'lifecycle', 'saves', 'updates', 'mods', 'players', 'console',
  'configuration', 'server', 'client', 'opensource', 'production', 'cutover'
])
const scopeRank = new Map(evidenceScopes.map((scope, index) => [scope, index]))
const commitPattern = /^[0-9a-f]{40}$/
const sha256Pattern = /^[0-9a-f]{64}$/
const evidenceIdPattern = /^[a-z0-9](?:[a-z0-9._-]{6,126}[a-z0-9])$/
const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/
const requirementIdPattern = /^[A-Z]{3}-\d{3}$/
const acceptanceEvidenceIndexProtocol = 'DYSON_ACCEPTANCE_EVIDENCE_INDEX_V1'
const maximumEvidenceIndexBytes = 64 * 1024
const maximumEvidenceIndexRequirements = 64
const evidenceIndexTopLevelKeys = ['protocol', 'schemaVersion', 'evidence']
const evidenceIndexMetadataKeys = [
  'evidenceId', 'kind', 'scope', 'subjectCommit', 'runtimePayloadSha256',
  'opaqueId', 'sha256', 'observedAt', 'requirementIds'
]
const mirroredEvidenceFields = [
  'evidenceId', 'kind', 'scope', 'subjectCommit', 'runtimePayloadSha256',
  'opaqueId', 'sha256', 'observedAt'
]
const repositoryEvidenceKeys = ['kind', 'ref']
const versionedEvidenceKeys = [...mirroredEvidenceFields, 'ref']
const versionedEvidenceFields = [
  'evidenceId', 'scope', 'subjectCommit', 'runtimePayloadSha256',
  'opaqueId', 'sha256', 'observedAt'
]
const releasePolicyKeys = [
  'blockingPriorities', 'productionEvidenceLivesOutsideRepository', 'releaseReadyState'
]
const requiredBlockingPriorities = ['P0', 'P1']

export function validateAcceptanceManifest(manifest, options) {
  const repositoryRoot = path.resolve(options.repositoryRoot)
  const releaseCommit = options.releaseCommit ?? null
  const artifactPayloadSha256 = options.artifactPayloadSha256 ?? null
  const requireReleaseReady = options.requireReleaseReady === true
  const errors = []

  if (manifest.schemaVersion !== 1) errors.push('schemaVersion must be 1')
  if (!Array.isArray(manifest.requirements) || manifest.requirements.length === 0) {
    errors.push('requirements must be a non-empty array')
  }
  if (!isPlainObject(manifest.releasePolicy) ||
      !hasExactKeys(manifest.releasePolicy, releasePolicyKeys) ||
      !Array.isArray(manifest.releasePolicy.blockingPriorities) ||
      manifest.releasePolicy.blockingPriorities.length !== requiredBlockingPriorities.length ||
      manifest.releasePolicy.blockingPriorities.some((priority, index) =>
        priority !== requiredBlockingPriorities[index]) ||
      manifest.releasePolicy.releaseReadyState !== 'verified' ||
      manifest.releasePolicy.productionEvidenceLivesOutsideRepository !== true) {
    errors.push('releasePolicy is invalid')
  }
  if (releaseCommit !== null && !commitPattern.test(releaseCommit)) {
    errors.push('release commit must be an exact lowercase 40-character Git commit')
  }
  if (artifactPayloadSha256 !== null && !sha256Pattern.test(artifactPayloadSha256)) {
    errors.push('artifact payload must be an exact lowercase SHA-256')
  }
  if (requireReleaseReady && releaseCommit === null) {
    errors.push('release-ready validation requires --release-commit')
  }
  if (requireReleaseReady && artifactPayloadSha256 === null) {
    errors.push('release-ready validation requires --artifact-manifest')
  }

  const ids = new Set()
  const evidenceDeclarations = new Map()
  const evidenceIndexCache = new Map()
  const qualifyingSubjectCommits = new Set()
  const observedAreas = new Set()
  for (const [index, requirement] of (manifest.requirements ?? []).entries()) {
    const label = requirement.id ?? `requirements[${index}]`
    if (!/^[A-Z]{3}-\d{3}$/.test(requirement.id ?? '')) errors.push(`${label}: invalid id`)
    if (ids.has(requirement.id)) errors.push(`${label}: duplicate id`)
    ids.add(requirement.id)

    if (typeof requirement.area !== 'string' || requirement.area.length === 0) {
      errors.push(`${label}: area is required`)
    } else {
      observedAreas.add(requirement.area)
    }
    if (!allowedPriorities.has(requirement.priority)) errors.push(`${label}: invalid priority`)
    if (!allowedStates.has(requirement.state)) errors.push(`${label}: invalid state`)
    if (typeof requirement.title !== 'string' || requirement.title.length < 4) errors.push(`${label}: title is required`)
    if (typeof requirement.criterion !== 'string' || requirement.criterion.length < 20) errors.push(`${label}: criterion is too short`)
    if (!Array.isArray(requirement.evidence)) errors.push(`${label}: evidence must be an array`)

    const minimumScope = minimumEvidenceScope(requirement)
    const qualifyingEvidence = []
    const requirementEvidenceIds = new Set()
    for (const evidence of requirement.evidence ?? []) {
      if (!isPlainObject(evidence)) {
        errors.push(`${label}: evidence entry must be an object`)
        continue
      }
      if (typeof evidence.kind !== 'string' || !allowedEvidenceKinds.has(evidence.kind)) {
        errors.push(`${label}: invalid evidence kind`)
        continue
      }
      const evidenceErrorCount = errors.length
      if (evidence.expiresAt !== undefined) {
        errors.push(`${label}: expiresAt is unsupported by the versioned public evidence contract`)
      }
      const isVersioned = versionedEvidenceFields.some((field) => evidence[field] !== undefined) ||
        parsePublicEvidenceIndexRef(evidence.ref) !== null
      const expectedEvidenceKeys = isVersioned ? versionedEvidenceKeys : repositoryEvidenceKeys
      if (!hasExactKeys(evidence, expectedEvidenceKeys)) {
        errors.push(`${label}: evidence entry has unsupported or missing fields`)
      }
      if (!isVersioned) {
        if (typeof evidence.ref === 'string') {
          validateRepositoryReference(evidence.ref, repositoryRoot, label, errors)
        } else {
          errors.push(`${label}: non-private evidence requires a repository ref`)
        }
        continue
      }

      if (!isSafePublicEvidenceId(evidence.evidenceId)) {
        errors.push(`${label}: invalid evidenceId`)
      } else if (requirementEvidenceIds.has(evidence.evidenceId)) {
        errors.push(`${label}: duplicate evidenceId ${evidence.evidenceId}`)
      } else {
        requirementEvidenceIds.add(evidence.evidenceId)
        const existing = evidenceDeclarations.get(evidence.evidenceId)
        if (existing !== undefined && !evidenceDeclarationsMatch(existing, evidence)) {
          errors.push(`${label}: conflicting metadata for evidenceId ${evidence.evidenceId}`)
        } else if (existing === undefined) {
          evidenceDeclarations.set(evidence.evidenceId, evidence)
        }
      }
      if (!scopeRank.has(evidence.scope)) errors.push(`${label}: invalid evidence scope`)
      if (!commitPattern.test(evidence.subjectCommit ?? '')) {
        errors.push(`${label}: versioned evidence requires an exact lowercase subjectCommit`)
      }
      if (!sha256Pattern.test(evidence.runtimePayloadSha256 ?? '')) {
        errors.push(`${label}: versioned evidence requires an exact lowercase runtimePayloadSha256`)
      }
      const evidenceClass = privateScopes.has(evidence.scope) ? 'private evidence' : 'versioned evidence'
      if (!opaqueIdPattern.test(evidence.opaqueId ?? '')) errors.push(`${label}: ${evidenceClass} requires an opaqueId`)
      if (!sha256Pattern.test(evidence.sha256 ?? '')) errors.push(`${label}: ${evidenceClass} requires a lowercase SHA-256`)
      if (!isIsoDate(evidence.observedAt)) errors.push(`${label}: ${evidenceClass} requires observedAt`)
      const indexValid = validateEvidenceIndexReference(
        evidence, requirement.id, repositoryRoot, label, errors, evidenceIndexCache
      )
      if (errors.length === evidenceErrorCount && indexValid &&
          proofKinds.has(evidence.kind) && scopeSatisfies(evidence.scope, minimumScope)) {
        qualifyingEvidence.push(evidence)
        if (commitPattern.test(evidence.subjectCommit ?? '')) {
          qualifyingSubjectCommits.add(evidence.subjectCommit)
        }
      }
    }

    if (requirement.state === 'verified') {
      if (requirement.evidence?.length === 0) errors.push(`${label}: verified requirements need evidence`)
      if (qualifyingEvidence.length === 0) {
        errors.push(`${label}: verified requirement needs versioned ${minimumScope} proof evidence`)
      }
      if (artifactPayloadSha256 !== null &&
          !qualifyingEvidence.some((evidence) => evidence.runtimePayloadSha256 === artifactPayloadSha256)) {
        errors.push(`${label}: no qualifying evidence is bound to runtime payload ${artifactPayloadSha256}`)
      }
    }
  }

  for (const area of requiredAreas) {
    if (!observedAreas.has(area)) errors.push(`required area is missing: ${area}`)
  }

  const counts = Object.fromEntries([...allowedStates].map((state) => [
    state,
    (manifest.requirements ?? []).filter((requirement) => requirement.state === state).length
  ]))
  const blockingPriorities = new Set(requiredBlockingPriorities)
  const blockers = (manifest.requirements ?? []).filter((requirement) =>
    blockingPriorities.has(requirement.priority) &&
    requirement.state !== 'verified'
  )
  return { errors, counts, blockers, observedAreas, qualifyingSubjectCommits }
}

export function validateEvidenceCommitBoundary(repositoryRoot, subjectCommit, releaseCommit) {
  if (!commitPattern.test(subjectCommit) || !commitPattern.test(releaseCommit)) {
    return ['evidence commit boundary requires exact lowercase commits']
  }
  const root = path.resolve(repositoryRoot)
  const safeRoot = root.replaceAll('\\', '/')
  const ancestor = spawnSync('git', [
    '-c', `safe.directory=${safeRoot}`, 'merge-base', '--is-ancestor', subjectCommit, releaseCommit
  ], { cwd: root, encoding: 'utf8', windowsHide: true })
  if (ancestor.status !== 0) return ['the evidence subject commit is not an ancestor of the release commit']
  const diff = spawnSync('git', [
    '-c', `safe.directory=${safeRoot}`, 'diff', '--name-only',
    `${subjectCommit}..${releaseCommit}`
  ], { cwd: root, encoding: 'utf8', windowsHide: true })
  if (diff.status !== 0) return ['the evidence-only release diff could not be verified']
  const paths = diff.stdout.split(/\r?\n/).filter(Boolean)
  const disallowed = paths.filter((candidate) => !isAllowedEvidenceOnlyPath(candidate))
  return disallowed.length === 0
    ? []
    : [`release commit changes non-evidence paths after subject commit: ${disallowed.join(', ')}`]
}

export function isAllowedEvidenceOnlyPath(candidate) {
  return candidate === 'acceptance/manifest.json' ||
    candidate === 'docs/ACCEPTANCE.md' ||
    parsePublicEvidenceIndexRef(candidate) !== null
}

export function minimumEvidenceScope(requirement) {
  if (requirement.id?.startsWith('CUT-')) return 'cutover'
  if (requirement.id === 'PRD-003' || requirement.id === 'PRD-004') return 'external-client'
  if (requirement.id === 'PRD-005' || requirement.id === 'SAV-005') return 'production'
  if (requirement.id === 'OSS-003') return 'release'
  if (requirement.priority === 'P0' || requirement.priority === 'P1') return 'dyson-side-by-side'
  return 'repository-integration'
}

function scopeSatisfies(actual, minimum) {
  const actualRank = scopeRank.get(actual)
  const minimumRank = scopeRank.get(minimum)
  return actualRank !== undefined && minimumRank !== undefined && actualRank >= minimumRank
}

function validateEvidenceIndexReference(
  evidence,
  requirementId,
  repositoryRoot,
  label,
  errors,
  cache
) {
  const referencedId = parsePublicEvidenceIndexRef(evidence.ref)
  if (referencedId === null) {
    errors.push(`${label}: versioned evidence ref must be acceptance/evidence/<safe-evidenceId>.json`)
    return false
  }
  if (referencedId !== evidence.evidenceId) {
    errors.push(`${label}: versioned evidence ref does not match evidenceId ${evidence.evidenceId ?? ''}`)
    return false
  }

  let cached = cache.get(evidence.ref)
  if (cached === undefined) {
    try {
      cached = { index: readAcceptanceEvidenceIndex(repositoryRoot, evidence.ref), error: null }
    } catch (error) {
      cached = {
        index: null,
        error: error instanceof EvidenceIndexError ? error.message : 'evidence index could not be read safely'
      }
    }
    cache.set(evidence.ref, cached)
  }
  if (cached.error !== null || cached.index === null) {
    errors.push(`${label}: ${cached.error}`)
    return false
  }

  let matches = true
  for (const field of mirroredEvidenceFields) {
    if (evidence[field] !== cached.index.evidence[field]) {
      errors.push(`${label}: ${field} does not match public evidence index`)
      matches = false
    }
  }
  if (!cached.index.evidence.requirementIds.includes(requirementId)) {
    errors.push(`${label}: public evidence index does not include requirement ${requirementId}`)
    matches = false
  }
  return matches
}

function readAcceptanceEvidenceIndex(repositoryRoot, ref) {
  const root = path.resolve(repositoryRoot)
  const candidate = path.resolve(root, ...ref.split('/'))
  const relative = path.relative(root, candidate)
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new EvidenceIndexError('evidence index path escapes the repository')
  }

  let current = root
  for (const [index, segment] of ref.split('/').entries()) {
    current = path.join(current, segment)
    let stats
    try {
      stats = fs.lstatSync(current)
    } catch {
      throw new EvidenceIndexError(`evidence index path does not exist: ${ref}`)
    }
    if (stats.isSymbolicLink() || (typeof stats.reparseTag === 'number' && stats.reparseTag !== 0)) {
      throw new EvidenceIndexError(`evidence index path is redirected: ${ref}`)
    }
    const finalSegment = index === ref.split('/').length - 1
    if ((!finalSegment && !stats.isDirectory()) || (finalSegment && !stats.isFile())) {
      throw new EvidenceIndexError(`evidence index path has an invalid type: ${ref}`)
    }
  }

  let realRoot
  let realCandidate
  try {
    realRoot = fs.realpathSync.native(root)
    realCandidate = fs.realpathSync.native(candidate)
  } catch {
    throw new EvidenceIndexError(`evidence index path could not be resolved: ${ref}`)
  }
  const realRelative = path.relative(realRoot, realCandidate)
  if (realRelative === '' || realRelative === '..' || realRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(realRelative)) {
    throw new EvidenceIndexError(`evidence index path escapes the repository: ${ref}`)
  }

  let descriptor
  try {
    const noFollow = fs.constants.O_NOFOLLOW ?? 0
    descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | noFollow)
    const stats = fs.fstatSync(descriptor)
    if (!stats.isFile() || stats.size < 1 || stats.size > maximumEvidenceIndexBytes) {
      throw new EvidenceIndexError(`evidence index size is invalid: ${ref}`)
    }
    const bytes = fs.readFileSync(descriptor)
    if (bytes.length !== stats.size || bytes.length > maximumEvidenceIndexBytes) {
      throw new EvidenceIndexError(`evidence index size changed while reading: ${ref}`)
    }
    const text = bytes.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(bytes)) {
      throw new EvidenceIndexError(`evidence index is not valid UTF-8: ${ref}`)
    }
    return validateAcceptanceEvidenceIndex(parseStrictJson(text))
  } catch (error) {
    if (error instanceof EvidenceIndexError) throw error
    throw new EvidenceIndexError(`evidence index could not be read safely: ${ref}`)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

function validateAcceptanceEvidenceIndex(index) {
  if (!hasExactKeys(index, evidenceIndexTopLevelKeys)) {
    throw new EvidenceIndexError('evidence index has unsupported top-level fields')
  }
  if (index.protocol !== acceptanceEvidenceIndexProtocol || index.schemaVersion !== 1) {
    throw new EvidenceIndexError('evidence index protocol or schemaVersion is invalid')
  }
  if (!hasExactKeys(index.evidence, evidenceIndexMetadataKeys)) {
    throw new EvidenceIndexError('evidence index metadata has unsupported fields')
  }

  const evidence = index.evidence
  if (!isSafePublicEvidenceId(evidence.evidenceId)) {
    throw new EvidenceIndexError('evidence index evidenceId is invalid')
  }
  if (!allowedEvidenceKinds.has(evidence.kind)) {
    throw new EvidenceIndexError('evidence index kind is invalid')
  }
  if (!scopeRank.has(evidence.scope)) {
    throw new EvidenceIndexError('evidence index scope is invalid')
  }
  if (!commitPattern.test(evidence.subjectCommit ?? '')) {
    throw new EvidenceIndexError('evidence index subjectCommit is invalid')
  }
  if (!sha256Pattern.test(evidence.runtimePayloadSha256 ?? '') ||
      !sha256Pattern.test(evidence.sha256 ?? '')) {
    throw new EvidenceIndexError('evidence index digest is invalid')
  }
  if (!opaqueIdPattern.test(evidence.opaqueId ?? '') ||
      (privateScopes.has(evidence.scope) && evidence.opaqueId !== `private:${evidence.evidenceId}`)) {
    throw new EvidenceIndexError('evidence index opaqueId is invalid')
  }
  if (!isIsoDate(evidence.observedAt)) {
    throw new EvidenceIndexError('evidence index observedAt is invalid')
  }
  if (!Array.isArray(evidence.requirementIds) || evidence.requirementIds.length < 1 ||
      evidence.requirementIds.length > maximumEvidenceIndexRequirements ||
      evidence.requirementIds.some((requirementId) => !requirementIdPattern.test(requirementId))) {
    throw new EvidenceIndexError('evidence index requirementIds are invalid')
  }
  const canonicalRequirementIds = [...new Set(evidence.requirementIds)].sort(compareOrdinal)
  if (canonicalRequirementIds.length !== evidence.requirementIds.length ||
      canonicalRequirementIds.some((requirementId, index) => requirementId !== evidence.requirementIds[index])) {
    throw new EvidenceIndexError('evidence index requirementIds are duplicate or non-canonical')
  }
  return index
}

function parsePublicEvidenceIndexRef(ref) {
  if (typeof ref !== 'string' || ref.includes('\\') || ref.includes('\0') ||
      ref.length > 180 || path.posix.normalize(ref) !== ref) {
    return null
  }
  const match = /^acceptance\/evidence\/([^/]+)\.json$/.exec(ref)
  return match !== null && isSafePublicEvidenceId(match[1]) ? match[1] : null
}

function isSafePublicEvidenceId(value) {
  if (typeof value !== 'string' || !evidenceIdPattern.test(value) || value.includes('..')) return false
  const windowsStem = value.split('.')[0]
  return !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(windowsStem)
}

function hasExactKeys(value, expectedKeys) {
  if (!isPlainObject(value)) return false
  const actual = Object.keys(value).sort(compareOrdinal)
  const expected = [...expectedKeys].sort(compareOrdinal)
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function evidenceDeclarationsMatch(left, right) {
  return left.ref === right.ref && mirroredEvidenceFields.every((field) => left[field] === right[field])
}

class EvidenceIndexError extends Error {}

function parseStrictJson(text) {
  let offset = 0
  let nodes = 0
  const fail = () => { throw new EvidenceIndexError('evidence index is invalid strict JSON') }
  const skipWhitespace = () => {
    while (offset < text.length && /[\u0009\u000a\u000d\u0020]/.test(text[offset])) offset++
  }
  const parseString = () => {
    const start = offset
    if (text[offset] !== '"') fail()
    offset++
    while (offset < text.length) {
      const code = text.charCodeAt(offset)
      if (code === 0x22) {
        offset++
        try { return JSON.parse(text.slice(start, offset)) }
        catch { fail() }
      }
      if (code < 0x20) fail()
      if (code === 0x5c) {
        offset += 2
        if (offset > text.length) fail()
      } else {
        offset++
      }
    }
    fail()
  }
  const parseValue = (depth) => {
    nodes++
    if (nodes > 4_096 || depth > 16) fail()
    skipWhitespace()
    const character = text[offset]
    if (character === '{') return parseObject(depth + 1)
    if (character === '[') return parseArray(depth + 1)
    if (character === '"') return parseString()
    for (const [literal, value] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, offset)) {
        offset += literal.length
        return value
      }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(offset))?.[0]
    if (number === undefined) fail()
    offset += number.length
    const value = Number(number)
    if (!Number.isFinite(value)) fail()
    return value
  }
  const parseObject = (depth) => {
    const value = Object.create(null)
    const keys = new Set()
    offset++
    skipWhitespace()
    if (text[offset] === '}') {
      offset++
      return value
    }
    while (offset < text.length) {
      skipWhitespace()
      const key = parseString()
      if (keys.has(key)) fail()
      keys.add(key)
      skipWhitespace()
      if (text[offset] !== ':') fail()
      offset++
      value[key] = parseValue(depth)
      skipWhitespace()
      if (text[offset] === '}') {
        offset++
        return value
      }
      if (text[offset] !== ',') fail()
      offset++
    }
    fail()
  }
  const parseArray = (depth) => {
    const value = []
    offset++
    skipWhitespace()
    if (text[offset] === ']') {
      offset++
      return value
    }
    while (offset < text.length) {
      value.push(parseValue(depth))
      skipWhitespace()
      if (text[offset] === ']') {
        offset++
        return value
      }
      if (text[offset] !== ',') fail()
      offset++
    }
    fail()
  }

  const value = parseValue(0)
  skipWhitespace()
  if (offset !== text.length) fail()
  return value
}

function validateRepositoryReference(ref, repositoryRoot, label, errors) {
  if (ref.includes('\\') || path.isAbsolute(ref) || ref.startsWith('..')) {
    errors.push(`${label}: evidence references must be repository-relative POSIX paths`)
    return
  }
  const evidencePath = path.resolve(repositoryRoot, ref)
  const relative = path.relative(repositoryRoot, evidencePath)
  if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(evidencePath)) {
    errors.push(`${label}: evidence path does not exist: ${ref}`)
  }
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false
  }
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}

function argumentValue(argumentsList, name) {
  const index = argumentsList.indexOf(name)
  return index === -1 ? null : argumentsList[index + 1] ?? null
}

function runCli() {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const manifestPath = path.join(repositoryRoot, 'acceptance', 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const argumentsList = process.argv.slice(2)
  const argumentsSet = new Set(argumentsList)
  const releaseCommit = argumentValue(argumentsList, '--release-commit')
  const artifactManifestPath = argumentValue(argumentsList, '--artifact-manifest')
  let artifactPayloadSha256 = null
  const preflightErrors = []
  if (artifactManifestPath !== null) {
    try {
      const artifactManifest = JSON.parse(fs.readFileSync(path.resolve(artifactManifestPath), 'utf8'))
      if (artifactManifest.protocol !== 'DYSON_CONTROL_RELEASE_ARTIFACT_V1' ||
          !sha256Pattern.test(artifactManifest.payloadSha256 ?? '')) {
        preflightErrors.push('artifact manifest is not a valid Dyson Control release artifact')
      } else {
        artifactPayloadSha256 = artifactManifest.payloadSha256
      }
    } catch {
      preflightErrors.push('artifact manifest could not be read')
    }
  }
  const result = validateAcceptanceManifest(manifest, {
    repositoryRoot,
    releaseCommit,
    artifactPayloadSha256,
    requireReleaseReady: argumentsSet.has('--require-release-ready')
  })

  result.errors.unshift(...preflightErrors)
  if (argumentsSet.has('--require-release-ready') && result.blockers.length === 0 && result.errors.length === 0) {
    if (result.qualifyingSubjectCommits.size !== 1) {
      result.errors.push('release-ready evidence must identify one exact subject commit')
    } else {
      const [subjectCommit] = result.qualifyingSubjectCommits
      result.errors.push(...validateEvidenceCommitBoundary(repositoryRoot, subjectCommit, releaseCommit))
    }
  }

  if (result.errors.length > 0) {
    console.error('Acceptance manifest validation failed:')
    for (const error of result.errors) console.error(`- ${error}`)
    process.exit(1)
  }

  console.log(`Acceptance manifest valid: ${manifest.requirements.length} requirements; ${result.counts.verified} verified, ${result.counts.implemented} implemented, ${result.counts['not-started']} not started.`)
  if (argumentsSet.has('--summary')) {
    const byArea = [...result.observedAreas].sort().map((area) => {
      const requirements = manifest.requirements.filter((requirement) => requirement.area === area)
      const verified = requirements.filter((requirement) => requirement.state === 'verified').length
      return { area, verified, total: requirements.length }
    })
    console.log(JSON.stringify({ counts: result.counts, releaseBlockers: result.blockers.length, byArea }, null, 2))
  }
  if (argumentsSet.has('--require-release-ready') && result.blockers.length > 0) {
    console.error(`Release acceptance gate failed: ${result.blockers.length} blocking requirements are not verified.`)
    for (const requirement of result.blockers) {
      console.error(`- ${requirement.id} [${requirement.priority}] ${requirement.state}: ${requirement.title}`)
    }
    process.exit(2)
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) runCli()

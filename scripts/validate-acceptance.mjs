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
const evidenceIdPattern = /^[a-z0-9][a-z0-9._:-]{7,127}$/
const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/

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
  if (!manifest.releasePolicy || !Array.isArray(manifest.releasePolicy.blockingPriorities) ||
      manifest.releasePolicy.releaseReadyState !== 'verified') {
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
  const evidenceIds = new Set()
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
    for (const evidence of requirement.evidence ?? []) {
      if (typeof evidence.kind !== 'string' || !allowedEvidenceKinds.has(evidence.kind)) {
        errors.push(`${label}: invalid evidence kind`)
        continue
      }
      if (typeof evidence.ref === 'string') {
        validateRepositoryReference(evidence.ref, repositoryRoot, label, errors)
      } else if (!privateScopes.has(evidence.scope)) {
        errors.push(`${label}: non-private evidence requires a repository ref`)
      }

      const isVersioned = typeof evidence.evidenceId === 'string' ||
        typeof evidence.scope === 'string' || typeof evidence.subjectCommit === 'string' ||
        typeof evidence.runtimePayloadSha256 === 'string'
      if (!isVersioned) continue
      if (!evidenceIdPattern.test(evidence.evidenceId ?? '')) {
        errors.push(`${label}: invalid evidenceId`)
      } else if (evidenceIds.has(evidence.evidenceId)) {
        errors.push(`${label}: duplicate evidenceId ${evidence.evidenceId}`)
      } else {
        evidenceIds.add(evidence.evidenceId)
      }
      if (!scopeRank.has(evidence.scope)) errors.push(`${label}: invalid evidence scope`)
      if (!commitPattern.test(evidence.subjectCommit ?? '')) {
        errors.push(`${label}: versioned evidence requires an exact lowercase subjectCommit`)
      }
      if (!sha256Pattern.test(evidence.runtimePayloadSha256 ?? '')) {
        errors.push(`${label}: versioned evidence requires an exact lowercase runtimePayloadSha256`)
      }
      if (privateScopes.has(evidence.scope)) {
        if (!opaqueIdPattern.test(evidence.opaqueId ?? '')) errors.push(`${label}: private evidence requires an opaqueId`)
        if (!sha256Pattern.test(evidence.sha256 ?? '')) errors.push(`${label}: private evidence requires a lowercase SHA-256`)
        if (!isIsoDate(evidence.observedAt)) errors.push(`${label}: private evidence requires observedAt`)
        if (evidence.expiresAt !== undefined && !isIsoDate(evidence.expiresAt)) {
          errors.push(`${label}: private evidence expiresAt is invalid`)
        }
      }
      if (proofKinds.has(evidence.kind) && scopeSatisfies(evidence.scope, minimumScope)) {
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
  const blockingPriorities = new Set(manifest.releasePolicy?.blockingPriorities ?? [])
  const blockers = (manifest.requirements ?? []).filter((requirement) =>
    blockingPriorities.has(requirement.priority) &&
    requirement.state !== manifest.releasePolicy?.releaseReadyState
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
    candidate.startsWith('acceptance/evidence/')
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
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && /T/.test(value)
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

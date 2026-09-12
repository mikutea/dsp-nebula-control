import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  isAllowedEvidenceOnlyPath, minimumEvidenceScope, validateAcceptanceManifest,
  validateEvidenceCommitBoundary
} from './validate-acceptance.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'acceptance', 'manifest.json'), 'utf8'))
const commit = 'a'.repeat(40)
const payload = 'd'.repeat(64)

test('release policy is an exact fail-closed P0 and P1 contract', () => {
  const cases = [
    null,
    {},
    { blockingPriorities: [], releaseReadyState: 'verified', productionEvidenceLivesOutsideRepository: true },
    { blockingPriorities: ['P0'], releaseReadyState: 'verified', productionEvidenceLivesOutsideRepository: true },
    { blockingPriorities: ['P1', 'P0'], releaseReadyState: 'verified', productionEvidenceLivesOutsideRepository: true },
    { blockingPriorities: ['P0', 'P0'], releaseReadyState: 'verified', productionEvidenceLivesOutsideRepository: true },
    { blockingPriorities: ['P0', 'P1', 'P2'], releaseReadyState: 'verified', productionEvidenceLivesOutsideRepository: true },
    { blockingPriorities: ['P0', 'P1'], releaseReadyState: 'implemented', productionEvidenceLivesOutsideRepository: true },
    { blockingPriorities: ['P0', 'P1'], releaseReadyState: 'verified', productionEvidenceLivesOutsideRepository: false },
    {
      blockingPriorities: ['P0', 'P1'], releaseReadyState: 'verified',
      productionEvidenceLivesOutsideRepository: true, unsupported: true
    }
  ]

  for (const releasePolicy of cases) {
    const fixture = structuredClone(manifest)
    fixture.releasePolicy = releasePolicy
    const result = validateAcceptanceManifest(fixture, { repositoryRoot })
    assert.ok(result.errors.includes('releasePolicy is invalid'), JSON.stringify(releasePolicy))
    assert.ok(result.blockers.some((requirement) =>
      (requirement.priority === 'P0' || requirement.priority === 'P1') && requirement.state !== 'verified'
    ), 'an invalid policy changed the fixed blocker calculation')
  }

  const valid = validateAcceptanceManifest(structuredClone(manifest), { repositoryRoot })
  assert.equal(valid.errors.includes('releasePolicy is invalid'), false)
})

test('legacy repository paths cannot promote a production-scoped requirement to verified', () => {
  const fixture = structuredClone(manifest)
  const requirement = fixture.requirements.find((entry) => entry.id === 'PRD-001')
  requirement.state = 'verified'
  requirement.evidence = [{ kind: 'automated-test', ref: 'apps/api/src/app.test.ts' }]
  const result = validateAcceptanceManifest(fixture, { repositoryRoot })
  assert.ok(result.errors.some((error) => error.includes('PRD-001: verified requirement needs versioned dyson-side-by-side proof evidence')))
})

test('private target-host evidence requires opaque identity, digest, observation time, and exact commit', () => {
  const fixture = structuredClone(manifest)
  const requirement = fixture.requirements.find((entry) => entry.id === 'PRD-001')
  requirement.state = 'verified'
  requirement.evidence = [{
    evidenceId: 'prd-001-run-0001', kind: 'operator-run', scope: 'dyson-side-by-side',
    subjectCommit: commit,
    runtimePayloadSha256: payload
  }]
  const result = validateAcceptanceManifest(fixture, { repositoryRoot, releaseCommit: commit })
  assert.ok(result.errors.some((error) => error.includes('PRD-001: private evidence requires an opaqueId')))
  assert.ok(result.errors.some((error) => error.includes('PRD-001: private evidence requires a lowercase SHA-256')))
  assert.ok(result.errors.some((error) => error.includes('PRD-001: private evidence requires observedAt')))
})

test('unimplemented evidence expiry metadata is rejected instead of being silently ignored', async (context) => {
  const root = await temporaryRoot(context)
  const { fixture, requirement } = isolatedRequirement('PRD-001')
  requirement.state = 'verified'
  const proof = privateProof('prd-001-expiry-0001', commit, payload)
  proof.expiresAt = '2026-09-01T00:00:00.000Z'
  requirement.evidence = [proof]
  await writeEvidenceIndex(root, proof, ['PRD-001'])

  const result = validateAcceptanceManifest(fixture, { repositoryRoot: root })
  assert.ok(result.errors.includes(
    'PRD-001: expiresAt is unsupported by the versioned public evidence contract'
  ))
  assert.ok(result.errors.includes(
    'PRD-001: verified requirement needs versioned dyson-side-by-side proof evidence'
  ))
})

test('repository and versioned evidence declarations use exact field sets', async (context) => {
  const legacyFixture = structuredClone(manifest)
  legacyFixture.requirements[0].evidence[0].typoMetadata = true
  let result = validateAcceptanceManifest(legacyFixture, { repositoryRoot })
  assert.ok(result.errors.includes(
    `${legacyFixture.requirements[0].id}: evidence entry has unsupported or missing fields`
  ))

  const root = await temporaryRoot(context)
  const { fixture, requirement } = isolatedRequirement('PRD-001')
  requirement.state = 'verified'
  const proof = privateProof('prd-001-schema-0001', commit, payload)
  proof.typoMetadata = true
  requirement.evidence = [proof]
  await writeEvidenceIndex(root, proof, ['PRD-001'])
  result = validateAcceptanceManifest(fixture, { repositoryRoot: root })
  assert.ok(result.errors.includes('PRD-001: evidence entry has unsupported or missing fields'))
  assert.ok(result.errors.includes(
    'PRD-001: verified requirement needs versioned dyson-side-by-side proof evidence'
  ))
})

test('release validation rejects indexed proof from a different runtime payload', async (context) => {
  const { fixture, requirement } = isolatedRequirement('PRD-001')
  const root = await temporaryRoot(context)
  requirement.state = 'verified'
  requirement.evidence = [privateProof('prd-001-run-0002', commit, 'b'.repeat(64))]
  await writeEvidenceIndex(root, requirement.evidence[0], ['PRD-001'])
  const result = validateAcceptanceManifest(fixture, {
    repositoryRoot: root, releaseCommit: 'e'.repeat(40), artifactPayloadSha256: payload
  })
  assert.ok(result.errors.some((error) => error.includes(`PRD-001: no qualifying evidence is bound to runtime payload ${payload}`)))
})

test('valid indexed private proof qualifies only at or above the requirement minimum', async (context) => {
  const { fixture, requirement } = isolatedRequirement('PRD-001')
  const root = await temporaryRoot(context)
  requirement.state = 'verified'
  requirement.evidence = [privateProof('prd-001-run-0003', commit, payload)]
  await writeEvidenceIndex(root, requirement.evidence[0], ['PRD-001'])
  const result = validateAcceptanceManifest(fixture, {
    repositoryRoot: root, releaseCommit: 'e'.repeat(40), artifactPayloadSha256: payload
  })
  assert.equal(result.errors.filter((error) => error.startsWith('PRD-001:')).length, 0)
  assert.equal(minimumEvidenceScope(requirement), 'dyson-side-by-side')
})

test('public index IDs use the shared PowerShell-safe grammar', async (context) => {
  const root = await temporaryRoot(context)
  const { fixture, requirement } = isolatedRequirement('PRD-001')
  requirement.state = 'verified'
  const proof = privateProof('prd_001-a', commit, payload)
  requirement.evidence = [proof]
  await writeEvidenceIndex(root, proof, ['PRD-001'])
  const result = validateAcceptanceManifest(fixture, { repositoryRoot: root })
  assert.equal(result.errors.filter((error) => error.startsWith('PRD-001:')).length, 0)
  assert.equal(isAllowedEvidenceOnlyPath('acceptance/evidence/prd_001-a.json'), true)
  assert.equal(isAllowedEvidenceOnlyPath('acceptance/evidence/prd:0010.json'), false)
  assert.equal(isAllowedEvidenceOnlyPath('acceptance/evidence/PRD-0010.json'), false)
  assert.equal(isAllowedEvidenceOnlyPath('acceptance/evidence/prd-0010..a.json'), false)
  assert.equal(isAllowedEvidenceOnlyPath('acceptance/evidence/prd-0010-.json'), false)
  assert.equal(isAllowedEvidenceOnlyPath('acceptance/evidence/con.fixture.json'), false)
})

test('indexed repository-scoped versioned evidence remains valid without claiming private scope', async (context) => {
  const root = await temporaryRoot(context)
  const { fixture, requirement } = isolatedRequirement('SRV-001')
  const proof = {
    evidenceId: 'srv-001-run-0001',
    kind: 'automated-test',
    scope: 'repository-unit',
    subjectCommit: commit,
    runtimePayloadSha256: payload,
    opaqueId: 'repository:srv-001-run-0001',
    sha256: 'c'.repeat(64),
    observedAt: '2026-08-31T00:00:00.000Z',
    ref: 'acceptance/evidence/srv-001-run-0001.json'
  }
  requirement.evidence = [proof]
  await writeEvidenceIndex(root, proof, ['SRV-001'])
  const result = validateAcceptanceManifest(fixture, { repositoryRoot: root })
  assert.equal(result.errors.filter((error) => error.startsWith('SRV-001:')).length, 0)
})

test('only public acceptance evidence paths may change after the attested subject commit', () => {
  assert.equal(isAllowedEvidenceOnlyPath('acceptance/manifest.json'), true)
  assert.equal(isAllowedEvidenceOnlyPath('acceptance/evidence/release-0001.json'), true)
  assert.equal(isAllowedEvidenceOnlyPath('acceptance/evidence/../app.json'), false)
  assert.equal(isAllowedEvidenceOnlyPath('acceptance/evidence/nested/release-0001.json'), false)
  assert.equal(isAllowedEvidenceOnlyPath('acceptance/evidence/release.json'), false)
  assert.equal(isAllowedEvidenceOnlyPath('docs/ACCEPTANCE.md'), true)
  assert.equal(isAllowedEvidenceOnlyPath('apps/api/src/app.ts'), false)
  assert.equal(isAllowedEvidenceOnlyPath('package.json'), false)
})

test('Git boundary accepts an evidence-only descendant and rejects runtime drift', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'dyson-acceptance-boundary-'))
  context.after(async () => rm(root, { recursive: true, force: true }))
  git(root, 'init')
  git(root, 'config', 'user.name', 'Dyson Acceptance Fixture')
  git(root, 'config', 'user.email', 'fixture@example.invalid')
  git(root, 'config', 'core.autocrlf', 'false')
  await mkdir(path.join(root, 'apps', 'api', 'src'), { recursive: true })
  await writeFile(path.join(root, 'apps', 'api', 'src', 'app.ts'), 'export const value = 1\n')
  git(root, 'add', '--', 'apps/api/src/app.ts')
  git(root, 'commit', '-m', 'candidate runtime')
  const subject = git(root, 'rev-parse', 'HEAD').stdout.trim()

  await mkdir(path.join(root, 'acceptance'), { recursive: true })
  await mkdir(path.join(root, 'docs'), { recursive: true })
  await writeFile(path.join(root, 'acceptance', 'manifest.json'), '{"schemaVersion":1}\n')
  await writeFile(path.join(root, 'docs', 'ACCEPTANCE.md'), '# Evidence\n')
  git(root, 'add', '--', 'acceptance/manifest.json', 'docs/ACCEPTANCE.md')
  git(root, 'commit', '-m', 'acceptance evidence')
  const evidenceCommit = git(root, 'rev-parse', 'HEAD').stdout.trim()
  assert.deepEqual(validateEvidenceCommitBoundary(root, subject, evidenceCommit), [])

  await writeFile(path.join(root, 'apps', 'api', 'src', 'app.ts'), 'export const value = 2\n')
  git(root, 'add', '--', 'apps/api/src/app.ts')
  git(root, 'commit', '-m', 'runtime drift')
  const driftedCommit = git(root, 'rev-parse', 'HEAD').stdout.trim()
  assert.match(
    validateEvidenceCommitBoundary(root, subject, driftedCommit).join(' '),
    /changes non-evidence paths.*apps\/api\/src\/app\.ts/
  )

  git(root, 'rm', '--', 'apps/api/src/app.ts')
  git(root, 'commit', '-m', 'runtime deletion drift')
  const deletedCommit = git(root, 'rev-parse', 'HEAD').stdout.trim()
  assert.match(
    validateEvidenceCommitBoundary(root, subject, deletedCommit).join(' '),
    /changes non-evidence paths.*apps\/api\/src\/app\.ts/
  )
})

test('versioned evidence requires the exact safe public index path', async (context) => {
  const root = await temporaryRoot(context)
  const cases = [
    [undefined, /versioned evidence ref must be/],
    ['acceptance/evidence/../prd-001-run-0004.json', /versioned evidence ref must be/],
    ['acceptance\\evidence\\prd-001-run-0004.json', /versioned evidence ref must be/],
    ['acceptance/evidence/nested/prd-001-run-0004.json', /versioned evidence ref must be/],
    ['acceptance/evidence/prd-001-run-9999.json', /ref does not match evidenceId/]
  ]
  for (const [ref, expected] of cases) {
    const { fixture, requirement } = isolatedRequirement('PRD-001')
    requirement.state = 'verified'
    const proof = privateProof('prd-001-run-0004', commit, payload)
    proof.ref = ref
    requirement.evidence = [proof]
    const result = validateAcceptanceManifest(fixture, { repositoryRoot: root })
    assert.match(result.errors.filter((error) => error.startsWith('PRD-001:')).join('\n'), expected)
  }

  const { fixture, requirement } = isolatedRequirement('PRD-001')
  requirement.state = 'verified'
  requirement.evidence = [{
    ...privateProof('prd-001-run-0004', commit, payload),
    evidenceId: 'prd:001:run:0004',
    ref: 'acceptance/evidence/prd:001:run:0004.json',
    opaqueId: 'private:prd:001:run:0004'
  }]
  const unsafe = validateAcceptanceManifest(fixture, { repositoryRoot: root })
  assert.match(unsafe.errors.join('\n'), /invalid evidenceId/)
})

test('public evidence index parsing rejects unknown fields, protocol drift, and duplicate JSON keys', async (context) => {
  const root = await temporaryRoot(context)
  const { fixture, requirement } = isolatedRequirement('PRD-001')
  requirement.state = 'verified'
  const proof = privateProof('prd-001-run-0005', commit, payload)
  requirement.evidence = [proof]
  const valid = evidenceIndex(proof, ['PRD-001'])
  const cases = [
    [{ ...structuredClone(valid), unexpected: true }, /unsupported top-level fields/],
    [{ ...structuredClone(valid), protocol: 'DYSON_ACCEPTANCE_EVIDENCE_INDEX_V2' }, /protocol or schemaVersion is invalid/],
    [{ ...structuredClone(valid), schemaVersion: 2 }, /protocol or schemaVersion is invalid/],
    [{
      ...structuredClone(valid),
      evidence: { ...structuredClone(valid.evidence), metadata: 'not-allowed' }
    }, /metadata has unsupported fields/]
  ]
  for (const [index, expected] of cases) {
    await writeEvidenceIndex(root, proof, ['PRD-001'], index)
    const result = validateAcceptanceManifest(fixture, { repositoryRoot: root })
    assert.match(result.errors.join('\n'), expected)
  }

  const duplicateProtocol = `{"protocol":"DYSON_ACCEPTANCE_EVIDENCE_INDEX_V1",` +
    `"protocol":"DYSON_ACCEPTANCE_EVIDENCE_INDEX_V1","schemaVersion":1,` +
    `"evidence":${JSON.stringify(valid.evidence)}}\n`
  await writeEvidenceIndex(root, proof, ['PRD-001'], duplicateProtocol)
  const duplicate = validateAcceptanceManifest(fixture, { repositoryRoot: root })
  assert.match(duplicate.errors.join('\n'), /invalid strict JSON/)
})

test('all duplicated manifest metadata must exactly match the public index', async (context) => {
  const root = await temporaryRoot(context)
  const { fixture, requirement } = isolatedRequirement('PRD-001')
  requirement.state = 'verified'
  const proof = privateProof('prd-001-run-0006', commit, payload)
  requirement.evidence = [proof]
  const different = privateProof('prd-001-run-9999', 'b'.repeat(40), 'e'.repeat(64))
  different.kind = 'rollback-drill'
  different.scope = 'production'
  different.sha256 = 'f'.repeat(64)
  different.observedAt = '2026-08-31T00:00:01.000Z'
  await writeEvidenceIndex(root, proof, ['PRD-001'], evidenceIndex(different, ['PRD-001']))

  const result = validateAcceptanceManifest(fixture, { repositoryRoot: root })
  for (const field of [
    'evidenceId', 'kind', 'scope', 'subjectCommit', 'runtimePayloadSha256',
    'opaqueId', 'sha256', 'observedAt'
  ]) {
    assert.ok(result.errors.includes(`PRD-001: ${field} does not match public evidence index`), field)
  }
})

test('public index requirement IDs must be canonical, unique, and include the current requirement', async (context) => {
  const root = await temporaryRoot(context)
  const { fixture, requirement } = isolatedRequirement('PRD-001')
  requirement.state = 'verified'
  const proof = privateProof('prd-001-run-0007', commit, payload)
  requirement.evidence = [proof]

  await writeEvidenceIndex(root, proof, ['PRD-002'])
  let result = validateAcceptanceManifest(fixture, { repositoryRoot: root })
  assert.match(result.errors.join('\n'), /does not include requirement PRD-001/)

  await writeEvidenceIndex(root, proof, ['PRD-001', 'PRD-001'])
  result = validateAcceptanceManifest(fixture, { repositoryRoot: root })
  assert.match(result.errors.join('\n'), /requirementIds are duplicate or non-canonical/)

  await writeEvidenceIndex(root, proof, ['PRD-002', 'PRD-001'])
  result = validateAcceptanceManifest(fixture, { repositoryRoot: root })
  assert.match(result.errors.join('\n'), /requirementIds are duplicate or non-canonical/)
})

test('duplicate evidence declarations remain fail closed', async (context) => {
  const root = await temporaryRoot(context)
  const { fixture, requirement } = isolatedRequirement('PRD-001')
  requirement.state = 'verified'
  const proof = privateProof('prd-001-run-0008', commit, payload)
  requirement.evidence = [proof, structuredClone(proof)]
  await writeEvidenceIndex(root, proof, ['PRD-001'])
  const result = validateAcceptanceManifest(fixture, { repositoryRoot: root })
  assert.match(result.errors.join('\n'), /duplicate evidenceId prd-001-run-0008/)
})

test('one indexed evidence bundle may cover multiple listed requirements but conflicting reuse is rejected', async (context) => {
  const root = await temporaryRoot(context)
  const fixture = structuredClone(manifest)
  for (const requirement of fixture.requirements) requirement.evidence = []
  const first = fixture.requirements.find((entry) => entry.id === 'PRD-001')
  const second = fixture.requirements.find((entry) => entry.id === 'PRD-002')
  first.state = 'verified'
  second.state = 'verified'
  const proof = privateProof('prd-shared-run-0001', commit, payload)
  first.evidence = [proof]
  second.evidence = [structuredClone(proof)]
  await writeEvidenceIndex(root, proof, ['PRD-001', 'PRD-002'])

  let result = validateAcceptanceManifest(fixture, { repositoryRoot: root })
  assert.equal(result.errors.filter((error) => /^PRD-00[12]:/.test(error)).length, 0)

  second.evidence[0].sha256 = 'e'.repeat(64)
  result = validateAcceptanceManifest(fixture, { repositoryRoot: root })
  assert.match(result.errors.join('\n'), /PRD-002: conflicting metadata for evidenceId prd-shared-run-0001/)
  assert.match(result.errors.join('\n'), /PRD-002: sha256 does not match public evidence index/)
})

test('public evidence indexes cannot be reached through a symlink or reparse-point escape', async (context) => {
  const root = await temporaryRoot(context)
  const outside = await temporaryRoot(context, 'dyson-acceptance-index-outside-')
  const { fixture, requirement } = isolatedRequirement('PRD-001')
  requirement.state = 'verified'
  const proof = privateProof('prd-001-run-0009', commit, payload)
  requirement.evidence = [proof]
  await mkdir(path.join(root, 'acceptance'), { recursive: true })
  await writeFile(path.join(outside, `${proof.evidenceId}.json`), JSON.stringify(evidenceIndex(proof, ['PRD-001'])))
  try {
    await symlink(outside, path.join(root, 'acceptance', 'evidence'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES' ||
        (process.platform === 'win32' && error?.code === 'UNKNOWN')) {
      context.skip('this host does not permit creating a symlink or junction fixture')
      return
    }
    throw error
  }

  const result = validateAcceptanceManifest(fixture, { repositoryRoot: root })
  assert.match(result.errors.join('\n'), /evidence index path is redirected/)
})

test('network, soak, public release, and cutover requirements have stronger explicit scopes', () => {
  const byId = Object.fromEntries(manifest.requirements.map((entry) => [entry.id, entry]))
  assert.equal(minimumEvidenceScope(byId['PRD-004']), 'external-client')
  assert.equal(minimumEvidenceScope(byId['PRD-005']), 'production')
  assert.equal(minimumEvidenceScope(byId['OSS-003']), 'release')
  assert.equal(minimumEvidenceScope(byId['CUT-002']), 'cutover')
})

function privateProof(evidenceId, subjectCommit, runtimePayloadSha256) {
  return {
    evidenceId,
    kind: 'operator-run',
    scope: 'dyson-side-by-side',
    subjectCommit,
    runtimePayloadSha256,
    opaqueId: `private:${evidenceId}`,
    sha256: 'c'.repeat(64),
    observedAt: '2026-08-31T00:00:00.000Z',
    ref: `acceptance/evidence/${evidenceId}.json`
  }
}

function evidenceIndex(proof, requirementIds) {
  return {
    protocol: 'DYSON_ACCEPTANCE_EVIDENCE_INDEX_V1',
    schemaVersion: 1,
    evidence: {
      evidenceId: proof.evidenceId,
      kind: proof.kind,
      scope: proof.scope,
      subjectCommit: proof.subjectCommit,
      runtimePayloadSha256: proof.runtimePayloadSha256,
      opaqueId: proof.opaqueId,
      sha256: proof.sha256,
      observedAt: proof.observedAt,
      requirementIds
    }
  }
}

function isolatedRequirement(requirementId) {
  const fixture = structuredClone(manifest)
  for (const requirement of fixture.requirements) requirement.evidence = []
  return {
    fixture,
    requirement: fixture.requirements.find((entry) => entry.id === requirementId)
  }
}

async function temporaryRoot(context, prefix = 'dyson-acceptance-index-') {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  context.after(async () => rm(root, { recursive: true, force: true }))
  return root
}

async function writeEvidenceIndex(root, proof, requirementIds, value = evidenceIndex(proof, requirementIds)) {
  const destination = path.join(root, ...proof.ref.split('/'))
  await mkdir(path.dirname(destination), { recursive: true })
  await writeFile(destination, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`)
}

function git(root, ...argumentsList) {
  const result = spawnSync('git', ['-c', `safe.directory=${root}`, ...argumentsList], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  })
  assert.equal(result.status, 0, result.stderr || `git ${argumentsList.join(' ')} failed`)
  return result
}

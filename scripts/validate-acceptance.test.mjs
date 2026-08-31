import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

test('release validation rejects proof from a different runtime payload', () => {
  const fixture = structuredClone(manifest)
  const requirement = fixture.requirements.find((entry) => entry.id === 'PRD-001')
  requirement.state = 'verified'
  requirement.evidence = [privateProof('prd-001-run-0002', commit, 'b'.repeat(64))]
  const result = validateAcceptanceManifest(fixture, {
    repositoryRoot, releaseCommit: 'e'.repeat(40), artifactPayloadSha256: payload
  })
  assert.ok(result.errors.some((error) => error.includes(`PRD-001: no qualifying evidence is bound to runtime payload ${payload}`)))
})

test('valid scoped private proof qualifies only at or above the requirement minimum', () => {
  const fixture = structuredClone(manifest)
  const requirement = fixture.requirements.find((entry) => entry.id === 'PRD-001')
  requirement.state = 'verified'
  requirement.evidence = [privateProof('prd-001-run-0003', commit, payload)]
  const result = validateAcceptanceManifest(fixture, {
    repositoryRoot, releaseCommit: 'e'.repeat(40), artifactPayloadSha256: payload
  })
  assert.equal(result.errors.filter((error) => error.startsWith('PRD-001:')).length, 0)
  assert.equal(minimumEvidenceScope(requirement), 'dyson-side-by-side')
})

test('only public acceptance evidence paths may change after the attested subject commit', () => {
  assert.equal(isAllowedEvidenceOnlyPath('acceptance/manifest.json'), true)
  assert.equal(isAllowedEvidenceOnlyPath('acceptance/evidence/release.json'), true)
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
    observedAt: '2026-08-31T00:00:00.000Z'
  }
}

function git(root, ...argumentsList) {
  const result = spawnSync('git', argumentsList, { cwd: root, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr || `git ${argumentsList.join(' ')} failed`)
  return result
}

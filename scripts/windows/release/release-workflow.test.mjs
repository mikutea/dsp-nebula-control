import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..', '..')
const ciWorkflowPath = path.join(repositoryRoot, '.github', 'workflows', 'ci.yml')
const workflowPath = path.join(repositoryRoot, '.github', 'workflows', 'release.yml')
const ciWorkflow = await readFile(ciWorkflowPath, 'utf8')
const workflow = await readFile(workflowPath, 'utf8')

test('CI and release install the SDK selected by the repository and use the same Node runtime', async () => {
  const selection = JSON.parse(await readFile(path.join(repositoryRoot, 'global.json'), 'utf8'))
  assert.equal(selection.sdk.rollForward, 'disable')
  assert.equal(selection.sdk.allowPrerelease, false)
  for (const configuration of [ciWorkflow, workflow]) {
    assert.ok(configuration.includes(`dotnet-version: ${selection.sdk.version}`))
    assert.match(configuration, /actions\/setup-dotnet@[0-9a-f]{40}/)
    assert.match(configuration, /node-version: 24\.20\.0/)
  }
})

test('CI is bounded, read-only, and runs affected regressions on Node 24 and Windows PowerShell 5.1', () => {
  assert.match(ciWorkflow, /^permissions:\r?\n  contents: read\r?$/m)
  assert.doesNotMatch(ciWorkflow, /^\s{2}[a-z-]+: write\s*$/m)
  assert.match(ciWorkflow, /runs-on: windows-latest/)
  assert.match(ciWorkflow, /timeout-minutes: 90/)
  assert.ok(ciWorkflow.includes('group: ci-${{ github.workflow }}-${{ github.ref }}'))
  assert.match(ciWorkflow, /cancel-in-progress: true/)
  assert.match(ciWorkflow, /actions\/checkout@[0-9a-f]{40} # v5/)
  assert.match(ciWorkflow, /actions\/setup-node@[0-9a-f]{40} # v6/)
  assert.match(ciWorkflow, /node-version: 24/)
  assert.match(ciWorkflow, /powershell\.exe[\s\S]*?\^5\\\.1\\\./)
  for (const command of [
    'npm ci',
    'npm ci --prefix apps/api',
    'npm ci --prefix apps/web',
    'node scripts/validate-incremental.mjs'
  ]) assert.ok(ciWorkflow.includes(command), `missing CI gate: ${command}`)
})

test('release workflow is tag-only with a strict in-job canonical gate', () => {
  assert.match(workflow, /^on:\r?\n  push:\r?\n    tags:\r?\n      - 'v\[0-9\]\*\.\[0-9\]\*\.\[0-9\]\*'/m)
  assert.doesNotMatch(workflow, /^\s*(?:pull_request|pull_request_target|workflow_dispatch|schedule|branches):/m)
  assert.match(workflow, /if: github\.event_name == 'push' && github\.ref_type == 'tag'/)
  assert.match(workflow, /\^v\(\?:0\|\[1-9\]\[0-9\]\*\).*?-rc\\\.\(\?:0\|\[1-9\]\[0-9\]\*\)/s)
  assert.match(workflow, /The tag, checkout, and workflow commit do not identify the same commit\./)
  assert.match(workflow, /The tag version does not exactly match package\.json\./)
})

test('release workflow pins official actions and grants only release contents access', () => {
  assert.match(workflow, /^permissions:\r?\n  contents: write\r?$/m)
  assert.doesNotMatch(workflow, /^\s{2}(?!contents:)[a-z-]+: write\s*$/m)
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40} # v5/)
  assert.match(workflow, /persist-credentials: false/)
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40} # v6/)
  assert.match(workflow, /node-version: 24/)
  assert.match(workflow, /runs-on: windows-latest/)
})

test('release workflow builds, runs affected regressions, and verifies every boundary', () => {
  for (const command of [
    'npm ci',
    'npm ci --prefix apps/api',
    'npm ci --prefix apps/web',
    'npm run build',
    'node scripts/validate-incremental.mjs',
    'npm run version:check -- --expected-version $env:RELEASE_VERSION --tag $env:RELEASE_TAG',
    'npm run acceptance:gate -- --release-commit $env:RELEASE_COMMIT',
    '--artifact-manifest',
    'npm run release:artifact --',
    'npm run release:artifact-check --',
    'node scripts/public-release/check.mjs --history --artifact',
    'npm run release:package --',
    'npm run release:package-check --'
  ]) assert.ok(workflow.includes(command), `missing release gate: ${command}`)
  assert.match(workflow, /git status --porcelain=v1 --untracked-files=all/g)
  assert.match(workflow, /The production acceptance gate rejected this release\./)
  assert.match(workflow, /Repository package versions or lockfile identities are inconsistent\./)
  const versionGate = workflow.indexOf(
    'npm run version:check -- --expected-version $env:RELEASE_VERSION --tag $env:RELEASE_TAG'
  )
  const lockedInstall = workflow.indexOf('npm ci')
  const build = workflow.indexOf('npm run build')
  const completeGate = workflow.indexOf('node scripts/validate-incremental.mjs')
  const acceptanceGate = workflow.indexOf('npm run acceptance:gate -- --release-commit $env:RELEASE_COMMIT')
  const artifactAssembly = workflow.indexOf('npm run release:artifact --')
  const releaseCreation = workflow.indexOf("'release', 'create', $env:RELEASE_TAG")
  assert.ok(versionGate >= 0 && versionGate < lockedInstall,
    'version consistency must fail closed before dependency installation')
  assert.ok(versionGate < build && versionGate < completeGate && versionGate < artifactAssembly,
    'version consistency must precede build, complete check, and artifact assembly')
  assert.ok(artifactAssembly >= 0 && artifactAssembly < acceptanceGate,
    'the exact artifact must be assembled before its acceptance evidence is checked')
  assert.ok(acceptanceGate < releaseCreation,
    'artifact-bound acceptance must precede GitHub Release creation')
})

test('GitHub release creation is conflict-safe and cannot clobber assets', () => {
  assert.match(workflow, /gh release view \$env:RELEASE_TAG --json tagName/)
  assert.match(workflow, /'release', 'create', \$env:RELEASE_TAG/)
  assert.match(workflow, /'--verify-tag'/)
  assert.match(workflow, /'--prerelease', '--latest=false'/)
  assert.doesNotMatch(workflow, /gh\s+release\s+upload|--clobber/)
  assert.match(workflow, /GitHub Release creation or asset upload failed closed\./)
})

test('CI and release never automatically repeat the complete suite', () => {
  for (const configuration of [ciWorkflow, workflow]) {
    assert.doesNotMatch(configuration, /npm run check(?:\s|$)/)
    assert.match(configuration, /fetch-depth: 0/)
    assert.match(configuration, /node scripts\/validate-incremental\.mjs/)
  }
})
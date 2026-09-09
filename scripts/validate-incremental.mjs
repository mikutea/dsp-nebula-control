import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const baseline = '47b125e57cea4a0ba2457b842b926edc6c4a2faf'
const versionFiles = new Set([
  '.env.example', 'README.md', 'package.json', 'package-lock.json',
  'apps/api/package.json', 'apps/api/package-lock.json',
  'apps/web/package.json', 'apps/web/package-lock.json',
  'apps/api/src/app.test.ts', 'apps/api/src/config.test.ts', 'apps/api/src/config.ts',
  'apps/api/src/providers/windows-lifecycle.integration.test.ts',
  'apps/api/src/providers/windows-lifecycle.test.ts', 'apps/api/src/providers/windows-lifecycle.ts',
  'integrations/dyson-control-bridge/DysonControlBridge.csproj',
  'integrations/dyson-control-bridge/DysonControlBridgePlugin.cs'
])
const reviewedPaths = new Set([
  '.github/workflows/ci.yml', '.github/workflows/release.yml', 'global.json',
  'scripts/windows/release/release-workflow.test.mjs',
  'scripts/windows/Get-DysonStatus.ps1',
  'scripts/windows/data-recovery/DysonDataRootRecovery.Common.ps1',
  'scripts/windows/data-recovery/SelfTest-DysonDataRootRecovery.ps1',
  'scripts/windows/lifecycle-broker/Install-DysonLifecycleBrokerTask.ps1',
  'scripts/windows/lifecycle-broker/SelfTest-DysonLifecycleBroker.ps1',
  'scripts/windows/deployment/Install-DysonControl.ps1',
  'scripts/windows/bootstrap/DysonGameLifecycleBootstrap.Common.ps1',
  'scripts/windows/bootstrap/SelfTest-DysonGameBootstrapPointer.ps1',
  'apps/api/src/providers/windows-status-script.test.ts',
  'scripts/validate-incremental.mjs', 'scripts/validate-incremental.test.mjs',
  'docs/incremental-validation.md', 'AGENTS.md'
])
const normalize = text => text.replaceAll('\r\n', '\n')

export function classifyChange(file, before, after) {
  if (after === null) throw new Error(`Deletion requires an updated validation plan: ${file}`)
  if (file === 'scripts/windows/release/DysonReleasePackaging.Common.ps1' && before !== null &&
      normalize(before).replace("    'scripts/windows/bootstrap/SelfTest-DysonGameLifecycleBootstrap.ps1',",
        "    'scripts/windows/bootstrap/SelfTest-DysonGameLifecycleBootstrap.ps1',\n    'scripts/windows/bootstrap/SelfTest-DysonGameBootstrapPointer.ps1',") === normalize(after)) return 'release-test-allowlist'
  if (versionFiles.has(file) && before !== null &&
      normalize(before).replaceAll('0.1.0-rc.16', '0.1.0-rc.17') === normalize(after)) return 'version-only'
  if (reviewedPaths.has(file)) return 'affected'
  throw new Error(`No reviewed affected-test mapping for ${file}; update the plan, never auto-run the full suite.`)
}

export function selectCommands(changes) {
  const affected = new Set(changes.filter(change => change.kind === 'affected').map(change => change.file))
  const commands = [
    ['node', ['scripts/validate-version-consistency.mjs']],
    ['node', ['--test', 'scripts/validate-incremental.test.mjs', 'scripts/windows/release/release-workflow.test.mjs']]
  ]
  if (affected.has('scripts/windows/Get-DysonStatus.ps1') ||
      affected.has('apps/api/src/providers/windows-status-script.test.ts')) {
    commands.push(['node', ['apps/api/node_modules/vitest/vitest.mjs', 'run', '--root', 'apps/api', '--maxWorkers=4',
      'src/providers/windows-status-script.test.ts', 'src/providers/windows.test.ts',
      'src/observability/server-status.test.ts', 'src/observability/snapshot.test.ts']])
  }
  if ([...affected].some(file => file.startsWith('scripts/windows/data-recovery/'))) {
    commands.push(['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', 'scripts/windows/data-recovery/SelfTest-DysonDataRootRecovery.ps1']])
  }
  if ([...affected].some(file => file.startsWith('scripts/windows/lifecycle-broker/')) ||
      affected.has('scripts/windows/deployment/Install-DysonControl.ps1')) {
    commands.push(['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', 'scripts/windows/lifecycle-broker/SelfTest-DysonLifecycleBroker.ps1']])
  }
  if (affected.has('scripts/windows/deployment/Install-DysonControl.ps1')) {
    commands.push(['node', ['apps/api/node_modules/typescript/bin/tsc', '-p', 'apps/api/tsconfig.json']])
    commands.push(['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', 'scripts/windows/deployment/SelfTest-DysonControlDeployment.ps1']])
  }
  if ([...affected].some(file => file.startsWith('scripts/windows/bootstrap/'))) {
    for (const script of ['SelfTest-DysonGameBootstrapPointer.ps1', 'SelfTest-DysonGameLifecycleBootstrap.ps1']) {
      commands.push(['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', `scripts/windows/bootstrap/${script}`]])
    }
  }
  return commands
}

export function runValidation(root, planOnly = false) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  git(['merge-base', '--is-ancestor', baseline, 'HEAD'])
  const files = [...new Set([
    ...git(['diff', '--name-only', '-z', baseline, '--']).split('\0'),
    ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0')
  ].filter(Boolean))].sort()
  const changes = files.map(file => {
    const before = git(['ls-tree', baseline, '--', file]).trim()
      ? git(['show', `${baseline}:${file}`]) : null
    let after = null
    try { after = readFileSync(path.join(root, file), 'utf8') } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    return { file, kind: classifyChange(file, before, after) }
  })
  const commands = selectCommands(changes)
  const report = { baseline, subject: git(['rev-parse', 'HEAD']).trim(), changes,
    fullSuiteRerun: false, releaseQualified: false, commands, state: 'planned' }
  if (planOnly) return report
  const sdk = execFileSync('dotnet', ['--version'], { cwd: root, encoding: 'utf8' }).trim()
  if (sdk !== '8.0.424') throw new Error('Expected repository-selected .NET SDK 8.0.424')
  for (const [executable, args] of commands) {
    execFileSync(executable === 'node' ? process.execPath : executable, args, { cwd: root, stdio: 'inherit' })
  }
  return { ...report, state: 'passed' }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, '..')
  const report = runValidation(root, process.argv.includes('--plan'))
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY,
      `Incremental validation: ${report.state}\n\nBaseline: ${baseline}\n\nChanged files: ${report.changes.length}. Full suite rerun: false. Production release qualification: not asserted.\n`, { flag: 'a' })
  }
  console.log(JSON.stringify(report, null, 2))
}

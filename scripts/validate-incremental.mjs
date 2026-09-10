import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const baseline = '77e72366e998d92e6d4765700a373d6afe18a342'
// Advance a component only after its relevant checks actually pass. A failed
// unrelated group must not erase completed evidence for an unchanged component.
export const componentBaselines = Object.fromEntries(
  ['status', 'recovery', 'bootstrap', 'lifecycle', 'deployment'].map(group => [group, {
    commit: baseline,
    evidence: 'https://github.com/mikutea/dsp-nebula-control/actions/runs/34358347690'
  }])
)
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
  'scripts/windows/deployment/SelfTest-DysonControlDeployment.ps1',
  'scripts/windows/bootstrap/DysonGameLifecycleBootstrap.Common.ps1',
  'scripts/windows/bootstrap/SelfTest-DysonGameBootstrapPointer.ps1',
  'scripts/windows/bootstrap/SelfTest-DysonGameLifecycleBootstrap.ps1',
  'apps/api/src/providers/windows-status-script.test.ts',
  'scripts/validate-incremental.mjs', 'scripts/validate-incremental.test.mjs',
  'docs/incremental-validation.md', 'AGENTS.md'
])
const normalize = text => text.replaceAll('\r\n', '\n')
const controlExitBefore = "    if ($process.ExitCode -ne 0) { throw 'The managed DSP process exited with a non-zero result.' }"
const controlExitAfter = [
  '    # Windows reports a delivered console interrupt as STATUS_CONTROL_C_EXIT.',
  '    # The stable bootstrap still requires its durable completed stop intent;',
  '    # unrelated non-zero exits remain failures.',
  '    if ($process.ExitCode -ne 0 -and $process.ExitCode -ne -1073741510) {',
  "        throw 'The managed DSP process exited with a non-zero result.'",
  '    }'
].join('\n')

// Exact normalized source identities: any additional runtime edit falls back to
// the regular bootstrap impact plan instead of inheriting this narrow check.
const aclSourceHash = source => createHash('sha256').update(normalize(source).trimEnd() + '\n').digest('hex')
const aclBeforeHash = 'b8ff1c53b36ceb1cb8c4f104621c967108c6c2b0c6f667410e3522453e51a1c9'
const aclAfterHash = '693e50ca6767358d9e0409987c994c804bc1e6d19be9c9b0f533cf2399a2b253'

export function classifyChange(file, before, after) {
  if (after === null) throw new Error(`Deletion requires an updated validation plan: ${file}`)
  if (file === 'scripts/windows/bootstrap/DysonGameLifecycleBootstrap.Common.ps1' && before !== null &&
      aclSourceHash(before) === aclBeforeHash && aclSourceHash(after) === aclAfterHash) return 'expected-exit-acl'
  if (file === 'scripts/windows/Start-DysonServer.ps1' && before !== null && normalize(before).includes(controlExitBefore) &&
      normalize(before).replace(controlExitBefore, controlExitAfter) === normalize(after)) return 'control-exit-policy'
  if (file === 'scripts/windows/deployment/DysonRebootAcceptance.Common.ps1') return 'test-only'
  if (file.endsWith('.md')) return 'documentation'
  if (reviewedPaths.has(file) && /\/SelfTest-[^/]+\.ps1$/.test(file)) return 'test-only'
  if (file === 'scripts/windows/release/DysonReleasePackaging.Common.ps1' && before !== null &&
      normalize(before).replace("    'scripts/windows/bootstrap/SelfTest-DysonGameLifecycleBootstrap.ps1',",
        "    'scripts/windows/bootstrap/SelfTest-DysonGameLifecycleBootstrap.ps1',\n    'scripts/windows/bootstrap/SelfTest-DysonGameBootstrapPointer.ps1',") === normalize(after)) return 'release-test-allowlist'
  if (versionFiles.has(file) && before !== null &&
      normalize(before).replaceAll('0.1.0-rc.17', '0.1.0-rc.18') === normalize(after)) return 'version-only'
  if (reviewedPaths.has(file)) return 'affected'
  throw new Error(`No reviewed affected-test mapping for ${file}; update the plan, never auto-run the full suite.`)
}

export function selectCommands(changes, { componentChanges } = {}) {
  const changed = group => new Set((componentChanges?.[group] ?? changes)
    .filter(change => change.kind === 'affected').map(change => change.file))
  const commands = [
    ['node', ['scripts/validate-version-consistency.mjs']],
    ['node', ['--test', 'scripts/validate-incremental.test.mjs', 'scripts/windows/release/release-workflow.test.mjs']]
  ]
  if (changed('status').has('scripts/windows/Get-DysonStatus.ps1') ||
      changed('status').has('apps/api/src/providers/windows-status-script.test.ts')) {
    commands.push(['node', ['apps/api/node_modules/vitest/vitest.mjs', 'run', '--root', 'apps/api', '--maxWorkers=4',
      'src/providers/windows-status-script.test.ts', 'src/providers/windows.test.ts',
      'src/observability/server-status.test.ts', 'src/observability/snapshot.test.ts']])
  }
  if ([...changed('recovery')].some(file => file.startsWith('scripts/windows/data-recovery/'))) {
    commands.push(['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', 'scripts/windows/data-recovery/SelfTest-DysonDataRootRecovery.ps1']])
  }
  if ([...changed('bootstrap')].some(file => file.startsWith('scripts/windows/bootstrap/'))) {
    for (const script of ['SelfTest-DysonGameBootstrapPointer.ps1', 'SelfTest-DysonGameLifecycleBootstrap.ps1']) {
      commands.push(['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', `scripts/windows/bootstrap/${script}`]])
    }
  }
  if ([...changed('lifecycle')].some(file => file.startsWith('scripts/windows/lifecycle-broker/'))) {
    commands.push(['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', 'scripts/windows/lifecycle-broker/SelfTest-DysonLifecycleBroker.ps1']])
  }
  if (changed('deployment').has('scripts/windows/deployment/Install-DysonControl.ps1')) {
    commands.push(['node', ['apps/api/node_modules/typescript/bin/tsc', '-p', 'apps/api/tsconfig.json']])
    commands.push(['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', 'scripts/windows/deployment/SelfTest-DysonControlDeployment.ps1']])
  }
  return commands
}

const deploymentCommand = ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', 'scripts/windows/deployment/SelfTest-DysonControlDeployment.ps1']]
const apiBuildCommand = ['node', ['apps/api/node_modules/typescript/bin/tsc', '-p', 'apps/api/tsconfig.json']]
const isDeploymentCommand = ([, args]) => args.includes('apps/api/tsconfig.json') ||
  args.includes('scripts/windows/deployment/SelfTest-DysonControlDeployment.ps1')
const commandGroup = command => {
  if (isDeploymentCommand(command)) return 'deployment'
  const args = command[1].join(' ')
  if (args.includes('/bootstrap/')) return 'bootstrap'
  if (args.includes('/lifecycle-broker/')) return 'lifecycle'
  if (args.includes('/data-recovery/')) return 'recovery'
  if (args.includes('windows-status-script.test.ts')) return 'status'
  return null
}

export function planExecution(changes, { componentChanges, hostChecks = false, fullDeployment = false } = {}) {
  const aclChanged = changes.some(change => change.kind === 'expected-exit-acl')
  const controlExitChanged = changes.some(change => change.kind === 'control-exit-policy')
  const requested = rows => rows.map(change => hostChecks && change.kind === 'test-only' &&
    !((controlExitChanged || aclChanged) && change.file === 'scripts/windows/bootstrap/SelfTest-DysonGameLifecycleBootstrap.ps1')
    ? { ...change, kind: 'affected' } : change)
  const selected = selectCommands(requested(changes), { componentChanges: componentChanges &&
    Object.fromEntries(Object.entries(componentChanges).map(([group, rows]) => [group, requested(rows)])) })
  const hostCommands = selected.slice(2)
  const commands = selected.slice(0, 2)
  if (controlExitChanged) commands.push(['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', 'scripts/windows/bootstrap/SelfTest-DysonGameLifecycleBootstrap.ps1', '-ExitPolicyOnly']])
  if (aclChanged) commands.push(['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', 'scripts/windows/bootstrap/SelfTest-DysonGameLifecycleBootstrap.ps1', '-ExpectedExitAclOnly']])
  const syntaxFiles = changes.filter(change => change.kind === 'test-only').map(change => change.file)
  if (syntaxFiles.length) {
    const literals = syntaxFiles.map(file => `'${file.replaceAll("'", "''")}'`).join(',')
    const script = `$ErrorActionPreference='Stop';foreach($file in @(${literals})){$tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) $file),[ref]$tokens,[ref]$errors);if($errors.Count){throw ('PowerShell syntax failed: '+$file)}}`
    commands.push(['powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]])
  }
  if (hostChecks) commands.push(...hostCommands.filter(command => !isDeploymentCommand(command)))
  if (fullDeployment) commands.push(apiBuildCommand, deploymentCommand)
  const pendingHostCommands = hostCommands.filter(command =>
    isDeploymentCommand(command) ? !fullDeployment : !hostChecks)
  const required = new Set(hostCommands.map(commandGroup))
  const running = new Set(commands.map(commandGroup))
  return { commands, pendingHostCommands, syntaxFiles,
    mode: fullDeployment ? 'explicit-deployment-suite' : hostChecks ? 'target-host' : 'fast',
    components: Object.keys(componentBaselines).map(group => ({ group,
      decision: running.has(group) ? 'run' : required.has(group) ? 'host-validation-required' : 'reuse',
      reason: running.has(group) ? group === 'deployment' ? 'explicit full-deployment request' : 'selected focused or host check' :
        required.has(group) ? 'changed runtime inputs or explicitly requested changed tests' :
          'no affected runtime inputs changed',
      verifiedCommit: componentBaselines[group].commit,
      evidence: componentBaselines[group].evidence })),
    reasons: changes.map(({ file, kind }) => ({ file, kind,
      decision: kind === 'control-exit-policy' ? 'reviewed runtime change: execute the focused exit-policy check' :
        kind === 'affected' ? 'run matching checks or reuse the verified component baseline' : 'no production behavior change' })) }
}

export function runValidation(root, planOnly = false, options = {}) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  git(['merge-base', '--is-ancestor', baseline, 'HEAD'])
  const references = [...new Set([baseline, ...Object.values(componentBaselines).map(value => value.commit)])]
  for (const reference of references) {
    if (!/^[0-9a-f]{40}$/.test(reference)) throw new Error('Validation evidence requires an immutable commit')
    git(['merge-base', '--is-ancestor', baseline, reference])
    git(['merge-base', '--is-ancestor', reference, 'HEAD'])
  }
  const files = [...new Set([
    ...references.flatMap(reference => git(['diff', '--name-only', '-z', reference, '--']).split('\0')),
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
  const componentChanges = {}
  const changedByReference = new Map()
  const classifiedByReference = new Map([[baseline, changes]])
  for (const [group, verified] of Object.entries(componentBaselines)) {
    git(['merge-base', '--is-ancestor', baseline, verified.commit])
    git(['merge-base', '--is-ancestor', verified.commit, 'HEAD'])
    if (!changedByReference.has(verified.commit)) {
      changedByReference.set(verified.commit, new Set([
        ...git(['diff', '--name-only', '-z', verified.commit, '--']).split('\0'),
        ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0')
      ]))
    }
    if (!classifiedByReference.has(verified.commit)) {
      classifiedByReference.set(verified.commit, changes
        .filter(change => changedByReference.get(verified.commit).has(change.file)).map(change => {
        const before = git(['ls-tree', verified.commit, '--', change.file]).trim()
          ? git(['show', `${verified.commit}:${change.file}`]) : null
        let after = null
        try { after = readFileSync(path.join(root, change.file), 'utf8') } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
        return { file: change.file, kind: classifyChange(change.file, before, after) }
        }))
    }
    componentChanges[group] = classifiedByReference.get(verified.commit)
      .filter(change => changedByReference.get(verified.commit).has(change.file))
  }
  const execution = planExecution(changes, { ...options, componentChanges })
  const { commands } = execution
  const report = { baseline, subject: git(['rev-parse', 'HEAD']).trim(), changes,
    componentBaselines, ...execution,
    fullSuiteRerun: false, releaseQualified: false, state: 'planned' }
  if (planOnly) return report
  if (options.hostChecks || options.fullDeployment) {
    const sdk = execFileSync('dotnet', ['--version'], { cwd: root, encoding: 'utf8' }).trim()
    if (sdk !== '8.0.424') throw new Error('Expected repository-selected .NET SDK 8.0.424')
  }
  for (const [executable, args] of commands) {
    execFileSync(executable === 'node' ? process.execPath : executable, args, { cwd: root, stdio: 'inherit' })
  }
  return { ...report, state: execution.pendingHostCommands.length ? 'host-validation-required' : 'passed' }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const flag of process.argv.slice(2)) {
    if (!['--plan', '--host-checks', '--full-deployment'].includes(flag)) throw new Error(`Unknown validation option: ${flag}`)
  }
  const root = path.resolve(import.meta.dirname, '..')
  const report = runValidation(root, process.argv.includes('--plan'), {
    hostChecks: process.argv.includes('--host-checks'),
    fullDeployment: process.argv.includes('--full-deployment')
  })
  if (report.state === 'host-validation-required') process.exitCode = 2
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY,
      `Validation: ${report.state} (${report.mode})\n\nBaseline: ${baseline}\n\nChanged files: ${report.changes.length}. Pending host commands: ${report.pendingHostCommands.length}. Full project suite rerun: false. Production release qualification: not asserted.\n`, { flag: 'a' })
  }
  console.log(JSON.stringify(report, null, 2))
}

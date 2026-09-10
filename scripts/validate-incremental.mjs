import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const baseline = 'f7c1d6186460a8586d8532978ec339a9d62686bb'
// Advance a component only after its relevant checks actually pass. A failed
// unrelated group must not erase completed evidence for an unchanged component.
export const componentBaselines = Object.fromEntries(
  ['status', 'recovery', 'bootstrap', 'lifecycle', 'deployment'].map(group => [group, {
    commit: baseline,
    evidence: 'https://github.com/mikutea/dsp-nebula-control/actions/runs/34459007627'
  }])
)
componentBaselines.lifecycle = {
  commit: baseline,
  evidence: 'https://github.com/mikutea/dsp-nebula-control/actions/runs/34459007627'
}
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
  'scripts/windows/lifecycle-broker/Invoke-DysonLifecycleBrokerWorker.ps1',
  'scripts/windows/lifecycle-broker/SelfTest-DysonLifecycleBroker.ps1',
  'scripts/windows/deployment/Install-DysonControl.ps1',
  'scripts/windows/deployment/SelfTest-DysonControlDeployment.ps1',
  'scripts/windows/bootstrap/DysonGameLifecycleBootstrap.Common.ps1',
  'scripts/windows/bootstrap/SelfTest-DysonGameBootstrapPointer.ps1',
  'scripts/windows/bootstrap/SelfTest-DysonGameLifecycleBootstrap.ps1',
  'apps/api/src/providers/windows-status-script.test.ts',
  'apps/api/src/providers/powershell-runner.ts', 'apps/api/src/providers/powershell-runner.test.ts',
  'apps/api/src/config.test.ts', 'apps/api/src/providers/windows-lifecycle.test.ts',
  'apps/api/src/services/lifecycle-service.test.ts',
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

// Only this reviewed startup patch receives the focused plan. Version labels
// are checked independently; any other runtime edit requires another plan.
const startupSourceHash = source => createHash('sha256').update(
  normalize(source).replace(/0\.1\.0-rc\.[0-9]+/gu, '0.1.0-rc.17').trimEnd() + '\n').digest('hex')
const startupSources = new Map([
  ['.env.example', {before:['dc9ffe019ee75ebc78a5eaa66791eaefce83d997acd5fe89a87bcc9c034e1188'],after:'212c2da8da402295fcc8c6069b0638deba7c0d271c1a9939c3b5902f4ec597c5'}],
  ['apps/api/src/app.ts', {before:['81ec044b1c43fa4f889336358caeaace096cb660c35376080fb5b306ab90c90c'],after:'6d9f409fd31f203b321b3608fed10044d32e115e4723e70b569f25d60e522b35'}],
  ['apps/api/src/config.ts', {before:['57e07a049b2e2a689353019cb3269b90e74d1a50e908a805a6e7d4051acc0c0d'],after:'d6ef2a5190fa2185ac289474d3547454e9669ae2924004fe1aee73ab24c405ba'}],
  ['apps/api/src/providers/windows-lifecycle.ts', {before:['9cd75b88447c8a4d558b35d00a0dccb1c32716843101a1ffc86cffb4a3e95380'],after:'e4b3f5620efd0f4411c167296d63d9a75befacd2cecd0bb838dc7e290c09ad8c'}],
  ['apps/api/src/services/lifecycle-service.ts', {before:['2bc2acada832a4383cb37fa44521f9120a8af145bba5f6496521970cc533a3f0'],after:'7a314149dadf2403b4d586af1dbe4de2690226eb57beb6588815a9a6ec81b625'}],
  ['scripts/windows/lifecycle-broker/Invoke-DysonLifecycleBrokerWorker.ps1', {before:['bf7725ecd25c309c7f7e4c6e2050902e5919a920cc45896931a320634f6ff425','4c55d309e150b3f8cc5f52afb6f45affc8edef44974365f6e09ec92deede3a70'],after:'620e27b382b67509aad17facac91854d4442de7699302e8784735d7065a6fa4a'}]
])

// Immutable RC23 source bytes verified by local integration and target-host
// recovery checks. See docs/incremental-validation.md; edits never inherit reuse.
const rc23VerifiedSources = new Map([
  [".env.example", "ce7625087de978204de8c36bf777f6c1ee47d4865bf9d8ae20e027cab81dd382"],
  ["apps/api/package-lock.json", "b0fc9173b227c9cb87b06db4fabbc5ee164a4fcb9e68e151bbbd1170d1f22bd4"],
  ["apps/api/package.json", "f9cdb3c4b3130c5a2f2a7ff279d72740768f7f693608ad7180e7014db5c056f4"],
  ["apps/api/src/app.test.ts", "da90f1aef0cf8eea18cc942a26b12f5865bebda17f6d825354b33a491eca5cd8"],
  ["apps/api/src/app.ts", "6c1b83159f24f8911834fb0aca8d6fffa11e3ac850de13bd27351620510b5847"],
  ["apps/api/src/config.test.ts", "8ca04559be3eba3876c06508dcc80a041a6ab6d5fe9790546f6ae9fc35271cf2"],
  ["apps/api/src/config.ts", "f56375e7515c10bf029658043330d89fe369fc935667e8667c40f41c966dd234"],
  ["apps/api/src/configuration-apply-coordination.test.ts", "0a00855eaed2d0bed43f6805cc52f8f13abb90d4adf7481122720f36903bdcbb"],
  ["apps/api/src/configuration-reconcile-coordination.test.ts", "2d3d8ca2a48f59a051c1306d9474566858334084adbd82cfdf3d9e74f2c4ee5e"],
  ["apps/api/src/game-config/history-hard-exit.test.ts", "0e279fee028151e889f9f5a5965ebd8cc7c7f4739e4a7860c9f00f46d54afac4"],
  ["apps/api/src/game-config/history.test.ts", "873f9143c22a79883c6d6a3b4baa65cb75a97f3ad1ff88e12745d2a83314a026"],
  ["apps/api/src/game-config/history.ts", "f8fd17dcdcf28410f911d9de9aceebbda825bc0bce7a8183ec4bf1326f1714c8"],
  ["apps/api/src/game-config/transaction.test.ts", "4561b74316ab9dd5ca61ed40b6451ccf090b467d28558b7508a979f33b38fd46"],
  ["apps/api/src/game-config/transaction.ts", "f3365914bffc0c73d0cee84771e7d3c8c1f466b5734cb90f767e984f515bca29"],
  ["apps/api/src/host-mutation/residual-file-lock.test.ts", "0d5e75cb2724be3ab868ca9789de2ad5b201de75fc16dd1baf708c3bcba25282"],
  ["apps/api/src/host-mutation/residual-file-lock.ts", "421f5c2f52be614fc1fccd3b6b9c5018a3f3a911aebbf7022de606924814dbab"],
  ["apps/api/src/providers/powershell-output.test.ts", "6b17addafb342a10be5face0fa1cabfd00cb7abfd34b0185817250a353e915c2"],
  ["apps/api/src/providers/powershell-runner.ts", "0ecda7cd829daf472d311d6c41270ae6c5ccf60a891c16f5eedb4425e36b72b8"],
  ["apps/api/src/providers/windows-lifecycle.integration.test.ts", "f5a39c275aa6f0aacf9f652181295bcaa9590a93eb5ab2a94721b0dc71e7dcce"],
  ["apps/api/src/providers/windows-lifecycle.test.ts", "08b9fff9c0e6b8fa6961896bbc1e9557038fea162deac7bf789d0dc1d5d0bac8"],
  ["apps/api/src/providers/windows-lifecycle.ts", "5e32d9364c444d1a606215b11f01c5a330bfef5550a889a7670ed03b32c99163"],
  ["apps/api/src/providers/windows.ts", "f7c89a69e84221931113389fafc3922e0bd64395e994cff4fbc98e2aa57432b3"],
  ["apps/api/src/saves/restore-hard-exit.test.ts", "b297ff909beb47a97d5df3f482fdcec2ce71b173122b429d340c04ed5c4bc788"],
  ["apps/api/src/saves/transactions.ts", "b58b494950ecf972db60eda47847bfe2fe9196a59b95c00f51b5b68cbb22a5c8"],
  ["apps/api/src/services/save-job-service.test.ts", "8b64858f59634b4ea1d9fedd856eeae4edd395cdbb2d9558b8018bd0fc101284"],
  ["apps/api/src/services/save-job-service.ts", "9a20100f61bcb9dc4393e127dd36982a0ace838345c9a1659d6ac5940b413879"],
  ["apps/api/src/update-pipeline/acquisition.test.ts", "9e4b79656faff0ac040f625aadfb8bc6e855b3f18cca37626ffafb10eb481482"],
  ["apps/api/src/update-pipeline/acquisition.ts", "51233221385fadadda8eee75f2d44ceb3f22d67910fb443838f09557f457553d"],
  ["apps/api/src/update-pipeline/cache-mutex.test.ts", "d5af1b16c05a5716f48605965bff07a8e767dd29e4cb3a8bbc9ca67e90a0898a"],
  ["apps/api/src/update-pipeline/cache-mutex.ts", "677b91ceb8639722a5966a25db3decb5e0f5d286723ffa8fcec516c7efc7063a"],
  ["apps/api/src/update-pipeline/candidate-preparation.ts", "01738356f8454de8a6429280544632579e449a3940405f87bd823ee8cb8fb8cf"],
  ["apps/api/src/update-pipeline/staging.test.ts", "3e7a15f380895e48817a4688e0c3349a75cf383b7ac60eb8788cc3e1d2f98452"],
  ["apps/api/src/update-pipeline/staging.ts", "8279dc02d36e4373ac0bc5188b0dc59271469a1645bcce07ce1c9b8bd1eb1b3c"],
  ["apps/api/src/update-pipeline/steam-manual-handoff.test.ts", "1c60ce99efd38f0a8d63ffe440bf5aecb5421c96d279f600c5f5c065f6c52c87"],
  ["apps/api/src/update-pipeline/steam-manual-handoff.ts", "718100e77137a9b8d42638eec7d522fe2b9797c3cc79cdeba89baad4df0250d2"],
  ["apps/api/src/workspace-routes.test.ts", "c51dea7c13c771d8c55f87f06326aa0c2572b8935f8f70f1b8987dd864e313b4"],
  ["apps/web/package-lock.json", "27b062ecf2ed2ac88d38a30cd432132e9e38af1f683f73d0dc557fad54b76f2b"],
  ["apps/web/package.json", "a2e7c3f1d45457185867acdb76636316ea2f542d0b9eaa56b3da416265044c51"],
  ["apps/web/src/App.tsx", "3c8e1d5d7dad5a68ed6b3ba51e7a8a0fb86b4272e9af3d30a20d330d9c8613d4"],
  ["apps/web/src/api.ts", "8da161c4213d57c5aa010dbb731badd59d93c52fed2cc95bb9ccb0ab19a4e1e8"],
  ["apps/web/src/configuration-workspace.test.tsx", "f8d0db0349ecdf2cd648e7c70c34c55e9f0cbe118d7a1957c33b46f7de89c997"],
  ["apps/web/src/model.ts", "76efc918cb5ada5ed30726d69b692b833c71a757ce82591fb57518ccd516841e"],
  ["apps/web/src/styles.css", "db054a3c03f8489d240eb3a703dd6a9b67778461048c2f3b61cbe5cc65e06a26"],
  ["integrations/dyson-control-bridge/DysonControlBridge.csproj", "751afe5332e2d05f2c03d555abfd350b7d1fa8dd9368207f14f8f24d4c108b79"],
  ["integrations/dyson-control-bridge/DysonControlBridgePlugin.cs", "8419c3114da427e5bfad5231cfe7fd26a001b5b7d6150b234f4d5c4c6a8e58a4"],
  ["package-lock.json", "b96775591b9aa67e96616dee8db733ec486f74f3bbb612b92b8e53a574ecd094"],
  ["package.json", "d8edd1c6d3e9fd5a55d1411680c0860a4a1888ee893ae74db344f7daf463fb80"],
  ["scripts/windows/configuration/dyson-control.environment-contract.json", "8ae71deb1f48f4b32b415b8fa6071b2ca3718e02a439d7bd5bd4fcdffb9c31e0"]
])

// Reuse the existing configuration gate without migrating the persisted contract.
const configurationGateSources = new Map([
  [".env.example", "6ea35413832696eb4fb1dd5d2ee4247df56d7173b37ac65821f8a6088ad2ee76"],
  ["apps/api/src/config.ts", "a4f154beec0605fa66b67b6fc7e340ec9e26158c494f99d134829190d788b9ca"],
  ["apps/api/src/config.test.ts", "a80d70a009148924def94a384ae49acb1518c427b9b1e758557bd86723cb8d99"],
  ["scripts/windows/configuration/dyson-control.environment-contract.json", "5386f42df066b3d5ce4fa26f3346baf4311b0ec8efb1eb4d83bdf488c14786dc"]
])

export function classifyChange(file, before, after) {
  if (after === null) throw new Error(`Deletion requires an updated validation plan: ${file}`)
  if (rc23VerifiedSources.get(file) === aclSourceHash(after)) return 'verified-rc23-source'
  if (configurationGateSources.get(file) === aclSourceHash(after)) return 'configuration-gate'
  const startup = startupSources.get(file)
  if (startup && before !== null && startup.before.includes(startupSourceHash(before)) &&
      startup.after === startupSourceHash(after)) return 'startup-policy'
  if (file === 'scripts/windows/lifecycle-broker/Invoke-DysonLifecycleBrokerWorker.ps1' && before !== null &&
      aclSourceHash(before) === 'bf7725ecd25c309c7f7e4c6e2050902e5919a920cc45896931a320634f6ff425' &&
      aclSourceHash(after) === '4c55d309e150b3f8cc5f52afb6f45affc8edef44974365f6e09ec92deede3a70') return 'verify-blocker-array'
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
  if (versionFiles.has(file) && before !== null) {
    if (file.endsWith('package.json') || file.endsWith('package-lock.json')) {
      try {
        const previous = JSON.parse(before), current = JSON.parse(after)
        if (current.version === '0.1.0-rc.23') {
          previous.version = current.version
          if (file.endsWith('package-lock.json')) {
            if (current.packages[''].version !== current.version) throw new Error('root version mismatch')
            previous.packages[''].version = current.packages[''].version
          }
          if (JSON.stringify(previous) === JSON.stringify(current)) return 'version-only'
        }
      } catch { /* A dependency or structural change requires a reviewed plan. */ }
    } else {
      const priorVersions = new Set(normalize(before).match(/0\.1\.0-rc\.[0-9]+/gu) ?? [])
      if ([...priorVersions].some(version => version !== '0.1.0-rc.23' &&
          normalize(before).replaceAll(version, '0.1.0-rc.23') === normalize(after))) return 'version-only'
    }
  }
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
  if (['apps/api/src/providers/powershell-runner.ts', 'apps/api/src/providers/powershell-runner.test.ts']
      .some(file => changed('lifecycle').has(file))) {
    commands.push(['node', ['apps/api/node_modules/vitest/vitest.mjs', 'run', '--root', 'apps/api', '--maxWorkers=4',
      'src/providers/powershell-runner.test.ts', 'src/providers/windows-lifecycle-broker.test.ts']])
  }
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
  if (args.includes('/lifecycle-broker/') || args.includes('powershell-runner.test.ts')) return 'lifecycle'
  if (args.includes('/data-recovery/')) return 'recovery'
  if (args.includes('windows-status-script.test.ts')) return 'status'
  return null
}

export function planExecution(changes, { componentChanges, hostChecks = false, fullDeployment = false } = {}) {
  const startupChanged = changes.some(change => change.kind === 'startup-policy')
  const verifyBlockersChanged = changes.some(change => change.kind === 'verify-blocker-array')
  const aclChanged = changes.some(change => change.kind === 'expected-exit-acl')
  const controlExitChanged = changes.some(change => change.kind === 'control-exit-policy')
  const requested = rows => rows.map(change => hostChecks && change.kind === 'test-only' &&
    !((controlExitChanged || aclChanged) && change.file === 'scripts/windows/bootstrap/SelfTest-DysonGameLifecycleBootstrap.ps1') &&
    !((verifyBlockersChanged || startupChanged) && change.file === 'scripts/windows/lifecycle-broker/SelfTest-DysonLifecycleBroker.ps1')
    ? { ...change, kind: 'affected' } : change)
  const selected = selectCommands(requested(changes), { componentChanges: componentChanges &&
    Object.fromEntries(Object.entries(componentChanges).map(([group, rows]) => [group, requested(rows)])) })
  const isRunnerCheck = ([, args]) => args.includes('src/providers/powershell-runner.test.ts')
  const hostCommands = selected.slice(2).filter(command => !isRunnerCheck(command))
  const commands = [...selected.slice(0, 2), ...selected.slice(2).filter(isRunnerCheck)]
  if (changes.some(change => change.kind === 'configuration-gate')) commands.push(['node',
    ['apps/api/node_modules/vitest/vitest.mjs', 'run', '--root', 'apps/api', '--maxWorkers=2',
      'src/config.test.ts', 'src/configuration-apply-coordination.test.ts', 'src/configuration-reconcile-coordination.test.ts']])
  if (controlExitChanged) commands.push(['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', 'scripts/windows/bootstrap/SelfTest-DysonGameLifecycleBootstrap.ps1', '-ExitPolicyOnly']])
  if (aclChanged) commands.push(['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', 'scripts/windows/bootstrap/SelfTest-DysonGameLifecycleBootstrap.ps1', '-ExpectedExitAclOnly']])
  if (verifyBlockersChanged) commands.push(['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', 'scripts/windows/lifecycle-broker/SelfTest-DysonLifecycleBroker.ps1', '-VerifyEvidenceOnly']])
  if (startupChanged || changes.some(change => ['apps/api/src/config.test.ts',
      'apps/api/src/providers/windows-lifecycle.test.ts', 'apps/api/src/services/lifecycle-service.test.ts']
      .includes(change.file) && change.kind === 'affected')) {
    commands.push(['node', ['apps/api/node_modules/vitest/vitest.mjs', 'run', '--root', 'apps/api', '--maxWorkers=4',
      'src/app.test.ts', 'src/config.test.ts', 'src/providers/windows-lifecycle.test.ts', 'src/services/lifecycle-service.test.ts']])
  }
  if (changes.some(change => change.kind === 'startup-policy' && change.file.endsWith('Invoke-DysonLifecycleBrokerWorker.ps1'))) {
    commands.push(['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', 'scripts/windows/lifecycle-broker/SelfTest-DysonLifecycleBroker.ps1', '-DispatchStateOnly']])
  }
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
      decision: kind === 'configuration-gate' ? 'run focused shared configuration gate checks' :
        kind === 'verified-rc23-source' ? 'reuse exact RC23 source evidence; production qualification remains separate' :
        kind === 'control-exit-policy' ? 'reviewed runtime change: execute the focused exit-policy check' :
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

import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyChange, selectCommands, planExecution } from './validate-incremental.mjs'

test('version reuse permits only the exact reviewed version substitution', () => {
  assert.equal(classifyChange('apps/api/src/config.ts', 'v=0.1.0-rc.17\r\n', 'v=0.1.0-rc.19\n'), 'version-only')
  assert.throws(() => classifyChange('apps/api/src/config.ts', 'v=0.1.0-rc.17', 'v=0.1.0-rc.19; unsafe=true'))
  assert.throws(() => classifyChange('apps/api/package-lock.json', 'old dependency', 'new dependency'))
})

test('a metadata-only candidate reuses functional results', () => {
  const commands = selectCommands([{ file: 'package.json', kind: 'version-only' }])
  assert.equal(commands.length, 2)
  assert.ok(commands.every(([executable]) => executable === 'node'))
  assert.ok(commands.every(([, args]) => !args.some(arg => arg.includes('vitest'))))
})

test('a status adapter change selects the related provider regressions', () => {
  const commands = selectCommands([{ file: 'scripts/windows/Get-DysonStatus.ps1', kind: 'affected' }])
  assert.ok(commands.some(([, args]) => args.includes('src/providers/windows.test.ts')))
  assert.ok(commands.every(([executable]) => executable !== 'powershell.exe'))
})

test('a combined change retains both affected regression groups', () => {
  const commands = selectCommands([
    { file: 'scripts/windows/Get-DysonStatus.ps1', kind: 'affected' },
    { file: 'scripts/windows/data-recovery/DysonDataRootRecovery.Common.ps1', kind: 'affected' }
  ])
  assert.ok(commands.some(([, args]) => args.includes('src/providers/windows.test.ts')))
  assert.ok(commands.some(([executable, args]) => executable === 'powershell.exe' &&
    args.includes('scripts/windows/data-recovery/SelfTest-DysonDataRootRecovery.ps1')))
})
test('unknown paths and deletions stop instead of silently skipping tests', () => {
  assert.throws(() => classifyChange('apps/api/src/auth.ts', 'a', 'b'))
  assert.throws(() => classifyChange('scripts/windows/Get-DysonStatus.ps1', 'a', null))
  assert.throws(() => classifyChange('apps/api/src/config.ts', null, 'new'))
})

test('deployment coordination selects integration checks without retesting an unchanged broker', () => {
  const file = 'scripts/windows/deployment/Install-DysonControl.ps1'
  assert.equal(classifyChange(file, 'old', 'new'), 'affected')
  const commands = selectCommands([{ file, kind: 'affected' }])
  for (const script of ['scripts/windows/deployment/SelfTest-DysonControlDeployment.ps1']) {
    assert.ok(commands.some(([exe, args]) => exe === 'powershell.exe' && args.includes(script)))
  }
  assert.ok(commands.every(([, args]) => !args.includes('scripts/windows/lifecycle-broker/SelfTest-DysonLifecycleBroker.ps1')))
  const buildIndex = commands.findIndex(([, args]) => args.includes('apps/api/tsconfig.json'))
  const deploymentIndex = commands.findIndex(([, args]) => args.includes('scripts/windows/deployment/SelfTest-DysonControlDeployment.ps1'))
  assert.ok(buildIndex >= 0 && buildIndex < deploymentIndex)
  assert.ok(commands.every(([, args]) => !args.includes('check')))
})

test('default validation declares missing host evidence instead of running the long deployment suite', () => {
  const plan = planExecution([{ file: 'scripts/windows/deployment/Install-DysonControl.ps1', kind: 'affected' }])
  assert.equal(plan.mode, 'fast')
  assert.equal(plan.commands.length, 2)
  assert.ok(plan.pendingHostCommands.some(([, args]) => args.includes('scripts/windows/deployment/SelfTest-DysonControlDeployment.ps1')))
  assert.equal(plan.components.find(item => item.group === 'deployment').decision, 'host-validation-required')
})

test('target-host mode runs only changed components and full deployment remains explicit', () => {
  const changes = [
    { file: 'scripts/windows/bootstrap/DysonGameLifecycleBootstrap.Common.ps1', kind: 'affected' },
    { file: 'scripts/windows/deployment/Install-DysonControl.ps1', kind: 'affected' }
  ]
  const focused = planExecution(changes, { hostChecks: true })
  assert.ok(focused.commands.some(([, args]) => args.includes('scripts/windows/bootstrap/SelfTest-DysonGameLifecycleBootstrap.ps1')))
  assert.ok(focused.commands.every(([, args]) => !args.includes('scripts/windows/deployment/SelfTest-DysonControlDeployment.ps1')))
  const explicit = planExecution(changes, { hostChecks: true, fullDeployment: true })
  assert.equal(explicit.pendingHostCommands.length, 0)
  assert.ok(explicit.commands.some(([, args]) => args.includes('scripts/windows/deployment/SelfTest-DysonControlDeployment.ps1')))
})

test('component evidence reuses an already verified change independently', () => {
  const changes = [{ file: 'scripts/windows/deployment/Install-DysonControl.ps1', kind: 'affected' }]
  const plan = planExecution(changes, { componentChanges: { deployment: [] } })
  assert.equal(plan.pendingHostCommands.length, 0)
  assert.equal(plan.components.find(item => item.group === 'deployment').decision, 'reuse')
})

test('documentation and test-only edits do not imply production transaction changes', () => {
  assert.equal(classifyChange('README.md', 'old', 'new'), 'documentation')
  const file = 'scripts/windows/deployment/SelfTest-DysonControlDeployment.ps1'
  const kind = classifyChange(file, 'old', 'new')
  assert.equal(kind, 'test-only')
  const plan = planExecution([{ file, kind }])
  assert.equal(plan.pendingHostCommands.length, 0)
  assert.deepEqual(plan.syntaxFiles, [file])
  assert.ok(plan.commands.some(([, args]) => args.includes('-EncodedCommand')))
  const explicit = planExecution([{ file: 'scripts/windows/bootstrap/SelfTest-DysonGameLifecycleBootstrap.ps1', kind: 'test-only' }], { hostChecks: true })
  assert.ok(explicit.commands.some(([, args]) => args.includes('scripts/windows/bootstrap/SelfTest-DysonGameLifecycleBootstrap.ps1')))
})

test('bootstrap resolution selects pointer and runtime regressions', () => {
  const file = 'scripts/windows/bootstrap/DysonGameLifecycleBootstrap.Common.ps1'
  assert.equal(classifyChange(file, 'old', 'new'), 'affected')
  const commands = selectCommands([{ file, kind: 'affected' }])
  for (const script of ['SelfTest-DysonGameBootstrapPointer.ps1', 'SelfTest-DysonGameLifecycleBootstrap.ps1']) {
    assert.ok(commands.some(([, args]) => args.includes(`scripts/windows/bootstrap/${script}`)))
  }
  assert.ok(commands.every(([, args]) => !args.includes('scripts/windows/deployment/SelfTest-DysonControlDeployment.ps1')))
})

test('the reviewed console-exit change uses only its focused source guard regression', () => {
  const changes = [
    { file: 'scripts/windows/Start-DysonServer.ps1', kind: 'control-exit-policy' },
    { file: 'scripts/windows/bootstrap/SelfTest-DysonGameLifecycleBootstrap.ps1', kind: 'test-only' }
  ]
  for (const options of [{}, { hostChecks: true }]) {
    const plan = planExecution(changes, options)
    assert.equal(plan.pendingHostCommands.length, 0)
    const bootstrap = plan.commands.filter(([, args]) => args.includes('scripts/windows/bootstrap/SelfTest-DysonGameLifecycleBootstrap.ps1'))
    assert.equal(bootstrap.length, 1)
    assert.ok(bootstrap[0][1].includes('-ExitPolicyOnly'))
    assert.ok(plan.commands.every(([, args]) => !args.includes('scripts/windows/deployment/SelfTest-DysonControlDeployment.ps1')))
  }
  assert.throws(() => classifyChange('scripts/windows/Start-DysonServer.ps1', 'old unrelated code', 'new unrelated code'))
})
test('the status adapter and validation infrastructure have explicit mappings', () => {
  for (const file of ['scripts/windows/Get-DysonStatus.ps1', '.github/workflows/ci.yml', 'global.json']) {
    assert.equal(classifyChange(file, 'old', 'new'), 'affected')
  }
})

test('the reviewed expected-exit ACL fix runs only its denied-WRITE_OWNER regression', () => {
  const changes = [
    { file: 'scripts/windows/bootstrap/DysonGameLifecycleBootstrap.Common.ps1', kind: 'expected-exit-acl' },
    { file: 'scripts/windows/bootstrap/SelfTest-DysonGameLifecycleBootstrap.ps1', kind: 'test-only' }
  ]
  for (const options of [{}, { hostChecks: true }]) {
    const plan = planExecution(changes, options)
    assert.equal(plan.pendingHostCommands.length, 0)
    const checks = plan.commands.filter(([, args]) => args.includes('scripts/windows/bootstrap/SelfTest-DysonGameLifecycleBootstrap.ps1'))
    assert.equal(checks.length, 1)
    assert.ok(checks[0][1].includes('-ExpectedExitAclOnly'))
  }
  assert.equal(classifyChange(changes[0].file, 'unreviewed old source', 'unreviewed new source'), 'affected')
})

test('the exact verify blocker array change runs its three serialization cases', () => {
  const file = 'scripts/windows/lifecycle-broker/Invoke-DysonLifecycleBrokerWorker.ps1'
  const changes = [{ file, kind: 'verify-blocker-array' },
    { file: 'scripts/windows/lifecycle-broker/SelfTest-DysonLifecycleBroker.ps1', kind: 'test-only' }]
  for (const options of [{}, {hostChecks:true}]) {
    const plan = planExecution(changes, options)
    assert.equal(plan.pendingHostCommands.length, 0)
    const checks = plan.commands.filter(([,args]) => args.includes('scripts/windows/lifecycle-broker/SelfTest-DysonLifecycleBroker.ps1'))
    assert.equal(checks.length, 1)
    assert.ok(checks[0][1].includes('-VerifyEvidenceOnly'))
  }
  assert.equal(classifyChange(file, 'other before', 'other after'), 'affected')
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyChange, selectCommands } from './validate-incremental.mjs'

test('version reuse permits only the exact reviewed version substitution', () => {
  assert.equal(classifyChange('apps/api/src/config.ts', 'v=0.1.0-rc.15\r\n', 'v=0.1.0-rc.16\n'), 'version-only')
  assert.throws(() => classifyChange('apps/api/src/config.ts', 'v=0.1.0-rc.15', 'v=0.1.0-rc.16; unsafe=true'))
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
test('the status adapter and validation infrastructure have explicit mappings', () => {
  for (const file of ['scripts/windows/Get-DysonStatus.ps1', '.github/workflows/ci.yml', 'global.json']) {
    assert.equal(classifyChange(file, 'old', 'new'), 'affected')
  }
})

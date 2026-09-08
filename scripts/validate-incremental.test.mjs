import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyChange } from './validate-incremental.mjs'

test('version reuse permits only the exact reviewed version substitution', () => {
  assert.equal(classifyChange('apps/api/src/config.ts', 'v=0.1.0-rc.14\r\n', 'v=0.1.0-rc.15\n'), 'version-only')
  assert.throws(() => classifyChange('apps/api/src/config.ts', 'v=0.1.0-rc.14', 'v=0.1.0-rc.15; unsafe=true'))
  assert.throws(() => classifyChange('apps/api/package-lock.json', 'old dependency', 'new dependency'))
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

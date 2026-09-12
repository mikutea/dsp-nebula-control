import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveGameRuntimeReceiptLocation } from './app.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'dyson-runtime-layout-')))
  roots.push(root)
  const bootstrap = path.join(root, 'bootstrap')
  const deployment = path.join(root, 'deployment')
  await Promise.all([mkdir(bootstrap), mkdir(path.join(deployment, 'data'), { recursive: true })])
  const layout = { protocol: 'DYSON_CONTROL_GAME_BOOTSTRAP_LAYOUT_V1', schemaVersion: 1,
    dataRoot: deployment, dataRootIdentity: createHash('sha256').update(deployment.toUpperCase()).digest('hex'),
    createdAt: '2026-09-01T00:00:00.0000000Z' }
  const config = { dataDir: path.join(deployment, 'data'), runtimeBootstrapRoot: bootstrap,
    nodeEnv: 'production' as const, deploymentVersion: '0.1.0-test', lifecycleEnabled: true }
  const save = async (value: unknown) => writeFile(path.join(bootstrap, 'bootstrap-layout.json'), JSON.stringify(value))
  return { root, bootstrap, deployment, layout, config, save }
}

describe('game runtime receipt data root', () => {
  it('uses the declared deployment root and binds the exact layout bytes', async () => {
    const f = await fixture()
    await f.save(f.layout)
    const result = await resolveGameRuntimeReceiptLocation(f.config)
    expect(result.dataRoot).toBe(f.deployment)
    expect(result.layoutSha256).toMatch(/^[0-9a-f]{64}$/)
    await f.save({ ...f.layout, createdAt: '2026-09-02T00:00:00Z' })
    expect((await resolveGameRuntimeReceiptLocation(f.config)).layoutSha256).not.toBe(result.layoutSha256)
  })

  it('does not guess a parent when a managed deployment marker is absent', async () => {
    const f = await fixture()
    await expect(resolveGameRuntimeReceiptLocation(f.config)).rejects.toThrow('GAME_RUNTIME_LAYOUT_INVALID')
    expect(await resolveGameRuntimeReceiptLocation({ ...f.config, runtimeBootstrapRoot: null }))
      .toEqual({ dataRoot: f.config.dataDir, layoutSha256: null })
  })

  it('rejects a mismatched identity, unrelated root and extra fields', async () => {
    const f = await fixture()
    for (const layout of [{ ...f.layout, dataRootIdentity: '0'.repeat(64) },
      { ...f.layout, allowParentSearch: true }]) {
      await f.save(layout)
      await expect(resolveGameRuntimeReceiptLocation(f.config)).rejects.toThrow('GAME_RUNTIME_LAYOUT_INVALID')
    }
    await f.save(f.layout)
    await expect(resolveGameRuntimeReceiptLocation({ ...f.config, dataDir: path.join(f.root, 'unrelated') }))
      .rejects.toThrow('GAME_RUNTIME_LAYOUT_INVALID')
  })

  it('rejects redirected bootstrap directories', async () => {
    const f = await fixture()
    await f.save(f.layout)
    const alias = path.join(f.root, 'redirected')
    await symlink(f.bootstrap, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(resolveGameRuntimeReceiptLocation({ ...f.config, runtimeBootstrapRoot: alias }))
      .rejects.toThrow('GAME_RUNTIME_LAYOUT_INVALID')
  })
})

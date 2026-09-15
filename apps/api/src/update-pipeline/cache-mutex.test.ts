import { spawnSync } from 'node:child_process'
import { link, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireCacheMutex } from './cache-mutex.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir())) throw new Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await mkdtemp(path.join(path.resolve(os.tmpdir()), 'dyson-cache-mutex-'))
  roots.push(root)
  return { root, lockPath: path.join(root, 'artifact.lock') }
}
async function abandonedLock(lockPath: string) {
  const source = new URL('./cache-mutex.ts', import.meta.url).href
  const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href
  const child = spawnSync(process.execPath, ['--import', loader, '--input-type=module', '--eval',
    `import { acquireCacheMutex } from ${JSON.stringify(source)}; await acquireCacheMutex(process.argv[1]); process.exit(75);`, lockPath],
  { windowsHide: true, timeout: 15_000, encoding: 'utf8', maxBuffer: 64 * 1024 })
  expect(child.status, child.stderr).toBe(75)
}

describe('recoverable cache metadata mutex', () => {
  it('does not take an active process lock and releases its own lock', async () => {
    const { lockPath } = await fixture()
    const owned = await acquireCacheMutex(lockPath)
    await expect(acquireCacheMutex(lockPath)).rejects.toMatchObject({ code: 'CACHE_MUTEX_BUSY' })
    await owned.release()
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reacquires an exact resource after an owning child exits', async () => {
    const { lockPath } = await fixture()
    await abandonedLock(lockPath)
    const old = JSON.parse(await readFile(lockPath, 'utf8'))
    const owned = await acquireCacheMutex(lockPath)
    const next = JSON.parse(await readFile(lockPath, 'utf8'))
    expect(next.binding).toBe(old.binding)
    expect(next.instanceId).not.toBe(old.instanceId)
    expect(next.pid).toBe(process.pid)
    await owned.release()
  })

  it.each(['legacy', 'foreign-host', 'different-resource', 'hard-linked'])(
    'preserves unproven ownership: %s', async mode => {
      const { root, lockPath } = await fixture()
      await abandonedLock(lockPath)
      const owner = JSON.parse(await readFile(lockPath, 'utf8'))
      let target = lockPath
      if (mode === 'legacy') await writeFile(lockPath, `${owner.pid}\n`)
      if (mode === 'foreign-host') await writeFile(lockPath, JSON.stringify({ ...owner, host: 'fictional-remote-host' }))
      if (mode === 'different-resource') { target = path.join(root, 'other.lock'); await rename(lockPath, target) }
      if (mode === 'hard-linked') await link(lockPath, path.join(root, 'second-link'))
      const before = await readFile(target)
      await expect(acquireCacheMutex(target)).rejects.toMatchObject({ code: 'CACHE_MUTEX_BUSY' })
      expect(await readFile(target)).toEqual(before)
    }
  )

  it.each(['in-place', 'replacement'])('does not delete a %s change during release', async mode => {
    const { root, lockPath } = await fixture()
    const owned = await acquireCacheMutex(lockPath)
    const original = await readFile(lockPath)
    if (mode === 'replacement') await rename(lockPath, path.join(root, 'original.lock'))
    const replacement = mode === 'replacement' ? original : Buffer.from('foreign owner')
    await writeFile(lockPath, replacement)
    await expect(owned.release()).rejects.toMatchObject({ code: 'CACHE_MUTEX_CHANGED' })
    expect(await readFile(lockPath)).toEqual(replacement)
  })
})

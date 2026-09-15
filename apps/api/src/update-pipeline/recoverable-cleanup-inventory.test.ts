import { realpath, mkdtemp, mkdir, writeFile, rename, rm, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { inspectCleanupObject } from './recoverable-cleanup-inventory.js'
it('keeps a release tree identity across quarantine and detects renamed content', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cleanup-tree-')))
  try {
    const source = path.join(root, 'source'), quarantine = path.join(root, 'quarantine')
    await mkdir(path.join(source, 'empty'), { recursive: true })
    await writeFile(path.join(source, 'component.bin'), 'fictional component')
    const original = await inspectCleanupObject(source)
    await rename(source, quarantine)
    expect(await inspectCleanupObject(source)).toBeNull()
    expect(await inspectCleanupObject(quarantine)).toEqual(original)
    await rename(path.join(quarantine, 'component.bin'), path.join(quarantine, 'changed.bin'))
    expect(await inspectCleanupObject(quarantine)).not.toEqual(original)
  } finally { await rm(root, { recursive: true, force: true }) }
})
it('rejects hardlinked material instead of trusting shared bytes', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cleanup-link-')))
  try {
    await writeFile(path.join(root, 'original'), 'fictional')
    await link(path.join(root, 'original'), path.join(root, 'alias'))
    await expect(inspectCleanupObject(path.join(root, 'alias'))).rejects.toThrow('UPDATE_CLEANUP_PATH_INVALID')
  } finally { await rm(root, { recursive: true, force: true }) }
})

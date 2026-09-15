import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeVerifiedResidualFileLock } from './residual-file-lock.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir())) throw new Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture(bytes = '{"requestId":"fictional-owned-request"}') {
  const root = await mkdtemp(path.join(path.resolve(os.tmpdir()), 'dyson-residual-lock-'))
  roots.push(root)
  const lockPath = path.join(root, 'transaction.lock')
  await writeFile(lockPath, bytes)
  const controller = new AbortController()
  return {
    lockPath, bytes, controller,
    expectedSha256: createHash('sha256').update(bytes).digest('hex'),
    scope: { signal: controller.signal, assertActive() {}, toPowerShellBorrowArguments: () => [] }
  }
}

describe('authorized residual file lock removal', () => {
  it('removes only the unchanged lock authorized by its domain evidence', async () => {
    const value = await fixture()
    let authorized = false
    await removeVerifiedResidualFileLock({ ...value, authorize: async evidence => {
      expect(evidence.bytes.toString()).toBe(value.bytes)
      expect(evidence.inode).not.toBe('0')
      authorized = true
    } })
    expect(authorized).toBe(true)
    await expect(readFile(value.lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves a lock when domain recovery authority rejects its owner', async () => {
    const value = await fixture()
    await expect(removeVerifiedResidualFileLock({ ...value, authorize: async () => {
      throw new Error('FOREIGN_REQUEST')
    } })).rejects.toThrow('FOREIGN_REQUEST')
    expect(await readFile(value.lockPath, 'utf8')).toBe(value.bytes)
  })

  it('preserves an exact-content replacement made during authorization', async () => {
    const value = await fixture()
    await expect(removeVerifiedResidualFileLock({ ...value, authorize: async () => {
      await unlink(value.lockPath)
      await writeFile(value.lockPath, value.bytes)
    } })).rejects.toMatchObject({ code: 'RESIDUAL_LOCK_CHANGED' })
    expect(await readFile(value.lockPath, 'utf8')).toBe(value.bytes)
  })

  it('preserves an in-place modification made during authorization', async () => {
    const value = await fixture()
    let recovered = false
    await expect(removeVerifiedResidualFileLock({ ...value, authorize: async () => {
      await writeFile(value.lockPath, 'foreign-owner')
    }, beforeRemove: async () => { recovered = true } })).rejects.toMatchObject({ code: 'RESIDUAL_LOCK_CHANGED' })
    expect(recovered).toBe(false)
    expect(await readFile(value.lockPath, 'utf8')).toBe('foreign-owner')
  })

  it('holds the lock through domain completion and retains it if recovery fails', async () => {
    const value = await fixture()
    await expect(removeVerifiedResidualFileLock({ ...value, authorize: async () => {}, beforeRemove: async () => {
      expect(await readFile(value.lockPath, 'utf8')).toBe(value.bytes)
      throw new Error('RECOVERY_INCOMPLETE')
    } })).rejects.toThrow('RECOVERY_INCOMPLETE')
    expect(await readFile(value.lockPath, 'utf8')).toBe(value.bytes)
  })

  it('rechecks the lock after domain recovery before removing it', async () => {
    const value = await fixture()
    await expect(removeVerifiedResidualFileLock({ ...value, authorize: async () => {}, beforeRemove: async () => {
      await writeFile(value.lockPath, 'changed-during-recovery')
    } })).rejects.toMatchObject({ code: 'RESIDUAL_LOCK_CHANGED' })
    expect(await readFile(value.lockPath, 'utf8')).toBe('changed-during-recovery')
  })

  it('preserves the lock if the recovery scope is cancelled before removal', async () => {
    const value = await fixture()
    await expect(removeVerifiedResidualFileLock({ ...value, authorize: async () => {
      value.controller.abort()
    } })).rejects.toMatchObject({ code: 'RESIDUAL_LOCK_CHANGED' })
    expect(await readFile(value.lockPath, 'utf8')).toBe(value.bytes)
  })

  it.each(['', 'x'.repeat(4_097)])('rejects an empty or oversized lock without authorizing it', async bytes => {
    const value = await fixture(bytes)
    let called = false
    await expect(removeVerifiedResidualFileLock({ ...value, authorize: async () => { called = true } }))
      .rejects.toMatchObject({ code: 'RESIDUAL_LOCK_INVALID' })
    expect(called).toBe(false)
    expect(await readFile(value.lockPath, 'utf8')).toBe(bytes)
  })
})

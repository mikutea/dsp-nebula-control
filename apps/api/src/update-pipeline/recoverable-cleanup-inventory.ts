import { createHash } from 'node:crypto'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { CleanupObjectEvidence } from './recoverable-cleanup-move.js'
const samePath = (a: string, b: string) => process.platform === 'win32'
  ? a.toLowerCase() === b.toLowerCase() : a === b
/** Bounded inventory for fixed-root quarantine plans; directory hashes include
 * relative names and empty directories, not machine-specific absolute paths. */
export async function inspectCleanupObject(root: string): Promise<CleanupObjectEvidence | null> {
  if (!path.isAbsolute(root) || path.resolve(root) === path.parse(root).root) throw new Error('UPDATE_CLEANUP_PATH_INVALID')
  const resolved = path.resolve(root)
  const initial = await lstat(resolved).catch(error => { if (error?.code === 'ENOENT') return null; throw error })
  if (!initial) return null
  let count = 0, total = 0
  const entries: Array<{ name: string; kind: 'file' | 'directory'; sha256?: string; sizeBytes?: number }> = []
  async function visit(file: string, name: string, depth: number): Promise<void> {
    if (++count > 4096 || depth > 16) throw new Error('UPDATE_CLEANUP_INVENTORY_LIMIT')
    const before = await lstat(file)
    if (before.isSymbolicLink() || !samePath(await realpath(file), file)) throw new Error('UPDATE_CLEANUP_PATH_INVALID')
    if (before.isDirectory()) {
      entries.push({ name, kind: 'directory' })
      for (const child of (await readdir(file)).sort()) {
        if (child.includes(':') || child.includes('\\') || child.includes('/') || child === '.' || child === '..') throw new Error('UPDATE_CLEANUP_PATH_INVALID')
        await visit(path.join(file, child), name ? name + '/' + child : child, depth + 1)
      }
    } else if (before.isFile() && before.nlink === 1) {
      total += before.size
      if (!Number.isSafeInteger(total) || total > 1024 * 1024 * 1024) throw new Error('UPDATE_CLEANUP_INVENTORY_LIMIT')
      const handle = await open(file, 'r')
      const hash = createHash('sha256')
      try {
        const opened = await handle.stat()
        if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size || opened.nlink !== 1) throw new Error('UPDATE_CLEANUP_SOURCE_CHANGED')
        const buffer = Buffer.alloc(1024 * 1024)
        let offset = 0
        while (offset < before.size) {
          const read = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset)
          if (!read.bytesRead) throw new Error('UPDATE_CLEANUP_SOURCE_CHANGED')
          hash.update(buffer.subarray(0, read.bytesRead)); offset += read.bytesRead
        }
        entries.push({ name, kind: 'file', sha256: hash.digest('hex'), sizeBytes: before.size })
      } finally { await handle.close() }
    } else throw new Error('UPDATE_CLEANUP_PATH_INVALID')
    const after = await lstat(file)
    if (after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.nlink !== before.nlink) throw new Error('UPDATE_CLEANUP_SOURCE_CHANGED')
  }
  await visit(resolved, '', 0)
  return { sizeBytes: total, sha256: initial.isFile() ? entries[0]!.sha256!
    : createHash('sha256').update('dyson-cleanup-tree-v1\0').update(JSON.stringify(entries)).digest('hex') }
}

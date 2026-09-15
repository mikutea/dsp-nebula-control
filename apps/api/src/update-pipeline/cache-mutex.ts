import { createHash, randomUUID } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { lstat, open, realpath, unlink, type FileHandle } from 'node:fs/promises'
import { hostname } from 'node:os'
import path from 'node:path'

export class CacheMutexError extends Error {
  constructor(readonly code: 'CACHE_MUTEX_BUSY' | 'CACHE_MUTEX_INVALID' | 'CACHE_MUTEX_CHANGED') {
    super(code); this.name = 'CacheMutexError'
  }
}

export interface CacheMutex { release(): Promise<void> }

/** Local cache/state metadata only. Reclaiming this mutex never authorizes a
 * live game mutation or replaces a domain's global mutation/recovery lease.
 * Legacy PID-only, foreign-host, live-owner, and unverified files stay intact. */
export async function acquireCacheMutex(lockPath: string): Promise<CacheMutex> {
  const parent = await realpath(path.dirname(lockPath))
  if (!path.isAbsolute(lockPath) || canonical(parent) !== canonical(path.dirname(lockPath))) throw new CacheMutexError('CACHE_MUTEX_INVALID')
  const binding = digest(Buffer.from(canonical(lockPath)))
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle: FileHandle | null = null
    try {
      handle = await open(lockPath, 'wx+', 0o600)
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error
      if (attempt !== 0 || !await reclaim(lockPath, binding)) throw new CacheMutexError('CACHE_MUTEX_BUSY')
      continue
    }
    try {
      const bytes = Buffer.from(`${JSON.stringify({ format: 'dyson-cache-mutex', version: 1,
        binding, host: hostname(), pid: process.pid, instanceId: randomUUID() })}\n`)
      await handle.writeFile(bytes)
      await handle.sync()
      const identity = await handle.stat({ bigint: true })
      assertRegular(identity)
      const owned = handle
      let released = false
      return { async release() {
        if (released) return
        released = true
        try { await verify(lockPath, owned, identity, bytes); await unlink(lockPath) }
        finally { await owned.close() }
      } }
    } catch (error) {
      await handle.close().catch(() => undefined)
      // An incomplete ownership record cannot be safely reclaimed automatically.
      throw error
    }
  }
  throw new CacheMutexError('CACHE_MUTEX_BUSY')
}

async function reclaim(lockPath: string, binding: string): Promise<boolean> {
  let handle: FileHandle | null = null
  try {
    const before = await lstat(lockPath, { bigint: true })
    assertRegular(before)
    if (canonical(await realpath(lockPath)) !== canonical(lockPath)) return false
    handle = await open(lockPath, 'r')
    const identity = await handle.stat({ bigint: true })
    assertSame(before, identity)
    const bytes = await readBounded(handle, identity)
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const owner = value as Record<string, unknown>
    if (Object.keys(owner).sort().join(',') !== 'binding,format,host,instanceId,pid,version' ||
        owner.format !== 'dyson-cache-mutex' || owner.version !== 1 || owner.binding !== binding || owner.host !== hostname() ||
        !Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0 || typeof owner.instanceId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(owner.instanceId)) return false
    try { process.kill(Number(owner.pid), 0); return false } catch (error) { if (!hasCode(error, 'ESRCH')) return false }
    await verify(lockPath, handle, identity, bytes)
    await unlink(lockPath)
    return true
  } catch { return false }
  finally { await handle?.close().catch(() => undefined) }
}

async function verify(lockPath: string, handle: FileHandle, identity: BigIntStats, bytes: Buffer): Promise<void> {
  assertSame(identity, await lstat(lockPath, { bigint: true }))
  assertSame(identity, await handle.stat({ bigint: true }))
  if (!(await readBounded(handle, identity)).equals(bytes)) throw new CacheMutexError('CACHE_MUTEX_CHANGED')
  assertSame(identity, await lstat(lockPath, { bigint: true }))
}

async function readBounded(handle: FileHandle, identity: BigIntStats): Promise<Buffer> {
  assertRegular(identity)
  const buffer = Buffer.alloc(4_097)
  const result = await handle.read(buffer, 0, buffer.length, 0)
  if (result.bytesRead !== Number(identity.size)) throw new CacheMutexError('CACHE_MUTEX_CHANGED')
  return buffer.subarray(0, result.bytesRead)
}

function assertRegular(value: BigIntStats): void {
  if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1n || value.ino === 0n || value.size < 1n || value.size > 4_096n) {
    throw new CacheMutexError('CACHE_MUTEX_INVALID')
  }
}
function assertSame(before: BigIntStats, after: BigIntStats): void {
  assertRegular(after)
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new CacheMutexError('CACHE_MUTEX_CHANGED')
}
function hasCode(value: unknown, code: string): boolean { return value instanceof Error && 'code' in value && value.code === code }
function canonical(value: string): string { const full = path.resolve(value); return process.platform === 'win32' ? full.toLowerCase() : full }
function digest(value: Buffer): string { return createHash('sha256').update(value).digest('hex') }

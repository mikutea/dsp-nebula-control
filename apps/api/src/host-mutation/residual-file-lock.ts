import { createHash } from 'node:crypto'
import { lstat, open, realpath, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { BigIntStats } from 'node:fs'
import type { HostMutationOperationScope } from './operation-coordinator.js'

export class ResidualFileLockError extends Error {
  constructor(readonly code: 'RESIDUAL_LOCK_INVALID' | 'RESIDUAL_LOCK_CHANGED') {
    super(code)
    this.name = 'ResidualFileLockError'
  }
}

export interface ResidualFileLockEvidence {
  readonly bytes: Buffer
  readonly sha256: string
  readonly device: string
  readonly inode: string
}

/**
 * Call only while the domain's exclusive recovery authority is held. The domain
 * must validate its durable request/journal and original ownership in authorize;
 * a dead PID or an old timestamp alone is not authorization to remove a lock.
 * The file stays open until the final identity check and removal, matching the
 * existing managed-mod recovery boundary. Protected control-directory access
 * and the host recovery lease exclude other cooperating writers.
 */
export async function removeVerifiedResidualFileLock(options: {
  lockPath: string
  expectedSha256: string
  scope: Pick<HostMutationOperationScope, 'signal' | 'assertActive'>
  authorize: (evidence: ResidualFileLockEvidence) => Promise<void>
  /** Finish and persist domain recovery while the verified lock still exists.
   * Any failure retains the lock. The callback must assert the recovery scope
   * around each write and may not replace or edit the lock itself. */
  beforeRemove?: () => Promise<void>
}): Promise<void> {
  if (!path.isAbsolute(options.lockPath) || !/^[a-f0-9]{64}$/.test(options.expectedSha256)) {
    throw new ResidualFileLockError('RESIDUAL_LOCK_INVALID')
  }
  const scope = options.scope
  const assertActive = () => {
    scope.assertActive()
    if (scope.signal.aborted) throw new ResidualFileLockError('RESIDUAL_LOCK_CHANGED')
  }
  assertActive()
  const before = await lstat(options.lockPath, { bigint: true })
  assertRegular(before)
  if (canonical(await realpath(options.lockPath)) !== canonical(options.lockPath)) {
    throw new ResidualFileLockError('RESIDUAL_LOCK_INVALID')
  }
  const handle = await open(options.lockPath, 'r')
  try {
    const opened = await handle.stat({ bigint: true })
    assertRegular(opened)
    assertSame(before, opened)
    const buffer = Buffer.alloc(4_097)
    const read = await handle.read(buffer, 0, buffer.length, 0)
    if (read.bytesRead !== Number(opened.size)) throw new ResidualFileLockError('RESIDUAL_LOCK_CHANGED')
    const bytes = buffer.subarray(0, read.bytesRead)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== options.expectedSha256) throw new ResidualFileLockError('RESIDUAL_LOCK_CHANGED')
    assertActive()
    await options.authorize(Object.freeze({
      bytes: Buffer.from(bytes), sha256: digest, device: opened.dev.toString(), inode: opened.ino.toString()
    }))
    const verifyUnchanged = async () => {
      assertActive()
      const current = await lstat(options.lockPath, { bigint: true })
      assertRegular(current)
      assertSame(opened, current)
      const after = await handle.stat({ bigint: true })
      assertSame(opened, after)
      if (current.size !== opened.size || after.size !== opened.size ||
          current.mtimeNs !== opened.mtimeNs || current.ctimeNs !== opened.ctimeNs) {
        throw new ResidualFileLockError('RESIDUAL_LOCK_CHANGED')
      }
      const reread = await handle.read(buffer, 0, buffer.length, 0)
      if (reread.bytesRead !== bytes.length ||
          createHash('sha256').update(buffer.subarray(0, reread.bytesRead)).digest('hex') !== digest) {
        throw new ResidualFileLockError('RESIDUAL_LOCK_CHANGED')
      }
      assertSame(opened, await lstat(options.lockPath, { bigint: true }))
      assertActive()
    }
    await verifyUnchanged()
    if (options.beforeRemove) {
      await options.beforeRemove()
      await verifyUnchanged()
    }
    await unlink(options.lockPath)
  } finally {
    await handle.close()
  }
}

function assertRegular(value: BigIntStats): void {
  if (!value.isFile() || value.isSymbolicLink() || value.ino === 0n || value.nlink !== 1n ||
      value.size < 1n || value.size > 4_096n) {
    throw new ResidualFileLockError('RESIDUAL_LOCK_INVALID')
  }
}

function assertSame(left: BigIntStats, right: BigIntStats): void {
  if (!right.isFile() || right.isSymbolicLink() || right.nlink !== 1n ||
      left.dev !== right.dev || left.ino !== right.ino) {
    throw new ResidualFileLockError('RESIDUAL_LOCK_CHANGED')
  }
}

function canonical(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

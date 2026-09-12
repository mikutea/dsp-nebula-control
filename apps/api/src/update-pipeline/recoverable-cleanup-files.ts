import { lstat, mkdir, realpath, rename } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { HostMutationOperationScope } from '../host-mutation/operation-coordinator.js'
import type { CleanupCandidate, CleanupMovePorts } from './recoverable-cleanup-move.js'
import { inspectCleanupObject } from './recoverable-cleanup-inventory.js'
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
/** Roots must have the control plane's protected ACL. All writers must hold the
 * host lease and activation lock; privileged external changes are not supported. */
export class FileCleanupMovePorts implements CleanupMovePorts {
  private readonly root: string
  private readonly requestId: string
  constructor(controlRoot: string, requestId: string) {
    if (!path.isAbsolute(controlRoot) || path.resolve(controlRoot) === path.parse(controlRoot).root) throw new Error('UPDATE_CLEANUP_PATH_INVALID')
    this.root = path.resolve(controlRoot)
    this.requestId = z.string().uuid().parse(requestId).toLowerCase()
  }
  private parts(candidate: CleanupCandidate, side: 'source' | 'quarantine'): string[] {
    const id = candidate.kind === 'history' ? z.string().uuid().parse(candidate.opaqueId).toLowerCase()
      : z.string().regex(/^(?:nebula|bepinex|bridge|control)-[0-9a-f]{32}$/).parse(candidate.opaqueId)
    if (side === 'quarantine') return ['cleanup-quarantine', this.requestId, candidate.kind + '-' + id]
    return candidate.kind === 'history' ? ['history', id + '.json'] : ['releases', id.split('-')[0]!, id]
  }
  private async parent(parts: string[], create: boolean, scope?: HostMutationOperationScope): Promise<boolean> {
    let current = this.root
    for (let index = -1; index < parts.length - 1; index++) {
      if (index >= 0) current = path.join(current, parts[index]!)
      let info = await lstat(current).catch(error => { if (error?.code === 'ENOENT') return null; throw error })
      if (!info && create && index >= 0) {
        scope!.assertActive()
        await mkdir(current)
        scope!.assertActive()
        info = await lstat(current)
      }
      if (!info) return false
      if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(current), current)) throw new Error('UPDATE_CLEANUP_PATH_INVALID')
    }
    return true
  }
  async inspect(candidate: CleanupCandidate, side: 'source' | 'quarantine') {
    const parts = this.parts(candidate, side)
    if (!await this.parent(parts, false)) return null
    return await inspectCleanupObject(path.join(this.root, ...parts))
  }
  async move(candidate: CleanupCandidate, direction: 'quarantine' | 'restore', scope: HostMutationOperationScope) {
    scope.assertActive()
    const sourceSide = direction === 'quarantine' ? 'source' : 'quarantine'
    const targetSide = direction === 'quarantine' ? 'quarantine' : 'source'
    const from = this.parts(candidate, sourceSide), to = this.parts(candidate, targetSide)
    if (!await this.parent(from, false)) throw new Error('UPDATE_CLEANUP_SOURCE_CHANGED')
    if (!await this.parent(to, direction === 'quarantine', scope)) throw new Error('UPDATE_CLEANUP_PATH_INVALID')
    const evidence = await this.inspect(candidate, sourceSide)
    if (!evidence || evidence.sha256 !== candidate.sha256 || evidence.sizeBytes !== candidate.sizeBytes) throw new Error('UPDATE_CLEANUP_SOURCE_CHANGED')
    if (await this.inspect(candidate, targetSide)) throw new Error('UPDATE_CLEANUP_LOCATION_AMBIGUOUS')
    scope.assertActive()
    // No copy/delete fallback: cross-volume rename must fail without migration.
    await rename(path.join(this.root, ...from), path.join(this.root, ...to))
    scope.assertActive()
  }
}

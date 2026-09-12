import type { HostMutationOperationScope } from '../host-mutation/operation-coordinator.js'
import type { RecoverableCleanupPlan } from './recoverable-cleanup-plan.js'
export type CleanupCandidate = RecoverableCleanupPlan['candidates'][number]
export interface CleanupObjectEvidence { sha256: string; sizeBytes: number }
/** Implementations resolve only protected fixed roots and perform same-volume
 * atomic rename. They must reject links, foreign paths and destination races. */
export interface CleanupMovePorts {
  inspect(candidate: CleanupCandidate, side: 'source' | 'quarantine'): Promise<CleanupObjectEvidence | null>
  move(candidate: CleanupCandidate, direction: 'quarantine' | 'restore', scope: HostMutationOperationScope): Promise<void>
}
/** Caller holds the global lease plus activation lock and has durably published
 * the complete request-bound intent before invoking any object move. */
export async function moveCleanupObject(candidate: CleanupCandidate, direction: 'quarantine' | 'restore',
  ports: CleanupMovePorts, scope: HostMutationOperationScope): Promise<{ reused: boolean }> {
  const inspect = async () => {
    scope.assertActive()
    const source = await ports.inspect(candidate, 'source')
    scope.assertActive()
    const quarantine = await ports.inspect(candidate, 'quarantine')
    scope.assertActive()
    for (const evidence of [source, quarantine]) {
      if (evidence && (evidence.sha256 !== candidate.sha256 || evidence.sizeBytes !== candidate.sizeBytes)) {
        throw new Error('UPDATE_CLEANUP_SOURCE_CHANGED')
      }
    }
    if ((source === null) === (quarantine === null)) throw new Error('UPDATE_CLEANUP_LOCATION_AMBIGUOUS')
    return source === null ? 'quarantine' : 'source'
  }
  const destination = direction === 'quarantine' ? 'quarantine' : 'source'
  if (await inspect() === destination) return { reused: true }
  scope.assertActive()
  await ports.move(candidate, direction, scope)
  scope.assertActive()
  if (await inspect() !== destination) throw new Error('UPDATE_CLEANUP_MOVE_UNPROVEN')
  return { reused: false }
}

import type { HostMutationOperationScope } from '../host-mutation/operation-coordinator.js'
import { moveCleanupObject, type CleanupMovePorts } from './recoverable-cleanup-move.js'
import { parseCleanupJournal, type CleanupJournal } from './recoverable-cleanup-records.js'
export interface CleanupJournalStore {
  loadCleanupJournal(requestId: string): CleanupJournal | null | Promise<CleanupJournal | null>
  appendCleanupJournal(input: unknown): CleanupJournal | Promise<CleanupJournal>
}
/** Internal executor. Caller must hold global host ownership and the activation
 * lock, validate protected eligibility/revision, and supply server audit fields. */
export async function executeCleanupJournal(input: unknown, options: {
  store: CleanupJournalStore; files: CleanupMovePorts; scope: HostMutationOperationScope; now?: () => Date
}): Promise<CleanupJournal> {
  const supplied = parseCleanupJournal(input), { store, files, scope } = options
  scope.assertActive()
  const previous = await store.loadCleanupJournal(supplied.requestId)
  scope.assertActive()
  let journal = previous ? parseCleanupJournal(previous) : supplied
  if (previous && (journal.plan.planSha256 !== supplied.plan.planSha256 || journal.direction !== supplied.direction ||
    journal.actor !== supplied.actor || journal.startedAt !== supplied.startedAt)) throw new Error('UPDATE_CLEANUP_JOURNAL_CONFLICT')
  if (!previous) {
    if (journal.state !== 'running' || journal.completedCount !== 0) throw new Error('UPDATE_CLEANUP_JOURNAL_INVALID')
    journal = await store.appendCleanupJournal(journal)
    scope.assertActive()
  }
  if (journal.state === 'completed') return journal
  for (let index = journal.completedCount; index < journal.plan.candidates.length; index++) {
    await moveCleanupObject(journal.plan.candidates[index]!, journal.direction, files, scope)
    scope.assertActive()
    journal = await store.appendCleanupJournal({ ...journal, completedCount: index + 1 })
    scope.assertActive()
  }
  // A checkpoint does not substitute for current destination evidence.
  for (const candidate of journal.plan.candidates) {
    scope.assertActive()
    const source = await files.inspect(candidate, journal.direction === 'quarantine' ? 'source' : 'quarantine')
    const destination = await files.inspect(candidate, journal.direction === 'quarantine' ? 'quarantine' : 'source')
    scope.assertActive()
    if (source !== null || destination?.sha256 !== candidate.sha256 || destination.sizeBytes !== candidate.sizeBytes) {
      throw new Error('UPDATE_CLEANUP_MOVE_UNPROVEN')
    }
  }
  const finishedAt = (options.now ?? (() => new Date()))().toISOString()
  const terminal = parseCleanupJournal({ ...journal, state: 'completed', finishedAt })
  scope.assertActive()
  await store.appendCleanupJournal(terminal)
  scope.assertActive()
  const persisted = await store.loadCleanupJournal(journal.requestId)
  scope.assertActive()
  if (!persisted || JSON.stringify(parseCleanupJournal(persisted)) !== JSON.stringify(terminal)) throw new Error('UPDATE_CLEANUP_TERMINAL_UNPROVEN')
  return terminal
}

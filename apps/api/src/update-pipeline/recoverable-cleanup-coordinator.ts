import { HostMutationLeaseError } from '../host-mutation/lease.js'
import { hostMutationReturn, hostMutationThrow, type HostMutationOperationCoordinator,
  type HostMutationRecoveryOperationCoordinator, type HostMutationOperationScope } from '../host-mutation/operation-coordinator.js'
import { executeCleanupJournal, type CleanupJournalStore } from './recoverable-cleanup-execution.js'
import { parseCleanupJournal, type CleanupJournal } from './recoverable-cleanup-records.js'
import type { CleanupMovePorts } from './recoverable-cleanup-move.js'
export interface CleanupCoordinatorOptions {
  coordinator: HostMutationOperationCoordinator
  recovery: HostMutationRecoveryOperationCoordinator
  store: CleanupJournalStore
  files: CleanupMovePorts
  withActivationLock<T>(scope: HostMutationOperationScope, work: () => Promise<T>): Promise<T>
  /** Read-only current revision, pending transaction and eligibility checks. */
  validateEligibility(journal: CleanupJournal, scope: HostMutationOperationScope): Promise<void>
}
export class RecoverableCleanupCoordinator {
  constructor(private readonly options: CleanupCoordinatorOptions) {}
  execute(input: unknown) { return this.run(input, false) }
  recover(input: unknown) { return this.run(input, true) }
  private async run(input: unknown, recovery: boolean): Promise<CleanupJournal> {
    const journal = parseCleanupJournal(input)
    const operation = journal.direction === 'quarantine' ? 'component-update-cleanup' : 'component-update-cleanup-restore'
    const work = async (scope: HostMutationOperationScope) => {
      let intentMayExist = recovery
      try {
        return await this.options.withActivationLock(scope, async () => {
          scope.assertActive()
          intentMayExist = true
          const existing = await this.options.store.loadCleanupJournal(journal.requestId)
          scope.assertActive()
          intentMayExist = recovery || (existing !== null && existing.state !== 'completed')
          if (existing?.state !== 'completed') {
            await this.options.validateEligibility(existing ?? journal, scope)
            scope.assertActive()
          }
          intentMayExist = true
          const terminal = await executeCleanupJournal(journal, { store: this.options.store, files: this.options.files, scope })
          scope.assertActive()
          return hostMutationReturn(terminal, 'release')
        })
      } catch (error) {
        if (error instanceof HostMutationLeaseError) throw error
        return hostMutationThrow<CleanupJournal>(error, intentMayExist ? 'abandon' : 'release')
      }
    }
    return recovery ? await this.options.recovery.runRecoveryExclusive({ expectedOperation: operation, expectedRequestId: journal.requestId }, work)
      : await this.options.coordinator.runExclusive({ operation, requestId: journal.requestId }, work)
  }
}

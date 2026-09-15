import { readFile } from 'node:fs/promises'
import { ModDeploymentService } from './deployment.js'
import type { ModDeploymentFaultPhase, ModDeploymentRequest } from './deployment-types.js'
import type {
  HostMutationOperationCoordinator,
  HostMutationOperationOutcome,
  HostMutationOperationRequest,
  HostMutationOperationScope
} from '../host-mutation/operation-coordinator.js'

const [stagingRoot, pluginsRoot, requestPath, crashPhase] = process.argv.slice(2)
if (stagingRoot === undefined || pluginsRoot === undefined || requestPath === undefined ||
    crashPhase === undefined) {
  throw new Error('fixture arguments missing')
}

const request = JSON.parse(await readFile(requestPath, 'utf8')) as ModDeploymentRequest
const scope: HostMutationOperationScope = {
  signal: new AbortController().signal,
  assertActive: () => undefined,
  toPowerShellBorrowArguments: () => []
}
const coordinator: HostMutationOperationCoordinator = {
  async runExclusive<T>(
    _request: HostMutationOperationRequest,
    operation: (
      hostMutation: HostMutationOperationScope
    ) => Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>
  ): Promise<T> {
    const outcome = await operation(scope)
    if (outcome.kind === 'return') return outcome.value
    throw outcome.error
  }
}

const service = new ModDeploymentService({
  stagingRoot,
  pluginsRoot,
  hostMutationCoordinator: coordinator,
  verifyStoppedState: async () => ({ processStopped: true, portClosed: true }),
  faultInjector: async (phase: ModDeploymentFaultPhase) => {
    if ((crashPhase === 'after-rollback-failed-move' || crashPhase === 'after-rollback-restore' ||
         crashPhase === 'after-rollback-receipt-pending-synced') &&
        phase === 'after-publish') {
      throw new Error('fixture starts rollback')
    }
    if (crashPhase === 'after-rollback-receipt-pending-synced' &&
        phase === 'after-receipt-pending-synced') {
      process.exit(86)
    }
    if (phase === crashPhase) process.exit(86)
  }
})

await service.execute(request)
throw new Error('fixture did not hard-exit')

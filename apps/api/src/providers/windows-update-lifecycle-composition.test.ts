import { describe, expect, it } from 'vitest'
import type { HostMutationOperationScope } from '../host-mutation/operation-coordinator.js'
import { WindowsLifecycleAdapter } from './windows-lifecycle.js'
import type { WindowsLifecycleBrokerClient } from './windows-lifecycle-broker.js'
import { WindowsUpdateActivationAdapters } from './windows-update-activation.js'

const requestId = '11111111-1111-4111-8111-111111111111'
const unused = async (): Promise<never> => { throw new Error('unexpected boundary call') }

function fixture(lifecyclePhaseTimeoutMs?: number) {
  const controller = new AbortController()
  const scope: HostMutationOperationScope = {
    signal: controller.signal,
    assertActive: () => controller.signal.throwIfAborted(),
    toPowerShellBorrowArguments: () => ['-FixtureBorrowedLease', 'verified']
  }
  const observations: string[] = []
  const dispatchScopes: unknown[] = []
  const dispatchIds: string[] = []
  const scriptArguments: string[][] = []
  const scriptSignals: AbortSignal[] = []
  const broker: WindowsLifecycleBrokerClient = {
    preflight: unused,
    status: unused,
    dispatch: async input => {
      dispatchScopes.push(input.hostMutation)
      dispatchIds.push(input.outerRequestId)
      return { operation: input.operation, dispatched: true, blockers: [],
        taskName: input.operation === 'graceful-stop' ? 'Dyson-Nebula-Stop' : 'Dyson-Nebula-Server',
        taskPath: '\\', readyVerified: true }
    },
    verify: async input => {
      observations.push(input.outerRequestId)
      const running = input.expected === 'running'
      return { expected: input.expected, matched: true, blockers: [], runtime: {
        lifecycleState: running ? 'running_verified' : 'stopped_verified',
        session: { status: 'verified', id: 3, count: 1 },
        steam: { status: 'verified', pid: 300, sessionId: 3 },
        process: running ? { status: 'verified', pid: 4242, owner: 'FICTIONAL\\Game', sessionId: 3 }
          : { status: 'absent', pid: null, owner: null, sessionId: null },
        port: { port: 8469, listenerCount: running ? 1 : 0 },
        pidFile: { present: running, valid: running }
      } }
    }
  }
  const statusProvider = { name: 'windows' as const, collectStatus: unused, previewLifecycle: unused }
  const lifecycle = new WindowsLifecycleAdapter({
    projectRoot: 'C:\\Fixture\\Project', runtimeBootstrapRoot: 'C:\\Fixture\\Bootstrap',
    statusProvider, brokerClient: broker,
    bridgeClient: { probe: unused, requestSave: unused },
    scriptRunner: { run: async (name, args, signal) => {
      expect(name).toBe('New-DysonSaveProtectionPoint.ps1')
      scriptArguments.push(args)
      scriptSignals.push(signal)
      const id = args[args.indexOf('-RequestId') + 1]
      return JSON.stringify({ protocol: 'DYSON_CONTROL_PROTECTION_V1', schemaVersion: 1,
        requestId: id, state: 'succeeded', dryRun: false, mutationPerformed: true,
        protectionPointId: `save:${id}`, sourcePairVerified: true,
        dsvBytes: 1024, serverBytes: 256, manifestVerified: true, reused: false })
    } }
  })
  const update = new WindowsUpdateActivationAdapters({
    lifecyclePhaseTimeoutMs,
    lifecycleAdapter: lifecycle, statusProvider, componentVersionProbe: unused,
    transactionProvider: {
      captureRollbackBaseline: unused,
      inspectProtectionPoint: async () => ({ manifestSha256: 'a'.repeat(64), saveIdentity: 'b'.repeat(64) }),
      restoreConfiguration: unused, restoreServerModLock: unused, restorePairedSave: unused,
      inspectRollbackReadback: unused, probeRuntimeLoadEvidence: unused
    }
  })
  return { update, lifecycle, scope, controller, broker, observations, dispatchScopes, dispatchIds, scriptArguments, scriptSignals }
}

describe('real Windows lifecycle and update adapter composition', () => {
  it('refreshes successful observations without changing mutation replay identity', async () => {
    const f = fixture()
    const context = { requestId, jobId: 'fixture-update', action: 'restart' as const,
      protectionPointId: null, hostMutation: f.scope, signal: f.scope.signal }
    await f.lifecycle.requestGracefulStop(context)
    await f.lifecycle.requestGracefulStop(context)
    expect(f.dispatchIds).toEqual([requestId, requestId])
    await f.lifecycle.verifyStopped(context)
    await f.lifecycle.verifyStopped(context)
    expect(f.observations).toHaveLength(2)
    expect(new Set(f.observations).size).toBe(2)
  })

  it('accepts actual stopped evidence and obtains a fresh observation at every publication barrier', async () => {
    const f = fixture()
    for (const phase of ['before-protection', 'before-publish'] as const) {
      await expect(f.update.verifyStoppedState({ requestId, component: 'bepinex', phase }, f.scope))
        .resolves.toEqual({ processStopped: true, portClosed: true })
    }
    expect(f.observations).toHaveLength(2)
    expect(new Set(f.observations).size).toBe(2)
  })

  it('passes cancellation through real protection scripts and validates their actual result', async () => {
    const f = fixture()
    await expect(f.update.createSaveProtectionPoint({ requestId, component: 'bepinex',
      purpose: 'component-update', targetVersion: '5.4.23.5', expectedRevision: 'c'.repeat(64) }, f.scope))
      .resolves.toMatchObject({ pairProtected: true, durable: true })
    expect(f.scriptSignals).toHaveLength(1)
    expect(f.scriptSignals[0]!.aborted).toBe(false)
    f.controller.abort()
    expect(f.scriptSignals[0]!.aborted).toBe(true)
  })

  it('borrows the original lease for real stop dispatch and accepts dispatch evidence', async () => {
    const f = fixture()
    await expect(f.update.requestGracefulStop({ requestId }, f.scope)).resolves.toEqual({ dispatched: true })
    expect(f.dispatchScopes).toEqual([f.scope])
  })

  it('bounds an observation and keeps a fresh cleanup phase available under the same active lease', async () => {
    const f = fixture(30)
    let observationSignal: AbortSignal | undefined
    f.broker.verify = async input => {
      observationSignal = input.signal
      await new Promise((_, reject) => input.signal.addEventListener('abort',
        () => reject(input.signal.reason), { once: true }))
      throw new Error('unreachable')
    }
    await expect(f.update.verifyStoppedState({ requestId, component: 'bepinex', phase: 'before-protection' }, f.scope))
      .rejects.toMatchObject({ code: 'WINDOWS_UPDATE_STOP_PROOF_FAILED' })
    expect(observationSignal!.aborted).toBe(true)
    expect(f.scope.signal.aborted).toBe(false)
    await expect(f.update.requestGracefulStop({ requestId }, f.scope)).resolves.toEqual({ dispatched: true })
    expect(f.dispatchScopes).toEqual([f.scope])
    f.controller.abort()
    await expect(f.update.requestGracefulStop({ requestId }, f.scope)).rejects.toBeDefined()
    expect(f.dispatchScopes).toHaveLength(1)
  })
})

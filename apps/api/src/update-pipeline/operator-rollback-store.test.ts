import { existsSync, readdirSync, statSync } from 'node:fs'
import { mkdtemp, mkdir, realpath, rm, readFile, writeFile, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileOperatorRollbackStore } from './operator-rollback-store.js'
import { operatorRollbackDigest } from './operator-rollback-records.js'
import { OperatorRollbackCoordinator, operatorRollbackPhases, type OperatorRollbackJournal, type OperatorRollbackReceipt,
  type OperatorRollbackPhase, type OperatorRollbackPorts } from './operator-rollback.js'
import type { HostMutationOperationScope, HostMutationOperationOutcome } from '../host-mutation/operation-coordinator.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const scope: HostMutationOperationScope = { signal: new AbortController().signal, assertActive() {}, toPowerShellBorrowArguments: () => [] }
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'dyson-operator-store-')))
  roots.push(root)
  const storeRoot = path.join(root, 'store')
  const requestId = '11111111-1111-4111-8111-111111111111', sourceRequestId = '22222222-2222-4222-8222-222222222222'
  const hash = 'a'.repeat(64)
  const planCore = { format: 'dyson-control-component-rollback-plan' as const, schemaVersion: 1 as const, dryRun: true as const,
    requestId, sourceRequestId, expectedRevision: hash, component: 'bepinex' as const, targetVersion: '5.4.17.0',
    materialSha256: hash, rollbackBindingSha256: hash, sourceProtectionBackupId: 'source-backup',
    restoreFileCount: 1, removeFileCount: 0, currentConfigurationRevision: hash }
  const plan = { ...planCore, planSha256: operatorRollbackDigest(planCore) }
  const protectionCore = { configurationSnapshotId: requestId, configurationRevision: hash, serverModLockSha256: hash,
    serverModLockRevision: hash, previousLoadedSaveIdentity: hash, protectionBackupId: 'forward-backup', protectionManifestSha256: hash }
  const protection = { ...protectionCore, bindingSha256: operatorRollbackDigest(protectionCore) }
  const journal: OperatorRollbackJournal = { request: { requestId, sourceRequestId, expectedRevision: hash,
    expectedPlanSha256: plan.planSha256 }, plan, phase: 'prepared', protection: null, resultingRevision: null }
  return { root, storeRoot, journal, protection, store: new FileOperatorRollbackStore(storeRoot) }
}
describe('append-only operator rollback store', () => {
  it('resumes the coordinator from a durable file checkpoint without repeating completed actions', async () => {
    const f = await fixture()
    const live = path.join(f.root, 'live-component')
    await writeFile(live, 'candidate')
    let protects = 0, restores = 0
    const dispositions: string[] = []
    const invoke = async <T>(work: (s: HostMutationOperationScope) => Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>) => {
      const result = await work(scope)
      dispositions.push(result.disposition)
      if (result.kind === 'throw') throw result.error
      return result.value
    }
    const ports: OperatorRollbackPorts = {
      preview: async () => f.journal.plan,
      validateResume: async () => {},
      protectCurrent: async () => { protects++; return f.protection },
      restoreFiles: async () => { restores++; await writeFile(live, 'original') },
      restoreEnvironment: async () => {},
      verify: async () => { expect(await readFile(live, 'utf8')).toBe('original') },
      commitState: async () => 'b'.repeat(64)
    }
    class InterruptedStore extends FileOperatorRollbackStore {
      override async checkpoint(previous: OperatorRollbackPhase, journal: OperatorRollbackJournal, s: HostMutationOperationScope) {
        await super.checkpoint(previous, journal, s)
        if (journal.phase === 'files-restored') throw new Error('SIMULATED_PROCESS_INTERRUPTION')
      }
    }
    const options = { ports, coordinator: { runExclusive: async <T>(_request: unknown, work: (s: HostMutationOperationScope) => Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>) => invoke(work) },
      recovery: { runRecoveryExclusive: async <T>(_request: unknown, work: (s: HostMutationOperationScope) => Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>) => invoke(work) } }
    await expect(new OperatorRollbackCoordinator({ ...options, store: new InterruptedStore(f.storeRoot) }).execute(f.journal.request))
      .rejects.toThrow('SIMULATED_PROCESS_INTERRUPTION')
    await expect(new OperatorRollbackCoordinator({ ...options, store: new FileOperatorRollbackStore(f.storeRoot) }).recover(f.journal.request))
      .resolves.toMatchObject({ status: 'succeeded' })
    expect({ protects, restores }).toEqual({ protects: 1, restores: 1 })
    expect(dispositions).toEqual(['abandon', 'release'])
  })

  it.each(['absent', 'empty', 'partial'])('rebuilds an interrupted %s initial intent from an exact fresh preview', async (kind) => {
    const f = await fixture()
    const live = path.join(f.root, 'live-component')
    await writeFile(live, 'candidate')
    let protects = 0, restores = 0
    const dispositions: string[] = []
    const invoke = async <T>(work: (s: HostMutationOperationScope) => Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>) => {
      const result = await work(scope)
      dispositions.push(result.disposition)
      if (result.kind === 'throw') throw result.error
      return result.value
    }
    const ports: OperatorRollbackPorts = {
      preview: async () => f.journal.plan,
      validateResume: async () => {},
      protectCurrent: async () => { protects++; return f.protection },
      restoreFiles: async () => { restores++; await writeFile(live, 'original') },
      restoreEnvironment: async () => {},
      verify: async () => { expect(await readFile(live, 'utf8')).toBe('original') },
      commitState: async () => 'b'.repeat(64)
    }
    class InterruptedStore extends FileOperatorRollbackStore {
      override async begin(journal: OperatorRollbackJournal, _s: HostMutationOperationScope) {
        const directory = path.join(f.storeRoot, journal.request.requestId)
        if (kind !== 'absent') await mkdir(directory, { recursive: true })
        if (kind === 'partial') await writeFile(path.join(directory, '.pending-33333333-3333-4333-8333-333333333333'), '{')
        throw new Error('SIMULATED_PROCESS_INTERRUPTION')
      }
    }
    const options = { ports, coordinator: { runExclusive: async <T>(_request: unknown, work: (s: HostMutationOperationScope) => Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>) => invoke(work) },
      recovery: { runRecoveryExclusive: async <T>(_request: unknown, work: (s: HostMutationOperationScope) => Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>) => invoke(work) } }
    await expect(new OperatorRollbackCoordinator({ ...options, store: new InterruptedStore(f.storeRoot) }).execute(f.journal.request))
      .rejects.toThrow('SIMULATED_PROCESS_INTERRUPTION')
    await expect(new OperatorRollbackCoordinator({ ...options,
      ports: { ...ports, preview: async () => ({ ...f.journal.plan, planSha256: 'f'.repeat(64) }) },
      store: new FileOperatorRollbackStore(f.storeRoot) }).recover(f.journal.request))
      .rejects.toThrow('UPDATE_ROLLBACK_PLAN_CHANGED')
    expect({ protects, restores }).toEqual({ protects: 0, restores: 0 })
    expect(existsSync(path.join(f.storeRoot, f.journal.request.requestId))).toBe(kind !== 'absent')
    await expect(new OperatorRollbackCoordinator({ ...options, store: new FileOperatorRollbackStore(f.storeRoot) }).recover(f.journal.request))
      .resolves.toMatchObject({ status: 'succeeded' })
    expect({ protects, restores }).toEqual({ protects: 1, restores: 1 })
    expect(dispositions).toEqual(['abandon', 'abandon', 'release'])
  })

  it('recovers a fully written intent interrupted before its first publication', async () => {
    const f = await fixture()
    const directory = path.join(f.storeRoot, f.journal.request.requestId)
    const lost = new Error('interrupted before publication')
    await expect(f.store.begin(f.journal, { ...scope, assertActive() {
      if (existsSync(directory) && readdirSync(directory).some(name => name.startsWith('.pending-') &&
        statSync(path.join(directory, name)).size > 0)) throw lost
    } })).rejects.toBe(lost)
    expect(await f.store.load(f.journal.request.requestId)).toBeNull()
    const invoke = async <T>(work: (s: HostMutationOperationScope) => Promise<HostMutationOperationOutcome<T>> | HostMutationOperationOutcome<T>) => {
      const result = await work(scope)
      if (result.kind === 'throw') { expect(result.disposition).toBe('abandon'); throw result.error }
      return result.value
    }
    const unexpected = async (): Promise<never> => { throw new Error('UNEXPECTED_GAME_OR_PREVIEW_ACTION') }
    const recovery = new OperatorRollbackCoordinator({ store: new FileOperatorRollbackStore(f.storeRoot),
      coordinator: { runExclusive: async (_input, work) => invoke(work) },
      recovery: { runRecoveryExclusive: async (_input, work) => invoke(work) },
      ports: { preview: unexpected, validateResume: unexpected, protectCurrent: unexpected,
        restoreFiles: unexpected, restoreEnvironment: unexpected, verify: unexpected, commitState: unexpected } })
    await expect(recovery.recover({ ...f.journal.request, expectedPlanSha256: 'f'.repeat(64) }))
      .rejects.toThrow('UPDATE_ROLLBACK_REQUEST_CONFLICT')
    const restarted = new FileOperatorRollbackStore(f.storeRoot)
    await expect(restarted.recoverIncompleteIntent(f.journal.request.requestId, scope)).resolves.toBe(false)
    expect((await restarted.load(f.journal.request.requestId))?.journal).toEqual(f.journal)
    await expect(restarted.recoverIncompleteIntent(f.journal.request.requestId, scope)).resolves.toBe(false)
  })

  it('refuses foreign entries and hardlinks when rebuilding an initial intent', async () => {
    const f = await fixture()
    const directory = path.join(f.storeRoot, f.journal.request.requestId)
    await mkdir(directory, { recursive: true })
    const foreign = path.join(directory, 'user-file.txt')
    await writeFile(foreign, 'preserve')
    await expect(f.store.rebuildIncompleteIntent(f.journal, scope)).rejects.toBeDefined()
    expect(await readFile(foreign, 'utf8')).toBe('preserve')
    await rm(foreign)
    const external = path.join(f.root, 'original')
    await writeFile(external, 'preserve')
    await link(external, path.join(directory, '.pending-33333333-3333-4333-8333-333333333333'))
    await expect(f.store.rebuildIncompleteIntent(f.journal, scope)).rejects.toBeDefined()
    expect(await readFile(external, 'utf8')).toBe('preserve')
  })

  it('roundtrips every checkpoint and terminal receipt across fresh instances', async () => {
    const f = await fixture()
    await f.store.begin(f.journal, scope)
    expect(await new FileOperatorRollbackStore(f.storeRoot).pending()).toEqual([{
      requestId: f.journal.request.requestId, sourceRequestId: f.journal.request.sourceRequestId, phase: 'prepared'
    }])
    let current = f.journal
    for (const phase of operatorRollbackPhases.slice(1)) {
      const next = { ...current, phase, protection: f.protection,
        resultingRevision: phase === 'state-committed' ? 'b'.repeat(64) : null }
      await new FileOperatorRollbackStore(f.storeRoot).checkpoint(current.phase, next, scope)
      current = next
    }
    const receipt: OperatorRollbackReceipt = { format: 'dyson-control-operator-rollback-receipt', schemaVersion: 1,
      requestId: current.request.requestId, sourceRequestId: current.request.sourceRequestId,
      planSha256: current.plan.planSha256, resultingRevision: current.resultingRevision!,
      protectionBackupId: f.protection.protectionBackupId, status: 'succeeded', recoveryRequired: false }
    await f.store.complete(receipt, scope)
    expect(await new FileOperatorRollbackStore(f.storeRoot).pending()).toEqual([])
    expect(await new FileOperatorRollbackStore(f.storeRoot).load(receipt.requestId)).toEqual({ journal: current, receipt })
    await expect(f.store.complete({ ...receipt, resultingRevision: 'c'.repeat(64) }, scope)).rejects.toBeDefined()
  })
  it('recovers readable publication after lease loss before temporary-link cleanup', async () => {
    const f = await fixture()
    const file = path.join(f.storeRoot, f.journal.request.requestId, '0-prepared.json')
    const lost = new Error('lease lost')
    await expect(f.store.begin(f.journal, { ...scope, assertActive() { if (existsSync(file)) throw lost } })).rejects.toBe(lost)
    expect((await new FileOperatorRollbackStore(f.storeRoot).load(f.journal.request.requestId))?.journal).toEqual(f.journal)
  })
  it('rejects checkpoint skips, foreign hardlinks and changed stored plans', async () => {
    const f = await fixture()
    await f.store.begin(f.journal, scope)
    await expect(f.store.checkpoint('prepared', { ...f.journal, phase: 'verified', protection: f.protection }, scope)).rejects.toBeDefined()
    const file = path.join(f.storeRoot, f.journal.request.requestId, '0-prepared.json')
    const foreign = path.join(f.root, 'foreign-link')
    await link(file, foreign)
    await expect(f.store.load(f.journal.request.requestId)).rejects.toBeDefined()
    await rm(foreign)
    const original = await readFile(file, 'utf8')
    await writeFile(file, original.replace('5.4.17.0', '5.4.99.0'))
    await expect(f.store.load(f.journal.request.requestId)).rejects.toBeDefined()
  })
})

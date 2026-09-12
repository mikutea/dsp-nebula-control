import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ControlDatabase } from '../storage/database.js'
import {
  ProductionBackupRetentionProtectionError,
  ProductionBackupRetentionProtectionSource,
  protectionReferenceToBackupId,
  type BackupRetentionWorkflowProtectionStore,
  type LifecycleBackupProtectionRecord,
  type SaveRestoreBackupProtectionRecord
} from './retention-protection-source.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

describe('production backup retention protection source', () => {
  it('maps logical save references to physical tx IDs and combines lifecycle, restore, and update workflows', async () => {
    const projectRoot = await fixtureProjectRoot()
    const lifecycleId = randomUUID()
    const lifecycleRecoveryId = randomUUID()
    const restoreId = randomUUID()
    const safeRestoreId = randomUUID()
    const updateId = randomUUID()
    await writePendingUpdateJournal(projectRoot, updateId, `save:${updateId}`)
    const store = new FakeWorkflowStore()
    store.lifecycle = [
      lifecycleRecord(lifecycleId, 'running', `save:${lifecycleId}`, false, false),
      lifecycleRecord(lifecycleRecoveryId, 'failed', `tx-${lifecycleRecoveryId}`, true, false),
      (() => {
        const requestId = randomUUID()
        return lifecycleRecord(requestId, 'succeeded', `save:${requestId}`, false, true)
      })()
    ]
    store.saveRestores = [
      saveRestoreRecord('queued', restoreId, null, false, false),
      saveRestoreRecord('succeeded', safeRestoreId, `tx-${safeRestoreId}`, false, true)
    ]

    const protectedIds = await new ProductionBackupRetentionProtectionSource({
      projectRoot,
      workflowStore: store
    }).listProtectedBackupIds()

    expect([...protectedIds].sort()).toEqual([
      `tx-${lifecycleId}`,
      `tx-${lifecycleRecoveryId}`,
      `tx-${restoreId}`,
      `tx-${updateId}`
    ].sort())
    expect([...protectedIds].some((value) => value.startsWith('save:'))).toBe(false)
  })

  it('uses the production database queries without exposing a logical save ID as a directory name', async () => {
    const projectRoot = await fixtureProjectRoot()
    const database = new ControlDatabase('unused', true)
    const lifecycle = database.createLifecycleJob('restart', 'fixture-lifecycle-protection', 'fixture', 'queued')
    database.setLifecycleProtectionPoint(lifecycle.job.id, `save:${lifecycle.run.requestId}`)
    const protectionRequestId = randomUUID()
    database.createSaveJob({
      operation: 'restore',
      idempotencyKey: randomUUID(),
      saveName: null,
      backupId: `tx-${randomUUID()}`,
      expectedRevision: 'a'.repeat(64),
      protectionRequestId
    }, 'fixture', 'queued')

    try {
      const protectedIds = await new ProductionBackupRetentionProtectionSource({
        projectRoot,
        workflowStore: database
      }).listProtectedBackupIds()
      expect(protectedIds).toEqual(new Set([
        `tx-${lifecycle.run.requestId}`,
        `tx-${protectionRequestId}`
      ]))
    } finally {
      database.close()
    }
  })

  it('retains orphaned lifecycle and restore runs when their job projection is missing', async () => {
    const projectRoot = await fixtureProjectRoot()
    const database = new ControlDatabase(projectRoot)
    const lifecycle = database.createLifecycleJob(
      'save', randomUUID(), 'fixture', 'fixture orphan lifecycle'
    )
    database.setLifecycleProtectionPoint(lifecycle.job.id, `save:${lifecycle.run.requestId}`)
    const restoreProtectionRequestId = randomUUID()
    const restore = database.createSaveJob({
      operation: 'restore',
      idempotencyKey: randomUUID(),
      saveName: null,
      backupId: `tx-${randomUUID()}`,
      expectedRevision: 'a'.repeat(64),
      protectionRequestId: restoreProtectionRequestId
    }, 'fixture', 'fixture orphan restore')
    const raw = new DatabaseSync(path.join(projectRoot, 'control.db'))
    try {
      raw.exec('PRAGMA foreign_keys = OFF')
      raw.prepare('DELETE FROM jobs WHERE id IN (?, ?)').run(lifecycle.job.id, restore.job.id)
    } finally {
      raw.close()
    }

    try {
      expect(database.listLifecycleBackupProtectionRecords()).toEqual([
        expect.objectContaining({
          requestId: lifecycle.run.requestId,
          terminalReceiptComplete: false
        })
      ])
      expect(database.listSaveRestoreBackupProtectionRecords()).toEqual([
        expect.objectContaining({
          protectionRequestId: restoreProtectionRequestId,
          terminalReceiptComplete: false
        })
      ])
      await expect(new ProductionBackupRetentionProtectionSource({
        projectRoot,
        workflowStore: database
      }).listProtectedBackupIds()).resolves.toEqual(new Set([
        `tx-${lifecycle.run.requestId}`,
        `tx-${restoreProtectionRequestId}`
      ]))
    } finally {
      database.close()
    }
  })

  it('retains deterministic protection identities when database terminal projections are incomplete or contradictory', async () => {
    const projectRoot = await fixtureProjectRoot()
    const database = new ControlDatabase('unused', true)
    const lifecycle = database.createLifecycleJob('restart', 'fixture-null-protection', 'fixture', 'queued')
    database.completeLifecycleRun(lifecycle.job.id, 'succeeded', 'tampered terminal', null, false)

    const protectionRequestId = randomUUID()
    const requestedBackupId = `tx-${randomUUID()}`
    const restore = database.createSaveJob({
      operation: 'restore', idempotencyKey: randomUUID(), saveName: null,
      backupId: requestedBackupId, expectedRevision: 'a'.repeat(64), protectionRequestId
    }, 'fixture', 'queued')
    database.completeSaveRun(restore.job.id, 'succeeded', 'contradictory terminal', null, false, {
      status: 'succeeded',
      backupId: `tx-${randomUUID()}`,
      protectionBackupId: `tx-${protectionRequestId}`,
      pairBytes: 1,
      rollback: 'not-required',
      reused: false,
      auditStored: true,
      cleanupPending: false,
      maintenanceRequired: false
    })

    try {
      const protectedIds = await new ProductionBackupRetentionProtectionSource({
        projectRoot, workflowStore: database
      }).listProtectedBackupIds()
      expect(protectedIds).toEqual(new Set([
        `tx-${lifecycle.run.requestId}`,
        `tx-${protectionRequestId}`
      ]))
    } finally {
      database.close()
    }
  })

  it('retains lifecycle protections for contradictory receipts and mismatched terminal jobs', async () => {
    const projectRoot = await fixtureProjectRoot()
    const database = new ControlDatabase(projectRoot)
    const completeSaveLifecycle = (succeededErrorCode: string | null) => {
      const created = database.createLifecycleJob(
        'save', randomUUID(), 'fixture', 'fixture lifecycle protection'
      )
      database.markLifecycleRunRunning(created.job.id, 'fixture running')
      for (const phase of ['lock', 'preflight', 'protection-point', 'save'] as const) {
        const receipt = database.startLifecyclePhase(created.job.id, phase, `fixture ${phase}`)
        if (phase === 'protection-point') {
          database.setLifecycleProtectionPoint(created.job.id, `save:${created.run.requestId}`)
        }
        database.finishLifecyclePhase(
          receipt.id,
          'succeeded',
          `fixture ${phase} succeeded`,
          phase === 'protection-point' ? succeededErrorCode : null,
          {}
        )
      }
      database.completeLifecycleRun(created.job.id, 'succeeded', 'fixture complete', null, false)
      return created
    }
    const contradictoryReceipt = completeSaveLifecycle('LIFECYCLE_CONTRADICTORY_SUCCESS')
    const missingStartedAt = completeSaveLifecycle(null)
    const mismatchedKind = completeSaveLifecycle(null)
    const raw = new DatabaseSync(path.join(projectRoot, 'control.db'))
    try {
      raw.prepare('UPDATE jobs SET started_at = NULL WHERE id = ?').run(missingStartedAt.job.id)
      raw.prepare("UPDATE jobs SET kind = 'game.start' WHERE id = ?").run(mismatchedKind.job.id)
    } finally {
      raw.close()
    }

    try {
      const records = database.listLifecycleBackupProtectionRecords()
      expect(records.filter((record) => [
        contradictoryReceipt.run.requestId,
        missingStartedAt.run.requestId,
        mismatchedKind.run.requestId
      ].includes(record.requestId))).toEqual(expect.arrayContaining([
        expect.objectContaining({ requestId: contradictoryReceipt.run.requestId, terminalReceiptComplete: false }),
        expect.objectContaining({ requestId: missingStartedAt.run.requestId, terminalReceiptComplete: false }),
        expect.objectContaining({ requestId: mismatchedKind.run.requestId, terminalReceiptComplete: false })
      ]))
      const protectedIds = await new ProductionBackupRetentionProtectionSource({
        projectRoot, workflowStore: database
      }).listProtectedBackupIds()
      expect(protectedIds).toEqual(new Set([
        `tx-${contradictoryReceipt.run.requestId}`,
        `tx-${missingStartedAt.run.requestId}`,
        `tx-${mismatchedKind.run.requestId}`
      ]))
    } finally {
      database.close()
    }
  })

  it('rejects malformed and mismatched protection references instead of treating them as paths', async () => {
    const projectRoot = await fixtureProjectRoot()
    expect(() => protectionReferenceToBackupId('save:C:\\fictional\\not-a-uuid')).toThrow(
      ProductionBackupRetentionProtectionError
    )
    expect(() => protectionReferenceToBackupId(`save:${randomUUID()}/child`)).toThrow(
      ProductionBackupRetentionProtectionError
    )
    const protectionRequestId = randomUUID()
    const store = new FakeWorkflowStore()
    store.saveRestores = [saveRestoreRecord(
      'interrupted', protectionRequestId, `tx-${randomUUID()}`, true, false
    )]

    await expect(new ProductionBackupRetentionProtectionSource({
      projectRoot,
      workflowStore: store
    }).listProtectedBackupIds()).rejects.toMatchObject({
      code: 'SAVE_RETENTION_PROTECTION_SOURCE_INVALID'
    })
  })

  it('fails closed when a workflow query fails', async () => {
    const projectRoot = await fixtureProjectRoot()
    const store = new FakeWorkflowStore()
    store.lifecycleError = new Error('fictional database unavailable')

    await expect(new ProductionBackupRetentionProtectionSource({
      projectRoot,
      workflowStore: store
    }).listProtectedBackupIds()).rejects.toMatchObject({
      code: 'SAVE_RETENTION_PROTECTION_SOURCE_UNAVAILABLE'
    })
  })

  it('fails closed when a workflow exceeds the bounded protection-record budget', async () => {
    const projectRoot = await fixtureProjectRoot()
    const store = new FakeWorkflowStore()
    store.lifecycle = Array.from({ length: 20_001 }, () => {
      const requestId = randomUUID()
      return lifecycleRecord(requestId, 'running', `save:${requestId}`, false, false)
    })

    await expect(new ProductionBackupRetentionProtectionSource({
      projectRoot,
      workflowStore: store
    }).listProtectedBackupIds()).rejects.toMatchObject({
      code: 'SAVE_RETENTION_PROTECTION_SOURCE_INVALID'
    })
  })

  it('releases a component-update protection only after a strict safe terminal receipt', async () => {
    const projectRoot = await fixtureProjectRoot()
    const requestId = randomUUID()
    const transaction = await writePendingUpdateJournal(projectRoot, requestId, `save:${requestId}`)
    const active = await writeCanonicalActiveState(projectRoot, [transaction])
    await writeUpdateReceipt(projectRoot, transaction, {
      status: 'succeeded',
      recoveryRequired: false,
      rollbackVerified: false,
      failureCode: null,
      resultingRevision: active.revision
    })

    const protectedIds = await new ProductionBackupRetentionProtectionSource({
      projectRoot,
      workflowStore: new FakeWorkflowStore()
    }).listProtectedBackupIds()
    expect(protectedIds).toEqual(new Set())
  })

  it('uses a strictly bound terminal recovery receipt to release a recovered update protection', async () => {
    const projectRoot = await fixtureProjectRoot()
    const requestId = randomUUID()
    const transaction = await writePendingUpdateJournal(projectRoot, requestId, `save:${requestId}`)
    await writeUpdateReceipt(projectRoot, transaction, {
      status: 'rollback-failed', recoveryRequired: true, rollbackVerified: false,
      failureCode: 'UPDATE_ROLLBACK_FAILED'
    })
    await writeUpdateReceipt(projectRoot, transaction, {
      status: 'rolled-back', recoveryRequired: false, rollbackVerified: true,
      failureCode: 'UPDATE_ROLLBACK_FAILED', resultingRevision: transaction.previousRevision
    }, {}, 'recovery-receipts')
    await writeCanonicalActiveState(projectRoot, [])

    const protectedIds = await new ProductionBackupRetentionProtectionSource({
      projectRoot,
      workflowStore: new FakeWorkflowStore()
    }).listProtectedBackupIds()
    expect(protectedIds).toEqual(new Set())
  })

  it('releases an orphan terminal rolled-back recovery receipt only with its journal and initial active state', async () => {
    const projectRoot = await fixtureProjectRoot()
    const requestId = randomUUID()
    const transaction = await writePendingUpdateJournal(projectRoot, requestId, `save:${requestId}`)
    await writeUpdateReceipt(projectRoot, transaction, {
      status: 'rolled-back', recoveryRequired: false, rollbackVerified: true,
      failureCode: 'UPDATE_INTERRUPTED', resultingRevision: transaction.previousRevision
    }, {}, 'recovery-receipts')
    await writeCanonicalActiveState(projectRoot, [])

    await expect(new ProductionBackupRetentionProtectionSource({
      projectRoot,
      workflowStore: new FakeWorkflowStore()
    }).listProtectedBackupIds()).resolves.toEqual(new Set())
  })

  it('releases an orphan terminal succeeded recovery receipt only with its journal and canonical active state', async () => {
    const projectRoot = await fixtureProjectRoot()
    const requestId = randomUUID()
    const transaction = await writePendingUpdateJournal(projectRoot, requestId, `save:${requestId}`)
    const active = await writeCanonicalActiveState(projectRoot, [transaction])
    await writeUpdateReceipt(projectRoot, transaction, {
      status: 'succeeded', recoveryRequired: false, rollbackVerified: false,
      failureCode: null, resultingRevision: active.revision
    }, {}, 'recovery-receipts')

    await expect(new ProductionBackupRetentionProtectionSource({
      projectRoot,
      workflowStore: new FakeWorkflowStore()
    }).listProtectedBackupIds()).resolves.toEqual(new Set())
  })

  it('retains a terminal update protection when active state is missing', async () => {
    const projectRoot = await fixtureProjectRoot()
    const requestId = randomUUID()
    const transaction = await writePendingUpdateJournal(projectRoot, requestId, `save:${requestId}`)
    await writeUpdateReceipt(projectRoot, transaction, {
      status: 'succeeded', recoveryRequired: false, rollbackVerified: false,
      failureCode: null
    })

    const protectedIds = await new ProductionBackupRetentionProtectionSource({
      projectRoot,
      workflowStore: new FakeWorkflowStore()
    }).listProtectedBackupIds()
    expect(protectedIds).toEqual(new Set([`tx-${requestId}`]))
  })

  it('rejects canonical active state that omits or trails a succeeded terminal activation', async () => {
    const omittedRoot = await fixtureProjectRoot()
    const omittedId = randomUUID()
    const omitted = await writePendingUpdateJournal(omittedRoot, omittedId, `save:${omittedId}`)
    await writeCanonicalActiveState(omittedRoot, [])
    await writeUpdateReceipt(omittedRoot, omitted, {
      status: 'succeeded', recoveryRequired: false, rollbackVerified: false,
      failureCode: null
    })
    await expect(new ProductionBackupRetentionProtectionSource({
      projectRoot: omittedRoot,
      workflowStore: new FakeWorkflowStore()
    }).listProtectedBackupIds()).rejects.toMatchObject({
      code: 'SAVE_RETENTION_PROTECTION_SOURCE_INVALID'
    })

    const staleRoot = await fixtureProjectRoot()
    const firstId = randomUUID()
    const first = await writePendingUpdateJournal(staleRoot, firstId, `save:${firstId}`)
    const firstState = await writeCanonicalActiveState(staleRoot, [first])
    await writeUpdateReceipt(staleRoot, first, {
      status: 'succeeded', recoveryRequired: false, rollbackVerified: false,
      failureCode: null, resultingRevision: firstState.revision
    })
    const secondId = randomUUID()
    const second = await writePendingUpdateJournal(staleRoot, secondId, `save:${secondId}`, {
      artifactId: 'fixture-artifact-0002',
      targetVersion: '0.9.23',
      compatibilityReceiptId: randomUUID(),
      releaseId: `nebula-${'6'.repeat(32)}`,
      previousRevision: firstState.revision,
      activatedAt: '2026-09-01T00:02:00.000Z'
    })
    const secondState = canonicalActiveState([first, second])
    await writeUpdateReceipt(staleRoot, second, {
      status: 'succeeded', recoveryRequired: false, rollbackVerified: false,
      failureCode: null, resultingRevision: secondState.revision
    })
    await expect(new ProductionBackupRetentionProtectionSource({
      projectRoot: staleRoot,
      workflowStore: new FakeWorkflowStore()
    }).listProtectedBackupIds()).rejects.toMatchObject({
      code: 'SAVE_RETENTION_PROTECTION_SOURCE_INVALID'
    })
    await writeCanonicalActiveState(staleRoot, [first, second])
    await expect(new ProductionBackupRetentionProtectionSource({
      projectRoot: staleRoot,
      workflowStore: new FakeWorkflowStore()
    }).listProtectedBackupIds()).resolves.toEqual(new Set())
  })

  it('rejects a failed receipt once an immutable update journal exists', async () => {
    const projectRoot = await fixtureProjectRoot()
    const requestId = randomUUID()
    const transaction = await writePendingUpdateJournal(projectRoot, requestId, `save:${requestId}`)
    await writeUpdateReceipt(projectRoot, transaction, {
      status: 'failed',
      recoveryRequired: false,
      rollbackVerified: false,
      failureCode: 'UPDATE_FIXTURE_FAILED'
    })

    await expect(new ProductionBackupRetentionProtectionSource({
      projectRoot,
      workflowStore: new FakeWorkflowStore()
    }).listProtectedBackupIds()).rejects.toMatchObject({
      code: 'SAVE_RETENTION_PROTECTION_SOURCE_INVALID'
    })
  })

  it('rejects a terminal update receipt whose persisted identity does not match its journal', async () => {
    const projectRoot = await fixtureProjectRoot()
    const requestId = randomUUID()
    const transaction = await writePendingUpdateJournal(projectRoot, requestId, `save:${requestId}`)
    await writeUpdateReceipt(projectRoot, transaction, {
      status: 'succeeded',
      recoveryRequired: false,
      rollbackVerified: false,
      failureCode: null
    }, { artifactId: 'different-artifact-0002' })

    await expect(new ProductionBackupRetentionProtectionSource({
      projectRoot,
      workflowStore: new FakeWorkflowStore()
    }).listProtectedBackupIds()).rejects.toMatchObject({
      code: 'SAVE_RETENTION_PROTECTION_SOURCE_INVALID'
    })
  })

  it('rejects an active update state whose canonical revision does not match its contents', async () => {
    const projectRoot = await fixtureProjectRoot()
    const requestId = randomUUID()
    await writePendingUpdateJournal(projectRoot, requestId, `save:${requestId}`)
    await writeFile(path.join(projectRoot, '.dyson-control-updates', 'active.json'), JSON.stringify({
      format: 'dyson-control-component-active-state',
      schemaVersion: 1,
      revision: '0'.repeat(64),
      recoveryRequired: false,
      components: [],
      lastTransaction: null
    }))

    await expect(new ProductionBackupRetentionProtectionSource({
      projectRoot,
      workflowStore: new FakeWorkflowStore()
    }).listProtectedBackupIds()).rejects.toMatchObject({
      code: 'SAVE_RETENTION_PROTECTION_SOURCE_INVALID'
    })
  })
})

class FakeWorkflowStore implements BackupRetentionWorkflowProtectionStore {
  lifecycle: LifecycleBackupProtectionRecord[] = []
  saveRestores: SaveRestoreBackupProtectionRecord[] = []
  lifecycleError: Error | null = null

  listLifecycleBackupProtectionRecords(): readonly LifecycleBackupProtectionRecord[] {
    if (this.lifecycleError) throw this.lifecycleError
    return this.lifecycle
  }

  listSaveRestoreBackupProtectionRecords(): readonly SaveRestoreBackupProtectionRecord[] {
    return this.saveRestores
  }
}

function lifecycleRecord(
  requestId: string,
  state: LifecycleBackupProtectionRecord['state'],
  protectionPointId: string | null,
  recoveryRequired: boolean,
  terminalReceiptComplete: boolean,
  action: LifecycleBackupProtectionRecord['action'] = 'restart'
): LifecycleBackupProtectionRecord {
  return { requestId, action, state, protectionPointId, recoveryRequired, terminalReceiptComplete }
}

function saveRestoreRecord(
  state: SaveRestoreBackupProtectionRecord['state'],
  protectionRequestId: string,
  resultProtectionBackupId: string | null,
  recoveryRequired: boolean,
  terminalReceiptComplete: boolean
): SaveRestoreBackupProtectionRecord {
  return {
    state,
    protectionRequestId,
    resultProtectionBackupId,
    recoveryRequired,
    terminalReceiptComplete
  }
}

async function fixtureProjectRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dyson-retention-protection-'))
  roots.push(root)
  return root
}

interface FixtureUpdateTransaction {
  requestId: string
  requestFingerprint: string
  component: 'nebula'
  artifactId: string
  targetVersion: string
  compatibilityReceiptId: string
  releaseId: string
  previousRevision: string
  protectionBackupId: string
  fileCount: number
  expandedBytes: number
  activatedAt: string
}

interface FixtureActiveState {
  format: 'dyson-control-component-active-state'
  schemaVersion: 1
  revision: string
  recoveryRequired: false
  components: Array<{
    component: 'nebula'
    version: string
    artifactId: string
    sha256: string
    releaseId: string
  }>
  lastTransaction: FixtureUpdateTransaction | null
}

function canonicalActiveState(transactions: readonly FixtureUpdateTransaction[]): FixtureActiveState {
  const latestByComponent = new Map<'nebula', FixtureUpdateTransaction>()
  for (const transaction of transactions) latestByComponent.set(transaction.component, transaction)
  const base = {
    format: 'dyson-control-component-active-state' as const,
    schemaVersion: 1 as const,
    recoveryRequired: false as const,
    components: [...latestByComponent.values()].map((transaction) => ({
      component: transaction.component,
      version: transaction.targetVersion,
      artifactId: transaction.artifactId,
      sha256: createHash('sha256').update(transaction.artifactId).digest('hex'),
      releaseId: transaction.releaseId
    })),
    lastTransaction: transactions.at(-1) ?? null
  }
  return {
    ...base,
    revision: createHash('sha256').update(canonicalFixtureJson(base)).digest('hex')
  }
}

async function writeCanonicalActiveState(
  projectRoot: string,
  transactions: readonly FixtureUpdateTransaction[]
): Promise<FixtureActiveState> {
  const state = canonicalActiveState(transactions)
  await writeFile(
    path.join(projectRoot, '.dyson-control-updates', 'active.json'),
    JSON.stringify(state)
  )
  return state
}

function canonicalFixtureJson(value: unknown): string {
  return JSON.stringify(sortFixtureCanonical(value))
}

function sortFixtureCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortFixtureCanonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, sortFixtureCanonical(entry)]))
  }
  return value
}

async function writePendingUpdateJournal(
  projectRoot: string,
  requestId: string,
  protectionBackupId: string,
  overrides: Partial<Omit<FixtureUpdateTransaction, 'requestId' | 'protectionBackupId'>> = {}
): Promise<FixtureUpdateTransaction> {
  const controlRoot = path.join(projectRoot, '.dyson-control-updates')
  await mkdir(path.join(controlRoot, 'transactions'), { recursive: true })
  await mkdir(path.join(controlRoot, 'receipts'), { recursive: true })
  const transaction: FixtureUpdateTransaction = {
    requestFingerprint: '1'.repeat(64),
    component: 'nebula',
    artifactId: 'fixture-artifact-0001',
    targetVersion: '0.9.22',
    compatibilityReceiptId: randomUUID(),
    releaseId: `nebula-${'2'.repeat(32)}`,
    previousRevision: canonicalActiveState([]).revision,
    fileCount: 1,
    expandedBytes: 64,
    activatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
    requestId,
    protectionBackupId
  }
  await writeFile(path.join(controlRoot, 'transactions', `${requestId}.json`), JSON.stringify({
    format: 'dyson-control-component-update-journal',
    schemaVersion: 1,
    transaction
  }))
  return transaction
}

async function writeUpdateReceipt(
  projectRoot: string,
  transaction: FixtureUpdateTransaction,
  terminal: {
    status: 'succeeded' | 'failed' | 'rolled-back' | 'rollback-failed'
    recoveryRequired: boolean
    rollbackVerified: boolean
    failureCode: string | null
    resultingRevision?: string
  },
  identityOverrides: Partial<Pick<FixtureUpdateTransaction,
    'component' | 'artifactId' | 'targetVersion' | 'compatibilityReceiptId' | 'releaseId'>> = {},
  directory: 'receipts' | 'recovery-receipts' = 'receipts'
): Promise<void> {
  const { resultingRevision = '4'.repeat(64), ...terminalFields } = terminal
  const receipt = {
    format: 'dyson-control-component-update-receipt',
    schemaVersion: 1,
    requestId: transaction.requestId,
    component: transaction.component,
    artifactId: transaction.artifactId,
    compatibilityReceiptId: transaction.compatibilityReceiptId,
    targetVersion: transaction.targetVersion,
    releaseId: transaction.releaseId,
    ...identityOverrides,
    ...terminalFields,
    previousRevision: transaction.previousRevision,
    resultingRevision,
    protectionBackupId: transaction.protectionBackupId,
    fileCount: transaction.fileCount,
    expandedBytes: transaction.expandedBytes,
    completedAt: '2026-09-01T00:01:00.000Z',
    reused: false
  }
  await mkdir(path.join(projectRoot, '.dyson-control-updates', directory), { recursive: true })
  await writeFile(
    path.join(projectRoot, '.dyson-control-updates', directory, `${transaction.requestId}.json`),
    JSON.stringify({
      format: 'dyson-control-component-update-receipt-envelope',
      schemaVersion: 1,
      requestFingerprint: transaction.requestFingerprint,
      receipt
    })
  )
}

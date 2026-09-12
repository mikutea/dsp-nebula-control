import { describe, expect, it } from 'vitest'
import { operatorRollbackDigest, parseOperatorRollbackJournal, parseOperatorRollbackReceipt } from './operator-rollback-records.js'

function fixture() {
  const hash = 'a'.repeat(64)
  const requestId = '11111111-1111-4111-8111-111111111111'
  const sourceRequestId = '22222222-2222-4222-8222-222222222222'
  const planCore = { format: 'dyson-control-component-rollback-plan', schemaVersion: 1, dryRun: true,
    requestId, sourceRequestId, expectedRevision: hash, component: 'bepinex', targetVersion: '5.4.17.0',
    materialSha256: hash, rollbackBindingSha256: hash, sourceProtectionBackupId: 'source-backup',
    restoreFileCount: 1, removeFileCount: 0, currentConfigurationRevision: hash }
  const plan = { ...planCore, planSha256: operatorRollbackDigest(planCore) }
  const protectionCore = { configurationSnapshotId: requestId, configurationRevision: hash,
    serverModLockSha256: hash, serverModLockRevision: hash, previousLoadedSaveIdentity: hash,
    protectionBackupId: 'forward-backup', protectionManifestSha256: hash }
  const protection = { ...protectionCore, bindingSha256: operatorRollbackDigest(protectionCore) }
  const journal = { request: { requestId, sourceRequestId, expectedRevision: hash, expectedPlanSha256: plan.planSha256 },
    plan, protection, phase: 'state-committed', resultingRevision: 'b'.repeat(64) }
  const receipt = { format: 'dyson-control-operator-rollback-receipt', schemaVersion: 1,
    requestId, sourceRequestId, planSha256: plan.planSha256, resultingRevision: journal.resultingRevision,
    protectionBackupId: protection.protectionBackupId, status: 'succeeded', recoveryRequired: false }
  return { journal, receipt }
}

describe('durable operator rollback record validation', () => {
  it('accepts coherent prepared and completed records', () => {
    const { journal, receipt } = fixture()
    expect(parseOperatorRollbackJournal({ ...journal, phase: 'prepared', protection: null, resultingRevision: null }).phase).toBe('prepared')
    expect(parseOperatorRollbackReceipt(receipt, journal)).toEqual(receipt)
  })
  it('rejects changed plans, protection bindings, premature receipts and unknown fields', () => {
    const { journal, receipt } = fixture()
    for (const invalid of [
      { ...journal, plan: { ...journal.plan, targetVersion: '5.4.99.0' } },
      { ...journal, protection: { ...journal.protection, protectionBackupId: 'other-backup' } },
      { ...journal, phase: 'protected', protection: null, resultingRevision: null },
      { ...journal, phase: 'prepared' }, { ...journal, extra: true }
    ]) expect(() => parseOperatorRollbackJournal(invalid)).toThrow()
    expect(() => parseOperatorRollbackReceipt(receipt, { ...journal, phase: 'verified', resultingRevision: null })).toThrow()
    expect(() => parseOperatorRollbackReceipt({ ...receipt, resultingRevision: 'c'.repeat(64) }, journal)).toThrow()
  })
})

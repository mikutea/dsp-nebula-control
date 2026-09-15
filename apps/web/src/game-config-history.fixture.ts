import type {
  GameConfigHistoryDiff,
  GameConfigHistoryRecoveryResult,
  GameConfigHistoryRestoreReceipt,
  GameConfigHistorySnapshotDetail,
  GameConfigHistorySnapshotSummary
} from './model'

export const configHistorySnapshotId = '018f47a0-7d5b-4abc-8def-0123456789ab'
export const configHistoryRequestId = '028f47a0-7d5b-4abc-8def-0123456789ab'
export const configHistoryProtectionSnapshotId = '038f47a0-7d5b-4abc-8def-0123456789ab'
export const configHistoryCurrentRevision = '1'.repeat(64)
export const configHistoryTargetRevision = '2'.repeat(64)

export function configHistorySnapshotFixture(): GameConfigHistorySnapshotDetail {
  return {
    format: 'dyson-control-game-config-snapshot',
    snapshotId: configHistorySnapshotId,
    kind: 'manual',
    createdAt: '2026-08-30T10:00:00.000Z',
    revision: configHistoryTargetRevision,
    manifestSha256: '3'.repeat(64),
    fileCount: 4,
    totalBytes: 2_048,
    files: [
      { id: 'nebula', present: true, bytes: 512 },
      { id: 'galaxy', present: true, bytes: 512 },
      { id: 'bepinex', present: true, bytes: 512 },
      { id: 'bridge', present: true, bytes: 512 }
    ]
  }
}

export function configHistorySummaryFixture(): GameConfigHistorySnapshotSummary {
  const { files: _files, ...summary } = configHistorySnapshotFixture()
  return summary
}

export function configHistoryDiffFixture(): GameConfigHistoryDiff {
  return {
    snapshotId: configHistorySnapshotId,
    currentRevision: configHistoryCurrentRevision,
    targetRevision: configHistoryTargetRevision,
    files: [
      { id: 'nebula', beforePresent: true, afterPresent: true, changed: true },
      { id: 'galaxy', beforePresent: true, afterPresent: true, changed: false },
      { id: 'bepinex', beforePresent: true, afterPresent: true, changed: false },
      { id: 'bridge', beforePresent: true, afterPresent: true, changed: true }
    ],
    settings: [
      {
        id: 'nebula.server-password',
        file: 'nebula',
        before: { configured: true },
        after: { configured: true },
        changed: true
      },
      {
        id: 'galaxy.star-count',
        file: 'galaxy',
        before: 32,
        after: 64,
        changed: true
      },
      {
        id: 'bridge.telemetry-enabled',
        file: 'bridge',
        before: false,
        after: true,
        changed: true
      }
    ]
  }
}

export function configHistoryDryRunReceiptFixture(): GameConfigHistoryRestoreReceipt {
  return {
    format: 'dyson-control-game-config-restore-receipt',
    version: 1,
    requestId: configHistoryRequestId,
    snapshotId: configHistorySnapshotId,
    protectionSnapshotId: null,
    status: 'dry-run',
    dryRun: true,
    expectedCurrentRevision: configHistoryCurrentRevision,
    targetRevision: configHistoryTargetRevision,
    finalRevision: configHistoryCurrentRevision,
    errorCode: 'NONE',
    startedAt: '2026-08-30T10:05:00.000Z',
    finishedAt: '2026-08-30T10:05:01.000Z',
    persisted: true,
    reused: false
  }
}

export function configHistoryRestoredReceiptFixture(
  requestId = configHistoryRequestId
): GameConfigHistoryRestoreReceipt {
  return {
    ...configHistoryDryRunReceiptFixture(),
    requestId,
    protectionSnapshotId: configHistoryProtectionSnapshotId,
    status: 'restored',
    dryRun: false,
    finalRevision: configHistoryTargetRevision,
    startedAt: '2026-08-30T10:06:00.000Z',
    finishedAt: '2026-08-30T10:06:02.000Z'
  }
}

export function configHistoryRecoveryFixture(): GameConfigHistoryRecoveryResult[] {
  return [{
    requestId: configHistoryRequestId,
    status: 'interrupted-recovered',
    finalRevision: configHistoryCurrentRevision,
    errorCode: 'CONFIG_HISTORY_INTERRUPTED_RECOVERED'
  }]
}

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HostMutationOperationScope } from '../host-mutation/operation-coordinator.js'
import type { PublicGameRuntimeReceipt } from '../lifecycle/game-runtime-receipts.js'
import type { ModDeploymentStateSummary } from '../mods/deployment-types.js'
import { SaveTransactionService } from '../saves/transactions.js'
import type { ComponentUpdateRollbackBinding } from '../update-pipeline/activation-types.js'
import type { AcceptedWindowsUpdateRuntimeEvidence } from './windows-update-runtime-evidence.js'
import {
  WindowsUpdateActivationTransactionProvider,
  WindowsUpdateTransactionProviderError
} from './windows-update-transaction-provider.js'

const fixedSaveName = '_lastexit_'
const requestId = '11111111-2222-4333-8444-555555555555'
const backupRequestId = '22222222-3333-4444-8555-666666666666'
const shaA = 'a'.repeat(64)
const shaB = 'b'.repeat(64)
const generation = 'c'.repeat(64)
const compatibilityRevision = 'd'.repeat(64)

const managedConfig = {
  'nebula.cfg': '[Nebula - Settings]\r\nAutoPauseEnabled = true\r\nServerPassword = fictional-old\r\nHostPort = 8469\r\n',
  'nebulaGameDescSettings.cfg': '[Basic]\nstarCount = 64\nresourceMultiplier = 1\n\n[General]\nisPeaceMode = false\n',
  'BepInEx.cfg': '[Logging.Console]\r\nEnabled = true\r\n',
  'io.github.mikutea.dyson-control-bridge.cfg': '[Bridge]\nEnabled = false\n\n[Timing]\nPollMilliseconds = 250\n'
} as const

const stoppedEvidence = {
  protocol: 'DYSON_CONTROL_RUNTIME_V1' as const,
  expected: 'stopped' as const,
  state: 'matched' as const,
  processVerified: true as const,
  gamePortListening: false as const
}

const temporaryRoots: string[] = []

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    await rm(temporaryRoots.pop()!, { recursive: true, force: true })
  }
})

describe('WindowsUpdateActivationTransactionProvider', () => {
  it('captures all rollback authorities, restores configuration and pair, then rereads every binding', async () => {
    const fixture = await createFixture()
    const baseline = await fixture.provider.captureRollbackBaseline({
      requestId,
      component: 'nebula',
      targetVersion: '0.9.22',
      expectedRevision: shaA
    }, fixture.hostMutation) as Baseline

    expect(baseline).toEqual(expect.objectContaining({
      configurationSnapshotId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      configurationRevision: expect.stringMatching(/^[0-9a-f]{64}$/),
      serverModLockSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      serverModLockRevision: fixture.state.mod.revision,
      previousLoadedSaveIdentity: fixture.originalSaveIdentity
    }))
    expect(fixture.state.stoppedProofCalls).toBe(3)
    expect(fixture.state.persistedEvidenceCalls).toBe(1)
    expect(fixture.state.receiptCalls).toBe(1)

    const backup = await fixture.saveService.backup({
      requestId: backupRequestId,
      saveName: fixedSaveName
    })
    expect(backup.status).toBe('succeeded')
    const protection = await fixture.provider.inspectProtectionPoint({
      requestId,
      backupId: backup.backupId
    }, fixture.hostMutation) as { manifestSha256: string; saveIdentity: string }
    expect(protection.saveIdentity).toBe(fixture.originalSaveIdentity)
    const binding = rollbackBinding(baseline, backup.backupId, protection.manifestSha256)

    await writeFile(
      path.join(fixture.configRoot, 'nebula.cfg'),
      managedConfig['nebula.cfg'].replace('fictional-old', 'fictional-mutated'),
      'utf8'
    )
    await writePair(fixture.saveRoot,
      Buffer.from('mutated-live-dsv'), Buffer.from('mutated-live-server'))

    await expect(fixture.provider.restoreConfiguration({
      requestId, component: 'nebula', binding
    }, fixture.hostMutation)).resolves.toEqual({ restored: true, rereadVerified: true })
    expect(await readFile(path.join(fixture.configRoot, 'nebula.cfg'), 'utf8'))
      .toBe(managedConfig['nebula.cfg'])
    expect(fixture.state.stopProofTokensIssued).toBe(1)
    expect(fixture.state.stopProofValidations).toBeGreaterThanOrEqual(2)

    await expect(fixture.provider.restoreServerModLock({
      requestId, component: 'nebula', binding
    }, fixture.hostMutation)).resolves.toEqual({ restored: true, rereadVerified: true })
    await expect(fixture.provider.restorePairedSave({
      requestId, component: 'nebula', binding
    }, fixture.hostMutation)).resolves.toEqual({ restored: true, rereadVerified: true })
    expect(await readPair(fixture.saveRoot)).toEqual(fixture.originalPair)

    await expect(fixture.provider.inspectRollbackReadback({
      requestId, component: 'nebula', binding
    }, fixture.hostMutation)).resolves.toEqual({
      configurationSnapshotId: baseline.configurationSnapshotId,
      configurationRevision: baseline.configurationRevision,
      serverModLockSha256: baseline.serverModLockSha256,
      serverModLockRevision: baseline.serverModLockRevision,
      protectionManifestSha256: protection.manifestSha256,
      loadedSaveIdentity: baseline.previousLoadedSaveIdentity
    })
  })

  it('fails stopped baseline closed unless the newest clean runtime receipt and exact fixed pair agree', async () => {
    const wrongPair = await createFixture()
    wrongPair.state.persisted = {
      ...wrongPair.state.persisted,
      loadedSaveIdentity: 'e'.repeat(64)
    }
    await expect(wrongPair.provider.captureRollbackBaseline({
      requestId,
      component: 'bridge',
      targetVersion: '0.1.0',
      expectedRevision: shaA
    }, wrongPair.hostMutation)).rejects.toMatchObject({
      code: 'WINDOWS_UPDATE_STOPPED_SAVE_BINDING_MISMATCH'
    })

    const wrongReceipt = await createFixture()
    wrongReceipt.state.receipt = {
      ...wrongReceipt.state.receipt,
      outcome: 'abnormal-exit',
      errorCode: 'BOOTSTRAP_UNEXPECTED_EXIT',
      restartExpected: true
    }
    await expect(wrongReceipt.provider.captureRollbackBaseline({
      requestId,
      component: 'control',
      targetVersion: '0.1.0',
      expectedRevision: shaA
    }, wrongReceipt.hostMutation)).rejects.toMatchObject({
      code: 'WINDOWS_UPDATE_RUNTIME_RECEIPT_MISMATCH'
    })
  })

  it('never claims a mod rollback when the fixed managed lock drifted', async () => {
    const fixture = await createFixture()
    const baseline = await fixture.provider.captureRollbackBaseline({
      requestId,
      component: 'bepinex',
      targetVersion: '5.4.23.3',
      expectedRevision: shaA
    }, fixture.hostMutation) as Baseline
    const binding = rollbackBinding(
      baseline,
      `tx-${backupRequestId}`,
      'f'.repeat(64)
    )
    fixture.state.mod = { ...fixture.state.mod, revision: '9'.repeat(64) }
    await expect(fixture.provider.restoreServerModLock({
      requestId, component: 'bepinex', binding
    }, fixture.hostMutation)).rejects.toMatchObject({
      code: 'WINDOWS_UPDATE_MOD_LOCK_DRIFT_UNRESTORABLE'
    })
  })

  it('uses trusted compatibility separately and brackets Steam samples and running generations', async () => {
    const fixture = await createFixture()
    await expect(fixture.provider.captureSteamManualBaseline({
      requestId,
      targetVersion: '0.10.34.28529',
      expectedRevision: shaA
    }, fixture.hostMutation)).resolves.toEqual({
      dspVersion: '0.10.34.28529',
      compatibilityRevision,
      compatible: true,
      loadedSaveIdentity: fixture.originalSaveIdentity
    })
    expect(fixture.state.currentEvidenceCalls).toBe(2)
    expect(fixture.state.compatibilityCalls).toBe(1)

    const stoppedBefore = fixture.state.stoppedProofCalls
    await expect(fixture.provider.resampleSteamManualRuntime({
      requestId,
      targetVersion: '0.10.34.28529'
    }, fixture.hostMutation)).resolves.toEqual({
      dspVersion: '0.10.34.28529',
      compatibilityRevision,
      compatible: true
    })
    expect(fixture.state.stoppedProofCalls - stoppedBefore).toBe(2)

    await expect(fixture.provider.probeSteamManualLoadEvidence({
      requestId,
      targetVersion: '0.10.34.28529',
      expectedLoadedSaveIdentity: fixture.originalSaveIdentity
    }, fixture.hostMutation)).resolves.toEqual(expect.objectContaining({
      processId: fixture.state.current.processId,
      dspVersion: '0.10.34.28529',
      compatibilityRevision,
      compatible: true,
      loadedSaveIdentity: fixture.originalSaveIdentity,
      startupGenerationId: generation,
      bridgeHeartbeatGenerationId: generation,
      loadedSaveLogGenerationId: generation
    }))

    fixture.state.currentSequence.push(
      fixture.state.current,
      {
        ...fixture.state.current,
        processId: fixture.state.current.processId + 1,
        startupGenerationId: '8'.repeat(64),
        bridgeHeartbeatGenerationId: '8'.repeat(64),
        loadedSaveLogGenerationId: '8'.repeat(64)
      }
    )
    await expect(fixture.provider.captureSteamManualBaseline({
      requestId,
      targetVersion: '0.10.34.28529',
      expectedRevision: shaA
    }, fixture.hostMutation)).rejects.toMatchObject({
      code: 'WINDOWS_UPDATE_RUNTIME_GENERATION_CHANGED'
    })
  })

  it('rejects request extensions before consulting any authority', async () => {
    const fixture = await createFixture()
    await expect(fixture.provider.captureRollbackBaseline({
      requestId,
      component: 'nebula',
      targetVersion: '0.9.22',
      expectedRevision: shaA,
      command: 'fictional-command'
    } as never, fixture.hostMutation)).rejects.toBeInstanceOf(WindowsUpdateTransactionProviderError)
    expect(fixture.state.stoppedProofCalls).toBe(0)
    expect(fixture.state.persistedEvidenceCalls).toBe(0)
  })
})

interface Baseline {
  configurationSnapshotId: string
  configurationRevision: string
  serverModLockSha256: string
  serverModLockRevision: string
  previousLoadedSaveIdentity: string
}

async function createFixture() {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'dyson-update-provider-'))
  temporaryRoots.push(projectRoot)
  const configRoot = path.join(projectRoot, 'server', 'BepInEx', 'config')
  const saveRoot = path.join(projectRoot, 'userdata', 'Save')
  const backupRoot = path.join(projectRoot, 'backups', 'saves')
  await Promise.all([
    mkdir(configRoot, { recursive: true }),
    mkdir(saveRoot, { recursive: true }),
    mkdir(backupRoot, { recursive: true })
  ])
  await Promise.all(Object.entries(managedConfig).map(([name, content]) =>
    writeFile(path.join(configRoot, name), content, 'utf8')))
  const originalPair = {
    dsv: Buffer.from('authoritative-original-dsv'),
    server: Buffer.from('authoritative-original-server')
  }
  await writePair(saveRoot, originalPair.dsv, originalPair.server)
  const originalSaveIdentity = pairIdentity(originalPair.dsv, originalPair.server)

  const processStartedAtUnixMs = Date.parse('2026-08-30T00:00:00.500Z')
  const bridgeStartedAtUnixMs = Date.parse('2026-08-30T00:00:02.000Z')
  const current: AcceptedWindowsUpdateRuntimeEvidence = {
    processId: 4242,
    processStartedAtUnixMs,
    bridgeStartedAtUnixMs,
    loadedSaveObservedAtUnixMs: Date.parse('2026-08-30T00:00:03.000Z'),
    writtenAtUnixMs: Date.parse('2026-08-30T00:00:03.000Z'),
    startedAt: new Date(processStartedAtUnixMs).toISOString(),
    startupGenerationId: generation,
    bridgeHeartbeatGenerationId: generation,
    loadedSaveLogGenerationId: generation,
    loadedSaveIdentity: originalSaveIdentity
  }
  const receipt: PublicGameRuntimeReceipt = {
    protocol: 'DYSON_CONTROL_GAME_RUNTIME_RECEIPT_V1',
    schemaVersion: 1,
    attemptId: '00000000-0000-0000-0000-000000000001',
    bindingId: '00000000-0000-0000-0000-000000000002',
    version: 'release-1',
    outcome: 'clean-exit',
    errorCode: null,
    restartExpected: false,
    startedAt: '2026-08-30T00:00:00.0000000+00:00',
    publishedAt: '2026-08-30T00:00:01.0000000+00:00',
    completedAt: '2026-08-30T00:00:10.0000000+00:00',
    projectRootIdentityVerified: true,
    dataRootIdentityVerified: true,
    receiptSha256: shaB
  }
  const mod: ModDeploymentStateSummary = {
    revision: shaA,
    packages: [],
    enabledCount: 0,
    disabledCount: 0
  }
  const state = {
    current,
    persisted: current,
    currentSequence: [] as AcceptedWindowsUpdateRuntimeEvidence[],
    receipt,
    mod,
    compatibility: {
      dspVersion: '0.10.34.28529',
      compatibilityRevision,
      compatible: true
    },
    stoppedProofCalls: 0,
    persistedEvidenceCalls: 0,
    currentEvidenceCalls: 0,
    receiptCalls: 0,
    compatibilityCalls: 0,
    stopProofTokensIssued: 0,
    stopProofValidations: 0
  }
  const verifyServiceStopped = async () => {
    state.stoppedProofCalls += 1
    return stoppedEvidence
  }
  const provider = new WindowsUpdateActivationTransactionProvider({
    projectRoot,
    configStopProof: {
      async issue() {
        state.stopProofTokensIssued += 1
        return 'fictional-fixed-stop-proof'
      },
      async validate() {
        state.stopProofValidations += 1
        return true
      }
    },
    verifyServiceStopped,
    modDeploymentService: {
      async inspect() { return structuredClone(state.mod) }
    },
    runtimeEvidenceSource: {
      async readCurrentRuntimeEvidence() {
        state.currentEvidenceCalls += 1
        return state.currentSequence.shift() ?? state.current
      },
      async readPersistedRuntimeEvidence() {
        state.persistedEvidenceCalls += 1
        return state.persisted
      }
    },
    runtimeCompatibilitySource: {
      async inspect() {
        state.compatibilityCalls += 1
        return state.compatibility
      }
    },
    gameRuntimeReceiptSource: {
      async list() {
        state.receiptCalls += 1
        return { items: [state.receipt], nextCursor: null }
      }
    }
  })
  const saveService = new SaveTransactionService({
    saveRoot,
    backupRoot,
    verifyServiceStopped,
    stableWindowMs: 0,
    snapshotAttempts: 2,
    wait: async () => undefined
  })
  return {
    projectRoot,
    configRoot,
    saveRoot,
    backupRoot,
    provider,
    saveService,
    state,
    originalPair,
    originalSaveIdentity,
    hostMutation: hostMutationScope()
  }
}

function rollbackBinding(
  baseline: Baseline,
  protectionBackupId: string,
  protectionManifestSha256: string
): ComponentUpdateRollbackBinding {
  const value = {
    ...baseline,
    protectionBackupId,
    protectionManifestSha256
  }
  return {
    ...value,
    bindingSha256: createHash('sha256').update(canonicalJson(value)).digest('hex')
  }
}

function hostMutationScope(): HostMutationOperationScope {
  const signal = new AbortController().signal
  return {
    signal,
    assertActive() { signal.throwIfAborted() },
    toPowerShellBorrowArguments() { return [] }
  }
}

async function writePair(saveRoot: string, dsv: Buffer, server: Buffer): Promise<void> {
  await Promise.all([
    writeFile(path.join(saveRoot, `${fixedSaveName}.dsv`), dsv),
    writeFile(path.join(saveRoot, `${fixedSaveName}.server`), server)
  ])
}

async function readPair(saveRoot: string): Promise<{ dsv: Buffer; server: Buffer }> {
  const [dsv, server] = await Promise.all([
    readFile(path.join(saveRoot, `${fixedSaveName}.dsv`)),
    readFile(path.join(saveRoot, `${fixedSaveName}.server`))
  ])
  return { dsv, server }
}

function pairIdentity(dsv: Buffer, server: Buffer): string {
  return createHash('sha256')
    .update('dyson-save-pair-revision-v1\0_lastexit_\0dsv\0', 'utf8')
    .update(String(dsv.length), 'utf8')
    .update('\0', 'utf8')
    .update(createHash('sha256').update(dsv).digest('hex'), 'ascii')
    .update('\0server\0', 'utf8')
    .update(String(server.length), 'utf8')
    .update('\0', 'utf8')
    .update(createHash('sha256').update(server).digest('hex'), 'ascii')
    .digest('hex')
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonical(value))
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, sortCanonical(child)]))
  }
  return value
}
